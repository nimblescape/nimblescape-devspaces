// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// The default image of the settings (DevspaceSource `defaultImage`): the open reads and builds the synthesized
// configuration `{ "image": … }` in place of the configuration of the repository, records the source in the entry and
// in the build record, builds again when the source switches, asks when the default image changes, restores the source
// after a failed switch, and the headless prepare builds the synthesized configuration too. The extension side (the
// settings, the commands, the context menu) is in src/vscode.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { UserFacingError } from '../errors';
import { DevcontainerCommandError } from '../helper/devcontainerCli';
import { LABEL_BUILD_RECORD, devspaceImageName, preparedImageName } from '../names';
import type { Devspace, DevspaceSource } from '../types';
import type { RepositoryTarget } from './operationBase';
import {
  BASE_IMAGE,
  DEFAULT_CONFIG_TEXT,
  DIGEST_NEW,
  DIGEST_OLD,
  ENV_ID,
  FEATURE,
  FEATURE_DIGEST,
  REPO,
  checked,
  createHarness,
  headlessPrepareService,
  imageConfigWithUser,
  prepareRun,
  seedDevspace,
  type Harness,
} from './devspaceService.testkit';
import { imageRecordLabels } from './imageRecord';
import { configHash, defaultImageConfiguration } from './pipelineRules';
import { DEFAULT_CONFIG_PATH } from './recordRules';

const IMAGE = 'ghcr.io/majikmate/devcontainer-base:latest';
const OTHER_IMAGE = 'ghcr.io/majikmate/devcontainer-base:2';
const IMAGE_DIGEST = `sha256:${'d'.repeat(64)}`;
const OTHER_DIGEST = `sha256:${'e'.repeat(64)}`;
const TARGET: RepositoryTarget = { repository: REPO, defaultBranch: 'main', configPaths: [DEFAULT_CONFIG_PATH], trusted: true };
const DEFAULT_IMAGE: DevspaceSource = { kind: 'defaultImage', image: IMAGE };
const CONFIGURATION: DevspaceSource = { kind: 'configuration' };
const IMAGE_1 = devspaceImageName(REPO, ENV_ID, 1);
const IMAGE_2 = devspaceImageName(REPO, ENV_ID, 2);
/** The digests of the registry for every reference of these tests (the check asks only for those of the open). */
const DIGESTS: Record<string, string> = { [BASE_IMAGE]: DIGEST_NEW, [IMAGE]: IMAGE_DIGEST, [OTHER_IMAGE]: OTHER_DIGEST, [FEATURE]: FEATURE_DIGEST };
const PREPARED = preparedImageName(REPO, ENV_ID);
/** The synthesized configuration of IMAGE, as the open reads and builds it. */
const SYNTHESIZED = defaultImageConfiguration(IMAGE);

let h: Harness;

beforeEach(() => {
  h = createHarness();
  // The registry answers for the references that the open asks for: those of the configuration, or the default image.
  const answers = (references: readonly string[]) => Object.fromEntries(references.filter((reference) => reference in DIGESTS).map((reference) => [reference, DIGESTS[reference]]));
  h.checker.outcome = (references) => checked(answers(references.images), answers(references.features));
});

afterEach(() => {
  h.cleanup();
});

function options(source?: DevspaceSource) {
  return { progress: h.progress, ...(source !== undefined ? { source } : {}) };
}

/** A devspace that was built from the default image IMAGE (its record and its entry say so), up to date. */
async function seedDefaultImageDevspace(extra: Parameters<typeof seedDevspace>[1] = {}): Promise<Devspace> {
  return seedDevspace(h, {
    record: { configHash: configHash(SYNTHESIZED.text), defaultImage: IMAGE, images: { [IMAGE]: IMAGE_DIGEST }, features: {} },
    extra: { defaultImage: IMAGE },
    ...extra,
  });
}

/** The build record of the devspace image `tag` as its labels carry it (without the pinned ID). */
function labelledRecord(tag: string): Record<string, unknown> {
  return JSON.parse(h.docker.labelled.get(tag)![LABEL_BUILD_RECORD]) as Record<string, unknown>;
}

async function rejection(promise: Promise<unknown>): Promise<UserFacingError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof UserFacingError) return error;
    throw error;
  }
  throw new Error('The promise did not reject.');
}

describe('an open with the default image', () => {
  it('reads and builds the synthesized configuration in place of the files of the repository, and records the source', async () => {
    // The repository has no Dev Container configuration at all: the default image needs none.
    h.helper.files = {};
    const result = await h.service.open(TARGET, options(DEFAULT_IMAGE));
    const env = (await h.registry.get(result.devspace.id))!;
    const image = devspaceImageName(REPO, env.id, 1);
    expect(env.defaultImage).toBe(IMAGE);
    expect(env.configPath).toBe(DEFAULT_CONFIG_PATH);
    expect(env.buildRecord).toMatchObject({
      devspaceImage: image,
      configPath: DEFAULT_CONFIG_PATH,
      configHash: configHash(SYNTHESIZED.text),
      defaultImage: IMAGE,
      images: { [IMAGE]: IMAGE_DIGEST },
      features: {},
    });
    // The CLI reads our configuration (`--override-config`) under the configuration path of the devspace; the files
    // of the repository are not read.
    expect(h.helper.readConfigurations.map((read) => [read.configPath, read.override])).toEqual([
      [DEFAULT_CONFIG_PATH, SYNTHESIZED.config],
      [DEFAULT_CONFIG_PATH, SYNTHESIZED.config],
    ]);
    expect(h.helper.calls.filter((call) => call.startsWith('readConfigFiles') || call.startsWith('listConfigurations'))).toEqual([]);
    // The build takes the synthesized configuration as our copy (`--config`), and the image is pulled before it.
    expect(h.helper.builds).toEqual([{ imageName: image, configPath: DEFAULT_CONFIG_PATH, override: SYNTHESIZED.config }]);
    expect(h.docker.log).toContain(`pull ${IMAGE}`);
    expect(h.helper.ups.map((up) => up.override.image)).toEqual([image]);
    // The image carries the record with the source.
    expect(labelledRecord(image)).toMatchObject({ defaultImage: IMAGE });
    expect(h.ui.prompts).toEqual([]);
    expect(h.ui.warnings).toEqual([]);
    expect(h.logger.infos).toContain(`${REPO} opens with the default image ${IMAGE} in place of its configuration.`);
  });

  it('"Select configuration…" names the configuration, whatever source the open names', async () => {
    const result = await h.service.open(TARGET, { ...options(DEFAULT_IMAGE), configPath: DEFAULT_CONFIG_PATH });
    const env = (await h.registry.get(result.devspace.id))!;
    expect(env).not.toHaveProperty('defaultImage');
    expect(env.buildRecord).not.toHaveProperty('defaultImage');
    expect(h.helper.builds).toEqual([{ imageName: devspaceImageName(REPO, env.id, 1), configPath: DEFAULT_CONFIG_PATH }]);
    expect(h.helper.readConfigurations.every((read) => read.override === undefined)).toBe(true);
  });

  it('builds a devspace of the configuration again from the default image, and creates its container again', async () => {
    await seedDevspace(h, { container: 'running' });
    await h.service.openDevspace(ENV_ID, options(DEFAULT_IMAGE));
    expect(h.helper.builds).toEqual([{ imageName: IMAGE_2, configPath: DEFAULT_CONFIG_PATH, override: SYNTHESIZED.config }]);
    expect(h.helper.ups).toEqual([expect.objectContaining({ image: IMAGE_2, removeExistingContainer: true })]);
    // Without a question: the user named the source.
    expect(h.ui.prompts).toEqual([]);
    const env = (await h.registry.get(ENV_ID))!;
    expect(env.defaultImage).toBe(IMAGE);
    expect(env.buildRecord).toMatchObject({ devspaceImage: IMAGE_2, defaultImage: IMAGE, images: { [IMAGE]: IMAGE_DIGEST } });
    expect(h.logger.infos).toContain(
      `Source of ${REPO}: the configuration ${DEFAULT_CONFIG_PATH} → the default image ${IMAGE}. The devspace is built again.`,
    );
  });

  it('keeps the default image of the last open when the open names no source', async () => {
    await seedDefaultImageDevspace({ container: 'stopped' });
    await h.service.openDevspace(ENV_ID, options());
    expect(h.helper.builds).toEqual([]);
    expect(h.helper.readConfigurations.every((read) => read.override?.image === IMAGE)).toBe(true);
    expect(h.helper.calls.filter((call) => call.startsWith('readConfigFiles'))).toEqual([]);
    expect(h.helper.ups.map((up) => up.image)).toEqual([IMAGE_1]);
    expect(h.ui.prompts).toEqual([]);
    expect((await h.registry.get(ENV_ID))?.defaultImage).toBe(IMAGE);
  });

  it('keeps the default image of the build record of an entry restored from its volume', async () => {
    const env = await seedDefaultImageDevspace({ container: 'stopped' });
    const record = env.buildRecord!;
    const config = imageConfigWithUser('vscode');
    h.docker.imageConfigs.set(record.devspaceImage, { ...config, Labels: { ...config.Labels, ...imageRecordLabels(env, record) } });
    // The entry lost its record and its source (as reconcileFromVolumes restores it).
    await h.registry.updateDevspace(ENV_ID, (entry) => {
      delete entry.buildRecord;
      delete entry.defaultImage;
    });
    await h.service.openDevspace(ENV_ID, options());
    expect(h.helper.builds).toEqual([]);
    expect(h.helper.readConfigurations.every((read) => read.override?.image === IMAGE)).toBe(true);
    expect((await h.registry.get(ENV_ID))).toMatchObject({ defaultImage: IMAGE, buildRecord: { defaultImage: IMAGE } });
  });

  it('asks Rebuild now or Later when the default image changed; Later keeps the container and records the new image', async () => {
    await seedDefaultImageDevspace({ container: 'stopped' });
    h.ui.configurationChangedAnswer = 'later';
    await h.service.openDevspace(ENV_ID, options({ kind: 'defaultImage', image: OTHER_IMAGE }));
    expect(h.ui.prompts).toEqual([`configurationChanged ${REPO} defaultImage`]);
    expect(h.helper.builds).toEqual([]);
    expect(h.helper.ups.map((up) => up.image)).toEqual([IMAGE_1]);
    const env = (await h.registry.get(ENV_ID))!;
    expect(env.defaultImage).toBe(OTHER_IMAGE);
    expect(env.buildRecord?.defaultImage).toBe(IMAGE);
    expect(h.logger.infos).toContain(`The default image of ${REPO} changed since the last build: ${IMAGE} → ${OTHER_IMAGE}.`);
  });

  it('Rebuild now builds from the changed default image', async () => {
    await seedDefaultImageDevspace({ container: 'stopped' });
    h.ui.configurationChangedAnswer = 'rebuildNow';
    await h.service.openDevspace(ENV_ID, options({ kind: 'defaultImage', image: OTHER_IMAGE }));
    expect(h.ui.prompts).toEqual([`configurationChanged ${REPO} defaultImage`]);
    expect(h.helper.builds).toEqual([{ imageName: IMAGE_2, configPath: DEFAULT_CONFIG_PATH, override: defaultImageConfiguration(OTHER_IMAGE).config }]);
    expect((await h.registry.get(ENV_ID))?.buildRecord).toMatchObject({ devspaceImage: IMAGE_2, defaultImage: OTHER_IMAGE, images: { [OTHER_IMAGE]: OTHER_DIGEST } });
  });

  it('builds a devspace of the default image again from the configuration, without a question', async () => {
    await seedDefaultImageDevspace({ container: 'running' });
    await h.service.openDevspace(ENV_ID, options(CONFIGURATION));
    expect(h.ui.prompts).toEqual([]);
    expect(h.helper.calls.filter((call) => call.startsWith('readConfigFiles'))).toEqual([`readConfigFiles ${DEFAULT_CONFIG_PATH}`]);
    expect(h.helper.readConfigurations.every((read) => read.override === undefined)).toBe(true);
    expect(h.helper.builds).toEqual([{ imageName: IMAGE_2, configPath: DEFAULT_CONFIG_PATH }]);
    expect(h.helper.ups).toEqual([expect.objectContaining({ image: IMAGE_2, removeExistingContainer: true })]);
    const env = (await h.registry.get(ENV_ID))!;
    expect(env).not.toHaveProperty('defaultImage');
    expect(env.buildRecord).toMatchObject({ devspaceImage: IMAGE_2, configHash: configHash(DEFAULT_CONFIG_TEXT), images: { [BASE_IMAGE]: DIGEST_NEW } });
    expect(env.buildRecord).not.toHaveProperty('defaultImage');
    expect(h.logger.infos).toContain(
      `Source of ${REPO}: the default image ${IMAGE} → the configuration ${DEFAULT_CONFIG_PATH}. The devspace is built again.`,
    );
  });

  it('asks Rebuild now or Later when the selected source was not built (a switch that fell back to the old devspace)', async () => {
    // The entry names the default image, the record the configuration: the build of the switch failed and the old
    // devspace started instead. An open that names no source does not build again on its own.
    await seedDevspace(h, { container: 'stopped', extra: { defaultImage: IMAGE } });
    h.ui.configurationChangedAnswer = 'later';
    await h.service.openDevspace(ENV_ID, options());
    expect(h.ui.prompts).toEqual([`configurationChanged ${REPO} source`]);
    expect(h.helper.builds).toEqual([]);
    expect(h.helper.ups.map((up) => up.image)).toEqual([IMAGE_1]);
    expect(h.logger.infos).toContain(`Source of ${REPO}: built from the configuration ${DEFAULT_CONFIG_PATH}, selected the default image ${IMAGE}.`);
    expect((await h.registry.get(ENV_ID))).toMatchObject({ defaultImage: IMAGE, buildRecord: { devspaceImage: IMAGE_1 } });

    h.ui.configurationChangedAnswer = 'rebuildNow';
    await h.service.openDevspace(ENV_ID, options());
    expect(h.helper.builds).toEqual([{ imageName: IMAGE_2, configPath: DEFAULT_CONFIG_PATH, override: SYNTHESIZED.config }]);
    expect((await h.registry.get(ENV_ID))?.buildRecord).toMatchObject({ devspaceImage: IMAGE_2, defaultImage: IMAGE });
  });

  it('restores the source of the last open when the switch could not be started', async () => {
    // No container and no image to fall back to: the failed build ends the open.
    await seedDefaultImageDevspace({ container: null, image: false });
    h.helper.buildError = () => new DevcontainerCommandError('devcontainer build', 1, '', 'no space left on device');
    const error = await rejection(h.service.openDevspace(ENV_ID, options(CONFIGURATION)));
    expect(error.code).toBe('buildFailed');
    const env = (await h.registry.get(ENV_ID))!;
    expect(env.defaultImage).toBe(IMAGE);
    expect(env.configPath).toBe(DEFAULT_CONFIG_PATH);
    expect(h.logger.infos).toContain(
      `the configuration ${DEFAULT_CONFIG_PATH} of ${REPO} could not be started; the default image ${IMAGE} stays selected.`,
    );
  });
});

describe('the headless prepare of a devspace of the default image', () => {
  it('builds the synthesized configuration as our copy (no frozen lockfile), reads no files, and the open takes the image', async () => {
    const env = await seedDefaultImageDevspace({ record: { configHash: configHash(SYNTHESIZED.text), defaultImage: IMAGE, images: { [IMAGE]: DIGEST_OLD }, features: {} }, container: 'running' });
    const record = env.buildRecord!;
    const config = imageConfigWithUser('vscode');
    h.docker.imageConfigs.set(record.devspaceImage, { ...config, Labels: { ...config.Labels, ...imageRecordLabels(env, record) } });
    const { run } = prepareRun();
    const headless = headlessPrepareService(h);
    const result = await headless.service.prepare(ENV_ID, run);
    expect(result).toMatchObject({ outcome: 'prepared' });
    expect(headless.hostUses).toEqual([]);
    expect(h.helper.builds).toEqual([{ imageName: PREPARED, configPath: DEFAULT_CONFIG_PATH, override: SYNTHESIZED.config }]);
    expect(h.helper.calls.filter((call) => call.startsWith('readConfigFiles') || call.startsWith('listConfigurations'))).toEqual([]);
    expect(h.helper.readConfigurations.every((read) => read.override?.image === IMAGE)).toBe(true);
    expect(h.docker.log).toContain(`pull ${IMAGE}`);
    // Then the open takes the prepared image: no build of its own.
    await h.service.openDevspace(ENV_ID, options());
    expect(h.helper.builds.map((build) => build.imageName)).toEqual([PREPARED]);
    expect((await h.registry.get(ENV_ID))?.buildRecord).toMatchObject({ devspaceImage: IMAGE_2, defaultImage: IMAGE, images: { [IMAGE]: IMAGE_DIGEST } });
  });
});
