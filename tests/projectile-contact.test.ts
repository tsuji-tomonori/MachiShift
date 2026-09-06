import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import RAPIER from '@dimforge/rapier3d-compat';
import * as THREE from 'three';
import { Environment } from '../src/environment';
import { getProjectileContact, type ProjectileContact } from '../src/projectile-contact';

const worlds: RAPIER.World[] = [];
beforeAll(async () => { await RAPIER.init(); });
afterEach(() => { for (const world of worlds.splice(0)) world.free(); });
function fixture() {
  const world = new RAPIER.World({ x: 0, y: 0, z: 0 });
  world.timestep = 1 / 60; worlds.push(world);
  const scene = new THREE.Scene();
  return { world, scene, environment: new Environment(scene, world) };
}

describe('Projectile contacts use actual Rapier sphere contacts', () => {
  it.each([0, 0.7])('detects and paints a grazing contact missed by the center ray (target rotation %s)', angle => {
    const { world, environment } = fixture();
    const rotation = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), angle);
    const center = new THREE.Vector3(0.3, 0, 1).applyQuaternion(rotation);
    environment.addBreakable({ id: 'grazed-fence', chunkId: 'fixture', verification: 'game_added',
      position: center.toArray() as [number, number, number], rotationY: angle, size: [0.2, 2, 2],
      parts: [{ offset: [0, 0, 0], size: [0.2, 2, 2] }] });
    const start = new THREE.Vector3(0, 0, -2).applyQuaternion(rotation);
    const velocity = new THREE.Vector3(0, 0, 30).applyQuaternion(rotation);
    const body = world.createRigidBody(RAPIER.RigidBodyDesc.dynamic().setTranslation(start.x, start.y, start.z).setCcdEnabled(true));
    const collider = world.createCollider(RAPIER.ColliderDesc.ball(0.23).setDensity(0.15).setRestitution(0.3), body);
    body.setLinvel(velocity, true);
    let previous = start.clone(), centerRayHits = 0;
    let first: ProjectileContact | null = null;
    const ray = new THREE.Raycaster();
    for (let i = 0; i < 60; i++) {
      world.step();
      const position = new THREE.Vector3().copy(body.translation()), delta = position.clone().sub(previous);
      ray.set(previous, delta.clone().normalize()); ray.far = delta.length() + 0.35;
      centerRayHits += ray.intersectObjects(environment.paintTargets, false).length;
      const contact = getProjectileContact(world, collider);
      if (contact && !first) {
        first = contact;
        expect(contact.targetColliderHandle).toBe(environment.getState()[0].colliderHandle);
        expect(contact.point.distanceTo(new THREE.Vector3(0.2, 0, 0).applyQuaternion(rotation))).toBeLessThan(0.001);
        expect(contact.normal.dot(position.clone().sub(contact.point))).toBeGreaterThan(0);
        expect(contact.normal.length()).toBeCloseTo(1);
        const paint = environment.paintCollider(contact.targetColliderHandle, contact.point, contact.normal, 0x168aff);
        expect(paint?.objectId).toBe('grazed-fence');
        expect(paint?.decalCount).toBeGreaterThan(0);
      }
      previous = position;
    }
    expect(first).not.toBeNull();
    expect(centerRayHits).toBe(0);
    expect(environment.stats.paintEvents).toBe(1);
  });

  it('does not turn nearby speculative contacts into projectile impacts', () => {
    const { world } = fixture();
    world.createCollider(RAPIER.ColliderDesc.cuboid(1, 1, 1));
    const body = world.createRigidBody(RAPIER.RigidBodyDesc.dynamic().setTranslation(1.232, 0, 0));
    const collider = world.createCollider(RAPIER.ColliderDesc.ball(0.23), body);
    world.step();
    expect(getProjectileContact(world, collider)).toBeNull();
    world.removeRigidBody(body);
    expect(getProjectileContact(world, collider)).toBeNull();
  });

  it.each(['wall', 'deck'] as const)('preserves the contacted source face without painting the back face or other %s', kind => {
    const { world, environment } = fixture();
    const front = [-2, -2, 0, 2, -2, 0, 2, 2, 0, -2, 2, 0];
    const back = [-2, -2, 0.02, 2, -2, 0.02, 2, 2, 0.02, -2, 2, 0.02];
    const positions = [...front, ...back];
    if (kind === 'deck') for (let i = 0; i < positions.length; i += 3) {
      const y = positions[i + 1]; positions[i + 1] = -positions[i + 2]; positions[i + 2] = y;
    }
    environment.addStaticMesh({ id: 'source', kind: kind === 'deck' ? 'road' : 'wall', chunkId: 'source', positions,
      indices: [0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7],
      surfaces: [{ id: 'contacted-source-face', sourceId: 'source', start: 0, count: 6 },
        { id: 'other-source-face', sourceId: 'source', start: 6, count: 6 }] });
    const normal = kind === 'deck' ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(0, 0, -1);
    const start = normal.clone().multiplyScalar(0.24);
    const body = world.createRigidBody(RAPIER.RigidBodyDesc.dynamic().setTranslation(start.x, start.y, start.z).setCcdEnabled(true));
    const collider = world.createCollider(RAPIER.ColliderDesc.ball(0.23), body);
    body.setLinvel(normal.clone().multiplyScalar(-3), true);
    let contact: ProjectileContact | null = null;
    for (let i = 0; i < 5 && !contact; i++) { world.step(); contact = getProjectileContact(world, collider); }
    expect(contact).not.toBeNull();
    const hit = environment.paintCollider(contact!.targetColliderHandle, contact!.point, contact!.normal, 0x168aff);
    expect(hit?.surfaceId).toBe('contacted-source-face');
    const marks = environment.getState()[0].paints;
    expect(marks.length).toBeGreaterThan(0);
    expect(marks.every(mark => mark.surfaceId === 'contacted-source-face')).toBe(true);
    const source = environment.meshes[0];
    for (const decal of source.children as THREE.Mesh[]) {
      const points = decal.geometry.getAttribute('position');
      for (let i = 0; i < points.count; i++) expect(Math.abs(kind === 'deck' ? points.getY(i) : points.getZ(i))).toBeLessThan(0.000001);
    }
  });

  it('rejects unloaded and reset collider handles, then paints the current moving piece and preserves its local paint through reload', () => {
    const { world, environment } = fixture();
    environment.addBreakable({ id: 'panel', chunkId: 'panel', verification: 'game_added', position: [0, 0, 0], size: [2, 2, 0.2],
      parts: [{ offset: [0, 0, 0], size: [2, 2, 0.2] }] });
    const point = new THREE.Vector3(0, 0, -0.1), normal = new THREE.Vector3(0, 0, -1);
    const original = environment.getState()[0].colliderHandle!;
    environment.unloadChunk('panel');
    expect(environment.paintCollider(original, point, normal, 0x168aff)).toBeNull();
    environment.reloadChunk('panel'); environment.reset();
    expect(environment.paintCollider(original, point, normal, 0x168aff)).toBeNull();
    environment.explode(new THREE.Vector3(0, 0, -1), 3);
    world.step(); environment.update(1 / 60, 1 / 60);
    const moving = environment.getState()[0];
    const mesh = environment.meshes[0];
    const hitPoint = mesh.localToWorld(point.clone());
    const hitNormal = normal.clone().transformDirection(mesh.matrixWorld);
    expect(environment.paintCollider(moving.colliderHandle!, hitPoint, hitNormal, 0x168aff)?.decalCount).toBeGreaterThan(0);
    const before = environment.getState()[0].paints;
    world.step(); environment.update(1 / 60, 2 / 60);
    const after = environment.getState()[0].paints;
    expect(after[0].localPoint).toEqual(before[0].localPoint);
    expect(after[0].worldPoint).not.toEqual(before[0].worldPoint);
    environment.unloadChunk('panel'); environment.reloadChunk('panel');
    const reloaded = environment.getState()[0].paints;
    expect(reloaded).toHaveLength(after.length);
    for (let i = 0; i < after.length; i++) {
      expect(reloaded[i].surfaceId).toBe(after[i].surfaceId);
      expect(reloaded[i].color).toBe(after[i].color);
      expect(new THREE.Vector3(...reloaded[i].localPoint).distanceTo(new THREE.Vector3(...after[i].localPoint))).toBeLessThan(0.000001);
      expect(new THREE.Vector3(...reloaded[i].worldPoint).distanceTo(new THREE.Vector3(...after[i].worldPoint))).toBeLessThan(0.000001);
    }
  });
});
