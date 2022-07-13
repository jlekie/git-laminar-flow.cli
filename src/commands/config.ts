import { Command, Option } from 'clipanion';
import * as Minimatch from 'minimatch';
import * as Bluebird from 'bluebird';
import * as _ from 'lodash';

import * as Chalk from 'chalk';

import * as Path from 'path';
import * as FS from 'fs-extra';

import * as Yaml from 'js-yaml';

import * as Tmp from 'tmp-promise';

import * as Zod from 'zod';
import { RecursiveConfigSchema } from '@jlekie/git-laminar-flow';

import { BaseCommand } from './common';
import { exec, execCmd, executeEditor, ExecOptions } from '../lib/exec';
import { loadConfig, loadV2Config, Config, Release, Hotfix, Support } from '../lib/config';

export class ImportCommand extends BaseCommand {
    static paths = [['config', 'import']];

    targetConfigPath = Option.String('--target-config', 'file://.gitflow.yml');

    // include = Option.Array('--include');
    // exclude = Option.Array('--exclude');

    static usage = Command.Usage({
        description: 'Import config',
        category: 'Config'
    });

    public async executeCommand() {
        const configPath = await this.resolveConfigPath();
        if (!configPath)
            throw new Error('Must specify a config URI');

        const settings = await this.loadSettings();
        const config = await loadV2Config(configPath, settings, { stdout: this.context.stdout, dryRun: this.dryRun });
        const targetConfig = await loadV2Config(this.targetConfigPath, settings, { stdout: this.context.stdout, dryRun: this.dryRun });

        config.migrateSource({
            sourceUri: this.targetConfigPath,
            baseHash: targetConfig.calculateHash()
        });

        await config.saveV2({ stdout: this.context.stdout, dryRun: this.dryRun });

        // const targetConfigs = await config.resolveFilteredConfigs({
        //     included: this.include,
        //     excluded: this.exclude
        // });

        // for (const config of targetConfigs) {
        //     console.log(config.identifier)
        //     // const configPath = Path.resolve(config.path, '.gitflow.yml');
        //     // if (!await FS.pathExists(configPath))
        //     //     continue;

        //     // const oldConfig = await loadV2Config(`file://${configPath}`, { stdout: this.context.stdout, dryRun: this.dryRun });
        //     // this.context.stdout.write(Chalk.gray(`Reading config from ${configPath}\n`));

        //     // await oldConfig.init({ stdout: this.context.stdout, dryRun: this.dryRun });
        // }

        // for (const config of targetConfigs) {
        //     const configPath = Path.resolve(config.path, '.gitflow.yml');
        //     if (!await FS.pathExists(configPath))
        //         continue;

        //     if (!this.dryRun)
        //         await FS.remove(configPath);
        //     this.context.stdout.write(Chalk.gray(`Config ${configPath} deleted\n`));
        // }
    }
}

async function *resolveUpdatedConfigs(sourceConfigs: Config[], rawConfig: RecursiveConfigSchema): AsyncGenerator<Config> {
    const sourceConfig = sourceConfigs.find(c => c.identifier === rawConfig.identifier);
    if (!sourceConfig)
        throw new Error(`No existing config with matching identifier of "${rawConfig.identifier}"`);

    const config = Config.fromSchema(rawConfig);
    await config.register(sourceConfig.path, sourceConfig.sourceUri, sourceConfig.baseHash, sourceConfig.settings, {

    }, sourceConfig.parentConfig, sourceConfig.parentSubmodule, sourceConfig.pathspec);

    if (sourceConfig.isNew || config.calculateHash() !== config.baseHash)
        yield config;

    for (const submodule of rawConfig.submodules ?? []) {
        if (submodule.config && submodule.url) {
            for await (const config of resolveUpdatedConfigs(sourceConfigs, submodule.config)) {
                yield config;
            }
        }
    }
}

export class EditCommand extends BaseCommand {
    static paths = [['config', 'edit']];

    recursive = Option.Boolean('--recursive,-r');

    static usage = Command.Usage({
        description: 'Edit config',
        category: 'Config'
    });

    public async executeCommand() {
        const configPath = await this.resolveConfigPath();
        if (!configPath)
            throw new Error('Must specify a config URI');

        const settings = await this.loadSettings();
        const config = await loadV2Config(configPath, settings, { verify: false, stdout: this.context.stdout, dryRun: this.dryRun });

        const tmpDir = await Tmp.dir({
            unsafeCleanup: true
        });
        const tmpConfigPath = Path.join(tmpDir.path, '.gitflow.yml');

        await FS.writeFile(tmpConfigPath, Yaml.dump(this.recursive ? config.toRecursiveHash() : config.toHash(), { lineWidth: 120 }), 'utf8');
        this.context.stdout.write(Chalk.yellow('Editing the config is an advanced feature. BE CAREFUL!\n'));
        // await executeVscode(['--wait', '-r', tmpConfigPath], { cwd: config.path, stdout: this.context.stdout });
        await executeEditor(tmpConfigPath, { defaultEditor: settings.defaultEditor, wait: true, cwd: config.path, stdout: this.context.stdout });

        const rawConfig = await FS.readFile(tmpConfigPath, 'utf8')
            .then(content => Yaml.load(content))
            .then(hash => RecursiveConfigSchema.parse(hash));

        for await (const updatedConfig of resolveUpdatedConfigs(config.flattenConfigs(), rawConfig))
            await updatedConfig.saveV2({ stdout: this.context.stdout, dryRun: this.dryRun });

        // const updatedConfig = await loadV2Config(`file://${configPath}`, settings, { stdout: this.context.stdout, cwd: config.path });

        // if (!this.dryRun) {
        //     updatedConfig.migrateSource({ sourceUri: config.sourceUri, baseHash: config.baseHash });
        //     await updatedConfig.saveV2({ stdout: this.context.stdout, dryRun: this.dryRun });

        //     if (this.recursive) {
        //         for (const newConfig of updatedConfig.flattenConfigs().filter(c => c.isNew))
        //             await this.cli.run(['config', 'edit', `--config=${newConfig.sourceUri}`, '--recursive']);
        //     }
        // }

        await tmpDir.cleanup();
    }
}
export class ViewCommand extends BaseCommand {
    static paths = [['config', 'view']];

    recursive = Option.Boolean('--recursive,-r');

    static usage = Command.Usage({
        description: 'View config',
        category: 'Config'
    });

    public async executeCommand() {
        const configPath = await this.resolveConfigPath();
        if (!configPath)
            throw new Error('Must specify a config URI');

        const settings = await this.loadSettings();
        const config = await loadV2Config(configPath, settings, { verify: false, stdout: this.context.stdout, dryRun: this.dryRun });

        const tmpDir = await Tmp.dir({
            unsafeCleanup: true
        });
        const tmpConfigPath = Path.join(tmpDir.path, '.gitflow.yml');

        await FS.writeFile(tmpConfigPath, Yaml.dump(this.recursive ? config.toRecursiveHash() : config.toHash(), { lineWidth: 120 }), 'utf8');
        await executeEditor(tmpConfigPath, { defaultEditor: settings.defaultEditor, cwd: config.path, stdout: this.context.stdout });
    }
}

export class MigrateCommand extends BaseCommand {
    static paths = [['config', 'migrate']];

    include = Option.Array('--include');
    exclude = Option.Array('--exclude');

    uri = Option.String('--uri', { required: true });

    static usage = Command.Usage({
        description: 'Edit config',
        category: 'Config'
    });

    public async executeCommand() {
        const configPath = await this.resolveConfigPath();
        if (!configPath)
            throw new Error('Must specify a config URI');

        const settings = await this.loadSettings();
        const config = await loadV2Config(configPath, settings, { stdout: this.context.stdout, dryRun: this.dryRun });
        const targetConfigs = await config.resolveFilteredConfigs({
            included: this.include ?? [ 'repo://root' ],
            excluded: this.exclude
        });

        for (const config of targetConfigs) {
            if (!this.dryRun) {
                config.migrateSource({ sourceUri: this.uri });
                await config.saveV2({ stdout: this.context.stdout, dryRun: this.dryRun });
            }
        }
    }
}
