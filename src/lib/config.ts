import * as _ from 'lodash';
import * as Bluebird from 'bluebird';

import * as Path from 'path';
import * as FS from 'fs-extra';
import * as Yaml from 'js-yaml';
import * as Glob from 'glob-promise';
import * as Minimatch from 'minimatch';

import * as Chalk from 'chalk';

import { v4 as Uuid } from 'uuid';

import * as Zod from 'zod';

import { exec, execCmd, ExecOptions } from './exec';

export const ConfigSubmoduleSchema = Zod.object({
    name: Zod.string(),
    path: Zod.string()
});
export const ConfigFeatureSchema = Zod.object({
    name: Zod.string(),
    branchName: Zod.string(),
    sourceSha: Zod.string()
});
export const ConfigReleaseSchema = Zod.object({
    name: Zod.string(),
    branchName: Zod.string(),
    sourceSha: Zod.string().optional()
});
export const ConfigHotfixSchema = Zod.object({
    name: Zod.string(),
    branchName: Zod.string(),
    sourceSha: Zod.string().optional()
});
export const ConfigSupportSchema = Zod.object({
    name: Zod.string(),
    masterBranchName: Zod.string(),
    developBranchName: Zod.string()
});
export const ConfigSchema = Zod.object({
    identifier: Zod.string(),
    upstreams: Zod.object({
        name: Zod.string(),
        url: Zod.string()
    }).array().optional(),
    submodules: ConfigSubmoduleSchema.array().optional(),
    features: ConfigFeatureSchema.array().optional(),
    releases: ConfigReleaseSchema.array().optional(),
    hotfixes: ConfigHotfixSchema.array().optional(),
    supports: ConfigSupportSchema.array().optional()
});

export interface State {
    [key: string]: StateValue;
}
export type StateValue = string | number | boolean | State;
export const StateSchema: Zod.ZodSchema<State> = Zod.record(
    Zod.string(),
    Zod.union([ Zod.string(), Zod.number(), Zod.boolean(), Zod.lazy(() => StateSchema) ])
);

export function getStateValue(state: State, key: string, type: 'string'): string | undefined;
export function getStateValue(state: State, key: string, type: 'number'): number | undefined;
export function getStateValue(state: State, key: string, type: 'boolean'): boolean | undefined;
export function getStateValue(state: State, key: string, type: 'nested'): State | undefined;
export function getStateValue(state: State, key: string, type: 'string' | 'number' | 'boolean' | 'nested') {
    const value = state[key];
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

        return value;
    }
    else {
        throw new Error(`Unsupported state type ${type}`);
    }
}

// Either load the config from disk if it exists or create a new default config
export async function loadConfig(path: string, parentConfig?: Config, pathspecPrefix?: string) {
    const config = await FS.pathExists(path)
        ? await FS.readFile(path, 'utf8')
            .then(content => Yaml.load(content))
            .then(hash => Config.parse(hash))
        : Config.createNew();

    const repoPath = Path.dirname(Path.resolve(path));
    await config.register(repoPath, parentConfig, pathspecPrefix);

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
} | {
    type: 'release';
    branch: string;
    release: Release;
} | {
    type: 'hotfix';
    branch: string;
    hotfix: Hotfix;
}

export type ConfigParams = Pick<Config, 'identifier' | 'upstreams' | 'submodules' | 'features' | 'releases' | 'hotfixes'>;
export class Config {
    public identifier: string;
    public upstreams: Array<{ name: string, url: string }>;
    public submodules: Submodule[];
    public features: Feature[];
    public releases: Release[];
    public hotfixes: Hotfix[];

    #initialized: boolean = false;

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

    #parentConfig?: Config;
    public get parentConfig() {
        if (!this.#initialized)
            throw new Error('Not initialized');

        return this.#parentConfig;
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
            hotfixes: value.hotfixes?.map(i => Hotfix.fromSchema(i)) ?? []
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
            hotfixes: []
        });
    }

    public constructor(params: ConfigParams) {
        this.identifier = params.identifier;
        this.upstreams = params.upstreams;
        this.submodules = params.submodules;
        this.features = params.features;
        this.releases = params.releases;
        this.hotfixes = params.hotfixes;
    }

    // Register internals (initialize)
    public async register(path: string, parentConfig?: Config, pathspec: string = 'root') {
        this.#initialized = true;

        this.#path = path;
        this.#parentConfig = parentConfig;
        this.#pathspec = pathspec;

        // const statePath = Path.join(path, '.gitflowstate');
        // this.#state = await FS.pathExists(statePath)
        //     ? await FS.readFile(statePath, 'utf8')
        //         .then(content => JSON.parse(content))
        //         .then(hash => StateSchema.parse(hash))
        //     : {};

        await Bluebird.map(this.submodules, i => i.register(this));
        await Bluebird.map(this.features, i => i.register(this));
        await Bluebird.map(this.releases, i => i.register(this));
        await Bluebird.map(this.hotfixes, i => i.register(this));
    }

    public flattenConfigs(): Config[] {
        return _.flatten([
            this,
            ...this.submodules.map(s => s.config.flattenConfigs())
        ]);
    }
    public async resolveFilteredConfigs(params: { included?: string[], excluded?: string[] } = {}): Promise<Config[]> {
        const configs: Config[] = [];
        await this.populateFilteredConfigs(configs, params);

        return configs;
    }
    private async populateFilteredConfigs(configs: Config[], params: { included?: string[], excluded?: string[] }) {
        const artifact = await this.resolveCurrentArtifact();

        const match = (uri: string) => {
            const [ type, pattern ] = uri.split('://', 2);

            if (type === 'repo') {
                return Minimatch(this.pathspec, pattern);
            }
            else if (type === 'branch') {
                return artifact.branch && Minimatch(artifact.branch, pattern);
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
            else {
                return false;
            }
        }

        if ((!params.included || params.included.some(uri => match(uri))) && (!params.excluded || !params.excluded.some(uri => match(uri))))
            configs.push(this);

        for (const submodule of this.submodules)
            await submodule.config.populateFilteredConfigs(configs, params);
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
                return { type: 'feature', branch: branchName, feature };

            const release = this.releases.find(f => f.branchName === branchName)
            if (release)
                return { type: 'release', branch: branchName, release };

            const hotfix = this.hotfixes.find(f => f.branchName === branchName)
            if (hotfix)
                return { type: 'hotfix', branch: branchName, hotfix };

            return { type: 'unknown', branch: branchName }
        }
    }

    public getStateValue(key: string, type: 'string'): Promise<string | undefined>;
    public getStateValue(key: string, type: 'number'): Promise<number | undefined>;
    public getStateValue(key: string, type: 'boolean'): Promise<boolean | undefined>;
    public getStateValue(key: string, type: 'nested'): Promise<State | undefined>;
    public async getStateValue(key: string, type: 'string' | 'number' | 'boolean' | 'nested') {
        const state = await this.loadState();

        const value = state[key];
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

            return value;
        }
        else {
            throw new Error(`Unsupported state type ${type}`);
        }
    }

    public async setStateValue(key: string, value?: StateValue) {
        const state = await this.loadState();

        if (value)
            state[key] = value;
        else
            delete state[key];

        await this.saveState(state);
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
    public async init({ stdout, dryRun }: ExecParams = {}) {
        // Either perform fetch for existing repo or clone/initialize new repo
        if (await FS.pathExists(this.path)) {
            await exec(`git fetch --all --prune`, { cwd: this.path, stdout, dryRun })
        }
        else {
            const originUpstream = this.upstreams.find(r => r.name == 'origin');
            if (originUpstream) {
                await exec(`git clone ${originUpstream.url} ${this.path}`, { stdout, dryRun });
            }
            else {
                await FS.ensureDir(this.path);
                await exec(`git init`, { cwd: this.path, stdout, dryRun });
                await exec(`git commit --allow-empty -m "initial commit"`, { cwd: this.path, stdout, dryRun });
            }
        }

        // Create develop branch if missing
        if (!await this.branchExists('develop', { stdout, dryRun })) {
            await this.createBranch('develop', { stdout, dryRun });
        }

        // Add upstreams if missing
        for (const upstream of this.upstreams) {
            if (!await this.upstreamExists(upstream.name, { stdout, dryRun }))
                await exec(`git remote add ${upstream.name} ${upstream.url}`, { cwd: this.path, stdout, dryRun });
        }

        // Update .gitmodules config with submodules
        if (!dryRun && this.submodules.length > 0) {
            const gitmodulesPath = Path.join(this.path, '.gitmodules');

            const gitmodulesStream = FS.createWriteStream(gitmodulesPath);
            for (const repo of this.submodules) {
                const resolvedPath = Path.posix.join(repo.path);
    
                gitmodulesStream.write(`[submodule "${repo.name}"]\n`);
                gitmodulesStream.write(`    path = ${resolvedPath}\n`);
                gitmodulesStream.write(`    url = ""\n`);
            }
            gitmodulesStream.close();

            stdout?.write(Chalk.gray(`Gitmodules config written to ${gitmodulesPath}\n`));
        }

        // // Initialize submodules
        // for (const submodule of this.submodules) {
        //     await submodule.init({ stdout, dryRun });
        // }

        // Initialize features
        for (const feature of this.features)
            await feature.init({ stdout, dryRun });

        // Initialize releases
        for (const release of this.releases)
            await release.init({ stdout, dryRun });

        // Save updated config to disk
        await this.save({ stdout, dryRun });
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

    // Save the config to disk
    public async save({ stdout, dryRun }: ExecParams = {}) {
        const configPath = Path.join(this.path, '.gitflow.yml');
        if (!dryRun) {
            const content = Yaml.dump(this);
            await FS.writeFile(configPath, content, 'utf8');
        }
        stdout?.write(Chalk.gray(`Config written to ${configPath}\n`));
    }

    public async loadState() {
        const statePath = Path.join(this.path, '.gitflowstate');
        return await FS.pathExists(statePath)
            ? await FS.readFile(statePath, 'utf8')
                .then(content => JSON.parse(content))
                .then(hash => StateSchema.parse(hash))
            : {};
    }
    public async saveState(state: State) {
        const statePath = Path.join(this.path, '.gitflowstate');

        const content = JSON.stringify(state);
        await FS.writeFile(statePath, content, 'utf8');
    }

    public async exec(cmd: string, { stdout, dryRun }: ExecParams = {}) {
        await exec(cmd, { cwd: this.path, stdout, dryRun });
    }

    public async fetch({ stdout, dryRun }: ExecParams = {}) {
        await exec(`git fetch --all`, { cwd: this.path, stdout, dryRun });
    }
    public async commit(message: string, { amend, stdout, dryRun }: ExecParams & CommitParams = {}) {
        await exec(`git commit -m "${message}"${amend ? ' --amend' : ''}`, { cwd: this.path, stdout, dryRun });
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

    public async checkoutBranch(branchName: string, { stdout, dryRun }: ExecParams = {}) {
        await exec(`git checkout ${branchName}`, { cwd: this.path, stdout, dryRun });
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
    public async branchExists(branchName: string, { stdout, dryRun }: ExecParams = {}) {
        return !!await execCmd(`git branch --list ${branchName}`, { cwd: this.path, stdout, dryRun });
    }
    public async remoteBranchExists(branchName: string, upstreamName: string, { stdout, dryRun }: ExecParams = {}) {
        return !!await execCmd(`git ls-remote --heads ${upstreamName} ${branchName}`, { cwd: this.path, stdout, dryRun });
    }

    public async isDirty({ stdout, dryRun }: ExecParams = {}) {
        await exec(`git update-index --refresh`, { cwd: this.path, stdout, dryRun }).catch(() => {});

        return await exec(`git diff-index --quiet HEAD`, { cwd: this.path, stdout, dryRun })
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

    public async merge(branchName: string, { squash, message, noCommit, strategy, stdout, dryRun }: ExecParams & MergeParams = {}) {
        if (squash) {
            await exec(`git merge --squash ${branchName}${message ? ` -m "${message}"` : ''}${noCommit ? ' --no-commit' : ''}${strategy ? ` -X ${strategy}` : ''}`, { cwd: this.path, stdout, dryRun });
        }
        else {
            await exec(`git merge ${branchName}${message ? ` -m "${message}"` : ''}${noCommit ? ' --no-commit' : ''}${strategy ? ` -X ${strategy}` : ''}`, { cwd: this.path, stdout, dryRun });
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

    // public toJSON() {
    //     return {
    //         identifier: this.identifier,
    //         submodules: this.submodules.map(i => i.toJSON())
    //     }
    // }
}

export type SubmoduleParams = Pick<Submodule, 'name' | 'path'>;
export class Submodule {
    public name: string;
    public path: string;

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
            ...value
        });
    }

    public constructor(params: SubmoduleParams) {
        this.name = params.name;
        this.path = params.path;
    }

    public async register(parentConfig: Config) {
        this.#initialized = true;

        this.#parentConfig = parentConfig;
        this.#config = await this.loadConfig();
    }

    public resolvePath() {
        return Path.join(this.parentConfig?.path ?? '.', this.path);
    }

    public async init({ stdout, dryRun }: ExecParams = {}) {
        await this.config.init({ stdout, dryRun });
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

    public async loadConfig() {
        const configPath = Path.join(this.resolvePath(), '.gitflow.yml');
        const config = await loadConfig(configPath, this.parentConfig, `${this.parentConfig.pathspec + '/'}${this.name}`);

        return config;
    }
}

export type FeatureParams = Pick<Feature, 'name' | 'branchName' | 'sourceSha'>;
export class Feature {
    public name: string;
    public branchName: string;
    public sourceSha: string;

    #initialized: boolean = false;

    #parentConfig!: Config;
    public get parentConfig() {
        if (!this.#initialized)
            throw new Error('Not initialized');

        return this.#parentConfig;
    }

    public get stateKey() {
        return `feature/${this.name}`;
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
    }

    public async register(parentConfig: Config) {
        this.#initialized = true;

        this.#parentConfig = parentConfig;
    }

    public async init({ stdout, dryRun }: ExecParams = {}) {
        if (!await this.parentConfig.branchExists(this.branchName, { stdout }))
            await this.parentConfig.createBranch(this.branchName, { source: this.sourceSha, stdout, dryRun });
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
}

export type ReleaseParams = Pick<Release, 'name' | 'branchName' | 'sourceSha'>;
export class Release {
    public name: string;
    public branchName: string;
    public sourceSha?: string;

    #initialized: boolean = false;

    #parentConfig!: Config;
    public get parentConfig() {
        if (!this.#initialized)
            throw new Error('Not initialized');

        return this.#parentConfig;
    }

    public get stateKey() {
        return `release/${this.name}`;
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
    }

    public async register(parentConfig: Config) {
        this.#initialized = true;

        this.#parentConfig = parentConfig;
    }

    public async init({ stdout, dryRun }: ExecParams = {}) {
        if (!await this.parentConfig.branchExists(this.branchName, { stdout }))
            await this.parentConfig.createBranch(this.branchName, { source: this.sourceSha, stdout, dryRun });
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
}

export type HotfixParams = Pick<Release, 'name' | 'branchName' | 'sourceSha'>;
export class Hotfix {
    public name: string;
    public branchName: string;
    public sourceSha?: string;

    #initialized: boolean = false;

    #parentConfig!: Config;
    public get parentConfig() {
        if (!this.#initialized)
            throw new Error('Not initialized');

        return this.#parentConfig;
    }

    public get stateKey() {
        return `hotfix/${this.name}`;
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
    }

    public async register(parentConfig: Config) {
        this.#initialized = true;

        this.#parentConfig = parentConfig;
    }

    public async init({ stdout, dryRun }: ExecParams = {}) {
        if (!await this.parentConfig.branchExists(this.branchName, { stdout }))
            await this.parentConfig.createBranch(this.branchName, { source: this.sourceSha, stdout, dryRun });
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
}

export type ExecParams = Omit<ExecOptions, 'cwd'> & { basePath?: string };
export interface MergeParams {
    squash?: boolean;
    message?: string;
    noCommit?: boolean;
    strategy?: string;
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