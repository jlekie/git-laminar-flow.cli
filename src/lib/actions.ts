import * as _ from 'lodash';
import * as Stream from 'stream';

import { Config, Feature, Support, Element } from './config';
import { Lazy, lazify, RequiredKeys, OptionalKeys } from './misc';

export interface CommonParams {
    stdout?: Stream.Writable;
    dryRun?: boolean;
}
export type ActionParam<T, P = void> = void extends P ? () => T | Promise<T> : (params: P) => T | Promise<T>;
export type ActionParams<T> = CommonParams & {
    [K in keyof T]: undefined extends T[K]
        ? (Required<T>[K] extends ActionParam<infer RT, infer PT> ? ActionParam<RT, PT> : () => T[K] | Promise<T[K]>)
        : T[K] extends ActionParam<infer RT, infer PT> ? ActionParam<RT, PT> : () => T[K] | Promise<T[K]>
}

export async function createFeature(config: Config, { stdout, dryRun, ...params }: ActionParams<{
    name: ActionParam<string>;
    configs: ActionParam<Config[], { configs: Config[] }>;
    from?: ActionParam<string, { config: Config }>;
    branchName: ActionParam<string, { config: Config, fromElement: Element, featureName: string }>;
    checkout?: ActionParam<boolean>
}>) {
    const featureName = await params.name();

    const allConfigs = config.flattenConfigs();
    const configs = await params.configs({ configs: allConfigs });
    for (const config of configs) {
        const from = await params.from?.({ config }) ?? 'branch://develop';
        const fromElement = await config.parseElement(from);
        const fromBranch = await (async () => {
            if (fromElement.type === 'branch')
                return fromElement.branch;
            else if (fromElement.type === 'repo')
                return fromElement.config.resolveCurrentBranch();
            else if (fromElement.type === 'feature')
                return fromElement.feature.branchName;
            else if (fromElement.type === 'release')
                return fromElement.release.branchName;
            else if (fromElement.type === 'hotfix')
                return fromElement.hotfix.branchName;
            else if (fromElement.type === 'support')
                return fromElement.support.developBranchName;
            else
                throw new Error(`Cannot derive source branch from ${from}`);
        })();

        const branchName = await params.branchName({ config, fromElement, featureName });
        const source = fromElement.type === 'support' ? fromElement.support : config;

        if (source.features.some(f => f.name === featureName))
            continue;

        const feature = new Feature({
            name: featureName,
            branchName,
            sourceSha: await config.resolveCommitSha(fromBranch)
        });
        source.features.push(feature);
        await feature.register(config, source instanceof Support ? source : undefined);

        await feature.init({ stdout: stdout, dryRun: dryRun });
        await config.save({ stdout: stdout, dryRun: dryRun });

        if (await params.checkout?.())
            await config.checkoutBranch(feature.branchName, { stdout: stdout, dryRun: dryRun });
    }
}

// import * as _ from 'lodash';
// import * as Bluebird from 'bluebird';

// import * as Chalk from 'chalk';

// import * as Path from 'path';
// import * as FS from 'fs-extra';

// import * as Stream from 'stream';

// import { loadConfig } from './config';
// import { exec } from './exec';

// export interface BaseParams {
//     stdout?: Stream.Writable;
//     configPath: string;
//     dryRun?: boolean;
// }

// export interface InitParams extends BaseParams {
//     repoBasePath?: string;
//     createGitmodulesConfig: boolean;
// }
// export async function init({ configPath, repoBasePath, createGitmodulesConfig, stdout, dryRun }: InitParams) {
//     const config = await loadConfig(configPath);

//     await Bluebird.map(config.submodules, async repo => {
//         const repoPath = Path.resolve(repoBasePath ?? '.', repo.path);

//         if (await FS.pathExists(repoPath)) {
//             await repo.fetch({ basePath: repoBasePath, stdout, dryRun });
//         }
//         else {
//             await repo.clone({ basePath: repoBasePath, stdout, dryRun });
//         }
//     }, { concurrency: 1 });

//     if (!dryRun && createGitmodulesConfig) {
//         stdout?.write(Chalk.cyan('Writing .gitmodules config...'));

//         const gitmodulesStream = FS.createWriteStream('.gitmodules');
//         for (const repo of config.submodules) {
//             const resolvedPath = Path.posix.join(repo.path);

//             gitmodulesStream.write(`[submodule "${repo.name}"]\n`);
//             gitmodulesStream.write(`    path = ${resolvedPath}\n`);
//             gitmodulesStream.write(`    url = ""\n`);
//         }
//         gitmodulesStream.close();
//     }
// }

// export interface CreateFeatureParams extends BaseParams {
// }
// export async function createFeature({ configPath, ...params }: CreateFeatureParams) {
//     const config = await loadConfig(configPath);


// }
