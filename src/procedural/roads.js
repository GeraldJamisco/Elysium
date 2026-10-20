// ============================================================
// ROAD NETWORK — Phase 7 visual sanitation
//
// The Phase 7 road layer generated arterials and locals inside
// segmentsForChunk() using a CHUNK-SEEDED rng.  Two consequences, both
// visible from Eagle in the "before" survey: a road crossing a chunk
// boundary was generated differently on each side and so never joined
// up, and roads were spawned wherever a highway happened to pass,
// including across country nobody lives in.  The result was a field of
// disconnected dashes.
//
// The network is now GLOBAL and OWNED BY PLACES, in four classes:
//
//   REGIONAL   long-distance links between settlements.  Routed as
//              polylines that bend toward the saddles in the landform,
//              so they read as following the country rather than being
//              ruled across it.  These are the only roads permitted in
//              open land, and every one of them connects two places.
//
//   ARTERIAL   a settlement's own spokes and orbital rings.  Where a
//              regional road arrives, a spoke is aligned to it, so the
//              regional road becomes the town's main street instead of
//              stopping at an arbitrary boundary.
//
//   STREET     neighbourhood grids.  Each district has its own
//              orientation, so a settlement is a set of locally coherent
//              grains meeting at angles, never one mathematical lattice.
//              Streets are marched out sample by sample and TERMINATE
//              WHERE DEVELOPMENT DOES, which is what gives the built-up
//              area a legible edge.
//
//   LANE       short local connections and cul-de-sacs in the low-density
//              bands, where a full grid would be too much road.
//
// A settlement's roads are generated once, lazily, and cached; the chunk
// layer just queries a uniform spatial index.  Everything stays at
// y=0.012 and deterministic from the global seed.
// ============================================================

import * as THREE from 'three';
import { PROC } from '../config.js';
import { createRNG, noise2, fbm2, hash2 } from './seed.js';
import { allSettlements, developmentAt, BAND, insideAuthoredTown, reservationAt } from './settlement.js';
import { landformAt } from './terrain.js';
import { authoredStreetSegments } from '../city/layout.js';

// How far outside an authored town's block boundary its perimeter
// collector runs: far enough to clear the footway and the block corner,
// close enough to read as the town's own edge.
const PERIM_OFFSET = 11;

// Vertical order of the road surfaces, above the land cover at 0.0025.
const Y_ROAD = 0.050;
const Y_FOOT = 0.062;
const Y_MARK = 0.072;

// The hierarchy, widest first.  COLLECTOR is new in Phase 8.5: it is the
// tier that was missing, and its absence is why the network came apart.
// An arterial leaves a settlement; a local street serves frontage; but
// nothing joined a settlement's own streets to each other at its edge,
// so every authored street in Veridian Cap ended in a stub at the town
// boundary and the road out of town connected to nothing.
export const ROAD = {
  regional:  { width: 11, color: 0x4a4e50, marks: 'dashed' },
  arterial:  { width: 8,  color: 0x4f5354, marks: 'edge' },
  collector: { width: 7,  color: 0x515553, marks: 'edge' },
  street:    { width: 6,  color: 0x565a58, marks: 'none' },
  lane:      { width: 4,  color: 0x5c605c, marks: 'none' },
  authored:  { width: 8,  color: 0x4f5354, marks: 'none' },
};

// ---- Global segment store + uniform spatial index --------------------
const INDEX_CELL = 200;                 // matches PROC.chunkSize
let _segments = [];                     // every segment ever generated
let _index = new Map();                 // "ix,iz" -> segment[]
let _regional = [];                     // regional polylines, for spoke alignment
let _builtSettlements = new Set();      // settlement ids whose roads exist
let _nextId = 1;
let _initialised = false;

export function clearRoads() {
  _segments = [];
  _index = new Map();
  _regional = [];
  _builtSettlements = new Set();
  _nextId = 1;
  _initialised = false;
}

function addSegment(x1, z1, x2, z2, type, owner, force) {
  const len = Math.hypot(x2 - x1, z2 - z1);
  if (len < 1.5) return null;
  // Never inside the authored town, whichever generator asked — unless
  // this is a road placed deliberately FOR that town (its perimeter
  // collector and the links onto it).  The guard exists to stop blind
  // generation landing in the settlement, not to stop the settlement
  // being connected to the world.
  if (!force && insideAuthored((x1 + x2) / 2, (z1 + z2) / 2)) return null;
  // A regional road may MEET the authored network at the gateway; it may
  // not run alongside it.  One was routed nine metres from The Reach
  // Road, parallel, for seventy metres — straight through the avenue's
  // tree line, so the authored planting stood in a procedural
  // carriageway.
  if (!force && type === 'regional' && besideAuthored((x1 + x2) / 2, (z1 + z2) / 2)) return null;
  // Reserved land is not subdivided by ANY local road.
  //
  // streetAllowed() has always refused streets here, but nothing refused
  // arterials or collectors — so a spoke ran straight across the stadium
  // site and the access chain then latched onto it, leaving a terminal
  // sitting inside protected space.  The reservation is only a
  // reservation if every road that is not passing through at regional
  // scale keeps out of it.  Regional roads are exempt: they are routed
  // between settlements and blocking one here would break the network
  // rather than protect the site.  The approach that serves the site is
  // laid by buildReservationAccess and stops on the boundary, which this
  // test does not catch because the boundary itself is not inside.
  if (!force && type !== 'regional' &&
      (reservationAt(x1, z1) || reservationAt(x2, z2) ||
       reservationAt((x1 + x2) / 2, (z1 + z2) / 2))) return null;
  const seg = {
    id: _nextId++,
    x1, z1, x2, z2,
    width: ROAD[type].width,
    type,
    owner: owner || null,
    len,
    angle: Math.atan2(z2 - z1, x2 - x1),
  };
  _segments.push(seg);

  // Index into every cell the segment's bounding box touches.  Segments
  // are short by construction (polylines are subdivided), so this stays
  // a handful of cells each.
  const i0 = Math.floor(Math.min(x1, x2) / INDEX_CELL);
  const i1 = Math.floor(Math.max(x1, x2) / INDEX_CELL);
  const j0 = Math.floor(Math.min(z1, z2) / INDEX_CELL);
  const j1 = Math.floor(Math.max(z1, z2) / INDEX_CELL);
  for (let j = j0; j <= j1; j++) {
    for (let i = i0; i <= i1; i++) {
      const k = i + ',' + j;
      let arr = _index.get(k);
      if (!arr) { arr = []; _index.set(k, arr); }
      arr.push(seg);
    }
  }
  return seg;
}

// ============================================================
// REGIONAL NETWORK
// ============================================================

/**
 * Build the inter-settlement network.  Called once at init.
 *
 * Topology is a minimum spanning tree over the settlement catalogue —
 * the cheapest network that still reaches everywhere, which is what a
 * colony would actually build — plus a small number of extra links
 * where two places are close but far apart through the tree.  Those
 * extras are what stop the network reading as a tree from above.
 *
 * Kept under the old name because chunk.js calls it at init.
 */
export function generateHighways(seed = PROC.procSeed) {
  if (_initialised) return _regional;
  _initialised = true;

  // ---- Register the authored streets in the procedural index ----
  //
  // Veridian Cap's own streets live in the ground mesh, not in this
  // segment list, so until now NOTHING procedural knew they existed.
  // The authored-town box kept buildings out of the town itself, but The
  // Reach Road runs 200 m beyond that box and had no protection at all:
  // procedural plots, boundaries and planting were laid across its
  // footway because, as far as the generator was concerned, there was no
  // road there.
  //
  // They are flagged `noDraw` — the city modules already draw them, and
  // drawing them twice would z-fight.  What matters is that every
  // procedural system that asks "is there a road here?" now gets the
  // right answer.
  for (const a of authoredStreetSegments()) {
    const seg = addSegment(a.x1, a.z1, a.x2, a.z2, 'authored', 'veridian-cap', true);
    if (seg) { seg.noDraw = true; seg.name = a.name; }
  }

  const sites = allSettlements();
  if (sites.length < 2) return _regional;

  // ---- Prim's MST over settlement centres ----
  const inTree = new Array(sites.length).fill(false);
  const best = new Array(sites.length).fill(Infinity);
  const parent = new Array(sites.length).fill(-1);
  best[0] = 0;
  const edges = [];

  for (let iter = 0; iter < sites.length; iter++) {
    let pick = -1;
    for (let i = 0; i < sites.length; i++) {
      if (!inTree[i] && (pick === -1 || best[i] < best[pick])) pick = i;
    }
    if (pick === -1) break;
    inTree[pick] = true;
    if (parent[pick] >= 0) edges.push([parent[pick], pick]);

    for (let i = 0; i < sites.length; i++) {
      if (inTree[i]) continue;
      // Bigger places attract links: dividing by tier makes the network
      // hang off the large settlements the way real trunk roads do.
      const d = Math.hypot(sites[i].x - sites[pick].x, sites[i].z - sites[pick].z);
      const w = d / (1 + sites[pick].tier * 0.14);
      if (w < best[i]) { best[i] = w; parent[i] = pick; }
    }
  }

  // ---- Extra links: close pairs that the tree left unconnected ----
  const have = new Set(edges.map(([a, b]) => Math.min(a, b) + ':' + Math.max(a, b)));
  for (let a = 0; a < sites.length; a++) {
    for (let b = a + 1; b < sites.length; b++) {
      const key = a + ':' + b;
      if (have.has(key)) continue;
      const d = Math.hypot(sites[a].x - sites[b].x, sites[a].z - sites[b].z);
      // Only worth a road if both ends are substantial and they are near.
      if (d > PROC.regionalLinkMax) continue;
      if (sites[a].tier + sites[b].tier < 4) continue;
      if (hash2(a * 31 + 7, b * 17 + 3) > 0.45) continue;
      edges.push([a, b]);
      have.add(key);
    }
  }

  for (const [a, b] of edges) routeRegional(sites[a], sites[b]);

  // Clear the middle of every gateway roundabout.
  //
  // The roundabout was DRAWN over the junction and the roads were never
  // touched, so the carriageways ran straight through the island and out
  // the other side: a ring painted on a crossroads, with nothing actually
  // meeting it.  Approaches now stop at the circulating carriageway,
  // which is what makes it a roundabout rather than a decoration.
  for (const s of sites) {
    if (!s.gateways) continue;
    for (const g of s.gateways) trimForRoundabout(g[0], g[1], 15.5);
  }
  return _regional;
}

/**
 * Route one regional road between two settlements.
 *
 * The straight line is subdivided and each interior point is displaced
 * perpendicular by two influences: a low-frequency noise term that gives
 * the road a lazy, surveyed curve, and a downhill term that pulls it
 * toward lower ground.  Together they produce a road that looks chosen
 * rather than computed, and that runs between the hills instead of over
 * them.
 */
function routeRegional(a, b) {
  // An authored settlement is entered through its gateway, not through
  // its centre — see the note on VERIDIAN_CAP.gateways in settlement.js.
  const A = gatewayToward(a, b);
  const B = gatewayToward(b, a);

  const dx = B.x - A.x, dz = B.z - A.z;
  const total = Math.hypot(dx, dz);
  if (total < 1) return;

  const ux = dx / total, uz = dz / total;
  const px = -uz, pz = ux;                    // unit perpendicular

  // One control point per ~180 m, so the curve has room to bend but the
  // segment list stays short.
  const n = Math.max(3, Math.min(48, Math.round(total / 180)));
  const pts = [];
  const amp = Math.min(total * 0.10, 240);    // never bend more than a tenth of the run

  for (let i = 0; i <= n; i++) {
    const t = i / n;
    let x = A.x + dx * t;
    let z = A.z + dz * t;

    // Taper to zero at both ends so the road arrives straight at each town.
    const taper = Math.sin(Math.PI * t);

    if (taper > 0.001) {
      const wander = (fbm2(x * 0.0009 + 41.7, z * 0.0009 - 8.3, 2) - 0.5) * 2;
      // Downhill pull: compare the landform a step to each side and
      // move toward the lower one.
      const probe = 70;
      const hL = landformAt(x + px * probe, z + pz * probe);
      const hR = landformAt(x - px * probe, z - pz * probe);
      const downhill = Math.max(-1, Math.min(1, (hR - hL) / 25));

      const off = (wander * 0.65 + downhill * 0.55) * amp * taper;
      x += px * off;
      z += pz * off;
    }
    pts.push([x, z]);
  }

  // Emit as a chain of segments, subdivided so each stays short enough
  // for the spatial index and for per-chunk clipping to be cheap.
  const line = [];
  for (let i = 0; i < pts.length - 1; i++) {
    const [x1, z1] = pts[i];
    const [x2, z2] = pts[i + 1];
    const segLen = Math.hypot(x2 - x1, z2 - z1);
    const steps = Math.max(1, Math.ceil(segLen / 90));
    for (let k = 0; k < steps; k++) {
      const t0 = k / steps, t1 = (k + 1) / steps;
      const s = addSegment(
        x1 + (x2 - x1) * t0, z1 + (z2 - z1) * t0,
        x1 + (x2 - x1) * t1, z1 + (z2 - z1) * t1,
        'regional', null
      );
      if (s) line.push(s);
    }
  }
  _regional.push({ a, b, segments: line });
}

/**
 * The point a regional road should attach to on a settlement.
 *
 * For a procedurally generated settlement that is its centre — its own
 * spokes are built outward from there.  For an AUTHORED one it is the
 * gateway nearest the far end, because the authored street network
 * already reaches the edge of the world on its own terms and the
 * regional road's job is to meet it there.
 */
function gatewayToward(s, other) {
  if (!s.gateways || !s.gateways.length) return { x: s.x, z: s.z };
  let best = s.gateways[0], bd = Infinity;
  for (const g of s.gateways) {
    const d = Math.hypot(other.x - g[0], other.z - g[1]);
    if (d < bd) { bd = d; best = g; }
  }
  return { x: best[0], z: best[1] };
}

/**
 * True inside an authored settlement, where the city modules own the
 * ground and nothing procedural may be drawn.  Checked at the point of
 * emission so it catches every road class at once rather than relying on
 * each generator to remember.
 */
function insideAuthored(x, z) { return insideAuthoredTown(x, z, 2); }

/**
 * Within the corridor of an authored street, but not at a gateway where
 * the two networks are supposed to meet.
 */
function besideAuthored(x, z) {
  for (let i = 0; i < _segments.length; i++) {
    const g = _segments[i];
    if (g.type !== 'authored') continue;
    const dx = g.x2 - g.x1, dz = g.z2 - g.z1;
    const l2 = dx * dx + dz * dz;
    let u = l2 ? ((x - g.x1) * dx + (z - g.z1) * dz) / l2 : 0;
    u = u < 0 ? 0 : u > 1 ? 1 : u;
    const px = x - (g.x1 + u * dx), pz = z - (g.z1 + u * dz);
    if (px * px + pz * pz > 26 * 26) continue;
    // Close by — allowed only near a declared gateway.
    for (const s of allSettlements()) {
      if (!s.gateways) continue;
      for (const gw of s.gateways) {
        // Only the gateway junction itself, not a 45 m licence to run
        // alongside the avenue: at 45 m a trunk road was still tracking
        // 3 m from the avenue centreline, straight down its line of
        // trees.  The gateway roundabout is 15 m in radius; 22 covers it.
        if (Math.hypot(x - gw[0], z - gw[1]) < 22) return false;
      }
    }
    return true;
  }
  return false;
}

/**
 * Directions in which regional roads arrive at a settlement.  Used to
 * align the settlement's own spokes, so an incoming trunk road
 * continues into town as its main street.
 */
function arrivalAngles(s) {
  const out = [];
  for (const r of _regional) {
    if (r.a === s) out.push(Math.atan2(r.b.z - s.z, r.b.x - s.x));
    else if (r.b === s) out.push(Math.atan2(r.a.z - s.z, r.a.x - s.x));
  }
  return out;
}

// ============================================================
// SETTLEMENT NETWORKS
// ============================================================

/**
 * Generate one settlement's arterials, streets and lanes.  Idempotent
 * and cached — the chunk layer calls this for any settlement whose
 * influence reaches a chunk it is about to build.
 */
export function ensureSettlementRoads(s) {
  if (!s || _builtSettlements.has(s.id)) return;
  _builtSettlements.add(s.id);

  const rng = createRNG(s.seed ^ 0x2B1D);
  // The arterials a settlement has already laid are collected as they
  // are built, so the street pass can keep out of their way.  Without
  // this the neighbourhood grids were drawn straight over the spokes and
  // the ring, which is what produced the crosshatched mess where a
  // district met an arterial.
  const arterials = [];

  // An authored settlement already has a street network.  Its outward
  // roads must CONTINUE that network, not ignore it: before Phase 8.5
  // Veridian Cap's five procedural spokes radiated at angles derived
  // from a hash, started outside the authored keep-out, and so never
  // touched the town's own streets — 165 dead ends and a settlement in
  // 255 disconnected pieces.
  const exits = s.authored ? buildTownPerimeter(s, arterials) : null;
  const spokeAngles = buildSpokes(s, rng, arterials, exits);
  buildRings(s, rng, arterials);

  // Streets are generated per district and marched independently, so
  // they stop where their district stops rather than where a road is.
  // Everything below turns that scatter of runs into a network.
  const firstStreet = _segments.length;
  buildDistricts(s, spokeAngles, rng, arterials);
  stitchNetwork(s, firstStreet);

  // Finally, make it a graph.  Until this runs, two roads that cross are
  // simply two line segments drawn over each other: there is no node at
  // the crossing, so nothing can turn from one into the other and the
  // faces between them are not enclosed by anything.  That single
  // missing operation is why the settlement audited as 79 disconnected
  // pieces with 354 nodes of degree two.
  if (s.authored) buildReservationAccess(s, arterials);

  planarizeNear(s.x, s.z, s.edgeR * 1.3);

  // ---- Final tidy, once, after the graph is built ----
  //
  // Whatever stage produces them, collinear duplicates and hanging
  // street ends only become visible once the graph is planarized.  Doing
  // this here rather than inside stitchNetwork means it catches them
  // regardless of which pass created them — and it runs ONCE, on a
  // finished graph, rather than iterating and eating streets.
  dedupeOverlaps(s);
  connectDeadEnds(s);
  planarizeNear(s.x, s.z, s.edgeR * 1.3);
  markTerminals(s);
}

/**
 * Give every dead end a visible ending.
 *
 * The terminal audit passes on graph grounds: each of the 35 terminals
 * has a reason — development thins out, the chain has served its plots,
 * the reservation boundary is there.  But a reason in the classifier is
 * not a reason a player can see.  Walked to, every one of them was the
 * same thing: carriageway, kerbs and markings cut off square in open
 * grass, which reads as a road someone forgot to finish rather than a
 * road that ended because it was done.
 *
 * So the classification that already exists decides a TREATMENT, and
 * nothing else changes — no segment is moved, added to the graph,
 * re-routed or removed.  Two endings cover every case in the world:
 *
 *   turning head  a street that stops inside built-up land stops where
 *                 a driver can turn round, which is what a cul-de-sac
 *                 actually is.
 *   taper         a road running out into open country gives up its
 *                 surfacing and narrows away as a track.
 *
 * Terminals inside the authored town keep their authored stub, and
 * terminals on the reservation boundary keep their square end, because
 * there the boundary IS the reason and a hammerhead would invent a
 * turning circle against a fence.
 */
function markTerminals(s) {
  const endDegree = (x, z) => {
    let n = 0;
    for (const o of _segments) {
      if (Math.hypot(o.x1 - x, o.z1 - z) < 1.5) n++;
      if (Math.hypot(o.x2 - x, o.z2 - z) < 1.5) n++;
    }
    return n;
  };

  for (const seg of _segments) {
    if (seg.noDraw || seg.roundabout) continue;
    if (Math.hypot(seg.x1 - s.x, seg.z1 - s.z) > s.edgeR * 1.6 &&
        Math.hypot(seg.x2 - s.x, seg.z2 - s.z) > s.edgeR * 1.6) continue;

    for (const end of ['A', 'B']) {
      const x = end === 'A' ? seg.x1 : seg.x2;
      const z = end === 'A' ? seg.z1 : seg.z2;
      if (endDegree(x, z) !== 1) continue;

      // The authored town lays its own street ends, and the reservation
      // boundary is itself the explanation.  Neither wants inventing.
      if (insideAuthoredTown(x, z, 3)) continue;
      if (reservationAt(x, z, 8)) continue;

      const dev = developmentAt(x, z);
      // BAND.EDGE is a descriptor object, not a number.  Compared
      // against intensity directly it yields NaN, every test is false
      // and every terminal silently becomes a taper — including streets
      // ending in the middle of the inner band.
      seg['term' + end] = dev.intensity >= BAND.EDGE.min ? 'head' : 'taper';
    }
  }
}

/**
 * Remove any street lying ALONG another road rather than beside it.
 *
 * At (70, 140) the graph held a street from (42,140) to (77,140) and a
 * second 7 m street from (77,140) doubling back to (70,140) on top of
 * it, its free end a dead end in the middle of another street.  A
 * terminal like that cannot be explained by anything in the world,
 * because it is not in the world: it is one road counted twice.
 */
function dedupeOverlaps(s) {
  const mine = _segments.filter(g => g.owner === s.id && g.type === 'street');
  const dead = new Set();
  const covers = (o, x, z) => {
    const dx = o.x2 - o.x1, dz = o.z2 - o.z1;
    const l2 = dx * dx + dz * dz;
    if (!l2) return false;
    let u = ((x - o.x1) * dx + (z - o.z1) * dz) / l2;
    if (u < -0.02 || u > 1.02) return false;
    u = u < 0 ? 0 : u > 1 ? 1 : u;
    const px = x - (o.x1 + u * dx), pz = z - (o.z1 + u * dz);
    return px * px + pz * pz < (o.width / 2 + 1.0) ** 2;
  };
  for (const g of mine) {
    if (dead.has(g.id)) continue;
    for (const o of _segments) {
      if (o === g || dead.has(o.id)) continue;
      if (o.len < g.len - 0.01) continue;                // keep the longer road
      if (Math.abs(Math.sin(g.angle - o.angle)) > 0.15) continue;
      if (covers(o, g.x1, g.z1) && covers(o, g.x2, g.z2)) { dead.add(g.id); break; }
    }
  }
  if (dead.size) removeSegments(dead);
}

/**
 * Join a street that stops just short of a road it plainly meets.
 *
 * Only genuine dead ends, only where the two roads cross at a real
 * angle, and never onto a trunk road.  A street ending alongside a
 * PARALLEL road is not a missing link — joining those merges two roads
 * doing different jobs, which is the "connect because it is close"
 * failure the whole phase is trying to avoid.
 */
function connectDeadEnds(s) {
  const REACH = 26;
  // Arterials get this too: an arterial stopping thirteen metres short
  // of a street it crosses at fifty degrees is the same defect as a
  // street doing it, and leaving the class out simply hid one.
  const mine = _segments.filter(g =>
    g.owner === s.id && (g.type === 'street' || g.type === 'arterial'));
  const degAt = (x, z) => {
    let n = 0;
    for (const o of _segments) {
      if (Math.hypot(o.x1 - x, o.z1 - z) < 1.5) n++;
      if (Math.hypot(o.x2 - x, o.z2 - z) < 1.5) n++;
    }
    return n;
  };

  const links = [];
  for (const g of mine) {
    for (const end of [[g.x1, g.z1], [g.x2, g.z2]]) {
      const [ex, ez] = end;
      if (degAt(ex, ez) !== 1) continue;
      let best = null;
      for (const o of _segments) {
        if (o === g || o.type === 'regional') continue;
        const d = Math.abs(Math.atan2(Math.sin(g.angle - o.angle), Math.cos(g.angle - o.angle))) % Math.PI;
        if (Math.min(d, Math.PI - d) <= 0.52) continue;  // parallel: leave it
        const pr = projectOn(o, ex, ez);
        if (pr.d < 1.0 || pr.d > REACH) continue;
        if (!best || pr.d < best.d) best = pr;
      }
      if (best) links.push([ex, ez, best.x, best.z, g.type]);
    }
  }
  // The link takes the LOWER class of the two it joins: a spur off an
  // arterial into a local street is a street, not more arterial.
  for (const [x1, z1, x2, z2, t] of links) {
    addSegment(x1, z1, x2, z2, t === 'arterial' ? 'street' : t, s.id);
  }
}

export function settlementRoadsReady(s) { return !s || _builtSettlements.has(s.id); }

/**
 * The perimeter collector of an authored settlement.
 *
 * A rectangle just outside the town's block boundary that every authored
 * street runs into, plus the road out of town.  One move, and it does
 * four things the audit said were missing: it terminates each authored
 * street at a junction instead of in mid-air, it connects The Reach Road
 * to the grid it leaves from, it forms the outer edge of the town's
 * outermost blocks, and it gives the outward arterials something real to
 * start from.
 *
 * Returns the exit points, in the direction each one leaves, so the
 * spokes can carry on from exactly where the town's streets stop.
 */
function buildTownPerimeter(s, collect) {
  const authored = authoredStreetSegments();
  if (!authored.length) return null;

  // Town extent, from the authored streets themselves.
  let maxX = 0, maxZ = 0;
  for (const a of authored) {
    if (a.name === 'The Reach Road') continue;
    maxX = Math.max(maxX, Math.abs(a.x1), Math.abs(a.x2));
    maxZ = Math.max(maxZ, Math.abs(a.z1), Math.abs(a.z2));
  }

  // Where the authored streets reach the town edge.
  const nsX = [], ewZ = [];
  for (const a of authored) {
    if (a.name === 'The Reach Road') continue;
    if (Math.abs(a.x1 - a.x2) < 0.5) { if (!nsX.includes(a.x1)) nsX.push(a.x1); }
    else if (!ewZ.includes(a.z1)) ewZ.push(a.z1);
  }

  const exits = [];
  const link = (ax, az, bx, bz) => {
    const seg = addSegment(ax, az, bx, bz, 'collector', s.id, true);
    if (seg && collect) collect.push(seg);
  };

  // ---- Each authored street simply continues ----
  //
  // Phase 8.5 ringed the whole town with a perimeter collector to gather
  // these ends.  It worked, and it was too much road: an eleven-metre
  // strip between the block edge and the ring, paved end to end, with a
  // junction wherever a street met it.  Walking the edge you were in a
  // yard of tarmac where there should have been grass, and the ring's
  // junctions read as scattered markings on nothing.
  //
  // The ring is gone.  Each street gets a short stub out to the point
  // where its arterial takes over, and nothing else is paved.
  for (const v of nsX) {
    for (const sgn of [-1, 1]) {
      link(v, sgn * maxZ, v, sgn * (maxZ + PERIM_OFFSET));
      exits.push({ x: v, z: sgn * (maxZ + PERIM_OFFSET), dir: sgn > 0 ? Math.PI / 2 : -Math.PI / 2 });
    }
  }
  for (const v of ewZ) {
    for (const sgn of [-1, 1]) {
      // The east side is handled by the edge collector below, so that the
      // road out of town gets a junction rather than a dead end.
      if (sgn > 0) continue;
      link(sgn * maxX, v, sgn * (maxX + PERIM_OFFSET), v);
      exits.push({ x: sgn * (maxX + PERIM_OFFSET), z: v, dir: sgn > 0 ? 0 : Math.PI });
    }
  }

  // ---- The east edge: one collector, so the road out of town starts
  // ---- at a junction instead of at a wall ----
  //
  // The Reach Road began at the face of a block: two lanes of carriageway
  // with markings, running into a building.  A road has to start
  // somewhere a driver can turn out of.  This short north-south collector
  // links the east ends of both cross-streets and crosses the avenue,
  // giving it a proper head.
  const reach = authored.find(a => a.name === 'The Reach Road');
  const ex = maxX + 8;
  const zTop = Math.max(...ewZ) + 4, zBot = Math.min(...ewZ) - 4;
  const cuts = [zBot, ...ewZ.slice().sort((p, q) => p - q)];
  if (reach) cuts.push(reach.z1);
  cuts.push(zTop);
  cuts.sort((p, q) => p - q);
  for (let i = 0; i < cuts.length - 1; i++) {
    const seg = addSegment(ex, cuts[i], ex, cuts[i + 1], 'collector', s.id, true);
    if (seg && collect) collect.push(seg);
  }
  for (const v of ewZ) link(maxX, v, ex, v);
  if (reach) {
    link(maxX, reach.z1, ex, reach.z1);
    exits.push({ x: ex, z: reach.z1, dir: 0 });
  }
  exits.push({ x: ex, z: zTop, dir: Math.PI / 2 });
  exits.push({ x: ex, z: zBot, dir: -Math.PI / 2 });

  return exits;
}

/**
 * Arterial spokes from the core out to the development edge.
 *
 * Spokes are spaced around the settlement but pulled toward the
 * directions regional roads arrive from, so the town's structure and
 * its external connections are the same structure.
 */
function buildSpokes(s, rng, arterials, exits) {
  const arrivals = arrivalAngles(s);
  const angles = [];

  // ---- An authored settlement continues its own streets ----
  //
  // Each exit is where one of the town's streets met the perimeter.  The
  // arterial carries on from there, in the direction that street was
  // already going, so from Eagle the road leaving town is visibly the
  // same road you were standing on inside it.
  if (exits && exits.length) {
    for (const e of exits) {
      const pts = [[e.x, e.z]];
      const step = 26;
      const r0 = Math.hypot(e.x - s.x, e.z - s.z);
      let x = e.x, z = e.z, a = e.dir;
      // The cap is a safety stop, not the reason the road ends.
      //
      // At edgeR * 1.02 an arterial ran out at 653 m while development
      // around it was still at 0.14 — above the arterial limit — so the
      // road simply stopped in the middle of a lived-in area with no
      // reason a player could see.  The development and landform tests
      // below are what should terminate a spoke; the cap only stops it
      // running forever.
      for (let r = r0; r <= s.edgeR * 1.45; r += step) {
        // Hold the street's direction.
        //
        // A 10% drift toward the radial made the nine arterials leaving
        // the perimeter converge and cross each other out in the fields,
        // which the intersection audit correctly read as eighteen
        // arterial-crosses-arterial junctions wanting roundabouts.  A
        // grid town's streets simply continue outward; the fanning has to
        // be gentle enough that two of them never meet.
        const radial = Math.atan2(z - s.z, x - s.x);
        a += normAngle(radial - a) * 0.015;
        x += Math.cos(a) * step;
        z += Math.sin(a) * step;
        const dev = developmentAt(x, z);
        if (dev.settlement !== s || dev.intensity < BAND.FRINGE.min) break;
        if (landformAt(x, z) > 3) break;
        pts.push([x, z]);
      }
      if (pts.length > 1) emitChain(pts, 'arterial', s.id, arterials);
      angles.push(e.dir);
    }
    return angles;
  }

  // ---- A generated settlement radiates from its centre ----
  const count = s.spokes;
  for (let i = 0; i < count; i++) {
    let a = s.grain + (i / count) * Math.PI * 2 + (rng.next() - 0.5) * 0.22;
    // Snap to the nearest arrival within 40 degrees.
    let bestD = 0.70, bestA = null;
    for (const ar of arrivals) {
      const d = Math.abs(normAngle(ar - a));
      if (d < bestD) { bestD = d; bestA = ar; }
    }
    if (bestA !== null) a = bestA;
    angles.push(a);
  }

  for (const a of angles) {
    const r0 = s.coreR * 0.20;
    const r1 = s.edgeR * 1.02;
    const pts = [];
    const step = 26;
    for (let r = r0; r <= r1; r += step) {
      const bow = Math.sin((r - r0) / Math.max(1, r1 - r0) * Math.PI) * s.coreR * 0.16
                * (hash2(Math.round(a * 100), Math.round(s.x)) - 0.5) * 2;
      const ax = a + bow / Math.max(30, r);
      const x = s.x + Math.cos(ax) * r;
      const z = s.z + Math.sin(ax) * r;
      const dev = developmentAt(x, z);
      if (dev.settlement !== s || dev.intensity < BAND.FRINGE.min) break;
      pts.push([x, z]);
    }
    emitChain(pts, 'arterial', s.id, arterials);
  }

  return angles;
}

/**
 * Orbital rings.  Only towns and larger have them; a village with a ring
 * road looks like a model, not a place.
 */
function buildRings(s, rng, arterials) {
  for (let k = 1; k <= s.rings; k++) {
    const rBase = s.coreR + (s.edgeR - s.coreR) * (k / (s.rings + 1)) * 1.05;
    const steps = Math.max(18, Math.round(rBase / 12));
    let run = [];
    for (let i = 0; i <= steps; i++) {
      const a = (i / steps) * Math.PI * 2 + s.grain;
      // Rings breathe with the settlement's own lobed outline rather
      // than being true circles.
      const wob = 1 + (noise2(Math.cos(a) * 2.7 + s.seed % 31, Math.sin(a) * 2.7) - 0.5) * 0.30;
      const r = rBase * wob;
      const x = s.x + Math.cos(a) * r;
      const z = s.z + Math.sin(a) * r;
      const dev = developmentAt(x, z);
      const ok = dev.settlement === s && dev.intensity >= BAND.EDGE.min && landformAt(x, z) < 3;
      if (ok) {
        run.push([x, z]);
      } else {
        // A ring that runs out of city becomes an open arc — which is
        // what a half-built bypass looks like, and is more believable
        // than a complete circle around a lopsided town.
        if (run.length > 2) emitChain(run, 'arterial', s.id, arterials);
        run = [];
      }
    }
    if (run.length > 2) emitChain(run, 'arterial', s.id, arterials);
  }
}

/**
 * Neighbourhood streets.
 *
 * The settlement is cut into districts — a sector between two spokes,
 * crossed with an annulus between two radii.  Each district gets its own
 * grid orientation and its own block size, derived from the band it
 * sits in.  Grid lines are marched across the district and kept only
 * where they are genuinely inside it and inside development, so streets
 * stop at the edge of the built-up area instead of running into fields.
 */
function buildDistricts(s, spokeAngles, rng, arterials) {
  buildStreetGrid(s, arterials);
}

/**
 * ONE street grid per settlement.
 *
 * Until Phase 8.5 each sector-and-annulus district laid its own grid at
 * its own hashed orientation.  Every district overlapped its neighbours,
 * and once the network was planarized those overlaps became real
 * junctions — turning the outskirts into a web of roads crossing at
 * every angle, enclosing triangular slivers rather than blocks.  The
 * audit was happy (it counted 1085 enclosed faces of about the right
 * average area) and the Eagle view was obviously wrong, because average
 * area says nothing about shape.
 *
 * A settlement extends ONE grain outward instead.  For Veridian Cap that
 * grain is the authored town's own, so the streets outside town continue
 * the streets inside it; blocks come out as rectangles because the lines
 * that bound them are parallel and perpendicular by construction.  The
 * grid coarsens with distance by dropping alternate lines, which is how
 * a real town thins toward its edge without changing its grain.
 */
function buildStreetGrid(s, arterials) {
  const theta = s.grain;
  const reach = s.edgeR * 1.05;
  const spacing = s.blockM;
  const lines = Math.ceil(reach / spacing);

  const STEP = 7;
  const MIN_RUN = 30;

  for (let axis = 0; axis < 2; axis++) {
    const ang = theta + (axis ? Math.PI / 2 : 0);
    const dx = Math.cos(ang), dz = Math.sin(ang);
    const nx = -dz, nz = dx;

    for (let li = -lines; li <= lines; li++) {
      // Coarsen outward: beyond the core every second line is dropped,
      // and beyond the inner band every fourth survives.
      const ringOut = Math.abs(li) * spacing;
      if (ringOut > s.coreR * 2.2 && (li % 2)) continue;
      if (ringOut > s.edgeR * 0.62 && (li % 4)) continue;

      const off = li * spacing;
      const ox = s.x + nx * off;
      const oz = s.z + nz * off;

      let run = null;
      const flush = () => {
        if (run && Math.hypot(run[2] - run[0], run[3] - run[1]) >= MIN_RUN) {
          addSegment(run[0], run[1], run[2], run[3], 'street', s.id);
        }
        run = null;
      };

      for (let t = -reach; t <= reach; t += STEP) {
        const x = ox + dx * t;
        const z = oz + dz * t;
        if (streetAllowed(s, x, z) && !nearArterial(x, z, arterials)) {
          if (!run) run = [x, z, x, z]; else { run[2] = x; run[3] = z; }
        } else flush();
      }
      flush();
    }
  }
}

/**
 * Clearance from the settlement's own arterials.  A street laid along a
 * spoke or a ring road is not a street, it is a second carriageway drawn
 * on top of the first.
 */
function nearArterial(x, z, arterials) {
  if (!arterials) return false;
  for (let i = 0; i < arterials.length; i++) {
    const a = arterials[i];
    const dx = a.x2 - a.x1, dz = a.z2 - a.z1;
    const l2 = dx * dx + dz * dz;
    let t = l2 ? ((x - a.x1) * dx + (z - a.z1) * dz) / l2 : 0;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    const px = x - (a.x1 + t * dx), pz = z - (a.z1 + t * dz);
    const reach = a.width / 2 + ROAD.street.width / 2 + 3.5;
    if (px * px + pz * pz < reach * reach) return true;
  }
  return false;
}



/** A street is allowed where its settlement's development still is. */
function streetAllowed(s, x, z) {
  const dev = developmentAt(x, z);
  if (dev.settlement !== s) return false;
  if (dev.intensity < BAND.EDGE.min) return false;
  if (landformAt(x, z) > 2.5) return false;
  // Local streets do not subdivide reserved land — that is what makes it
  // a reservation rather than a block awaiting houses.  The arterial that
  // serves it runs along its edge, so access is unaffected.
  if (reservationAt(x, z, 4)) return false;
  // Veridian Cap's authored core builds its own streets.
  if (s.authored && Math.hypot(x, z) < s.authoredR) return false;
  return true;
}

// ============================================================
// STITCH AND PRUNE
//
// The district grids produce runs of street, not a network: each run is
// marched across its district and ends where development or the sector
// boundary ends, which is almost never where another road is.  The audit
// counted 180 dead ends and found most of the settlement unreachable
// from its own gateway.
//
// Three passes fix that, in the order that matters:
//
//   SNAP    a run that stops just short of another road is extended to
//           meet it, because that is what it was trying to do
//   PRUNE   a run that still touches nothing is not a street, it is a
//           line on grass, and it is removed
//   THIN    a run lying alongside another within half a block is a
//           second carriageway doing the first one's job
// ============================================================

const SNAP_REACH = 26;      // how far a street will reach for a junction
const THIN_GAP = 30;        // parallel runs closer than this are redundant

/** Shortest distance from a point to a segment, and the closest point. */
function projectOn(seg, x, z) {
  const dx = seg.x2 - seg.x1, dz = seg.z2 - seg.z1;
  const l2 = dx * dx + dz * dz;
  let t = l2 ? ((x - seg.x1) * dx + (z - seg.z1) * dz) / l2 : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const px = seg.x1 + t * dx, pz = seg.z1 + t * dz;
  return { x: px, z: pz, d: Math.hypot(x - px, z - pz), t };
}

function stitchNetwork(s, firstStreet) {
  const streets = _segments.slice(firstStreet).filter(g => g.type === 'street');
  if (!streets.length) return;
  // Everything a street may legitimately join: the settlement's own
  // higher-order roads, and other streets.
  const spine = _segments.filter(g =>
    g.owner === s.id && (g.type === 'arterial' || g.type === 'collector'));

  const dead = new Set();

  // ---- OVERLAP ----
  //
  // Remove any street that lies ALONG another road rather than beside it.
  //
  // At (70, 140) the graph held a street from (42,140) to (77,140) and a
  // second 7 m street from (77,140) back to (70,140) — doubling back on
  // top of the first, its free end a dead end sitting in the middle of
  // another street.  Collinear overlaps like this produce terminals that
  // cannot be explained by anything in the world, because they are not
  // in the world: they are the same road counted twice.
  const covers = (o, x, z) => {
    const dx = o.x2 - o.x1, dz = o.z2 - o.z1;
    const l2 = dx * dx + dz * dz;
    if (!l2) return false;
    let u = ((x - o.x1) * dx + (z - o.z1) * dz) / l2;
    if (u < -0.02 || u > 1.02) return false;
    u = u < 0 ? 0 : u > 1 ? 1 : u;
    const px = x - (o.x1 + u * dx), pz = z - (o.z1 + u * dz);
    return px * px + pz * pz < (o.width / 2 + 1.0) ** 2;
  };
  for (const g of streets) {
    if (dead.has(g.id)) continue;
    for (const o of _segments) {
      if (o === g || dead.has(o.id)) continue;
      if (o.len < g.len - 0.01) continue;                 // keep the longer road
      if (Math.abs(Math.sin(g.angle - o.angle)) > 0.15) continue;
      if (covers(o, g.x1, g.z1) && covers(o, g.x2, g.z2)) { dead.add(g.id); break; }
    }
  }

  // ---- SNAP ----
  //
  // Only GENUINE dead ends are snapped.  The previous test bailed out
  // whenever any road came within a metre of the endpoint — and a chain's
  // own neighbouring fragment always does — so a street that stopped
  // eighteen metres short of an arterial was read as "already meets
  // something" and left hanging.  Counting how many segments actually
  // share the endpoint is the question that was meant to be asked.
  const endDegree = (x, z) => {
    let n = 0;
    for (const o of _segments) {
      // Segments already condemned by the overlap pass do not count:
      // an endpoint shared only with a duplicate that is about to be
      // deleted is a dead end, not a junction, and treating it as one is
      // what left five live streets hanging short of their arterial.
      if (dead.has(o.id)) continue;
      if (Math.hypot(o.x1 - x, o.z1 - z) < 1.5) n++;
      if (Math.hypot(o.x2 - x, o.z2 - z) < 1.5) n++;
    }
    return n;
  };

  const links = [];
  for (const g of streets) {
    for (const end of [[g.x1, g.z1], [g.x2, g.z2]]) {
      const [ex, ez] = end;
      if (endDegree(ex, ez) > 1) continue;             // already a junction
      let best = null;
      for (const o of spine.concat(streets)) {
        if (o === g) continue;
        // Never splice a local street onto a trunk road: a house does not
        // take its access off a regional carriageway.
        if (o.type === 'regional') continue;
        const pr = projectOn(o, ex, ez);
        if (pr.d < 1.0) continue;
        if (pr.d <= SNAP_REACH && (!best || pr.d < best.d)) best = pr;
      }
      if (best) links.push([ex, ez, best.x, best.z]);
    }
  }
  for (const [x1, z1, x2, z2] of links) addSegment(x1, z1, x2, z2, 'street', s.id);

  // ---- PRUNE ----
  const all = _segments.filter(g => g.owner === s.id);
  for (const g of streets) {
    let joined = 0;
    for (const end of [[g.x1, g.z1], [g.x2, g.z2]]) {
      for (const o of all) {
        if (o === g) continue;
        if (projectOn(o, end[0], end[1]).d < 2.0) { joined++; break; }
      }
    }
    if (joined === 0) dead.add(g.id);
  }

  // ---- THIN ----
  for (let i = 0; i < streets.length; i++) {
    const a = streets[i];
    if (dead.has(a.id)) continue;
    for (let j = i + 1; j < streets.length; j++) {
      const b = streets[j];
      if (dead.has(b.id)) continue;
      if (Math.abs(Math.sin(a.angle - b.angle)) > 0.20) continue;
      const am = { x: (a.x1 + a.x2) / 2, z: (a.z1 + a.z2) / 2 };
      const pr = projectOn(b, am.x, am.z);
      if (pr.d > 0.5 && pr.d < THIN_GAP) { dead.add(b.len <= a.len ? b.id : a.id); }
    }
  }

  if (dead.size) removeSegments(dead);
}

// A dead-end trim was tried here and removed: deleting short street
// fragments whose end met nothing ate backwards along whole streets —
// remove the tail, the next segment becomes a tail — and broke the
// settlement into twelve components with more dead ends than it started
// with (42 -> 79).  Trimming tails needs to work on whole street CHAINS,
// not on planarized fragments, and that is a larger job than it looks.

/**
 * Access to reserved land.
 *
 * A reservation with no road to it is not a site, it is a field.  This
 * lays the approach that completes the chain:
 *
 *   regional -> gateway roundabout -> arterial -> collector
 *   -> stadium approach -> (future) plaza -> (future) stadium
 *
 * It builds the road and stops there.  What has to exist now is the
 * route, so that when the stadium arrives it arrives somewhere connected.
 */
function buildReservationAccess(s, collect) {
  const list = PROC.reservations || [];
  for (const res of list) {
    const cx = (res.minX + res.maxX) / 2;
    const cz = (res.minZ + res.maxZ) / 2;

    // The approach should arrive at the site's near edge, not its middle.
    const toTown = Math.atan2(s.z - cz, s.x - cx);
    const ex = Math.max(res.minX, Math.min(res.maxX, cx + Math.cos(toTown) * (res.maxX - res.minX) / 2));
    const ez = Math.max(res.minZ, Math.min(res.maxZ, cz + Math.sin(toTown) * (res.maxZ - res.minZ) / 2));

    let best = null, bd = 400;
    for (const g of _segments) {
      if (g.type === 'street' || g.type === 'lane') continue;
      const dx = g.x2 - g.x1, dz = g.z2 - g.z1;
      const l2 = dx * dx + dz * dz;
      let t = l2 ? ((ex - g.x1) * dx + (ez - g.z1) * dz) / l2 : 0;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      const px = g.x1 + t * dx, pz = g.z1 + t * dz;
      const d = Math.hypot(ex - px, ez - pz);
      if (d < bd) { bd = d; best = { x: px, z: pz }; }
    }
    if (!best || bd < 8) continue;

    const steps = Math.max(2, Math.ceil(bd / 40));
    const pts = [];
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      pts.push([best.x + (ex - best.x) * t, best.z + (ez - best.z) * t]);
    }
    emitChain(pts, 'collector', s.id, collect);
    res._access = { from: best, to: { x: ex, z: ez }, length: Math.round(bd) };
  }
}

// ============================================================
// PLANARIZATION
//
// Split every segment at every point where another crosses or touches
// it, so crossing roads share a node.  This is what turns a bundle of
// overlapping lines into a network with junctions — and what makes the
// faces between them into blocks.  Without it the settlement is dozens
// of disconnected pieces.
// ============================================================

const CROSS_EPS = 0.6;

/** Parametric intersection of two segments, or null. */
function crossAt(a, b) {
  const r1x = a.x2 - a.x1, r1z = a.z2 - a.z1;
  const r2x = b.x2 - b.x1, r2z = b.z2 - b.z1;
  const den = r1x * r2z - r1z * r2x;
  if (Math.abs(den) < 1e-9) return null;               // parallel
  const dx = b.x1 - a.x1, dz = b.z1 - a.z1;
  const t = (dx * r2z - dz * r2x) / den;
  const u = (dx * r1z - dz * r1x) / den;
  if (t < -1e-6 || t > 1 + 1e-6 || u < -1e-6 || u > 1 + 1e-6) return null;
  return { t, u, x: a.x1 + r1x * t, z: a.z1 + r1z * t };
}

function planarizeNear(cx, cz, r) {
  const near = _segments.filter(g =>
    Math.hypot((g.x1 + g.x2) / 2 - cx, (g.z1 + g.z2) / 2 - cz) <= r);
  if (near.length < 2) return;

  const cuts = new Map();                              // segment -> [t, ...]
  const put = (g, t) => {
    if (t <= CROSS_EPS / g.len || t >= 1 - CROSS_EPS / g.len) return;   // already an end
    let arr = cuts.get(g);
    if (!arr) { arr = []; cuts.set(g, arr); }
    if (!arr.some(v => Math.abs(v - t) * g.len < CROSS_EPS)) arr.push(t);
  };

  for (let i = 0; i < near.length; i++) {
    for (let j = i + 1; j < near.length; j++) {
      const a = near[i], b = near[j];
      if (Math.min(a.x1, a.x2) > Math.max(b.x1, b.x2) + 1) continue;
      if (Math.max(a.x1, a.x2) < Math.min(b.x1, b.x2) - 1) continue;
      if (Math.min(a.z1, a.z2) > Math.max(b.z1, b.z2) + 1) continue;
      if (Math.max(a.z1, a.z2) < Math.min(b.z1, b.z2) - 1) continue;
      const c = crossAt(a, b);
      if (!c) continue;
      put(a, c.t); put(b, c.u);
    }
  }
  if (!cuts.size) return;

  const dead = new Set();
  const born = [];
  for (const [g, ts] of cuts) {
    ts.sort((p, q) => p - q);
    const stops = [0, ...ts, 1];
    for (let k = 0; k < stops.length - 1; k++) {
      const t0 = stops[k], t1 = stops[k + 1];
      if ((t1 - t0) * g.len < CROSS_EPS) continue;
      born.push({
        x1: g.x1 + (g.x2 - g.x1) * t0, z1: g.z1 + (g.z2 - g.z1) * t0,
        x2: g.x1 + (g.x2 - g.x1) * t1, z2: g.z1 + (g.z2 - g.z1) * t1,
        type: g.type, owner: g.owner, noDraw: g.noDraw,
      });
    }
    dead.add(g.id);
  }
  removeSegments(dead);
  // Re-emit forced: these are existing roads being split, not new ones.
  for (const b of born) {
    const seg = addSegment(b.x1, b.z1, b.x2, b.z2, b.type, b.owner, true);
    if (seg && b.noDraw) seg.noDraw = true;
  }
}

/**
 * Pull every road back to the edge of a roundabout.
 *
 * A segment wholly inside the circle is removed; one that crosses the
 * edge is shortened to stop on it.  The approaches then arrive AT the
 * ring instead of running through it — which is the difference between a
 * roundabout and a ring painted over a crossroads.
 */
function trimForRoundabout(cx, cz, r) {
  // The ring nodes.  Approaches are trimmed to END ON one of these, and
  // the ring itself is emitted as road, so traffic can actually pass from
  // one approach to another.
  //
  // Trimming alone was not enough and made things worse: the approaches
  // stopped short of each other with NOTHING joining them, because the
  // circulating carriageway existed only as drawn geometry in
  // junctions.js and never as a road in the graph.  A roundabout is a
  // small one-way loop of street; if it is not in the graph it is a
  // picture of a roundabout.
  const N = 12;
  const ring = [];
  for (let i = 0; i < N; i++) {
    const a2 = (i / N) * Math.PI * 2;
    ring.push({ x: cx + Math.cos(a2) * r, z: cz + Math.sin(a2) * r });
  }
  const nearestRingNode = (x, z) => {
    let bd = Infinity, best = ring[0];
    for (const p of ring) {
      const d = Math.hypot(p.x - x, p.z - z);
      if (d < bd) { bd = d; best = p; }
    }
    return best;
  };

  const dead = new Set();
  const born = [];
  for (const g of _segments) {
    const d1 = Math.hypot(g.x1 - cx, g.z1 - cz);
    const d2 = Math.hypot(g.x2 - cx, g.z2 - cz);
    if (d1 >= r && d2 >= r) continue;                 // clear of the circle
    dead.add(g.id);
    if (d1 < r && d2 < r) continue;                   // wholly inside: gone

    const [ox, oz, ix, iz] = d1 >= r
      ? [g.x1, g.z1, g.x2, g.z2]
      : [g.x2, g.z2, g.x1, g.z1];
    const dx = ix - ox, dz = iz - oz;
    const len = Math.hypot(dx, dz);
    if (len < 0.1) continue;
    let keep = len;
    for (let t = 0; t <= len; t += 0.5) {
      if (Math.hypot(ox + (dx / len) * t - cx, oz + (dz / len) * t - cz) <= r) { keep = t; break; }
    }
    if (keep < 1.5) continue;
    // End exactly on a ring node, so the approach and the ring share one.
    const hit = nearestRingNode(ox + (dx / len) * keep, oz + (dz / len) * keep);
    born.push({ x1: ox, z1: oz, x2: hit.x, z2: hit.z,
                type: g.type, owner: g.owner, noDraw: g.noDraw });
  }
  if (!dead.size) return;
  removeSegments(dead);
  for (const b of born) {
    const seg = addSegment(b.x1, b.z1, b.x2, b.z2, b.type, b.owner, true);
    if (seg && b.noDraw) seg.noDraw = true;
  }
  // The circulating carriageway.  Marked noDraw because junctions.js
  // already draws the ring; what this adds is the graph.
  for (let i = 0; i < N; i++) {
    const p = ring[i], q = ring[(i + 1) % N];
    const seg = addSegment(p.x, p.z, q.x, q.z, 'collector', null, true);
    if (seg) { seg.noDraw = true; seg.roundabout = true; }
  }
}

/** Drop segments by id, from the master list and from the spatial index. */
function removeSegments(ids) {
  _segments = _segments.filter(g => !ids.has(g.id));
  for (const [k, arr] of _index) {
    const kept = arr.filter(g => !ids.has(g.id));
    if (kept.length) _index.set(k, kept); else _index.delete(k);
  }
}

/** Emit a polyline as a chain of segments, optionally collecting them. */
function emitChain(pts, type, owner, collect) {
  for (let i = 0; i < pts.length - 1; i++) {
    const seg = addSegment(pts[i][0], pts[i][1], pts[i + 1][0], pts[i + 1][1], type, owner);
    if (seg && collect) collect.push(seg);
  }
}

function normAngle(a) {
  while (a > Math.PI) a -= Math.PI * 2;
  while (a < -Math.PI) a += Math.PI * 2;
  return a;
}

// ============================================================
// QUERIES
// ============================================================

/**
 * Every segment relevant to a chunk.  A pure index lookup now — no
 * generation happens here, which is what makes roads continuous across
 * chunk boundaries.
 *
 * @param {number} margin  extra metres around the chunk, so buildings on
 *   a frontage just outside the chunk still know about their road
 */
export function segmentsForChunk(cx, cz, chunkSize, margin = 0) {
  const minX = cx * chunkSize - margin;
  const maxX = (cx + 1) * chunkSize + margin;
  const minZ = cz * chunkSize - margin;
  const maxZ = (cz + 1) * chunkSize + margin;

  const i0 = Math.floor(minX / INDEX_CELL), i1 = Math.floor(maxX / INDEX_CELL);
  const j0 = Math.floor(minZ / INDEX_CELL), j1 = Math.floor(maxZ / INDEX_CELL);

  const seen = new Set();
  const out = [];
  for (let j = j0; j <= j1; j++) {
    for (let i = i0; i <= i1; i++) {
      const arr = _index.get(i + ',' + j);
      if (!arr) continue;
      for (const s of arr) {
        if (seen.has(s.id)) continue;
        seen.add(s.id);
        if (Math.min(s.x1, s.x2) > maxX || Math.max(s.x1, s.x2) < minX) continue;
        if (Math.min(s.z1, s.z2) > maxZ || Math.max(s.z1, s.z2) < minZ) continue;
        out.push(s);
      }
    }
  }
  return out;
}

/** Segments whose midpoint falls inside the chunk — the chunk owns these. */
export function ownedSegments(cx, cz, chunkSize) {
  const minX = cx * chunkSize, maxX = minX + chunkSize;
  const minZ = cz * chunkSize, maxZ = minZ + chunkSize;
  return segmentsForChunk(cx, cz, chunkSize, 0).filter(s => {
    const mx = (s.x1 + s.x2) / 2, mz = (s.z1 + s.z2) / 2;
    return mx >= minX && mx < maxX && mz >= minZ && mz < maxZ;
  });
}

/** Distance from a point to the nearest segment in a list, with the segment. */
export function nearestSegment(x, z, segs) {
  let bd = Infinity, best = null, bt = 0;
  for (const s of segs) {
    const dx = s.x2 - s.x1, dz = s.z2 - s.z1;
    const l2 = dx * dx + dz * dz;
    let t = l2 ? ((x - s.x1) * dx + (z - s.z1) * dz) / l2 : 0;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    const px = x - (s.x1 + t * dx), pz = z - (s.z1 + t * dz);
    const d = px * px + pz * pz;
    if (d < bd) { bd = d; best = s; bt = t; }
  }
  return { seg: best, dist: Math.sqrt(bd), t: bt };
}

/** True if the point is inside any segment's carriageway plus clearance. */
export function onRoad(x, z, segs, clearance = 0) {
  for (const s of segs) {
    const reach = s.width / 2 + clearance;
    const dx = s.x2 - s.x1, dz = s.z2 - s.z1;
    const l2 = dx * dx + dz * dz;
    let t = l2 ? ((x - s.x1) * dx + (z - s.z1) * dz) / l2 : 0;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    const px = x - (s.x1 + t * dx), pz = z - (s.z1 + t * dz);
    if (px * px + pz * pz < reach * reach) return true;
  }
  return false;
}

export function allRegional() { return _regional; }
export function segmentCount() { return _segments.length; }

/** Every generated segment whose midpoint lies within `r` of (x, z). */
export function segmentsNear(x, z, r) {
  return _segments.filter(s =>
    Math.hypot((s.x1 + s.x2) / 2 - x, (s.z1 + s.z2) / 2 - z) <= r);
}

// ============================================================
// GEOMETRY
// ============================================================

/**
 * Build road surfaces for a list of segments.
 *
 * Carriageway, a junction patch at each end (which is what hides the
 * mitre gaps where segments of a polyline meet at an angle), and class-
 * appropriate markings.  Streets and lanes carry a kerb strip instead of
 * paint — at the scale they are seen, a lighter edge reads as a footway
 * and paint reads as noise.
 */
export function buildRoadGeometry(segments, chunkKey, accPartRef, accSlabRef) {
  for (const seg of segments) {
    if (seg.noDraw) continue;              // the city modules draw these
    // Road surfaces sit clear of the land cover beneath them.  At the
    // authored town's Y_ROAD of 0.012 they were within a hair of the
    // field polygons at 0.0025 and the two fought wherever a road
    // crossed open country, which showed from Eagle as hatching along
    // the trunk roads.  Four centimetres is invisible on the ground and
    // decisive in the depth buffer.

    const { len, angle, width, type } = seg;
    if (len < 0.5) continue;
    const midX = (seg.x1 + seg.x2) / 2;
    const midZ = (seg.z1 + seg.z2) / 2;
    const spec = ROAD[type];

    const road = new THREE.PlaneGeometry(len, width);
    road.rotateX(-Math.PI / 2);
    road.rotateY(-angle);
    road.translate(midX, Y_ROAD, midZ);
    accPartRef(chunkKey, road, 'opaque', spec.color, { jitter: 0.012 });

    // ---- Terminal treatment (see markTerminals) ----
    //
    // Drawn geometry only.  Nothing here enters the graph, carries
    // collision or moves a road: a terminal that the audit already
    // explains is simply given the ending that explanation implies.
    for (const end of ['A', 'B']) {
      const kind = seg['term' + end];
      if (!kind) continue;
      const tx = end === 'A' ? seg.x1 : seg.x2;
      const tz = end === 'A' ? seg.z1 : seg.z2;
      // Outward along the road, away from the rest of the network.
      const ox = end === 'A' ? (seg.x1 - seg.x2) / len : (seg.x2 - seg.x1) / len;
      const oz = end === 'A' ? (seg.z1 - seg.z2) / len : (seg.z2 - seg.z1) / len;

      if (kind === 'head') {
        // A turning circle, sized so a vehicle can actually come about:
        // the head sits just inside the terminal so its far edge lands
        // on the point the carriageway already reaches.
        const R = Math.max(width * 1.55, 7.5);
        const hx = tx + ox * (R - width / 2), hz = tz + oz * (R - width / 2);

        // The kerb runs round the head but stops either side of the
        // street coming in — a full annulus would lay two metres of
        // footway straight across the carriageway you arrive on.
        // RingGeometry's theta is measured in XY; after rotateX(-90)
        // a world bearing (ox, oz) sits at theta = -atan2(oz, ox).
        const gap = Math.asin(Math.min(0.95, (width / 2 + 1.2) / R));
        const thIn = -Math.atan2(oz, ox) + Math.PI;
        const ring = new THREE.RingGeometry(R, R + 2.2, 26, 1,
                                            thIn + gap, Math.PI * 2 - gap * 2);
        ring.rotateX(-Math.PI / 2);
        ring.translate(hx, Y_FOOT, hz);
        accPartRef(chunkKey, ring, 'opaque', 0xbdb7a6, { jitter: 0.02 });

        const pad = new THREE.CircleGeometry(R, 22);
        pad.rotateX(-Math.PI / 2);
        pad.translate(hx, Y_ROAD + 0.002, hz);
        accPartRef(chunkKey, pad, 'opaque', spec.color, { jitter: 0.012 });
      } else {
        // The surfacing gives out.  Carriageway narrows to a cart track
        // over ten metres and the track runs on a little into the field,
        // so the road ends the way a road ends when the town stops
        // paying for it.
        const L1 = 10, L2 = 9;
        const w0 = width / 2, w1 = 1.5, w2 = 1.15;
        const px = -oz, pz = ox;
        const mk = (ax, az, aw, bx, bz, bw, y, colour) => {
          const g = new THREE.BufferGeometry();
          g.setAttribute('position', new THREE.Float32BufferAttribute([
            ax + px * aw, y, az + pz * aw,   ax - px * aw, y, az - pz * aw,
            bx - px * bw, y, bz - pz * bw,   bx + px * bw, y, bz + pz * bw,
          ], 3));
          // Wound so the face points at +Y.  In the XZ plane a positive
          // signed area is CLOCKWISE seen from above, so the obvious
          // order culls the whole taper and the road just ends square
          // again — with the audit still reporting the taper as drawn.
          g.setIndex([0, 2, 1, 0, 3, 2]);
          g.computeVertexNormals();
          accPartRef(chunkKey, g, 'opaque', colour, { jitter: 0.015 });
        };
        const m1x = tx + ox * L1, m1z = tz + oz * L1;
        mk(tx, tz, w0, m1x, m1z, w1, Y_ROAD + 0.002, spec.color);
        mk(m1x, m1z, w1, m1x + ox * L2, m1z + oz * L2, w2,
           Y_ROAD + 0.003, 0x9c8f76);
      }
    }

    // Junction discs close the gap at every polyline joint and read as
    // the corner radius at every intersection.
    for (const [jx, jz] of [[seg.x1, seg.z1], [seg.x2, seg.z2]]) {
      const disc = new THREE.CircleGeometry(width / 2, 8);
      disc.rotateX(-Math.PI / 2);
      disc.translate(jx, Y_ROAD - 0.001, jz);
      accPartRef(chunkKey, disc, 'opaque', spec.color, { jitter: 0.012 });
    }

    if (spec.marks === 'dashed' || spec.marks === 'edge') {
      const edgeOff = width / 2 - 0.45;
      for (const s of [-1, 1]) {
        const edge = new THREE.PlaneGeometry(len, 0.16);
        edge.rotateX(-Math.PI / 2);
        edge.rotateY(-angle);
        edge.translate(midX + s * edgeOff * Math.sin(angle), Y_MARK,
                       midZ - s * edgeOff * Math.cos(angle));
        accPartRef(chunkKey, edge, 'opaque', 0xbfb9a6, { jitter: 0.005 });
      }
    }

    if (spec.marks === 'dashed') {
      const step = 8;
      const n = Math.floor(len / step);
      const start = -n * step / 2;
      for (let i = 0; i < n; i++) {
        const o = start + i * step + step / 2;
        const dash = new THREE.PlaneGeometry(3.0, 0.16);
        dash.rotateX(-Math.PI / 2);
        dash.rotateY(-angle);
        dash.translate(midX + o * Math.cos(angle), Y_MARK, midZ + o * Math.sin(angle));
        accPartRef(chunkKey, dash, 'opaque', 0xbfb9a6);
      }
    }

    // Arterials and collectors carry frontage, so they carry pedestrians.
    //
    // Only streets and lanes were built with a footway, so the moment you
    // walked out of the authored town along an arterial the pavement
    // simply stopped and you were on grass between the carriageway and
    // somebody's front wall.  A major road with buildings addressing it
    // and nowhere to walk is the plainest pedestrian defect there is.
    if (spec.marks === 'edge') {
      const off = width / 2 + 1.35;
      const KERB_H = 0.16;
      const sx = Math.sin(angle), cs = Math.cos(angle);
      for (const s of [-1, 1]) {
        const fw = new THREE.PlaneGeometry(len, 2.6);
        fw.rotateX(-Math.PI / 2);
        fw.rotateY(-angle);
        fw.translate(midX + s * off * sx, Y_FOOT + KERB_H, midZ - s * off * cs);
        accPartRef(chunkKey, fw, 'opaque', 0xbdb7a6, { jitter: 0.02 });

        const kOff = width / 2 + 0.06;
        const face = new THREE.BoxGeometry(len, KERB_H, 0.16);
        face.rotateY(-angle);
        face.translate(midX + s * kOff * sx, Y_FOOT + KERB_H / 2, midZ - s * kOff * cs);
        accPartRef(chunkKey, face, 'opaque', 0xa8a294, { jitter: 0.02 });

        const top = new THREE.BoxGeometry(len, 0.04, 0.09);
        top.rotateY(-angle);
        top.translate(midX + s * (kOff + 0.04) * sx, Y_FOOT + KERB_H + 0.02,
                      midZ - s * (kOff + 0.04) * cs);
        accPartRef(chunkKey, top, 'opaque', 0xd2ccbc);
      }
    }

    if (spec.marks === 'none') {
      // Footway and kerb.
      //
      // The strips alone were flat decals at carriageway level: from the
      // footway a procedural street had no edge, while every authored
      // street in Veridian Cap has a 0.35 m kerb with a lit top chamfer.
      // That difference is most of why the town felt built and the roads
      // out of it felt drawn.  The kerb is a real height change, so the
      // two now read as the same kind of street.
      const off = width / 2 + 0.95;
      const KERB_H = 0.16;
      for (const s of [-1, 1]) {
        const sx = Math.sin(angle), cz = Math.cos(angle);
        const fw = new THREE.PlaneGeometry(len, 1.9);
        fw.rotateX(-Math.PI / 2);
        fw.rotateY(-angle);
        fw.translate(midX + s * off * sx, Y_FOOT + KERB_H, midZ - s * off * cz);
        accPartRef(chunkKey, fw, 'opaque', 0xbdb7a6, { jitter: 0.02 });

        // Kerb face, and a paler top edge to catch the sun.
        const kOff = width / 2 + 0.06;
        const face = new THREE.BoxGeometry(len, KERB_H, 0.16);
        face.rotateY(-angle);
        face.translate(midX + s * kOff * sx, Y_FOOT + KERB_H / 2, midZ - s * kOff * cz);
        accPartRef(chunkKey, face, 'opaque', 0xa8a294, { jitter: 0.02 });

        const top = new THREE.BoxGeometry(len, 0.04, 0.09);
        top.rotateY(-angle);
        top.translate(midX + s * (kOff + 0.04) * sx, Y_FOOT + KERB_H + 0.02,
                      midZ - s * (kOff + 0.04) * cz);
        accPartRef(chunkKey, top, 'opaque', 0xd2ccbc);
      }
    }
  }
  return segments;
}
