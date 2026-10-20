// ============================================================
// RURAL INFRASTRUCTURE — Phase 9C
//
// The countryside already had fields, hedgerows, woods and farms.  What
// it did not have was any sign that anybody reaches them.
//
// An audit of the land within 1600 m found three farmsteads standing
// 19 to 93 m off a regional road with NOTHING between the road and the
// yard, and not one track leaving a road into a field.  The land was
// drawn as farmland and used by nobody — which is the agricultural
// equivalent of the Phase 8.6.1 defect where streets had kerbs, footways
// and turning heads but no buildings.
//
// This module adds the connections, not decoration:
//
//   farm track   road -> farmyard, and yard -> the fields it works
//   drainage     shallow ditches that follow the land, at field edges
//   buffer       planting between an industrial edge and what adjoins it
//
// Three rules hold throughout:
//
//   1. NOTHING here joins the public road graph.  Tracks are drawn
//      geometry with no segment, no node, no junction.  Phase 8.5/8.6
//      cannot see them and must not.
//   2. Nothing here registers collision.  These are surfaces and low
//      features; landscape.js has never registered collision either, and
//      a ditch you cannot walk over would be worse than no ditch.
//   3. Everything is a pure function of position and the shared lattice,
//      so two runs agree and a chunk rebuilt at a different LOD
//      describes the same ground.
// ============================================================

import * as THREE from 'three';
import { hash2, fbm2 } from './seed.js';
import { landformAt } from './terrain.js';
import { developmentAt, BAND, reservationAt, insideAuthoredTown } from './settlement.js';
import { zoneAt, ZONE } from './zones.js';
import { onRoad, segmentsNear } from './roads.js';
import { farmsteadSites } from './parcels.js';
import { allSettlements } from './settlement.js';

// Heights. The track sits just above the land cover (0.0025) and just
// below the road surface (0.050), because where a track meets a road the
// road is the thing that was built last.
const Y_TRACK = 0.030;
const Y_DITCH = 0.020;

const TRACK = 0xa89b7c;        // dry, pale, unsurfaced
const TRACK_EDGE = 0x8d9a6a;   // the grass that grows up its sides
const DITCH = 0x6e7d55;

/**
 * One unsurfaced way, drawn as a narrow strip with grass edges.
 *
 * Deliberately not the road builder: a farm track has no kerb, no
 * markings, no footway and no junction geometry, and the whole point is
 * that it reads as a lesser thing than the road it leaves.
 */
function track(key, ax, az, bx, bz, accPart, width = 3.1) {
  const len = Math.hypot(bx - ax, bz - az);
  if (len < 4) return 0;
  const ang = Math.atan2(bz - az, bx - ax);
  const mx = (ax + bx) / 2, mz = (az + bz) / 2;

  const g = new THREE.PlaneGeometry(len, width);
  g.rotateX(-Math.PI / 2);
  g.rotateY(-ang);
  g.translate(mx, Y_TRACK, mz);
  accPart(key, g, 'opaque', TRACK, { jitter: 0.05 });

  // Grass either side, so the track reads as worn rather than laid.
  for (const s of [-1, 1]) {
    const e = new THREE.PlaneGeometry(len, 1.15);
    e.rotateX(-Math.PI / 2);
    e.rotateY(-ang);
    e.translate(mx + s * Math.sin(ang) * (width / 2 + 0.55),
                Y_TRACK - 0.004,
                mz - s * Math.cos(ang) * (width / 2 + 0.55));
    accPart(key, e, 'foliage', TRACK_EDGE, { jitter: 0.07 });
  }
  return len;
}

/**
 * Farm access for one chunk.
 *
 * For every farmstead whose yard falls in this chunk: a track from the
 * point on its access road nearest the yard, up to the yard, and then
 * one or two short spurs on into the fields it works.
 *
 * Field spurs are rationed on purpose.  A track to every field would be
 * the agricultural version of prop spam and would read as a grid; a farm
 * reaching two or three of its fields reads as a farm.
 */
export function buildFarmAccess(key, bounds, segs, accPart) {
  // ONE chunk owns each farm: the one its yard stands in.
  //
  // The first version enumerated sites with a 170 m margin so a track
  // could be drawn from either side of a chunk edge.  That was wrong
  // twice over.  Each neighbouring chunk picks the access road from its
  // OWN segment list, so the same farm was given tracks running to
  // different roads — a starburst of four or five ways out of one yard.
  // And a farm owned by a chunk at LOD 2, which builds no buildings at
  // all, still had its tracks drawn by a detailed neighbour: a farm
  // track arriving at open grass.
  //
  // Letting the owning chunk draw the whole track, even where it runs
  // past the chunk edge, keeps the track and the buildings in one place
  // and at one LOD.  Geometry crossing the boundary is merged into the
  // owning chunk's mesh and unloads with it.
  const ctx = bounds;

  // Neighbouring steadings, for avoidance only — not drawn by this chunk.
  // Two farms can share a stretch of road: one farm's nearest point on
  // the lane sat beside its neighbour's yard, and the track laid from
  // there ran straight through the neighbour's farmhouse.  A walk capture
  // found it by standing inside the wall.
  const wide = {
    minX: bounds.minX - 320, maxX: bounds.maxX + 320,
    minZ: bounds.minZ - 320, maxZ: bounds.maxZ + 320,
  };
  const neighbours = farmsteadSites(wide, segs);
  const YARD_R = 27;          // covers farmhouse, barn and shed about a yard

  /** Does this line pass through somebody else's steading? */
  const blocked = (ax, az, bx, bz, self) => {
    for (const n of neighbours) {
      if (n === self || (n.i === self.i && n.j === self.j)) continue;
      const vx = bx - ax, vz = bz - az;
      const l2 = vx * vx + vz * vz;
      let t = l2 ? ((n.x - ax) * vx + (n.z - az) * vz) / l2 : 0;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      if (Math.hypot(n.x - (ax + t * vx), n.z - (az + t * vz)) < YARD_R) return true;
    }
    return false;
  };

  let tracks = 0, metres = 0, spurs = 0, refused = 0;
  for (const site of farmsteadSites(ctx, segs)) {
    if (!site.accessAt) continue;

    // Road -> yard.  The track stops at the yard edge rather than in the
    // middle of it, so it arrives at the steading instead of through it.
    //
    // Where the straight line would cross a neighbour's yard, the gate is
    // moved ALONG the lane until the run is clear — which is what a farm
    // does: the entrance is wherever it can actually be.
    const ang = site.access.angle;
    const rx = Math.cos(ang), rz = Math.sin(ang);
    let gx = site.accessAt[0], gz = site.accessAt[1], clear = false;
    for (const shift of [0, 34, -34, 68, -68, 102, -102]) {
      const tx = site.accessAt[0] + rx * shift, tz = site.accessAt[1] + rz * shift;
      if (!blocked(tx, tz, site.x, site.z, site)) { gx = tx; gz = tz; clear = true; break; }
    }
    if (!clear) { refused++; continue; }   // no honest way in: draw nothing

    const dx = site.x - gx, dz = site.z - gz;
    const d = Math.hypot(dx, dz) || 1;
    const ux = dx / d, uz = dz / d;
    // Leave the carriageway edge, not the centreline.
    const start = (site.access.width / 2) + 1.0;
    const stop = Math.max(start + 4, d - 9);
    if (stop > start) {
      metres += track(key, gx + ux * start, gz + uz * start,
                      gx + ux * stop, gz + uz * stop, accPart);
      tracks++;
    }

    // Yard -> fields.  One spur always, a second on a coin the lattice
    // already decided, thrown out across the yard's far side.
    const nSpur = hash2(site.i * 61 + 7, site.j * 29 + 3) < 0.45 ? 2 : 1;
    for (let k = 0; k < nSpur; k++) {
      const a = site.rot + Math.PI + (k ? 1.05 : -0.55) +
                (hash2(site.i * 13 + k, site.j * 17 + k) - 0.5) * 0.5;
      const L = 40 + hash2(site.j * 7 + k, site.i * 11 + k) * 55;
      const ex = site.x + Math.cos(a) * L, ez = site.z + Math.sin(a) * L;
      // A spur must stay in workable open country.
      if (reservationAt(ex, ez, 6) || insideAuthoredTown(ex, ez, 4)) continue;
      if (landformAt(ex, ez) > 6) continue;
      const zEnd = zoneAt(ex, ez);
      if (zEnd !== ZONE.AGRICULTURAL && zEnd !== ZONE.RURAL_SETTLED) continue;
      // ...and must not run along a public road.
      if (onRoad(ex, ez, segs, 6)) continue;
      const sx = site.x + Math.cos(a) * 12, sz = site.z + Math.sin(a) * 12;
      if (blocked(sx, sz, ex, ez, site)) continue;
      metres += track(key, sx, sz, ex, ez, accPart, 2.5);
      spurs++;
    }
  }
  return { tracks, spurs, refused, metres: Math.round(metres) };
}

/**
 * Drainage.
 *
 * Follows the land rather than the map: a ditch is cut where the ground
 * is genuinely low relative to its surroundings AND the land is farmed,
 * which is the only place a farmer would bother. Sampling the landform
 * field on both sides of a candidate line is what keeps these out of the
 * hilltops, where a ditch would read as a scar.
 */
export function buildDrainage(key, bounds, segs, accPart) {
  const STEP = 46;
  const i0 = Math.ceil(bounds.minX / STEP), i1 = Math.floor(bounds.maxX / STEP);
  const j0 = Math.ceil(bounds.minZ / STEP), j1 = Math.floor(bounds.maxZ / STEP);
  let cut = 0;

  for (let j = j0; j <= j1; j++) {
    for (let i = i0; i <= i1; i++) {
      const x = i * STEP + (hash2(i * 5 + 1, j * 9 + 2) - 0.5) * STEP * 0.6;
      const z = j * STEP + (hash2(j * 3 + 4, i * 7 + 6) - 0.5) * STEP * 0.6;

      if (zoneAt(x, z) !== ZONE.AGRICULTURAL) continue;
      if (reservationAt(x, z, 8)) continue;

      // Is this actually a low point?  Compare the landform here against
      // a ring around it; a ditch belongs where water would collect.
      const here = landformAt(x, z);
      let around = 0;
      for (let k = 0; k < 4; k++) {
        const a = (k / 4) * Math.PI * 2;
        around += landformAt(x + Math.cos(a) * 34, z + Math.sin(a) * 34);
      }
      if (here > around / 4 - 0.45) continue;      // not a hollow
      if (here > 5) continue;                       // not on high ground

      // Run it along the fall line, which is the direction the ring says
      // the land drops fastest.
      let bestA = 0, bestDrop = 0;
      for (let k = 0; k < 8; k++) {
        const a = (k / 8) * Math.PI * 2;
        const drop = here - landformAt(x + Math.cos(a) * 40, z + Math.sin(a) * 40);
        if (drop < bestDrop) { bestDrop = drop; bestA = a; }
      }
      const L = 34 + hash2(i * 23, j * 19) * 26;
      const ex = x + Math.cos(bestA) * L, ez = z + Math.sin(bestA) * L;
      if (onRoad(x, z, segs, 5) || onRoad(ex, ez, segs, 5)) continue;

      const len = Math.hypot(ex - x, ez - z);
      const ang = Math.atan2(ez - z, ex - x);
      const g = new THREE.PlaneGeometry(len, 2.3);
      g.rotateX(-Math.PI / 2);
      g.rotateY(-ang);
      g.translate((x + ex) / 2, Y_DITCH, (z + ez) / 2);
      accPart(key, g, 'foliage', DITCH, { jitter: 0.08 });
      cut++;
    }
  }
  return cut;
}

// ============================================================
// FIELD BOUNDARY PROVENANCE
//
// Hedgerows already existed and were already placed well — on shared
// field boundaries only, broken where a road crosses, with gaps for
// gateways.  What they lacked was a REASON.  Every hedge was
// interchangeable, so nothing downstream could tell an agricultural
// boundary from the edge of a wood or the verge of a trunk road, and a
// later pass had no way to treat them differently.
//
// This classifies a boundary from the world around it.  It changes no
// placement; it names what is already there, and records it so
// qa/field-boundaries.cjs can check the naming is honest.
// ============================================================

export const BOUNDARY = {
  AGRICULTURAL:   'agricultural',    // field to field
  WOODLAND_EDGE:  'woodland-edge',   // farmland meeting trees
  SETTLEMENT_EDGE:'settlement-edge', // farmland meeting a built-up zone
  ROAD_EDGE:      'road-edge',       // running alongside a public road
  DRAINAGE:       'drainage',        // along a hollow
};

// Diagnostic registry.  Chunks stream, so this reflects what is loaded
// rather than the whole planet — which is exactly what a QA sweep of the
// loaded world wants to inspect.
const _boundaries = [];
export function recordBoundary(b) {
  if (_boundaries.length > 20000) return;
  _boundaries.push(b);
}
export function fieldBoundaries() { return _boundaries; }
export function clearFieldBoundaries() { _boundaries.length = 0; }

let _bid = 0;

/**
 * Why this boundary exists.  Order matters: a hedge beside a trunk road
 * is a road edge whatever the fields on either side are doing, and a
 * hedge against a wood is a woodland edge before it is farmland.
 */
export function classifyBoundary(ax, az, bx, bz, segs) {
  const mx = (ax + bx) / 2, mz = (az + bz) / 2;

  let origin = BOUNDARY.AGRICULTURAL;
  if (onRoad(mx, mz, segs, 9)) origin = BOUNDARY.ROAD_EDGE;
  else if (landformAt(mx, mz) > 12) origin = BOUNDARY.WOODLAND_EDGE;
  else {
    const dev = developmentAt(mx, mz);
    if (dev.intensity >= BAND.RURAL.min) origin = BOUNDARY.SETTLEMENT_EDGE;
    else {
      // A hollow: the same test the drainage pass uses, so a boundary
      // called DRAINAGE is one a ditch would actually be cut along.
      const here = landformAt(mx, mz);
      let around = 0;
      for (let k = 0; k < 4; k++) {
        const a = (k / 4) * Math.PI * 2;
        around += landformAt(mx + Math.cos(a) * 30, mz + Math.sin(a) * 30);
      }
      if (here < around / 4 - 0.5) origin = BOUNDARY.DRAINAGE;
    }
  }

  const len = Math.hypot(bx - ax, bz - az);
  return {
    boundaryId: 'B' + (_bid++),
    origin,
    x: +mx.toFixed(1), z: +mz.toFixed(1),
    length: +len.toFixed(1),
    orientation: +Math.atan2(bz - az, bx - ax).toFixed(3),
    // Filled by the hedge pass: where it actually planted, and how many
    // runs it skipped for a road crossing or a gateway.
    drawn: [], gaps: 0,
  };
}

// ============================================================
// INDUSTRIAL LANDSCAPE
//
// 9B sited industry correctly — works on a qualifying road, sheds on an
// internal estate road, nothing where neither exists.  What it did not
// do is give the ground around a works any character, so an industrial
// cluster read as large houses standing in grass.
//
// Two cheap additions carry most of the meaning: hardstanding under and
// between the buildings, and a planted screen on the side that faces
// open country, which is what the INDUSTRIAL zone's own rules already
// said should be there.
// ============================================================

const YARD = 0x9a9789;

export function buildIndustrialGround(key, bounds, parcels, accPart) {
  let yards = 0, buffers = 0;
  for (const p of parcels) {
    if (p.family !== 'industrial') continue;
    if (p.kind === 'barn' || p.kind === 'shed' && p.band === 'rural') continue;
    if (p.x < bounds.minX || p.x >= bounds.maxX) continue;
    if (p.z < bounds.minZ || p.z >= bounds.maxZ) continue;

    // Service yard: hardstanding around the building, squared to it.
    const w = p.w * 1.9, d = p.d * 1.55;
    const g = new THREE.PlaneGeometry(w, d);
    g.rotateX(-Math.PI / 2);
    g.rotateY(-(p.rot || 0));
    g.translate(p.x, 0.028, p.z);
    accPart(key, g, 'opaque', YARD, { jitter: 0.04 });
    yards++;

    // Planted buffer on the countryside side only.  A screen all the way
    // round would be a hedge maze; what a works has is a screen where it
    // faces the fields.
    const bx = p.x - Math.sin(p.rot || 0) * (d * 0.62);
    const bz = p.z - Math.cos(p.rot || 0) * (d * 0.62);
    if (zoneAt(bx, bz) === ZONE.AGRICULTURAL || zoneAt(bx, bz) === ZONE.HINTERLAND) {
      const n = 4;
      for (let k = 0; k < n; k++) {
        const t = (k - (n - 1) / 2) * 6.5;
        const tx = bx + Math.cos(p.rot || 0) * t;
        const tz = bz - Math.sin(p.rot || 0) * t;
        const b = new THREE.SphereGeometry(2.6, 6, 4);
        b.scale(1, 0.8, 1);
        b.translate(tx, 2.4, tz);
        accPart(key, b, 'foliage', 0x5d7a4e, { jitter: 0.1 });
      }
      buffers++;
    }
  }
  return { yards, buffers };
}

// ============================================================
// UTILITY CORRIDORS
//
// One thing a landscape shows that a map does not: that places are
// serviced.  A corridor is cheap to read and easy to overdo, so this is
// deliberately mean with it.
//
// Corridors run between settlements that are actually neighbours, one
// per pair, chosen from the existing catalogue rather than from any new
// structure.  A pair is drawn once — by the settlement with the lower
// id — so two chunks cannot each lay their own version of the same line.
//
// Poles are parameterised by distance ALONG the corridor from its start,
// so a pole belongs to the corridor rather than to a chunk, and the
// chunk that contains it draws it.  That is what stops a pole appearing
// twice at a chunk boundary or vanishing at one.
// ============================================================

const POLE_SPACING = 78;
const CORRIDOR_STRIP = 0x8f9a72;

let _corridors = null;

// Poles as PLACED, not as intended.  The builder rejects a pole that
// would stand near a road, in the reservation or on steep ground, so a
// diagnostic that re-derives positions from the corridor line counts
// poles that were never built — which is exactly the false failure the
// first run of qa/utility-corridors.cjs reported.
const _poles = [];
export function utilityPoles() { return _poles; }
function recordPole(x, z, corridor) {
  if (_poles.length > 5000) return;
  _poles.push({ x: +x.toFixed(1), z: +z.toFixed(1), corridor });
}

/** The corridor set, derived once from the settlement catalogue. */
export function utilityCorridors() {
  if (_corridors) return _corridors;
  const list = allSettlements();
  const out = [];
  for (const a of list) {
    if (a.tier < 2) continue;                 // hamlets are not serviced hubs
    // Nearest neighbour worth connecting to.
    let best = null, bd = Infinity;
    for (const b of list) {
      if (b === a || b.tier < 1) continue;
      const d = Math.hypot(b.x - a.x, b.z - a.z);
      if (d < bd) { bd = d; best = b; }
    }
    if (!best || bd > 2600) continue;
    // Draw each pair once.
    if (String(a.id) > String(best.id)) continue;
    const ux = (best.x - a.x) / bd, uz = (best.z - a.z) / bd;
    // Start and end clear of both settlements' built edges.
    const x1 = a.x + ux * (a.edgeR * 0.72), z1 = a.z + uz * (a.edgeR * 0.72);
    const x2 = best.x - ux * (best.edgeR * 0.72), z2 = best.z - uz * (best.edgeR * 0.72);
    const len = Math.hypot(x2 - x1, z2 - z1);
    if (len < 140) continue;
    out.push({ id: `U-${a.id}-${best.id}`, from: a.id, to: best.id,
               x1, z1, x2, z2, len, ux: (x2 - x1) / len, uz: (z2 - z1) / len });
  }
  _corridors = out;
  return out;
}

/**
 * Where a corridor's poles actually go.
 *
 * Pure, and the single source of truth: the builder draws exactly this
 * set (clipped to its chunk) and the audit reads exactly this set.  The
 * first version of qa/utility-corridors.cjs re-derived positions from the
 * corridor line without the filters and reported two poles standing in a
 * carriageway that were never built; the version after that read a
 * registry which was empty because the probe never left orbit, and
 * "0 poles, PASS" proves nothing at all.
 */
export function corridorPoles(c) {
  const out = [];
  for (let k = 1; k * POLE_SPACING < c.len; k++) {
    const d = k * POLE_SPACING;
    const x = c.x1 + c.ux * d, z = c.z1 + c.uz * d;
    if (reservationAt(x, z, 8) || insideAuthoredTown(x, z, 8)) continue;
    if (onRoad(x, z, segmentsNear(x, z, 80), 7)) continue;
    if (landformAt(x, z) > 14) continue;
    out.push({ x: +x.toFixed(1), z: +z.toFixed(1), corridor: c.id });
  }
  return out;
}

/** How many poles a corridor carries, for diagnostics. */
export function corridorPoleCount(c) { return corridorPoles(c).length; }

export function buildUtilityCorridors(key, bounds, segs, accPart) {
  let poles = 0, strips = 0;
  for (const c of utilityCorridors()) {
    // Cheap reject: does this corridor come anywhere near the chunk?
    const cx = (bounds.minX + bounds.maxX) / 2, cz = (bounds.minZ + bounds.maxZ) / 2;
    let t = ((cx - c.x1) * c.ux + (cz - c.z1) * c.uz);
    t = t < 0 ? 0 : t > c.len ? c.len : t;
    if (Math.hypot(cx - (c.x1 + c.ux * t), cz - (c.z1 + c.uz * t)) > 220) continue;

    // The maintained strip, in runs, each drawn by the chunk it sits in.
    const RUN = 24;
    for (let d = 0; d < c.len; d += RUN) {
      const mx = c.x1 + c.ux * (d + RUN / 2), mz = c.z1 + c.uz * (d + RUN / 2);
      if (mx < bounds.minX || mx >= bounds.maxX || mz < bounds.minZ || mz >= bounds.maxZ) continue;
      if (reservationAt(mx, mz, 6) || insideAuthoredTown(mx, mz, 6)) continue;
      if (onRoad(mx, mz, segs, 4)) continue;
      const ang = Math.atan2(c.uz, c.ux);
      const g = new THREE.PlaneGeometry(Math.min(RUN, c.len - d), 7.5);
      g.rotateX(-Math.PI / 2);
      g.rotateY(-ang);
      g.translate(mx, 0.018, mz);
      accPart(key, g, 'foliage', CORRIDOR_STRIP, { jitter: 0.05 });
      strips++;
    }

    // Poles, owned by distance along the corridor — the chunk that
    // contains one draws it, so none is doubled or dropped at an edge.
    for (const pole of corridorPoles(c)) {
      const px = pole.x, pz = pole.z;
      if (px < bounds.minX || px >= bounds.maxX || pz < bounds.minZ || pz >= bounds.maxZ) continue;

      const h = 9.5;
      const post = new THREE.BoxGeometry(0.34, h, 0.34);
      post.translate(px, h / 2, pz);
      accPart(key, post, 'opaque', 0x6b6154, { jitter: 0.05 });
      const arm = new THREE.BoxGeometry(2.6, 0.2, 0.2);
      arm.rotateY(-Math.atan2(c.uz, c.ux));
      arm.translate(px, h - 0.7, pz);
      accPart(key, arm, 'opaque', 0x6b6154, { jitter: 0.04 });
      recordPole(px, pz, c.id);
      poles++;
    }
  }
  return { poles, strips };
}
