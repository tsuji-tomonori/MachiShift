import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { Environment, type StaticMeshSpec } from '../src/environment';

const worlds: RAPIER.World[] = [];
beforeAll(async () => { await RAPIER.init(); });
afterEach(() => { for (const world of worlds.splice(0)) world.free(); });

function fixture() {
  const scene = new THREE.Scene();
  const world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
  world.timestep = 1 / 60;
  worlds.push(world);
  const environment = new Environment(scene, world);
  environment.addStaticMesh({ id: 'ground', surfaceId: 'ground:top', kind: 'road', chunkId: 'test',
    positions: [-70, 0, -70, 70, 0, -70, 70, 0, 70, -70, 0, 70], indices: [0, 2, 1, 0, 3, 2] });
  const step = (seconds: number, from = 0) => {
    for (let i = 1; i <= Math.round(seconds * 60); i++) {
      world.step();
      environment.update(1 / 60, from + i / 60);
    }
  };
  return { scene, world, environment, step };
}

function fence(environment: Environment, id = 'fence', z = 0) {
  environment.addBreakable({ id, position: [0, 1, z], size: [4, 2, 0.2],
    chunkId: 'fence-chunk', color: 0xe8a84b, verification: 'game_added',
    parts: [-1.33, 0, 1.33].map(x => ({ offset: [x, 0, 0], size: [1.325, 2, 0.2] })),
  });
}

function box(environment: Environment, id: string, size: [number, number, number], center: [number, number, number]) {
  const geometry = new THREE.BoxGeometry(...size).translate(...center);
  environment.addStaticMesh({ id, kind: 'wall', chunkId: 'test',
    positions: Array.from(geometry.getAttribute('position').array), indices: Array.from(geometry.index!.array) });
  geometry.dispose();
}

describe('Environment: actual Three surfaces and Rapier bodies', () => {
  it('AT-04: blue paint follows moving physical fragments and the former fence permits a driven body through', () => {
    const { scene, world, environment, step } = fixture();
    fence(environment);
    const hit = environment.paintRay(new THREE.Vector3(0, 1, -4), new THREE.Vector3(0, 0, 1), 0x2785ff);
    expect(hit?.objectId).toBe('fence');
    expect(hit?.decalCount).toBeGreaterThan(0);
    const paintedBefore = environment.getState().filter(p => p.objectId === 'fence' && p.paints.length);
    const before = paintedBefore[0];
    expect(before.paints[0].color).toBe(0x2785ff);
    const paintedMesh = scene.getObjectByName(before.id) as THREE.Mesh<THREE.BufferGeometry, THREE.MeshStandardMaterial>;
    expect(paintedMesh.material.color.getHex()).toBe(0xe8a84b);
    expect(paintedMesh.children[0].parent).toBe(paintedMesh);
    const originalHandles = environment.getState().filter(p => p.objectId === 'fence').map(p => p.colliderHandle!);
    const kart = world.createRigidBody(RAPIER.RigidBodyDesc.dynamic().setTranslation(0, 0.7, -4)
      .setGravityScale(0).lockRotations().setCcdEnabled(true));
    world.createCollider(RAPIER.ColliderDesc.ball(0.35).setMass(200), kart);
    for (let i = 0; i < 60; i++) { kart.setLinvel({ x: 0, y: 0, z: 8 }, true); world.step(); }
    expect(kart.translation().z).toBeLessThan(-0.4);
    const blast = environment.explode(new THREE.Vector3(0, 1, -2));
    expect(blast.destroyed).toEqual(['fence']);
    expect(blast.fragments).toBe(3);
    // Rapier's JS map contains() ignores generation; the actual returned handle must differ.
    for (const handle of originalHandles) expect(world.getCollider(handle)?.handle).not.toBe(handle);
    step(1.2);
    const after = environment.getState().find(p => p.id === before.id)!;
    expect(after.dynamic).toBe(true);
    expect(after.paints[0].localPoint).toEqual(before.paints[0].localPoint);
    expect(new THREE.Vector3(...after.paints[0].worldPoint).distanceTo(new THREE.Vector3(...before.paints[0].worldPoint))).toBeGreaterThan(1);
    expect(paintedMesh.children[0].parent).toBe(paintedMesh);
    kart.setTranslation({ x: 0, y: 0.7, z: -4 }, true);
    for (let i = 0; i < 70; i++) {
      kart.setLinvel({ x: 0, y: 0, z: 8 }, true);
      world.step();
      environment.update(1 / 60, 1.2 + (i + 1) / 60);
    }
    expect(kart.translation().z).toBeGreaterThan(3);
  });

  it('AT-05: thin wall rear faces and a separate upper floor receive no paint', () => {
    const { scene, environment } = fixture();
    box(environment, 'thin-wall', [8, 4, 0.02], [0, 2, 0]);
    box(environment, 'upper-floor', [8, 0.1, 8], [0, 5, 0]);
    const hit = environment.paintRay(new THREE.Vector3(0, 2, -4), new THREE.Vector3(0, 0, 1), 0x2785ff);
    expect(hit?.objectId).toBe('thin-wall');
    const wall = scene.getObjectByName('thin-wall')!;
    expect(wall.children.length).toBeGreaterThan(0);
    for (const decal of wall.children as THREE.Mesh[]) {
      const position = decal.geometry.getAttribute('position');
      for (let i = 0; i < position.count; i++) expect(position.getZ(i)).toBeCloseTo(-0.01, 5);
    }
    expect(environment.getState().find(p => p.id === 'upper-floor')!.paints).toHaveLength(0);
  });

  it('PAINT-04/07: slope patches follow the plane, colors layer, temporary grip expires before visual paint', () => {
    const { scene, environment } = fixture();
    environment.addStaticMesh({ id: 'slope', kind: 'road', chunkId: 'test',
      positions: [10, 1, -4, 18, 5, -4, 18, 5, 4, 10, 1, 4], indices: [0, 2, 1, 0, 3, 2] });
    const origin = new THREE.Vector3(14, 10, 0);
    const direction = new THREE.Vector3(0, -1, 0);
    environment.paintRay(origin, direction, 0x2785ff);
    environment.paintRay(origin, direction, 0xff457e);
    const slope = scene.getObjectByName('slope')!;
    expect(slope.children).toHaveLength(2);
    for (const decal of slope.children as THREE.Mesh[]) {
      const position = decal.geometry.getAttribute('position');
      for (let i = 0; i < position.count; i++) expect(position.getY(i)).toBeCloseTo((position.getX(i) - 10) * 0.5 + 1, 4);
    }
    const state = environment.getState().find(p => p.id === 'slope')!;
    expect(state.paints.map(p => p.color)).toEqual([0x2785ff, 0xff457e]);
    expect(environment.gripAt(new THREE.Vector3(14, 3.5, 0), 1)).toBe(0.52);
    expect(environment.gripAt(new THREE.Vector3(14, 6.5, 0), 1)).toBe(1);
    environment.update(0, 9);
    expect(environment.gripAt(new THREE.Vector3(14, 3.5, 0), 9)).toBe(1);
    expect(environment.stats.paintDecals).toBe(2);
  });

  it('PAINT-01 provenance: a hit on a combined source mesh resolves the original polygon ID', () => {
    const { environment } = fixture();
    environment.addStaticMesh({ id: 'source-building', kind: 'building', chunkId: 'test',
      positions: [-4, 0, 3, 0, 0, 3, 0, 4, 3, -4, 4, 3, 0, 0, 3, 4, 0, 3, 4, 4, 3, 0, 4, 3],
      indices: [0, 2, 1, 0, 3, 2, 4, 6, 5, 4, 7, 6],
      surfaces: [
        { id: 'gml-polygon-left', sourceId: 'gml-source-1', start: 0, count: 6 },
        { id: 'gml-polygon-right', sourceId: 'gml-source-1', start: 6, count: 6 },
      ],
    });
    const hit = environment.paintRay(new THREE.Vector3(2, 2, -3), new THREE.Vector3(0, 0, 1), 0x2785ff);
    expect(hit?.surfaceId).toBe('gml-polygon-right');
    const state = environment.getState().find(p => p.id === 'source-building')!;
    expect(state.paints.every(p => p.surfaceId === 'gml-polygon-right')).toBe(true);
    expect(state.surfaces?.[1].sourceId).toBe('gml-source-1');
  });

  it('DEST-06: an intact wall occludes a blast, and only exposed targets break', () => {
    const { environment } = fixture();
    box(environment, 'blast-wall', [10, 5, 0.3], [0, 2.5, 0]);
    fence(environment, 'behind-wall', 3);
    fence(environment, 'in-front', -5);
    const blast = environment.explode(new THREE.Vector3(0, 1, -3), 12);
    expect(blast.destroyed).toEqual(['in-front']);
    expect(blast.occluded).toBe(3);
    expect(environment.getState().filter(p => p.objectId === 'behind-wall').every(p => !p.broken)).toBe(true);
    expect(environment.hasLineOfSight(new THREE.Vector3(0, 1, -3), new THREE.Vector3(0, 1, 3))).toBe(false);
  });

  it('AT-08/DEST-04: culling preserves mutation; retired fragments retain paint without permanently blocking routes', () => {
    const { environment, step, world } = fixture();
    fence(environment);
    environment.paintRay(new THREE.Vector3(0, 1, -4), new THREE.Vector3(0, 0, 1), 0x2785ff);
    environment.explode(new THREE.Vector3(0, 1, -2));
    step(2);
    const active = environment.getState().filter(p => p.objectId === 'fence');
    expect(active.every(p => p.dynamic)).toBe(true);
    expect(active.every(p => world.colliders.contains(p.colliderHandle!))).toBe(true);
    environment.setChunkVisible('fence-chunk', false);
    const hidden = environment.getState().filter(p => p.objectId === 'fence');
    expect(hidden.every(p => p.broken && !p.visible)).toBe(true);
    environment.setChunkVisible('fence-chunk', true);
    expect(environment.getState().filter(p => p.objectId === 'fence')).toEqual(active);
    step(5, 2);
    const retired = environment.getState().filter(p => p.objectId === 'fence');
    expect(retired.every(p => p.retired && p.colliderHandle === null && p.bodyHandle === null)).toBe(true);
    expect(retired.reduce((sum, p) => sum + p.paints.length, 0)).toBeGreaterThan(0);
    expect(environment.stats.dynamicDebris).toBe(0);
    expect(environment.stats.retainedFragments).toBe(3);
  });

  it('AT-11: repeated resets restore original colliders, remove paint/grip and leave unrelated vehicle bodies valid', () => {
    const { environment, world, step } = fixture();
    fence(environment);
    const initial = environment.getState().filter(p => p.objectId === 'fence');
    const vehicle = world.createRigidBody(RAPIER.RigidBodyDesc.dynamic().setTranslation(8, 2, 0));
    const vehicleCollider = world.createCollider(RAPIER.ColliderDesc.ball(0.5), vehicle);
    for (let cycle = 0; cycle < 4; cycle++) {
      environment.paintRay(new THREE.Vector3(0, 1, -4), new THREE.Vector3(0, 0, 1), 0x2785ff);
      environment.paintRay(new THREE.Vector3(5, 3, 0), new THREE.Vector3(0, -1, 0), 0xff457e);
      environment.explode(new THREE.Vector3(0, 1, -2));
      step(cycle % 2 === 0 ? 7 : 1);
      environment.reset();
      const restored = environment.getState().filter(p => p.objectId === 'fence');
      expect(restored.map(p => p.position)).toEqual(initial.map(p => p.position));
      expect(restored.every(p => !p.broken && !p.retired && !p.dynamic && p.colliderHandle !== null)).toBe(true);
      expect(environment.stats.paintEvents).toBe(0);
      expect(environment.stats.paintDecals).toBe(0);
      expect(environment.stats.gripZones).toBe(0);
      expect(environment.stats.colliderCount).toBe(4);
      expect(world.colliders.len()).toBe(5);
      expect(world.colliders.contains(vehicleCollider.handle)).toBe(true);
      expect(world.bodies.contains(vehicle.handle)).toBe(true);
      const count = world.colliders.len();
      environment.reset();
      expect(world.colliders.len()).toBe(count);
    }
  });

  it('DEST-04 budget: at most 100 dynamic pieces; excess pieces lose collision while broken state remains', () => {
    const { environment, world } = fixture();
    for (let n = 0; n < 40; n++) {
      environment.addBreakable({ id: `budget-${n}`, position: [n * 3, 1, 10], size: [2, 2, 0.2],
        chunkId: 'test', verification: 'game_added' });
      environment.explode(new THREE.Vector3(n * 3, 1, 8), 2.8);
    }
    expect(environment.stats.retainedFragments).toBe(120);
    expect(environment.stats.dynamicDebris).toBe(100);
    expect(environment.getState().filter(p => p.retired)).toHaveLength(20);
    expect(world.colliders.len()).toBe(101);
  });

  it('AT-11 stale handles: external body removal and slot reuse cannot remove a new unrelated vehicle', () => {
    const { environment, world } = fixture();
    fence(environment);
    const state = environment.getState().find(p => p.objectId === 'fence')!;
    world.removeRigidBody(world.getRigidBody(state.bodyHandle!));
    const replacement = world.createRigidBody(RAPIER.RigidBodyDesc.dynamic().setTranslation(15, 3, 0));
    const replacementCollider = world.createCollider(RAPIER.ColliderDesc.ball(0.5), replacement);
    environment.reset();
    expect(world.getRigidBody(replacement.handle)?.handle).toBe(replacement.handle);
    expect(world.getCollider(replacementCollider.handle)?.handle).toBe(replacementCollider.handle);
    expect(environment.stats.staticColliders).toBe(4);
  });

  it('DEST-03: selected original sloping facade detaches with paint; the original vertices and retained building wall stay intact', () => {
    const { scene, environment, step } = fixture();
    const positions = [-2, 0.3, 0, 2, 0.3, 0, 1.4, 3.1, 0.7, -1.2, 3.1, 0.7,
      -2, 0.3, 4, 2, 0.3, 4, 2, 3.1, 4, -2, 3.1, 4];
    const selection = environment.addDestructibleMesh({ id: 'source-facade', kind: 'building', chunkId: 'source',
      verification: 'source_only', positions, indices: [0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7],
      surfaces: [{ id: 'front-polygon', sourceId: 'gml-front', start: 0, count: 6 },
        { id: 'rear-polygon', sourceId: 'gml-rear', start: 6, count: 6 }],
    }, { surfaceIds: ['front-polygon'] });
    expect(selection.selectedSurfaces).toEqual(['front-polygon']);
    const sourceMeshes = environment.meshes.filter(mesh => mesh.userData.objectId === 'source-facade');
    const rendered = sourceMeshes.flatMap(mesh => {
      const position = mesh.geometry.getAttribute('position');
      return Array.from({ length: position.count }, (_, i) => new THREE.Vector3().fromBufferAttribute(position, i).applyMatrix4(mesh.matrixWorld));
    });
    expect(rendered).toHaveLength(8);
    for (let i = 0; i < positions.length; i += 3) {
      const expected = new THREE.Vector3(positions[i], positions[i + 1], positions[i + 2]);
      expect(Math.min(...rendered.map(point => point.distanceTo(expected)))).toBeLessThan(0.000001);
    }
    const hit = environment.paintRay(new THREE.Vector3(0, 1.6, -3), new THREE.Vector3(0, 0, 1), 0x2785ff);
    expect(hit?.surfaceId).toBe('front-polygon');
    const original = environment.getState().find(piece => piece.id === 'source-facade:source-part-0')!;
    const fixed = environment.getState().find(piece => piece.id === 'source-facade:retained')!;
    const fragment = scene.getObjectByName(original.id) as THREE.Mesh;
    const localVertices = Array.from(fragment.geometry.getAttribute('position').array);
    const result = environment.explode(new THREE.Vector3(0, 1.6, -2), 8);
    expect(result.fragments).toBe(1);
    step(0.5);
    const broken = environment.getState().find(piece => piece.id === original.id)!;
    expect(broken.dynamic).toBe(true);
    expect(broken.collisionApproximation).toContain('convex_hull');
    expect(broken.paints[0].localPoint).toEqual(original.paints[0].localPoint);
    expect(new THREE.Vector3(...broken.paints[0].worldPoint).distanceTo(new THREE.Vector3(...original.paints[0].worldPoint))).toBeGreaterThan(0.5);
    expect(Array.from(fragment.geometry.getAttribute('position').array)).toEqual(localVertices);
    expect(environment.getState().find(piece => piece.id === fixed.id)).toEqual(fixed);
    environment.reset();
    expect(environment.getState().find(piece => piece.id === original.id)!.position).toEqual(original.position);
  });

  it('AT-08: actual unload disposes geometry/materials and physics; reload rebuilds a painted moving fragment from saved local records', () => {
    const { scene, environment, world, step } = fixture();
    fence(environment);
    environment.paintRay(new THREE.Vector3(0, 1, -4), new THREE.Vector3(0, 0, 1), 0x2785ff);
    environment.explode(new THREE.Vector3(0, 1, -2));
    step(0.5);
    const before = environment.getState().filter(piece => piece.objectId === 'fence');
    const meshes = environment.meshes.filter(mesh => mesh.userData.objectId === 'fence');
    const oldGeometry = meshes[0].geometry;
    let geometryDisposals = 0; let materialDisposals = 0;
    for (const mesh of meshes) {
      mesh.geometry.addEventListener('dispose', () => geometryDisposals++);
      (mesh.material as THREE.Material).addEventListener('dispose', () => materialDisposals++);
    }
    const priorColliderCount = world.colliders.len();
    environment.unloadChunk('fence-chunk');
    expect(geometryDisposals).toBe(3);
    expect(materialDisposals).toBe(3);
    expect(world.colliders.len()).toBe(priorColliderCount - 3);
    expect(scene.getObjectByName(meshes[0].name)).toBeUndefined();
    expect(environment.meshes.some(mesh => mesh.userData.objectId === 'fence')).toBe(false);
    expect(environment.getState().filter(piece => piece.objectId === 'fence').every(piece => !piece.loaded && piece.broken && piece.colliderHandle === null)).toBe(true);
    environment.reloadChunk('fence-chunk');
    expect(world.colliders.len()).toBe(priorColliderCount);
    expect(meshes[0].geometry).not.toBe(oldGeometry);
    const restored = environment.getState().filter(piece => piece.objectId === 'fence');
    expect(restored.every(piece => piece.loaded && piece.broken && piece.dynamic)).toBe(true);
    for (const previous of before) {
      const after = restored.find(piece => piece.id === previous.id)!;
      expect(after.position).toEqual(previous.position);
      expect(after.paints.length).toBe(previous.paints.length);
      for (let i = 0; i < previous.paints.length; i++) {
        expect(after.paints[i].color).toBe(previous.paints[i].color);
        expect(after.paints[i].surfaceId).toBe(previous.paints[i].surfaceId);
        expect(new THREE.Vector3(...after.paints[i].worldPoint).distanceTo(new THREE.Vector3(...previous.paints[i].worldPoint))).toBeLessThan(0.000001);
      }
    }
    step(0.25, 0.5);
    expect(environment.getState().find(piece => piece.id === before[0].id)!.position).not.toEqual(before[0].position);
    environment.unloadChunk('fence-chunk');
    environment.update(0, 7);
    environment.reloadChunk('fence-chunk');
    expect(environment.getState().filter(piece => piece.objectId === 'fence').every(piece => piece.broken && piece.retired && piece.colliderHandle === null)).toBe(true);
    environment.reset();
    expect(environment.stats.staticColliders).toBe(4);
    expect(environment.stats.paintDecals).toBe(0);
  });

  it('AT-08/11: intact source triangle colliders really unload and reconstruct, then permanent test-chunk deletion survives reset', () => {
    const { scene, environment, world } = fixture();
    box(environment, 'source-box', [3, 4, 2], [6, 2, 0]);
    const originalCount = world.colliders.len();
    environment.unloadChunk('test');
    expect(world.colliders.len()).toBe(0);
    expect(environment.meshes).toHaveLength(0);
    environment.reloadChunk('test');
    expect(world.colliders.len()).toBe(originalCount);
    expect(scene.getObjectByName('source-box')).toBeDefined();
    fence(environment);
    environment.paintRay(new THREE.Vector3(0, 1, -4), new THREE.Vector3(0, 0, 1), 0x2785ff);
    environment.removeChunk('fence-chunk');
    environment.reset();
    expect(environment.getState().some(piece => piece.objectId === 'fence')).toBe(false);
    expect(world.colliders.len()).toBe(originalCount);
    expect(environment.stats.objects).toBe(2);
  });

  it('PAINT-07: a close stacked deck does not inherit ground paint grip', () => {
    const { environment } = fixture();
    environment.paintRay(new THREE.Vector3(0, 2, 0), new THREE.Vector3(0, -1, 0), 0x2785ff);
    environment.addStaticMesh({ id: 'low-deck', kind: 'road', chunkId: 'test',
      positions: [-3, 0.65, -3, 3, 0.65, -3, 3, 0.65, 3, -3, 0.65, 3], indices: [0, 2, 1, 0, 3, 2] });
    expect(environment.gripAt(new THREE.Vector3(0, 1, 0), 1)).toBe(1);
    expect(environment.gripAt(new THREE.Vector3(0, 0.3, 0), 1)).toBe(0.52);
  });

  it('DEST-02/PAINT-05/AT-08 actual PLATEAU bench: original source triangles remain, a painted source polygon moves and truly unloads/reloads', () => {
    const { environment, step, world } = fixture();
    const data = JSON.parse(gunzipSync(readFileSync('public/data/chunk--1_0.json.gz')).toString()) as { objects: StaticMeshSpec[] };
    const source = data.objects.find(object => object.id === 'plateau:frn_66fe84a0-eabc-4da0-8fe6-3d9cab18e19f')!;
    expect(source, 'The test requires the actual downloaded source bench; no generated substitute.').toBeDefined();
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(source.positions, 3));
    geometry.setIndex(source.indices);
    geometry.computeBoundingBox();
    const center = geometry.boundingBox!.getCenter(new THREE.Vector3());
    const origin = center.clone().add(new THREE.Vector3(0, 3, 0));
    const ray = new THREE.Raycaster(origin, new THREE.Vector3(0, -1, 0));
    const probeMaterial = new THREE.MeshBasicMaterial({ side: THREE.DoubleSide });
    const probe = new THREE.Mesh(geometry, probeMaterial);
    probe.updateMatrixWorld(true);
    const intersection = ray.intersectObject(probe)[0];
    expect(intersection).toBeDefined();
    const surface = source.surfaces!.find(range => intersection.faceIndex! * 3 >= range.start && intersection.faceIndex! * 3 < range.start + range.count)!;
    geometry.dispose(); probeMaterial.dispose();
    environment.addDestructibleMesh(source, { surfaceIds: [surface.id], maxPieces: 1 });
    const actualMeshes = environment.meshes.filter(mesh => mesh.userData.objectId === source.id);
    expect(actualMeshes.reduce((sum, mesh) => sum + mesh.geometry.index!.count, 0)).toBe(source.indices.length);
    const hit = environment.paintRay(origin, new THREE.Vector3(0, -1, 0), 0x2785ff);
    expect(hit?.surfaceId).toBe(surface.id);
    const before = environment.getState().find(piece => piece.objectId === source.id && piece.paints.some(paint => paint.surfaceId === surface.id))!;
    expect(before.verification).toBe('source_only');
    const blastPoint = new THREE.Vector3(...hit!.point).addScaledVector(new THREE.Vector3(...hit!.normal), 1);
    expect(environment.explode(blastPoint, 3).fragments).toBe(1);
    step(0.25);
    const moving = environment.getState().find(piece => piece.id === before.id)!;
    expect(moving.dynamic).toBe(true);
    const movedMetres = new THREE.Vector3(...moving.paints[0].worldPoint).distanceTo(new THREE.Vector3(...before.paints[0].worldPoint));
    expect(movedMetres).toBeGreaterThan(0.1);
    const colliderCount = world.colliders.len();
    environment.unloadChunk(source.chunkId);
    expect(world.colliders.len()).toBe(colliderCount - 2);
    environment.reloadChunk(source.chunkId);
    expect(world.colliders.len()).toBe(colliderCount);
    const reloaded = environment.getState().find(piece => piece.id === before.id)!;
    expect(reloaded.broken).toBe(true);
    expect(reloaded.dynamic).toBe(true);
    expect(reloaded.paints[0].surfaceId).toBe(surface.id);
    expect(new THREE.Vector3(...reloaded.paints[0].worldPoint).distanceTo(new THREE.Vector3(...moving.paints[0].worldPoint))).toBeLessThan(0.000001);
    console.info('SOURCE_BENCH_PHYSICS', JSON.stringify({ sourceObject: source.id, surfaceId: surface.id,
      retainedSourceIndices: source.indices.length, movedMetres, simulationSeconds: 0.25,
      colliderCountBeforeUnload: colliderCount, colliderCountAfterReload: world.colliders.len(),
      paintWorldPoint: moving.paints[0].worldPoint, restoredPaintWorldPoint: reloaded.paints[0].worldPoint,
      collisionApproximation: reloaded.collisionApproximation, rendered: false, scripted: true }));
  });

  it('DEST-03 actual chosen PLATEAU WallSurface: original source facade and paint detach while the unselected building structure stays fixed', () => {
    const { environment, world, step } = fixture();
    const manifest = JSON.parse(readFileSync('public/data/destructibles.json', 'utf8')) as {
      objects: { id: string; kind: string; sourceSemantic: string; surfaceIds?: string[]; chunk?: string }[];
    };
    const selection = manifest.objects.find(object => object.kind === 'building' && object.sourceSemantic === 'WallSurface')!;
    expect(selection, 'This requires an actual selected source WallSurface.').toBeDefined();
    const chunkPath = `public/data/${selection.chunk}.gz`;
    const chunk = JSON.parse(gunzipSync(readFileSync(chunkPath)).toString()) as { objects: StaticMeshSpec[] };
    const source = chunk.objects.find(object => object.id === selection.id)!;
    const surface = source.surfaces!.find(range => range.id === selection.surfaceIds![0])!;
    expect(surface).toBeDefined();
    expect(source.surfaces!.length).toBeGreaterThan(1);
    const vertices = source.indices.slice(surface.start, surface.start + 3).map(i =>
      new THREE.Vector3(source.positions[i * 3], source.positions[i * 3 + 1], source.positions[i * 3 + 2]));
    const target = vertices.reduce((sum, point) => sum.add(point), new THREE.Vector3()).multiplyScalar(1 / 3);
    const normal = vertices[1].clone().sub(vertices[0]).cross(vertices[2].clone().sub(vertices[0])).normalize();
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(source.positions, 3));
    geometry.setIndex(source.indices);
    const material = new THREE.MeshBasicMaterial({ side: THREE.DoubleSide });
    const probe = new THREE.Mesh(geometry, material);
    probe.updateMatrixWorld(true);
    const side = [1, -1].find(sign => {
      const ray = new THREE.Raycaster(target.clone().addScaledVector(normal, 4 * sign), normal.clone().multiplyScalar(-sign));
      const hit = ray.intersectObject(probe)[0];
      return hit && hit.faceIndex! * 3 >= surface.start && hit.faceIndex! * 3 < surface.start + surface.count;
    });
    expect(side, 'The selected source wall must be directly visible from an actual external ray.').toBeDefined();
    geometry.dispose(); material.dispose();
    const facing = normal.multiplyScalar(side!);
    environment.addDestructibleMesh(source, { surfaceIds: selection.surfaceIds, maxPieces: 1 });
    const meshes = environment.meshes.filter(mesh => mesh.userData.objectId === source.id);
    expect(meshes.reduce((sum, mesh) => sum + mesh.geometry.index!.count, 0)).toBe(source.indices.length);
    const sourcePiece = meshes.find(mesh => mesh.userData.surfaceId === surface.id)!;
    const sourceVertices = sourcePiece.geometry.getAttribute('position');
    const transformed = Array.from({ length: sourceVertices.count }, (_, i) =>
      new THREE.Vector3().fromBufferAttribute(sourceVertices, i).applyMatrix4(sourcePiece.matrixWorld));
    for (const index of new Set(source.indices.slice(surface.start, surface.start + surface.count))) {
      const point = new THREE.Vector3(source.positions[index * 3], source.positions[index * 3 + 1], source.positions[index * 3 + 2]);
      expect(Math.min(...transformed.map(vertex => vertex.distanceTo(point)))).toBeLessThan(0.000001);
    }
    const hit = environment.paintRay(target.clone().addScaledVector(facing, 4), facing.clone().negate(), 0x2785ff);
    expect(hit?.surfaceId).toBe(surface.id);
    const before = environment.getState().find(piece => piece.id === sourcePiece.name)!;
    const retained = environment.getState().find(piece => piece.objectId === source.id && piece.id.endsWith(':retained'))!;
    expect(retained.colliderHandle).not.toBeNull();
    const retainedGeometry = meshes.find(mesh => mesh.name === retained.id)!.geometry;
    const retainedPositions = Array.from(retainedGeometry.getAttribute('position').array);
    const blast = environment.explode(target.clone().addScaledVector(facing, 1.5), 12);
    expect(blast.fragments).toBe(1);
    step(0.5);
    const detached = environment.getState().find(piece => piece.id === before.id)!;
    const movedMetres = new THREE.Vector3(...detached.paints[0].worldPoint).distanceTo(new THREE.Vector3(...before.paints[0].worldPoint));
    expect(detached.dynamic).toBe(true);
    expect(movedMetres).toBeGreaterThan(0.1);
    expect(detached.paints[0].localPoint).toEqual(before.paints[0].localPoint);
    expect(environment.getState().find(piece => piece.id === retained.id)).toEqual(retained);
    expect(world.getCollider(retained.colliderHandle!)?.handle).toBe(retained.colliderHandle);
    expect(Array.from(retainedGeometry.getAttribute('position').array)).toEqual(retainedPositions);
    expect(environment.getState().filter(piece => piece.objectId === source.id).some(piece => !piece.broken)).toBe(true);
    console.info('SOURCE_FACADE_PHYSICS', JSON.stringify({ sourceObject: source.id, surfaceId: surface.id,
      sourceSemantic: selection.sourceSemantic, originalIndices: source.indices.length,
      detachableIndices: surface.count, retainedIndices: retainedGeometry.index!.count,
      movedMetres, simulationSeconds: 0.5, retainedColliderStillValid: true,
      collisionApproximation: detached.collisionApproximation, rendered: false, scripted: true }));
  });
});
