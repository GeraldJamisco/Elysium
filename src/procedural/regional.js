// ============================================================
// REGIONAL DEVELOPMENT MASS — Phase 9A, LOD 3
//
// What a settlement looks like from four hundred metres up.
//
// The detailed passes build parcels: frontage, setback, entrance, roof,
// collision.  They are correct and they are expensive, so the chunk
// manager only runs them within 500 m of the camera.  Beyond that the
// world kept its roads, its fields and its hedgerows and lost every
// single building — 147 of 173 loaded chunks carried none.  The result
// was not "a quiet countryside"; it was a planarized street network,
// kerbs and turning heads included, laid out across open grass.  A road
// plan with nothing built on it reads as abandoned, not as rural.
//
// This pass answers a different question from the detail pass.  Not
// "what is this building" but "is there a town here, how big is it, and
// where does it stop".  So it builds no architecture at all: one
// untextured box per mass, merged into the chunk's existing buckets,
// no roof, no collision, no shadow.  Twelve triangles each.
//
// The masses are placed from the zone model, not from parcels, because
// parcels cost roughly what the detail pass costs and we are trying to
// avoid exactly that.  What the zone gives us is the thing that actually
// reads at distance: how much of the ground is built on, how tightly it
// clusters, how tall it tends to be and how coarse its grain is.
// ============================================================

import * as THREE from 'three';
import { hash2, fbm2 } from './seed.js';
import { zoneAt, ZONE } from './zones.js';

const STOREY = 3.2;

// Deliberately the same hues as buildingfam's wall palettes.  A distant
// settlement that is a different colour from a near one reads as a
// different KIND of place, which is precisely the wrong signal.
const WALL = {
  'urban-core':    [0xd6d3c8, 0xc8c7bd, 0xdedbd0, 0xe6dfd0],
  'urban-edge':    [0xe0cfae, 0xd8c3a0, 0xe7dcc2, 0xdcd4c2],
  'suburban':      [0xe0cfae, 0xcdb694, 0xdcc9ad, 0xe7dcc2],
  'rural-settled': [0xd8c3a0, 0xcdb694, 0x8a6f55],
  'agricultural':  [0x8a6f55, 0x7a6450, 0x9fa4a2],
  'industrial':    [0x9fa4a2, 0xb0b3ac, 0x8d9290],
};

// Roofs are what a suburb actually shows from above, so each mass gets a
// thin cap in a roof hue rather than a flat-topped box.  It is one extra
// box and it is the difference between "houses" and "crates".
const ROOF = {
  'urban-core':    [0xbdb9ac, 0xb3aea0, 0xc6c2b4],
  'urban-edge':    [0x8c5e4a, 0x9a6a4e, 0xb3aea0, 0x7c6b56],
  'suburban':      [0x8c5e4a, 0x9a6a4e, 0x6b6f66, 0x7c6b56, 0xa1705a],
  'rural-settled': [0x8c5e4a, 0x6b6f66, 0x7c6b56],
  'agricultural':  [0x9aa3a4, 0x88918f, 0x6b6f66],
  'industrial':    [0x9aa3a4, 0x88918f],
};

const pick = (arr, h) => arr[Math.floor(h * arr.length) % arr.length];

/**
 * Clustering field.  Low frequency, so it groups masses into
 * neighbourhoods and leaves gaps between them instead of dithering a
 * uniform grey over the whole settlement.
 */
function clumpAt(x, z) {
  return fbm2(x * 0.0042 - 5.1, z * 0.0042 + 9.4, 2);
}

/**
 * Distance from a point to the nearest road, with that road's bearing.
 *
 * Masses are aligned to the road they sit near and kept off its
 * carriageway.  Alignment is most of what separates "a town" from "a
 * scatter of boxes" at this distance: real development runs along its
 * streets, and a field of randomly rotated blocks reads as debris even
 * when the density is right.
 */
function nearestRoad(x, z, segs) {
  let bd = Infinity, angle = 0, width = 0;
  for (let i = 0; i < segs.length; i++) {
    const s = segs[i];
    const dx = s.x2 - s.x1, dz = s.z2 - s.z1;
    const l2 = dx * dx + dz * dz;
    let t = l2 ? ((x - s.x1) * dx + (z - s.z1) * dz) / l2 : 0;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    const px = x - (s.x1 + t * dx), pz = z - (s.z1 + t * dz);
    const d = Math.hypot(px, pz);
    if (d < bd) { bd = d; angle = s.angle; width = s.width; }
  }
  return { d: bd, angle, width };
}

/**
 * Build the regional mass for one chunk.
 *
 * @param {string}   key    chunk key, for the geometry accumulator
 * @param {object}   b      { minX, maxX, minZ, maxZ }
 * @param {Array}    segs   road segments near this chunk
 * @param {Function} accPart(key, geometry, bucket, colour, opts)
 * @returns {number} how many masses were emitted
 */
export function buildRegionalMass(key, b, segs, accPart) {
  // One lattice for the whole chunk.  The zone's own grain then decides
  // how many lattice points it actually uses, so an urban core samples
  // every point and farmland samples one in sixty-four — without needing
  // a different lattice per zone, which would tear at zone boundaries.
  const STEP = 18;
  const i0 = Math.ceil(b.minX / STEP), i1 = Math.floor(b.maxX / STEP);
  const j0 = Math.ceil(b.minZ / STEP), j1 = Math.floor(b.maxZ / STEP);

  let n = 0;
  for (let j = j0; j <= j1; j++) {
    for (let i = i0; i <= i1; i++) {
      // Jitter first: a mass placed exactly on a lattice point betrays
      // the lattice from above however good the density is.
      const hx = hash2(i * 13 + 7, j * 29 + 3);
      const hz = hash2(j * 17 + 11, i * 23 + 5);
      const x = i * STEP + (hx - 0.5) * STEP * 0.85;
      const z = j * STEP + (hz - 0.5) * STEP * 0.85;

      const zone = zoneAt(x, z);
      const m = zone.mass;
      if (!m.cover) continue;

      // The zone's grain, expressed as a stride over the shared lattice.
      const stride = Math.max(1, Math.round(m.grain / STEP));
      if (stride > 1 && (((i % stride) + stride) % stride ||
                         ((j % stride) + stride) % stride)) continue;

      // Cover, pulled about by the clustering field.  At clump 0 the
      // cover is uniform; at clump 1 it is entirely decided by whether
      // this is a built-up part of the settlement or a gap in it.
      const roll = hash2(i * 101 + 31, j * 211 + 17);
      const cover = m.cover * (1 - m.clump) + m.cover * 2 * m.clump * clumpAt(x, z);
      if (roll > cover) continue;

      const road = nearestRoad(x, z, segs);
      // Nothing stands in a carriageway, and nothing stands absurdly far
      // from any road — development that ignores the network is the
      // "random building field" this phase exists to avoid.
      const hw = road.width / 2 + 3;
      if (road.d < hw) continue;
      if (road.d > (zone === ZONE.AGRICULTURAL ? 110 : 58)) continue;

      const hf = hash2(i * 37 + 3, j * 41 + 19);
      const hs = hash2(j * 43 + 13, i * 47 + 29);
      const w = m.foot[0] + hs * (m.foot[1] - m.foot[0]);
      const d = m.foot[0] + hf * (m.foot[1] - m.foot[0]);
      const floors = m.floors[0] + Math.floor(hf * (m.floors[1] - m.floors[0] + 1));
      const h = Math.max(3, floors * STOREY);

      const wall = pick(WALL[zone.name] || WALL.suburban, hs);
      const roof = pick(ROOF[zone.name] || ROOF.suburban, hf);

      const body = new THREE.BoxGeometry(w, h, d);
      body.rotateY(-road.angle);
      body.translate(x, h / 2, z);
      accPart(key, body, 'opaque', wall, { jitter: 0.035 });

      // The cap. Slightly oversized so it reads as an eave line rather
      // than as a stripe painted on the top of a box.
      const cap = new THREE.BoxGeometry(w + 0.6, 0.55, d + 0.6);
      cap.rotateY(-road.angle);
      cap.translate(x, h + 0.2, z);
      accPart(key, cap, 'opaque', roof, { jitter: 0.02 });

      n++;
    }
  }
  return n;
}
