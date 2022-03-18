import { Command, Option } from 'clipanion';
import * as Typanion from 'typanion';
import * as Minimatch from 'minimatch';
import * as Bluebird from 'bluebird';
import * as _ from 'lodash';
import * as Zod from 'zod';

import * as Chalk from 'chalk';

import * as Prompts from 'prompts';

import { BaseCommand } from './common';

import { loadV2Config, Config, Release, Support } from 'lib/config';
import { createSupport, deleteSupport } from 'lib/actions';

export class CreateInteractiveCommand extends BaseCommand {
    static paths = [['support', 'create']];

    supportName = Option.String('--name');
    masterBranchName = Option.String('--master-branch-name');
    developBranchName = Option.String('--develop-branch-name');
    from = Option.String('--from');

    include = Option.Array('--include');
    exclude = Option.Array('--exclude');

    checkout = Option.String('--checkout', { validator: Typanion.isOneOf([ Typanion.isLiteral('master'), Typanion.isLiteral('develop') ]) });

    static usage = Command.Usage({
        description: 'Create support',
        category: 'Support'
    });

    public async execute() {
        Prompts.override({
            supportName: this.supportName,
            masterBranchName: this.masterBranchName,
            developBranchName: this.developBranchName,
            from: this.from,
            checkout: this.checkout
        });

        const rootConfig = await this.loadConfig();
        const targetConfigs = await rootConfig.resolveFilteredConfigs({
            included: this.include,
            excluded: this.exclude
        });

        await createSupport(rootConfig, {
            name: () => this.prompt('supportName', Zod.string().nonempty(), {
                type: 'text',
                message: 'Support Name'
            }),
            from: ({ config }) => this.prompt('from', Zod.string().url(), {
                type: 'text',
                message: `[${Chalk.magenta(config.pathspec)}] From`,
                initial: 'branch://master'
            }),
            masterBranchName: ({ config, supportName }) => this.prompt('masterBranchName', Zod.string(), {
                type: 'text',
                message: `[${Chalk.magenta(config.pathspec)}] Master Branch Name`,
                initial: `support/${supportName}/master`
            }),
            developBranchName: ({ config, supportName }) => this.prompt('developBranchName', Zod.string(), {
                type: 'text',
                message: `[${Chalk.magenta(config.pathspec)}] Develop Branch Name`,
                initial: `support/${supportName}/develop`
            }),
            configs: ({ configs }) => this.prompt('configs', Zod.string().array().transform(ids => _(ids).map(id => configs.find(c => c.identifier === id)).compact().value()), {
                type: 'multiselect',
                message: 'Select Modules',
                choices: configs.map(c => ({ title: c.pathspec, value: c.identifier, selected: targetConfigs.some(tc => tc.identifier === c.identifier) }))
            }),
            checkout: ({ config }) => this.prompt('checkout', Zod.union([ Zod.literal('master'), Zod.literal('develop') ]).nullable().optional(), {
                type: 'select',
                message: `[${Chalk.magenta(config.pathspec)}] Checkout`,
                choices: [
                    { title: 'N/A', value: null },
                    { title: 'Master', value: 'master' },
                    { title: 'Develop', value: 'develop' }
                ]
            }),
            activate: ({ config }) => this.prompt('activate', Zod.boolean(), {
                type: 'confirm',
                message: `[${Chalk.magenta(config.pathspec)}] Activate`
            }),
            stdout: this.context.stdout,
            dryRun: this.dryRun
        });
    }
}
export class CreateCommand extends BaseCommand {
    static paths = [['support', 'create']];

    supportName = Option.String('--name', { required: true });
    masterBranchName = Option.String('--master-branch-name');
    developBranchName = Option.String('--develop-branch-name');
    from = Option.String('--from', 'master');

    include = Option.Array('--include');
    exclude = Option.Array('--exclude');

    checkout = Option.String('--checkout', { validator: Typanion.isOneOf([ Typanion.isLiteral('master'), Typanion.isLiteral('develop') ]) });

    static usage = Command.Usage({
        description: 'Create support',
        category: 'Support'
    });

    public async execute() {
        const rootConfig = await this.loadConfig();
        const targetConfigs = await rootConfig.resolveFilteredConfigs({
            included: this.include,
            excluded: this.exclude
        });

        await createSupport(rootConfig, {
            name: async () => this.supportName,
            from: () => this.from,
            masterBranchName: ({ supportName }) => this.masterBranchName ?? `support/${supportName}/master`,
            developBranchName: ({ supportName }) => this.developBranchName ?? `support/${supportName}/develop`,
            configs: () => targetConfigs,
            checkout: () => this.checkout,
            stdout: this.context.stdout,
            dryRun: this.dryRun
        });
    }
}

export class DeleteCommand extends BaseCommand {
    static paths = [['support', 'delete']];

    supportName = Option.Rest({ required: 1 });

    include = Option.Array('--include');
    exclude = Option.Array('--exclude');

    static usage = Command.Usage({
        description: 'Delete support',
        category: 'Support'
    });

    public async execute() {
        const rootConfig = await this.loadConfig();
        const targetConfigs = await rootConfig.resolveFilteredConfigs({
            included: this.include,
            excluded: this.exclude
        });

        await deleteSupport(rootConfig, {
            name: async () => this.supportName[0],
            configs: () => targetConfigs,
            stdout: this.context.stdout,
            dryRun: this.dryRun
        });
    }
}

export class ActivateCommand extends BaseCommand {
    static paths = [['support', 'set-active']];

    name = Option.String('--name', { required: true });

    include = Option.Array('--include');
    exclude = Option.Array('--exclude');

    checkout = Option.String('--checkout');

    static usage = Command.Usage({
        description: 'Create support',
        category: 'Support'
    });

    public async execute() {
        const config = await this.loadConfig();
        const targetConfigs = await config.resolveFilteredConfigs({
            included: this.include,
            excluded: this.exclude
        });

        const featureFqn = config.resolveFeatureFqn(this.name);

        for (const config of targetConfigs) {
            const support = config.supports.find(f => f.name === featureFqn)
            if (!support)
                continue;

            await config.setStateValue('activeSupport', featureFqn);

            if (this.checkout === 'develop')
                await config.checkoutBranch(support.developBranchName, { stdout: this.context.stdout, dryRun: this.dryRun });
            else if (this.checkout === 'master')
                await config.checkoutBranch(support.masterBranchName, { stdout: this.context.stdout, dryRun: this.dryRun });
        }
    }
}
