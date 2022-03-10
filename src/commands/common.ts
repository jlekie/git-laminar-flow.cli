import { Command, Option } from 'clipanion';
import * as Chalk from 'chalk';

import * as OS from 'os';
import * as Path from 'path';

import { loadSettings } from '../lib/settings';
import { loadV2Config } from '../lib/config';

export abstract class BaseCommand extends Command {
    dryRun = Option.Boolean('--dry-run');
    configPath = Option.String('--config', 'branch://gitflow');
    settingsPath = Option.String('--settings', Path.resolve(OS.homedir(), '.gitflow/cli.yml'));

    abstract execute(): Promise<number | void>;

    protected logVerbose(message: string) {
        this.context.stdout.write(`${Chalk.gray(message)}\n`)
    }
    protected logInfo(message: string) {
        this.context.stdout.write(`${Chalk.blue(message)}\n`)
    }
    protected logWarning(message: string) {
        this.context.stdout.write(`${Chalk.yellow(message)}\n`)
    }
    protected logError(message: string) {
        this.context.stdout.write(`${Chalk.red(message)}\n`)
    }

    protected log(message: string) {
        this.context.stdout.write(`${message}\n`)
    }

    protected async loadSettings() {
        return loadSettings(this.settingsPath);
    }
    protected async loadConfig() {
        const settings = await loadSettings(this.settingsPath);

        return loadV2Config(this.configPath, settings, { stdout: this.context.stdout, dryRun: this.dryRun })
    }
}