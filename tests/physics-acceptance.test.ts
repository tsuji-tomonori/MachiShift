import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { beforeAll, expect, it } from 'vitest';
import RAPIER from '@dimforge/rapier3d-compat';
import * as THREE from 'three';
import { Environment, type StaticMeshSpec } from '../src/environment';
import { Race, NEUTRAL_INPUT, type RoutePoint } from '../src/race';
import { getProjectileContact } from '../src/projectile-contact';

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


const evidence: Record<string, unknown> = { testedAt: new Date().toISOString(), testSha256: createHash('sha256').update(readFileSync('tests/physics-acceptance.test.ts')).digest('hex'), environmentSha256: createHash('sha256').update(readFileSync('src/environment.ts')).digest('hex'), raceSha256: createHash('sha256').update(readFileSync('src/race.ts')).digest('hex'), schemaVersion: 1, kind: 'scripted-physical-state-and-geometry', rendered: false, humanEvaluation: false, targetHardwarePerformance: false, cases: {} };
function record(id: string, value: unknown) {
  (evidence.cases as Record<string, unknown>)[id] = value;
  mkdirSync('artifacts', { recursive: true });
  writeFileSync('artifacts/physics-acceptance.json', JSON.stringify(evidence, null, 2));
}

it('PAINT-04 acceptance: edge clipping and separately raycast visible/occluded neighbours', () => {
  const world = new RAPIER.World({x: 0, y: -9.81, z: 0}), scene = new THREE.Scene();
  const environment = new Environment(scene, world);
  const add = (id: string, x0: number, x1: number, z: number) => environment.addStaticMesh({ id, kind: 'wall', chunkId: 'synthetic-edge', verification: 'game_added',
    positions: [x0,0,z,x1,0,z,x1,4,z,x0,4,z], indices: [0,2,1,0,3,2] });
  try {
    add('left', -3, 0, 0); add('visible-right', 0.1, 3, 0); add('occluded-right', 0.1, 3, 0.3);
    for (const color of [0x2785ff, 0xff457e]) {
      const result = environment.paintRay(new THREE.Vector3(-0.2,2,-4), new THREE.Vector3(0,0,1), color);
      expect(result?.objectId).toBe('left'); expect(result?.decalCount).toBe(2);
    }
    const state = environment.getState();
    expect(state.find(p => p.id === 'occluded-right')!.paints).toHaveLength(0);
    for (const id of ['left','visible-right']) {
      const part = state.find(p => p.id === id)!;
      expect(part.paints.map(p => p.color)).toEqual([0x2785ff,0xff457e]);
      const mesh = scene.getObjectByName(id)!;
      for (const decal of mesh.children as THREE.Mesh[]) {
        const vertices = decal.geometry.getAttribute('position');
        for (let i=0;i<vertices.count;i++) {
          expect(vertices.getZ(i)).toBeCloseTo(0,5);
          expect(vertices.getX(i)).toBeGreaterThanOrEqual(id === 'left' ? -3.00001 : 0.09999);
          expect(vertices.getX(i)).toBeLessThanOrEqual(id === 'left' ? 0.00001 : 3.00001);
        }
      }
    }
    record('PAINT-04-edge', { fixture: 'explicit synthetic adjacent triangle meshes', colors: [0x2785ff,0xff457e], state, clippedVerticesChecked: true, rearNeighbourUnpainted: true });
  } finally { world.free(); }
});

it('AT-06 acceptance: a moving kart contacts explosion fragments and responds to input within three seconds', () => {
  const world = new RAPIER.World({x:0,y:-9.81,z:0}), scene = new THREE.Scene(); world.timestep=DT;
  const environment = new Environment(scene,world);
  environment.addStaticMesh({id:'floor',kind:'road',chunkId:'synthetic',verification:'game_added', positions:[-200,0,-200,200,0,-200,200,0,200,-200,0,200],indices:[0,2,1,0,3,2]});
  const race = new Race(world, [[0,0,0],[0,0,100],[100,0,100],[100,0,-100],[0,0,-100]]);
  race.reset('free');
  environment.addBreakable({id:'impact-fence',position:[-1.35,1,15],size:[8,2,0.3],chunkId:'synthetic',verification:'game_added'});
  let blastTime:number|null=null, contactTime:number|null=null, responseTime:number|null=null;
  let contactPosition:THREE.Vector3|null=null;
  const contacts:unknown[]=[];
  try {
    for (let frame=0;frame<60*12;frame++) {
      if (blastTime === null && race.player.body.translation().z > 12) {
        expect(race.player.speed).toBeGreaterThan(5);
        const blast = environment.explode(new THREE.Vector3(-1.35,1,17));
        expect(blast.fragments).toBeGreaterThan(0); blastTime=race.elapsed;
      }
      race.update(DT,{...NEUTRAL_INPUT,throttle:1,steer: contactTime===null?0:1},p=>environment.gripAt(p,race.elapsed),true);
      world.step(); race.afterStep(DT); environment.update(DT,race.elapsed);
      const debris = new Set(environment.getState().filter(p=>p.dynamic).map(p=>p.colliderHandle));
      world.contactPairsWith(race.player.collider,other=> {
        if (!debris.has(other.handle)) return;
        world.contactPair(race.player.collider,other,manifold=> {
          if (!manifold.numSolverContacts()) return;
          if (contactTime===null) {contactTime=race.elapsed;contactPosition=new THREE.Vector3().copy(race.player.body.translation());}
          contacts.push({seconds:race.elapsed,collider:other.handle,normal:manifold.normal(),points:manifold.numSolverContacts(),velocity:race.player.body.linvel()});
        });
      });
      if (contactTime!==null && responseTime===null && race.elapsed-contactTime>0.1 && race.player.grounded && Math.abs(race.player.speed)>3 && Math.abs(race.player.body.angvel().y)>0.1 && new THREE.Vector3().copy(race.player.body.translation()).distanceTo(contactPosition!)>1) responseTime=race.elapsed;
      if (responseTime!==null) break;
    }
    console.info('CONTACT_ACCEPTANCE',JSON.stringify({blastTime,contactTime,responseTime,contacts}));
    expect(contactTime).not.toBeNull(); expect(responseTime).not.toBeNull();
    expect(responseTime!-contactTime!).toBeLessThan(3);
    record('AT-06',{fixture:'synthetic controlled impact using production Race and Environment',blastTime,contactTime,responseTime,secondsToGroundedThrottleAndSteeringResponse:responseTime!-contactTime!,contacts,recoveries:race.player.recoveries});
  } finally {world.free();}
});

it('AT-07 acceptance: blue fragments and opening persist across physically driven source-course laps', async () => {
  const {stageSha256,world,environment,race,shortcutCenter}=sourceFixture();
  const original=environment.getState().filter(p=>p.objectId==='game:shortcut-gate');
  const at=race.path.sample(115), normal=new THREE.Vector3(Math.sin(Math.atan2(at.tangent.x,at.tangent.z)),0,Math.cos(Math.atan2(at.tangent.x,at.tangent.z)));
  try {
    const paint=environment.paintRay(shortcutCenter.clone().addScaledVector(normal,-4),normal,0x2785ff);
    expect(paint?.objectId).toBe('game:shortcut-gate');
    const painted=environment.getState().filter(p=>p.objectId==='game:shortcut-gate' && p.paints.length);
    expect(painted.length).toBeGreaterThan(0);
    const blast=environment.explode(shortcutCenter.clone().addScaledVector(normal,-2));
    expect(blast.destroyed).toContain('game:shortcut-gate');
    const visits:unknown[]=[]; let lastLap=0; const gripVehicles=new Set<number>();
    for(let frame=0;frame<60*350 && !race.allFinished;frame++) {
      // A real source road receives local paint on the shared driving line.
      if(frame===0) {
        const p=race.path.sample(8).position;
        const hit=environment.paintRay(p.clone().add(new THREE.Vector3(0,4,0)),new THREE.Vector3(0,-1,0),0xff457e);
        expect(hit).not.toBeNull();
      }
      race.update(DT,race.driveAI(race.player),p=>environment.gripAt(p,race.elapsed),true);
      world.step();race.afterStep(DT);environment.update(DT,race.elapsed);
      for(const v of race.vehicles) if(v.grip<1) gripVehicles.add(v.id);
      if(frame%120===0) await new Promise<void>(done=>setTimeout(done,0));
      const distance=race.path.distances[race.progressFor(race.player).lastPassed];
      if(race.player.lap>lastLap && distance>=155 && distance<190) {
        const state=environment.getState().filter(p=>p.objectId==='game:shortcut-gate');
        expect(state.every(p=>p.broken)).toBe(true);
        for(const before of painted) {
          const after=state.find(p=>p.id===before.id)!;
          expect(after.paints.map(p=>({color:p.color,localPoint:p.localPoint,surfaceId:p.surfaceId}))).toEqual(before.paints.map(p=>({color:p.color,localPoint:p.localPoint,surfaceId:p.surfaceId})));
          expect(after.paints.every(p=>p.vertices>0)).toBe(true);
          expect(new THREE.Vector3(...after.paints[0].worldPoint).distanceTo(new THREE.Vector3(...before.paints[0].worldPoint))).toBeGreaterThan(0.1);
        }
        expect(state.every(p=>p.colliderHandle===null)).toBe(true);
        visits.push({lap:race.player.lap,seconds:race.elapsed,distance,position:race.player.body.translation(),acceptedGates:race.progressFor(race.player).acceptedGates,state});
        lastLap=race.player.lap;
      }
    }
    expect(visits).toHaveLength(3);expect(race.allFinished).toBe(true);
    const afterLaps=environment.getState().filter(p=>p.objectId==='game:shortcut-gate');
    expect(afterLaps.every(p=>p.broken)).toBe(true);
    environment.reset();race.reset('race');world.step();
    const reset=environment.getState().filter(p=>p.objectId==='game:shortcut-gate');
    expect(reset.every(p=>!p.broken && p.paints.length===0 && p.colliderHandle!==null)).toBe(true);
    expect(reset.map(p=>p.position)).toEqual(original.map(p=>p.position));
    record('AT-07',{ vehiclesPassingActivePaint: [...gripVehicles].sort(), stageSha256,fixture:'actual source roads with explicitly game_added shortcut fence',scriptedPlayerInput:true,positionOrProgressEdits:false,paint,blast,visits,reset});
  } finally {world.free();}
},180000);

it('GAME-10 acceptance: source-course fall, player wrong-way recovery, and physical blockage return safely within three seconds', async () => {
  const {stageSha256,world,environment,race}=sourceFixture();
  const results:unknown[]=[];
  try {
    for(const fault of ['fall','wrong-way-manual','physical-stall'] as const) {
      race.reset('free');world.step();
      for(let i=0;i<60;i++) {race.update(DT,NEUTRAL_INPUT,()=>1,true);world.step();race.afterStep(DT);}
      const position=new THREE.Vector3().copy(race.player.body.translation());
      const gates=race.progressFor(race.player).acceptedGates, checkpoint=race.player.checkpoint;
      const barriers:RAPIER.Collider[]=[];
      if(fault==='fall') race.player.body.setTranslation(position.clone().add(new THREE.Vector3(0,-8,0)),true);
      if(fault==='wrong-way-manual') race.player.body.setRotation(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0,1,0),race.player.heading+Math.PI),true);
      if(fault==='physical-stall') {
        const ahead=new THREE.Vector3(Math.sin(race.player.heading),0,Math.cos(race.player.heading));
        const center=position.clone().addScaledVector(ahead,1.45);
        barriers.push(world.createCollider(RAPIER.ColliderDesc.cuboid(5,2,0.3).setTranslation(center.x,center.y,center.z).setRotation(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0,1,0),race.player.heading))));
      }
      world.step();
      const start=race.elapsed; let seconds:number|null=null;
      for(let frame=0;frame<180;frame++) {
        race.update(DT,{...NEUTRAL_INPUT,throttle:1,recover:fault==='wrong-way-manual'},p=>environment.gripAt(p,race.elapsed),true);
        // Check the recovery transaction before normal movement can earn a gate.
        if(race.player.recoveries>0) {
          seconds=race.elapsed-start;
          expect(race.progressFor(race.player).acceptedGates).toBe(gates);expect(race.player.checkpoint).toBe(checkpoint);
          const pos=race.player.body.translation(),rot=race.player.body.rotation();
          const overlap=world.intersectionWithShape(pos,rot,new RAPIER.Cuboid(0.5,0.3,0.8),RAPIER.QueryFilterFlags.EXCLUDE_SENSORS,undefined,undefined,race.player.body);
          expect(overlap).toBeNull();
          break;
        }
        world.step();race.afterStep(DT);
      }
      expect(seconds, fault).not.toBeNull(); expect(seconds!,fault).toBeLessThan(3);
      const recoveredAt=new THREE.Vector3().copy(race.player.body.translation());
      for(const barrier of barriers)world.removeCollider(barrier,true);
      for(let i=0;i<60;i++){race.update(DT,race.driveAI(race.player),()=>1,true);world.step();race.afterStep(DT);}
      expect(race.player.grounded).toBe(true);
      expect(new THREE.Vector3().copy(race.player.body.translation()).distanceTo(recoveredAt)).toBeGreaterThan(1);
      results.push({fault,seconds,gatesBefore:gates,checkpointBefore:checkpoint,recoveredAt:recoveredAt.toArray(),positionAfterOneSecond:race.player.body.translation(),groundedAfterOneSecond:race.player.grounded});
    }
    record('GAME-10',{stageSha256,faultInjectionOnly:true,playerWrongWayUsesRecoveryControl:true,progressNotAwardedOnRecovery:true,results});
  } finally {world.free();}
},45000);


it('DESIGN-03 acceptance: six source-course karts share paint, projectile-created debris, overtaking and the opened shortcut', async () => {
  const {stageSha256,world,environment,race,shortcutCenter}=sourceFixture();
  const paintedRoadObjects=new Set<string>(), affectedVehicles=new Set<number>();
  const overtakes:unknown[]=[], projectileContacts:unknown[]=[];
  const pairOrder=new Map<string,{leader:number;recoveries:number;seconds:number}>();
  let projectile:{body:RAPIER.RigidBody;collider:RAPIER.Collider;item:'paint'|'bomb'}|null=null;
  let paintedGate=false,destroyedGate=false,maxDynamicFragments=0;
  const tangent=race.path.sample(115).tangent;
  try {
    // Test-applied starting-grid road paint, individually raycast against actual
    // source surfaces. No grip callbacks, positions or race progress are mocked.
    for(let d=-20;d<=10;d+=2) for(const lane of [-3,-1.5,0,1.5,3]) {
      const sample=race.path.sample(d), side=new THREE.Vector3(sample.tangent.z,0,-sample.tangent.x);
      const hit=environment.paintRay(sample.position.addScaledVector(side,lane).add(new THREE.Vector3(0,4,0)),new THREE.Vector3(0,-1,0),0xff457e);
      if(hit?.gripExpiresAt) paintedRoadObjects.add(hit.objectId);
    }
    expect(paintedRoadObjects.size).toBeGreaterThan(0);
    const launch=(item:'paint'|'bomb')=> {
      // Controlled projectile-launch fixture. UI pickup/aim/throw and launchFor
      // are covered by browser acceptance, not substituted by this fixture.
      const p=shortcutCenter.clone().addScaledVector(tangent,-4);
      const body=world.createRigidBody(RAPIER.RigidBodyDesc.dynamic().setTranslation(p.x,p.y,p.z).setCcdEnabled(true));
      const collider=world.createCollider(RAPIER.ColliderDesc.ball(0.23).setDensity(0.15).setRestitution(0.3),body);
      body.setLinvel(tangent.clone().multiplyScalar(15).setY(1.5),true);
      projectile={body,collider,item};
    };
    for(let frame=0;frame<60*350 && !race.allFinished;frame++) {
      if(!projectile && !paintedGate && race.elapsed>=6) launch('paint');
      if(!projectile && paintedGate && !destroyedGate) launch('bomb');
      race.update(DT,race.driveAI(race.player),p=>environment.gripAt(p,race.elapsed),true);
      world.step();race.afterStep(DT);environment.update(DT,race.elapsed);
      for(const v of race.vehicles) if(v.grip<1) affectedVehicles.add(v.id);
      if(projectile) {
        const current=projectile as {body:RAPIER.RigidBody;collider:RAPIER.Collider;item:'paint'|'bomb'};
        const contact=getProjectileContact(world,current.collider);
        if(contact) {
          const target=environment.getState().find(p=>p.colliderHandle===contact.targetColliderHandle);
          expect(target?.objectId).toBe('game:shortcut-gate');
          const effect=current.item==='paint'
            ? environment.paintCollider(contact.targetColliderHandle,contact.point,contact.normal,0x168aff)
            : environment.explode(contact.point.clone().addScaledVector(contact.normal,0.15));
          expect(effect).not.toBeNull();
          projectileContacts.push({item:current.item,seconds:race.elapsed,targetObjectId:target!.objectId,point:contact.point.toArray(),normal:contact.normal.toArray(),effect});
          if(current.item==='paint') paintedGate=true; else destroyedGate=true;
          world.removeRigidBody(current.body);projectile=null;
        }
      }
      maxDynamicFragments=Math.max(maxDynamicFragments,environment.stats.dynamicDebris);
      // Require a real >1m pair order reversal, outside recovery transactions.
      // Finished cars are excluded so result parking cannot manufacture passes.
      if(frame%30===0) for(let a=0;a<6;a++)for(let b=a+1;b<6;b++) {
        const va=race.vehicles[a],vb=race.vehicles[b]; if(va.finished||vb.finished)continue;
        const pa=new THREE.Vector3().copy(va.body.translation()),pb=new THREE.Vector3().copy(vb.body.translation());
        const da=race.progressFor(va).rankDistance(pa),db=race.progressFor(vb).rankDistance(pb);
        if(Math.abs(da-db)<1)continue;
        const leader=da>db?a:b,key=`${a}:${b}`,recoveries=va.recoveries+vb.recoveries,previous=pairOrder.get(key);
        if(previous && previous.leader!==leader && previous.recoveries===recoveries && race.elapsed-previous.seconds<=1 && overtakes.length<20) {
          overtakes.push({seconds:race.elapsed,pair:[a,b],previousLeader:previous.leader,leader,routeProgressMetres:[da,db],positions:[pa.toArray(),pb.toArray()],recoveryCount:recoveries});
        }
        pairOrder.set(key,{leader,recoveries,seconds:race.elapsed});
      }
      if(frame%120===0) await new Promise<void>(done=>setTimeout(done,0));
    }
    const vehicles=race.vehicles.map(v=>({id:v.id,finished:v.finished,finishTime:v.finishTime,rank:v.rank,recoveries:v.recoveries,gates:race.progressFor(v).acceptedGates,distanceTravelled:v.distanceTravelled}));
    const result={stageSha256,sourceRoads:true,scriptedPlayerInput:true,positionOrProgressEdits:false,controlledProjectileLaunchNotUI:true,
      paintedRoadObjects:[...paintedRoadObjects],affectedVehicles:[...affectedVehicles].sort(),projectileContacts,maxDynamicFragments,overtakes,vehicles,
      remainingIntactGameFences:environment.getState().filter(p=>p.objectId.startsWith('game:fence:')&&!p.broken).length,
      finalShortcut:environment.getState().filter(p=>p.objectId==='game:shortcut-gate').map(p=>({id:p.id,broken:p.broken,colliderHandle:p.colliderHandle,paintCount:p.paints.length}))};
    console.info('DESIGN03_PHYSICS',JSON.stringify(result));
    expect([...affectedVehicles].sort()).toEqual([0,1,2,3,4,5]);
    expect(projectileContacts).toHaveLength(2);expect(maxDynamicFragments).toBeGreaterThan(0);
    expect(overtakes.length).toBeGreaterThan(0);expect(race.allFinished).toBe(true);
    expect(vehicles.every(v=>v.gates===race.route.length*3)).toBe(true);
    expect(result.remainingIntactGameFences).toBeGreaterThan(0);
    expect(result.finalShortcut.every(p=>p.broken && p.colliderHandle===null)).toBe(true);
    expect(result.finalShortcut.some(p=>p.paintCount>0)).toBe(true);
    record('DESIGN-03',result);
  } finally {world.free();}
},180000);
