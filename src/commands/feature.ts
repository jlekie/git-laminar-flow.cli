import { Command, Option } from 'clipanion';
import * as Minimatch from 'minimatch';
import * as Bluebird from 'bluebird';

import * as Chalk from 'chalk';

import { BaseCommand } from './common';

import { loadConfig, Config, Feature } from '../lib/config';

export class CreateCommand extends BaseCommand {
    static paths = [['feature', 'create']];

    featureName = Option.String('--feature', { required: true });
    submodules = Option.Array('--submodules', []);
    branchName = Option.String('--branch-name', { required: false });

    checkout = Option.Boolean('--checkout', false);

    static usage = Command.Usage({
        description: 'Create feature'
    });

    public async execute() {
        const config = await loadConfig(this.configPath);
        const featureFqn = config.resolveFeatureFqn(this.featureName);

        const branchName = this.branchName ?? `feature/${this.featureName}`;

        if (config.features.some(f => f.fqn === featureFqn))
            throw new Error(`Feature ${this.featureName} already exists`);

        const features: Feature[] = [];
        const addFeature = async (config: Config) => {
            const feature = new Feature({
                fqn: featureFqn,
                branchName
            });

            config.features.push(feature);
            features.push(feature);

            await feature.register(config);            
        }

        await addFeature(config);

        const submodules = config.submodules.filter(s => this.submodules.some(pattern => Minimatch(s.name, pattern)));
        for (const submodule of submodules)
            await addFeature(submodule.config);

        await config.save({ stdout: this.context.stdout, dryRun: this.dryRun });
        await Bluebird.map(submodules, s => s.config.save({ stdout: this.context.stdout, dryRun: this.dryRun }));

        await config.initializeFeature(featureFqn, { stdout: this.context.stdout, dryRun: this.dryRun });

        if (this.checkout) {
            await Bluebird.map(features, feature => feature.checkoutBranch({ stdout: this.context.stdout, dryRun: this.dryRun }), { concurrency: 1 });
        }
    }
}

export class CheckoutCommand extends BaseCommand {
    static paths = [['feature', 'checkout']];

    featureName = Option.String('--feature', { required: true });

    static usage = Command.Usage({
        description: 'Checkout feature'
    });

    public async execute() {
        const config = await loadConfig(this.configPath);
        const featureFqn = config.resolveFeatureFqn(this.featureName);

        const features = config.findFeatures(featureFqn);
        await Bluebird.map(features, feature => feature.checkoutBranch({ stdout: this.context.stdout, dryRun: this.dryRun }));
    }
}

export class SyncCommand extends BaseCommand {
    static paths = [['feature', 'sync']];

    featureName = Option.String('--feature', { required: true });
    branchName = Option.String('--branch', 'develop');

    static usage = Command.Usage({
        description: 'Sync feature from branch'
    });

    public async execute() {
        const config = await loadConfig(this.configPath);
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

    static usage = Command.Usage({
        description: 'Merge feature into develop'
    });

    public async execute() {
        const config = await loadConfig(this.configPath);
        const featureFqn = config.resolveFeatureFqn(this.featureName);

        const features = config.findFeatures(featureFqn);
        await Bluebird.map(features, async feature => {
            const baseBranch = await feature.parentConfig.resolveCurrentBranch({ stdout: this.context.stdout });

            try {
                await feature.parentConfig.checkoutBranch('develop', { stdout: this.context.stdout, dryRun: this.dryRun })
                await feature.parentConfig.merge(feature.branchName, { stdout: this.context.stdout, dryRun: this.dryRun }).catch(async () => {
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

export class CloseCommand extends BaseCommand {
    static paths = [['feature', 'close']];

    featureName = Option.String('--feature', { required: true });

    static usage = Command.Usage({
        description: 'Close feature'
    });

    public async execute() {
        const config = await loadConfig(this.configPath);
        const featureFqn = config.resolveFeatureFqn(this.featureName);

        const features = config.findFeatures(featureFqn);
        for (const feature of features) {
            await feature.parentConfig.checkoutBranch('develop', { stdout: this.context.stdout, dryRun: this.dryRun });
            await feature.parentConfig.deleteBranch(feature.branchName, { stdout: this.context.stdout, dryRun: this.dryRun });

            const idx = feature.parentConfig.features.indexOf(feature);
            feature.parentConfig.features.splice(idx, 1);
            await feature.parentConfig.save({ stdout: this.context.stdout, dryRun: this.dryRun });
        }
    }
}