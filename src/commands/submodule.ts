import { Command, Option } from 'clipanion';

import { BaseCommand } from './common';

import { loadV2Config } from '../lib/config';

export class CloneCommand extends BaseCommand {
    static paths = [['submodules', 'clone']];

    reposBasePath = Option.String('--repo-base-path')

    static usage = Command.Usage({
        description: 'Clone',
        category: 'Submodule'
    });

    public async execute() {
        const config = await this.loadConfig();
    }
}