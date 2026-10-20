import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

// ============================================================
// VERIDIAN CAP — ARCHITECTURAL SYSTEM (Phase 5A/5B)
//
// One language, four families.  Every building in the settlement
// is assembled from the same parts in the same order:
//
//     PLINTH  — the ground floor, expressed in a cooler cast
//               stone, always taller than the floors above it.
//     BODY    — repeating floors on a fixed structural bay.
//               Piers run full height and project; window bays
//               sit recessed between them.  The recess is real
//               geometry, not a painted rectangle, so it casts
//               its own reveal shadow at every hour.
//     CROWN   — a parapet, cornice or setback that stops the
//               building against the sky.
//
// The families differ in bay width, floor height, window
// proportion, crown and entrance treatment — never in grammar.
// That is what keeps sixty buildings reading as one town.
//
// PERFORMANCE MODEL
// Nothing here creates a mesh.  Every part is pushed into a
// shared accumulator as a transformed geometry with its colour
// baked into vertex colours.  At the end of worldbuilding the
// whole settlement is merged into FOUR meshes — opaque, glass,
// metal, glow — so the entire built environment costs four draw
// calls and four shadow draw calls, whatever the detail level.
// ============================================================

// ---- Shared materials (the complete architectural palette) ----
export const ARCH_MAT = {
  opaque: new THREE.MeshStandardMaterial({
    vertexColors: true, roughness: 0.85, metalness: 0.02,
  }),
  glass: new THREE.MeshStandardMaterial({
    vertexColors: true, roughness: 0.10, metalness: 0.22,
    envMapIntensity: 2.2,
  }),
  metal: new THREE.MeshStandardMaterial({
    vertexColors: true, roughness: 0.38, metalness: 0.75,
    envMapIntensity: 1.4,
  }),
  foliage: new THREE.MeshStandardMaterial({
    vertexColors: true, roughness: 0.94, metalness: 0,
  }),
  // Lit glazing and lamp lenses. Kept dim by day — an emissive panel bright
  // enough to read at night looks like painted card at four in the afternoon.
  glow: new THREE.MeshStandardMaterial({
    vertexColors: true, roughness: 0.28, metalness: 0.1,
    emissive: 0xffcf8e, emissiveIntensity: 0.16,
  }),
};

// ---- Accumulator ----
const buckets = { opaque: [], glass: [], metal: [], foliage: [], glow: [] };
const _c = new THREE.Color();

/**
 * Push one part into the town-wide geometry accumulator.
 *
 * @param {THREE.BufferGeometry} geo  a fresh geometry (consumed, not cloned)
 * @param {string} bucket  'opaque' | 'glass' | 'metal' | 'foliage' | 'glow'
 * @param {number|string} color  base colour
 * @param {object} [opt]
 *   opt.ao      multiply colour by this (use < 1 inside recesses)
 *   opt.jitter  per-part tonal jitter amount (breaks up flat material)
 *   opt.grade   true to darken toward the ground (cheap ambient occlusion)
 *   opt.gradeY  [y0, y1] explicit range for that darkening — used by
 *               planting, where the shading runs across the canopy itself
 *   opt.at      [x, y, z] translation applied after any local transform
 */
export function part(geo, bucket, color, opt = {}) {
  const { ao = 1, jitter = 0, grade = false, gradeY, at } = opt;
  // mergeGeometries refuses a mix of indexed and non-indexed inputs, and the
  // kit draws on both (BoxGeometry is indexed, IcosahedronGeometry is not).
  // Everything is flattened to non-indexed on the way in, which also makes
  // the per-face tonal jitter below behave consistently.
  if (geo.index) {
    const flat = geo.toNonIndexed();
    geo.dispose();
    geo = flat;
  }
  if (at) geo.translate(at[0], at[1], at[2]);

  _c.set(color);
  const j = jitter ? 1 + (Math.random() - 0.5) * 2 * jitter : 1;
  const r = _c.r * ao * j, g = _c.g * ao * j, b = _c.b * ao * j;

  const pos = geo.attributes.position;
  const n = pos.count;
  const col = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    // Cheap grounding: parts fade slightly darker as they approach grade,
    // which reads as contact shading where walls meet the pavement.
    let k = 1;
    if (grade || gradeY) {
      const [y0, y1] = gradeY || [0, 4.5];
      const y = pos.getY(i);
      k = 0.74 + 0.26 * Math.min(1, Math.max(0, (y - y0) / (y1 - y0)));
    }
    col[i * 3] = r * k; col[i * 3 + 1] = g * k; col[i * 3 + 2] = b * k;
  }
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  if (!geo.attributes.uv) {
    geo.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(n * 2), 2));
  }
  buckets[bucket].push(geo);
  return geo;
}

/** Axis-aligned box part, sized and centred in world space. */
export function slab(bucket, color, w, h, d, x, y, z, opt = {}) {
  const g = new THREE.BoxGeometry(w, h, d);
  return part(g, bucket, color, { ...opt, at: [x, y, z] });
}

/**
 * Merge every accumulated part into four meshes and add them to `parent`.
 * Call once, after all buildings are generated.
 */
export function finalizeArchitecture(parent) {
  const made = [];
  for (const key of Object.keys(buckets)) {
    const list = buckets[key];
    if (!list.length) continue;
    const merged = mergeGeometries(list, false);
    list.forEach(g => g.dispose());
    buckets[key] = [];
    if (!merged) { console.warn('architecture: merge failed for', key); continue; }
    merged.computeBoundingSphere();
    const mesh = new THREE.Mesh(merged, ARCH_MAT[key]);
    mesh.name = `arch-${key}`;
    mesh.castShadow = key !== 'glow';
    mesh.receiveShadow = true;
    // The settlement is small and always largely on screen; skipping the
    // per-frame cull test on four large static meshes is the cheaper side.
    mesh.frustumCulled = false;
    parent.add(mesh);
    made.push(mesh);
  }
  return made;
}
