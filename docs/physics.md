# Environment destruction and persistent paint

Implementation: `src/environment.ts`. Integration and regression tests: `tests/environment.test.ts`.

This is arcade gameplay. Fragment density, force, strength, lifetime and grip values do not describe real explosive effects or real structural safety. Generated fences and other fixtures carry `verification: game_added`; loading a real CityGML building does not turn a generated fence into a surveyed street fixture.

## Runtime contract

`new Environment(scene, world)` uses the caller's Three scene and Rapier world. The caller steps the shared world, then invokes `update(dt, elapsedSeconds)`. All vehicles can collide with the environment through the same physics world.

| API | Behavior |
| --- | --- |
| `addStaticMesh({id,chunkId,kind,positions,indices,color?,surfaceId?,verification?,surfaces?})` | Preserves all supplied x/y/z values and creates the corresponding triangle collider. Does not flatten a road or substitute a bounding box for a source building. |
| `surfaces: [{id,sourceId,start,count}]` | Original polygon IDs and triangle-index-buffer ranges. A hit's `faceIndex * 3` resolves the source surface and restricts its decal to that polygon. |
| `addBreakable({id,position,size,rotationY?,color?,chunkId,kind?,verification,parts?})` | Creates explicit pre-segmented box parts. Each part has its own rendered mesh and initial fixed collider. `parts` entries are `{id?,offset:[x,y,z],size:[x,y,z],color?}` in object-local coordinates. |
| `addDestructibleMesh(spec,{surfaceIds?,maxPieces?,maxSurfaceArea?})` | Selects original source polygons for detachment; renders their actual vertices and retains unselected geometry. Returns selected surface IDs and piece IDs. Buildings keep source structure even if every available surface was requested. |
| `paintRay(origin,direction,color,maxDistance=65)` | Closest hit plus eight independently ray-tested nearby droplets. Returns object/surface ID, hit point/normal, color, decal count and optional grip expiration. |
| `explode(position,radius=12)` | Returns destroyed object IDs, physically detached fragment count, and occluded fragment count. Applies no damage through an intervening intact wall. |
| `hasLineOfSight(origin,target,ignoreObjectId?)` | Render-triangle visibility for shared vehicle blast logic. Intended target object may be excluded to avoid a fragmented object's self-occlusion. |
| `gripAt(position,elapsed)` | Returns `0.52` inside active road paint, otherwise `1`. All vehicle controllers should use the same function. |
| `setChunkVisible(id,visible)` | Render culling only. Geometry, colliders and race state remain resident. This is not a claim of streaming objects out of memory or persisting them on disk. |
| `unloadChunk(id)` | Removes bodies/colliders, disposes rendered geometry/materials and decal resources, removes meshes from the scene. Keeps compact local paint records, final transform/velocities and immutable typed-array geometry. |
| `reloadChunk(id)` | Reconstructs fresh render/physics resources from saved state; broken objects do not regain their original fixed collider. Expired fragments resume without collision. |
| `removeChunk(id)` | Permanently removes an owned chunk and its archived state; disposable stress fixtures cannot reappear on reset. |
| `getState()` | Copies positions and paint attachments from real meshes, and dynamic status/handles from real Rapier objects. |
| `reset()` | Removes all paint and grip zones; removes live fragment bodies; restores original transforms/fixed colliders, visibility and event numbering. |

Original immutable geography and runtime breakable state are separate. `addStaticMesh` retains source geometry. `addBreakable` is for authored game additions. `addDestructibleMesh` retains every original visible triangle and selected polygon's original source ID; selected polygons acquire their own local coordinate frame without shape replacement. A source bench or fence uses source surfaces, not a reconstructed box. For a building, unselected surfaces remain immovable and visible. Default automatic selection limits buildings to six mostly vertical surfaces of at most 60 m², and furniture to 24 surfaces of at most 100 m²; explicit surface IDs allow curated selection.

Initial source-part colliders use exact triangle geometry. After detachment, thin surfaces receive a convex hull from their source vertices with a 4 cm skin toward the blast-exposed side so planar panels have a stable dynamic collider. This is a recorded gameplay collision approximation; it is not a measured wall thickness. Using a symmetric skin initially trapped a detached triangle inside a thin source bench; an actual source-data test detected this and the outward skin fixed it without moving visible vertices. If a hull cannot be constructed, an enclosing cuboid is explicitly recorded as fallback in `getState().collisionApproximation`. The visible shape remains original triangles in both cases. Whether the chosen original polygon describes a specific window, awning, bench component or other real object depends on the actual source metadata and inventory; the geometry API alone does not certify those categories.

## Destruction and collision

1. The blast queries each unbroken piece within 12 m against intervening rendered surfaces. Eligibility is computed before any body is removed, so iteration order does not create accidental visibility through newly removed objects.
2. The original fixed body and attached collider are removed. Each fragment receives a new dynamic body, collider, angular impulse and outward/upward impulse. Authored box parts use cuboids; source surfaces use their documented convex collision envelope. Continuous collision detection is enabled. Paint remains a child of that same mesh.
3. Dynamic debris participates in ground/vehicle collisions. At 6 seconds its final mesh transform is retained and its body/collider are removed. This keeps a settled fragment from permanently obstructing the course.
4. If more than 100 pieces would remain dynamic, the smallest pieces retire first, then the oldest among equally sized pieces. Visible fragments and their paint survive this limit; no intact blocking collider is restored.

| Tuning | Value |
| --- | --- |
| Blast radius | 12 m |
| Debris live physics | 6 s |
| Dynamic debris cap | 100 |
| Fragment density | 6 gameplay units |
| Fragment friction / restitution | 0.65 / 0.14 |
| Linear / angular damping | 0.7 / 0.9 |
| Outward impulse per unit mass | 9–23, attenuated by distance |
| Upward impulse per unit mass | 5–17, depending on distance/direction |

Angular impulse scales with the squared fragment dimensions, limiting tiny source triangles' spin instead of applying the same torque per mass to a centimetre chip and a metre panel.

Selected building facade polygons receive an outward separation impulse along the exposed surface normal. A real chosen source-wall regression found that an inward generic impulse wedged a full-height wall against retained roof/side geometry. The outward impulse makes the detached panel release through actual Rapier motion without moving its initial vertices or deleting other building colliders. This release direction is explicitly arcade tuning, not a model of how a real blast would load a real wall.

Rapier 0.19.3's JavaScript collider/body lookup map can return a replacement object for a stale generational handle with the same slot. Removal guards compare the returned object's full handle with the expected handle. A regression test externally removes one environment body, reuses its slot for a vehicle, resets, and checks that vehicle survives. Checking only `world.colliders.contains(oldHandle)` does not prove removal after slot reuse.

## Local surface paint

Paint is actual `DecalGeometry` clipped to the struck mesh and then transformed into that mesh's local coordinates. It is never a whole-object material-color replacement. The original surface ID is stored with each paint mark. Breakage changes the mesh's physical body but does not detach the paint child, preserving local registration exactly.

Before projection, opposite-facing triangles and surfaces outside the local face plane are rejected. Where original polygon ranges exist, only the struck polygon is projected. The projector has an 0.08 m depth. Each nearby droplet has its own closest-surface ray test. A thin wall's front and back can therefore be distinguished even when both lie inside projector depth. Tilted surfaces keep their original plane. New events render above old events, preserving different-color layering.

The procedural splash has an irregular edge and diagonal hatching so the marked area carries a pattern as well as color. Primary splash radius is 1.6 m. A road hit creates an 8-second grip region; paint remains visible throughout the race after this effect expires. Grip first checks horizontal distance and a 1.5 m height band, then casts down to identify the actual supporting source surface. A close upper deck therefore cannot inherit a lower floor's paint effect. This remains arcade vehicle-level grip rather than separate tire/contact-patch simulation.

## Resource unloading and restoration

Visibility culling and unloading are different operations. `setChunkVisible` only hides a group. `unloadChunk` removes its real physics bodies/colliders, detaches scene meshes, disposes each paint/base geometry and material, and replaces base geometries with empty buffers. An immutable archive of positions/normals/indices/UVs remains in typed arrays so the source can be reconstructed. Paint archives contain local hit position, face normal/index, local ray direction, diameter, color, surface ID and event number rather than retaining decal geometry.

`reloadChunk` constructs fresh Three buffers/materials and fresh physics handles at the saved transforms. Each paint decal is re-projected onto its original local surface. Intact objects receive their original fixed collider; broken fragments receive a dynamic collision envelope only if their six-second lifetime remains active. Their saved linear/angular velocities resume. If lifetime expired while unloaded, visible fragments and paint restore without collision. Offscreen physics is paused during actual unloading; these objects are not simulated while absent. The game must keep active racing areas loaded so a vehicle cannot enter an absent collision region. Stored archives are in memory; there is no claim of disk save/restart persistence.

## Evidence and limits

Run `npx vitest run tests/environment.test.ts`. These are Node integration tests using real Three geometry and the real Rapier WASM physics world, without a rendering GPU. They validate the subsystem and do not constitute full real-stage acceptance or target-PC performance certification.

| Test | Exercised behavior |
| --- | --- |
| AT-04 | Paint blue; prove base material unchanged; initially drive a dynamic body into and be blocked by the fence; explode; verify original collider handles replaced; step physical fragments; verify paint world position moves while local position stays; drive the real body through the old fence position. |
| AT-05 | Paint a 2 cm wall and inspect every decal vertex: only the hit-facing plane is covered; a separate upper floor receives no paint. |
| PAINT-04/07 | Inspect clipped decal vertices against a sloped surface equation; two colors layer; grip expires while paint remains; a different height receives no grip effect. |
| Paint provenance | Combined source mesh resolves the correct original polygon ID and retains its source ID in state. |
| DEST-06 | A wall shields three pieces while an exposed fence breaks; the same visibility method rejects a vehicle position behind the wall. |
| AT-08 / DEST-04 | Real dynamic fragments and colliders survive render culling; restoring visibility produces unchanged state; at 6 s collisions retire while broken pieces and paint stay visible. |
| AT-11 | Four fracture/reset cycles alternate active and retired bodies; initial geometry and collider count return; paint/grip are empty; unrelated vehicle bodies remain. Repeated reset is idempotent. |
| Debris budget | 120 pieces break, only 100 remain dynamic; the other 20 remain visibly broken and noncolliding. |
| Stale handles | A reused body slot cannot cause reset to remove an unrelated replacement vehicle. |
| Original source facade | A nonrectangular sloping polygon retains all initial source vertices, detaches with physically moving paint, and leaves the other source wall and its collider intact. |
| Actual resource unload | Dispose events are observed; Three scene meshes and Rapier colliders disappear. Fresh geometry/colliders reconstruct at saved positions with paint; motion resumes; expiration while unloaded restores noncolliding debris. |
| Static reload / permanent removal | Exact source triangle colliders really leave and re-enter the world. Permanent fixture removal survives reset and keeps the correct object/collider counts. |
| Close stacked deck | A second floor only 0.65 m above painted ground does not inherit the ground's grip effect. |
| Downloaded PLATEAU bench | Loads the actual `frn_66fe84a0-eabc-4da0-8fe6-3d9cab18e19f` source from the shipped compressed chunk. Preserves its source index count; paints an actual hit polygon; detaches and physically moves its paint by over 0.1 m in 0.25 s; genuinely unloads/reloads and verifies restored paint world position within 1 µm. Logs source polygon, measured movement and collider counts. |
| Chosen PLATEAU facade | Loads the first actual `WallSurface` building selection from `public/data/destructibles.json` and its original compressed source chunk. Confirms the exact selected vertices and original index total; paints and detaches that source wall; verifies real paint movement while every retained building vertex, pose and fixed collider stays unchanged. This validates wall-surface detachment, not source classification as a window or awning. |

Unverified by these local fixtures: full race/AI behavior, category-specific acceptance on the chosen real source street furniture/windows/awnings, 200-event GPU frame budgets, target-PC performance, real geography accuracy and human initial-play understanding. Real source stage and browser evidence are recorded separately by the integration owner. In-memory unload/restore is implemented and tested; disk-backed saves are not implemented.

## Official API references

Checked during implementation against the installed pinned packages and official documentation:

- [Three.js DecalGeometry](https://threejs.org/docs/pages/DecalGeometry.html)
- [Three.js official decal example](https://github.com/mrdoob/three.js/blob/r180/examples/webgl_decals.html)
- [Rapier JavaScript rigid bodies](https://rapier.rs/docs/user_guides/javascript/rigid_bodies/)
- [Rapier scene queries](https://rapier.rs/docs/user_guides/templates/scene_queries)

The hosted Rapier guide identifies its JavaScript documentation as 0.17; the implementation also checks the installed 0.19.3 declarations and executes integration tests against 0.19.3 rather than assuming guide-version equivalence.
