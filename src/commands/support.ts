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

const AnswersSchema = Zod.string()
    .transform(value => value.split('=', 2))
    .transform(([pattern, value]) => ({ pattern, value }))
    .array();

export class CreateInteractiveCommand extends BaseCommand {
    static paths = [['support', 'create']];

    include = Option.Array('--include');
    exclude = Option.Array('--exclude');

    answers = Option.Rest();

    static usage = Command.Usage({
        description: 'Create support',
        category: 'Support'
    });

    public async executeCommand() {
        const answers = AnswersSchema.parse(this.answers);

        const rootConfig = await this.loadConfig();
        const targetConfigs = await rootConfig.resolveFilteredConfigs({
            included: this.include,
            excluded: this.exclude
        });

        await createSupport(rootConfig, {
            name: () => this.createOverridablePrompt('supportName', Zod.string().nonempty(), {
                type: 'text',
                message: 'Support Name'
            }, {
                answers
            }),
            from: ({ config }) => this.createOverridablePrompt('from', Zod.string().url(), (initial) => ({
                type: 'text',
                message: `[${Chalk.magenta(config.pathspec)}] From`,
                initial: initial ?? undefined
            }), {
                answers,
                pathspecPrefix: config.pathspec,
                defaultValue: 'branch://master'
            }),
            masterBranchName: ({ config, supportName }) => this.createOverridablePrompt('masterBranchName', Zod.string(), (initial) => ({
                type: 'text',
                message: `[${Chalk.magenta(config.pathspec)}] Master Branch Name`,
                initial: initial ?? undefined
            }), {
                answers,
                pathspecPrefix: config.pathspec,
                defaultValue: `support/${supportName}/master`
            }),
            developBranchName: ({ config, supportName }) => this.createOverridablePrompt('developBranchName', Zod.string(), (initial) => ({
                type: 'text',
                message: `[${Chalk.magenta(config.pathspec)}] Develop Branch Name`,
                initial: initial ?? undefined
            }), {
                answers,
                pathspecPrefix: config.pathspec,
                defaultValue: `support/${supportName}/develop`
            }),
            configs: ({ configs }) => this.createOverridablePrompt('configs', Zod.string().array().transform(ids => _(ids).map(id => configs.find(c => c.identifier === id)).compact().value()), {
                type: 'multiselect',
                message: 'Select Modules',
                choices: configs.map(c => ({ title: c.pathspec, value: c.identifier, selected: targetConfigs.some(tc => tc.identifier === c.identifier) }))
            }, {
                answers
            }),
            checkout: ({ config }) => this.createOverridablePrompt('checkout', Zod.union([ Zod.literal('master'), Zod.literal('develop') ]).nullable().optional(), {
                type: 'select',
                message: `[${Chalk.magenta(config.pathspec)}] Checkout`,
                choices: [
                    { title: 'N/A', value: null },
                    { title: 'Master', value: 'master' },
                    { title: 'Develop', value: 'develop' }
                ]
            }, {
                answers,
                pathspecPrefix: config.pathspec,
                defaultValue: null
            }),
            activate: ({ config }) => this.createOverridablePrompt('activate', Zod.boolean(), {
                type: 'confirm',
                message: `[${Chalk.magenta(config.pathspec)}] Activate`
            }, {
                answers,
                pathspecPrefix: config.pathspec,
                defaultValue: false
            }),
            upstream: ({ config }) => this.createOverridablePrompt('upstream', Zod.string().nullable().transform(v => v ?? undefined), {
                type: 'select',
                message: `[${Chalk.magenta(config.pathspec)}] Upstream`,
                choices: [
                    { title: 'N/A', value: null },
                    ...config.upstreams.map(u => ({ title: u.name, value: u.name }))
                ],
                initial: config.upstreams.length > 0 ? 1 : 0
            }, {
                answers,
                pathspecPrefix: config.pathspec,
                defaultValue: config.upstreams[0]?.name ?? null
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

    public async executeCommand() {
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

export class DeleteInteractiveCommand extends BaseCommand {
    static paths = [['support', 'delete'], ['delete', 'support']];

    include = Option.Array('--include');
    exclude = Option.Array('--exclude');

    static usage = Command.Usage({
        description: 'Delete support',
        category: 'Support'
    });

    public async executeCommand() {
        const rootConfig = await this.loadConfig();

        await deleteSupport(rootConfig, {
            name: async () => this.prompt('supportName', Zod.string().nonempty(), {
                type: 'text',
                message: 'Support Name'
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

    public async executeCommand() {
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
