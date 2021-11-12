import { Command, Option } from 'clipanion';
import * as Minimatch from 'minimatch';
import * as Bluebird from 'bluebird';
import * as Chalk from 'chalk';

import { URL } from 'url';

import { BaseCommand } from './common';

import { loadConfig, Config, Feature } from '../lib/config';

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
        const config = await loadConfig(this.configPath);
        const targetConfigs = await config.resolveFilteredConfigs({
            included: this.include,
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
        const config = await loadConfig(this.configPath);
        const targetConfigs = await config.resolveFilteredConfigs({
            included: this.include,
            excluded: this.exclude
        });

        const [ type, target ] = this.target.split('://');

        for (const config of targetConfigs) {
            if (type === 'branch') {
                await config.checkoutBranch(target, { stdout: this.context.stdout, dryRun: this.dryRun });
            }
            else if (type === 'feature') {
                const feature = config.features.find(f => f.name === target);
                if (feature)
                    await config.checkoutBranch(feature.branchName, { stdout: this.context.stdout, dryRun: this.dryRun });
            }
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
        const config = await loadConfig(this.configPath);

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
        const config = await loadConfig(this.configPath);
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
        const config = await loadConfig(this.configPath);
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
        const config = await loadConfig(this.configPath);
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

    target = Option.String('--target', { required: true });

    abort = Option.Boolean('--abort', false);

    static usage = Command.Usage({
        description: 'Closes active features/release/etc'
    });

    public async execute() {
        const config = await loadConfig(this.configPath);
        const targetConfigs = await config.resolveFilteredConfigs({
            included: this.include,
            excluded: this.exclude
        });

        const [ type, target ] = this.target.split('://');

        for (const config of targetConfigs) {
            try {
                const artifact = await config.resolveCurrentArtifact();
                if (artifact.type !== 'develop') {
                    this.logWarning(`Cannot close feature unless on develop [${artifact.branch}]`);
                    continue;
                }

                if (type === 'feature') {
                    const feature = config.features.find(f => f.name === target);
                    if (!feature)
                        continue;

                    this.context.stdout.write(Chalk.cyan(`Preparing to close feature ${feature.name} [${feature.branchName}]...\n`));

                    await config.checkoutBranch('develop', { stdout: this.context.stdout, dryRun: this.dryRun });

                    if (!this.abort) {
                        await config.merge(feature.branchName, { squash: true, stdout: this.context.stdout, dryRun: this.dryRun });
    
                        if (await config.hasStagedChanges({ stdout: this.context.stdout, dryRun: this.dryRun }))
                            await config.commit(`feature ${feature.name} merge`, { stdout: this.context.stdout, dryRun: this.dryRun });
                    }

                    await config.deleteBranch(feature.branchName, { stdout: this.context.stdout, dryRun: this.dryRun });
    
                    const idx = config.features.indexOf(feature);
                    config.features.splice(idx, 1);
                    await config.save({ stdout: this.context.stdout, dryRun: this.dryRun });

                    this.logInfo(`Feature ${feature.name} closed`);
                }
                else if (type === 'release') {
                    const release = config.releases.find(f => f.name === target);
                    if (!release)
                        continue;

                    this.context.stdout.write(Chalk.cyan(`Preparing to close release ${release.name} [${release.branchName}]...\n`));

                    await config.checkoutBranch('develop', { stdout: this.context.stdout, dryRun: this.dryRun });

                    if (!this.abort) {
                        await config.merge(release.branchName, { squash: true, stdout: this.context.stdout, dryRun: this.dryRun });
    
                        if (await config.hasStagedChanges({ stdout: this.context.stdout, dryRun: this.dryRun }))
                            await config.commit(`release ${release.name} merge`, { stdout: this.context.stdout, dryRun: this.dryRun });
                    }

                    await config.checkoutBranch('master', { stdout: this.context.stdout, dryRun: this.dryRun });

                    if (!this.abort) {
                        await config.merge(release.branchName, { squash: true, stdout: this.context.stdout, dryRun: this.dryRun });
    
                        if (await config.hasStagedChanges({ stdout: this.context.stdout, dryRun: this.dryRun })) {
                            await config.commit(`release ${release.name} merge`, { stdout: this.context.stdout, dryRun: this.dryRun });
                            await config.tag(release.name, { annotation: `Release ${release.name}`, stdout: this.context.stdout, dryRun: this.dryRun })
                        }
                    }

                    await config.deleteBranch(release.branchName, { stdout: this.context.stdout, dryRun: this.dryRun });

                    const idx = config.releases.indexOf(release);
                    config.releases.splice(idx, 1);
                    await config.save({ stdout: this.context.stdout, dryRun: this.dryRun });

                    this.logInfo(`Release ${release.name} closed`);
                }
            }
            catch (err) {
                this.logError(err.toString());
            }
        }
    }
}