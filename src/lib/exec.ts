import * as Chalk from 'chalk';
import * as ChildProcess from 'child_process';
import * as Stream from 'stream';

import * as Readline from 'readline';

export interface ExecOptions {
    cwd?: string;
    stdout?: Stream.Writable;
    dryRun?: boolean;
}
export interface InputOptions {
    cwd?: string;
    stdin: Stream.Readable;
    stdout?: Stream.Writable;
}

export async function exec(cmd: string, { cwd, stdout, dryRun }: ExecOptions = {}) {
    if (cwd)
        stdout?.write(Chalk.gray(`${cmd} [${cwd}]\n`));
    else
        stdout?.write(Chalk.gray(`${cmd}\n`));

    if (dryRun)
        return;

    const proc = ChildProcess.spawn(cmd, { shell: true, cwd });

    return new Promise<void>((resolve, reject) => {
        proc.stdout.on('data', d => stdout?.write(Chalk.gray(d)));
        proc.stderr.on('data', d => stdout?.write(Chalk.gray(d)));

        proc.on('close', (code) => code !== 0 ? reject(new Error(`${cmd} <${cwd}> Exited with code ${code}`)) : resolve());
        proc.on('error', (err) => reject(err));
    });
}
export async function execCmd(cmd: string, { cwd, stdout, dryRun }: ExecOptions = {}) {
    if (cwd)
        stdout?.write(Chalk.gray(`${cmd} [${cwd}]\n`));
    else
        stdout?.write(Chalk.gray(`${cmd}\n`));

    // if (dryRun)
    //     return '';

    return new Promise<string>((resolve, reject) => {
        ChildProcess.exec(cmd, { cwd }, (err, stdout, stderr) => {
            if (err) {
                reject(err);
                return;
            }

            resolve(stdout.trim());
        });
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