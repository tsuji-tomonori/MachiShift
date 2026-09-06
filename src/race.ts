import RAPIER from '@dimforge/rapier3d-compat';
import * as THREE from 'three';

export type RoutePoint = [number, number, number];
export interface DriveInput {
  throttle: number;
  brake: number;
  steer: number;
  drift: boolean;
  recover: boolean;
}
export const NEUTRAL_INPUT: DriveInput = Object.freeze({ throttle: 0, brake: 0, steer: 0, drift: false, recover: false });
const UP = new THREE.Vector3(0, 1, 0);
const HALF = { x: 0.73, y: 0.4, z: 1.06 };
const MAX_SPEED = 26;
const clamp = THREE.MathUtils.clamp;
const angleDifference = (a: number, b: number) => Math.atan2(Math.sin(a - b), Math.cos(a - b));

/** A closed, metre-based path. This utility does not establish surveyed accuracy. */
export class Route {
  readonly points: THREE.Vector3[];
  readonly distances: number[] = [0];
  readonly length: number;

  constructor(points: readonly RoutePoint[]) {
    this.points = points.map(p => new THREE.Vector3(...p));
    if (this.points.length > 3 && this.points[0].distanceTo(this.points.at(-1)!) < 0.01) this.points.pop();
    if (this.points.length < 3 || this.points.some(p => !Number.isFinite(p.x + p.y + p.z))) throw new Error('Route requires at least three finite metre-based points.');
    for (let i = 0; i < this.points.length; i++) {
      const length = this.points[i].distanceTo(this.points[(i + 1) % this.points.length]);
      const next = this.points[(i + 1) % this.points.length];
      if (length < 0.2 || Math.hypot(this.points[i].x - next.x, this.points[i].z - next.z) < 0.2) throw new Error('Ground route contains duplicate, vertical, or excessively close points.');
      this.distances.push(this.distances[i] + length);
    }
    this.length = this.distances.at(-1)!;
  }

  sample(distance: number): { position: THREE.Vector3; tangent: THREE.Vector3; index: number } {
    const d = THREE.MathUtils.euclideanModulo(distance, this.length);
    let index = 0;
    while (index < this.points.length - 1 && this.distances[index + 1] <= d) index++;
    const start = this.points[index], end = this.points[(index + 1) % this.points.length];
    const fraction = (d - this.distances[index]) / (this.distances[index + 1] - this.distances[index]);
    return { position: start.clone().lerp(end, fraction), tangent: end.clone().sub(start).normalize(), index };
  }

  nearest(position: THREE.Vector3): { distance: number; separation: number; position: THREE.Vector3; tangent: THREE.Vector3 } {
    let best = { distance: 0, separation: Infinity, position: this.points[0].clone(), tangent: new THREE.Vector3(0, 0, 1) };
    for (let i = 0; i < this.points.length; i++) {
      const a = this.points[i], b = this.points[(i + 1) % this.points.length];
      const delta = b.clone().sub(a);
      const flatLengthSq = delta.x * delta.x + delta.z * delta.z;
      const t = clamp(((position.x - a.x) * delta.x + (position.z - a.z) * delta.z) / flatLengthSq, 0, 1);
      const closest = a.clone().addScaledVector(delta, t);
      const separation = Math.hypot(position.x - closest.x, position.z - closest.z);
      if (separation < best.separation) best = { distance: this.distances[i] + t * delta.length(), separation, position: closest, tangent: delta.normalize() };
    }
    return best;
  }

  gateNormal(index: number): THREE.Vector3 {
    const here = this.points[index], n = this.points.length;
    const a = here.clone().sub(this.points[(index + n - 1) % n]).setY(0).normalize();
    const b = this.points[(index + 1) % n].clone().sub(here).setY(0).normalize();
    return a.add(b).normalize();
  }
}

/** Sequential swept gates, shared by physical play and logic-level tests. */
export class CourseProgress {
  checkpoint = 1;
  completedLaps = 0;
  acceptedGates = 0;
  finished = false;
  lastPassed = 0;
  previous: THREE.Vector3;
  rejectedTeleports = 0;

  constructor(readonly route: Route, start: THREE.Vector3, readonly gateHalfWidth = 8) {
    this.previous = start.clone();
  }

  reset(position: THREE.Vector3): void {
    this.checkpoint = 1; this.completedLaps = 0; this.acceptedGates = 0;
    this.lastPassed = 0; this.finished = false; this.rejectedTeleports = 0;
    this.previous.copy(position);
  }

  anchor(position: THREE.Vector3): void { this.previous.copy(position); }

  advance(position: THREE.Vector3, dt: number): boolean {
    const displacement = position.clone().sub(this.previous);
    if (displacement.length() > Math.max(2, dt * 70)) {
      this.rejectedTeleports++; this.previous.copy(position); return false;
    }
    if (this.finished) { this.previous.copy(position); return false; }
    const gate = this.route.points[this.checkpoint];
    const normal = this.route.gateNormal(this.checkpoint);
    const before = this.previous.clone().sub(gate).dot(normal);
    const after = position.clone().sub(gate).dot(normal);
    let accepted = false;
    if (before <= 0 && after > 0 && displacement.dot(normal) > 0.002) {
      const t = -before / (after - before);
      const crossing = this.previous.clone().lerp(position, t).sub(gate);
      const sideways = Math.abs(crossing.x * normal.z - crossing.z * normal.x);
      if (sideways <= this.gateHalfWidth && Math.abs(crossing.y) < 2.2) {
        this.lastPassed = this.checkpoint;
        this.checkpoint = (this.checkpoint + 1) % this.route.points.length;
        this.acceptedGates++;
        if (this.lastPassed === 0) {
          this.completedLaps++;
          this.finished = this.completedLaps >= 3;
        }
        accepted = true;
      }
    }
    this.previous.copy(position);
    return accepted;
  }

  rankDistance(position: THREE.Vector3): number {
    const i = this.lastPassed, a = this.route.points[i], b = this.route.points[this.checkpoint];
    const direction = b.clone().sub(a).setY(0);
    const along = clamp(position.clone().sub(a).dot(direction) / direction.lengthSq(), -0.1, 0.999);
    return this.completedLaps * this.route.length + this.route.distances[i] + along * (this.route.distances[i + 1] - this.route.distances[i]);
  }
}

export interface Vehicle {
  id: number;
  name: string;
  color: number;
  body: RAPIER.RigidBody;
  collider: RAPIER.Collider;
  mesh?: THREE.Group;
  heading: number;
  speed: number;
  lap: number;
  rank: number;
  finished: boolean;
  finishTime: number | null;
  boost: number;
  driftCharge: number;
  checkpoint: number;
  grounded: boolean;
  grip: number;
  recoveries: number;
  distanceTravelled: number;
}

interface DriverState {
  progress: CourseProgress;
  driftHeld: boolean;
  recoverHeld: boolean;
  stalledFor: number;
  wrongWayFor: number;
  missedGateFor: number;
  avoidLane: number;
  avoidUntil: number;
  reverseUntil: number;
  reverseAttempts: number;
  reverseAnchor: number;
  cooldown: number;
  lastPosition: THREE.Vector3;
  wheels: THREE.Object3D[];
  boostMesh?: THREE.Mesh;
}

/** Dynamic Rapier vehicles: position changes are confined to reset/recovery. */
export class Race {
  readonly path: Route;
  readonly route: RoutePoint[];
  readonly vehicles: Vehicle[] = [];
  readonly routeLength: number;
  elapsed = 0;
  mode: 'race' | 'free' = 'race';
  private running = false;
  private readonly states = new Map<number, DriverState>();

  constructor(readonly world: RAPIER.World, route: RoutePoint[], scene?: THREE.Scene) {
    this.path = new Route(route); this.route = this.path.points.map(p => [p.x, p.y, p.z]); this.routeLength = this.path.length;
    const names = ['YOU', 'AKARI', 'SORA', 'REN', 'NAGI', 'AOI'];
    const colors = [0x22d3ee, 0xff9466, 0xb0a0ff, 0xeed266, 0x7ce4ba, 0xed7fac];
    for (let id = 0; id < 6; id++) {
      const body = world.createRigidBody(RAPIER.RigidBodyDesc.dynamic().setCanSleep(false).setCcdEnabled(true).setLinearDamping(0.08).setAngularDamping(5));
      body.setEnabledRotations(false, true, false, true);
      const collider = world.createCollider(RAPIER.ColliderDesc.roundCuboid(HALF.x - 0.08, HALF.y - 0.08, HALF.z - 0.08, 0.08).setMass(180).setFriction(0.15).setRestitution(0.08), body);
      collider.setActiveEvents(RAPIER.ActiveEvents.COLLISION_EVENTS);
      const vehicle: Vehicle = { id, name: names[id], color: colors[id], body, collider, heading: 0, speed: 0, lap: 1, rank: id + 1, finished: false, finishTime: null, boost: 0, driftCharge: 0, checkpoint: 1, grounded: false, grip: 1, recoveries: 0, distanceTravelled: 0 };
      const visual = scene ? makeKart(colors[id], id) : undefined;
      if (visual) { vehicle.mesh = visual.group; scene!.add(visual.group); }
      this.vehicles.push(vehicle);
      this.states.set(id, { progress: new CourseProgress(this.path, this.path.points[0]), driftHeld: false, recoverHeld: false, stalledFor: 0, wrongWayFor: 0, missedGateFor: 0, avoidLane: 0, avoidUntil: 0, reverseUntil: 0, reverseAttempts: 0, reverseAnchor: 0, cooldown: 0, lastPosition: new THREE.Vector3(), wheels: visual?.wheels ?? [], boostMesh: visual?.boost });
    }
    this.reset('race');
  }

  get player(): Vehicle { return this.vehicles[0]; }
  get complete(): boolean { return this.player.finished; }
  get allFinished(): boolean { return this.vehicles.every(v => v.finished); }
  sampleRoute(distance: number): THREE.Vector3 { return this.path.sample(distance).position; }
  progressFor(vehicle: Vehicle): Readonly<CourseProgress> { return this.states.get(vehicle.id)!.progress; }

  reset(mode: 'race' | 'free'): void {
    this.mode = mode; this.elapsed = 0; this.running = false;
    for (const v of this.vehicles) {
      const sample = this.path.sample(-4 - Math.floor(v.id / 2) * 5);
      const side = (v.id % 2 === 0 ? -1 : 1) * 1.35;
      const position = sample.position.add(new THREE.Vector3(sample.tangent.z, 0, -sample.tangent.x).multiplyScalar(side));
      position.y += HALF.y + 0.08;
      v.body.setEnabled(mode === 'race' || v.id === 0);
      v.body.setTranslation(position, true);
      v.heading = Math.atan2(sample.tangent.x, sample.tangent.z);
      v.body.setRotation(new THREE.Quaternion().setFromAxisAngle(UP, v.heading), true);
      v.body.setLinvel({ x: 0, y: 0, z: 0 }, true); v.body.setAngvel({ x: 0, y: 0, z: 0 }, true);
      // Keep inactive AI collision shapes explicitly disabled across repeated
      // free-mode resets, including scene-query participation.
      v.collider.setEnabled(mode === 'race' || v.id === 0);
      v.speed = 0; v.lap = 1; v.rank = v.id + 1; v.finished = false; v.finishTime = null; v.boost = 0; v.driftCharge = 0; v.checkpoint = 1; v.recoveries = 0; v.distanceTravelled = 0;
      const state = this.states.get(v.id)!;
      state.progress.reset(position); state.lastPosition.copy(position); state.driftHeld = false; state.recoverHeld = false; state.stalledFor = 0; state.wrongWayFor = 0; state.missedGateFor = 0; state.avoidLane = 0; state.avoidUntil = 0; state.reverseUntil = 0; state.reverseAttempts = 0; state.reverseAnchor = 0; state.cooldown = 0;
      if (v.mesh) { v.mesh.visible = mode === 'race' || v.id === 0; v.mesh.position.copy(position); v.mesh.quaternion.copy(v.body.rotation()); }
    }
  }

  /** Apply vehicle control, then caller advances world at a fixed 1/60 s. */
  update(dt: number, playerInput: DriveInput, gripAt: (position: THREE.Vector3) => number, racing: boolean): void {
    this.running = racing;
    if (racing) this.elapsed += dt;
    for (const v of this.vehicles) {
      if (!v.body.isEnabled()) continue;
      const state = this.states.get(v.id)!;
      if (!racing) {
        const velocity = v.body.linvel();
        v.body.setLinvel({ x: 0, y: velocity.y, z: 0 }, true);
        v.body.setAngvel({ x: 0, y: 0, z: 0 }, true);
        continue;
      }
      // Finishers keep rolling with ordinary physics so they do not barricade the line.
      const input = v.id === 0 && !v.finished ? playerInput : this.driveAI(v);
      const position = new THREE.Vector3().copy(v.body.translation());
      v.heading = new THREE.Euler().setFromQuaternion(new THREE.Quaternion().copy(v.body.rotation()), 'YXZ').y;
      const forward = new THREE.Vector3(Math.sin(v.heading), 0, Math.cos(v.heading));
      const sideways = new THREE.Vector3(forward.z, 0, -forward.x);
      const velocity = new THREE.Vector3().copy(v.body.linvel());
      v.speed = velocity.dot(forward);
      const ground = this.world.castRayAndGetNormal(new RAPIER.Ray(position, { x: 0, y: -1, z: 0 }), 0.85, true, RAPIER.QueryFilterFlags.EXCLUDE_SENSORS, undefined, undefined, v.body);
      v.grounded = !!ground && ground.normal.y > 0.35;
      v.grip = clamp(gripAt(position), 0.15, 1.4);
      const throttle = clamp(input.throttle, -1, 1), brake = clamp(input.brake, 0, 1), steer = clamp(input.steer, -1, 1);
      const drifting = input.drift && v.grounded && Math.abs(v.speed) > 6 && Math.abs(steer) > 0.2;
      if (drifting) v.driftCharge = clamp(v.driftCharge + dt * 0.48 * Math.abs(steer), 0, 1);
      else if (state.driftHeld && !input.drift && v.driftCharge >= 0.24) { v.boost = 0.55 + v.driftCharge * 1.3; v.driftCharge = 0; }
      else if (!input.drift) v.driftCharge = Math.max(0, v.driftCharge - dt);
      state.driftHeld = input.drift;
      v.boost = Math.max(0, v.boost - dt);
      const topSpeed = MAX_SPEED + (v.boost > 0 ? 8 : 0);
      const power = throttle * 13.5 * clamp((topSpeed - Math.abs(v.speed)) / 5, 0, 1);
      const boostPower = v.boost > 0 && v.speed < topSpeed ? 10 : 0;
      const deceleration = Math.sign(v.speed) * (brake * 22 + 0.26 + Math.abs(v.speed) * 0.05);
      const dv = forward.clone().multiplyScalar((power + boostPower - deceleration) * dt * (v.grounded ? 1 : 0.05));
      const lateralGrip = (drifting ? 1.9 : 9) * v.grip;
      dv.addScaledVector(sideways, -velocity.dot(sideways) * Math.min(1, dt * lateralGrip) * (v.grounded ? 1 : 0.03));
      v.body.applyImpulse(dv.multiplyScalar(v.body.mass()), true);
      // Low-speed steering authority lets a bumper turn away from a contact
      // instead of requiring forward speed that the very contact prevents.
      const steeringAuthority = Math.min(1, Math.max(throttle > 0.2 ? 0.38 : 0, Math.abs(v.speed) / 5));
      const turnRate = steer * steeringAuthority * (1.75 - Math.min(0.75, Math.abs(v.speed) / 36)) * (drifting ? 1.25 : 1) * (v.speed < -0.5 ? -1 : 1) * Math.sqrt(v.grip);
      const oldTurn = v.body.angvel().y;
      v.body.setAngvel({ x: 0, y: THREE.MathUtils.lerp(oldTurn, turnRate, Math.min(1, dt * 12)), z: 0 }, true);
      state.cooldown = Math.max(0, state.cooldown - dt);
      const distance = position.distanceTo(state.lastPosition);
      state.stalledFor = throttle > 0.2 && distance < dt * 1.3 ? state.stalledFor + dt : 0;
      const near = this.path.nearest(position);
      const wrongWay = forward.dot(near.tangent) < -0.6 && Math.abs(v.speed) > 2;
      state.wrongWayFor = wrongWay ? state.wrongWayFor + dt : 0;
      // A contact can push a car around a narrow ordered gate. Return it to the
      // last legal checkpoint promptly; never let the AI earn the missing gate.
      let pathDistance = near.distance;
      const expectedDistance = state.progress.checkpoint === 0 ? this.path.length : this.path.distances[state.progress.checkpoint];
      if (state.progress.checkpoint === 0 && pathDistance < this.path.length / 2) pathDistance += this.path.length;
      if (state.progress.lastPassed === 0 && pathDistance > this.path.length / 2) pathDistance -= this.path.length;
      const gateOvershoot = pathDistance - expectedDistance;
      const missedGate = this.mode === 'race' && !v.finished && gateOvershoot > 6 && gateOvershoot < this.path.length * 0.8;
      state.missedGateFor = missedGate ? state.missedGateFor + dt : 0;
      const shouldRecover = (input.recover && !state.recoverHeld) || position.y < near.position.y - 5 || state.stalledFor > 2.25 || state.missedGateFor > 1.2 || (v.id > 0 && state.wrongWayFor > 2);
      if (shouldRecover && state.cooldown <= 0) this.recover(v);
      state.recoverHeld = input.recover;
      state.lastPosition.copy(position);
    }
  }

  /** Control decision; player and AI controls use the same dynamic body controller. */
  driveAI(vehicle: Vehicle): DriveInput {
    const position = new THREE.Vector3().copy(vehicle.body.translation());
    const near = this.path.nearest(position);
    const speed = Math.hypot(vehicle.body.linvel().x, vehicle.body.linvel().z);
    const lookahead = clamp(5 + speed * 0.43, 5, 15);
    const target = this.path.sample(near.distance + lookahead);
    const next = this.path.sample(near.distance + lookahead + 10);
    const curvature = Math.acos(clamp(near.tangent.dot(next.tangent), -1, 1));
    const state = this.states.get(vehicle.id)!;
    const clearAhead = THREE.MathUtils.euclideanModulo(state.avoidUntil - near.distance, this.path.length);
    if (clearAhead > 40 || clearAhead < 0.2) state.avoidLane = 0;
    const pathRight = new THREE.Vector3(near.tangent.z, 0, -near.tangent.x).normalize();
    const pathOrigin = near.position.clone().add(new THREE.Vector3(0, 0.6, 0));
    const staticOnly = (collider: RAPIER.Collider) => collider.parent()?.isDynamic() !== true;
    const barrier = this.world.castRay(new RAPIER.Ray(pathOrigin, near.tangent), 25, true, RAPIER.QueryFilterFlags.EXCLUDE_SENSORS, undefined, undefined, vehicle.body, staticOnly);
    // The wide lateral bypass is valid only in a locally straight corridor.
    // At a bend a tangent ray can hit an outer fence that the route turns away
    // from; ordinary fan rays steer through those corners instead.
    if (curvature > 0.18) state.avoidLane = 0;
    if (curvature <= 0.18 && barrier && barrier.timeOfImpact > 0.4 && barrier.timeOfImpact < 23) {
      const preference = state.avoidLane ? Math.sign(state.avoidLane) : (vehicle.id + vehicle.recoveries) % 2 ? -1 : 1;
      for (const sign of [preference, -preference]) {
        const offset = sign * 5.2;
        const laneOrigin = pathOrigin.clone().addScaledVector(pathRight, offset);
        const blockedLane = this.world.castRay(new RAPIER.Ray(laneOrigin, near.tangent), barrier.timeOfImpact + 5, true, RAPIER.QueryFilterFlags.EXCLUDE_SENSORS, undefined, undefined, vehicle.body, staticOnly);
        if (!blockedLane) {
          state.avoidLane = offset;
          state.avoidUntil = THREE.MathUtils.euclideanModulo(near.distance + barrier.timeOfImpact + 5, this.path.length);
          break;
        }
      }
    }
    const lane = state.avoidLane || Math.sin(vehicle.id * 2.3) * 0.85;
    if (state.avoidLane && barrier) {
      const bypassTarget = this.path.sample(near.distance + Math.min(lookahead, Math.max(4, barrier.timeOfImpact * 0.55)));
      target.position.copy(bypassTarget.position); target.tangent.copy(bypassTarget.tangent);
    }
    target.position.addScaledVector(new THREE.Vector3(target.tangent.z, 0, -target.tangent.x), lane);
    const desired = Math.atan2(target.position.x - position.x, target.position.z - position.z);
    const heading = new THREE.Euler().setFromQuaternion(new THREE.Quaternion().copy(vehicle.body.rotation()), 'YXZ').y;
    let difference = angleDifference(desired, heading);
    let obstacleDistance = Infinity;
    const forward = new THREE.Vector3(Math.sin(heading), 0, Math.cos(heading));
    const right = new THREE.Vector3(forward.z, 0, -forward.x);
    const origin = position.clone().addScaledVector(forward, 1.2);
    const rayLength = clamp(4 + speed * 0.6, 4, 18);
    const scan = (angle: number) => {
      const direction = forward.clone().applyAxisAngle(UP, angle);
      const hit = this.world.castRay(new RAPIER.Ray(origin, direction), rayLength, true, RAPIER.QueryFilterFlags.EXCLUDE_SENSORS, undefined, undefined, vehicle.body);
      return hit?.timeOfImpact ?? rayLength;
    };
    for (const offset of [-0.58, 0, 0.58]) {
      const originSide = origin.clone().addScaledVector(right, offset);
      const hit = this.world.castRay(new RAPIER.Ray(originSide, forward), rayLength, true, RAPIER.QueryFilterFlags.EXCLUDE_SENSORS, undefined, undefined, vehicle.body);
      if (hit) obstacleDistance = Math.min(obstacleDistance, hit.timeOfImpact);
    }
    if (obstacleDistance < rayLength * 0.85 && !state.avoidLane) {
      const left = scan(-0.45), rightDistance = scan(0.45);
      const followBend = curvature > 0.18 && Math.abs(difference) > 0.12;
      const avoid = followBend ? Math.sign(difference) : rightDistance > left + 0.3 ? 1 : left > rightDistance + 0.3 ? -1 : (vehicle.id + vehicle.recoveries) % 2 ? 1 : -1;
      difference += avoid * clamp((rayLength - obstacleDistance) / rayLength, 0, 1) * 0.8;
    }
    const targetSpeed = Math.min(state.avoidLane ? 17 : 24, clamp(24 - curvature * 10 - Math.abs(difference) * 3, 8, 24));
    const advanceSinceReverse = THREE.MathUtils.euclideanModulo(near.distance - state.reverseAnchor, this.path.length);
    if (state.reverseAttempts && advanceSinceReverse > 6 && advanceSinceReverse < this.path.length / 2) state.reverseAttempts = 0;
    if (obstacleDistance < 2.5 && speed < 2 && state.stalledFor > 0.3 && state.reverseUntil <= this.elapsed) {
      // Do not spend the race alternating forward and reverse at the same wall.
      if (state.reverseAttempts > 0) return { ...NEUTRAL_INPUT, throttle: 1, recover: true };
      const reverse = forward.clone().negate();
      const behind = position.clone().addScaledVector(reverse, 1.3);
      const rearHit = this.world.castRay(new RAPIER.Ray(behind, reverse), 3, true, RAPIER.QueryFilterFlags.EXCLUDE_SENSORS, undefined, undefined, vehicle.body);
      if (!rearHit) { state.reverseUntil = this.elapsed + 0.9; state.reverseAttempts++; state.reverseAnchor = near.distance; }
    }
    if (state.reverseUntil > this.elapsed) return { throttle: -0.65, brake: 0, steer: clamp(-difference * 1.7, -1, 1), drift: false, recover: false };
    // The path follower uses normal tyre grip. A blind automatic drift at a
    // roadside fence was repeatedly pushing AI cars outside their safe line.
    // Player drift still uses this exact same physical controller when requested.
    return { throttle: speed < targetSpeed + 1 ? 1 : 0, brake: speed > targetSpeed + 2 || obstacleDistance < 2 ? 0.7 : 0, steer: clamp(difference * 2.1, -1, 1), drift: false, recover: false };
  }

  /** Explicit relocation is only used for safe reset/recovery, never regular AI motion. */
  recover(vehicle: Vehicle = this.player): boolean {
    const state = this.states.get(vehicle.id)!;
    const checkpointDistance = this.path.distances[state.progress.lastPassed];
    // A blocked car needs a run-up to turn around a wide barrier. Respawning a
    // few metres behind the same bumper would repeat the identical collision.
    const recoveryRunUp = state.stalledFor > 2 || state.reverseAttempts > 0 ? 22 : 3;
    for (let step = 0; step < 10; step++) for (const lane of [0, -1.6, 1.6]) {
      const sample = this.path.sample(checkpointDistance - recoveryRunUp - step * 2.5);
      const position = sample.position.clone().addScaledVector(new THREE.Vector3(sample.tangent.z, 0, -sample.tangent.x), lane);
      const rayStart = position.clone().add(new THREE.Vector3(0, 6, 0));
      const ground = this.world.castRayAndGetNormal(new RAPIER.Ray(rayStart, { x: 0, y: -1, z: 0 }), 14, true, RAPIER.QueryFilterFlags.EXCLUDE_SENSORS, undefined, undefined, vehicle.body, c => c.parent()?.isFixed() !== false);
      if (!ground || ground.normal.y < 0.55) continue;
      position.y = rayStart.y - ground.timeOfImpact + HALF.y + 0.07;
      const heading = Math.atan2(sample.tangent.x, sample.tangent.z);
      const rotation = new THREE.Quaternion().setFromAxisAngle(UP, heading);
      const hit = this.world.intersectionWithShape(position, rotation, new RAPIER.Cuboid(HALF.x + 0.12, HALF.y - 0.01, HALF.z + 0.2), RAPIER.QueryFilterFlags.EXCLUDE_SENSORS, undefined, undefined, vehicle.body);
      if (hit) continue;
      vehicle.body.setTranslation(position, true); vehicle.body.setRotation(rotation, true);
      vehicle.body.setLinvel({ x: 0, y: 0, z: 0 }, true); vehicle.body.setAngvel({ x: 0, y: 0, z: 0 }, true);
      vehicle.heading = heading; vehicle.speed = 0; vehicle.boost = 0; vehicle.driftCharge = 0; vehicle.recoveries++;
      state.progress.anchor(position); state.lastPosition.copy(position); state.stalledFor = 0; state.wrongWayFor = 0; state.missedGateFor = 0; state.avoidLane = 0; state.avoidUntil = 0; state.reverseUntil = 0; state.reverseAttempts = 0; state.reverseAnchor = 0; state.cooldown = 1;
      return true;
    }
    return false;
  }

  afterStep(dt: number): void {
    for (const v of this.vehicles) {
      if (!v.body.isEnabled()) continue;
      const position = new THREE.Vector3().copy(v.body.translation());
      const state = this.states.get(v.id)!;
      v.heading = new THREE.Euler().setFromQuaternion(new THREE.Quaternion().copy(v.body.rotation()), 'YXZ').y;
      const velocity = v.body.linvel();
      v.speed = velocity.x * Math.sin(v.heading) + velocity.z * Math.cos(v.heading);
      if (this.running) {
        v.distanceTravelled += Math.min(position.distanceTo(state.progress.previous), dt * 70);
        if (this.mode === 'race') state.progress.advance(position, dt);
        else state.progress.anchor(position);
        v.checkpoint = state.progress.checkpoint;
        v.lap = Math.min(3, state.progress.completedLaps + 1);
        if (state.progress.finished && !v.finished) { v.finished = true; v.finishTime = this.elapsed; }
      } else state.progress.anchor(position);
      if (v.mesh) {
        v.mesh.position.copy(position); v.mesh.quaternion.copy(v.body.rotation());
        for (const wheel of state.wheels) wheel.rotateX(v.speed * dt / 0.31);
        if (state.boostMesh) { state.boostMesh.visible = v.boost > 0; state.boostMesh.scale.z = 0.9 + Math.sin(this.elapsed * 45) * 0.14; }
        const glow = v.mesh.getObjectByName('driftGlow') as THREE.Mesh | undefined;
        if (glow) { glow.visible = v.driftCharge > 0.08; (glow.material as THREE.MeshBasicMaterial).color.setHex(v.driftCharge > 0.65 ? 0xffbc55 : 0x61e8ff); glow.scale.setScalar(0.6 + v.driftCharge * 0.7); }
      }
    }
    const order = this.vehicles.slice().sort((a, b) => {
      if (a.finished && b.finished) return a.finishTime! - b.finishTime! || a.id - b.id;
      if (a.finished) return -1; if (b.finished) return 1;
      return this.states.get(b.id)!.progress.rankDistance(new THREE.Vector3().copy(b.body.translation())) - this.states.get(a.id)!.progress.rankDistance(new THREE.Vector3().copy(a.body.translation())) || a.id - b.id;
    });
    order.forEach((v, i) => { v.rank = i + 1; });
  }
}

function makeKart(color: number, id: number): { group: THREE.Group; wheels: THREE.Object3D[]; boost: THREE.Mesh } {
  const group = new THREE.Group(); group.name = `kart-${id}`;
  const bodyMaterial = new THREE.MeshStandardMaterial({ color, metalness: 0.48, roughness: 0.27 });
  const dark = new THREE.MeshStandardMaterial({ color: 0x182436, metalness: 0.25, roughness: 0.48 });
  const tireMaterial = new THREE.MeshStandardMaterial({ color: 0x15181f, roughness: 0.88 });
  const white = new THREE.MeshStandardMaterial({ color: 0xf2f7fa, metalness: 0.25, roughness: 0.32 });
  const box = (size: RoutePoint, position: RoutePoint, material: THREE.Material) => {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(...size), material); mesh.position.set(...position); mesh.castShadow = true; mesh.receiveShadow = true; group.add(mesh); return mesh;
  };
  box([1.18, 0.3, 1.85], [0, -0.06, 0], dark);
  box([1.03, 0.26, 0.88], [0, 0.13, 0.55], bodyMaterial).rotation.x = -0.13;
  box([0.14, 0.27, 0.85], [0, 0.147, 0.57], white).rotation.x = -0.13;
  box([0.25, 0.38, 1.36], [-0.53, 0.1, -0.16], bodyMaterial);
  box([0.25, 0.38, 1.36], [0.53, 0.1, -0.16], bodyMaterial);
  box([1.58, 0.16, 0.17], [0, -0.06, 1.06], dark);
  box([1.45, 0.11, 0.37], [0, 0.61, -0.95], bodyMaterial);
  box([0.07, 0.56, 0.08], [-0.48, 0.31, -0.95], dark);
  box([0.07, 0.56, 0.08], [0.48, 0.31, -0.95], dark);
  box([0.54, 0.6, 0.22], [0, 0.36, -0.48], dark).rotation.x = -0.15;
  const torso = new THREE.Mesh(new THREE.CapsuleGeometry(0.22, 0.23, 4, 10), white); torso.position.set(0, 0.48, -0.2); torso.castShadow = true; group.add(torso);
  const helmet = new THREE.Mesh(new THREE.SphereGeometry(0.31, 20, 14), bodyMaterial); helmet.position.set(0, 0.95, -0.15); helmet.castShadow = true; group.add(helmet);
  const visor = new THREE.Mesh(new THREE.SphereGeometry(0.319, 16, 10, -Math.PI / 2, Math.PI, Math.PI * 0.29, Math.PI * 0.29), new THREE.MeshStandardMaterial({ color: 0x10243c, metalness: 0.78, roughness: 0.14 })); visor.position.copy(helmet.position); group.add(visor);
  const wheels: THREE.Object3D[] = [];
  for (const x of [-0.74, 0.74]) for (const z of [-0.7, 0.67]) {
    const axle = new THREE.Group(); axle.position.set(x, -0.065, z); group.add(axle);
    const tire = new THREE.Mesh(new THREE.CylinderGeometry(0.31, 0.31, 0.29, 14), tireMaterial); tire.rotation.z = Math.PI / 2; tire.castShadow = true; axle.add(tire);
    const hub = new THREE.Mesh(new THREE.CylinderGeometry(0.17, 0.17, 0.3, 8), white); hub.rotation.z = Math.PI / 2; axle.add(hub); wheels.push(axle);
  }
  const lightMaterial = new THREE.MeshBasicMaterial({ color: 0xbef9ff });
  box([0.2, 0.07, 0.035], [-0.35, 0.16, 0.98], lightMaterial);
  box([0.2, 0.07, 0.035], [0.35, 0.16, 0.98], lightMaterial);
  const boost = new THREE.Mesh(new THREE.ConeGeometry(0.18, 1.25, 10), new THREE.MeshBasicMaterial({ color: 0x65ecff, transparent: true, opacity: 0.8 }));
  boost.rotation.x = -Math.PI / 2; boost.position.set(0, 0.03, -1.63); boost.visible = false; group.add(boost);
  const glow = new THREE.Mesh(new THREE.TorusGeometry(0.65, 0.035, 5, 20), new THREE.MeshBasicMaterial({ color: 0x61e8ff }));
  glow.name = 'driftGlow'; glow.rotation.x = Math.PI / 2; glow.position.set(0, -0.32, -0.47); glow.visible = false; group.add(glow);
  return { group, wheels, boost };
}
