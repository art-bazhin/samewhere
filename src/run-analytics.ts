import { PASSAGE_GOALS, ROOM_IDS, type Game, type RoomId } from './world';
import { GAME_VERSION } from './version';

const ROOM_LABELS: Record<RoomId, string> = {
  A: '4', B: '5', C: '6', D: '3', E: 'Y', F: 'X', G: 'H',
};

export const MILESTONES = [
  'run_started',
  ...ROOM_IDS.map(room => `room_${ROOM_LABELS[room]}_visited`),
  ...PASSAGE_GOALS.map(goal => `symbol_connection_${ROOM_LABELS[goal.to]}_opened`),
  ...PASSAGE_GOALS.map(goal => `symbol_room_${ROOM_LABELS[goal.to]}_visited`),
  'all_balls_in_4', 'room_4_pattern_completed', 'game_completed',
] as const;

export interface RunAnalyticsState {
  version: typeof GAME_VERSION;
  activeMs: number;
  reached: string[];
}
export type AnalyticsSink = (event: string, value: number) => void;

/** Bad telemetry must not invalidate otherwise usable game progress. */
export function readRunAnalytics(value: unknown): RunAnalyticsState | undefined {
  if (!value || typeof value !== 'object') return;
  const state = value as RunAnalyticsState;
  if (state.version !== GAME_VERSION || !Number.isFinite(state.activeMs) || state.activeMs < 0 ||
      !Array.isArray(state.reached) || state.reached.length > 128 ||
      new Set(state.reached).size !== state.reached.length) return;
  if (state.reached.length > 0 && !state.reached.includes('run_started')) return;
  // Version mismatches reset the whole save; unknown names alone must not disable tracking.
  const reached = state.reached.filter(item => MILESTONES.includes(item));
  return { version: GAME_VERSION, activeMs: Math.floor(state.activeMs), reached };
}

/** One small checkpoint per run, independent of the network and SDK session clock. */
export class RunAnalytics {
  private state: RunAnalyticsState | undefined;
  private activeSince: number | null = null;
  private announced = false;
  constructor(
    saved: RunAnalyticsState | undefined,
    public send: AnalyticsSink,
    private readonly enabled = true,
    private readonly now = () => performance.now(),
  ) {
    this.state = enabled ? readRunAnalytics(saved) : undefined;
  }
  reset() {
    this.state = this.enabled ? { version: GAME_VERSION, activeMs: 0, reached: [] } : undefined;
    this.activeSince = null; this.announced = false;
  }
  setPlaying(playing: boolean) {
    if (!this.state || playing === (this.activeSince !== null)) return;
    this.checkpoint(); this.activeSince = playing ? Math.floor(this.now()) : null;
  }
  private checkpoint() {
    if (!this.state || this.activeSince === null) return;
    const now = Math.floor(this.now());
    this.state.activeMs += Math.max(0, now - this.activeSince); this.activeSince = now;
  }
  snapshot(): RunAnalyticsState | undefined {
    this.checkpoint();
    return this.state && { ...this.state, reached: [...this.state.reached] };
  }
  play(game: Game) {
    if (!this.state || this.announced) return;
    this.announced = true;
    if (this.state.reached.includes('run_started')) this.measure('run_resumed');
    else this.mark('run_started');
    this.observe(game);
  }
  observe(game: Game) {
    if (!this.state?.reached.includes('run_started')) return;
    this.checkpoint();
    const { world, player } = game;
    this.mark(`room_${ROOM_LABELS[player.room]}_visited`);
    for (const [index, goal] of PASSAGE_GOALS.entries()) {
      if (world.passageProgress < index + 1) continue;
      this.mark(`symbol_connection_${ROOM_LABELS[goal.to]}_opened`);
      if (player.room === goal.to) this.mark(`symbol_room_${ROOM_LABELS[goal.to]}_visited`);
    }
    if (world.passageProgress >= PASSAGE_GOALS.length && player.room === 'A' &&
        world.balls.every(ball => !ball.socket || ball.socket.room === 'A')) this.mark('all_balls_in_4');
    if (world.passageProgress > PASSAGE_GOALS.length) this.mark('room_4_pattern_completed');
    if (world.gallery?.outside) this.mark('game_completed');
  }
  private mark(milestone: string) {
    if (!this.state || this.state.reached.includes(milestone)) return;
    this.state.reached.push(milestone); this.measure(milestone);
  }
  private measure(milestone: string) {
    if (!this.state) return;
    // Design events expose one numeric value in the free GameAnalytics UI.
    try { this.send(`v${GAME_VERSION}:${milestone}`, Math.floor(this.state.activeMs / 1000)); }
    catch { /* Telemetry must never interrupt gameplay. */ }
  }
}
