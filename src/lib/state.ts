import * as Path from 'path';
import * as FS from 'fs-extra';
import * as Yaml from 'js-yaml';

import * as Chalk from 'chalk';

import * as Zod from 'zod';

export const FeatureSchema = Zod.record(Zod.string(), Zod.boolean());
export const StateSchema = Zod.object({
    features: Zod.record(Zod.string(), FeatureSchema),
    releases: Zod.record(Zod.string(), FeatureSchema),
    hotfixes: Zod.record(Zod.string(), FeatureSchema),
});

// Either load the state from disk if it exists or create a new default state
export async function loadState(path: string) {
    const state = await FS.pathExists(path)
        ? await FS.readFile(path, 'utf8')
            .then(content => Yaml.load(content))
            .then(hash => State.parse(hash))
        : State.createNew();

    return state;
}

export type StateParams = Pick<State, 'features' | 'releases' | 'hotfixes'>;
export class State {
    public features: Record<string, Record<string, boolean>>;
    public releases: Record<string, Record<string, boolean>>;
    public hotfixes: Record<string, Record<string, boolean>>;

    #initialized: boolean = false;

    #pathspec!: string;
    public get pathspec() {
        if (!this.#initialized)
            throw new Error('Not initialized');

        return this.#pathspec;
    }

    public static parse(value: unknown) {
        return this.fromSchema(StateSchema.parse(value));
    }
    public static fromSchema(value: Zod.infer<typeof StateSchema>) {
        const config = new State({
            ...value,
            features: { ...value.features },
            releases: { ...value.releases },
            hotfixes: { ...value.hotfixes }
        });

        return config;
    }

    // Create a new state
    public static createNew() {
        return new State({
            features: {},
            releases: {},
            hotfixes: {}
        });
    }

    public constructor(params: StateParams) {
        this.features = params.features;
        this.releases = params.releases;
        this.hotfixes = params.hotfixes;
    }

    public async register(pathspec: string = 'root') {
        this.#initialized = true;

        this.#pathspec = pathspec;
    }

    public getState(pathspec: string) {

    }

    public async save(path: string) {
        const content = Yaml.dump(this);
        await FS.writeFile(path, content, 'utf8');
    }
}