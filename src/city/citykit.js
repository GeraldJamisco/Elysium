import * as THREE from 'three';
import { TOWN, STAGES } from '../config.js';
import { blockData, surface } from './layout.js';
import { collisionRegistry } from './collision.js';
import { slab, part } from './architecture.js';
import { groundReserved } from './district.js';
import { segmentsNear, onRoad, ensureSettlementRoads } from '../procedural/roads.js';
import { settlementById } from '../procedural/settlement.js';

// ============================================================
// VERIDIAN CAP — STREET KIT, PLANTING AND THE CENTRAL GREEN
// Phase 5D
//
// PLANTING IS COMPOSITION, NOT DECORATION.
// Every plant in the settlement belongs to one of four roles,
// and the role decides the species, so vegetation reinforces the
// spatial hierarchy instead of blurring it:
//
//   street      evenly spaced broadleaf in a paved tree pit —
//               reads the street as a street
//   avenue      a formal double row of columnar trees — marks
//               the road out of town as the major route
//   park        grouped parasol trees and a defined planted
//               edge — reads the green as a designed place
//   courtyard   informal broadleaf groups inside the blocks —
//               reads block interiors as private and soft
//
// PERFORMANCE
// Nothing here allocates a mesh or a light.  Street furniture
// and planting are pushed into the same shared accumulator as
// the architecture (see architecture.js) and merged with it.
// The previous kit created roughly a hundred PointLights, one
// per lamp; a forward renderer evaluates every one of them on
// every lit fragment, which was the single largest cost in the
// scene.  Lamp heads are emissive geometry instead.
// ============================================================

// ---- Palette ----
const P = {
  bark:      ['#6b5744', '#7a6450', '#5f4d3c', '#74604b'],
  leafMid:   ['#76a854', '#82b25e', '#6d9e4e', '#8cb968', '#699748'],
  leafDark:  ['#54803d', '#5c8943', '#4d7738'],
  leafPale:  ['#9dc570', '#a8cd7c', '#93bd68'],
  shrub:     ['#5f8f48', '#6c9a52', '#578843'],
  lampPost:  '#7d837f',
  lampHead:  '#b9bfba',
  lampLens:  '#d8d3c4',
  stone:     '#b3ac9c',
  stoneDeep: '#918a7b',
  bench:     '#8b6f4c',
  benchLeg:  '#7e8480',
  bronze:    '#96794f',
  water:     '#4e8f96',
};

// Deterministic stream — the settlement must look the same every reload.
let _s = 0;
function rr() {
  _s = (_s + 0x6D2B79F5) | 0;
  let t = Math.imul(_s ^ (_s >>> 15), 1 | _s);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
const pick = a => a[Math.floor(rr() * a.length)];

// Keep planting off the spawn point: a trunk two metres in front of the
// player's eyes on arrival is the first thing they see of the settlement.
const SPAWN = new THREE.Vector2(STAGES.walk.spawnPos[0], STAGES.walk.spawnPos[2]);
const SPAWN_CLEAR = 4.0;

function spawnBlocked(x, z) {
  return Math.hypot(x - SPAWN.x, z - SPAWN.y) < SPAWN_CLEAR;
}

/**
  * True if this ground is unavailable for planting.
  *
  * Two reasons it can be: something solid already stands there, or the
  * district model has reserved it as a path, a gate or a crossing.  The
  * second is not a collision body and must not become one — reserved
  * ground is ground a person is meant to walk on, and the whole point is
  * that a tree does not end up standing in the only way into a block.
  */
function occupied(x, z, r) {
  if (groundReserved(x, z, r)) return true;
  return collisionRegistry.query(x, z, r).length > 0;
}

export function buildStreetKit() {
  _s = 0x1C17E;
  const { blocksX, blocksZ, blockW, blockD, roadW, sidewalkW } = TOWN;
  const edgeW = roadW + sidewalkW * 2;
  const totalX = blocksX * blockW + (blocksX - 1) * edgeW;
  const totalZ = blocksZ * blockD + (blocksZ - 1) * edgeW;

  // ---- Street lighting and street trees, alternating along every footway ----
  for (let x = 0; x < blocksX - 1; x++) {
    const rdX = -totalX / 2 + (x + 1) * blockW + x * edgeW + roadW / 2 + sidewalkW;
    for (let z = 0; z < blocksZ; z++) {
      const blk = blockData[z * blocksX + x];
      furnishFootway(rdX - roadW / 2 - sidewalkW / 2, blk.minZ, blk.maxZ, 'ns', 1);
      furnishFootway(rdX + roadW / 2 + sidewalkW / 2, blk.minZ, blk.maxZ, 'ns', -1);
    }
  }
  for (let z = 0; z < blocksZ - 1; z++) {
    const rdZ = -totalZ / 2 + (z + 1) * blockD + z * edgeW + roadW / 2 + sidewalkW;
    for (let x = 0; x < blocksX; x++) {
      const blk = blockData[z * blocksX + x];
      furnishFootway(rdZ - roadW / 2 - sidewalkW / 2, blk.minX, blk.maxX, 'ew', 1);
      furnishFootway(rdZ + roadW / 2 + sidewalkW / 2, blk.minX, blk.maxX, 'ew', -1);
    }
  }

  // ---- The avenue: a formal columnar double row ----
  const rightEdge = totalX / 2;
  // The row is formal, so it is laid at one fixed offset for the whole
  // avenue — and for that reason it knew nothing about the procedural
  // roads that cross it.  Four of its trees stood in a carriageway: two
  // in the town's east-edge collector at x ~ 84, two in the circulating
  // carriageway of the gateway roundabout at (276, 0), which was carved
  // through the row long after it was planted.  A formal avenue may skip
  // a position; it may not put a tree in a road.
  // generateHighways() lays the regional network and trims the gateway
  // roundabout, but a settlement's OWN roads — including the east-edge
  // collector the first two trees stood in — are built lazily, per
  // chunk.  Without this the guard sees half a network and catches half
  // the defect.  The call is idempotent and builds graph only.
  const vc = settlementById('veridian-cap');
  if (vc) ensureSettlementRoads(vc);
  const avenueSegs = segmentsNear(rightEdge + TOWN.avenueLen / 2, 0,
                                  TOWN.avenueLen + 60);
  for (let dd = 10; dd < TOWN.avenueLen - 6; dd += 12) {
    const x = rightEdge + dd;
    for (const s of [-1, 1]) {
      const z = s * (roadW / 2 + sidewalkW + 2.6);
      if (onRoad(x, z, avenueSegs, 2.0)) continue;
      plant('column', x, z, 1.0 + rr() * 0.18);
      if (dd % 24 < 1) lamp(x, s * (roadW / 2 + sidewalkW / 2), s > 0 ? -1 : 1);
    }
  }

  // ---- Block interiors ----
  blockData.forEach(blk => {
    if (blk.park) return;
    courtyard(blk);
  });

  // ---- The central green ----
  const parkBlk = blockData.find(b => b.park);
  if (parkBlk) buildPark(parkBlk);
}

// ============================================================
// FOOTWAY FURNITURE
// ============================================================

/**
 * Lay out one footway run: lamps every 14 m, street trees on the
 * half-interval between them.  `inward` is the sign that points from the
 * footway toward the block, used to face benches and lean lamp heads
 * out over the carriageway.
 */
function furnishFootway(fixed, from, to, dir, inward) {
  const len = to - from;
  if (len < 10) return;
  const n = Math.max(1, Math.round(len / 14));
  const step = len / n;

  // Furniture stands on the kerb side of the footway, not down the middle
  // of it.  A 1.5 m tree pit centred on a 2.5 m footway leaves 0.5 m of
  // paving either side — walkable only because a person is 0.8 m wide,
  // and it meant every tree on every street forced a diversion.  Shifting
  // the line 0.55 m toward the carriageway puts the pit where a tree pit
  // belongs and leaves a continuous walking line against the buildings.
  // buildStreetKit passes inward = +1 for the footway on the LOW side of
  // the carriageway and -1 for the high side, so +inward always points
  // across the road.
  const VERGE = 0.55;
  fixed += inward * VERGE;

  // A street tree is 1.5 m of pit and a solid trunk, and a lamp is a
  // post: standing either on a doorway approach, a crossing or the one
  // close into a block is how a route that reads as connected turns out
  // to be obstructed.  But DROPPING the tree costs the street a tree to
  // save a door, and there are many more trees than doors — so when the
  // nominal position is on reserved ground the piece slides along the
  // footway to the nearest spot that is clear, and is only given up if
  // the whole neighbourhood of the position is spoken for.
  const OFFSETS = [0, 2.2, -2.2, 4.0, -4.0, 5.6, -5.6];

  const placeAlong = (at, probe, put) => {
    for (const o of OFFSETS) {
      const a = at + o;
      if (a < from - 1 || a > to + 1) continue;
      const [x, z] = dir === 'ns' ? [fixed, a] : [a, fixed];
      if (spawnBlocked(x, z) || occupied(x, z, probe)) continue;
      put(x, z);
      return true;
    }
    return false;
  };

  for (let i = 0; i <= n; i++) {
    placeAlong(from + i * step, 0.9,
      (x, z) => lamp(x, z, dir === 'ns' ? -inward : 0, dir === 'ew' ? -inward : 0));
  }
  for (let i = 0; i < n; i++) {
    placeAlong(from + (i + 0.5) * step, 1.3, (x, z) => {
      treePit(x, z);
      plant('broad', x, z, 0.92 + rr() * 0.22);
    });
  }
}

/** A paved pit with a kerb ring: the detail that roots a street tree. */
function treePit(x, z) {
  surface('parkPath', 1.5, 1.5, x, 0.362, z);
  slab('opaque', P.stoneDeep, 1.66, 0.06, 0.14, x, 0.383, z - 0.76);
  slab('opaque', P.stoneDeep, 1.66, 0.06, 0.14, x, 0.383, z + 0.76);
  slab('opaque', P.stoneDeep, 0.14, 0.06, 1.66, x - 0.76, 0.383, z);
  slab('opaque', P.stoneDeep, 0.14, 0.06, 1.66, x + 0.76, 0.383, z);
}

/**
 * Street lamp.  Tapered post, a short arm leaning out over the road, a
 * shrouded head and a warm lens.  The lens is emissive geometry, not a
 * light source — see the note at the top of this file.
 */
function lamp(x, z, ax = 0, az = 0) {
  const H = 4.3;
  const base = 0.35;
  slab('opaque', P.stoneDeep, 0.40, 0.12, 0.40, x, base + 0.06, z);
  cyl('metal', P.lampPost, 0.075, 0.105, H, x, base + H / 2, z);
  // Arm out over the carriageway
  const armLen = 0.9;
  const hx = x + ax * armLen, hz = z + az * armLen;
  slab('metal', P.lampPost, ax ? armLen : 0.07, 0.07, az ? armLen : 0.07,
       (x + hx) / 2, base + H - 0.06, (z + hz) / 2);
  // Shrouded head: the shroud is what stops it reading as a floating dot.
  slab('metal', P.lampHead, 0.46, 0.10, 0.30, hx, base + H - 0.14, hz);
  // The lens is frosted GLASS, not an emitter. Veridian Cap is lit at four in
  // the afternoon; a lamp glowing in full sun is the detail that tells a
  // player the world is decorated rather than observed.
  slab('glass', P.lampLens, 0.38, 0.05, 0.24, hx, base + H - 0.21, hz, { jitter: 0.05 });

  collisionRegistry.registerBody({
    minX: x - 0.15, maxX: x + 0.15,
    minY: 0, maxY: H,
    minZ: z - 0.15, maxZ: z + 0.15,
    type: 'lamp',
    tag: `lamp@${x.toFixed(1)},${z.toFixed(1)}`,
  });
}

/** A bench, facing along `dir` with its back toward `backSign`. */
function bench(x, z, dir, backSign) {
  const L = 1.9, seatY = 0.80;
  const along = dir === 'ns' ? [0, 1] : [1, 0];
  const w = along[0] ? L : 0.52;
  const d = along[1] ? L : 0.52;
  slab('opaque', P.bench, w, 0.09, d, x, seatY, z, { jitter: 0.04 });
  const bx = along[0] ? 0 : backSign * 0.22;
  const bz = along[1] ? 0 : backSign * 0.22;
  slab('opaque', P.bench, along[0] ? L : 0.08, 0.42, along[1] ? L : 0.08,
       x + bx, seatY + 0.30, z + bz, { jitter: 0.04 });
  for (const s of [-1, 1]) {
    slab('metal', P.benchLeg, 0.07, seatY, 0.40,
         x + (along[0] ? s * (L / 2 - 0.18) : 0),
         seatY / 2,
         z + (along[1] ? s * (L / 2 - 0.18) : 0));
  }
  collisionRegistry.registerBody({
    minX: x - w / 2, maxX: x + w / 2,
    minY: 0, maxY: seatY + 0.5,
    minZ: z - d / 2, maxZ: z + d / 2,
    type: 'bench',
    tag: `bench@${x.toFixed(1)},${z.toFixed(1)}`,
  });
}

// ============================================================
// PLANTING
//
// Four silhouettes, built from faceted lobes rather than smooth
// spheres.  Each lobe carries its own tone and a vertical shading
// gradient, so a canopy has a lit top and a shaded underside — the
// thing a single flat-coloured sphere can never do.
// ============================================================

function cyl(bucket, color, rTop, rBot, h, x, y, z, opt) {
  const g = new THREE.CylinderGeometry(rTop, rBot, h, 7, 1);
  part(g, bucket, color, { ...opt, at: [x, y, z] });
}

/** One canopy lobe: a faceted blob, squashed and offset. */
function lobe(x, y, z, rx, ry, rz, color, detail, shadeSpan) {
  const g = new THREE.IcosahedronGeometry(1, detail);
  g.scale(rx, ry, rz);
  g.translate(x, y, z);
  part(g, 'foliage', color, { jitter: 0.07, gradeY: shadeSpan });
}

export function plant(species, x, z, scale = 1, seedShift = 0) {
  if (seedShift) _s = (_s + seedShift) | 0;
  const bark = pick(P.bark);

  if (species === 'shrub') {
    const h = (0.85 + rr() * 0.6) * scale;
    const r = (0.62 + rr() * 0.3) * scale;
    for (let i = 0; i < 3; i++) {
      const a = rr() * Math.PI * 2;
      lobe(x + Math.cos(a) * r * 0.4, h * 0.52 + rr() * 0.12 * h, z + Math.sin(a) * r * 0.4,
           r, h * 0.55, r * 0.92, pick(P.shrub), 1, [0, h * 1.4]);
    }
    return;   // low planting is walk-through by design
  }

  if (species === 'column') {
    // Narrow upright: used only where the plan wants a vertical accent.
    const h = (7.2 + rr() * 2.0) * scale;
    const r = (0.95 + rr() * 0.22) * scale;
    cyl('opaque', bark, 0.07 * scale, 0.12 * scale, h * 0.30, x, h * 0.15, z, { jitter: 0.05 });
    const dark = pick(P.leafDark), mid = pick(P.leafMid);
    for (let i = 0; i < 5; i++) {
      const t = i / 4;
      lobe(x + (rr() - 0.5) * 0.2, h * (0.24 + t * 0.66), z + (rr() - 0.5) * 0.2,
           r * (1 - t * 0.45), h * 0.18, r * (1 - t * 0.45),
           i % 2 ? dark : mid, 1, [h * 0.1, h]);
    }
    trunkCollision(x, z, 0.26, h * 0.30);
    return;
  }

  if (species === 'parasol') {
    // High clear trunk, wide flat canopy — you can stand and see beneath it.
    const h = (5.2 + rr() * 1.3) * scale;
    const r = (2.9 + rr() * 0.8) * scale;
    cyl('opaque', bark, 0.10 * scale, 0.18 * scale, h * 0.70, x, h * 0.35, z, { jitter: 0.05 });
    const mid = pick(P.leafMid);
    lobe(x, h * 0.94, z, r, r * 0.32, r * 0.92, mid, 1, [h * 0.5, h * 1.25]);
    lobe(x + r * 0.32, h * 1.02, z - r * 0.26, r * 0.6, r * 0.26, r * 0.56,
         pick(P.leafPale), 1, [h * 0.5, h * 1.3]);
    lobe(x - r * 0.36, h * 0.90, z + r * 0.30, r * 0.56, r * 0.24, r * 0.52,
         pick(P.leafDark), 1, [h * 0.5, h * 1.25]);
    trunkCollision(x, z, 0.30, h * 0.70);
    return;
  }

  // 'broad' — the settlement's default street and courtyard tree.
  // The crown starts at roughly 40% of the height: high enough to walk and
  // see under, low enough that the trunk never reads as a bare pole.
  const h = (5.4 + rr() * 1.7) * scale;
  const r = (2.0 + rr() * 0.5) * scale;
  cyl('opaque', bark, 0.085 * scale, 0.155 * scale, h * 0.52, x, h * 0.26, z, { jitter: 0.05 });
  const crownY = h * 0.72;
  const span = [h * 0.30, h * 1.06];
  lobe(x, crownY, z, r, r * 0.82, r * 0.95, pick(P.leafMid), 1, span);
  lobe(x + r * 0.44, crownY + r * 0.30, z - r * 0.30, r * 0.66, r * 0.56, r * 0.64,
       pick(P.leafPale), 1, span);
  lobe(x - r * 0.42, crownY + r * 0.10, z + r * 0.38, r * 0.70, r * 0.54, r * 0.68,
       pick(P.leafDark), 1, span);
  lobe(x + r * 0.16, crownY - r * 0.34, z + r * 0.18, r * 0.74, r * 0.44, r * 0.72,
       pick(P.leafMid), 1, span);
  trunkCollision(x, z, 0.3, h * 0.52);
}

function trunkCollision(x, z, r, h) {
  collisionRegistry.registerBody({
    minX: x - r, maxX: x + r,
    minY: 0, maxY: h,
    minZ: z - r, maxZ: z + r,
    type: 'tree',
    tag: `tree@${x.toFixed(1)},${z.toFixed(1)}`,
  });
}

/** A continuous clipped hedge run — used to define edges, never scattered. */
function hedgeRun(x1, z1, x2, z2, hgt = 0.7) {
  const len = Math.hypot(x2 - x1, z2 - z1);
  if (len < 0.3) return;
  const ang = Math.atan2(z2 - z1, x2 - x1);
  // A clipped hedge is a solid prism first; the lobes only soften its top.
  // Built from spheres alone it reads as a row of boulders.
  const g = new THREE.BoxGeometry(len, hgt * 0.86, 0.92);
  g.rotateY(-ang);
  g.translate((x1 + x2) / 2, hgt * 0.43, (z1 + z2) / 2);
  part(g, 'foliage', pick(P.shrub), { jitter: 0.03, gradeY: [0, hgt * 1.5] });

  const n = Math.max(2, Math.round(len / 0.7));
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const x = x1 + (x2 - x1) * t;
    const z = z1 + (z2 - z1) * t;
    const h = hgt * (0.96 + rr() * 0.12);
    lobe(x, h * 0.80, z, 0.48, h * 0.30, 0.48, pick(P.shrub), 1, [0, h * 1.5]);
  }
}

// ============================================================
// BLOCK COURTYARDS
// ============================================================

function courtyard(blk) {
  // Informal groups, not scatter: one dominant tree with companions.
  for (let g = 0; g < 2; g++) {
    let gx = 0, gz = 0, ok = false;
    for (let tries = 0; tries < 24 && !ok; tries++) {
      gx = blk.cx + (rr() - 0.5) * blk.w * 0.42;
      gz = blk.cz + (rr() - 0.5) * blk.d * 0.42;
      ok = !occupied(gx, gz, 3.0);
    }
    if (!ok) continue;
    plant('broad', gx, gz, 0.85 + rr() * 0.3);
    const n = 1 + Math.floor(rr() * 2);
    for (let i = 0; i < n; i++) {
      const a = rr() * Math.PI * 2, d = 3.0 + rr() * 2.2;
      const px = gx + Math.cos(a) * d, pz = gz + Math.sin(a) * d;
      if (occupied(px, pz, 1.6)) continue;
      plant(rr() > 0.45 ? 'broad' : 'shrub', px, pz, 0.6 + rr() * 0.35);
    }
    for (let i = 0; i < 4; i++) {
      const a = rr() * Math.PI * 2, d = 1.6 + rr() * 3.4;
      const px = gx + Math.cos(a) * d, pz = gz + Math.sin(a) * d;
      if (!occupied(px, pz, 1.0)) plant('shrub', px, pz, 0.7 + rr() * 0.5);
    }
  }
}

// ============================================================
// THE CENTRAL GREEN
//
// Geometry is unchanged from Phase 3C — the block, the four axial
// approaches and the basin at the crossing of them all sit exactly
// where they did.  What is added is design: a paved civic plaza at
// the centre, a ring walk tying the four approaches together, a
// defined planted edge, grouped shade trees and an open lawn kept
// clear so the focal feature is visible from every approach.
// ============================================================

function buildPark(blk) {
  const bx = blk.park.x, bz = blk.park.z;
  const HALF_W = blk.w / 2, HALF_D = blk.d / 2;
  const PLAZA_R = 6.2;
  const RING_R = 9.6;

  // ---- Axial approaches (Phase 3C positions preserved) ----
  const approaches = [
    { dir: 'z', from: blk.minZ, to: bz - PLAZA_R },
    { dir: 'z', from: blk.maxZ, to: bz + PLAZA_R },
    { dir: 'x', from: blk.minX, to: bx - PLAZA_R },
    { dir: 'x', from: blk.maxX, to: bx + PLAZA_R },
  ];
  approaches.forEach(p => {
    const len = Math.abs(p.to - p.from);
    const mid = (p.to + p.from) / 2;
    if (p.dir === 'z') surface('parkPath', 2.6, len, bx, 0.028, mid);
    else               surface('parkPath', len, 2.6, mid, 0.028, bz);
  });

  // ---- Ring walk ----
  const seg = 28;
  for (let i = 0; i < seg; i++) {
    const a = (i + 0.5) / seg * Math.PI * 2;
    const px = bx + Math.cos(a) * RING_R;
    const pz = bz + Math.sin(a) * RING_R;
    const g = new THREE.PlaneGeometry(2.2, (2 * Math.PI * RING_R) / seg + 0.5);
    g.rotateX(-Math.PI / 2);
    g.rotateY(-a);
    g.translate(px, 0.03, pz);
    part(g, 'opaque', '#b7a98c', { jitter: 0.03 });
  }

  // ---- Civic plaza ----
  const plaza = new THREE.CircleGeometry(PLAZA_R, 40);
  plaza.rotateX(-Math.PI / 2);
  plaza.translate(bx, 0.034, bz);
  part(plaza, 'opaque', '#c2b498', { jitter: 0.02 });
  ringBand(bx, bz, PLAZA_R, 0.26, 0.05, 0.05, P.stoneDeep);

  // ---- Focal feature: the settlement marker over a reflecting pool ----
  // The basin footprint and its single collision body are unchanged from
  // Phase 3C.  What changed is presence: three stone steps, a bronze-rimmed
  // pool wide enough to read as water from the ring walk, and a tapered
  // finned pylon tall enough to be seen from all four approach streets.
  // One object carries the settlement's identity, rather than glow props
  // scattered across the green.
  for (let i = 0; i < 3; i++) {
    const r = 2.55 - i * 0.34;
    cylY('opaque', i === 0 ? P.stone : P.stoneDeep, r, r + 0.05, 0.16, bx, 0.08 + i * 0.16, bz, 28);
  }
  // Pool: a shallow dish, its floor a shade darker so the water reads wet.
  cylY('opaque', '#5d6a63', 1.62, 1.62, 0.06, bx, 0.52, bz, 28);
  const water = new THREE.CircleGeometry(1.60, 36);
  water.rotateX(-Math.PI / 2);
  water.translate(bx, 0.575, bz);
  part(water, 'glass', P.water, { jitter: 0.015 });
  ringBand(bx, bz, 1.72, 0.26, 0.16, 0.46, P.bronze, 'metal');

  // The pylon: a tapered shaft with three fins, standing out of the pool.
  cylY('opaque', P.stone, 0.46, 0.62, 0.55, bx, 0.82, bz, 12);
  cylY('opaque', '#d5d2c6', 0.17, 0.42, 6.2, bx, 4.2, bz, 10);
  for (let i = 0; i < 3; i++) {
    const a = (i / 3) * Math.PI * 2;
    const fin = new THREE.BoxGeometry(0.9, 4.4, 0.09);
    fin.translate(0.42, 0, 0);
    fin.rotateY(-a);
    fin.translate(bx, 3.5, bz);
    part(fin, 'opaque', '#b9beb6', { jitter: 0.03, gradeY: [1.2, 6.0] });
  }
  cylY('metal', P.bronze, 0.52, 0.30, 0.42, bx, 7.45, bz, 10);
  const beacon = new THREE.IcosahedronGeometry(0.50, 1);
  beacon.translate(bx, 7.95, bz);
  part(beacon, 'glow', '#ffe2b4');

  // ---- Seating around the plaza, facing in ----
  // Timber-topped stone blocks, set tangentially and kept off the four
  // approach axes so nothing stands in the middle of a sightline.
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2 + Math.PI / 8;
    const px = bx + Math.cos(a) * (PLAZA_R - 1.2);
    const pz = bz + Math.sin(a) * (PLAZA_R - 1.2);
    seatBlock(px, pz, a);
  }

  // ---- Benches on the ring, set on the diagonals so they look at the
  //      marker without blocking an approach ----
  for (let i = 0; i < 4; i++) {
    const a = Math.PI / 4 + (i / 4) * Math.PI * 2;
    const px = bx + Math.cos(a) * (RING_R + 1.9);
    const pz = bz + Math.sin(a) * (RING_R + 1.9);
    bench(px, pz, Math.abs(Math.cos(a)) > 0.5 ? 'ns' : 'ew', Math.cos(a) > 0 ? 1 : -1);
  }

  // ---- Planted edge: a hedge line inside the block boundary, broken at
  //      each approach so the four entries stay legible from the street.
  const inset = 2.2;
  const gap = 3.2;
  const x0 = blk.minX + inset, x1 = blk.maxX - inset;
  const z0 = blk.minZ + inset, z1 = blk.maxZ - inset;
  hedgeRun(x0, z0, bx - gap, z0); hedgeRun(bx + gap, z0, x1, z0);
  hedgeRun(x0, z1, bx - gap, z1); hedgeRun(bx + gap, z1, x1, z1);
  hedgeRun(x0, z0, x0, bz - gap); hedgeRun(x0, bz + gap, x0, z1);
  hedgeRun(x1, z0, x1, bz - gap); hedgeRun(x1, bz + gap, x1, z1);

  // ---- Perimeter trees: the enclosure that makes a green a park ----
  const per = 3.9;
  for (let i = 0; i < 4; i++) {
    const t = (i + 0.5) / 4;
    for (const s of [-1, 1]) {
      const px = blk.minX + per + t * (blk.w - 2 * per);
      const pz = bz + s * (HALF_D - per);
      if (Math.abs(px - bx) > gap + 1) plant('broad', px, pz, 1.0 + rr() * 0.25);
    }
  }
  for (let i = 0; i < 3; i++) {
    const t = (i + 0.5) / 3;
    for (const s of [-1, 1]) {
      const pz = blk.minZ + per + t * (blk.d - 2 * per);
      const px = bx + s * (HALF_W - per);
      if (Math.abs(pz - bz) > gap + 1) plant('broad', px, pz, 1.0 + rr() * 0.25);
    }
  }

  // ---- Three groves of shade trees, off the axes, off the open lawn ----
  const groves = [[-1, -1], [1, -1], [-1, 1]];
  groves.forEach(([sx, sz]) => {
    const gx = bx + sx * 12.5, gz = bz + sz * 11.0;
    for (let i = 0; i < 2; i++) {
      const a = (i / 2) * Math.PI * 2 + rr();
      const dd = 2.2 + rr() * 2.0;
      plant('parasol', gx + Math.cos(a) * dd, gz + Math.sin(a) * dd, 0.95 + rr() * 0.25);
    }
    for (let i = 0; i < 4; i++) {
      const a = rr() * Math.PI * 2, dd = 3.2 + rr() * 3.0;
      plant('shrub', gx + Math.cos(a) * dd, gz + Math.sin(a) * dd, 0.8 + rr() * 0.5);
    }
  });

  // ---- Columnar pairs flanking each approach: a gateway into the green ----
  for (const [ax, az] of [[0, -1], [0, 1], [-1, 0], [1, 0]]) {
    for (const s of [-1, 1]) {
      const px = bx + ax * (HALF_W - 2.6) + (ax ? 0 : s * 3.4);
      const pz = bz + az * (HALF_D - 2.6) + (az ? 0 : s * 3.4);
      plant('column', px, pz, 0.86 + rr() * 0.12);
    }
  }

  // ---- Lawn variation: shallow mown bands, kept clear of the plaza ----
  for (let i = 0; i < 5; i++) {
    const a = rr() * Math.PI * 2;
    const dd = RING_R + 1.5 + rr() * 7;
    const px = bx + Math.cos(a) * dd, pz = bz + Math.sin(a) * dd;
    if (Math.abs(px - bx) > HALF_W - 3 || Math.abs(pz - bz) > HALF_D - 3) continue;
    const g = new THREE.CircleGeometry(2.2 + rr() * 3.4, 9);
    g.rotateX(-Math.PI / 2);
    g.scale(1, 1, 0.5 + rr() * 0.6);
    g.rotateY(rr() * Math.PI);
    g.translate(px, 0.026, pz);
    part(g, 'foliage', rr() > 0.5 ? '#78a25a' : '#6f9b54', { jitter: 0.02 });
  }

  // ---- Basin collision (unchanged footprint) ----
  collisionRegistry.registerBody({
    minX: bx - 2.6, maxX: bx + 2.6,
    minY: 0, maxY: 0.6,
    minZ: bz - 2.6, maxZ: bz + 2.6,
    type: 'basin',
    tag: `basin@${bx.toFixed(1)},${bz.toFixed(1)}`,
  });
}

/** A low stone seat block, rotated to face the plaza centre. */
function seatBlock(x, z, angle) {
  const g = new THREE.BoxGeometry(1.8, 0.40, 0.62);
  g.rotateY(-angle);
  g.translate(x, 0.24, z);
  part(g, 'opaque', P.stone, { jitter: 0.04 });
  // A timber top: the material change is what reads as "sit here".
  const t = new THREE.BoxGeometry(1.84, 0.09, 0.66);
  t.rotateY(-angle);
  t.translate(x, 0.48, z);
  part(t, 'opaque', P.bench, { jitter: 0.04 });
  collisionRegistry.registerBody({
    minX: x - 0.9, maxX: x + 0.9,
    minY: 0, maxY: 0.5,
    minZ: z - 0.9, maxZ: z + 0.9,
    type: 'seat',
    tag: `seat@${x.toFixed(1)},${z.toFixed(1)}`,
  });
}

/** A flat ring band, used for plaza edges and the basin rim. */
function ringBand(cx, cz, r, width, h, y, color, bucket = 'opaque') {
  const seg = 32;
  for (let i = 0; i < seg; i++) {
    const a = (i + 0.5) / seg * Math.PI * 2;
    const g = new THREE.BoxGeometry(width, h, (2 * Math.PI * r) / seg + 0.06);
    g.rotateY(-a);
    g.translate(cx + Math.cos(a) * r, y + h / 2, cz + Math.sin(a) * r);
    part(g, bucket, color, { jitter: 0.02 });
  }
}

/** Upright cylinder helper for the park's stone and metalwork. */
function cylY(bucket, color, rTop, rBot, h, x, y, z, seg) {
  const g = new THREE.CylinderGeometry(rTop, rBot, h, seg || 16, 1);
  part(g, bucket, color, { jitter: 0.02, at: [x, y, z] });
}
