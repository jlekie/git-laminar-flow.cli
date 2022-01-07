import { Command, Option } from 'clipanion';
import * as Minimatch from 'minimatch';
import * as Bluebird from 'bluebird';

import * as Chalk from 'chalk';

import { BaseCommand } from './common';

import { loadConfig, Config, Release, Hotfix, Support } from '../lib/config';

export class CreateCommand extends BaseCommand {
    static paths = [['hotfix', 'create']];

    hotfixName = Option.String('--name', { required: true });
    branchName = Option.String('--branch-name', { required: false });
    from = Option.String('--from', 'branch://master');

    include = Option.Array('--include');
    exclude = Option.Array('--exclude');

    checkout = Option.Boolean('--checkout', false);

    static usage = Command.Usage({
        description: 'Create hotfix',
        category: 'Hotfix'
    });

    public async execute() {
        const config = await loadConfig(this.configPath);
        const targetConfigs = await config.resolveFilteredConfigs({
            included: this.include,
            excluded: this.exclude
        });

        const featureFqn = config.resolveFeatureFqn(this.hotfixName);

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
                    return fromElement.support.masterBranchName;
                else
                    throw new Error(`Cannot derive source branch from ${this.from}`);
            })();

            const branchName = this.branchName ?? `${fromElement.type === 'support' ? `support/${fromElement.support.name}/` : ''}hotfix/${this.hotfixName}`;
            const source = fromElement.type === 'support' ? fromElement.support : config;

            if (source.hotfixes.some(f => f.name === featureFqn))
                continue;

            const hotfix = new Hotfix({
                name: featureFqn,
                branchName,
                sourceSha: await config.resolveCommitSha(fromBranch)
            });
            source.hotfixes.push(hotfix);
            await hotfix.register(config, source instanceof Support ? source : undefined);

            await hotfix.init({ stdout: this.context.stdout, dryRun: this.dryRun });
            await config.save({ stdout: this.context.stdout, dryRun: this.dryRun });

            if (this.checkout)
                config.checkoutBranch(hotfix.branchName, { stdout: this.context.stdout, dryRun: this.dryRun });
        }
    }
}