import { Command, Option } from 'clipanion';

export abstract class BaseCommand extends Command {
    dryRun = Option.Boolean('--dry-run');
    configPath = Option.String('--config', '.gitflow.yml');

    abstract execute(): Promise<number | void>;
}