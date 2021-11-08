import * as _ from 'lodash';
import * as Bluebird from 'bluebird';

import * as Path from 'path';
import * as FS from 'fs-extra';
import * as Yaml from 'js-yaml';
import * as Glob from 'glob-promise';

import * as Zod from 'zod';

import { exec, execCmd, ExecOptions } from './exec';

export const ConfigSubmoduleSchema = Zod.object({
    name: Zod.string(),
    path: Zod.string(),
    remotes: Zod.object({
        name: Zod.string(),
        url: Zod.string()
    }).array()
});
export const ConfigFeatureSchema = Zod.object({
    fqn: Zod.string(),
    branchName: Zod.string()
});
export const ConfigReleaseSchema = Zod.object({
    fqn: Zod.string(),
    branchName: Zod.string()
});
export const ConfigSchema = Zod.object({
    identifier: Zod.string(),
    submodules: ConfigSubmoduleSchema.array().optional(),
    features: ConfigFeatureSchema.array().optional(),
    releases: ConfigReleaseSchema.array().optional()
});

export async function loadConfig(path: string, parentConfig?: Config) {
    const config = await FS.readFile(path, 'utf8')
        .then(content => Yaml.load(content))
        .then(hash => Config.parse(hash));

    await config.register(Path.dirname(Path.resolve(path)), parentConfig);

    return config;
}

export type ConfigParams = Pick<Config, 'identifier' | 'submodules' | 'features' | 'releases'>;
export class Config {
    public identifier: string;
    public submodules: Submodule[];
    public features: Feature[];
    public releases: Release[];

    #initialized: boolean = false;

    #path!: string;
    public get path() {
        if (!this.#initialized)
            throw new Error('Not initialized');

        return this.#path;
    }

    #parentConfig?: Config;
    public get parentConfig() {
        if (!this.#initialized)
            throw new Error('Not initialized');

        return this.#parentConfig;
    }

    public static parse(value: unknown) {
        return this.fromSchema(ConfigSchema.parse(value));
    }
    public static fromSchema(value: Zod.infer<typeof ConfigSchema>) {
        const config = new Config({
            ...value,
            submodules: value.submodules?.map( i => Submodule.fromSchema(i)) ?? [],
            features: value.features?.map(i => Feature.fromSchema(i)) ?? [],
            releases: value.releases?.map(i => Release.fromSchema(i)) ?? []
        });

        return config;
    }

    public constructor(params: ConfigParams) {
        this.identifier = params.identifier;
        this.submodules = params.submodules;
        this.features = params.features;
        this.releases = params.releases;
    }

    public async register(path: string, parentConfig?: Config) {
        this.#initialized = true;

        this.#path = path;
        this.#parentConfig = parentConfig;

        await Bluebird.map(this.submodules, i => i.register(this));
        await Bluebird.map(this.features, i => i.register(this));
        await Bluebird.map(this.releases, i => i.register(this));
    }

    public resolveFeatureFqn(featureName: string) {
        const parts = featureName.split('/');

        let targetContext: Config = this;
        for (let a = 0; a < parts.length - 1; a++) {
            const submodule = targetContext.submodules.find(s => s.name === parts[a]);
            if (!submodule)
                throw new Error(`Submodule ${parts[a]} not found`);

            targetContext = submodule.config;
        }

        return `${targetContext.identifier}/${parts[parts.length - 1]}`;
    }

    public async checkoutFeature(featureFqn: string, { stdout, dryRun }: ExecParams = {}) {
        await Bluebird.map(this.features.filter(f => f.fqn === featureFqn), async feature => {
            if (!await feature.branchExists({ stdout, dryRun }))
                await feature.createBranch({ stdout, dryRun });
        }, { concurrency: 1 });

        await Bluebird.map(this.submodules, async submodule => {
            const submoduleConfig = await submodule.loadConfig();
            await submoduleConfig.checkoutFeature(featureFqn, { stdout, dryRun });
        }, { concurrency: 1 });
    }

    // public toJSON() {
    //     return {
    //         identifier: this.identifier,
    //         submodules: this.submodules.map(i => i.toJSON())
    //     }
    // }
}

export type SubmoduleParams = Pick<Submodule, 'name' | 'path' | 'remotes'>;
export class Submodule {
    public name: string;
    public path: string;
    public remotes: Array<{ name: string, url: string }>;

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
            remotes: value.remotes.map(i => ({ ...i }))
        });
    }

    public constructor(params: SubmoduleParams) {
        this.name = params.name;
        this.path = params.path;
        this.remotes = params.remotes;
    }

    public async register(parentConfig: Config) {
        this.#initialized = true;

        this.#parentConfig = parentConfig;
        this.#config = await this.loadConfig();
    }

    public resolvePath() {
        return Path.join(this.parentConfig?.path ?? '.', this.path);
    }

    public async fetch({ stdout, dryRun }: ExecParams = {}) {
        await exec(`git fetch --all --prune`, { cwd: this.resolvePath(), stdout, dryRun })
    }
    public async clone({ stdout, dryRun }: ExecParams = {}) {
        const originRemote = this.remotes.find(r => r.name == 'origin');
        if (!originRemote)
            throw new Error(`No origin remote specified for repo ${this.name}`);

        const repoPath = Path.resolve(this.parentConfig?.path ?? '.', this.path);
        await exec(`git clone ${originRemote.url} ${repoPath}`, { stdout, dryRun })
    }

    public async loadConfig() {
        const configPath = Path.join(this.resolvePath(), '.gitflow.yml');
        const config = await loadConfig(configPath, this.parentConfig);

        return config;
    }
}

export type FeatureParams = Pick<Feature, 'fqn' | 'branchName'>;
export class Feature {
    public fqn: string;
    public branchName: string;

    #initialized: boolean = false;

    #parentConfig!: Config;
    public get parentConfig() {
        if (!this.#initialized)
            throw new Error('Not initialized');

        return this.#parentConfig;
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
        this.fqn = params.fqn;
        this.branchName = params.branchName;
    }

    public register(parentConfig: Config) {
        this.#initialized = true;

        this.#parentConfig = parentConfig;
    }

    public async branchExists({ stdout }: ExecParams = {}) {
        const result = await execCmd(`git branch --list ${this.branchName}`, { cwd: this.parentConfig?.path, stdout });

        return !!result;
    }

    public async createBranch({ stdout, dryRun }: ExecParams = {}) {
        await exec(`git branch ${this.branchName}`, { cwd: this.parentConfig?.path, stdout, dryRun });
    }
}

export type ReleaseParams = Pick<Feature, 'fqn' | 'branchName'>;
export class Release {
    public fqn: string;
    public branchName: string;

    #initialized: boolean = false;

    #parentConfig!: Config;
    public get parentConfig() {
        if (!this.#initialized)
            throw new Error('Not initialized');

        return this.#parentConfig;
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
        this.fqn = params.fqn;
        this.branchName = params.branchName;
    }

    public register(parentConfig: Config) {
        this.#initialized = true;

        this.#parentConfig = parentConfig;
    }

    public async createBranch({ stdout, dryRun }: ExecParams = {}) {
        await exec(`git branch ${this.branchName}`, { cwd: this.parentConfig?.path, stdout, dryRun })
    }
}

export type ExecParams = Omit<ExecOptions, 'cwd'> & { basePath?: string };