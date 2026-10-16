import test from 'node:test';
import assert from 'node:assert/strict';
import { Game, ROOMS, type BallColor, type RoomId } from '../src/world';

interface Layout { room: RoomId; balls: (RoomId | null)[] }
interface Restriction { hub?: RoomId; fixedColor?: BallColor }

// These footprints have connected corridors without internal gates. Keep
// socket capacity, but merge equivalent terminal choices and same-color ball IDs.
// This search is independent of Game.interact and only exposes local controls.
function canReach(goal: RoomId, initial: Layout, restriction: Restriction = {}) {
  const canonical = (balls: Layout['balls']) => {
    const compare = (a: RoomId | null, b: RoomId | null) => (a ?? '_').localeCompare(b ?? '_');
    return [...balls.slice(0, 2).sort(compare), ...balls.slice(2).sort(compare)];
  };
  const key = (state: Layout) => `${state.room}:${state.balls.map(ball => ball ?? '_').join('')}`;
  const start = { ...initial, balls: canonical(initial.balls) };
  const queue = [start], seen = new Set([key(start)]);
  const fixed = restriction.fixedColor === 'red' ? 0 : restriction.fixedColor === 'blue' ? 2 : null;
  function add(room: RoomId, balls: Layout['balls']) {
    const state = { room, balls: canonical(balls) };
    if (fixed !== null && state.balls.slice(fixed, fixed + 2).join() !== start.balls.slice(fixed, fixed + 2).join()) return;
    const hash = key(state);
    if (!seen.has(hash)) { seen.add(hash); queue.push(state); }
  }
  for (let index = 0; index < queue.length; index++) {
    const { room, balls } = queue[index];
    if (room === goal) return true;
    const controls = ROOMS[room].pedestals.map(pedestal => pedestal.controls);
    balls.forEach((location, ball) => {
      if (location !== null && controls.includes(location)) {
        const next = [...balls]; next[ball] = null; add(room, next);
      } else if (location === null) {
        for (const target of controls) {
          if (balls.filter(location => location === target).length >= ROOMS[target].sides) continue;
          const next = [...balls]; next[ball] = target; add(room, next);
        }
      }
    });
    for (const ball of [0, 2]) {
      const a = balls[ball], b = balls[ball + 1];
      if (a === null || b === null || a === b) continue;
      const to = a === room ? b : b === room ? a : null;
      if (to !== null && (!restriction.hub || room === restriction.hub || to === restriction.hub)) add(to, balls);
    }
  }
  return false;
}

test('G is reachable with four balls, but routing every crossing through A cannot reach it', () => {
  const game = new Game();
  const initial = { room: game.player.room, balls: game.world.balls.map(ball => ball.socket?.room ?? null) };
  assert.equal(canReach('G', initial), true);
  assert.equal(canReach('G', initial, { hub: 'A' }), false);
});

test('after the original route to D, neither color can remain a permanent return connection', () => {
  const atD: Layout = { room: 'D', balls: ['A', 'D', 'A', 'C'] };
  assert.equal(canReach('G', atD), true);
  for (const color of ['red', 'blue'] as const) assert.equal(canReach('G', atD, { fixedColor: color }), false);
});
