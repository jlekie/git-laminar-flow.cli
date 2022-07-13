#!/usr/bin/env node
import 'source-map-support/register';

import * as _ from 'lodash';
import * as Bluebird from 'bluebird';
import { Builtins, Cli, Command, Option } from 'clipanion';

import { SubmoduleCommands, FeatureCommands, ReleaseCommands, RepoCommands, HotfixCommands, SupportCommands, ConfigCommands, SettingsCommands, BaseCommand, registerPluginCommands } from './commands';

const [ node, app, ...args ] = process.argv;

const cli = new Cli({
    binaryName: '[ git-laminar-flow, glf ]',
    binaryLabel: 'Git Laminar Flow',
    binaryVersion: '1.0.0-alpha.12'
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
cli.register(RepoCommands.GenerateSolutionCommand);
process.stdout.isTTY && cli.register(RepoCommands.ViewVersionCommand);
process.stdout.isTTY && cli.register(RepoCommands.SetVersionCommand);
process.stdout.isTTY && cli.register(RepoCommands.IncrementVersionCommand);
process.stdout.isTTY && cli.register(RepoCommands.StampVersionCommand);

// cli.register(SubmoduleCommands.CloneCommand);

process.stdout.isTTY ? cli.register(FeatureCommands.CreateInteractiveCommand) : cli.register(FeatureCommands.CreateCommand);
process.stdout.isTTY ? cli.register(ReleaseCommands.CreateInteractiveCommand) : cli.register(ReleaseCommands.CreateCommand);
process.stdout.isTTY ? cli.register(HotfixCommands.CreateInteractiveCommand) : cli.register(HotfixCommands.CreateCommand);
process.stdout.isTTY ? cli.register(SupportCommands.CreateInteractiveCommand) : cli.register(SupportCommands.CreateCommand);

process.stdout.isTTY && cli.register(FeatureCommands.DeleteInteractiveCommand);
process.stdout.isTTY && cli.register(ReleaseCommands.DeleteInteractiveCommand);
process.stdout.isTTY && cli.register(HotfixCommands.DeleteInteractiveCommand);
process.stdout.isTTY && cli.register(SupportCommands.DeleteInteractiveCommand);

process.stdout.isTTY && cli.register(FeatureCommands.CloseInteractiveCommand);
process.stdout.isTTY && cli.register(ReleaseCommands.CloseInteractiveCommand);

process.stdout.isTTY && cli.register(FeatureCommands.MergeInteractiveCommand);

process.stdout.isTTY && cli.register(FeatureCommands.SyncInteractiveCommand);

process.stdout.isTTY && cli.register(SubmoduleCommands.CreateInteractiveCommand);

cli.register(SupportCommands.ActivateCommand);

cli.register(ConfigCommands.ImportCommand);
process.stdout.isTTY && cli.register(ConfigCommands.EditCommand);
cli.register(ConfigCommands.ViewCommand);
cli.register(ConfigCommands.MigrateCommand);

process.stdout.isTTY && cli.register(SettingsCommands.InitCommand);
process.stdout.isTTY && cli.register(SettingsCommands.AddRepoCommand);

const preCli = new Cli();
preCli.register(class extends BaseCommand {
    args = Option.Proxy();

    public async executeCommand() {
        const config = await this.reloadConfig();
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
    }
});
preCli.run(args).then(() => {
    cli.register(Builtins.HelpCommand);
    cli.register(Builtins.VersionCommand);

    cli.runExit(args).catch(err => {
        throw new Error(`Application failed to launch; ${err}`);
    });
}).catch(err => {
    throw new Error(`Application failed to launch; ${err}`);
});
