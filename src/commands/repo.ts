import { Command, Option } from 'clipanion';
import * as Minimatch from 'minimatch';
import * as Bluebird from 'bluebird';
import * as Chalk from 'chalk';

import * as FS from 'fs-extra';
import * as Path from 'path';

import * as Prompts from 'prompts';

import { URL } from 'url';

import { BaseCommand } from './common';

import { loadConfig, Config, Feature } from '../lib/config';
import { loadState } from '../lib/state';

export class InitCommand extends BaseCommand {
    static paths = [['init']];

    reposBasePath = Option.String('--repo-base-path')

    include = Option.Array('--include');
    exclude = Option.Array('--exclude');

    static usage = Command.Usage({
        description: 'Initialize repo',
        details: 'This will initialize the repo'
    });

    public async execute() {
        const config = await loadConfig(this.configPath);
        const targetConfigs = await config.resolveFilteredConfigs({
            included: this.include,
            excluded: this.exclude
        });

        for (const config of targetConfigs)
            await config.init({ stdout: this.context.stdout, dryRun: this.dryRun });
    }
}

export class CheckoutCommand extends BaseCommand {
    static paths = [['checkout']];

    include = Option.Array('--include');
    exclude = Option.Array('--exclude');

    target = Option.String('--target', 'branch://develop');

    static usage = Command.Usage({
        description: 'Checkout feature'
    });

    public async execute() {
        const config = await loadConfig(this.configPath);
        const targetConfigs = await config.resolveFilteredConfigs({
            included: this.include,
            excluded: this.exclude
        });

        const [ type, target ] = this.target.split('://');

        for (const config of targetConfigs) {
            if (type === 'branch') {
                await config.checkoutBranch(target, { stdout: this.context.stdout, dryRun: this.dryRun });
            }
            else if (type === 'feature') {
                const feature = config.features.find(f => f.name === target);
                if (feature)
                    await config.checkoutBranch(feature.branchName, { stdout: this.context.stdout, dryRun: this.dryRun });
            }
            else if (type === 'release') {
                const release = config.releases.find(r => r.name === target);
                if (release)
                    await config.checkoutBranch(release.branchName, { stdout: this.context.stdout, dryRun: this.dryRun });
            }
            else if (type === 'hotfix') {
                const hotfix = config.hotfixes.find(r => r.name === target);
                if (hotfix)
                    await config.checkoutBranch(hotfix.branchName, { stdout: this.context.stdout, dryRun: this.dryRun });
            }
        }
    }
}

export class FetchCommand extends BaseCommand {
    static paths = [['fetch']];

    submodules = Option.Array('--submodules', [ '**' ]);

    static usage = Command.Usage({
        description: 'Fetch'
    });

    public async execute() {
        const config = await loadConfig(this.configPath);

        const targetConfigs = [
            config,
            ...config.submodules.filter(s => this.submodules.some(pattern => Minimatch(s.name, pattern))).map(s => s.config)
        ];

        await Bluebird.map(targetConfigs, config => config.fetch({ stdout: this.context.stdout, dryRun: this.dryRun }), { concurrency: 1 });
    }
}

export class ExecCommand extends BaseCommand {
    static paths = [['exec']];

    cmd = Option.String('--cmd', { required: true })
    include = Option.Array('--include');
    exclude = Option.Array('--exclude');

    static usage = Command.Usage({
        description: 'Execute CLI command in repo'
    });

    public async execute() {
        const config = await loadConfig(this.configPath);
        const targetConfigs = await config.resolveFilteredConfigs({
            included: this.include,
            excluded: this.exclude
        });

        for (const config of targetConfigs)
            await config.exec(this.cmd, { stdout: this.context.stdout, dryRun: this.dryRun });
        // await Bluebird.map(targetConfigs, config => config.exec('dir', { stdout: this.context.stdout, dryRun: this.dryRun }), {
        //     concurrency: 1
        // });
    }
}

export class StatusCommand extends BaseCommand {
    static paths = [['status']];

    include = Option.Array('--include');
    exclude = Option.Array('--exclude');

    static usage = Command.Usage({
        description: 'Report checkout status'
    });

    public async execute() {
        const config = await loadConfig(this.configPath);
        const targetConfigs = await config.resolveFilteredConfigs({
            included: this.include,
            excluded: this.exclude
        });

        for (const config of targetConfigs) {
            const artifact = await config.resolveCurrentArtifact();

            if (artifact.type === 'master')
                this.context.stdout.write(`[${Chalk.blue(config.path)}] ${Chalk.magenta('MASTER')} ${Chalk.gray(artifact.branch)}\n`);
            else if (artifact.type === 'develop')
                this.context.stdout.write(`[${Chalk.blue(config.path)}] ${Chalk.magenta('DEVELOP')} ${Chalk.gray(artifact.branch)}\n`);
            else if (artifact.type === 'feature')
                this.context.stdout.write(`[${Chalk.blue(config.path)}] ${Chalk.magenta('FEATURE')} ${Chalk.green(artifact.feature.name)} ${Chalk.gray(artifact.branch)}\n`);
            else if (artifact.type === 'release')
                this.context.stdout.write(`[${Chalk.blue(config.path)}] ${Chalk.magenta('RELEASE')} ${Chalk.green(artifact.release.name)} ${Chalk.gray(artifact.branch)}\n`);
            else
                this.context.stdout.write(`[${Chalk.blue(config.path)}] ${Chalk.gray(artifact.branch)}\n`);
        }
    }
}

export class SyncCommand extends BaseCommand {
    static paths = [['sync']];

    include = Option.Array('--include');
    exclude = Option.Array('--exclude');

    target = Option.String('--target', 'branch://develop');
    abort = Option.Boolean('--abort', false);

    static usage = Command.Usage({
        description: 'Sync checkouts with branch'
    });

    public async execute() {
        const config = await loadConfig(this.configPath);
        const targetConfigs = await config.resolveFilteredConfigs({
            included: this.include,
            excluded: this.exclude
        });

        const [ type, target ] = this.target.split('://');

        for (const config of targetConfigs) {
            const branch = (() => {
                if (type === 'branch') {
                    return target
                }
                else if (type === 'feature') {
                    const feature = config.features.find(f => f.name === target);
                    if (feature)
                        return feature.branchName;
                }
            })();

            if (!branch || !await config.branchExists(branch))
                continue;

            const currentBranch = await config.resolveCurrentBranch({ stdout: this.context.stdout });
            if (currentBranch === branch)
                continue;

            if (this.abort) {
                await config.abortMerge({ stdout: this.context.stdout, dryRun: this.dryRun });
            }
            else {
                await config.merge(branch, { stdout: this.context.stdout, dryRun: this.dryRun }).catch(() => {
                    this.logWarning(`Merge failed, resolve conflicts and commit merged changes`)
                });
            }
        }
    }
}

export class CloseCommand extends BaseCommand {
    static paths = [['close']];

    include = Option.Array('--include');
    exclude = Option.Array('--exclude');

    target = Option.String('--target');

    abort = Option.Boolean('--abort,--finish', false);

    static usage = Command.Usage({
        description: 'Closes active features/release/hotfix'
    });

    public async execute() {
        const config = await loadConfig(this.configPath);
        const targetConfigs = await config.resolveFilteredConfigs({
            included: this.include,
            excluded: this.exclude
        });

        // const [ type, target ] = this.target.split('://');

        for (const config of targetConfigs) {
            const repoRelativePath = './' + Path.relative(Path.resolve(), config.path).split(Path.sep).join(Path.posix.sep);

            const promptConfirm = async (message: string, key: string = 'value', initial?: any) => {
                await Prompts({
                    type: 'confirm',
                    name: key,
                    message: `[${Chalk.blue(repoRelativePath)}] ${message}`,
                    initial
                }).then(answers => {
                    if (!answers[key])
                        throw new Error('Close aborted');
                });
            }
            const promptSelect = async (message: string, choices: Prompts.Choice[], key: string = 'value', initial?: any) => {
                return await Prompts({
                    type: 'select',
                    name: key,
                    message: `[${Chalk.blue(repoRelativePath)}] ${message}`,
                    choices,
                    initial
                }).then(answers => answers[key]);
            }

            try {
                const artifact = await (async () => {
                    const activeClosingFeature = await config.getStateValue('activeClosingFeature', 'string');
                    if (activeClosingFeature) {
                        this.logWarning(`[${Chalk.blue(repoRelativePath)}] Resuming close of ${activeClosingFeature}...`);

                        return await config.resolveArtifactFromBranch(activeClosingFeature);
                    }
                    else if (this.target) {
                        const [ type, target ] = this.target.split('://');

                        if (type === 'feature') {
                            const feature = config.features.find(f => f.name === target);
                            if (!feature)
                                return;

                            return config.resolveArtifactFromBranch(feature.branchName);
                        }
                        else if (type === 'release') {
                            const release = config.releases.find(f => f.name === target);
                            if (!release)
                                return;

                            return config.resolveArtifactFromBranch(release.branchName);
                        }
                        else if (type === 'hotfix') {
                            const hotfix = config.hotfixes.find(f => f.name === target);
                            if (!hotfix)
                                return;

                            return config.resolveArtifactFromBranch(hotfix.branchName);
                        }
                        else {
                            throw new Error(`Unknown target type ${type}`);
                        }
                    }
                    else {
                        return await config.resolveCurrentArtifact();
                    }
                })();

                // if (artifact.type !== 'develop') {
                //     this.logWarning(`Cannot close feature unless on develop [${artifact.branch}]`);
                //     continue;
                // }

                if (artifact?.type === 'feature') {
                    // const feature = config.features.find(f => f.name === target);
                    // if (!feature)
                    //     continue;

                    await promptConfirm(`You are about to close feature ${Chalk.magenta(artifact.feature.name)} [${Chalk.gray(artifact.feature.branchName)}]. Continue?`, 'close-continue');
                    await config.setStateValue('activeClosingFeature', artifact.branch);

                    if (!this.abort) {
                        if (await config.isDirty({ stdout: this.context.stdout }))
                            throw new Error(`Cannot merge, please commit all outstanding changes`);

                        await config.checkoutBranch('develop', { stdout: this.context.stdout, dryRun: this.dryRun });
                        if (await config.isDirty({ stdout: this.context.stdout }))
                            throw new Error(`Cannot merge, develop has uncommited or staged changes`);

                        await config.merge(artifact.feature.branchName, { squash: true, stdout: this.context.stdout, dryRun: this.dryRun }).catch(async err => {
                            if (await FS.pathExists(Path.join(config.path, '.git/SQUASH_MSG')))
                                await FS.writeFile(Path.join(config.path, '.git/SQUASH_MSG'), `feature ${artifact.feature.name} merge`);

                            while (await config.isMergeInProgress({ stdout: this.context.stdout }))
                                await promptConfirm(`Merge of branch ${Chalk.blue(artifact.branch)} into ${Chalk.blue('develop')} failed, resolve conflicts to proceed. Continue?`, 'merge-continue', true);

                            // artifact.feature.setStateFlag('close/merging/develop');

                            // this.logWarning(`Git merge failure: ${err.toString()}`);
                            // await config.resetMerge({ stdout: this.context.stdout, dryRun: this.dryRun })
                            // await config.checkoutBranch(artifact.branch, { stdout: this.context.stdout, dryRun: this.dryRun });

                            // if (await FS.pathExists(Path.join(config.path, '.git/SQUASH_MSG')))
                            //     await FS.writeFile(Path.join(config.path, '.git/SQUASH_MSG'), `feature ${artifact.feature.name} merge`);

                            // throw err;
                        });

                        if (await config.hasStagedChanges({ stdout: this.context.stdout, dryRun: this.dryRun }))
                            await config.commit(`feature ${artifact.feature.name} merge`, { stdout: this.context.stdout, dryRun: this.dryRun });
                    }

                    await config.checkoutBranch('develop', { stdout: this.context.stdout, dryRun: this.dryRun });
                    await config.deleteBranch(artifact.feature.branchName, { stdout: this.context.stdout, dryRun: this.dryRun });

                    await config.deleteFeature(artifact.feature)
                    await config.save({ stdout: this.context.stdout, dryRun: this.dryRun });

                    this.logInfo(`Feature ${artifact.feature.name} closed`);
                }
                else if (artifact?.type === 'release') {
                    // const release = config.releases.find(f => f.name === target);
                    // if (!release)
                    //     continue;

                    await promptConfirm(`You are about to close release ${Chalk.magenta(artifact.release.name)} [${Chalk.gray(artifact.release.branchName)}]. Continue?`, 'close-continue');
                    await config.setStateValue('activeClosingFeature', artifact.branch);

                    if (!this.abort) {
                        if (await config.isDirty({ stdout: this.context.stdout }))
                            throw new Error(`Cannot merge, please commit all outstanding changes`);

                        await config.checkoutBranch('develop', { stdout: this.context.stdout, dryRun: this.dryRun });
                        if (await config.isDirty({ stdout: this.context.stdout }))
                            throw new Error(`Cannot merge, develop has uncommited or staged changes`);

                        await config.merge(artifact.release.branchName, { squash: true, stdout: this.context.stdout, dryRun: this.dryRun }).catch(async err => {
                            if (await FS.pathExists(Path.join(config.path, '.git/SQUASH_MSG')))
                                await FS.writeFile(Path.join(config.path, '.git/SQUASH_MSG'), `release ${artifact.release.name} merge`);

                            while (await config.isMergeInProgress({ stdout: this.context.stdout }))
                                await promptConfirm(`Merge of branch ${Chalk.blue(artifact.branch)} into ${Chalk.blue('develop')} failed, resolve conflicts to proceed. Continue?`, 'merge-continue', true);

                            // this.logWarning(`Git merge failure: ${err.toString()}`);
                            // await config.resetMerge({ stdout: this.context.stdout, dryRun: this.dryRun })
                            // await config.checkoutBranch(artifact.branch, { stdout: this.context.stdout, dryRun: this.dryRun });

                            // throw err;
                        });
    
                        if (await config.hasStagedChanges({ stdout: this.context.stdout, dryRun: this.dryRun }))
                            await config.commit(`release ${artifact.release.name} merge`, { stdout: this.context.stdout, dryRun: this.dryRun });
                    }

                    if (!this.abort) {
                        await config.checkoutBranch('master', { stdout: this.context.stdout, dryRun: this.dryRun });
                        if (await config.isDirty({ stdout: this.context.stdout }))
                            throw new Error(`Cannot merge, master has uncommited or staged changes`);

                        await config.merge(artifact.release.branchName, { squash: true, stdout: this.context.stdout, dryRun: this.dryRun }).catch(async err => {
                            if (await FS.pathExists(Path.join(config.path, '.git/SQUASH_MSG')))
                                await FS.writeFile(Path.join(config.path, '.git/SQUASH_MSG'), `release ${artifact.release.name} merge`);

                            while (await config.isMergeInProgress({ stdout: this.context.stdout }))
                                await promptConfirm(`Merge of branch ${Chalk.blue(artifact.branch)} into ${Chalk.blue('develop')} failed, resolve conflicts to proceed. Continue?`, 'merge-continue', true);

                            // this.logWarning(`Git merge failure: ${err.toString()}`);
                            // await config.resetMerge({ stdout: this.context.stdout, dryRun: this.dryRun })
                            // await config.checkoutBranch(artifact.branch, { stdout: this.context.stdout, dryRun: this.dryRun });

                            // throw err;
                        });
    
                        if (await config.hasStagedChanges({ stdout: this.context.stdout, dryRun: this.dryRun }))
                            await config.commit(`release ${artifact.release.name} merge`, { stdout: this.context.stdout, dryRun: this.dryRun });

                        await config.tag(artifact.release.name, { annotation: `Release ${artifact.release.name}`, stdout: this.context.stdout, dryRun: this.dryRun })
                    }

                    await config.deleteBranch(artifact.release.branchName, { stdout: this.context.stdout, dryRun: this.dryRun });

                    await config.deleteRelease(artifact.release);
                    await config.save({ stdout: this.context.stdout, dryRun: this.dryRun });

                    await config.checkoutBranch('develop', { stdout: this.context.stdout, dryRun: this.dryRun });

                    this.logInfo(`Release ${artifact.release.name} closed`);
                }
                else if (artifact?.type === 'hotfix') {
                    await promptConfirm(`You are about to close hotfix ${Chalk.magenta(artifact.hotfix.name)} [${Chalk.gray(artifact.hotfix.branchName)}]. Continue?`, 'close-continue');
                    await config.setStateValue('activeClosingFeature', artifact.branch);

                    if (!this.abort) {
                        if (await config.isDirty({ stdout: this.context.stdout }))
                            throw new Error(`Cannot merge, please commit all outstanding changes`);

                        await config.checkoutBranch('develop', { stdout: this.context.stdout, dryRun: this.dryRun });
                        if (await config.isDirty({ stdout: this.context.stdout }))
                            throw new Error(`Cannot merge, develop has uncommited or staged changes`);

                        await config.merge(artifact.hotfix.branchName, { squash: true, stdout: this.context.stdout, dryRun: this.dryRun }).catch(async err => {
                            // artifact.hotfix.setStateFlag('close/merging');
                            // while (await config.isMergeInProgress({ stdout: this.context.stdout })) {
                            //     await prompt('Git merge failure', { cwd: config.path, stdin: this.context.stdin, stdout: this.context.stdout });
                            // }

                            if (await FS.pathExists(Path.join(config.path, '.git/SQUASH_MSG')))
                                await FS.writeFile(Path.join(config.path, '.git/SQUASH_MSG'), `hotfix ${artifact.hotfix.name} merge`);

                            while (await config.isMergeInProgress({ stdout: this.context.stdout }))
                                await promptConfirm(`Merge of branch ${Chalk.blue(artifact.branch)} into ${Chalk.blue('develop')} failed, resolve conflicts to proceed. Continue?`, 'merge-continue', true);

                            // await prompt('Git merge failure. Please resolve conflicts to continue.', { cwd: config.path, stdin: this.context.stdin, stdout: this.context.stdout });
                            // if (!await config.isMergeInProgress({ stdout: this.context.stdout })) {
                            //     this.logWarning(`Git merge failure: ${err.toString()}`);
                            //     await config.resetMerge({ stdout: this.context.stdout, dryRun: this.dryRun });
                            //     await config.checkoutBranch(artifact.branch, { stdout: this.context.stdout, dryRun: this.dryRun });

                            //     throw err;
                            // }
                        });
    
                        if (await config.hasStagedChanges({ stdout: this.context.stdout, dryRun: this.dryRun }))
                            await config.commit(`hotfix ${artifact.hotfix.name} merge`, { stdout: this.context.stdout, dryRun: this.dryRun });
                    }

                    await config.checkoutBranch('master', { stdout: this.context.stdout, dryRun: this.dryRun });
                    if (await config.isDirty({ stdout: this.context.stdout }))
                        throw new Error(`Cannot merge, master has uncommited or staged changes`);

                    if (!this.abort) {
                        await config.merge(artifact.hotfix.branchName, { squash: true, stdout: this.context.stdout, dryRun: this.dryRun }).catch(async err => {
                            // while (await config.isMergeInProgress({ stdout: this.context.stdout })) {
                            //     await prompt('Git merge failure', { cwd: config.path, stdin: this.context.stdin, stdout: this.context.stdout });
                            // }

                            if (await FS.pathExists(Path.join(config.path, '.git/SQUASH_MSG')))
                                await FS.writeFile(Path.join(config.path, '.git/SQUASH_MSG'), `hotfix ${artifact.hotfix.name} merge`);

                            while (await config.isMergeInProgress({ stdout: this.context.stdout }))
                                await promptConfirm(`Merge of branch ${Chalk.blue(artifact.branch)} into ${Chalk.blue('develop')} failed, resolve conflicts to proceed. Continue?`, 'merge-continue', true);

                            // await prompt('Git merge failure. Please resolve conflicts to continue.', { cwd: config.path, stdin: this.context.stdin, stdout: this.context.stdout });
                            // if (!await config.isMergeInProgress({ stdout: this.context.stdout })) {
                            //     this.logWarning(`Git merge failure: ${err.toString()}`);
                            //     await config.resetMerge({ stdout: this.context.stdout, dryRun: this.dryRun });
                            //     await config.checkoutBranch(artifact.branch, { stdout: this.context.stdout, dryRun: this.dryRun });

                            //     throw err;
                            // }
                        });

                        // await config.merge(artifact.hotfix.branchName, { overwrite: true, squash: true, stdout: this.context.stdout, dryRun: this.dryRun }).catch(async err => {
                        //     this.logWarning(`Git merge failure: ${err.toString()}`);
                        //     await config.resetMerge({ stdout: this.context.stdout, dryRun: this.dryRun });
                        //     await config.checkoutBranch(artifact.branch, { stdout: this.context.stdout, dryRun: this.dryRun });

                        //     throw err;
                        // });
    
                        if (await config.hasStagedChanges({ stdout: this.context.stdout, dryRun: this.dryRun }))
                            await config.commit(`hotfix ${artifact.hotfix.name} merge`, { stdout: this.context.stdout, dryRun: this.dryRun });

                        await config.tag(artifact.hotfix.name, { annotation: `Hotfix ${artifact.hotfix.name}`, stdout: this.context.stdout, dryRun: this.dryRun })
                    }

                    await config.deleteBranch(artifact.hotfix.branchName, { stdout: this.context.stdout, dryRun: this.dryRun });

                    await config.deleteHotfix(artifact.hotfix);
                    await config.save({ stdout: this.context.stdout, dryRun: this.dryRun });

                    await config.checkoutBranch('develop', { stdout: this.context.stdout, dryRun: this.dryRun });

                    this.logInfo(`Hotfix ${artifact.hotfix.name} closed`);
                }
                else {
                    this.logVerbose(`[${Chalk.blue(repoRelativePath)}] Nothing to close, bypassing`);
                }

                await config.setStateValue('activeClosingFeature');
            }
            catch (err) {
                this.logError(`[${repoRelativePath}] ${err.toString()}`);
            }
        }
    }
}