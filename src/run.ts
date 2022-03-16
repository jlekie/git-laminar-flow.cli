#!/usr/bin/env node
import 'source-map-support/register';

import { Builtins, Cli } from 'clipanion';

import { SubmoduleCommands, FeatureCommands, ReleaseCommands, RepoCommands, HotfixCommands, SupportCommands, ConfigCommands } from './commands';

const [ node, app, ...args ] = process.argv;
const cli = new Cli({
    binaryName: 'git-laminar-flow',
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
cli.register(RepoCommands.CreateCommand);

cli.register(SubmoduleCommands.CloneCommand);

process.stdout.isTTY ? cli.register(FeatureCommands.CreateInteractiveCommand) : cli.register(FeatureCommands.CreateCommand);
cli.register(ReleaseCommands.CreateCommand);
cli.register(HotfixCommands.CreateCommand);
cli.register(SupportCommands.CreateCommand);

cli.register(SupportCommands.ActivateCommand);

cli.register(ConfigCommands.ImportCommand);
cli.register(ConfigCommands.EditCommand);

cli.register(Builtins.HelpCommand);
cli.register(Builtins.VersionCommand);

cli.runExit(args).catch(err => {
    throw new Error(`Application failed to launch; ${err}`);
});
