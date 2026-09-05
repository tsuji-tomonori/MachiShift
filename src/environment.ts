import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import { DecalGeometry } from 'three/addons/geometries/DecalGeometry.js';

type Vec3 = [number, number, number];
export interface StaticMeshSpec {
  id: string; chunkId: string; kind: string; positions: number[]; indices: number[];
  color?: number | string; surfaceId?: string; verification?: string;
  surfaces?: SurfaceRange[];
}
export interface SurfaceRange { id: string; sourceId: string; start: number; count: number }
export interface BreakablePart { id?: string; offset: Vec3; size: Vec3; color?: number }
export interface BreakableSpec {
  id: string; position: Vec3; size: Vec3; rotationY?: number; color?: number;
  chunkId: string; kind?: string; verification: 'game_added' | 'source_only';
  parts?: BreakablePart[];
}
export interface PaintResult {
  objectId: string; surfaceId: string; point: Vec3; normal: Vec3;
  color: number; decalCount: number; gripExpiresAt: number | null;
}
export interface ExplosionResult { destroyed: string[]; fragments: number; occluded: number }
export interface DestructibleMeshOptions { surfaceIds?: string[]; maxPieces?: number; maxSurfaceArea?: number }

interface PaintMark {
  mesh: THREE.Mesh<THREE.BufferGeometry, THREE.MeshBasicMaterial> | null;
  eventId: number; color: number; localPoint: THREE.Vector3; surfaceId: string;
  localRay: THREE.Vector3; faceNormal: THREE.Vector3; faceIndex: number; diameter: number; vertices: number;
}
interface GeometryArchive { positions: Float32Array; normals: Float32Array; indices: Uint32Array; uv?: Float32Array }
interface Piece {
  id: string; objectId: string; surfaceId: string; chunkId: string; kind: string;
  verification: string; mesh: THREE.Mesh<THREE.BufferGeometry, THREE.MeshStandardMaterial>;
  surfaces?: SurfaceRange[];
  body: RAPIER.RigidBody | null; collider: RAPIER.Collider | null;
  initialPosition: THREE.Vector3; initialQuaternion: THREE.Quaternion;
  size: Vec3 | null; brokenAt: number | null; retired: boolean; paints: PaintMark[];
  sourceMesh?: boolean; collisionApproximation?: string; loaded?: boolean; archive?: GeometryArchive;
  collisionSkinSign?: number;
  materialArchive?: { color: number; roughness: number; metalness: number };
  parked?: { linear: Vec3; angular: Vec3; sleeping: boolean };
}
interface GripZone { center: THREE.Vector3; radius: number; expiresAt: number; surfaceId: string }

const MAX_DYNAMIC_DEBRIS = 100;
const DEBRIS_LIFETIME = 6;
const GRIP_LIFETIME = 8;
const PAINT_RADIUS = 1.6;
const UP = new THREE.Vector3(0, 1, 0);

/** Rendered surfaces, colliders and race mutations share stable object/surface IDs. */
export class Environment {
  private readonly pieces = new Map<string, Piece>();
  private readonly chunks = new Map<string, THREE.Group>();
  private readonly objectIds = new Set<string>();
  private readonly unloadedChunks = new Set<string>();
  private readonly raycaster = new THREE.Raycaster();
  private readonly splatTexture = makeSplatTexture();
  private gripZones: GripZone[] = [];
  private paintEventCount = 0;
  private elapsed = 0;

  constructor(private readonly scene: THREE.Scene, private readonly world: RAPIER.World) {}

  get meshes(): THREE.Mesh[] { return [...this.pieces.values()].filter(piece => piece.loaded !== false).map(piece => piece.mesh); }
  get paintTargets(): THREE.Mesh[] { return this.meshes; }
  get activeGripZones() {
    return this.gripZones.filter(zone => zone.expiresAt > this.elapsed)
      .map(zone => ({ ...zone, center: zone.center.clone() }));
  }

  get stats() {
    const pieces = [...this.pieces.values()];
    return {
      objects: this.objectIds.size,
      breakables: new Set(pieces.filter(p => p.size).map(p => p.objectId)).size,
      destroyed: new Set(pieces.filter(p => p.brokenAt !== null).map(p => p.objectId)).size,
      pieces: pieces.length,
      dynamicDebris: pieces.filter(p => p.brokenAt !== null && p.body !== null).length,
      retainedFragments: pieces.filter(p => p.brokenAt !== null).length,
      paintEvents: this.paintEventCount,
      paintDecals: pieces.reduce((n, p) => n + p.paints.length, 0),
      gripZones: this.gripZones.filter(z => z.expiresAt > this.elapsed).length,
      staticColliders: pieces.filter(p => p.brokenAt === null && p.collider !== null).length,
      colliderCount: pieces.filter(p => p.collider !== null).length,
      loadedPieces: pieces.filter(p => p.loaded !== false).length,
      loadedChunks: this.chunks.size - this.unloadedChunks.size,
      unloadedChunks: this.unloadedChunks.size,
    };
  }

  addStaticMesh(spec: StaticMeshSpec): void {
    this.assertNewObject(spec.id);
    if (spec.positions.length < 9 || spec.positions.length % 3 !== 0 || spec.indices.length % 3 !== 0) {
      throw new Error(`Invalid triangle mesh: ${spec.id}`);
    }
    if (spec.positions.some(v => !Number.isFinite(v)) || spec.indices.some(i => !Number.isInteger(i) || i < 0 || i >= spec.positions.length / 3)) {
      throw new Error(`Invalid coordinates or indices: ${spec.id}`);
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(spec.positions, 3));
    geometry.setIndex(spec.indices);
    geometry.computeVertexNormals();
    geometry.computeBoundingSphere();
    const mesh = new THREE.Mesh(geometry, new THREE.MeshStandardMaterial({
      color: spec.color ?? (spec.kind === 'road' ? 0x555e61 : 0xc9c4b8),
      roughness: 0.92, side: THREE.DoubleSide,
    }));
    mesh.receiveShadow = true;
    mesh.castShadow = spec.kind !== 'road';
    const collider = this.world.createCollider(RAPIER.ColliderDesc.trimesh(
      new Float32Array(spec.positions), new Uint32Array(spec.indices),
    ).setFriction(0.65));
    const piece: Piece = {
      id: spec.id, objectId: spec.id, surfaceId: spec.surfaceId ?? `${spec.id}:surface`,
      chunkId: spec.chunkId, kind: spec.kind, verification: spec.verification ?? 'source_only',
      surfaces: spec.surfaces?.map(surface => ({ ...surface })),
      mesh, body: null, collider, initialPosition: mesh.position.clone(), initialQuaternion: mesh.quaternion.clone(),
      size: null, brokenAt: null, retired: false, paints: [],
    };
    this.registerPiece(piece);
    this.objectIds.add(spec.id);
  }

  addBreakable(spec: BreakableSpec): void {
    this.assertNewObject(spec.id);
    if ([...spec.position, ...spec.size].some(v => !Number.isFinite(v)) || spec.size.some(v => v <= 0)) {
      throw new Error(`Invalid breakable dimensions: ${spec.id}`);
    }
    const parts = spec.parts?.length ? spec.parts : defaultParts(spec.size);
    const rotation = new THREE.Quaternion().setFromAxisAngle(UP, spec.rotationY ?? 0);
    const center = new THREE.Vector3(...spec.position);
    parts.forEach((part, index) => {
      if ([...part.offset, ...part.size].some(v => !Number.isFinite(v)) || part.size.some(v => v <= 0)) {
        throw new Error(`Invalid breakable part: ${spec.id}/${index}`);
      }
      const mesh = new THREE.Mesh(new THREE.BoxGeometry(...part.size), new THREE.MeshStandardMaterial({
        color: part.color ?? spec.color ?? 0xeca542, roughness: 0.7, metalness: 0.12,
        side: THREE.DoubleSide,
      }));
      mesh.position.copy(new THREE.Vector3(...part.offset).applyQuaternion(rotation).add(center));
      mesh.quaternion.copy(rotation);
      mesh.castShadow = mesh.receiveShadow = true;
      const id = part.id ?? `${spec.id}:part-${index}`;
      if (this.pieces.has(id)) throw new Error(`Duplicate part ID: ${id}`);
      const piece: Piece = {
        id, objectId: spec.id, surfaceId: `${spec.id}:surface:${index}`, chunkId: spec.chunkId,
        kind: spec.kind ?? 'fence', verification: spec.verification, mesh,
        body: null, collider: null, initialPosition: mesh.position.clone(), initialQuaternion: rotation.clone(),
        size: [...part.size], brokenAt: null, retired: false, paints: [],
      };
      this.createFixedBody(piece);
      this.registerPiece(piece);
    });
    this.objectIds.add(spec.id);
  }

  /** Detach selected original polygons without changing the source object's initial rendered shape. */
  addDestructibleMesh(spec: StaticMeshSpec, options: DestructibleMeshOptions = {}) {
    this.assertNewObject(spec.id);
    const surfaces = spec.surfaces?.length ? spec.surfaces : [{ id: spec.surfaceId ?? `${spec.id}:source-surface`,
      sourceId: spec.id, start: 0, count: spec.indices.length }];
    const maxPieces = options.maxPieces ?? (spec.kind === 'building' ? 6 : 24);
    const chosen = surfaces.filter(surface => {
      if (options.surfaceIds) return options.surfaceIds.includes(surface.id);
      const metrics = surfaceMetrics(spec, surface);
      return metrics.area > 0.005 && metrics.area <= (options.maxSurfaceArea ?? (spec.kind === 'building' ? 60 : 100))
        && (spec.kind !== 'building' || Math.abs(metrics.normal.y) < 0.8);
    }).slice(0, maxPieces);
    // A building must retain source structure even when a caller selects every available polygon.
    if (spec.kind === 'building' && chosen.length === surfaces.length) chosen.pop();
    if (!chosen.length) { this.addStaticMesh(spec); return { selectedSurfaces: [] as string[], pieceIds: [] as string[] }; }
    const chosenIds = new Set(chosen.map(surface => surface.id));
    const pieceIds: string[] = [];
    const makeSourcePiece = (ranges: SurfaceRange[], pieceId: string, detachable: boolean) => {
      const selectedIndices: number[] = [];
      const pieceSurfaces = ranges.map(range => {
        const start = selectedIndices.length;
        for (let i = range.start; i < range.start + range.count; i++) selectedIndices.push(spec.indices[i]);
        return { ...range, start, count: selectedIndices.length - start };
      });
      const used = [...new Set(selectedIndices)];
      const bounds = new THREE.Box3();
      for (const i of used) bounds.expandByPoint(new THREE.Vector3(spec.positions[i * 3], spec.positions[i * 3 + 1], spec.positions[i * 3 + 2]));
      const center = bounds.getCenter(new THREE.Vector3());
      const remap = new Map(used.map((index, i) => [index, i]));
      const positions = used.flatMap(i => [spec.positions[i * 3] - center.x,
        spec.positions[i * 3 + 1] - center.y, spec.positions[i * 3 + 2] - center.z]);
      const indices = selectedIndices.map(i => remap.get(i)!);
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
      geometry.setIndex(indices);
      geometry.computeVertexNormals();
      const mesh = new THREE.Mesh(geometry, new THREE.MeshStandardMaterial({
        color: spec.color ?? 0xc9c4b8, roughness: 0.92, side: THREE.DoubleSide,
      }));
      mesh.position.copy(center);
      mesh.castShadow = mesh.receiveShadow = true;
      const dimensions = bounds.getSize(new THREE.Vector3());
      const piece: Piece = { id: pieceId, objectId: spec.id, surfaceId: pieceSurfaces[0].id,
        surfaces: pieceSurfaces, chunkId: spec.chunkId, kind: spec.kind, verification: spec.verification ?? 'source_only',
        mesh, body: null, collider: null, initialPosition: center.clone(), initialQuaternion: mesh.quaternion.clone(),
        size: detachable ? [Math.max(0.08, dimensions.x), Math.max(0.08, dimensions.y), Math.max(0.08, dimensions.z)] : null,
        brokenAt: null, retired: false, paints: [], sourceMesh: true,
        collisionApproximation: detachable ? 'initial_exact_triangles; detached_convex_hull_with_0.04m_outward_gameplay_skin' : 'source_triangles',
      };
      if (detachable) this.createFixedBody(piece);
      else piece.collider = this.world.createCollider(RAPIER.ColliderDesc.trimesh(new Float32Array(positions), new Uint32Array(indices))
        .setTranslation(center.x, center.y, center.z).setFriction(0.65));
      this.registerPiece(piece);
      pieceIds.push(piece.id);
    };
    for (const [index, surface] of chosen.entries()) makeSourcePiece([surface], `${spec.id}:source-part-${index}`, true);
    const retained = surfaces.filter(surface => !chosenIds.has(surface.id));
    // Keep any source triangles not present in the supplied semantic ranges as immutable geometry.
    const covered = new Uint8Array(spec.indices.length);
    for (const surface of surfaces) covered.fill(1, surface.start, surface.start + surface.count);
    for (let i = 0; i < covered.length; i += 3) if (!covered[i]) retained.push({ id: `${spec.id}:unmapped:${i}`,
      sourceId: spec.id, start: i, count: 3 });
    if (retained.length) makeSourcePiece(retained, `${spec.id}:retained`, false);
    this.objectIds.add(spec.id);
    return { selectedSurfaces: chosen.map(surface => surface.id), pieceIds };
  }

  /** One central hit and independently ray-tested adjacent droplets: no volume through walls. */
  paintRay(origin: THREE.Vector3, direction: THREE.Vector3, color: number, maxDistance = 65): PaintResult | null {
    if (direction.lengthSq() < 1e-10 || !Number.isFinite(maxDistance) || maxDistance <= 0) return null;
    this.scene.updateMatrixWorld(true);
    const targets = this.meshes;
    const unit = direction.clone().normalize();
    const centerHit = this.cast(origin, unit, maxDistance, targets);
    if (!centerHit?.face) return null;
    const primary = this.pieces.get(centerHit.object.userData.pieceId as string);
    if (!primary) return null;
    const normal = this.hitNormal(centerHit, unit);
    const tangent = new THREE.Vector3().crossVectors(normal, Math.abs(normal.y) > 0.9 ? new THREE.Vector3(1, 0, 0) : UP).normalize();
    const bitangent = new THREE.Vector3().crossVectors(normal, tangent).normalize();
    const eventId = ++this.paintEventCount;
    let decalCount = 0;
    const done = new Set<string>();
    const apply = (hit: THREE.Intersection, rayDirection: THREE.Vector3, diameter: number) => {
      const piece = this.pieces.get(hit.object.userData.pieceId as string);
      if (!piece || !hit.face) return;
      const hitNormal = this.hitNormal(hit, rayDirection);
      // A single event can reach different faces, but does not stack duplicate patches on one face.
      const key = `${piece.id}:${this.surfaceAt(piece, hit)}:${hitNormal.x.toFixed(1)}:${hitNormal.y.toFixed(1)}:${hitNormal.z.toFixed(1)}`;
      if (done.has(key)) return;
      done.add(key);
      if (this.addDecal(piece, hit, rayDirection, diameter, color, eventId)) decalCount++;
    };
    apply(centerHit, unit, PAINT_RADIUS * 2);
    for (let i = 0; i < 8; i++) {
      const angle = i * Math.PI / 4;
      const target = centerHit.point.clone().addScaledVector(tangent, Math.cos(angle) * 0.9)
        .addScaledVector(bitangent, Math.sin(angle) * 0.9);
      const ray = target.sub(origin).normalize();
      const hit = this.cast(origin, ray, Math.min(maxDistance, centerHit.distance + 1.8), targets);
      if (hit && hit.point.distanceTo(centerHit.point) < PAINT_RADIUS + 0.5) apply(hit, ray, 1.9);
    }
    let gripExpiresAt: number | null = null;
    if (normal.y > 0.65 && primary.size === null) {
      gripExpiresAt = this.elapsed + GRIP_LIFETIME;
      this.gripZones.push({ center: centerHit.point.clone(), radius: PAINT_RADIUS, expiresAt: gripExpiresAt, surfaceId: this.surfaceAt(primary, centerHit) });
    }
    return { objectId: primary.objectId, surfaceId: this.surfaceAt(primary, centerHit), point: centerHit.point.toArray() as Vec3,
      normal: normal.toArray() as Vec3, color, decalCount, gripExpiresAt };
  }

  /** Arcade tuning, not a model of real structural strength or real explosive behavior. */
  explode(position: THREE.Vector3, radius = 12): ExplosionResult {
    this.scene.updateMatrixWorld(true);
    const destroyed = new Set<string>();
    let occluded = 0;
    const eligible: Piece[] = [];
    for (const piece of this.pieces.values()) {
      if (!piece.size || piece.brokenAt !== null || piece.loaded === false) continue;
      const distance = piece.mesh.position.distanceTo(position);
      if (distance > radius) continue;
      if (!this.hasLineOfSight(position, piece.mesh.position, piece.sourceMesh ? piece.id : piece.objectId)) { occluded++; continue; }
      eligible.push(piece);
    }
    // Eligibility is evaluated before any collider changes, so map iteration order cannot expose a target.
    for (const piece of eligible) {
      this.removePieceBody(piece);
      const p = piece.mesh.position;
      const body = this.createDynamicBody(piece, position);
      piece.brokenAt = this.elapsed;
      piece.retired = false;
      const away = p.clone().sub(position);
      if (away.lengthSq() < 0.01) away.set(0.5, 0.2, 1);
      away.normalize();
      if (piece.sourceMesh && piece.kind === 'building') {
        // A whole source facade polygon can be wedged between retained roof/side surfaces if
        // pushed inward. Arcade detachment gives it an outward separation impulse instead.
        away.fromBufferAttribute(piece.mesh.geometry.getAttribute('normal'), 0)
          .applyQuaternion(piece.mesh.quaternion).multiplyScalar(piece.collisionSkinSign ?? 1).normalize();
      }
      const force = Math.max(0.2, 1 - p.distanceTo(position) / radius);
      // Separate pieces acquire real linear/angular velocity and collide in the shared Rapier world.
      const mass = body.mass();
      body.applyImpulse({ x: away.x * (9 + force * 14) * mass,
        y: (5 + force * 7 + Math.max(0, away.y) * 5) * mass,
        z: away.z * (9 + force * 14) * mass }, true);
      const rotationalScale = Math.min(1, piece.size!.reduce((sum, value) => sum + value * value, 0) / 6);
      body.applyTorqueImpulse({ x: mass * 0.7 * rotationalScale, y: mass * 0.3 * rotationalScale, z: mass * -0.9 * rotationalScale }, true);
      destroyed.add(piece.objectId);
    }
    this.enforceDebrisBudget();
    return { destroyed: [...destroyed], fragments: eligible.length, occluded };
  }

  /** Occlusion uses the same triangles shown to players, including sloped real-data walls. */
  hasLineOfSight(origin: THREE.Vector3, target: THREE.Vector3, ignoreObjectId?: string): boolean {
    this.scene.updateMatrixWorld(true);
    const offset = target.clone().sub(origin);
    const distance = offset.length();
    if (distance < 0.04) return true;
    const direction = offset.normalize();
    const candidates = [...this.pieces.values()].filter(piece => piece.objectId !== ignoreObjectId && piece.id !== ignoreObjectId && !piece.retired && piece.loaded !== false).map(piece => piece.mesh);
    return this.cast(origin.clone().addScaledVector(direction, 0.025), direction, distance - 0.04, candidates) === undefined;
  }

  update(_dt: number, elapsed: number): void {
    this.elapsed = elapsed;
    for (const piece of this.pieces.values()) {
      if (piece.brokenAt === null || !piece.body) continue;
      const p = piece.body.translation();
      const q = piece.body.rotation();
      piece.mesh.position.set(p.x, p.y, p.z);
      piece.mesh.quaternion.set(q.x, q.y, q.z, q.w);
      if (elapsed - piece.brokenAt >= DEBRIS_LIFETIME) this.retire(piece);
    }
    this.gripZones = this.gripZones.filter(zone => zone.expiresAt > elapsed);
  }

  /** Rendering visibility only; neither geography nor mutations are discarded or re-created. */
  setChunkVisible(id: string, visible: boolean): void {
    const chunk = this.chunks.get(id);
    if (chunk) chunk.visible = visible;
  }

  /** Release render geometry/materials and all physics resources; retain immutable geometry and compact race state. */
  unloadChunk(id: string): void {
    const chunk = this.chunks.get(id);
    if (!chunk || this.unloadedChunks.has(id)) return;
    for (const piece of this.pieces.values()) {
      if (piece.chunkId !== id) continue;
      if (piece.body && piece.brokenAt !== null) {
        const position = piece.body.translation(); const rotation = piece.body.rotation();
        piece.mesh.position.set(position.x, position.y, position.z);
        piece.mesh.quaternion.set(rotation.x, rotation.y, rotation.z, rotation.w);
        const linear = piece.body.linvel(); const angular = piece.body.angvel();
        piece.parked = { linear: [linear.x, linear.y, linear.z], angular: [angular.x, angular.y, angular.z], sleeping: piece.body.isSleeping() };
      }
      this.removePieceBody(piece);
      for (const mark of piece.paints) {
        if (mark.mesh) {
          piece.mesh.remove(mark.mesh);
          mark.mesh.geometry.dispose();
          mark.mesh.material.dispose();
          mark.mesh = null;
        }
      }
      piece.mesh.geometry.dispose();
      piece.mesh.geometry = new THREE.BufferGeometry();
      piece.mesh.material.dispose();
      piece.mesh.removeFromParent();
      piece.mesh.updateMatrixWorld(true);
      piece.loaded = false;
    }
    chunk.removeFromParent();
    this.unloadedChunks.add(id);
  }

  /** Reconstruct released render/physics resources from immutable geometry + current race state. */
  reloadChunk(id: string): void {
    const chunk = this.chunks.get(id);
    if (!chunk || !this.unloadedChunks.has(id)) return;
    this.scene.add(chunk);
    for (const piece of this.pieces.values()) {
      if (piece.chunkId !== id) continue;
      const archive = piece.archive!;
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute('position', new THREE.BufferAttribute(archive.positions.slice(), 3));
      geometry.setAttribute('normal', new THREE.BufferAttribute(archive.normals.slice(), 3));
      if (archive.uv) geometry.setAttribute('uv', new THREE.BufferAttribute(archive.uv.slice(), 2));
      geometry.setIndex(new THREE.BufferAttribute(archive.indices.slice(), 1));
      piece.mesh.geometry.dispose();
      piece.mesh.geometry = geometry;
      piece.mesh.material = new THREE.MeshStandardMaterial({ ...piece.materialArchive!, side: THREE.DoubleSide });
      chunk.add(piece.mesh);
      piece.loaded = true;
      piece.mesh.updateMatrixWorld(true);
      if (piece.size) {
        if (piece.brokenAt === null) this.createFixedBody(piece);
        else if (piece.retired || this.elapsed - piece.brokenAt >= DEBRIS_LIFETIME) piece.retired = true;
        else {
          const body = this.createDynamicBody(piece);
          if (piece.parked) {
            const [x, y, z] = piece.parked.linear;
            const [ax, ay, az] = piece.parked.angular;
            body.setLinvel({ x, y, z }, true);
            body.setAngvel({ x: ax, y: ay, z: az }, true);
            if (piece.parked.sleeping) body.sleep();
          }
        }
      } else {
        const position = piece.mesh.position;
        piece.collider = this.world.createCollider(RAPIER.ColliderDesc.trimesh(archive.positions.slice(), archive.indices.slice())
          .setTranslation(position.x, position.y, position.z).setRotation(piece.mesh.quaternion).setFriction(0.65));
      }
      const marks = piece.paints;
      piece.paints = [];
      for (const mark of marks) {
        const point = piece.mesh.localToWorld(mark.localPoint.clone());
        const direction = mark.localRay.clone().transformDirection(piece.mesh.matrixWorld);
        const hit = { object: piece.mesh, point, faceIndex: mark.faceIndex,
          face: { a: 0, b: 0, c: 0, normal: mark.faceNormal.clone(), materialIndex: 0 }, distance: 0 } as THREE.Intersection;
        this.addDecal(piece, hit, direction, mark.diameter, mark.color, mark.eventId);
      }
    }
    this.unloadedChunks.delete(id);
    this.enforceDebrisBudget();
    this.scene.updateMatrixWorld(true);
  }

  /** Permanently remove an owned chunk, e.g. disposable load-test fixtures; reset cannot resurrect it. */
  removeChunk(id: string): void {
    const removedSurfaces = new Set<string>();
    const removedObjects = new Set<string>();
    for (const piece of [...this.pieces.values()]) {
      if (piece.chunkId !== id) continue;
      this.removePieceBody(piece);
      for (const mark of piece.paints) if (mark.mesh) {
        mark.mesh.geometry.dispose();
        mark.mesh.material.dispose();
      }
      piece.mesh.geometry.dispose();
      piece.mesh.material.dispose();
      piece.mesh.removeFromParent();
      removedSurfaces.add(piece.surfaceId);
      for (const surface of piece.surfaces ?? []) removedSurfaces.add(surface.id);
      removedObjects.add(piece.objectId);
      this.pieces.delete(piece.id);
    }
    for (const objectId of removedObjects) {
      if (![...this.pieces.values()].some(piece => piece.objectId === objectId)) this.objectIds.delete(objectId);
    }
    this.gripZones = this.gripZones.filter(zone => !removedSurfaces.has(zone.surfaceId));
    this.chunks.get(id)?.removeFromParent();
    this.chunks.delete(id);
    this.unloadedChunks.delete(id);
  }

  gripAt(position: THREE.Vector3, elapsed: number): number {
    const candidates = this.gripZones.filter(zone => zone.expiresAt > elapsed
      && Math.abs(position.y - zone.center.y) < 1.5
      && Math.hypot(position.x - zone.center.x, position.z - zone.center.z) <= zone.radius);
    if (!candidates.length) return 1;
    // Resolve the actually visible supporting surface, including close stacked decks.
    const hit = this.cast(position.clone().add(new THREE.Vector3(0, 0.12, 0)), new THREE.Vector3(0, -1, 0), 2, this.meshes);
    const piece = hit ? this.pieces.get(hit.object.userData.pieceId as string) : null;
    return hit && piece && candidates.some(zone => zone.surfaceId === this.surfaceAt(piece, hit)) ? 0.52 : 1;
  }

  reset(): void {
    for (const id of [...this.unloadedChunks]) this.reloadChunk(id);
    for (const piece of this.pieces.values()) {
      for (const mark of piece.paints) {
        if (mark.mesh) {
          piece.mesh.remove(mark.mesh);
          mark.mesh.geometry.dispose();
          mark.mesh.material.dispose();
        }
      }
      piece.paints = [];
      if (piece.size) {
        this.removePieceBody(piece);
        piece.mesh.position.copy(piece.initialPosition);
        piece.mesh.quaternion.copy(piece.initialQuaternion);
        piece.brokenAt = null;
        piece.retired = false;
        piece.parked = undefined;
        piece.collisionSkinSign = undefined;
        if (piece.sourceMesh) piece.collisionApproximation = 'initial_exact_triangles; detached_convex_hull_with_0.04m_outward_gameplay_skin';
        this.createFixedBody(piece);
      }
    }
    for (const chunk of this.chunks.values()) chunk.visible = true;
    this.gripZones = [];
    this.paintEventCount = 0;
    this.elapsed = 0;
    this.scene.updateMatrixWorld(true);
  }

  /** Copies derived from live rendered meshes / Rapier handles, for audit and test assertions. */
  getState() {
    this.scene.updateMatrixWorld(true);
    return [...this.pieces.values()].map(piece => ({
      id: piece.id, objectId: piece.objectId, surfaceId: piece.surfaceId, chunkId: piece.chunkId,
      surfaces: piece.surfaces?.map(surface => ({ ...surface })),
      kind: piece.kind, verification: piece.verification,
      sourceMesh: piece.sourceMesh ?? false, collisionApproximation: piece.collisionApproximation ?? 'cuboid_part',
      collisionSkinSign: piece.collisionSkinSign,
      loaded: piece.loaded !== false,
      broken: piece.brokenAt !== null, retired: piece.retired,
      visible: this.chunks.get(piece.chunkId)?.visible ?? true,
      position: piece.mesh.getWorldPosition(new THREE.Vector3()).toArray() as Vec3,
      rotation: piece.mesh.quaternion.toArray(),
      bodyHandle: piece.body?.handle ?? null, colliderHandle: piece.collider?.handle ?? null,
      dynamic: piece.body?.isDynamic() ?? false,
      paints: piece.paints.map(mark => ({ eventId: mark.eventId, color: mark.color,
        surfaceId: mark.surfaceId, localPoint: mark.localPoint.toArray() as Vec3,
        worldPoint: piece.mesh.localToWorld(mark.localPoint.clone()).toArray() as Vec3,
        vertices: mark.mesh?.geometry.getAttribute('position').count ?? mark.vertices,
      })),
    }));
  }

  private assertNewObject(id: string): void {
    if (this.objectIds.has(id)) throw new Error(`Duplicate object ID: ${id}`);
  }

  private registerPiece(piece: Piece): void {
    let chunk = this.chunks.get(piece.chunkId);
    if (!chunk) {
      chunk = new THREE.Group();
      chunk.name = piece.chunkId;
      this.scene.add(chunk);
      this.chunks.set(piece.chunkId, chunk);
    }
    piece.mesh.name = piece.id;
    piece.mesh.userData = { pieceId: piece.id, objectId: piece.objectId,
      surfaceId: piece.surfaceId, chunkId: piece.chunkId, verification: piece.verification, kind: piece.kind };
    chunk.add(piece.mesh);
    const geometry = piece.mesh.geometry;
    const positions = geometry.getAttribute('position'); const normals = geometry.getAttribute('normal');
    piece.archive = { positions: new Float32Array(positions.array), normals: new Float32Array(normals.array),
      indices: geometry.index ? new Uint32Array(geometry.index.array) : Uint32Array.from({ length: positions.count }, (_, i) => i),
      uv: geometry.getAttribute('uv') ? new Float32Array(geometry.getAttribute('uv').array) : undefined };
    piece.materialArchive = { color: piece.mesh.material.color.getHex(), roughness: piece.mesh.material.roughness, metalness: piece.mesh.material.metalness };
    piece.loaded = true;
    this.pieces.set(piece.id, piece);
    piece.mesh.updateMatrixWorld(true);
  }

  private createFixedBody(piece: Piece): void {
    const p = piece.initialPosition;
    piece.body = this.world.createRigidBody(RAPIER.RigidBodyDesc.fixed()
      .setTranslation(p.x, p.y, p.z).setRotation(piece.initialQuaternion));
    const desc = piece.sourceMesh ? RAPIER.ColliderDesc.trimesh(
      new Float32Array(piece.mesh.geometry.getAttribute('position').array), new Uint32Array(piece.mesh.geometry.index!.array),
    ) : RAPIER.ColliderDesc.cuboid(piece.size![0] / 2, piece.size![1] / 2, piece.size![2] / 2);
    piece.collider = this.world.createCollider(desc.setFriction(0.55), piece.body);
  }

  private createDynamicBody(piece: Piece, blastOrigin?: THREE.Vector3): RAPIER.RigidBody {
    const p = piece.mesh.position;
    const body = this.world.createRigidBody(RAPIER.RigidBodyDesc.dynamic()
      .setTranslation(p.x, p.y, p.z).setRotation(piece.mesh.quaternion)
      .setLinearDamping(0.7).setAngularDamping(0.9).setCanSleep(true).setCcdEnabled(true));
    let descriptor: RAPIER.ColliderDesc | null = null;
    if (piece.sourceMesh) {
      const vertices = piece.mesh.geometry.getAttribute('position');
      const normals = piece.mesh.geometry.getAttribute('normal');
      if (blastOrigin) {
        const worldNormal = new THREE.Vector3().fromBufferAttribute(normals, 0).applyQuaternion(piece.mesh.quaternion);
        piece.collisionSkinSign = worldNormal.dot(blastOrigin.clone().sub(piece.mesh.position)) >= 0 ? 1 : -1;
      }
      const hull: number[] = [];
      // Put the gameplay skin on the exposed side. A symmetric skin can begin inside the retained
      // source shell and pin a thin bench panel before its separating impulse is integrated.
      for (let i = 0; i < vertices.count; i++) for (const layer of [0, 1]) hull.push(
        vertices.getX(i) + normals.getX(i) * 0.04 * layer * (piece.collisionSkinSign ?? 1),
        vertices.getY(i) + normals.getY(i) * 0.04 * layer * (piece.collisionSkinSign ?? 1),
        vertices.getZ(i) + normals.getZ(i) * 0.04 * layer * (piece.collisionSkinSign ?? 1),
      );
      descriptor = RAPIER.ColliderDesc.convexHull(new Float32Array(hull));
      if (!descriptor) piece.collisionApproximation = 'initial_exact_triangles; detached_fallback_cuboid_envelope';
    }
    descriptor ??= RAPIER.ColliderDesc.cuboid(piece.size![0] / 2, piece.size![1] / 2, piece.size![2] / 2);
    piece.body = body;
    piece.collider = this.world.createCollider(descriptor.setDensity(6).setFriction(0.65).setRestitution(0.14), body);
    return body;
  }

  private removePieceBody(piece: Piece): void {
    // Rapier's JS map lookup ignores the generational bits: compare the returned handle as well.
    if (piece.body && this.world.getRigidBody(piece.body.handle)?.handle === piece.body.handle) this.world.removeRigidBody(piece.body);
    else if (piece.collider && this.world.getCollider(piece.collider.handle)?.handle === piece.collider.handle) this.world.removeCollider(piece.collider, true);
    piece.body = null;
    piece.collider = null;
  }

  private retire(piece: Piece): void {
    // Save current render transform first, then release both simulation and collision. Visible paint stays.
    this.removePieceBody(piece);
    piece.retired = true;
  }

  private enforceDebrisBudget(): void {
    const active = [...this.pieces.values()].filter(piece => piece.brokenAt !== null && piece.body !== null);
    active.sort((a, b) => volume(a.size!) - volume(b.size!) || a.brokenAt! - b.brokenAt!);
    while (active.length > MAX_DYNAMIC_DEBRIS) this.retire(active.shift()!);
  }

  private cast(origin: THREE.Vector3, direction: THREE.Vector3, distance: number, targets: THREE.Mesh[]) {
    this.raycaster.set(origin, direction);
    this.raycaster.near = 0;
    this.raycaster.far = distance;
    return this.raycaster.intersectObjects(targets, false)[0];
  }

  private hitNormal(hit: THREE.Intersection, direction: THREE.Vector3): THREE.Vector3 {
    const normal = hit.face!.normal.clone().transformDirection(hit.object.matrixWorld);
    if (normal.dot(direction) > 0) normal.negate();
    return normal;
  }

  private surfaceAt(piece: Piece, hit: THREE.Intersection): string {
    const index = (hit.faceIndex ?? 0) * 3;
    return piece.surfaces?.find(surface => index >= surface.start && index < surface.start + surface.count)?.id ?? piece.surfaceId;
  }

  private addDecal(piece: Piece, hit: THREE.Intersection, rayDirection: THREE.Vector3,
    diameter: number, color: number, eventId: number): boolean {
    const mesh = piece.mesh;
    const normal = this.hitNormal(hit, rayDirection);
    const orientation = new THREE.Euler().setFromQuaternion(new THREE.Quaternion()
      .setFromUnitVectors(new THREE.Vector3(0, 0, 1), normal));
    const sourceIndex = (hit.faceIndex ?? 0) * 3;
    const sourceSurface = piece.surfaces?.find(surface => sourceIndex >= surface.start && sourceIndex < surface.start + surface.count);
    const surfaceId = sourceSurface?.id ?? piece.surfaceId;
    const filtered = visibleFaceGeometry(mesh, hit, normal, sourceSurface);
    const proxy = new THREE.Mesh(filtered, mesh.material);
    proxy.matrixAutoUpdate = false;
    proxy.matrixWorld.copy(mesh.matrixWorld);
    const geometry = new DecalGeometry(proxy, hit.point, orientation, new THREE.Vector3(diameter, diameter, 0.08));
    filtered.dispose();
    if (geometry.getAttribute('position').count === 0) { geometry.dispose(); return false; }
    geometry.applyMatrix4(mesh.matrixWorld.clone().invert());
    const material = new THREE.MeshBasicMaterial({ color, map: this.splatTexture, transparent: true,
      opacity: 0.94, alphaTest: 0.08, depthWrite: false, polygonOffset: true,
      polygonOffsetFactor: -4, polygonOffsetUnits: -4, side: THREE.DoubleSide,
    });
    const decal = new THREE.Mesh(geometry, material);
    decal.name = `paint-${eventId}-${piece.id}`;
    decal.renderOrder = 10 + eventId;
    decal.userData = { paintEvent: eventId, objectId: piece.objectId, surfaceId };
    mesh.add(decal);
    piece.paints.push({ mesh: decal, eventId, color, localPoint: mesh.worldToLocal(hit.point.clone()), surfaceId,
      faceNormal: hit.face!.normal.clone(), faceIndex: hit.faceIndex ?? 0, diameter,
      localRay: rayDirection.clone().transformDirection(mesh.matrixWorld.clone().invert()), vertices: geometry.getAttribute('position').count });
    return true;
  }
}

/** Filter opposite-facing triangles before DecalGeometry, including walls thinner than projection depth. */
function visibleFaceGeometry(mesh: THREE.Mesh, hit: THREE.Intersection, normal: THREE.Vector3, range?: SurfaceRange): THREE.BufferGeometry {
  const source = mesh.geometry;
  const positions = source.getAttribute('position');
  const indices = source.index;
  const data: number[] = [];
  const a = new THREE.Vector3(); const b = new THREE.Vector3(); const c = new THREE.Vector3();
  const cross = new THREE.Vector3(); const edge = new THREE.Vector3();
  const authoredNormal = hit.face!.normal.clone().transformDirection(mesh.matrixWorld);
  const windingSign = authoredNormal.dot(normal) >= 0 ? 1 : -1;
  const count = indices?.count ?? positions.count;
  for (let i = 0; i < count; i += 3) {
    if (range && (i < range.start || i >= range.start + range.count)) continue;
    const ia = indices ? indices.getX(i) : i;
    const ib = indices ? indices.getX(i + 1) : i + 1;
    const ic = indices ? indices.getX(i + 2) : i + 2;
    a.fromBufferAttribute(positions, ia).applyMatrix4(mesh.matrixWorld);
    b.fromBufferAttribute(positions, ib).applyMatrix4(mesh.matrixWorld);
    c.fromBufferAttribute(positions, ic).applyMatrix4(mesh.matrixWorld);
    cross.subVectors(b, a).cross(edge.subVectors(c, a)).normalize().multiplyScalar(windingSign);
    if (cross.dot(normal) < 0.5) continue;
    // Explicitly exclude close parallel surfaces (undersides / another floor) from one face's patch.
    if (Math.abs(a.clone().sub(hit.point).dot(normal)) > 0.035
      && Math.abs(b.clone().sub(hit.point).dot(normal)) > 0.035
      && Math.abs(c.clone().sub(hit.point).dot(normal)) > 0.035) continue;
    for (const index of [ia, ib, ic]) data.push(positions.getX(index), positions.getY(index), positions.getZ(index));
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(data, 3));
  geometry.computeVertexNormals();
  return geometry;
}

function defaultParts(size: Vec3): BreakablePart[] {
  const count = Math.min(12, Math.max(3, Math.ceil(size[0] / 0.85)));
  const width = size[0] / count;
  return Array.from({ length: count }, (_, i) => ({
    offset: [(i + 0.5) * width - size[0] / 2, 0, 0] as Vec3,
    size: [width * 0.995, size[1], size[2]] as Vec3,
  }));
}

function volume(size: Vec3): number { return size[0] * size[1] * size[2]; }

function surfaceMetrics(spec: StaticMeshSpec, surface: SurfaceRange) {
  let area = 0;
  const normal = new THREE.Vector3();
  for (let i = surface.start; i < surface.start + surface.count; i += 3) {
    const points = [spec.indices[i], spec.indices[i + 1], spec.indices[i + 2]].map(index =>
      new THREE.Vector3(spec.positions[index * 3], spec.positions[index * 3 + 1], spec.positions[index * 3 + 2]));
    const cross = points[1].sub(points[0]).cross(points[2].sub(points[0]));
    area += cross.length() * 0.5;
    normal.add(cross);
  }
  return { area, normal: normal.normalize() };
}

function makeSplatTexture(): THREE.DataTexture {
  const size = 96;
  const data = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const u = (x + 0.5) / size * 2 - 1; const v = (y + 0.5) / size * 2 - 1;
    const angle = Math.atan2(v, u); const radius = Math.hypot(u, v);
    const edge = 0.80 + 0.075 * Math.sin(angle * 7) + 0.055 * Math.sin(angle * 13 + 0.8);
    const alpha = THREE.MathUtils.clamp((edge - radius) * 20, 0, 1);
    const index = (y * size + x) * 4;
    // Bright diagonal hatching makes the hazard a visible pattern as well as a color.
    const stripe = ((x + y) % 22) < 4;
    data[index] = data[index + 1] = data[index + 2] = stripe ? 245 : 195;
    data[index + 3] = Math.round(alpha * 255);
  }
  const texture = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
  texture.needsUpdate = true;
  texture.magFilter = THREE.LinearFilter;
  texture.minFilter = THREE.LinearFilter;
  return texture;
}
