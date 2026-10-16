/** Pure game rules and collision/portal math. No dependency on WebGL or the DOM. */
import { closestOnSegment, crossOutline, hOutline, insideOutline, outlineWalls, regularOutline, yOutline, type Vec2 } from './geometry';
export type { Vec2 } from './geometry';
export type RoomId = 'A' | 'B' | 'C' | 'D' | 'E' | 'F' | 'G';
export type BallColor = 'red' | 'blue';
export interface SocketRef { room: RoomId; side: number }
export interface BallState { id: string; color: BallColor; socket: SocketRef | null }
export interface PlayerState extends Vec2 { room: RoomId; yaw: number; pitch: number }
export interface WorldState { balls: BallState[]; selected: BallColor }
export interface Snapshot { world: WorldState; player: PlayerState }
export interface Connection { color: BallColor; ends: [SocketRef, SocketRef] }
export interface PedestalDefinition extends Vec2 { controls: RoomId }
/** sides counts portal/socket positions; outlines may have additional solid edges. */
export interface RoomDefinition { id: RoomId; name: string; shape: string; sides: number; apothem: number; pedestals: PedestalDefinition[]; outline?: Vec2[]; portalEdges?: number[] }
export const CEILING_TILE_SIZE = 0.6;
export const ROOMS: Record<RoomId, RoomDefinition> = {
  A: { id: 'A', name: 'Квадратная комната', shape: 'square', sides: 4, apothem: 5, pedestals: [{ controls: 'A', x: -1.5, z: 1.5 }, { controls: 'B', x: 1.5, z: -1.5 }] },
  B: { id: 'B', name: 'Пятиугольная комната', shape: 'pentagon', sides: 5, apothem: 5, pedestals: [{ controls: 'B', x: -1.5, z: 0.8 }, { controls: 'C', x: 1.5, z: -0.8 }] },
  C: { id: 'C', name: 'Шестиугольная комната', shape: 'hexagon', sides: 6, apothem: 5, pedestals: [{ controls: 'C', x: -1.5, z: 0.8 }, { controls: 'D', x: 1.5, z: -0.8 }] },
  D: { id: 'D', name: 'Треугольная комната', shape: 'triangle', sides: 3, apothem: 5, pedestals: [{ controls: 'D', x: -1.5, z: 0.8 }, { controls: 'A', x: 1.5, z: -0.8 }, { controls: 'E', x: 1.5, z: 2 }] },
  E: { id: 'E', name: 'Y-комната', shape: 'y-room', sides: 3, apothem: 7, outline: yOutline(7, 1.7), portalEdges: [0, 3, 6],
    pedestals: [{ controls: 'B', x: -2.6, z: 1.5 }, { controls: 'F', x: 2.6, z: 1.5 }] },
  F: { id: 'F', name: 'Комната-крест', shape: 'cross-room', sides: 4, apothem: 7, outline: crossOutline(7, 1.7), portalEdges: [0, 3, 6, 9],
    pedestals: [{ controls: 'D', x: -3, z: 0 }, { controls: 'G', x: 3, z: 0 }] },
  G: { id: 'G', name: 'H-комната', shape: 'h-room', sides: 4, apothem: 7, outline: hOutline(7, 3.5, 1.7), portalEdges: [0, 4, 6, 10],
    pedestals: [
      { controls: 'A', x: -3.5, z: -4 }, { controls: 'B', x: -3.5, z: 0 }, { controls: 'C', x: -3.5, z: 4 },
      { controls: 'D', x: 3.5, z: -4 }, { controls: 'E', x: 3.5, z: 0 }, { controls: 'F', x: 3.5, z: 4 },
      { controls: 'G', x: 0, z: 0 },
    ] },
};
export const ROOM_IDS = Object.keys(ROOMS) as RoomId[];
// Tile centers are integer multiples of 60 cm; the origin is a tile center.
// Round half-tiles away from zero to preserve symmetric pedestal arrangements.
const ceilingCoordinate = (value: number) => Math.sign(value) * Math.round(Math.abs(value) / CEILING_TILE_SIZE) * CEILING_TILE_SIZE;
for (const id of ROOM_IDS) for (const pedestal of ROOMS[id].pedestals) {
  pedestal.x = ceilingCoordinate(pedestal.x); pedestal.z = ceilingCoordinate(pedestal.z);
}
const outlines = Object.fromEntries(ROOM_IDS.map(id => [id, ROOMS[id].outline ?? regularOutline(ROOMS[id].sides, ROOMS[id].apothem)])) as Record<RoomId, Vec2[]>;
const boundaries = Object.fromEntries(ROOM_IDS.map(id => [id, outlineWalls(outlines[id], ROOMS[id].portalEdges ?? Array.from({ length: ROOMS[id].sides }, (_, i) => i))])) as Record<RoomId, ReturnType<typeof outlineWalls>>;
const doorways = Object.fromEntries(ROOM_IDS.map(id => [id, boundaries[id].filter(wall => wall.portal !== null).sort((a, b) => a.portal! - b.portal!)])) as typeof boundaries;
export const ROOM_HEIGHT = 3.5;
export const WALL_THICKNESS = 0.3;
export const EYE_HEIGHT = 1.65;
export const DOOR_WIDTH = 1.8;
export const DOOR_HEIGHT = 2.6;
export const PLAYER_RADIUS = 0.22;
export const PEDESTAL_APOTHEM = 0.325;
export const PEDESTAL_HEIGHT = 1.2;
export const SOCKET_RADIUS = 0.235;
export const roomOutline = (room: RoomId) => outlines[room];
export const roomWalls = (room: RoomId) => boundaries[room];
export const doorFrame = (room: RoomId, side: number) => doorways[room][side];
export function portalPosition(room: RoomId, side: number): Vec2 {
  const { center, normal } = doorFrame(room, side);
  return { x: center.x + normal.x * WALL_THICKNESS / 2, z: center.z + normal.z * WALL_THICKNESS / 2 };
}
export function portalDistance(room: RoomId, side = 0) {
  const p = portalPosition(room, side), n = wallNormal(room, side); return p.x * n.x + p.z * n.z;
}
export function pedestalOutline(room: RoomId): Vec2[] {
  return ROOMS[room].outline ? outlines[room].map(p => ({ x: p.x * .06, z: p.z * .06 })) : regularOutline(ROOMS[room].sides, PEDESTAL_APOTHEM);
}
export function socketPosition(room: RoomId, side: number): Vec2 {
  const { center, normal } = doorFrame(room, side);
  return ROOMS[room].outline ? { x: center.x * .06 - normal.x * .09, z: center.z * .06 - normal.z * .09 } : { x: normal.x * SOCKET_RADIUS, z: normal.z * SOCKET_RADIUS };
}
const pedestalRadii = Object.fromEntries(ROOM_IDS.map(id => [id, Math.max(...pedestalOutline(id).map(p => Math.hypot(p.x, p.z)))])) as Record<RoomId, number>;
export const pedestalRadius = (room: RoomId) => pedestalRadii[room];
export const sameSocket = (a: SocketRef, b: SocketRef) => a.room === b.room && a.side === b.side;
export const wallAngle = (room: RoomId, side: number) => ROOMS[room].outline ? Math.atan2(doorFrame(room, side).normal.x, -doorFrame(room, side).normal.z) : side * Math.PI * 2 / ROOMS[room].sides;
export function wallNormal(room: RoomId, side: number): Vec2 {
  const a = wallAngle(room, side);
  return { x: Math.sin(a), z: -Math.cos(a) };
}
export function rotate(v: Vec2, angle: number): Vec2 {
  const c = Math.cos(angle), s = Math.sin(angle);
  return { x: v.x * c - v.z * s, z: v.x * s + v.z * c };
}
export function portalAngle(from: SocketRef, to: SocketRef) {
  return wallAngle(to.room, to.side) - wallAngle(from.room, from.side) + Math.PI;
}
export function transformPoint(p: Vec2, from: SocketRef, to: SocketRef): Vec2 {
  const a = portalPosition(from.room, from.side), b = portalPosition(to.room, to.side);
  const offset = rotate({ x: p.x - a.x, z: p.z - a.z }, portalAngle(from, to));
  return { x: offset.x + b.x, z: offset.z + b.z };
}
export function canStand(room: RoomId, point: Vec2, radius = PLAYER_RADIUS): boolean {
  if (!insideOutline(point, outlines[room])) return false;
  for (const wall of boundaries[room]) {
    const closest = closestOnSegment(point, wall.a, wall.b);
    if (Math.hypot(point.x - closest.x, point.z - closest.z) < radius - 1e-8) return false;
  }
  return ROOMS[room].pedestals.every(p => Math.hypot(point.x - p.x, point.z - p.z) >= pedestalRadius(p.controls) + radius - 1e-8);
}
export function connections(world: WorldState): Connection[] {
  return (['red', 'blue'] as const).flatMap(color => {
    const pair = world.balls.filter(b => b.color === color);
    return pair.every(b => b.socket) ? [{ color, ends: [pair[0].socket!, pair[1].socket!] as [SocketRef, SocketRef] }] : [];
  });
}
export function destination(world: WorldState, socket: SocketRef): SocketRef | null {
  for (const { ends } of connections(world)) {
    if (sameSocket(ends[0], socket)) return ends[1];
    if (sameSocket(ends[1], socket)) return ends[0];
  }
  return null;
}
export function ballAt(world: WorldState, socket: SocketRef) {
  return world.balls.find(b => b.socket && sameSocket(b.socket, socket));
}
export function inventoryCount(world: WorldState, color: BallColor) {
  return world.balls.filter(b => b.color === color && !b.socket).length;
}
export function initialState(): Snapshot {
  return {
    world: { selected: 'red', balls: [
      { id: 'R1', color: 'red', socket: { room: 'B', side: 0 } },
      { id: 'R2', color: 'red', socket: { room: 'B', side: 2 } },
      { id: 'B1', color: 'blue', socket: { room: 'C', side: 0 } },
      { id: 'B2', color: 'blue', socket: { room: 'C', side: 3 } },
    ] },
    player: { room: 'A', x: -3, z: 3, yaw: -Math.PI / 4, pitch: -0.16 },
  };
}
export function validateWorld(world: WorldState) {
  if (world.balls.length !== 4 || new Set(world.balls.map(b => b.id)).size !== 4) throw new Error('Exactly four unique balls are required');
  for (const color of ['red', 'blue'] as const) if (world.balls.filter(b => b.color === color).length !== 2) throw new Error('Each color requires two endpoints');
  const occupied = new Set<string>();
  for (const { socket } of world.balls) {
    if (!socket) continue;
    if (!ROOMS[socket.room] || !Number.isInteger(socket.side) || socket.side < 0 || socket.side >= ROOMS[socket.room].sides) throw new Error('Invalid socket');
    const key = `${socket.room}${socket.side}`;
    if (occupied.has(key)) throw new Error('Two balls cannot occupy one socket');
    occupied.add(key);
  }
}

export class Game {
  world: WorldState;
  player: PlayerState;
  history: Snapshot[] = [];
  transitions = 0;
  constructor() {
    const state = initialState();
    this.world = state.world; this.player = state.player;
  }
  snapshot(): Snapshot { return structuredClone({ world: this.world, player: this.player }); }
  remember(snapshot = this.snapshot()) {
    this.history.push(snapshot);
    if (this.history.length > 256) this.history.shift();
  }
  restore(snapshot: Snapshot) {
    const state = structuredClone(snapshot);
    validateWorld(state.world);
    this.world = state.world; this.player = state.player;
  }
  undo() {
    const last = this.history.pop();
    if (!last) return false;
    this.restore(last); return true;
  }
  reset() {
    this.restore(initialState()); this.history = []; this.transitions = 0;
  }
  interact(socket: SocketRef): 'take' | 'place' | null {
    if (!ROOMS[socket.room] || socket.side < 0 || socket.side >= ROOMS[socket.room].sides || !Number.isInteger(socket.side)) return null;
    const existing = ballAt(this.world, socket);
    const available = this.world.balls.find(b => !b.socket && b.color === this.world.selected);
    if (!existing && !available) return null;
    this.remember();
    if (existing) { existing.socket = null; this.world.selected = existing.color; }
    else available!.socket = { ...socket };
    validateWorld(this.world);
    return existing ? 'take' : 'place';
  }
  move(displacement: Vec2) {
    // Small bounded steps preserve collision behavior even after a slow frame.
    const steps = Math.max(1, Math.ceil(Math.hypot(displacement.x, displacement.z) / 0.065));
    let step = { x: displacement.x / steps, z: displacement.z / steps };
    for (let s = 0; s < steps; s++) {
      const old = { x: this.player.x, z: this.player.z };
      let next = { x: old.x + step.x, z: old.z + step.z };
      const room = ROOMS[this.player.room];
      let crossed = false;
      for (let side = 0; side < room.sides; side++) {
        const n = wallNormal(room.id, side), to = destination(this.world, { room: room.id, side });
        const frame = doorFrame(room.id, side);
        const d0 = (old.x - frame.center.x) * n.x + (old.z - frame.center.z) * n.z;
        let d1 = (next.x - frame.center.x) * n.x + (next.z - frame.center.z) * n.z;
        let lateral = (next.x - frame.center.x) * -n.z + (next.z - frame.center.z) * n.x;
        if (room.outline && Math.abs(lateral) > frame.width / 2 + PLAYER_RADIUS) continue;
        const clearance = DOOR_WIDTH / 2 - PLAYER_RADIUS;
        if (to && d1 > -PLAYER_RADIUS && Math.abs(lateral) > clearance) {
          // Keep the existing conservative jamb clearance. Once inside the
          // doorway, stop sideways motion without snapping back into the room.
          if (d0 <= -PLAYER_RADIUS + 1e-9) {
            const push = d1 + PLAYER_RADIUS;
            next.x -= n.x * push; next.z -= n.z * push;
          } else {
            const push = Math.sign(lateral) * clearance - lateral;
            next.x -= n.z * push; next.z += n.x * push;
          }
          d1 = (next.x - frame.center.x) * n.x + (next.z - frame.center.z) * n.z;
          lateral = (next.x - frame.center.x) * -n.z + (next.z - frame.center.z) * n.x;
        }
        const open = to && Math.abs(lateral) <= clearance + 1e-9;
        const seam = WALL_THICKNESS / 2;
        if (open && d0 <= seam && d1 > seam) {
          const from = { room: room.id, side };
          const t = (seam - d0) / (d1 - d0);
          const boundary = { x: old.x + (next.x - old.x) * t, z: old.z + (next.z - old.z) * t };
          const before = this.snapshot();
          before.player.x = boundary.x - n.x * (WALL_THICKNESS / 2 + PLAYER_RADIUS + 0.035);
          before.player.z = boundary.z - n.z * (WALL_THICKNESS / 2 + PLAYER_RADIUS + 0.035);
          this.remember(before);
          next = transformPoint(next, from, to);
          const delta = portalAngle(from, to);
          step = rotate(step, delta);
          this.player.yaw -= delta;
          this.player.room = to.room;
          this.transitions++;
          crossed = true; break;
        }
        if (!to && d1 > -PLAYER_RADIUS) {
          const push = d1 + PLAYER_RADIUS;
          next.x -= n.x * push; next.z -= n.z * push;
        }
      }
      if (!crossed) {
        if (room.outline) {
          // Finite segments support recesses and connecting corridors. Infinite
          // half-planes would incorrectly seal the other arms of a Y, +, or H.
          for (let pass = 0; pass < 3; pass++) for (const wall of boundaries[room.id]) {
            const open = wall.portal !== null && destination(this.world, { room: room.id, side: wall.portal });
            const segments = open ? [
              [wall.a, { x: wall.center.x + wall.normal.z * DOOR_WIDTH / 2, z: wall.center.z - wall.normal.x * DOOR_WIDTH / 2 }],
              [{ x: wall.center.x - wall.normal.z * DOOR_WIDTH / 2, z: wall.center.z + wall.normal.x * DOOR_WIDTH / 2 }, wall.b],
            ] : [[wall.a, wall.b]];
            for (const [a, b] of segments) {
              const closest = closestOnSegment(next, a, b), dx = next.x - closest.x, dz = next.z - closest.z, distance = Math.hypot(dx, dz);
              if (distance >= PLAYER_RADIUS - 1e-9) continue;
              if (distance > 1e-9 && insideOutline(next, outlines[room.id])) {
                const push = (PLAYER_RADIUS - distance) / distance;
                next.x += dx * push; next.z += dz * push;
              } else {
                next.x = closest.x - wall.normal.x * PLAYER_RADIUS;
                next.z = closest.z - wall.normal.z * PLAYER_RADIUS;
              }
            }
          }
        }
        for (const pedestal of room.pedestals) {
          const dx = next.x - pedestal.x, dz = next.z - pedestal.z;
          const distance = Math.hypot(dx, dz), radius = pedestalRadius(pedestal.controls) + PLAYER_RADIUS;
          if (distance < radius) {
            const safe = Math.max(distance, 0.0001);
            next.x = pedestal.x + dx / safe * radius;
            next.z = pedestal.z + dz / safe * radius;
          }
        }
      }
      this.player.x = next.x; this.player.z = next.z;
    }
  }
}
