import { Command, Option } from 'clipanion';
import * as Minimatch from 'minimatch';
import * as Bluebird from 'bluebird';
import * as Chalk from 'chalk';

import { BaseCommand } from './common';

import { loadConfig, Config, Feature } from '../lib/config';

export class InitCommand extends BaseCommand {
    static paths = [['init']];

    reposBasePath = Option.String('--repo-base-path')

    static usage = Command.Usage({
        description: 'Initialize repo',
        details: 'This will initialize the repo'
    });

    public async execute() {
        const config = await loadConfig(this.configPath);

        await config.init({ stdout: this.context.stdout, dryRun: this.dryRun });
    }
}

export class CheckoutCommand extends BaseCommand {
    static paths = [['checkout']];

    branchName = Option.String('--branch', 'develop');
    submodules = Option.Array('--submodules', [ '**' ]);

    static usage = Command.Usage({
        description: 'Checkout feature'
    });

    public async execute() {
        const config = await loadConfig(this.configPath);

        const targetConfigs = [
            config,
            ...config.submodules.filter(s => this.submodules.some(pattern => Minimatch(s.name, pattern))).map(s => s.config)
        ];

        await Bluebird.map(targetConfigs, config => config.checkoutBranch(this.branchName, { stdout: this.context.stdout, dryRun: this.dryRun }), { concurrency: 1 });
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
    include = Option.Array('--include', []);
    exclude = Option.Array('--exclude', []);

    static usage = Command.Usage({
        description: 'Execute CLI command in repo'
    });

    public async execute() {
        const config = await loadConfig(this.configPath);
        const targetConfigs = config.flattenConfigs().filter(c => {
            if (this.include.length > 0 && !this.include.some(pattern => Minimatch(c.pathspec, pattern)))
                return false;
            else if (this.exclude.length > 0 && this.exclude.some(pattern => Minimatch(c.pathspec, pattern)))
                return false;

            return true;
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

    include = Option.Array('--include', []);
    exclude = Option.Array('--exclude', []);

    static usage = Command.Usage({
        description: 'Report checkout status'
    });

    public async execute() {
        const config = await loadConfig(this.configPath);
        const targetConfigs = config.flattenConfigs().filter(c => {
            if (this.include.length > 0 && !this.include.some(pattern => Minimatch(c.pathspec, pattern)))
                return false;
            else if (this.exclude.length > 0 && this.exclude.some(pattern => Minimatch(c.pathspec, pattern)))
                return false;

            return true;
        });

        for (const config of targetConfigs) {
            const currentBranch = await config.resolveCurrentBranch({ stdout: this.context.stdout, dryRun: this.dryRun });

            const matchingFeature = config.features.find(f => f.branchName === currentBranch);
            if (matchingFeature)
                this.context.stdout.write(`[${config.path}] ${Chalk.magenta('FEATURE')} ${Chalk.blue(currentBranch)}\n`);
            else if (currentBranch === 'develop')
                this.context.stdout.write(`[${config.path}] ${Chalk.magenta('DEVELOP')} ${Chalk.blue(currentBranch)}\n`);
        }
    }
}