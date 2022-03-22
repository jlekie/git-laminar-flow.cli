import { Command, Option } from 'clipanion';
import * as Minimatch from 'minimatch';
import * as Bluebird from 'bluebird';

import * as Chalk from 'chalk';

import * as Path from 'path';
import * as FS from 'fs-extra';

import * as Yaml from 'js-yaml';

import * as Tmp from 'tmp-promise';

import { BaseCommand } from './common';
import { exec, execCmd, ExecOptions } from 'lib/exec';

import { loadConfig, loadV2Config, Config, Release, Hotfix, Support } from 'lib/config';

export class ImportCommand extends BaseCommand {
    static paths = [['config', 'import']];

    targetConfigPath = Option.String('--target-config', 'file://.gitflow.yml');

    // include = Option.Array('--include');
    // exclude = Option.Array('--exclude');

    static usage = Command.Usage({
        description: 'Import config',
        category: 'Config'
    });

    public async execute() {
        const settings = await this.loadSettings();
        const config = await loadV2Config(this.configPath, settings, { stdout: this.context.stdout, dryRun: this.dryRun });
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

export class EditCommand extends BaseCommand {
    static paths = [['config', 'edit']];

    include = Option.Array('--include');
    exclude = Option.Array('--exclude');

    recursive = Option.Boolean('--recursive,-r');

    static usage = Command.Usage({
        description: 'Edit config',
        category: 'Config'
    });

    public async execute() {
        const settings = await this.loadSettings();
        const config = await loadV2Config(this.configPath, settings, { stdout: this.context.stdout, dryRun: this.dryRun });
        const targetConfigs = await config.resolveFilteredConfigs({
            included: this.include ?? [ 'repo://root' ],
            excluded: this.exclude
        });

        const tmpDir = await Tmp.dir({
            unsafeCleanup: true
        });
        const configPath = Path.join(tmpDir.path, '.gitflow.yml');

        for (const config of targetConfigs) {
            if (!this.dryRun) {
                await FS.writeFile(configPath, Yaml.dump(config.toHash()), 'utf8');
                await executeVscodeEdit(configPath, { cwd: config.path, stdout: this.context.stdout, dryRun: this.dryRun });

                const updatedConfig = await loadV2Config(`file://${configPath}`, settings, { stdout: this.context.stdout, cwd: config.path });
                updatedConfig.migrateSource({ sourceUri: config.sourceUri, baseHash: config.baseHash });
                await updatedConfig.saveV2({ stdout: this.context.stdout, dryRun: this.dryRun });

                if (this.recursive) {
                    for (const newConfig of updatedConfig.flattenConfigs().filter(c => c.isNew))
                        await this.cli.run(['config', 'edit', `--config=${newConfig.sourceUri}`, '--recursive']);
                }
            }
        }

        await tmpDir.cleanup();
    }
}

async function executeVscodeEdit(path: string, options: ExecOptions = {}) {
    const termProgram = process.env['TERM_PROGRAM'];
    const termProgramVersion = process.env['TERM_PROGRAM_VERSION'];

    if (!termProgram || termProgram !== 'vscode')
        throw new Error('Required environment variable TERM_PROGRAM missing');
    if (!termProgramVersion)
        throw new Error('Required environment variable TERM_PROGRAM_VERSION missing');

    const vscodeCmd = termProgramVersion.endsWith('-insider') ? 'code-insiders' : 'code';
    await exec(`${vscodeCmd} --wait -r ${path}`, options);
}
