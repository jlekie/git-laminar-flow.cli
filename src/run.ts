#!/usr/bin/env node
import 'source-map-support/register';

import { Builtins, Cli } from 'clipanion';

import { SubmoduleCommands, FeatureCommands, ReleaseCommands, RepoCommands } from './commands';

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

cli.register(SubmoduleCommands.CloneCommand);

cli.register(FeatureCommands.CreateCommand);
cli.register(FeatureCommands.CheckoutCommand);
cli.register(FeatureCommands.CommitCommand);
cli.register(FeatureCommands.SyncCommand);
cli.register(FeatureCommands.MergeCommand);
cli.register(FeatureCommands.CloseCommand);

cli.register(ReleaseCommands.CreateCommand);
cli.register(ReleaseCommands.CloseCommand);

cli.register(Builtins.HelpCommand);
cli.register(Builtins.VersionCommand);

cli.runExit(args);