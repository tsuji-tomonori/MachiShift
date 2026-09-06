import { expect, test, type Page, type TestInfo } from '@playwright/test';

interface Diagnostics {
  phase: string;
  tutorialStep: number;
  sampledAtMilliseconds: number;
  renderQuality: string;
  renderResolution: number[];
  elapsed: number;
  courseMeters: number;
  inventory: string[];
  thrownCount: number;
  paintHits: number;
  bombHits: number;
  paintEvents: number;
  destroyed: number;
  dynamicDebris: number;
  gripZones: number;
  recoveries: number;
  autoDrive: boolean;
  vehicles: Array<{ id: number; lap: number; rank: number; checkpoint: number; finished: boolean; speed: number; heading: number; driftCharge: number; boost: number; position: { x: number; y: number; z: number } }>;
}

async function readDiagnostics(page: Page): Promise<Diagnostics> {
  // Read the visible QA panel, which derives from actual physics/render state.
  // Never write position, checkpoints, lap counts or hidden game variables.
  const raw = await page.locator('#diagnostics').textContent();
  if (!raw) throw new Error('The actual-state diagnostics panel is empty');
  return JSON.parse(raw) as Diagnostics;
}

async function attachJSON(testInfo: TestInfo, name: string, value: unknown): Promise<void> {
  await testInfo.attach(name, { body: JSON.stringify(value, null, 2), contentType: 'application/json' });
}

test.afterEach(async ({ page }, testInfo) => {
  if (testInfo.status !== testInfo.expectedStatus && await page.locator('#diagnostics').count()) {
    const raw = await page.locator('#diagnostics').textContent();
    await testInfo.attach('actual-state-on-failure', { body: raw ?? 'Diagnostics not populated', contentType: 'text/plain' });
  }
});

async function openStage(page: Page, testInfo: TestInfo): Promise<void> {
  const stageResponse = await page.request.get('/data/stage.json');
  expect(stageResponse.ok()).toBe(true);
  const stage = await stageResponse.json();
  expect(stage.metadata.source).toMatch(/PLATEAU|岐阜|CityGML/i);
  expect(stage.chunks.length).toBeGreaterThan(0);
  expect(stage.route.length).toBeGreaterThan(3);
  await attachJSON(testInfo, 'source-stage', {
    commit: process.env.GITHUB_SHA ?? 'working-tree',
    executedAt: new Date().toISOString(),
    environment: 'Playwright Chromium / 1280x720 UI / SwiftShader; title and retry use high graphics, driving selects low graphics (640x360 scene, no shadows)',
    scope: 'Automated functional play on bundled real CityGML-derived stage. Not independent survey, human evaluation or AT-12.',
    metadata: stage.metadata,
    chunks: stage.chunks.map((chunk: { id: string; sha256: string }) => ({ id: chunk.id, sha256: chunk.sha256 })),
  });
  await page.goto('/?qa=1');
  await expect(page.getByRole('button', { name: 'レースを始める', exact: false })).toBeVisible({ timeout: 150_000 });
}

test('real stage: controls, keyboard driving, real throw, tutorial, 6-car 3-lap race, results and reset', async ({ page }, testInfo) => {
  test.setTimeout(14 * 60_000);
  const uncaught: string[] = [];
  page.on('pageerror', error => uncaught.push(error.message));
  await openStage(page, testInfo);
  await page.screenshot({ path: testInfo.outputPath('real-stage-title.png') });
  await page.getByRole('button', { name: '出典・再現範囲', exact: true }).click();
  await expect(page.locator('#source-dates')).toContainText('2024年度');
  await expect(page.locator('#source-dates')).toContainText('不明');
  await expect(page.locator('#source-dates')).toContainText('未実施');
  await attachJSON(testInfo, 'GEO-07-source-dates', { text: await page.locator('#source-dates').innerText() });
  await page.getByRole('button', { name: '戻る', exact: true }).click();
  // Use the same lightweight graphics setting available to a player. Geometry,
  // collisions, six vehicles and fixed physics ticks remain unchanged.
  await page.getByRole('button', { name: '描画を軽量にする', exact: true }).click();
  await expect(page.getByRole('button', { name: '描画を高品質にする', exact: true })).toBeVisible();

  await page.getByRole('button', { name: '操作方法', exact: true }).click();
  await expect(page.getByRole('heading', { name: '走る・狙う・街を変える' })).toBeVisible();
  await expect(page.getByRole('table')).toContainText('ゲームパッド');
  await page.getByRole('button', { name: '戻る', exact: true }).click();
  await page.getByRole('button', { name: '自由走行', exact: true }).click();
  await page.locator('#qa summary').click();
  await expect.poll(async () => (await readDiagnostics(page)).phase).toBe('free');
  const before = await readDiagnostics(page);
  expect(before.vehicles).toHaveLength(6);
  expect(before.renderQuality).toBe('low');
  expect(before.renderResolution).toEqual([640, 360]);
  expect(before.inventory).toHaveLength(0);
  expect(before.destroyed).toBe(0);

  // Genuine keyboard input crosses a pickup. We do not grant inventory in JS.
  await page.keyboard.down('KeyW');
  try {
    await expect.poll(async () => Math.abs((await readDiagnostics(page)).vehicles[0].speed), { timeout: 40_000 }).toBeGreaterThan(6);
    await expect.poll(async () => (await readDiagnostics(page)).inventory.length, { timeout: 40_000 }).toBeGreaterThan(0);
    await page.keyboard.down('Shift');
    await page.keyboard.down('KeyA');
    const headingBeforeDrift = (await readDiagnostics(page)).vehicles[0].heading;
    await expect.poll(async () => (await readDiagnostics(page)).vehicles[0].driftCharge, { timeout: 20_000, intervals: [100, 200, 250] }).toBeGreaterThanOrEqual(0.26);
    const charged = await readDiagnostics(page);
    const turn = charged.vehicles[0].heading - headingBeforeDrift;
    expect(Math.abs(Math.atan2(Math.sin(turn), Math.cos(turn)))).toBeGreaterThan(0.1);
    await page.keyboard.up('KeyA');
    await page.keyboard.up('Shift');
    await expect.poll(async () => (await readDiagnostics(page)).vehicles[0].boost, { timeout: 10_000, intervals: [100, 200, 250] }).toBeGreaterThan(0);
    await attachJSON(testInfo, 'keyboard-drift-boost', { charged, released: await readDiagnostics(page) });
  } finally {
    await page.keyboard.up('KeyW');
    await page.keyboard.up('KeyA');
    await page.keyboard.up('Shift');
  }
  const driven = await readDiagnostics(page);
  expect(Math.hypot(driven.vehicles[0].position.x - before.vehicles[0].position.x, driven.vehicles[0].position.z - before.vehicles[0].position.z)).toBeGreaterThan(10);
  await page.keyboard.down('KeyS');
  try {
    await expect.poll(async () => Math.abs((await readDiagnostics(page)).vehicles[0].speed), { timeout: 20_000 }).toBeLessThan(1);
  } finally { await page.keyboard.up('KeyS'); }
  const beforeRecovery = await readDiagnostics(page);
  await page.keyboard.press('KeyR');
  await expect.poll(async () => (await readDiagnostics(page)).recoveries, { timeout: 10_000 }).toBeGreaterThan(beforeRecovery.recoveries);
  const recovered = await readDiagnostics(page);
  expect(recovered.vehicles[0].checkpoint).toBe(beforeRecovery.vehicles[0].checkpoint);
  expect(recovered.vehicles[0].lap).toBe(beforeRecovery.vehicles[0].lap);
  await attachJSON(testInfo, 'manual-recovery', { before: beforeRecovery, after: recovered });

  // Aim from the ordinary recovery position after stopping. A moving post-drift
  // throw can legitimately miss; the hit assertion needs a repeatable road aim.
  await page.mouse.move(640, 360);
  await page.keyboard.down('Space');
  await expect(page.locator('.aim-text')).toContainText('離して投げる');
  await page.keyboard.up('Space');
  await expect.poll(async () => (await readDiagnostics(page)).thrownCount).toBe(1);
  await expect.poll(async () => {
    const state = await readDiagnostics(page);
    return state.paintHits + state.bombHits;
  }, { timeout: 40_000 }).toBeGreaterThan(0);
  await attachJSON(testInfo, 'keyboard-drive-and-throw', await readDiagnostics(page));

  await page.keyboard.press('Escape');
  await expect(page.getByRole('heading', { name: 'ひと休み' })).toBeVisible();
  await expect.poll(async () => (await readDiagnostics(page)).phase).toBe('paused');
  const paused = await readDiagnostics(page);
  // Require a fresh observation; a frozen HUD must not prove frozen physics.
  await expect.poll(async () => (await readDiagnostics(page)).sampledAtMilliseconds).toBeGreaterThan(paused.sampledAtMilliseconds + 400);
  const stillPaused = await readDiagnostics(page);
  expect(stillPaused.elapsed).toBe(paused.elapsed);
  expect(stillPaused.vehicles).toEqual(paused.vehicles);
  await attachJSON(testInfo, 'paused-physical-state', { paused, stillPaused });
  await page.getByRole('button', { name: 'タイトルへ', exact: true }).click();
  await page.getByRole('button', { name: '操作を練習する', exact: true }).click();
  await expect(page.getByRole('heading', { name: '1. 走り出そう' })).toBeVisible();
  await page.locator('#qa summary').click();
  const lessons: Diagnostics[] = [await readDiagnostics(page)];
  await page.keyboard.down('KeyW');
  try {
    await expect.poll(async () => (await readDiagnostics(page)).tutorialStep).toBe(1);
    lessons.push(await readDiagnostics(page));
    await page.keyboard.down('KeyA');
    await expect.poll(async () => (await readDiagnostics(page)).tutorialStep).toBe(2);
    lessons.push(await readDiagnostics(page));
    await page.keyboard.down('Shift');
    await expect.poll(async () => (await readDiagnostics(page)).vehicles[0].driftCharge).toBeGreaterThan(.3);
    await page.keyboard.up('Shift'); await page.keyboard.up('KeyA');
    await expect.poll(async () => (await readDiagnostics(page)).tutorialStep).toBe(3);
    lessons.push(await readDiagnostics(page));
  } finally { await page.keyboard.up('KeyW'); await page.keyboard.up('KeyA'); await page.keyboard.up('Shift'); }
  await page.keyboard.down('Space');
  await expect.poll(async () => (await readDiagnostics(page)).tutorialStep).toBe(4);
  lessons.push(await readDiagnostics(page));
  await page.keyboard.up('Space');
  await expect.poll(async () => (await readDiagnostics(page)).tutorialStep).toBe(5);
  lessons.push(await readDiagnostics(page));
  await page.keyboard.press('KeyR');
  await expect.poll(async () => (await readDiagnostics(page)).phase, { timeout: 30_000 }).toBe('race');
  expect(lessons.map(lesson=>lesson.tutorialStep)).toEqual([0,1,2,3,4,5]);
  await attachJSON(testInfo, 'GAME-09-six-lessons', {lessons, completed: await readDiagnostics(page)});
  // A completed first experience is remembered; explicit replay still works.
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'タイトルへ', exact: true }).click();
  await page.getByRole('button', { name: 'レースを始める', exact: false }).click();
  await expect.poll(async () => (await readDiagnostics(page)).phase).toBe('race');
  await expect(page.locator('#lesson')).toBeEmpty();
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'タイトルへ', exact: true }).click();
  await page.getByRole('button', { name: '操作を練習する', exact: true }).click();
  await expect(page.getByRole('heading', { name: '1. 走り出そう' })).toBeVisible();
  await page.getByRole('button', { name: '練習をスキップしてレースへ', exact: true }).click();
  await page.locator('#qa summary').click();
  await expect.poll(async () => (await readDiagnostics(page)).phase, { timeout: 30_000 }).toBe('race');
  const reset = await readDiagnostics(page);
  expect(reset.vehicles.every(vehicle => vehicle.lap === 1 && !vehicle.finished)).toBe(true);
  expect(reset.paintEvents).toBe(0);
  expect(reset.destroyed).toBe(0);
  expect(reset.dynamicDebris).toBe(0);
  expect(reset.gripZones).toBe(0);
  expect(reset.thrownCount).toBe(0);

  // The visible panel enables the ordinary AI controller for the player.
  // All six vehicles still use dynamic bodies, real roads and ordered gates.
  await page.getByRole('button', { name: '自動走行を開始', exact: true }).click();
  await expect.poll(async () => (await readDiagnostics(page)).autoDrive).toBe(true);
  await attachJSON(testInfo, 'race-start', await readDiagnostics(page));
  await expect(page.getByRole('heading', { name: '街に、足跡を残した。' })).toBeVisible({ timeout: 10 * 60_000 });
  await expect(page.locator('.result-row')).toHaveCount(6);
  await expect(page.locator('.dialog')).toContainText('3周の記録');
  // AI hits must not be credited to the player, who only auto-drives this race.
  await expect(page.locator('.dialog')).toContainText('自分のペイント命中 0 / 投擲 0');
  await expect(page.locator('.result-row').filter({ hasText: '走行中' })).toHaveCount(0, { timeout: 120_000 });
  await attachJSON(testInfo, 'race-result-text', { text: await page.locator('.dialog').innerText(), uncaught });
  await page.screenshot({ path: testInfo.outputPath('three-lap-results.png') });

  await page.getByRole('button', { name: 'もう一度走る', exact: false }).click();
  await page.locator('#qa summary').click();
  await expect.poll(async () => (await readDiagnostics(page)).phase, { timeout: 30_000 }).toBe('race');
  const again = await readDiagnostics(page);
  expect(again.vehicles.every(vehicle => vehicle.lap === 1 && !vehicle.finished)).toBe(true);
  expect(again.paintEvents).toBe(0);
  expect(again.destroyed).toBe(0);
  expect(again.dynamicDebris).toBe(0);
  expect(again.thrownCount).toBe(0);
  expect(again.autoDrive).toBe(false);
  await attachJSON(testInfo, 'rerace-reset', again);
  await page.screenshot({ path: testInfo.outputPath('rerace-reset.png') });
  expect(uncaught).toEqual([]);
});

test('real chunk network failure displays retry and reload recovers', async ({ page }, testInfo) => {
  let failedOnce = false;
  await page.route('**/data/*.json.gz', async route => {
    if (!failedOnce) { failedOnce = true; await route.abort('failed'); }
    else await route.continue();
  });
  await page.goto('/?qa=1');
  await expect(page.getByRole('heading', { name: '街を読み込めませんでした' })).toBeVisible({ timeout: 60_000 });
  expect(failedOnce).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('chunk-failure.png') });
  await page.getByRole('button', { name: '再試行', exact: false }).click();
  await expect(page.getByRole('button', { name: 'レースを始める', exact: false })).toBeVisible({ timeout: 120_000 });
  await page.screenshot({ path: testInfo.outputPath('chunk-retry-success.png') });
  await attachJSON(testInfo, 'network-recovery', {
    executedAt: new Date().toISOString(),
    commit: process.env.GITHUB_SHA ?? 'working-tree',
    result: 'PASS',
    method: 'Abort exactly one original compressed chunk request, then serve the unchanged real stage on retry.',
    scope: 'Network error/retry UI only, not geographic accuracy or performance acceptance.',
  });
});
