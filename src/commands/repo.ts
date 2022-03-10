import { Command, Option } from 'clipanion';
import * as Minimatch from 'minimatch';
import * as Bluebird from 'bluebird';
import * as Chalk from 'chalk';
import Table = require('cli-table');

import * as FS from 'fs-extra';
import * as Path from 'path';

import * as Prompts from 'prompts';

import { URL } from 'url';

import { BaseCommand } from './common';

import { loadV2Config, Config, Feature, StateProxy } from '../lib/config';
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
        const config = await this.loadConfig();
        const targetConfigs = await config.resolveFilteredConfigs({
            included: this.include ?? [ 'repo://**' ],
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
        const config = await this.loadConfig();
        const targetConfigs = await config.resolveFilteredConfigs({
            included: this.include,
            excluded: this.exclude
        });

        const [ type, target ] = this.target.split('://');

        for (const config of targetConfigs) {
            const fromElement = await config.parseElement(this.target);
            const fromBranch = await (async () => {
                if (fromElement.type === 'branch')
                    return fromElement.branch;
                else if (fromElement.type === 'feature')
                    return fromElement.feature.branchName;
                else if (fromElement.type === 'release')
                    return fromElement.release.branchName;
                else if (fromElement.type === 'hotfix')
                    return fromElement.hotfix.branchName;
                else if (fromElement.type === 'support')
                    if (fromElement.targetBranch === 'develop')
                        return fromElement.support.developBranchName;
                    else if (fromElement.targetBranch === 'master')
                        return fromElement.support.masterBranchName;
                    else
                        return fromElement.support.developBranchName;
                else
                    throw new Error(`Cannot derive source branch from ${this.target}`);
            })();

            await config.checkoutBranch(fromBranch, { stdout: this.context.stdout, dryRun: this.dryRun });
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
        const config = await this.loadConfig();

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
        const config = await this.loadConfig();
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
        const config = await this.loadConfig();
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
        const config = await this.loadConfig();
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
        const config = await this.loadConfig();
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
                // const activeSupport = await config.resolveActiveSupport();

                const element = await (async () => {
                    const activeClosingFeature = await config.getStateValue('activeClosingFeature', 'string');
                    if (activeClosingFeature)
                        this.logWarning(`[${Chalk.blue(repoRelativePath)}] Resuming close of ${activeClosingFeature}...`);

                    const featureUri = activeClosingFeature ?? this.target;
                    return featureUri ? await config.parseElement(featureUri).catch(() => undefined) : await config.resolveCurrentElement();
                })();

                if (!element) {
                    this.logVerbose(`[${Chalk.blue(repoRelativePath)}] Nothing to close, bypassing`);
                    continue;
                }

                console.log(element)

                // const artifact = await (async () => {
                //     const activeClosingFeature = await config.getStateValue('activeClosingFeature', 'string');
                //     if (activeClosingFeature) {
                //         this.logWarning(`[${Chalk.blue(repoRelativePath)}] Resuming close of ${activeClosingFeature}...`);
                //     }

                //     const featureUri = activeClosingFeature ?? this.target;
                //     if (featureUri) {
                //         const [ type, target ] = featureUri.split('://');

                //         if (type === 'feature') {
                //             const feature = config.features.find(f => f.name === target);
                //             if (!feature)
                //                 return;

                //             return config.resolveArtifactFromBranch(feature.branchName);
                //         }
                //         else if (type === 'release') {
                //             const release = config.releases.find(f => f.name === target);
                //             if (!release)
                //                 return;

                //             return config.resolveArtifactFromBranch(release.branchName);
                //         }
                //         else if (type === 'hotfix') {
                //             const hotfix = config.hotfixes.find(f => f.name === target);
                //             if (!hotfix)
                //                 return;

                //             return config.resolveArtifactFromBranch(hotfix.branchName);
                //         }
                //         else {
                //             throw new Error(`Unknown target type ${type}`);
                //         }
                //     }
                //     else {
                //         return await config.resolveCurrentArtifact();
                //     }
                // })();

                if (element.type === 'feature') {
                    await promptConfirm(`You are about to close feature ${Chalk.magenta(element.feature.name)} [${Chalk.gray(element.feature.branchName)}]. Continue?`, 'close-continue');
                    await config.setStateValue('activeClosingFeature', element.feature.uri);

                    if (!this.abort) {
                        if (!await config.getStateValue([ `${element.feature.uri}/closing`, 'develop' ], 'boolean')) {
                            if (await config.isDirty({ stdout: this.context.stdout }))
                                throw new Error(`Cannot merge, please commit all outstanding changes`);

                            await config.checkoutBranch(element.feature.parentSupport?.developBranchName ?? 'develop', { stdout: this.context.stdout, dryRun: this.dryRun });
                            if (await config.isDirty({ stdout: this.context.stdout }))
                                throw new Error(`Cannot merge, develop has uncommited or staged changes`);

                            await config.merge(element.feature.branchName, { squash: true, stdout: this.context.stdout, dryRun: this.dryRun }).catch(async err => {
                                if (await FS.pathExists(Path.join(config.path, '.git/SQUASH_MSG')))
                                    await FS.writeFile(Path.join(config.path, '.git/SQUASH_MSG'), `feature ${element.feature.name} merge`);

                                while (await config.isMergeInProgress({ stdout: this.context.stdout }))
                                    await promptConfirm(`Merge of branch ${Chalk.blue(element.feature.branchName)} into ${Chalk.blue('develop')} failed, resolve conflicts to proceed. Continue?`, 'merge-continue', true);
                            });

                            if (await config.hasStagedChanges({ stdout: this.context.stdout, dryRun: this.dryRun }))
                                await config.commit(`feature ${element.feature.name} merge`, { stdout: this.context.stdout, dryRun: this.dryRun });

                            await config.setStateValue([ `${element.feature.uri}/closing`, 'develop' ], true);
                        }
                    }

                    await config.checkoutBranch(element.feature.parentSupport?.developBranchName ?? 'develop', { stdout: this.context.stdout, dryRun: this.dryRun });
                    await config.deleteBranch(element.feature.branchName, { stdout: this.context.stdout, dryRun: this.dryRun });

                    await (element.feature.parentSupport ?? element.feature.parentConfig).deleteFeature(element.feature)
                    await config.save({ stdout: this.context.stdout, dryRun: this.dryRun });

                    await config.setStateValues(`${element.feature.uri}/closing`);

                    this.logInfo(`Feature ${element.feature.name} closed`);
                }
                else if (element.type === 'release') {
                    await promptConfirm(`You are about to close release ${Chalk.magenta(element.release.name)} [${Chalk.gray(element.release.branchName)}]. Continue?`, 'close-continue');
                    await config.setStateValue('activeClosingFeature', element.release.uri);

                    if (!this.abort) {
                        if (!await config.getStateValue([ `${element.release.uri}/closing`, 'develop' ], 'boolean')) {
                            if (await config.isDirty({ stdout: this.context.stdout }))
                                throw new Error(`Cannot merge, please commit all outstanding changes`);

                            await config.checkoutBranch(element.release.parentSupport?.developBranchName ?? 'develop', { stdout: this.context.stdout, dryRun: this.dryRun });
                            if (await config.isDirty({ stdout: this.context.stdout }))
                                throw new Error(`Cannot merge, develop has uncommited or staged changes`);

                            await config.merge(element.release.branchName, { squash: true, stdout: this.context.stdout, dryRun: this.dryRun }).catch(async err => {
                                if (await FS.pathExists(Path.join(config.path, '.git/SQUASH_MSG')))
                                    await FS.writeFile(Path.join(config.path, '.git/SQUASH_MSG'), `release ${element.release.name} merge`);

                                while (await config.isMergeInProgress({ stdout: this.context.stdout }))
                                    await promptConfirm(`Merge of branch ${Chalk.blue(element.release.branchName)} into ${Chalk.blue('develop')} failed, resolve conflicts to proceed. Continue?`, 'merge-continue', true);
                            });

                            if (await config.hasStagedChanges({ stdout: this.context.stdout, dryRun: this.dryRun }))
                                await config.commit(`release ${element.release.name} merge`, { stdout: this.context.stdout, dryRun: this.dryRun });

                            await config.setStateValue([ `${element.release.uri}/closing`, 'develop' ], true);
                        }

                        if (!await config.getStateValue([ `${element.release.uri}/closing`, 'master' ], 'boolean')) {
                            await config.checkoutBranch(element.release.parentSupport?.masterBranchName ?? 'master', { stdout: this.context.stdout, dryRun: this.dryRun });
                            if (await config.isDirty({ stdout: this.context.stdout }))
                                throw new Error(`Cannot merge, master has uncommited or staged changes`);
    
                            await config.merge(element.release.branchName, { squash: true, stdout: this.context.stdout, dryRun: this.dryRun }).catch(async err => {
                                if (await FS.pathExists(Path.join(config.path, '.git/SQUASH_MSG')))
                                    await FS.writeFile(Path.join(config.path, '.git/SQUASH_MSG'), `release ${element.release.name} merge`);
    
                                while (await config.isMergeInProgress({ stdout: this.context.stdout }))
                                    await promptConfirm(`Merge of branch ${Chalk.blue(element.release.branchName)} into ${Chalk.blue('develop')} failed, resolve conflicts to proceed. Continue?`, 'merge-continue', true);
                            });

                            if (await config.hasStagedChanges({ stdout: this.context.stdout, dryRun: this.dryRun }))
                                await config.commit(`release ${element.release.name} merge`, { stdout: this.context.stdout, dryRun: this.dryRun });
    
                            await config.tag(element.release.name, { annotation: `Release ${element.release.name}`, stdout: this.context.stdout, dryRun: this.dryRun })

                            await config.setStateValue([ `${element.release.uri}/closing`, 'master' ], true);
                        }
                    }

                    await config.checkoutBranch(element.release.parentSupport?.developBranchName ?? 'develop', { stdout: this.context.stdout, dryRun: this.dryRun });
                    await config.deleteBranch(element.release.branchName, { stdout: this.context.stdout, dryRun: this.dryRun });

                    await (element.release.parentSupport ?? element.release.parentConfig).deleteRelease(element.release);
                    await config.save({ stdout: this.context.stdout, dryRun: this.dryRun });

                    await config.setStateValues(`${element.release.uri}/closing`);

                    this.logInfo(`Release ${element.release.name} closed`);
                }
                else if (element.type === 'hotfix') {
                    await promptConfirm(`You are about to close hotfix ${Chalk.magenta(element.hotfix.name)} [${Chalk.gray(element.hotfix.branchName)}]. Continue?`, 'close-continue');
                    await config.setStateValue('activeClosingFeature', element.hotfix.uri);

                    if (!this.abort) {
                        if (await config.isDirty({ stdout: this.context.stdout }))
                            throw new Error(`Cannot merge, please commit all outstanding changes`);

                        if (!await config.getStateValue([ `${element.hotfix.uri}/closing`, 'master' ], 'boolean')) {
                            await config.checkoutBranch(element.hotfix.parentSupport?.masterBranchName ?? 'master', { stdout: this.context.stdout, dryRun: this.dryRun });
                            if (await config.isDirty({ stdout: this.context.stdout }))
                                throw new Error(`Cannot merge, master has uncommited or staged changes`);

                            await config.merge(element.hotfix.branchName, { squash: true, stdout: this.context.stdout, dryRun: this.dryRun }).catch(async err => {
                                if (await FS.pathExists(Path.join(config.path, '.git/SQUASH_MSG')))
                                    await FS.writeFile(Path.join(config.path, '.git/SQUASH_MSG'), `hotfix ${element.hotfix.name} merge`);

                                while (await config.isMergeInProgress({ stdout: this.context.stdout }))
                                    await promptConfirm(`Merge of branch ${Chalk.blue(element.hotfix.branchName)} into ${Chalk.blue('develop')} failed, resolve conflicts to proceed. Continue?`, 'merge-continue', true);
                            });

                            if (await config.hasStagedChanges({ stdout: this.context.stdout, dryRun: this.dryRun }))
                                await config.commit(`hotfix ${element.hotfix.name} merge`, { stdout: this.context.stdout, dryRun: this.dryRun });

                            await config.tag(element.hotfix.name, { annotation: `Hotfix ${element.hotfix.name}`, stdout: this.context.stdout, dryRun: this.dryRun });

                            await config.setStateValue([ `${element.hotfix.uri}/closing`, 'master' ], true);
                        }

                        if (!await config.getStateValue([ `${element.hotfix.uri}/closing`, 'develop' ], 'boolean')) {
                            await config.checkoutBranch(element.hotfix.parentSupport?.developBranchName ?? 'develop', { stdout: this.context.stdout, dryRun: this.dryRun });
                            if (await config.isDirty({ stdout: this.context.stdout }))
                                throw new Error(`Cannot merge, develop has uncommited or staged changes`);
    
                            await config.merge(element.hotfix.branchName, { squash: true, stdout: this.context.stdout, dryRun: this.dryRun }).catch(async err => {
                                if (await FS.pathExists(Path.join(config.path, '.git/SQUASH_MSG')))
                                    await FS.writeFile(Path.join(config.path, '.git/SQUASH_MSG'), `hotfix ${element.hotfix.name} merge`);
    
                                while (await config.isMergeInProgress({ stdout: this.context.stdout }))
                                    await promptConfirm(`Merge of branch ${Chalk.blue(element.hotfix.branchName)} into ${Chalk.blue('develop')} failed, resolve conflicts to proceed. Continue?`, 'merge-continue', true);
                            });

                            if (await config.hasStagedChanges({ stdout: this.context.stdout, dryRun: this.dryRun }))
                                await config.commit(`hotfix ${element.hotfix.name} merge`, { stdout: this.context.stdout, dryRun: this.dryRun });
    
                            await config.setStateValue([ `${element.hotfix.uri}/closing`, 'develop' ], true);
                        }
                    }

                    await config.checkoutBranch(element.hotfix.parentSupport?.developBranchName ?? 'develop', { stdout: this.context.stdout, dryRun: this.dryRun });
                    await config.deleteBranch(element.hotfix.branchName, { stdout: this.context.stdout, dryRun: this.dryRun });

                    await (element.hotfix.parentSupport ?? element.hotfix.parentConfig).deleteHotfix(element.hotfix);
                    await config.save({ stdout: this.context.stdout, dryRun: this.dryRun });

                    await config.setStateValues(`${element.hotfix.uri}/closing`);

                    this.logInfo(`Hotfix ${element.hotfix.name} closed`);
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

export class ListCommand extends BaseCommand {
    static paths = [['list']];

    include = Option.Array('--include');
    exclude = Option.Array('--exclude');

    static usage = Command.Usage({
        description: 'Execute CLI command in repo'
    });

    public async execute() {
        const config = await this.loadConfig();
        const targetConfigs = await config.resolveFilteredConfigs({
            included: this.include,
            excluded: this.exclude
        });

        for (const config of targetConfigs) {
            const table = new Table({
                chars: { 'top': '═' , 'top-mid': '╤' , 'top-left': '╔' , 'top-right': '╗'
                        , 'bottom': '═' , 'bottom-mid': '╧' , 'bottom-left': '╚' , 'bottom-right': '╝'
                        , 'left': '║' , 'left-mid': '╟' , 'mid': '─' , 'mid-mid': '┼'
                        , 'right': '║' , 'right-mid': '╢' , 'middle': '│' }
            });
            table.push(
                { 'Path': config.pathspec },
                { 'Identifier': config.identifier }
            );

            if (config.upstreams.length) {
                const featureTable = new Table({
                    head: ['Name', 'Url']
                });
                featureTable.push(...config.upstreams.map(i => [ i.name, i.url ]));

                table.push({ 'Upstreams': featureTable.toString() });
            }
            else {
                table.push({ 'Upstreams': 'None' });
            }

            if (config.features.length) {
                const featureTable = new Table({
                    head: ['Name', 'Branch Name', 'Source SHA']
                });
                featureTable.push(...config.features.map(i => [ i.name, i.branchName, i.sourceSha ]));

                table.push({ 'Features': featureTable.toString() });
            }
            else {
                table.push({ 'Features': 'None' });
            }

            if (config.releases.length) {
                const releaseTable = new Table({
                    head: ['Name', 'Branch Name', 'Source SHA']
                });
                releaseTable.push(...config.releases.map(i => [ i.name, i.branchName, i.sourceSha ]));

                table.push({ 'Releases': releaseTable.toString() });
            }
            else {
                table.push({ 'Releases': 'None' });
            }

            if (config.hotfixes.length) {
                const hotfixTable = new Table({
                    head: ['Name', 'Branch Name', 'Source SHA']
                });
                hotfixTable.push(...config.hotfixes.map(i => [ i.name, i.branchName, i.sourceSha ]));

                table.push({ 'Hotfixes': hotfixTable.toString() });
            }
            else {
                table.push({ 'Hotfixes': 'None' });
            }

            if (config.supports.length) {
                const supportTable = new Table({
                    head: ['Name', 'Master Branch Name', 'Develop Branch Name', 'Source SHA']
                });
                supportTable.push(...config.supports.map(i => [ i.name, i.masterBranchName, i.developBranchName, i.sourceSha ]));

                table.push({ 'Supports': supportTable.toString() });
            }
            else {
                table.push({ 'Supports': 'None' });
            }

            this.context.stdout.write(table.toString() + '\n\n');
        }
    }
}