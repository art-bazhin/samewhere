/** Pure game rules and collision/portal math. No dependency on WebGL or the DOM. */
export type RoomId = 'A' | 'B';
export type BallColor = 'red' | 'blue';
export type Mode = 'explore' | 'puzzle';
export interface Vec2 { x: number; z: number }
export interface SocketRef { room: RoomId; side: number }
export interface BallState { id: string; color: BallColor; socket: SocketRef | null }
export interface PlayerState extends Vec2 { room: RoomId; yaw: number; pitch: number }
export interface WorldState { balls: BallState[]; selected: BallColor; mode: Mode; visitedB: boolean; solved: boolean }
export interface Snapshot { world: WorldState; player: PlayerState }
export interface Connection { color: BallColor; ends: [SocketRef, SocketRef] }
export interface PedestalDefinition extends Vec2 { controls: RoomId }
export interface RoomDefinition { id: RoomId; sides: number; apothem: number; pedestals: PedestalDefinition[] }
export const ROOMS: Record<RoomId, RoomDefinition> = {
  A: { id: 'A', sides: 4, apothem: 5, pedestals: [{ controls: 'A', x: -1.5, z: 1.5 }, { controls: 'B', x: 1.5, z: -1.5 }] },
  B: { id: 'B', sides: 5, apothem: 5, pedestals: [{ controls: 'A', x: -1.5, z: 0.8 }, { controls: 'B', x: 1.5, z: -0.8 }] },
};
export const ROOM_HEIGHT = 3.5;
export const EYE_HEIGHT = 1.65;
export const DOOR_WIDTH = 1.8;
export const DOOR_HEIGHT = 2.6;
export const PLAYER_RADIUS = 0.22;
export const PEDESTAL_APOTHEM = 0.65;
export const SOCKET_RADIUS = 0.47;
export const sameSocket = (a: SocketRef, b: SocketRef) => a.room === b.room && a.side === b.side;
export const wallAngle = (room: RoomId, side: number) => side * Math.PI * 2 / ROOMS[room].sides;
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
  const a = wallNormal(from.room, from.side), b = wallNormal(to.room, to.side);
  const offset = rotate({ x: p.x - a.x * ROOMS[from.room].apothem, z: p.z - a.z * ROOMS[from.room].apothem }, portalAngle(from, to));
  return { x: offset.x + b.x * ROOMS[to.room].apothem, z: offset.z + b.z * ROOMS[to.room].apothem };
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
export function initialState(mode: Mode = 'explore'): Snapshot {
  return {
    world: { mode, selected: 'red', visitedB: false, solved: false, balls: [
      { id: 'R1', color: 'red', socket: { room: 'A', side: 0 } },
      { id: 'R2', color: 'red', socket: { room: 'A', side: 2 } },
      { id: 'B1', color: 'blue', socket: { room: 'A', side: 1 } },
      { id: 'B2', color: 'blue', socket: { room: 'A', side: 3 } },
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
  constructor(mode: Mode = 'explore') {
    const state = initialState(mode);
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
  reset(mode = this.world.mode) {
    this.restore(initialState(mode)); this.history = []; this.transitions = 0;
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
        const d0 = old.x * n.x + old.z * n.z, d1 = next.x * n.x + next.z * n.z;
        const lateral = next.x * -n.z + next.z * n.x;
        const open = to && Math.abs(lateral) < DOOR_WIDTH / 2 - PLAYER_RADIUS;
        if (open && d0 <= room.apothem && d1 > room.apothem) {
          const from = { room: room.id, side };
          const t = (room.apothem - d0) / (d1 - d0);
          const boundary = { x: old.x + step.x * t, z: old.z + step.z * t };
          const before = this.snapshot();
          before.player.x = boundary.x - n.x * (PLAYER_RADIUS + 0.035);
          before.player.z = boundary.z - n.z * (PLAYER_RADIUS + 0.035);
          this.remember(before);
          next = transformPoint(next, from, to);
          const delta = portalAngle(from, to);
          step = rotate(step, delta);
          this.player.yaw -= delta;
          this.player.room = to.room;
          this.transitions++;
          if (to.room === 'B') this.world.visitedB = true;
          if (this.world.mode === 'puzzle' && this.world.visitedB && to.room === 'A') this.world.solved = true;
          crossed = true; break;
        }
        if (!open && d1 > room.apothem - PLAYER_RADIUS) {
          const push = d1 - room.apothem + PLAYER_RADIUS;
          next.x -= n.x * push; next.z -= n.z * push;
        }
      }
      if (!crossed) {
        if (this.world.mode === 'puzzle' && room.id === 'A') {
          const distance = (next.z - next.x) / Math.SQRT2;
          const oldSide = old.z - old.x >= 0 ? 1 : -1;
          const clearance = PLAYER_RADIUS + 0.07;
          if (distance * oldSide < clearance) {
            const push = clearance * oldSide - distance;
            next.x -= push / Math.SQRT2; next.z += push / Math.SQRT2;
          }
        }
        for (const pedestal of room.pedestals) {
          const dx = next.x - pedestal.x, dz = next.z - pedestal.z;
          const distance = Math.hypot(dx, dz), radius = 0.88 + PLAYER_RADIUS;
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
