import { expect, test } from '@playwright/test';

test('PERF capture mechanism: real stage six cars, three blasts, 100 fragments and 200 paints', async ({ page }, info) => {
  test.setTimeout(8 * 60_000);
  await page.goto('/?qa=1');
  await expect(page.getByRole('button', { name: '描画を軽量にする', exact: true })).toBeVisible({timeout:150_000});
  await page.getByRole('button', { name: '描画を軽量にする', exact: true }).click();
  await page.getByRole('button', { name: '操作を練習する', exact: true }).click();
  await page.getByRole('button', { name: '練習をスキップしてレースへ', exact: true }).click();
  await page.locator('#qa summary').click();
  const read = async () => JSON.parse((await page.locator('#diagnostics').textContent())!);
  await expect.poll(async()=> (await read()).phase).toBe('race');
  await page.getByRole('button', { name: '指定負荷を実行', exact: true }).click();
  await expect.poll(async()=> (await read()).measurement?.addedPaintEvents).toBeGreaterThanOrEqual(200);
  const start = await read();
  expect(start.measurement.activeVehicleCount).toBe(6);
  expect(start.measurement.initialBlasts).toHaveLength(3);
  expect(start.measurement.initialBlasts.every((blast:{fragments:number})=>blast.fragments>0)).toBe(true);
  expect(start.measurement.initialBlasts.reduce((sum:number,blast:{fragments:number})=>sum+blast.fragments,0)).toBe(100);
  expect(start.measurement.startStats.dynamicDebris).toBe(100);
  expect(start.measurement.acceptance).toBe('REFERENCE_ONLY_UNTIL_TARGET_HARDWARE_CONFIRMED');
  await expect(page.locator('#hazards')).toContainText('半径');
  await expect(page.locator('#hazards')).toContainText('秒');
  await page.screenshot({path:info.outputPath('paint-hazard-patterns.png')});
  await info.attach('PERF-reference-start', {body:JSON.stringify(start,null,2), contentType:'application/json'});
  await expect.poll(async()=> (await read()).measurement?.completion, {timeout:5*60_000}).toBe('completed');
  const end = await read();
  expect(end.measurement.actualSimulationSeconds).toBeGreaterThanOrEqual(60);
  expect(end.frameMilliseconds.count).toBeGreaterThan(100);
  expect(end.frameMilliseconds.p99).toBeGreaterThanOrEqual(end.frameMilliseconds.p50);
  expect(end.memory).not.toBeNull();
  expect(end.paintEvents).toBeGreaterThanOrEqual(200);
  // Road effect expires independently of the persistent marks.
  expect(end.gripEffects).toHaveLength(0);
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: '計測を保存', exact: true }).click();
  await (await download).saveAs(info.outputPath('runtime-reference.json'));
  await info.attach('PERF-reference-end', {body:JSON.stringify(end,null,2), contentType:'application/json'});
});
