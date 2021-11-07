import * as _ from 'lodash';
import * as Bluebird from 'bluebird';

import * as Path from 'path';
import * as FS from 'fs-extra';
import * as Yaml from 'js-yaml';
import * as Glob from 'glob-promise';

import * as Zod from 'zod';

import { exec, ExecOptions } from './exec';

export const ConfigSubmoduleSchema = Zod.object({
    name: Zod.string(),
    path: Zod.string(),
    remotes: Zod.object({
        name: Zod.string(),
        url: Zod.string()
    }).array()
});
export const ConfigFeatureSchema = Zod.object({
    identifier: Zod.string(),
    branchName: Zod.string()
});
export const ConfigSchema = Zod.object({
    identifier: Zod.string(),
    submodules: ConfigSubmoduleSchema.array().optional(),
    features: ConfigFeatureSchema.array().optional()
});

export async function loadConfig(path: string) {
    const config = await FS.readFile(path, 'utf8')
        .then(content => Yaml.load(content))
        .then(hash => Config.parse(hash, path));

    return config;
}

export type ConfigParams = Pick<Config, 'identifier' | 'submodules' | 'features' | 'basePath'>;
export class Config {
    public identifier: string;
    public submodules: Submodule[];
    public features: Feature[];

    public basePath: string;

    public static parse(value: unknown, basePath: string) {
        return this.fromSchema(ConfigSchema.parse(value), basePath);
    }
    public static fromSchema(value: Zod.infer<typeof ConfigSchema>, basePath: string) {
        return new this({
            ...value,
            submodules: value.submodules?.map(i => Submodule.fromSchema(i)) ?? [],
            features: value.features?.map(i => Feature.fromSchema(i)) ?? [],
            basePath
        });
    }

    public constructor(params: ConfigParams) {
        this.identifier = params.identifier;
        this.submodules = params.submodules;
        this.features = params.features;
        this.basePath = params.basePath;
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

    public async fetch({ basePath, stdout, dryRun }: ExecParams = {}) {
        const cwd = Path.resolve(basePath ?? '.', this.path);

        await exec(`git fetch --all --prune`, { cwd, stdout, dryRun })
    }
    public async clone({ basePath, stdout, dryRun }: ExecParams = {}) {
        const originRemote = this.remotes.find(r => r.name == 'origin');
        if (!originRemote)
            throw new Error(`No origin remote specified for repo ${this.name}`);

        const repoPath = Path.resolve(basePath ?? '.', this.path);
        await exec(`git clone ${originRemote.url} ${repoPath}`, { stdout, dryRun })
    }
}

export type FeatureParams = Pick<Feature, 'identifier' | 'branchName'>;
export class Feature {
    public identifier: string;
    public branchName: string;

    public static parse(value: unknown) {
        return this.fromSchema(ConfigFeatureSchema.parse(value));
    }
    public static fromSchema(value: Zod.infer<typeof ConfigFeatureSchema>) {
        return new this({
            ...value
        });
    }

    public constructor(params: FeatureParams) {
        this.identifier = params.identifier;
        this.branchName = params.branchName;
    }

    public async createBranch() {
    }
}

export type ExecParams = Omit<ExecOptions, 'cwd'> & { basePath?: string };