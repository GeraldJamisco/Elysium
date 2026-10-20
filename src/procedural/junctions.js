// ============================================================
// JUNCTIONS — Phase 8.6 transportation infrastructure
//
// Phase 8.5 gave Veridian Cap a connected, planarized road graph.  What
// it did not give it was a transportation SYSTEM: every junction in the
// settlement looked identical from Eagle, whether it was two houses'
// driveways meeting or the point where the regional network arrives.
//
// This module classifies every junction from the graph and builds the
// control each one earns.  The classification is data first — a future
// vehicle, bus, NPC or emergency-services system asks this module "what
// kind of intersection is this?" and gets an answer — and geometry
// second.
//
// The hierarchy, and what it earns:
//
//   LOCAL          street x street              nothing
//   NEIGHBOURHOOD  collector x street           a marked crossing
//   MAJOR          arterial x collector         signals + stop lines
//   STRATEGIC      arterial x arterial          signals
//   REGIONAL       regional x arterial          roundabout, at the gateway
//
// THE RESTRAINT IS THE POINT.  The first classifier written for this
// phase recommended 68 roundabouts for a town of 150 junctions, because
// an arterial bending a few degrees as it crossed a street registered as
// two arterials meeting.  A road passing through a junction is ONE road.
// Getting that wrong is how a small town ends up with the infrastructure
// of a motorway network.
// ============================================================

import * as THREE from 'three';
import { collisionRegistry } from '../city/collision.js';
import { segmentsNear } from './roads.js';
import { allSettlements } from './settlement.js';

// Road class ranks, fastest/widest first.  'authored' is Veridian Cap's
// own street grid, which functions as a collector.
const RANK = { regional: 5, arterial: 4, collector: 3, authored: 3, street: 2, lane: 1 };

const SNAP = 4.0;

export const CONTROL = {
  NONE: 'NONE',
  CROSSING: 'CROSSING',
  SIGNAL: 'SIGNAL',
  ROUNDABOUT: 'ROUNDABOUT',
};

let _junctions = null;

export function clearJunctions() { _junctions = null; }

/**
 * Classify every junction around a settlement.  Deterministic: it is a
 * pure function of the road graph, which is itself deterministic.
 */
export function buildJunctions(range = 900) {
  if (_junctions) return _junctions;

  const segs = segmentsNear(0, 0, range);
  const nodes = [];
  const keyOf = (x, z) => {
    for (let i = 0; i < nodes.length; i++) {
      if (Math.hypot(nodes[i].x - x, nodes[i].z - z) <= SNAP) return i;
    }
    nodes.push({ x, z, legs: [] });
    return nodes.length - 1;
  };
  for (const s of segs) {
    const a = keyOf(s.x1, s.z1), b = keyOf(s.x2, s.z2);
    nodes[a].legs.push({ type: s.type, bear: Math.atan2(s.z2 - s.z1, s.x2 - s.x1), width: s.width });
    nodes[b].legs.push({ type: s.type, bear: Math.atan2(s.z1 - s.z2, s.x1 - s.x2), width: s.width });
  }

  const norm = a => Math.atan2(Math.sin(a), Math.cos(a));

  /**
   * The approaches a junction really has.
   *
   * Planarization splits roads at every crossing, so a node's raw leg
   * list contains short fragments pointing in almost every direction.
   * Drawing a crossing per leg painted zebra bars at a dozen angles,
   * several of them out over grass — markings scattered around a
   * junction like litter.  An approach is a DIRECTION traffic arrives
   * from: one per bearing, widest road wins.
   */
  const principalApproaches = legs => {
    const out = [];
    for (const l of legs) {
      const same = out.find(o => Math.abs(norm(o.bear - l.bear)) < 0.45);
      if (same) {
        if ((RANK[l.type] || 1) > (RANK[same.type] || 1)) {
          same.type = l.type; same.width = l.width;
        }
        continue;
      }
      out.push({ bear: l.bear, type: l.type, width: l.width });
    }
    return out;
  };
  const isOpposite = (a, b) => Math.abs(Math.abs(norm(a - b)) - Math.PI) < 0.65;

  const out = [];
  nodes.forEach((n, i) => {
    if (n.legs.length < 3) return;

    // Reduce legs to distinct ROADS: a road that passes straight through
    // arrives on one bearing and leaves on the opposite one.
    const used = new Array(n.legs.length).fill(false);
    const roads = [];
    for (let a = 0; a < n.legs.length; a++) {
      if (used[a]) continue;
      let partner = -1;
      for (let b = a + 1; b < n.legs.length; b++) {
        if (used[b] || n.legs[b].type !== n.legs[a].type) continue;
        if (isOpposite(n.legs[a].bear, n.legs[b].bear)) { partner = b; break; }
      }
      used[a] = true;
      if (partner >= 0) used[partner] = true;
      roads.push({ type: n.legs[a].type, through: partner >= 0 });
    }
    if (roads.length < 2) return;                 // a bend, not a junction

    const ranks = roads.map(r => RANK[r.type] || 1).sort((a, b) => b - a);
    const hi = ranks[0], second = ranks[1];
    const arms = n.legs.length;

    let cls, control;
    if (hi >= 5 && second >= 4) { cls = 'REGIONAL'; control = CONTROL.ROUNDABOUT; }
    else if (hi >= 5) { cls = 'REGIONAL'; control = CONTROL.SIGNAL; }
    else if (hi >= 4 && second >= 4) { cls = 'STRATEGIC'; control = CONTROL.SIGNAL; }
    else if (hi >= 4 && second >= 3) { cls = 'MAJOR'; control = arms >= 4 ? CONTROL.SIGNAL : CONTROL.CROSSING; }
    else if (hi >= 4) { cls = 'MAJOR'; control = CONTROL.CROSSING; }
    else if (hi >= 3) { cls = 'NEIGHBOURHOOD'; control = CONTROL.CROSSING; }
    else { cls = 'LOCAL'; control = CONTROL.NONE; }

    out.push({
      id: 'INT-' + String(out.length + 1).padStart(3, '0'),
      x: n.x, z: n.z,
      arms, roads: roads.map(r => r.type),
      cls, control,
      approaches: principalApproaches(n.legs),
      r: Math.hypot(n.x, n.z),
    });
  });

  // ---- Restraint pass ----
  //
  // Classification says what a junction COULD carry; these rules decide
  // what actually gets built.  Without them the grid's regularity makes
  // every equivalent junction claim the same treatment and the town ends
  // up signalised end to end.
  rationTreatments(out);

  _junctions = out;
  return out;
}

/**
 * Thin the recommended controls down to what a settlement this size
 * would really build.
 *
 * Two rules, both about spacing:
 *
 *   A roundabout is a piece of regional infrastructure.  Only the
 *   highest-ranked one in any 260 m survives, so the cluster of regional
 *   junctions where the trunk roads converge on the gateway becomes ONE
 *   gateway roundabout rather than four competing ones.
 *
 *   Signals are not installed within 120 m of each other on the same
 *   corridor — a driver meeting a signal every block is a sign the
 *   network is being over-controlled, not well controlled.
 */
function rationTreatments(list) {
  // Mark the junction that IS the settlement gateway.  It is the one
  // place the brief names outright, and the spacing rule below would
  // otherwise demote it in favour of a bigger junction further out: the
  // gateway is defined by what it means, not by how many arms it has.
  for (const s of allSettlements()) {
    if (!s.gateways) continue;
    for (const g of s.gateways) {
      let best = null, bd = 140;
      for (const j of list) {
        const d = Math.hypot(j.x - g[0], j.z - g[1]);
        if (d < bd) { bd = d; best = j; }
      }
      if (best) { best.isGateway = true; best.cls = 'REGIONAL'; best.control = CONTROL.ROUNDABOUT; }
    }
  }

  const score = j => (j.isGateway ? 1000 : j.cls === 'REGIONAL' ? 400 : j.cls === 'STRATEGIC' ? 300 : 200) + j.arms * 10;
  const byScore = list.slice().sort((a, b) => score(b) - score(a));

  const keptRound = [];
  const keptSignal = [];
  for (const j of byScore) {
    if (j.control === CONTROL.ROUNDABOUT) {
      if (keptRound.some(k => Math.hypot(k.x - j.x, k.z - j.z) < 260)) {
        j.control = CONTROL.SIGNAL;              // demote the runners-up
      } else {
        keptRound.push(j);
      }
    }
  }
  for (const j of byScore) {
    if (j.control !== CONTROL.SIGNAL) continue;
    if (keptSignal.some(k => Math.hypot(k.x - j.x, k.z - j.z) < 120)) {
      j.control = CONTROL.CROSSING;
    } else {
      keptSignal.push(j);
    }
  }
}

export function allJunctions() { return _junctions || buildJunctions(); }

/** Junctions whose centre falls inside a chunk — that chunk builds them. */
export function junctionsIn(minX, minZ, maxX, maxZ) {
  return allJunctions().filter(j =>
    j.x >= minX && j.x < maxX && j.z >= minZ && j.z < maxZ);
}

export function junctionSummary() {
  const list = allJunctions();
  const cls = {}, ctrl = {};
  list.forEach(j => {
    cls[j.cls] = (cls[j.cls] || 0) + 1;
    ctrl[j.control] = (ctrl[j.control] || 0) + 1;
  });
  return { junctions: list.length, cls, ctrl };
}

// ============================================================
// GEOMETRY
// ============================================================

const C = {
  pole: 0x54595a,
  head: 0x2f3436,
  lensRed: 0xd4573f,
  lensAmber: 0xd9a441,
  mark: 0xc4bfae,
  kerb: 0xa8a294,
  island: 0x7fa063,
  signBack: 0x46504a,
};

/**
 * Build the control geometry for the junctions inside a chunk.
 * Pushed into the chunk accumulator so it merges with everything else.
 */
export function buildJunctionGeometry(key, bounds, accPart, accSlab, lod, track) {
  const list = junctionsIn(bounds.minX, bounds.minZ, bounds.maxX, bounds.maxZ);
  for (const j of list) {
    if (j.control === CONTROL.CROSSING) buildCrossings(key, j, accPart, lod);
    else if (j.control === CONTROL.SIGNAL) buildSignals(key, j, accPart, accSlab, lod, track);
    else if (j.control === CONTROL.ROUNDABOUT) buildRoundabout(key, j, accPart, accSlab, lod, track);
  }
}

const Y_MARK = 0.074;          // just above the road markings at 0.072

/**
 * True if a point lies on a carriageway.
 *
 * Paint belongs on tarmac.  Crossing bars and stop lines are positioned
 * by stepping out along an approach bearing, and an approach whose road
 * is short, bends, or ends at the junction puts that step onto grass —
 * so the settlement collected zebra bars lying in the open with no road
 * under them.  Every mark is now checked against the road network before
 * it is drawn, which is a rule that cannot be got wrong by geometry
 * drifting later.
 */
function onCarriageway(x, z) {
  const segs = segmentsNear(x, z, 30);
  for (let i = 0; i < segs.length; i++) {
    const g = segs[i];
    const dx = g.x2 - g.x1, dz = g.z2 - g.z1;
    const l2 = dx * dx + dz * dz;
    let u = l2 ? ((x - g.x1) * dx + (z - g.z1) * dz) / l2 : 0;
    u = u < 0 ? 0 : u > 1 ? 1 : u;
    const px = x - (g.x1 + u * dx), pz = z - (g.z1 + u * dz);
    if (px * px + pz * pz <= (g.width / 2) * (g.width / 2)) return true;
  }
  return false;
}

/** Zebra bars across each approach, set back from the junction. */
function buildCrossings(key, j, accPart, lod) {
  if (lod > 1) return;
  for (const ap of j.approaches) {
    const w = ap.width || 6;
    const set = w * 0.9 + 3.2;                     // clear of the junction box
    const cx = j.x + Math.cos(ap.bear) * set;
    const cz = j.z + Math.sin(ap.bear) * set;
    if (!onCarriageway(cx, cz)) continue;          // no road here: no paint
    const bars = 5, pitch = w * 0.82 / bars;
    for (let i = 0; i < bars; i++) {
      const o = -w * 0.41 + (i + 0.5) * pitch;
      const g = new THREE.PlaneGeometry(0.44, w * 0.52);
      g.rotateX(-Math.PI / 2);
      g.rotateY(-ap.bear);
      g.translate(cx + Math.cos(ap.bear + Math.PI / 2) * o,
                  Y_MARK,
                  cz + Math.sin(ap.bear + Math.PI / 2) * o);
      accPart(key, g, 'opaque', C.mark, { jitter: 0.01 });
    }
  }
}

/**
 * A signalised junction: a stop line and a signal on each approach.
 *
 * The signal stands on the NEAR-RIGHT corner of its approach and its
 * head faces back down that approach, which is where a driver arriving
 * on it would look.  Placing one pole at the junction centre and calling
 * it done is the failure mode the brief names explicitly.
 */
function buildSignals(key, j, accPart, accSlab, lod, track) {
  buildCrossings(key, j, accPart, lod);
  if (lod > 0) return;                              // poles are walk-scale detail

  for (const ap of j.approaches) {
    const w = ap.width || 6;
    const set = w * 0.9 + 1.4;
    const bx = j.x + Math.cos(ap.bear) * set;
    const bz = j.z + Math.sin(ap.bear) * set;
    if (!onCarriageway(bx, bz)) continue;          // no road here: no signal

    // Stop line across the approach, on the near side of the crossing.
    const sl = new THREE.PlaneGeometry(0.5, w * 0.88);
    sl.rotateX(-Math.PI / 2);
    sl.rotateY(-ap.bear);
    sl.translate(bx, Y_MARK, bz);
    accPart(key, sl, 'opaque', C.mark, { jitter: 0.01 });

    // Pole on the right-hand kerb of the approach.
    const side = ap.bear + Math.PI / 2;
    const px = bx + Math.cos(side) * (w / 2 + 1.5);
    const pz = bz + Math.sin(side) * (w / 2 + 1.5);

    const H = 4.6;
    accSlab(key, 'opaque', C.pole, 0.46, 0.14, 0.46, px, 0.07, pz, { jitter: 0.02 });
    accSlab(key, 'opaque', C.pole, 0.17, H, 0.17, px, H / 2, pz, { jitter: 0.02 });

    // Head, facing back down the approach toward oncoming traffic.
    const face = ap.bear;                            // outward along the approach
    const hx = px - Math.cos(side) * 0.55;
    const hz = pz - Math.sin(side) * 0.55;
    const box = new THREE.BoxGeometry(0.44, 1.18, 0.34);
    box.rotateY(-face);
    box.translate(hx, H - 0.5, hz);
    accPart(key, box, 'opaque', C.head, { jitter: 0.02 });

    // A pale backboard, then three lenses on the face that looks back
    // down the road.  At 0.12 m the lenses were technically present and
    // invisible from the footway: a signal a pedestrian cannot read is
    // not infrastructure, it is a post.
    const bb = new THREE.BoxGeometry(0.62, 1.34, 0.05);
    bb.rotateY(-face);
    bb.translate(hx + Math.cos(face) * 0.185, H - 0.5, hz + Math.sin(face) * 0.185);
    accPart(key, bb, 'opaque', 0x1f2426, { ao: 0.9 });

    for (let i = 0; i < 3; i++) {
      const lens = new THREE.CircleGeometry(0.165, 10);
      lens.rotateY(-face + Math.PI / 2);
      lens.translate(
        hx + Math.cos(face) * 0.225,
        H - 0.14 - i * 0.38,
        hz + Math.sin(face) * 0.225);
      accPart(key, lens, 'glow',
              i === 0 ? C.lensRed : i === 1 ? C.lensAmber : 0x6fc47a, { jitter: 0.02 });
    }

    // A pole is solid.
    registerPost(px, pz, 0.3, H, 'signal', track);
  }
}

/**
 * The gateway roundabout.
 *
 * One piece of regional infrastructure, at the point where the trunk
 * network meets the town's own road.  Central island, circulating
 * carriageway, an apron ring, and a planted centre — the Elysium
 * register rather than a motorway interchange.
 */
function buildRoundabout(key, j, accPart, accSlab, lod, track) {
  const R_ISLAND = 7.0;
  const R_ROAD = 15.0;

  // Circulating carriageway.
  const road = new THREE.RingGeometry(R_ISLAND, R_ROAD, 36);
  road.rotateX(-Math.PI / 2);
  road.translate(j.x, 0.052, j.z);
  accPart(key, road, 'opaque', 0x4f5354, { jitter: 0.012 });

  // Apron and kerb line around the island.
  const apron = new THREE.RingGeometry(R_ISLAND, R_ISLAND + 1.1, 32);
  apron.rotateX(-Math.PI / 2);
  apron.translate(j.x, 0.062, j.z);
  accPart(key, apron, 'opaque', C.kerb, { jitter: 0.02 });

  // Planted island, raised, with a low kerb.
  const isl = new THREE.CircleGeometry(R_ISLAND, 28);
  isl.rotateX(-Math.PI / 2);
  isl.translate(j.x, 0.34, j.z);
  accPart(key, isl, 'foliage', C.island, { jitter: 0.04 });
  const rim = new THREE.CylinderGeometry(R_ISLAND, R_ISLAND, 0.34, 28, 1, true);
  rim.translate(j.x, 0.17, j.z);
  accPart(key, rim, 'opaque', C.kerb, { jitter: 0.02 });

  if (lod === 0) {
    // A marker at the centre: this is the settlement's front door.
    accSlab(key, 'opaque', 0xb3ac9c, 2.0, 0.5, 2.0, j.x, 0.6, j.z, { jitter: 0.02 });
    accSlab(key, 'opaque', 0xc8c2b2, 0.7, 3.4, 0.7, j.x, 2.5, j.z, { jitter: 0.02 });
    accSlab(key, 'glow', 0x9fd0b4, 0.5, 0.5, 0.5, j.x, 4.35, j.z, { jitter: 0.03 });
  }

  // The island is solid; the carriageway is not.
  registerPost(j.x, j.z, R_ISLAND, 1.2, 'roundabout-island', track);

  // Give-way markings and a splitter nose on each approach.
  for (const ap of j.approaches) {
    const w = ap.width || 8;
    const gx = j.x + Math.cos(ap.bear) * (R_ROAD + 1.0);
    const gz = j.z + Math.sin(ap.bear) * (R_ROAD + 1.0);
    if (!onCarriageway(gx, gz)) continue;          // no road here: no paint
    const give = new THREE.PlaneGeometry(0.6, w * 0.9);
    give.rotateX(-Math.PI / 2);
    give.rotateY(-ap.bear);
    give.translate(gx, Y_MARK, gz);
    accPart(key, give, 'opaque', C.mark, { jitter: 0.01 });
  }
}

/** Register a solid post/island, tracked for chunk unload. */
function registerPost(x, z, r, h, type, track) {
  const body = {
    minX: x - r, maxX: x + r, minY: 0, maxY: h,
    minZ: z - r, maxZ: z + r,
    type, tag: `${type}@${x.toFixed(1)},${z.toFixed(1)}`,
  };
  if (Array.isArray(track)) track.push(body);
  collisionRegistry.registerBody(body);
}
