import * as Bluebird from 'bluebird';
import * as Zod from 'zod';
import * as _ from 'lodash';
import * as Chalk from 'chalk';

import * as Path from 'path';
import * as FS from 'fs-extra';
import * as Yaml from 'js-yaml';

import { Command, Option } from 'clipanion';

import * as Minimatch from 'minimatch';
import * as Toposort from 'toposort';

import { PluginHandler } from '../lib/plugin';
import { BaseInteractiveCommand, OverridablePromptAnswerTypes } from '../commands/common';
import { setVersion, incrementVersion, viewVersion, stampVersion } from '../lib/actions';

const OptionsSchema = Zod.object({
    dependencies: Zod.record(Zod.string(), Zod.string().array()).optional()
});

const createPlugin: PluginHandler = (options) => {
    const { dependencies = {} } = OptionsSchema.parse(options);

    return {
        // init: async ({ config, stdout, dryRun }) => {
        //     const version = config.resolveVersion();
        //     const timestamp = Date.now();

        //     const repos = await Bluebird.mapSeries(config.submodules, async submodule => ({
        //         name: submodule.name,
        //         hash: await submodule.config.resolveCommitSha(parsedOptions.targetBranch ?? 'HEAD', { stdout, dryRun }),
        //         glfHash: await submodule.config.calculateHash()
        //     }));

        //     const manifestContent = Yaml.dump({
        //         version,
        //         timestamp,
        //         repos
        //     });

        //     await FS.outputFile(parsedOptions.snapshotManifestPath, manifestContent, 'utf8');
        // },
        updateVersion: async (oldVersion, newVersion, { config, stdout, dryRun }) => {
            const parentIntegration = config.parentSubmodule && config.parentConfig && config.parentConfig.integrations.find(i => i.plugin === '@jlekie/git-laminar-flow-cli/plugins/versioning');
            if (parentIntegration) {
                const { dependencies = {} } = OptionsSchema.parse(parentIntegration.options);
                // console.log(dependencies)

                const explodedDependencies: [string, string][] = [];
                for (const key in dependencies) {
                    const keyMatches = config.parentConfig.submodules.filter(s => Minimatch(s.name, key)).map(s => s.config.identifier);
                    const valueMatches = config.parentConfig.submodules.filter(s => dependencies[key].some(v => Minimatch(s.name, v))).map(s => s.config.identifier);
    
                    for (const keyMatch of keyMatches)
                        for (const valueMatch of valueMatches)
                            explodedDependencies.push([ keyMatch, valueMatch ]);
                }

                // console.log(explodedDependencies)

                const sortedDependencies = Toposort(explodedDependencies).reverse();

                const targetIds: string[] = []
                const process = (id: string) => {
                    const ids = _.compact(explodedDependencies
                        .filter(d => d[1] === id)
                        .map(d => config.parentConfig?.submodules.find(s => s.config.identifier === d[0])?.config.identifier));

                    for (const id of ids) {
                        if (targetIds.indexOf(id) < 0) {
                            targetIds.push(id);
                            process(id);
                        }
                    }
                }
                process(config.identifier);

                // console.log(explodedDependencies)
                // console.log(explodedDependencies.filter(d => d[1] === config.parentSubmodule?.name))
                // console.log(explodedDependencies.filter(d => d[1] === config.parentSubmodule?.name).map(d => config.parentConfig?.submodules.find(s => s.name === d[0])?.config.identifier))
                // const sortedDependencies = Toposort(explodedDependencies).reverse();
                // console.log(sortedDependencies);

                return _(targetIds)
                    .sortBy(id => sortedDependencies.indexOf(id))
                    .map(id => config.parentConfig?.submodules.find(s => s.config.identifier === id)?.config)
                    .compact()
                    .value();
            }

            return [];
        },
        registerCommands: () => [
            // class ViewVersionCommand extends BaseInteractiveCommand {
            //     static paths = [['version', 'view']];
            
            //     releaseName = Option.String('--name');
            
            //     include = Option.Array('--include');
            //     exclude = Option.Array('--exclude');
            
            //     static usage = Command.Usage({
            //         description: 'View version',
            //         category: 'Version'
            //     });
            
            //     public async executeCommand() {
            //         const rootConfig = await this.loadConfig();
            //         const targetConfigs = await rootConfig.resolveFilteredConfigs({
            //             included: this.include,
            //             excluded: this.exclude
            //         });
            
            //         await viewVersion(rootConfig, {
            //             configs: async ({ configs }) => this.createOverridablePrompt('configs', value => Zod.string().array().transform(ids => _(ids).map(id => configs.find(c => c.identifier === id)).compact().value()).parse(value), (initial) => ({
            //                 type: 'multiselect',
            //                 message: 'Select Modules',
            //                 choices: configs.map(c => ({ title: `${c.pathspec} [${c.resolveVersion()}]`, value: c.identifier, selected: initial?.some(tc => tc === c.identifier) }))
            //             }), {
            //                 answerType: OverridablePromptAnswerTypes.StringArray,
            //                 defaultValue: targetConfigs.map(c => c.identifier)
            //             }),
            //             stdout: this.context.stdout,
            //             dryRun: this.dryRun
            //         });
            //     }
            // },
            // class StampVersionCommand extends BaseInteractiveCommand {
            //     static paths = [['version', 'stamp']];
            
            //     include = Option.Array('--include');
            //     exclude = Option.Array('--exclude');
            
            //     static usage = Command.Usage({
            //         description: 'Stamp version',
            //         category: 'Version'
            //     });
            
            //     public async executeCommand() {
            //         const rootConfig = await this.loadConfig();
            //         const targetConfigs = await rootConfig.resolveFilteredConfigs({
            //             included: this.include,
            //             excluded: this.exclude
            //         });
            
            //         await stampVersion(rootConfig, {
            //             configs: async ({ configs }) => this.createOverridablePrompt('configs', value => Zod.string().array().transform(ids => _(ids).map(id => configs.find(c => c.identifier === id)).compact().value()).parse(value), (initial) => ({
            //                 type: 'multiselect',
            //                 message: 'Select Modules',
            //                 choices: configs.map(c => ({ title: `${c.pathspec} [${c.resolveVersion()}]`, value: c.identifier, selected: initial?.some(tc => tc === c.identifier) }))
            //             }), {
            //                 answerType: OverridablePromptAnswerTypes.StringArray,
            //                 defaultValue: targetConfigs.map(c => c.identifier)
            //             }),
            //             stdout: this.context.stdout,
            //             dryRun: this.dryRun
            //         });
            //     }
            // },
            // class SetVersionCommand extends BaseInteractiveCommand {
            //     static paths = [['version', 'set']];
            
            //     include = Option.Array('--include');
            //     exclude = Option.Array('--exclude');
            
            //     static usage = Command.Usage({
            //         description: 'Set version',
            //         category: 'Version'
            //     });
            
            //     public async executeCommand() {
            //         const rootConfig = await this.loadConfig();
            //         const targetConfigs = await rootConfig.resolveFilteredConfigs({
            //             included: this.include,
            //             excluded: this.exclude
            //         });
            
            //         await setVersion(rootConfig, {
            //             configs: async ({ configs }) => this.createOverridablePrompt('configs', value => Zod.string().array().transform(ids => _(ids).map(id => configs.find(c => c.identifier === id)).compact().value()).parse(value), (initial) => ({
            //                 type: 'multiselect',
            //                 message: 'Select Modules',
            //                 choices: configs.map(c => ({ title: `${c.pathspec} [${c.resolveVersion()}]`, value: c.identifier, selected: initial?.some(tc => tc === c.identifier) }))
            //             }), {
            //                 answerType: OverridablePromptAnswerTypes.StringArray,
            //                 defaultValue: targetConfigs.map(c => c.identifier)
            //             }),
            //             version: ({ config }) => this.createOverridablePrompt('version', value => Zod.string().nullable().transform(v => v || null).parse(value), initial => ({
            //                 type: 'text',
            //                 message: `[${Chalk.magenta(config.pathspec)}] Version`,
            //                 initial
            //             })),
            //             stdout: this.context.stdout,
            //             dryRun: this.dryRun
            //         });
            //     }
            // },
            // class IncrementVersionCommand extends BaseInteractiveCommand {
            //     static paths = [['version', 'increment'], ['increment', 'version']];
            
            //     include = Option.Array('--include');
            //     exclude = Option.Array('--exclude');
            
            //     type = Option.String('--type', 'prerelease', {
            //         description: 'Type type of version increment to use'
            //     });
            //     prereleaseIdentifier = Option.String('--prerelease-identifier', 'alpha', {
            //         description: 'Identifier to use for prerelease versions'
            //     });
            
            //     static usage = Command.Usage({
            //         description: 'Increment version',
            //         category: 'Version'
            //     });
            
            //     public async executeCommand() {
            //         const rootConfig = await this.loadConfig();
            //         const targetConfigs = await rootConfig.resolveFilteredConfigs({
            //             included: this.include,
            //             excluded: this.exclude
            //         });
            
            //         await incrementVersion(rootConfig, {
            //             configs: async ({ configs }) => this.createOverridablePrompt('configs', value => Zod.string().array().transform(ids => _(ids).map(id => configs.find(c => c.identifier === id)).compact().value()).parse(value), (initial) => ({
            //                 type: 'multiselect',
            //                 message: 'Select Modules',
            //                 choices: configs.map(c => ({ title: `${c.pathspec} [${c.resolveVersion()}]`, value: c.identifier, selected: initial?.some(tc => tc === c.identifier) }))
            //             }), {
            //                 answerType: OverridablePromptAnswerTypes.StringArray,
            //                 defaultValue: targetConfigs.map(c => c.identifier)
            //             }),
            //             type: () => this.createOverridablePrompt('type', value => Zod.union([ Zod.literal('major'), Zod.literal('minor'), Zod.literal('patch'), Zod.literal('prerelease'), Zod.literal('premajor'), Zod.literal('preminor'), Zod.literal('prepatch') ]).parse(value), initial => ({
            //                 type: 'select',
            //                 message: 'Release Type',
            //                 choices: [
            //                     { title: 'Prerelease', value: 'prerelease' },
            //                     { title: 'Major', value: 'major' },
            //                     { title: 'Minor', value: 'minor' },
            //                     { title: 'Patch', value: 'patch' },
            //                     { title: 'Premajor', value: 'premajor' },
            //                     { title: 'Preminor', value: 'preminor' },
            //                     { title: 'Prepatch', value: 'prepatch' }
            //                 ],
            //                 initial: initial ? [ 'prerelease', 'major', 'minor', 'patch', 'premajor', 'preminor', 'prepatch' ].indexOf(initial) : 0
            //             }), {
            //                 defaultValue: this.type
            //             }),
            //             prereleaseIdentifier: () => this.createOverridablePrompt('prereleaseIdentifier', value => Zod.string().parse(value), initial => ({
            //                 type: 'text',
            //                 message: 'Prerelease Identifier',
            //                 initial
            //             }), {
            //                 defaultValue: this.prereleaseIdentifier,
            //                 interactivity: 2
            //             }),
            //             stdout: this.context.stdout,
            //             dryRun: this.dryRun
            //         });
            //     }
            // }
        ]
    }
}

export default createPlugin;
