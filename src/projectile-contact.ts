import RAPIER from '@dimforge/rapier3d-compat';
import * as THREE from 'three';

export interface ProjectileContact {
  targetColliderHandle: number;
  /** World-space point on the contacted collider, updated through its current pose. */
  point: THREE.Vector3;
  /** Unit normal pointing out of the target, towards the projectile. */
  normal: THREE.Vector3;
}

/** Read immediately after world.step(), before removing colliders or stepping again.
 * A center ray cannot detect all contacts made by the projectile's spherical collider.
 * The narrow phase also contains merely nearby pairs; require penetration or an
 * actual solver impulse, and copy temporary manifold data before returning.
 */
export function getProjectileContact(world: RAPIER.World, projectile: RAPIER.Collider): ProjectileContact | null {
  if (world.getCollider(projectile.handle)?.handle !== projectile.handle) return null;
  const center = new THREE.Vector3().copy(projectile.translation());
  let best: ProjectileContact | null = null;
  let bestImpulse = -1;
  let bestDistance = Infinity;
  world.contactPairsWith(projectile, target => {
    if (world.getCollider(target.handle)?.handle !== target.handle || target.isSensor()) return;
    world.contactPair(projectile, target, (manifold, flipped) => {
      for (let i = 0; i < manifold.numContacts(); i++) {
        const distance = manifold.contactDist(i);
        const impulse = manifold.contactImpulse(i);
        if (distance > 0 && impulse <= 0) continue;
        // With the requested (projectile, target) order, a flipped manifold puts
        // the target in slot 1. Its local normal always points out of that target.
        const localPoint = flipped ? manifold.localContactPoint1(i) : manifold.localContactPoint2(i);
        if (!localPoint) continue;
        const localNormal = flipped ? manifold.localNormal1() : manifold.localNormal2();
        const rotation = new THREE.Quaternion().copy(target.rotation());
        const point = new THREE.Vector3().copy(localPoint).applyQuaternion(rotation).add(target.translation());
        const normal = new THREE.Vector3().copy(localNormal).applyQuaternion(rotation).normalize();
        if (![...point.toArray(), ...normal.toArray()].every(Number.isFinite) || normal.lengthSq() < 0.5) continue;
        // Multiple triangles can overlap the sphere within one step (e.g. a thin
        // wall or stacked deck). Pick the surface nearest its center, not the
        // largest solver impulse, which can belong to a surface behind it.
        const surfaceDistance = point.distanceToSquared(center);
        if (surfaceDistance > bestDistance || (surfaceDistance === bestDistance && impulse <= bestImpulse)) continue;
        best = { targetColliderHandle: target.handle, point, normal };
        bestImpulse = impulse;
        bestDistance = surfaceDistance;
      }
    });
  });
  return best;
}
