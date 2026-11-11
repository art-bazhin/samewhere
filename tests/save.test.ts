import test from 'node:test';
import assert from 'node:assert/strict';
import { Game, FINAL_PASSAGE_GOALS, PASSAGE_GOALS } from '../src/world';
import { hasSave, loadSave, saveGame, SAVE_KEY } from '../src/save';

function memoryStorage() {
  const entries = new Map<string, string>();
  return { getItem: (key: string) => entries.get(key) ?? null, setItem: (key: string, value: string) => { entries.set(key, value); } };
}

test('a save restores position, balls, selected color, progress, undo history and audio milestones', () => {
  const game = new Game(), storage = memoryStorage();
  game.interact({ room: 'B', side: 0 }); game.interact({ room: 'C', side: 0 });
  game.world.passageProgress = 2;
  Object.assign(game.player, { room: 'G', x: 1.25, z: 3.75, yaw: -4.2, pitch: .3 });
  game.transitions = 7;
  saveGame(game, [0, 1, 2, 3], false, storage);
  const saved = loadSave(storage)!;
  assert.deepEqual(saved.state, game.snapshot()); assert.deepEqual(saved.history, game.history);
  assert.equal(saved.transitions, 7); assert.deepEqual(saved.music, [0, 1, 2, 3]); assert.equal(saved.soundEnabled, false);
  const resumed = new Game(); resumed.restore(saved.state); resumed.history = saved.history;
  resumed.undo(); assert.deepEqual(resumed.snapshot(), game.history.at(-1));
  game.reset(); saveGame(game, [0], true, storage);
  assert.deepEqual(loadSave(storage)!.state, new Game().snapshot()); assert.deepEqual(loadSave(storage)!.history, []);
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

test('missing, damaged, incompatible and invalid saves fall back to a new game', () => {
  const storage = memoryStorage(); assert.equal(loadSave(storage), null);
  for (const json of ['{', 'null', '{}', '{"version":2}']) {
    storage.setItem(SAVE_KEY, json); assert.equal(loadSave(storage), null);
  }
  const changes = [
    (save: any) => { save.state.world.balls[0].id = 'unknown'; },
    (save: any) => { save.state.world.balls[0].socket.side = 99; },
    (save: any) => { save.state.player.x = null; },
    (save: any) => { save.state.player.room = 'unknown'; },
    (save: any) => { save.state.world.passageProgress = 99; },
    (save: any) => { save.state.world.gallery = { cell: { x: 0, z: 0 }, signs: [], outside: false }; },
    (save: any) => { save.history = [null]; },
    (save: any) => { save.music = [0, 99]; },
  ];
  for (const change of changes) {
    saveGame(new Game(), [0], true, storage);
    const save = JSON.parse(storage.getItem(SAVE_KEY)!); change(save);
    storage.setItem(SAVE_KEY, JSON.stringify(save)); assert.equal(loadSave(storage), null);
  }
});

test('blocked storage and quota errors do not interrupt play', () => {
  const storage = { getItem(): string | null { throw new Error('Blocked'); }, setItem() { throw new Error('Quota exceeded'); } };
  assert.equal(hasSave(storage), false);
  assert.equal(loadSave(storage), null);
  assert.doesNotThrow(() => saveGame(new Game(), [0], true, storage));
});
