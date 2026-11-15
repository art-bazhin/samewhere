import { test, expect } from '@playwright/test';

async function capture(page: import('@playwright/test').Page) {
  await page.evaluate(() => {
    const app = window.__samewhere; app.analyticsEvents = [];
    app.analytics.send = (event: string, value: number) => app.analyticsEvents.push({ event, value });
  });
}

test('milestones survive reload and exclude the pause menu; drawings have separate first visits', async ({ page }) => {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto('/'); await expect(page.locator('#loading-screen')).toBeHidden(); await capture(page);
  await page.locator('#play-button').click(); await expect(page.locator('#overlay')).toBeHidden();
  await page.waitForTimeout(200);
  await page.evaluate(() => {
    const { game, sync, mouseLook } = window.__samewhere;
    game.interact({ room: 'B', side: 2 }); game.interact({ room: 'A', side: 0 });
    Object.assign(game.player, { x: 0, z: -4.7, yaw: 0, pitch: 0 }); mouseLook.reset(); sync();
  });
  await page.keyboard.down('KeyW');
  await page.waitForFunction(() => window.__samewhere.game.player.room === 'B'); await page.keyboard.up('KeyW');
  await page.evaluate(() => { window.__samewhere.sync(); window.__samewhere.sync(); });
  expect(await page.evaluate(() => window.__samewhere.analyticsEvents.filter(({ event }: any) => event.endsWith(':room_5_visited')))).toHaveLength(1);
  await page.keyboard.press('Escape'); await expect(page.locator('#overlay')).toBeVisible();
  const paused = await page.evaluate(() => window.__samewhere.analytics.snapshot());
  await page.waitForTimeout(300);
  expect(await page.evaluate(() => window.__samewhere.analytics.snapshot())).toEqual(paused);
  await page.reload(); await expect(page.locator('#loading-screen')).toBeHidden(); await capture(page);
  expect(await page.evaluate(() => window.__samewhere.analytics.snapshot())).toEqual(paused);
  await page.locator('#resume-button').click(); await expect(page.locator('#overlay')).toBeHidden();
  expect(await page.evaluate(() => window.__samewhere.analyticsEvents.find(({ event }: any) => event.endsWith(':run_resumed')).value))
    .toBe(Math.round(paused.activeMs) / 1000);
  await page.evaluate(() => { const { game, sync } = window.__samewhere; game.world.passageProgress = 1; sync(); sync(); });
  const events = await page.evaluate(() => window.__samewhere.analyticsEvents);
  expect(events.filter(({ event }: any) => event.endsWith(':room_5_visited'))).toHaveLength(0);
  expect(events.filter(({ event }: any) => event.endsWith(':symbol_connection_5_opened'))).toHaveLength(1);
  expect(events.filter(({ event }: any) => event.endsWith(':symbol_room_5_visited'))).toHaveLength(1);
  expect(events.every(({ event }: any) => /^v1:[^:]+$/.test(event))).toBe(true);
  expect(errors).toEqual([]);
});

test('the real SDK sends gameplay milestones at the correct stage after its session is ready', async ({ page }) => {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  const received: any[] = [];
  let initialized = false, release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  await page.route('https://api.gameanalytics.com/**', async route => {
    const request = route.request();
    const headers = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': 'POST, OPTIONS' };
    if (request.method() === 'OPTIONS') { await route.fulfill({ status: 204, headers }); return; }
    if (request.url().includes('/init?')) {
      initialized = true; await gate;
      await route.fulfill({ status: 201, headers, json: { enabled: true, server_ts: Math.floor(Date.now() / 1000), configs: [], configs_hash: 'test' } });
    } else {
      received.push(...JSON.parse(request.postData()!));
      await route.fulfill({ status: 200, headers, json: {} });
    }
  });
  await page.goto('/'); await expect(page.locator('#loading-screen')).toBeHidden();
  await page.evaluate(async () => {
    const path = '/src/game-analytics.ts', { createGameAnalyticsSink } = await import(path);
    const app = window.__samewhere; app.analyticsEvents = [];
    const send = createGameAnalyticsSink({ enabled: true, gameKey: 'a'.repeat(32), secretKey: 'b'.repeat(40), build: 'browser-test' });
    app.analytics.send = (event: string, value: number) => { app.analyticsEvents.push({ event, value }); send(event, value); };
  });
  await page.locator('#play-button').click(); await expect(page.locator('#overlay')).toBeHidden();
  const result = await page.evaluate(async () => {
    const path = '/src/world.ts', { PASSAGE_GOALS, FINAL_PASSAGE_GOALS, portalPosition, wallNormal } = await import(path);
    const app = window.__samewhere, { game, sync } = app;
    const roomLabels: Record<string, string> = { A: '4', B: '5', C: '6', D: '3', E: 'Y', F: 'X', G: 'H' };
    const count = (milestone: string) => app.analyticsEvents.filter(({ event }: any) => event === `v1:${milestone}`).length;
    function collect() { for (const ball of game.world.balls) if (ball.socket) { game.interact(ball.socket); sync(); } }
    function place(color: string, room: string, side: number) {
      game.selectColor(color);
      if (game.interact({ room, side }) !== 'place') throw new Error(`Could not place ${color} at ${room}${side}`);
      sync();
    }
    // The exact final arrangement at the beginning must not complete the puzzle.
    collect();
    for (const goal of FINAL_PASSAGE_GOALS) place(goal.color, 'A', goal.from.side);
    const early = { progress: game.world.passageProgress, collectionEvents: count('all_balls_in_4'),
      completionEvents: count('room_4_pattern_completed'), gallery: game.world.gallery };
    const goals: { progress: number; opened: number; beforeVisit: number; afterVisit: number; collectionEvents: number }[] = [];
    for (const [index, goal] of PASSAGE_GOALS.entries()) {
      game.player.room = 'G'; sync(); collect();
      place(goal.color, goal.from.room, goal.from.side); place(goal.color, goal.to, 0);
      const beforeVisit = count(`symbol_room_${roomLabels[goal.to]}_visited`);
      game.player.room = goal.to; sync(); sync();
      const afterVisit = count(`symbol_room_${roomLabels[goal.to]}_visited`);
      // Experimentally gathering all four balls after either early goal is not the finale.
      if (index < PASSAGE_GOALS.length - 1) { game.player.room = 'A'; sync(); collect(); }
      goals.push({ progress: game.world.passageProgress, opened: count(`symbol_connection_${roomLabels[goal.to]}_opened`),
        beforeVisit, afterVisit, collectionEvents: count('all_balls_in_4') });
      if (game.world.passageProgress !== index + 1) throw new Error('The actual game rules did not advance the symbol chain');
    }
    // Even after the chain, swapping two colors must not send completion.
    collect();
    const finalCollection = count('all_balls_in_4');
    for (let side = 0; side < 4; side++) place(side < 2 ? 'red' : 'blue', 'A', side);
    const wrongColors = count('room_4_pattern_completed');
    game.interact({ room: 'A', side: 1 }); sync(); game.interact({ room: 'A', side: 2 }); sync();
    place('red', 'A', 2);
    const beforeLastBall = count('room_4_pattern_completed');
    place('blue', 'A', 1);
    const completedPattern = count('room_4_pattern_completed'), beforeExit = count('game_completed');
    // Removing and replacing a ball must not resend the completed milestone.
    game.interact({ room: 'A', side: 1 }); sync(); place('blue', 'A', 1);
    const repeatedPattern = count('room_4_pattern_completed');
    const gallery = game.world.gallery, last = gallery.signs.at(-1);
    const first = gallery.signs[0], firstP = portalPosition('A', first.side), firstN = wallNormal('A', first.side);
    Object.assign(game.player, { x: firstP.x - firstN.x * .1, z: firstP.z - firstN.z * .1 });
    game.move({ x: firstN.x * .2, z: firstN.z * .2 }); sync();
    const ordinaryDoor = { outside: gallery.outside, completionEvents: count('game_completed') };
    gallery.cell = { x: last.x, z: last.z };
    const p = portalPosition('A', last.side), n = wallNormal('A', last.side);
    Object.assign(game.player, { x: p.x - n.x * .1, z: p.z - n.z * .1 });
    game.move({ x: n.x * .05, z: n.z * .05 }); sync();
    const atThreshold = { outside: gallery.outside, completionEvents: count('game_completed') };
    game.move({ x: n.x * .1, z: n.z * .1 }); sync();
    return { early, goals, finalCollection, repeatedCollection: count('all_balls_in_4'), wrongColors, beforeLastBall, completedPattern, repeatedPattern, beforeExit, ordinaryDoor, atThreshold,
      outside: game.world.gallery.outside, exitEvents: count('game_completed'), expected: [...app.analyticsEvents] };
  });
  expect(result.early).toEqual({ progress: 0, collectionEvents: 0, completionEvents: 0, gallery: null });
  expect(result.goals).toEqual([1, 2, 3].map(progress => ({ progress, opened: 1, beforeVisit: 0, afterVisit: 1, collectionEvents: 0 })));
  expect(result.finalCollection).toBe(1); expect(result.repeatedCollection).toBe(1);
  expect(result.wrongColors).toBe(0); expect(result.beforeLastBall).toBe(0);
  expect(result.completedPattern).toBe(1); expect(result.repeatedPattern).toBe(1);
  expect(result.ordinaryDoor).toEqual({ outside: false, completionEvents: 0 });
  expect(result.atThreshold).toEqual({ outside: false, completionEvents: 0 });
  expect(result.beforeExit).toBe(0); expect(result.outside).toBe(true); expect(result.exitEvents).toBe(1);
  expect(result.expected.every(({ event }: any) => /^v1:[^:]+$/.test(event))).toBe(true);
  await expect.poll(() => initialized).toBe(true);
  expect(received).toEqual([]); release();
  await expect.poll(() => received.filter(event => event.category === 'design'), { timeout: 15_000 }).toHaveLength(result.expected.length);
  expect(received.filter(event => event.category === 'design').map(event => ({ event: event.event_id, value: event.value, build: event.build })))
    .toEqual(result.expected.map((event: any) => ({ ...event, build: 'browser-test' })));
  expect(errors).toEqual([]);
});

test('developer shortcuts do not record milestones or load the analytics SDK', async ({ page }) => {
  const requests: string[] = [];
  page.on('request', request => { if (/gameanalytics|GameAnalytics/.test(request.url()) && !request.url().includes('/src/game-analytics.ts')) requests.push(request.url()); });
  await page.goto('/?dev=1'); await expect(page.locator('#loading-screen')).toBeHidden(); await capture(page);
  await page.locator('#play-button').click(); await expect(page.locator('#overlay')).toBeHidden();
  await page.keyboard.press('Digit9');
  expect(await page.evaluate(() => window.__samewhere.analyticsEvents)).toEqual([]);
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('samewhere.save')!).analytics)).toBeUndefined();
  expect(requests).toEqual([]);
});
