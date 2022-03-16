import { Command, Option } from 'clipanion';
import * as Minimatch from 'minimatch';
import * as Bluebird from 'bluebird';
import * as _ from 'lodash';
import * as Zod from 'zod';

import * as Chalk from 'chalk';

import * as Prompts from 'prompts';

import { BaseCommand } from './common';

import { loadV2Config, Config, Feature, Support } from '../lib/config';
import { createFeature } from '../lib/actions';

export class CreateInteractiveCommand extends BaseCommand {
    static paths = [['feature', 'create']];

    featureName = Option.String('--name');
    branchName = Option.String('--branch-name');
    from = Option.String('--from');

    include = Option.Array('--include');
    exclude = Option.Array('--exclude');

    checkout = Option.Boolean('--checkout');

    static usage = Command.Usage({
        description: 'Create feature',
        category: 'Feature'
    });

    public async execute() {
        Prompts.override({
            featureName: this.featureName,
            branchName: this.branchName,
            from: this.from,
            checkout: this.checkout
        });

        const rootConfig = await this.loadConfig();
        const targetConfigs = await rootConfig.resolveFilteredConfigs({
            included: this.include,
            excluded: this.exclude
        });

        await createFeature(rootConfig, {
            name: () => this.prompt('featureName', Zod.string().nonempty(), {
                type: 'text',
                message: 'Feature Name'
            }),
            from: ({ config }) => this.prompt('from', Zod.string().url(), {
                type: 'text',
                message: `[${Chalk.magenta(config.pathspec)}] From`,
                initial: 'branch://develop'
            }),
            branchName: ({ config, fromElement, featureName }) => this.prompt('branchName', Zod.string(), {
                type: 'text',
                message: `[${Chalk.magenta(config.pathspec)}] Branch Name`,
                initial: `${fromElement.type === 'support' ? `support/${fromElement.support.name}/` : ''}feature/${featureName}`
            }),
            configs: ({ configs }) => this.prompt('configs', Zod.string().array().transform(ids => _(ids).map(id => configs.find(c => c.identifier === id)).compact().value()), {
                type: 'multiselect',
                message: 'Select Modules',
                choices: configs.map(c => ({ title: c.pathspec, value: c.identifier, selected: targetConfigs.some(tc => tc.identifier === c.identifier) }))
            }),
            checkout: () => this.prompt('checkout', Zod.boolean(), {
                type: 'confirm',
                message: 'Checkout'
            }),
            stdout: this.context.stdout,
            dryRun: this.dryRun
        });
    }
}

export class CreateCommand extends BaseCommand {
    static paths = [['feature', 'create']];

    featureName = Option.String('--name', { required: true });
    branchName = Option.String('--branch-name');
    from = Option.String('--from', 'branch://develop');

    include = Option.Array('--include');
    exclude = Option.Array('--exclude');

    checkout = Option.Boolean('--checkout', false);

    static usage = Command.Usage({
        description: 'Create feature',
        category: 'Feature'
    });

    public async execute() {
        const rootConfig = await this.loadConfig();
        const targetConfigs = await rootConfig.resolveFilteredConfigs({
            included: this.include,
            excluded: this.exclude
        });

        await createFeature(rootConfig, {
            name: async () => this.featureName ?? 'test',
            from: () => this.from,
            branchName: ({ fromElement, featureName }) => this.branchName ?? `${fromElement.type === 'support' ? `support/${fromElement.support.name}/` : ''}feature/${featureName}`,
            configs: () => targetConfigs,
            checkout: () => this.checkout,
            stdout: this.context.stdout,
            dryRun: this.dryRun
        });

        // const allConfigs = config.flattenConfigs();
        // const targetConfigs = await config.resolveFilteredConfigs({
        //     included: this.include,
        //     excluded: this.exclude
        // });

        // const { featureName, configs } = await this.prompt({
        //     featureName: Zod.string(),
        //     configs: Zod.string().array()
        // }, {
        //     featureName: {
        //         prompt: {
        //             type: 'text',
        //             message: 'Feature Name'
        //         },
        //         handler: () => this.featureName
        //     },
        //     configs: {
        //         prompt: {
        //             type: 'multiselect',
        //             message: 'Select Modules',
        //             choices: allConfigs.map(c => ({ title: c.pathspec, value: c.identifier, selected: targetConfigs.some(tc => tc.identifier === c.identifier) }))
        //         },
        //         handler: () => targetConfigs.map(c => c.identifier)
        //     }
        // }, ({ configs, ...params }) => ({
        //     ...params,
        //     configs: _(configs).map(id => allConfigs.find(c => c.identifier === id)).compact().value()
        // }));

        // for (const config of configs) {
        //     const { from } = await this.prompt({
        //         from: Zod.string()
        //     }, {
        //         from: {
        //             prompt: {
        //                 type: 'text',
        //                 message: `[${config.pathspec}] Feature Branch Source`,
        //                 initial: 'branch://develop'
        //             },
        //             handler: () => this.from
        //         }
        //     });

        //     const fromElement = await config.parseElement(from);
        //     const fromBranch = await (async () => {
        //         if (fromElement.type === 'branch')
        //             return fromElement.branch;
        //         else if (fromElement.type === 'repo')
        //             return fromElement.config.resolveCurrentBranch();
        //         else if (fromElement.type === 'feature')
        //             return fromElement.feature.branchName;
        //         else if (fromElement.type === 'release')
        //             return fromElement.release.branchName;
        //         else if (fromElement.type === 'hotfix')
        //             return fromElement.hotfix.branchName;
        //         else if (fromElement.type === 'support')
        //             return fromElement.support.developBranchName;
        //         else
        //             throw new Error(`Cannot derive source branch from ${from}`);
        //     })();

        //     const { branchName } = await this.prompt({
        //         branchName: Zod.string()
        //     }, {
        //         branchName: {
        //             prompt: {
        //                 type: 'text',
        //                 message: `[${config.pathspec}] Branch Name`,
        //                 initial: `${fromElement.type === 'support' ? `support/${fromElement.support.name}/` : ''}feature/${featureName}`
        //             },
        //             handler: () => this.branchName
        //         }
        //     });

        //     // const branchName = this.branchName ?? `${fromElement.type === 'support' ? `support/${fromElement.support.name}/` : ''}feature/${this.featureName}`;
        //     const source = fromElement.type === 'support' ? fromElement.support : config;

        //     if (source.features.some(f => f.name === featureName))
        //         continue;

        //     const feature = new Feature({
        //         name: featureName,
        //         branchName,
        //         sourceSha: await config.resolveCommitSha(fromBranch)
        //     });
        //     source.features.push(feature);
        //     await feature.register(config, source instanceof Support ? source : undefined);

        //     await feature.init({ stdout: this.context.stdout, dryRun: this.dryRun });
        //     await config.save({ stdout: this.context.stdout, dryRun: this.dryRun });

        //     if (this.checkout)
        //         config.checkoutBranch(feature.branchName, { stdout: this.context.stdout, dryRun: this.dryRun });
        // }
    }
}

export class CheckoutCommand extends BaseCommand {
    static paths = [['feature', 'checkout']];

    featureName = Option.String('--feature', { required: true });

    static usage = Command.Usage({
        description: 'Checkout feature',
        category: 'Feature'
    });

    public async execute() {
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

    public async execute() {
        const config = await this.loadConfig();
        const featureFqn = config.resolveFeatureFqn(this.featureName);

        const features = config.findFeatures(featureFqn);
        for (const feature of features) {
            const message = this.message ?? `feature ${feature.name} checkpoint`;
            await feature.parentConfig.commit(message, { stdout: this.context.stdout, dryRun: this.dryRun });
        }
    }
}

export class SyncCommand extends BaseCommand {
    static paths = [['feature', 'sync']];

    featureName = Option.String('--feature', { required: true });
    branchName = Option.String('--branch', 'develop');

    static usage = Command.Usage({
        description: 'Sync feature from branch',
        category: 'Feature'
    });

    public async execute() {
        const config = await this.loadConfig();
        const featureFqn = config.resolveFeatureFqn(this.featureName);

        const features = config.findFeatures(featureFqn);
        await Bluebird.map(features, async feature => {
            const baseBranch = await feature.parentConfig.resolveCurrentBranch({ stdout: this.context.stdout });

            try {
                await feature.checkoutBranch({ stdout: this.context.stdout, dryRun: this.dryRun })
                await feature.parentConfig.merge(this.branchName, { stdout: this.context.stdout, dryRun: this.dryRun }).catch(async () => {
                    this.context.stdout.write(Chalk.yellow(`Merge failed, aborting...\n`));
                    await feature.parentConfig.abortMerge({ stdout: this.context.stdout, dryRun: this.dryRun });
                });
            }
            finally {
                if (baseBranch)
                    await feature.parentConfig.checkoutBranch(baseBranch, { stdout: this.context.stdout, dryRun: this.dryRun });
            }
        }, { concurrency: 1 });
    }
}

export class MergeCommand extends BaseCommand {
    static paths = [['feature', 'merge']];

    featureName = Option.String('--feature', { required: true });
    squash = Option.Boolean('--squash', false);

    static usage = Command.Usage({
        description: 'Merge feature into develop',
        category: 'Feature'
    });

    public async execute() {
        const config = await this.loadConfig();
        const featureFqn = config.resolveFeatureFqn(this.featureName);

        const features = config.findFeatures(featureFqn);
        await Bluebird.map(features, async feature => {
            try {
                if (await feature.parentConfig.isDirty({ stdout: this.context.stdout }))
                    throw new Error(`Workspace ${feature.parentConfig.path} has uncommitted changes, aborting`);

                const baseBranch = await feature.parentConfig.resolveCurrentBranch({ stdout: this.context.stdout });

                try {
                    await feature.parentConfig.checkoutBranch('develop', { stdout: this.context.stdout, dryRun: this.dryRun })
                    await feature.parentConfig.merge(feature.branchName, { squash: this.squash, stdout: this.context.stdout, dryRun: this.dryRun }).catch(async () => {
                        this.context.stdout.write(Chalk.yellow(`Merge failed, aborting...\n`));
                        await feature.parentConfig.abortMerge({ stdout: this.context.stdout, dryRun: this.dryRun });
                    });
                    await feature.parentConfig.commit(`feature ${feature.name} merge`, { stdout: this.context.stdout, dryRun: this.dryRun });
                }
                finally {
                    if (baseBranch)
                        await feature.parentConfig.checkoutBranch(baseBranch, { stdout: this.context.stdout, dryRun: this.dryRun });
                }
            }
            catch (err) {
                this.context.stderr.write(Chalk.red(err.toString()) + '\n');
            }
        }, { concurrency: 1 });
    }
}

export class CloseCommand extends BaseCommand {
    static paths = [['feature', 'close']];

    featureName = Option.String('--feature', { required: true });

    static usage = Command.Usage({
        description: 'Close feature',
        category: 'Feature'
    });

    public async execute() {
        const config = await this.loadConfig();
        const featureFqn = config.resolveFeatureFqn(this.featureName);

        const features = config.findFeatures(featureFqn);
        for (const feature of features) {
            if (await feature.parentConfig.resolveCurrentBranch({ stdout: this.context.stdout, dryRun: this.dryRun }) === feature.branchName)
                await feature.parentConfig.checkoutBranch('develop', { stdout: this.context.stdout, dryRun: this.dryRun });

            await feature.parentConfig.deleteBranch(feature.branchName, { stdout: this.context.stdout, dryRun: this.dryRun });

            const idx = feature.parentConfig.features.indexOf(feature);
            feature.parentConfig.features.splice(idx, 1);
            await feature.parentConfig.save({ stdout: this.context.stdout, dryRun: this.dryRun });
        }
    }
}
