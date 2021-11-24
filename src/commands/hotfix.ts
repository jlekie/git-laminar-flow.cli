import { Command, Option } from 'clipanion';
import * as Minimatch from 'minimatch';
import * as Bluebird from 'bluebird';

import * as Chalk from 'chalk';

import { BaseCommand } from './common';

import { loadConfig, Config, Release, Hotfix } from '../lib/config';

export class CreateCommand extends BaseCommand {
    static paths = [['hotfix', 'create']];

    name = Option.String('--name', { required: true });
    branchName = Option.String('--branch-name', { required: false });
    from = Option.String('--from', 'master');

    include = Option.Array('--include');
    exclude = Option.Array('--exclude');

    checkout = Option.Boolean('--checkout', false);

    static usage = Command.Usage({
        description: 'Create hotfix'
    });

    public async execute() {
        const config = await loadConfig(this.configPath);
        const targetConfigs = await config.resolveFilteredConfigs({
            included: this.include,
            excluded: this.exclude
        });

        const featureFqn = config.resolveFeatureFqn(this.name);
        const branchName = this.branchName ?? `hotfix/${this.name}`;

        for (const config of targetConfigs) {
            if (config.hotfixes.some(f => f.name === featureFqn))
                continue;

            const hotfix = new Hotfix({
                name: featureFqn,
                branchName,
                sourceSha: await config.resolveCommitSha(this.from)
            });
            config.hotfixes.push(hotfix);
            await hotfix.register(config);

            await hotfix.init({ stdout: this.context.stdout, dryRun: this.dryRun });
            await config.save({ stdout: this.context.stdout, dryRun: this.dryRun });

            if (this.checkout)
                config.checkoutBranch(hotfix.branchName, { stdout: this.context.stdout, dryRun: this.dryRun });
        }
    }
}