import { FINAL_PASSAGE_GOALS, Game, initialState, PASSAGE_GOALS, ROOM_IDS, validateWorld, type Snapshot } from './world';
import { galleryRoute } from './gallery';

export const SAVE_KEY = 'samewhere.save';
export function hasSave(storage?: Pick<Storage, 'getItem'>): boolean {
  try { return (storage ?? localStorage).getItem(SAVE_KEY) !== null; }
  catch { return false; }
}

interface SavedGame {
  version: 1;
  state: Snapshot;
  history: Snapshot[];
  transitions: number;
  music: number[];
  soundEnabled: boolean;
}

function validateSnapshot({ world, player }: Snapshot) {
  validateWorld(world);
  const balls = initialState().world.balls;
  if (!balls.every(expected => world.balls.some(ball => ball.id === expected.id && ball.color === expected.color)) ||
      world.balls.some(ball => ball.socket !== null && typeof ball.socket !== 'object') || !['red', 'blue'].includes(world.selected) ||
      !Number.isInteger(world.passageProgress) || world.passageProgress < 0 || world.passageProgress > PASSAGE_GOALS.length + 1 ||
      !ROOM_IDS.includes(player.room) || ![player.x, player.z, player.yaw, player.pitch].every(Number.isFinite) || Math.abs(player.pitch) > Math.PI / 2) {
    throw new Error('Invalid saved state');
  }
  if (world.gallery !== null) {
    const gallery = world.gallery;
    if (player.room !== 'A' || world.passageProgress !== PASSAGE_GOALS.length + 1 ||
        !Number.isSafeInteger(gallery.cell.x) || !Number.isSafeInteger(gallery.cell.z) || typeof gallery.outside !== 'boolean' ||
        JSON.stringify(gallery.signs) !== JSON.stringify(galleryRoute()) ||
        !FINAL_PASSAGE_GOALS.every(goal => world.balls.some(ball => ball.color === goal.color &&
          ball.socket?.room === goal.from.room && ball.socket.side === goal.from.side))) throw new Error('Invalid saved gallery');
  }
}

/** Invalid or unavailable browser storage must never prevent a new game. */
export function loadSave(storage?: Pick<Storage, 'getItem'>): SavedGame | null {
  try {
    const saved: SavedGame = JSON.parse((storage ?? localStorage).getItem(SAVE_KEY) ?? 'null');
    if (!saved || saved.version !== 1 || !Array.isArray(saved.history) || saved.history.length > 256 ||
        !Number.isSafeInteger(saved.transitions) || saved.transitions < 0 || typeof saved.soundEnabled !== 'boolean' ||
        !Array.isArray(saved.music) || !saved.music.includes(0) || new Set(saved.music).size !== saved.music.length ||
        !saved.music.every(index => Number.isInteger(index) && index >= 0 && index < 6)) return null;
    validateSnapshot(saved.state);
    saved.history.forEach(validateSnapshot);
    return saved;
  } catch { return null; }
}

export function saveGame(game: Game, music: Iterable<number>, soundEnabled: boolean, storage?: Pick<Storage, 'setItem'>) {
  try {
    const saved: SavedGame = { version: 1, state: { world: game.world, player: game.player }, history: game.history,
      transitions: game.transitions, music: [...music], soundEnabled };
    (storage ?? localStorage).setItem(SAVE_KEY, JSON.stringify(saved));
  } catch { /* Play can continue when storage is blocked or full. */ }
}
