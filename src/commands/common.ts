import { Command, Option } from 'clipanion';
import * as Chalk from 'chalk';

export abstract class BaseCommand extends Command {
    dryRun = Option.Boolean('--dry-run');
    configPath = Option.String('--config', '.gitflow.yml');

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
}