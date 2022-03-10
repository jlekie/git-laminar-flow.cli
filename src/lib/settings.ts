import * as FS from 'fs-extra';
import * as Yaml from 'js-yaml';

import * as Zod from 'zod';

export const GlfsRepositorySchema = Zod.object({
    name: Zod.string(),
    url: Zod.string().url()
});
export const SettingsSchema = Zod.object({
    glfsRepositories: GlfsRepositorySchema.array().optional()
});

export class Settings {
    public readonly glfsRepositories: readonly GlfsRepository[];

    public static parse(value: unknown) {
        return this.fromSchema(SettingsSchema.parse(value));
    }
    public static fromSchema(value: Zod.infer<typeof SettingsSchema>) {
        return new Settings({
            glfsRepositories: value.glfsRepositories?.map(i => GlfsRepository.parse(i)) ?? []
        });
    }

    public static createNew() {
        return new Settings({
            glfsRepositories: []
        });
    }

    public constructor(params: Pick<Settings, 'glfsRepositories'>) {
        this.glfsRepositories = params.glfsRepositories;
    }

    public async save(path: string) {
        const content = Yaml.dump(this);

        await FS.writeFile(path, content, 'utf8');
    }
}
export class GlfsRepository {
    public readonly name: string;
    public readonly url: string;

    public static parse(value: unknown) {
        return this.fromSchema(GlfsRepositorySchema.parse(value));
    }
    public static fromSchema(value: Zod.infer<typeof GlfsRepositorySchema>) {
        return new GlfsRepository({
            name: value.name,
            url: value.url
        });
    }

    public constructor(params: Pick<GlfsRepository, 'name' | 'url'>) {
        this.name = params.name;
        this.url = params.url;
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