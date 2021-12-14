import { Command, Option } from 'clipanion';
import * as Minimatch from 'minimatch';
import * as Bluebird from 'bluebird';

import * as Chalk from 'chalk';

import { BaseCommand } from './common';

import { loadConfig, Config, Release, Support } from '../lib/config';

export class CreateCommand extends BaseCommand {
    static paths = [['support', 'create']];

    name = Option.String('--name', { required: true });
    from = Option.String('--from', 'master');

    include = Option.Array('--include');
    exclude = Option.Array('--exclude');

    checkout = Option.String('--checkout');

    static usage = Command.Usage({
        description: 'Create support',
        category: 'Support'
    });

    public async execute() {
        const config = await loadConfig(this.configPath);
        const targetConfigs = await config.resolveFilteredConfigs({
            included: this.include,
            excluded: this.exclude
        });

        const featureFqn = config.resolveFeatureFqn(this.name);
        const masterBranchName = `support/${this.name}/master`;
        const developBranchName = `support/${this.name}/develop`;

        for (const config of targetConfigs) {
            if (config.supports.some(f => f.name === featureFqn))
                continue;

            const support = new Support({
                name: featureFqn,
                masterBranchName,
                developBranchName,
                sourceSha: await config.resolveCommitSha(this.from)
            });
            config.supports.push(support);
            await support.register(config);

            await support.init({ stdout: this.context.stdout, dryRun: this.dryRun });
            await config.save({ stdout: this.context.stdout, dryRun: this.dryRun });

            if (this.checkout === 'develop')
                config.checkoutBranch(support.developBranchName, { stdout: this.context.stdout, dryRun: this.dryRun });
            else if (this.checkout === 'master')
                config.checkoutBranch(support.masterBranchName, { stdout: this.context.stdout, dryRun: this.dryRun });
        }
    }
}