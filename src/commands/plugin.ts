import * as _ from 'lodash';
import * as Bluebird from 'bluebird';

import * as Path from 'path';
import * as FS from 'fs-extra';

import * as OS from 'os';

import { Command, Option } from 'clipanion';
import { BaseCommand, BaseInteractiveCommand } from './common';

import { Config } from '../lib/config';
import { loadSettings } from 'lib/settings';

// async function resolveConfigPath() {
//     const sourceUriPath = Path.resolve('.glf', 'source_uri');
//     const sourceUri = await FS.pathExists(sourceUriPath)
//         ? await FS.readFile(sourceUriPath, 'utf8')
//         : undefined;

//     return sourceUri;
// }
// async function loadConfig() {
//     Path.resolve(OS.homedir(), '.glf/cli.yml')
//     const settings = await loadSettings(this.settingsPath);

//     const configPath = await this.resolveConfigPath();
//     if (!configPath)
//         throw new Error('Must specify a config URI');

//     return loadV2Config(configPath, settings, { stdout: this.context.stdout, dryRun: this.dryRun })
// }

// export class PluginCommand extends BaseInteractiveCommand {
//     public async executeCommand() {
//         const config = await this.loadConfig();

//         // return Bluebird.mapSeries(config.integrations, async integration => {
//         //     const plugin = await integration.loadPlugin();
//         //     if (!plugin.registerCommands)
//         //         return;

//         //     return await plugin.registerCommands();
//         // }).then(r => _(r).flatten().compact().value())

//         for (const integration of config.integrations) {
//             const plugin = await integration.loadPlugin();
//             if (!plugin.registerCommands)
//                 return;

//             const pluginCommands = await plugin.registerCommands();
//         }

//         this.context.stdout.write(this.cli.usage(null, { detailed: true }));
//         // this.context.stdout.write(this.cli.error(new Error('test')))
//     }
// }

export function registerPluginCommands() {
//    return Bluebird.mapSeries(config.integrations, async integration => {
//         const plugin = await integration.loadPlugin();
//         if (!plugin.registerCommands)
//             return;

//         return await plugin.registerCommands();
//     }).then(r => _(r).flatten().compact().value());
}
