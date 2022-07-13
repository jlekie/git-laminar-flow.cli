import { Command, Option } from 'clipanion';
import * as Minimatch from 'minimatch';
import * as Bluebird from 'bluebird';
import * as _ from 'lodash';
import * as Zod from 'zod';

import * as Chalk from 'chalk';

import * as Prompts from 'prompts';

import { BaseCommand, BaseInteractiveCommand } from './common';

import { loadV2Config, Config, Release, Hotfix, Support } from '../lib/config';
import { createHotfix, deleteHotfix } from '../lib/actions';

export class CreateInteractiveCommand extends BaseInteractiveCommand {
    static paths = [['hotfix', 'create']];

    featureName = Option.String('--name');
    branchName = Option.String('--branch-name');
    from = Option.String('--from');

    include = Option.Array('--include');
    exclude = Option.Array('--exclude');

    checkout = Option.Boolean('--checkout');
    intermediate = Option.Boolean('--intermediate');

    static usage = Command.Usage({
        description: 'Create hotfix',
        category: 'Hotfix'
    });

    public async executeCommand() {
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
            from: ({ config, activeSupport }) => this.prompt('from', Zod.string().url(), {
                type: 'text',
                message: `[${Chalk.magenta(config.pathspec)}] From`,
                initial: activeSupport ? `support://${activeSupport}/master` : 'branch://master'
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
            checkout: ({ config }) => this.prompt('checkout', Zod.boolean(), {
                type: 'confirm',
                message: `[${Chalk.magenta(config.pathspec)}] Checkout`,
            }),
            upstream: ({ config }) => this.prompt('upstream', Zod.string().nullable().transform(v => v ?? undefined), {
                type: 'select',
                message: `[${Chalk.magenta(config.pathspec)}] Upstream`,
                choices: [
                    { title: 'N/A', value: null },
                    ...config.upstreams.map(u => ({ title: u.name, value: u.name }))
                ],
                initial: config.upstreams.length > 0 ? 1 : 0
            }),
            intermediate: () => this.intermediate,
            stdout: this.context.stdout,
            dryRun: this.dryRun
        });
    }
}
export class CreateCommand extends BaseCommand {
    static paths = [['hotfix', 'create']];

    hotfixName = Option.String('--name', { required: true });
    branchName = Option.String('--branch-name');
    from = Option.String('--from');

    include = Option.Array('--include');
    exclude = Option.Array('--exclude');

    checkout = Option.Boolean('--checkout', false);

    static usage = Command.Usage({
        description: 'Create hotfix',
        category: 'Hotfix'
    });

    public async executeCommand() {
        const rootConfig = await this.loadConfig();
        const targetConfigs = await rootConfig.resolveFilteredConfigs({
            included: this.include,
            excluded: this.exclude
        });

        await createHotfix(rootConfig, {
            name: async () => this.hotfixName,
            from: ({ activeSupport }) => this.from ?? (activeSupport ? `support://${activeSupport}/master` : 'branch://master'),
            branchName: ({ fromElement, hotfixName }) => this.branchName ?? `${fromElement.type === 'support' ? `support/${fromElement.support.name}/` : ''}feature/${hotfixName}`,
            configs: () => targetConfigs,
            checkout: () => this.checkout,
            stdout: this.context.stdout,
            dryRun: this.dryRun
        });
    }
}

export class DeleteInteractiveCommand extends BaseInteractiveCommand {
    static paths = [['hotfix', 'delete']];

    include = Option.Array('--include');
    exclude = Option.Array('--exclude');

    static usage = Command.Usage({
        description: 'Delete hotfix',
        category: 'Hotfix'
    });

    public async executeCommand() {
        const rootConfig = await this.loadConfig();

        await deleteHotfix(rootConfig, {
            name: () => this.prompt('hotfixName', Zod.string().nonempty(), {
                type: 'text',
                message: 'Hotfix Name'
            }),
            configs: ({ configs }) => this.prompt('configs', Zod.string().array().transform(ids => _(ids).map(id => configs.find(c => c.identifier === id)).compact().value()), {
                type: 'multiselect',
                message: 'Select Modules',
                choices: configs.map(c => ({ title: c.pathspec, value: c.identifier, selected: true }))
            }),
            stdout: this.context.stdout,
            dryRun: this.dryRun
        });
    }
}
