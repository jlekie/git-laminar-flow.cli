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