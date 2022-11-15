#!/usr/bin/env node
import 'source-map-support/register';

import * as _ from 'lodash';
import * as Bluebird from 'bluebird';
import { Builtins, Cli, Command, Option } from 'clipanion';
import * as Minimist from 'minimist';
import * as Zod from 'zod';
import * as Path from 'path';
import * as OS from 'os';

import { SubmoduleCommands, FeatureCommands, ReleaseCommands, RepoCommands, HotfixCommands, SupportCommands, ConfigCommands, SettingsCommands, BaseCommand, registerPluginCommands, reloadConfig } from './commands';

const [ node, app, ...args ] = process.argv;

const cli = new Cli({
    binaryName: '[ git-laminar-flow, glf ]',
    binaryLabel: 'Git Laminar Flow',
    binaryVersion: '1.0.0-alpha.29'
});

cli.register(RepoCommands.InitCommand)
cli.register(RepoCommands.CheckoutCommand);
cli.register(RepoCommands.FetchCommand);
cli.register(RepoCommands.ExecCommand);
cli.register(RepoCommands.StatusCommand);
cli.register(RepoCommands.SyncCommand);
cli.register(RepoCommands.CloseCommand);
cli.register(RepoCommands.ListCommand);
cli.register(RepoCommands.ResetStateCommand);
cli.register(RepoCommands.CommitCommand);
cli.register(RepoCommands.CreateWorkspaceCommand);
cli.register(RepoCommands.OpenWorkspaceCommand);
// cli.register(RepoCommands.GenerateSolutionCommand);
cli.register(RepoCommands.ViewVersionCommand);
cli.register(RepoCommands.SetVersionCommand);
cli.register(RepoCommands.IncrementVersionCommand);
cli.register(RepoCommands.StampVersionCommand);
cli.register(RepoCommands.SetDependenciesCommand);
cli.register(RepoCommands.ListDependentsCommand);

// cli.register(SubmoduleCommands.CloneCommand);

cli.register(FeatureCommands.CreateInteractiveCommand);
cli.register(ReleaseCommands.CreateInteractiveCommand);
cli.register(HotfixCommands.CreateInteractiveCommand);
cli.register(SupportCommands.CreateInteractiveCommand);

cli.register(FeatureCommands.DeleteInteractiveCommand);
cli.register(ReleaseCommands.DeleteInteractiveCommand);
cli.register(HotfixCommands.DeleteInteractiveCommand);
cli.register(SupportCommands.DeleteInteractiveCommand);

cli.register(FeatureCommands.CloseInteractiveCommand);
cli.register(ReleaseCommands.CloseInteractiveCommand);

cli.register(FeatureCommands.MergeInteractiveCommand);

cli.register(FeatureCommands.SyncInteractiveCommand);

cli.register(SubmoduleCommands.CreateInteractiveCommand);

cli.register(SupportCommands.ActivateCommand);

cli.register(ConfigCommands.ImportCommand);
cli.register(ConfigCommands.EditCommand);
cli.register(ConfigCommands.ViewCommand);
cli.register(ConfigCommands.MigrateCommand);

cli.register(SettingsCommands.InitCommand);
cli.register(SettingsCommands.AddRepoCommand);

const PreArgsSchema = Zod.object({
    cwd: Zod.string().optional(),
    config: Zod.string().optional(),
    settings: Zod.string().default(Path.resolve(OS.homedir(), '.glf/cli.yml'))
});

// const passthroughArgs: string[] = [];
// console.log(args)
const preArgs = PreArgsSchema.parse(Minimist(args, {
    string: [ 'cwd' ],
    // unknown: (arg) => {
    //     passthroughArgs.push(arg);
    //     return false;
    // }
}));
(async () => {
    if (preArgs.cwd)
        process.chdir(preArgs.cwd);

    const config = await reloadConfig(preArgs.settings).catch(() => null)
    if (!config)
        return;

    const pluginCommands = await Bluebird.mapSeries(config.integrations, async integration => {
        const plugin = await integration.loadPlugin();
        if (!plugin.registerCommands)
            return;

        return await plugin.registerCommands();
    }).then(r => _(r).flatten().compact().value());

    for (const PluginCommand of pluginCommands)
        cli.register(PluginCommand);
})().then(async () => {
    cli.register(Builtins.HelpCommand);
    cli.register(Builtins.VersionCommand);

    await cli.runExit(args);
}).catch(err => {
    throw new Error(`Application failed to launch; ${err}`);
});

// const preCli = new Cli({
//     binaryName: '[ git-laminar-flow, glf ]',
//     binaryLabel: 'Git Laminar Flow',
//     binaryVersion: '1.0.0-alpha.12'
// });
// preCli.register(class Test extends Command {
//     config = Option.String('--config');
//     args = Option.Proxy();

//     public async execute() {
//         // console.log(this.args)
//         console.log(this.config)
//     }

//     // public async executeCommand() {
//     //     console.log(this.args)
//     //     console.log(this.configPath)
//     //     // if (this.cwd)
//     //     //     process.chdir(this.cwd);

//     //     const config = await this.reloadConfig();
//     //     if (!config)
//     //         return;

//     //     const pluginCommands = await Bluebird.mapSeries(config.integrations, async integration => {
//     //         const plugin = await integration.loadPlugin();
//     //         if (!plugin.registerCommands)
//     //             return;

//     //         return await plugin.registerCommands();
//     //     }).then(r => _(r).flatten().compact().value());

//     //     for (const PluginCommand of pluginCommands)
//     //         cli.register(PluginCommand);
//     // }
// });
// preCli.run(args).then(() => {
//     cli.register(Builtins.HelpCommand);
//     cli.register(Builtins.VersionCommand);

//     cli.runExit(args).catch(err => {
//         throw new Error(`Application failed to launch; ${err}`);
//     });
// }).catch(err => {
//     throw new Error(`Application failed to launch; ${err}`);
// });
