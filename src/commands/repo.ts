import { Command, Option } from 'clipanion';
import * as Typanion from 'typanion';
import * as Minimatch from 'minimatch';
import * as Bluebird from 'bluebird';
import * as _ from 'lodash';
import * as Chalk from 'chalk';
import Table = require('cli-table');
import * as Zod from 'zod';

import * as FS from 'fs-extra';
import * as Path from 'path';

import * as Prompts from 'prompts';

import { BaseCommand, BaseInteractiveCommand, OverridablePromptAnswerTypes } from './common';

import { iterateTopologicallyNonMapped } from '../lib/config';
import { commit, sync, setVersion, incrementVersion, viewVersion, stampVersion, setDependencies, listDependants } from '../lib/actions';
import { executeVscode } from '../lib/exec';
import { StatusTypes } from '../lib/porcelain';

export class InitCommand extends BaseCommand {
    static paths = [['init']];

    reposBasePath = Option.String('--repo-base-path')

    include = Option.Array('--include');
    exclude = Option.Array('--exclude');

    parallelism = Option.String('--parallelism', { validator: Typanion.isNumber() });

    target = Option.String('--target');

    // writeGitmodules = Option.Boolean('--write-gitmodules');

    static usage = Command.Usage({
        description: 'Initialize repo'
    });

    public async executeCommand() {
        const config = await this.loadConfig();
        const targetConfigs = await config.resolveFilteredConfigs({
            included: this.include ?? [ 'repo://**' ],
            excluded: this.exclude
        });

        const configGroups = [];
        for await (const configGroup of iterateTopologicallyNonMapped(targetConfigs, (item, parent) => item.parentConfig === parent))
            configGroups.push(configGroup);

        for (const configGroup of configGroups)
            await Bluebird.map(configGroup, async config => {
                await config.init({ stdout: this.context.stdout, dryRun: this.dryRun, writeGitmdoulesConfig: true });

                if (this.target) {
                    if (!await config.hasElement(this.target))
                        return;

                    const fromElement = await config.parseElement(this.target);
                    const fromBranch = await (async () => {
                        if (fromElement.type === 'branch') {
                            if (fromElement.branch === 'develop')
                                return config.resolveDevelopBranchName();
                            else if (fromElement.branch === 'master')
                                return config.resolveMasterBranchName();
                            else
                                return fromElement.branch;
                        }
                        else if (fromElement.type === 'feature')
                            return fromElement.feature.branchName;
                        else if (fromElement.type === 'release')
                            return fromElement.release.branchName;
                        else if (fromElement.type === 'hotfix')
                            return fromElement.hotfix.branchName;
                        else if (fromElement.type === 'support') {
                            if (fromElement.targetBranch === 'develop')
                                return fromElement.support.developBranchName;
                            else if (fromElement.targetBranch === 'master')
                                return fromElement.support.masterBranchName;
                            else
                                return fromElement.support.developBranchName;
                        }
                        else
                            throw new Error(`Cannot derive source branch from ${this.target}`);
                    })();

                    await config.checkoutBranch(fromBranch, { stdout: this.context.stdout, dryRun: this.dryRun });
                }
            }, this.parallelism ? { concurrency: this.parallelism } : undefined);

        // for (const config of targetConfigs)
        //     await config.init({ stdout: this.context.stdout, dryRun: this.dryRun });
    }
}

export class CheckoutCommand extends BaseCommand {
    static paths = [['checkout']];

    include = Option.Array('--include');
    exclude = Option.Array('--exclude');

    target = Option.String('--target', 'branch://develop');

    static usage = Command.Usage({
        description: 'Checkout target'
    });

    public async executeCommand() {
        const config = await this.loadConfig();
        const targetConfigs = await config.resolveFilteredConfigs({
            included: this.include,
            excluded: this.exclude
        });

        const [ type, target ] = this.target.split('://');

        for (const config of targetConfigs) {
            if (!await config.hasElement(this.target))
                continue;

            const fromElement = await config.parseElement(this.target);
            const fromBranch = await (async () => {
                if (fromElement.type === 'branch') {
                    if (fromElement.branch === 'develop')
                        return config.resolveDevelopBranchName();
                    else if (fromElement.branch === 'master')
                        return config.resolveMasterBranchName();
                    else
                        return fromElement.branch;
                }
                else if (fromElement.type === 'feature')
                    return fromElement.feature.branchName;
                else if (fromElement.type === 'release')
                    return fromElement.release.branchName;
                else if (fromElement.type === 'hotfix')
                    return fromElement.hotfix.branchName;
                else if (fromElement.type === 'support') {
                    if (fromElement.targetBranch === 'develop')
                        return fromElement.support.developBranchName;
                    else if (fromElement.targetBranch === 'master')
                        return fromElement.support.masterBranchName;
                    else
                        return fromElement.support.developBranchName;
                }
                else
                    throw new Error(`Cannot derive source branch from ${this.target}`);
            })();

            await config.checkoutBranch(fromBranch, { stdout: this.context.stdout, dryRun: this.dryRun });
        }
    }
}

export class CommitCommand extends BaseInteractiveCommand {
    static paths = [['commit']];

    include = Option.Array('--include');
    exclude = Option.Array('--exclude');

    stageAll = Option.Boolean('--stage-all');
    message = Option.String('--message');

    static usage = Command.Usage({
        description: 'Commit'
    });

    public async executeCommand() {
        const rootConfig = await this.loadConfig();
        const targetConfigs = await rootConfig.resolveFilteredConfigs({
            included: this.include,
            excluded: this.exclude
        });

        await commit(rootConfig, {
            configs: async ({ configs }) => this.createOverridablePrompt('configs', value => Zod.string().array().transform(ids => _(ids).map(id => configs.find(c => c.identifier === id)).compact().value()).parse(value), (initial) => ({
                type: 'multiselect',
                message: 'Select Modules',
                choices: configs.map(c => ({ title: c.pathspec, value: c.identifier, selected: initial?.some(tc => tc === c.identifier) }))
            }), {
                defaultValue: targetConfigs.map(c => c.identifier)
            }),
            stagedFiles: async ({ config, statuses }) => this.createOverridablePrompt('stagedFiles', value => Zod.string().array().parse(value), (initial) => ({
                type: 'multiselect',
                message: `[${Chalk.magenta(config.pathspec)}] Files to Stage`,
                choices: statuses.map(status => ({ title: status.path, value: status.path, selected: initial?.includes(status.path) }))
            }), {
                pathspecPrefix: config.pathspec,
                defaultValue: statuses.filter(s => s.staged || this.stageAll).map(s => s.path)
            }),
            message: ({ configs }) => this.createOverridablePrompt('message', value => Zod.string().nonempty().parse(value), (initial) => ({
                type: 'text',
                message: `[${Chalk.magenta(configs.map(c => c.pathspec).join(', '))}] Commit Message`,
                initial
            }), {
                // pathspecPrefix: config.pathspec,
                defaultValue: this.message ?? 'checkpoint'
            }),
            stage: ({ config }) => this.createOverridablePrompt('stage', value => Zod.boolean().parse(value), {
                type: 'confirm',
                message: `[${Chalk.magenta(config.pathspec)}] Stage All Changes`,
            }, {
                pathspecPrefix: config.pathspec,
                defaultValue: false
            }),
            stdout: this.context.stdout,
            dryRun: this.dryRun
        });
    }
}

export class FetchCommand extends BaseCommand {
    static paths = [['fetch']];

    submodules = Option.Array('--submodules', [ '**' ]);

    static usage = Command.Usage({
        description: 'Fetch'
    });

    public async executeCommand() {
        const config = await this.loadConfig();

        const targetConfigs = [
            config,
            ...config.submodules.filter(s => this.submodules.some(pattern => Minimatch(s.name, pattern))).map(s => s.config)
        ];

        await Bluebird.map(targetConfigs, config => config.fetch({ stdout: this.context.stdout, dryRun: this.dryRun }), { concurrency: 1 });
    }
}

export class ExecCommand extends BaseInteractiveCommand {
    static paths = [['exec']];

    include = Option.Array('--include');
    exclude = Option.Array('--exclude');

    concurrency = Option.String('-c,--concurrency');

    static usage = Command.Usage({
        description: 'Execute CLI command in repo'
    });

    public async executeCommand() {
        const concurrency = this.concurrency ? parseInt(this.concurrency) : undefined;

        const rootConfig = await this.loadConfig();
        const targetConfigs = await rootConfig.resolveFilteredConfigs({
            included: this.include,
            excluded: this.exclude
        });

        const allConfigs = rootConfig.flattenConfigs();
        const configs = await this.createOverridablePrompt('configs', value => Zod.string().array().transform(ids => _(ids).map(id => allConfigs.find(c => c.identifier === id)).compact().value()).parse(value), (initial) => ({
            type: 'multiselect',
            message: 'Select Modules',
            choices: allConfigs.map(c => ({ title: c.pathspec, value: c.identifier, selected: initial?.some(tc => tc === c.identifier) }))
        }), {
            defaultValue: targetConfigs.map(c => c.identifier)
        });

        const cmd = await this.createOverridablePrompt('cmd', value => Zod.string().nonempty().parse(value), {
            type: 'text',
            message: 'Command'
        });

        await Bluebird.map(configs, config => config.execRaw(cmd, { stdout: this.context.stdout, dryRun: this.dryRun }).then(() => {
            this.context.stdout.write(`[${Chalk.magenta(config.pathspec)}] ${Chalk.cyan(cmd)} ${Chalk.green('Complete')}\n`);
        }).catch(err => {
            this.context.stdout.write(`[${Chalk.magenta(config.pathspec)}] ${Chalk.cyan(cmd)} ${Chalk.red('Failed')} <${Chalk.red(err)}>\n`);
        }), concurrency ? {
            concurrency
        } : undefined);
    }
}

// export class StatusCommand extends BaseCommand {
//     static paths = [['status']];

//     include = Option.Array('--include');
//     exclude = Option.Array('--exclude');

//     static usage = Command.Usage({
//         description: 'Report checkout status'
//     });

//     public async executeCommand() {
//         const config = await this.loadConfig();
//         const targetConfigs = await config.resolveFilteredConfigs({
//             included: this.include,
//             excluded: this.exclude
//         });

//         for (const config of targetConfigs) {
//             const artifact = await config.resolveCurrentArtifact();

//             if (artifact.type === 'master')
//                 this.context.stdout.write(`[${Chalk.blue(config.path)}] ${Chalk.magenta('MASTER')} ${Chalk.gray(artifact.branch)}\n`);
//             else if (artifact.type === 'develop')
//                 this.context.stdout.write(`[${Chalk.blue(config.path)}] ${Chalk.magenta('DEVELOP')} ${Chalk.gray(artifact.branch)}\n`);
//             else if (artifact.type === 'feature')
//                 this.context.stdout.write(`[${Chalk.blue(config.path)}] ${Chalk.magenta('FEATURE')} ${Chalk.green(artifact.feature.name)} ${Chalk.gray(artifact.branch)}\n`);
//             else if (artifact.type === 'release')
//                 this.context.stdout.write(`[${Chalk.blue(config.path)}] ${Chalk.magenta('RELEASE')} ${Chalk.green(artifact.release.name)} ${Chalk.gray(artifact.branch)}\n`);
//             else
//                 this.context.stdout.write(`[${Chalk.blue(config.path)}] ${Chalk.gray(artifact.branch)}\n`);
//         }
//     }
// }
export class StatusCommand extends BaseInteractiveCommand {
    static paths = [['status']];

    include = Option.Array('--include');
    exclude = Option.Array('--exclude');

    static usage = Command.Usage({
        description: 'Report checkout status'
    });

    public async executeCommand() {
        const rootConfig = await this.loadConfig();
        const allConfigs = rootConfig.flattenConfigs();
        const targetConfigs = await rootConfig.resolveFilteredConfigs({
            included: this.include,
            excluded: this.exclude
        });
        const configs = await this.createOverridablePrompt('configs', value => Zod.string().array().transform(ids => _(ids).map(id => allConfigs.find(c => c.identifier === id)).compact().value()).parse(value), (initial) => ({
            type: 'multiselect',
            message: 'Select Modules',
            choices: allConfigs.map(c => ({ title: c.pathspec, value: c.identifier, selected: initial?.some(tc => tc === c.identifier) }))
        }), {
            defaultValue: targetConfigs.map(c => c.identifier)
        });

        const resolvedStatuses = await Bluebird.map(configs, async config => ({
            config,
            statuses: await config.resolveStatuses({ stdout: this.context.stdout, dryRun: this.dryRun })
        })).filter(c => c.statuses.length > 0);

        for (const { config, statuses } of resolvedStatuses) {
            const table = new Table({
                head: [ Chalk.white.bold(`${config.pathspec} [${Chalk.magenta(await config.resolveCurrentBranch({ stdout: this.context.stdout, dryRun: this.dryRun }))}]`) ],
                chars: { 'top': '═' , 'top-mid': '╤' , 'top-left': '╔' , 'top-right': '╗'
                        , 'bottom': '═' , 'bottom-mid': '╧' , 'bottom-left': '╚' , 'bottom-right': '╝'
                        , 'left': '║' , 'left-mid': '╟' , 'mid': '─' , 'mid-mid': '┼'
                        , 'right': '║' , 'right-mid': '╢' , 'middle': '│' }
            });

            const stagedChanges = statuses.filter(s => s.staged);
            const unstagedChanges = statuses.filter(s => !s.staged);

            if (stagedChanges.length) {
                table.push([
                    Chalk.blue.bold.underline('STAGED') + '\n\n' +
                    stagedChanges.map(status => {
                        if (status.type === StatusTypes.Untracked)
                            return Chalk.gray('U ' + status.path) + (status.isSubmodule ? ` [${Chalk.magenta('SUBMODULE')}]` : '');
                        else if (status.type === StatusTypes.Modified)
                            return Chalk.yellow('M ' + status.path) + (status.isSubmodule ? ` [${Chalk.magenta('SUBMODULE')}]` : '');
                        else if (status.type === StatusTypes.Added)
                            return Chalk.green('A ' + status.path) + (status.isSubmodule ? ` [${Chalk.magenta('SUBMODULE')}]` : '');
                        else if (status.type === StatusTypes.Deleted)
                            return Chalk.red('D ' + status.path) + (status.isSubmodule ? ` [${Chalk.magenta('SUBMODULE')}]` : '');
                        else if (status.type === StatusTypes.Renamed)
                            return Chalk.yellow('R ' + status.path) + (status.isSubmodule ? ` [${Chalk.magenta('SUBMODULE')}]` : '');
                        else if (status.type === StatusTypes.Copied)
                            return Chalk.gray('C ' + status.path) + (status.isSubmodule ? ` [${Chalk.magenta('SUBMODULE')}]` : '');
                        else
                            return Chalk.gray('? ' + status.path) + (status.isSubmodule ? ` [${Chalk.magenta('SUBMODULE')}]` : '');
                    }).join('\n'),
                ]);
            }

            if (unstagedChanges.length) {
                table.push([
                    Chalk.blue.bold.underline('UNSTAGED') + '\n\n' +
                    unstagedChanges.map(status => {
                        if (status.type === StatusTypes.Untracked)
                            return Chalk.gray('U ' + status.path) + (status.isSubmodule ? ` [${Chalk.magenta('SUBMODULE')}]` : '');
                        else if (status.type === StatusTypes.Modified)
                            return Chalk.yellow('M ' + status.path) + (status.isSubmodule ? ` [${Chalk.magenta('SUBMODULE')}]` : '');
                        else if (status.type === StatusTypes.Added)
                            return Chalk.green('A ' + status.path) + (status.isSubmodule ? ` [${Chalk.magenta('SUBMODULE')}]` : '');
                        else if (status.type === StatusTypes.Deleted)
                            return Chalk.red('D ' + status.path) + (status.isSubmodule ? ` [${Chalk.magenta('SUBMODULE')}]` : '');
                        else if (status.type === StatusTypes.Renamed)
                            return Chalk.yellow('R ' + status.path) + (status.isSubmodule ? ` [${Chalk.magenta('SUBMODULE')}]` : '');
                        else if (status.type === StatusTypes.Copied)
                            return Chalk.gray('C ' + status.path) + (status.isSubmodule ? ` [${Chalk.magenta('SUBMODULE')}]` : '');
                        else
                            return Chalk.gray('? ' + status.path) + (status.isSubmodule ? ` [${Chalk.magenta('SUBMODULE')}]` : '');
                    }).join('\n'),
                ]);
            }

            this.context.stdout.write(table.toString() + '\n');
        }
    }
}

export class SyncCommand extends BaseInteractiveCommand {
    static paths = [['sync']];

    include = Option.Array('--include');
    exclude = Option.Array('--exclude');

    push = Option.Boolean('--push', false);

    static usage = Command.Usage({
        description: 'Sync local/remote changes'
    });

    public async executeCommand() {
        const rootConfig = await this.loadConfig();
        const targetConfigs = await rootConfig.resolveFilteredConfigs({
            included: this.include,
            excluded: this.exclude
        });

        await sync(rootConfig, {
            configs: async ({ configs }) => this.createOverridablePrompt('configs', value => Zod.string().array().transform(ids => _(ids).map(id => configs.find(c => c.identifier === id)).compact().value()).parse(value), (initial) => ({
                type: 'multiselect',
                message: 'Select Modules',
                choices: configs.map(c => ({ title: c.pathspec, value: c.identifier, selected: initial?.some(tc => tc === c.identifier) }))
            }), {
                defaultValue: targetConfigs.map(c => c.identifier)
            }),
            push: () => this.push,
            stdout: this.context.stdout,
            dryRun: this.dryRun
        });
    }
}
// export class SyncCommand extends BaseCommand {
//     static paths = [['sync']];

//     include = Option.Array('--include');
//     exclude = Option.Array('--exclude');

//     target = Option.String('--target', 'branch://develop');
//     abort = Option.Boolean('--abort', false);

//     static usage = Command.Usage({
//         description: 'Sync checkouts with branch'
//     });

//     public async executeCommand() {
//         const config = await this.loadConfig();
//         const targetConfigs = await config.resolveFilteredConfigs({
//             included: this.include,
//             excluded: this.exclude
//         });

//         const [ type, target ] = this.target.split('://');

//         for (const config of targetConfigs) {
//             const branch = (() => {
//                 if (type === 'branch') {
//                     return target
//                 }
//                 else if (type === 'feature') {
//                     const feature = config.features.find(f => f.name === target);
//                     if (feature)
//                         return feature.branchName;
//                 }
//             })();

//             if (!branch || !await config.branchExists(branch))
//                 continue;

//             const currentBranch = await config.resolveCurrentBranch({ stdout: this.context.stdout });
//             if (currentBranch === branch)
//                 continue;

//             if (this.abort) {
//                 await config.abortMerge({ stdout: this.context.stdout, dryRun: this.dryRun });
//             }
//             else {
//                 await config.merge(branch, { stdout: this.context.stdout, dryRun: this.dryRun }).catch(() => {
//                     this.logWarning(`Merge failed, resolve conflicts and commit merged changes`)
//                 });
//             }
//         }
//     }
// }

export class CloseCommand extends BaseCommand {
    static paths = [['close']];

    include = Option.Array('--include');
    exclude = Option.Array('--exclude');

    target = Option.String('--target');

    abort = Option.Boolean('--abort,--finish', false);

    static usage = Command.Usage({
        description: 'Closes active features/release/hotfix'
    });

    public async executeCommand() {
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

                            await config.checkoutBranch(element.feature.parentSupport?.developBranchName ?? config.resolveDevelopBranchName(), { stdout: this.context.stdout, dryRun: this.dryRun });
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

                    await config.checkoutBranch(element.feature.parentSupport?.developBranchName ?? config.resolveDevelopBranchName(), { stdout: this.context.stdout, dryRun: this.dryRun });
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

                            await config.checkoutBranch(element.release.parentSupport?.developBranchName ?? config.resolveDevelopBranchName(), { stdout: this.context.stdout, dryRun: this.dryRun });
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
                            await config.checkoutBranch(element.release.parentSupport?.masterBranchName ?? config.resolveMasterBranchName(), { stdout: this.context.stdout, dryRun: this.dryRun });
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

                    await config.checkoutBranch(element.release.parentSupport?.developBranchName ?? config.resolveDevelopBranchName(), { stdout: this.context.stdout, dryRun: this.dryRun });
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
                            await config.checkoutBranch(element.hotfix.parentSupport?.masterBranchName ?? config.resolveMasterBranchName(), { stdout: this.context.stdout, dryRun: this.dryRun });
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
                            await config.checkoutBranch(element.hotfix.parentSupport?.developBranchName ?? config.resolveDevelopBranchName(), { stdout: this.context.stdout, dryRun: this.dryRun });
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

                    await config.checkoutBranch(element.hotfix.parentSupport?.developBranchName ?? config.resolveDevelopBranchName(), { stdout: this.context.stdout, dryRun: this.dryRun });
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
        description: 'List overall status of repo'
    });

    public async executeCommand() {
        const config = await this.loadConfig();
        const targetConfigs = await config.resolveFilteredConfigs({
            included: this.include,
            excluded: this.exclude
        });

        const targets = await Bluebird.map(targetConfigs, async config => {
            const masterStatus = await config.resolveBranchStatus(config.resolveMasterBranchName(), 'origin', { stdout: this.context.stdout, dryRun: this.dryRun });
            const developStatus = await config.resolveBranchStatus(config.resolveDevelopBranchName(), 'origin', { stdout: this.context.stdout, dryRun: this.dryRun });

            return {
                config,
                master: {
                    ...masterStatus,
                    commitsAhead: await masterStatus.resolveCommitsAhead({ stdout: this.context.stdout }),
                    commitsBehind: await masterStatus.resolveCommitsBehind({ stdout: this.context.stdout })
                },
                develop: {
                    ...developStatus,
                    commitsAhead: await developStatus.resolveCommitsAhead({ stdout: this.context.stdout }),
                    commitsBehind: await developStatus.resolveCommitsBehind({ stdout: this.context.stdout })
                }
            };
        });

        for (const { config, master, develop } of targets) {
            const table = new Table({
                chars: { 'top': '═' , 'top-mid': '╤' , 'top-left': '╔' , 'top-right': '╗'
                        , 'bottom': '═' , 'bottom-mid': '╧' , 'bottom-left': '╚' , 'bottom-right': '╝'
                        , 'left': '║' , 'left-mid': '╟' , 'mid': '─' , 'mid-mid': '┼'
                        , 'right': '║' , 'right-mid': '╢' , 'middle': '│' }
            });
            table.push(
                { 'Path': config.pathspec },
                // { 'Identifier': config.identifier }
                { 'Master': `${master.branchName} [${master.upstreamBranchName}] +${master.commitsAhead} -${master.commitsBehind}` },
                { 'Develop': `${develop.branchName} [${develop.upstreamBranchName}] +${develop.commitsAhead} -${develop.commitsBehind}` }
            );

            if (config.upstreams.length) {
                const featureTable = new Table({
                    head: ['Name', 'Url'],
                    // chars: { 'top': '' , 'top-mid': '' , 'top-left': '' , 'top-right': ''
                    //         , 'bottom': '' , 'bottom-mid': '' , 'bottom-left': '' , 'bottom-right': ''
                    //         , 'left': '' , 'left-mid': '' , 'mid': '' , 'mid-mid': ''
                    //         , 'right': '' , 'right-mid': '' , 'middle': ' ' }
                });
                featureTable.push(...config.upstreams.map(i => [ i.name, i.url ]));

                table.push({ 'Upstreams': featureTable.toString() });
            }
            // else {
            //     table.push({ 'Upstreams': 'None' });
            // }

            if (config.features.length) {
                const featureTable = new Table({
                    head: ['Name', 'Branch Name', 'Source SHA']
                });
                featureTable.push(...config.features.map(i => [ i.name, i.branchName, i.sourceSha ]));

                table.push({ 'Features': featureTable.toString() });
            }
            // else {
            //     table.push({ 'Features': 'None' });
            // }

            if (config.releases.length) {
                const releaseTable = new Table({
                    head: ['Name', 'Branch Name', 'Source SHA', 'Intermediate']
                });
                releaseTable.push(...config.releases.map(i => [ i.name, i.branchName, i.sourceSha, i.intermediate ]));

                table.push({ 'Releases': releaseTable.toString() });
            }
            // else {
            //     table.push({ 'Releases': 'None' });
            // }

            if (config.hotfixes.length) {
                const hotfixTable = new Table({
                    head: ['Name', 'Branch Name', 'Source SHA', 'Intermediate']
                });
                hotfixTable.push(...config.hotfixes.map(i => [ i.name, i.branchName, i.sourceSha, i.intermediate ]));

                table.push({ 'Hotfixes': hotfixTable.toString() });
            }
            // else {
            //     table.push({ 'Hotfixes': 'None' });
            // }

            if (config.supports.length) {
                // const supportTable = new Table({
                //     // head: ['Name', 'Master Branch Name', 'Develop Branch Name', 'Source SHA']
                // });
                // supportTable.push(...config.supports.map(i => [ i.name, i.masterBranchName, i.developBranchName, i.sourceSha ]));

                const tmp = config.supports.map(support => {
                    const supportTable = new Table();
                    supportTable.push(
                        { 'Name': support.name },
                        { 'Master Branch': support.masterBranchName },
                        { 'Develop Branch': support.developBranchName },
                        { 'Source SHA': support.sourceSha }
                    );

                    if (support.features.length) {
                        const featureTable = new Table({
                            head: ['Name', 'Branch Name', 'Source SHA']
                        });
                        featureTable.push(...support.features.map(i => [ i.name, i.branchName, i.sourceSha ]));
        
                        supportTable.push({ 'Features': featureTable.toString() });
                    }
        
                    if (support.releases.length) {
                        const releaseTable = new Table({
                            head: ['Name', 'Branch Name', 'Source SHA', 'Intermediate']
                        });
                        releaseTable.push(...support.releases.map(i => [ i.name, i.branchName, i.sourceSha, i.intermediate ]));
        
                        supportTable.push({ 'Releases': releaseTable.toString() });
                    }
        
                    if (support.hotfixes.length) {
                        const hotfixTable = new Table({
                            head: ['Name', 'Branch Name', 'Source SHA', 'Intermediate']
                        });
                        hotfixTable.push(...support.hotfixes.map(i => [ i.name, i.branchName, i.sourceSha, i.intermediate ]));
        
                        supportTable.push({ 'Hotfixes': hotfixTable.toString() });
                    }

                    return supportTable.toString();
                }).join('\n');

                table.push({ 'Supports': tmp });
            }
            // else {
            //     table.push({ 'Supports': 'None' });
            // }

            this.context.stdout.write(table.toString() + '\n\n');
        }
    }
}

// export class CreateCommand extends BaseCommand {
//     static paths = [['create', 'feature']];

//     include = Option.Array('--include');
//     exclude = Option.Array('--exclude');

//     featureName = Option.String('--name', { required: true });
//     branchName = Option.String('--branch');
//     from = Option.String('--from', 'branch://develop');
//     checkout = Option.Boolean('--checkout', false);

//     public async executeCommand() {
//         const config = await this.loadConfig();
//         const targetConfigs = await config.resolveFilteredConfigs({
//             included: this.include,
//             excluded: this.exclude
//         });

//         const configs = await Prompts({
//             type: 'multiselect',
//             name: 'value',
//             message: 'Select Modules',
//             choices: targetConfigs.map(c => ({ title: c.pathspec, value: c.identifier, selected: true }))
//         }).then(d => _(d.value).map(id => targetConfigs.find(c => c.identifier === id)).compact().value());

//         for (const config of configs) {
//             const fromElement = await config.parseElement(this.from);
//             const fromBranch = await (async () => {
//                 if (fromElement.type === 'branch')
//                     return fromElement.branch;
//                 else if (fromElement.type === 'repo')
//                     return fromElement.config.resolveCurrentBranch();
//                 else if (fromElement.type === 'feature')
//                     return fromElement.feature.branchName;
//                 else if (fromElement.type === 'release')
//                     return fromElement.release.branchName;
//                 else if (fromElement.type === 'hotfix')
//                     return fromElement.hotfix.branchName;
//                 else if (fromElement.type === 'support')
//                     return fromElement.support.developBranchName;
//                 else
//                     throw new Error(`Cannot derive source branch from ${this.from}`);
//             })();

//             const branchName = this.branchName ?? `${fromElement.type === 'support' ? `support/${fromElement.support.name}/` : ''}feature/${this.featureName}`;
//             const source = fromElement.type === 'support' ? fromElement.support : config;

//             if (source.features.some(f => f.name === this.featureName))
//                 continue;

//             const feature = new Feature({
//                 name: this.featureName,
//                 branchName,
//                 sourceSha: await config.resolveCommitSha(fromBranch)
//             });
//             source.features.push(feature);
//             await feature.register(config, source instanceof Support ? source : undefined);

//             await feature.init({ stdout: this.context.stdout, dryRun: this.dryRun });
//             await config.save({ stdout: this.context.stdout, dryRun: this.dryRun });

//             if (this.checkout)
//                 await config.checkoutBranch(feature.branchName, { stdout: this.context.stdout, dryRun: this.dryRun });
//         }
//     }
// }

export class ResetStateCommand extends BaseCommand {
    static paths = [['state', 'reset']];

    include = Option.Array('--include');
    exclude = Option.Array('--exclude');

    static usage = Command.Usage({
        description: 'Reset GLF local state'
    });

    public async executeCommand() {
        const config = await this.loadConfig();
        const targetConfigs = await config.resolveFilteredConfigs({
            included: this.include,
            excluded: this.exclude
        });

        for (const config of targetConfigs)
            await config.saveState({});
    }
}

export class ValidateCommand extends BaseCommand {
    static paths = [['validate']];

    include = Option.Array('--include');
    exclude = Option.Array('--exclude');

    static usage = Command.Usage({
        description: 'Validate repo checkout'
    });

    public async executeCommand() {
        const config = await this.loadConfig();
        const targetConfigs = await config.resolveFilteredConfigs({
            included: this.include,
            excluded: this.exclude
        });

        for (const config of targetConfigs)
            await config.saveState({});
    }
}

const WorkspaceSchema = Zod.object({
    folders: Zod.object({
        name: Zod.string(),
        path: Zod.string(),
        glfIdentifier: Zod.string().optional()
    }).array().optional(),
    settings: Zod.record(Zod.any()).optional()
});
export class CreateWorkspaceCommand extends BaseInteractiveCommand {
    static paths = [['vscode', 'workspace', 'create']];

    include = Option.Array('--include');
    exclude = Option.Array('--exclude');

    static usage = Command.Usage({
        description: 'Generate/inject repo checkouts into a VSCode workspace',
        category: 'VSCode'
    });

    public async executeCommand() {
        const rootConfig = await this.loadConfig();
        const allConfigs = rootConfig.flattenConfigs();
        const targetConfigs = await rootConfig.resolveFilteredConfigs({
            included: this.include,
            excluded: this.exclude
        });

        const workspaceName = await this.createOverridablePrompt('name', value => Zod.string().nonempty().parse(value), {
            type: 'text',
            message: 'Workspace Name'
        });
        const workspacePath = Path.resolve(`${workspaceName}.code-workspace`);

        const configs = await this.createOverridablePrompt('configs', value => Zod.string().array().transform(ids => _(ids).map(id => allConfigs.find(c => c.identifier === id)).compact().value()).parse(value), (initial) => ({
            type: 'multiselect',
            message: 'Select Modules',
            choices: allConfigs.map(c => ({ title: c.pathspec, value: c.identifier, selected: initial?.some(tc => tc === c.identifier) }))
        }), {
            defaultValue: targetConfigs.map(c => c.identifier)
        });

        const workspace = WorkspaceSchema.parse(await FS.pathExists(workspacePath) ? await FS.readJson(workspacePath) : {});
        workspace.folders = workspace.folders ?? [];

        for await (const groupedConfigs of iterateTopologicallyNonMapped(configs, (item, parent) => item.parentConfig === parent)) {

            for (const config of groupedConfigs) {
                const tmp = (config.pathspec === 'root' ? 'Workspace' : config.pathspec.replace('root/', '').replace(/\//g, ' / ')).split('.');
                const name = _(tmp)
                    .map(f => f.split('-').map(ff => _.capitalize(ff)).join(''))
                    .value().join('.');
    
                // const name = _.startCase(config.pathspec === 'root' ? 'Workspace' : config.pathspec.replace('root/', '').replace(/\//g, ' / '));
                const path = './' + Path.relative(Path.dirname(workspacePath), config.path).replace(/\\/g, '/');
    
                const existingFolder = workspace.folders.find(f => f.glfIdentifier === config.identifier);
                if (existingFolder) {
                    existingFolder.name = name;
                    existingFolder.path = path;
                }
                else {
                    workspace.folders.push({
                        name,
                        path,
                        glfIdentifier: config.identifier
                    });
                }
            }
        }

        // for (const config of configs) {
        //     const tmp = (config.pathspec === 'root' ? 'Workspace' : config.pathspec.replace('root/', '').replace(/\//g, ' / ')).split('.');
        //     const name = _(tmp)
        //         .map(f => f.split('-').map(ff => _.capitalize(ff)).join(''))
        //         .value().join('.');

        //     // const name = _.startCase(config.pathspec === 'root' ? 'Workspace' : config.pathspec.replace('root/', '').replace(/\//g, ' / '));
        //     const path = './' + Path.relative(Path.dirname(workspacePath), config.path).replace(/\\/g, '/');

        //     const existingFolder = workspace.folders.find(f => f.glfIdentifier === config.identifier);
        //     if (existingFolder) {
        //         existingFolder.name = name;
        //         existingFolder.path = path;
        //     }
        //     else {
        //         workspace.folders.push({
        //             name,
        //             path,
        //             glfIdentifier: config.identifier
        //         });
        //     }
        // }

        await FS.writeJson(workspacePath, workspace, {
            spaces: 2
        });
    }
}
export class OpenWorkspaceCommand extends BaseInteractiveCommand {
    static paths = [['vscode', 'workspace', 'open']];

    include = Option.Array('--include');
    exclude = Option.Array('--exclude');

    static usage = Command.Usage({
        description: 'Create an on-demand VSCode workspace for repo checkouts',
        category: 'VSCode'
    });

    public async executeCommand() {
        const rootConfig = await this.loadConfig();
        const allConfigs = rootConfig.flattenConfigs();
        const targetConfigs = await rootConfig.resolveFilteredConfigs({
            included: this.include,
            excluded: this.exclude
        });

        const configs = await this.createOverridablePrompt('configs', value => Zod.string().array().transform(ids => _(ids).map(id => allConfigs.find(c => c.identifier === id)).compact().value()).parse(value), (initial) => ({
            type: 'multiselect',
            message: 'Select Modules',
            choices: allConfigs.map(c => ({ title: c.pathspec, value: c.identifier, selected: initial?.some(tc => tc === c.identifier) }))
        }), {
            defaultValue: targetConfigs.map(c => c.identifier)
        });

        await executeVscode([ '--wait', '--new-window', ...configs.map(c => c.path) ], { vscodeExec: rootConfig.settings.vscodeExec, cwd: rootConfig.path, stdout: this.context.stdout, dryRun: this.dryRun });
    }
}

// export class GenerateSolutionCommand extends BaseInteractiveCommand {
//     static paths = [['vs', 'create', 'solution']];

//     include = Option.Array('--include');
//     exclude = Option.Array('--exclude');

//     static usage = Command.Usage({
//         description: 'Create a new solution from repo checkouts',
//         category: "Visual Studio"
//     });

//     public async executeCommand() {
//         const rootConfig = await this.loadConfig();
//         const allConfigs = rootConfig.flattenConfigs();
//         const targetConfigs = await rootConfig.resolveFilteredConfigs({
//             included: this.include,
//             excluded: this.exclude
//         });

//         const solutionName = await this.createOverridablePrompt('name', value => Zod.string().nonempty().parse(value), {
//             type: 'text',
//             message: 'Solution Name'
//         });
//         const solutionPath = Path.resolve(rootConfig.path, `${solutionName}.sln`);

//         const configs = await this.createOverridablePrompt('configs', value => Zod.string().array().transform(ids => _(ids).map(id => allConfigs.find(c => c.identifier === id)).compact().value()).parse(value), (initial) => ({
//             type: 'multiselect',
//             message: 'Select Modules',
//             choices: allConfigs.map(c => ({ title: c.pathspec, value: c.identifier, selected: initial?.some(tc => tc === c.identifier) }))
//         }), {
//             defaultValue: targetConfigs.map(c => c.identifier)
//         });

//         if (await FS.pathExists(solutionPath)) {
//             this.logWarning(`Solution already exists at ${solutionPath}, cannot override`);
//             return;
//         }

//         await rootConfig.exec(`dotnet new sln -n ${solutionName}`, { stdout: this.context.stdout, dryRun: this.dryRun });

//         for (const config of configs) {
//             const relativePath = Path.relative(rootConfig.path, config.path);

//             this.logVerbose(`Adding ${config.pathspec} to solution`);
//             await rootConfig.exec(`dotnet sln ${solutionName}.sln add --in-root ${relativePath}`, { stdout: this.context.stdout, dryRun: this.dryRun });
//         }
//     }
// }

export class ViewVersionCommand extends BaseInteractiveCommand {
    static paths = [['version', 'view']];

    releaseName = Option.String('--name');

    include = Option.Array('--include');
    exclude = Option.Array('--exclude');

    static usage = Command.Usage({
        description: 'View version',
        category: 'Version'
    });

    public async executeCommand() {
        const rootConfig = await this.loadConfig();
        const targetConfigs = await rootConfig.resolveFilteredConfigs({
            included: this.include,
            excluded: this.exclude
        });

        await viewVersion(rootConfig, {
            configs: async ({ configs }) => this.createOverridablePrompt('configs', value => Zod.string().array().transform(ids => _(ids).map(id => configs.map(c => c.config).find(c => c.identifier === id)).compact().value()).parse(value), (initial) => ({
                type: 'multiselect',
                message: 'Select Modules',
                choices: configs.map(c => ({ title: `${c.config.pathspec} [${c.version}]`, value: c.config.identifier, selected: initial?.some(tc => tc === c.config.identifier) }))
            }), {
                answerType: OverridablePromptAnswerTypes.StringArray,
                defaultValue: targetConfigs.map(c => c.identifier)
            }),
            stdout: this.context.stdout,
            dryRun: this.dryRun
        });
    }
}
export class StampVersionCommand extends BaseInteractiveCommand {
    static paths = [['version', 'stamp']];

    include = Option.Array('--include');
    exclude = Option.Array('--exclude');

    static usage = Command.Usage({
        description: 'Stamp version',
        category: 'Version'
    });

    public async executeCommand() {
        const rootConfig = await this.loadConfig();
        const targetConfigs = await rootConfig.resolveFilteredConfigs({
            included: this.include,
            excluded: this.exclude
        });

        await stampVersion(rootConfig, {
            configs: async ({ configs }) => this.createOverridablePrompt('configs', value => Zod.string().array().transform(ids => _(ids).map(id => configs.map(c => c.config).find(c => c.identifier === id)).compact().value()).parse(value), (initial) => ({
                type: 'multiselect',
                message: 'Select Modules',
                choices: configs.map(c => ({ title: `${c.config.pathspec} [${c.version}]`, value: c.config.identifier, selected: initial?.some(tc => tc === c.config.identifier) }))
            }), {
                answerType: OverridablePromptAnswerTypes.StringArray,
                defaultValue: targetConfigs.map(c => c.identifier)
            }),
            stdout: this.context.stdout,
            dryRun: this.dryRun
        });
    }
}
export class SetVersionCommand extends BaseInteractiveCommand {
    static paths = [['version', 'set']];

    include = Option.Array('--include');
    exclude = Option.Array('--exclude');

    static usage = Command.Usage({
        description: 'Set version',
        category: 'Version'
    });

    public async executeCommand() {
        const rootConfig = await this.loadConfig();
        const targetConfigs = await rootConfig.resolveFilteredConfigs({
            included: this.include,
            excluded: this.exclude
        });

        await setVersion(rootConfig, {
            configs: async ({ configs }) => this.createOverridablePrompt('configs', value => Zod.string().array().transform(ids => _(ids).map(id => configs.map(c => c.config).find(c => c.identifier === id)).compact().value()).parse(value), (initial) => ({
                type: 'multiselect',
                message: 'Select Modules',
                choices: configs.map(c => ({ title: `${c.config.pathspec} [${c.version}]`, value: c.config.identifier, selected: initial?.some(tc => tc === c.config.identifier) }))
            }), {
                answerType: OverridablePromptAnswerTypes.StringArray,
                defaultValue: targetConfigs.map(c => c.identifier)
            }),
            version: ({ config }) => this.createOverridablePrompt('version', value => Zod.string().nullable().transform(v => v || null).parse(value), initial => ({
                type: 'text',
                message: `[${Chalk.magenta(config.pathspec)}] Version`,
                initial
            })),
            stdout: this.context.stdout,
            dryRun: this.dryRun
        });
    }
}
export class IncrementVersionCommand extends BaseInteractiveCommand {
    static paths = [['version', 'increment'], ['increment', 'version']];

    include = Option.Array('--include');
    exclude = Option.Array('--exclude');

    type = Option.String('--type', 'prerelease', {
        description: 'Type type of version increment to use'
    });
    prereleaseIdentifier = Option.String('--prerelease-identifier', 'alpha', {
        description: 'Identifier to use for prerelease versions'
    });
    cascade = Option.Boolean('--cascade', false, {
        description: 'Cascade version change across dependents'
    });

    static usage = Command.Usage({
        description: 'Increment version',
        category: 'Version'
    });

    public async executeCommand() {
        const rootConfig = await this.loadConfig();
        const targetConfigs = await rootConfig.resolveFilteredConfigs({
            included: this.include,
            excluded: this.exclude
        });

        await incrementVersion(rootConfig, {
            configs: async ({ configs }) => this.createOverridablePrompt('configs', value => Zod.string().array().transform(ids => _(ids).map(id => configs.map(c => c.config).find(c => c.identifier === id)).compact().value()).parse(value), (initial) => ({
                type: 'multiselect',
                message: 'Select Modules',
                choices: configs.map(c => ({ title: `${c.config.pathspec} [${c.version}]`, value: c.config.identifier, selected: initial?.some(tc => tc === c.config.identifier) }))
            }), {
                answerType: OverridablePromptAnswerTypes.StringArray,
                defaultValue: targetConfigs.map(c => c.identifier)
            }),
            cascadeConfigs: async ({ configs }) => this.createOverridablePrompt('configs', value => Zod.string().array().transform(ids => _(ids).map(id => configs.find(c => c.identifier === id)).compact().value()).parse(value), (initial) => ({
                type: 'multiselect',
                message: 'Select Cascaded Modules',
                choices: configs.map(c => ({ title: `${c.pathspec} [${c.resolveVersion()}]`, value: c.identifier, selected: initial?.some(tc => tc === c.identifier) }))
            }), {
                answerType: OverridablePromptAnswerTypes.StringArray,
                defaultValue: configs.map(c => c.identifier)
            }),
            type: ({ config }) => this.createOverridablePrompt(`${config.pathspec}/type`, value => Zod.union([ Zod.literal('major'), Zod.literal('minor'), Zod.literal('patch'), Zod.literal('prerelease'), Zod.literal('premajor'), Zod.literal('preminor'), Zod.literal('prepatch') ]).parse(value), initial => ({
                type: 'select',
                message: `[${Chalk.magenta(config.pathspec)}] Release Type`,
                choices: [
                    { title: 'Prerelease', value: 'prerelease' },
                    { title: 'Major', value: 'major' },
                    { title: 'Minor', value: 'minor' },
                    { title: 'Patch', value: 'patch' },
                    { title: 'Premajor', value: 'premajor' },
                    { title: 'Preminor', value: 'preminor' },
                    { title: 'Prepatch', value: 'prepatch' }
                ],
                initial: initial ? [ 'prerelease', 'major', 'minor', 'patch', 'premajor', 'preminor', 'prepatch' ].indexOf(initial) : 0
            }), {
                defaultValue: this.type,
                interactivity: 2
            }),
            prereleaseIdentifier: ({ config }) => this.createOverridablePrompt(`${config.pathspec}/prereleaseIdentifier`, value => Zod.string().parse(value), initial => ({
                type: 'text',
                message: `[${Chalk.magenta(config.pathspec)}] Prerelease Identifier`,
                initial
            }), {
                defaultValue: this.prereleaseIdentifier,
                interactivity: 3
            }),
            cascade: () => this.createOverridablePrompt('cascade', value => Zod.boolean().parse(value), initial => ({
                type: 'confirm',
                message: `Cascade version changes?`,
                initial
            }), {
                defaultValue: this.cascade,
            }),
            stdout: this.context.stdout,
            dryRun: this.dryRun
        });
    }
}
export class ListDependentsCommand extends BaseInteractiveCommand {
    static paths = [['dependents', 'list'], ['list', 'dependents']];

    include = Option.Array('--include');
    exclude = Option.Array('--exclude');

    static usage = Command.Usage({
        description: 'List dependents',
        category: 'Dependency'
    });

    public async executeCommand() {
        const rootConfig = await this.loadConfig();
        const targetConfigs = await rootConfig.resolveFilteredConfigs({
            included: this.include,
            excluded: this.exclude
        });

        await listDependants(rootConfig, {
            configs: async ({ configs }) => this.createOverridablePrompt('configs', value => Zod.string().array().transform(ids => _(ids).map(id => configs.find(c => c.identifier === id)).compact().value()).parse(value), (initial) => ({
                type: 'multiselect',
                message: 'Select Modules',
                choices: configs.map(c => ({ title: `${c.pathspec} [${c.resolveVersion()}]`, value: c.identifier, selected: initial?.some(tc => tc === c.identifier) }))
            }), {
                answerType: OverridablePromptAnswerTypes.StringArray,
                defaultValue: targetConfigs.map(c => c.identifier)
            }),
            stdout: this.context.stdout,
            dryRun: this.dryRun
        });
    }
}
export class SetDependenciesCommand extends BaseInteractiveCommand {
    static paths = [['dependencies', 'set'], ['set', 'dependencies']];

    include = Option.Array('--include');
    exclude = Option.Array('--exclude');

    static usage = Command.Usage({
        description: 'Set dependencies',
        category: 'Dependency'
    });

    public async executeCommand() {
        const rootConfig = await this.loadConfig();
        const targetConfigs = await rootConfig.resolveFilteredConfigs({
            included: this.include,
            excluded: this.exclude
        });

        await setDependencies(rootConfig, {
            configs: async ({ configs }) => this.createOverridablePrompt('configs', value => Zod.string().array().transform(ids => _(ids).map(id => configs.find(c => c.identifier === id)).compact().value()).parse(value), (initial) => ({
                type: 'multiselect',
                message: 'Select Modules',
                choices: configs.map(c => ({ title: `${c.pathspec} [${c.resolveVersion()}]`, value: c.identifier, selected: initial?.some(tc => tc === c.identifier) }))
            }), {
                answerType: OverridablePromptAnswerTypes.StringArray,
                defaultValue: targetConfigs.map(c => c.identifier)
            }),
            dependencies: async ({ config, configs }) => this.createOverridablePrompt('dependencies', value => Zod.string().array().transform(ids => _(ids).map(id => configs.find(c => c.identifier === id)).compact().value()).parse(value), (initial) => ({
                type: 'multiselect',
                message: `[${Chalk.magenta(config.pathspec)}] Dependencies`,
                choices: configs.map(c => ({ title: `${c.pathspec} [${c.resolveVersion()}]`, value: c.identifier, selected: initial?.some(tc => tc === c.identifier) }))
            }), {
                answerType: OverridablePromptAnswerTypes.StringArray,
                defaultValue: config.dependencies
            }),
            stdout: this.context.stdout,
            dryRun: this.dryRun
        });
    }
}
