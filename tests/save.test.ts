import test from 'node:test';
import assert from 'node:assert/strict';
import { Game, FINAL_PASSAGE_GOALS, PASSAGE_GOALS } from '../src/world';
import { hasSave, loadSave, saveGame, SAVE_KEY } from '../src/save';
import { GAME_VERSION } from '../src/version';
import { loadSettings, saveSettings } from '../src/settings';
import type { RunAnalyticsState } from '../src/run-analytics';

function memoryStorage() {
  const entries = new Map<string, string>();
  return { getItem: (key: string) => entries.get(key) ?? null,
    setItem: (key: string, value: string) => { entries.set(key, value); }, removeItem: (key: string) => { entries.delete(key); } };
}

test('a save restores position, balls, selected color, progress and audio milestones', () => {
  const game = new Game(), storage = memoryStorage();
  game.interact({ room: 'B', side: 0 }); game.interact({ room: 'C', side: 0 });
  game.world.passageProgress = 2;
  Object.assign(game.player, { room: 'G', x: 1.25, z: 3.75, yaw: -4.2, pitch: .3 });
  game.transitions = 7;
  saveGame(game, [0, 1, 2, 3], false, storage);
  const saved = loadSave(storage)!;
  assert.equal(saved.version, GAME_VERSION);
  assert.deepEqual(saved.state, game.snapshot());
  assert.equal('history' in JSON.parse(storage.getItem(SAVE_KEY)!), false);
  assert.equal(saved.transitions, 7); assert.deepEqual(saved.music, [0, 1, 2, 3]); assert.equal(saved.soundEnabled, false);
  const resumed = new Game(); resumed.restore(saved.state);
  assert.deepEqual(resumed.snapshot(), game.snapshot());
  game.reset(); saveGame(game, [0], true, storage);
  assert.deepEqual(loadSave(storage)!.state, new Game().snapshot());
});

test('the EXIT gallery and completed ending survive serialization', () => {
  const game = new Game(), storage = memoryStorage();
  game.world.balls.forEach(ball => { ball.socket = null; }); game.world.passageProgress = PASSAGE_GOALS.length;
  for (const goal of FINAL_PASSAGE_GOALS) { game.selectColor(goal.color); game.interact(goal.from); }
  game.world.gallery!.cell = { x: 8, z: 17 };
  for (const outside of [false, true]) {
    game.world.gallery!.outside = outside; saveGame(game, [0, 1, 2, 3, 4, 5], true, storage);
    assert.deepEqual(loadSave(storage)!.state, game.snapshot());
  }
});

test('obsolete history is discarded without rejecting the current-version saved state', () => {
  const game = new Game(), storage = memoryStorage();
  game.interact({ room: 'B', side: 0 }); saveGame(game, [0, 1], false, storage);
  const current = storage.getItem(SAVE_KEY)!;
  for (const history of [Array(256).fill(game.snapshot()), [null], 'obsolete']) {
    storage.setItem(SAVE_KEY, JSON.stringify({ ...JSON.parse(current), history }));
    const saved = loadSave(storage)!;
    assert.deepEqual(saved.state, game.snapshot());
    assert.equal('history' in saved, false);
    const resumed = new Game(); resumed.restore(saved.state); resumed.transitions = saved.transitions;
    saveGame(resumed, saved.music, saved.soundEnabled, storage);
    assert.equal(storage.getItem(SAVE_KEY), current);
  }
});

test('incompatible saves are removed with their analytics while settings and SDK storage survive', () => {
  const game = new Game(), storage = memoryStorage();
  game.player.room = 'G'; game.world.passageProgress = 2; game.transitions = 30;
  saveSettings({ lookSensitivity: 2.3 }, storage);
  storage.setItem('sdk-storage', 'keep');
  for (const version of [GAME_VERSION - 1, GAME_VERSION + 1, undefined]) {
    saveGame(game, [0, 1, 2], false, storage, { version: GAME_VERSION, activeMs: 42_000, reached: ['run_started', 'room_H_visited'] });
    const saved = JSON.parse(storage.getItem(SAVE_KEY)!); saved.version = version;
    storage.setItem(SAVE_KEY, JSON.stringify(saved));
    assert.equal(loadSave(storage), null);
    assert.equal(storage.getItem(SAVE_KEY), null);
    assert.equal(hasSave(storage), false);
    assert.deepEqual(loadSettings(storage), { lookSensitivity: 2.3 });
    assert.equal(storage.getItem('sdk-storage'), 'keep');
  }
});

test('missing, damaged, incompatible and invalid saves fall back to a new game', () => {
  const storage = memoryStorage(); assert.equal(loadSave(storage), null);
  for (const json of ['{', 'null', '{}', JSON.stringify({ version: GAME_VERSION + 1 })]) {
    storage.setItem(SAVE_KEY, json); assert.equal(loadSave(storage), null);
  }
  const changes = [
    (save: any) => { save.state.world.balls[0].id = 'unknown'; },
    (save: any) => { save.state.world.balls[0].socket.side = 99; },
    (save: any) => { save.state.player.x = null; },
    (save: any) => { save.state.player.room = 'unknown'; },
    (save: any) => { save.state.world.passageProgress = 99; },
    (save: any) => { save.state.world.gallery = { cell: { x: 0, z: 0 }, signs: [], outside: false }; },
    (save: any) => { save.music = [0, 99]; },
  ];
  for (const change of changes) {
    saveGame(new Game(), [0], true, storage);
    const save = JSON.parse(storage.getItem(SAVE_KEY)!); change(save);
    storage.setItem(SAVE_KEY, JSON.stringify(save)); assert.equal(loadSave(storage), null);
  }
});

test('blocked storage and quota errors do not interrupt play', () => {
  const storage = { getItem(): string | null { throw new Error('Blocked'); }, setItem() { throw new Error('Quota exceeded'); }, removeItem() { throw new Error('Blocked'); } };
  assert.equal(hasSave(storage), false);
  assert.equal(loadSave(storage), null);
  assert.doesNotThrow(() => saveGame(new Game(), [0], true, storage));
});

test('analytics checkpoints survive saving, while damaged analytics do not discard game progress', () => {
  const game = new Game(), storage = memoryStorage();
  const analytics: RunAnalyticsState = { version: GAME_VERSION, activeMs: 42_000, reached: ['run_started', 'room_4_visited', 'symbol_connection_5_opened'] };
  saveGame(game, [0], true, storage, analytics);
  assert.deepEqual(loadSave(storage)!.analytics, analytics);
  const saved = JSON.parse(storage.getItem(SAVE_KEY)!);
  saved.analytics.activeMs = -1; storage.setItem(SAVE_KEY, JSON.stringify(saved));
  assert.deepEqual(loadSave(storage)!.state, game.snapshot());
  assert.equal(loadSave(storage)!.analytics, undefined);
});
