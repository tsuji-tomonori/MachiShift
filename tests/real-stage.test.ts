import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { beforeAll, expect, it } from 'vitest';
import RAPIER from '@dimforge/rapier3d-compat';
import * as THREE from 'three';
import { Environment, type StaticMeshSpec } from '../src/environment';
import { Race, type RoutePoint } from '../src/race';

beforeAll(async () => { await RAPIER.init(); });
const DT = 1 / 60;
// Game-authored training fence: the original 32 m placement pinned cars at a bend.
const FIRST_SIDE_FENCE_DISTANCE = 72;
interface Stage { route: RoutePoint[]; routeStatus: string; chunks: { id: string; url: string }[] }
function readJSON<T>(path: string): T {
  const bytes = readFileSync(path);
  return JSON.parse((path.endsWith('.gz') ? gunzipSync(bytes) : bytes).toString()) as T;
}

function sourceFixture() {
  const stagePath = resolve('public/data/stage.json');
  const stageSha256 = createHash('sha256').update(readFileSync(stagePath)).digest('hex');
  const stage = readJSON<Stage>(stagePath);
  expect(stage.route.length, 'A source-grounded route is required; an artificial fallback is not accepted.').toBeGreaterThan(3);
  const scene = new THREE.Scene();
  const world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
  world.timestep = DT;
  const environment = new Environment(scene, world);
  for (const chunk of stage.chunks) {
    const data = readJSON<{ objects: StaticMeshSpec[] }>(resolve('public', chunk.url.replace(/^\//, '')));
    for (const object of data.objects) if ((object as StaticMeshSpec & { runtimeEligible?: boolean }).runtimeEligible !== false) environment.addStaticMesh({ ...object, chunkId: chunk.id });
  }
  const race = new Race(world, stage.route);
  const fenceCenters: THREE.Vector3[] = [];
  for (const distance of [FIRST_SIDE_FENCE_DISTANCE, race.routeLength * 0.31, race.routeLength * 0.62]) {
    const at = race.sampleRoute(distance), ahead = race.sampleRoute(distance + 2);
    const heading = Math.atan2(ahead.x - at.x, ahead.z - at.z);
    const center = at.clone().addScaledVector(new THREE.Vector3(Math.cos(heading), 0, -Math.sin(heading)), 4.5).add(new THREE.Vector3(0, 1, 0));
    fenceCenters.push(center);
    environment.addBreakable({ id: `game:fence:${Math.round(distance)}`, position: center.toArray() as RoutePoint, size: [5, 1.8, 0.22], rotationY: heading, color: 0xf2c450, chunkId: 'game-added', kind: 'fence', verification: 'game_added' });
  }
  const shortcut = race.sampleRoute(115), shortcutAhead = race.sampleRoute(117);
  const shortcutHeading = Math.atan2(shortcutAhead.x - shortcut.x, shortcutAhead.z - shortcut.z);
  const shortcutCenter = shortcut.add(new THREE.Vector3(0, 1, 0));
  fenceCenters.push(shortcutCenter);
  environment.addBreakable({ id: 'game:shortcut-gate', position: shortcutCenter.toArray() as RoutePoint, size: [7, 1.8, 0.22], rotationY: shortcutHeading, color: 0xf2c450, chunkId: 'game-added', kind: 'fence', verification: 'game_added' });
  world.step(); environment.update(0, 0); race.afterStep(0);
  return { stage, stageSha256, world, environment, race, fenceCenters, shortcutCenter };
}

it('AT-09 integration: all six physical vehicles complete the actual PLATEAU course before and after destruction', async () => {
  const { stage, stageSha256, world, environment, race, fenceCenters } = sourceFixture();
  const reports: Record<string, unknown>[] = [];
  try {
    for (const scenario of ['baseline', 'destroyed-fences'] as const) {
      environment.reset(); race.reset('race'); world.step();
      let explosionFragments = 0;
      if (scenario === 'destroyed-fences') {
        for (const center of fenceCenters) explosionFragments += environment.explode(center.clone().add(new THREE.Vector3(0, 0, -1))).fragments;
        expect(explosionFragments).toBeGreaterThan(0);
      }
      const timeline: unknown[] = [];
      const recoveryEvents: { vehicleId: number; seconds: number; lap: number; checkpoint: number; routeDistance: number; legalRouteDistance: number; position: { x: number; y: number; z: number }; count: number }[] = [];
      const recoveriesAtFinish = new Map<number, number>();
      const metresAtFinish = new Map<number, number>();
      let shortcutEntry: { seconds: number; metres: number; recoveries: number } | null = null;
      let shortcutSection: { seconds: number; metres: number; recoveries: number } | null = null;
      const wallStart = performance.now();
      for (let frame = 0; frame < 60 * 420 && !race.allFinished; frame++) {
        const beforeRecovery = race.vehicles.map(v => ({ count: v.recoveries, finished: v.finished, lap: v.lap, checkpoint: v.checkpoint, position: v.body.translation(), legalRouteDistance: race.path.distances[race.progressFor(v).lastPassed] }));
        race.update(DT, race.driveAI(race.player), p => environment.gripAt(p, race.elapsed), true);
        world.step(); race.afterStep(DT); environment.update(DT, race.elapsed);
        for (const v of race.vehicles) {
          const before = beforeRecovery[v.id];
          if (!before.finished && v.recoveries > before.count) recoveryEvents.push({ vehicleId: v.id, seconds: race.elapsed, lap: before.lap, checkpoint: before.checkpoint, routeDistance: race.path.nearest(new THREE.Vector3().copy(before.position)).distance, legalRouteDistance: before.legalRouteDistance, position: before.position, count: v.recoveries - before.count });
        }
        // Keep Vitest's worker RPC responsive during a multi-minute simulation.
        if (frame % 120 === 0) await new Promise<void>(done => setTimeout(done, 0));
        for (const v of race.vehicles) if (v.finished && !recoveriesAtFinish.has(v.id)) { recoveriesAtFinish.set(v.id, v.recoveries); metresAtFinish.set(v.id, v.distanceTravelled); }
        const passedDistance = race.path.distances[race.progressFor(race.player).lastPassed];
        if (race.player.lap === 1 && !shortcutEntry && passedDistance >= 70) shortcutEntry = { seconds: race.elapsed, metres: race.player.distanceTravelled, recoveries: race.player.recoveries };
        if (race.player.lap === 1 && shortcutEntry && !shortcutSection && passedDistance >= 155) shortcutSection = { seconds: race.elapsed - shortcutEntry.seconds, metres: race.player.distanceTravelled - shortcutEntry.metres, recoveries: race.player.recoveries - shortcutEntry.recoveries };
        if (frame % (60 * 30) === 0) {
          const checkpoint = { seconds: +race.elapsed.toFixed(2), vehicles: race.vehicles.map(v => ({ id: v.id, lap: v.lap, checkpoint: v.checkpoint, recoveries: v.recoveries, position: v.body.translation() })) };
          timeline.push(checkpoint);
        }
      }
      const report = {
        scenario, testedAt: new Date().toISOString(), stageSha256, routeStatus: stage.routeStatus,
        routeMetres: race.routeLength, coursePoints: race.route.length, seconds: race.elapsed, executionSeconds: (performance.now() - wallStart) / 1000,
        objectCount: environment.stats.objects, firstSideFenceDistance: FIRST_SIDE_FENCE_DISTANCE, explosionFragments, shortcutSection, recoveryEvents,
        scriptedInput: true, rendered: false, realHardwarePerformanceClaim: false,
        vehicles: race.vehicles.map(v => ({ id: v.id, finished: v.finished, finishTime: v.finishTime, rank: v.rank, lap: v.lap, checkpoint: v.checkpoint, metres: v.distanceTravelled, metresAtFinish: metresAtFinish.get(v.id) ?? null, recoveries: v.recoveries, recoveriesAtFinish: recoveriesAtFinish.get(v.id) ?? null, rejectedTeleports: race.progressFor(v).rejectedTeleports, gates: race.progressFor(v).acceptedGates, position: v.body.translation() })), timeline,
      };
      reports.push(report);
      mkdirSync(resolve('artifacts'), { recursive: true });
      writeFileSync(resolve('artifacts/real-stage-physics.json'), JSON.stringify({ kind: 'physical-state-evidence', reports }, null, 2));
      console.info('REAL_STAGE_PHYSICS', JSON.stringify({ ...report, timeline: undefined }));
      expect(race.vehicles.map(v => ({ id: v.id, finished: v.finished, lap: v.lap, checkpoint: v.checkpoint, recoveries: v.recoveries }))).toEqual(expect.arrayContaining(race.vehicles.map(v => expect.objectContaining({ id: v.id, finished: true, lap: 3 }))));
      expect(race.vehicles.every(v => race.progressFor(v).acceptedGates === race.route.length * 3)).toBe(true);
      expect(new Set(race.vehicles.map(v => v.rank)).size).toBe(6);
      // Internal regression: a car must not repeatedly recover at the first bend
      // in one lap, even if recovery eventually lets the six-car race finish.
      for (const vehicle of race.vehicles) for (const lap of [1, 2, 3]) {
        const atFirstBend = recoveryEvents.filter(event => event.vehicleId === vehicle.id && event.lap === lap && ((event.routeDistance >= 10 && event.routeDistance <= 55) || (event.legalRouteDistance >= 10 && event.legalRouteDistance <= 55)));
        expect(atFirstBend.reduce((sum, event) => sum + event.count, 0), `${scenario}: car ${vehicle.id}, lap ${lap} repeated first-bend recovery`).toBeLessThanOrEqual(1);
      }
    }
  } finally { world.free(); }
}, 180000);

it('DEST-07 integration: opening the actual source-road center gate shortens the physical driven segment', async () => {
  const { stageSha256, world, environment, race, shortcutCenter } = sourceFixture();
  const trials: { opened: boolean; metres: number; seconds: number; recoveries: number }[] = [];
  try {
    for (const opened of [false, true]) {
      environment.reset(); race.reset('free'); world.step();
      if (opened) expect(environment.explode(shortcutCenter.clone().add(new THREE.Vector3(0, 0, 1))).fragments).toBeGreaterThan(0);
      let entry: { metres: number; seconds: number; recoveries: number } | null = null;
      const approachTrace: unknown[] = [];
      for (let frame = 0; frame < 60 * 60; frame++) {
        race.update(DT, race.driveAI(race.player), p => environment.gripAt(p, race.elapsed), true);
        world.step(); race.afterStep(DT); environment.update(DT, race.elapsed);
        if (frame % 120 === 0) await new Promise<void>(done => setTimeout(done, 0));
        const distance = race.path.nearest(new THREE.Vector3().copy(race.player.body.translation())).distance;
        if (frame % 30 === 0 && frame < 900) approachTrace.push({ t: race.elapsed, d: distance, pos: race.player.body.translation(), speed: race.player.speed, heading: race.player.heading, input: race.driveAI(race.player), recoveries: race.player.recoveries });
        if (!entry && distance >= 70 && distance < 100) entry = { metres: race.player.distanceTravelled, seconds: race.elapsed, recoveries: race.player.recoveries };
        if (entry && distance >= 155 && distance < 190) {
          trials.push({ opened, metres: race.player.distanceTravelled - entry.metres, seconds: race.elapsed - entry.seconds, recoveries: race.player.recoveries - entry.recoveries });
          break;
        }
      }
      if (!trials.some(t => t.opened === opened)) console.info('REAL_SHORTCUT_INCOMPLETE', JSON.stringify({ opened, entry, elapsed: race.elapsed, position: race.player.body.translation(), near: race.path.nearest(new THREE.Vector3().copy(race.player.body.translation())).distance, recoveries: race.player.recoveries, input: race.driveAI(race.player), grounded: race.player.grounded, approachTrace }));
    }
    const report = { stageSha256, scriptedInput: true, rendered: false, sectionRouteMetres: [70, 155], trials };
    mkdirSync(resolve('artifacts'), { recursive: true });
    writeFileSync(resolve('artifacts/real-shortcut-physics.json'), JSON.stringify(report, null, 2));
    console.info('REAL_SHORTCUT_PHYSICS', JSON.stringify(report));
    expect(trials).toHaveLength(2);
    expect(trials.every(t => t.recoveries === 0)).toBe(true);
    expect(trials[0].metres - trials[1].metres).toBeGreaterThan(0.5);
    expect(trials[0].seconds - trials[1].seconds).toBeGreaterThan(0.1);
  } finally { world.free(); }
}, 45000);

it('actual source first 200 metres remain traversable for all six cars with intact barriers', async () => {
  const { world, environment, race } = sourceFixture();
  const passed = new Set<number>();
  const piecesByCollider = new Map(environment.getState().filter(p => p.colliderHandle !== null).map(p => [p.colliderHandle!, { id: p.id, objectId: p.objectId, kind: p.kind, verification: p.verification }]));
  const contactSamples: unknown[] = [];
  const recorded = new Set<string>();
  try {
    for (let frame = 0; frame < 60 * 60 && passed.size < 6; frame++) {
      race.update(DT, race.driveAI(race.player), p => environment.gripAt(p, race.elapsed), true);
      world.step(); race.afterStep(DT); environment.update(DT, race.elapsed);
      for (const v of race.vehicles) if (Math.abs(v.speed) < 0.6 && v.checkpoint >= 8 && v.checkpoint <= 14) world.contactPairsWith(v.collider, other => {
        const key = `${v.id}:${other.handle}`;
        if (recorded.has(key)) return;
        world.contactPair(v.collider, other, manifold => {
          if (!manifold.numSolverContacts() || Math.abs(manifold.normal().y) > 0.6) return;
          recorded.add(key);
          contactSamples.push({ vehicleId: v.id, seconds: race.elapsed, checkpoint: v.checkpoint, position: v.body.translation(), other: piecesByCollider.get(other.handle) ?? { vehicleId: race.vehicles.find(candidate => candidate.collider.handle === other.handle)?.id }, normal: manifold.normal(), contactCount: manifold.numSolverContacts() });
        });
      });
      if (frame % 120 === 0) await new Promise<void>(done => setTimeout(done, 0));
      for (const v of race.vehicles) if (race.path.distances[race.progressFor(v).lastPassed] >= 200) passed.add(v.id);
    }
    console.info('REAL_FIRST_200M', JSON.stringify(race.vehicles.map(v => ({ id: v.id, checkpoint: v.checkpoint, recoveries: v.recoveries, at: v.body.translation(), input: race.driveAI(v) }))));
    mkdirSync(resolve('artifacts'), { recursive: true });
    writeFileSync(resolve('artifacts/first-bend-contact-diagnosis.json'), JSON.stringify({ firstSideFenceDistance: FIRST_SIDE_FENCE_DISTANCE, contactSamples }, null, 2));
    console.info('FIRST_BEND_CONTACTS', JSON.stringify(contactSamples));
    expect([...passed].sort()).toEqual([0, 1, 2, 3, 4, 5]);
  } finally { world.free(); }
}, 45000);
