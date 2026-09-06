import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { beforeAll, expect, it } from 'vitest';
import RAPIER from '@dimforge/rapier3d-compat';
import * as THREE from 'three';
import { Environment, type StaticMeshSpec } from '../src/environment';

beforeAll(async () => { await RAPIER.init(); });

it('AT-03: actual source bridges keep deck/ground collisions, paint and the ground route distinct', () => {
  const bytes = readFileSync('public/data/stage.json');
  const stage = JSON.parse(bytes.toString()) as { route: [number, number, number][]; chunks: { id: string; url: string; sha256: string }[] };
  const world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
  const scene = new THREE.Scene();
  const environment = new Environment(scene, world);
  const bridges: StaticMeshSpec[] = [];
  const hashes: { path: string; sha256: string }[] = [];
  for (const chunk of stage.chunks) {
    const data = readFileSync(`public/${chunk.url}`);
    expect(createHash('sha256').update(data).digest('hex')).toBe(chunk.sha256);
    hashes.push({ path: `public/${chunk.url}`, sha256: chunk.sha256 });
    const objects = (JSON.parse(gunzipSync(data).toString()) as { objects: (StaticMeshSpec & { runtimeEligible?: boolean })[] }).objects;
    for (const object of objects) if (object.runtimeEligible !== false && ['road', 'plaza', 'bridge', 'terrain'].includes(object.kind)) {
      environment.addStaticMesh(object);
      if (object.kind === 'bridge') bridges.push(object);
    }
  }
  world.step(); scene.updateMatrixWorld(true);
  const states = environment.getState();
  const byHandle = new Map(states.map(state => [state.colliderHandle, state]));
  const down = new THREE.Vector3(0, -1, 0);
  const cast = (origin: THREE.Vector3, distance = 50) => {
    const hit = world.castRayAndGetNormal(new RAPIER.Ray(origin, down), distance, true);
    return hit ? { hit, state: byHandle.get(hit.collider.handle)!, point: origin.clone().addScaledVector(down, hit.timeOfImpact) } : null;
  };
  const reports: unknown[] = [];
  try {
    expect(bridges).toHaveLength(2);
    for (const bridge of bridges) {
      let pair: { above: THREE.Vector3; below: THREE.Vector3; groundId: string; deckY: number; groundY: number } | null = null;
      // Candidate points are unmodified source triangle centroids; no invented deck.
      for (let i = 0; i < bridge.indices.length && !pair; i += 3) {
        const a = new THREE.Vector3().fromArray(bridge.positions, bridge.indices[i] * 3);
        const b = new THREE.Vector3().fromArray(bridge.positions, bridge.indices[i + 1] * 3);
        const c = new THREE.Vector3().fromArray(bridge.positions, bridge.indices[i + 2] * 3);
        const cross = b.clone().sub(a).cross(c.clone().sub(a));
        if (cross.length() < 2 || Math.abs(cross.normalize().y) < 0.95) continue;
        const center = a.add(b).add(c).divideScalar(3);
        const upper = cast(center.clone().add(new THREE.Vector3(0, 0.3, 0)), 0.6);
        if (!upper || upper.state.objectId !== bridge.id) continue;
        const lowerOrigin = center.clone().add(new THREE.Vector3(0, -1, 0));
        const lower = cast(lowerOrigin, 15);
        if (!lower || !['road', 'plaza'].includes(lower.state.kind) || center.y - lower.point.y < 2.5) continue;
        pair = { above: center.clone().add(new THREE.Vector3(0, 0.3, 0)), below: lowerOrigin, groundId: lower.state.objectId, deckY: upper.point.y, groundY: lower.point.y };
      }
      expect(pair, `independent collision layers under ${bridge.id}`).not.toBeNull();
      const selected = pair!;
      environment.reset(); scene.updateMatrixWorld(true);
      const deckPaint = environment.paintRay(selected.above, down, 0x2785ff);
      expect(deckPaint?.objectId).toBe(bridge.id);
      expect(environment.getState().filter(state => ['road', 'plaza'].includes(state.kind)).every(state => state.paints.length === 0)).toBe(true);
      const groundPaint = environment.paintRay(selected.below, down, 0xff457e);
      expect(groundPaint?.objectId).toBe(selected.groundId);
      expect(deckPaint?.surfaceId).not.toBe(groundPaint?.surfaceId);
      expect(environment.getState().find(state => state.objectId === bridge.id)!.paints.every(mark => mark.color === 0x2785ff)).toBe(true);
      reports.push({ bridgeId: bridge.id, above: selected.above.toArray(), below: selected.below.toArray(), deckY: selected.deckY, groundY: selected.groundY, deckPaint, groundPaint });
    }
    const routeSupport = stage.route.map((point, index) => {
      const support = cast(new THREE.Vector3(...point).add(new THREE.Vector3(0, 0.3, 0)), 1);
      expect(support, `source route support ${index}`).not.toBeNull();
      expect(['road', 'plaza']).toContain(support!.state.kind);
      expect(Math.abs(support!.point.y - point[1])).toBeLessThan(0.3);
      return { index, objectId: support!.state.objectId, kind: support!.state.kind, heightError: Math.abs(support!.point.y - point[1]) };
    });
    mkdirSync('artifacts', { recursive: true });
    writeFileSync('artifacts/geographic-separation.json', JSON.stringify({
      id: 'AT-03-SOURCE-SEPARATION', executedAt: new Date().toISOString(), result: 'PASS',
      environment: `Node ${process.version}; actual Rapier WASM colliders and Three.js paint geometry; no GPU`,
      scope: 'Both bundled bridges: actual stacked collider ray hits and two-layer paint isolation; every actual route sample supported by ground road/plaza. Does not survey real-world stair/ramp connections (GEO-03), ground accuracy (GEO-04/05), human evaluation or target GPU.',
      stageSha256: createHash('sha256').update(bytes).digest('hex'), hashes, bridges: reports, routeSupport,
    }, null, 2));
  } finally { world.free(); }
}, 30000);
