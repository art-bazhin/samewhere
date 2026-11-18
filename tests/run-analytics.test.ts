import test from 'node:test';
import assert from 'node:assert/strict';
import { Game, FINAL_PASSAGE_GOALS, PASSAGE_GOALS, portalPosition, ROOM_IDS, wallNormal } from '../src/world';
import { MILESTONES, readRunAnalytics, RunAnalytics } from '../src/run-analytics';
import { createGameAnalyticsSink, type AnalyticsCommand } from '../src/game-analytics';
import { GAME_VERSION } from '../src/version';

const roomLabels = { A: '4', B: '5', C: '6', D: '3', E: 'Y', F: 'X', G: 'H' } as const;
const eventId = (milestone: string) => `v${GAME_VERSION}:${milestone}`;

function fixture() {
  let now = 0;
  const events: [string, number][] = [], game = new Game();
  const tracker = new RunAnalytics(undefined, (event, value) => events.push([event, value]), true, () => now);
  const advance = (ms: number) => { now += ms; };
  tracker.reset(); tracker.play(game); tracker.setPlaying(true);
  const value = (milestone: string) => events.find(([event]) => event === eventId(milestone))?.[1];
  return { tracker, game, events, advance, value };
}

function collect(game: Game, tracker: RunAnalytics) {
  for (const ball of game.world.balls) if (ball.socket) {
    assert.equal(game.interact(ball.socket), 'take'); tracker.observe(game);
  }
}

function place(game: Game, tracker: RunAnalytics, color: 'red' | 'blue', room: typeof game.player.room, side: number) {
  game.selectColor(color); assert.equal(game.interact({ room, side }), 'place'); tracker.observe(game);
}

test('preparing a new run and observing its room does not send a start before play begins', () => {
  const game = new Game(), events: string[] = [];
  const tracker = new RunAnalytics(undefined, event => events.push(event));
  tracker.reset(); tracker.observe(game);
  assert.equal(events.length, 0); assert.deepEqual(tracker.snapshot()!.reached, []);
  tracker.play(game); tracker.play(game);
  assert.deepEqual(events, [
    eventId('run_started'),
    eventId('room_4_visited'),
  ]);
});

test('milestones send only cumulative thinking time once, excluding pauses', () => {
  const { tracker, game, events, advance, value } = fixture();
  advance(1250); game.player.room = 'B'; game.transitions = 1; tracker.observe(game);
  assert.equal(value('room_5_visited'), 1);
  advance(500); game.player.room = 'C'; tracker.observe(game);
  assert.equal(value('room_6_visited'), 1);
  tracker.setPlaying(false); advance(60_000); tracker.setPlaying(true);
  advance(2250); game.player.room = 'D'; game.transitions = 5; tracker.observe(game);
  assert.equal(value('room_3_visited'), 4);
  for (let i = 0; i < 20; i++) tracker.observe(game);
  assert.equal(events.filter(([event]) => event === eventId('room_3_visited')).length, 1);
  assert.ok(events.every(([event]) => new RegExp(`^v${GAME_VERSION}:[^:]+$`).test(event)));
  assert.equal(tracker.snapshot()!.activeMs, 4000);
});

test('each room has a first visit and newly revealed drawings require a separate visit', () => {
  const { tracker, game, events, advance, value } = fixture();
  for (const room of ROOM_IDS) {
    game.player.room = room; game.transitions++; tracker.observe(game);
    assert.equal(value(`room_${roomLabels[room]}_visited`), 0);
  }
  assert.deepEqual(events.filter(([event]) => new RegExp(`^v${GAME_VERSION}:room_[3456XYH]_visited$`).test(event)).map(([event]) => event).sort(), [
    eventId('room_3_visited'), eventId('room_4_visited'), eventId('room_5_visited'), eventId('room_6_visited'),
    eventId('room_X_visited'), eventId('room_Y_visited'), eventId('room_H_visited'),
  ].sort());
  assert.equal(value('symbol_room_5_visited'), undefined);
  for (const [index, goal] of PASSAGE_GOALS.entries()) {
    game.player.room = 'G'; collect(game, tracker);
    const wrong = goal.color === 'red' ? 'blue' : 'red';
    place(game, tracker, wrong, goal.from.room, goal.from.side); place(game, tracker, wrong, goal.to, 0);
    assert.equal(game.world.passageProgress, index); assert.equal(value(`symbol_connection_${roomLabels[goal.to]}_opened`), undefined);
    collect(game, tracker);
    advance(1000);
    place(game, tracker, goal.color, goal.from.room, goal.from.side); place(game, tracker, goal.color, goal.to, 0);
    assert.equal(game.world.passageProgress, index + 1);
    assert.equal(value(`symbol_connection_${roomLabels[goal.to]}_opened`), index * 2 + 1);
    assert.equal(value(`symbol_room_${roomLabels[goal.to]}_visited`), undefined);
    advance(1000); game.player.room = goal.to; game.transitions++; tracker.observe(game);
    assert.equal(value(`symbol_room_${roomLabels[goal.to]}_visited`), index * 2 + 2);
    game.player.room = 'G'; tracker.observe(game); game.player.room = goal.to; tracker.observe(game);
    assert.equal(events.filter(([event]) => event === eventId(`symbol_room_${roomLabels[goal.to]}_visited`)).length, 1);
  }
});

test('symbol milestones reject a wrong wall, destination, color, and an incomplete pair at every stage', () => {
  for (const [stage, goal] of PASSAGE_GOALS.entries()) {
    const { tracker, game, value } = fixture(); game.player.room = 'G';
    for (const previous of PASSAGE_GOALS.slice(0, stage)) {
      collect(game, tracker);
      place(game, tracker, previous.color, previous.from.room, previous.from.side); place(game, tracker, previous.color, previous.to, 0);
    }
    const other = goal.color === 'red' ? 'blue' : 'red';
    for (const [from, to, color] of [
      [{ ...goal.from, side: goal.from.side === 0 ? 1 : 0 }, { room: goal.to, side: 0 }, goal.color],
      [goal.from, { room: 'C', side: 0 }, goal.color],
      [goal.from, { room: goal.to, side: 0 }, other],
    ] as const) {
      collect(game, tracker);
      place(game, tracker, color, from.room, from.side); place(game, tracker, color, to.room, to.side);
      assert.equal(game.world.passageProgress, stage); assert.equal(value(`symbol_connection_${roomLabels[goal.to]}_opened`), undefined);
    }
    collect(game, tracker);
    place(game, tracker, goal.color, goal.from.room, goal.from.side);
    assert.equal(value(`symbol_connection_${roomLabels[goal.to]}_opened`), undefined);
    place(game, tracker, goal.color, goal.to, 0);
    assert.equal(game.world.passageProgress, stage + 1); assert.equal(value(`symbol_connection_${roomLabels[goal.to]}_opened`), 0);
  }
});

test('a future connection does not send its milestone until the preceding goals are completed', () => {
  for (const future of [1, 2]) {
    const { tracker, game, advance, value } = fixture(); game.player.room = 'G';
    for (const previous of PASSAGE_GOALS.slice(0, future - 1)) {
      collect(game, tracker);
      place(game, tracker, previous.color, previous.from.room, previous.from.side); place(game, tracker, previous.color, previous.to, 0);
    }
    collect(game, tracker); advance(1000);
    const goal = PASSAGE_GOALS[future], missing = PASSAGE_GOALS[future - 1];
    place(game, tracker, goal.color, goal.from.room, goal.from.side); place(game, tracker, goal.color, goal.to, 0);
    assert.equal(game.world.passageProgress, future - 1); assert.equal(value(`symbol_connection_${roomLabels[goal.to]}_opened`), undefined);
    advance(1000);
    place(game, tracker, missing.color, missing.from.room, missing.from.side); place(game, tracker, missing.color, missing.to, 0);
    assert.equal(game.world.passageProgress, future + 1); assert.equal(value(`symbol_connection_${roomLabels[goal.to]}_opened`), 2);
    assert.equal(value(`symbol_room_${roomLabels[goal.to]}_visited`), undefined);
  }
});

test('a newly revealed drawing is recorded if the player is already in its room, only once across reload', () => {
  const { tracker, game, events, advance, value } = fixture();
  game.player.room = 'B'; tracker.observe(game); collect(game, tracker);
  assert.equal(value('symbol_room_5_visited'), undefined);
  advance(1000);
  place(game, tracker, 'red', 'G', 3); place(game, tracker, 'red', 'B', 0);
  assert.equal(value('symbol_room_5_visited'), 1);
  const resumed = new RunAnalytics(tracker.snapshot(), (event, value) => events.push([event, value]));
  resumed.play(game); resumed.observe(game);
  assert.equal(events.filter(([event]) => event === eventId('symbol_room_5_visited')).length, 1);
});

test('the square pattern milestone requires the entire symbol chain and the fourth correctly placed ball', () => {
  for (let completed = 0; completed <= PASSAGE_GOALS.length; completed++) {
    const { tracker, game, events, advance, value } = fixture();
    game.player.room = 'G';
    for (const goal of PASSAGE_GOALS.slice(0, completed)) {
      collect(game, tracker);
      place(game, tracker, goal.color, goal.from.room, goal.from.side); place(game, tracker, goal.color, goal.to, 0);
    }
    assert.equal(game.world.passageProgress, completed);
    collect(game, tracker); game.player.room = 'A'; tracker.observe(game);
    for (const [index, goal] of FINAL_PASSAGE_GOALS.entries()) {
      assert.equal(value('room_4_pattern_completed'), undefined);
      advance(1000); place(game, tracker, goal.color, goal.from.room, goal.from.side);
      if (index < 3 || completed < PASSAGE_GOALS.length) assert.equal(value('room_4_pattern_completed'), undefined);
    }
    if (completed < PASSAGE_GOALS.length) {
      assert.equal(game.world.passageProgress, completed); assert.equal(game.world.gallery, null);
      assert.equal(events.filter(([event]) => event === eventId('room_4_pattern_completed')).length, 0);
    } else {
      assert.equal(game.world.passageProgress, PASSAGE_GOALS.length + 1); assert.ok(game.world.gallery);
      assert.equal(value('room_4_pattern_completed'), 4);
      game.interact({ room: 'A', side: 3 }); tracker.observe(game);
      place(game, tracker, 'blue', 'A', 3); tracker.observe(game);
      assert.equal(events.filter(([event]) => event === eventId('room_4_pattern_completed')).length, 1);
    }
  }
});

test('wrong final colors and a correct pattern assembled outside A do not send completion', () => {
  const { tracker, game, events, value } = fixture();
  game.player.room = 'G';
  for (const goal of PASSAGE_GOALS) {
    collect(game, tracker);
    place(game, tracker, goal.color, goal.from.room, goal.from.side); place(game, tracker, goal.color, goal.to, 0);
  }
  collect(game, tracker); game.player.room = 'A';
  for (let side = 0; side < 4; side++) place(game, tracker, side < 2 ? 'red' : 'blue', 'A', side);
  assert.equal(value('room_4_pattern_completed'), undefined); assert.equal(game.world.gallery, null);
  collect(game, tracker); game.player.room = 'G';
  for (const goal of FINAL_PASSAGE_GOALS) place(game, tracker, goal.color, 'A', goal.from.side);
  assert.equal(value('room_4_pattern_completed'), undefined); assert.equal(game.world.gallery, null);
  game.player.room = 'A';
  assert.equal(game.interact({ room: 'A', side: 3 }), 'take'); tracker.observe(game);
  assert.equal(value('room_4_pattern_completed'), undefined);
  place(game, tracker, 'blue', 'A', 3);
  assert.ok(game.world.gallery);
  assert.equal(events.filter(([event]) => event === eventId('room_4_pattern_completed')).length, 1);
});

test('early collection does not consume the final collection milestone before the entire symbol chain', () => {
  const { tracker, game, events, advance, value } = fixture();
  collect(game, tracker);
  assert.equal(value('all_balls_in_4'), undefined);
  assert.equal(tracker.snapshot()!.reached.includes('all_balls_in_4'), false);
  for (const [index, goal] of PASSAGE_GOALS.entries()) {
    game.player.room = 'G';
    place(game, tracker, goal.color, goal.from.room, goal.from.side); place(game, tracker, goal.color, goal.to, 0);
    game.player.room = 'A'; advance(1000); game.transitions += 5;
    collect(game, tracker); tracker.observe(game);
    assert.equal(game.world.passageProgress, index + 1);
    if (index < PASSAGE_GOALS.length - 1) {
      assert.equal(value('all_balls_in_4'), undefined);
      assert.equal(tracker.snapshot()!.reached.includes('all_balls_in_4'), false);
    }
  }
  assert.equal(value('all_balls_in_4'), 3);
  place(game, tracker, 'red', 'A', 0);
  game.player.room = 'G'; tracker.observe(game); game.player.room = 'A'; tracker.observe(game);
  collect(game, tracker); tracker.observe(game);
  assert.equal(events.filter(([event]) => event === eventId('all_balls_in_4')).length, 1);
});

test('final collection includes balls already placed in A, and the completed pattern and exit are distinct', () => {
  const { tracker, game, advance, value } = fixture();
  game.world.passageProgress = PASSAGE_GOALS.length;
  game.world.balls.forEach(ball => { ball.socket = null; });
  game.player.room = 'G'; tracker.observe(game); assert.equal(value('all_balls_in_4'), undefined);
  game.player.room = 'A'; game.world.balls[0].socket = { room: 'A', side: 0 };
  advance(1000); tracker.observe(game); assert.equal(value('all_balls_in_4'), 1);
  game.world.balls[0].socket = null;
  for (const goal of FINAL_PASSAGE_GOALS) { game.selectColor(goal.color); game.interact(goal.from); tracker.observe(game); }
  assert.equal(value('room_4_pattern_completed'), 1); assert.equal(value('game_completed'), undefined);
  advance(2000); game.world.gallery!.outside = true; game.transitions += game.world.gallery!.signs.length; tracker.observe(game);
  assert.equal(value('game_completed'), 3);
});

test('ordinary gallery doors and approaching the final threshold do not send game completion', () => {
  const { tracker, game, events, advance, value } = fixture(); game.player.room = 'G';
  for (const goal of PASSAGE_GOALS) {
    collect(game, tracker);
    place(game, tracker, goal.color, goal.from.room, goal.from.side); place(game, tracker, goal.color, goal.to, 0);
  }
  game.player.room = 'A'; collect(game, tracker);
  for (const goal of FINAL_PASSAGE_GOALS) place(game, tracker, goal.color, 'A', goal.from.side);
  const gallery = game.world.gallery!;
  function approach(side: number) {
    const p = portalPosition('A', side), n = wallNormal('A', side);
    Object.assign(game.player, { x: p.x - n.x * .1, z: p.z - n.z * .1 });
    return n;
  }
  const first = approach(gallery.signs[0].side);
  game.move({ x: first.x * .2, z: first.z * .2 }); tracker.observe(game);
  assert.equal(game.transitions, 1); assert.equal(gallery.outside, false); assert.equal(value('game_completed'), undefined);
  const last = gallery.signs.at(-1)!; gallery.cell = { x: last.x, z: last.z };
  const n = approach(last.side);
  game.move({ x: n.x * .05, z: n.z * .05 }); tracker.observe(game);
  assert.equal(gallery.outside, false); assert.equal(value('game_completed'), undefined);
  advance(1000); game.move({ x: n.x * .1, z: n.z * .1 }); tracker.observe(game);
  assert.equal(gallery.outside, true); assert.equal(value('game_completed'), 1);
  game.move({ x: -n.x * .1, z: -n.z * .1 }); tracker.observe(game);
  game.move({ x: n.x * .1, z: n.z * .1 }); tracker.observe(game);
  assert.equal(events.filter(([event]) => event === eventId('game_completed')).length, 1);
});

test('reload preserves time and reached milestones; menu resumes do not create extra resume events', () => {
  const { tracker, game, events, advance, value } = fixture();
  advance(5000); game.player.room = 'B'; tracker.observe(game); tracker.setPlaying(false);
  let now = 100_000;
  const resumed = new RunAnalytics(tracker.snapshot(), (event, value) => events.push([event, value]), true, () => now);
  resumed.play(game); resumed.setPlaying(true); now += 1000;
  game.player.room = 'D'; resumed.observe(game);
  resumed.setPlaying(false); now += 60_000; resumed.play(game); resumed.setPlaying(true);
  assert.equal(value('room_3_visited'), 6);
  assert.equal(events.filter(([event]) => event.endsWith(':run_resumed')).length, 1);
  assert.equal(events.filter(([event]) => event.endsWith(':room_5_visited')).length, 1);
  resumed.reset(); resumed.play(game);
  assert.equal(events.filter(([event]) => event.endsWith(':run_started')).length, 2);
  assert.equal(resumed.snapshot()!.activeMs, 0);
});

test('the timer calculates and saves whole milliseconds without losing time across frequent checkpoints', () => {
  let now = 0.2;
  const game = new Game(), tracker = new RunAnalytics(undefined, () => {}, true, () => now);
  tracker.reset(); tracker.play(game); tracker.setPlaying(true);
  for (let i = 1; i <= 100; i++) {
    now = 0.2 + i * 0.2;
    assert.equal(tracker.snapshot()!.activeMs, Math.floor(now) - Math.floor(0.2));
  }
  tracker.setPlaying(false); now = 1000.8; tracker.setPlaying(true);
  now = 1010.9; tracker.setPlaying(false);
  assert.equal(tracker.snapshot()!.activeMs, 30);
  const loaded = readRunAnalytics({ version: GAME_VERSION, activeMs: 30.7, reached: ['run_started'] })!;
  assert.equal(loaded.activeMs, 30);
  const resumed = new RunAnalytics(loaded, () => {}, true, () => now);
  resumed.play(game); resumed.setPlaying(true); now = 1012.3;
  assert.equal(resumed.snapshot()!.activeMs, 32);
});

test('missing timing metadata is not invented; dev runs and failed senders cannot affect play', () => {
  const game = new Game(), events: string[] = [];
  const legacy = new RunAnalytics(undefined, event => events.push(event));
  legacy.play(game); legacy.setPlaying(true); legacy.observe(game); assert.equal(legacy.snapshot(), undefined);
  assert.equal(events.length, 0);
  const dev = new RunAnalytics(undefined, event => events.push(event), false);
  dev.reset(); dev.play(game); dev.observe(game); assert.equal(dev.snapshot(), undefined); assert.equal(events.length, 0);
  legacy.reset(); legacy.send = () => { throw new Error('Offline'); };
  assert.doesNotThrow(() => legacy.play(game));
  assert.ok(legacy.snapshot()!.reached.includes('run_started'));
});

test('telemetry checkpoints validate their size, milestone names, uniqueness and clock', () => {
  for (const value of [null, {}, { version: GAME_VERSION - 1, activeMs: 1000, reached: ['run_started'] },
    { version: GAME_VERSION, activeMs: -1, reached: [] }, { version: GAME_VERSION, activeMs: Infinity, reached: [] },
    { version: GAME_VERSION, activeMs: 0, reached: ['unknown'] }, { version: GAME_VERSION, activeMs: 0, reached: ['room_5_visited'] },
    { version: GAME_VERSION, activeMs: 0, reached: ['run_started', ...Array.from({ length: 128 }, (_, i) => `unknown_${i}`)] },
    { version: GAME_VERSION, activeMs: 0, reached: Array(100).fill('run_started') }]) assert.equal(readRunAnalytics(value), undefined);
  const saved = { version: GAME_VERSION, activeMs: 1000, reached: [...MILESTONES] };
  assert.deepEqual(readRunAnalytics(saved), saved);
  assert.deepEqual(readRunAnalytics({ ...saved, reached: [...MILESTONES, 'unknown'] }), saved);
});

test('unknown milestone names do not discard valid timing, deduplication or later events', () => {
  const loaded = readRunAnalytics({ version: GAME_VERSION, activeMs: 42_000,
    reached: ['run_started', 'room_4_visited', 'symbol_connection_3_opened', 'symbol_room_3_visited'] })!;
  assert.deepEqual(loaded.reached, ['run_started', 'room_4_visited']);
  assert.equal(loaded.activeMs, 42_000);
  const game = new Game(), events: [string, number][] = [];
  let now = 100_000;
  const tracker = new RunAnalytics(loaded, (event, value) => events.push([event, value]), true, () => now);
  tracker.play(game); tracker.setPlaying(true); now += 2000;
  game.player.room = 'B'; tracker.observe(game);
  assert.deepEqual(events, [[eventId('run_resumed'), 42], [eventId('room_5_visited'), 44]]);
  assert.deepEqual(tracker.snapshot()!.reached, ['run_started', 'room_4_visited', 'room_5_visited']);
});

const config = { enabled: true, gameKey: 'a'.repeat(32), secretKey: 'b'.repeat(40) };
const tick = () => new Promise(resolve => setTimeout(resolve, 0));

test('SDK events wait for asynchronous session initialization, then drain in order', async () => {
  const calls: [string, unknown[]][] = [];
  let ready: (() => void) | undefined;
  const command: AnalyticsCommand = (name, ...args) => {
    calls.push([name, args]);
    if (name === 'addRemoteConfigsListener') ready = (args[0] as { onRemoteConfigsUpdated(): void }).onRemoteConfigsUpdated;
  };
  const send = createGameAnalyticsSink(config, async () => command);
  send('first', 0); send('second', 10); await tick();
  assert.ok(calls.some(([name]) => name === 'initialize'));
  assert.deepEqual(calls.filter(([name]) => name === 'configureBuild').map(([, args]) => args), [[String(GAME_VERSION)]]);
  assert.equal(calls.filter(([name]) => name === 'addDesignEvent').length, 0);
  ready!(); send('third', 15);
  assert.deepEqual(calls.filter(([name]) => name === 'addDesignEvent').map(([, args]) => args), [['first', 0], ['second', 10], ['third', 15]]);
});

test('disabled or missing SDK credentials do not load anything; failed imports are contained', async () => {
  let loads = 0;
  const load = async () => { loads++; throw new Error('Blocked'); };
  for (const settings of [{ ...config, enabled: false }, { ...config, gameKey: '' }, { ...config, secretKey: '' }]) {
    createGameAnalyticsSink(settings, load)('test', 1);
  }
  await tick(); assert.equal(loads, 0);
  const send = createGameAnalyticsSink(config, load);
  assert.doesNotThrow(() => send('test', 1)); await tick(); send('test', 2);
  assert.equal(loads, 1);
});
