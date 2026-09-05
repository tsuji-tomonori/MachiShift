import { expect, test, type Page, type TestInfo } from '@playwright/test';

type Vec3 = [number, number, number];
interface Mark { eventId: number; color: number; localPoint: Vec3; worldPoint: Vec3; vertices: number }
interface Piece {
  id: string; objectId: string; broken: boolean; dynamic: boolean; retired: boolean;
  position: Vec3; bodyHandle: number | null; colliderHandle: number | null; paints: Mark[];
}
interface State {
  phase: string; sampledAtMilliseconds: number; elapsed: number; routeDistance: number;
  inventory: string[]; selectedItem: string | null; aimPoint: Vec3 | null; aimObjectId: string | null;
  thrownCount: number; paintHits: number; bombHits: number; paintEvents: number;
  destroyed: number; dynamicDebris: number; autoDrive: boolean; shortcut: Piece[];
  vehicles: Array<{ id: number; lap: number; checkpoint: number; speed: number; heading: number; position: { x: number; y: number; z: number } }>;
}
async function state(page: Page): Promise<State> {
  const raw = await page.locator('#diagnostics').textContent();
  if (!raw) throw new Error('Visible actual-state diagnostics are empty');
  return JSON.parse(raw) as State;
}
async function record(page: Page, info: TestInfo, name: string): Promise<State> {
  const actual = await state(page);
  await info.attach(name, { body: JSON.stringify(actual, null, 2), contentType: 'application/json' });
  return actual;
}
const distance = (a: Vec3, b: Vec3) => Math.hypot(...a.map((v, i) => v - b[i]));
function gateCenter(pieces: Piece[]): Vec3 {
  return [0, 1, 2].map(axis => pieces.reduce((sum, piece) => sum + piece.position[axis], 0) / pieces.length) as Vec3;
}
function gateRange(s: State, center: Vec3): number {
  const p = s.vehicles[0].position;
  return Math.hypot(center[0] - p.x, center[2] - p.z);
}
async function brake(page: Page): Promise<void> {
  await page.keyboard.down('KeyS');
  try { await expect.poll(async () => Math.abs((await state(page)).vehicles[0].speed), { timeout: 30_000, intervals: [100, 200] }).toBeLessThan(0.4); }
  finally { await page.keyboard.up('KeyS'); }
}
async function aimAndThrow(page: Page, center: Vec3, item: string): Promise<void> {
  if ((await state(page)).selectedItem !== item) await page.keyboard.press('KeyE');
  await expect.poll(async () => (await state(page)).selectedItem).toBe(item);
  const before = await state(page), vehicle = before.vehicles[0];
  const heading = Math.atan2(center[0] - vehicle.position.x, center[2] - vehicle.position.z);
  const offset = Math.atan2(Math.sin(heading - vehicle.heading), Math.cos(heading - vehicle.heading));
  expect(Math.abs(offset), 'Gate must be reachable with the ordinary ±0.65 rad aim control').toBeLessThan(0.65);
  await page.mouse.move(640 * (1 - offset / 0.65), 360);
  await page.keyboard.down('Space');
  try {
    await expect(page.locator('.aim-text')).toContainText('離して投げる');
    await expect.poll(async () => (await state(page)).aimObjectId, { timeout: 20_000 }).toBe('game:shortcut-gate');
  } finally { await page.keyboard.up('Space'); }
  await expect.poll(async () => (await state(page)).thrownCount).toBe(before.thrownCount + 1);
}

test('AT-04/07/11 real stage: collect, paint fence, bomb, moving painted debris, drive through, return next lap, reset', async ({ page }, info) => {
  test.setTimeout(15 * 60_000);
  const uncaught: string[] = [];
  page.on('pageerror', error => uncaught.push(error.message));
  try {
    const response = await page.request.get('/data/stage.json');
    expect(response.ok()).toBe(true);
    const stage = await response.json();
    expect(stage.metadata.source).toMatch(/PLATEAU|CityGML/);
    await info.attach('core-scope', { body: JSON.stringify({
      commit: process.env.GITHUB_SHA ?? 'working-tree', executedAt: new Date().toISOString(),
      source: stage.metadata, environment: 'Chromium / SwiftShader / low graphics 640x360 scene',
      method: 'Real production stage, ordinary free mode, UI auto-drive and keyboard/pointer controls; visible diagnostics read only. No position, inventory, lap or environment-state injection.',
      limitation: 'The fence is explicitly game_added. This establishes integrated functional behavior, not surveyed fidelity, human evaluation or target-GPU performance.',
    }, null, 2), contentType: 'application/json' });
    await page.goto('/?qa=1');
    await expect(page.getByRole('button', { name: 'レースを始める', exact: false })).toBeVisible({ timeout: 150_000 });
    await page.getByRole('button', { name: '描画を軽量にする', exact: true }).click();
    await page.getByRole('button', { name: '自由走行', exact: true }).click();
    await page.locator('#qa summary').click();
    await expect.poll(async () => (await state(page)).phase).toBe('free');
    const initial = await record(page, info, 'core-initial');
    expect(initial.inventory).toHaveLength(0);
    expect(initial.shortcut.length).toBeGreaterThan(0);
    expect(initial.shortcut.every(p => !p.broken && p.colliderHandle !== null && p.paints.length === 0)).toBe(true);
    const center = gateCenter(initial.shortcut);

    // Both pickups are reached by the same ordinary controller used by AI cars.
    // The first bomb is before the gate so a player can stop and aim at it.
    await page.getByRole('button', { name: '自動走行を開始', exact: true }).click();
    await expect.poll(async () => (await state(page)).inventory, { timeout: 120_000, intervals: [100, 200] }).toEqual(['paint', 'bomb']);
    await page.getByRole('button', { name: '自動走行を停止', exact: true }).click();
    await brake(page);
    // Approach at normal acceleration if braking after the pickup left the
    // fence beyond the stationary projectile arc. No teleport or recovery.
    if (gateRange(await state(page), center) > 27) {
      await page.keyboard.down('KeyW');
      try { await expect.poll(async () => gateRange(await state(page), center), { timeout: 30_000, intervals: [100, 200] }).toBeLessThanOrEqual(27); }
      finally { await page.keyboard.up('KeyW'); }
      await brake(page);
    }
    const ready = await record(page, info, 'core-picked-up-and-stopped');
    expect(ready.inventory).toEqual(['paint', 'bomb']);
    expect(ready.routeDistance).toBeGreaterThan(70);
    expect(ready.routeDistance).toBeLessThan(105);
    expect(gateRange(ready, center)).toBeGreaterThan(16);
    expect(gateRange(ready, center)).toBeLessThanOrEqual(28);

    await aimAndThrow(page, center, 'paint');
    await expect.poll(async () => (await state(page)).shortcut.reduce((n, p) => n + p.paints.length, 0), { timeout: 40_000 }).toBeGreaterThan(0);
    const painted = await record(page, info, 'core-painted-fence');
    expect(painted.paintHits).toBe(1);
    expect(painted.shortcut.every(p => !p.broken)).toBe(true);
    const paintedPieces = painted.shortcut.filter(p => p.paints.length > 0);
    expect(paintedPieces.every(p => p.paints.every(mark => mark.color === 0x168aff && mark.vertices > 0))).toBe(true);
    await page.screenshot({ path: info.outputPath('core-painted-fence.png') });

    await aimAndThrow(page, center, 'bomb');
    await expect.poll(async () => (await state(page)).shortcut.filter(p => p.broken).length, { timeout: 40_000 }).toBe(initial.shortcut.length);
    await expect.poll(async () => {
      const current = await state(page);
      return paintedPieces.some(before => {
        const after = current.shortcut.find(p => p.id === before.id);
        return after?.broken && after.paints.some(mark => before.paints.some(original =>
          mark.eventId === original.eventId && mark.color === original.color &&
          distance(mark.localPoint, original.localPoint) < 0.00001 && distance(mark.worldPoint, original.worldPoint) > 0.1));
      });
    }, { timeout: 30_000, intervals: [100, 200] }).toBe(true);
    const broken = await record(page, info, 'core-painted-fragments-moved');
    expect(broken.bombHits).toBe(1);
    expect(broken.thrownCount).toBe(2);
    expect(broken.shortcut.every(p => p.broken)).toBe(true);
    for (const original of paintedPieces) {
      const fragment = broken.shortcut.find(p => p.id === original.id)!;
      expect(fragment.paints.map(p => ({ id: p.eventId, local: p.localPoint, color: p.color })))
        .toEqual(original.paints.map(p => ({ id: p.eventId, local: p.localPoint, color: p.color })));
    }
    await page.screenshot({ path: info.outputPath('core-painted-fragments.png') });

    // Crossing is measured in the original gate's local plane. Merely driving
    // around its end cannot pass this assertion. Observe both sides and the
    // interpolated crossing of the 7 m wide opening with cart-width margin.
    const route = stage.route as Vec3[];
    let travelled = 0, tangent: Vec3 = [0, 0, 1];
    for (let i = 0; i < route.length; i++) {
      const a = route[i], b = route[(i + 1) % route.length], length = distance(a, b);
      if (travelled + length >= 115) { const flat = Math.hypot(b[0] - a[0], b[2] - a[2]); tangent = [(b[0] - a[0]) / flat, 0, (b[2] - a[2]) / flat]; break; }
      travelled += length;
    }
    const gateCoordinates = (s: State) => {
      const p = s.vehicles[0].position, x = p.x - center[0], z = p.z - center[2];
      return { forward: x * tangent[0] + z * tangent[2], side: x * tangent[2] - z * tangent[0], y: p.y };
    };
    let previous = gateCoordinates(broken);
    expect(previous.forward).toBeLessThan(-2);
    let crossing: { before: typeof previous; after: typeof previous; side: number } | undefined;
    await page.getByRole('button', { name: '自動走行を開始', exact: true }).click();
    await expect.poll(async () => {
      const current = gateCoordinates(await state(page));
      if (!crossing && previous.forward <= 0 && current.forward > 0) {
        const ratio = -previous.forward / (current.forward - previous.forward);
        crossing = { before: previous, after: current, side: previous.side + ratio * (current.side - previous.side) };
      }
      previous = current;
      return Boolean(crossing && current.forward > 3);
    }, { timeout: 120_000, intervals: [100, 200] }).toBe(true);
    expect(Math.abs(crossing!.side)).toBeLessThan(2.75);
    expect(Math.abs(crossing!.after.y - center[1])).toBeLessThan(1.5);
    await info.attach('core-original-gate-crossing', { body: JSON.stringify(crossing, null, 2), contentType: 'application/json' });
    await record(page, info, 'core-driven-through-original-fence');

    await expect.poll(async () => {
      const current = await state(page);
      return current.vehicles[0].lap >= 2 && current.routeDistance >= 115 && current.routeDistance < 200;
    }, { timeout: 8 * 60_000, intervals: [250, 500] }).toBe(true);
    await page.getByRole('button', { name: '自動走行を停止', exact: true }).click();
    await brake(page);
    const returned = await record(page, info, 'core-returned-next-lap');
    expect(returned.shortcut.every(p => p.broken && p.colliderHandle === null)).toBe(true);
    for (const original of paintedPieces) {
      const retained = returned.shortcut.find(p => p.id === original.id)!;
      expect(retained.paints.map(p => ({ id: p.eventId, local: p.localPoint, color: p.color })))
        .toEqual(original.paints.map(p => ({ id: p.eventId, local: p.localPoint, color: p.color })));
    }
    await page.screenshot({ path: info.outputPath('core-next-lap-state.png') });
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: 'タイトルへ', exact: true }).click();
    await page.getByRole('button', { name: '自由走行', exact: true }).click();
    await page.locator('#qa summary').click();
    await expect.poll(async () => (await state(page)).phase).toBe('free');
    const reset = await record(page, info, 'core-new-session-reset');
    expect(reset.paintEvents).toBe(0);
    expect(reset.destroyed).toBe(0);
    expect(reset.dynamicDebris).toBe(0);
    expect(reset.thrownCount).toBe(0);
    expect(reset.inventory).toHaveLength(0);
    expect(reset.vehicles[0].lap).toBe(1);
    expect(reset.shortcut.every(p => !p.broken && p.colliderHandle !== null && p.paints.length === 0)).toBe(true);
    expect(reset.shortcut.map(p => p.position)).toEqual(initial.shortcut.map(p => p.position));
    expect(uncaught).toEqual([]);
  } finally {
    for (const key of ['KeyW', 'KeyS', 'Space']) await page.keyboard.up(key).catch(() => {});
    if (await page.locator('#diagnostics').count()) await record(page, info, 'core-final-or-failure-state');
  }
});
