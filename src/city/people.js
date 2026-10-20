// ============================================================
// HUMAN PRESENCE — Phase 10A
//
// Veridian Cap is a town nobody has ever been seen in.  Every phase so
// far has built the reasons for people — doors that face streets,
// crossings where roads meet, a green with benches round a basin — and
// the place has never had one person in it.
//
// This is a presence layer, not a simulation.  It sits BESIDE the world
// rather than inside it: people read the district model, the road graph
// and the pedestrian network, and nothing in those layers knows people
// exist.  Deleting this file returns the town to Phase 9C exactly.
//
// What a person is:
//
//   an origin, a destination, a route, an activity, a lifecycle state
//
// and nothing else.  No needs, no personality, no dialogue, no economy.
// Those are later phases and most of them are traps.
//
// LIFECYCLE
//   SPAWN -> WALKING -> ARRIVED -> ACTIVE -> DEPARTING -> DESPAWN
//
// Agents are POOLED: the array is allocated once and reused, so the
// population is bounded by construction and there is no path by which it
// can grow.  An agent that cannot route does not teleport and does not
// wander; it is marked failed, recorded for QA, and given another
// destination.
// ============================================================

import * as THREE from 'three';
import { createRNG } from '../procedural/seed.js';
import { district } from './district.js';
import { collisionRegistry } from './collision.js';
import { buildPedNet, pedNet } from './pednet.js';

export const ACTIVITY = {
  RESIDENT:   'RESIDENT',
  SHOPPER:    'SHOPPER',
  VISITOR:    'VISITOR',
  CIVIC_USER: 'CIVIC_USER',
  PARK_USER:  'PARK_USER',
  COMMUTER:   'COMMUTER',
};

export const STATE = {
  SPAWN: 'SPAWN', WALKING: 'WALKING', ARRIVED: 'ARRIVED',
  ACTIVE: 'ACTIVE', DEPARTING: 'DEPARTING', DESPAWN: 'DESPAWN',
};

const POPULATION = 42;            // dozens, as briefed — not hundreds
const WALK_SPEED = 1.35;          // m/s, a person's pace
const ACCEL = 2.4;
const ARRIVE_R = 1.6;
const SIM_RADIUS = 420;           // beyond this an agent is not stepped
const DRAW_RADIUS = 340;

// ---- Eagle readability (Phase 10A.1) --------------------------------
//
// A person is 1.79 m tall.  Measured against the real Eagle camera at
// 1280x800, the projected height is:
//
//   eagle 140 (cam y 105)   6.9 px    readable
//   eagle 220 (cam y 165)   4.5 px    marginal
//   eagle 340 (cam y 255)   2.9 px    sub-perceptual
//   eagle 500 (cam y 376)   2.0 px    and 25 of 42 culled
//   eagle 700 (cam y 526)   1.4 px    and ALL 42 culled by DRAW_RADIUS
//
// So from altitude the town read as empty for two separate reasons: the
// figures were too small to see, and past 340 m they were not drawn.
//
// Above a threshold the same instanced mesh stops drawing one instance
// per PERSON and starts drawing one per GROUP of people — at a scale
// that holds a readable size on screen.  The groups are the agents'
// own positions bucketed together, so the pattern on screen is where
// people actually are: dense at the green and the shops, thin on a
// residential street, nothing at the edge.  Nothing decorative is added
// and no agent is moved.
const AGG_ON = 120;               // camera altitude: start aggregating
const AGG_OFF = 98;               // ...and stop.  Hysteresis, so a camera
                                  // drifting across the line cannot flicker.
const AGG_BUCKET = 15;            // metres: how close is "together"
// Aggregate markers need CONTRAST, not just pixels.  At 7-10 px the first
// version was the right size and still invisible: muted grey-brown
// figures the same tone as the buildings and the same size as the street
// furniture.  A warm, slightly lighter tone separates from both the cool
// roofs and the green, without leaving the world's palette — the town
// already carries terracotta, so warmth belongs here.
const AGG_TINT = new THREE.Color(0xd8a56a);
const AGG_DRAW_RADIUS = 1400;     // clusters stay visible far beyond DRAW_RADIUS

export const peopleState = {
  agents: [],
  mesh: null,
  enabled: true,
  stats: { active: 0, drawn: 0, routeFailures: 0, stuck: 0, reroutes: 0 },
};

// ---- Figure ---------------------------------------------------------
//
// One shared low-poly figure, instanced.  It has to read as a person at
// walking distance and as activity from altitude, and it must not look
// like a placeholder capsule — so it carries the one silhouette cue that
// survives at any size: shoulders wider than the head, legs apart.
function figureGeometry() {
  const parts = [];
  const body = new THREE.CylinderGeometry(0.19, 0.25, 0.72, 6);
  body.translate(0, 1.16, 0);
  parts.push(body);
  const head = new THREE.SphereGeometry(0.125, 6, 5);
  head.translate(0, 1.66, 0);
  parts.push(head);
  for (const s of [-1, 1]) {
    const leg = new THREE.CylinderGeometry(0.075, 0.065, 0.82, 5);
    leg.translate(s * 0.10, 0.41, 0);
    parts.push(leg);
  }
  // Merge by hand: BufferGeometryUtils is not imported anywhere else in
  // this project and one figure does not justify pulling it in.
  let vTotal = 0, iTotal = 0;
  for (const g of parts) { vTotal += g.attributes.position.count; iTotal += g.index.count; }
  const pos = new Float32Array(vTotal * 3);
  const nor = new Float32Array(vTotal * 3);
  const idx = new Uint16Array(iTotal);
  let vo = 0, io = 0;
  for (const g of parts) {
    const p = g.attributes.position.array, n = g.attributes.normal.array;
    pos.set(p, vo * 3); nor.set(n, vo * 3);
    const gi = g.index.array;
    for (let i = 0; i < gi.length; i++) idx[io + i] = gi[i] + vo;
    vo += g.attributes.position.count; io += gi.length;
    g.dispose();
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  out.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  out.setIndex(new THREE.BufferAttribute(idx, 1));
  out.computeBoundingSphere();
  return out;
}

// Muted, and in the world's own register — this is Elysium, not a crowd
// of primary colours.
const COAT = [0x6b7280, 0x8a7f6d, 0x5f6b5a, 0x7d6a5c, 0x6a6f7a, 0x8b8577, 0x55606b];

// ---- Destinations ---------------------------------------------------

function destinationsFor(activity, buildings) {
  switch (activity) {
    case ACTIVITY.SHOPPER:
      return buildings.filter(b => b.purpose === 'commercial' || b.purpose === 'corner-shop');
    case ACTIVITY.CIVIC_USER:
      return buildings.filter(b => b.purpose === 'civic' || b.purpose === 'landmark');
    case ACTIVITY.RESIDENT:
    case ACTIVITY.COMMUTER:
      return buildings.filter(b => b.purpose === 'residence');
    case ACTIVITY.VISITOR:
      return buildings.filter(b => b.purpose !== 'residence');
    default:
      return buildings;
  }
}

/**
 * The activity a person is engaged in at a given world time.
 *
 * Deliberately trivial for now, and deliberately SHAPED for later: the
 * signature is the interface the brief asked for, so a day/night pass can
 * make activity depend on the hour without any caller changing.
 */
export function activityFor(person, worldTime) {
  return person.activity;
}

// ---- Build ----------------------------------------------------------

export function buildPeople(scene, junctions, seed = 0x10A) {
  const net = buildPedNet(junctions);
  const rng = createRNG(seed);

  const buildings = district.buildings.filter(b => b.entrance);
  const doorNodes = [];
  for (let i = 0; i < net.nodes.length; i++) {
    if (net.nodes[i].kind === 'door') doorNodes.push(i);
  }
  const parkNodes = [];
  for (let i = 0; i < net.nodes.length; i++) {
    if (net.nodes[i].kind === 'park') parkNodes.push(i);
  }

  const doorOf = new Map();
  for (const i of doorNodes) {
    const r = net.nodes[i].ref;
    if (r && r.tag) doorOf.set(r.tag, i);
  }

  const MIX = [
    ACTIVITY.RESIDENT, ACTIVITY.RESIDENT, ACTIVITY.SHOPPER, ACTIVITY.SHOPPER,
    ACTIVITY.PARK_USER, ACTIVITY.CIVIC_USER, ACTIVITY.VISITOR, ACTIVITY.COMMUTER,
  ];

  const agents = [];
  for (let i = 0; i < POPULATION; i++) {
    const activity = rng.pick(MIX);
    const homes = buildings.filter(b => b.purpose === 'residence');
    const home = homes.length ? rng.pick(homes) : buildings[0];
    const originNode = doorOf.get(home.tag);
    const a = {
      id: 'P' + String(i + 1).padStart(3, '0'),
      activity,
      state: STATE.SPAWN,
      homeTag: home ? home.tag : null,
      origin: originNode !== undefined ? originNode : -1,
      dest: -1,
      route: null, leg: 0, t: 0,
      x: 0, z: 0, yaw: 0, speed: 0,
      dwell: 0,
      colour: rng.pick(COAT),
      // Groups: a person may walk with the one before them.  Small and
      // occasional — 1s, 2s, the odd 3 — never a crowd.
      group: rng.next() < 0.28 ? (i > 0 ? agents[i - 1].id : null) : null,
      failures: 0,
    };
    if (a.origin >= 0) {
      a.x = net.nodes[a.origin].x;
      a.z = net.nodes[a.origin].z;
    }
    agents.push(a);
  }

  peopleState.agents = agents;
  peopleState._net = net;
  peopleState._doorNodes = doorNodes;
  peopleState._parkNodes = parkNodes;
  peopleState._buildings = buildings;
  peopleState._doorOf = doorOf;
  peopleState._rng = rng;

  // ---- Rendering: one instanced mesh for the whole population --------
  const geo = figureGeometry();
  const mat = new THREE.MeshLambertMaterial({ vertexColors: false });
  const mesh = new THREE.InstancedMesh(geo, mat, POPULATION);
  mesh.name = 'people';
  mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  mesh.frustumCulled = false;
  mesh.castShadow = false;
  mesh.receiveShadow = false;
  const colours = new Float32Array(POPULATION * 3);
  const c = new THREE.Color();
  for (let i = 0; i < POPULATION; i++) {
    c.setHex(agents[i].colour);
    colours[i * 3] = c.r; colours[i * 3 + 1] = c.g; colours[i * 3 + 2] = c.b;
  }
  mesh.instanceColor = new THREE.InstancedBufferAttribute(colours, 3);
  scene.add(mesh);
  peopleState.mesh = mesh;

  for (const a of agents) assignDestination(a);
  return peopleState;
}

// ---- Routing --------------------------------------------------------

function pickDestination(a) {
  const net = peopleState._net;
  const rng = peopleState._rng;
  if (a.activity === ACTIVITY.PARK_USER) {
    const p = peopleState._parkNodes;
    return p.length ? rng.pick(p) : -1;
  }
  const pool = destinationsFor(a.activity, peopleState._buildings);
  if (!pool.length) return -1;
  const b = rng.pick(pool);
  const n = peopleState._doorOf.get(b.tag);
  return n === undefined ? -1 : n;
}

/**
 * Give an agent somewhere to be, and a way to get there.
 *
 * Every route has a fallback.  A destination that cannot be reached is
 * not walked to in a straight line and is not silently retried forever:
 * it is counted, and another destination is chosen.  After a few
 * failures the agent goes home, which is always reachable because that
 * is where it started.
 */
function assignDestination(a) {
  const net = peopleState._net;
  // Start from where the agent actually IS, not from where its previous
  // route was supposed to end.  A re-route mid-walk took the old
  // destination as the origin, so the new route began somewhere the agent
  // was not — and it then walked straight there across whatever lay
  // between.  Eighteen agents were off their own route because of this.
  const here = net.nearest(a.x, a.z, ['sidewalk', 'door', 'park']);
  for (let attempt = 0; attempt < 4; attempt++) {
    const dest = pickDestination(a);
    if (dest < 0 || dest === here) continue;
    const r = net.route(here, dest);
    if (r && r.length > 1) {
      a.route = r; a.leg = 0; a.t = 0; a.dest = dest;
      a.state = STATE.WALKING;
      return true;
    }
    a.failures++;
    peopleState.stats.routeFailures++;
  }
  // Fallback: go home.  Never teleport, never push through geometry.
  const home = peopleState._doorOf.get(a.homeTag);
  if (home !== undefined && home !== here) {
    const r = net.route(here, home);
    if (r && r.length > 1) {
      a.route = r; a.leg = 0; a.t = 0; a.dest = home;
      a.state = STATE.WALKING;
      peopleState.stats.reroutes++;
      return true;
    }
  }
  a.state = STATE.ACTIVE;
  a.dwell = 6 + peopleState._rng.next() * 10;
  return false;
}

// ---- Update ---------------------------------------------------------

// Scratch objects, allocated once.  Composing a matrix per agent per
// frame with fresh Vector3s made forty-two allocations a frame for no
// reason; at this size that is pure garbage.
const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _up = new THREE.Vector3(0, 1, 0);
const _scl = new THREE.Vector3(1, 1, 1);
const _pos = new THREE.Vector3();
const _scl2 = new THREE.Vector3(1, 1, 1);
const _hidden = new THREE.Vector3(0, -900, 0);
let _frame = 0;
let _aggregating = false;         // sticky between thresholds
const _buckets = new Map();

/**
 * Advance every agent: movement, routing, lifecycle.
 *
 * Deliberately separate from drawing.  Both representations call this and
 * nothing else touches agent state, so switching LOD cannot change where
 * anybody walks — which is the one thing a readability change must never
 * do.
 */
function stepAgents(dt, camPos, st, net) {
  let active = 0, stuck = 0;
  for (let i = 0; i < st.agents.length; i++) {
    const a = st.agents[i];
    if (Math.hypot(a.x - camPos.x, a.z - camPos.z) > SIM_RADIUS) continue;
    active++;

    if (a.state === STATE.SPAWN) a.state = STATE.WALKING;

    if (a.state === STATE.WALKING && a.route) {
      const target = net.nodes[a.route[Math.min(a.leg + 1, a.route.length - 1)]];
      const vx = target.x - a.x, vz = target.z - a.z;
      const d = Math.hypot(vx, vz);
      if (d < ARRIVE_R) {
        a.leg++;
        if (a.leg >= a.route.length - 1) { a.state = STATE.ARRIVED; a.speed = 0; }
      } else {
        a.speed = Math.min(WALK_SPEED, a.speed + ACCEL * dt);
        const ux = vx / d, uz = vz / d;
        const step = a.speed * dt;

        // Collision as a SAFETY NET, not a per-frame tax.  The pedestrian
        // network is built on pavements, doorsteps and park ground, so a
        // route is walkable by construction and this almost never changes
        // the outcome.  Running it for every agent every frame tested 42
        // agents against ~1800 bodies and cost 36 ms a frame on its own.
        if (((_frame + i) & 7) === 0) {
          const res = collisionRegistry.preventTunneling(
            a.x, a.z, ux * step * 8, uz * step * 8, 0.32, b => b.type !== 'interior');
          const moved = Math.hypot(res.x - a.x, res.z - a.z);
          if (moved < step * 8 * 0.2) {
            a.stuckFor = (a.stuckFor || 0) + dt * 8;
            if (a.stuckFor > 1.5) { stuck++; a.stuckFor = 0; assignDestination(a); }
          } else { a.stuckFor = 0; a.x = res.x; a.z = res.z; }
        } else {
          a.x += ux * step; a.z += uz * step;
        }
        a.yaw = Math.atan2(ux, uz);
      }
    } else if (a.state === STATE.ARRIVED) {
      a.state = STATE.ACTIVE;
      a.dwell = 5 + st._rng.next() * 14;
    } else if (a.state === STATE.ACTIVE) {
      a.dwell -= dt;
      if (a.dwell <= 0) a.state = STATE.DEPARTING;
    } else if (a.state === STATE.DEPARTING) {
      a.origin = a.dest;
      assignDestination(a);
    }
  }
  st.stats.active = active;
  st.stats.stuck = stuck;
}

export function updatePeople(dt, camPos) {
  const st = peopleState;
  if (!st.enabled || !st.mesh || !st.agents.length) return;
  const net = st._net;
  const m = _m, q = _q, up = _up, scl = _scl, hidden = _hidden;
  _frame++;

  // Which representation?  Decided from camera ALTITUDE, once per frame,
  // for the whole population — never per agent, so an individual and the
  // group containing it can never be drawn at the same time.
  if (_aggregating) { if (camPos.y < AGG_OFF) _aggregating = false; }
  else { if (camPos.y > AGG_ON) _aggregating = true; }
  st.stats.mode = _aggregating ? 'aggregate' : 'individual';

  // The simulation runs identically either way.
  stepAgents(dt, camPos, st, net);

  let drawn = 0;

  // ---- Aggregate: one instance per GROUP of people -------------------
  if (_aggregating) {
    _buckets.clear();
    for (const a of st.agents) {
      if (Math.hypot(a.x - camPos.x, a.z - camPos.z) > AGG_DRAW_RADIUS) continue;
      const k = Math.round(a.x / AGG_BUCKET) + ':' + Math.round(a.z / AGG_BUCKET);
      let b = _buckets.get(k);
      if (!b) { b = { x: 0, z: 0, n: 0 }; _buckets.set(k, b); }
      b.x += a.x; b.z += a.z; b.n++;
    }
    // Scale to hold a readable size on screen, with a little more weight
    // for a group than for one person.
    // Target ~15 px rather than ~8.  At 7-10 px, correctly tinted and
    // correctly placed, the markers were still findable only if you knew
    // to look — measured, then checked against the render.  Above 120 m
    // nothing else in frame is at human scale either, so an enlarged
    // silhouette reads as "people here" rather than misstating a size the
    // viewer can compare against anything.
    const base = Math.max(2.5, Math.min(10.0, camPos.y / 52));
    let i = 0;
    for (const b of _buckets.values()) {
      if (i >= st.agents.length) break;
      const k = base * (1 + 0.16 * Math.min(6, b.n - 1));
      _pos.set(b.x / b.n, 0, b.z / b.n);
      q.setFromAxisAngle(up, 0);
      _scl2.set(k, k, k);
      m.compose(_pos, q, _scl2);
      st.mesh.setMatrixAt(i, m);
      i++; drawn++;
    }
    for (; i < st.agents.length; i++) { m.compose(hidden, q, scl); st.mesh.setMatrixAt(i, m); }

    // Tint the markers once on entering aggregate mode, and restore the
    // per-person colours once on leaving.  Rewriting the colour buffer
    // every frame would be pure cost for a value that does not change.
    if (!st._tinted) {
      const c = st.mesh.instanceColor;
      for (let k = 0; k < st.agents.length; k++) {
        c.array[k * 3] = AGG_TINT.r; c.array[k * 3 + 1] = AGG_TINT.g; c.array[k * 3 + 2] = AGG_TINT.b;
      }
      c.needsUpdate = true; st._tinted = true;
    }
    // Per-agent placement flags are stale now; clear them so the switch
    // back to individuals rewrites every matrix rather than trusting a
    // cached "already placed".
    for (const a of st.agents) { a._placed = false; a._hidden = false; }
    st.mesh.instanceMatrix.needsUpdate = true;
    st.stats.drawn = drawn;
    st.stats.clusters = _buckets.size;
    return;
  }

  // ---- Individual: one instance per person ---------------------------
  st.stats.clusters = 0;
  if (st._tinted) {
    const c = st.mesh.instanceColor, col = new THREE.Color();
    for (let k = 0; k < st.agents.length; k++) {
      col.setHex(st.agents[k].colour);
      c.array[k * 3] = col.r; c.array[k * 3 + 1] = col.g; c.array[k * 3 + 2] = col.b;
    }
    c.needsUpdate = true; st._tinted = false;
  }
  for (let i = 0; i < st.agents.length; i++) {
    const a = st.agents[i];
    const far = Math.hypot(a.x - camPos.x, a.z - camPos.z);
    if (far < DRAW_RADIUS) {
      q.setFromAxisAngle(up, a.yaw);
      _pos.set(a.x, 0, a.z);
      _scl2.set(1, 1, 1);
      m.compose(_pos, q, _scl2);
      st.mesh.setMatrixAt(i, m);
      a._placed = true; a._hidden = false;
      drawn++;
    } else if (!a._hidden) {
      m.compose(hidden, q, scl);
      st.mesh.setMatrixAt(i, m);
      a._hidden = true; a._placed = false;
    }
  }
  st.mesh.instanceMatrix.needsUpdate = true;
  st.stats.drawn = drawn;
}

/** Diagnostic snapshot for qa/human-presence.cjs. */
export function peopleSummary() {
  const st = peopleState;
  const byActivity = {}, byState = {};
  for (const a of st.agents) {
    byActivity[a.activity] = (byActivity[a.activity] || 0) + 1;
    byState[a.state] = (byState[a.state] || 0) + 1;
  }
  return {
    population: st.agents.length,
    active: st.stats.active,
    drawn: st.stats.drawn,
    routeFailures: st.stats.routeFailures,
    reroutes: st.stats.reroutes,
    stuck: st.stats.stuck,
    byActivity, byState,
    net: st._net ? st._net.stats : null,
    agents: st.agents.map(a => ({
      id: a.id, activity: a.activity, state: a.state,
      x: +a.x.toFixed(2), z: +a.z.toFixed(2),
      origin: a.origin, dest: a.dest,
      routeLen: a.route ? a.route.length : 0,
      failures: a.failures,
    })),
  };
}
