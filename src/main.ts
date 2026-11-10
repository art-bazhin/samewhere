import './style.css';
import { ballAt, connections, FINAL_PASSAGE_GOALS, Game, inventoryCount, PASSAGE_GOALS, wallNormal } from './world';
import { galleryRoute } from './gallery';
import { SpaceRenderer } from './scene';
import { Sound } from './audio';
import { FrameTiming } from './timing';
import { MouseLook } from './mouse-look';
import { SurfaceTextures } from './surface-textures';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const devMode = new URLSearchParams(location.search).get('dev') === '1';
$('fps-counter').hidden = !devMode;
const canvas = $<HTMLCanvasElement>('game');
const game = new Game();
const sound = new Sound();
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
let locked = false, started = false, debug = false, disposed = false;
let fullscreenPending = false;
let sweep: { yaw: number; pitch: number; start: number } | null = null;
const keys = new Set<string>();
document.body.classList.add('paused');

function applyLook(delta: { x: number; y: number }) {
  game.player.yaw -= delta.x * 0.002;
  game.player.pitch = Math.max(-1.35, Math.min(1.35, game.player.pitch - delta.y * 0.002));
}
function updateHUD() {
  const world = game.world;
  const red = inventoryCount(world, 'red'), blue = inventoryCount(world, 'blue');
  inventory.setAttribute('aria-label', red + blue ? `В руках: красных ${red}, синих ${blue}. Выбран ${world.selected === 'red' ? 'красный' : 'синий'} цвет.` : 'В руках нет шаров');
  for (const ball of world.balls) {
    const element = inventoryBalls.get(ball.id)!;
    element.classList.toggle('held', !ball.socket);
    element.classList.toggle('selected', world.selected === ball.color);
    element.setAttribute('aria-hidden', String(!!ball.socket));
    element.setAttribute('aria-label', `${ball.color === 'red' ? 'Красный' : 'Синий'} шар${world.selected === ball.color ? ', выбран' : ''}`);
  }
}
function sync() {
  space.sync(); space.pick(); updateHUD();
  if (started) sound.music.update(game.player.room, game.world.passageProgress);
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
  stopSweep(); mouseLook.reset(); debugRoomIndex = 0;
  game.reset(); sound.music.reset(); sync();
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
function pause() { if (document.pointerLockElement) document.exitPointerLock(); }
function updateFullscreenButtons() {
  const active = !!document.fullscreenElement;
  const label = active ? 'Выйти из полного экрана' : 'На весь экран';
  document.querySelectorAll<HTMLButtonElement>('[data-fullscreen]').forEach(button => {
    button.hidden = !document.fullscreenEnabled && !active;
    button.setAttribute('aria-pressed', String(active));
    button.setAttribute('aria-label', `${label} (F)`);
    button.title = `${label} (F)`;
  });
  document.querySelectorAll<HTMLElement>('[data-fullscreen-label]').forEach(element => { element.textContent = label; });
}
async function toggleFullscreen() {
  if (fullscreenPending) return;
  fullscreenPending = true;
  try {
    if (document.fullscreenElement) await document.exitFullscreen();
    else await document.documentElement.requestFullscreen({ navigationUI: 'hide' });
  } catch {
    const message = 'Не удалось включить полноэкранный режим. Попробуйте открыть игру в отдельной вкладке браузера.';
    pause(); $('error').hidden = false; $('error').textContent = message;
  } finally { fullscreenPending = false; }
}
async function play() {
  if (!space) return;
  sound.unlock();
  try {
    try { await canvas.requestPointerLock({ unadjustedMovement: true }); mouseInput = 'raw'; }
    catch (error) {
      if (!(error instanceof DOMException) || error.name !== 'NotSupportedError') throw error;
      await canvas.requestPointerLock(); mouseInput = 'standard';
    }
  }
  catch { $('error').hidden = false; $('error').textContent = 'Браузер не разрешил захват мыши. Откройте игру в отдельной вкладке и нажмите «Войти» ещё раз.'; }
}
$('play-button').addEventListener('click', () => void play());
document.querySelectorAll<HTMLButtonElement>('[data-fullscreen]').forEach(button => button.addEventListener('click', () => void toggleFullscreen()));
document.addEventListener('fullscreenchange', updateFullscreenButtons);
updateFullscreenButtons();
document.addEventListener('pointerlockchange', () => {
  locked = document.pointerLockElement === canvas; keys.clear();
  mouseLook.reset();
  if (!locked) stopSweep();
  timing.reset();
  $('overlay').hidden = locked; document.body.classList.toggle('paused', !locked);
  if (locked && !started) started = true;
  if (!locked && started) {
    $('play-button').firstElementChild!.textContent = 'Вернуться в пространство';
    $('menu-title').innerHTML = 'Вы всё ещё<br>в том же <em>месте.</em>';
  }
});
document.addEventListener(mouseEvent, event => {
  if (!locked || sweep) return;
  const pointer = event as PointerEvent;
  const coalesced = pointer.getCoalescedEvents?.();
  // Use either individual packets or their aggregate; never count both streams.
  if (coalesced?.length) {
    for (const sample of coalesced) mouseLook.push(sample.movementX, sample.movementY);
  } else mouseLook.push(pointer.movementX, pointer.movementY);
}, { passive: true });
document.addEventListener('wheel', event => {
  if (!locked || sweep || !event.deltaY) return;
  event.preventDefault();
  const color = game.world.selected === 'red' ? 'blue' : 'red';
  if (inventoryCount(game.world, color)) { game.selectColor(color); updateHUD(); }
}, { passive: false });
document.addEventListener('keydown', event => {
  if (event.code === 'Escape') { pause(); return; }
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
  if (event.code === 'Digit1' || event.code === 'Digit2') { game.selectColor(event.code === 'Digit1' ? 'red' : 'blue'); updateHUD(); }
  if (event.code === 'KeyZ') undo();
  if (event.code === 'KeyR' && devMode) reset();
  if (event.code === 'KeyM') sound.enabled = !sound.enabled;
  if (event.code === 'KeyT' && devMode) surfaceTextures.toggle();
});
document.addEventListener('keyup', event => keys.delete(event.code));
window.addEventListener('blur', () => { keys.clear(); pause(); });
document.addEventListener('visibilitychange', () => {
  hudTime = performance.now(); timing.reset();
  if (document.hidden) { keys.clear(); pause(); }
});
canvas.addEventListener('click', () => {
  if (!locked || sweep) return;
  const socket = space.pick(); if (!socket) return;
  if (game.interact(socket)) sync();
});
canvas.addEventListener('contextmenu', event => event.preventDefault());
window.addEventListener('resize', () => space?.resize());
canvas.addEventListener('webglcontextlost', event => { event.preventDefault(); pause(); $('error').hidden = false; $('error').textContent = 'Графический контекст потерян. Перезагрузите страницу, чтобы продолжить.'; });

let previousTime = performance.now(), hudTime = previousTime, fps = 0;
function frame(time: number) {
  if (disposed) return;
  requestAnimationFrame(frame);
  const dt = Math.min((time - previousTime) / 1000, 0.1); previousTime = time;
  if (document.hidden) return;
  const frameStart = performance.now();
  if (locked) {
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
  }
  space.render(); timing.record(frameStart, performance.now() - frameStart);
  if (time - hudTime > 500) {
    const stats = timing.summary();
    const gpu = space.gpuTiming.summary();
    fps = Math.round(stats.fps); hudTime = time;
    if (devMode) $('fps-counter').textContent = `${fps} FPS`;
    if (debug) {
      const p = game.player;
      $('debug').textContent = `SAMEWHERE / DEBUG\nКомната ${p.room}\nПозиция ${p.x.toFixed(2)}, ${p.z.toFixed(2)}\nYaw ${p.yaw.toFixed(2)} · Pitch ${p.pitch.toFixed(2)}\n${fps} FPS · ${space.passes}/${space.maxPasses} проходов · дальность ${space.visibilityDistance} м\nКадр: p95 ${stats.p95Ms.toFixed(1)} / max ${stats.maxMs.toFixed(1)} мс\nCPU p95 ${stats.cpuP95Ms.toFixed(1)} мс · долгих ${stats.slowFrames}/120\nGPU p95 ${gpu.p95Ms?.toFixed(1) ?? '—'} / max ${gpu.maxMs?.toFixed(1) ?? '—'} мс · очередь ${gpu.pending}\nМышь: ${mouseInput === 'raw' ? 'raw input' : 'обычный ввод'}\nGPU: ${space.renderer.info.memory.geometries} геометрий / ${space.renderer.info.memory.textures} текстур\n${space.drawCalls} draw calls · пул ${space.targets.length}/${space.maxPasses - 1}\nПорталы: ${(space.portalPixels / 1e6).toFixed(2)} Мпикс / кадр\nПереходов ${game.transitions} · история ${game.history.length}/256\n\n${game.world.balls.map(b => `${b.id}: ${b.socket ? b.socket.room + b.socket.side : 'инвентарь'}`).join('\n')}\n\n${connections(game.world).map(c => `${c.color}: ${c.ends.map(e => e.room + e.side).join(' ↔ ')}`).join('\n')}`;
    }
  }
}
try {
  space = new SpaceRenderer(canvas, game);
  surfaceTextures = new SurfaceTextures(Object.values(space.rooms).map(room => room.scene), space.assets.textures);
  updateHUD(); requestAnimationFrame(frame);
  const playButton = $<HTMLButtonElement>('play-button'), playLabel = playButton.querySelector('span')!;
  playButton.disabled = true; playLabel.textContent = 'Подготовка пространства…';
  void Promise.all([space.ready, sound.ready]).then(() => { playButton.disabled = false; playLabel.textContent = 'Войти в пространство'; }).catch(error => {
    console.error(error); $('error').hidden = false; $('error').textContent = 'Не удалось подготовить игру. Обновите страницу.';
  });
  // Development-only inspection surface for reproducible browser acceptance checks.
  if (import.meta.env.DEV) Object.assign(window, { __samewhere: { game, space, sound, sync, reset, undo, pause, timing, mouseLook, mouseEvent, get fps() { return fps; }, get mouseInput() { return mouseInput; } } });
} catch (error) {
  console.error(error); $('error').hidden = false;
  $('error').textContent = 'Не удалось запустить 3D. Нужен настольный браузер с WebGL 2 и аппаратным ускорением.';
  $<HTMLButtonElement>('play-button').disabled = true;
}
window.addEventListener('pagehide', event => { if (event.persisted) { pause(); return; } disposed = true; space?.dispose(); sound.dispose(); });
