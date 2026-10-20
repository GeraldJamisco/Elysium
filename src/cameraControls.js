import * as THREE from 'three';
import { camera, controls, renderer } from './scene.js';
import { STAGES } from './config.js';
import { state } from './globe.js';
import { collisionRegistry, PLAYER_RADIUS } from './city/collision.js';
import { enterInterior as _enterInterior, exitInterior as _exitInterior, getCurrentInterior } from './city/interiors.js';

// ============================================================
// STAGE CONTRACT — Elysium Phase 1
//
// ORBIT → EAGLE → WALK → EAGLE → ORBIT
//
// stageState.current ('orbit' | 'eagle' | 'walk')
// stageState.transition — true during any camera animation;
//   gates ALL stage-changing input (F, Enter, ESC, clicks).
//
// Eagle controller owns a yaw/pitch/distance/target around
//   the settlement.  Drag rotates, wheel zooms, WASD pans
//   the target (bounded to SURVEY_ENVELOPE).
//
// Eagle context is saved on descend and restored on return
//   from Walk so the user feels they returned to the same
//   aerial position.
//
// Walk controller uses pointer lock for look; falls back to
//   drag-look if lock fails.  WASD moves every frame.
// ============================================================

export const stageState = {
  current: 'orbit',          // 'orbit' | 'eagle' | 'walk'
  transition: false,         // true during any camera animation
};

// ---- SINGLE TRANSITION AUTHORITY ----
// cameraControls.js is the ONLY module that writes stageState.transition.
// main.js calls setTransition(true) before a flight and updateCams
// guarantees clearing it when the flight completes — even if the flight
// callback throws or never resolves.
let _transitionGuard = false;
export function setTransition(v) {
  _transitionGuard = v;
  stageState.transition = v;
}
export function isTransitioning() { return _transitionGuard; }

// ---- Eagle controller ----
export const eagle = {
  active: false,
  target: new THREE.Vector3(0, 0, 0),
  distance: 78,
  yaw: 0.35,
  pitch: 0.55,
  dragging: false,
  lastX: 0, lastY: 0,
  keys: { fwd: false, back: false, left: false, right: false },

  // Saved eagle context during Walk — restored on ESC
  savedContext: null,   // { target: Vector3, distance, yaw, pitch } or null
};

// ---- Walk state ----
export const ws = {
  active: false,
  euler: new THREE.Euler(0, 0, 0, 'YXZ'),
  fwd: false, back: false, left: false, right: false,
  vel: new THREE.Vector3(),
  dir: new THREE.Vector3(),
  lockRequested: false,
  dragLook: false,
  interiorId: null,       // null = exterior; 'lounge' = inside a building
};

// ---- HUD ----
const ORBIT_HUD = 'AMARINE<br>ORBITAL SURVEY<br><span style="font-size:10px;color:#78908a">Drag to rotate · Scroll to zoom<br>Click a settlement to inspect</span>';
export const TRANSITION_HUD_ORBIT_EAGLE = 'Approaching Veridian Cap';
const EAGLE_HUD = 'VERIDIAN CAP<br>SETTLEMENT SURVEY<br><span style="font-size:10px;color:#78908a">Drag to orbit · Scroll to zoom<br>WASD / arrow keys to move<br><span class="key">F</span> / <span class="key">Enter</span> to enter the streets · <span class="key">Esc</span> to return to orbit</span>';
export const TRANSITION_HUD_EAGLE_WALK = 'Entering Veridian Cap';
const WALK_HUD = '<span class="key">W A S D</span> / arrows move · <span class="key">Mouse</span> to look · <span class="key">ESC</span> return to survey';
export const TRANSITION_HUD_WALK_EAGLE = 'Returning to survey';
export const TRANSITION_HUD_EAGLE_ORBIT = 'Returning to orbit';

function setTitle(text) {
  const el = document.getElementById('hud-title');
  if (!el) return;
  el.textContent = text;
}

export function setHUD(msg) {
  const el = document.getElementById('hud-stage');
  if (!el) return;
  el.innerHTML = msg;
}

export function setTransitionHUD(msg) {
  const el = document.getElementById('hud-stage');
  if (!el) return;
  el.innerHTML = msg;
  setCrosshair('');
  showDescendHint(false);
}

export function setCrosshair(mode) {
  const el = document.getElementById('crosshair');
  if (!el) return;
  el.className = mode || '';
}

export function showDescendHint(show) {
  const el = document.getElementById('descend-hint');
  if (!el) return;
  el.classList.toggle('show', show);
}

export function hideHint() {
  const el = document.getElementById('street-hint');
  if (el) el.classList.remove('show');
}

// ---- Orbit controls helper ----
export function setOrbit(on) { controls.orbit.enabled = on; }

/**
 * True when the keyboard belongs to a text field rather than to the world.
 * Every global key handler checks this first.
 */
export function isTyping() {
  const a = document.activeElement;
  if (!a) return false;
  const tag = a.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || a.isContentEditable;
}

// ---- Pointer lock change handler ----
function trackPointerLockChange() {
  if (!document.pointerLockElement && ws.active && !stageState.transition) {
    const hint = document.getElementById('street-hint');
    if (hint) hint.innerHTML = 'Click the scene to continue looking';
    ws.lockRequested = true;
  }
}

// Show drag-look hint when walk pointer lock is unavailable
function showDragFallbackHint() {
  const hint = document.getElementById('street-hint');
  if (hint) hint.innerHTML = 'Drag to look · Click the scene to continue looking';
}

// ---- Survey envelope: clamp eagle target so it stays over the settlement ----
// Phase 7: when panning beyond the authored survey envelope the clamp
// expands gradually, allowing the player to explore procedural content
// extending from Veridian Cap.
function clampTarget(t) {
  const hw = STAGES.eagle.surveyHalfWidth;
  const hd = STAGES.eagle.surveyHalfDepth;
  const d = Math.hypot(t.x, t.z);
  // Within the tight authored envelope: clamp exactly as before.
  if (d <= hw) {
    t.x = Math.max(-hw, Math.min(hw, t.x));
    t.z = Math.max(-hd, Math.min(hd, t.z));
  } else {
    // Outside the tight envelope: expand up to the planetary limit.
    // The clamp is proportional so the player never hits a hard wall
    // at the boundary — once they push past ±120 the limit extends
    // to ±5000.
    const limit = 5000;
    t.x = Math.max(-limit, Math.min(limit, t.x));
    t.z = Math.max(-limit, Math.min(limit, t.z));
  }
}

// ---- Eagle camera: compute position from yaw/pitch/distance ----
export function applyEagleCam() {
  const cp = Math.sin(eagle.pitch);
  const sp = Math.cos(eagle.pitch);
  camera.position.set(
    eagle.target.x + eagle.distance * sp * Math.cos(eagle.yaw),
    eagle.target.y + eagle.distance * cp,
    eagle.target.z + eagle.distance * sp * Math.sin(eagle.yaw)
  );
  camera.lookAt(eagle.target);
}

// ---- Input setup (called once at init) ----
export function setupWalkCtrls() {
  const dom = renderer.domElement;

  document.addEventListener('pointerlockchange', trackPointerLockChange);

  // Clear directional input on focus loss so keys never stick across transitions,
  // tab switches, or pointer-lock exits.
  window.addEventListener('blur', () => {
    ws.fwd = ws.back = ws.left = ws.right = false;
    ws.vel.set(0, 0, 0);
    eagle.keys.fwd = eagle.keys.back = eagle.keys.left = eagle.keys.right = false;
  });

  // Re-lock on click when lock was lost
  dom.addEventListener('click', () => {
    if (ws.lockRequested && ws.active) {
      ws.lockRequested = false;
      try { dom.requestPointerLock(); } catch (_) {}
    }
  });

  // ---- Mouse: eagle drag orbit / walk fallback look ----
  dom.addEventListener('pointerdown', (e) => {
    if (ws.active && !document.pointerLockElement) {
      ws.dragLook = true;
      eagle.lastX = e.clientX;
      eagle.lastY = e.clientY;
      showDragFallbackHint();
      return;
    }
    if (stageState.current !== 'eagle' || ws.active || stageState.transition) return;
    eagle.dragging = true;
    eagle.lastX = e.clientX;
    eagle.lastY = e.clientY;
  });

  window.addEventListener('pointermove', (e) => {
    if (eagle.dragging) {
      const dx = e.clientX - eagle.lastX;
      const dy = e.clientY - eagle.lastY;
      eagle.lastX = e.clientX;
      eagle.lastY = e.clientY;
      eagle.yaw -= dx * 0.005;
      eagle.pitch = Math.max(0.12, Math.min(1.45, eagle.pitch + dy * 0.005));
      applyEagleCam();
    } else if (ws.dragLook) {
      const dx = e.clientX - eagle.lastX;
      const dy = e.clientY - eagle.lastY;
      eagle.lastX = e.clientX;
      eagle.lastY = e.clientY;
      ws.euler.y -= dx * 0.002;
      ws.euler.x = Math.max(-1.4, Math.min(1.4, ws.euler.x - dy * 0.002));
      camera.quaternion.setFromEuler(ws.euler);
    }
  });

  window.addEventListener('pointerup', () => {
    eagle.dragging = false;
    ws.dragLook = false;
  });

  // ---- Scroll zoom for eagle ----
  dom.addEventListener('wheel', (e) => {
    if (stageState.current !== 'eagle' || ws.active || stageState.transition) return;
    e.preventDefault();
    eagle.distance *= (1 + Math.sign(e.deltaY) * 0.08);
    eagle.distance = Math.max(STAGES.eagle.minDist, Math.min(STAGES.eagle.maxDist, eagle.distance));
    applyEagleCam();
  }, { passive: false });

  // ---- Keyboard: walk / eagle WASD + arrows ----
  window.addEventListener('keydown', (e) => {
    if (isTyping()) return;
    if (ws.active) {
      switch (e.code) {
        case 'KeyW': case 'ArrowUp':    ws.fwd = true; e.preventDefault(); break;
        case 'KeyS': case 'ArrowDown':  ws.back = true; e.preventDefault(); break;
        case 'KeyA': case 'ArrowLeft':  ws.left = true; e.preventDefault(); break;
        case 'KeyD': case 'ArrowRight': ws.right = true; e.preventDefault(); break;
      }
    } else if (stageState.current === 'eagle' && !stageState.transition) {
      switch (e.code) {
        case 'KeyW': case 'ArrowUp':    eagle.keys.fwd = true; e.preventDefault(); break;
        case 'KeyS': case 'ArrowDown':  eagle.keys.back = true; e.preventDefault(); break;
        case 'KeyA': case 'ArrowLeft':  eagle.keys.left = true; e.preventDefault(); break;
        case 'KeyD': case 'ArrowRight': eagle.keys.right = true; e.preventDefault(); break;
      }
    }
  });

  window.addEventListener('keyup', (e) => {
    if (isTyping()) return;
    if (ws.active) {
      switch (e.code) {
        case 'KeyW': case 'ArrowUp':    ws.fwd = false; break;
        case 'KeyS': case 'ArrowDown':  ws.back = false; break;
        case 'KeyA': case 'ArrowLeft':  ws.left = false; break;
        case 'KeyD': case 'ArrowRight': ws.right = false; break;
      }
    }
    if (stageState.current === 'eagle') {
      switch (e.code) {
        case 'KeyW': case 'ArrowUp':    eagle.keys.fwd = false; break;
        case 'KeyS': case 'ArrowDown':  eagle.keys.back = false; break;
        case 'KeyA': case 'ArrowLeft':  eagle.keys.left = false; break;
        case 'KeyD': case 'ArrowRight': eagle.keys.right = false; break;
      }
    }
  });
}

// ============================================================
// STAGE ENTRY / EXIT
// ============================================================

export function enterEagle() {
  stageState.current = 'eagle';
  controls.orbit.enabled = false;
  eagle.active = true;
  setTitle('✦ VERIDIAN CAP · SETTLEMENT SURVEY');
  // Derive yaw/pitch/distance from current camera position
  const off = camera.position.clone().sub(eagle.target);
  eagle.distance = Math.max(STAGES.eagle.minDist, Math.min(STAGES.eagle.maxDist, off.length()));
  eagle.yaw = Math.atan2(off.z, off.x);
  eagle.pitch = Math.acos(Math.max(-1, Math.min(1, off.y / (off.length() || 1))));
  applyEagleCam();
  setCrosshair('eagle');
  showDescendHint(true);
  setHUD(EAGLE_HUD);
}

export function enterWalk() {
  // Walk state is committed BEFORE any pointer-lock attempt.
  // Lock is best-effort; success or failure does not affect walk activation.
  stageState.current = 'walk';
  ws.active = true;
  eagle.keys.fwd = eagle.keys.back = eagle.keys.left = eagle.keys.right = false;
  setTitle('✦ VERIDIAN CAP · ON THE STREET');
  ws.lockRequested = false;
  eagle.active = false;
  controls.orbit.enabled = false;
  const q = camera.quaternion.clone();
  ws.euler.setFromQuaternion(q);
  setCrosshair('');
  showDescendHint(false);
  setHUD(WALK_HUD);
  // requestPointerLock is non-blocking; if it fails (no user gesture, wrong document, etc.)
  // the fallback drag-look in updateCams and pointer handlers still works.
  try {
    if (document.body && document.body === document.body.parentNode) {
      renderer.domElement.requestPointerLock();
    }
  } catch (_) {}

  // Phase 4: resolve any collision overlap at spawn point
  const safe = collisionRegistry.resolveOverlap(camera.position.x, camera.position.z, PLAYER_RADIUS);
  if (safe) { camera.position.x = safe.x; camera.position.z = safe.z; }
}

export function exitWalk() {
  // Phase 6: exit any active interior when leaving walk mode
  if (ws.interiorId) {
    _exitInterior();
    ws.interiorId = null;
    hideHint();
  }
  ws.active = false;
  ws.lockRequested = false;
  ws.fwd = ws.back = ws.left = ws.right = false;
  ws.vel.set(0, 0, 0);
  controls.orbit.enabled = false;
  if (document.pointerLockElement) document.exitPointerLock();
}

export function exitToOrbit() {
  stageState.current = 'orbit';
  eagle.active = false;
  eagle.keys.fwd = eagle.keys.back = eagle.keys.left = eagle.keys.right = false;
  setTitle('✦ AMARINE · ORBITAL SURVEY');
  ws.active = false;
  ws.lockRequested = false;
  ws.fwd = ws.back = ws.left = ws.right = false;
  ws.vel.set(0, 0, 0);
  controls.orbit.enabled = true;
  controls.orbit.enablePan = false;
  controls.orbit.minDistance = STAGES.orbit.minDist;
  controls.orbit.maxDistance = STAGES.orbit.maxDist;
  controls.orbit.target.set(0, 0, 0);
  controls.orbit.update();
  if (document.pointerLockElement) document.exitPointerLock();
  setCrosshair('');
  showDescendHint(false);
  setHUD(ORBIT_HUD);
}

// ============================================================
// FRAME UPDATE
// ============================================================

export function updateCams(dt) {
  // ---- Flight animation takes priority ----
  // updateCams is the sole completion guard: when a flightUpdate returns
  // false (done), we ALWAYS clear transition — even if onDone threw.
  if (state.flightUpdate) {
    try {
      const ok = state.flightUpdate(dt);
      if (!ok) {
        state.flightUpdate = null;
        setTransition(false);
      }
    } catch (err) {
      console.error('flightUpdate error:', err);
      state.flightUpdate = null;
      setTransition(false);
    }
    return;
  }

  // ---- Walk ----
  if (ws.active) {
    if (document.pointerLockElement) {
      const mx = document.movementX || 0;
      const my = document.movementY || 0;
      if (mx || my) {
        ws.euler.y -= mx * STAGES.walk.sensitivity;
        ws.euler.x -= my * STAGES.walk.sensitivity;
        ws.euler.x = Math.max(-Math.PI / 2.1, Math.min(Math.PI / 2.1, ws.euler.x));
        camera.quaternion.setFromEuler(ws.euler);
      }
    }

    ws.dir.z = Number(ws.fwd) - Number(ws.back);
    ws.dir.x = Number(ws.right) - Number(ws.left);
    const moving = ws.dir.z !== 0 || ws.dir.x !== 0;
    if (moving) ws.dir.normalize();
    // Smooth velocity toward commanded direction × speed, so walk moves at the
    // configured speed in world units/s regardless of frame rate.  The lerp
    // blends fast enough (~6 frames at 60fps) that response feels immediate
    // and release stops cleanly without sliding.
    const targetVz = ws.dir.z * STAGES.walk.speed;
    const targetVx = ws.dir.x * STAGES.walk.speed;
    const k = Math.min(1, 12 * dt);
    ws.vel.z += (targetVz - ws.vel.z) * k;
    ws.vel.x += (targetVx - ws.vel.x) * k;

    const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(camera.quaternion);
    const rgt = new THREE.Vector3(1, 0, 0).applyQuaternion(camera.quaternion);
    fwd.y = 0; fwd.normalize();
    rgt.y = 0; rgt.normalize();

    // Phase 4: collision-resolved movement (tunneling-safe)
    // Phase 6: interior-aware body filtering
    const rawDx = (fwd.x * ws.vel.z + rgt.x * ws.vel.x) * dt;
    const rawDz = (fwd.z * ws.vel.z + rgt.z * ws.vel.x) * dt;
    if (rawDx !== 0 || rawDz !== 0) {
      const bodyFilter = ws.interiorId
        ? b => b.type === 'interior'
        : b => b.type !== 'interior';
      const res = collisionRegistry.preventTunneling(
        camera.position.x, camera.position.z,
        rawDx, rawDz,
        PLAYER_RADIUS,
        bodyFilter
      );
      camera.position.x = res.x;
      camera.position.z = res.z;
    }
    camera.position.y = STAGES.walk.height;
    return;
  }

  // ---- Eagle WASD/arrow pan (speed scales with camera distance) ----
  if (stageState.current === 'eagle') {
    const spd = eagle.distance * STAGES.eagle.panScale * dt;
    const camFwd = new THREE.Vector3(0, 0, -1).applyQuaternion(camera.quaternion);
    const camRight = new THREE.Vector3(1, 0, 0).applyQuaternion(camera.quaternion);
    camFwd.y = 0; camFwd.normalize();
    camRight.y = 0; camRight.normalize();
    let tdx = 0, tdz = 0;
    if (eagle.keys.fwd) { tdx += camFwd.x * spd; tdz += camFwd.z * spd; }
    if (eagle.keys.back) { tdx -= camFwd.x * spd; tdz -= camFwd.z * spd; }
    if (eagle.keys.left) { tdx -= camRight.x * spd; tdz -= camRight.z * spd; }
    if (eagle.keys.right) { tdx += camRight.x * spd; tdz += camRight.z * spd; }
    if (tdx || tdz) {
      eagle.target.x += tdx;
      eagle.target.z += tdz;
      clampTarget(eagle.target);
      applyEagleCam();
    }
    return;
  }

  // ---- Orbit ----
  controls.orbit?.update();
}