// import { Command, Option } from 'clipanion';
// import * as Chalk from 'chalk';

// import * as Path from 'path';
// import * as FS from 'fs-extra';

// import { BaseCommand } from './common';
// import { init } from '../lib/actions';
// import { loadConfig } from '../lib/config';

// export class InitCommand extends BaseCommand {
//     static paths = [['init']];

//     reposBasePath = Option.String('--repo-base-path')

//     static usage = Command.Usage({
//         description: 'Initialize repo',
//         details: 'This will initialize the repo'
//     });

//     public async execute() {
//         const config = await loadConfig(this.configPath);

//         await config.init({ stdout: this.context.stdout, dryRun: this.dryRun });
//     }
// }