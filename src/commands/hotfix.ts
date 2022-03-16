import { Command, Option } from 'clipanion';
import * as Minimatch from 'minimatch';
import * as Bluebird from 'bluebird';
import * as _ from 'lodash';
import * as Zod from 'zod';

import * as Chalk from 'chalk';

import * as Prompts from 'prompts';

import { BaseCommand } from './common';

import { loadV2Config, Config, Release, Hotfix, Support } from '../lib/config';
import { createHotfix } from '../lib/actions';

export class CreateInteractiveCommand extends BaseCommand {
    static paths = [['hotfix', 'create']];

    featureName = Option.String('--name');
    branchName = Option.String('--branch-name');
    from = Option.String('--from');

    include = Option.Array('--include');
    exclude = Option.Array('--exclude');

    checkout = Option.Boolean('--checkout');

    static usage = Command.Usage({
        description: 'Create hotfix',
        category: 'Hotfix'
    });

    public async execute() {
        Prompts.override({
            featureName: this.featureName,
            branchName: this.branchName,
            from: this.from,
            checkout: this.checkout
        });

        const rootConfig = await this.loadConfig();
        const targetConfigs = await rootConfig.resolveFilteredConfigs({
            included: this.include,
            excluded: this.exclude
        });

        await createHotfix(rootConfig, {
            name: () => this.prompt('featureName', Zod.string().nonempty(), {
                type: 'text',
                message: 'Hotfix Name'
            }),
            from: ({ config }) => this.prompt('from', Zod.string().url(), {
                type: 'text',
                message: `[${Chalk.magenta(config.pathspec)}] From`,
                initial: 'branch://master'
            }),
            branchName: ({ config, fromElement, hotfixName }) => this.prompt('branchName', Zod.string(), {
                type: 'text',
                message: `[${Chalk.magenta(config.pathspec)}] Branch Name`,
                initial: `${fromElement.type === 'support' ? `support/${fromElement.support.name}/` : ''}hotfix/${hotfixName}`
            }),
            configs: ({ configs }) => this.prompt('configs', Zod.string().array().transform(ids => _(ids).map(id => configs.find(c => c.identifier === id)).compact().value()), {
                type: 'multiselect',
                message: 'Select Modules',
                choices: configs.map(c => ({ title: c.pathspec, value: c.identifier, selected: targetConfigs.some(tc => tc.identifier === c.identifier) }))
            }),
            checkout: () => this.prompt('checkout', Zod.boolean(), {
                type: 'confirm',
                message: 'Checkout'
            }),
            stdout: this.context.stdout,
            dryRun: this.dryRun
        });
    }
}
export class CreateCommand extends BaseCommand {
    static paths = [['hotfix', 'create']];

    hotfixName = Option.String('--name', { required: true });
    branchName = Option.String('--branch-name');
    from = Option.String('--from', 'branch://master');

    include = Option.Array('--include');
    exclude = Option.Array('--exclude');

    checkout = Option.Boolean('--checkout', false);

    static usage = Command.Usage({
        description: 'Create hotfix',
        category: 'Hotfix'
    });

    public async execute() {
        const rootConfig = await this.loadConfig();
        const targetConfigs = await rootConfig.resolveFilteredConfigs({
            included: this.include,
            excluded: this.exclude
        });

        await createHotfix(rootConfig, {
            name: async () => this.hotfixName,
            from: () => this.from,
            branchName: ({ fromElement, hotfixName }) => this.branchName ?? `${fromElement.type === 'support' ? `support/${fromElement.support.name}/` : ''}feature/${hotfixName}`,
            configs: () => targetConfigs,
            checkout: () => this.checkout,
            stdout: this.context.stdout,
            dryRun: this.dryRun
        });
    }
}
