// ============================================================
// LANDFORM FIELD — Phase 7 visual sanitation
//
// The Phase 7 world put 46 decorative cones in a ring 520–1420 m from
// Veridian Cap and generated buildings out to 2000 m.  The two knew
// nothing about each other, so from Eagle whole neighbourhoods were
// buried inside hillsides and roads ran through rock.
//
// This module makes the relief part of the world model instead of
// scenery.  One low-frequency field decides where high ground is; the
// settlement catalogue is sampled from the same field (settlements land
// in the basins), and roads consult it to route around slopes.  Hills
// are then instantiated only where nothing is built.
//
// The ground plane itself stays flat — the whole collision, walk and
// road stack is built on y=0 and displacing it is a different project.
// What changes is that relief and civilization now agree about where
// each of them belongs.
// ============================================================

import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { PROC } from '../config.js';
import { fbm2, hash2 } from './seed.js';
import { developmentAt } from './settlement.js';

// The habitability field.  settlement.js sites its catalogue against
// exactly this expression, so the two modules cannot drift apart: high
// values are the good ground that gets settled, low values are the
// ground that stays high and wooded.
export function habitabilityAt(wx, wz) {
  return fbm2(wx * 0.00042 + 91.3, wz * 0.00042 - 12.7, 3);
}

// Value-noise fBm is heavily centred — over the whole planet this field
// spans roughly 0.40 to 0.71, not 0 to 1.  The first version of this
// module compared it against thresholds chosen as if it were uniform,
// with the result that relief never once crossed the buildable
// threshold and the planet came out perfectly flat.  These two constants
// are the measured working range, and every threshold below is expressed
// against them rather than against an imagined 0..1.
const HAB_LOW = 0.425;
const HAB_HIGH = 0.545;

/**
 * Raw relief potential in [0,1] — how high this ground wants to be.
 *
 * Low habitability means high ground.  Getting this the right way round
 * matters: with the relationship inverted, settlements sited on the most
 * habitable land would have been sited precisely on the ridge tops.
 *
 * A ridged second octave breaks the result into chains rather than
 * domes, which is what makes the valleys between them read as routes.
 */
export function reliefAt(wx, wz) {
  const f = habitabilityAt(wx, wz);
  const base = Math.max(0, Math.min(1, (HAB_HIGH - f) / (HAB_HIGH - HAB_LOW)));
  if (base <= 0) return 0;

  // Ridging: fold a finer octave about its midpoint so its crests form
  // lines.  Kept as a modulation of `base`, so it can sharpen high
  // ground but never raise ground that wants to be flat.
  const d = fbm2(wx * 0.0011 - 5.5, wz * 0.0011 + 8.2, 2);
  const ridge = 1 - Math.min(1, Math.abs(d - 0.54) / 0.10);
  return Math.max(0, Math.min(1, base * (0.66 + ridge * 0.50)));
}

/**
 * Effective landform height in metres, after civilization has flattened
 * what it occupies.  Downstream systems treat anything above a couple of
 * metres as unbuildable.
 */
export function landformAt(wx, wz) {
  const r = reliefAt(wx, wz);
  if (r <= 0) return 0;
  const dev = developmentAt(wx, wz).intensity;
  // Development suppresses relief: people build on the flat, and where
  // they have built, it is flat.  The shoulder is soft so the hills do
  // not end in a cliff at the development boundary.
  const suppress = Math.min(1, dev * 2.4);
  return Math.pow(r, 1.7) * PROC.reliefHeight * (1 - suppress);
}

/** True where the ground is flat enough to be worth building on. */
export function isBuildable(wx, wz) {
  return landformAt(wx, wz) < 1.5;
}

/**
 * Slope penalty in [0,1] for road routing — sampled as a finite
 * difference of landformAt.  Regional roads use this to bend toward the
 * saddles between hills instead of climbing over them.
 */
export function slopeAt(wx, wz, h = 40) {
  const a = landformAt(wx - h, wz), b = landformAt(wx + h, wz);
  const c = landformAt(wx, wz - h), d = landformAt(wx, wz + h);
  return Math.min(1, (Math.abs(b - a) + Math.abs(d - c)) / (2 * h) * 6);
}

// ============================================================
// HILL INSTANTIATION
//
// Hills are placed on a jittered lattice and kept only where the
// landform field is high AND nothing is developed.  That replaces the
// old fixed ring of 46 cones, which sat at a distance from origin that
// had nothing to do with where the world was built.
// ============================================================

const HILL_CELL = 260;

/**
 * Build the relief mesh covering a radius around the origin.
 * Returns a single merged THREE.Mesh, or null if there is no relief.
 *
 * @param {number} reach  how far out to instantiate hills, metres
 */
export function buildRelief(reach = PROC.reliefReach) {
  const parts = [];
  const n = Math.ceil(reach / HILL_CELL);

  for (let iz = -n; iz <= n; iz++) {
    for (let ix = -n; ix <= n; ix++) {
      const jx = (hash2(ix * 19 + 3, iz * 23 + 41) - 0.5) * HILL_CELL * 0.75;
      const jz = (hash2(iz * 29 + 13, ix * 37 + 7) - 0.5) * HILL_CELL * 0.75;
      const x = ix * HILL_CELL + jx;
      const z = iz * HILL_CELL + jz;
      if (Math.hypot(x, z) > reach) continue;

      const h = landformAt(x, z);
      if (h < PROC.reliefHeight * 0.16) continue;      // not high ground

      // A hill is a mass, not a spike: its footprint scales with how
      // much high ground surrounds it, so isolated cones never appear.
      const spread = (landformAt(x - 90, z) + landformAt(x + 90, z) +
                      landformAt(x, z - 90) + landformAt(x, z + 90)) / 4;
      if (spread < PROC.reliefHeight * 0.08) continue;

      const hgt = h * (0.75 + hash2(ix * 5, iz * 11) * 0.5);
      const rad = HILL_CELL * (0.62 + hash2(iz * 3, ix * 9) * 0.45);

      const g = new THREE.ConeGeometry(rad, hgt, 6, 1);
      g.scale(1, 1, 0.62 + hash2(ix + 71, iz + 17) * 0.55);
      g.rotateY(hash2(ix * 13 + 2, iz * 7 + 5) * Math.PI);
      // Sunk below the plane so the base never reads as a hard rim.
      g.translate(x, hgt / 2 - Math.min(9, hgt * 0.34), z);
      parts.push(g);
    }
  }

  if (!parts.length) return null;
  const merged = mergeGeometries(parts, false);
  parts.forEach(g => g.dispose());
  if (!merged) return null;

  const mesh = new THREE.Mesh(
    merged,
    new THREE.MeshStandardMaterial({ color: 0x5f7150, roughness: 1, metalness: 0, flatShading: true })
  );
  mesh.name = 'relief';
  mesh.frustumCulled = false;
  // Not shadow-receiving.  The relief runs to 3.4 km and the directional
  // light's shadow camera covers the settlement, so every hill outside
  // that frustum samples beyond the shadow map and comes back fully
  // occluded — which put a solid black dome on the horizon.  Distance
  // shading comes from the fog, which is what it is for.
  mesh.receiveShadow = false;
  mesh.castShadow = false;
  return mesh;
}
