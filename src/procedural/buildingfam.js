// ============================================================
// PROCEDURAL BUILDING FAMILIES — Phase 7 visual sanitation
//
// Two things were wrong with the Phase 7 families, and both were
// visible from Eagle.
//
// The first: buildProcBuilding accepted a `rotation` argument and every
// builder inside it ignored the argument, so every procedural building
// on the planet was axis-aligned.  A field of boxes all facing the same
// way is the single loudest "generated" tell there is, and no amount of
// placement work survives it.  Every form here is now built in its own
// local frame and rotated onto its plot, so buildings face their street.
//
// The second: form was chosen from a family and a variant number that
// knew nothing about where the building stood.  Form now follows the
// parcel — its use, its storey count and its band — which is what makes
// a core read as a core and a lane read as a lane.
//
// Roofs carry the palette.  From altitude the roof is most of what is
// visible of a building, so roof colour and pitch do more for the
// aerial read than any facade work, and they are where the settlement's
// character lives: warm pantile and slate in the housing, pale flat
// decks and planted terraces in the cores, standing-seam metal on the
// works and barns.
// ============================================================

import * as THREE from 'three';
import { collisionRegistry } from '../city/collision.js';
import { hash2 } from './seed.js';

// ---- Palette -------------------------------------------------------
// Held in the same value range as facades.js so procedural structures
// read as part of Veridian Cap's world rather than as foreign blocks.
const C = {
  wallHome:  [0xe0cfae, 0xd8c3a0, 0xe7dcc2, 0xcdb694, 0xdcc9ad],
  wallShop:  [0xe6dfd0, 0xdcd4c2, 0xece6d8, 0xd3cab6],
  wallTall:  [0xd6d3c8, 0xc8c7bd, 0xdedbd0],
  wallCivic: [0xe9e4d6, 0xdfd8c6],
  wallInd:   [0x9fa4a2, 0xb0b3ac, 0x8d9290],
  wallBarn:  [0x7a6450, 0x8a6f55],

  // Pitched roofs.  The spread here is what gives a suburb its texture
  // from above; a single roof colour reads as a printed pattern.
  roofPitched: [0x8c5e4a, 0x9a6a4e, 0x6b6f66, 0x7c6b56, 0x5f6a63, 0xa1705a],
  // Flat decks: pale, so urban cores read lighter than their suburbs.
  roofFlat:  [0xbdb9ac, 0xb3aea0, 0xc6c2b4],
  roofGreen: 0x7d9a68,          // planted deck — the Elysium note
  roofMetal: [0x9aa3a4, 0x88918f],

  baseWarm:  0xa89a83,
  baseStone: 0x9aa09c,
  trimLight: 0xf1ece0,
  trimShade: 0xb6b0a1,
  glassDay:  0x4a6f7c,
  glassPale: 0x6f95a4,
  glassWarm: 0x5d7f84,
  bronze:    0x96794f,
  steel:     0xa6acad,
  door:      0x8a7a64,
  reveal:    0x6f6a60,   // the shadow inside a window opening
  doorDark:  0x6b5a48,

  // Plot surfaces.  A building with no ground around it floats; a
  // building with a garden, a yard or a forecourt sits on a parcel, and
  // from altitude the parcels are what make a street legible.
  lawn:      [0x86a06a, 0x7d9a63, 0x8fa872],
  yard:      0xa8a496,
  paving:    0xb8b3a4,
};

const STOREY = 3.2;

// ============================================================
// LOCAL FRAME
//
// Every builder works in a frame whose origin is the plot centre, +X is
// along the frontage and -Z faces the street.  The frame applies the
// plot's rotation on the way out, which is what finally makes `rotation`
// mean something.
// ============================================================

function frame(accPart, accSlab, key, cx, cz, rot) {
  const ca = Math.cos(rot), sa = Math.sin(rot);
  return {
    /** Box in local coordinates. */
    slab(bucket, color, w, h, d, lx, ly, lz, opt) {
      const g = new THREE.BoxGeometry(w, h, d);
      g.rotateY(rot);
      g.translate(cx + lx * ca + lz * sa, ly, cz - lx * sa + lz * ca);
      return accPart(key, g, bucket, color, opt);
    },
    /** Arbitrary geometry authored in local space. */
    part(geo, bucket, color, opt) {
      geo.rotateY(rot);
      geo.translate(cx, 0, cz);
      return accPart(key, geo, bucket, color, opt);
    },
    /** Flat quad on the ground in local coordinates (plots, yards). */
    pad(color, w, d, lx, lz, y, opt) {
      const g = new THREE.PlaneGeometry(w, d);
      g.rotateX(-Math.PI / 2);
      g.rotateY(rot);
      g.translate(cx + lx * ca + lz * sa, y, cz - lx * sa + lz * ca);
      return accPart(key, g, 'foliage', color, opt);
    },
  };
}

/**
 * Build one procedural building from a parcel descriptor.
 *
 * @param {object} p     parcel (see parcels.js): x, z, rot, w, d, h,
 *                       floors, family, kind, band, plotW/plotFront/plotBack
 * @param {object} io    { accPart, accSlab, chunkKey }
 * @param {number} detail 2 full, 1 mass + roof + frontage, 0 mass + roof
 * @returns {number} realised height including roof
 */
export function buildParcelBuilding(p, io, detail = 2) {
  const { accPart, accSlab, chunkKey } = io;
  const f = frame(accPart, accSlab, chunkKey, p.x, p.z, p.rot);
  const seed = hash2(Math.round(p.x * 4), Math.round(p.z * 4));

  let total;
  switch (p.kind) {
    case 'terrace':   total = buildTerrace(f, p, seed, detail); break;
    case 'semi':      total = buildHouse(f, p, seed, detail, 'hipped'); break;
    case 'house':     total = buildHouse(f, p, seed, detail, 'gabled'); break;
    case 'farmhouse': total = buildHouse(f, p, seed, detail, 'gabled'); break;
    case 'shop':      total = buildShop(f, p, seed, detail); break;
    case 'mixed':     total = buildMixed(f, p, seed, detail); break;
    case 'civic':     total = buildCivic(f, p, seed, detail); break;
    case 'landmark':  total = buildLandmark(f, p, seed, detail); break;
    case 'works':     total = buildWorks(f, p, seed, detail); break;
    case 'barn':      total = buildBarn(f, p, seed, detail); break;
    case 'shed':      total = buildShed(f, p, seed, detail); break;
    default:          total = buildHouse(f, p, seed, detail, 'gabled'); break;
  }

  registerParcelCollision(p, total);
  return total;
}

// ============================================================
// PLOT SURFACE
//
// Drawn before the building so the building sits on it.  This is the
// cheapest single thing that improves the aerial read: it turns a row of
// objects into a row of properties with frontages, gaps and back gardens.
// ============================================================

function plotSurface(f, p, seed, kind) {
  const front = p.plotFront || 0;
  const back = p.plotBack || 0;
  if (front + back < 1) return;

  const w = Math.max(p.w, p.plotW || p.w);
  const frontMid = -(p.d / 2 + front / 2);
  const backMid = p.d / 2 + back / 2;

  if (kind === 'forecourt') {
    // Urban: the frontage is paved to the kerb, and the back of the plot
    // is a yard rather than a garden.
    f.pad(C.paving, w * 1.0, front, 0, frontMid, 0.006, { jitter: 0.03 });
    if (back > 1) f.pad(C.yard, w * 1.0, back, 0, backMid, 0.005, { jitter: 0.04 });
    plotBoundary(f, p, w, front, back, seed, 'wall');
    return;
  }

  if (kind === 'yard') {
    f.pad(C.yard, w * 1.35, front + p.d + back, 0, (back - front) / 2, 0.005, { jitter: 0.04 });
    return;
  }

  // Garden: a small front garden and a deep back one, in different
  // greens so the block has grain, with a path to the door.
  const lawnA = C.lawn[Math.floor(seed * C.lawn.length) % C.lawn.length];
  const lawnB = C.lawn[(Math.floor(seed * C.lawn.length) + 2) % C.lawn.length];
  if (front > 0.5) f.pad(lawnA, w, front, 0, frontMid, 0.005, { jitter: 0.05 });
  if (back > 0.5) f.pad(lawnB, w, back, 0, backMid, 0.004, { jitter: 0.05 });
  if (front > 1.0) f.pad(C.paving, 1.1, front, 0, frontMid, 0.008, { jitter: 0.02 });

  plotBoundary(f, p, w, front, back, seed, 'hedge');
}

/**
 * The boundary between one property and the next.
 *
 * This is the detail that makes a suburb read as a suburb from above: a
 * block of undivided lawn is parkland, and the same block ruled into
 * plots is somewhere people live.  Side boundaries only — the front is
 * open to the street and the back meets the neighbouring row.
 */
function plotBoundary(f, p, w, front, back, seed, style) {
  // A boundary runs BEHIND THE BUILDING LINE, and only over ground the
  // plot actually owns.
  //
  // It used to span the whole plot and was drawn without ever looking at
  // a road, so on plot after plot a pale panel ran from the back fence
  // out past the building and across the footway to the kerb.  Because
  // they carried no collision you walked straight through them: the
  // "cardboard in the road".  A sweep of the settlement found 313 of
  // them standing in a carriageway.
  //
  // Each run is now tested against the roads near the building and
  // dropped if it would stand in one, which handles the case no depth
  // limit can — a corner plot with a street along its side.
  const nose = Math.min(1.4, front * 0.4);
  const z0 = -(p.d / 2 + nose);
  const z1 = p.d / 2 + back;
  const depth = z1 - z0;
  if (depth < 3 || w < 3) return;

  const runs = Math.max(2, Math.round(depth / 6));
  const seg = depth / runs;
  const wall = style === 'wall';

  for (const sgn of [-1, 1]) {
    const lx = sgn * w / 2;
    for (let i = 0; i < runs; i++) {
      const lz = z0 + seg * (i + 0.5);
      // Test both ENDS as well as the middle: a six-metre run checked
      // only at its midpoint still puts a metre of wall in the kerb.
      // The pad clears the footway too, not just the carriageway — the
      // footway is public way and a garden wall across it is the same
      // defect, only easier to miss.
      const [wx, wz] = toWorld(p, lx, lz);
      const [ax, az] = toWorld(p, lx, lz - seg * 0.47);
      const [bx2, bz2] = toWorld(p, lx, lz + seg * 0.47);
      if (onPublicWay(wx, wz, 2.6) ||
          onPublicWay(ax, az, 2.6) ||
          onPublicWay(bx2, bz2, 2.6)) continue;            // it is public way
      if (!wall && hash2(Math.round(p.x) + i * 7, Math.round(p.z) + sgn * 3) < 0.18) continue;

      if (wall) {
        f.slab('opaque', C.trimShade, 0.3, 1.5, seg * 0.94, lx, 0.75, lz, { jitter: 0.04 });
        // A coping course: without it the wall is a flat panel, which is
        // most of why these read as cardboard rather than as masonry.
        f.slab('opaque', C.trimLight, 0.40, 0.09, seg * 0.94, lx, 1.53, lz, { jitter: 0.02 });
        registerBoundary(p, lx, lz, 0.3, seg * 0.94, 1.5);
      } else {
        f.slab('foliage', 0x5c7a4c, 0.55, 1.15 + seed * 0.5, seg * 0.90,
               lx, 0.6, lz, { jitter: 0.12 });
        registerBoundary(p, lx, lz, 0.55, seg * 0.90, 1.3);
      }
    }
  }
}

/**
 * Register a plot boundary as solid, in world space.
 *
 * A wall you can walk through is scenery, not a boundary — and it was
 * exactly the absence of collision here that let these run into the road
 * unnoticed by every audit, since nothing solid was ever reported.
 */
function registerBoundary(p, lx, lz, thick, len, h) {
  const ca = Math.cos(p.rot), sa = Math.sin(p.rot);
  const wx = p.x + lx * ca + lz * sa;
  const wz = p.z - lx * sa + lz * ca;
  const hx = (Math.abs(thick * ca) + Math.abs(len * sa)) / 2;
  const hz = (Math.abs(thick * sa) + Math.abs(len * ca)) / 2;
  const body = {
    minX: wx - hx, maxX: wx + hx, minY: 0, maxY: h,
    minZ: wz - hz, maxZ: wz + hz,
    type: 'boundary', tag: `bnd@${wx.toFixed(1)},${wz.toFixed(1)}`,
  };
  if (Array.isArray(_currentCollisions)) _currentCollisions.push(body);
  collisionRegistry.registerBody(body);
}

// ============================================================
// HOUSING
// ============================================================

/** Detached and semi-detached: the suburban and edge stock. */
function buildHouse(f, p, seed, detail, roof) {
  const wall = pick(C.wallHome, seed);
  const roofCol = pick(C.roofPitched, hash2(Math.round(p.x), Math.round(p.z) + 7));
  const h = p.floors * STOREY * 0.92;
  const roofH = Math.min(3.2, p.w * 0.30);

  plotSurface(f, p, seed, 'garden');

  f.slab('opaque', wall, p.w, h, p.d, 0, h / 2, 0, { jitter: 0.025, grade: true, gradeY: [0, h] });

  cornice(f, p.w, p.d, h, C.trimLight, 0.18);
  if (roof === 'gabled') gableRoof(f, p.w, p.d, roofH, h, roofCol);
  else hippedRoof(f, p.w, p.d, roofH * 0.85, h, roofCol);

  if (detail >= 1) {
    facade(f, p, h, wall, detail, { groundGlazing: false });
    frontDoor(f, p, seed);
  }
  if (detail >= 2) {
    // A chimney gives the roofline something to catch the low sun on,
    // and reads at walk distance without costing anything at altitude.
    f.slab('opaque', C.baseWarm, 0.7, roofH * 0.9, 0.7,
           p.w * 0.26, h + roofH * 0.75, p.d * 0.1, { jitter: 0.03 });
  }
  return h + roofH;
}

/**
 * Terraces: the core and inner-band housing.  Flat roof behind a
 * parapet, deeper plan, no gaps — which is the whole point of the form.
 */
function buildTerrace(f, p, seed, detail) {
  const wall = pick(C.wallHome, seed);
  const h = p.floors * STOREY;

  plotSurface(f, p, seed, p.band === 'core' ? 'forecourt' : 'garden');

  // A plinth course: it lifts the wall off the ground plane, which is
  // what stops a flat-roofed block reading as an extruded rectangle.
  f.slab('opaque', C.baseWarm, p.w, 0.55, p.d, 0, 0.275, 0, { jitter: 0.02 });
  f.slab('opaque', wall, p.w, h - 0.55, p.d, 0, 0.55 + (h - 0.55) / 2, 0,
         { jitter: 0.02, grade: true, gradeY: [0.55, h] });

  cornice(f, p.w, p.d, h, pick(C.roofFlat, seed));
  if (p.floors >= 4) stringCourse(f, p.w, p.d, STOREY + 0.55, C.trimShade);
  parapet(f, p.w, p.d, h, pick(C.roofFlat, seed));
  // Roof decks in the denser bands are planted as often as not.
  if (hash2(Math.round(p.x) + 3, Math.round(p.z) - 5) < 0.42) {
    f.slab('foliage', C.roofGreen, p.w * 0.78, 0.18, p.d * 0.78, 0, h + 0.14, 0, { jitter: 0.06 });
  }

  if (detail >= 1) {
    facade(f, p, h, wall, detail, { groundGlazing: false });
    frontDoor(f, p, seed);
  }
  return h + 0.6;
}

// ============================================================
// COMMERCIAL
// ============================================================

/** Shopfront: single or two storey, glazed ground floor, deep canopy. */
function buildShop(f, p, seed, detail) {
  const wall = pick(C.wallShop, seed);
  const h = Math.max(4.2, p.floors * STOREY);

  plotSurface(f, p, seed, 'forecourt');

  f.slab('opaque', C.baseStone, p.w, 0.42, p.d, 0, 0.21, 0, { jitter: 0.02 });
  f.slab('opaque', wall, p.w, h - 0.42, p.d, 0, 0.42 + (h - 0.42) / 2, 0,
         { jitter: 0.02, grade: true, gradeY: [0.42, h] });

  // Shopfront on the street elevation.
  const glzW = p.w * 0.78, glzH = Math.min(2.6, (h - 0.42) * 0.62);
  f.slab('glass', C.glassDay, glzW, glzH, 0.10, 0, 0.42 + glzH / 2 + 0.25, -(p.d / 2 + 0.05),
         { jitter: 0.06 });
  // Canopy: the strongest shorthand for "this is a shopping street".
  f.slab('opaque', C.trimLight, p.w * 1.02, 0.14, 1.5, 0, 0.42 + glzH + 0.65, -(p.d / 2 - 0.4),
         { jitter: 0.02 });

  if (p.floors > 1 && detail >= 1) {
    facade(f, p, h, wall, detail, { groundGlazing: true, fromFloor: 1 });
  }
  cornice(f, p.w, p.d, h, pick(C.roofFlat, seed));
  flatRoof(f, p.w, p.d, h, pick(C.roofFlat, seed));
  return h + 0.4;
}

/** Mixed use: shop below, flats above.  The workhorse of an inner band. */
function buildMixed(f, p, seed, detail) {
  const base = pick(C.wallShop, seed);
  const upper = pick(C.wallHome, hash2(Math.round(p.z), Math.round(p.x)));
  const h = Math.max(6.4, p.floors * STOREY);
  const groundH = 3.4;

  plotSurface(f, p, seed, 'forecourt');

  f.slab('opaque', C.baseStone, p.w, 0.45, p.d, 0, 0.225, 0, { jitter: 0.02 });
  f.slab('opaque', base, p.w, groundH - 0.45, p.d, 0, 0.45 + (groundH - 0.45) / 2, 0, { jitter: 0.02 });
  f.slab('opaque', upper, p.w, h - groundH, p.d, 0, groundH + (h - groundH) / 2, 0,
         { jitter: 0.02, grade: true, gradeY: [groundH, h] });

  const glzH = 2.1;
  f.slab('glass', C.glassDay, p.w * 0.72, glzH, 0.10, 0, 0.7 + glzH / 2, -(p.d / 2 + 0.05), { jitter: 0.06 });
  f.slab('opaque', C.trimLight, p.w * 1.02, 0.13, 1.3, 0, groundH - 0.35, -(p.d / 2 - 0.35), { jitter: 0.02 });
  // String course between the two uses — reads the building as two
  // things stacked, which is what it is.
  f.slab('opaque', C.trimShade, p.w * 1.03, 0.16, p.d * 1.02, 0, groundH, 0, { jitter: 0.02 });

  if (detail >= 1) facade(f, p, h, upper, detail, { groundGlazing: true, fromFloor: 1, floorH: (h - groundH) / Math.max(1, p.floors - 1), baseY: groundH });
  cornice(f, p.w, p.d, h, pick(C.roofFlat, seed));
  parapet(f, p.w, p.d, h, pick(C.roofFlat, seed));
  return h + 0.6;
}

// ============================================================
// CIVIC AND LANDMARK
//
// Rationed to settlement cores by the parcel layer.  Their job is to
// give each settlement a centre the eye can find from altitude, so they
// differ from their neighbours in silhouette, not just in height.
// ============================================================

function buildCivic(f, p, seed, detail) {
  const wall = pick(C.wallCivic, seed);
  const h = Math.max(6.5, p.floors * STOREY);

  // Stepped base and a forecourt: a civic building stands back from the
  // frontage line its neighbours hold.
  f.pad(C.paving, p.w * 1.35, 5.0, 0, -(p.d / 2 + 2.5), 0.007, { jitter: 0.02 });
  f.slab('opaque', C.baseStone, p.w * 1.10, 0.35, p.d * 1.10, 0, 0.175, 0, { jitter: 0.02 });
  f.slab('opaque', C.baseStone, p.w * 1.04, 0.32, p.d * 1.04, 0, 0.51, 0, { jitter: 0.02 });
  f.slab('opaque', wall, p.w, h, p.d, 0, 0.67 + h / 2, 0, { jitter: 0.02, grade: true, gradeY: [0.67, h] });

  // Colonnade across the street elevation — Veridian Cap's own
  // architectural note, carried out to the settlements that came after.
  const cols = Math.max(4, Math.round(p.w / 2.6));
  const pitch = p.w / cols;
  for (let i = 0; i < cols; i++) {
    const lx = -p.w / 2 + pitch * (i + 0.5);
    f.slab('opaque', C.trimLight, 0.42, h * 0.72, 0.42, lx, 0.67 + h * 0.36, -(p.d / 2 + 0.9), { jitter: 0.02 });
  }
  f.slab('opaque', C.trimLight, p.w * 1.06, 0.34, 2.2, 0, 0.67 + h * 0.72 + 0.17, -(p.d / 2 + 0.75), { jitter: 0.02 });

  // Clerestory lantern: the silhouette cue that finds the centre of town.
  f.slab('opaque', wall, p.w * 0.42, 1.8, p.d * 0.42, 0, 0.67 + h + 0.9, 0, { jitter: 0.02 });
  f.slab('glass', C.glassPale, p.w * 0.36, 1.1, p.d * 0.36, 0, 0.67 + h + 0.9, 0, { jitter: 0.05 });
  f.slab('opaque', C.bronze, p.w * 0.50, 0.22, p.d * 0.50, 0, 0.67 + h + 1.91, 0, { jitter: 0.02 });

  if (detail >= 1) facade(f, p, h, wall, detail, { baseY: 0.67, tall: true });
  return h + 2.8;
}

function buildLandmark(f, p, seed, detail) {
  const wall = pick(C.wallTall, seed);
  const h = Math.max(12, p.floors * STOREY);
  const setbackAt = h * 0.68;

  f.pad(C.paving, p.w * 1.3, 4.0, 0, -(p.d / 2 + 2.0), 0.007, { jitter: 0.02 });
  f.slab('opaque', C.baseStone, p.w * 1.06, 0.8, p.d * 1.06, 0, 0.4, 0, { jitter: 0.02 });
  f.slab('opaque', wall, p.w, setbackAt, p.d, 0, 0.8 + setbackAt / 2, 0,
         { jitter: 0.02, grade: true, gradeY: [0.8, h] });

  // Setback top with a planted terrace on the step — the same green
  // register as the roof decks below, at the scale of the skyline.
  f.slab('foliage', C.roofGreen, p.w * 0.98, 0.20, p.d * 0.98, 0, 0.8 + setbackAt + 0.10, 0, { jitter: 0.05 });
  const topW = p.w * 0.70, topD = p.d * 0.70, topH = h - setbackAt;
  f.slab('opaque', wall, topW, topH, topD, 0, 0.8 + setbackAt + topH / 2, 0, { jitter: 0.02 });
  f.slab('opaque', C.steel, topW * 1.08, 0.3, topD * 1.08, 0, 0.8 + h + 0.15, 0, { jitter: 0.02 });

  if (detail >= 1) {
    // Glazed bands rather than punched windows: the change of technique
    // is part of what makes a landmark read as a different class of
    // building from the terraces around it.
    const bands = Math.max(3, Math.round(setbackAt / STOREY));
    for (let i = 0; i < bands; i++) {
      const y = 0.8 + (i + 0.5) * (setbackAt / bands);
      f.slab('glass', C.glassWarm, p.w * 0.92, STOREY * 0.52, p.d * 1.01, 0, y, 0, { jitter: 0.05 });
      f.slab('glass', C.glassWarm, p.w * 1.01, STOREY * 0.52, p.d * 0.92, 0, y, 0, { jitter: 0.05 });
    }
  }
  return h + 1.2;
}

// ============================================================
// INDUSTRIAL AND AGRICULTURAL
// ============================================================

function buildWorks(f, p, seed, detail) {
  const wall = pick(C.wallInd, seed);
  const h = Math.max(6.5, p.floors * STOREY * 1.3);

  // A works has a yard, and the yard is most of what is seen from above.
  f.pad(C.yard, p.w * 1.7, p.d * 1.5, 0, 0, 0.005, { jitter: 0.03 });

  f.slab('opaque', wall, p.w, h, p.d, 0, h / 2, 0, { jitter: 0.02 });
  // Shallow pitched metal roof with a monitor along the ridge.
  gableRoof(f, p.w, p.d, Math.min(2.0, p.w * 0.12), h, pick(C.roofMetal, seed));
  f.slab('opaque', wall, p.w * 0.16, 0.9, p.d * 0.86, 0, h + 0.45, 0, { jitter: 0.02 });

  if (detail >= 1) {
    // Roller doors on the street elevation, and a high strip light.
    const doors = Math.max(1, Math.round(p.w / 7));
    const pitch = p.w / doors;
    for (let i = 0; i < doors; i++) {
      f.slab('opaque', C.doorDark, Math.min(4.0, pitch * 0.55), 3.6, 0.12,
             -p.w / 2 + pitch * (i + 0.5), 1.8, -(p.d / 2 + 0.06), { ao: 0.7 });
    }
    f.slab('glass', C.glassPale, p.w * 0.86, 0.8, 0.06, 0, h - 1.2, -(p.d / 2 + 0.05), { jitter: 0.05 });
  }
  return h + 1.6;
}

function buildBarn(f, p, seed, detail) {
  const wall = pick(C.wallBarn, seed);
  const h = Math.max(5.0, p.h);
  const roofH = Math.min(3.6, p.w * 0.38);
  f.pad(C.yard, p.w * 1.6, p.d * 1.25, 0, 0, 0.005, { jitter: 0.04 });
  f.slab('opaque', wall, p.w, h, p.d, 0, h / 2, 0, { jitter: 0.035 });
  gableRoof(f, p.w, p.d, roofH, h, pick(C.roofMetal, seed));
  if (detail >= 1) {
    f.slab('opaque', C.doorDark, p.w * 0.45, h * 0.75, 0.10, 0, h * 0.375, -(p.d / 2 + 0.05), { ao: 0.68 });
  }
  return h + roofH;
}

function buildShed(f, p, seed, detail) {
  const wall = pick(C.wallInd, seed);
  const h = Math.max(3.0, p.h);
  f.slab('opaque', wall, p.w, h, p.d, 0, h / 2, 0, { jitter: 0.03 });
  f.slab('opaque', pick(C.roofMetal, seed), p.w + 0.3, 0.18, p.d + 0.3, 0, h + 0.09, 0, { jitter: 0.02 });
  return h + 0.3;
}

// ============================================================
// ROOF FORMS
// ============================================================

/**
 * Gabled roof, ridge running along the frontage (local X) so the gable
 * ends face the neighbours.
 *
 * Built as ONE closed triangular prism rather than as two tilted slabs
 * plus separately-placed end triangles.  The earlier version rotated a
 * 3-sided cone through two axes to make each end wall, which produced
 * fins standing off the side of every pitched roof in the world — the
 * dark spikes visible beside the houses in the first survey.  A prism
 * has the end walls built in and cannot come apart.
 */
function gableRoof(f, w, d, h, y, col) {
  const over = 0.35;
  const W = w / 2 + over;       // half-length along the ridge
  const D = d / 2 + over;       // half-span across the slope
  const g = prismGeometry(W, D, h);
  g.translate(0, y, 0);
  f.part(g, 'opaque', col, { jitter: 0.03 });
}

/**
 * A triangular prism: cross-section (-D,0) (D,0) (0,h) in the ZY plane,
 * extruded from x=-W to x=+W.  Non-indexed, so it drops straight into
 * the chunk accumulator alongside everything else.
 */
function prismGeometry(W, D, h) {
  const A = [-W, 0, -D], B = [-W, 0, D], C = [-W, h, 0];   // -X end
  const A2 = [W, 0, -D], B2 = [W, 0, D], C2 = [W, h, 0];   // +X end

  const tri = (p, q, r) => [...p, ...q, ...r];
  const quad = (p, q, r, t) => [...tri(p, q, r), ...tri(p, r, t)];

  const pos = [
    ...tri(A, C, B),            // -X gable end
    ...tri(A2, B2, C2),         // +X gable end
    ...quad(A, A2, C2, C),      // slope toward -Z
    ...quad(B, C, C2, B2),      // slope toward +Z
    ...quad(A, B, B2, A2),      // soffit
  ];

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.computeVertexNormals();
  return geo;
}

/**
 * Hipped roof: a four-sided pyramid.
 *
 * A 4-segment cone turned 45 degrees has its square base on the
 * diagonals, so the circumradius has to be scaled by root two for the
 * base to reach the walls.  Without that the roof sat inside the
 * building's footprint and left the wall head exposed.
 */
function hippedRoof(f, w, d, h, y, col) {
  const over = 0.35;
  const W = w / 2 + over, D = d / 2 + over;
  const pyr = new THREE.CylinderGeometry(0, W * Math.SQRT2, h, 4);
  pyr.rotateY(Math.PI / 4);
  pyr.scale(1, 1, D / W);
  pyr.translate(0, y + h / 2, 0);
  f.part(pyr, 'opaque', col, { jitter: 0.03 });
}

/**
 * Cornice.
 *
 * The one move that separates a designed building from an extruded box.
 * Every wall in the procedural stock ran straight into its roof, so from
 * the footway the suburbs read as slabs with rectangles punched in them
 * while the authored town — which has cornices, string courses and
 * eaves — read as architecture.  Two thin oversized bands cost almost
 * nothing and give the top of every wall a shadow line.
 */
function cornice(f, w, d, y, col, depth = 0.26) {
  f.slab('opaque', col, w + depth * 2, 0.16, d + depth * 2, 0, y - 0.08, 0, { jitter: 0.02 });
  f.slab('opaque', col, w + depth, 0.12, d + depth, 0, y - 0.24, 0, { jitter: 0.02, ao: 0.88 });
}

/**
 * String course: a band marking a floor line partway up a taller wall.
 * Without one a six-storey elevation has no horizontal rhythm at all.
 */
function stringCourse(f, w, d, y, col) {
  f.slab('opaque', col, w + 0.14, 0.10, d + 0.14, 0, y, 0, { jitter: 0.02, ao: 0.92 });
}

function flatRoof(f, w, d, y, col) {
  f.slab('opaque', col, w + 0.3, 0.2, d + 0.3, 0, y + 0.1, 0, { jitter: 0.025 });
}

function parapet(f, w, d, y, col) {
  const t = 0.42;
  f.slab('opaque', col, w, 0.16, d, 0, y + 0.08, 0, { jitter: 0.02 });   // deck
  f.slab('opaque', col, w, t, 0.26, 0, y + t / 2, d / 2 - 0.13, { jitter: 0.02 });
  f.slab('opaque', col, w, t, 0.26, 0, y + t / 2, -(d / 2 - 0.13), { jitter: 0.02 });
  f.slab('opaque', col, 0.26, t, d, w / 2 - 0.13, y + t / 2, 0, { jitter: 0.02 });
  f.slab('opaque', col, 0.26, t, d, -(w / 2 - 0.13), y + t / 2, 0, { jitter: 0.02 });
  f.slab('opaque', C.trimLight, w + 0.18, 0.09, d + 0.18, 0, y + t + 0.045, 0, { jitter: 0.02 });
}

// ============================================================
// FACADES
//
// Windows are emitted per storey as a band of panes with one sill
// course, rather than as an individually recessed opening each.  At the
// distances these buildings are actually seen from, the band is what
// reads, and it costs a fraction of the geometry — which is what lets
// the storey count follow density instead of being capped by budget.
// ============================================================

function facade(f, p, h, wallCol, detail, opt = {}) {
  const { groundGlazing = false, fromFloor = 0, baseY = 0.5, tall = false } = opt;
  const floors = Math.max(1, p.floors);
  const floorH = opt.floorH || (h - baseY) / floors;
  const winCol = hash2(Math.round(p.x) + 11, Math.round(p.z) + 2) < 0.5 ? C.glassDay : C.glassPale;

  // Street and rear elevations get full treatment; the flanks get panes
  // only when the building is seen close up.
  const sides = [
    { run: p.w, off: -(p.d / 2 + 0.05), axis: 'x', pitch: 3.4, always: true },
    { run: p.w, off: p.d / 2 + 0.05, axis: 'x', pitch: 4.2, always: true },
    { run: p.d, off: -(p.w / 2 + 0.05), axis: 'z', pitch: 4.6, always: false },
    { run: p.d, off: p.w / 2 + 0.05, axis: 'z', pitch: 4.6, always: false },
  ];

  for (let fl = fromFloor; fl < floors; fl++) {
    const y0 = baseY + (fl - (opt.floorH ? fromFloor : 0)) * floorH;
    const winH = Math.min(floorH * 0.46, tall ? 2.4 : 1.7);
    const y = y0 + floorH * 0.52;
    if (y + winH / 2 > h) break;

    for (const s of sides) {
      if (!s.always && detail < 2) continue;
      const n = Math.max(1, Math.floor(s.run / s.pitch));
      const pitch = s.run / n;
      const paneW = pitch * (s.always ? 0.54 : 0.46);

      for (let i = 0; i < n; i++) {
        const o = -s.run / 2 + pitch * (i + 0.5);
        // Reveal first, glass proud of it.  A pane laid flat on the wall
        // reads as a sticker; set behind a darker frame it reads as a
        // hole in a wall with thickness, which is what a window is.
        const inset = s.off > 0 ? -0.10 : 0.10;
        if (s.axis === 'x') {
          f.slab('opaque', C.reveal, paneW + 0.22, winH + 0.22, 0.06, o, y, s.off + inset, { ao: 0.62 });
          f.slab('glass', winCol, paneW, winH, 0.05, o, y, s.off, { jitter: 0.07 });
        } else {
          f.slab('opaque', C.reveal, 0.06, winH + 0.22, paneW + 0.22, s.off + inset, y, o, { ao: 0.62 });
          f.slab('glass', winCol, 0.05, winH, paneW, s.off, y, o, { jitter: 0.07 });
        }
      }

      // One sill course per storey per elevation: a single box that ties
      // the openings into a line, which is the horizontal rhythm the
      // authored town gets from its floor slabs.
      if (s.always) {
        f.slab('opaque', C.trimLight, s.run * 0.98, 0.10, 0.16, 0, y - winH / 2 - 0.05, s.off,
               { jitter: 0.02 });
      }
    }
  }
}

function frontDoor(f, p, seed) {
  const doorW = 1.05, doorH = 2.15;
  const lx = (seed - 0.5) * Math.max(0, p.w - doorW - 1.6);
  f.slab('opaque', C.door, doorW, doorH, 0.10, lx, doorH / 2, -(p.d / 2 + 0.05), { ao: 0.72 });
  f.slab('opaque', C.trimLight, doorW + 0.24, 0.10, 0.16, lx, doorH + 0.05, -(p.d / 2 + 0.05));
}

// ============================================================
// LOD 1
//
// Mass and roof only, but the roof is still coloured by kind — from the
// distance LOD 1 is seen at, roof colour is the whole signal, so a
// uniformly grey LOD band is what made the middle distance read as
// rubble in the "before" survey.
// ============================================================

export function buildLOD1Volume(p, accSlab, accPart, chunkKey) {
  const f = frame(accPart, accSlab, chunkKey, p.x, p.z, p.rot);
  const seed = hash2(Math.round(p.x * 4), Math.round(p.z * 4));
  const pitched = p.kind === 'house' || p.kind === 'semi' || p.kind === 'farmhouse' ||
                  p.kind === 'barn' || p.kind === 'works';
  const wall = p.family === 'residential' ? pick(C.wallHome, seed)
             : p.family === 'commercial' ? pick(C.wallShop, seed)
             : p.family === 'civic' ? pick(C.wallCivic, seed)
             : pick(C.wallInd, seed);
  const h = Math.max(3, p.h);

  f.slab('opaque', wall, p.w, h, p.d, 0, h / 2, 0, { jitter: 0.03, grade: true, gradeY: [0, h] });
  if (pitched) {
    gableRoof(f, p.w, p.d, Math.min(2.6, p.w * 0.28), h,
              pick(p.family === 'industrial' ? C.roofMetal : C.roofPitched, seed));
  } else {
    f.slab('opaque', pick(C.roofFlat, seed), p.w + 0.2, 0.3, p.d + 0.2, 0, h + 0.15, 0, { jitter: 0.02 });
  }
  return h;
}

// ============================================================
// COLLISION
// ============================================================

// Per-chunk collision tracking: the chunk manager sets this before
// building a chunk, then reads it afterward to unregister on unload.
let _currentCollisions = null;

export function setCollisionTracker(arr) { _currentCollisions = arr; }

// Roads near the building currently being built.  Plot boundaries are
// checked against these: a garden wall is private, a road is public, and
// nothing private may be built across a public way.  Clamping the plot's
// DEPTH is not sufficient on its own — a plot on a corner has a road
// running alongside it, which no depth limit can see.
let _nearSegs = null;
export function setNearSegments(segs) { _nearSegs = segs; }

/** True if a point lies in or beside a road. */
function onPublicWay(x, z, pad = 1.2) {
  if (!_nearSegs) return false;
  for (let i = 0; i < _nearSegs.length; i++) {
    const g = _nearSegs[i];
    const dx = g.x2 - g.x1, dz = g.z2 - g.z1;
    const l2 = dx * dx + dz * dz;
    let u = l2 ? ((x - g.x1) * dx + (z - g.z1) * dz) / l2 : 0;
    u = u < 0 ? 0 : u > 1 ? 1 : u;
    const px = x - (g.x1 + u * dx), pz = z - (g.z1 + u * dz);
    const reach = g.width / 2 + pad;
    if (px * px + pz * pz < reach * reach) return true;
  }
  return false;
}

/** Local plot coordinates to world, for the road test. */
function toWorld(p, lx, lz) {
  const ca = Math.cos(p.rot), sa = Math.sin(p.rot);
  return [p.x + lx * ca + lz * sa, p.z - lx * sa + lz * ca];
}

/**
 * Register a parcel's collision body.
 *
 * The registry is axis-aligned, so a building turned to face its street
 * gets the bounding box of its rotated footprint.  parcels.js sets each
 * plot back by exactly this extent, so the box never reaches the road.
 */
function registerParcelCollision(p, height) {
  const ca = Math.abs(Math.cos(p.rot)), sa = Math.abs(Math.sin(p.rot));
  const hx = (p.w * ca + p.d * sa) / 2;
  const hz = (p.w * sa + p.d * ca) / 2;
  const body = {
    minX: p.x - hx, maxX: p.x + hx,
    minY: 0, maxY: height,
    minZ: p.z - hz, maxZ: p.z + hz,
    type: 'proc-building',
    tag: `pb@${p.x.toFixed(1)},${p.z.toFixed(1)}`,
  };
  if (Array.isArray(_currentCollisions)) _currentCollisions.push(body);
  collisionRegistry.registerBody(body);
}

// ---- helpers ---------------------------------------------------------

function pick(arr, t) { return arr[Math.floor(t * arr.length) % arr.length]; }
