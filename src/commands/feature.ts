import { Command, Option } from 'clipanion';
import * as Minimatch from 'minimatch';
import * as Bluebird from 'bluebird';

import * as Chalk from 'chalk';

import { BaseCommand } from './common';

import { loadRepoConfig, Config, Feature, Support } from '../lib/config';

export class CreateCommand extends BaseCommand {
    static paths = [['feature', 'create']];

    featureName = Option.String('--name', { required: true });
    branchName = Option.String('--branch-name', { required: false });
    from = Option.String('--from', 'branch://develop');

    include = Option.Array('--include');
    exclude = Option.Array('--exclude');

    checkout = Option.Boolean('--checkout', false);

    static usage = Command.Usage({
        description: 'Create feature',
        category: 'Feature'
    });

    public async execute() {
        const config = await loadRepoConfig({ stdout: this.context.stdout, dryRun: this.dryRun });
        const targetConfigs = await config.resolveFilteredConfigs({
            included: this.include,
            excluded: this.exclude
        });

        const featureFqn = config.resolveFeatureFqn(this.featureName);

        for (const config of targetConfigs) {
            const fromElement = await config.parseElement(this.from);
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
                    throw new Error(`Cannot derive source branch from ${this.from}`);
            })();

            const branchName = this.branchName ?? `${fromElement.type === 'support' ? `support/${fromElement.support.name}/` : ''}feature/${this.featureName}`;
            const source = fromElement.type === 'support' ? fromElement.support : config;

            if (source.features.some(f => f.name === featureFqn))
                continue;

            const feature = new Feature({
                name: featureFqn,
                branchName,
                sourceSha: await config.resolveCommitSha(fromBranch)
            });
            source.features.push(feature);
            await feature.register(config, source instanceof Support ? source : undefined);

            await feature.init({ stdout: this.context.stdout, dryRun: this.dryRun });
            await config.save({ stdout: this.context.stdout, dryRun: this.dryRun });

            if (this.checkout)
                config.checkoutBranch(feature.branchName, { stdout: this.context.stdout, dryRun: this.dryRun });
        }
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
        const config = await loadRepoConfig({ stdout: this.context.stdout, dryRun: this.dryRun });
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
        const config = await loadRepoConfig({ stdout: this.context.stdout, dryRun: this.dryRun });
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
        const config = await loadRepoConfig({ stdout: this.context.stdout, dryRun: this.dryRun });
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
        const config = await loadRepoConfig({ stdout: this.context.stdout, dryRun: this.dryRun });
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
        const config = await loadRepoConfig({ stdout: this.context.stdout, dryRun: this.dryRun });
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