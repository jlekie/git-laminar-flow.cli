import * as _ from 'lodash';
import * as Bluebird from 'bluebird';

import * as Path from 'path';
import * as FS from 'fs-extra';
import * as Yaml from 'js-yaml';
import * as Minimatch from 'minimatch';

import Axios from 'axios';

import * as Chalk from 'chalk';

import { v4 as Uuid } from 'uuid';

import * as Zod from 'zod';

import * as Semver from 'semver';

import { Transform, TransformOptions } from 'stream';
import { StringDecoder } from 'string_decoder';

import {
    ConfigSchema, ConfigSubmoduleSchema, ConfigFeatureSchema, ConfigReleaseSchema, ConfigHotfixSchema, ConfigSupportSchema, ConfigUriSchema, ElementSchema, RecursiveConfigSchema, RecursiveConfigSubmoduleSchema, ConfigIntegrationSchema, ConfigTaggingSchema, ConfigMessageTemplate, ConfigTagTemplate,
    ConfigBase, SubmoduleBase, FeatureBase, ReleaseBase, HotfixBase, SupportBase, IntegrationBase, TaggingBase, MessageTemplateBase, TagTemplateBase,
    parseConfigReference, resolveApiVersion
} from '@jlekie/git-laminar-flow';

import { exec, execCmd, ExecOptions, execRaw } from './exec';
import { Settings } from './settings';
import { loadPlugin } from './plugin';
import { parseStatus } from './porcelain';

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

// export function *resolveOrderedConfigs(configs: Config[], parent?: Config): Generator<Config[]> {
//     const filteredConfigs = configs.filter(c => c.parentConfig === parent);
//     for (const config of filteredConfigs)
//         for (const childFilteredConfigs of resolveOrderedConfigs(configs, config))
//             yield childFilteredConfigs;

//     if (filteredConfigs.length > 0)
//         yield filteredConfigs;
// }
// export type ResolveFilteredOrderedConfigsMapper<T> = T extends (...args: any[]) => infer R ? R : undefined;
// export function resolveFilteredOrderedConfigs(configs: Config[], { parent, filter }: Partial<{ parent: Config, filter: (config: Config) => boolean | Promise<boolean> }>): AsyncGenerator<Config[]>;
// export function resolveFilteredOrderedConfigs<T>(configs: Config[], { parent, filter }: Partial<{ parent: Config, filter: (config: Config) => boolean | Promise<boolean> }> & { mapper: (config: Config) => T }): AsyncGenerator<T[]>;
// export async function *resolveFilteredOrderedConfigs<T, RT extends NonNullable<T>>(configs: Config[], { parent, filter, mapper }: Partial<{ parent: Config, filter: (config: Config) => boolean | Promise<boolean>, mapper: (config: Config) => T | undefined }> = {}): AsyncGenerator<Config[] | RT[]> {
//     const applicableConfigs = configs.filter(c => c.parentConfig === parent);
//     // console.log(applicableConfigs, parent)

//     for (const config of applicableConfigs)
//         for await (const childFilteredConfigs of resolveFilteredOrderedConfigs(configs, { parent: config, filter }))
//             mapper ? yield _.compact(childFilteredConfigs.map(c => mapper(c))) : yield childFilteredConfigs;

//     const filteredConfigs = filter ? await Bluebird.filter(applicableConfigs, filter) : [];
//     if (filteredConfigs.length > 0)
//         mapper ? yield _.compact(filteredConfigs.map(c => mapper(c))) : yield filteredConfigs;
// }

export interface IterateTopologicallyNonMappedParams<T> {
    parent?: T;

    filter?: (item: T) => boolean | Promise<boolean>;
}
export async function *iterateTopologicallyNonMapped<T>(items: T[], resolveChildren: (item: T, parent?: T) => boolean | Promise<boolean>, { parent, filter }: IterateTopologicallyNonMappedParams<T> = {}): AsyncGenerator<T[]> {
    const children = await Bluebird.filter(items, item => resolveChildren(item, parent));

    for (const child of children)
        for await (const grandChildren of iterateTopologicallyNonMapped<T>(items, resolveChildren, { parent: child, filter }))
            yield grandChildren;

    const filteredChildren = filter ? await Bluebird.filter(children, c => filter(c)) : children;
    if (filteredChildren.length > 0) {
        yield filteredChildren;
    }
}

export interface IterateTopologicallyMappedParams<T, RT> {
    parent?: T;

    filter?: (item: T) => boolean | Promise<boolean>;

    mapper: (item: T) => RT | Promise<RT>
}
export async function *iterateTopologicallyMapped<T, RT>(items: T[], resolveChildren: (item: T, parent?: T) => boolean | Promise<boolean>, { parent, filter, mapper }: IterateTopologicallyMappedParams<T, RT>): AsyncGenerator<NonNullable<RT>[]> {
    const children = await Bluebird.filter(items, item => resolveChildren(item, parent));

    for (const child of children)
        for await (const grandChildren of iterateTopologicallyMapped<T, RT>(items, resolveChildren, { parent: child, filter, mapper }))
            yield grandChildren;

    const filteredChildren = filter ? await Bluebird.filter(children, c => filter(c)) : children;
    if (filteredChildren.length > 0) {
        yield _.compact(await Bluebird.map(filteredChildren, c => mapper(c))) as NonNullable<RT>[];
    }
}

export function iterateTopologically<T>(items: T[], resolveChildren: (item: T, parent?: T) => boolean | Promise<boolean>, params: IterateTopologicallyNonMappedParams<T>): AsyncGenerator<T[]>;
export function iterateTopologically<T, RT>(items: T[], resolveChildren: (item: T, parent?: T) => boolean | Promise<boolean>, params: IterateTopologicallyMappedParams<T, RT>): AsyncGenerator<NonNullable<RT>[]>;
export async function *iterateTopologically<T, RT>(items: T[], resolveChildren: (item: T, parent?: T) => boolean | Promise<boolean>, params: IterateTopologicallyNonMappedParams<T> | IterateTopologicallyMappedParams<T, RT>): AsyncGenerator<T[] | NonNullable<RT>[]> {
    if ('mapper' in params) {
        for await (const children of iterateTopologicallyMapped(items, resolveChildren, params))
            yield children;
    }
    else {
        for await (const children of iterateTopologicallyNonMapped(items, resolveChildren, params))
            yield children;
    }
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
            .then(content => content ? JSON.parse(content) : {})
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
            const glfsRepo = (() => {
                const matchedRepo = configRef.hostname
                    ? settings.glfsRepositories.find(r => r.name === configRef.hostname)
                    : settings.getDefaultRepo();

                if (!matchedRepo)
                    throw new Error(`No registry defined for ${configRef.hostname}`);

                return matchedRepo;
            })();

            return await Axios.get(`${glfsRepo.url}/v1/${glfsRepo.name}/${configRef.namespace}/${configRef.name}${configRef.support ? `/${configRef.support}` : ''}`, {
                auth: glfsRepo.apiKey ? {
                    username: 'glf.cli',
                    password: glfsRepo.apiKey
                } : undefined,
                headers: {
                    'Glf-Api-Version': resolveApiVersion()
                }
            })
                .then(response => Config.parse(response.data))
                .catch(err => {
                    if (Axios.isAxiosError(err) && err.response?.status === 404)
                        return Config.createNew();

                    if (Axios.isAxiosError(err))
                        throw new Error(`Failed to fetch http(s) config [${err.response?.data.message ?? err}]`);
                    else
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

    config.submodules.push(...await config.loadShadowSubmodules({
        verify
    }));
    config.features.push(...await config.loadShadowFeatures());
    config.releases.push(...await config.loadShadowReleases());
    config.hotfixes.push(...await config.loadShadowHotfixes());

    for (const support of config.supports) {
        support.features.push(...await support.loadShadowFeatures());
        support.releases.push(...await support.loadShadowReleases());
        support.hotfixes.push(...await support.loadShadowHotfixes());
    }

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
        const glfsRepo = (() => {
            const matchedRepo = configRef.hostname
                ? settings.glfsRepositories.find(r => r.name === configRef.hostname)
                : settings.getDefaultRepo();

            if (!matchedRepo)
                throw new Error(`No registry defined for ${configRef.hostname}`);

            return matchedRepo;
        })();

        await Axios.delete(`${glfsRepo.url}/v1/${glfsRepo.name}/${configRef.namespace}/${configRef.name}`, {
            auth: glfsRepo.apiKey ? {
                username: 'glf.cli',
                password: glfsRepo.apiKey
            } : undefined
        });
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
} | {
    type: 'support.develop';
    branch: string;
    support: Support;
} | {
    type: 'support.master';
    branch: string;
    support: Support;
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

export interface ConfigContextHash {
    identifier: string;
    labels: Record<string, string[]>;
    annotations: Record<string, unknown>;
    submodules: SubmoduleContextHash[];
}
export interface SubmoduleContextHash {
    name: string;
    config: ConfigContextHash;
}

export type ConfigParams = Pick<Config, 'identifier' | 'upstreams' | 'submodules' | 'features' | 'releases' | 'hotfixes' | 'supports' | 'included' | 'excluded'> & Partial<Pick<Config, 'apiVersion' | 'featureMessageTemplate' | 'releaseMessageTemplate' | 'hotfixMessageTemplate' | 'releaseTagTemplate' | 'hotfixTagTemplate' | 'isNew' | 'managed' | 'developVersion' | 'masterVersion' | 'tags' | 'integrations' | 'commitMessageTemplates' | 'tagTemplates' | 'masterBranchName' | 'developBranchName' | 'dependencies' | 'labels' | 'annotations'>>;
export class Config {
    public apiVersion?: string;
    public identifier: string;
    public managed: boolean;
    public developVersion?: string;
    public masterVersion?: string;
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
    public integrations: Integration[];
    public commitMessageTemplates: MessageTemplate[];
    public tagTemplates: TagTemplate[];
    public masterBranchName?: string;
    public developBranchName?: string;
    public dependencies: (string | Record<string, string>)[];
    public labels: Record<string, string | string[]>;
    public annotations: Record<string, unknown>;

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
            tags: value.tags?.slice() ?? [],
            integrations: value.integrations?.map(i => Integration.fromSchema(i)),
            commitMessageTemplates: value.commitMessageTemplates?.map(i => MessageTemplate.fromSchema(i)),
            tagTemplates: value.tagTemplates?.map(i => TagTemplate.fromSchema(i)),

            developVersion: value.developVersion ?? value.version,
            masterVersion: value.masterVersion ?? value.version
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
        this.apiVersion = params.apiVersion;
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
        this.developVersion = params.developVersion;
        this.masterVersion = params.masterVersion;

        this.tags = params.tags ?? [];

        this.integrations = params.integrations ?? [];

        this.commitMessageTemplates = params.commitMessageTemplates ?? [];
        this.tagTemplates = params.tagTemplates ?? [];

        this.masterBranchName = params.masterBranchName;
        this.developBranchName = params.developBranchName;

        this.dependencies = params.dependencies ?? [];

        this.labels = params.labels ?? {};
        this.annotations = params.annotations ?? {};
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
        await Bluebird.map(this.integrations, i => i.register(this));
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
            else if (type === 'submodule' && this.parentSubmodule) {
                return Minimatch(this.parentSubmodule.name, pattern);
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
                else if (type === 'support') {
                    return (artifact.type === 'support.develop' || artifact.type === 'support.master') && Minimatch(artifact.support.name, pattern);
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
        if (((!included || !included.length) || _.some(await Bluebird.map(included, uri => matchAll(uri.split(';'))))) && ((!excluded || !excluded.length) || !_.some(await Bluebird.map(excluded, uri => matchAll(uri.split(';'))))))
            configs.push(this);

        for (const submodule of this.submodules)
            await submodule.config.populateFilteredConfigs(configs, rootConfig, params);
    }

    public async resolveCurrentArtifact(): Promise<Artifact> {
        const currentBranch = await this.resolveCurrentBranch();

        return this.resolveArtifactFromBranch(currentBranch);
    }
    public async resolveArtifactFromBranch(branchName: string): Promise<Artifact> {
        if (branchName === this.resolveMasterBranchName()) {
            return { type: 'master', branch: branchName };
        }
        else if (branchName === this.resolveDevelopBranchName()) {
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

            const masterSupport = this.supports.find(f => f.masterBranchName === branchName)
            if (masterSupport)
                return { type: 'support.master', branch: branchName, support: masterSupport };

            const developSupport = this.supports.find(f => f.developBranchName === branchName)
            if (developSupport)
                return { type: 'support.develop', branch: branchName, support: developSupport };

            for (const support of this.supports) {
                const feature = support.features.find(f => f.branchName === branchName)
                if (feature)
                    return { type: 'feature', branch: branchName, uri: feature.uri, feature };
    
                const release = support.releases.find(f => f.branchName === branchName)
                if (release)
                    return { type: 'release', branch: branchName, uri: release.uri, release };
    
                const hotfix = support.hotfixes.find(f => f.branchName === branchName)
                if (hotfix)
                    return { type: 'hotfix', branch: branchName, uri: hotfix.uri, hotfix };
            }

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
            const branchName = (() => {
                if (value === 'master')
                    return this.resolveMasterBranchName();
                else if (value === 'develop')
                    return this.resolveDevelopBranchName();
                else
                    return value;
            })();

            if (!await this.branchExists(branchName))
                throw new Error(`Branch ${value} does not exist`);

            return { type: 'branch', branch: branchName };
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
            const parts = value.split('/');

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
            const parts = value.split('/');

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
            const parts = value.split('/');

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
    public async init({ stdout, dryRun, writeGitmdoulesConfig, submoduleParallelism }: ExecParams & { writeGitmdoulesConfig?: boolean, submoduleParallelism?: number } = {}) {
        if (!this.managed) {
            stdout?.write(Chalk.yellow("Repo not managed, bypassing\n"));

            // Initialize submodules
            await Bluebird.map(this.submodules, submodule => submodule.init({ stdout, dryRun }), submoduleParallelism ? { concurrency: submoduleParallelism } : undefined);
            // for (const submodule of this.submodules)
            //     await submodule.init({ stdout, dryRun });
        }
        else {
            // Either perform fetch for existing repo or clone/initialize new repo
            if (await FS.pathExists(this.path)) {
                if (await FS.pathExists(Path.resolve(this.path, '.git'))) {
                    await exec(`git fetch --all --prune`, { cwd: this.path, stdout, dryRun });

                    if (!await this.execCmd('git rev-parse HEAD', { stdout, dryRun }).then(() => true).catch(() => false))
                        await exec(`git commit --allow-empty -m "initial commit (GLFCID: ${this.identifier})"`, { cwd: this.path, stdout, dryRun });
                }
                else {
                    const originUpstream = this.upstreams.find(r => r.name == 'origin');
                    if (originUpstream) {
                        await exec(`git init`, { cwd: this.path, stdout, dryRun });
                        await exec(`git remote add ${originUpstream.name} ${originUpstream.url}`, { cwd: this.path, stdout, dryRun });
                        await exec(`git fetch`, { cwd: this.path, stdout, dryRun });

                        if (!await this.remoteBranchExists(this.resolveMasterBranchName(), originUpstream.name, { stdout, dryRun })) {
                            await exec(`git commit --allow-empty -m "initial commit (GLFCID: ${this.identifier})"`, { cwd: this.path, stdout, dryRun });
                        }
                    }
                    else {
                        await exec(`git init`, { cwd: this.path, stdout, dryRun });
                        await exec(`git commit --allow-empty -m "initial commit (GLFCID: ${this.identifier})"`, { cwd: this.path, stdout, dryRun });
                    }
                }
            }
            else {
                const originUpstream = this.upstreams.find(r => r.name == 'origin');
                if (originUpstream) {
                    await exec(`git clone ${originUpstream.url} "${this.path}"`, { stdout, dryRun });

                    if (await this.exec('git rev-parse HEAD', { stdout, dryRun }).then(() => false).catch(() => true))
                        await exec(`git commit --allow-empty -m "initial commit (GLFCID: ${this.identifier})"`, { cwd: this.path, stdout, dryRun });
                }
                else {
                    await FS.ensureDir(this.path);
                    await exec(`git init`, { cwd: this.path, stdout, dryRun });
                    await exec(`git commit --allow-empty -m "initial commit (GLFCID: ${this.identifier})"`, { cwd: this.path, stdout, dryRun });
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
            if (!await this.branchExists(this.resolveMasterBranchName(), { stdout, dryRun })) {
                if (await this.remoteBranchExists(this.resolveMasterBranchName(), 'origin', { stdout, dryRun })) {
                    const currentBranch = await this.resolveCurrentBranch({ stdout, dryRun }).catch(() => undefined);
                    await exec(`git checkout -b ${this.resolveMasterBranchName()} --track origin/${this.resolveMasterBranchName()}`, { cwd: this.path, stdout, dryRun });
                    currentBranch && await this.checkoutBranch(currentBranch, { stdout, dryRun });
                }
                else {
                    // const initialSha = await this.execCmd('git rev-list --max-parents=0 HEAD', { stdout, dryRun });
                    const initialSha = await this.execCmd('git rev-parse HEAD', { stdout, dryRun });
                    await this.createBranch(this.resolveMasterBranchName(), { source: initialSha, stdout, dryRun });
                }
            }
            // else if (await this.remoteBranchExists('master', 'origin', { stdout, dryRun }) && !(await this.resolveBranchUpstream('master', { stdout, dryRun }))) {
            //     const currentBranch = await this.resolveCurrentBranch({ stdout, dryRun });

            //     await this.checkoutBranch('master', { stdout, dryRun });
            //     await this.exec('git branch -u origin/master', { stdout, dryRun });
            //     await this.checkoutBranch(currentBranch, { stdout, dryRun });
            // }

            // Create develop branch if missing
            if (!await this.branchExists(this.resolveDevelopBranchName(), { stdout, dryRun })) {
                if (await this.remoteBranchExists(this.resolveDevelopBranchName(), 'origin', { stdout, dryRun })) {
                    const currentBranch = await this.resolveCurrentBranch({ stdout, dryRun }).catch(() => undefined);
                    await exec(`git checkout -b ${this.resolveDevelopBranchName()} --track origin/${this.resolveDevelopBranchName()}`, { cwd: this.path, stdout, dryRun });
                    currentBranch && await this.checkoutBranch(currentBranch, { stdout, dryRun });
                }
                else {
                    // const initialSha = await this.execCmd('git rev-list --max-parents=0 HEAD', { stdout, dryRun });
                    const initialSha = await this.execCmd('git rev-parse HEAD', { stdout, dryRun });
                    await this.createBranch(this.resolveDevelopBranchName(), { source: initialSha, stdout, dryRun });
                }

                await this.checkoutBranch(this.resolveDevelopBranchName(), { stdout, dryRun });
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
            await Bluebird.map(this.submodules, submodule => submodule.init({ stdout, dryRun }), submoduleParallelism ? { concurrency: submoduleParallelism } : undefined);
            // const addedSubmodules = await Bluebird.map(this.submodules, submodule => submodule.init({ stdout, dryRun }).then(r => ({ submodule, ...r })), { concurrency: 1 }).filter(s => s.submoduleAdded);
            // if (addedSubmodules.length > 0 && await this.hasStagedChanges({ stdout, dryRun })) {
            //     // await this.stage(['.gitmodules', ...addedSubmodules.map(s => s.submodule.path) ], { stdout, dryRun, force: true });
            //     await this.commit('submodule synchronization', { stdout, dryRun });
            // }

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

            if (await this.isDirty({ stdout, dryRun })) {
                stdout?.write(Chalk.yellow(`Uncommitted changes for ${this.pathspec}, will not pull latest\n`));
            }
            else {
                await this.pull({ stdout, dryRun });
            }

            // // Save updated config to disk
            // await this.save({ stdout, dryRun });
        }

        for (const integration of this.resolveIntegrations()) {
            const plugin = await integration.loadPlugin();
            await plugin.init?.({
                config: this,
                stdout,
                dryRun
            });
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

        const sourceConfigPath = Path.join(this.path, '.glf', 'source_config.yml');
        await FS.outputFile(sourceConfigPath, Yaml.dump(this.toHash()), {
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
            const relativePath = './' + Path.relative(repo.parentConfig.path, repo.config.path).replace('\\', '/');

            const originUpstream = repo.config.upstreams.find(u => u.name === 'origin');

            gitmodulesStream.write(`[submodule "${repo.name}"]\n`);
            gitmodulesStream.write(`    path = ${resolvedPath}\n`);
            gitmodulesStream.write(`    url = "${originUpstream?.url ?? relativePath}"\n`);
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

        // if (!dryRun) {
        //     const content = Yaml.dump(this);

        //     const sourceUriPath = Path.join(this.path, '.glf', 'source_config.yml');
        //     await FS.outputFile(sourceUriPath, content, {
        //         encoding: 'utf8'
        //     });
        //     stdout?.write(Chalk.gray(`Config backup written to ${sourceUriPath}\n`));
        // }

        const configRef = parseConfigReference(this.sourceUri);
        if (configRef.type === 'file') {
            if (!dryRun) {
                const content = Yaml.dump(this.toHash());
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
                    await FS.writeFile(configPath, Yaml.dump(this.toHash()), 'utf8');
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
            const glfsRepo = (() => {
                const matchedRepo = configRef.hostname
                    ? this.settings.glfsRepositories.find(r => r.name === configRef.hostname)
                    : this.settings.getDefaultRepo();

                if (!matchedRepo)
                    throw new Error(`No registry defined for ${configRef.hostname}`);

                return matchedRepo;
            })();

            if (!dryRun) {
                await Axios.put(`${glfsRepo.url}/v1/${glfsRepo.name}/${configRef.namespace}/${configRef.name}${configRef.support ? `/${configRef.support}` : ''}`, this.toHash(), {
                    headers: {
                        'glf-api-version': resolveApiVersion(),
                        'if-match': this.baseHash
                    },
                    auth: glfsRepo.apiKey ? {
                        username: 'glf.cli',
                        password: glfsRepo.apiKey
                    } : undefined
                })
                .catch(err => {
                    if (Axios.isAxiosError(err))
                        throw new Error(`Failed to fetch http(s) config [${err.response?.data.message ?? err}]`);
                    else
                        throw new Error(`Failed to fetch http(s) config [${err}]`);
                });
            }
        }
        else {
            throw new Error(`Unsupported config type ${configRef.type}`);
        }

        if (!dryRun) {
            await FS.emptyDir(Path.join(this.path, '.glf', 'shadow-features'));
            await FS.emptyDir(Path.join(this.path, '.glf', 'shadow-releases'));
            await FS.emptyDir(Path.join(this.path, '.glf', 'shadow-hotfixes'));

            for (const feature of this.features.filter(f => f.shadow)) {
                const featurePath = Path.join(this.path, '.glf', 'shadow-features', `${feature.name}.json`);
                await FS.outputJson(featurePath, feature.toHash(), 'utf8');
            }

            for (const release of this.releases.filter(f => f.shadow)) {
                const releasePath = Path.join(this.path, '.glf', 'shadow-releases', `${release.name}.json`);
                await FS.outputJson(releasePath, release.toHash(), 'utf8');
            }

            for (const hotfix of this.hotfixes.filter(f => f.shadow)) {
                const hotfixPath = Path.join(this.path, '.glf', 'shadow-hotfixes', `${hotfix.name}.json`);
                await FS.outputJson(hotfixPath, hotfix.toHash(), 'utf8');
            }

            for (const support of this.supports) {
                for (const feature of support.features.filter(f => f.shadow)) {
                    const featurePath = Path.join(this.path, '.glf', 'shadow-features', support.name, `${feature.name}.json`);
                    await FS.outputJson(featurePath, feature.toHash(), 'utf8');
                }
    
                for (const release of support.releases.filter(f => f.shadow)) {
                    const releasePath = Path.join(this.path, '.glf', 'shadow-releases', support.name, `${release.name}.json`);
                    await FS.outputJson(releasePath, release.toHash(), 'utf8');
                }
    
                for (const hotfix of support.hotfixes.filter(f => f.shadow)) {
                    const hotfixPath = Path.join(this.path, '.glf', 'shadow-hotfixes', support.name, `${hotfix.name}.json`);
                    await FS.outputJson(hotfixPath, hotfix.toHash(), 'utf8');
                }
            }
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
    public async execRaw(cmd: string, { stdout, dryRun, echo }: ExecParams = {}) {
        return await execRaw(cmd, { cwd: this.path, stdout, dryRun, echo });
    }

    public async fetch({ stdout, dryRun }: ExecParams = {}) {
        await exec(`git fetch --all`, { cwd: this.path, stdout, dryRun });
    }
    public async pull({ stdout, dryRun }: ExecParams = {}) {
        await exec(`git pull`, { cwd: this.path, stdout, dryRun });
    }
    public async stage(files: string[], { stdout, dryRun, force }: ExecParams & StageParams = {}) {
        if (!files.length)
            return;

        await exec(`git add${force ? ' -f' : ''} ${files.join(' ')}`, { cwd: this.path, stdout, dryRun });
    }
    public async commit(message: string, { amend, allowEmpty, stdout, dryRun }: ExecParams & CommitParams = {}) {
        await exec(`git commit -m "${message}"${amend ? ' --amend' : ''}${allowEmpty ? ' --allow-empty' : ''}`, { cwd: this.path, stdout, dryRun });
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
    public async checkoutBranchTree(branchName: string | ((config: Config) => string), { orphan, stdout, dryRun }: ExecParams & CheckoutBranchParams = {}) {
        const resolvedBranchName = _.isFunction(branchName) ? branchName(this) : branchName;

        for (const submodule of this.submodules)
            await submodule.config.checkoutBranchTree(branchName, { orphan, stdout, dryRun });

        await exec(`git checkout ${orphan ? '--orphan ' : ''}${resolvedBranchName}`, { cwd: this.path, stdout, dryRun });
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
        await exec(`git update-index --refresh`, { cwd: this.path, stdout, dryRun, retries: 0 }).catch(() => {});

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
        const rawStatus = await this.execCmd('git status -uall --porcelain=v2', { stdout, dryRun, trim: false });

        return _.compact(rawStatus.split('\n').map(line => {
            if (!line)
                return;

            return parseStatus(line);
        }));
    }

    // public async resolveStatuses({ stdout, dryRun }: ExecParams = {}) {
    //     const rawStatus = await this.execCmd('git status -uall --porcelain=v1', { stdout, dryRun, trim: false });

    //     return _.compact(rawStatus.split('\n').map(line => {
    //         if (!line)
    //             return;

    //         const typeCode = line.substring(0, 2);
    //         const path = line.substring(3);

    //         if (typeCode === '??')
    //             return { type: 'untracked', path } as const;
    //         else if (typeCode === ' M')
    //             return { type: 'modified', staged: false, path } as const;
    //         else if (typeCode === 'M ')
    //             return { type: 'modified', staged: true, path } as const;
    //         else if (typeCode === ' A')
    //             return { type: 'added', staged: false, path } as const;
    //         else if (typeCode === 'A ')
    //             return { type: 'added', staged: true, path } as const;
    //         else if (typeCode === ' D')
    //             return { type: 'deleted', staged: false, path } as const;
    //         else if (typeCode === 'D ')
    //             return { type: 'deleted', staged: true, path } as const;
    //         else if (typeCode === ' R')
    //             return { type: 'renamed', staged: false, path } as const;
    //         else if (typeCode === 'R ')
    //             return { type: 'renamed', staged: true, path } as const;
    //         else if (typeCode === ' C')
    //             return { type: 'copied', staged: false, path } as const;
    //         else if (typeCode === 'C ')
    //             return { type: 'copied', staged: true, path } as const;
    //         else
    //             return { type: 'unknown', path } as const;
    //     }));
    // }

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

    public migrateSource({ sourceUri, baseHash }: { sourceUri?: string, baseHash?: string } = {}) {
        if (sourceUri)
            this.#sourceUri = sourceUri;

        if (baseHash)
            this.#baseHash = baseHash;
    }

    public toRecursiveHash(stampApiVersion = false): Zod.infer<typeof RecursiveConfigSchema> {
        return {
            ...this.toHash(stampApiVersion),
            submodules: this.submodules.length ? this.submodules.map(s => s.toRecursiveHash(stampApiVersion)) : undefined,
        };
    }

    public toContextHash(): ConfigContextHash {
        return {
            ...this.toHash(),
            labels: this.normalizeLabels(),
            annotations: this.normalizeAnnotations(),
            submodules: this.submodules.map(s => s.toContextHash())
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

    public async swapCheckoutTree<T>(branchName: string | ((config: Config) => string), handler: () => T | Promise<T>, { stdout, dryRun }: ExecParams = {}) {
        const cleanups = await this._swapCheckoutTree(branchName, { stdout, dryRun });

        try {
            const result = await handler();

            return result;
        }
        finally {
            await Bluebird.map(cleanups, cleanup => cleanup());
        }
    }
    private async _swapCheckoutTree(branchName: string | ((config: Config) => string), { stdout, dryRun }: ExecParams = {}) {
        const cleanups: Array<() => void | Promise<void>> = [];

        for (const submodule of this.submodules)
            cleanups.push(...await submodule.config._swapCheckoutTree(branchName, { stdout, dryRun }));

        const resolvedBranchName = _.isFunction(branchName) ? branchName(this) : branchName;

        const currentBranch = await this.resolveCurrentBranch({ stdout, dryRun });
        const currentBranchActive = currentBranch === resolvedBranchName;

        if (!currentBranchActive)
            await this.checkoutBranch(resolvedBranchName, { stdout, dryRun });

        cleanups.push(async () => {
            if (!currentBranchActive)
                await this.checkoutBranch(currentBranch, { stdout, dryRun });
        });

        return cleanups;
    }

    public async resolveCurrentArtifactVersion(fallback: boolean = false) {
        const currentArtifact = await this.resolveCurrentArtifact();
        switch (currentArtifact.type) {
            case 'develop':
                return this.resolveVersion('develop') ?? (fallback ? this.resolveVersion('master') : undefined);
            case 'master':
                return this.resolveVersion('master');
            case 'feature':
                return currentArtifact.feature.resolveVersion() ?? (fallback ? (currentArtifact.feature.parentSupport ? currentArtifact.feature.parentSupport : this).resolveVersion('develop') : undefined);
            case 'release':
                return currentArtifact.release.resolveVersion() ?? (fallback ? (currentArtifact.release.parentSupport ? currentArtifact.release.parentSupport : this).resolveVersion('develop') : undefined);
            case 'hotfix':
                return currentArtifact.hotfix.resolveVersion() ?? (fallback ? (currentArtifact.hotfix.parentSupport ? currentArtifact.hotfix.parentSupport : this).resolveVersion('develop') : undefined);
            case 'support.develop':
                return currentArtifact.support.resolveVersion('develop');
            case 'support.master':
                return currentArtifact.support.resolveVersion('master');
            default:
                throw new Error(`Unsupported artifact type ${currentArtifact.type} [${currentArtifact.branch}]`);
        }
    }
    public async setCurrentArtifactVersion(version: string | null, { ...execParams }: ExecParams = {}) {
        const currentArtifact = await this.resolveCurrentArtifact();
        switch (currentArtifact.type) {
            case 'develop':
                return this.setVersion('develop', version, execParams);
            case 'master':
                return this.setVersion('master', version, execParams);
            case 'feature':
                return currentArtifact.feature.setVersion(version, execParams);
            case 'release':
                return currentArtifact.release.setVersion(version, execParams);
            case 'hotfix':
                return currentArtifact.hotfix.setVersion(version, execParams);
            case 'support.develop':
                return currentArtifact.support.setVersion('develop', version, execParams);
            case 'support.master':
                return currentArtifact.support.setVersion('master', version, execParams);
            default:
                throw new Error(`Unsupported artifact type ${currentArtifact.type} [${currentArtifact.branch}]`);
        }
    }

    public async setVersion(type: 'develop' | 'master', version: string | null, { stdout, dryRun }: ExecParams = {}) {
        const versionTarget = type === 'develop' ? 'developVersion' : 'masterVersion';
        const currentVersion = this[versionTarget];

        const oldVersion = currentVersion ? Semver.clean(currentVersion) : null;

        if (version) {
            this[versionTarget] = `v${version}`;

            for (const integration of this.resolveIntegrations()) {
                const plugin = await integration.loadPlugin();
                await plugin.updateVersion?.(oldVersion, version, {
                    config: this,
                    stdout,
                    dryRun
                });
            }
        }
        else {
            delete this[versionTarget];
        }

        if (this.parentConfig) {
            let rootConfig = this.parentConfig;
            while (rootConfig?.parentConfig)
                rootConfig = rootConfig.parentConfig;

            return rootConfig.flattenConfigs().filter(c => c.isDependent(this));
        }

        return [];
    }

    public flattenCommitMessageTemplates() {
        const messageTemplates = [ ...this.commitMessageTemplates ];

        if (this.parentConfig)
            messageTemplates.push(...this.parentConfig.flattenCommitMessageTemplates().filter(t => !messageTemplates.some(tt => t.name === tt.name)));

        return messageTemplates;
    }
    public flattenTagTemplates() {
        const tagTemplates = [ ...this.tagTemplates ];

        if (this.parentConfig)
            tagTemplates.push(...this.parentConfig.flattenTagTemplates().filter(t => !tagTemplates.some(tt => t.name === tt.name)));

        return tagTemplates;
    }

    public resolveMasterBranchName() {
        return this.masterBranchName ?? 'master';
    }
    public resolveDevelopBranchName() {
        return this.developBranchName ?? 'develop';
    }

    public async loadShadowSubmodules(loadRepoParams: Pick<LoadRepoConfigParams, 'verify'>) {
        const submodulesPath = Path.join(this.path, '.glf', 'shadow-submodules');
        if (!await FS.pathExists(submodulesPath))
            return [];

        return Bluebird.map(FS.readdir(submodulesPath), file => 
            FS.readFile(Path.join(submodulesPath, file), 'utf8')
                .then(content => JSON.parse(content))
                .then(hash => Submodule.parse(hash, true))
                .then(async submodule => {
                    await submodule.register(this, loadRepoParams);
                    return submodule;
                }));
    }
    public async loadShadowFeatures() {
        const featuresPath = Path.join(this.path, '.glf', 'shadow-features');
        if (!await FS.pathExists(featuresPath))
            return [];

        return Bluebird.map((await FS.readdir(featuresPath, { withFileTypes: true })).filter(f => f.isFile()).map(f => f.name), file => 
            FS.readFile(Path.join(featuresPath, file), 'utf8')
                .then(content => JSON.parse(content))
                .then(hash => Feature.parse(hash, true))
                .then(async feature => {
                    await feature.register(this);
                    return feature;
                }));
    }
    public async loadShadowReleases() {
        const releasesPath = Path.join(this.path, '.glf', 'shadow-releases');
        if (!await FS.pathExists(releasesPath))
            return [];

        return Bluebird.map((await FS.readdir(releasesPath, { withFileTypes: true })).filter(f => f.isFile()).map(f => f.name), file => 
            FS.readFile(Path.join(releasesPath, file), 'utf8')
                .then(content => JSON.parse(content))
                .then(hash => Release.parse(hash, true))
                .then(async release => {
                    await release.register(this);
                    return release;
                }));
    }
    public async loadShadowHotfixes() {
        const hotfixesPath = Path.join(this.path, '.glf', 'shadow-hotfixes');
        if (!await FS.pathExists(hotfixesPath))
            return [];

        return Bluebird.map((await FS.readdir(hotfixesPath, { withFileTypes: true })).filter(f => f.isFile()).map(f => f.name), file => 
            FS.readFile(Path.join(hotfixesPath, file), 'utf8')
                .then(content => JSON.parse(content))
                .then(hash => Hotfix.parse(hash, true))
                .then(async hotfix => {
                    await hotfix.register(this);
                    return hotfix;
                }));
    }

    public async trySetActiveSupport(supportName?: string) {
        if (supportName) {
            const support = this.supports.find(s => s.name === supportName);
            if (!support)
                return;
    
            await this.setStateValue('activeSupport', supportName);

            return support;
        }
        else {
            await this.setStateValue('activeSupport');
        }
    }
    public async resolveActiveSupport() {
        const supportName = await this.getStateValue('activeSupport', 'string');
        if (!supportName)
            return;

        const support = this.supports.find(s => s.name === supportName);
        if (!support)
            throw new Error(`Support ${supportName} not defined`);

        return support;
    }

    public normalizeLabels() {
        return {
            ..._.transform(this.labels, (memo, value, key) => memo[key] = _.isArray(value) ? value : [ value ], {} as Record<string, string[]>),
            ...(this.parentSubmodule ? _.transform(this.parentSubmodule.labels, (memo, value, key) => memo[key] = _.isArray(value) ? value : [ value ], {} as Record<string, string[]>) : {})
        }
    }
    public normalizeAnnotations() {
        return {
            ...this.annotations,
            ...(this.parentSubmodule ? this.parentSubmodule.annotations : {})
        }
    }

    public resolveIntegrations() {
        return [
            ...this.integrations,
            ...this.settings.integrations
        ];
    }

    public isDependent(config: Config) {
        const labels = config.normalizeLabels();

        return this.dependencies.some(d => {
            if (_.isString(d))
                return config.identifier === d;
            else
                return _.every(d, (value, key) => labels[key]?.some(v => v === value));
        });
    }
}

export interface Config extends ConfigBase {}
applyMixins(Config, [ ConfigBase ]);

export type SubmoduleParams = Pick<Submodule, 'name' | 'path' | 'url'> & Partial<Pick<Submodule, 'tags' | 'labels' | 'annotations'>>;
export class Submodule {
    public name: string;
    public path: string;
    public url?: string;
    public tags: string[];
    public labels: Record<string, string | string[]>;
    public annotations: Record<string, unknown>;

    public readonly shadow: boolean;

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

    public static parse(value: unknown, shadow?: boolean) {
        return this.fromSchema(ConfigSubmoduleSchema.parse(value), shadow);
    }
    public static fromSchema(value: Zod.infer<typeof ConfigSubmoduleSchema>, shadow?: boolean) {
        return new this({
            ...value,
            tags: value.tags?.slice() ?? []
        }, shadow);
    }

    public constructor(params: SubmoduleParams, shadow?: boolean) {
        this.name = params.name;
        this.path = params.path;
        this.url = params.url;
        this.tags = params.tags ?? [];
        this.labels = params.labels ?? {};
        this.annotations = params.annotations ?? {};

        this.shadow = shadow ?? false;
    }

    public async register(parentConfig: Config, loadRepoParams: Pick<LoadRepoConfigParams, 'verify'>) {
        this.#initialized = true;

        this.#parentConfig = parentConfig;
        this.#config = await this.loadConfig(loadRepoParams);
    }

    public resolvePath() {
        return Path.join(this.parentConfig?.path ?? '.', this.path);
    }
    public resolveTags() {
        return [ ...this.tags, ...this.config.tags ];
    }

    public async init({ stdout, dryRun }: ExecParams = {}) {
        await this.config.init({ stdout, dryRun });

        // const relativePath = Path.relative(this.parentConfig.path, this.config.path);

        // const submoduleAdded = await this.parentConfig.execCmd(`git submodule status ${this.path}`, { stdout, dryRun }).then(r => false).catch(() => true);
        // if (submoduleAdded)
        //     await this.parentConfig.exec(`git submodule add -f --name ${this.name} ${this.config.upstreams.length > 0 ? this.config.upstreams[0].url : this.path} ${this.path}`, { stdout, dryRun });

        // return {
        //     submoduleAdded
        // };
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

    public toRecursiveHash(stampApiVersion = false): Zod.infer<typeof RecursiveConfigSubmoduleSchema> {
        return {
            ...this.toHash(),
            config: this.config.toRecursiveHash(stampApiVersion)
        };
    }

    public toContextHash(): SubmoduleContextHash {
        return {
            ...this.toHash(),
            config: this.config.toContextHash()
        }
    }
}
export interface Submodule extends SubmoduleBase {}
applyMixins(Submodule, [ SubmoduleBase ]);

export type FeatureParams = Pick<Feature, 'name' | 'branchName' | 'sourceSha' | 'upstream'> & Partial<Pick<Feature, 'tags' | 'version'>>;
export class Feature {
    public name: string;
    public branchName: string;
    public sourceSha: string;
    public version?: string;
    public upstream?: string;
    public tags: Tagging[];

    public readonly shadow: boolean;

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

    public static parse(value: unknown, shadow?: boolean) {
        return this.fromSchema(ConfigFeatureSchema.parse(value), shadow);
    }
    public static fromSchema(value: Zod.infer<typeof ConfigFeatureSchema>, shadow?: boolean) {
        return new this({
            ...value,
            tags: value.tags?.map(t => Tagging.fromSchema(t))
        }, shadow);
    }

    public constructor(params: FeatureParams, shadow?: boolean) {
        this.name = params.name;
        this.branchName = params.branchName;
        this.sourceSha = params.sourceSha;
        this.version = params.version;
        this.upstream = params.upstream;
        this.tags = params.tags ?? [];

        this.shadow = shadow ?? false;
    }

    public async register(parentConfig: Config, parentSupport?: Support) {
        this.#initialized = true;

        this.#parentConfig = parentConfig;
        this.#parentSupport = parentSupport;
    }

    public async init({ stdout, dryRun }: ExecParams = {}) {
        // if (!await this.parentConfig.branchExists(this.branchName, { stdout })) {
        //     const currentBranch = await this.parentConfig.resolveCurrentBranch({ stdout, dryRun });

        //     if (this.upstream && await this.parentConfig.remoteBranchExists(this.branchName, this.upstream, { stdout })) {
        //         await exec(`git checkout -b ${this.branchName} ${this.upstream}/${this.branchName}`, { cwd: this.parentConfig.path, stdout, dryRun });
        //     }
        //     else {
        //         await this.parentConfig.createBranch(this.branchName, { source: this.sourceSha, stdout, dryRun });
        //     }

        //     await this.parentConfig.checkoutBranch(currentBranch, { stdout, dryRun });
        // }
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

    public async setVersion(version: string | null, { stdout, dryRun }: ExecParams = {}) {
        const oldVersion = this.version ? Semver.clean(this.version) : null;

        if (version) {
            this.version = `v${version}`;

            for (const integration of this.parentConfig.integrations) {
                const plugin = await integration.loadPlugin();
                await plugin.updateVersion?.(oldVersion, version, {
                    config: this.parentConfig,
                    stdout,
                    dryRun
                });
            }
        }
        else {
            delete this.version;
        }

        if (this.parentConfig.parentConfig) {
            let rootConfig = this.parentConfig.parentConfig;
            while (rootConfig?.parentConfig)
                rootConfig = rootConfig.parentConfig;

            return rootConfig.flattenConfigs().filter(c => c.isDependent(this.parentConfig));
        }

        return [];
    }
}
export interface Feature extends FeatureBase {}
applyMixins(Feature, [ FeatureBase ]);

export type ReleaseParams = Pick<Release, 'name' | 'branchName' | 'sourceSha' | 'upstream'> & Partial<Pick<Release, 'intermediate' | 'tags' | 'version'>>;
export class Release {
    public name: string;
    public branchName: string;
    public sourceSha: string;
    public version?: string;
    public upstream?: string;
    public intermediate: boolean;
    public tags: Tagging[];

    public readonly shadow: boolean;

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

    public static parse(value: unknown, shadow?: boolean) {
        return this.fromSchema(ConfigReleaseSchema.parse(value), shadow);
    }
    public static fromSchema(value: Zod.infer<typeof ConfigReleaseSchema>, shadow?: boolean) {
        return new this({
            ...value,
            tags: value.tags?.map(t => Tagging.fromSchema(t))
        }, shadow);
    }

    public constructor(params: ReleaseParams, shadow?: boolean) {
        this.name = params.name;
        this.branchName = params.branchName;
        this.sourceSha = params.sourceSha;
        this.version = params.version;
        this.upstream = params.upstream;
        this.intermediate = params.intermediate ?? false;
        this.tags = params.tags ??[];

        this.shadow = shadow ?? false;
    }

    public async register(parentConfig: Config, parentSupport?: Support) {
        this.#initialized = true;

        this.#parentConfig = parentConfig;
        this.#parentSupport = parentSupport;
    }

    public async init({ stdout, dryRun }: ExecParams = {}) {
        // if (!await this.parentConfig.branchExists(this.branchName, { stdout })) {
        //     const currentBranch = await this.parentConfig.resolveCurrentBranch({ stdout, dryRun });

        //     if (this.upstream && await this.parentConfig.remoteBranchExists(this.branchName, this.upstream, { stdout })) {
        //         await exec(`git checkout -b ${this.branchName} ${this.upstream}/${this.branchName}`, { cwd: this.parentConfig.path, stdout, dryRun });
        //     }
        //     else {
        //         await this.parentConfig.createBranch(this.branchName, { source: this.sourceSha, stdout, dryRun });
        //     }

        //     await this.parentConfig.checkoutBranch(currentBranch, { stdout, dryRun });
        // }
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

    public async setVersion(version: string | null, { stdout, dryRun }: ExecParams = {}) {
        const oldVersion = this.version ? Semver.clean(this.version) : null;

        if (version) {
            this.version = `v${version}`;

            for (const integration of this.parentConfig.integrations) {
                const plugin = await integration.loadPlugin();
                await plugin.updateVersion?.(oldVersion, version, {
                    config: this.parentConfig,
                    stdout,
                    dryRun
                });
            }
        }
        else {
            delete this.version;
        }

        if (this.parentConfig.parentConfig) {
            let rootConfig = this.parentConfig.parentConfig;
            while (rootConfig?.parentConfig)
                rootConfig = rootConfig.parentConfig;

            return rootConfig.flattenConfigs().filter(c => c.isDependent(this.parentConfig));
        }

        return [];
    }
}
export interface Release extends ReleaseBase {}
applyMixins(Release, [ ReleaseBase ]);

export type HotfixParams = Pick<Hotfix, 'name' | 'branchName' | 'sourceSha' | 'upstream'> & Partial<Pick<Hotfix, 'intermediate' | 'tags' | 'version'>>;
export class Hotfix {
    public name: string;
    public branchName: string;
    public sourceSha: string;
    public version?: string;
    public upstream?: string;
    public intermediate: boolean;
    public tags: Tagging[];

    public readonly shadow: boolean;

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

    public static parse(value: unknown, shadow?: boolean) {
        return this.fromSchema(ConfigHotfixSchema.parse(value), shadow);
    }
    public static fromSchema(value: Zod.infer<typeof ConfigHotfixSchema>, shadow?: boolean) {
        return new this({
            ...value,
            tags: value.tags?.map(t => Tagging.fromSchema(t))
        }, shadow);
    }

    public constructor(params: HotfixParams, shadow?: boolean) {
        this.name = params.name;
        this.branchName = params.branchName;
        this.sourceSha = params.sourceSha;
        this.version = params.version;
        this.upstream = params.upstream;
        this.intermediate = params.intermediate ?? false;
        this.tags = params.tags ??[];

        this.shadow = shadow ?? false;
    }

    public async register(parentConfig: Config, parentSupport?: Support) {
        this.#initialized = true;

        this.#parentConfig = parentConfig;
        this.#parentSupport = parentSupport;
    }

    public async init({ stdout, dryRun }: ExecParams = {}) {
        // if (!await this.parentConfig.branchExists(this.branchName, { stdout })) {
        //     const currentBranch = await this.parentConfig.resolveCurrentBranch({ stdout, dryRun });

        //     if (this.upstream && await this.parentConfig.remoteBranchExists(this.branchName, this.upstream, { stdout })) {
        //         await exec(`git checkout -b ${this.branchName} ${this.upstream}/${this.branchName}`, { cwd: this.parentConfig.path, stdout, dryRun });
        //     }
        //     else {
        //         await this.parentConfig.createBranch(this.branchName, { source: this.sourceSha, stdout, dryRun });
        //     }

        //     await this.parentConfig.checkoutBranch(currentBranch, { stdout, dryRun });
        // }
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

    public async setVersion(version: string | null, { stdout, dryRun }: ExecParams = {}) {
        const oldVersion = this.version ? Semver.clean(this.version) : null;

        if (version) {
            this.version = `v${version}`;

            for (const integration of this.parentConfig.integrations) {
                const plugin = await integration.loadPlugin();
                await plugin.updateVersion?.(oldVersion, version, {
                    config: this.parentConfig,
                    stdout,
                    dryRun
                });
            }
        }
        else {
            delete this.version;
        }

        if (this.parentConfig.parentConfig) {
            let rootConfig = this.parentConfig.parentConfig;
            while (rootConfig?.parentConfig)
                rootConfig = rootConfig.parentConfig;

            return rootConfig.flattenConfigs().filter(c => c.isDependent(this.parentConfig));
        }

        return [];
    }
}
export interface Hotfix extends HotfixBase {}
applyMixins(Hotfix, [ HotfixBase ]);

export type SupportParams = Pick<Support, 'name' | 'masterBranchName' | 'developBranchName' | 'sourceSha' | 'features' | 'releases' | 'hotfixes' | 'upstream'> & Partial<Pick<Support, 'masterVersion' | 'developVersion'>>;
export class Support {
    public name: string;
    public masterBranchName: string;
    public developBranchName: string;
    public sourceSha: string;
    public developVersion?: string;
    public masterVersion?: string;
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
        this.masterVersion = params.masterVersion;
        this.developVersion = params.developVersion;
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
        // if (!await this.parentConfig.branchExists(this.masterBranchName, { stdout })) {
        //     const currentBranch = await this.parentConfig.resolveCurrentBranch({ stdout, dryRun });

        //     if (this.upstream && await this.parentConfig.remoteBranchExists(this.masterBranchName, this.upstream, { stdout })) {
        //         await exec(`git checkout -b ${this.masterBranchName} ${this.upstream}/${this.masterBranchName}`, { cwd: this.parentConfig.path, stdout, dryRun });
        //     }
        //     else {
        //         await this.parentConfig.createBranch(this.masterBranchName, { source: this.sourceSha, stdout, dryRun });
        //     }

        //     await this.parentConfig.checkoutBranch(currentBranch, { stdout, dryRun });
        // }

        // if (!await this.parentConfig.branchExists(this.developBranchName, { stdout })) {
        //     const currentBranch = await this.parentConfig.resolveCurrentBranch({ stdout, dryRun });

        //     if (this.upstream && await this.parentConfig.remoteBranchExists(this.developBranchName, this.upstream, { stdout })) {
        //         await exec(`git checkout -b ${this.developBranchName} ${this.upstream}/${this.developBranchName}`, { cwd: this.parentConfig.path, stdout, dryRun });
        //     }
        //     else {
        //         await this.parentConfig.createBranch(this.developBranchName, { source: this.sourceSha, stdout, dryRun });
        //     }

        //     await this.parentConfig.checkoutBranch(currentBranch, { stdout, dryRun });
        // }

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

    public async setVersion(type: 'develop' | 'master', version: string | null, { stdout, dryRun }: ExecParams = {}) {
        const versionTarget = type === 'develop' ? 'developVersion' : 'masterVersion';
        const currentVersion = this[versionTarget];

        const oldVersion = currentVersion ? Semver.clean(currentVersion) : null;

        if (version) {
            this[versionTarget] = `v${version}`;

            for (const integration of this.parentConfig.integrations) {
                const plugin = await integration.loadPlugin();
                await plugin.updateVersion?.(oldVersion, version, {
                    config: this.parentConfig,
                    stdout,
                    dryRun
                });
            }
        }
        else {
            delete this[versionTarget];
        }

        if (this.parentConfig.parentConfig) {
            let rootConfig = this.parentConfig.parentConfig;
            while (rootConfig?.parentConfig)
                rootConfig = rootConfig.parentConfig;

            return rootConfig.flattenConfigs().filter(c => c.isDependent(this.parentConfig));
        }

        return [];
    }

    public async loadShadowFeatures() {
        const featuresPath = Path.join(this.parentConfig.path, '.glf', 'shadow-features', this.name);
        if (!await FS.pathExists(featuresPath))
            return [];

        return Bluebird.map((await FS.readdir(featuresPath, { withFileTypes: true })).filter(f => f.isFile()).map(f => f.name), file => 
            FS.readFile(Path.join(featuresPath, file), 'utf8')
                .then(content => JSON.parse(content))
                .then(hash => Feature.parse(hash, true))
                .then(async feature => {
                    await feature.register(this.parentConfig, this);
                    return feature;
                }));
    }
    public async loadShadowReleases() {
        const releasesPath = Path.join(this.parentConfig.path, '.glf', 'shadow-releases', this.name);
        if (!await FS.pathExists(releasesPath))
            return [];

        return Bluebird.map((await FS.readdir(releasesPath, { withFileTypes: true })).filter(f => f.isFile()).map(f => f.name), file => 
            FS.readFile(Path.join(releasesPath, file), 'utf8')
                .then(content => JSON.parse(content))
                .then(hash => Release.parse(hash, true))
                .then(async release => {
                    await release.register(this.parentConfig, this);
                    return release;
                }));
    }
    public async loadShadowHotfixes() {
        const hotfixesPath = Path.join(this.parentConfig.path, '.glf', 'shadow-hotfixes', this.name);
        if (!await FS.pathExists(hotfixesPath))
            return [];

        return Bluebird.map((await FS.readdir(hotfixesPath, { withFileTypes: true })).filter(f => f.isFile()).map(f => f.name), file => 
            FS.readFile(Path.join(hotfixesPath, file), 'utf8')
                .then(content => JSON.parse(content))
                .then(hash => Hotfix.parse(hash, true))
                .then(async hotfix => {
                    await hotfix.register(this.parentConfig, this);
                    return hotfix;
                }));
    }

    public resolveMasterBranchName() {
        return this.masterBranchName;
    }
    public resolveDevelopBranchName() {
        return this.developBranchName;
    }
}
export interface Support extends SupportBase {}
applyMixins(Support, [ SupportBase ]);

export type IntegrationParams = Pick<Integration, 'plugin' | 'options'>;
export class Integration {
    public plugin: string;
    public options: Record<string, unknown>;

    #initialized: boolean = false;

    #parentConfig!: Config;
    public get parentConfig() {
        if (!this.#initialized)
            throw new Error('Not initialized');

        return this.#parentConfig;
    }

    // #pluginModule!: Plugin;
    // public get pluginModule() {
    //     if (!this.#initialized)
    //         throw new Error('Not initialized');

    //     return this.#pluginModule;
    // }

    public static parse(value: unknown) {
        return this.fromSchema(ConfigIntegrationSchema.parse(value));
    }
    public static fromSchema(value: Zod.infer<typeof ConfigIntegrationSchema>) {
        return new this({
            ...value,
            options: value.options ? { ...value.options } : {}
        });
    }

    public constructor(params: IntegrationParams) {
        this.plugin = params.plugin;
        this.options = params.options;
    }

    public async register(parentConfig: Config) {
        this.#initialized = true;

        this.#parentConfig = parentConfig;

        // this.#pluginModule = await loadPlugin(this.plugin, this.options);
    }

    public async loadPlugin() {
        return loadPlugin(this.plugin, this.options);
    }
}
export interface Integration extends IntegrationBase {}
applyMixins(Integration, [ IntegrationBase ]);

export type TaggingParams = Pick<Tagging, 'name' | 'annotation'>;
export class Tagging {
    public name: string;
    public annotation?: string;

    public static parse(value: unknown) {
        return this.fromSchema(ConfigTaggingSchema.parse(value));
    }
    public static fromSchema(value: Zod.infer<typeof ConfigTaggingSchema>) {
        return new this({
            ...value
        });
    }

    public constructor(params: TaggingParams) {
        this.name = params.name;
        this.annotation = params.annotation;
    }
}
export interface Tagging extends TaggingBase {}
applyMixins(Tagging, [ TaggingBase ]);

export type MessageTemplateParams = Pick<MessageTemplate, 'name' | 'message'>;
export class MessageTemplate {
    public name: string;

    #message!: string;
    public get message() {
        return this.#message;
    }
    public set message(value) {
        this.#message = value;
        this.#messageTemplate = _.template(value);
    }

    #messageTemplate!: _.TemplateExecutor;
    public get messageTemplate() {
        return this.#messageTemplate;
    }

    public static parse(value: unknown) {
        return this.fromSchema(ConfigMessageTemplate.parse(value));
    }
    public static fromSchema(value: Zod.infer<typeof ConfigMessageTemplate>) {
        return new this({
            ...value
        });
    }

    public constructor(params: MessageTemplateParams) {
        this.name = params.name;
        this.message = params.message;
    }
}
export interface MessageTemplate extends MessageTemplateBase {}
applyMixins(MessageTemplate, [ MessageTemplateBase ]);

export type TagTemplateParams = Pick<TagTemplate, 'name' | 'tag'> & Partial<Pick<TagTemplate, 'annotation'>>;
export class TagTemplate {
    public name: string;

    #tag!: string;
    public get tag() {
        return this.#tag;
    }
    public set tag(value) {
        this.#tag = value;
        this.#tagTemplate = _.template(value);
    }

    #annotation?: string;
    public get annotation() {
        return this.#annotation;
    }
    public set annotation(value) {
        this.#annotation = value;
        this.#annotationTemplate = _.template(value);
    }

    #tagTemplate!: _.TemplateExecutor;
    public get tagTemplate() {
        return this.#tagTemplate;
    }

    #annotationTemplate?: _.TemplateExecutor;
    public get annotationTemplate() {
        return this.#annotationTemplate;
    }

    public static parse(value: unknown) {
        return this.fromSchema(ConfigTagTemplate.parse(value));
    }
    public static fromSchema(value: Zod.infer<typeof ConfigTagTemplate>) {
        return new this({
            ...value
        });
    }

    public constructor(params: TagTemplateParams) {
        this.name = params.name;
        this.tag = params.tag;
        this.annotation = params.annotation;
    }
}
export interface TagTemplate extends TagTemplateBase {}
applyMixins(TagTemplate, [ TagTemplateBase ]);

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
export interface StageParams {
    force?: boolean;
}
export interface CommitParams {
    amend?: boolean;
    allowEmpty?: boolean;
}
export interface PushParams {
    setUpstream?: boolean;
}
