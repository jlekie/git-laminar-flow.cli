import * as _ from 'lodash';
import * as Bluebird from 'bluebird';
import * as Stream from 'stream';

import * as Path from 'path';
import * as FS from 'fs-extra';

import * as Chalk from 'chalk';

import * as Semver from 'semver';

import { Config, Feature, Release, Hotfix, Support, Element, iterateTopologicallyNonMapped, iterateTopologicallyMapped, Submodule, TagTemplate, MessageTemplate } from './config';

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
export type ActionParamResult<T> = T extends (...args: any) => any ? ReturnType<T> : T;
export type ActionParamResults<T> = {
    [K in keyof T]: Awaited<ActionParamResult<T[K]>>;
}

async function resolveFromArtifacts(config: Config, from: string) {
    const fromElement = await config.parseElement(from);
    const fromBranch = await (async () => {
        if (fromElement.type === 'branch')  {
            if (fromElement.branch === 'master')
                return config.resolveMasterBranchName();
            else if (fromElement.branch === 'develop')
                return config.resolveDevelopBranchName();
            else
                return fromElement.branch;
        }
        else if (fromElement.type === 'repo')
            return fromElement.config.resolveCurrentBranch();
        else if (fromElement.type === 'feature')
            return fromElement.feature.branchName;
        else if (fromElement.type === 'release')
            return fromElement.release.branchName;
        else if (fromElement.type === 'hotfix')
            return fromElement.hotfix.branchName;
        else if (fromElement.type === 'support')
            return fromElement.targetBranch === 'master' ? fromElement.support.masterBranchName : fromElement.support.developBranchName;
        else
            throw new Error(`Cannot derive source branch from ${from}`);
    })();

    return [ fromElement, fromBranch ] as const;
}

export async function createFeature(rootConfig: Config, { stdout, dryRun, ...params }: ActionParams<{
    name: ActionParam<string>;
    configs: ActionParam<Config[], { configs: Config[] }>;
    from?: ActionParam<string, { config: Config, activeSupport?: Support }>;
    branchName: ActionParam<string, { config: Config, fromElement: Element, featureName: string }>;
    checkout?: ActionParam<boolean, { config: Config }>;
    upstream?: ActionParam<string | undefined, { config: Config }>;
    shadow?: ActionParam<boolean, { config: Config }>;
}>) {
    const featureName = await params.name();

    const allConfigs = rootConfig.flattenConfigs().filter(c => c.managed);
    const configs = await params.configs({ configs: allConfigs });

    await Bluebird.map(Bluebird.mapSeries(configs, async config => {
        const activeSupport = await config.resolveActiveSupport();
        const from = await params.from?.({ config, activeSupport }) ?? 'branch://develop';
        const [ fromElement, fromBranch ] = await resolveFromArtifacts(config, from);

        return {
            config,
            branchName: await params.branchName({ config, featureName, fromElement }),
            from,
            upstream: await params.upstream?.({ config }),
            checkout: await params.checkout?.({ config }),
            shadow: await params.shadow?.({ config })
        };
    }), async ({ config, from, branchName, upstream, checkout, shadow }) => {
        if (config.features.some(f => f.name === featureName)) {
            stdout?.write(Chalk.gray(`[${Chalk.magenta(config.pathspec)}] Feature ${featureName} already exists; bypassing`) + '\n');
            return;
        }

        const [ fromElement, fromBranch ] = await resolveFromArtifacts(config, from);

        const source = fromElement.type === 'support' ? fromElement.support : config;

        const feature = new Feature({
            name: featureName,
            branchName,
            sourceSha: await config.resolveCommitSha(fromBranch),
            upstream
        }, shadow);
        source.features.push(feature);
        await feature.register(config, source instanceof Support ? source : undefined);

        await feature.init({ stdout: stdout, dryRun: dryRun });
        await config.save({ stdout: stdout, dryRun: dryRun });

        if (checkout)
            await config.checkoutBranch(feature.branchName, { stdout: stdout, dryRun: dryRun });
    });
}
export async function createRelease(rootConfig: Config, { stdout, dryRun, ...params }: ActionParams<{
    name: ActionParam<string>;
    configs: ActionParam<Config[], { configs: Config[] }>;
    from?: ActionParam<string, { config: Config, activeSupport?: Support }>;
    branchName: ActionParam<string, { config: Config, fromElement: Element, releaseName: string }>;
    checkout?: ActionParam<boolean, { config: Config }>;
    intermediate?: ActionParam<boolean | undefined, { config: Config }>;
    upstream?: ActionParam<string | undefined, { config: Config }>;
    shadow?: ActionParam<boolean, { config: Config }>;
}>) {
    const releaseName = await params.name();

    const allConfigs = rootConfig.flattenConfigs().filter(c => c.managed);
    const configs = await params.configs({ configs: allConfigs });

    await Bluebird.map(Bluebird.mapSeries(configs, async config => {
        const activeSupport = await config.resolveActiveSupport();
        const from = await params.from?.({ config, activeSupport }) ?? 'branch://develop';
        const [ fromElement, fromBranch ] = await resolveFromArtifacts(config, from);

        return {
            config,
            branchName: await params.branchName({ config, releaseName, fromElement }),
            from,
            upstream: await params.upstream?.({ config }),
            intermediate: await params.intermediate?.({ config }),
            checkout: await params.checkout?.({ config }),
            shadow: await params.shadow?.({ config })
        };
    }), async ({ config, from, branchName, upstream, checkout, intermediate, shadow }) => {
        if (config.releases.some(f => f.name === releaseName)) {
            stdout?.write(Chalk.gray(`[${Chalk.magenta(config.pathspec)}] Release ${releaseName} already exists; bypassing`) + '\n');
            return;
        }

        const [ fromElement, fromBranch ] = await resolveFromArtifacts(config, from);

        const source = fromElement.type === 'support' ? fromElement.support : config;

        const release = new Release({
            name: releaseName,
            branchName,
            sourceSha: await config.resolveCommitSha(fromBranch),
            upstream,
            intermediate
        }, shadow);
        source.releases.push(release);
        await release.register(config, source instanceof Support ? source : undefined);

        await release.init({ stdout: stdout, dryRun: dryRun });
        await config.save({ stdout: stdout, dryRun: dryRun });

        if (checkout)
            await config.checkoutBranch(release.branchName, { stdout: stdout, dryRun: dryRun });
    });

    // for (const config of configs) {
    //     if (config.releases.some(f => f.name === releaseName)) {
    //         stdout?.write(Chalk.gray(`[${Chalk.magenta(config.pathspec)}] Release ${releaseName} already exists; bypassing`) + '\n');
    //         continue;
    //     }

    //     const activeSupport = await config.getStateValue('activeSupport', 'string');

    //     const from = await params.from?.({ config, activeSupport }) ?? 'branch://develop';
    //     const [ fromElement, fromBranch ] = await resolveFromArtifacts(config, from);

    //     const branchName = await params.branchName({ config, fromElement, releaseName });
    //     const source = fromElement.type === 'support' ? fromElement.support : config;

    //     const release = new Release({
    //         name: releaseName,
    //         branchName,
    //         sourceSha: await config.resolveCommitSha(fromBranch),
    //         upstream: await params.upstream?.({ config }),
    //         intermediate: await params.intermediate?.({ config })
    //     });
    //     source.releases.push(release);
    //     await release.register(config, source instanceof Support ? source : undefined);

    //     await release.init({ stdout: stdout, dryRun: dryRun });
    //     await config.save({ stdout: stdout, dryRun: dryRun });

    //     if (await params.checkout?.({ config }))
    //         await config.checkoutBranch(release.branchName, { stdout: stdout, dryRun: dryRun });
    // }
}
export async function createHotfix(rootConfig: Config, { stdout, dryRun, ...params }: ActionParams<{
    name: ActionParam<string>;
    configs: ActionParam<Config[], { configs: Config[] }>;
    from?: ActionParam<string, { config: Config, activeSupport?: Support }>;
    branchName: ActionParam<string, { config: Config, fromElement: Element, hotfixName: string }>;
    checkout?: ActionParam<boolean, { config: Config }>;
    intermediate?: ActionParam<boolean | undefined, { config: Config }>;
    upstream?: ActionParam<string | undefined, { config: Config }>;
    shadow?: ActionParam<boolean, { config: Config }>;
}>) {
    const hotfixName = await params.name();

    const allConfigs = rootConfig.flattenConfigs().filter(c => c.managed);
    const configs = await params.configs({ configs: allConfigs });
    for (const config of configs) {
        if (config.hotfixes.some(f => f.name === hotfixName)) {
            stdout?.write(Chalk.gray(`[${Chalk.magenta(config.pathspec)}] Hotfix ${hotfixName} already exists; bypassing`) + '\n');
            continue;
        }

        const activeSupport = await config.resolveActiveSupport();
        const from = await params.from?.({ config, activeSupport }) ?? 'branch://develop';
        const [ fromElement, fromBranch ] = await resolveFromArtifacts(config, from);

        const branchName = await params.branchName({ config, fromElement, hotfixName });
        const source = fromElement.type === 'support' ? fromElement.support : config;

        const shadow = await params.shadow?.({ config })

        const hotfix = new Hotfix({
            name: hotfixName,
            branchName,
            sourceSha: await config.resolveCommitSha(fromBranch),
            upstream: await params.upstream?.({ config }),
            intermediate: await params.intermediate?.({ config })
        }, shadow);
        source.hotfixes.push(hotfix);
        await hotfix.register(config, source instanceof Support ? source : undefined);

        await hotfix.init({ stdout: stdout, dryRun: dryRun });
        await config.save({ stdout: stdout, dryRun: dryRun });

        if (await params.checkout?.({ config }))
            await config.checkoutBranch(hotfix.branchName, { stdout: stdout, dryRun: dryRun });
    }
}
export async function createSupport(rootConfig: Config, { stdout, dryRun, ...params }: ActionParams<{
    name: ActionParam<string>;
    configs: ActionParam<Config[], { configs: Config[] }>;
    from?: ActionParam<string, { config: Config }>;
    masterBranchName: ActionParam<string, { config: Config, supportName: string }>;
    developBranchName: ActionParam<string, { config: Config, supportName: string }>;
    checkout?: ActionParam<'master' | 'develop' | null | undefined, { config: Config }>;
    activate?: ActionParam<boolean, { config: Config }>;
    upstream?: ActionParam<string | undefined, { config: Config }>;
}>) {
    const supportName = await params.name();

    const allConfigs = rootConfig.flattenConfigs().filter(c => c.managed);
    const configs = await params.configs({ configs: allConfigs });

    await Bluebird.mapSeries(Bluebird.mapSeries(configs, async config => ({
        config,
        masterBranchName: await params.masterBranchName({ config, supportName }),
        developBranchName: await params.developBranchName({ config, supportName }),
        from: await params.from?.({ config }) ?? 'branch://master',
        upstream: await params.upstream?.({ config }),
        checkout: await params.checkout?.({ config }),
        activate: await params.activate?.({ config })
    })), async ({ config, from, masterBranchName, developBranchName, upstream, checkout, activate }) => {
        if (config.supports.some(f => f.name === supportName)) {
            stdout?.write(Chalk.gray(`[${Chalk.magenta(config.pathspec)}] Support ${supportName} already exists; bypassing`) + '\n');
            return;
        }

        const [ fromElement, fromBranch ] = await resolveFromArtifacts(config, from);

        const support = new Support({
            name: supportName,
            masterBranchName,
            developBranchName,
            sourceSha: await config.resolveCommitSha(fromBranch),
            upstream,
            features: [],
            releases: [],
            hotfixes: []
        });
        config.supports.push(support);
        await support.register(config);

        await support.initNew({ stdout: stdout, dryRun: dryRun });

        // await support.init({ stdout: stdout, dryRun: dryRun });
        // await config.save({ stdout: stdout, dryRun: dryRun });

        // if (checkout === 'develop')
        //     await config.checkoutBranch(support.developBranchName, { stdout: stdout, dryRun: dryRun, retries: 3 });
        // else if (checkout === 'master')
        //     await config.checkoutBranch(support.masterBranchName, { stdout: stdout, dryRun: dryRun, retries: 3 });

        // if (activate)
        //     await config.setStateValue('activeSupport', supportName);
    });
}

// export async function syncSupport(rootConfig: Config, { stdout, dryRun, ...params }: ActionParams<{
//     name: ActionParam<string, { supports: string[] }>;
//     configs: ActionParam<Config[], { configs: Config[] }>;
// }>) {
//     const supports = await Bluebird.map(rootConfig.flattenConfigs(), config => config.supports)
//         .then(supports => _(supports).flatten().map(r => r.name).uniq().value());

//     const supportName = await params.name({ supports });

//     const allConfigs = await Bluebird.filter(rootConfig.flattenConfigs(), c => c.hasElement(`support://${supportName}`));
//     if (!allConfigs.length)
//         return;
    
//     const configs = await params.configs({ configs: allConfigs });
//     for (const config of configs) {
//         const { support } = await config.findElement('support', supportName);

//         if (await config.resolveCurrentBranch({ stdout, dryRun }) === support.branchName)
//             await config.checkoutBranch(config.resolveDevelopBranchName(), { stdout, dryRun });

//         if (await config.branchExists(feature.branchName, { stdout, dryRun }))
//             await config.deleteBranch(feature.branchName, { stdout, dryRun });

//         if (!dryRun)
//             await (feature.parentSupport ?? feature.parentConfig).deleteFeature(feature);

//         await config.save({ stdout: stdout, dryRun: dryRun });
//     }
// }

export async function deleteFeature(rootConfig: Config, { stdout, dryRun, ...params }: ActionParams<{
    name: ActionParam<string, { features: string[] }>;
    configs: ActionParam<Config[], { configs: Config[] }>;
}>) {
    const features = await Bluebird.map(rootConfig.flattenConfigs(), config => config.features)
        .then(features => _(features).flatten().map(r => r.name).uniq().value());

    const featureName = await params.name({ features });

    const allConfigs = await Bluebird.filter(rootConfig.flattenConfigs(), c => c.hasElement(`feature://${featureName}`));
    if (!allConfigs.length)
        return;
    
    const configs = await params.configs({ configs: allConfigs });
    for (const config of configs) {
        const { feature } = await config.findElement('feature', featureName);

        if (await config.resolveCurrentBranch({ stdout, dryRun }) === feature.branchName)
            await config.checkoutBranch(config.resolveDevelopBranchName(), { stdout, dryRun });

        if (await config.branchExists(feature.branchName, { stdout, dryRun }))
            await config.deleteBranch(feature.branchName, { stdout, dryRun });

        if (!dryRun)
            await (feature.parentSupport ?? feature.parentConfig).deleteFeature(feature);

        await config.save({ stdout: stdout, dryRun: dryRun });
    }
}
export async function deleteRelease(rootConfig: Config, { stdout, dryRun, ...params }: ActionParams<{
    name: ActionParam<string, { releases: string[] }>;
    configs: ActionParam<Config[], { configs: Config[] }>;
}>) {
    const releases = await Bluebird.map(rootConfig.flattenConfigs(), config => config.releases)
        .then(releases => _(releases).flatten().map(r => r.name).uniq().value());
    if (!releases.length) {
        stdout?.write(Chalk.yellow('No releases exist to delete\n'));
        return;
    }

    const releaseName = await params.name({ releases });

    const allConfigs = await Bluebird.filter(rootConfig.flattenConfigs(), c => c.hasElement(`release://${releaseName}`));
    if (!allConfigs.length)
        return;

    const configs = await params.configs({ configs: allConfigs });
    for (const config of configs) {
        const { release } = await config.findElement('release', releaseName);

        if (await config.resolveCurrentBranch({ stdout, dryRun }) === release.branchName)
            await config.checkoutBranch(config.resolveDevelopBranchName(), { stdout, dryRun });

        if (await config.branchExists(release.branchName, { stdout, dryRun }))
            await config.deleteBranch(release.branchName, { stdout, dryRun });

        if (!dryRun)
            await (release.parentSupport ?? release.parentConfig).deleteRelease(release);

        await config.save({ stdout: stdout, dryRun: dryRun });
    }
}
export async function deleteHotfix(rootConfig: Config, { stdout, dryRun, ...params }: ActionParams<{
    name: ActionParam<string>;
    configs: ActionParam<Config[], { configs: Config[] }>;
}>) {
    const hotfixName = await params.name();

    const allConfigs = await Bluebird.filter(rootConfig.flattenConfigs(), c => c.hasElement(`hotfix://${hotfixName}`));
    if (!allConfigs.length)
        return;
    
    const configs = await params.configs({ configs: allConfigs });
    for (const config of configs) {
        const { hotfix } = await config.findElement('hotfix', hotfixName);

        if (await config.resolveCurrentBranch({ stdout, dryRun }) === hotfix.branchName)
            await config.checkoutBranch(config.resolveDevelopBranchName(), { stdout, dryRun });

        if (await config.branchExists(hotfix.branchName, { stdout, dryRun }))
            await config.deleteBranch(hotfix.branchName, { stdout, dryRun });

        if (!dryRun)
            await (hotfix.parentSupport ?? hotfix.parentConfig).deleteHotfix(hotfix);

        await config.save({ stdout: stdout, dryRun: dryRun });
    }
}
export async function deleteSupport(rootConfig: Config, { stdout, dryRun, ...params }: ActionParams<{
    name: ActionParam<string>;
    configs: ActionParam<Config[], { configs: Config[] }>;
}>) {
    const supportName = await params.name();

    const allConfigs = await Bluebird.filter(rootConfig.flattenConfigs(), c => c.hasElement(`support://${supportName}`));

    if (!allConfigs.length)
        return;

    const configs = await params.configs({ configs: allConfigs });
    for (const config of configs) {
        const { support } = await config.findElement('support', supportName);

        if ([ support.masterBranchName, support.developBranchName ].indexOf(await config.resolveCurrentBranch({ stdout, dryRun })) >= 0)
            await config.checkoutBranch(config.resolveDevelopBranchName(), { stdout, dryRun });

        if (await config.branchExists(support.masterBranchName, { stdout, dryRun }))
            await config.deleteBranch(support.masterBranchName, { stdout, dryRun });
        if (await config.branchExists(support.developBranchName, { stdout, dryRun }))
            await config.deleteBranch(support.developBranchName, { stdout, dryRun });

        if (!dryRun)
            await config.deleteSupport(support);

        await config.save({ stdout: stdout, dryRun: dryRun });
    }
}

export async function closeFeature(rootConfig: Config, { stdout, dryRun, ...params }: ActionParams<{
    name: ActionParam<string, { features: string[] }>;
    features: ActionParam<Feature[], { features: Feature[] }>;
    confirm?: ActionParam<boolean, { message: string }>;
    abort: ActionParam<boolean, { config: Config }>;
    deleteLocalBranch?: ActionParam<boolean, { config: Config }>;
    deleteRemoteBranch?: ActionParam<boolean, { config: Config }>;
}>) {
    const allFeatures = _.flatMap(rootConfig.flattenConfigs(), c => c.features);

    const featureName = await params.name({
        features: _(allFeatures).map(f => f.name).uniq().value()
    });

    const features = await params.features({
        features: _(allFeatures).filter(f => f.name === featureName).value()
    });

    let failedMerges = [];
    do {
        failedMerges = await Bluebird.mapSeries(features, async feature => {
            const config = feature.parentConfig;

            try {
                if (await config.getStateValue([ feature.stateKey, 'closing', 'merge' ], 'boolean')) {
                    stdout?.write(Chalk.gray(`[${Chalk.magenta(config.pathspec)}] Feature already closed; bypassing...\n`));
                    return;
                }

                const commitMessage = feature.resolveCommitMessageTemplate()({
                    featureName: feature.name
                });

                if (await config.isDirty({ stdout }))
                    throw new Error(`Cannot merge, please commit all outstanding changes`);

                await config.swapCheckout((feature.parentSupport ?? config).resolveDevelopBranchName(), async () => {
                    await config.merge(feature.branchName, { squash: true, stdout, dryRun }).catch(async err => {
                        if (await FS.pathExists(Path.join(config.path, '.git/SQUASH_MSG')))
                            await FS.writeFile(Path.join(config.path, '.git/SQUASH_MSG'), commitMessage);

                        throw new Error(`Could not merge changes; ${err}`);
                        // if (params.confirm) {
                        //     while (await config.isMergeInProgress({ stdout }))
                        //         await params.confirm?.({ config, message: 'Continue with merge' });
                        // }
                        // else {
                        //     throw new Error(`Could not merge changes; ${err}`);
                        // }
                    });

                    if (await config.hasStagedChanges({ stdout, dryRun }))
                        await config.commit(commitMessage, { stdout, dryRun });
                });

                !dryRun && await config.setStateValue([ feature.stateKey, 'closing', 'merge' ], true);
            }
            catch (err) {
                return { config, err };
            }
        }).then(v => _.compact(v));

        if (failedMerges.length > 0) {
            stdout?.write(`Errors occurred during merge\n${failedMerges.map(({ config, err }) => `  [${Chalk.magenta(config.pathspec)}] ${err.toString()}\n`)}`);
            if (!await params.confirm?.({ message: 'Continue with merge?' }))
                throw new Error('User aborted merge');
        }
    } while (failedMerges.length > 0)

    // const features = await Bluebird.map(rootConfig.flattenConfigs(), config => config.features)
    //     .then(features => _(features).flatten().map(r => r.name).uniq().value());

    // const featureName = await params.name({ features });

    // const allConfigs = rootConfig.flattenConfigs();
    // const applicableConfigs = await Bluebird.filter(rootConfig.flattenConfigs(), c => c.hasElement(`feature://${featureName}`));
    // if (!applicableConfigs.length)
    //     return;

    // // const parentHasFeature = (c: Config) => {
    // //     let count = 0;
    // //     if (c.features.some(f => f.name == featureName))
    // //         count++;

    // //     if (c.parentConfig)
    // //         count += parentHasFeature(c.parentConfig);

    // //     return count;
    // // }

    // const configs = await params.configs({ configs: applicableConfigs });
    // for await (const groupedConfigs of iterateTopologicallyNonMapped(allConfigs, (item, parent) => item.parentConfig === parent, {
    //     filter: c => configs.indexOf(c) >= 0
    // })) {
    //     // console.log(groupedConfigs.map(c => c.pathspec))
    //     // for (const config of groupedConfigs) {
    //     //     console.log(config.pathspec)
    //     // }

    //     for (const config of groupedConfigs) {
    //         const { feature } = await config.findElement('feature', featureName);

    //         !dryRun && await config.setStateValue('activeClosingFeature', feature.uri);

    //         if (!params.abort({ config })) {
    //             const commitMessage = feature.resolveCommitMessageTemplate()({
    //                 featureName: feature.name
    //             });

    //             if (!await config.getStateValue([ feature.stateKey, 'closing', 'develop' ], 'boolean')) {
    //                 if (await config.isDirty({ stdout }))
    //                     throw new Error(`Cannot merge, please commit all outstanding changes`);

    //                 await config.checkoutBranch(feature.parentSupport?.developBranchName ?? config.resolveDevelopBranchName(), { stdout, dryRun });
    //                 if (await config.isDirty({ stdout }))
    //                     throw new Error(`Cannot merge, develop has uncommited or staged changes`);

    //                 await config.merge(feature.branchName, { squash: true, stdout, dryRun }).catch(async err => {
    //                     if (await FS.pathExists(Path.join(config.path, '.git/SQUASH_MSG')))
    //                         await FS.writeFile(Path.join(config.path, '.git/SQUASH_MSG'), commitMessage);

    //                     if (params.confirm) {
    //                         while (await config.isMergeInProgress({ stdout }))
    //                             await params.confirm?.({ config, message: 'Continue with merge' });
    //                     }
    //                     else {
    //                         throw new Error(`Could not merge changes; ${err}`);
    //                     }
    //                 });

    //                 if (await config.hasStagedChanges({ stdout, dryRun }))
    //                     await config.commit(commitMessage, { stdout, dryRun });

    //                 !dryRun && await config.setStateValue([ feature.stateKey, 'closing', 'develop' ], true);
    //             }
    //         }

    //         // if (await config.branchExists(feature.branchName, { stdout, dryRun }) && await params.deleteLocalBranch?.({ config }))
    //         //     await config.deleteBranch(feature.branchName, { stdout, dryRun });

    //         // if (await config.remoteBranchExists(feature.branchName, 'origin', { stdout, dryRun }) && await params.deleteRemoteBranch?.({ config }))
    //         //     await config.deleteRemoteBranch(feature.branchName, 'origin', { stdout, dryRun });

    //         // if (!dryRun)
    //         //     await (feature.parentSupport ?? feature.parentConfig).deleteFeature(feature);

    //         await config.save({ stdout: stdout, dryRun: dryRun });
    //     }
    // }
    // // for (const config of _.orderBy(configs, c => parentHasFeature(c), 'desc')) {
    // //     if (await config.hasNestedElement(`feature://${featureName}`)) {
    // //         stdout?.write('Submodules contain unclosed feature\n');
    // //         continue;
    // //     }

    // //     const { feature } = await config.findElement('feature', featureName);

    // //     !dryRun && await config.setStateValue('activeClosingFeature', feature.uri);

    // //     if (!params.abort({ config })) {
    // //         const commitMessage = feature.resolveCommitMessageTemplate()({
    // //             featureName: feature.name
    // //         });

    // //         if (!await config.getStateValue([ feature.stateKey, 'closing', 'develop' ], 'boolean')) {
    // //             if (await config.isDirty({ stdout }))
    // //                 throw new Error(`Cannot merge, please commit all outstanding changes`);

    // //             await config.checkoutBranch(feature.parentSupport?.developBranchName ?? 'develop', { stdout, dryRun });
    // //             if (await config.isDirty({ stdout }))
    // //                 throw new Error(`Cannot merge, develop has uncommited or staged changes`);

    // //             await config.merge(feature.branchName, { squash: true, stdout, dryRun }).catch(async err => {
    // //                 if (await FS.pathExists(Path.join(config.path, '.git/SQUASH_MSG')))
    // //                     await FS.writeFile(Path.join(config.path, '.git/SQUASH_MSG'), commitMessage);

    // //                 if (params.confirm) {
    // //                     while (await config.isMergeInProgress({ stdout }))
    // //                         await params.confirm?.({ config, message: 'Continue with merge' });
    // //                 }
    // //                 else {
    // //                     throw new Error(`Could not merge changes; ${err}`);
    // //                 }
    // //             });

    // //             if (await config.hasStagedChanges({ stdout, dryRun }))
    // //                 await config.commit(commitMessage, { stdout, dryRun });

    // //             !dryRun && await config.setStateValue([ feature.stateKey, 'closing', 'develop' ], true);
    // //         }
    // //     }

    // //     if (await config.branchExists(feature.branchName, { stdout, dryRun }) && await params.deleteLocalBranch?.({ config }))
    // //         await config.deleteBranch(feature.branchName, { stdout, dryRun });

    // //     if (await config.remoteBranchExists(feature.branchName, 'origin', { stdout, dryRun }) && await params.deleteRemoteBranch?.({ config }))
    // //         await config.deleteRemoteBranch(feature.branchName, 'origin', { stdout, dryRun });

    // //     if (!dryRun)
    // //         await (feature.parentSupport ?? feature.parentConfig).deleteFeature(feature);

    // //     await config.save({ stdout: stdout, dryRun: dryRun });
    // // }
}

export async function closeRelease(rootConfig: Config, { stdout, dryRun, ...params }: ActionParams<{
    name: ActionParam<string, { releases: string[] }>;
    configs: ActionParam<Config[], { configs: Config[] }>;
    confirm?: ActionParam<boolean, { config?: Config, message: string }>;
    abort: ActionParam<boolean, { config: Config }>;
    deleteLocalBranch?: ActionParam<boolean, { config: Config }>;
    deleteRemoteBranch?: ActionParam<boolean, { config: Config }>;
    commitMessage?: ActionParam<MessageTemplate | undefined, { config: Config, messages: MessageTemplate[] }>;
    stagedFiles?: ActionParam<string[], { config: Config, statuses: Awaited<ReturnType<Config['resolveStatuses']>> }>;
    tags?: ActionParam<TagTemplate[], { config: Config, templates: TagTemplate[] }>;
    push?: ActionParam<boolean, { config: Config }>;
}>) {
    const releases = await Bluebird.map(rootConfig.flattenConfigs(), async config => {
            const support = await config.resolveActiveSupport();

            return support ? support.releases : config.releases;
        })
        .then(releases => _(releases).flatten().map(r => r.parentSupport ? `${r.parentSupport.name}/${r.name}` : r.name).uniq().value());

    const releaseName = await params.name({ releases });

    const allConfigs = rootConfig.flattenConfigs();
    const applicableConfigs = await Bluebird.filter(rootConfig.flattenConfigs(), c => c.hasElement(`release://${releaseName}`));
    if (!applicableConfigs.length)
        return;



    const prompts = await Bluebird.mapSeries(params.configs({ configs: applicableConfigs }), async config => {
        const commitMessageTemplates = config.flattenCommitMessageTemplates();
        const tagTemplates = config.flattenTagTemplates();

        return {
            config,
            release: await config.findElement('release', releaseName).then(({ release }) => release),
            abort: await params.abort({ config }),
            deleteLocalBranch: await params.deleteLocalBranch?.({ config }),
            deleteRemoteBranch: await params.deleteRemoteBranch?.({ config }),
            commitMessageTemplate: commitMessageTemplates.length ? await params.commitMessage?.({
                config,
                messages: commitMessageTemplates
            }) : undefined,
            tagTemplates: (tagTemplates.length ? await params.tags?.({
                config,
                templates: tagTemplates
            }) : undefined) ?? []
        };
    });

    for await (const groupedConfigs of iterateTopologicallyMapped(allConfigs, (item, parent) => item.parentConfig === parent, {
        mapper: c => prompts.find(p => p.config === c)
    })) {
        let configs = await Bluebird.mapSeries(groupedConfigs, async c => ({
            ...c,
            stagedFiles: await (async () => {
                const statuses = await Bluebird.filter(c.config.resolveStatuses({ stdout, dryRun }), s => !s.isSubmodule);
                if (!statuses.length)
                    return;

                return params.stagedFiles?.({ config: c.config, statuses })
            })() ?? [],
        }));

        while (configs.length > 0) {
            const failedMerges = await Bluebird.mapSeries(configs, async (groupedConfig) => {
                const { config, release, commitMessageTemplate, stagedFiles } = groupedConfig;

                try {
                    if (!await config.getStateValue([ release.stateKey, 'closing', 'commit' ], 'boolean')) {
                        const templateData = {
                            releaseName: release.name,
                            intermediate: release.intermediate,
                            version: await release.parentConfig.resolveCurrentArtifactVersion()
                        };

                        const commitMessage = commitMessageTemplate?.messageTemplate(templateData) ?? release.resolveCommitMessageTemplate()(templateData);

                        await config.checkoutBranch(release.branchName, { stdout, dryRun });
                        await config.stage(stagedFiles, { stdout, dryRun });
                        await config.commit(commitMessage, { allowEmpty: true, stdout, dryRun });

                        !dryRun && await config.setStateValue([ release.stateKey, 'closing', 'commit' ], true);
                    }
                }
                catch (error) {
                    return { groupedConfig, error };
                }
            }).then(_.compact);

            configs = failedMerges.map(({ groupedConfig }) => groupedConfig);
            if (failedMerges.length > 0) {
                stdout?.write(`Errors occurred during merge\n${failedMerges.map(({ groupedConfig, error }) => `  [${Chalk.magenta(groupedConfig.config.pathspec)}] ${error.toString()}\n`)}`);
                if (!await params.confirm?.({ message: 'Continue with merge?' }))
                    throw new Error('User aborted merge');
            }
        }
    }

    for await (const groupedConfigs of iterateTopologicallyMapped(allConfigs, (item, parent) => item.parentConfig === parent, {
        mapper: c => prompts.find(p => p.config === c)
    })) {
        let configs = groupedConfigs;

        while (configs.length > 0) {
            const failedMerges = await Bluebird.mapSeries(configs, async (groupedConfig) => {
                const { config, release } = groupedConfig;

                try {
                    if (!await config.getStateValue([ release.stateKey, 'closing', 'develop' ], 'boolean')) {
                        // await config.swapCheckoutTree(config => config.releases.find(r => r.name === release.name && r.parentSupport?.name === release.parentSupport?.name)?.parentSupport?.developBranchName ?? config.resolveDevelopBranchName(), async () => {
                        await config.swapCheckout(release.parentSupport?.developBranchName ?? release.parentConfig.resolveDevelopBranchName(), async () => {
                            await config.merge(release.branchName, { stdout, dryRun });

                            // await config.stage(await Bluebird.filter(config.resolveStatuses({ stdout, dryRun }), s => !!s.isSubmodule).map(s => s.path), { stdout, dryRun });

                            if (await config.hasStagedChanges({ stdout, dryRun }))
                                await config.commit(`Merged ${release.branchName} into develop`, { stdout, dryRun });
                        }, { stdout, dryRun });

                        !dryRun && await config.setStateValue([ release.stateKey, 'closing', 'develop' ], true);
                    }
                }
                catch (error) {
                    return { groupedConfig, error };
                }
            }).then(_.compact);

            configs = failedMerges.map(({ groupedConfig }) => groupedConfig);
            if (failedMerges.length > 0) {
                stdout?.write(`Errors occurred during merge\n${failedMerges.map(({ groupedConfig, error }) => `  [${Chalk.magenta(groupedConfig.config.pathspec)}] ${error.toString()}\n`)}`);
                if (!await params.confirm?.({ message: 'Continue with merge?' }))
                    throw new Error('User aborted merge');
            }
        }
    }

    for await (const groupedConfigs of iterateTopologicallyMapped(allConfigs, (item, parent) => item.parentConfig === parent, {
        mapper: c => prompts.find(p => p.config === c)
    })) {
        let configs = groupedConfigs;

        while (configs.length > 0) {
            const failedMerges = await Bluebird.mapSeries(configs, async (groupedConfig) => {
                const { config, release, tagTemplates } = groupedConfig;

                try {
                    if (!await config.getStateValue([ release.stateKey, 'closing', 'master' ], 'boolean')) {
                        const templateData = {
                            releaseName: release.name,
                            intermediate: release.intermediate,
                            version: await release.parentConfig.resolveCurrentArtifactVersion()
                        };

                        // await config.swapCheckoutTree(config => config.releases.find(r => r.name === release.name && r.parentSupport?.name === release.parentSupport?.name)?.parentSupport?.masterBranchName ?? config.resolveMasterBranchName(), async () => {
                        await config.swapCheckout(release.parentSupport?.masterBranchName ?? release.parentConfig.resolveMasterBranchName(), async () => {
                            await config.merge(release.branchName, { stdout, dryRun });

                            // await config.stage(await Bluebird.filter(config.resolveStatuses({ stdout, dryRun }), s => !!s.isSubmodule).map(s => s.path), { stdout, dryRun });
    
                            if (await config.hasStagedChanges({ stdout, dryRun }))
                                await config.commit(`Merged ${release.branchName} into master`, { stdout, dryRun });
    
                            for (const tagTemplate of tagTemplates)
                                await config.tag(tagTemplate.tagTemplate(templateData), { annotation: tagTemplate.annotationTemplate?.(templateData), stdout, dryRun })
                        }, { stdout, dryRun });

                        !dryRun && await config.setStateValue([ release.stateKey, 'closing', 'master' ], true);
                    }
                }
                catch (error) {
                    return { groupedConfig, error };
                }
            }).then(_.compact);

            configs = failedMerges.map(({ groupedConfig }) => groupedConfig);
            if (failedMerges.length > 0) {
                stdout?.write(`Errors occurred during merge\n${failedMerges.map(({ groupedConfig, error }) => `  [${Chalk.magenta(groupedConfig.config.pathspec)}] ${error.toString()}\n`)}`);
                if (!await params.confirm?.({ message: 'Continue with merge?' }))
                    throw new Error('User aborted merge');
            }
        }
    }

    for await (const groupedConfigs of iterateTopologicallyMapped(allConfigs, (item, parent) => item.parentConfig === parent, {
        mapper: c => prompts.find(p => p.config === c)
    })) {
        let configs = groupedConfigs;

        while (configs.length > 0) {
            const failedMerges = await Bluebird.mapSeries(configs, async (groupedConfig) => {
                const { config, release, deleteLocalBranch, deleteRemoteBranch } = groupedConfig;

                try {
                    const version = release.resolveVersion();
                    if (version) {
                        const developVersion = await (release.parentSupport ?? config).resolveVersion('develop');
                        if (developVersion && Semver.lt(version, developVersion))
                            throw new Error(`Release version (${version}) is less than the develop version (${developVersion})`);

                        const masterVersion = await (release.parentSupport ?? config).resolveVersion('master');
                        if (masterVersion && Semver.lt(version, masterVersion))
                            throw new Error(`Release version (${version}) is less than the master version (${masterVersion})`);

                        await (release.parentSupport ?? config).setVersion('develop', version, { stdout, dryRun });
                        await (release.parentSupport ?? config).setVersion('master', version, { stdout, dryRun })
                    }

                    await config.checkoutBranch(release.parentSupport?.developBranchName ?? config.resolveDevelopBranchName(), { stdout, dryRun });

                    if (await config.branchExists(release.branchName, { stdout, dryRun }) && deleteLocalBranch)
                        await config.deleteBranch(release.branchName, { stdout, dryRun });

                    if (await config.remoteBranchExists(release.branchName, 'origin', { stdout, dryRun }) && deleteRemoteBranch)
                        await config.deleteRemoteBranch(release.branchName, 'origin', { stdout, dryRun });

                    !dryRun && await (release.parentSupport ?? release.parentConfig).deleteRelease(release);

                    await config.save({ stdout: stdout, dryRun: dryRun });
                }
                catch (error) {
                    return { groupedConfig, error };
                }
            }).then(_.compact);

            configs = failedMerges.map(({ groupedConfig }) => groupedConfig);
            if (failedMerges.length > 0) {
                stdout?.write(`Errors occurred during merge\n${failedMerges.map(({ groupedConfig, error }) => `  [${Chalk.magenta(groupedConfig.config.pathspec)}] ${error.toString()}\n`)}`);
                if (!await params.confirm?.({ message: 'Continue with merge?' }))
                    throw new Error('User aborted merge');
            }
        }
    }




    // for await (const groupedConfigs of iterateTopologicallyMapped(allConfigs, (item, parent) => item.parentConfig === parent, {
    //     mapper: c => prompts.find(p => p.config === c)
    // })) {
    //     let configs = await Bluebird.mapSeries(groupedConfigs, async c => ({
    //         ...c,
    //         stagedFiles: await params.stagedFiles?.({ config: c.config, statuses: await Bluebird.filter(c.config.resolveStatuses({ stdout, dryRun }), s => !s.isSubmodule) }),
    //     }));

    //     while (configs.length > 0) {
    //         const failedMerges = await Bluebird.map(configs, async (groupedConfig) => {
    //             const { config, abort, deleteLocalBranch, deleteRemoteBranch, tagTemplates, commitMessageTemplate, stagedFiles = [] } = groupedConfig;

    //             try {
    //                 const { release } = await config.findElement('release', releaseName);

    //                 !dryRun && await config.setStateValue('activeClosingFeature', release.uri);

    //                 if (!abort) {
    //                     const templateData = {
    //                         releaseName: release.name,
    //                         intermediate: release.intermediate,
    //                         version: release.parentConfig.resolveVersion()
    //                     };

    //                     const commitMessage = commitMessageTemplate?.messageTemplate(templateData) ?? release.resolveCommitMessageTemplate()(templateData);

    //                     await config.stage(stagedFiles, { stdout, dryRun });
    //                     await config.commit(commitMessage, { allowEmpty: true, stdout, dryRun });

    //                     if (await config.isDirty({ stdout }))
    //                         throw new Error(`Cannot merge, please commit all outstanding changes first or stash them`);

    //                     // await commit(rootConfig, {
    //                     //     configs: () => [ config ],
    //                     //     message: () => commitMessage,
    //                     //     stagedFiles: ({ statuses }) => statuses.map(s => s.path),
    //                     //     stdout,
    //                     //     dryRun
    //                     // });

    //                     // await config.commit(commitMessage, { allowEmpty: true, stdout, dryRun });

    //                     if (!await config.getStateValue([ release.stateKey, 'closing', 'develop' ], 'boolean')) {
    //                         await config.checkoutBranch(release.parentSupport?.developBranchName ?? 'develop', { stdout, dryRun });
    //                         // if (await config.isDirty({ stdout }))
    //                         //     throw new Error(`Cannot merge, develop has uncommited or staged changes`);

    //                         await config.merge(release.branchName, { stdout, dryRun }).catch(async err => {
    //                             if (await FS.pathExists(Path.join(config.path, '.git/MERGE_MSG')))
    //                                 await FS.writeFile(Path.join(config.path, '.git/MERGE_MSG'), commitMessage);

    //                             if (params.confirm) {
    //                                 while (await config.isMergeInProgress({ stdout }))
    //                                     await params.confirm?.({ config, message: 'Continue with merge' });
    //                             }
    //                             else {
    //                                 throw new Error(`Could not merge changes; ${err}`);
    //                             }
    //                         });

    //                         await config.stage(await Bluebird.filter(config.resolveStatuses({ stdout, dryRun }), s => !!s.isSubmodule).map(s => s.path), { stdout, dryRun });

    //                         if (await config.hasStagedChanges({ stdout, dryRun }))
    //                             await config.commit(commitMessage, { stdout, dryRun });

    //                         !dryRun && await config.setStateValue([ release.stateKey, 'closing', 'develop' ], true);
    //                     }

    //                     if (!await config.getStateValue([ release.stateKey, 'closing', 'master' ], 'boolean')) {
    //                         await config.checkoutBranch(release.parentSupport?.masterBranchName ?? 'master', { stdout, dryRun });
    //                         // if (await config.isDirty({ stdout }))
    //                         //     throw new Error(`Cannot merge, master has uncommited or staged changes`);

    //                         await config.merge(release.branchName, { stdout, dryRun }).catch(async err => {
    //                             if (await FS.pathExists(Path.join(config.path, '.git/MERGE_MSG')))
    //                                 await FS.writeFile(Path.join(config.path, '.git/MERGE_MSG'), commitMessage);

    //                             if (params.confirm) {
    //                                 while (await config.isMergeInProgress({ stdout }))
    //                                     await params.confirm?.({ config, message: 'Continue with merge' });
    //                             }
    //                             else {
    //                                 throw new Error(`Could not merge changes; ${err}`);
    //                             }
    //                         });

    //                         await config.stage(await Bluebird.filter(config.resolveStatuses({ stdout, dryRun }), s => !!s.isSubmodule).map(s => s.path), { stdout, dryRun });

    //                         if (await config.hasStagedChanges({ stdout, dryRun }))
    //                             await config.commit(commitMessage, { stdout, dryRun });

    //                         for (const tagTemplate of tagTemplates)
    //                             await config.tag(tagTemplate.tagTemplate(templateData), { annotation: tagTemplate.annotationTemplate?.(templateData), stdout, dryRun })

    //                         // if (!release.intermediate)
    //                         //     await config.tag(tag, { annotation: `Release ${release.name}`, stdout, dryRun })

    //                         !dryRun && await config.setStateValue([ release.stateKey, 'closing', 'master' ], true);
    //                     }
    //                 }

    //                 if (await config.branchExists(release.branchName, { stdout, dryRun }) && deleteLocalBranch)
    //                     await config.deleteBranch(release.branchName, { stdout, dryRun });

    //                 if (await config.remoteBranchExists(release.branchName, 'origin', { stdout, dryRun }) && deleteRemoteBranch)
    //                     await config.deleteRemoteBranch(release.branchName, 'origin', { stdout, dryRun });

    //                 if (!dryRun)
    //                     await (release.parentSupport ?? release.parentConfig).deleteRelease(release);

    //                 await config.checkoutBranch(release.parentSupport?.developBranchName ?? 'develop', { stdout, dryRun });

    //                 await config.save({ stdout: stdout, dryRun: dryRun });
    //             }
    //             catch (error) {
    //                 return { groupedConfig, error };
    //             }
    //         }).then(_.compact);

    //         configs = failedMerges.map(({ groupedConfig }) => groupedConfig);
    //         if (failedMerges.length > 0) {
    //             stdout?.write(`Errors occurred during merge\n${failedMerges.map(({ groupedConfig, error }) => `  [${Chalk.magenta(groupedConfig.config.pathspec)}] ${error.toString()}\n`)}`);
    //             if (!await params.confirm?.({ message: 'Continue with merge?' }))
    //                 throw new Error('User aborted merge');
    //         }
    //     }
    // }




    // const configs = await params.configs({ configs: applicableConfigs });
    // for await (const groupedConfigs of resolveFilteredOrderedConfigs(allConfigs, { filter:  c => configs.indexOf(c) >= 0 })) {
    //     // console.log(groupedConfigs.map(c => c.pathspec))

    //     for (const config of groupedConfigs) {
    //         const { release } = await config.findElement('release', releaseName);

    //         !dryRun && await config.setStateValue('activeClosingFeature', release.uri);

    //         if (!params.abort({ config })) {
    //             const commitMessage = release.resolveCommitMessageTemplate()({
    //                 releaseName: release.name,
    //                 intermediate: release.intermediate
    //             });
    //             const tag = release.resolveTagTemplate()({
    //                 releaseName: release.name,
    //                 intermediate: release.intermediate
    //             });

    //             if (!await config.getStateValue([ release.stateKey, 'closing', 'develop' ], 'boolean')) {
    //                 if (await config.isDirty({ stdout }))
    //                     throw new Error(`Cannot merge, please commit all outstanding changes`);

    //                 await config.checkoutBranch(release.parentSupport?.developBranchName ?? 'develop', { stdout, dryRun });
    //                 if (await config.isDirty({ stdout }))
    //                     throw new Error(`Cannot merge, develop has uncommited or staged changes`);

    //                 await config.merge(release.branchName, { noFastForward: true, message: commitMessage, stdout, dryRun }).catch(async err => {
    //                     if (await FS.pathExists(Path.join(config.path, '.git/MERGE_MSG')))
    //                         await FS.writeFile(Path.join(config.path, '.git/MERGE_MSG'), commitMessage);

    //                     if (params.confirm) {
    //                         while (await config.isMergeInProgress({ stdout }))
    //                             await params.confirm?.({ config, message: 'Continue with merge' });
    //                     }
    //                     else {
    //                         throw new Error(`Could not merge changes; ${err}`);
    //                     }
    //                 });

    //                 if (await config.hasStagedChanges({ stdout, dryRun }))
    //                     await config.commit(commitMessage, { stdout, dryRun });

    //                 !dryRun && await config.setStateValue([ release.stateKey, 'closing', 'develop' ], true);
    //             }

    //             if (!await config.getStateValue([ release.stateKey, 'closing', 'master' ], 'boolean')) {
    //                 await config.checkoutBranch(release.parentSupport?.masterBranchName ?? 'master', { stdout, dryRun });
    //                 if (await config.isDirty({ stdout }))
    //                     throw new Error(`Cannot merge, master has uncommited or staged changes`);

    //                 await config.merge(release.branchName, { message: commitMessage, noFastForward: true, stdout, dryRun }).catch(async err => {
    //                     if (await FS.pathExists(Path.join(config.path, '.git/MERGE_MSG')))
    //                         await FS.writeFile(Path.join(config.path, '.git/MERGE_MSG'), commitMessage);

    //                     if (params.confirm) {
    //                         while (await config.isMergeInProgress({ stdout }))
    //                             await params.confirm?.({ config, message: 'Continue with merge' });
    //                     }
    //                     else {
    //                         throw new Error(`Could not merge changes; ${err}`);
    //                     }
    //                 });

    //                 if (await config.hasStagedChanges({ stdout, dryRun }))
    //                     await config.commit(commitMessage, { stdout, dryRun });

    //                 if (!release.intermediate)
    //                     await config.tag(tag, { annotation: `Release ${release.name}`, stdout, dryRun })

    //                 !dryRun && await config.setStateValue([ release.stateKey, 'closing', 'master' ], true);
    //             }
    //         }

    //         if (await config.branchExists(release.branchName, { stdout, dryRun }) && await params.deleteLocalBranch?.({ config }))
    //             await config.deleteBranch(release.branchName, { stdout, dryRun });

    //         if (await config.remoteBranchExists(release.branchName, 'origin', { stdout, dryRun }) && await params.deleteRemoteBranch?.({ config }))
    //             await config.deleteRemoteBranch(release.branchName, 'origin', { stdout, dryRun });

    //         if (!dryRun)
    //             await (release.parentSupport ?? release.parentConfig).deleteRelease(release);

    //         await config.save({ stdout: stdout, dryRun: dryRun });
    //     }
    // }





    // const configs = await params.configs({ configs: allConfigs });
    // for (const config of configs) {
    //     const { release } = await config.findElement('release', releaseName);

    //     !dryRun && await config.setStateValue('activeClosingFeature', release.uri);

    //     if (!params.abort({ config })) {
    //         const commitMessage = release.resolveCommitMessageTemplate()({
    //             releaseName: release.name,
    //             intermediate: release.intermediate
    //         });
    //         const tag = release.resolveTagTemplate()({
    //             releaseName: release.name,
    //             intermediate: release.intermediate
    //         });

    //         if (!await config.getStateValue([ release.stateKey, 'closing', 'develop' ], 'boolean')) {
    //             if (await config.isDirty({ stdout }))
    //                 throw new Error(`Cannot merge, please commit all outstanding changes`);

    //             await config.checkoutBranch(release.parentSupport?.developBranchName ?? 'develop', { stdout, dryRun });
    //             if (await config.isDirty({ stdout }))
    //                 throw new Error(`Cannot merge, develop has uncommited or staged changes`);

    //             await config.merge(release.branchName, { noFastForward: true, message: commitMessage, stdout, dryRun }).catch(async err => {
    //                 if (await FS.pathExists(Path.join(config.path, '.git/MERGE_MSG')))
    //                     await FS.writeFile(Path.join(config.path, '.git/MERGE_MSG'), commitMessage);

    //                 if (params.confirm) {
    //                     while (await config.isMergeInProgress({ stdout }))
    //                         await params.confirm?.({ config, message: 'Continue with merge' });
    //                 }
    //                 else {
    //                     throw new Error(`Could not merge changes; ${err}`);
    //                 }
    //             });

    //             if (await config.hasStagedChanges({ stdout, dryRun }))
    //                 await config.commit(commitMessage, { stdout, dryRun });

    //             !dryRun && await config.setStateValue([ release.stateKey, 'closing', 'develop' ], true);
    //         }

    //         if (!await config.getStateValue([ release.stateKey, 'closing', 'master' ], 'boolean')) {
    //             await config.checkoutBranch(release.parentSupport?.masterBranchName ?? 'master', { stdout, dryRun });
    //             if (await config.isDirty({ stdout }))
    //                 throw new Error(`Cannot merge, master has uncommited or staged changes`);

    //             await config.merge(release.branchName, { message: commitMessage, noFastForward: true, stdout, dryRun }).catch(async err => {
    //                 if (await FS.pathExists(Path.join(config.path, '.git/MERGE_MSG')))
    //                     await FS.writeFile(Path.join(config.path, '.git/MERGE_MSG'), commitMessage);

    //                 if (params.confirm) {
    //                     while (await config.isMergeInProgress({ stdout }))
    //                         await params.confirm?.({ config, message: 'Continue with merge' });
    //                 }
    //                 else {
    //                     throw new Error(`Could not merge changes; ${err}`);
    //                 }
    //             });

    //             if (await config.hasStagedChanges({ stdout, dryRun }))
    //                 await config.commit(commitMessage, { stdout, dryRun });

    //             if (!release.intermediate)
    //                 await config.tag(tag, { annotation: `Release ${release.name}`, stdout, dryRun })

    //             !dryRun && await config.setStateValue([ release.stateKey, 'closing', 'master' ], true);
    //         }
    //     }

    //     if (await config.branchExists(release.branchName, { stdout, dryRun }) && await params.deleteLocalBranch?.({ config }))
    //         await config.deleteBranch(release.branchName, { stdout, dryRun });

    //     if (await config.remoteBranchExists(release.branchName, 'origin', { stdout, dryRun }) && await params.deleteRemoteBranch?.({ config }))
    //         await config.deleteRemoteBranch(release.branchName, 'origin', { stdout, dryRun });

    //     if (!dryRun)
    //         await (release.parentSupport ?? release.parentConfig).deleteRelease(release);

    //     await config.save({ stdout: stdout, dryRun: dryRun });
    // }
}

export async function mergeFeature(rootConfig: Config, { stdout, dryRun, ...params }: ActionParams<{
    name: ActionParam<string, { features: string[] }>;
    source: ActionParam<string, { config: Config }>;
    configs: ActionParam<Config[], { configs: Config[] }>;
}>) {
    const features = await Bluebird.map(rootConfig.flattenConfigs(), config => config.features)
        .then(features => _(features).flatten().map(r => r.name).uniq().value());

    const featureName = await params.name({ features });

    const allConfigs = await Bluebird.filter(rootConfig.flattenConfigs(), c => c.hasElement(`feature://${featureName}`));
    if (!allConfigs.length)
        return;
    
    const configs = await params.configs({ configs: allConfigs });
    await Bluebird.map(Bluebird.mapSeries(configs, async config => {
        return {
            config,
            source: await params.source({ config }),
        };
    }), async ({ config, source }) => {
        const { feature } = await config.findElement('feature', featureName);
        const sourceBranch = await config.parseElement(source).then(sourceElement => {
            if (sourceElement.type == 'branch') {
                return sourceElement.branch;
            }
            else {
                throw new Error(`Unsupported source type ${sourceElement.type}`);
            }
        });

        if (!await config.resolveCurrentBranch({ stdout, dryRun }).then(currentBranch => currentBranch === feature.branchName))
            await feature.checkoutBranch({ stdout, dryRun });

        await config.merge(sourceBranch, { stdout, dryRun });
    });
}

export async function syncFeature(rootConfig: Config, { stdout, dryRun, ...params }: ActionParams<{
    name: ActionParam<string, { features: string[] }>;
    configs: ActionParam<Config[], { configs: Config[] }>;
    push: ActionParam<boolean, { config: Config }>;
}>) {
    const features = await Bluebird.map(rootConfig.flattenConfigs(), config => config.features)
        .then(features => _(features).flatten().map(r => r.name).uniq().value());

    const featureName = await params.name({ features });

    const allConfigs = await Bluebird.filter(rootConfig.flattenConfigs(), c => c.hasElement(`feature://${featureName}`));
    if (!allConfigs.length)
        return;
    
    const configs = await params.configs({ configs: allConfigs });
    await Bluebird.map(Bluebird.mapSeries(configs, async config => {
        return {
            config,
            push: await params.push({ config })
        };
    }), async ({ config, push }) => {
        const { feature } = await config.findElement('feature', featureName);

        await feature.swapCheckout(async () => {
            if (feature.upstream) {
                await config.exec(`git merge ${feature.upstream}/${feature.branchName}`, { stdout, dryRun });
    
                if (push)
                    await config.exec(`git push -u ${feature.upstream} ${feature.branchName}`, { stdout, dryRun });
            }
        }, { stdout, dryRun });
    });
}

export async function commit(rootConfig: Config, { stdout, dryRun, ...params }: ActionParams<{
    configs: ActionParam<Config[], { configs: Config[] }>;
    stagedFiles: ActionParam<string[], { config: Config, statuses: Awaited<ReturnType<Config['resolveStatuses']>> }>;
    message: ActionParam<string, { configs: Config[] }>;
    stage?: ActionParam<boolean, { config: Config }>;
}>) {
    // const allConfigs = await Bluebird.filter(rootConfig.flattenConfigs(), config => config.resolveStatuses({ stdout, dryRun }).then(s => s.length > 0));
    // if (!allConfigs.length)
    //     return;

    // const configs = await params.configs({ configs: allConfigs });
    // for await (const groupedConfigs of iterateTopologicallyNonMapped(configs, (item, parent) => item.parentConfig === parent)) {
    //     const message = await params.message({ configs: groupedConfigs })

    //     await Bluebird.map(Bluebird.mapSeries(groupedConfigs, async config => {
    //         return {
    //             config,
    //             stagedFiles: await params.stagedFiles({ config, statuses: await Bluebird.filter(config.resolveStatuses({ stdout, dryRun }), s => !s.isSubmodule) }),
    //             // message: await params.message({ config })
    //         };
    //     }), async ({ config, stagedFiles }) => {
    //         await config.stage(stagedFiles, { stdout, dryRun });
    //         await config.commit(message, { stdout, dryRun });
    //     });
    // }

    const allConfigs = await Bluebird.filter(rootConfig.flattenConfigs(), config => config.resolveStatuses({ stdout, dryRun }).then(s => s.length > 0));
    if (!allConfigs.length)
        return;

    const configs = await params.configs({ configs: allConfigs });
    await Bluebird.map(Bluebird.mapSeries(configs, async config => {
        return {
            config,
            stagedFiles: await params.stagedFiles({ config, statuses: await config.resolveStatuses({ stdout, dryRun }) }),
            message: await params.message({ configs })
        };
    }), async ({ config, message, stagedFiles }) => {
        await config.stage(stagedFiles, { stdout, dryRun });
        await config.commit(message, { stdout, dryRun });
    });
}

export async function sync(rootConfig: Config, { stdout, dryRun, ...params }: ActionParams<{
    configs: ActionParam<Config[], { configs: Config[] }>;
    push: ActionParam<boolean>;
}>) {
    const allConfigs = rootConfig.flattenConfigs().filter(c => c.managed);
    const configs = await params.configs({ configs: allConfigs });

    await Bluebird.map(configs, async config => {
        await config.swapCheckout(config.resolveMasterBranchName(), async () => {
            await config.pull({ stdout, dryRun });

            if (params.push())
                await config.push('origin', config.resolveMasterBranchName(), { stdout, dryRun });
        });

        await config.swapCheckout(config.resolveDevelopBranchName(), async () => {
            await config.pull({ stdout, dryRun });

            if (params.push())
                await config.push('origin', config.resolveDevelopBranchName(), { stdout, dryRun });
        });
    });

    // const allConfigs = rootConfig.flattenConfigs();
    // const statuses = await Bluebird.map(allConfigs, async config => {
    //     if (!config.managed)
    //         return;

    //     await config.fetch({ stdout, dryRun });

    //     const master = await config.resolveBranchStatus(config.resolveMasterBranchName(), 'origin', { stdout });
    //     const develop = await config.resolveBranchStatus(config.resolveDevelopBranchName(), 'origin', { stdout });

    //     const features = await Bluebird
    //         .map(config.features, feature => feature.upstream ? config.resolveBranchStatus(feature.branchName, feature.upstream, { stdout }) : undefined)
    //         .then(s => _.compact(s));
    //     const supports = [
    //         ...await Bluebird
    //             .map(config.supports, support => support.upstream ? config.resolveBranchStatus(support.masterBranchName, develop.upstream, { stdout }) : undefined)
    //             .then(s => _.compact(s)),
    //         ...await Bluebird
    //             .map(config.supports, support => support.upstream ? config.resolveBranchStatus(support.developBranchName, develop.upstream, { stdout }) : undefined)
    //             .then(s => _.compact(s))
    //     ];

    //     return {
    //         identifier: config.identifier,
    //         master,
    //         develop,
    //         features,
    //         supports,
    //         applicable: master.differs || develop.differs || features.some(f => f.differs) || supports.some(s => s.differs)
    //     };
    // }).then(statuses => _(statuses).compact().keyBy(s => s.identifier).value());

    // const applicableConfigs = allConfigs.filter(c => statuses[c.identifier]?.applicable)
    // if (!applicableConfigs.length)
    //     return;

    // const configs = await params.configs({ configs: applicableConfigs });
    // for await (const groupedConfigs of iterateTopologicallyNonMapped(allConfigs, (item, parent) => item.parentConfig === parent, {
    //     filter: config => configs.some(c => c === config)
    // })) {
    //     await Bluebird.map(Bluebird.mapSeries(groupedConfigs, async config => ({
    //         config,
    //         // stagedFiles: await params.stagedFiles({ config, statuses: await config.resolveStatuses({ stdout, dryRun }) }),
    //         // message: await params.message({ config })
    //     })), async ({ config }) => {
    //         const status = statuses[config.identifier];

    //         const processStatus = async (branchStatus: Awaited<ReturnType<Config['resolveBranchStatus']>>) => {
    //             if (branchStatus.differs) {
    //                 await config.checkout(branchStatus.branchName, async () => {
    //                     if (await branchStatus.resolveCommitsBehind({ stdout }) > 0)
    //                         // await config.exec(`git merge ${branchStatus.upstreamBranchName}`, { stdout, dryRun });
    //                         await config.exec(`git pull ${branchStatus.upstream} ${branchStatus.branchName}`, { stdout, dryRun });
    //                     if (await params.push() && (!branchStatus.upstreamBranchExists || await branchStatus.resolveCommitsAhead({ stdout }) > 0))
    //                         await config.exec(`git push -u ${branchStatus.upstream} ${branchStatus.branchName}`, { stdout, dryRun });
    //                 }, { stdout, dryRun });
    //             }
    //         }

    //         await processStatus(status.master);
    //         await processStatus(status.develop);

    //         for (const feature of status.features)
    //             await processStatus(feature);
    //         for (const support of status.supports)
    //             await processStatus(support);
    //     }, { concurrency: 1 });
    // }
}

export async function createSubmodule(config: Config, { stdout, dryRun, ...params }: ActionParams<{
    name: ActionParam<string>;
    path: ActionParam<string, { name: string }>;
    url: ActionParam<string>;
}>) {
    const name = await params.name();

    const submodule = new Submodule({
        name,
        path: await params.path({ name }),
        url: await params.url()
    });
    config.submodules.push(submodule);
    await submodule.register(config, { verify: true });

    await submodule.config.init({ stdout, dryRun });
    await submodule.init({ stdout, dryRun });

    await config.save({ stdout: stdout, dryRun: dryRun });
}

export async function viewVersion(rootConfig: Config, { stdout, dryRun, ...params }: ActionParams<{
    configs: ActionParam<Config[], { configs: { config: Config, version?: string }[] }>;
}>) {
    const allConfigs = rootConfig.flattenConfigs().filter(c => c.managed);
    const configs = await params.configs({ configs: await Bluebird.map(allConfigs, async config => ({ config, version: await config.resolveCurrentArtifactVersion(true) })) });

    await Bluebird.mapSeries(Bluebird.mapSeries(configs, async config => {
        return {
            config
        };
    }), async ({ config }) => {
        function writeStatus(label: string, primary: () => string | undefined, secondary?: () => string | undefined) {
            let value = primary();
            if (value) {
                value = Chalk.green(value);
            }
            else {
                value = secondary?.();
                if (value)
                    value = Chalk.yellow(value);
                else
                    value = Chalk.red('N/A');
            }

            stdout?.write(`  ${Chalk.cyan(label)}: ${value}\n`);
        }

        stdout?.write(`[${Chalk.blue(config.pathspec)}]\n`);
        writeStatus('Master', () => config.resolveVersion('master'));
        writeStatus('Develop', () => config.resolveVersion('develop'), () => config.resolveVersion('master'));
        for (const feature of config.features) {
            writeStatus(`Feature "${feature.name}"`, () => feature.resolveVersion(), () => feature.parentConfig.resolveVersion('develop'));
        }
        for (const release of config.releases) {
            writeStatus(`Release "${release.name}"`, () => release.resolveVersion(), () => release.parentConfig.resolveVersion('develop'));
        }
        for (const hotfix of config.hotfixes) {
            writeStatus(`Hotfix "${hotfix.name}"`, () => hotfix.resolveVersion(), () => hotfix.parentConfig.resolveVersion('develop'));
        }
        for (const support of config.supports) {
            writeStatus(`Support "${support.name}" - Master`, () => support.resolveVersion('master'));
            writeStatus(`Support "${support.name}" - Develop`, () => support.resolveVersion('develop'));
        }
    });
}
export async function setVersion(rootConfig: Config, { stdout, dryRun, ...params }: ActionParams<{
    configs: ActionParam<Config[], { configs: { config: Config, version?: string }[] }>;
    version: ActionParam<string | null, { config: Config }>;
}>) {
    const allConfigs = rootConfig.flattenConfigs().filter(c => c.managed);
    const configs = await params.configs({ configs: await Bluebird.map(allConfigs, async config => ({ config, version: await config.resolveCurrentArtifactVersion(true) })) });

    await Bluebird.mapSeries(Bluebird.mapSeries(configs, async config => {
        return {
            config,
            version: await params.version({ config })
        };
    }), async ({ config, version }) => {
        const targetIds = [];

        if (version) {
            const sanitizedVersion = Semver.clean(version);
            if (!sanitizedVersion)
                throw new Error(`Could not parse version from "${version}"`);

            targetIds.push(...await config.setCurrentArtifactVersion(sanitizedVersion, { stdout, dryRun }));
            stdout?.write(`[${Chalk.blue(config.pathspec)}] Set version to v${sanitizedVersion}\n`);
        }
        else {
            targetIds.push(...await config.setCurrentArtifactVersion(null, { stdout, dryRun }));
            stdout?.write(`[${Chalk.blue(config.pathspec)}] ${Chalk.yellow('Cleared set version')}\n`);
        }

        console.log('PEER CONFIGS: ', targetIds)

        await config.save({ stdout, dryRun });
    });
}
export async function stampVersion(rootConfig: Config, { stdout, dryRun, ...params }: ActionParams<{
    configs: ActionParam<Config[], { configs: { config: Config, version?: string }[] }>;
}>) {
    const allConfigs = rootConfig.flattenConfigs().filter(c => c.managed);
    const configs = await params.configs({ configs: await Bluebird.map(allConfigs, async config => ({ config, version: await config.resolveCurrentArtifactVersion(true) })) });

    await Bluebird.mapSeries(Bluebird.mapSeries(configs, async config => {
        return {
            config
        };
    }), async ({ config }) => {
        const version = await config.resolveCurrentArtifactVersion(true);
        if (!version)
            return;

        await config.setCurrentArtifactVersion(version, { stdout, dryRun });
        stdout?.write(`[${Chalk.blue(config.pathspec)}] Set version to v${version}\n`);
    });
}
export async function incrementVersion(rootConfig: Config, { stdout, dryRun, ...params }: ActionParams<{
    configs: ActionParam<Config[], { configs: { config: Config, version?: string }[] }>;
    type: ActionParam<Semver.ReleaseType, { config: Config }>;
    prereleaseIdentifier: ActionParam<string, { config: Config }>;
    cascade?: ActionParam<boolean>;
    cascadeConfigs: ActionParam<Config[], { configs: { config: Config, version?: string }[] }>;
    commit?: ActionParam<boolean>;
}>) {
    const allConfigs = rootConfig.flattenConfigs().filter(c => c.managed);
    const configs = await params.configs({ configs: await Bluebird.map(allConfigs, async config => ({ config, version: await config.resolveCurrentArtifactVersion(true) })) });
    // const type = await params.type();
    const cascade = await params.cascade?.() ?? false;

    const dependantConfigs = resolveDependants(configs, allConfigs);
    const cascadedConfigs = cascade && dependantConfigs.length > 0 ? await params.cascadeConfigs({ configs: await Bluebird.map(dependantConfigs, async config => ({ config, version: await config.resolveCurrentArtifactVersion(true) })) }) : [];

    // const prereleaseIdentifier = await (async () => {
    //     switch (type) {
    //         case 'premajor':
    //         case 'preminor':
    //         case 'prepatch':
    //         case 'prerelease':
    //             return params.prereleaseIdentifier();
    //     }
    // })();

    await Bluebird.mapSeries(Bluebird.mapSeries([
        ...configs,
        ...cascadedConfigs
    ], async config => {
        const type = await params.type({ config });
        const prereleaseIdentifier = await (async () => {
            switch (type) {
                case 'premajor':
                case 'preminor':
                case 'prepatch':
                case 'prerelease':
                    return params.prereleaseIdentifier({ config });
            }
        })();

        return {
            config,
            type,
            prereleaseIdentifier
        };
    }), async ({ config, type, prereleaseIdentifier }) => {
        const version = await config.resolveCurrentArtifactVersion(true);
        if (version) {
            const incrementedVersion = Semver.inc(version, type, prereleaseIdentifier);
            if (!incrementedVersion)
                throw new Error(`Could not increment version from "${version}"`);

            await config.setCurrentArtifactVersion(incrementedVersion, { stdout, dryRun });
            stdout?.write(`[${Chalk.blue(config.pathspec)}] Incremented version from v${version} to v${incrementedVersion}\n`);

            await config.save({ stdout, dryRun });
        }
    });
}

export async function listDependants(rootConfig: Config, { stdout, dryRun, ...params }: ActionParams<{
    configs: ActionParam<Config[], { configs: Config[] }>;
}>) {
    const allConfigs = rootConfig.flattenConfigs().filter(c => c.managed);
    const configs = await params.configs({ configs: allConfigs });

    await Bluebird.mapSeries(Bluebird.mapSeries(configs, async config => {
        return {
            config
        };
    }), async ({ config }) => {
        stdout?.write(`${config.pathspec.toUpperCase()}\n`)
        const dependents = allConfigs.filter(c => c.isDependent(config))
        for (const dependent of dependents)
            stdout?.write('  - ' + dependent.pathspec + '\n');
    });
}

export async function setDependencies(rootConfig: Config, { stdout, dryRun, ...params }: ActionParams<{
    configs: ActionParam<Config[], { configs: Config[] }>;
    dependencies: ActionParam<Config[], { config: Config, configs: Config[] }>;
}>) {
    const allConfigs = rootConfig.flattenConfigs().filter(c => c.managed);
    const configs = await params.configs({ configs: allConfigs });

    await Bluebird.mapSeries(Bluebird.mapSeries(configs, async config => {
        return {
            config,
            dependencies: await params.dependencies({ config, configs: allConfigs })
        };
    }), async ({ config, dependencies }) => {
        config.dependencies = dependencies.map(d => d.identifier);

        await config.save({ stdout, dryRun });
    });
}

function resolveDependants(configs: Config[], allConfigs: Config[]) {
    const dependentConfigs: Config[] = [];

    const inner = (config: Config) => {
        for (const dependentConfig of allConfigs.filter(c => c.isDependent(config))) {
            if (dependentConfigs.indexOf(dependentConfig) < 0 && configs.indexOf(dependentConfig) < 0) {
                dependentConfigs.push(dependentConfig);
                inner(dependentConfig);
            }
        }
    };

    for (const config of configs)
        inner(config);

    return dependentConfigs;
}
