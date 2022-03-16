import { Command, Option } from 'clipanion';
import * as Minimatch from 'minimatch';
import * as Bluebird from 'bluebird';
import * as _ from 'lodash';
import * as Zod from 'zod';

import * as Chalk from 'chalk';
import * as Prompts from 'prompts';

import { BaseCommand } from './common';

import { loadV2Config, Config, Release, Support } from '../lib/config';
import { createRelease } from '../lib/actions';

export class CreateInteractiveCommand extends BaseCommand {
    static paths = [['release', 'create']];

    releaseName = Option.String('--name');
    branchName = Option.String('--branch-name');
    from = Option.String('--from');

    include = Option.Array('--include');
    exclude = Option.Array('--exclude');

    checkout = Option.Boolean('--checkout');

    static usage = Command.Usage({
        description: 'Create release',
        category: 'Release'
    });

    public async execute() {
        Prompts.override({
            releaseName: this.releaseName,
            branchName: this.branchName,
            from: this.from,
            checkout: this.checkout
        });

        const rootConfig = await this.loadConfig();
        const targetConfigs = await rootConfig.resolveFilteredConfigs({
            included: this.include,
            excluded: this.exclude
        });

        await createRelease(rootConfig, {
            name: () => this.prompt('releaseName', Zod.string().nonempty(), {
                type: 'text',
                message: 'Release Name'
            }),
            from: ({ config }) => this.prompt('from', Zod.string().url(), {
                type: 'text',
                message: `[${Chalk.magenta(config.pathspec)}] From`,
                initial: 'branch://develop'
            }),
            branchName: ({ config, fromElement, releaseName }) => this.prompt('branchName', Zod.string(), {
                type: 'text',
                message: `[${Chalk.magenta(config.pathspec)}] Branch Name`,
                initial: `${fromElement.type === 'support' ? `support/${fromElement.support.name}/` : ''}release/${releaseName}`
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
    static paths = [['release', 'create']];

    releaseName = Option.String('--name', { required: true });
    branchName = Option.String('--branch-name');
    from = Option.String('--from', 'branch://develop');

    include = Option.Array('--include');
    exclude = Option.Array('--exclude');

    checkout = Option.Boolean('--checkout', false);

    static usage = Command.Usage({
        description: 'Create release',
        category: 'Release'
    });

    public async execute() {
        const rootConfig = await this.loadConfig();
        const targetConfigs = await rootConfig.resolveFilteredConfigs({
            included: this.include,
            excluded: this.exclude
        });

        await createRelease(rootConfig, {
            name: async () => this.releaseName,
            from: () => this.from,
            branchName: ({ fromElement, releaseName }) => this.branchName ?? `${fromElement.type === 'support' ? `support/${fromElement.support.name}/` : ''}release/${releaseName}`,
            configs: () => targetConfigs,
            checkout: () => this.checkout,
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
