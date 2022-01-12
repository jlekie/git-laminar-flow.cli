import { Command, Option } from 'clipanion';
import * as Minimatch from 'minimatch';
import * as Bluebird from 'bluebird';

import * as Chalk from 'chalk';

import * as Path from 'path';
import * as FS from 'fs-extra';

import { BaseCommand } from './common';

import { loadConfig, Config, Release, Hotfix, Support } from '../lib/config';

export class ImportCommand extends BaseCommand {
    static paths = [['config', 'import']];

    configPath = Option.String('--path', '.gitflow.yml');

    include = Option.Array('--include');
    exclude = Option.Array('--exclude');

    static usage = Command.Usage({
        description: 'Import config',
        category: 'Config'
    });

    public async execute() {
        const config = await loadConfig(this.configPath);
        const targetConfigs = await config.resolveFilteredConfigs({
            included: this.include,
            excluded: this.exclude
        });

        for (const config of targetConfigs) {
            const configPath = Path.resolve(config.path, '.gitflow.yml');
            if (!await FS.pathExists(configPath))
                continue;

            const oldConfig = await loadConfig(configPath);
            this.context.stdout.write(Chalk.gray(`Reading config from ${configPath}\n`));

            await oldConfig.init({ stdout: this.context.stdout, dryRun: this.dryRun });
        }

        for (const config of targetConfigs) {
            const configPath = Path.resolve(config.path, '.gitflow.yml');
            if (!await FS.pathExists(configPath))
                continue;

            if (!this.dryRun)
                await FS.remove(configPath);
            this.context.stdout.write(Chalk.gray(`Config ${configPath} deleted\n`));
        }
    }
}