import { Command, Option } from 'clipanion';
import * as Minimatch from 'minimatch';
import * as Bluebird from 'bluebird';

import * as Chalk from 'chalk';

import { BaseCommand } from './common';

import { loadConfig, Config, Release } from '../lib/config';

export class CreateCommand extends BaseCommand {
    static paths = [['release', 'create']];

    releaseName = Option.String('--release', { required: true });
    submodules = Option.Array('--submodules', []);
    branchName = Option.String('--branch-name', { required: false });

    checkout = Option.Boolean('--checkout', false);

    static usage = Command.Usage({
        description: 'Create release'
    });

    public async execute() {
        const config = await loadConfig(this.configPath);
        const featureFqn = config.resolveFeatureFqn(this.releaseName);

        const branchName = this.branchName ?? `release/${this.releaseName}`;

        const updatedConfigs: Config[] = [];
        const addRelease = async (config: Config) => {
            if (config.releases.some(f => f.fqn === featureFqn))
                return;

            const release = new Release({
                fqn: featureFqn,
                branchName
            });
            config.releases.push(release);

            updatedConfigs.push(config);

            await release.register(config);            
        }

        await addRelease(config);

        const submodules = config.submodules.filter(s => this.submodules.some(pattern => Minimatch(s.name, pattern)));
        for (const submodule of submodules)
            await addRelease(submodule.config);

        await Bluebird.map(updatedConfigs, config => config.save({ stdout: this.context.stdout, dryRun: this.dryRun }))

        const releases = config.findReleases(featureFqn);
        await Bluebird.map(releases, async release => {
            await release.initialize({ stdout: this.context.stdout, dryRun: this.dryRun })

            if (this.checkout)
                await release.parentConfig.checkoutBranch(release.branchName, { stdout: this.context.stdout, dryRun: this.dryRun });
        }, { concurrency: 1 });
    }
}

export class CheckoutCommand extends BaseCommand {
    static paths = [['release', 'checkout']];

    releaseName = Option.String('--release', { required: true });

    static usage = Command.Usage({
        description: 'Checkout release'
    });

    public async execute() {
        const config = await loadConfig(this.configPath);
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
        description: 'Sync release from branch'
    });

    public async execute() {
        const config = await loadConfig(this.configPath);
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
        description: 'Merge feature into develop & master'
    });

    public async execute() {
        const config = await loadConfig(this.configPath);
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
        description: 'Delete release'
    });

    public async execute() {
        const config = await loadConfig(this.configPath);
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