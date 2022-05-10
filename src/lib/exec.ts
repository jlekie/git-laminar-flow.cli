import * as _ from 'lodash';
import * as Chalk from 'chalk';
import * as ChildProcess from 'child_process';
import * as Stream from 'stream';

import * as Path from 'path';

import * as Readline from 'readline';

import { Settings } from './settings';

export interface ExecOptions {
    cwd?: string;
    stdout?: Stream.Writable;
    dryRun?: boolean;
    echo?: boolean;
}
export interface InputOptions {
    cwd?: string;
    stdin: Stream.Readable;
    stdout?: Stream.Writable;
}

export async function exec(cmd: string, { cwd, stdout, dryRun, echo = true }: ExecOptions = {}) {
    echo && stdout?.write(Chalk.gray(`${Chalk.cyan(cmd)} [${Path.resolve(cwd ?? '.')}]\n`));

    if (dryRun)
        return;

    const proc = ChildProcess.spawn(cmd, { shell: true, cwd });

    return new Promise<void>((resolve, reject) => {
        proc.stdout.on('data', d => stdout?.write(Chalk.gray(d)));
        proc.stderr.on('data', d => stdout?.write(Chalk.gray(d)));

        proc.on('close', (code) => code !== 0 ? reject(new Error(`${cmd} <${Path.resolve(cwd ?? '.')}> Exited with code ${code}`)) : resolve());
        proc.on('error', (err) => reject(err));
    }).catch(err => {
        throw new Error(`Shell exec failed: ${err}`);
    });
}
export async function execCmd(cmd: string, { cwd, stdout, dryRun, echo = true, trim = true }: ExecOptions & { trim?: boolean } = {}) {
    echo && stdout?.write(Chalk.gray(`${Chalk.cyan(cmd)} [${Path.resolve(cwd ?? '.')}]\n`));

    // if (dryRun)
    //     return '';

    return new Promise<string>((resolve, reject) => {
        ChildProcess.exec(cmd, { cwd }, (err, stdout, stderr) => {
            if (err) {
                reject(new Error(`Command "${cmd}" [${cwd}] failed [${err}]`));
                return;
            }

            resolve(trim ? stdout.trim() : stdout);
        });
    }).catch(err => {
        throw new Error(`Shell exec failed: ${err}`);
    });
}

export async function prompt(query: string, { cwd, stdin, stdout }: InputOptions) {
    const rl = Readline.createInterface({
        input: stdin,
        output: stdout,
    });

    return new Promise<string>((resolve, reject) => rl.question(query, ans => {
        rl.close();
        resolve(ans);
    }));
}

export async function executeEditor(path: string, { defaultEditor, wait, ...options }: ExecOptions & { defaultEditor?: 'vscode' | 'vscode-insiders', wait?: boolean } = {}) {
    const editor = (() => {
        if (defaultEditor) {
            return defaultEditor;
        }
        else {
            if (process.env['TERM_PROGRAM'] && process.env['TERM_PROGRAM_VERSION'])
                return process.env['TERM_PROGRAM_VERSION'].endsWith('-insider') ? 'vscode-insiders' : 'vscode';
            else
                throw new Error('Default editor not specified and could not determine default from environment');
        }
    })();

    if (editor === 'vscode' || editor === 'vscode-insiders') {
        const editorExec = editor === 'vscode' ? 'code' : 'code-insiders';
        const inEditor = !!(process.env['TERM_PROGRAM'] && process.env['TERM_PROGRAM_VERSION']);

        const args = [];
        args.push(editorExec);

        if (inEditor)
            args.push('--reuse-window');
        else
            args.push('--new-window');

        if (wait)
            args.push('--wait');

        args.push(path);

        await exec(args.join(' '), options);
    }
}

export async function executeVscode(args: string | string[], options: ExecOptions & { vscodeExec?: string } = {}) {
    args = _.isArray(args) ? args : [ args ];

    const vscodeCmd = options.vscodeExec ?? (() => {
        const termProgram = process.env['TERM_PROGRAM'];
        const termProgramVersion = process.env['TERM_PROGRAM_VERSION'];
    
        if (!termProgram || termProgram !== 'vscode')
            throw new Error('Required environment variable TERM_PROGRAM missing');
        if (!termProgramVersion)
            throw new Error('Required environment variable TERM_PROGRAM_VERSION missing');

        return termProgramVersion.endsWith('-insider') ? 'code-insiders' : 'code';
    })();

    await exec(`${vscodeCmd} ${args.join(' ')}`, options);
}
