import * as Bluebird from 'bluebird';
import * as Zod from 'zod';

import * as Path from 'path';
import * as FS from 'fs-extra';
import * as Yaml from 'js-yaml';

import { Command, Option } from 'clipanion';

import { PluginHandler } from '../lib/plugin';
import { BaseInteractiveCommand } from '../commands/common';

const OptionsSchema = Zod.object({
    snapshotManifestPath: Zod.string(),
    targetBranch: Zod.string().optional()
});

const SnapshotManifestSchema = Zod.object({
    version: Zod.string(),
    timestamp: Zod.number().int(),
    repos: Zod.object({
        name: Zod.string(),
        hash: Zod.string(),
        glfHash: Zod.string()
    }).array()
});

const createPlugin: PluginHandler = (options) => {
    const parsedOptions = OptionsSchema.parse(options);

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
        // updateVersion: async (oldVersion, newVersion, { config, stdout, dryRun }) => {
        // }
        registerCommands: () => [
            class SnapshotCommand extends BaseInteractiveCommand {
                static paths = [['repo', 'snapshot']]
                static usage = Command.Usage({
                    description: 'Create a snapshot manifest',
                    category: 'Snapshot'
                });

                snapshotManifestPath = Option.String('--path', parsedOptions.snapshotManifestPath);
                targetBranch = Option.String('--branch', parsedOptions.targetBranch ?? 'HEAD');

                public async executeCommand() {
                    const config = await this.loadConfig();

                    const snapshotManifestPath = Path.resolve(this.snapshotManifestPath);

                    const version = config.resolveVersion();
                    const timestamp = Date.now();

                    const repos = await Bluebird.mapSeries(config.submodules, async submodule => ({
                        name: submodule.name,
                        hash: await submodule.config.resolveCommitSha(this.targetBranch, { stdout: this.context.stdout, dryRun: this.dryRun }),
                        glfHash: submodule.config.calculateHash()
                    }));

                    const manifestContent = Yaml.dump({
                        version,
                        timestamp,
                        repos
                    });

                    await FS.outputFile(snapshotManifestPath, manifestContent, 'utf8');
                    this.context.stdout?.write(`Snapshot manifest written to ${snapshotManifestPath}\n`);
                }
            },
            class RestoreCommand extends BaseInteractiveCommand {
                static paths = [['repo', 'restore']]
                static usage = Command.Usage({
                    description: 'Restore from a snapshot manifest',
                    category: 'Snapshot'
                });

                snapshotManifestPath = Option.String('--path', parsedOptions.snapshotManifestPath);

                public async executeCommand() {
                    const config = await this.loadConfig();

                    const snapshotManifestPath = Path.resolve(this.snapshotManifestPath);
                    const snapshotManifest = await FS.readFile(snapshotManifestPath, 'utf8')
                        .then(Yaml.load)
                        .then(SnapshotManifestSchema.parse);

                    for (const repo of snapshotManifest.repos) {
                        const submodule = config.submodules.find(s => s.name === repo.name);
                        if (!submodule)
                            continue;

                        await submodule.config.checkoutBranch(repo.hash, { stdout: this.context.stdout, dryRun: this.dryRun });
                    }
                }
            }
        ]
    }
}

export default createPlugin;
