import { Command, Option } from 'clipanion';
import * as Minimatch from 'minimatch';
import * as Bluebird from 'bluebird';

import * as Chalk from 'chalk';

import { BaseCommand } from './common';

import { loadV2Config, Config, Release, Support } from '../lib/config';

export class CreateCommand extends BaseCommand {
    static paths = [['release', 'create']];

    releaseName = Option.String('--name', { required: true });
    branchName = Option.String('--branch-name', { required: false });
    from = Option.String('--from', 'branch://develop');

    include = Option.Array('--include');
    exclude = Option.Array('--exclude');

    checkout = Option.Boolean('--checkout', false);

    static usage = Command.Usage({
        description: 'Create release',
        category: 'Release'
    });

    public async execute() {
        const config = await this.loadConfig();
        const targetConfigs = await config.resolveFilteredConfigs({
            included: this.include,
            excluded: this.exclude
        });

        const featureFqn = config.resolveFeatureFqn(this.releaseName);

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

            const branchName = this.branchName ?? `${fromElement.type === 'support' ? `support/${fromElement.support.name}/` : ''}release/${this.releaseName}`;
            const source = fromElement.type === 'support' ? fromElement.support : config;

            if (source.releases.some(f => f.name === featureFqn))
                continue;

            const release = new Release({
                name: featureFqn,
                branchName,
                sourceSha: await config.resolveCommitSha(fromBranch)
            });
            source.releases.push(release);
            await release.register(config, source instanceof Support ? source : undefined);

            await release.init({ stdout: this.context.stdout, dryRun: this.dryRun });
            await config.save({ stdout: this.context.stdout, dryRun: this.dryRun });

            if (this.checkout)
                await config.checkoutBranch(release.branchName, { stdout: this.context.stdout, dryRun: this.dryRun });
        }
    }
}

export class CheckoutCommand extends BaseCommand {
    static paths = [['release', 'checkout']];

    releaseName = Option.String('--release', { required: true });

    static usage = Command.Usage({
        description: 'Checkout release',
        category: 'Release'
    });

    public async execute() {
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
    branchName = Option.String('--branch', 'develop');

    static usage = Command.Usage({
        description: 'Sync release from branch',
        category: 'Release'
    });

    public async execute() {
        const config = await this.loadConfig();
        const featureFqn = config.resolveFeatureFqn(this.releaseName);

        const releases = config.findReleases(featureFqn);
        await Bluebird.map(releases, async release => {
            const baseBranch = await release.parentConfig.resolveCurrentBranch({ stdout: this.context.stdout });

            try {
                await release.parentConfig.checkoutBranch(release.branchName, { stdout: this.context.stdout, dryRun: this.dryRun })
                await release.parentConfig.merge(this.branchName, { stdout: this.context.stdout, dryRun: this.dryRun }).catch(async () => {
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

    public async execute() {
        const config = await this.loadConfig();
        const featureFqn = config.resolveFeatureFqn(this.releaseName);

        const releases = config.findReleases(featureFqn);
        await Bluebird.map(releases, async release => {
            const baseBranch = await release.parentConfig.resolveCurrentBranch({ stdout: this.context.stdout });

            try {
                await release.parentConfig.checkoutBranch('develop', { stdout: this.context.stdout, dryRun: this.dryRun })
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

export class CloseCommand extends BaseCommand {
    static paths = [['release', 'close']];

    releaseName = Option.String('--release', { required: true });

    static usage = Command.Usage({
        description: 'Delete release',
        category: 'Release'
    });

    public async execute() {
        const config = await this.loadConfig();
        const featureFqn = config.resolveFeatureFqn(this.releaseName);

        const releases = config.findReleases(featureFqn);
        await Bluebird.map(releases, async release => {
            if (await release.parentConfig.resolveCurrentBranch({ stdout: this.context.stdout, dryRun: this.dryRun }) === release.branchName)
                await release.parentConfig.checkoutBranch('develop', { stdout: this.context.stdout, dryRun: this.dryRun });

            await release.parentConfig.deleteBranch(release.branchName, ({ stdout: this.context.stdout, dryRun: this.dryRun }));

            const idx = release.parentConfig.releases.indexOf(release);
            release.parentConfig.releases.splice(idx, 1);
            await release.parentConfig.save({ stdout: this.context.stdout, dryRun: this.dryRun });
        }, { concurrency: 1 });
    }
}
