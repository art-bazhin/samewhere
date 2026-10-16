import test from 'node:test';
import assert from 'node:assert/strict';
import { ballAt, connections, destination, DOOR_WIDTH, Game, inventoryCount, PEDESTAL_APOTHEM, PLAYER_RADIUS, portalAngle, portalDistance, ROOM_IDS, ROOMS, rotate, transformPoint, validateWorld, WALL_THICKNESS, wallNormal, type RoomId, type SocketRef } from '../src/world';

const close = (a: number, b: number, epsilon = 1e-7) => assert.ok(Math.abs(a - b) < epsilon, `${a} ≠ ${b}`);
function atWall(game: Game, room: RoomId, side: number, lateral = 0) {
  const n = wallNormal(room, side);
  Object.assign(game.player, { room, x: n.x * 4.7 - n.z * lateral, z: n.z * 4.7 + n.x * lateral, yaw: -Math.atan2(n.x, -n.z), pitch: -0.2 });
}
function walkOut(game: Game, side: number) {
  const n = wallNormal(game.player.room, side); game.move({ x: n.x * 0.6, z: n.z * 0.6 });
}
function loopGame() {
  const game = new Game(), sides = [0, 2, 1, 3];
  game.world.balls.forEach((ball, index) => { ball.socket = { room: 'A', side: sides[index] }; });
  return game;
}

test('four-room pedestal chain starts in A with empty inventory, red balls on B and blue balls on C', () => {
  const { world, player } = new Game();
  assert.equal(player.room, 'A');
  assert.equal(inventoryCount(world, 'red'), 0); assert.equal(inventoryCount(world, 'blue'), 0);
  assert.equal(connections(world).length, 2);
  assert.deepEqual(destination(world, { room: 'B', side: 0 }), { room: 'B', side: 2 });
  assert.deepEqual(destination(world, { room: 'C', side: 0 }), { room: 'C', side: 3 });
  assert.deepEqual(ROOM_IDS, ['A', 'B', 'C', 'D']);
  assert.deepEqual(ROOM_IDS.map(id => ROOMS[id].sides), [4, 5, 6, 3]);
  assert.deepEqual(ROOM_IDS.map(id => ROOMS[id].pedestals.map(p => p.controls)), [['A', 'B'], ['B', 'C'], ['C', 'D'], ['D', 'A']]);
  assert.ok(world.balls.every(ball => ball.socket?.room === (ball.color === 'red' ? 'B' : 'C')));
  for (const room of ['A', 'D'] as const) for (let side = 0; side < ROOMS[room].sides; side++) assert.equal(destination(world, { room, side }), null);
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
test('all 324 source/target combinations preserve lateral position, direction, and inverse mapping', () => {
  const endpoints: SocketRef[] = ROOM_IDS.flatMap(room => Array.from({ length: ROOMS[room].sides }, (_, side) => ({ room, side })));
  for (const from of endpoints) for (const to of endpoints) {
    const a = wallNormal(from.room, from.side), b = wallNormal(to.room, to.side);
    const p = { x: a.x * (portalDistance(from.room) + 0.3) - a.z * 0.4, z: a.z * (portalDistance(from.room) + 0.3) + a.x * 0.4 };
    const mapped = transformPoint(p, from, to), back = transformPoint(mapped, to, from);
    close(back.x, p.x); close(back.z, p.z);
    close(mapped.x * b.x + mapped.z * b.z, portalDistance(to.room) - 0.3);
    close(mapped.x * -b.z + mapped.z * b.x, -0.4);
    const direction = rotate(a, portalAngle(from, to)); close(direction.x, -b.x); close(direction.z, -b.z);
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
  const free = new Game(); Object.assign(free.player, { x: -1.5, z: 3 }); free.move({ x: 0, z: -1.2 }); assert.ok(Math.hypot(free.player.x + 1.5, free.player.z - 1.5) >= PEDESTAL_APOTHEM / Math.cos(Math.PI / 4) + PLAYER_RADIUS - 1e-8);
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
test('the A–B–A–C–A–D route uses only pedestals available in the current room', () => {
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
