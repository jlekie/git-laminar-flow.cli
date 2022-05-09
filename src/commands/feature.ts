import { Command, Option } from 'clipanion';
import * as Minimatch from 'minimatch';
import * as Bluebird from 'bluebird';
import * as _ from 'lodash';
import * as Zod from 'zod';

import * as Chalk from 'chalk';

import * as Prompts from 'prompts';

import { BaseCommand, BaseInteractiveCommand, AnswersSchema } from './common';

import { loadV2Config, Config, Feature, Support } from 'lib/config';
import { closeFeature, createFeature, deleteFeature, mergeFeature, syncFeature } from 'lib/actions';

export class CreateInteractiveCommand extends BaseInteractiveCommand {
    static paths = [['feature', 'create'], ['create', 'feature']];

    include = Option.Array('--include');
    exclude = Option.Array('--exclude');

    static usage = Command.Usage({
        description: 'Create feature',
        category: 'Feature'
    });

    public async executeCommand() {
        const rootConfig = await this.loadConfig();
        const targetConfigs = await rootConfig.resolveFilteredConfigs({
            included: this.include,
            excluded: this.exclude
        });

        await createFeature(rootConfig, {
            name: () => this.createOverridablePrompt('featureName', Zod.string().nonempty(), {
                type: 'text',
                message: 'Feature Name'
            }),
            from: ({ config, activeSupport }) => this.createOverridablePrompt('from', Zod.string().url(), (initial) => ({
                type: 'text',
                message: `[${Chalk.magenta(config.pathspec)}] From`,
                initial
            }), {
                pathspecPrefix: config.pathspec,
                defaultValue: activeSupport ? `support://${activeSupport}/develop` : 'branch://develop'
            }),
            branchName: ({ config, fromElement, featureName }) => this.createOverridablePrompt('branchName', Zod.string(), (initial) => ({
                type: 'text',
                message: `[${Chalk.magenta(config.pathspec)}] Branch Name`,
                initial
            }), {
                pathspecPrefix: config.pathspec,
                defaultValue: `${fromElement.type === 'support' ? `support/${fromElement.support.name}/` : ''}feature/${featureName}`
            }),
            configs: ({ configs }) => this.createOverridablePrompt('configs', Zod.string().array().transform(ids => _(ids).map(id => configs.find(c => c.identifier === id)).compact().value()), {
                type: 'multiselect',
                message: 'Select Modules',
                choices: configs.map(c => ({ title: c.pathspec, value: c.identifier, selected: targetConfigs.some(tc => tc.identifier === c.identifier) }))
            }),
            checkout: ({ config }) => this.createOverridablePrompt('checkout', Zod.boolean(), {
                type: 'confirm',
                message: `[${Chalk.magenta(config.pathspec)}] Checkout`,
            }, {
                pathspecPrefix: config.pathspec,
                defaultValue: false
            }),
            upstream: ({ config }) => this.createOverridablePrompt('upstream', Zod.string().nullable().transform(v => v ?? undefined), (initial) => ({
                type: 'select',
                message: `[${Chalk.magenta(config.pathspec)}] Upstream`,
                choices: [
                    { title: 'N/A', value: null },
                    ...config.upstreams.map(u => ({ title: u.name, value: u.name }))
                ],
                initial
            }), {
                pathspecPrefix: config.pathspec,
                defaultValue: config.upstreams[0]?.name ?? null
            }),
            stdout: this.context.stdout,
            dryRun: this.dryRun
        });
    }
}

export class CreateCommand extends BaseCommand {
    static paths = [['feature', 'create'], ['create', 'feature']];

    featureName = Option.String('--name', { required: true });
    branchName = Option.String('--branch-name');
    from = Option.String('--from');

    include = Option.Array('--include');
    exclude = Option.Array('--exclude');

    checkout = Option.Boolean('--checkout', false);

    static usage = Command.Usage({
        description: 'Create feature',
        category: 'Feature'
    });

    public async executeCommand() {
        const rootConfig = await this.loadConfig();
        const targetConfigs = await rootConfig.resolveFilteredConfigs({
            included: this.include,
            excluded: this.exclude
        });

        await createFeature(rootConfig, {
            name: async () => this.featureName,
            from: ({ activeSupport }) => this.from ?? (activeSupport ? `support://${activeSupport}/develop` : 'branch://develop'),
            branchName: ({ fromElement, featureName }) => this.branchName ?? `${fromElement.type === 'support' ? `support/${fromElement.support.name}/` : ''}feature/${featureName}`,
            configs: () => targetConfigs,
            checkout: () => this.checkout,
            stdout: this.context.stdout,
            dryRun: this.dryRun
        });
    }
}

export class DeleteInteractiveCommand extends BaseInteractiveCommand {
    static paths = [['feature', 'delete'], ['delete', 'feature']];

    static usage = Command.Usage({
        description: 'Delete feature',
        category: 'Feature'
    });

    public async executeCommand() {
        const rootConfig = await this.loadConfig();

        await deleteFeature(rootConfig, {
            name: ({ features }) => this.createOverridablePrompt('featureName', Zod.string().nonempty(), {
                type: 'select',
                message: 'Feature Name',
                choices: features.map(r => ({ title: r, value: r }))
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
    static paths = [['feature', 'checkout']];

    featureName = Option.String('--feature', { required: true });

    static usage = Command.Usage({
        description: 'Checkout feature',
        category: 'Feature'
    });

    public async executeCommand() {
        const config = await this.loadConfig();
        const featureFqn = config.resolveFeatureFqn(this.featureName);

        const features = config.findFeatures(featureFqn);
        await Bluebird.map(features, feature => feature.checkoutBranch({ stdout: this.context.stdout, dryRun: this.dryRun }), {
            concurrency: 1
        });
    }
}

export class CommitCommand extends BaseCommand {
    static paths = [['feature', 'commit']];

    featureName = Option.String('--feature', { required: true });
    message = Option.String('--message', { required: false })

    static usage = Command.Usage({
        description: 'Commit feature',
        category: 'Feature'
    });

    public async executeCommand() {
        const config = await this.loadConfig();
        const featureFqn = config.resolveFeatureFqn(this.featureName);

        const features = config.findFeatures(featureFqn);
        for (const feature of features) {
            const message = this.message ?? `feature ${feature.name} checkpoint`;
            await feature.parentConfig.commit(message, { stdout: this.context.stdout, dryRun: this.dryRun });
        }
    }
}

export class SyncInteractiveCommand extends BaseInteractiveCommand {
    static paths = [['feature', 'sync']];

    include = Option.Array('--include');
    exclude = Option.Array('--exclude');

    static usage = Command.Usage({
        description: 'Sync feature from branch',
        category: 'Feature'
    });

    public async executeCommand() {
        const rootConfig = await this.loadConfig();

        await syncFeature(rootConfig, {
            name: ({ features }) => this.createOverridablePrompt('featureName', Zod.string().nonempty(), {
                type: 'select',
                message: 'Feature Name',
                choices: features.map(r => ({ title: r, value: r }))
            }),
            configs: ({ configs }) => this.createOverridablePrompt('configs', Zod.string().array().transform(ids => _(ids).map(id => configs.find(c => c.identifier === id)).compact().value()), {
                type: 'multiselect',
                message: 'Select Modules',
                choices: configs.map(c => ({ title: c.pathspec, value: c.identifier, selected: true }))
            }),
            push: ({ config }) => this.createOverridablePrompt('push', Zod.boolean(), {
                type: 'confirm',
                message: `[${Chalk.magenta(config.pathspec)}] Push to origin`,
                initial: false
            }),
            stdout: this.context.stdout,
            dryRun: this.dryRun
        });
    }
}

export class MergeInteractiveCommand extends BaseInteractiveCommand {
    static paths = [['feature', 'merge']];

    include = Option.Array('--include');
    exclude = Option.Array('--exclude');

    static usage = Command.Usage({
        description: 'Merge feature from branch',
        category: 'Feature'
    });

    public async executeCommand() {
        const rootConfig = await this.loadConfig();
        // const targetConfigs = await rootConfig.resolveFilteredConfigs({
        //     included: this.include,
        //     excluded: this.exclude
        // });

        await mergeFeature(rootConfig, {
            name: ({ features }) => this.createOverridablePrompt('featureName', Zod.string().nonempty(), {
                type: 'select',
                message: 'Feature Name',
                choices: features.map(r => ({ title: r, value: r }))
            }),
            source: ({ config }) => this.createOverridablePrompt('source', Zod.string().nonempty(), {
                type: 'text',
                message: `[${Chalk.magenta(config.pathspec)}] Merge source`,
                initial: 'branch://develop'
            }),
            configs: ({ configs }) => this.createOverridablePrompt('configs', Zod.string().array().transform(ids => _(ids).map(id => configs.find(c => c.identifier === id)).compact().value()), {
                type: 'multiselect',
                message: 'Select Modules',
                choices: configs.map(c => ({ title: c.pathspec, value: c.identifier, selected: true }))
            }),
            stdout: this.context.stdout,
            dryRun: this.dryRun
        });
    }
}

export class CloseInteractiveCommand extends BaseInteractiveCommand {
    static paths = [['feature', 'close'], ['close', 'feature']];

    include = Option.Array('--include');
    exclude = Option.Array('--exclude');

    abort = Option.Boolean('--abort,--finish', false);

    static usage = Command.Usage({
        description: 'Close feature',
        category: 'Feature'
    });

    public async executeCommand() {
        const rootConfig = await this.loadConfig();

        await closeFeature(rootConfig, {
            name: () => this.createOverridablePrompt('featureName', Zod.string().nonempty(), {
                type: 'text',
                message: 'Feature Name'
            }),
            configs: ({ configs }) => this.createOverridablePrompt('configs', Zod.string().array().transform(ids => _(ids).map(id => configs.find(c => c.identifier === id)).compact().value()), {
                type: 'multiselect',
                message: 'Select Modules',
                choices: configs.map(c => ({ title: c.pathspec, value: c.identifier, selected: true }))
            }),
            confirm: ({ config, message }) => this.prompt('configs', Zod.boolean(), {
                type: 'confirm',
                message: `[${Chalk.magenta(config.pathspec)}] ${message}`
            }),
            abort: () => this.abort,
            deleteLocalBranch: ({ config }) => this.createOverridablePrompt('deleteLocalBranch', Zod.boolean(), (initial) => ({
                type: 'confirm',
                message: `[${Chalk.magenta(config.pathspec)}] Delete local branch?`,
                initial
            }), {
                pathspecPrefix: config.pathspec,
                defaultValue: true
            }),
            deleteRemoteBranch: ({ config }) => this.createOverridablePrompt('deleteRemoteBranch', Zod.boolean(), (initial) => ({
                type: 'confirm',
                message: `[${Chalk.magenta(config.pathspec)}] Delete remote branch?`,
                initial
            }), {
                pathspecPrefix: config.pathspec,
                defaultValue: true
            }),
            stdout: this.context.stdout,
            dryRun: this.dryRun
        });
    }
}
