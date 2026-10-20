// ============================================================
// PARCELS — Phase 7 visual sanitation
//
// Phase 7 placed buildings by walking a 26 m grid over the chunk,
// jittering each cell, rolling against a density number and rotating the
// result randomly.  Nothing in that pipeline ever looked at a road, so
// from Eagle the buildings read exactly as what they were: confetti.
//
// Buildings are now laid out ALONG STREET FRONTAGE.  For each road
// segment this module enumerates the parcels on both of its sides —
// width, depth, setback, use and storey count all derived from the
// development band the frontage sits in — and every building is turned
// to face its road.  That one relationship is what turns a scatter of
// boxes into streets.
//
// The enumeration is a pure function of (segment id, index, side), so
// any chunk computes the same parcel identically and a parcel is emitted
// exactly once, by whichever chunk contains its centre.
//
// Bands, in the order a player meets them walking out of a core:
//
//   CORE    continuous frontage, shops at ground level, deepest plots,
//           the tallest storey counts in the settlement
//   INNER   semi-continuous terraces and mixed use, small gaps
//   OUTER   semi-detached, modest gardens, corner shops only
//   EDGE    detached houses, generous gardens, wide spacing
//   FRINGE  scattered homes on large plots along the lanes
//   RURAL   farmsteads: a house, a barn, and fields around them
// ============================================================

import { PROC } from '../config.js';
import { hash2, fbm2 } from './seed.js';
import { developmentAt, BAND, insideAuthoredTown, reservationAt } from './settlement.js';
import { zoneAt, clusterAt, ZONE } from './zones.js';
import { landformAt } from './terrain.js';
import { onRoad, segmentsNear } from './roads.js';

// ---- Frontage rules per band ----------------------------------------
//
// frontage  parcel width along the street
// depth     depth of the BUILDING
// plot      depth of the whole property, front boundary to back
// setback   gap between kerb and the building face
// fill      probability a parcel is built on at all
// gapFrac   fraction of the frontage left as a gap between neighbours
//           (0 = continuous terrace, 0.5 = generously detached)
//
// `plot` is what fills a block.  Without it the buildings lined the
// streets correctly and the middle of every block stayed an empty green
// field, which from a street read as houses standing in parkland.  Plot
// depths here are set so that two facing rows of properties very nearly
// meet back to back across a block, which is what a block is.
const RULES = {
  core:    { frontage: 13, depth: 17, plot: 24, setback: 1.6, fill: 0.94, gapFrac: 0.06, maxFloorFrac: 1.00 },
  inner:   { frontage: 12, depth: 15, plot: 26, setback: 3.0, fill: 0.86, gapFrac: 0.14, maxFloorFrac: 0.68 },
  outer:   { frontage: 15, depth: 14, plot: 30, setback: 5.5, fill: 0.84, gapFrac: 0.28, maxFloorFrac: 0.40 },
  edge:    { frontage: 19, depth: 13, plot: 32, setback: 8.0, fill: 0.70, gapFrac: 0.42, maxFloorFrac: 0.26 },
  fringe:  { frontage: 34, depth: 15, plot: 36, setback: 11.0, fill: 0.34, gapFrac: 0.62, maxFloorFrac: 0.18 },
  rural:   { frontage: 64, depth: 22, plot: 44, setback: 16.0, fill: 0.20, gapFrac: 0.74, maxFloorFrac: 0.14 },
};

const STOREY = 3.2;

// ---- Placement trace (diagnostic, off by default) --------------------
//
// A one-sided street can be perfectly correct — the far side may be
// countryside, a park, a reservation or simply another zone — or it can
// be a placement bug.  The two are indistinguishable from the outside,
// so the rejection reasons are made observable rather than guessed at.
// Null in normal runs, so this costs one comparison per candidate.
let _trace = null;
export function setParcelTrace(fn) { _trace = fn || null; }
const T = (why, segId, side, x, z) => { if (_trace) _trace(why, segId, side, x, z); };

// Footway width per road class, as buildRoadGeometry actually builds it.
// A setback measured from the carriageway alone puts the building on the
// pavement of any road that has one — which is what happened the moment
// the authored streets joined the index and parcels began fronting them.
const FOOTWAY = { street: 2.2, lane: 2.2, authored: 2.6, arterial: 2.8, collector: 2.8 };

/**
 * Land-use field.  Low frequency, so commercial and industrial appear as
 * CLUSTERS — a shopping street, a works on the edge of town — instead of
 * alternating parcel by parcel, which is what made the old mix read as
 * noise even where the density was right.
 */
export function useField(x, z) {
  return fbm2(x * 0.0035 + 13.7, z * 0.0035 - 21.3, 2);
}

/**
 * Enumerate the parcels on both sides of one road segment.
 *
 * @param {object} seg        road segment (see roads.js)
 * @param {object} ctx        { minX, maxX, minZ, maxZ } owning chunk bounds
 * @param {Array}  nearSegs   segments to test against, so a building is
 *                            never placed on top of a crossing road
 * @param {Array}  out        parcels are pushed here
 */
export function parcelsForSegment(seg, ctx, nearSegs, out) {
  // Lanes and regional roads carry frontage differently: a trunk road
  // between towns must NOT sprout ribbon development along its whole
  // length, or the countryside fills up with houses facing a motorway.
  if (seg.type === 'regional') return;

  const dx = (seg.x2 - seg.x1) / seg.len;
  const dz = (seg.z2 - seg.z1) / seg.len;
  const nx = -dz, nz = dx;                    // left-hand normal

  // Band is sampled once at the segment midpoint: a single segment is
  // short enough that its whole frontage belongs to one neighbourhood,
  // and sampling per parcel made adjacent plots disagree about setback.
  const midDev = developmentAt((seg.x1 + seg.x2) / 2, (seg.z1 + seg.z2) / 2);
  if (!midDev.settlement) return;
  const rule = RULES[midDev.band.name];
  if (!rule) return;

  const s = midDev.settlement;
  // Phase 9B: the zone sets the GRAIN of the frontage.  A core street
  // divides into more, narrower plots than a lane through a hamlet does,
  // and that difference in rhythm is visible from the air long before
  // any difference in architecture is.
  const midZone = zoneAt((seg.x1 + seg.x2) / 2, (seg.z1 + seg.z2) / 2);
  // Does a road that can carry industry reach this frontage?
  //
  // Requiring the works to stand ON an arterial was too strict: the
  // industrial zone rarely fronts one directly, and demanding it left
  // two works standing in 1400 m of world.  Requiring nothing at all was
  // too loose, and produced a ten-unit estate served by a residential
  // street.  What an industrial estate actually has is an internal road
  // a short way off a main one, so that is what is tested.
  const midX = (seg.x1 + seg.x2) / 2, midZ = (seg.z1 + seg.z2) / 2;
  let nearBigRoad = false;
  for (const g of nearSegs) {
    if (g.type !== 'arterial' && g.type !== 'regional' && g.type !== 'collector') continue;
    const gdx = g.x2 - g.x1, gdz = g.z2 - g.z1;
    const l2 = gdx * gdx + gdz * gdz;
    let t = l2 ? ((midX - g.x1) * gdx + (midZ - g.z1) * gdz) / l2 : 0;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    if (Math.hypot(midX - (g.x1 + t * gdx), midZ - (g.z1 + t * gdz)) < 130) {
      nearBigRoad = true; break;
    }
  }
  const stride = rule.frontage * midZone.build.strideMul;
  const n = Math.floor(seg.len / stride);
  if (n < 1) return;

  // Centre the run of parcels on the segment, so a frontage reads as
  // deliberate rather than starting hard at one junction.
  const pad = (seg.len - n * stride) / 2;

  for (let side = 0; side < 2; side++) {
    const sgn = side ? -1 : 1;

    for (let k = 0; k < n; k++) {
      const h = hash2(seg.id * 131 + k * 7 + side * 3, seg.id * 17 + k * 29 + side * 101);

      const along = pad + (k + 0.5) * stride;
      const fx = seg.x1 + dx * along;
      const fz = seg.z1 + dz * along;

      // Local band: gently varies along a long frontage so a street can
      // thin out toward its far end.
      const dev = developmentAt(fx, fz);
      if (dev.settlement !== s) { T('other-settlement', seg.id, side, fx, fz); continue; }
      if (dev.intensity < BAND.RURAL.min) { T('below-rural', seg.id, side, fx, fz); continue; }
      if (insideAuthoredTown(fx, fz, 3)) { T('authored-town', seg.id, side, fx, fz); continue; }
      // Reserved land is not a development parcel.
      if (reservationAt(fx, fz, 6)) { T('reservation', seg.id, side, fx, fz); continue; }

      const localRule = RULES[dev.band.name] || rule;
      // The zone is sampled where the BUILDING will stand, not at its
      // frontage point.  With deep setbacks the two can be different
      // zones, and deciding a use from the kerb put fourteen houses
      // inside the industrial zone in the first run of this change.
      const approxOff = seg.width / 2 + (FOOTWAY[seg.type] || 0) +
                        localRule.setback + localRule.depth * 0.5;
      const zone = zoneAt(fx + nx * sgn * approxOff, fz + nz * sgn * approxOff);
      const zb = zone.build;

      // Occupancy: the band says how much, the zone says how it gathers.
      // At clump 0 this is the band's own fill; at clump 1 it is decided
      // entirely by the cluster field, so buildings come in groups with
      // real gaps between them instead of an even dusting along every
      // road.  This is what makes a suburb read as a neighbourhood and
      // the countryside read as having hamlets in it.
      const cl = clusterAt(fx, fz);
      const fill = localRule.fill * zb.fillMul *
                   (1 - zb.clump + zb.clump * 2 * cl);
      if (h > fill) { T('fill', seg.id, side, fx, fz); continue; }

      // Face the road: local -Z is the front elevation, so the rotation
      // that turns -Z toward the kerb is atan2 of the inward normal.
      const rot = rotOf(nx, nz, sgn);

      // ---- Plot geometry ----
      const gapJ = hash2(seg.id * 7 + k, side * 53 + 11);
      // Gap between neighbours: small in a core, where buildings hold the
      // street line, wide in a hamlet where they do not.
      const gap = Math.min(0.85, localRule.gapFrac * zb.gapMul * (0.65 + gapJ * 0.7));
      // Width is derived from the plot module and then scaled by the
      // zone, but never allowed to exceed the stride it sits in — an
      // unclamped footMul on a rural stride of 105 m produced 55 m
      // buildings, and in a core where the stride is tighter than the
      // module it would have made neighbours overlap.
      // ...and never thinner than a building can plausibly be.  A wide
      // rural stride with a wide gap left 3 m slivers standing on their
      // own in a field.
      let w = Math.max(7, Math.min(stride * (1 - gap) * zb.footMul[0], stride * 0.94));
      let d = localRule.depth * (0.72 + hash2(k * 13 + side, seg.id * 3) * 0.42) * zb.footMul[1];
      const setback = localRule.setback * zb.setbackMul *
                      (0.8 + hash2(seg.id + k, side * 7 + 2) * 0.45);

      // Use and storeys are decided before the plot is positioned,
      // because a works or a landmark needs a bigger footprint and the
      // setback has to be measured from the footprint it actually gets.
      const use = chooseUse(s, dev, fx, fz, seg, h, zone, nearBigRoad);
      if (!use) { T('no-use', seg.id, side, fx, fz); continue; }
      const floors = floorsFor(s, dev, use, localRule, hash2(seg.id * 5 + k, side * 19 + 7));
      if (use.family === 'industrial') { w = Math.max(w, 16); d = Math.max(d, 20); }
      if (use.kind === 'landmark') { w *= 1.15; d *= 1.15; }
      if (use.kind === 'civic') { w *= 1.10; d *= 1.10; }

      // Building centre: out from the kerb far enough that the building's
      // WORLD-AXIS bounding box clears the carriageway by the setback.
      //
      // Collision bodies are axis-aligned (Phase 4) but these buildings
      // are turned to face their street, so a plot on a diagonal road has
      // a collision box noticeably wider than its walls.  Setting back by
      // half the depth would leave that box lying across the footway and
      // the player would meet an invisible wall in the street.  Measuring
      // the real AABB extent along the road normal costs nothing and
      // keeps geometry and collision honest with each other.
      const ca = Math.abs(Math.cos(rot)), sa = Math.abs(Math.sin(rot));
      const hx = (w * ca + d * sa) / 2;
      const hz = (w * sa + d * ca) / 2;
      const reach = Math.abs(nx) * hx + Math.abs(nz) * hz;

      const off = seg.width / 2 + (FOOTWAY[seg.type] || 0) + setback + reach;
      const bx = fx + nx * sgn * off;
      const bz = fz + nz * sgn * off;

      if (bx < ctx.minX || bx >= ctx.maxX || bz < ctx.minZ || bz >= ctx.maxZ) { T('outside-chunk', seg.id, side, bx, bz); continue; }
      if (reservationAt(bx, bz, 2)) { T('reservation-body', seg.id, side, bx, bz); continue; }
      if (landformAt(bx, bz) > 2.0) { T('relief', seg.id, side, bx, bz); continue; }
      // Clear of every OTHER road — its own frontage is what it is set
      // back from, so testing against that one would reject the plot.
      if (crossesOtherRoad(bx, bz, hx, hz, nearSegs, seg)) { T('crosses-road', seg.id, side, bx, bz); continue; }

      T('PLACED', seg.id, side, bx, bz);
      out.push({
        x: bx, z: bz, rot,
        w, d,
        floors,
        h: floors * STOREY,
        family: use.family,
        kind: use.kind,
        variant: use.variant,
        band: dev.band.name,
        settlement: s,
        // The property this building stands on: its width along the
        // street and how far back it runs.  The building layer draws the
        // garden, the yard and the boundary from these.
        plotW: localRule.frontage,
        plotFront: setback,
        // How far the plot may run behind the building before it reaches
        // another road.
        //
        // The parcel layer checks the BUILDING against nearby roads, but
        // the plot is much bigger than the building — garden, yard and
        // side boundaries — and none of that was ever tested.  With
        // blocks about 70 m across and plots up to 44 m deep, two facing
        // rows met in the middle and their boundaries ran straight across
        // whatever street lay behind: a sweep of the settlement found 313
        // plot boundaries standing in a carriageway.
        // (nx, nz) * sgn points from the road OUT to the building, so it
        // is also the direction the back garden runs in.  Passing its
        // negative marched back toward the plot's own frontage, found
        // nothing (that road is excluded as its own), and clamped
        // nothing — which is why the first attempt changed the numbers
        // not at all.
        plotBack: backRoom(bx, bz, nx * sgn, nz * sgn, d,
                           Math.max(2, localRule.plot - setback - d), nearSegs, seg),
        frontX: fx, frontZ: fz,
      });
    }
  }
}

/**
 * Farmsteads.  The rural and countryside bands are served by lanes, not
 * by street grids, so their buildings come from here instead: a house
 * and one or two outbuildings set back from a road, with fields around
 * them.  Deliberately rare — a farm every few hundred metres reads as
 * agriculture; one every fifty reads as sprawl.
 */
/**
 * Where the farmsteads ARE.
 *
 * Split out of farmsteadsForChunk so that the buildings and the farm
 * tracks that serve them are derived from one enumeration.  Two passes
 * each re-deriving "where is the farm" from the same lattice is how a
 * track ends up arriving at open ground.
 *
 * Pure and deterministic: a function of the lattice and the world
 * fields, with no side effects, so the landscape layer can call it for
 * any chunk without building anything.
 *
 * @returns {Array<{x,z,rot,fwdX,fwdZ,rgtX,rgtZ,i,j,access,accessAt,accessD}>}
 */
export function farmsteadSites(ctx, segs) {
  const CELL = 170;
  const sites = [];
  const i0 = Math.floor(ctx.minX / CELL), i1 = Math.floor(ctx.maxX / CELL);
  const j0 = Math.floor(ctx.minZ / CELL), j1 = Math.floor(ctx.maxZ / CELL);

  for (let j = j0; j <= j1; j++) {
    for (let i = i0; i <= i1; i++) {
      const roll = hash2(i * 313 + 11, j * 719 + 5);
      if (roll > PROC.farmsteadChance) continue;

      const fx = (i + hash2(i * 3, j * 5) * 0.8 + 0.1) * CELL;
      const fz = (j + hash2(j * 7, i * 9) * 0.8 + 0.1) * CELL;
      if (fx < ctx.minX || fx >= ctx.maxX || fz < ctx.minZ || fz >= ctx.maxZ) continue;

      const dev = developmentAt(fx, fz);
      // Farms belong to the countryside and the rural fringe, not to towns.
      if (dev.intensity > BAND.FRINGE.min) continue;
      if (landformAt(fx, fz) > 2.0) continue;

      // A farmstead needs road access; without one it reads as a
      // building dropped in a field.  The reach is generous because the
      // farm TRACK is what makes the connection visible — before tracks
      // existed this had to be short enough that the farm sat almost on
      // the verge, which is not where farms are.
      let access = null, bestD = PROC.farmAccessRange, at = null;
      for (const s of segs) {
        const ddx = s.x2 - s.x1, ddz = s.z2 - s.z1;
        const l2 = ddx * ddx + ddz * ddz;
        let t = l2 ? ((fx - s.x1) * ddx + (fz - s.z1) * ddz) / l2 : 0;
        t = t < 0 ? 0 : t > 1 ? 1 : t;
        const qx = s.x1 + t * ddx, qz = s.z1 + t * ddz;
        const d = Math.hypot(fx - qx, fz - qz);
        if (d < bestD && d > s.width) { bestD = d; access = s; at = [qx, qz]; }
      }
      if (!access) continue;

      // Orient the whole steading to the access road.
      const rot = Math.atan2(fx - (access.x1 + access.x2) / 2, fz - (access.z1 + access.z2) / 2);
      sites.push({
        x: fx, z: fz, rot, i, j,
        fwdX: Math.sin(rot), fwdZ: Math.cos(rot),
        rgtX: Math.cos(rot), rgtZ: -Math.sin(rot),
        access, accessAt: at, accessD: bestD,
      });
    }
  }
  return sites;
}

export function farmsteadsForChunk(ctx, segs, out) {
  for (const site of farmsteadSites(ctx, segs)) {
      const { x: fx, z: fz, rot, i, j, fwdX, fwdZ, rgtX, rgtZ } = site;

      // Farmhouse, facing the lane.
      out.push({
        x: fx, z: fz, rot,
        w: 10 + hash2(i, j) * 4, d: 9 + hash2(j, i) * 4,
        floors: 2, h: 2 * STOREY,
        family: 'residential', kind: 'farmhouse', variant: 1,
        band: 'rural', settlement: null, plotW: 26, plotFront: 8, plotBack: 14,
        frontX: fx - fwdX * 8, frontZ: fz - fwdZ * 8,
      });

      // Barn set square to the house across a yard.
      const bd = 16 + hash2(i * 5, j * 3) * 10;
      out.push({
        x: fx + rgtX * 19 + fwdX * 5, z: fz + rgtZ * 19 + fwdZ * 5, rot,
        w: 11 + hash2(i * 9, j * 11) * 5, d: bd,
        floors: 1, h: 6.5,
        family: 'industrial', kind: 'barn', variant: 0,
        band: 'rural', settlement: null, plotW: 0, plotFront: 0, plotBack: 0,
        frontX: fx, frontZ: fz,
      });

      if (hash2(i * 17, j * 23) < 0.45) {
        out.push({
          x: fx - rgtX * 15 + fwdX * 12, z: fz - rgtZ * 15 + fwdZ * 12, rot,
          w: 7, d: 9, floors: 1, h: 4.2,
          family: 'industrial', kind: 'shed', variant: 1,
          band: 'rural', settlement: null, plotW: 0, plotFront: 0, plotBack: 0,
          frontX: fx, frontZ: fz,
        });
      }
  }
}

/**
 * Rotation that turns a building's front elevation (local -Z) toward the
 * kerb, given the road's left-hand normal and which side the plot is on.
 */
function rotOf(nx, nz, sgn) { return Math.atan2(-nx * sgn, -nz * sgn); }

/**
 * How deep the plot can run behind the building before it meets a road.
 *
 * Marches back from the rear face and stops short of the first
 * carriageway it finds, so a plot never claims public way.  Returns at
 * least a token depth: a building with no back garden is odd, a building
 * whose back garden is in the street is wrong.
 */
function backRoom(bx, bz, ox, oz, depth, want, segs, own) {
  const rearX = bx + ox * depth / 2;
  const rearZ = bz + oz * depth / 2;
  const CLEAR = 2.5;                      // keep this far off any kerb
  for (let t = 0; t <= want; t += 1.5) {
    const x = rearX + ox * t, z = rearZ + oz * t;
    for (let i = 0; i < segs.length; i++) {
      const g = segs[i];
      if (g === own) continue;
      const dx = g.x2 - g.x1, dz = g.z2 - g.z1;
      const l2 = dx * dx + dz * dz;
      let u = l2 ? ((x - g.x1) * dx + (z - g.z1) * dz) / l2 : 0;
      u = u < 0 ? 0 : u > 1 ? 1 : u;
      const px = x - (g.x1 + u * dx), pz = z - (g.z1 + u * dz);
      if (px * px + pz * pz < (g.width / 2 + CLEAR) ** 2) return Math.max(2, t - 1.5);
    }
  }
  return want;
}

/**
 * True if a plot's bounding box would sit on a road other than the one
 * it fronts.  Crossing streets and the arterial network get a wide
 * berth; the plot's own frontage is excluded, since the setback already
 * defines that relationship.
 */
function crossesOtherRoad(bx, bz, hx, hz, segs, own) {
  // The building's own frontage is set back by its exact AABB extent, but
  // against OTHER roads it was only cleared by 82% of its bounding radius
  // with no allowance for their footways — so seventy-six buildings had a
  // corner standing in somebody else's pavement.  Use the real extent and
  // clear the footway as well as the carriageway.
  const FOOTWAY = 2.4;
  for (let i = 0; i < segs.length; i++) {
    const s = segs[i];
    if (s === own) continue;
    const ddx = s.x2 - s.x1, ddz = s.z2 - s.z1;
    const l2 = ddx * ddx + ddz * ddz;
    const clear = s.width / 2 + FOOTWAY;
    let t0 = l2 ? ((bx - s.x1) * ddx + (bz - s.z1) * ddz) / l2 : 0;
    const len = Math.sqrt(l2) || 1;
    const win = (hx + hz + clear) / len;
    for (let k = -2; k <= 2; k++) {
      let t = t0 + (k / 2) * win;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      const qx = s.x1 + t * ddx, qz = s.z1 + t * ddz;
      const ex = Math.max(0, Math.abs(qx - bx) - hx);
      const ez = Math.max(0, Math.abs(qz - bz) - hz);
      if (ex * ex + ez * ez < clear * clear) return true;
    }
  }
  return false;
}

/**
 * Every parcel the frontage rules produce within `r` of a point.
 * Used by the road audit to ask whether a street is serving anything.
 */
export function parcelsNear(x, z, r) {
  const segs = segmentsNear(x, z, r + 90);
  const ctx = { minX: x - r, maxX: x + r, minZ: z - r, maxZ: z + r };
  const out = [];
  for (const s of segs) parcelsForSegment(s, ctx, segs, out);
  farmsteadsForChunk(ctx, segs, out);
  return out;
}

// ---- use and height --------------------------------------------------

/**
 * What gets built on a parcel.
 *
 * The rules are ordinary planning logic, and they matter more to the
 * aerial read than any amount of facade detail: shops gather on the
 * arterials near a centre, industry sits on the outskirts where the big
 * roads are, civic buildings sit at the core, and everything else is
 * somebody's house.
 */
function chooseUse(s, dev, x, z, seg, h, zone, nearBigRoad) {
  const band = dev.band;
  const uf = useField(x, z);
  const onArterial = seg.type === 'arterial';

  // Civic and landmark: core only, and rationed.  The brief is explicit
  // that not every building should be important.
  if (band === BAND.CORE && s.tier >= 2) {
    if (h < 0.06) return { family: 'civic', kind: 'landmark', variant: 0 };
    if (h < 0.16) return { family: 'civic', kind: 'civic', variant: h < 0.11 ? 0 : 1 };
  }

  // ---- Industry ----
  //
  // The industrial ZONE existed from Phase 9A but nothing consulted it
  // here, so the two disagreed completely: an audit of 71 parcels inside
  // the industrial zone found 64 houses and 7 works.  Industry was being
  // sited by a band-and-arterial test that rarely coincided with the zone,
  // and housing filled the industrial edge — which is exactly the
  // residential/industrial adjacency this phase is meant to remove.
  //
  // The zone is now the authority on WHERE, and it is already derived
  // from the same use-field expression, so the two cannot drift apart.
  // A works still needs a real road to work off: an industrial estate
  // hanging off a residential street is as wrong as a works in a garden.
  const onBigRoad = seg.type === 'arterial' || seg.type === 'regional' ||
                    seg.type === 'collector';
  if (zone === ZONE.INDUSTRIAL) {
    if (onBigRoad) return { family: 'industrial', kind: 'works', variant: h < 0.5 ? 0 : 1 };
    // An internal estate road: sheds and yards, served off the main one.
    if (nearBigRoad) return { family: 'industrial', kind: 'shed', variant: h < 0.5 ? 0 : 1 };
    // Inside the zone but with only a local street to work off.  The
    // first version of this built sheds here anyway and produced a
    // ten-unit industrial estate served by a residential street — the
    // adjacency this phase exists to remove, arrived at from the other
    // direction.  Industry needs a road that can carry it; where there
    // is none, the right answer is that nothing is built, and the land
    // stays the yard and open ground an industrial edge actually has.
    return null;
  }

  // Outside the zone, industry is not placed by this function at all.
  // Farmsteads are the one exception and they come through
  // farmsteadsForChunk(), which builds its own barns and sheds.

  // Commercial: the high street.  Needs a busy frontage AND the use
  // field's agreement, so shops form runs rather than appearing singly.
  const commercialPull = (band === BAND.CORE ? 0.85 : band === BAND.INNER ? 0.52 : band === BAND.OUTER ? 0.20 : 0.05)
                       * (onArterial ? 1.35 : 0.72);
  if (uf > 0.52 && h < commercialPull) {
    return { family: 'commercial', kind: band === BAND.CORE ? 'shop' : 'mixed', variant: h < commercialPull * 0.45 ? 0 : 1 };
  }

  // Everything else is housing, in the form the band supports.
  if (band === BAND.CORE || band === BAND.INNER) {
    return { family: 'residential', kind: 'terrace', variant: 2 };
  }
  if (band === BAND.OUTER) {
    return { family: 'residential', kind: 'semi', variant: h < 0.5 ? 0 : 2 };
  }
  return { family: 'residential', kind: 'house', variant: h < 0.55 ? 0 : 1 };
}

/**
 * Storeys.  Driven by development intensity and capped by the
 * settlement's own tier, so a hamlet never grows a tower and a city's
 * skyline falls away toward its suburbs.
 */
function floorsFor(s, dev, use, rule, h) {
  const tierMax = s ? s.floors : 2;

  // Height follows PROXIMITY TO THE CENTRE, not intensity alone.
  //
  // Driving it from intensity gave Veridian Cap seven- and eight-storey
  // slabs standing immediately outside a town whose own stock is mostly
  // two to four storeys with three landmark terraces — the suburbs
  // out-built the settlement they belong to.  The development field is
  // deliberately broad (Veridian Cap's reaches 640 m) because it governs
  // where building happens; how TALL to build is a different question,
  // and it has to fall away much faster than density does or the
  // hierarchy inverts.
  //
  // At a quarter of the way to the edge this is already down to about a
  // third of the settlement's maximum, which puts three- and four-storey
  // frontage against the town and two-storey housing beyond it.
  const prox = Math.max(0, 1 - dev.u * 2.2);
  const base = 1 + (tierMax - 1) * Math.pow(prox, 1.5) * rule.maxFloorFrac / RULES.core.maxFloorFrac;

  let f = base * (0.80 + h * 0.45);
  if (use.kind === 'landmark') f = tierMax * (0.95 + h * 0.3);
  else if (use.kind === 'civic') f = Math.max(2, base * 0.8);
  else if (use.family === 'industrial') f = Math.min(2, base);
  else if (use.kind === 'house' || use.kind === 'semi' || use.kind === 'farmhouse') {
    // Suburban housing is two storeys as a rule, with the occasional
    // bungalow.  Rounding the intensity curve directly made most of the
    // outer bands single-storey, and a suburb of single-storey boxes
    // reads as a shed farm rather than as somewhere people live.
    f = h < 0.22 ? 1 : 2;
  }

  return Math.max(1, Math.min(tierMax, Math.round(f)));
}
