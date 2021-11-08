import { Command, Option } from 'clipanion';
import * as Minimatch from 'minimatch';
import * as Bluebird from 'bluebird';

import { BaseCommand } from './common';

import { loadConfig, Config, Feature } from '../lib/config';

export class CheckoutCommand extends BaseCommand {
    static paths = [['checkout']];

    branchName = Option.String('--branch', { required: true });
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