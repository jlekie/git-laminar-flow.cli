import * as _ from 'lodash';
import * as Bluebird from 'bluebird';

import * as Chalk from 'chalk';

import * as Path from 'path';
import * as FS from 'fs-extra';

import * as Stream from 'stream';

import { loadConfig } from './config';
import { exec } from './exec';

export interface BaseParams {
    stdout?: Stream.Writable;
    configPath: string;
    dryRun?: boolean;
}

export interface InitParams extends BaseParams {
    repoBasePath?: string;
    createGitmodulesConfig: boolean;
}
export async function init({ configPath, repoBasePath, createGitmodulesConfig, stdout, dryRun }: InitParams) {
    const config = await loadConfig(configPath);

    await Bluebird.map(config.submodules, async repo => {
        const repoPath = Path.resolve(repoBasePath ?? '.', repo.path);

        if (await FS.pathExists(repoPath)) {
            await repo.fetch({ basePath: repoBasePath, stdout, dryRun });
        }
        else {
            await repo.clone({ basePath: repoBasePath, stdout, dryRun });
        }
    }, { concurrency: 1 });

    if (!dryRun && createGitmodulesConfig) {
        stdout?.write(Chalk.cyan('Writing .gitmodules config...'));

        const gitmodulesStream = FS.createWriteStream('.gitmodules');
        for (const repo of config.submodules) {
            const resolvedPath = Path.posix.join(repo.path);

            gitmodulesStream.write(`[submodule "${repo.name}"]\n`);
            gitmodulesStream.write(`    path = ${resolvedPath}\n`);
            gitmodulesStream.write(`    url = ""\n`);
        }
        gitmodulesStream.close();
    }
}

export interface CreateFeatureParams extends BaseParams {
}
export async function createFeature({ configPath, ...params }: CreateFeatureParams) {
    const config = await loadConfig(configPath);


}