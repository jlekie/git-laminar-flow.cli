#!/usr/bin/env node
import 'source-map-support/register';

import { Builtins, Cli } from 'clipanion';

import { SubmoduleCommands, FeatureCommands, ReleaseCommands, RepoCommands, HotfixCommands, SupportCommands, ConfigCommands } from './commands';

const [ node, app, ...args ] = process.argv;
const cli = new Cli({
    binaryName: '[ git-laminar-flow, glf ]',
    binaryLabel: 'Git Laminar Flow',
    binaryVersion: '1.0.0'
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

cli.register(SupportCommands.ActivateCommand);

cli.register(ConfigCommands.ImportCommand);
process.stdout.isTTY && cli.register(ConfigCommands.EditCommand);
cli.register(ConfigCommands.ViewCommand);
cli.register(ConfigCommands.MigrateCommand);

cli.register(Builtins.HelpCommand);
cli.register(Builtins.VersionCommand);

cli.runExit(args).catch(err => {
    throw new Error(`Application failed to launch; ${err}`);
});
