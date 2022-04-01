import { Command, Option } from 'clipanion';
import * as Chalk from 'chalk';
import * as _ from 'lodash';

import * as Zod from 'zod';

import * as OS from 'os';
import * as Path from 'path';

import * as Prompts from 'prompts';

import * as Minimatch from 'minimatch';

import { loadSettings } from 'lib/settings';
import { loadV2Config, getStateValue, loadState } from 'lib/config';
import { Lazy } from 'lib/misc';

export const AnswersSchema = Zod.string()
    .transform(value => value.split('=', 2))
    .transform(([pattern, value]) => ({ pattern, value }))
    .array();

export abstract class BaseCommand extends Command {
    dryRun = Option.Boolean('--dry-run');
    configPath = Option.String('--config');
    settingsPath = Option.String('--settings', Path.resolve(OS.homedir(), '.glf/cli.yml'));

    public async execute() {
        return this.executeCommand().catch(err => {
            if (err instanceof Zod.ZodError)
                this.logError(`Zod validation failure: ${err.stack}`)
            else if (err instanceof Error)
                this.logError(`Command fault: ${err.stack}`)
            else
                this.logError(`Command fault: ${err}`)

            return 2;
        })
    }
    abstract executeCommand(): Promise<number | void>;

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

    protected async resolveConfigPath() {
        const state = await loadState(Path.resolve('.glf', 'state.json'));

        return this.configPath ?? getStateValue(state, 'configUri', 'string');
    }
    protected async loadConfig() {
        const settings = await loadSettings(this.settingsPath);
        const state = await loadState(Path.resolve('.glf', 'state.json'));

        const configPath = this.configPath ?? getStateValue(state, 'configUri', 'string');
        if (!configPath)
            throw new Error('Must specify a config URI');

        return loadV2Config(configPath, settings, { stdout: this.context.stdout, dryRun: this.dryRun })
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
    
        protected prompt<N extends string>(name: N, prompt: Omit<Prompts.PromptObject<N>, 'name'>): Promise<Prompts.Answers<N>>;
        protected prompt<N extends string, T extends Zod.ZodTypeAny>(name: N, Schema: T, prompt: Omit<Prompts.PromptObject<N>, 'name'>): Promise<Zod.infer<T>>;
        protected async prompt<N extends string, T extends Zod.ZodTypeAny>(name: N, ...args: readonly [Omit<Prompts.PromptObject<N>, 'name'>] | readonly [T, Omit<Prompts.PromptObject<N>, 'name'>]): Promise<Zod.infer<T>> {
            const { prompt, Schema } = (() => {
                if (args.length === 1) {
                    return { prompt: args[0], Schema: undefined }
                }
                else if (args.length === 2) {
                    return { prompt: args[1], Schema: args[0] }
                }
                else {
                    throw new Error('Invalid arguments');
                }
            })();
    
            const params = await Prompts({
                ...prompt,
                name,
                stdin: this.context.stdin,
                stdout: this.context.stdout
            });
    
            try {
                if (Schema)
                    return Schema.parse(params[name]);
                else
                    return params[name];
            }
            catch (err) {
                if (err instanceof Zod.ZodError)
                    throw new Error(`Input validation failed (${params[name]}): ${err.errors.map(e => e.message).join(', ')}`)
                else
                    throw err;
            }
        }
}

export abstract class BaseInteractiveCommand extends BaseCommand {
    rawAnswers = Option.Rest({ name: 'answers' });
    defaultAll = Option.Boolean('--default-all');

    #answers = new Lazy(() => AnswersSchema.parse(this.rawAnswers))
    public get answers() {
        return this.#answers.value;
    }

    protected async createOverridablePrompt<T extends Zod.ZodTypeAny, D = Prompts.InitialReturnValue>(name: string, Schema: T, prompt: Omit<Prompts.PromptObject<"from">, "name"> | ((defaultValue?: D) => Omit<Prompts.PromptObject<"from">, "name">), { answers = [], pathspecPrefix, defaultValue }: Partial<{ answers: { pattern: string, value: string }[], pathspecPrefix: string, defaultValue: D }> = {}): Promise<Zod.infer<T>> {
        const allAnswers = _.reverse([ ...this.answers, ...answers ]);
        if (this.defaultAll)
            allAnswers.push({ pattern: '**', value: '<DEFAULT>' });

        const findAnswerValue = (pathspec: string) => {
            const answer = allAnswers.find(a => Minimatch(pathspec, a.pattern));
            if (!answer)
                return;

            const value = (() => {
                if (answer.value === '<DEFAULT>')
                    return defaultValue;
                else if (answer.value === '<TRUE>')
                    return true;
                else if (answer.value === '<FALSE>')
                    return false;
                else if (answer.value === '<NULL>')
                    return null;
                else if (answer.value === '<ASK>')
                    return undefined;
                else
                    return answer.value;
            })();

            if (value !== undefined)
                this.context.stdout.write(Chalk.gray(`Using matching answer value "${value}" for ${pathspec}\n`));

            return value;
        }

        const answerValue = findAnswerValue(pathspecPrefix ? `${pathspecPrefix}/${name}` : name);
        if (answerValue !== undefined) {
            return Schema.parse(answerValue)
        }
        else {
            const promptValue = await this.prompt(name, _.isFunction(prompt) ? prompt(defaultValue ?? undefined) : prompt);
            return Schema.parse(promptValue);
        }
    }
}
