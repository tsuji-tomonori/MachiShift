import { beforeAll, describe, expect, it, vi } from 'vitest';
import RAPIER from '@dimforge/rapier3d-compat';
import { Scene, Vector3 } from 'three';
import { CourseProgress, NEUTRAL_INPUT, Race, Route, type DriveInput, type RoutePoint } from '../src/race';
import { Environment } from '../src/environment';

beforeAll(async () => { await RAPIER.init(); });
const DT = 1 / 60;
const square: RoutePoint[] = [[0, 0, 0], [0, 0, 40], [40, 0, 40], [40, 0, 0]];
const syntheticOval = (): RoutePoint[] => Array.from({ length: 24 }, (_, i) => {
  const t = 2 * Math.PI * i / 24;
  return [65 * (1 - Math.cos(t)), 0, 85 * Math.sin(t)];
});
function scene(route = syntheticOval()): { race: Race; world: RAPIER.World } {
  const world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
  world.timestep = DT;
  world.createCollider(RAPIER.ColliderDesc.cuboid(350, 0.5, 350).setTranslation(0, -0.5, 0).setFriction(0.15));
  const race = new Race(world, route);
  world.step();
  return { race, world };
}
function tick(race: Race, world: RAPIER.World, input: DriveInput = NEUTRAL_INPUT, enabled = true, grip = 1): void {
  race.update(DT, input, () => grip, enabled); world.step(); race.afterStep(DT);
}
function advanceAround(progress: CourseProgress, laps: number): void {
  // Logic fixture: feed samples every 0.5 metre. This does not claim physical play.
  for (let d = 0.5; d < progress.route.length * laps + 1; d += 0.5) progress.advance(progress.route.sample(d).position.add(new Vector3(0, 0.4, 0)), DT);
}

describe('course ordering and reset (GAME-03, GAME-08, GAME-10, AT-11)', () => {
  it('measures metre-scale closed path and accepts only three complete ordered laps', () => {
    const route = new Route(square);
    expect(route.length).toBe(160);
    const progress = new CourseProgress(route, new Vector3(0, 0.4, 0));
    advanceAround(progress, 3);
    expect(progress.completedLaps).toBe(3);
    expect(progress.acceptedGates).toBe(12);
    expect(progress.finished).toBe(true);
    progress.reset(new Vector3(0, 0.4, 0));
    expect([progress.completedLaps, progress.acceptedGates, progress.checkpoint]).toEqual([0, 0, 1]);
    expect(progress.finished).toBe(false);
  });

  it('rejects skipped gates, backward crossing, distant crossing and teleports', () => {
    const route = new Route(square);
    const progress = new CourseProgress(route, new Vector3(0, 0.4, 0));
    for (let i = 0; i < 1000; i++) progress.advance(route.sample(-i * 0.5).position.add(new Vector3(0, 0.4, 0)), DT);
    expect(progress.acceptedGates).toBe(0);
    progress.anchor(new Vector3(39.8, 0.4, 40));
    progress.advance(new Vector3(40.2, 0.4, 40), DT);
    expect(progress.checkpoint).toBe(1);
    progress.anchor(new Vector3(25, 0.4, 15));
    progress.advance(new Vector3(25.5, 0.4, 15.5), DT);
    expect(progress.checkpoint).toBe(1);
    progress.anchor(new Vector3(0, 0.4, 0));
    progress.advance(new Vector3(1, 0.4, 42), DT);
    expect(progress.rejectedTeleports).toBeGreaterThan(0);
    expect(progress.checkpoint).toBe(1);
  });

  it('recovery anchoring preserves passed gates and does not add lap progress', () => {
    const route = new Route(square), progress = new CourseProgress(route, new Vector3(0, 0.4, 0));
    for (let d = 0.5; d <= 41; d += 0.5) progress.advance(route.sample(d).position.add(new Vector3(0, 0.4, 0)), DT);
    expect(progress.checkpoint).toBe(2);
    const accepted = progress.acceptedGates;
    progress.anchor(route.sample(37).position.add(new Vector3(0, 0.4, 0)));
    expect(progress.acceptedGates).toBe(accepted);
    expect(progress.completedLaps).toBe(0);
    expect(progress.checkpoint).toBe(2);
  });
});

describe('actual Rapier vehicle integration (GAME-04, GAME-06, GAME-10, AT-06, AT-09)', () => {
  it('creates six dynamic colliding vehicles; countdown and free mode preserve state', () => {
    const { world, race } = scene();
    expect(race.vehicles).toHaveLength(6);
    expect(race.vehicles.every(v => v.body.isDynamic() && v.collider.isEnabled())).toBe(true);
    const before = race.player.body.translation();
    for (let frame = 0; frame < 180; frame++) tick(race, world, { ...NEUTRAL_INPUT, throttle: 1 }, false);
    expect(race.elapsed).toBe(0);
    expect(Math.hypot(race.player.body.translation().x - before.x, race.player.body.translation().z - before.z)).toBeLessThan(0.1);
    race.reset('free');
    expect(race.vehicles.filter(v => v.body.isEnabled())).toHaveLength(1);
    for (let frame = 0; frame < 120; frame++) tick(race, world, { ...NEUTRAL_INPUT, throttle: 1 });
    expect(race.player.distanceTravelled).toBeGreaterThan(8);
    expect(race.player.lap).toBe(1);
    race.reset('race');
    expect(race.vehicles.every(v => v.body.isEnabled())).toBe(true);
    expect(race.vehicles.every(v => v.lap === 1 && v.boost === 0 && !v.finished && v.recoveries === 0)).toBe(true);
    world.free();
  });

  it('vehicle cannot drive through a fixed barrier under throttle', () => {
    const { world, race } = scene(square);
    race.reset('free');
    // Deliberate fixture relocation: exercising contact, not course completion.
    race.player.body.setTranslation({ x: 0, y: 0.5, z: 0 }, true);
    race.player.body.setRotation({ x: 0, y: 0, z: 0, w: 1 }, true);
    world.createCollider(RAPIER.ColliderDesc.cuboid(10, 2, 0.3).setTranslation(0, 2, 10));
    for (let i = 0; i < 120; i++) tick(race, world, { ...NEUTRAL_INPUT, throttle: 1 });
    expect(race.player.body.translation().z).toBeLessThan(8.8);
    expect(race.player.body.translation().z).toBeGreaterThan(5);
    world.free();
  });

  it('drift release yields a real boost, and paint grip uses the same controller', () => {
    const { world, race } = scene();
    race.reset('free');
    for (let i = 0; i < 120; i++) tick(race, world, { ...NEUTRAL_INPUT, throttle: 1 });
    for (let i = 0; i < 100; i++) tick(race, world, { ...NEUTRAL_INPUT, throttle: 1, drift: true, steer: 0.65 }, true, 0.55);
    expect(race.player.grip).toBe(0.55);
    expect(race.player.driftCharge).toBeGreaterThan(0.24);
    tick(race, world, { ...NEUTRAL_INPUT, throttle: 1 });
    expect(race.player.boost).toBeGreaterThan(0.5);
    expect(race.player.body.isDynamic()).toBe(true);
    world.free();
  });

  it('safe recovery detects ground, avoids another kart, and retains checkpoint', () => {
    const { world, race } = scene();
    for (let i = 0; i < 60; i++) tick(race, world, NEUTRAL_INPUT, false);
    const checkpoint = race.player.checkpoint;
    expect(race.recover()).toBe(true);
    world.step(); race.afterStep(DT);
    expect(race.player.checkpoint).toBe(checkpoint);
    expect(race.player.recoveries).toBe(1);
    expect(race.player.body.translation().y).toBeGreaterThan(0.39);
    for (const other of race.vehicles.slice(1)) {
      expect(new Vector3().copy(other.body.translation()).distanceTo(new Vector3().copy(race.player.body.translation()))).toBeGreaterThan(1.45);
    }
    world.free();
  });

  it('coasting preserves forward heading and recovers only sustained wrong-way AI travel', () => {
    const route: RoutePoint[] = [[0, 0, 0], [0, 0, 500], [200, 0, 500], [200, 0, -100], [0, 0, -100]];
    for (const direction of [1, -1]) {
      const { world, race } = scene(route);
      const car = race.vehicles[1];
      // Controlled physical fault/heading fixture. No gate or progress values are
      // edited; the completion tests use ordinary unmodified race spawns.
      for (const other of race.vehicles) if (other !== car) { other.body.setEnabled(false); other.collider.setEnabled(false); }
      car.body.setTranslation({ x: 0, y: 0.48, z: 100 }, true);
      car.body.setRotation({ x: 0, y: direction < 0 ? 1 : 0, z: 0, w: direction > 0 ? 1 : 0 }, true);
      car.body.setLinvel({ x: 0, y: 0, z: 15 * direction }, true);
      const input = vi.spyOn(race, 'driveAI').mockReturnValue(NEUTRAL_INPUT);
      world.step(); race.afterStep(DT);
      let frames = 0;
      while (frames < 180 && car.recoveries === 0) { tick(race, world); frames++; }
      expect(car.recoveries, `coasting direction ${direction}`).toBe(direction > 0 ? 0 : 1);
      if (direction > 0) expect(car.body.translation().z).toBeGreaterThan(125);
      else expect(frames * DT).toBeLessThan(3);
      expect(race.progressFor(car).acceptedGates).toBe(0);
      input.mockRestore(); world.free();
    }
  });

  it('a missed-gate fault returns to the last legal position within three seconds without awarding progress', () => {
    const { world, race } = scene();
    // Explicit fault injection only: relocate beyond an unpassed gate. Completion
    // tests above/below do not use position or progress mutation.
    const fault = race.path.sample(55);
    race.player.body.setTranslation(fault.position.add(new Vector3(0, 0.48, 0)), true);
    world.step(); race.afterStep(DT);
    let frames = 0;
    while (frames < 180 && race.player.recoveries === 0) { tick(race, world, race.driveAI(race.player)); frames++; }
    expect(race.player.recoveries).toBe(1);
    expect(frames * DT).toBeLessThan(3);
    expect(race.player.checkpoint).toBe(1);
    expect(race.progressFor(race.player).acceptedGates).toBe(0);
    expect(race.player.lap).toBe(1);
    world.free();
  });

  it('a real centerline barrier causes a physical detour; destruction opens a measurably shorter AI line', () => {
    const route: RoutePoint[] = [[0, 0, 0], [0, 0, 100], [80, 0, 100], [80, 0, -100], [0, 0, -100]];
    const results: { opened: boolean; metres: number; seconds: number; recoveries: number; maxLateral: number }[] = [];
    for (const opened of [false, true]) {
      const { world, race } = scene(route);
      const environment = new Environment(new Scene(), world);
      environment.addBreakable({ id: 'game:shortcut-gate', position: [0, 1, 45], size: [7, 1.8, 0.22], chunkId: 'synthetic', verification: 'game_added' });
      race.reset('free'); world.step();
      if (opened) expect(environment.explode(new Vector3(0, 1, 43)).fragments).toBeGreaterThan(0);
      let frame = 0, maxLateral = 0;
      while (frame < 3600 && race.player.body.translation().z < 70) {
        tick(race, world, race.driveAI(race.player)); environment.update(DT, race.elapsed);
        maxLateral = Math.max(maxLateral, Math.abs(race.player.body.translation().x)); frame++;
      }
      expect(race.player.body.translation().z, JSON.stringify({ opened, at: race.player.body.translation(), heading: race.player.heading, recoveries: race.player.recoveries, maxLateral, input: race.driveAI(race.player) })).toBeGreaterThanOrEqual(70);
      results.push({ opened, metres: race.player.distanceTravelled, seconds: race.elapsed, recoveries: race.player.recoveries, maxLateral });
      world.free();
    }
    expect(results[0].recoveries).toBe(0);
    expect(results[1].recoveries).toBe(0);
    expect(results[0].maxLateral).toBeGreaterThan(4);
    expect(results[0].metres - results[1].metres).toBeGreaterThan(0.8);
    expect(results[0].seconds - results[1].seconds).toBeGreaterThan(0.1);
    console.info('SYNTHETIC_SHORTCUT_PHYSICS', JSON.stringify(results));
  });

  it('six colliding karts can physically pass an intact centerline gate as a group', () => {
    const route: RoutePoint[] = [[0, 0, 0], [0, 0, 100], [80, 0, 100], [80, 0, -100], [0, 0, -100]];
    const { world, race } = scene(route);
    const environment = new Environment(new Scene(), world);
    environment.addBreakable({ id: 'game:shortcut-gate', position: [0, 1, 45], size: [7, 1.8, 0.22], chunkId: 'synthetic', verification: 'game_added' });
    world.step();
    const passed = new Set<number>();
    for (let frame = 0; frame < 60 * 30 && passed.size < 6; frame++) {
      tick(race, world, race.driveAI(race.player)); environment.update(DT, race.elapsed);
      for (const v of race.vehicles) if (v.body.translation().z > 70) passed.add(v.id);
    }
    expect([...passed].sort()).toEqual([0, 1, 2, 3, 4, 5]);
    console.info('SYNTHETIC_GROUP_GATE', JSON.stringify(race.vehicles.map(v => ({ id: v.id, recoveries: v.recoveries, gates: race.progressFor(v).acceptedGates }))));
    world.free();
  });

  it('all six physical vehicles complete three laps on a synthetic oval without progress edits', () => {
    const { world, race } = scene();
    const recoveriesBefore = race.vehicles.map(v => v.recoveries);
    for (let frame = 0; frame < 60 * 180 && !race.allFinished; frame++) tick(race, world, race.driveAI(race.player));
    expect(race.vehicles.map(v => ({ id: v.id, lap: v.lap, checkpoint: v.checkpoint, finished: v.finished, recoveries: v.recoveries }))).toEqual(expect.arrayContaining(race.vehicles.map(v => expect.objectContaining({ id: v.id, lap: 3, finished: true }))));
    expect(race.vehicles.every(v => v.finishTime !== null && v.finishTime > 45)).toBe(true);
    expect(new Set(race.vehicles.map(v => v.rank)).size).toBe(6);
    expect(race.vehicles.map(v => v.recoveries)).toEqual(recoveriesBefore);
    expect(race.vehicles.every(v => race.progressFor(v).acceptedGates === 72)).toBe(true);
    console.info('SYNTHETIC_OVAL_PHYSICS', JSON.stringify({ routeMetres: race.routeLength, seconds: race.elapsed, vehicles: race.vehicles.map(v => ({ id: v.id, finished: v.finished, finishTime: v.finishTime, metres: v.distanceTravelled, recoveries: v.recoveries, gates: race.progressFor(v).acceptedGates })) }));
    world.free();
  }, 30000);
});
