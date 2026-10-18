import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { lightingRevision } from '../scripts/lighting-plugin';

test('lighting revision follows nested/new bake dependencies and the dependency lockfile', async () => {
  const root = await mkdtemp(join(tmpdir(), 'samewhere-lighting-inputs-'));
  const put = (path: string, source: string) => writeFile(join(root, path), source);
  try {
    await mkdir(join(root, 'scripts')); await mkdir(join(root, 'src'));
    await put('scripts/bake-lighting.ts', "import '../src/level';");
    await put('src/level.ts', "import './light';"); await put('src/light.ts', 'export const intensity = 25;');
    await put('scripts/lighting-plugin.ts', ''); await put('package.json', '{}'); await put('package-lock.json', '{}');
    const first = await lightingRevision(root);
    const draft = await lightingRevision(root, 'draft');
    assert.notEqual(draft.revision, first.revision, 'Draft and full lighting must have separate assets');
    assert.equal((await lightingRevision(root, 'draft')).revision, draft.revision);
    assert.ok(first.files.has(join(root, 'src/light.ts')));
    assert.equal((await lightingRevision(root)).revision, first.revision);
    await put('src/unrelated.ts', 'export const hud = true;');
    assert.equal((await lightingRevision(root)).revision, first.revision);
    await put('src/light.ts', 'export const intensity = 26;');
    const changed = await lightingRevision(root); assert.notEqual(changed.revision, first.revision);
    await put('src/light.ts', "import './new-algorithm';"); await put('src/new-algorithm.ts', 'export const samples = 9;');
    const added = await lightingRevision(root); assert.ok(added.files.has(join(root, 'src/new-algorithm.ts')));
    await put('src/new-algorithm.ts', 'export const samples = 16;');
    const algorithm = await lightingRevision(root); assert.notEqual(algorithm.revision, added.revision);
    await put('package-lock.json', '{"lockfileVersion": 3}');
    assert.notEqual((await lightingRevision(root)).revision, algorithm.revision);
  } finally { await rm(root, { recursive: true, force: true }); }
});
