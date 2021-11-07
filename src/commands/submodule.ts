import { Command, Option } from 'clipanion';

import { BaseCommand } from './common';

import { loadConfig } from '../lib/config';

export class CloneCommand extends BaseCommand {
    static paths = [['submodules', 'clone']];

    reposBasePath = Option.String('--repo-base-path')

    static usage = Command.Usage({
        description: 'Clone'
    });

    public async execute() {
        const config = await loadConfig(this.configPath);
    }
}