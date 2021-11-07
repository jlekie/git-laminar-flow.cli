import { Command, Option } from 'clipanion';

import { BaseCommand } from './common';

export class CreateCommand extends BaseCommand {
    static paths = [['feature', 'create']];

    static usage = Command.Usage({
        description: 'Initialize repo',
        details: 'This will initialize the repo'
    });

    public async execute() {
    }
}