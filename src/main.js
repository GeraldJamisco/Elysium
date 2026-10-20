import * as THREE from 'three';
import { Timer } from 'three';
import { scene, camera, renderer, controls, initRenderer, startLoop, setOrbitConfig } from './scene.js';
import { buildGlobe, pickPin, pins, getPinScreen, state, buildStars } from './globe.js';
import { planetMaps } from './planetmaps.js';
import { buildAtmosphere, skyState } from './atmosphere.js';
import { buildTown, ground, finalizeGround, authoredStreetSegments } from './city/layout.js';
import { buildBuildings, buildingRegistry } from './city/buildings.js';
import { buildStreetKit } from './city/citykit.js';
import { buildDistrict, district, districtSummary } from './city/district.js';
import { finalizeArchitecture } from './city/architecture.js';
import { buildInteriors, setInteriorContext, LOUNGE_INTERIOR, enterInterior, exitInterior } from './city/interiors.js';
import { ProceduralWorld } from './procedural/chunk.js';
import { segmentsNear, ROAD, ensureSettlementRoads } from './procedural/roads.js';
import { walkLocation } from './nav/locator.js';
import { parcelsNear, setParcelTrace } from './procedural/parcels.js';
import { zoneAt, ZONE, clusterAt } from './procedural/zones.js';
import { fieldBoundaries, classifyBoundary, BOUNDARY, utilityCorridors, corridorPoleCount, utilityPoles, corridorPoles } from './procedural/ruralinfra.js';
import { allJunctions, junctionSummary } from './procedural/junctions.js';
import { buildPeople, updatePeople, peopleState, peopleSummary, activityFor } from './city/people.js';
import { buildPedNet, pedNet } from './city/pednet.js';
import { developmentAt, reservationAt, insideAuthoredTown, BAND, allSettlements } from './procedural/settlement.js';
import {
  updateCams, setupWalkCtrls, setOrbit, ws, stageState, eagle,
  enterWalk, exitWalk, enterEagle, exitToOrbit, applyEagleCam,
  setHUD, setTransitionHUD, setCrosshair, showDescendHint, setTransition, hideHint, isTyping,
  TRANSITION_HUD_ORBIT_EAGLE, TRANSITION_HUD_EAGLE_WALK,
  TRANSITION_HUD_WALK_EAGLE, TRANSITION_HUD_EAGLE_ORBIT,
} from './cameraControls.js';
import { STAGES, ORBIT, PROC, ATMOS } from './config.js';
import { collisionRegistry } from './city/collision.js';
import './nav/nav.css';
import './style.css';
import {
  initSurvey, updateLocator, updateLabels, setStage as setNavStage,
  setNavBusy, select as selectSite, clearSelection, hasSelection,
  capturePreviews, setWaypoint, getWaypoint,
} from './nav/survey.js';
import { setViewfinderContext } from './nav/viewfinder.js';
import { settledSite } from './nav/places.js';
import { initSearch, setSearchStage, searchIsOpen, setOpen as setSearchOpen } from './nav/search.js';
import { planetMaps as _pm } from './planetmaps.js';

// ============================================================
// ELYSIUM — Phase 1
// STAGE LOOP RELIABILITY
//
// ORBIT → EAGLE → WALK → EAGLE → ORBIT
//
// Input gating: all stage-changing actions (F, Enter, ESC,
//   pin click, pointer drag) are blocked while
//   stageState.transition is true.
// Scenes: ground (town) visible only in EAGLE / WALK.
//         globeGroup visible only in ORBIT.
// HUD updates on every stage change.
// ============================================================

initRenderer();
setInteriorContext(renderer, scene);
const timer = new Timer();

const globeGroup = buildGlobe();
buildStars();
buildAtmosphere();
ground.visible = false;
// Worldbuilding order matters: buildings, street furniture and planting all
// push into one shared geometry accumulator, and the two finalize calls merge
// everything into a handful of static meshes. Nothing may be pushed after them.
buildTown();
buildBuildings();
// Phase 8: derive the district's spatial relationships and build the ground
// they imply.  It runs BETWEEN placement and planting because the planting
// pass has to know which ground is a path and keep off it.
buildDistrict();
// Phase 7: procedural planetary infrastructure — generates roads, buildings,
// and landscape on-demand in chunks radiating from Veridian Cap.
//
// init() is here, BEFORE the planting pass, because it builds the road
// GRAPH and no geometry — it pushes nothing into the architecture
// accumulators, so it is safe this early.  The avenue's formal tree row
// has to be able to ask where the procedural roads are: run after
// planting, the answer was an empty network, the guard matched nothing
// and four trees were left standing in a carriageway.
const procWorld = new ProceduralWorld();
procWorld.init();

buildStreetKit();
finalizeArchitecture(ground);
finalizeGround();

// Phase 6: build enterable interiors after world assembly so they form their own
// meshes (separate from the town-wide architecture buckets) and can be toggled.
buildInteriors();

// Phase 10A: human presence.  Built last and kept entirely separate —
// people READ the district, the road graph and the pedestrian network,
// and nothing in those layers knows they exist.
buildPeople(scene, allJunctions());

// The navigation layer photographs the real world for its previews, so the
// captures have to happen while the surface scenery is assembled and lit —
// before the opening swap to orbit hides it again.
setViewfinderContext(renderer, scene);
setScenery('surface');
capturePreviews();

// Opening state: orbit. Routed through the same swap the stage changes use,
// so there is exactly one place that decides what a stage looks like.
setScenery('orbit');

// ============================================================
// NAVIGATION
// ============================================================

const planetStats = _pm().stats;

initSurvey({
  planetFacts: [
    `${planetStats.landPercent}% land`,
    'Temperate · abundant life',
    '10 sites charted · 1 settled',
  ],
  buildingCount: buildingRegistry.length,
  onFocus: site => focusGlobeOn(site),
  onSelect: () => {},
  onDescend: site => { if (site && site.settled) onDescendFromCard(); },
});

initSearch({ onGo: place => goToPlace(place) });

// ============================================================
// TRAVELLING TO A NAMED PLACE
//
// What "go here" means depends on where the player is standing.
//
//   EAGLE  the survey camera eases across to look at the place, and
//          descending from there arrives AT it rather than at the
//          settlement's default spawn.
//   WALK   the player is on foot, so they are given a bearing and a
//          distance and they walk. Teleporting would be faster and
//          would quietly undo the thing the whole world is built on:
//          that these places are a real distance apart.
// ============================================================

let pendingArrival = null;

function goToPlace(place) {
  if (!place) return;
  if (stageState.current === 'eagle') {
    pendingArrival = place.arrive || null;
    easeEagleTo(place.at[0], place.at[1]);
    setWaypoint(null);
    toast(place.name + ' · press F to arrive');
  } else if (ws.active) {
    pendingArrival = null;
    setWaypoint(place, () => toast('Waypoint cleared'));
    toast('Guiding to ' + place.name);
  }
}

// ---- Easing the eagle target ----
const eagleEase = { active: false, fx: 0, fz: 0, tx: 0, tz: 0, t: 0, dur: 1.1 };

function easeEagleTo(x, z) {
  const hw = STAGES.eagle.surveyHalfWidth;
  const hd = STAGES.eagle.surveyHalfDepth;
  eagleEase.fx = eagle.target.x;
  eagleEase.fz = eagle.target.z;
  // The survey envelope is the same clamp WASD panning obeys, so search can
  // never put the camera somewhere the controls could not reach.
  eagleEase.tx = Math.max(-hw, Math.min(hw, x));
  eagleEase.tz = Math.max(-hd, Math.min(hd, z));
  eagleEase.t = 0;
  eagleEase.active = true;
}

function updateEagleEase(dt) {
  // The ease drives applyEagleCam, which OWNS the camera. Left running after
  // a descend it hauls the walking player back up to the survey position
  // every frame, so it has to stop the moment the stage does.
  if (eagleEase.active && stageState.current !== 'eagle') eagleEase.active = false;
  if (!eagleEase.active) return;
  eagleEase.t = Math.min(1, eagleEase.t + dt / eagleEase.dur);
  const e = eagleEase.t < 0.5
    ? 4 * eagleEase.t ** 3
    : 1 - Math.pow(-2 * eagleEase.t + 2, 3) / 2;
  eagle.target.x = eagleEase.fx + (eagleEase.tx - eagleEase.fx) * e;
  eagle.target.z = eagleEase.fz + (eagleEase.tz - eagleEase.fz) * e;
  applyEagleCam();
  if (eagleEase.t >= 1) eagleEase.active = false;
}

// ---- Easing the planet to face a site ----
// Selecting a place should TURN THE WORLD to show it, not cut to it. The
// globe only ever rotates about its own axis, so the target angle is the
// difference between where the site points and where the camera is.
const globeSpin = { active: false, from: 0, to: 0, t: 0, dur: 1.15 };

function focusGlobeOn(site) {
  if (!site || stageState.current !== 'orbit') return;
  const pin = pins.find(q => q.data.name === site.name);
  if (!pin) return;
  const camAngle = Math.atan2(camera.position.z, camera.position.x);
  const pinAngle = Math.atan2(pin.dir.z, pin.dir.x);
  // A rotation of a about Y maps a point at angle phi to (phi - a), so the
  // rotation that brings this pin to the camera is (pin - camera).
  let to = pinAngle - camAngle;
  const from = globeGroup.rotation.y;
  // Shortest way round, so the planet never spins the long way for a
  // one-degree correction.
  while (to - from > Math.PI) to -= Math.PI * 2;
  while (to - from < -Math.PI) to += Math.PI * 2;
  globeSpin.from = from;
  globeSpin.to = to;
  globeSpin.t = 0;
  globeSpin.active = true;
}

function updateGlobeSpin(dt) {
  if (!globeSpin.active) return false;
  globeSpin.t = Math.min(1, globeSpin.t + dt / globeSpin.dur);
  const e = globeSpin.t < 0.5
    ? 4 * globeSpin.t ** 3
    : 1 - Math.pow(-2 * globeSpin.t + 2, 3) / 2;
  globeGroup.rotation.y = globeSpin.from + (globeSpin.to - globeSpin.from) * e;
  if (globeSpin.t >= 1) globeSpin.active = false;
  return true;
}

function onDescendFromCard() {
  const pin = pins.find(q => q.data.real);
  if (pin) onPinClick(pin);
}

// ---- Start in Orbit ----
camera.position.set(STAGES.orbit.cameraPos[0], STAGES.orbit.cameraPos[1], STAGES.orbit.cameraPos[2]);
camera.lookAt(0, 0, 0);
// Aim slightly above the planet center so the planet sits a touch below-center
// in the opening frame, giving the feeling of observing a planet in space.
// OrbitControls.target stays planet-centered so user interaction re-centers normally.
camera.lookAt(0, 12, 0);
setOrbitConfig({
  target: STAGES.orbit.target,
  minDist: STAGES.orbit.minDist,
  maxDist: STAGES.orbit.maxDist,
  enablePan: STAGES.orbit.enablePan,
});
setOrbit(true);
setHUD('AMARINE<br>ORBITAL SURVEY<br><span style="font-size:10px;color:#78908a">Drag to rotate · Scroll to zoom<br>Click a settlement to inspect</span>');

// ============================================================
// TRANSITION HELPERS
// ============================================================

/**
 * Acquire the transition lock.
 * Only cameraControls.setTransition writes the flag; this helper just
 * requests it. Returns false if a flight is already animating.
 */
function beginTransition() {
  if (state.flightUpdate) return false; // already animating
  setTransition(true);
  return true;
}

/**
 * Fly camera from current position to target over `dur` ms.
 * Camera always looks at (0,0,0). The tween loop runs inside
 * state.flightUpdate and is consumed by updateCams, which is the
 * guaranteed completion path that clears the transition lock.
 */
function flyTo(target, dur = 3000) {
  return new Promise(res => {
    const start = camera.position.clone();
    // Time-accuracy: drive the tween off wall-clock time (performance.now) so the
    // flight completes in `dur` MILLISECONDS of real time regardless of animation
    // loop frame rate. The per-frame dt is clamped to 0.05 in the loop, which
    // would otherwise stretch the flight enormously when frames are throttled.
    const t0 = performance.now();
    const ease = v => v < 0.5 ? 4 * v * v * v : 1 - Math.pow(-2 * v + 2, 3) / 2;
    state.flightUpdate = () => {
      const t = Math.min(1, (performance.now() - t0) / dur);
      const e = ease(t);
      camera.position.lerpVectors(start, target, e);
      camera.lookAt(0, 0, 0);
      if (t >= 1) {
        // NOTE: do NOT null flightUpdate here—updateCams does that when
        // it sees the false return, and then clears the transition flag.
        res();
        return false;
      }
      return true;
    };
  });
}

// ============================================================
// SETTLEMENT: PIN CLICK → EAGLE
// ============================================================

renderer.domElement.addEventListener('click', (ev) => {
  // No pin clicks during transitions
  if (stageState.transition) return;
  // No pin clicks while walking
  if (ws.active) return;
  const pin = pickPin(ev.clientX, ev.clientY);
  if (pin) onPinSelect(pin);
});

/**
 * Clicking a mark on the planet is the same act as clicking its row in the
 * register: both select the site and open its card. Only the card's own
 * action actually commits to entering the world, so a stray click on the
 * globe can never drop the player into a place they were only looking at.
 */
function onPinSelect(pin) {
  const id = pin.data.name.toLowerCase().replace(/[^a-z]+/g, '-');
  selectSite(id, true);
}

async function onPinClick(pin) {
  if (!pin.data.real) {
    toast(pin.data.name + ' — not yet settled. Only Veridian Cap is built.');
    return;
  }
  if (stageState.current === 'eagle') return;
  if (!beginTransition()) return;

  // Show town, hide globe
  setScenery('surface');
  controls.orbit.enabled = false;
  setNavBusy(true);

  // Enter eagle state immediately so eagle controller is active
  enterEagle();
  setNavStage('eagle');
  setSearchStage('eagle');
  setTransitionHUD(TRANSITION_HUD_ORBIT_EAGLE);

  // Animate camera to the authored eagle position
  const dest = new THREE.Vector3(STAGES.eagle.cameraPos[0], STAGES.eagle.cameraPos[1], STAGES.eagle.cameraPos[2]);
  await flyTo(dest, 3000);
  setNavBusy(false);

  // Commit eagle state; updateCams clears the transition lock on completion.
  enterEagle(); // re-seed yaw/pitch/distance to match the fly-to destination
}

// ============================================================
// KEYBOARD: STAGE NAVIGATION
// ============================================================

window.addEventListener('keydown', e => {
  if (isTyping()) return;
  const key = e.key;

  // ---- F / Enter: descend to Walk ----
  if (key === 'f' || key === 'F' || key === 'Enter') {
    if (stageState.transition) {
      return; // ignored during transition
    }
    if (ws.active) {
      return; // ignored while walking
    }
    if (stageState.current === 'eagle') {
      onDescend();
    }
    // orbit: ignored
    return;
  }

  // ---- P: drop a development marker ----
  //
  // A way to point at a defect from inside the world.  Press P wherever
  // something is wrong and the spot is logged to the browser console
  // with everything needed to go straight back to it: world position,
  // which way you were facing, the stage, the named place, and whatever
  // roads, junctions and solid bodies are within a few metres — which is
  // usually enough to identify the offending object without a second
  // trip.  Markers accumulate on window.MC.marks; MC.marksJSON() prints
  // them all in one block to copy out.
  if (key === 'p' || key === 'P') {
    const pos = camera.position;
    const yaw = Math.atan2(
      -(new THREE.Vector3(0, 0, -1).applyQuaternion(camera.quaternion).x),
      -(new THREE.Vector3(0, 0, -1).applyQuaternion(camera.quaternion).z));
    const near = collisionRegistry.query(pos.x, pos.z, 4.0)
      .map(b => ({ tag: b.tag || b.type, type: b.type,
                   dx: +(((b.minX + b.maxX) / 2) - pos.x).toFixed(2),
                   dz: +(((b.minZ + b.maxZ) / 2) - pos.z).toFixed(2),
                   h: +(b.maxY - b.minY).toFixed(2) }));
    const roads = segmentsNear(pos.x, pos.z, 18).map(r => r.type);
    const junc = allJunctions()
      .filter(j => Math.hypot(j.x - pos.x, j.z - pos.z) < 25)
      .map(j => `${j.id}:${j.cls}/${j.control}`);
    const where = walkLocation(pos.x, pos.z, ws.interiorId ? LOUNGE_INTERIOR.name : null);

    const mark = {
      n: marks.length + 1,
      x: +pos.x.toFixed(2), z: +pos.z.toFixed(2), y: +pos.y.toFixed(2),
      yaw: +yaw.toFixed(3),
      stage: stageState.current,
      place: `${where.place} · ${where.detail}`,
      roadsWithin18m: [...new Set(roads)],
      junctionsWithin25m: junc,
      solidWithin4m: near,
    };
    marks.push(mark);
    console.log(`%c◆ MARK ${mark.n}  (${mark.x}, ${mark.z})  ${mark.place}`,
                'color:#8fd3b0;font-weight:bold');
    console.log(mark);
    console.log(`%c   spot.cjs arg:  M${mark.n}:${mark.x},${mark.z},${mark.yaw}`, 'color:#9aa');
    toast(`Marked #${mark.n} — ${mark.x}, ${mark.z}`);
    return;
  }

  // ---- E: interact with interior entrance/exit ----
  if (key === 'e' || key === 'E') {
    if (stageState.transition) return;
    if (!ws.active) return;
    if (ws.interiorId) {
      // Inside — check if near exit door
      const def = LOUNGE_INTERIOR;
      const dx = camera.position.x - def.exitDoor.x;
      const dz = camera.position.z - def.exitDoor.z;
      if (dx * dx + dz * dz < 2.25) {
        const pos = exitInterior();
        ws.interiorId = null;
        if (pos) { camera.position.x = pos.x; camera.position.z = pos.z; }
        hideHint();
        toast('Exited ' + def.name);
      }
    } else {
      // Outside — check if near any interior entrance
      const def = LOUNGE_INTERIOR;
      const dx = camera.position.x - def.entrance.x;
      const dz = camera.position.z - def.entrance.z;
      if (dx * dx + dz * dz < 2.25) {
        const pos = enterInterior('lounge');
        if (pos) {
          ws.interiorId = 'lounge';
          camera.position.x = pos.x;
          camera.position.z = pos.z;
          hideHint();
          toast(def.name + ' · Veridian Cap');
        }
      }
    }
    return;
  }

  // ---- ESC: stage cycle ----
  if (key === 'Escape') {
    if (stageState.transition) return;
    if (searchIsOpen()) { setSearchOpen(false); return; }
    if (stageState.current === 'orbit' && hasSelection()) { clearSelection(); return; }
    if (getWaypoint()) { setWaypoint(null); return; }
    if (ws.active) {
      walkToEagle();
    } else if (stageState.current === 'eagle') {
      eagleToOrbit();
    }
  }

  // Suppress arrow keys from scrolling the page in any stage
  if (key === 'ArrowUp' || key === 'ArrowDown' || key === 'ArrowLeft' || key === 'ArrowRight') {
    e.preventDefault();
  }
});

// ============================================================
// DESCEND: EAGLE → WALK
// ============================================================

function onDescend() {
  eagleEase.active = false;
  setNavStage('walk');
  setSearchStage('walk');
  // Save eagle context so Walk→Eagle return restores the same view
  eagle.savedContext = {
    target: eagle.target.clone(),
    distance: eagle.distance,
    yaw: eagle.yaw,
    pitch: eagle.pitch,
  };

  // Arrive where the player asked to arrive. Searching for the Community
  // Hall and then being put down at the default spawn on the far side of
  // town would make the search look decorative.
  const a = pendingArrival;
  pendingArrival = null;
  if (a) {
    camera.position.set(a.x, STAGES.walk.height, a.z);
    camera.quaternion.setFromEuler(new THREE.Euler(0, a.yaw, 0, 'YXZ'));
  } else {
    camera.position.set(
      STAGES.walk.spawnPos[0],
      STAGES.walk.spawnPos[1],
      STAGES.walk.spawnPos[2]
    );
    camera.quaternion.setFromEuler(new THREE.Euler(
      STAGES.walk.spawnRot[0],
      STAGES.walk.spawnRot[1],
      STAGES.walk.spawnRot[2],
      STAGES.walk.spawnRot[3] || 'YXZ'
    ));
  }

  // enterWalk resolves any collision overlap at the arrival point, so an
  // authored standing position that clips a kerb or a planter is corrected
  // rather than trapping the player.
  enterWalk();
}

// ============================================================
// WALK → EAGLE (restore saved context or fly to default)
// ============================================================

function walkToEagle() {
  if (!beginTransition()) return;

  exitWalk();
  setScenery('surface');
  controls.orbit.enabled = false;

  if (eagle.savedContext) {
    setTransitionHUD(TRANSITION_HUD_WALK_EAGLE);
    // Restore saved eagle position immediately — no fly needed
    const ctx = eagle.savedContext;
    eagle.target.copy(ctx.target);
    eagle.distance = ctx.distance;
    eagle.yaw = ctx.yaw;
    eagle.pitch = ctx.pitch;
    applyEagleCam();
    // Commit eagle state manually (no flight, so no automated completion)
    stageState.current = 'eagle';
    eagle.active = true;
    setNavStage('eagle');
    setSearchStage('eagle');
    setCrosshair('eagle');
    showDescendHint(true);
    setHUD('VERIDIAN CAP<br>SETTLEMENT SURVEY<br><span style="font-size:10px;color:#78908a">Drag to orbit · Scroll to zoom<br>WASD / arrow keys to move<br><span class="key">F</span> / <span class="key">Enter</span> to enter the streets · <span class="key">Esc</span> to return to orbit</span>');
    setTransition(false);
  } else {
    // No saved context → fly to authored position
    enterEagle();
    const dest = new THREE.Vector3(STAGES.eagle.cameraPos[0], STAGES.eagle.cameraPos[1], STAGES.eagle.cameraPos[2]);
    flyTo(dest, 2000).then(() => {
      enterEagle();
      // updateCams clears transition lock on flight completion
    });
  }
}

// ============================================================
// EAGLE → ORBIT
// ============================================================

function eagleToOrbit() {
  if (!beginTransition()) return;

  setScenery('orbit');
  controls.orbit.enabled = false;

  exitToOrbit();  // sets stage.current = 'orbit'
  setNavStage('orbit');
  setSearchStage('orbit');
  setNavBusy(true);
  setWaypoint(null);
  setTransitionHUD(TRANSITION_HUD_EAGLE_ORBIT);

  const dest = new THREE.Vector3(STAGES.orbit.cameraPos[0], STAGES.orbit.cameraPos[1], STAGES.orbit.cameraPos[2]);
  flyTo(dest, 3000).then(() => {
    camera.lookAt(0, 0, 0);
    controls.orbit.target.set(0, 0, 0);
    controls.orbit.update();
    setNavBusy(false);
    // updateCams clears transition lock on flight completion
  });
}

// ============================================================
// INIT
// ============================================================

setupWalkCtrls();
setOrbit(true);

// ============================================================
// MAIN LOOP
// ============================================================

startLoop(() => {
  timer.update();
  const dt = Math.min(timer.getDelta(), 0.05);
  try {
    updateCams(dt);
  } catch (err) {
    console.error('updateCams error:', err);
  }

  // Phase 6: interior entrance/exit proximity detection for HUD hints
  if (ws.active && !stageState.transition) {
    if (ws.interiorId) {
      const def = LOUNGE_INTERIOR;
      const dx = camera.position.x - def.exitDoor.x;
      const dz = camera.position.z - def.exitDoor.z;
      if (dx * dx + dz * dz < 4.0) {
        showHint('Press <span class="key">E</span> to exit', 0);
      } else { hideHint(); }
    } else {
      const def = LOUNGE_INTERIOR;
      const dx = camera.position.x - def.entrance.x;
      const dz = camera.position.z - def.entrance.z;
      if (dx * dx + dz * dz < 4.0) {
        showHint('Press <span class="key">E</span> to enter', 0);
      } else { hideHint(); }
    }
  }
  // Auto-rotate the globe in orbit, unless a site focus is easing it — a
  // drifting planet fighting a deliberate turn reads as a bug.
  updateEagleEase(dt);
  const spinning = updateGlobeSpin(dt);
  if (!spinning && controls.orbit && controls.orbit.enabled && stageState.current === 'orbit') {
    globeGroup.rotation.y += STAGES.orbit.globeAutoRotateSpeed;
  }

  // The sky dome is a 3 km sphere, and it has to travel with the camera.
  // Sitting at the world origin it was fine while Eagle was clamped to a
  // 120 m survey envelope, but Phase 7 lets the camera roam kilometres
  // out — and from a kilometre away the dome's below-horizon half rises
  // into view as a large dark lobe hanging over the origin, which read as
  // a black dome squatting on Veridian Cap.  Following the camera in the
  // horizontal plane keeps the horizon where the viewer actually is.
  if (skyState.mesh && skyState.mesh.visible) {
    skyState.mesh.position.set(camera.position.x, 0, camera.position.z);
  }

  // Aerial perspective is stage-dependent: see ATMOS.fogDensityEagle.
  // The street keeps the haze it was tuned with; the regional view gets
  // air it can see through.
  if (scene.fog) {
    scene.fog.density = stageState.current === 'eagle'
      ? ATMOS.fogDensityEagle : ATMOS.fogDensity;
  }

  // Phase 10A: step the people.  Bounded population, and only the agents
  // within the simulation radius are touched.
  if (stageState.current !== 'orbit') updatePeople(Math.min(dt, 0.1), camera.position);

  // Phase 7: keep procedural chunks around the camera loaded, at the
  // LOD matching their distance.  Bounded at 2 builds/frame.
  if (!ws.interiorId) {
    procWorld.update(camera.position, stageState.current);
  }

  // The navigation layer follows the world rather than the other way round.
  updateLocator({
    stage: stageState.current,
    camera,
    interiorName: ws.interiorId ? LOUNGE_INTERIOR.name : null,
  });
  if (stageState.current === 'orbit') updateLabels(projectPins());
  const clouds = globeGroup.getObjectByName('clouds');
  if (clouds) clouds.rotation.y += 0.0003;
});

// ============================================================
// HELPERS
// ============================================================

const _proj = [];
/**
 * Screen positions for the settlement labels.
 * A pin on the far side of the planet still projects to a valid point, so
 * facing is tested too — otherwise names float over the wrong hemisphere.
 */
function projectPins() {
  _proj.length = 0;
  for (const pin of pins) {
    const world = pin.mesh.getWorldPosition(new THREE.Vector3());
    const v = world.clone().project(camera);
    const toCam = camera.position.clone().sub(world).normalize();
    const facing = world.clone().normalize().dot(toCam) > 0.18;
    _proj.push({
      id: pin.data.name.toLowerCase().replace(/[^a-z]+/g, '-'),
      x: (v.x * 0.5 + 0.5) * window.innerWidth,
      y: -(v.y * 0.5 - 0.5) * window.innerHeight - 26,
      visible: facing && v.z < 1,
    });
  }
  return _proj;
}

/**
 * Show the surface world or the orbital world, never both.
 *
 * Everything that belongs to standing ON Amarine — the sky dome, the
 * ground haze, the directional sun and the hemisphere bounce — is switched
 * off in orbit, and the star field is switched on. They are two different
 * places: a daytime sky dome and a layer of surface fog left running behind
 * a planet viewed from space is what made Amarine read as a dark disc on a
 * tan background instead of a world against the dark.
 *
 * The planet carries its own lighting inside its shader (see globe.js), so
 * orbit needs no scene lights at all.
 */
function setScenery(mode) {
  const surface = (mode === 'surface');
  ground.visible = surface;
  globeGroup.visible = !surface;

  if (state.stars) state.stars.visible = !surface;
  if (skyState.mesh) skyState.mesh.visible = surface;
  if (skyState.sun) skyState.sun.visible = surface;
  if (skyState.hemi) skyState.hemi.visible = surface;
  scene.fog = surface ? skyState.fog : null;
}

let showHint_timeout;
function showHint(msg, dur) {
  const el = document.getElementById('street-hint');
  if (!el) return;
  el.innerHTML = msg; el.classList.add('show');
  clearTimeout(showHint_timeout);
  if (dur !== 0) {
    showHint_timeout = setTimeout(() => el.classList.remove('show'), dur || 6000);
  }
}
function toast(msg) {
  const t = document.getElementById('toast');
  if (!t) return;
  t.textContent = msg; t.classList.add('show');
  setTimeout(() => t.classList.remove('show'), 3500);
}

// Development markers dropped with the P key.
const marks = [];

window.MC = {
  marks,
  marksJSON: () => { const t = JSON.stringify(marks, null, 1); console.log(t); return t; },
  scene, camera, renderer, stageState, eagle, ws, pins, getPinScreen,
  collisionRegistry,
  // Phase 7 survey hooks: place the eagle camera anywhere on the planet so
  // the generated civilization can be inspected from altitude in QA.
  procWorld, applyEagleCam,
  // The live generation config, so a measurement run can re-scope the
  // regional radius without a rebuild.  Phase 9A measures 1.5/2/2.5/3 km
  // and the distance has to be earned by numbers, not assumed.
  PROC,
  // Phase 8 reference-district model, for the QA harnesses.
  district, districtSummary,
  // Phase 8.5 road-network audit hooks.  The authored streets are folded
  // in with the procedural ones so the audit sees ONE network, which is
  // the only way a question like "is this reachable from the gateway"
  // has a meaningful answer.
  junctions: { all: allJunctions, summary: junctionSummary },
  // Read-only world queries, for audits that need to know what KIND of
  // ground a point is on rather than just what is drawn there.
  world: {
    developmentAt, reservationAt, insideAuthoredTown, BAND,
    parkBounds: { minX: -21, maxX: 21, minZ: -19, maxZ: 19 },
  },
  // Phase 9C diagnostic hooks.  A probe that does its own
  // import('/src/procedural/roads.js') gets a DIFFERENT module instance
  // from the running app — its _segments held 15 entries where the app's
  // held 515 — so anything measured through it describes a parallel
  // world.  Everything a QA probe needs is exposed here, from the live
  // instance, so that mistake cannot be made again.
  zones: { zoneAt, ZONE, clusterAt },
  // Phase 10A human-presence diagnostics.
  people: { state: peopleState, summary: peopleSummary, activityFor, net: pedNet, update: updatePeople },
  // Phase 9C landscape diagnostics, from the live instance.
  landscape: { fieldBoundaries, classifyBoundary, BOUNDARY, utilityCorridors, corridorPoleCount, utilityPoles, corridorPoles },
  parcels: { setParcelTrace, ensureSettlementRoads, allSettlements },
  roads: {
    ROAD,
    // The authored streets are registered in the procedural index at
    // init, so this is already one network.
    segmentsNear,
    parcelsNear: (x, z, r) => [
      ...buildingRegistry.map(b => ({ x: b.cx, z: b.cz, src: 'authored' })),
      ...parcelsNear(x, z, r),
    ].filter(p => Math.hypot(p.x - x, p.z - z) <= r),
  },
  buildings: buildingRegistry,
  controls,
  planetStats: planetMaps().stats,
  hallDef: LOUNGE_INTERIOR,
  hallPanes: LOUNGE_INTERIOR._panes ? LOUNGE_INTERIOR._panes.length : -1,
  navPlaces: (settledSite() || {}).highlights || [],
  orbitSun: new THREE.Vector3(...ORBIT.sunDir).normalize(),
  THREE,
  __diag: {
    flightUpdate: () => state.flightUpdate ? 'active' : null,
    wsFwd: () => ws.fwd,
    wsVelZ: () => ws.vel.z,
    wsDirZ: () => ws.dir.z,
  },
};