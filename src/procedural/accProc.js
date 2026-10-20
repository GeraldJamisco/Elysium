// ============================================================
// PROCEDURAL ACCUMULATOR — Phase 7
//
// A per-chunk geometry accumulator, mirroring architecture.js but
// kept separate so procedural content can load/unload as its chunk
// is created/destroyed while the authored settlement stays permanent.
//
// Each chunk owns its own set of material buckets. When a chunk is
// finalized the buckets merge into up to five meshes (opaque, glass,
// metal, foliage, glow) exactly as the authored architecture does, so
// every procedural chunk costs the same small number of draw calls.
// ============================================================

import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

// ---- Shared materials (reuse the authored architectural palette for coherence) ----
export const PROC_MAT = {
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
  glow: new THREE.MeshStandardMaterial({
    vertexColors: true, roughness: 0.28, metalness: 0.1,
    emissive: 0xffcf8e, emissiveIntensity: 0.16,
  }),
};

// Per-chunk accumulator state. Keyed by chunk string "cx,cz".
const chunkAcc = new Map();

export function getChunkAcc(key) {
  let acc = chunkAcc.get(key);
  if (!acc) {
    acc = { opaque: [], glass: [], metal: [], foliage: [], glow: [] };
    chunkAcc.set(key, acc);
  }
  return acc;
}

export function releaseChunkAcc(key) {
  const acc = chunkAcc.get(key);
  if (!acc) return;
  for (const k of Object.keys(acc)) {
    for (const g of acc[k]) { try { g.dispose(); } catch (_) {} }
    acc[k] = [];
  }
  chunkAcc.delete(key);
}

const _c = new THREE.Color();

/**
 * Push one part into a chunk's accumulator.
 * Mirrors architecture.js part(): flattens to non-indexed, bakes
 * vertex colour with optional AO / tonal jitter / grade.
 */
export function accPart(key, geo, bucket, color, opt = {}) {
  const acc = getChunkAcc(key);
  const { ao = 1, jitter = 0, grade = false, gradeY, at } = opt;
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
  acc[bucket].push(geo);
  return geo;
}

/** Axis-aligned box part, sized and centred in world space. */
export function accSlab(key, bucket, color, w, h, d, x, y, z, opt = {}) {
  const g = new THREE.BoxGeometry(w, h, d);
  return accPart(key, g, bucket, color, { ...opt, at: [x, y, z] });
}

/**
 * Finalize a single chunk: merge all accumulated parts into meshes.
 * Returns an array of THREE.Mesh added to no parent (the caller
 * attaches them to the chunk group). Clears the accumulator.
 *
 * @param {string} key            chunk key
 * @param {number} shadowDist     if a chunk is beyond this distance
 *                              from origin, meshes cast no shadow
 * @param {boolean} castShadow    master switch (LOD 1+ sets false)
 */
export function finalizeChunk(key, { castShadow = true } = {}) {
  const acc = chunkAcc.get(key);
  if (!acc) return [];
  const made = [];
  for (const bucket of Object.keys(PROC_MAT)) {
    const list = acc[bucket];
    if (!list.length) continue;
    const merged = mergeGeometries(list, false);
    list.forEach(g => g.dispose());
    acc[bucket] = [];
    if (!merged) { console.warn('proc: merge failed for', key, bucket); continue; }
    merged.computeBoundingSphere();
    const mesh = new THREE.Mesh(merged, PROC_MAT[bucket]);
    mesh.name = `proc-${key}-${bucket}`;
    mesh.castShadow = castShadow ? bucket !== 'glow' : false;
    mesh.receiveShadow = true;
    // Frustum culling ON for procedural content — chunks off-screen
    // behind the camera are skipped by the renderer automatically.
    mesh.frustumCulled = true;
    made.push(mesh);
  }
  chunkAcc.delete(key);
  return made;
}