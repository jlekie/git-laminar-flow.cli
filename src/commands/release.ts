import { Command, Option } from 'clipanion';
import * as Minimatch from 'minimatch';
import * as Bluebird from 'bluebird';
import * as _ from 'lodash';
import * as Zod from 'zod';

import * as Chalk from 'chalk';
import * as Prompts from 'prompts';

import { BaseCommand, BaseInteractiveCommand, OverridablePromptAnswerTypes } from './common';

import { loadV2Config, Config, Release, Support } from '../lib/config';
import { closeRelease, createRelease, deleteRelease } from '../lib/actions';

export class CreateInteractiveCommand extends BaseInteractiveCommand {
    static paths = [['release', 'create'], ['create', 'release']];

    releaseName = Option.String('--name');
    branchName = Option.String('--branch-name');
    from = Option.String('--from');

    include = Option.Array('--include');
    exclude = Option.Array('--exclude');

    static usage = Command.Usage({
        description: 'Create release',
        category: 'Release'
    });

    public async executeCommand() {
        const rootConfig = await this.loadConfig();
        const targetConfigs = await rootConfig.resolveFilteredConfigs({
            included: this.include,
            excluded: this.exclude
        });

        await createRelease(rootConfig, {
            name: () => this.createOverridablePrompt('releaseName', value => Zod.string().nonempty().parse(value), {
                type: 'text',
                message: 'Release Name'
            }),
            from: ({ config, activeSupport }) => this.createOverridablePrompt('from', value => Zod.string().url().parse(value), (initial) => ({
                type: 'text',
                message: `[${Chalk.magenta(config.pathspec)}] From`,
                initial
            }), {
                pathspecPrefix: config.pathspec,
                defaultValue: activeSupport ? `support://${activeSupport}/develop` : 'branch://develop'
            }),
            branchName: ({ config, fromElement, releaseName }) => this.createOverridablePrompt('branchName', value => Zod.string().parse(value), (initial) => ({
                type: 'text',
                message: `[${Chalk.magenta(config.pathspec)}] Branch Name`,
                initial
            }), {
                pathspecPrefix: config.pathspec,
                defaultValue: `${fromElement.type === 'support' ? `support/${fromElement.support.name}/` : ''}release/${releaseName}`
            }),
            configs: async ({ configs }) => this.createOverridablePrompt('configs', value => Zod.string().array().transform(ids => _(ids).map(id => configs.find(c => c.identifier === id)).compact().value()).parse(value), (initial) => ({
                type: 'multiselect',
                message: 'Select Modules',
                choices: configs.map(c => ({ title: c.pathspec, value: c.identifier, selected: initial?.some(tc => tc === c.identifier) }))
            }), {
                defaultValue: targetConfigs.map(c => c.identifier)
            }),
            checkout: ({ config }) => this.createOverridablePrompt('checkout', value => Zod.boolean().parse(value), (initial) => ({
                type: 'confirm',
                message: `[${Chalk.magenta(config.pathspec)}] Checkout`,
                initial
            }), {
                pathspecPrefix: config.pathspec,
                defaultValue: true
            }),
            upstream: ({ config }) => this.createOverridablePrompt('upstream', value => Zod.string().nullable().transform(v => v ?? undefined).parse(value), (initial) => ({
                type: 'select',
                message: `[${Chalk.magenta(config.pathspec)}] Upstream`,
                choices: [
                    { title: 'N/A', value: null },
                    ...config.upstreams.map(u => ({ title: u.name, value: u.name }))
                ],
                initial: config.upstreams.findIndex(u => u.name === initial) + 1
            }), {
                pathspecPrefix: config.pathspec,
                defaultValue: config.upstreams[0]?.name ?? null
            }),
            intermediate: ({ config }) => this.createOverridablePrompt('intermediate', value => Zod.boolean().parse(value), (initial) => ({
                type: 'confirm',
                message: `[${Chalk.magenta(config.pathspec)}] Intermediate Release`,
                initial
            }), {
                pathspecPrefix: config.pathspec,
                defaultValue: false
            }),
            stdout: this.context.stdout,
            dryRun: this.dryRun
        });
    }
}
export class CreateCommand extends BaseCommand {
    static paths = [['release', 'create'], ['create', 'release']];

    releaseName = Option.String('--name', { required: true });
    branchName = Option.String('--branch-name');
    from = Option.String('--from');

    include = Option.Array('--include');
    exclude = Option.Array('--exclude');

    checkout = Option.Boolean('--checkout', false);

    static usage = Command.Usage({
        description: 'Create release',
        category: 'Release'
    });

    public async executeCommand() {
        const rootConfig = await this.loadConfig();
        const targetConfigs = await rootConfig.resolveFilteredConfigs({
            included: this.include,
            excluded: this.exclude
        });

        await createRelease(rootConfig, {
            name: async () => this.releaseName,
            from: ({ activeSupport }) => this.from ?? (activeSupport ? `support://${activeSupport}/develop` : 'branch://develop'),
            branchName: ({ fromElement, releaseName }) => this.branchName ?? `${fromElement.type === 'support' ? `support/${fromElement.support.name}/` : ''}release/${releaseName}`,
            configs: () => targetConfigs,
            checkout: () => this.checkout,
            stdout: this.context.stdout,
            dryRun: this.dryRun
        });
    }
}

export class DeleteInteractiveCommand extends BaseInteractiveCommand {
    static paths = [['release', 'delete'], ['delete', 'release']];

    static usage = Command.Usage({
        description: 'Delete release',
        category: 'Release'
    });

    public async executeCommand() {
        const rootConfig = await this.loadConfig();

        await deleteRelease(rootConfig, {
            name: ({ releases }) => this.createOverridablePrompt('releaseName', value => Zod.string().nonempty().parse(value), {
                type: 'select',
                message: 'Release Name',
                choices: releases.map(r => ({ title: r, value: r }))
            }),
            configs: ({ configs }) => this.prompt('configs', Zod.string().array().transform(ids => _(ids).map(id => configs.find(c => c.identifier === id)).compact().value()), {
                type: 'multiselect',
                message: 'Select Modules',
                choices: configs.map(c => ({ title: c.pathspec, value: c.identifier, selected: true }))
            }),
            stdout: this.context.stdout,
            dryRun: this.dryRun
        });
    }
}

export class CheckoutCommand extends BaseCommand {
    static paths = [['release', 'checkout']];

    releaseName = Option.String('--release', { required: true });

    static usage = Command.Usage({
        description: 'Checkout release',
        category: 'Release'
    });

    public async executeCommand() {
        const config = await this.loadConfig();
        const featureFqn = config.resolveFeatureFqn(this.releaseName);

        const releases = config.findReleases(featureFqn);
        await Bluebird.map(releases, release => release.parentConfig.checkoutBranch(release.branchName, { stdout: this.context.stdout, dryRun: this.dryRun }), {
            concurrency: 1
        });
    }
}

export class SyncCommand extends BaseCommand {
    static paths = [['release', 'sync']];

    releaseName = Option.String('--release', { required: true });
    branchName = Option.String('--branch');

    static usage = Command.Usage({
        description: 'Sync release from branch',
        category: 'Release'
    });

    public async executeCommand() {
        const config = await this.loadConfig();
        const featureFqn = config.resolveFeatureFqn(this.releaseName);

        const releases = config.findReleases(featureFqn);
        await Bluebird.map(releases, async release => {
            const baseBranch = await release.parentConfig.resolveCurrentBranch({ stdout: this.context.stdout });

            try {
                await release.parentConfig.checkoutBranch(release.branchName, { stdout: this.context.stdout, dryRun: this.dryRun })
                await release.parentConfig.merge(this.branchName ?? release.parentConfig.resolveDevelopBranchName(), { stdout: this.context.stdout, dryRun: this.dryRun }).catch(async () => {
                    this.context.stdout.write(Chalk.yellow(`Merge failed, aborting...\n`));
                    await release.parentConfig.abortMerge({ stdout: this.context.stdout, dryRun: this.dryRun });
                });
            }
            finally {
                if (baseBranch)
                    await release.parentConfig.checkoutBranch(baseBranch, { stdout: this.context.stdout, dryRun: this.dryRun });
            }
        }, { concurrency: 1 });
    }
}

export class MergeCommand extends BaseCommand {
    static paths = [['release', 'merge']];

    releaseName = Option.String('--release', { required: true });

    static usage = Command.Usage({
        description: 'Merge feature into develop & master',
        category: 'Release'
    });

    public async executeCommand() {
        const config = await this.loadConfig();
        const featureFqn = config.resolveFeatureFqn(this.releaseName);

        const releases = config.findReleases(featureFqn);
        await Bluebird.map(releases, async release => {
            const baseBranch = await release.parentConfig.resolveCurrentBranch({ stdout: this.context.stdout });

            try {
                await release.parentConfig.checkoutBranch(release.parentConfig.resolveDevelopBranchName(), { stdout: this.context.stdout, dryRun: this.dryRun })
                await release.parentConfig.merge(release.branchName, { stdout: this.context.stdout, dryRun: this.dryRun }).catch(async () => {
                    this.context.stdout.write(Chalk.yellow(`Merge failed, aborting...\n`));
                    await release.parentConfig.abortMerge({ stdout: this.context.stdout, dryRun: this.dryRun });
                });
            }
            finally {
                if (baseBranch)
                    await release.parentConfig.checkoutBranch(baseBranch, { stdout: this.context.stdout, dryRun: this.dryRun });
            }
        }, { concurrency: 1 });
    }
}

export class CloseInteractiveCommand extends BaseInteractiveCommand {
    static paths = [['release', 'close'], ['close', 'release']];

    abort = Option.Boolean('--abort,--finish', false);

    static usage = Command.Usage({
        description: 'Close release',
        category: 'Release'
    });

    public async executeCommand() {
        const rootConfig = await this.loadConfig();

        await closeRelease(rootConfig, {
            name: ({ releases }) => this.createOverridablePrompt('releaseName', value => Zod.string().nonempty().parse(value), {
                type: 'select',
                message: 'Release Name',
                choices: releases.map(r => ({ title: r, value: r }))
            }),
            // configs: ({ configs }) => this.createOverridablePrompt('configs', value => Zod.string().array().transform(ids => _(ids).map(id => configs.find(c => c.identifier === id)).compact().value()).parse(value), {
            //     type: 'multiselect',
            //     message: 'Select Modules',
            //     choices: configs.map(c => ({ title: c.pathspec, value: c.identifier, selected: true }))
            // }),
            configs: async ({ configs }) => this.createOverridablePrompt('configs', value => Zod.string().array().transform(ids => _(ids).map(id => configs.find(c => c.identifier === id)).compact().value()).parse(value), (initial) => ({
                type: 'multiselect',
                message: 'Select Modules',
                choices: configs.map(c => ({ title: c.pathspec, value: c.identifier, selected: initial?.some(tc => tc === c.identifier) }))
            }), {
                defaultValue: configs.map(c => c.identifier)
            }),
            confirm: ({ config, message }) => this.createOverridablePrompt('confirm', value => Zod.boolean().parse(value), initial => ({
                type: 'confirm',
                message: `${config ? `[${Chalk.magenta(config.pathspec)}] ` : ''}${message}`,
                initial
            })),
            abort: () => this.abort,
            deleteLocalBranch: ({ config }) => this.createOverridablePrompt('deleteLocalBranch', value => Zod.boolean().parse(value), initial => ({
                type: 'confirm',
                message: `[${Chalk.magenta(config.pathspec)}] Delete local branch?`,
                initial
            }), {
                answerType: OverridablePromptAnswerTypes.Boolean,
                pathspecPrefix: config.pathspec,
                defaultValue: true
            }),
            deleteRemoteBranch: ({ config }) => this.createOverridablePrompt('deleteRemoteBranch', value => Zod.boolean().parse(value), initial => ({
                type: 'confirm',
                message: `[${Chalk.magenta(config.pathspec)}] Delete remote branch?`,
                initial
            }), {
                answerType: OverridablePromptAnswerTypes.Boolean,
                pathspecPrefix: config.pathspec,
                defaultValue: true
            }),
            tags: ({ config, templates }) => this.createOverridablePrompt('tags', value => Zod.string().array().transform(names => _(names).map(id => templates.find(t => t.name === id)).compact().value()).parse(value), initial => ({
                type: 'multiselect',
                message: `[${Chalk.magenta(config.pathspec)}] Select Tag Templates`,
                choices: templates.map(t => ({ title: t.name, value: t.name, selected: initial?.some(tt => tt === t.name) }))
            }), {
                answerType: OverridablePromptAnswerTypes.StringArray,
                defaultValue: []
            }),
            commitMessage: ({ config, messages }) => this.createOverridablePrompt('commitMessage', value => Zod.string().transform(name => messages.find(t => t.name === name)).parse(value), initial => ({
                type: 'select',
                message: `[${Chalk.magenta(config.pathspec)}] Select Commit Message`,
                choices: messages.map(t => ({ title: t.name, value: t.name })),
                initial: messages.findIndex(m => m.name === initial)
            }), {
                defaultValue: messages[0].name
            }),
            stagedFiles: async ({ config, statuses }) => this.createOverridablePrompt('stagedFiles', value => Zod.string().array().parse(value), (initial) => ({
                type: 'multiselect',
                message: `[${Chalk.magenta(config.pathspec)}] Files to Stage`,
                choices: statuses.map(status => ({ title: status.path, value: status.path, selected: initial?.includes(status.path) }))
            }), {
                pathspecPrefix: config.pathspec,
                defaultValue: statuses.map(s => s.path)
            }),
            stdout: this.context.stdout,
            dryRun: this.dryRun
        });
    }
}
