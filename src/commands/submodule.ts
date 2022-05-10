import { Command, Option } from 'clipanion';
import * as Zod from 'zod';

import { BaseCommand, BaseInteractiveCommand } from './common';

import { loadV2Config } from 'lib/config';
import { createSubmodule } from 'lib/actions';

export class CreateInteractiveCommand extends BaseInteractiveCommand {
    static paths = [['submodule', 'create']];

    static usage = Command.Usage({
        description: 'Create',
        category: 'Submodule'
    });

    public async executeCommand() {
        const rootConfig = await this.loadConfig();

        await createSubmodule(rootConfig, {
            name: () => this.createOverridablePrompt('name', Zod.string().nonempty(), {
                type: 'text',
                message: 'Submodule Name'
            }),
            path: ({ name }) => this.createOverridablePrompt('path', Zod.string().nonempty(), {
                type: 'text',
                message: 'Checkout Path',
                initial: `./modules/${name}`
            }),
            url: () => this.createOverridablePrompt('url', Zod.string().nonempty().url(), {
                type: 'text',
                message: 'Submodule Url'
            }),
            stdout: this.context.stdout,
            dryRun: this.dryRun
        });
    }
}
