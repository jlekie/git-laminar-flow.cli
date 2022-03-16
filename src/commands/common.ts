import { Command, Option } from 'clipanion';
import * as Chalk from 'chalk';
import * as _ from 'lodash';

import * as Zod from 'zod';

import * as OS from 'os';
import * as Path from 'path';

import * as Prompts from 'prompts';

import { loadSettings } from '../lib/settings';
import { loadV2Config } from '../lib/config';

export abstract class BaseCommand extends Command {
    dryRun = Option.Boolean('--dry-run');
    configPath = Option.String('--config', 'branch://gitflow');
    settingsPath = Option.String('--settings', Path.resolve(OS.homedir(), '.gitflow/cli.yml'));

    abstract execute(): Promise<number | void>;

    protected logVerbose(message: string) {
        this.context.stdout.write(`${Chalk.gray(message)}\n`)
    }
    protected logInfo(message: string) {
        this.context.stdout.write(`${Chalk.blue(message)}\n`)
    }
    protected logWarning(message: string) {
        this.context.stdout.write(`${Chalk.yellow(message)}\n`)
    }
    protected logError(message: string) {
        this.context.stdout.write(`${Chalk.red(message)}\n`)
    }

    protected log(message: string) {
        this.context.stdout.write(`${message}\n`)
    }

    protected async loadSettings() {
        return loadSettings(this.settingsPath);
    }
    protected async loadConfig() {
        const settings = await loadSettings(this.settingsPath);

        return loadV2Config(this.configPath, settings, { stdout: this.context.stdout, dryRun: this.dryRun })
    }

    // protected async prompt<T extends Zod.ZodRawShape>(params: T, promptOptions: Prompts.PromptObject<keyof T & string>) {
    protected prompts<T extends Zod.ZodRawShape>(params: T, prompts: { [K in keyof T]: { prompt: Omit<Prompts.PromptObject<K & string>, 'name'>, handler: () => Zod.infer<T[K]> | undefined } }): Promise<Zod.infer<Zod.ZodObject<T>>>;
    protected async prompts<T extends Zod.ZodRawShape, O>(params: T, prompts: { [K in keyof T]: { prompt: Omit<Prompts.PromptObject<K & string>, 'name'>, handler: () => Zod.infer<T[K]> | undefined } }, transform: (params: Zod.infer<Zod.ZodObject<T>>) => O): Promise<O>;
    protected async prompts<T extends Zod.ZodRawShape, O>(params: T, prompts: { [K in keyof T]: { prompt: Omit<Prompts.PromptObject<K & string>, 'name'>, handler: () => Zod.infer<T[K]> | undefined } }, transform?: (params: Zod.infer<Zod.ZodObject<T>>) => O): Promise<O | Zod.infer<Zod.ZodObject<T>>> {
        const Schema = Zod.object<T>(params);

        const parsedInputs = process.stdout.isTTY
            ? await Prompts(_.map(prompts, (value, key) => ({
                name: key,
                ...value.prompt
            }))).then(value => Schema.parse(value))
            : Schema.parse(_.transform(prompts, (result, value, key) => {
                result[key] = value.handler();
            }, {} as Record<keyof T, unknown>));

        if (transform)
            return transform(parsedInputs);
        else
            return parsedInputs;
    }

    protected async prompt<N extends string, T extends Zod.ZodTypeAny>(name: N, Schema: T, prompt: Omit<Prompts.PromptObject<N>, 'name'>): Promise<Zod.infer<T>> {
        const params = await Prompts({
            ...prompt,
            name
        });

        try {
            return Schema.parse(params[name]);
        }
        catch (err) {
            if (err instanceof Zod.ZodError)
                throw new Error(`Input validation failed: ${err.errors.map(e => e.message).join(', ')}`)
            else
                throw err;
        }
    }
}
