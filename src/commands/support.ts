import { Command, Option } from 'clipanion';
import * as Typanion from 'typanion';
import * as Minimatch from 'minimatch';
import * as Bluebird from 'bluebird';
import * as _ from 'lodash';
import * as Zod from 'zod';

import * as Chalk from 'chalk';

import * as Prompts from 'prompts';

import { BaseCommand, BaseInteractiveCommand, AnswersSchema, OverridablePromptAnswerTypes } from './common';

import { loadV2Config, Config, Release, Support } from '../lib/config';
import { createSupport, deleteSupport } from '../lib/actions';

export class CreateInteractiveCommand extends BaseInteractiveCommand {
    static paths = [['support', 'create'], ['create', 'support']];

    include = Option.Array('--include');
    exclude = Option.Array('--exclude');

    supportName = Option.String('--name');

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
            name: () => this.createOverridablePrompt('supportName', value => Zod.string().nonempty().parse(value), initial => ({
                type: 'text',
                message: 'Support Name',
                initial
            }), {
                defaultValue: this.supportName
            }),
            from: ({ config }) => this.createOverridablePrompt('from', value => Zod.string().url().parse(value), (initial) => ({
                type: 'text',
                message: `[${Chalk.magenta(config.pathspec)}] From`,
                initial
            }), {
                pathspecPrefix: config.pathspec,
                defaultValue: 'branch://develop',
                interactivity: 2
            }),
            masterBranchName: ({ config, supportName }) => this.createOverridablePrompt('masterBranchName', value => Zod.string().parse(value), (initial) => ({
                type: 'text',
                message: `[${Chalk.magenta(config.pathspec)}] Master Branch Name`,
                initial
            }), {
                pathspecPrefix: config.pathspec,
                defaultValue: `support/${supportName}/master`,
                interactivity: 2
            }),
            developBranchName: ({ config, supportName }) => this.createOverridablePrompt('developBranchName', value => Zod.string().parse(value), (initial) => ({
                type: 'text',
                message: `[${Chalk.magenta(config.pathspec)}] Develop Branch Name`,
                initial
            }), {
                pathspecPrefix: config.pathspec,
                defaultValue: `support/${supportName}/develop`,
                interactivity: 2
            }),
            configs: async ({ configs }) => this.createOverridablePrompt('configs', value => Zod.string().array().transform(ids => _(ids).map(id => configs.find(c => c.identifier === id)).compact().value()).parse(value), (initial) => ({
                type: 'multiselect',
                message: 'Select Modules',
                choices: configs.map(c => ({ title: c.pathspec, value: c.identifier, selected: initial?.some(tc => tc === c.identifier) }))
            }), {
                defaultValue: targetConfigs.map(c => c.identifier)
            }),
            checkout: ({ config }) => this.createOverridablePrompt('checkout', value => Zod.union([ Zod.literal('master'), Zod.literal('develop') ]).nullable().optional().parse(value), initial => ({
                type: 'select',
                message: `[${Chalk.magenta(config.pathspec)}] Checkout`,
                choices: [
                    { title: 'N/A', value: null },
                    { title: 'Master', value: 'master' },
                    { title: 'Develop', value: 'develop' }
                ],
                initial: initial ? [ null, 'master', 'develop' ].indexOf(initial) : 0
            }), {
                pathspecPrefix: config.pathspec,
                defaultValue: 'develop',
                interactivity: 2
            }),
            activate: ({ config }) => this.createOverridablePrompt('activate', value => Zod.boolean().parse(value), {
                type: 'confirm',
                message: `[${Chalk.magenta(config.pathspec)}] Activate`
            }, {
                pathspecPrefix: config.pathspec,
                defaultValue: true,
                interactivity: 2,
                answerType: OverridablePromptAnswerTypes.Boolean
            }),
            upstream: ({ config }) => this.createOverridablePrompt('upstream', value => Zod.string().nullable().transform(v => v ?? undefined).parse(value), (initial) => ({
                type: 'select',
                message: `[${Chalk.magenta(config.pathspec)}] Upstream`,
                choices: [
                    { title: 'N/A', value: null },
                    ...config.upstreams.map(u => ({ title: u.name, value: u.name }))
                ],
                initial: config.upstreams.findIndex(u => u.name === initial) + 1
            }), {
                pathspecPrefix: config.pathspec,
                defaultValue: config.upstreams[0]?.name ?? null,
                interactivity: 2
            }),
            stdout: this.context.stdout,
            dryRun: this.dryRun
        });
    }
}
export class SyncCommand extends BaseInteractiveCommand {
    static paths = [['support', 'create'], ['create', 'support']];

    include = Option.Array('--include');
    exclude = Option.Array('--exclude');

    supportName = Option.String('--name');

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
            name: () => this.createOverridablePrompt('supportName', value => Zod.string().nonempty().parse(value), initial => ({
                type: 'text',
                message: 'Support Name',
                initial
            }), {
                defaultValue: this.supportName
            }),
            from: ({ config }) => this.createOverridablePrompt('from', value => Zod.string().url().parse(value), (initial) => ({
                type: 'text',
                message: `[${Chalk.magenta(config.pathspec)}] From`,
                initial
            }), {
                pathspecPrefix: config.pathspec,
                defaultValue: 'branch://master',
                interactivity: 2
            }),
            masterBranchName: ({ config, supportName }) => this.createOverridablePrompt('masterBranchName', value => Zod.string().parse(value), (initial) => ({
                type: 'text',
                message: `[${Chalk.magenta(config.pathspec)}] Master Branch Name`,
                initial
            }), {
                pathspecPrefix: config.pathspec,
                defaultValue: `support/${supportName}/master`,
                interactivity: 2
            }),
            developBranchName: ({ config, supportName }) => this.createOverridablePrompt('developBranchName', value => Zod.string().parse(value), (initial) => ({
                type: 'text',
                message: `[${Chalk.magenta(config.pathspec)}] Develop Branch Name`,
                initial
            }), {
                pathspecPrefix: config.pathspec,
                defaultValue: `support/${supportName}/develop`,
                interactivity: 2
            }),
            configs: async ({ configs }) => this.createOverridablePrompt('configs', value => Zod.string().array().transform(ids => _(ids).map(id => configs.find(c => c.identifier === id)).compact().value()).parse(value), (initial) => ({
                type: 'multiselect',
                message: 'Select Modules',
                choices: configs.map(c => ({ title: c.pathspec, value: c.identifier, selected: initial?.some(tc => tc === c.identifier) }))
            }), {
                defaultValue: targetConfigs.map(c => c.identifier)
            }),
            checkout: ({ config }) => this.createOverridablePrompt('checkout', value => Zod.union([ Zod.literal('master'), Zod.literal('develop') ]).nullable().optional().parse(value), initial => ({
                type: 'select',
                message: `[${Chalk.magenta(config.pathspec)}] Checkout`,
                choices: [
                    { title: 'N/A', value: null },
                    { title: 'Master', value: 'master' },
                    { title: 'Develop', value: 'develop' }
                ],
                initial: initial ? [ null, 'master', 'develop' ].indexOf(initial) : 0
            }), {
                pathspecPrefix: config.pathspec,
                defaultValue: 'develop',
                interactivity: 2
            }),
            activate: ({ config }) => this.createOverridablePrompt('activate', value => Zod.boolean().parse(value), {
                type: 'confirm',
                message: `[${Chalk.magenta(config.pathspec)}] Activate`
            }, {
                pathspecPrefix: config.pathspec,
                defaultValue: true,
                interactivity: 2
            }),
            upstream: ({ config }) => this.createOverridablePrompt('upstream', value => Zod.string().nullable().transform(v => v ?? undefined).parse(value), (initial) => ({
                type: 'select',
                message: `[${Chalk.magenta(config.pathspec)}] Upstream`,
                choices: [
                    { title: 'N/A', value: null },
                    ...config.upstreams.map(u => ({ title: u.name, value: u.name }))
                ],
                initial: config.upstreams.findIndex(u => u.name === initial) + 1
            }), {
                pathspecPrefix: config.pathspec,
                defaultValue: config.upstreams[0]?.name ?? null,
                interactivity: 2
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

export class DeleteInteractiveCommand extends BaseInteractiveCommand {
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
    static paths = [
        ['support', 'set-active'],
        ['support', 'set']
    ];

    name = Option.String('--name');

    include = Option.Array('--include');
    exclude = Option.Array('--exclude');

    checkout = Option.String('--checkout', { tolerateBoolean: true });

    static usage = Command.Usage({
        description: 'Set active support',
        category: 'Support'
    });

    public async executeCommand() {
        const config = await this.loadConfig();
        const targetConfigs = await config.resolveFilteredConfigs({
            included: this.include,
            excluded: this.exclude
        });

        for (const config of targetConfigs) {
            const support = await config.trySetActiveSupport(this.name);

            if (support) {
                if (this.checkout === true || this.checkout === 'develop')
                    await config.checkoutBranch(support.developBranchName, { stdout: this.context.stdout, dryRun: this.dryRun });
                else if (this.checkout === 'master')
                    await config.checkoutBranch(support.masterBranchName, { stdout: this.context.stdout, dryRun: this.dryRun });
            }
            else {
                if (this.checkout === true || this.checkout === 'develop')
                    await config.checkoutBranch(config.resolveDevelopBranchName(), { stdout: this.context.stdout, dryRun: this.dryRun });
                else if (this.checkout === 'master')
                    await config.checkoutBranch(config.resolveMasterBranchName(), { stdout: this.context.stdout, dryRun: this.dryRun });
            }
        }
    }
}
