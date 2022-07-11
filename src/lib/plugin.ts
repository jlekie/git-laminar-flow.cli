import * as Stream from 'stream';
import * as Zod from 'zod';

import { Config } from './config';

export interface Plugin {
    init?(params: {
        config: Config,
        stdout?: Stream.Writable
        dryRun?: boolean;
    }): void | Promise<void>;

    updateVersion?(oldVersion: string | null, newVersion: string, params: {
        config: Config,
        stdout?: Stream.Writable
        dryRun?: boolean;
    }): void | Promise<void>;
}

export type PluginHandler = (options: Record<string, unknown>) => Plugin;

const OptionsSchema = Zod.object({
    onInit: Zod.string().array().default([]),
    onUpdateVersion: Zod.string().array().default([])
});

const createExecPlugin: PluginHandler = (options) => {
    const parsedOptions = OptionsSchema.parse(options);

    return {
        init: async ({ config, stdout, dryRun }) => {
            for (const cmd of parsedOptions.onInit)
                await config.exec(cmd, { stdout, dryRun });
        },
        updateVersion: async (oldVersion, newVersion, { config, stdout, dryRun }) => {
            for (const cmd of parsedOptions.onUpdateVersion)
                await config.exec(cmd, { stdout, dryRun });
        }
    }
}

export async function loadPlugin(moduleUri: string, options: Record<string, unknown>): Promise<Plugin> {
    if (moduleUri === 'exec') {
        return createExecPlugin(options);
    }
    else {
        const pluginModule = await import(moduleUri);

        if (!pluginModule.default)
            throw new Error('Loaded plugin has no default export');
    
        return pluginModule.default(options);
    }
}
