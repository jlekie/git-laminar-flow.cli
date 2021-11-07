import { Command, Option } from 'clipanion';

import { BaseCommand } from './common';
import { init } from '../lib/actions';

export class InitCommand extends BaseCommand {
    static paths = [['init']];

    reposBasePath = Option.String('--repo-base-path')

    static usage = Command.Usage({
        description: 'Initialize repo',
        details: 'This will initialize the repo'
    });

    public async execute() {
        await init({
            repoBasePath: this.reposBasePath,
            configPath: this.configPath,
            stdout: this.context.stdout,
            createGitmodulesConfig: true,
            dryRun: this.dryRun
        });
    }
}