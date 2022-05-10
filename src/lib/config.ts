import * as _ from 'lodash';
import * as Bluebird from 'bluebird';

import * as Path from 'path';
import * as FS from 'fs-extra';
import * as Yaml from 'js-yaml';
import * as Glob from 'glob-promise';
import * as Minimatch from 'minimatch';

import Axios from 'axios';

import * as Chalk from 'chalk';

import { v4 as Uuid } from 'uuid';

import * as Zod from 'zod';

import { Transform, TransformOptions } from 'stream';
import { StringDecoder } from 'string_decoder';

import {
    ConfigSchema, ConfigSubmoduleSchema, ConfigFeatureSchema, ConfigReleaseSchema, ConfigHotfixSchema, ConfigSupportSchema, ConfigUriSchema, ElementSchema, RecursiveConfigSchema, RecursiveConfigSubmoduleSchema,
    ConfigBase, SubmoduleBase, FeatureBase, ReleaseBase, HotfixBase, SupportBase,
    parseConfigReference
} from '@jlekie/git-laminar-flow';

import { exec, execCmd, ExecOptions } from './exec';
import { Settings } from './settings';

function applyMixins(derivedCtor: any, constructors: any[]) {
    constructors.forEach((baseCtor) => {
        Object.getOwnPropertyNames(baseCtor.prototype).forEach((name) => {
            Object.defineProperty(
                derivedCtor.prototype,
                name,
                Object.getOwnPropertyDescriptor(baseCtor.prototype, name) || Object.create(null)
            );
        });
    });
}

class TestTransform extends Transform {
    public static create(baseStream: NodeJS.WritableStream, label: string, options?: TransformOptions) {
        const stream = new this(label, options);
        stream.pipe(baseStream);

        return stream;
    }

    public readonly label: string;

    #decoder: StringDecoder = new StringDecoder('utf8');
    #last?: string;

    public constructor(label: string, options?: TransformOptions) {
        super(options);

        this.label = label;
    }

    public _transform(data: Buffer, encoding: string, callback: (err?: Error | null, data?: Buffer | string) => void) {
        if (this.#last === undefined)
            this.#last = '';

        this.#last += this.#decoder.write(data);

        const list = this.#last.split(/\n/);
        this.#last = list.pop();

        for (let i = 0; i < list.length; i++)
            this.push(`${this.label} ${list[i]}\n`);

        callback();
    }
    public _flush(callback: () => void) {
        this.#last += this.#decoder.end();

        if (this.#last)
            this.push(this.#last);

        callback();
    }
}

export function *resolveOrderedConfigs(configs: Config[], parent?: Config): Generator<Config[]> {
    const filteredConfigs = configs.filter(c => c.parentConfig === parent);
    for (const config of filteredConfigs)
        for (const childFilteredConfigs of resolveOrderedConfigs(configs, config))
            yield childFilteredConfigs;

    if (filteredConfigs.length > 0)
        yield filteredConfigs;
}
export async function *resolveFilteredOrderedConfigs(configs: Config[], { parent, filter }: Partial<{ parent: Config, filter: (config: Config) => boolean | Promise<boolean> }> = {}): AsyncGenerator<Config[]> {
    const applicableConfigs = configs.filter(c => c.parentConfig === parent);
    // console.log(applicableConfigs, parent)

    for (const config of applicableConfigs)
        for await (const childFilteredConfigs of resolveFilteredOrderedConfigs(configs, { parent: config, filter }))
            yield childFilteredConfigs;

    const filteredConfigs = filter ? await Bluebird.filter(applicableConfigs, filter) : [];
    if (filteredConfigs.length > 0)
        yield filteredConfigs;
}

export interface State {
    [key: string]: StateValue;
}
export type StateValue = string | number | boolean | State;
export type StateProxyValue = string | number | boolean | StateProxy;
export const StateSchema: Zod.ZodSchema<State> = Zod.record(
    Zod.string(),
    Zod.union([ Zod.string(), Zod.number(), Zod.boolean(), Zod.lazy(() => StateSchema) ])
);

export class StateProxy {
    #config: Config;
    #state: State;

    public constructor(config: Config, state: State = {}) {
        this.#config = config;
        this.#state = state;
    }

    public getValue(key: string, type: 'string'): string | undefined;
    public getValue(key: string, type: 'number'): number | undefined;
    public getValue(key: string, type: 'boolean'): boolean | undefined;
    public getValue(key: string, type: 'nested'): StateProxy | undefined;
    public getValue(key: string, type: 'string' | 'number' | 'boolean' | 'nested'): StateProxyValue | undefined {
        // return getStateValue(this.#state, key, type);

        const value = this.#state[key];
        if (value === undefined)
            return;

        if (type === 'string') {
            if (!_.isString(value))
                throw new Error(`State key ${key} not a string`);

            return value;
        }
        else if (type === 'number') {
            if (!_.isNumber(value))
                throw new Error(`State key ${key} not a number`);

            return value;
        }
        else if (type === 'boolean') {
            if (!_.isBoolean(value))
                throw new Error(`State key ${key} not a boolean`);

            return value;
        }
        else if (type === 'nested') {
            if (!_.isObject(value))
                throw new Error(`State key ${key} not a nested state`);

            return new StateProxy(this.#config, value);
        }
        else {
            throw new Error(`Unsupported state type ${type}`);
        }
    }

    // public async setValue(key: string, value?: StateValue | StateProxyValue) {
    //     const state = await this.loadState();

    //     if (value)
    //         state[key] = value instanceof StateProxy ? value.toJSON() : value;
    //     else
    //         delete state[key];

    //     await this.saveState(state);
    // }

    public toJSON() {
        return this.#state;
    }
}

export function getStateValue(state: State, key: string | string[], type: 'string'): string | undefined;
export function getStateValue(state: State, key: string | string[], type: 'number'): number | undefined;
export function getStateValue(state: State, key: string | string[], type: 'boolean'): boolean | undefined;
export function getStateValue(state: State, key: string | string[], type: 'nested'): State | undefined;
export function getStateValue(state: State, key: string | string[], type: 'string' | 'number' | 'boolean' | 'nested'): StateValue | undefined {
    return getStateGenericValue(state, key, type);
}

export function getStateGenericValue(state: State, key: string | string[], type: 'string' | 'number' | 'boolean' | 'nested'): StateValue | undefined {
    key = _.isArray(key) ? key : [ key ];

    const value = state[key[0]];
    if (value === undefined)
        return;

    if (key.length > 1) {
        if (!_.isObject(value))
            throw new Error(`State key ${key[0]} not a nested state`);

        return getStateGenericValue(value, key.slice(1), type);
    }
    else if (type === 'string') {
        if (!_.isString(value))
            throw new Error(`State key ${key[0]} not a string`);

        return value;
    }
    else if (type === 'number') {
        if (!_.isNumber(value))
            throw new Error(`State key ${key[0]} not a number`);

        return value;
    }
    else if (type === 'boolean') {
        if (!_.isBoolean(value))
            throw new Error(`State key ${key[0]} not a boolean`);

        return value;
    }
    else if (type === 'nested') {
        if (!_.isObject(value))
            throw new Error(`State key ${key[0]} not a nested state`);

        return value;
    }
    else {
        throw new Error(`Unsupported state type ${type}`);
    }
}

export function setStateValue(state: State, key: string | string[], value?: StateValue | StateProxyValue) {
    key = _.isArray(key) ? key : [ key ];

    if (key.length > 1) {
        const nestedState = state[key[0]] = state[key[0]] ?? {};
        if (!_.isObject(nestedState))
            throw new Error(`State key ${key[0]} not a nested state`);

        setStateValue(nestedState, key.slice(1), value);
    }
    else {
        if (value)
            state[key[0]] = value instanceof StateProxy ? value.toJSON() : value;
        else
            delete state[key[0]];
    }
}

export async function loadState(statePath: string) {
    return await FS.pathExists(statePath)
        ? await FS.readFile(statePath, 'utf8')
            .then(content => JSON.parse(content))
            .then(hash => StateSchema.parse(hash))
        : {};
}
export async function saveState(statePath: string, state: State) {
    await FS.ensureFile(statePath);

    const content = JSON.stringify(state);
    await FS.writeFile(statePath, content, 'utf8');
}

export async function loadV2Config(uri: string, settings: Settings, { cwd, parentConfig, parentSubmodule, pathspecPrefix, stdout, dryRun, verify = true }: LoadRepoConfigParams & ExecParams = {}) {
    // stdout = stdout && TestTransform.create(stdout, Chalk.gray('[loadV2Config]'));

    cwd = Path.resolve(cwd ?? '.');

    stdout?.write(Chalk.gray(`Loading file from ${uri} [${cwd}]\n`));

    const config = await (async () => {
        const configRef = parseConfigReference(uri);

        if (configRef.type === 'file') {
            return await FS.pathExists(configRef.path)
                ? await FS.readFile(configRef.path, 'utf8')
                    .then(content => Yaml.load(content))
                    .then(hash => Config.parse(hash))
                : Config.createNew();
        }
        else if (configRef.type === 'branch') {
            return await execCmd(`git show ${configRef.branchName}:.gitflow.yml`, { cwd, stdout, dryRun })
                .then(content => Yaml.load(content))
                .then(hash => Config.parse(hash))
                .catch(() => Config.createNew());
        }
        else if (configRef.type === 'http') {
            return await Axios.get(`${configRef.protocol}://${configRef.url}`)
                .then(response => Config.parse(response.data))
                .catch(err => {
                    if (Axios.isAxiosError(err) && err.response?.status === 404)
                        return Config.createNew();

                    throw new Error(`Failed to fetch http(s) config [${err}]`);
                });
        }
        else if (configRef.type === 'glfs') {
            const [hostUrl, apiKey] = (() => {
                const matchedRepo = configRef.hostname
                    ? settings.glfsRepositories.find(r => r.name === configRef.hostname)
                    : settings.getDefaultRepo();

                if (matchedRepo)
                    return [matchedRepo.url, matchedRepo.apiKey];
                else
                    return [`http://${configRef.hostname}`];
            })();

            return await Axios.get(`${hostUrl}/v1/${configRef.namespace}/${configRef.name}`, {
                auth: apiKey ? {
                    username: 'glf.cli',
                    password: apiKey
                } : undefined
            })
                .then(response => Config.parse(response.data))
                .catch(err => {
                    if (Axios.isAxiosError(err) && err.response?.status === 404)
                        return Config.createNew();

                    throw new Error(`Failed to fetch http(s) config [${err}]`);
                });
        }
        else {
            throw new Error(`Unsupported config type ${configRef.type}`);
        }
    })();

    await config.register(cwd, uri, config.calculateHash(), settings, {
        verify
    }, parentConfig, parentSubmodule, pathspecPrefix);

    verify && await config.verify({ stdout, dryRun });

    return config;
}

export async function deleteConfig(uri: string, settings: Settings) {
    const configRef = parseConfigReference(uri);

    if (configRef.type === 'file') {
        if (await FS.pathExists(configRef.path))
            await FS.remove(configRef.path);
    }
    else if (configRef.type === 'http') {
        await Axios.delete(`${configRef.protocol}://${configRef.url}`);
    }
    else if (configRef.type === 'glfs') {
        const hostUrl = (() => {
            const matchedRepo = configRef.hostname
                ? settings.glfsRepositories.find(r => r.name === configRef.hostname)
                : settings.getDefaultRepo();

            if (matchedRepo)
                return matchedRepo.url;
            else
                return `http://${configRef.hostname}`;
        })();

        await Axios.delete(`${hostUrl}/v1/${configRef.namespace}/${configRef.name}`);
    }
    else {
        throw new Error(`Unsupported config type ${configRef.type}`);
    }
}

// Either load the config from disk if it exists or create a new default config
export async function loadConfig(path: string, settings: Settings, { cwd, parentConfig, parentSubmodule, pathspecPrefix }: { cwd?: string, parentConfig?: Config, parentSubmodule?: Submodule, pathspecPrefix?: string } = {}) {
    const config = await FS.pathExists(path)
        ? await FS.readFile(path, 'utf8')
            .then(content => Yaml.load(content))
            .then(hash => Config.parse(hash))
        : Config.createNew();

    const repoPath = cwd ?? Path.dirname(Path.resolve(path));
    await config.register(repoPath, `file://${path}`, config.calculateHash(), settings, {
        
    }, parentConfig, parentSubmodule, pathspecPrefix);

    return config;
}

export interface LoadRepoConfigParams {
    cwd?: string;
    parentConfig?: Config;
    parentSubmodule?: Submodule;
    pathspecPrefix?: string;
    verify?: boolean;
}
export async function loadRepoConfig(settings: Settings, { cwd, parentConfig, parentSubmodule, pathspecPrefix, stdout, dryRun }: LoadRepoConfigParams & ExecParams = {}) {
    stdout = stdout && TestTransform.create(stdout, Chalk.gray('[loadRepoConfig]'));

    // if (!!await execCmd(`git remote show origin`, { cwd, stdout, dryRun }).catch(err => false)) {
    //     await exec('git fetch origin gitflow:gitflow', { cwd, stdout, dryRun });

    //     // if (!!await execCmd(`git branch --list gitflow`, { cwd, stdout, dryRun }))
    //     //     await exec('git pull origin gitflow', { cwd, stdout, dryRun });
    // }

    const config = await execCmd('git show gitflow:.gitflow.yml', { cwd, stdout, dryRun })
        .then(content => Yaml.load(content))
        .then(hash => Config.parse(hash))
        .catch(() => Config.createNew());

    await config.register(Path.resolve(cwd ?? '.'), 'branch://gitflow', config.calculateHash(), settings, {

    }, parentConfig, parentSubmodule, pathspecPrefix);

    return config;
}

export type Artifact = {
    type: 'unknown';
    branch: string;
} | {
    type: 'master';
    branch: string;
} | {
    type: 'develop';
    branch: string;
} | {
    type: 'feature';
    branch: string;
    feature: Feature;
    uri: string;
} | {
    type: 'release';
    branch: string;
    release: Release;
    uri: string;
} | {
    type: 'hotfix';
    branch: string;
    hotfix: Hotfix;
    uri: string;
};

export type Element = {
    type: 'branch';
    branch: string;
} | {
    type: 'repo';
    config: Config;
} | {
    type: 'feature';
    feature: Feature;
} | {
    type: 'release';
    release: Release;
} | {
    type: 'hotfix';
    hotfix: Hotfix;
} | {
    type: 'support',
    support: Support;
    targetBranch?: 'master' | 'develop';
};
export type NarrowedElement<T, N> = T extends { type: N } ? T : never;

export interface BranchStatus {
    branchName: string;
    localExists: boolean;
    upstreamExists: boolean;
    commitsAhead: number;
    commitsBehind: number;
}

export type ConfigParams = Pick<Config, 'identifier' | 'upstreams' | 'submodules' | 'features' | 'releases' | 'hotfixes' | 'supports' | 'included' | 'excluded'> & Partial<Pick<Config, 'featureMessageTemplate' | 'releaseMessageTemplate' | 'hotfixMessageTemplate' | 'releaseTagTemplate' | 'hotfixTagTemplate' | 'isNew' | 'managed' | 'tags'>>;
export class Config {
    public identifier: string;
    public managed: boolean;
    public upstreams: Array<{ name: string, url: string }>;
    public submodules: Submodule[];
    public features: Feature[];
    public releases: Release[];
    public hotfixes: Hotfix[];
    public supports: Support[];
    public included: string[];
    public excluded: string[];
    public featureMessageTemplate?: string;
    public releaseMessageTemplate?: string;
    public hotfixMessageTemplate?: string;
    public releaseTagTemplate?: string;
    public hotfixTagTemplate?: string;
    public tags: string[];

    public readonly isNew: boolean;

    #initialized: boolean = false;

    #sourceUri!: string;
    public get sourceUri() {
        if (!this.#initialized)
            throw new Error('Not initialized');

        return this.#sourceUri;
    }

    #path!: string;
    public get path() {
        if (!this.#initialized)
            throw new Error('Not initialized');

        return this.#path;
    }

    #pathspec!: string;
    public get pathspec() {
        if (!this.#initialized)
            throw new Error('Not initialized');

        return this.#pathspec;
    }

    #baseHash!: string;
    public get baseHash() {
        if (!this.#initialized)
            throw new Error('Not initialized');

        return this.#baseHash;
    }

    #settings!: Settings;
    public get settings() {
        if (!this.#initialized)
            throw new Error('Not initialized');

        return this.#settings;
    }

    #parentConfig?: Config;
    public get parentConfig() {
        if (!this.#initialized)
            throw new Error('Not initialized');

        return this.#parentConfig;
    }

    #parentSubmodule?: Submodule;
    public get parentSubmodule() {
        if (!this.#initialized)
            throw new Error('Not initialized');

        return this.#parentSubmodule;
    }

    // #state: State = {};
    // public get state() {
    //     return this.#state;
    // }

    public static parse(value: unknown) {
        return this.fromSchema(ConfigSchema.parse(value));
    }
    public static fromSchema(value: Zod.infer<typeof ConfigSchema>) {
        const config = new Config({
            ...value,
            upstreams: value.upstreams?.map(i => ({ ...i })) ?? [],
            submodules: value.submodules?.map( i => Submodule.fromSchema(i)) ?? [],
            features: value.features?.map(i => Feature.fromSchema(i)) ?? [],
            releases: value.releases?.map(i => Release.fromSchema(i)) ?? [],
            hotfixes: value.hotfixes?.map(i => Hotfix.fromSchema(i)) ?? [],
            supports: value.supports?.map(i => Support.fromSchema(i)) ?? [],
            included: value.included?.slice() ?? [],
            excluded: value.excluded?.slice() ?? [],
            tags: value.tags?.slice() ?? []
        });

        return config;
    }

    // Create a new config with a random identifier
    public static createNew() {
        return new Config({
            identifier: Uuid().replace(/-/g, ''),
            upstreams: [],
            submodules: [],
            features: [],
            releases: [],
            hotfixes: [],
            supports: [],
            included: [],
            excluded: [],
            tags: [],
            isNew: true
        });
    }

    public constructor(params: ConfigParams) {
        this.identifier = params.identifier;
        this.upstreams = params.upstreams;
        this.submodules = params.submodules;
        this.features = params.features;
        this.releases = params.releases;
        this.hotfixes = params.hotfixes;
        this.supports = params.supports;
        this.included = params.included;
        this.excluded = params.excluded;
        this.featureMessageTemplate = params.featureMessageTemplate;
        this.releaseMessageTemplate = params.releaseMessageTemplate;
        this.hotfixMessageTemplate = params.hotfixMessageTemplate;
        this.releaseTagTemplate = params.releaseTagTemplate;
        this.hotfixTagTemplate = params.hotfixTagTemplate;

        this.isNew = params.isNew ?? false;
        this.managed = params.managed ?? true;

        this.tags = params.tags ?? [];
    }

    // Register internals (initialize)
    public async register(path: string, sourceUri: string, baseHash: string, settings: Settings, loadRepoParams: Pick<LoadRepoConfigParams, 'verify'>, parentConfig?: Config, parentSubmodule?: Submodule, pathspec: string = 'root') {
        this.#initialized = true;

        this.#path = path;
        this.#sourceUri = sourceUri;
        this.#parentConfig = parentConfig;
        this.#parentSubmodule = parentSubmodule;
        this.#pathspec = pathspec;
        this.#baseHash = baseHash;
        this.#settings = settings;

        // const statePath = Path.join(path, '.gitflowstate');
        // this.#state = await FS.pathExists(statePath)
        //     ? await FS.readFile(statePath, 'utf8')
        //         .then(content => JSON.parse(content))
        //         .then(hash => StateSchema.parse(hash))
        //     : {};

        await Bluebird.map(this.submodules, i => i.register(this, loadRepoParams));
        await Bluebird.map(this.features, i => i.register(this));
        await Bluebird.map(this.releases, i => i.register(this));
        await Bluebird.map(this.hotfixes, i => i.register(this));
        await Bluebird.map(this.supports, i => i.register(this));
    }

    public flattenConfigs(): Config[] {
        return _.flatten([
            this,
            ...this.submodules.map(s => s.config.flattenConfigs())
        ]);
    }
    public async resolveFilteredConfigs(params: { included?: string[], excluded?: string[] } = {}): Promise<Config[]> {
        const configs: Config[] = [];
        await this.populateFilteredConfigs(configs, this, params);

        return configs;
    }
    private async populateFilteredConfigs(configs: Config[], rootConfig: Config, params: { included?: string[], excluded?: string[] }) {
        const match = async (uri: string) => {
            const [ type, pattern ] = uri.split('://', 2);

            if (type === 'repo') {
                return Minimatch(this.pathspec, pattern);
            }
            else {
                const artifact = await this.resolveCurrentArtifact();

                if (type === 'branch') {
                    return !!artifact.branch && Minimatch(artifact.branch, pattern);
                }
                else if (type === 'feature') {
                    return artifact.type === 'feature' && Minimatch(artifact.feature.name, pattern);
                }
                else if (type === 'release') {
                    return artifact.type === 'release' && Minimatch(artifact.release.name, pattern);
                }
                else if (type === 'hotfix') {
                    return artifact.type === 'hotfix' && Minimatch(artifact.hotfix.name, pattern);
                }
                else if (type === 'tag') {
                    const tags = [ ...this.tags, ...(this.parentSubmodule?.tags ?? []) ];
                    return tags.some(tag => Minimatch(tag, pattern));
                }
            }

            return false;
        }
        const matchAll = async (uris: string[]) => _.every(await Bluebird.map(uris, uri => match(uri)));

        const included = params.included ?? rootConfig.included;
        const excluded = params.excluded ?? rootConfig.excluded;
        if (((!included || !included.length) || await Bluebird.any(included.map(uri => matchAll(uri.split(';'))))) && ((!excluded || !excluded.length) || !await Bluebird.any(excluded.map(uri => matchAll(uri.split(';'))))))
            configs.push(this);

        for (const submodule of this.submodules)
            await submodule.config.populateFilteredConfigs(configs, rootConfig, params);
    }

    public async resolveCurrentArtifact(): Promise<Artifact> {
        const currentBranch = await this.resolveCurrentBranch();

        return this.resolveArtifactFromBranch(currentBranch);
    }
    public async resolveArtifactFromBranch(branchName: string): Promise<Artifact> {
        if (branchName === 'master') {
            return { type: 'master', branch: branchName };
        }
        else if (branchName === 'develop') {
            return { type: 'develop', branch: branchName };
        }
        else {
            const feature = this.features.find(f => f.branchName === branchName)
            if (feature)
                return { type: 'feature', branch: branchName, uri: feature.uri, feature };

            const release = this.releases.find(f => f.branchName === branchName)
            if (release)
                return { type: 'release', branch: branchName, uri: release.uri, release };

            const hotfix = this.hotfixes.find(f => f.branchName === branchName)
            if (hotfix)
                return { type: 'hotfix', branch: branchName, uri: hotfix.uri, hotfix };

            return { type: 'unknown', branch: branchName }
        }
    }

    public async hasElement(uri: string) {
        return this.parseElement(uri).then(() => true).catch(() => false);
    }

    public async findElement<T extends Element['type']>(type: T, path: string) {
        const fromElement = await this.parseElement(`${type}://${path}`);

        if (fromElement.type !== type)
            throw new Error(`Element type mismatch [${fromElement.type} / ${type}]`);
    
        return fromElement as NarrowedElement<Element, T>;
    }

    public async parseElement(uri: string): Promise<Element> {
        const [ type, value ] = ElementSchema.parse(uri.split('://', 2));

        if (type === 'branch') {
            if (!await this.branchExists(value))
                throw new Error(`Branch ${value} does not exist`);

            return { type: 'branch', branch: value };
        }
        else if (type === 'repo') {
            const parts = value.split('/');

            let config;
            for (let a = 0; a < parts.length; a++) {
                if (a === 0 && parts[a] === 'root') {
                    config = this;
                }
                else {
                    const submodule = this.submodules.find(s => s.name === parts[a])
                    if (!submodule)
                        throw new Error(`Submodule ${parts[a]} does not exist`);

                    config = submodule.config;
                }
            }

            if (!config)
                throw new Error(`Config for repo ${value} does not exist`);

            return { type: 'repo', config };
        }
        else if (type === 'feature') {
            const parts = value.split(':');

            if (parts.length === 2) {
                const support = this.supports.find(s => s.name === parts[0]);
                if (!support)
                    throw new Error(`Support ${value} does not exist`);

                const feature = support.features.find(f => f.name === parts[1]);
                if (!feature)
                    throw new Error(`Feature ${value} does not exist`);
    
                return { type: 'feature', feature };
            }
            else {
                const feature = this.features.find(f => f.name === value);
                if (!feature)
                    throw new Error(`Feature ${value} does not exist`);
    
                return { type: 'feature', feature };
            }
        }
        else if (type === 'release') {
            const parts = value.split(':');

            if (parts.length === 2) {
                const support = this.supports.find(s => s.name === parts[0]);
                if (!support)
                    throw new Error(`Support ${value} does not exist`);

                const release = support.releases.find(r => r.name === parts[1]);
                if (!release)
                    throw new Error(`Release ${value} does not exist`);
    
                return { type: 'release', release };
            }
            else {
                const release = this.releases.find(r => r.name === value);
                if (!release)
                    throw new Error(`Release ${value} does not exist`);
    
                return { type: 'release', release };
            }
        }
        else if (type === 'hotfix') {
            const parts = value.split(':');

            if (parts.length === 2) {
                const support = this.supports.find(s => s.name === parts[0]);
                if (!support)
                    throw new Error(`Support ${value} does not exist`);

                const hotfix = support.hotfixes.find(h => h.name === parts[1]);
                if (!hotfix)
                    throw new Error(`Hotfix ${value} does not exist`);
    
                return { type: 'hotfix', hotfix };
            }
            else {
                const hotfix = this.hotfixes.find(h => h.name === value);
                if (!hotfix)
                    throw new Error(`Hotfix ${value} does not exist`);
    
                return { type: 'hotfix', hotfix };
            }
        }
        else if (type === 'support') {
            const parts = value.split('/');

            if (parts.length === 2) {
                const support = this.supports.find(s => s.name === parts[0]);
                if (!support)
                    throw new Error(`Support ${value} does not exist`);
    
                return { type: 'support', support, targetBranch: Zod.union([ Zod.literal('master'), Zod.literal('develop') ]).parse(parts[1]) };
            }
            else {
                const support = this.supports.find(s => s.name === value);
                if (!support)
                    throw new Error(`Support ${value} does not exist`);
    
                return { type: 'support', support };
            }
        }
        else {
            throw new Error(`Could not parse element ${uri}`);
        }
    }

    public async resolveCurrentElement(): Promise<Element> {
        const currentBranch = await this.resolveCurrentBranch();

        return this.resolveElementFromBranch(currentBranch);
    }
    public async resolveElementFromBranch(branchName: string): Promise<Element> {
        const feature = this.features.find(f => f.branchName === branchName)
        if (feature)
            return { type: 'feature', feature };

        const release = this.releases.find(f => f.branchName === branchName)
        if (release)
            return { type: 'release', release };

        const hotfix = this.hotfixes.find(f => f.branchName === branchName)
        if (hotfix)
            return { type: 'hotfix', hotfix };

        const support = this.supports.find(f => f.developBranchName === branchName || f.masterBranchName === branchName)
        if (support)
            return { type: 'support', support };

        return { type: 'branch', branch: branchName }
    }

    public getStateValue(key: string | string[], type: 'string'): Promise<string | undefined>;
    public getStateValue(key: string | string[], type: 'number'): Promise<number | undefined>;
    public getStateValue(key: string | string[], type: 'boolean'): Promise<boolean | undefined>;
    public getStateValue(key: string | string[], type: 'nested'): Promise<State | undefined>;
    public async getStateValue(key: string | string[], type: 'string' | 'number' | 'boolean' | 'nested'): Promise<StateValue | undefined> {
        const state = await this.loadState();

        return getStateGenericValue(state, key, type);
    }

    public async setStateValue(key: string | string[], value?: StateValue | StateProxyValue) {
        const state = await this.loadState();

        setStateValue(state, key, value);

        await this.saveState(state);
    }
    public async setStateValues(glob: string, value?: StateValue | StateProxyValue) {
        const state = await this.loadState();

        const matchedKeys = _(state)
            .keys()
            .filter(key => Minimatch(key, glob))
            .value();

        for (const key of matchedKeys)
            setStateValue(state, key, value);

        await this.saveState(state);
    }

    public async verify({ stdout, dryRun }: ExecParams = {}) {
        const identifierPath = Path.join(this.path, '.glf', 'identifier');
        if (await FS.pathExists(identifierPath)) {
            const identifier = await FS.readFile(identifierPath, 'utf8');
            if (identifier !== this.identifier)
                throw new Error(`Source identifier verification failed (expected ${identifier} but received ${this.identifier})`);
        }
    }

    public resolveFeatureFqn(featureName: string) {
        return featureName;
        // const parts = featureName.split('/');

        // let targetContext: Config = this;
        // for (let a = 0; a < parts.length - 1; a++) {
        //     const submodule = targetContext.submodules.find(s => s.name === parts[a]);
        //     if (!submodule)
        //         throw new Error(`Submodule ${parts[a]} not found`);

        //     targetContext = submodule.config;
        // }

        // return `${targetContext.identifier}/${parts[parts.length - 1]}`;
    }

    // Find all features with a specified FQN recursively
    public findFeatures(featureFqn: string): Feature[] {
        return [
            ...this.features.filter(f => f.name === featureFqn),
            ..._.flatMap(this.submodules, s => s.config.findFeatures(featureFqn))
        ];
    }
    // Find all releases with a specified FQN recursively
    public findReleases(releaseFqn: string): Release[] {
        return [
            ...this.releases.filter(f => f.name === releaseFqn),
            ..._.flatMap(this.submodules, s => s.config.findReleases(releaseFqn))
        ];
    }

    public async initializeFeature(featureFqn: string, { stdout, dryRun }: ExecParams = {}) {
        await Bluebird.map(this.features.filter(f => f.name === featureFqn), async feature => {
            if (!await feature.branchExists({ stdout, dryRun })) {
                await feature.createBranch({ stdout, dryRun });
                stdout?.write(Chalk.blue(`Branch ${feature.branchName} created [${this.path}]\n`));
            }
        }, { concurrency: 1 });

        await Bluebird.map(this.submodules, async submodule => {
            await submodule.config.initializeFeature(featureFqn, { stdout, dryRun });
        }, { concurrency: 1 });
    }

    // Initialize the config and its associated repo
    public async init({ stdout, dryRun, writeGitmdoulesConfig }: ExecParams & { writeGitmdoulesConfig?: boolean } = {}) {
        if (!this.managed) {
            stdout?.write(Chalk.yellow("Repo not managed, bypassing\n"));

            // Initialize submodules
            for (const submodule of this.submodules)
                await submodule.init({ stdout, dryRun });
        }
        else {
            // Either perform fetch for existing repo or clone/initialize new repo
            if (await FS.pathExists(this.path)) {
                if (await FS.pathExists(Path.resolve(this.path, '.git'))) {
                    await exec(`git fetch --all --prune`, { cwd: this.path, stdout, dryRun });
                }
                else {
                    const originUpstream = this.upstreams.find(r => r.name == 'origin');
                    if (originUpstream) {
                        await exec(`git init`, { cwd: this.path, stdout, dryRun });
                        await exec(`git remote add ${originUpstream.name} ${originUpstream.url}`, { cwd: this.path, stdout, dryRun });
                        await exec(`git fetch`, { cwd: this.path, stdout, dryRun });

                        if (!await this.remoteBranchExists('master', originUpstream.name, { stdout, dryRun })) {
                            await exec(`git commit --allow-empty -m "initial commit"`, { cwd: this.path, stdout, dryRun });
                        }
                    }
                    else {
                        await exec(`git init`, { cwd: this.path, stdout, dryRun });
                        await exec(`git commit --allow-empty -m "initial commit"`, { cwd: this.path, stdout, dryRun });
                    }
                }
            }
            else {
                const originUpstream = this.upstreams.find(r => r.name == 'origin');
                if (originUpstream) {
                    await exec(`git clone ${originUpstream.url} ${this.path}`, { stdout, dryRun });

                    if (!await this.branchExists('master', { stdout, dryRun })) {
                        await exec(`git commit --allow-empty -m "initial commit"`, { cwd: this.path, stdout, dryRun });
                    }
                }
                else {
                    await FS.ensureDir(this.path);
                    await exec(`git init`, { cwd: this.path, stdout, dryRun });
                    await exec(`git commit --allow-empty -m "initial commit"`, { cwd: this.path, stdout, dryRun });
                }
            }

            // Add upstreams if missing
            for (const upstream of this.upstreams) {
                if (!await this.upstreamExists(upstream.name, { stdout, dryRun })) {
                    await exec(`git remote add ${upstream.name} ${upstream.url}`, { cwd: this.path, stdout, dryRun });
                    await exec(`git fetch`, { cwd: this.path, stdout, dryRun });
                }
            }

            // Create master branch if missing
            if (!await this.branchExists('master', { stdout, dryRun })) {
                if (await this.remoteBranchExists('master', 'origin', { stdout, dryRun })) {
                    const currentBranch = await this.resolveCurrentBranch({ stdout, dryRun }).catch(() => undefined);
                    await exec(`git checkout -b master --track origin/master`, { cwd: this.path, stdout, dryRun });
                    currentBranch && await this.checkoutBranch(currentBranch, { stdout, dryRun });
                }
                else {
                    const initialSha = await this.execCmd('git rev-list --max-parents=0 HEAD', { stdout, dryRun });
                    await this.createBranch('master', { source: initialSha, stdout, dryRun });
                }
            }
            // else if (await this.remoteBranchExists('master', 'origin', { stdout, dryRun }) && !(await this.resolveBranchUpstream('master', { stdout, dryRun }))) {
            //     const currentBranch = await this.resolveCurrentBranch({ stdout, dryRun });

            //     await this.checkoutBranch('master', { stdout, dryRun });
            //     await this.exec('git branch -u origin/master', { stdout, dryRun });
            //     await this.checkoutBranch(currentBranch, { stdout, dryRun });
            // }

            // Create develop branch if missing
            if (!await this.branchExists('develop', { stdout, dryRun })) {
                if (await this.remoteBranchExists('develop', 'origin', { stdout, dryRun })) {
                    const currentBranch = await this.resolveCurrentBranch({ stdout, dryRun }).catch(() => undefined);
                    await exec(`git checkout -b develop --track origin/develop`, { cwd: this.path, stdout, dryRun });
                    currentBranch && await this.checkoutBranch(currentBranch, { stdout, dryRun });
                }
                else {
                    const initialSha = await this.execCmd('git rev-list --max-parents=0 HEAD', { stdout, dryRun });
                    await this.createBranch('develop', { source: initialSha, stdout, dryRun });
                }

                await this.checkoutBranch('develop', { stdout, dryRun });
            }
            // else if (await this.remoteBranchExists('develop', 'origin', { stdout, dryRun }) && !(await this.resolveBranchUpstream('develop', { stdout, dryRun }))) {
            //     const currentBranch = await this.resolveCurrentBranch({ stdout, dryRun });

            //     await this.checkoutBranch('develop', { stdout, dryRun });
            //     await this.exec('git branch -u origin/develop', { stdout, dryRun });
            //     await this.checkoutBranch(currentBranch, { stdout, dryRun });
            // }

            // // Create gitflow branch if missing
            // if (!await this.branchExists('gitflow', { stdout, dryRun })) {
            //     const currentBranch = await this.resolveCurrentBranch({ stdout, dryRun });

            //     await this.checkoutBranch('gitflow', { orphan: true, stdout, dryRun });
            //     await exec(`git reset HEAD -- .`, { cwd: this.path, stdout, dryRun });

            //     const gitignorePath = Path.resolve(this.path, '.gitignore');
            //     !dryRun && await FS.writeFile(gitignorePath, '*\n!*/\n');
            //     stdout?.write(Chalk.gray(`.gitignore written to ${gitignorePath}\n`));
            //     await exec('git add -f .gitignore', { cwd: this.path, stdout, dryRun });

            //     await exec(`git commit --allow-empty -m "initial commit"`, { cwd: this.path, stdout, dryRun });

            //     await this.checkoutBranch(currentBranch, { stdout, dryRun });
            // }

            // // Add origin upstream if missing
            // if (this.parentSubmodule?.url && !await this.upstreamExists('origin', { stdout, dryRun }))
            //     this.createUpstream('origin', this.parentSubmodule.url, { stdout, dryRun });

            // Initialize submodules
            for (const submodule of this.submodules)
                await submodule.init({ stdout, dryRun });

            // Initialize features
            for (const feature of this.features)
                await feature.init({ stdout, dryRun });

            // Initialize releases
            for (const release of this.releases)
                await release.init({ stdout, dryRun });

            // Initialize hotfixes
            for (const hotfix of this.hotfixes)
                await hotfix.init({ stdout, dryRun });

            // Initialize supports
            for (const support of this.supports)
                await support.init({ stdout, dryRun });

            // // Save updated config to disk
            // await this.save({ stdout, dryRun });
        }

        // Update .gitmodules config with submodules
        if (writeGitmdoulesConfig && this.submodules.length > 0)
            this.writeGitmodulesConfig({ stdout, dryRun });

        const sourceUriPath = Path.join(this.path, '.glf', 'source_uri');
        await FS.outputFile(sourceUriPath, this.sourceUri, {
            encoding: 'utf8'
        });

        const identifierPath = Path.join(this.path, '.glf', 'identifier');
        await FS.writeFile(identifierPath, this.identifier, {
            encoding: 'utf8'
        });
    }

    public writeGitmodulesConfig({ stdout, dryRun }: ExecParams = {}) {
        if (dryRun)
            return;

        const gitmodulesPath = Path.join(this.path, '.gitmodules');

        const gitmodulesStream = FS.createWriteStream(gitmodulesPath);
        for (const repo of this.submodules) {
            const resolvedPath = Path.posix.join(repo.path);

            const originUpstream = repo.config.upstreams.find(u => u.name === 'origin');

            gitmodulesStream.write(`[submodule "${repo.name}"]\n`);
            gitmodulesStream.write(`    path = ${resolvedPath}\n`);
            gitmodulesStream.write(`    url = "${originUpstream?.url ?? ''}"\n`);
        }
        gitmodulesStream.close();

        stdout?.write(Chalk.gray(`Gitmodules config written to ${gitmodulesPath}\n`));
    }

    public async deleteFeature(feature: Feature) {
        const state = await this.loadState();
        delete state[feature.stateKey];
        await this.saveState(state);

        const idx = this.features.indexOf(feature);
        this.features.splice(idx, 1);
    }
    public async deleteRelease(release: Release) {
        const state = await this.loadState();
        delete state[release.stateKey];
        await this.saveState(state);

        const idx = this.releases.indexOf(release);
        this.releases.splice(idx, 1);
    }
    public async deleteHotfix(hotfix: Hotfix) {
        const state = await this.loadState();
        delete state[hotfix.stateKey];
        await this.saveState(state);

        const idx = this.hotfixes.indexOf(hotfix);
        this.hotfixes.splice(idx, 1);
    }
    public async deleteSupport(support: Support) {
        const state = await this.loadState();
        delete state[support.stateKey];
        await this.saveState(state);

        const idx = this.supports.indexOf(support);
        this.supports.splice(idx, 1);
    }

    // Save the config to disk
    public async save({ stdout, dryRun }: ExecParams = {}) {
        await this.saveV2({ stdout, dryRun });
        // const configPath = Path.join(this.path, '.gitflow.yml');
        // if (!dryRun) {
        //     const content = Yaml.dump(this);
        //     await FS.writeFile(configPath, content, 'utf8');
        // }
        // stdout?.write(Chalk.gray(`Config written to ${configPath}\n`));
    }
    public async saveRepo({ stdout, dryRun }: ExecParams = {}) {
        stdout = stdout && TestTransform.create(stdout, Chalk.gray('[saveRepo]'));

        const existingConfig = await loadRepoConfig(this.settings, { cwd: this.path, stdout, dryRun });

        const currentHash = this.calculateHash();
        if (currentHash !== existingConfig.calculateHash()) {
            const currentBranch = await this.resolveCurrentBranch({ stdout, dryRun });
            await this.checkoutBranch('gitflow', { stdout, dryRun });

            const configPath = Path.join(this.path, '.gitflow.yml');
            if (!dryRun)
                await FS.writeFile(configPath, Yaml.dump(this), 'utf8');
            stdout?.write(Chalk.gray(`Config written to ${configPath}\n`));

            await exec('git add -f .gitflow.yml', { cwd: this.path, stdout, dryRun });
            await exec(`git commit -m "gitflow config update <${currentHash}>" .gitflow.yml`, { cwd: this.path, stdout, dryRun });

            await this.checkoutBranch(currentBranch, { stdout, dryRun });

            // if (await this.upstreamExists('origin', { stdout, dryRun }))
            //     await this.push('origin', 'gitflow', { stdout, dryRun });
        }
    }
    public async saveV2({ stdout, dryRun }: ExecParams = {}) {
        // stdout = stdout && TestTransform.create(stdout, Chalk.gray('[saveV2]'));

        stdout?.write(Chalk.gray(`Saving config to ${this.sourceUri}\n`));

        const configRef = parseConfigReference(this.sourceUri);
        if (configRef.type === 'file') {
            if (!dryRun) {
                const content = Yaml.dump(this);
                await FS.writeFile(configRef.path, content, 'utf8');
            }
            stdout?.write(Chalk.gray(`Config written to ${configRef.path}\n`));
        }
        else if (configRef.type === 'branch') {
            const existingConfig = await loadV2Config(this.sourceUri, this.settings, { cwd: this.path, stdout, dryRun });

            const currentHash = this.calculateHash();
            if (currentHash !== existingConfig.calculateHash()) {
                const currentBranch = await this.resolveCurrentBranch({ stdout, dryRun });
                await this.checkoutBranch(configRef.branchName, { stdout, dryRun });

                const configPath = Path.join(this.path, '.gitflow.yml');
                if (!dryRun)
                    await FS.writeFile(configPath, Yaml.dump(this), 'utf8');
                stdout?.write(Chalk.gray(`Config written to ${configPath}\n`));

                await exec('git add -f .gitflow.yml', { cwd: this.path, stdout, dryRun });
                await exec(`git commit -m "gitflow config update <${currentHash}>" .gitflow.yml`, { cwd: this.path, stdout, dryRun });

                await this.checkoutBranch(currentBranch, { stdout, dryRun });

                // if (await this.upstreamExists('origin', { stdout, dryRun }))
                //     await this.push('origin', 'gitflow', { stdout, dryRun });
            }
        }
        else if (configRef.type === 'http') {
            if (!dryRun) {
                await Axios.put(`${configRef.protocol}://${configRef.url}`, this.toHash(), {
                    headers: {
                        'if-match': this.baseHash
                    }
                });
            }
        }
        else if (configRef.type === 'glfs') {
            const [hostUrl, apiKey] = (() => {
                const matchedRepo = configRef.hostname
                    ? this.settings.glfsRepositories.find(r => r.name === configRef.hostname)
                    : this.settings.getDefaultRepo();

                if (matchedRepo)
                    return [matchedRepo.url, matchedRepo.apiKey];
                else
                    return [`http://${configRef.hostname}`];
            })();

            if (!dryRun) {
                await Axios.put(`${hostUrl}/v1/${configRef.namespace}/${configRef.name}`, this.toHash(), {
                    headers: {
                        'if-match': this.baseHash
                    },
                    auth: apiKey ? {
                        username: 'glf.cli',
                        password: apiKey
                    } : undefined
                });
            }
        }
        else {
            throw new Error(`Unsupported config type ${configRef.type}`);
        }
    }

    public async loadState() {
        const statePath = Path.join(this.path, '.glf', 'state.json');

        return loadState(statePath);
    }
    public async saveState(state: State) {
        const statePath = Path.join(this.path, '.glf', 'state.json');

        await saveState(statePath, state);
    }

    public async exec(cmd: string, { stdout, dryRun, echo }: ExecParams = {}) {
        await exec(cmd, { cwd: this.path, stdout, dryRun, echo });
    }
    public async execCmd(cmd: string, { stdout, dryRun, echo, trim }: ExecParams & { trim?: boolean } = {}) {
        return await execCmd(cmd, { cwd: this.path, stdout, dryRun, echo, trim });
    }

    public async fetch({ stdout, dryRun }: ExecParams = {}) {
        await exec(`git fetch --all`, { cwd: this.path, stdout, dryRun });
    }
    public async stage(files: string[], { stdout, dryRun }: ExecParams = {}) {
        await exec(`git add ${files.join(' ')}`, { cwd: this.path, stdout, dryRun });
    }
    public async commit(message: string, { amend, stdout, dryRun }: ExecParams & CommitParams = {}) {
        await exec(`git commit -m "${message}"${amend ? ' --amend' : ''}`, { cwd: this.path, stdout, dryRun });
    }
    public async push(upstreamName: string, branchName: string, { setUpstream, stdout, dryRun }: ExecParams & PushParams = {}) {
        await exec(`git push${setUpstream ? ' -u' : ''} ${upstreamName} ${branchName}`, { cwd: this.path, stdout, dryRun });
    }
    public async tag(tag: string, { source, annotation, stdout, dryRun }: ExecParams & TagParams = {}) {
        if (source || annotation) {
            await exec(`git tag -a ${tag}${annotation ? ` -m "${annotation}"` : ''}${source ? ` ${source}` : ''}`, { cwd: this.#path, stdout, dryRun });
        }
        else {
            await exec(`git tag ${tag}`, { cwd: this.#path, stdout, dryRun });
        }
    }

    public async upstreamExists(upstreamName: string, { stdout, dryRun }: ExecParams = {}) {
        return !!await execCmd(`git remote show ${upstreamName}`, { cwd: this.path, stdout, dryRun }).catch(err => false);
    }
    public async createUpstream(upstreamName: string, upstreamUrl: string, { stdout, dryRun }: ExecParams = {}) {
        await exec(`git remote add ${upstreamName} ${upstreamUrl}`, { cwd: this.path, stdout, dryRun });
    }

    public async checkoutBranch(branchName: string, { orphan, stdout, dryRun }: ExecParams & CheckoutBranchParams = {}) {
        // stdout = stdout && TestTransform.create(stdout, Chalk.gray('[checkoutBranch]'));

        await exec(`git checkout ${orphan ? '--orphan ' : ''}${branchName}`, { cwd: this.path, stdout, dryRun });
    }
    public async createBranch(branchName: string, { source, stdout, dryRun }: ExecParams & CreateBranchParams = {}) {
        if (source)
            await exec(`git branch ${branchName} ${source}`, { cwd: this.path, stdout, dryRun });
        else
            await exec(`git branch ${branchName}`, { cwd: this.path, stdout, dryRun });
    }
    public async deleteBranch(branchName: string, { stdout, dryRun }: ExecParams = {}) {
        await exec(`git branch -D ${branchName}`, { cwd: this.path, stdout, dryRun });
    }
    public async deleteRemoteBranch(branchName: string, upstreamName: string, { stdout, dryRun }: ExecParams = {}) {
        await exec(`git push -d ${upstreamName} ${branchName}`, { cwd: this.path, stdout, dryRun });
    }
    public async branchExists(branchName: string, { stdout, dryRun }: ExecParams = {}) {
        return !!await execCmd(`git branch --list ${branchName}`, { cwd: this.path, stdout, dryRun });
    }
    public async remoteBranchExists(branchName: string, upstreamName: string, { stdout, dryRun }: ExecParams = {}) {
        return await this.upstreamExists(upstreamName, { stdout, dryRun }) && !!await execCmd(`git ls-remote --heads ${upstreamName} ${branchName}`, { cwd: this.path, stdout, dryRun });
    }

    public async isDirty({ stdout, dryRun }: ExecParams = {}) {
        await exec(`git update-index --refresh`, { cwd: this.path, stdout, dryRun }).catch(() => {});

        return await execCmd(`git diff-index --quiet HEAD`, { cwd: this.path, stdout, dryRun })
            .then(() => false)
            .catch(() => true);
    }
    public async hasStagedChanges({ stdout, dryRun }: ExecParams = {}) {
        return !!await execCmd(`git diff --name-only --cached`, { cwd: this.path, stdout, dryRun });
    }
    public async isMergeInProgress({ stdout, dryRun }: ExecParams = {}) {
        return exec('git merge HEAD', { cwd: this.path, stdout, dryRun })
            .then(() => false)
            .catch(() => true);
    }

    public async merge(branchName: string, { squash, message, noCommit, strategy, noFastForward, stdout, dryRun }: ExecParams & MergeParams = {}) {
        if (squash) {
            await exec(`git merge --squash ${branchName}${noFastForward ? ' --no-ff' : ''}${message ? ` -m "${message}"` : ''}${noCommit ? ' --no-commit' : ''}${strategy ? ` -X ${strategy}` : ''}`, { cwd: this.path, stdout, dryRun });
        }
        else {
            await exec(`git merge ${branchName}${noFastForward ? ' --no-ff' : ''}${message ? ` -m "${message}"` : ''}${noCommit ? ' --no-commit' : ''}${strategy ? ` -X ${strategy}` : ''}`, { cwd: this.path, stdout, dryRun });
        }
    }
    public async abortMerge({ stdout, dryRun }: ExecParams = {}) {
        await exec(`git merge --abort`, { cwd: this.path, stdout, dryRun });
    }
    public async resetMerge({ stdout, dryRun }: ExecParams = {}) {
        await exec(`git reset --merge`, { cwd: this.path, stdout, dryRun });
    }

    public async resolveCurrentBranch({ stdout, dryRun }: ExecParams = {}) {
        return execCmd(`git rev-parse --abbrev-ref HEAD`, { cwd: this.path, stdout, dryRun });
    }

    public async resolveCommitSha(target: string, { stdout, dryRun }: ExecParams = {}) {
        return execCmd(`git rev-parse ${target}`, { cwd: this.path, stdout, dryRun });
    }

    public async resolveStatuses({ stdout, dryRun }: ExecParams = {}) {
        const rawStatus = await this.execCmd('git status -uall --porcelain=v1', { stdout, dryRun, trim: false });

        return _.compact(rawStatus.split('\n').map(line => {
            if (!line)
                return;

            const typeCode = line.substring(0, 2);
            const path = line.substring(3);

            if (typeCode === '??')
                return { type: 'untracked', path } as const;
            else if (typeCode === ' M')
                return { type: 'modified', staged: false, path } as const;
            else if (typeCode === 'M ')
                return { type: 'modified', staged: true, path } as const;
            else if (typeCode === ' A')
                return { type: 'added', staged: false, path } as const;
            else if (typeCode === 'A ')
                return { type: 'added', staged: true, path } as const;
            else if (typeCode === ' D')
                return { type: 'deleted', staged: false, path } as const;
            else if (typeCode === 'D ')
                return { type: 'deleted', staged: true, path } as const;
            else if (typeCode === ' R')
                return { type: 'renamed', staged: false, path } as const;
            else if (typeCode === 'R ')
                return { type: 'renamed', staged: true, path } as const;
            else if (typeCode === ' C')
                return { type: 'copied', staged: false, path } as const;
            else if (typeCode === 'C ')
                return { type: 'copied', staged: true, path } as const;
            else
                return { type: 'unknown', path } as const;
        }));
    }

    public async resolveBranchUpstream(branchName: string, { stdout, dryRun }: ExecParams = {}) {
        return execCmd(`git branch --list ${branchName} --format="%(upstream)"`, { cwd: this.path, stdout, dryRun });
    }

    public async resolveBranchStatus(branchName: string, upstream: string, { stdout, dryRun }: ExecParams = {}) {
        const upstreamBranchName = `${upstream}/${branchName}`;
        const localExists = await this.branchExists(branchName, { stdout, dryRun });
        const upstreamExists = await this.upstreamExists(upstream, { stdout, dryRun });
        const upstreamBranchExists = await this.remoteBranchExists(branchName, upstream, { stdout, dryRun });
        const localSha = await this.resolveCommitSha(branchName, { stdout, dryRun }).catch(() => undefined);
        const upstreamSha = await this.resolveCommitSha(upstreamBranchName, { stdout, dryRun }).catch(() => undefined);

        return {
            branchName,
            upstream,
            upstreamBranchName,
            localExists,
            upstreamExists,
            upstreamBranchExists,
            resolveCommitsBehind: ({ stdout }: ExecParams = {}) => this.execCmd(`git rev-list --count ${branchName}..${upstreamBranchName}`, { stdout })
                .then(value => parseInt(value))
                .catch(() => -1),
            resolveCommitsAhead: ({ stdout }: ExecParams = {}) => this.execCmd(`git rev-list --count ${upstreamBranchName}..${branchName}`, { stdout })
                .then(value => parseInt(value))
                .catch(() => -1),
            localSha,
            upstreamSha,
            differs: localExists && upstreamExists && localSha !== upstreamSha
        };
    }

    public async checkout<T>(branchName: string, handler: () => T | Promise<T>, { orphan, stdout, dryRun }: ExecParams & CheckoutBranchParams = {}) {
        const originalBranchName = await this.resolveCurrentBranch({ stdout });

        originalBranchName !== branchName && await this.checkoutBranch(branchName, { orphan, stdout, dryRun });
        const result = await handler();
        originalBranchName !== branchName && await this.checkoutBranch(originalBranchName, { stdout, dryRun });

        return result;
    }

    public async resolveActiveSupport() {
        const activeSupportName = await this.getStateValue('activeSupport', 'string');
        const activeSupport = activeSupportName ? this.supports.find(s => s.name === activeSupportName) : undefined;

        return activeSupport;
    }

    public migrateSource({ sourceUri, baseHash }: { sourceUri?: string, baseHash?: string } = {}) {
        if (sourceUri)
            this.#sourceUri = sourceUri;

        if (baseHash)
            this.#baseHash = baseHash;
    }

    public toRecursiveHash(): Zod.infer<typeof RecursiveConfigSchema> {
        return {
            ...this.toHash(),
            submodules: this.submodules.map(s => s.toRecursiveHash())
        }
    }

    // public toJSON() {
    //     return {
    //         identifier: this.identifier,
    //         submodules: this.submodules.map(i => i.toJSON())
    //     }
    // }

    public async hasNestedElement(uri: string) {
        for (const submodule of this.submodules) {
            if (await submodule.config.hasElement(uri) || await submodule.config.hasNestedElement(uri))
                return true;
        }

        return false;
    }

    public async swapCheckout<T>(branchName: string, handler: () => T | Promise<T>, { stdout, dryRun }: ExecParams = {}) {
        const currentBranch = await this.resolveCurrentBranch({ stdout, dryRun });
        const currentBranchActive = currentBranch === branchName;

        if (!currentBranchActive)
            await this.checkoutBranch(branchName, { stdout, dryRun });

        try {
            const result = await handler();

            return result;
        }
        finally {
            if (!currentBranchActive)
                await this.checkoutBranch(currentBranch, { stdout, dryRun });
        }
    }
}

export interface Config extends ConfigBase {}
applyMixins(Config, [ ConfigBase ]);

export type SubmoduleParams = Pick<Submodule, 'name' | 'path' | 'url'> & Partial<Pick<Submodule, 'tags'>>;
export class Submodule {
    public name: string;
    public path: string;
    public url?: string;
    public tags: string[];

    #initialized: boolean = false;

    #config!: Config;
    public get config() {
        if (!this.#initialized)
            throw new Error('Not initialized');

        return this.#config;
    }

    #parentConfig!: Config;
    public get parentConfig() {
        if (!this.#initialized)
            throw new Error('Not initialized');

        return this.#parentConfig;
    }

    public static parse(value: unknown) {
        return this.fromSchema(ConfigSubmoduleSchema.parse(value));
    }
    public static fromSchema(value: Zod.infer<typeof ConfigSubmoduleSchema>) {
        return new this({
            ...value,
            tags: value.tags?.slice() ?? []
        });
    }

    public constructor(params: SubmoduleParams) {
        this.name = params.name;
        this.path = params.path;
        this.url = params.url;
        this.tags = params.tags ?? [];
    }

    public async register(parentConfig: Config, loadRepoParams: Pick<LoadRepoConfigParams, 'verify'>) {
        this.#initialized = true;

        this.#parentConfig = parentConfig;
        this.#config = await this.loadConfig(loadRepoParams);
    }

    public resolvePath() {
        return Path.join(this.parentConfig?.path ?? '.', this.path);
    }

    public async init({ stdout, dryRun }: ExecParams = {}) {
        // await this.config.init({ stdout, dryRun });

        if (await this.parentConfig.execCmd(`git submodule status ${this.path}`, { stdout, dryRun }).then(r => false).catch(() => true) && this.config.upstreams.length > 0)
            await this.parentConfig.exec(`git submodule add -f --name ${this.name} ${this.config.upstreams[0].url} ${this.path}`, { stdout, dryRun });
    }

    public async fetch({ stdout, dryRun }: ExecParams = {}) {
        await exec(`git fetch --all --prune`, { cwd: this.resolvePath(), stdout, dryRun })
    }
    public async clone({ stdout, dryRun }: ExecParams = {}) {
        const originRemote = this.config.upstreams.find(r => r.name == 'origin');
        if (!originRemote)
            throw new Error(`No origin remote specified for repo ${this.name}`);

        const repoPath = Path.resolve(this.parentConfig?.path ?? '.', this.path);
        await exec(`git clone ${originRemote.url} ${repoPath}`, { stdout, dryRun })
    }

    public async loadConfig(loadRepoParams: Pick<LoadRepoConfigParams, 'verify'>) {
        const config = await loadV2Config(this.url ?? 'branch://gitflow', this.parentConfig.settings, {
            ...loadRepoParams,
            cwd: this.resolvePath(),
            parentConfig: this.parentConfig,
            parentSubmodule: this,
            pathspecPrefix: `${this.parentConfig.pathspec + '/'}${this.name}`,
            // stdout: process.stdout //TMP!!
        });

        return config;
    }

    public toRecursiveHash(): Zod.infer<typeof RecursiveConfigSubmoduleSchema> {
        return {
            ...this.toHash(),
            config: this.config.toRecursiveHash()
        }
    }
}

export interface Submodule extends SubmoduleBase {}
applyMixins(Submodule, [ SubmoduleBase ]);

export type FeatureParams = Pick<Feature, 'name' | 'branchName' | 'sourceSha' | 'upstream'>;
export class Feature {
    public name: string;
    public branchName: string;
    public sourceSha: string;
    public upstream?: string;

    #initialized: boolean = false;

    #parentConfig!: Config;
    public get parentConfig() {
        if (!this.#initialized)
            throw new Error('Not initialized');

        return this.#parentConfig;
    }

    #parentSupport!: Support | undefined;
    public get parentSupport() {
        if (!this.#initialized)
            throw new Error('Not initialized');

        return this.#parentSupport;
    }

    public get uri() {
        return `feature://${this.parentSupport ? `${this.parentSupport.name}/` : ''}${this.name}`;
    }
    public get stateKey() {
        return `feature/${this.parentSupport ? `${this.parentSupport.name}/` : ''}${this.name}`;
    }

    public static parse(value: unknown) {
        return this.fromSchema(ConfigFeatureSchema.parse(value));
    }
    public static fromSchema(value: Zod.infer<typeof ConfigFeatureSchema>) {
        return new this({
            ...value
        });
    }

    public constructor(params: FeatureParams) {
        this.name = params.name;
        this.branchName = params.branchName;
        this.sourceSha = params.sourceSha;
        this.upstream = params.upstream;
    }

    public async register(parentConfig: Config, parentSupport?: Support) {
        this.#initialized = true;

        this.#parentConfig = parentConfig;
        this.#parentSupport = parentSupport;
    }

    public async init({ stdout, dryRun }: ExecParams = {}) {
        if (!await this.parentConfig.branchExists(this.branchName, { stdout })) {
            if (this.upstream && await this.parentConfig.remoteBranchExists(this.branchName, this.upstream, { stdout })) {
                await exec(`git checkout -b ${this.branchName} ${this.upstream}/${this.branchName}`, { cwd: this.parentConfig.path, stdout, dryRun });
            }
            else {
                await this.parentConfig.createBranch(this.branchName, { source: this.sourceSha, stdout, dryRun });
            }
        }
    }

    public async branchExists({ stdout }: ExecParams = {}) {
        const result = await execCmd(`git branch --list ${this.branchName}`, { cwd: this.parentConfig?.path, stdout });

        return !!result;
    }

    public async createBranch({ stdout, dryRun }: ExecParams = {}) {
        await exec(`git branch ${this.branchName} develop`, { cwd: this.parentConfig?.path, stdout, dryRun });
    }
    public async checkoutBranch({ stdout, dryRun }: ExecParams = {}) {
        await exec(`git checkout ${this.branchName}`, { cwd: this.parentConfig?.path, stdout, dryRun });
    }

    public resolveCommitMessageTemplate() {
        return _.template(this.parentConfig.featureMessageTemplate ?? 'Feature <%= featureName %> Merged');
    }

    public swapCheckout<T>(handler: () => T | Promise<T>, { stdout, dryRun }: ExecParams = {}) {
        return this.parentConfig.swapCheckout(this.branchName, handler, { stdout, dryRun });
    }
}

export interface Feature extends FeatureBase {}
applyMixins(Feature, [ FeatureBase ]);

export type ReleaseParams = Pick<Release, 'name' | 'branchName' | 'sourceSha' | 'upstream'> & Partial<Pick<Release, 'intermediate'>>;
export class Release {
    public name: string;
    public branchName: string;
    public sourceSha: string;
    public upstream?: string;
    public intermediate: boolean;

    #initialized: boolean = false;

    #parentConfig!: Config;
    public get parentConfig() {
        if (!this.#initialized)
            throw new Error('Not initialized');

        return this.#parentConfig;
    }

    #parentSupport!: Support | undefined;
    public get parentSupport() {
        if (!this.#initialized)
            throw new Error('Not initialized');

        return this.#parentSupport;
    }

    public get uri() {
        return `release://${this.parentSupport ? `${this.parentSupport.name}/` : ''}${this.name}`;
    }
    public get stateKey() {
        return `release/${this.parentSupport ? `${this.parentSupport.name}/` : ''}${this.name}`;
    }

    public static parse(value: unknown) {
        return this.fromSchema(ConfigReleaseSchema.parse(value));
    }
    public static fromSchema(value: Zod.infer<typeof ConfigReleaseSchema>) {
        return new this({
            ...value
        });
    }

    public constructor(params: ReleaseParams) {
        this.name = params.name;
        this.branchName = params.branchName;
        this.sourceSha = params.sourceSha;
        this.upstream = params.upstream;
        this.intermediate = params.intermediate ?? false;
    }

    public async register(parentConfig: Config, parentSupport?: Support) {
        this.#initialized = true;

        this.#parentConfig = parentConfig;
        this.#parentSupport = parentSupport;
    }

    public async init({ stdout, dryRun }: ExecParams = {}) {
        if (!await this.parentConfig.branchExists(this.branchName, { stdout })) {
            if (this.upstream && await this.parentConfig.remoteBranchExists(this.branchName, this.upstream, { stdout })) {
                await exec(`git checkout -b ${this.branchName} ${this.upstream}/${this.branchName}`, { cwd: this.parentConfig.path, stdout, dryRun });
            }
            else {
                await this.parentConfig.createBranch(this.branchName, { source: this.sourceSha, stdout, dryRun });
            }
        }
    }

    public async branchExists({ stdout }: ExecParams = {}) {
        const result = await execCmd(`git branch --list ${this.branchName}`, { cwd: this.parentConfig?.path, stdout });

        return !!result;
    }
    public async createBranch({ stdout, dryRun }: ExecParams = {}) {
        await exec(`git branch ${this.branchName}`, { cwd: this.parentConfig?.path, stdout, dryRun })
    }

    public async initialize({ stdout, dryRun }: ExecParams = {}) {
        if (!await this.branchExists({ stdout, dryRun })) {
            await this.createBranch({ stdout, dryRun });
            stdout?.write(Chalk.blue(`Branch ${this.branchName} created [${this.parentConfig.path}]\n`));
        }
    }

    public resolveCommitMessageTemplate() {
        return _.template(this.parentConfig.releaseMessageTemplate ?? '<% if (intermediate) { %>Intermediate Release Merged<% } else { %>Release "<%= releaseName %>" Merged<% } %>');
    }
    public resolveTagTemplate() {
        return _.template(this.parentConfig.releaseTagTemplate ?? '<%= releaseName %>');
    }
}

export interface Release extends ReleaseBase {}
applyMixins(Release, [ ReleaseBase ]);

export type HotfixParams = Pick<Hotfix, 'name' | 'branchName' | 'sourceSha' | 'upstream'> & Partial<Pick<Hotfix, 'intermediate'>>;
export class Hotfix {
    public name: string;
    public branchName: string;
    public sourceSha: string;
    public upstream?: string;
    public intermediate: boolean;

    #initialized: boolean = false;

    #parentConfig!: Config;
    public get parentConfig() {
        if (!this.#initialized)
            throw new Error('Not initialized');

        return this.#parentConfig;
    }

    #parentSupport!: Support | undefined;
    public get parentSupport() {
        if (!this.#initialized)
            throw new Error('Not initialized');

        return this.#parentSupport;
    }

    public get uri() {
        return `hotfix://${this.parentSupport ? `${this.parentSupport.name}/` : ''}${this.name}`;
    }
    public get stateKey() {
        return `hotfix/${this.parentSupport ? `${this.parentSupport.name}/` : ''}${this.name}`;
    }

    public static parse(value: unknown) {
        return this.fromSchema(ConfigHotfixSchema.parse(value));
    }
    public static fromSchema(value: Zod.infer<typeof ConfigHotfixSchema>) {
        return new this({
            ...value
        });
    }

    public constructor(params: HotfixParams) {
        this.name = params.name;
        this.branchName = params.branchName;
        this.sourceSha = params.sourceSha;
        this.upstream = params.upstream;
        this.intermediate = params.intermediate ?? false;
    }

    public async register(parentConfig: Config, parentSupport?: Support) {
        this.#initialized = true;

        this.#parentConfig = parentConfig;
        this.#parentSupport = parentSupport;
    }

    public async init({ stdout, dryRun }: ExecParams = {}) {
        if (!await this.parentConfig.branchExists(this.branchName, { stdout })) {
            if (this.upstream && await this.parentConfig.remoteBranchExists(this.branchName, this.upstream, { stdout })) {
                await exec(`git checkout -b ${this.branchName} ${this.upstream}/${this.branchName}`, { cwd: this.parentConfig.path, stdout, dryRun });
            }
            else {
                await this.parentConfig.createBranch(this.branchName, { source: this.sourceSha, stdout, dryRun });
            }
        }
    }

    public async branchExists({ stdout }: ExecParams = {}) {
        const result = await execCmd(`git branch --list ${this.branchName}`, { cwd: this.parentConfig?.path, stdout });

        return !!result;
    }
    public async createBranch({ stdout, dryRun }: ExecParams = {}) {
        await exec(`git branch ${this.branchName}`, { cwd: this.parentConfig?.path, stdout, dryRun })
    }

    public async initialize({ stdout, dryRun }: ExecParams = {}) {
        if (!await this.branchExists({ stdout, dryRun })) {
            await this.createBranch({ stdout, dryRun });
            stdout?.write(Chalk.blue(`Branch ${this.branchName} created [${this.parentConfig.path}]\n`));
        }
    }

    public resolveCommitMessageTemplate() {
        return _.template(this.parentConfig.hotfixMessageTemplate ?? '<% if (intermediate) { %>Intermediate Hotfix Merged<% } else { %>Hotfix <%= hotfixName %> Merged<% } %>');
    }
    public resolveTagTemplate() {
        return _.template(this.parentConfig.hotfixTagTemplate ?? '<%= hotfixName %>');
    }
}

export interface Hotfix extends HotfixBase {}
applyMixins(Hotfix, [ HotfixBase ]);

export type SupportParams = Pick<Support, 'name' | 'masterBranchName' | 'developBranchName' | 'sourceSha' | 'features' | 'releases' | 'hotfixes' | 'upstream'>;
export class Support {
    public name: string;
    public masterBranchName: string;
    public developBranchName: string;
    public sourceSha: string;
    public upstream?: string;

    public features: Feature[];
    public releases: Release[];
    public hotfixes: Hotfix[];

    #initialized: boolean = false;

    #parentConfig!: Config;
    public get parentConfig() {
        if (!this.#initialized)
            throw new Error('Not initialized');

        return this.#parentConfig;
    }

    public get uri() {
        return `support://${this.name}`;
    }
    public get stateKey() {
        return `support/${this.name}`;
    }

    public static parse(value: unknown) {
        return this.fromSchema(ConfigSupportSchema.parse(value));
    }
    public static fromSchema(value: Zod.infer<typeof ConfigSupportSchema>) {
        return new this({
            ...value,
            features: value.features?.map(i => Feature.fromSchema(i)) ?? [],
            releases: value.releases?.map(i => Release.fromSchema(i)) ?? [],
            hotfixes: value.hotfixes?.map(i => Hotfix.fromSchema(i)) ?? []
        });
    }

    public constructor(params: SupportParams) {
        this.name = params.name;
        this.masterBranchName = params.masterBranchName;
        this.developBranchName = params.developBranchName;
        this.sourceSha = params.sourceSha;
        this.upstream = params.upstream;

        this.features = params.features;
        this.releases = params.releases;
        this.hotfixes = params.hotfixes;
    }

    public async register(parentConfig: Config) {
        this.#initialized = true;

        this.#parentConfig = parentConfig;

        await Bluebird.map(this.features, i => i.register(parentConfig, this));
        await Bluebird.map(this.releases, i => i.register(parentConfig, this));
        await Bluebird.map(this.hotfixes, i => i.register(parentConfig, this));
    }

    public async init({ stdout, dryRun }: ExecParams = {}) {
        if (!await this.parentConfig.branchExists(this.masterBranchName, { stdout })) {
            if (this.upstream && await this.parentConfig.remoteBranchExists(this.masterBranchName, this.upstream, { stdout })) {
                await exec(`git checkout -b ${this.masterBranchName} ${this.upstream}/${this.masterBranchName}`, { cwd: this.parentConfig.path, stdout, dryRun });
            }
            else {
                await this.parentConfig.createBranch(this.masterBranchName, { source: this.sourceSha, stdout, dryRun });
            }
        }

        if (!await this.parentConfig.branchExists(this.developBranchName, { stdout })) {
            if (this.upstream && await this.parentConfig.remoteBranchExists(this.developBranchName, this.upstream, { stdout })) {
                await exec(`git checkout -b ${this.developBranchName} ${this.upstream}/${this.developBranchName}`, { cwd: this.parentConfig.path, stdout, dryRun });
            }
            else {
                await this.parentConfig.createBranch(this.developBranchName, { source: this.sourceSha, stdout, dryRun });
            }
        }

        // Initialize features
        for (const feature of this.features)
            await feature.init({ stdout, dryRun });

        // Initialize releases
        for (const release of this.releases)
            await release.init({ stdout, dryRun });

        // Initialize hotfixes
        for (const hotfix of this.hotfixes)
            await hotfix.init({ stdout, dryRun });
    }

    public async deleteFeature(feature: Feature) {
        const state = await this.parentConfig.loadState();
        delete state[feature.stateKey];
        await this.parentConfig.saveState(state);

        const idx = this.features.indexOf(feature);
        this.features.splice(idx, 1);
    }
    public async deleteRelease(release: Release) {
        const state = await this.parentConfig.loadState();
        delete state[release.stateKey];
        await this.parentConfig.saveState(state);

        const idx = this.releases.indexOf(release);
        this.releases.splice(idx, 1);
    }
    public async deleteHotfix(hotfix: Hotfix) {
        const state = await this.parentConfig.loadState();
        delete state[hotfix.stateKey];
        await this.parentConfig.saveState(state);

        const idx = this.hotfixes.indexOf(hotfix);
        this.hotfixes.splice(idx, 1);
    }
}

export interface Support extends SupportBase {}
applyMixins(Support, [ SupportBase ]);

export type ExecParams = Omit<ExecOptions, 'cwd'> & { basePath?: string };
export interface MergeParams {
    squash?: boolean;
    message?: string;
    noCommit?: boolean;
    noFastForward?: boolean;
    strategy?: string;
}
export interface CheckoutBranchParams {
    orphan?: boolean;
}
export interface CreateBranchParams {
    source?: string;
}
export interface TagParams {
    source?: string;
    annotation?: string;
}
export interface CommitParams {
    amend?: boolean;
}
export interface PushParams {
    setUpstream?: boolean;
}
