import test from 'node:test';
import assert from 'node:assert/strict';
import { ballAt, connections, destination, DOOR_WIDTH, Game, inventoryCount, PLAYER_RADIUS, portalAngle, portalDistance, ROOMS, rotate, transformPoint, validateWorld, WALL_THICKNESS, wallNormal, type RoomId, type SocketRef } from '../src/world';

const close = (a: number, b: number, epsilon = 1e-7) => assert.ok(Math.abs(a - b) < epsilon, `${a} ≠ ${b}`);
function atWall(game: Game, room: RoomId, side: number, lateral = 0) {
  const n = wallNormal(room, side);
  Object.assign(game.player, { room, x: n.x * 4.7 - n.z * lateral, z: n.z * 4.7 + n.x * lateral, yaw: -Math.atan2(n.x, -n.z), pitch: -0.2 });
}
function walkOut(game: Game, side: number) {
  const n = wallNormal(game.player.room, side); game.move({ x: n.x * 0.6, z: n.z * 0.6 });
}

test('initial endpoints and inactive pentagon', () => {
  const { world } = new Game();
  assert.equal(connections(world).length, 2);
  assert.deepEqual(destination(world, { room: 'A', side: 0 }), { room: 'A', side: 2 });
  assert.deepEqual(destination(world, { room: 'A', side: 1 }), { room: 'A', side: 3 });
  for (let side = 0; side < 5; side++) assert.equal(destination(world, { room: 'B', side }), null);
});
test('taking R1 removes both red doors and preserves blue; placing it on B links A2–B0', () => {
  const game = new Game();
  assert.equal(game.interact({ room: 'A', side: 0 }), 'take');
  assert.equal(destination(game.world, { room: 'A', side: 0 }), null);
  assert.equal(destination(game.world, { room: 'A', side: 2 }), null);
  assert.deepEqual(destination(game.world, { room: 'A', side: 3 }), { room: 'A', side: 1 });
  assert.equal(inventoryCount(game.world, 'red'), 1);
  assert.equal(game.interact({ room: 'B', side: 0 }), 'place');
  assert.deepEqual(destination(game.world, { room: 'A', side: 2 }), { room: 'B', side: 0 });
  assert.deepEqual(destination(game.world, { room: 'B', side: 0 }), { room: 'A', side: 2 });
  // Access from another physical pedestal still addresses the same logical socket.
  assert.equal(ballAt(game.world, { room: 'B', side: 0 })?.id, 'R1');
  game.interact({ room: 'B', side: 0 });
  assert.equal(ballAt(game.world, { room: 'B', side: 0 }), undefined);
  assert.equal(inventoryCount(game.world, 'red'), 1);
});
test('occupied socket always picks up, selects its color and never silently swaps', () => {
  const game = new Game(); game.interact({ room: 'A', side: 0 });
  game.world.selected = 'red'; game.interact({ room: 'A', side: 1 });
  assert.equal(game.world.selected, 'blue'); assert.equal(ballAt(game.world, { room: 'A', side: 1 }), undefined);
  assert.equal(inventoryCount(game.world, 'red'), 1); assert.equal(inventoryCount(game.world, 'blue'), 1);
});
test('an unavailable color and invalid socket do not create actions or overwrite history', () => {
  const game = new Game();
  assert.equal(game.interact({ room: 'B', side: 2 }), null); assert.equal(game.history.length, 0);
  assert.equal(game.interact({ room: 'B', side: 5 }), null); assert.equal(game.history.length, 0);
});
test('four-ball conservation survives 2,000 arbitrary take/place/undo operations', () => {
  const game = new Game(); let seed = 71021;
  const random = () => { seed = (1664525 * seed + 1013904223) >>> 0; return seed / 2 ** 32; };
  for (let i = 0; i < 2000; i++) {
    const room = random() > 0.5 ? 'A' : 'B'; game.world.selected = random() > 0.5 ? 'red' : 'blue';
    game.interact({ room, side: Math.floor(random() * ROOMS[room].sides) });
    if (random() < 0.15) game.undo();
    validateWorld(game.world); assert.equal(game.world.balls.length, 4);
    assert.equal(game.world.balls.filter(b => b.socket).length + inventoryCount(game.world, 'red') + inventoryCount(game.world, 'blue'), 4);
  }
});
test('all 81 source/target combinations preserve lateral position, direction, and inverse mapping', () => {
  const endpoints: SocketRef[] = (['A', 'B'] as const).flatMap(room => Array.from({ length: ROOMS[room].sides }, (_, side) => ({ room, side })));
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
  const game = new Game(); atWall(game, 'A', 0, 0.4); const yaw = game.player.yaw;
  walkOut(game, 0);
  assert.equal(game.transitions, 1); close(game.player.x, 0.4); close(game.player.z, 4.7 + WALL_THICKNESS); close(Math.sin(game.player.yaw), Math.sin(yaw)); close(game.player.pitch, -0.2);
  game.move({ x: 0, z: 0.6 });
  assert.equal(game.transitions, 2); close(game.player.x, 0.4); close(game.player.z, -4.7);
});
test('adjacent portals transform residual movement and undo restores a safe source pose', () => {
  const game = new Game(); game.world.balls[1].socket = { room: 'A', side: 1 }; game.world.balls[2].socket = null; game.world.balls[3].socket = null;
  atWall(game, 'A', 0, 0.4); walkOut(game, 0);
  assert.equal(game.transitions, 1); close(game.player.x, 4.7 + WALL_THICKNESS); close(game.player.z, -0.4);
  const forward = { x: -Math.sin(game.player.yaw), z: -Math.cos(game.player.yaw) }; close(forward.x, -1); close(forward.z, 0);
  assert.ok(game.undo()); assert.equal(game.player.room, 'A'); assert.ok(game.player.z >= -5 + PLAYER_RADIUS); close(game.player.x, 0.4);
});
test('closed walls, door jambs, pedestals and the partition resist a large movement step', () => {
  const game = new Game('puzzle'); game.interact({ room: 'A', side: 0 });
  atWall(game, 'A', 0); game.move({ x: 0, z: -10 }); assert.ok(game.player.z >= -5 + PLAYER_RADIUS - 1e-8);
  atWall(game, 'A', 3, 0.82); game.move({ x: -1, z: 0 }); assert.equal(game.transitions, 0); assert.ok(game.player.x >= -5 + PLAYER_RADIUS - 1e-8);
  Object.assign(game.player, { x: -1, z: 1 }); game.move({ x: 3, z: -3 }); assert.ok((game.player.z - game.player.x) / Math.SQRT2 >= PLAYER_RADIUS + WALL_THICKNESS / 2 - 1e-8);
  const free = new Game(); Object.assign(free.player, { x: -1.5, z: 3 }); free.move({ x: 0, z: -1.2 }); assert.ok(Math.hypot(free.player.x + 1.5, free.player.z - 1.5) >= 1.099);
});
test('the partition reference solution reaches B, returns and can undo both legs', () => {
  const game = new Game('puzzle');
  game.interact({ room: 'A', side: 0 });
  atWall(game, 'A', 3); walkOut(game, 3); assert.ok(game.player.z < game.player.x);
  game.interact({ room: 'B', side: 0 });
  atWall(game, 'A', 1); walkOut(game, 1); assert.ok(game.player.z > game.player.x);
  atWall(game, 'A', 2); walkOut(game, 2); assert.equal(game.player.room, 'B'); assert.ok(game.world.visitedB); assert.ok(!game.world.solved);
  game.move({ x: 0, z: -0.6 }); assert.equal(game.player.room, 'A'); assert.ok(game.world.solved);
  game.undo(); assert.equal(game.player.room, 'B'); assert.ok(!game.world.solved);
  game.undo(); assert.equal(game.player.room, 'A'); assert.ok(!game.world.visitedB);
});
test('100 continuous loops have bounded state/history and no position drift', () => {
  const game = new Game(); Object.assign(game.player, { x: 0.4, z: 0 });
  game.move({ x: 0, z: -100 * 2 * portalDistance('A') });
  assert.equal(game.transitions, 100); close(game.player.z, 0, 1e-6); close(game.player.x, 0.4, 1e-6);
  assert.equal(game.history.length, 100); validateWorld(game.world);
});
test('reset preserves the mode, restores inventory/pose and clears history', () => {
  const game = new Game('puzzle'); game.interact({ room: 'A', side: 0 }); game.reset();
  assert.equal(game.world.mode, 'puzzle'); assert.equal(game.history.length, 0); assert.equal(connections(game.world).length, 2); close(game.player.x, -3); close(game.player.z, 3);
});

test('a doorway takes 30 cm to cross between inner wall faces and reverses continuously', () => {
  const game = new Game(); Object.assign(game.player, { x: 0, z: -4.99 });
  game.move({ x: 0, z: -0.1 }); assert.equal(game.transitions, 0); close(game.player.z, -5.09);
  game.move({ x: 0, z: -0.1 }); assert.equal(game.transitions, 1); close(game.player.z, 5.11);
  game.move({ x: 0, z: -0.11 }); close(game.player.z, 5);
  close(2 * (portalDistance('A') - ROOMS.A.apothem), WALL_THICKNESS);
  game.move({ x: 0, z: 0.31 }); assert.equal(game.transitions, 2); close(game.player.z, -4.99);
});

test('inside a thick doorway the jamb stops sideways motion without snapping the player out of the wall', () => {
  const game = new Game(); Object.assign(game.player, { x: 0, z: -5.08 });
  game.move({ x: 0.9, z: 0 });
  close(game.player.x, DOOR_WIDTH / 2 - PLAYER_RADIUS); close(game.player.z, -5.08);
  assert.equal(game.transitions, 0);
  game.move({ x: 0, z: -0.1 });
  assert.equal(game.transitions, 1); close(game.player.z, 5.12);
  game.move({ x: 0.2, z: 0 });
  close(game.player.x, DOOR_WIDTH / 2 - PLAYER_RADIUS); close(game.player.z, 5.12);
});
