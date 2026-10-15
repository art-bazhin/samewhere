import './style.css';
import { ballAt, connections, Game, inventoryCount, type Mode } from './world';
import { SpaceRenderer } from './scene';
import { Sound } from './audio';
import { FrameTiming } from './timing';
import { MouseLook } from './mouse-look';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const canvas = $<HTMLCanvasElement>('game');
const game = new Game();
const sound = new Sound();
const timing = new FrameTiming();
const mouseLook = new MouseLook();
const mouseEvent = 'onpointerrawupdate' in window ? 'pointerrawupdate' : 'mousemove';
const crosshair = $('crosshair'), interaction = $('interaction');
let interactionText = '';
let mouseInput: 'raw' | 'standard' = 'standard';
const MOVE_SPEED = 5;
let space: SpaceRenderer;
let locked = false, started = false, debug = false, disposed = false;
let fullscreenPending = false;
let sweep: { yaw: number; pitch: number; start: number } | null = null;
let chosenMode: Mode = 'explore';
let toastTimeout: ReturnType<typeof setTimeout>;
const keys = new Set<string>();
document.body.classList.add('paused');

function toast(message: string) {
  $('toast').textContent = message; $('toast').classList.add('visible');
  clearTimeout(toastTimeout); toastTimeout = setTimeout(() => $('toast').classList.remove('visible'), 2600);
}
function applyLook(delta: { x: number; y: number }) {
  game.player.yaw -= delta.x * 0.002;
  game.player.pitch = Math.max(-1.35, Math.min(1.35, game.player.pitch - delta.y * 0.002));
}
function updateHUD() {
  const world = game.world;
  $('room-name').textContent = game.player.room === 'A' ? 'Квадратная комната' : 'Пятиугольная комната';
  $('room-shape').className = `shape ${game.player.room === 'A' ? 'square' : 'pentagon'}`;
  $('mode-label').textContent = world.mode === 'explore' ? 'Исследование' : 'Перегородка';
  $('red-count').textContent = String(inventoryCount(world, 'red')); $('blue-count').textContent = String(inventoryCount(world, 'blue'));
  $('select-red').classList.toggle('selected', world.selected === 'red'); $('select-blue').classList.toggle('selected', world.selected === 'blue');
  $('select-red').setAttribute('aria-pressed', String(world.selected === 'red')); $('select-blue').setAttribute('aria-pressed', String(world.selected === 'blue'));
  $('objective').hidden = world.mode !== 'puzzle';
  $('objective').classList.toggle('solved', world.solved);
  $('objective-text').textContent = world.solved ? 'Вы нашли другую комнату и вернулись. Пространство подчиняется вам.' : 'Найдите путь в пятиугольную комнату и вернитесь.';
  $('visit-step').classList.toggle('done', world.visitedB); $('return-step').classList.toggle('done', world.solved);
}
function sync() { space.sync(); space.pick(); updateHUD(); }
function stopSweep() {
  if (!sweep) return;
  game.player.yaw = sweep.yaw; game.player.pitch = sweep.pitch; sweep = null;
}
function toggleSweep() {
  if (sweep) { stopSweep(); toast('Проверка плавности остановлена'); return; }
  keys.clear(); mouseLook.reset();
  sweep = { yaw: game.player.yaw, pitch: game.player.pitch, start: performance.now() };
  toast('Тест плавности: 6 секунд без мыши · F4 — остановить');
}
function reset(mode = game.world.mode) {
  stopSweep(); mouseLook.reset();
  game.reset(mode); chosenMode = mode; sync(); updateModeButtons(); toast(mode === 'explore' ? 'Исследование · начальное состояние' : 'Перегородка · найдите путь в другую комнату');
}
function updateModeButtons() {
  document.querySelectorAll<HTMLButtonElement>('[data-mode]').forEach(button => { button.classList.toggle('active', button.dataset.mode === chosenMode); button.setAttribute('aria-pressed', String(button.dataset.mode === chosenMode)); });
}
function undo() {
  stopSweep(); mouseLook.reset();
  if (game.undo()) { sync(); sound.play('undo'); toast('Последнее действие отменено'); }
  else toast('Пока нечего отменять');
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
    if (locked) toast(message);
    else { $('error').hidden = false; $('error').textContent = message; }
  } finally { fullscreenPending = false; }
}
async function play() {
  if (!space) return;
  if (game.world.mode !== chosenMode) reset(chosenMode);
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
$('menu-button').addEventListener('click', pause);
document.querySelectorAll<HTMLButtonElement>('[data-fullscreen]').forEach(button => button.addEventListener('click', () => void toggleFullscreen()));
document.addEventListener('fullscreenchange', updateFullscreenButtons);
updateFullscreenButtons();
$('help-button').addEventListener('click', () => { pause(); $<HTMLDetailsElement>('help').open = true; });
document.querySelectorAll<HTMLButtonElement>('[data-mode]').forEach(button => button.addEventListener('click', () => { chosenMode = button.dataset.mode as Mode; updateModeButtons(); }));
for (const color of ['red', 'blue'] as const) $(`select-${color}`).addEventListener('click', () => { game.world.selected = color; updateHUD(); });
document.addEventListener('pointerlockchange', () => {
  locked = document.pointerLockElement === canvas; keys.clear();
  mouseLook.reset();
  if (!locked) stopSweep();
  timing.reset();
  $('overlay').hidden = locked; document.body.classList.toggle('paused', !locked);
  if (locked && !started) { started = true; toast('Подойдите к пьедесталу. Посмотрите на шар и нажмите ЛКМ.'); }
  if (!locked && started) {
    $('play-button').firstElementChild!.textContent = 'Вернуться в пространство';
    $('menu-title').innerHTML = 'Вы всё ещё<br>в том же <em>месте.</em>';
    chosenMode = game.world.mode; updateModeButtons();
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
document.addEventListener('keydown', event => {
  if (event.code === 'KeyF') { event.preventDefault(); if (!event.repeat) void toggleFullscreen(); return; }
  if (event.code === 'F3') { event.preventDefault(); debug = !debug; $('debug').hidden = !debug; return; }
  if (event.code === 'F2') { event.preventDefault(); if (space) reset(game.world.mode === 'explore' ? 'puzzle' : 'explore'); return; }
  if (event.code === 'F4') { event.preventDefault(); if (locked && !event.repeat) toggleSweep(); return; }
  if (!locked) return;
  if (['KeyW','KeyA','KeyS','KeyD','ArrowUp','ArrowDown','ArrowLeft','ArrowRight','Space'].includes(event.code)) event.preventDefault();
  keys.add(event.code);
  if (event.repeat) return;
  if (event.code === 'Digit1' || event.code === 'Digit2') { game.world.selected = event.code === 'Digit1' ? 'red' : 'blue'; updateHUD(); }
  if (event.code === 'KeyZ') undo();
  if (event.code === 'KeyR') reset();
  if (event.code === 'KeyM') { sound.enabled = !sound.enabled; toast(sound.enabled ? 'Звук включён' : 'Звук выключен'); }
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
  const result = game.interact(socket);
  if (result) { sync(); sound.play(result); }
  else toast('В руках нет шара выбранного цвета · 1 / 2 — сменить цвет');
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
      if (elapsed >= 6000) { stopSweep(); toast('Тест завершён · обычное управление восстановлено'); }
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
      const oldTransitions = game.transitions, solved = game.world.solved;
      game.move({ x: (-Math.sin(yaw) * forward + Math.cos(yaw) * sideways) * speed, z: (-Math.cos(yaw) * forward - Math.sin(yaw) * sideways) * speed });
      if (game.transitions !== oldTransitions) { updateHUD(); sound.play('portal'); }
      if (!solved && game.world.solved) { sound.play('success'); toast('Маршрут найден. Вы вернулись.'); }
    }
    const socket = space.pick();
    const message = socket ? (ballAt(game.world, socket) ? 'ЛКМ · Забрать шар' : `ЛКМ · Положить ${game.world.selected === 'red' ? 'красный' : 'синий'} шар`) : '';
    if (message !== interactionText) {
      interactionText = message; crosshair.classList.toggle('available', !!socket); interaction.textContent = message;
    }
  }
  space.render(); timing.record(frameStart, performance.now() - frameStart);
  if (time - hudTime > 500) {
    const stats = timing.summary();
    const gpu = space.gpuTiming.summary();
    fps = Math.round(stats.fps); hudTime = time;
    $('fps-counter').textContent = `${fps} FPS`;
    $('frame-time').textContent = `${stats.meanMs.toFixed(1)} мс · пик ${stats.maxMs.toFixed(1)} · GPU ${gpu.p95Ms?.toFixed(1) ?? '—'}`;
    $('frame-time').title = `Интервал JS: p95 ${stats.p95Ms.toFixed(1)} / пик ${stats.maxMs.toFixed(1)} мс; CPU p95 ${stats.cpuP95Ms.toFixed(1)} мс; GPU p95 ${gpu.p95Ms?.toFixed(1) ?? 'недоступно'} / пик ${gpu.maxMs?.toFixed(1) ?? '—'} мс; долгих кадров ${stats.slowFrames}`;
    if (debug) {
      const p = game.player;
      $('debug').textContent = `SAMEWHERE / DEBUG\nКомната ${p.room} · ${game.world.mode}\nПозиция ${p.x.toFixed(2)}, ${p.z.toFixed(2)}\nYaw ${p.yaw.toFixed(2)} · Pitch ${p.pitch.toFixed(2)}\n${fps} FPS · ${space.passes}/24 проходов · depth 4\nКадр: p95 ${stats.p95Ms.toFixed(1)} / max ${stats.maxMs.toFixed(1)} мс\nCPU p95 ${stats.cpuP95Ms.toFixed(1)} мс · долгих ${stats.slowFrames}/120\nGPU p95 ${gpu.p95Ms?.toFixed(1) ?? '—'} / max ${gpu.maxMs?.toFixed(1) ?? '—'} мс · очередь ${gpu.pending}\nМышь: ${mouseInput === 'raw' ? 'raw input' : 'обычный ввод'}\nGPU: ${space.renderer.info.memory.geometries} геометрий / ${space.renderer.info.memory.textures} текстур\n${space.drawCalls} draw calls · пул ${space.targets.length}/23\nПорталы: ${(space.portalPixels / 1e6).toFixed(2)} Мпикс / кадр\nПереходов ${game.transitions} · история ${game.history.length}/256\n\n${game.world.balls.map(b => `${b.id}: ${b.socket ? b.socket.room + b.socket.side : 'инвентарь'}`).join('\n')}\n\n${connections(game.world).map(c => `${c.color}: ${c.ends.map(e => e.room + e.side).join(' ↔ ')}`).join('\n')}`;
    }
  }
}
try {
  space = new SpaceRenderer(canvas, game); updateHUD(); requestAnimationFrame(frame);
  const playButton = $<HTMLButtonElement>('play-button'), playLabel = playButton.querySelector('span')!;
  playButton.disabled = true; playLabel.textContent = 'Загрузка пространства…';
  void space.ready.then(() => { playButton.disabled = false; playLabel.textContent = 'Войти в пространство'; }).catch(error => {
    console.error(error); $('error').hidden = false; $('error').textContent = 'Не удалось загрузить материалы. Обновите страницу.';
  });
  // Development-only inspection surface for reproducible browser acceptance checks.
  if (import.meta.env.DEV) Object.assign(window, { __samewhere: { game, space, sync, reset, undo, pause, timing, mouseLook, mouseEvent, get fps() { return fps; }, get mouseInput() { return mouseInput; } } });
} catch (error) {
  console.error(error); $('error').hidden = false;
  $('error').textContent = 'Не удалось запустить 3D. Нужен настольный браузер с WebGL 2 и аппаратным ускорением.';
  $<HTMLButtonElement>('play-button').disabled = true;
}
window.addEventListener('pagehide', event => { if (event.persisted) { pause(); return; } disposed = true; space?.dispose(); void sound.context?.close(); });
