import * as FS from 'fs-extra';
import * as Yaml from 'js-yaml';

import * as Zod from 'zod';

export const GlfsRepositorySchema = Zod.object({
    name: Zod.string(),
    url: Zod.string().url(),
    apiKey: Zod.string().optional()
});
export const SettingsSchema = Zod.object({
    defaultGlfsRepository: Zod.string(),
    glfsRepositories: GlfsRepositorySchema.array().optional(),
    vscodeExec: Zod.string().optional()
});

export class Settings {
    public readonly defaultGlfsRepository: string;
    public readonly glfsRepositories: readonly GlfsRepository[];
    public readonly vscodeExec?: string;

    public static parse(value: unknown) {
        return this.fromSchema(SettingsSchema.parse(value));
    }
    public static fromSchema(value: Zod.infer<typeof SettingsSchema>) {
        return new Settings({
            ...value,
            glfsRepositories: value.glfsRepositories?.map(i => GlfsRepository.parse(i)) ?? []
        });
    }

    public static createNew() {
        return new Settings({
            defaultGlfsRepository: 'default',
            glfsRepositories: []
        });
    }

    public constructor(params: Pick<Settings, 'defaultGlfsRepository' | 'glfsRepositories'> & Partial<Pick<Settings, 'vscodeExec'>>) {
        this.defaultGlfsRepository = params.defaultGlfsRepository;
        this.glfsRepositories = params.glfsRepositories;
        this.vscodeExec = params.vscodeExec;
    }

    public getDefaultRepo() {
        const repo = this.glfsRepositories.find(r => r.name === this.defaultGlfsRepository);
        if (!repo)
            throw new Error(`Default repo ${this.defaultGlfsRepository} not defined`);

        return repo;
    }

    public async save(path: string) {
        const content = Yaml.dump(this);

        await FS.writeFile(path, content, 'utf8');
    }
}
export class GlfsRepository {
    public readonly name: string;
    public readonly url: string;
    public readonly apiKey?: string;

    public static parse(value: unknown) {
        return this.fromSchema(GlfsRepositorySchema.parse(value));
    }
    public static fromSchema(value: Zod.infer<typeof GlfsRepositorySchema>) {
        return new GlfsRepository({
            ...value
        });
    }

    public constructor(params: Pick<GlfsRepository, 'name' | 'url'> & Partial<Pick<GlfsRepository, 'apiKey'>>) {
        this.name = params.name;
        this.url = params.url;
        this.apiKey = params.apiKey;
    }
}

export async function loadSettings(path: string) {
    const config = await FS.pathExists(path)
        ? await FS.readFile(path, 'utf8')
            .then(content => Yaml.load(content))
            .then(hash => Settings.parse(hash))
        : Settings.createNew();

    return config;
}
