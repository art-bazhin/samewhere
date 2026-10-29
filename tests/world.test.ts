import test from 'node:test';
import assert from 'node:assert/strict';
import { closestOnSegment, insideOutline } from '../src/geometry';
import { galleryRoute } from '../src/gallery';
import { ballAt, canStand, connections, destination, DOOR_WIDTH, FINAL_PASSAGE_GOALS, Game, inventoryCount, PASSAGE_GOALS, pedestalOutline, PEDESTAL_APOTHEM, PLAYER_RADIUS, portalAngle, portalDistance, portalPosition, ROOM_IDS, ROOMS, roomOutline, rotate, socketPosition, transformPoint, validateWorld, WALL_THICKNESS, wallNormal, type RoomId, type SocketRef } from '../src/world';

const close = (a: number, b: number, epsilon = 1e-7) => assert.ok(Math.abs(a - b) < epsilon, `${a} ≠ ${b}`);
function atWall(game: Game, room: RoomId, side: number, lateral = 0) {
  const n = wallNormal(room, side), p = portalPosition(room, side);
  Object.assign(game.player, { room, x: p.x - n.x * .45 - n.z * lateral, z: p.z - n.z * .45 + n.x * lateral, yaw: -Math.atan2(n.x, -n.z), pitch: -0.2 });
}
function walkOut(game: Game, side: number) {
  const n = wallNormal(game.player.room, side); game.move({ x: n.x * 0.6, z: n.z * 0.6 });
}
function loopGame() {
  const game = new Game(), sides = [0, 2, 1, 3];
  game.world.balls.forEach((ball, index) => { ball.socket = { room: 'A', side: sides[index] }; });
  return game;
}

test('seven-room layout starts in A with empty inventory, red balls on B and blue balls on C', () => {
  const { world, player } = new Game();
  assert.equal(player.room, 'A');
  assert.equal(inventoryCount(world, 'red'), 0); assert.equal(inventoryCount(world, 'blue'), 0);
  assert.equal(connections(world).length, 2);
  assert.deepEqual(destination(world, { room: 'B', side: 0 }), { room: 'B', side: 2 });
  assert.deepEqual(destination(world, { room: 'C', side: 0 }), { room: 'C', side: 3 });
  assert.deepEqual(ROOM_IDS, ['A', 'B', 'C', 'D', 'E', 'F', 'G']);
  assert.deepEqual(ROOM_IDS.map(id => ROOMS[id].sides), [4, 5, 6, 3, 3, 4, 4]);
  assert.deepEqual(ROOM_IDS.map(id => ROOMS[id].pedestals.map(p => p.controls)), [['A', 'B'], ['C'], ['D'], ['A', 'E'], ['B', 'F'], ['G'], ROOM_IDS]);
  assert.ok(world.balls.every(ball => ball.socket?.room === (ball.color === 'red' ? 'B' : 'C')));
  for (const room of ['A', 'D', 'E', 'F', 'G'] as const) for (let side = 0; side < ROOMS[room].sides; side++) assert.equal(destination(world, { room, side }), null);
});
test('taking R2 removes both red doors and preserves blue; placing it on A links A0–B0', () => {
  const game = new Game();
  assert.equal(game.interact({ room: 'B', side: 2 }), 'take');
  assert.equal(destination(game.world, { room: 'B', side: 0 }), null);
  assert.equal(destination(game.world, { room: 'B', side: 2 }), null);
  assert.deepEqual(destination(game.world, { room: 'C', side: 0 }), { room: 'C', side: 3 });
  assert.equal(inventoryCount(game.world, 'red'), 1);
  assert.equal(game.interact({ room: 'A', side: 0 }), 'place');
  assert.deepEqual(destination(game.world, { room: 'A', side: 0 }), { room: 'B', side: 0 });
  assert.deepEqual(destination(game.world, { room: 'B', side: 0 }), { room: 'A', side: 0 });
  // Access from another physical pedestal still addresses the same logical socket.
  assert.equal(ballAt(game.world, { room: 'B', side: 0 })?.id, 'R1');
  game.interact({ room: 'B', side: 0 });
  assert.equal(ballAt(game.world, { room: 'B', side: 0 }), undefined);
  assert.equal(inventoryCount(game.world, 'red'), 1);
});
test('occupied socket always picks up, selects its color and never silently swaps', () => {
  const game = new Game(); game.interact({ room: 'B', side: 0 });
  game.world.selected = 'red'; game.interact({ room: 'C', side: 0 });
  assert.equal(game.world.selected, 'blue'); assert.equal(ballAt(game.world, { room: 'C', side: 0 }), undefined);
  assert.equal(inventoryCount(game.world, 'red'), 1); assert.equal(inventoryCount(game.world, 'blue'), 1);
});
test('unrelated hub connections and self-loops do not advance the first goal', () => {
  const game = new Game();
  assert.equal(game.world.passageProgress, 0);
  game.interact({ room: 'B', side: 2 });
  assert.equal(game.world.passageProgress, 0);
  game.interact({ room: 'G', side: 0 });
  assert.equal(game.player.room, 'A'); assert.equal(game.world.passageProgress, 0);
  game.interact({ room: 'G', side: 0 });
  assert.equal(game.world.passageProgress, 0);
  game.undo(); assert.equal(game.world.passageProgress, 0);
  game.undo(); assert.equal(game.world.passageProgress, 0);
  game.reset(); assert.equal(game.world.passageProgress, 0);
  game.interact({ room: 'B', side: 0 }); game.interact({ room: 'B', side: 2 });
  game.interact({ room: 'G', side: 0 }); game.interact({ room: 'G', side: 1 });
  assert.equal(game.world.passageProgress, 0);
});
test('each passage goal accepts every destination entrance and either order of placement without traversal', () => {
  for (const [stage, goal] of PASSAGE_GOALS.entries()) for (let side = 0; side < ROOMS[goal.to].sides; side++) for (const reverse of [false, true]) {
    const game = new Game(); game.world.balls.forEach(ball => { ball.socket = null; });
    game.world.passageProgress = stage; game.world.selected = goal.color;
    const ends: SocketRef[] = [goal.from, { room: goal.to, side }];
    for (const end of reverse ? ends.reverse() : ends) game.interact(end);
    assert.equal(game.world.passageProgress, stage + 1); assert.equal(game.player.room, 'A');
    game.interact(goal.from);
    assert.equal(game.world.passageProgress, stage + 1);
    game.undo(); game.undo(); assert.equal(game.world.passageProgress, stage);
    game.reset(); assert.equal(game.world.passageProgress, 0);
  }
});
test('other hub exits, rooms and colors still open ordinary passages without completing the goal', () => {
  for (const [color, hubSide, room] of [['blue', 3, 'B'], ['red', 0, 'B'], ['red', 3, 'C']] as const) {
    const game = new Game(); game.world.balls.forEach(ball => { ball.socket = null; }); game.world.selected = color;
    game.interact({ room, side: 0 }); game.interact({ room: 'G', side: hubSide });
    assert.deepEqual(destination(game.world, { room: 'G', side: hubSide }), { room, side: 0 });
    assert.equal(game.world.passageProgress, 0);
  }
});
test('the pentagon goal waits for the hub goal and rejects other exits, rooms and colors', () => {
  const premature = new Game(); premature.world.balls.forEach(ball => { ball.socket = null; });
  premature.world.selected = 'blue';
  premature.interact({ room: 'B', side: 2 }); premature.interact({ room: 'D', side: 0 });
  assert.equal(premature.world.passageProgress, 0);
  for (const [color, side, room] of [['red', 2, 'D'], ['blue', 1, 'D'], ['blue', 2, 'F']] as const) {
    const game = new Game();
    game.interact({ room: 'B', side: 2 }); game.interact({ room: 'G', side: 3 });
    assert.equal(game.world.passageProgress, 1);
    game.interact({ room: 'G', side: 3 }); game.interact({ room: 'B', side: 0 });
    game.interact({ room: 'C', side: 0 }); game.interact({ room: 'C', side: 3 });
    game.world.selected = color;
    game.interact({ room: 'B', side }); game.interact({ room, side: 0 });
    assert.equal(game.world.passageProgress, 1);
  }
});
test('the full marked route and final square pattern are reachable using local controls and reversible travel', () => {
  const game = new Game();
  const sockets: SocketRef[] = [{ room: 'E', side: 0 }, { room: 'F', side: 0 }, { room: 'E', side: 1 }, { room: 'G', side: 0 }];
  game.world.balls.forEach((ball, i) => { ball.socket = sockets[i]; }); // State after the tested route into G.
  Object.assign(game.player, { room: 'G', x: 0, z: 1.1 });
  const interact = (room: RoomId, side: number) => {
    assert.ok(ROOMS[game.player.room].pedestals.some(p => p.controls === room), `${room} control missing in ${game.player.room}`);
    assert.ok(game.interact({ room, side })); validateWorld(game.world);
  };
  const clear = () => { for (const ball of game.world.balls) if (ball.socket) interact(ball.socket.room, ball.socket.side); };
  const place = (color: 'red' | 'blue', room: RoomId, side: number) => { game.world.selected = color; assert.equal(ballAt(game.world, { room, side }), undefined); interact(room, side); };
  const cross = (room: RoomId, color: 'red' | 'blue') => {
    const link = connections(game.world).find(link => link.color === color && link.ends.some(end => end.room === game.player.room) && link.ends.some(end => end.room === room));
    assert.ok(link); const from = link.ends.find(end => end.room === game.player.room)!;
    atWall(game, from.room, from.side); walkOut(game, from.side); assert.equal(game.player.room, room);
  };
  for (const [stage, goal] of PASSAGE_GOALS.entries()) {
    clear(); place(goal.color, goal.from.room, goal.from.side); place(goal.color, goal.to, 0);
    assert.equal(game.world.passageProgress, stage + 1); assert.equal(game.player.room, 'G');
    const ferry = goal.color === 'red' ? 'blue' : 'red';
    place(ferry, 'G', 0); place(ferry, goal.to, 1);
    cross(goal.to, ferry); cross('G', ferry);
  }
  clear();
  for (const goal of FINAL_PASSAGE_GOALS) place(goal.color, goal.from.room, goal.from.side);
  assert.equal(game.world.passageProgress, PASSAGE_GOALS.length, 'A pattern assembled remotely does not finish the game');
  clear(); place('red', 'B', 2); place('red', 'F', 0); place('blue', 'B', 0); place('blue', 'G', 1);
  // Recover the last hub endpoint from F, then carry all balls back through the existing control chain.
  const recovery = [
    ['take', 'red', 'B'], ['place', 'red', 'E'], ['take', 'blue', 'B'], ['place', 'blue', 'E'],
    ['move', 'blue', 'E'], ['move', 'red', 'F'], ['take', 'blue', 'G'], ['move', 'red', 'E'],
    ['take', 'red', 'F'], ['place', 'red', 'B'], ['move', 'red', 'B'], ['place', 'blue', 'C'],
    ['move', 'red', 'E'], ['take', 'red', 'B'], ['move', 'blue', 'C'], ['place', 'red', 'D'],
    ['move', 'blue', 'E'], ['move', 'red', 'D'], ['take', 'red', 'E'], ['place', 'red', 'A'],
    ['take', 'blue', 'E'], ['place', 'blue', 'A'], ['move', 'red', 'A'], ['move', 'blue', 'C'],
    ['take', 'red', 'D'], ['move', 'blue', 'A'], ['place', 'red', 'B'], ['take', 'blue', 'A'],
    ['move', 'red', 'B'], ['take', 'blue', 'C'], ['move', 'red', 'A'], ['take', 'red', 'A'], ['take', 'red', 'B'],
  ] as const;
  for (const [action, color, room] of recovery) {
    if (action === 'move') cross(room, color);
    else if (action === 'take') { const socket = game.world.balls.find(ball => ball.color === color && ball.socket?.room === room)?.socket; assert.ok(socket); interact(socket.room, socket.side); }
    else place(color, room, Array.from({ length: ROOMS[room].sides }, (_, side) => side).find(side => !ballAt(game.world, { room, side }))!);
  }
  assert.equal(game.player.room, 'A'); assert.ok(game.world.balls.every(ball => !ball.socket));
  place('red', 'A', 0); place('red', 'A', 1); place('blue', 'A', 2); place('blue', 'A', 3);
  assert.equal(game.world.passageProgress, PASSAGE_GOALS.length, 'The wrong color arrangement is not the final pattern');
  interact('A', 1); interact('A', 2); place('red', 'A', 2); interact('A', 0); place('blue', 'A', 1);
  assert.equal(game.world.passageProgress, PASSAGE_GOALS.length, 'Both colored pairs must coexist');
  place('red', 'A', 0); assert.equal(game.world.passageProgress, PASSAGE_GOALS.length + 1);
  assert.ok(connections(game.world).every(link => link.ends.every(end => end.room === 'A')));
  interact('A', 0); assert.equal(game.world.passageProgress, PASSAGE_GOALS.length + 1);
  game.undo(); game.undo(); assert.equal(game.world.passageProgress, PASSAGE_GOALS.length);
  game.reset(); assert.equal(game.world.passageProgress, 0);
});
test('the square gallery starts with the complete pattern and preserves its rooms and signs through undo', () => {
  const game = new Game(); game.world.passageProgress = PASSAGE_GOALS.length;
  game.world.balls.forEach((ball, index) => { ball.socket = index === 3 ? null : { room: 'A', side: [0, 2, 1][index] }; });
  assert.equal(game.snapshot().world.gallery, null);
  game.world.selected = 'blue'; game.interact({ room: 'A', side: 3 });
  const route = galleryRoute();
  assert.deepEqual(game.snapshot().world.gallery, { cell: { x: 0, z: 0 }, signs: route, outside: false });
  for (const side of [0, 1, 2, 3]) {
    atWall(game, 'A', side); walkOut(game, side);
    assert.equal(game.player.room, 'A');
  }
  assert.deepEqual(game.world.gallery, { cell: { x: 0, z: 0 }, signs: route, outside: false });
  game.undo(); assert.deepEqual(game.world.gallery!.cell, { x: 1, z: 0 });
  game.interact({ room: 'A', side: 0 }); assert.equal(game.snapshot().world.gallery, null);
  game.undo(); assert.deepEqual(game.world.gallery, { cell: { x: 1, z: 0 }, signs: route, outside: false });
  game.reset(); assert.equal(game.world.gallery, null);
});
test('the long diagonal EXIT section crosses eight red-left/blue-right doors without changing direction', () => {
  const route = galleryRoute();
  const start = route.findIndex((sign, index) => index > 0 && route[index - 1].side === 1 &&
    Array.from({ length: 8 }, (_, step) => route[index + step]?.side === step % 2).every(Boolean));
  assert.ok(start >= 0, 'Missing diagonal section entered from the west');
  const game = loopGame(); game.world.passageProgress = PASSAGE_GOALS.length;
  game.interact({ room: 'A', side: 3 }); game.interact({ room: 'A', side: 3 });
  const gallery = game.world.gallery!;
  gallery.cell = { x: route[start].x, z: route[start].z };
  Object.assign(game.player, { x: -portalDistance('A') + .4, z: -.4, yaw: -Math.PI / 4, pitch: 0 });
  let crossed = 0;
  for (let step = 0; step < 2000 && crossed < 8; step++) {
    const before = game.transitions;
    game.move({ x: .04, z: -.04 });
    if (game.transitions === before) continue;
    assert.equal(game.transitions, before + 1);
    const sign = route[start + crossed];
    assert.equal(game.world.balls.find(ball => ball.socket?.room === 'A' && ball.socket.side === sign.side)?.color,
      crossed % 2 ? 'blue' : 'red');
    assert.deepEqual(gallery.cell, { x: route[start + crossed + 1].x, z: route[start + crossed + 1].z });
    crossed++;
  }
  assert.equal(crossed, 8, 'A wall or pedestal blocked the continuous diagonal walk');
  close(Math.sin(game.player.yaw), Math.sin(-Math.PI / 4));
  close(Math.cos(game.player.yaw), Math.cos(-Math.PI / 4));
});
test('the last EXIT opens directly into free white space and allows returning and undo', () => {
  const game = loopGame(); game.world.passageProgress = PASSAGE_GOALS.length;
  game.interact({ room: 'A', side: 3 }); game.interact({ room: 'A', side: 3 });
  const gallery = game.world.gallery!, last = gallery.signs.at(-1)!;
  gallery.cell = { x: last.x, z: last.z };
  const p = portalPosition('A', last.side), n = wallNormal('A', last.side);
  atWall(game, 'A', last.side); const yaw = game.player.yaw; walkOut(game, last.side);
  assert.equal(gallery.outside, true); close(game.player.yaw, yaw);
  close((game.player.x - p.x) * n.x + (game.player.z - p.z) * n.z, .15);
  assert.equal(game.interact({ room: 'A', side: 0 }), null);
  game.undo(); assert.equal(game.world.gallery!.outside, false);
  atWall(game, 'A', last.side); walkOut(game, last.side);
  const start = { x: game.player.x, z: game.player.z };
  game.move({ x: n.x * 20 - n.z * 10, z: n.z * 20 + n.x * 10 });
  close(game.player.x, start.x + n.x * 20 - n.z * 10);
  close(game.player.z, start.z + n.z * 20 + n.x * 10);
  // Crossing the surrounding white wall must not leak into another gallery cell.
  game.move({ x: -n.x * 30, z: -n.z * 30 });
  assert.equal(game.world.gallery!.outside, true);
  close((game.player.x - p.x) * n.x + (game.player.z - p.z) * n.z, PLAYER_RADIUS);
  game.move({ x: -n.z * -10, z: n.x * -10 });
  game.move({ x: -n.x * .5, z: -n.z * .5 });
  assert.equal(game.world.gallery!.outside, false);
  assert.deepEqual(game.world.gallery!.cell, { x: last.x, z: last.z });
  game.undo(); assert.equal(game.world.gallery!.outside, true);
  game.reset(); assert.equal(game.world.gallery, null);
});
test('an unavailable color and invalid socket do not create actions or overwrite history', () => {
  const game = new Game();
  assert.equal(game.interact({ room: 'B', side: 1 }), null); assert.equal(game.history.length, 0);
  assert.equal(game.interact({ room: 'B', side: 5 }), null); assert.equal(game.history.length, 0);
});
test('four-ball conservation survives 2,000 arbitrary take/place/undo operations', () => {
  const game = new Game(); let seed = 71021;
  const random = () => { seed = (1664525 * seed + 1013904223) >>> 0; return seed / 2 ** 32; };
  for (let i = 0; i < 2000; i++) {
    const room = ROOM_IDS[Math.floor(random() * ROOM_IDS.length)]; game.world.selected = random() > 0.5 ? 'red' : 'blue';
    game.interact({ room, side: Math.floor(random() * ROOMS[room].sides) });
    if (random() < 0.15) game.undo();
    validateWorld(game.world); assert.equal(game.world.balls.length, 4);
    assert.equal(game.world.balls.filter(b => b.socket).length + inventoryCount(game.world, 'red') + inventoryCount(game.world, 'blue'), 4);
  }
});
test('all source/target combinations preserve lateral position, direction, and inverse mapping', () => {
  const endpoints: SocketRef[] = ROOM_IDS.flatMap(room => Array.from({ length: ROOMS[room].sides }, (_, side) => ({ room, side })));
  for (const from of endpoints) for (const to of endpoints) {
    const a = wallNormal(from.room, from.side), b = wallNormal(to.room, to.side), start = portalPosition(from.room, from.side), end = portalPosition(to.room, to.side);
    const p = { x: start.x + a.x * .3 - a.z * .4, z: start.z + a.z * .3 + a.x * .4 };
    const mapped = transformPoint(p, from, to), back = transformPoint(mapped, to, from);
    close(back.x, p.x); close(back.z, p.z);
    close((mapped.x - end.x) * b.x + (mapped.z - end.z) * b.z, -0.3);
    close((mapped.x - end.x) * -b.z + (mapped.z - end.z) * b.x, -0.4);
    const direction = rotate(a, portalAngle(from, to)); close(direction.x, -b.x); close(direction.z, -b.z);
  }
});

test('Y arms have equal length, + has four ends, and H has two separated parallel corridors', () => {
  for (let side = 0; side < 3; side++) close(Math.hypot(...Object.values(portalPosition('E', side))), 7 + WALL_THICKNESS / 2);
  assert.equal(ROOMS.E.sides, 3); assert.equal(ROOMS.F.sides, 4); assert.equal(ROOMS.G.sides, 4);
  assert.ok(canStand('E', { x: 0, z: -5 }));
  assert.ok(canStand('E', { x: -4.3, z: 2.5 })); assert.ok(canStand('E', { x: 4.3, z: 2.5 }));
  assert.equal(canStand('E', { x: 0, z: 4 }), false);
  for (const p of [{ x: 0, z: -5 }, { x: 5, z: 0 }, { x: 0, z: 5 }, { x: -5, z: 0 }]) assert.ok(canStand('F', p));
  assert.equal(canStand('F', { x: 4, z: 4 }), false);
  for (const x of [-3.5, 3.5]) for (const z of [-5.5, 5.5]) assert.ok(canStand('G', { x, z }));
  assert.ok(canStand('G', { x: 0, z: 1.1 })); assert.equal(canStand('G', { x: 0, z: 0 }), false);
  assert.equal(canStand('G', { x: 0, z: -5 }), false);
});

test('concave walls stop shortcuts across H notches while its center connects both legs', () => {
  const game = new Game(); Object.assign(game.player, { room: 'G', x: -3.5, z: -5.5 });
  game.move({ x: 7, z: 0 }); assert.ok(game.player.x <= -1.8 - PLAYER_RADIUS + 1e-7);
  game.move({ x: 0, z: 6.6 }); close(game.player.z, 1.1);
  game.move({ x: 4.3, z: 0 }); assert.ok(game.player.x > 2);
  game.move({ x: 0, z: -6.6 }); close(game.player.z, -5.5); assert.ok(game.player.x > 2);
  assert.ok(insideOutline(game.player, roomOutline('G')));
});

test('every corridor terminal crosses and returns, including the offset H portals', () => {
  for (const room of ['E', 'F', 'G'] as const) for (let side = 0; side < ROOMS[room].sides; side++) {
    const game = new Game(); game.world.balls[0].socket = { room, side }; game.world.balls[1].socket = { room: 'A', side: 0 };
    game.world.balls[2].socket = game.world.balls[3].socket = null;
    atWall(game, room, side, .1); walkOut(game, side); assert.equal(game.player.room, 'A', `${room}${side} entry`);
    game.move({ x: 0, z: -.6 }); assert.equal(game.player.room, room, `${room}${side} return`);
    assert.equal(game.transitions, 2);
  }
});

test('miniature sockets follow corridor ends and retain 9 cm of clearance from the nearest edge', () => {
  for (const room of ROOM_IDS) {
    const outline = pedestalOutline(room);
    for (let side = 0; side < ROOMS[room].sides; side++) {
      const p = socketPosition(room, side); assert.ok(insideOutline(p, outline));
      const clearance = Math.min(...outline.map((a, i) => { const q = closestOnSegment(p, a, outline[(i + 1) % outline.length]); return Math.hypot(p.x - q.x, p.z - q.z); }));
      close(clearance, .09);
    }
  }
});
test('opposite portals preserve the camera and permit an immediate backward return', () => {
  const game = loopGame(); atWall(game, 'A', 0, 0.4); const yaw = game.player.yaw;
  walkOut(game, 0);
  assert.equal(game.transitions, 1); close(game.player.x, 0.4); close(game.player.z, 4.7 + WALL_THICKNESS); close(Math.sin(game.player.yaw), Math.sin(yaw)); close(game.player.pitch, -0.2);
  game.move({ x: 0, z: 0.6 });
  assert.equal(game.transitions, 2); close(game.player.x, 0.4); close(game.player.z, -4.7);
});
test('adjacent portals transform residual movement and undo restores a safe source pose', () => {
  const game = loopGame(); game.world.balls[1].socket = { room: 'A', side: 1 }; game.world.balls[2].socket = null; game.world.balls[3].socket = null;
  atWall(game, 'A', 0, 0.4); walkOut(game, 0);
  assert.equal(game.transitions, 1); close(game.player.x, 4.7 + WALL_THICKNESS); close(game.player.z, -0.4);
  const forward = { x: -Math.sin(game.player.yaw), z: -Math.cos(game.player.yaw) }; close(forward.x, -1); close(forward.z, 0);
  assert.ok(game.undo()); assert.equal(game.player.room, 'A'); assert.ok(game.player.z >= -5 + PLAYER_RADIUS); close(game.player.x, 0.4);
});
test('closed walls, door jambs and pedestals resist a large movement step', () => {
  const game = loopGame(); game.interact({ room: 'A', side: 0 });
  atWall(game, 'A', 0); game.move({ x: 0, z: -10 }); assert.ok(game.player.z >= -5 + PLAYER_RADIUS - 1e-8);
  atWall(game, 'A', 3, 0.82); game.move({ x: -1, z: 0 }); assert.equal(game.transitions, 0); assert.ok(game.player.x >= -5 + PLAYER_RADIUS - 1e-8);
  const free = new Game(), pedestal = ROOMS.A.pedestals[0];
  Object.assign(free.player, { x: pedestal.x, z: pedestal.z + 1.5 }); free.move({ x: 0, z: -1.2 });
  assert.ok(Math.hypot(free.player.x - pedestal.x, free.player.z - pedestal.z) >= PEDESTAL_APOTHEM / Math.cos(Math.PI / 4) + PLAYER_RADIUS - 1e-8);
});
test('the room diagonal can be crossed freely in both directions', () => {
  const game = new Game(); Object.assign(game.player, { x: -1, z: 1 });
  game.move({ x: 1.5, z: -1.5 }); close(game.player.x, .5); close(game.player.z, -.5);
  game.move({ x: -1.5, z: 1.5 }); close(game.player.x, -1); close(game.player.z, 1);
});
test('a link reaches B, returns and can undo both legs', () => {
  const game = new Game();
  game.interact({ room: 'B', side: 2 });
  game.interact({ room: 'A', side: 2 });
  atWall(game, 'A', 2); walkOut(game, 2); assert.equal(game.player.room, 'B');
  game.move({ x: 0, z: -0.6 }); assert.equal(game.player.room, 'A');
  game.undo(); assert.equal(game.player.room, 'B');
  game.undo(); assert.equal(game.player.room, 'A');
});
test('the complete A–D–G route uses only available pedestals and preserves all four balls', () => {
  const game = new Game(), route: RoomId[] = ['A'];
  const interact = (room: RoomId, side: number) => {
    assert.ok(ROOMS[game.player.room].pedestals.some(p => p.controls === room), `${room} pedestal unavailable in ${game.player.room}`);
    assert.ok(game.interact({ room, side })); validateWorld(game.world);
  };
  const cross = (side: number, room: RoomId) => {
    atWall(game, game.player.room, side); walkOut(game, side);
    assert.equal(game.player.room, room); route.push(room);
  };
  interact('B', 2); interact('A', 0);
  cross(0, 'B');
  interact('C', 3); cross(0, 'A');
  interact('A', 1); interact('B', 0); cross(1, 'C');
  interact('D', 0); cross(0, 'A'); cross(0, 'D');
  assert.deepEqual(route, ['A', 'B', 'A', 'C', 'A', 'D']);
  assert.deepEqual(destination(game.world, { room: 'A', side: 0 }), { room: 'D', side: 0 });
  assert.deepEqual(destination(game.world, { room: 'A', side: 1 }), { room: 'C', side: 0 });
  assert.equal(inventoryCount(game.world, 'red') + inventoryCount(game.world, 'blue'), 0);

  interact('A', 0); interact('E', 0); // Move the red anchor from A to E.
  interact('A', 1); interact('E', 1);
  cross(0, 'E'); cross(1, 'C');
  interact('D', 0); cross(0, 'E');
  interact('B', 0); cross(0, 'B');
  interact('C', 0); cross(0, 'E');
  interact('B', 0); interact('F', 0); cross(0, 'F');
  game.world.selected = 'blue'; interact('G', 0);
  cross(0, 'E'); cross(1, 'G');
  assert.deepEqual(route, ['A', 'B', 'A', 'C', 'A', 'D', 'E', 'C', 'E', 'B', 'E', 'F', 'E', 'G']);
  assert.deepEqual(destination(game.world, { room: 'E', side: 0 }), { room: 'F', side: 0 });
  assert.deepEqual(destination(game.world, { room: 'E', side: 1 }), { room: 'G', side: 0 });
  assert.equal(game.transitions, 13); assert.equal(game.world.balls.length, 4);
  assert.ok(game.world.balls.every(ball => ball.socket));
  assert.ok(game.undo()); assert.equal(game.player.room, 'E');
  assert.ok(game.undo()); assert.equal(game.player.room, 'F');
});
test('100 continuous loops have bounded state/history and no position drift', () => {
  const game = loopGame(); Object.assign(game.player, { x: 0.4, z: 0 });
  game.move({ x: 0, z: -100 * 2 * portalDistance('A') });
  assert.equal(game.transitions, 100); close(game.player.z, 0, 1e-6); close(game.player.x, 0.4, 1e-6);
  assert.equal(game.history.length, 100); validateWorld(game.world);
});
test('reset restores inventory, pose and initial links and clears history', () => {
  const game = new Game(), initial = game.snapshot();
  game.interact({ room: 'B', side: 0 }); game.interact({ room: 'A', side: 0 });
  game.interact({ room: 'C', side: 0 }); game.player.room = 'C'; game.world.selected = 'blue'; game.reset();
  assert.deepEqual(game.snapshot(), initial);
  assert.equal(game.world.selected, 'red'); assert.equal(game.history.length, 0); assert.equal(connections(game.world).length, 2); close(game.player.x, -3); close(game.player.z, 3);
});

test('a doorway takes 30 cm to cross between inner wall faces and reverses continuously', () => {
  const game = loopGame(); Object.assign(game.player, { x: 0, z: -4.99 });
  game.move({ x: 0, z: -0.1 }); assert.equal(game.transitions, 0); close(game.player.z, -5.09);
  game.move({ x: 0, z: -0.1 }); assert.equal(game.transitions, 1); close(game.player.z, 5.11);
  game.move({ x: 0, z: -0.11 }); close(game.player.z, 5);
  close(2 * (portalDistance('A') - ROOMS.A.apothem), WALL_THICKNESS);
  game.move({ x: 0, z: 0.31 }); assert.equal(game.transitions, 2); close(game.player.z, -4.99);
});

test('inside a thick doorway the jamb stops sideways motion without snapping the player out of the wall', () => {
  const game = loopGame(); Object.assign(game.player, { x: 0, z: -5.08 });
  game.move({ x: 0.9, z: 0 });
  close(game.player.x, DOOR_WIDTH / 2 - PLAYER_RADIUS); close(game.player.z, -5.08);
  assert.equal(game.transitions, 0);
  game.move({ x: 0, z: -0.1 });
  assert.equal(game.transitions, 1); close(game.player.z, 5.12);
  game.move({ x: 0.2, z: 0 });
  close(game.player.x, DOOR_WIDTH / 2 - PLAYER_RADIUS); close(game.player.z, 5.12);
});
