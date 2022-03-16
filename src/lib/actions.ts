import * as _ from 'lodash';
import * as Stream from 'stream';

import * as Chalk from 'chalk';

import { Config, Feature, Release, Hotfix, Support, Element } from './config';

export interface CommonParams {
    stdout?: Stream.Writable;
    dryRun?: boolean;
}
export type ActionParam<T, P = void> = void extends P ? () => T | Promise<T> : (params: P) => T | Promise<T>;
export type ActionParams<T> = CommonParams & {
    [K in keyof T]: undefined extends T[K]
        ? (Required<T>[K] extends ActionParam<infer RT, infer PT> ? ActionParam<RT, PT> : () => T[K] | Promise<T[K]>)
        : T[K] extends ActionParam<infer RT, infer PT> ? ActionParam<RT, PT> : () => T[K] | Promise<T[K]>
}

export async function createFeature(rootConfig: Config, { stdout, dryRun, ...params }: ActionParams<{
    name: ActionParam<string>;
    configs: ActionParam<Config[], { configs: Config[] }>;
    from?: ActionParam<string, { config: Config }>;
    branchName: ActionParam<string, { config: Config, fromElement: Element, featureName: string }>;
    checkout?: ActionParam<boolean>
}>) {
    const featureName = await params.name();

    const allConfigs = rootConfig.flattenConfigs();
    const configs = await params.configs({ configs: allConfigs });
    for (const config of configs) {
        if (config.features.some(f => f.name === featureName)) {
            stdout?.write(Chalk.gray(`[${Chalk.magenta(config.pathspec)}] Feature ${featureName} already exists; bypassing`) + '\n');
            continue;
        }

        const from = await params.from?.({ config }) ?? 'branch://develop';
        const fromElement = await config.parseElement(from);
        const fromBranch = await (async () => {
            if (fromElement.type === 'branch')
                return fromElement.branch;
            else if (fromElement.type === 'repo')
                return fromElement.config.resolveCurrentBranch();
            else if (fromElement.type === 'feature')
                return fromElement.feature.branchName;
            else if (fromElement.type === 'release')
                return fromElement.release.branchName;
            else if (fromElement.type === 'hotfix')
                return fromElement.hotfix.branchName;
            else if (fromElement.type === 'support')
                return fromElement.support.developBranchName;
            else
                throw new Error(`Cannot derive source branch from ${from}`);
        })();

        const branchName = await params.branchName({ config, fromElement, featureName });
        const source = fromElement.type === 'support' ? fromElement.support : config;

        const feature = new Feature({
            name: featureName,
            branchName,
            sourceSha: await config.resolveCommitSha(fromBranch)
        });
        source.features.push(feature);
        await feature.register(config, source instanceof Support ? source : undefined);

        await feature.init({ stdout: stdout, dryRun: dryRun });
        await config.save({ stdout: stdout, dryRun: dryRun });

        if (await params.checkout?.())
            await config.checkoutBranch(feature.branchName, { stdout: stdout, dryRun: dryRun });
    }
}

export async function createRelease(rootConfig: Config, { stdout, dryRun, ...params }: ActionParams<{
    name: ActionParam<string>;
    configs: ActionParam<Config[], { configs: Config[] }>;
    from?: ActionParam<string, { config: Config }>;
    branchName: ActionParam<string, { config: Config, fromElement: Element, releaseName: string }>;
    checkout?: ActionParam<boolean>
}>) {
    const releaseName = await params.name();

    const allConfigs = rootConfig.flattenConfigs();
    const configs = await params.configs({ configs: allConfigs });
    for (const config of configs) {
        if (config.releases.some(f => f.name === releaseName)) {
            stdout?.write(Chalk.gray(`[${Chalk.magenta(config.pathspec)}] Release ${releaseName} already exists; bypassing`) + '\n');
            continue;
        }

        const from = await params.from?.({ config }) ?? 'branch://develop';
        const fromElement = await config.parseElement(from);
        const fromBranch = await (async () => {
            if (fromElement.type === 'branch')
                return fromElement.branch;
            else if (fromElement.type === 'repo')
                return fromElement.config.resolveCurrentBranch();
            else if (fromElement.type === 'feature')
                return fromElement.feature.branchName;
            else if (fromElement.type === 'release')
                return fromElement.release.branchName;
            else if (fromElement.type === 'hotfix')
                return fromElement.hotfix.branchName;
            else if (fromElement.type === 'support')
                return fromElement.support.developBranchName;
            else
                throw new Error(`Cannot derive source branch from ${from}`);
        })();

        const branchName = await params.branchName({ config, fromElement, releaseName });
        const source = fromElement.type === 'support' ? fromElement.support : config;

        const release = new Release({
            name: releaseName,
            branchName,
            sourceSha: await config.resolveCommitSha(fromBranch)
        });
        source.releases.push(release);
        await release.register(config, source instanceof Support ? source : undefined);

        await release.init({ stdout: stdout, dryRun: dryRun });
        await config.save({ stdout: stdout, dryRun: dryRun });

        if (await params.checkout?.())
            await config.checkoutBranch(release.branchName, { stdout: stdout, dryRun: dryRun });
    }
}

export async function createHotfix(rootConfig: Config, { stdout, dryRun, ...params }: ActionParams<{
    name: ActionParam<string>;
    configs: ActionParam<Config[], { configs: Config[] }>;
    from?: ActionParam<string, { config: Config }>;
    branchName: ActionParam<string, { config: Config, fromElement: Element, hotfixName: string }>;
    checkout?: ActionParam<boolean>
}>) {
    const hotfixName = await params.name();

    const allConfigs = rootConfig.flattenConfigs();
    const configs = await params.configs({ configs: allConfigs });
    for (const config of configs) {
        if (config.hotfixes.some(f => f.name === hotfixName)) {
            stdout?.write(Chalk.gray(`[${Chalk.magenta(config.pathspec)}] Hotfix ${hotfixName} already exists; bypassing`) + '\n');
            continue;
        }

        const from = await params.from?.({ config }) ?? 'branch://develop';
        const fromElement = await config.parseElement(from);
        const fromBranch = await (async () => {
            if (fromElement.type === 'branch')
                return fromElement.branch;
            else if (fromElement.type === 'repo')
                return fromElement.config.resolveCurrentBranch();
            else if (fromElement.type === 'feature')
                return fromElement.feature.branchName;
            else if (fromElement.type === 'release')
                return fromElement.release.branchName;
            else if (fromElement.type === 'hotfix')
                return fromElement.hotfix.branchName;
            else if (fromElement.type === 'support')
                return fromElement.support.developBranchName;
            else
                throw new Error(`Cannot derive source branch from ${from}`);
        })();

        const branchName = await params.branchName({ config, fromElement, hotfixName });
        const source = fromElement.type === 'support' ? fromElement.support : config;

        const hotfix = new Hotfix({
            name: hotfixName,
            branchName,
            sourceSha: await config.resolveCommitSha(fromBranch)
        });
        source.hotfixes.push(hotfix);
        await hotfix.register(config, source instanceof Support ? source : undefined);

        await hotfix.init({ stdout: stdout, dryRun: dryRun });
        await config.save({ stdout: stdout, dryRun: dryRun });

        if (await params.checkout?.())
            await config.checkoutBranch(hotfix.branchName, { stdout: stdout, dryRun: dryRun });
    }
}

export async function createSupport(rootConfig: Config, { stdout, dryRun, ...params }: ActionParams<{
    name: ActionParam<string>;
    configs: ActionParam<Config[], { configs: Config[] }>;
    from?: ActionParam<string, { config: Config }>;
    masterBranchName: ActionParam<string, { config: Config, supportName: string }>;
    developBranchName: ActionParam<string, { config: Config, supportName: string }>;
    checkout?: ActionParam<'master' | 'develop' | null | undefined>
}>) {
    const supportName = await params.name();

    const allConfigs = rootConfig.flattenConfigs();
    const configs = await params.configs({ configs: allConfigs });
    for (const config of configs) {
        if (config.supports.some(f => f.name === supportName)) {
            stdout?.write(Chalk.gray(`[${Chalk.magenta(config.pathspec)}] Support ${supportName} already exists; bypassing`) + '\n');
            continue;
        }

        const from = await params.from?.({ config }) ?? 'branch://master';
        const fromElement = await config.parseElement(from);
        const fromBranch = await (async () => {
            if (fromElement.type === 'branch')
                return fromElement.branch;
            else if (fromElement.type === 'repo')
                return fromElement.config.resolveCurrentBranch();
            else if (fromElement.type === 'feature')
                return fromElement.feature.branchName;
            else if (fromElement.type === 'release')
                return fromElement.release.branchName;
            else if (fromElement.type === 'hotfix')
                return fromElement.hotfix.branchName;
            else if (fromElement.type === 'support')
                return fromElement.support.developBranchName;
            else
                throw new Error(`Cannot derive source branch from ${from}`);
        })();

        const masterBranchName = await params.masterBranchName({ config, supportName });
        const developBranchName = await params.developBranchName({ config, supportName });

        const support = new Support({
            name: supportName,
            masterBranchName,
            developBranchName,
            sourceSha: await config.resolveCommitSha(fromBranch),
            features: [],
            releases: [],
            hotfixes: []
        });
        config.supports.push(support);
        await support.register(config);

        await support.init({ stdout: stdout, dryRun: dryRun });
        await config.save({ stdout: stdout, dryRun: dryRun });

        const checkout = await params.checkout?.();
        if (checkout === 'develop')
            await config.checkoutBranch(support.developBranchName, { stdout: stdout, dryRun: dryRun });
        else if (checkout === 'master')
            await config.checkoutBranch(support.masterBranchName, { stdout: stdout, dryRun: dryRun });
    }
}
