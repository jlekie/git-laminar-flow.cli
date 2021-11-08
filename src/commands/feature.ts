import { Command, Option } from 'clipanion';

import { BaseCommand } from './common';

import { loadConfig, Config } from '../lib/config';

export class CreateCommand extends BaseCommand {
    static paths = [['feature', 'create']];

    static usage = Command.Usage({
        description: 'Initialize repo',
        details: 'This will initialize the repo'
    });

    public async execute() {
    }
}

export class CheckoutCommand extends BaseCommand {
    static paths = [['feature', 'checkout']];

    featureName = Option.String('--feature', { required: true })
    submoduleName = Option.String('--submodule')

    static usage = Command.Usage({
        description: 'Checkout feature'
    });

    public async execute() {
        const config = await loadConfig(this.configPath);
        const featureFqn = config.resolveFeatureFqn(this.featureName);

        return config.checkoutFeature(featureFqn, { stdout: this.context.stdout, dryRun: this.dryRun });
    }
}