import * as Stream from 'stream';

import { Config } from './config';

export interface Plugin {
    updateVersion(oldVersion: string | null, newVersion: string, params: {
        config: Config,
        stdout?: Stream.Writable
        dryRun?: boolean;
    }): void | Promise<void>
}

export type PluginHandler = (options: Record<string, unknown>) => Plugin;

export async function loadPlugin(moduleUri: string, options: Record<string, unknown>): Promise<Plugin> {
    const pluginModule = await import(moduleUri);

    if (!pluginModule.default)
        throw new Error('Loaded plugin has no default export');

    return pluginModule.default(options);
}
