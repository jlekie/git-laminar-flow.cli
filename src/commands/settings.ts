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

import { BaseInteractiveCommand } from './common';
import { exec, execCmd, ExecOptions } from 'lib/exec';

import { loadConfig, loadV2Config, Config, Release, Hotfix, Support } from 'lib/config';
import { executeVscode } from 'lib/exec';

export class InitCommand extends BaseInteractiveCommand {
    static paths = [['settings', 'init']];

    static usage = Command.Usage({
        description: 'Initialize application settings',
        category: 'Settings'
    });

    public async executeCommand() {
        const settings = await this.loadSettings();

        await settings.save(this.settingsPath);
    }
}

export class AddRepoCommand extends BaseInteractiveCommand {
    static paths = [['settings', 'repo', 'add']];

    static usage = Command.Usage({
        description: 'Add GLFS repo',
        category: 'Settings'
    });

    public async executeCommand() {
        const settings = await this.loadSettings();

        const name = await this.createOverridablePrompt('repoName', Zod.string().nonempty(), {
            type: 'text',
            message: 'Repository Name'
        });
        const url = await this.createOverridablePrompt('url', Zod.string().url(), {
            type: 'text',
            message: 'Repository URL'
        });
        const apiKey = await this.createOverridablePrompt('apiKey', Zod.string().optional(), {
            type: 'password',
            message: 'API Key'
        });

        settings.glfsRepositories.push({
            name,
            url,
            apiKey
        });

        await settings.save(this.settingsPath);
    }
}
