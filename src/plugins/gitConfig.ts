import * as _ from 'lodash';
import * as Bluebird from 'bluebird';
import * as Zod from 'zod';

import * as Path from 'path';
import * as FS from 'fs-extra';
import * as OS from 'os';
import * as Yaml from 'js-yaml';

import * as Minimatch from 'minimatch';

import { Command, Option } from 'clipanion';

import { PluginHandler } from '../lib/plugin';
import { BaseInteractiveCommand } from '../commands/common';

const OptionsSchema = Zod.object({
    manifestPath: Zod.string().optional()
});

const GitManifestSchema = Zod.object({
    configs: Zod.object({
        included: Zod.record(Zod.string(), Zod.union([ Zod.string(), Zod.string().array() ])).default({}).transform(value => _.transform(value, (result, value, key) => {
            result[key] = _.isArray(value) ? value.map(v => v.split(',')) : [ value.split(',') ];
        }, {} as Record<string, string[][]>)),
        values: Zod.record(Zod.string(), Zod.string())
    }).array()
});

const createPlugin: PluginHandler = (options) => {
    const parsedOptions = OptionsSchema.parse(options);
    const manifestPath = parsedOptions.manifestPath ?? Path.resolve(OS.homedir(), '.glf/git.yml')

    return {
        init: async ({ config, stdout, dryRun }) => {
            if (!(await FS.pathExists(manifestPath)))
                return;

            const manifest = await FS.readFile(manifestPath, 'utf8')
                .then(content => Yaml.load(content))
                .then(hash => GitManifestSchema.parse(hash));

            const labels = config.normalizeLabels();

            for (const gitConfig of manifest.configs) {
                if (_.isEmpty(gitConfig.included) || _.every(gitConfig.included, (value, key) => _.some(value, v => v.every(vv => labels[key]?.some(l => Minimatch(l, vv)))))) {
                    for (const key in gitConfig.values) {
                        await config.exec(`git config ${key} "${gitConfig.values[key]}"`, { stdout, dryRun });
                    }
                }
            }
        }
    }
}

export default createPlugin;
