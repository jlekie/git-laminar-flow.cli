import * as Chalk from 'chalk';
import * as ChildProcess from 'child_process';
import * as Stream from 'stream';

export interface ExecOptions {
    cwd?: string;
    stdout?: Stream.Writable;
    dryRun?: boolean;
}

export async function exec(cmd: string, { cwd, stdout, dryRun }: ExecOptions = {}) {
    if (cwd)
        stdout?.write(Chalk.gray(`Executing "${cmd}" [${cwd}]...\n`));
    else
        stdout?.write(Chalk.gray(`Executing "${cmd}"...\n`));

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
    // if (cwd)
    //     stdout?.write(Chalk.gray(`Executing "${cmd}" [${cwd}]...\n`));
    // else
    //     stdout?.write(Chalk.gray(`Executing "${cmd}"...\n`));

    if (dryRun)
        return '';

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