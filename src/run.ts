#!/usr/bin/env node
import 'source-map-support/register';

import { Builtins, Cli } from 'clipanion';

import { InitCommand, SubmoduleCommands, FeatureCommands, ReleaseCommands, RepoCommands } from './commands';

const [ node, app, ...args ] = process.argv;
const cli = new Cli({
    binaryName: 'git-laminar-flow',
    binaryLabel: 'Git Laminar Flow',
    binaryVersion: '1.0.0'
});

cli.register(InitCommand)
cli.register(SubmoduleCommands.CloneCommand);

cli.register(FeatureCommands.CreateCommand);
cli.register(FeatureCommands.CheckoutCommand);
cli.register(FeatureCommands.SyncCommand);
cli.register(FeatureCommands.MergeCommand);
cli.register(FeatureCommands.CloseCommand);

cli.register(ReleaseCommands.CreateCommand);
cli.register(ReleaseCommands.CloseCommand);

cli.register(RepoCommands.CheckoutCommand);
cli.register(RepoCommands.FetchCommand);

cli.register(Builtins.HelpCommand);
cli.register(Builtins.VersionCommand);

cli.runExit(args);