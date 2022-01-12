import { Command, Option } from 'clipanion';

import { BaseCommand } from './common';

import { loadRepoConfig } from '../lib/config';

export class CloneCommand extends BaseCommand {
    static paths = [['submodules', 'clone']];

    reposBasePath = Option.String('--repo-base-path')

    static usage = Command.Usage({
        description: 'Clone',
        category: 'Submodule'
    });

    public async execute() {
        const config = await loadRepoConfig({ stdout: this.context.stdout, dryRun: this.dryRun });
    }
}