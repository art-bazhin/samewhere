import { ballAt, connections, FINAL_PASSAGE_GOALS, Game, inventoryCount, PASSAGE_GOALS, wallNormal } from './world';
import { galleryRoute } from './gallery';
import { SpaceRenderer } from './scene';
import { Sound } from './audio';
import { FrameTiming } from './timing';
import { MouseLook } from './mouse-look';
import { SurfaceTextures } from './surface-textures';
import { hasSave, loadSave, saveGame } from './save';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const devMode = new URLSearchParams(location.search).get('dev') === '1';
const keyboard = (navigator as Navigator & {
  keyboard?: { lock(keys: string[]): Promise<void>; unlock(): void };
}).keyboard;
$('fps-counter').hidden = !devMode;
const canvas = $<HTMLCanvasElement>('game');
const controlsDialog = $<HTMLDialogElement>('controls-dialog');
const newGameDialog = $<HTMLDialogElement>('new-game-dialog');
const dialogs = [controlsDialog, newGameDialog];
const endingScreen = $('ending-screen'), playAgain = $<HTMLButtonElement>('play-again');
const game = new Game();
const sound = new Sound();
const saved = loadSave();
if (saved) {
  game.restore(saved.state); game.history = saved.history; game.transitions = saved.transitions;
  sound.music.active.clear(); saved.music.forEach(index => sound.music.active.add(index));
  sound.enabled = saved.soundEnabled;
}
const timing = new FrameTiming();
const mouseLook = new MouseLook();
const mouseEvent = 'onpointerrawupdate' in window ? 'pointerrawupdate' : 'mousemove';
const crosshair = $('crosshair'), inventory = $('inventory');
const inventoryBalls = new Map(game.world.balls.map(ball => {
  const element = document.createElement('span');
  element.className = 'inventory-ball'; element.dataset.ball = ball.id; element.dataset.color = ball.color;
  element.setAttribute('role', 'img'); inventory.append(element);
  return [ball.id, element];
}));
let mouseInput: 'raw' | 'standard' = 'standard';
const MOVE_SPEED = 5;
const DEBUG_ROOMS = ['G', 'A', 'B', 'C', 'D', 'E', 'F'] as const;
let debugRoomIndex = 0;
let space: SpaceRenderer;
let surfaceTextures: SurfaceTextures;
let locked = false, started = !!saved, ended = false, debug = false, disposed = false;
let fullscreenPending = false;
let playPending = false, playCancelled = false;
let sweep: { yaw: number; pitch: number; start: number } | null = null;
const keys = new Set<string>();
$('resume-button').hidden = !started;

function autosave(existingOnly = false) {
  if (started && !sweep && (!existingOnly || hasSave())) saveGame(game, sound.music.active, sound.enabled);
}
const saveTimer = window.setInterval(() => { if (locked && !ended && !document.hidden) autosave(); }, 1000);

function finishLoading() {
  const loading = $('loading-screen'), menu = $('menu-content');
  menu.hidden = false;
  loading.addEventListener('animationend', () => {
    loading.hidden = true; menu.inert = false;
    document.body.classList.remove('loading');
  }, { once: true });
  loading.classList.add('revealing');
}

function applyLook(delta: { x: number; y: number }) {
  game.player.yaw -= delta.x * 0.002;
  game.player.pitch = Math.max(-1.35, Math.min(1.35, game.player.pitch - delta.y * 0.002));
}
function updateHUD() {
  const world = game.world;
  const red = inventoryCount(world, 'red'), blue = inventoryCount(world, 'blue');
  inventory.setAttribute('aria-label', red + blue ? `In hand: ${red} red, ${blue} blue. Selected: ${world.selected}.` : 'No balls in hand');
  for (const ball of world.balls) {
    const element = inventoryBalls.get(ball.id)!;
    element.classList.toggle('held', !ball.socket);
    element.classList.toggle('selected', world.selected === ball.color);
    element.setAttribute('aria-hidden', String(!!ball.socket));
    element.setAttribute('aria-label', `${ball.color === 'red' ? 'Red' : 'Blue'} ball${world.selected === ball.color ? ', selected' : ''}`);
  }
}
function sync() {
  space.sync(); space.pick(); updateHUD();
  if (started) sound.music.update(game.player.room, game.world.passageProgress);
  autosave();
}
function stopSweep() {
  if (!sweep) return;
  game.player.yaw = sweep.yaw; game.player.pitch = sweep.pitch; sweep = null;
}
function toggleSweep() {
  if (sweep) { stopSweep(); return; }
  keys.clear(); mouseLook.reset();
  sweep = { yaw: game.player.yaw, pitch: game.player.pitch, start: performance.now() };
}
function reset() {
  ended = false; endingScreen.hidden = true; $('hud').hidden = false;
  $('overlay').hidden = locked; document.body.classList.toggle('paused', !locked);
  stopSweep(); mouseLook.reset(); debugRoomIndex = 0;
  game.reset(); sound.music.reset(); sound.setPaused(!locked); sync();
}
function finishGame() {
  if (ended) return;
  ended = true; keys.clear(); stopSweep(); mouseLook.reset(); dialogs.forEach(dialog => dialog.close());
  $('hud').hidden = true; $('overlay').hidden = true;
  document.body.classList.remove('paused');
  endingScreen.classList.remove('interactive');
  playAgain.disabled = true; endingScreen.hidden = false;
  sound.music.finish();
  autosave();
}
function nextDebugRoom() {
  stopSweep(); keys.clear(); mouseLook.reset();
  const room = DEBUG_ROOMS[debugRoomIndex];
  debugRoomIndex = (debugRoomIndex + 1) % DEBUG_ROOMS.length;
  if (game.world.gallery) game.world.gallery.outside = false;
  // The hub's central pedestal occupies the origin; this spot is clear in every room.
  Object.assign(game.player, { room, x: 0, z: 1, yaw: 0, pitch: 0 });
  sync();
}
function prepareGalleryTest(atExit = false) {
  stopSweep(); keys.clear(); mouseLook.reset(); game.remember();
  game.world.balls.forEach(ball => { ball.socket = null; });
  game.world.selected = 'red'; game.world.passageProgress = PASSAGE_GOALS.length; game.world.gallery = null;
  game.player = { room: 'A', x: -3, z: 3, yaw: -Math.PI / 4, pitch: -.3 };
  if (atExit) {
    for (const goal of FINAL_PASSAGE_GOALS) {
      game.world.balls.find(ball => ball.color === goal.color && !ball.socket)!.socket = { ...goal.from };
    }
    const signs = galleryRoute(), last = signs.at(-1)!, normal = wallNormal('A', last.side);
    game.world.passageProgress++;
    game.world.gallery = { cell: { x: last.x, z: last.z }, signs, outside: false };
    game.player = { room: 'A', x: 0, z: 0, yaw: -Math.atan2(normal.x, -normal.z), pitch: 0 };
  }
  sync();
}
function undo() {
  stopSweep(); mouseLook.reset();
  if (game.undo()) { sync(); sound.play('undo'); }
}
function pause() { playCancelled = true; if (document.pointerLockElement) document.exitPointerLock(); }
async function toggleFullscreen() {
  if (fullscreenPending) return;
  fullscreenPending = true;
  try {
    if (document.fullscreenElement) await document.exitFullscreen();
    else await document.documentElement.requestFullscreen({ navigationUI: 'hide' });
  } catch {
    const message = 'Could not enter fullscreen. Try opening the game in a separate browser tab.';
    pause(); $('error').hidden = false; $('error').textContent = message;
  } finally { fullscreenPending = false; }
}
document.addEventListener('fullscreenchange', () => {
  if (!keyboard?.lock) return;
  if (document.fullscreenElement) {
    void keyboard.lock(['Escape']).catch(error => { if (devMode) console.warn('Keyboard lock failed:', error); });
  } else keyboard.unlock();
});
async function captureMouse() {
  try { await canvas.requestPointerLock({ unadjustedMovement: true }); mouseInput = 'raw'; }
  catch (error) {
    if (!(error instanceof DOMException) || error.name !== 'NotSupportedError') throw error;
    await canvas.requestPointerLock(); mouseInput = 'standard';
  }
}
async function play(newGame = false) {
  if (!space || playPending || locked) return;
  playPending = true; playCancelled = false;
  if (newGame) reset();
  $('error').hidden = true;
  try {
    sound.unlock();
    try { await captureMouse(); }
    catch (error) {
      if (!(error instanceof DOMException) || error.name !== 'SecurityError' || !error.message.includes('immediately after')) throw error;
      // Chromium imposes a 1.25 s cooldown after its Esc unlock gesture.
      await new Promise(resolve => setTimeout(resolve, 1300));
      if (playCancelled || disposed || document.hidden || !document.hasFocus() || dialogs.some(dialog => dialog.open)) return;
      await captureMouse();
    }
    if (playCancelled) pause();
  } catch (error) {
    if (playCancelled || disposed) return;
    if (devMode) console.warn('Mouse capture failed:', error);
    $('error').hidden = false;
    $('error').textContent = 'Could not capture the mouse. Click again to retry. If this keeps happening, open the game in a separate browser tab.';
  } finally { playPending = false; }
}
$('play-button').addEventListener('click', () => {
  if (playPending || locked) return;
  if (started) newGameDialog.showModal(); else void play(true);
});
$('new-game-cancel').addEventListener('click', () => newGameDialog.close());
$('new-game-confirm').addEventListener('click', () => { newGameDialog.close(); void play(true); });
playAgain.addEventListener('click', () => void play(true));
playAgain.addEventListener('animationstart', () => {
  if (ended) { endingScreen.classList.add('interactive'); pause(); }
});
playAgain.addEventListener('animationend', () => { playAgain.disabled = false; });
$('resume-button').addEventListener('click', () => void play());
$('controls-button').addEventListener('click', () => controlsDialog.showModal());
$('controls-close').addEventListener('click', () => controlsDialog.close());
for (const dialog of dialogs) dialog.addEventListener('click', event => {
  if (event.target !== dialog) return;
  const bounds = dialog.getBoundingClientRect();
  if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) dialog.close();
});
document.addEventListener('pointerdown', () => document.body.classList.remove('tab-navigation'));
document.addEventListener('pointerlockchange', () => {
  locked = document.pointerLockElement === canvas; keys.clear();
  sound.setPaused(!locked && !ended);
  mouseLook.reset();
  if (!locked) stopSweep();
  timing.reset();
  $('overlay').hidden = locked || ended; document.body.classList.toggle('paused', !locked && !ended);
  $('menu-content').inert = locked || ended || document.body.classList.contains('loading');
  if (locked && !started) started = true;
  $('resume-button').hidden = !started;
  autosave(!locked);
});
document.addEventListener(mouseEvent, event => {
  if (!locked || sweep || ended) return;
  const pointer = event as PointerEvent;
  const coalesced = pointer.getCoalescedEvents?.();
  // Use either individual packets or their aggregate; never count both streams.
  if (coalesced?.length) {
    for (const sample of coalesced) mouseLook.push(sample.movementX, sample.movementY);
  } else mouseLook.push(pointer.movementX, pointer.movementY);
}, { passive: true });
document.addEventListener('wheel', event => {
  if (!locked || sweep || ended || !event.deltaY) return;
  event.preventDefault();
  const color = game.world.selected === 'red' ? 'blue' : 'red';
  if (inventoryCount(game.world, color)) { game.selectColor(color); updateHUD(); autosave(); }
}, { passive: false });
document.addEventListener('keydown', event => {
  if (event.code === 'Tab' && !locked) document.body.classList.add('tab-navigation');
  if (event.code === 'Escape') document.body.classList.remove('tab-navigation');
  if (ended) { if (event.code === 'Escape') event.preventDefault(); return; }
  if (event.code === 'Escape') {
    event.preventDefault();
    if (event.repeat) return;
    const dialog = dialogs.find(dialog => dialog.open);
    if (dialog) dialog.close();
    else if (locked || playPending) pause();
    else if (document.fullscreenElement && started && !$('menu-content').inert) void play();
    return;
  }
  if (event.code === 'KeyF') { event.preventDefault(); if (!event.repeat) void toggleFullscreen(); return; }
  if (event.code === 'F3') { event.preventDefault(); if (devMode) { debug = !debug; $('debug').hidden = !debug; } return; }
  if (event.code === 'F4') { event.preventDefault(); if (devMode && locked && !event.repeat) toggleSweep(); return; }
  if (!locked) return;
  if (event.code === 'Tab') { event.preventDefault(); if (devMode && !event.repeat) nextDebugRoom(); return; }
  if (event.code === 'Digit0' || event.code === 'Numpad0') { event.preventDefault(); if (devMode && !event.repeat) prepareGalleryTest(); return; }
  if (event.code === 'Digit9' || event.code === 'Numpad9') { event.preventDefault(); if (devMode && !event.repeat) prepareGalleryTest(true); return; }
  if (['KeyW','KeyA','KeyS','KeyD','ArrowUp','ArrowDown','ArrowLeft','ArrowRight','Space'].includes(event.code)) event.preventDefault();
  keys.add(event.code);
  if (event.repeat) return;
  if (event.code === 'Digit1' || event.code === 'Digit2') { game.selectColor(event.code === 'Digit1' ? 'red' : 'blue'); updateHUD(); autosave(); }
  if (event.code === 'KeyZ' && devMode) undo();
  if (event.code === 'KeyR' && devMode) reset();
  if (event.code === 'KeyM') { sound.enabled = !sound.enabled; autosave(); }
  if (event.code === 'KeyT' && devMode) surfaceTextures.toggle();
});
document.addEventListener('keyup', event => keys.delete(event.code));
window.addEventListener('blur', () => { keys.clear(); pause(); });
document.addEventListener('visibilitychange', () => {
  hudTime = performance.now(); timing.reset();
  if (document.hidden) { keys.clear(); autosave(true); pause(); }
});
canvas.addEventListener('click', () => {
  if (!locked || sweep || ended) return;
  const socket = space.pick(); if (!socket) return;
  if (game.interact(socket)) sync();
});
canvas.addEventListener('contextmenu', event => event.preventDefault());
window.addEventListener('resize', () => space?.resize());
canvas.addEventListener('webglcontextlost', event => { event.preventDefault(); pause(); $('error').hidden = false; $('error').textContent = 'The graphics context was lost. Reload the page to continue.'; });

let previousTime = performance.now(), hudTime = previousTime, fps = 0;
function frame(time: number) {
  if (disposed) return;
  requestAnimationFrame(frame);
  const dt = Math.min((time - previousTime) / 1000, 0.1); previousTime = time;
  if (document.hidden) return;
  const frameStart = performance.now();
  if (locked && !ended) {
    const transitions = game.transitions;
    if (!sweep) {
      applyLook(mouseLook.consume());
    }
    if (sweep) {
      const elapsed = frameStart - sweep.start;
      if (elapsed >= 6000) stopSweep();
      else {
        const angle = elapsed / 3000 * Math.PI * 2;
        game.player.yaw = sweep.yaw + 0.6 * Math.sin(angle);
        game.player.pitch = Math.max(-1.35, Math.min(1.35, sweep.pitch + 0.3 * (Math.cos(angle) - 1)));
      }
    }
    let forward = Number(keys.has('KeyW') || keys.has('ArrowUp')) - Number(keys.has('KeyS') || keys.has('ArrowDown'));
    let sideways = Number(keys.has('KeyD') || keys.has('ArrowRight')) - Number(keys.has('KeyA') || keys.has('ArrowLeft'));
    const length = Math.hypot(forward, sideways);
    if (length && !sweep) {
      forward /= length; sideways /= length;
      const yaw = game.player.yaw, speed = MOVE_SPEED * dt;
      game.move({ x: (-Math.sin(yaw) * forward + Math.cos(yaw) * sideways) * speed, z: (-Math.cos(yaw) * forward - Math.sin(yaw) * sideways) * speed });
    }
    const socket = space.pick();
    crosshair.classList.toggle('available', !!socket && (!!ballAt(game.world, socket) || inventoryCount(game.world, game.world.selected) > 0));
    sound.music.update(game.player.room, game.world.passageProgress);
    if (game.transitions !== transitions) autosave();
  }
  if (locked && !ended && game.world.gallery?.outside) finishGame();
  space.render(); timing.record(frameStart, performance.now() - frameStart);
  if (time - hudTime > 500) {
    const stats = timing.summary();
    const gpu = space.gpuTiming.summary();
    fps = Math.round(stats.fps); hudTime = time;
    if (devMode) $('fps-counter').textContent = `${fps} FPS`;
    if (debug) {
      const p = game.player;
      $('debug').textContent = `SAMEWHERE / DEBUG\nRoom ${p.room}\nPosition ${p.x.toFixed(2)}, ${p.z.toFixed(2)}\nYaw ${p.yaw.toFixed(2)} · Pitch ${p.pitch.toFixed(2)}\n${fps} FPS · ${space.passes}/${space.maxPasses} passes · visibility ${space.visibilityDistance} m\nFrame: p95 ${stats.p95Ms.toFixed(1)} / max ${stats.maxMs.toFixed(1)} ms\nCPU p95 ${stats.cpuP95Ms.toFixed(1)} ms · slow frames ${stats.slowFrames}/120\nGPU p95 ${gpu.p95Ms?.toFixed(1) ?? '—'} / max ${gpu.maxMs?.toFixed(1) ?? '—'} ms · pending ${gpu.pending}\nMouse: ${mouseInput === 'raw' ? 'raw input' : 'standard input'}\nGPU: ${space.renderer.info.memory.geometries} geometries / ${space.renderer.info.memory.textures} textures\n${space.drawCalls} draw calls · pool ${space.targets.length}/${space.maxPasses - 1}\nPortals: ${(space.portalPixels / 1e6).toFixed(2)} Mpixels / frame\nTransitions ${game.transitions} · history ${game.history.length}/256\n\n${game.world.balls.map(b => `${b.id}: ${b.socket ? b.socket.room + b.socket.side : 'inventory'}`).join('\n')}\n\n${connections(game.world).map(c => `${c.color}: ${c.ends.map(e => e.room + e.side).join(' ↔ ')}`).join('\n')}`;
    }
  }
}
try {
  space = new SpaceRenderer(canvas, game);
  surfaceTextures = new SurfaceTextures(Object.values(space.rooms).map(room => room.scene), space.assets.textures);
  updateHUD(); requestAnimationFrame(frame);
  const playButton = $<HTMLButtonElement>('play-button');
  void Promise.all([space.ready, sound.ready]).then(() => { playButton.disabled = false; playButton.removeAttribute('aria-busy'); finishLoading(); }).catch(error => {
    console.error(error); $('error').hidden = false; $('error').textContent = 'Could not prepare the game. Reload the page to try again.';
    finishLoading();
  });
  // Development-only inspection surface for reproducible browser acceptance checks.
  if (import.meta.env.DEV) Object.assign(window, { __samewhere: { game, space, sound, sync, reset, undo, pause, timing, mouseLook, mouseEvent, get fps() { return fps; }, get mouseInput() { return mouseInput; } } });
} catch (error) {
  console.error(error); $('error').hidden = false;
  $('error').textContent = 'Could not start 3D. Use a desktop browser with WebGL 2 and hardware acceleration.';
  $<HTMLButtonElement>('play-button').disabled = true;
  finishLoading();
}
window.addEventListener('pagehide', event => {
  stopSweep(); autosave(true);
  if (event.persisted) { pause(); return; }
  clearInterval(saveTimer); disposed = true; space?.dispose(); sound.dispose();
});
