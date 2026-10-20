import * as THREE from 'three';
import { buildRelief } from '../procedural/terrain.js';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { scene } from '../scene.js';
import { TOWN } from '../config.js';
import { asphaltTex, pavingTex, parkPathTex, grassTex, plainTex, TILE_M } from '../textures.js';
import { slab } from './architecture.js';

export const ground = new THREE.Group();

/**
 * The authored street network as graph segments, split at every
 * intersection.
 *
 * The procedural layer keeps its roads in a segment list; the authored
 * town draws its streets straight into the ground mesh and keeps no
 * such list, so there was no way to ask whether the two networks join.
 * This reconstructs the authored streets from the same TOWN constants
 * layout.js lays them out from, so the answer is derived rather than
 * transcribed.
 */
export function authoredStreetSegments() {
  const { blocksX, blocksZ, blockW, blockD, roadW, sidewalkW } = TOWN;
  const edgeW = roadW + sidewalkW * 2;
  const totalX = blocksX * blockW + (blocksX - 1) * edgeW;
  const totalZ = blocksZ * blockD + (blocksZ - 1) * edgeW;

  const ns = [], ew = [];
  for (let x = 0; x < blocksX - 1; x++) {
    ns.push(-totalX / 2 + (x + 1) * blockW + x * edgeW + roadW / 2 + sidewalkW);
  }
  for (let z = 0; z < blocksZ - 1; z++) {
    ew.push(-totalZ / 2 + (z + 1) * blockD + z * edgeW + roadW / 2 + sidewalkW);
  }

  const out = [];
  let id = 900000;
  const add = (x1, z1, x2, z2, name) => {
    const len = Math.hypot(x2 - x1, z2 - z1);
    if (len < 0.5) return;
    out.push({ id: id++, x1, z1, x2, z2, len, width: roadW, type: 'authored',
               angle: Math.atan2(z2 - z1, x2 - x1), owner: 'veridian-cap', name });
  };

  const NS_NAMES = ['Fernway', 'Lantern Row'];
  const EW_NAMES = ['Cinder Walk', 'Harvest Walk'];

  ns.forEach((x, i) => {
    const cuts = [-totalZ / 2, ...ew, totalZ / 2];
    for (let k = 0; k < cuts.length - 1; k++) add(x, cuts[k], x, cuts[k + 1], NS_NAMES[i]);
  });
  ew.forEach((z, i) => {
    const cuts = [-totalX / 2, ...ns, totalX / 2];
    for (let k = 0; k < cuts.length - 1; k++) add(cuts[k], z, cuts[k + 1], z, EW_NAMES[i]);
  });

  // The road out of town.
  add(totalX / 2, 0, totalX / 2 + TOWN.avenueLen, 0, 'The Reach Road');
  return out;
}
export const blockData = [];

// ============================================================
// GROUND PLANE — Phase 5C
//
// The street network, setbacks and block boundaries are exactly
// as Phase 3 laid them out.  What changed is how the surfaces
// are made:
//
//   * Every surface is a flat quad whose UVs are derived from
//     WORLD position, so the paving grain is continuous across
//     segment joins and identical on a 2 m stoop and a 200 m
//     avenue.  Before, one tile was stretched over each mesh,
//     which is what made the roads read as painted colour.
//
//   * Surfaces of the same material are merged into a single
//     mesh, so the whole ground plane is five draw calls.
//
//   * The road is built as a road: carriageway, edge lines, a
//     dashed centre line, a chamfered kerb, then the footway.
//     Each of those is a real height change or a real material
//     change, which is what makes a street feel constructed.
// ============================================================

const SURF = {
  asphalt:  { tile: TILE_M.asphalt,  mat: null, geo: [] },
  paving:   { tile: TILE_M.paving,   mat: null, geo: [] },
  grass:    { tile: TILE_M.grass,    mat: null, geo: [] },
  parkPath: { tile: TILE_M.parkPath, mat: null, geo: [] },
  marking:  { tile: 1,               mat: null, geo: [] },
};

/** Flat quad at world (cx, y, cz), UVs taken from world XZ. */
export function surface(kind, w, d, cx, y, cz) {
  const s = SURF[kind];
  const g = new THREE.PlaneGeometry(w, d);
  g.rotateX(-Math.PI / 2);
  g.translate(cx, y, cz);
  const pos = g.attributes.position;
  const uv = g.attributes.uv;
  for (let i = 0; i < pos.count; i++) {
    uv.setXY(i, pos.getX(i) / s.tile, pos.getZ(i) / s.tile);
  }
  s.geo.push(g);
  return g;
}

function buildSurfaceMaterials() {
  SURF.asphalt.mat = new THREE.MeshStandardMaterial({
    map: asphaltTex(), roughness: 0.93, metalness: 0.04,
  });
  SURF.paving.mat = new THREE.MeshStandardMaterial({
    map: pavingTex(), roughness: 0.87, metalness: 0.0,
  });
  SURF.grass.mat = new THREE.MeshStandardMaterial({
    map: grassTex(), roughness: 1.0, metalness: 0.0,
  });
  SURF.parkPath.mat = new THREE.MeshStandardMaterial({
    map: parkPathTex(), roughness: 0.95, metalness: 0.0,
  });
  SURF.marking.mat = new THREE.MeshStandardMaterial({
    color: 0xc0bba8, roughness: 0.78, metalness: 0.0,
  });
}

/** Merge every accumulated ground surface.  Call after all worldbuilding. */
export function finalizeGround() {
  for (const key of Object.keys(SURF)) {
    const s = SURF[key];
    if (!s.geo.length) continue;
    const merged = mergeGeometries(s.geo, false);
    s.geo.forEach(g => g.dispose());
    s.geo = [];
    if (!merged) { console.warn('ground: merge failed for', key); continue; }
    const m = new THREE.Mesh(merged, s.mat);
    m.name = `ground-${key}`;
    m.receiveShadow = true;
    m.frustumCulled = false;
    ground.add(m);
  }
}

// ---- Surface datum heights ----
// Kept exactly as Phase 3/4 established them: collision and the walk
// eye height are both authored against these numbers.
const Y_ROAD = 0.012;
const Y_MARK = 0.042;
const Y_WALK = 0.35;
const Y_WALKMARK = 0.372;

export function buildTown() {
  scene.add(ground);
  buildSurfaceMaterials();

  const { blocksX, blocksZ, blockW, blockD, roadW, sidewalkW } = TOWN;

  const edgeW = roadW + sidewalkW * 2;
  const totalX = blocksX * blockW + (blocksX - 1) * edgeW;
  const totalZ = blocksZ * blockD + (blocksZ - 1) * edgeW;

  buildTerrain();

  // ---- Blocks ----
  for (let z = 0; z < blocksZ; z++) for (let x = 0; x < blocksX; x++) {
    const minX = -totalX / 2 + x * (blockW + edgeW);
    const maxX = minX + blockW;
    const minZ = -totalZ / 2 + z * (blockD + edgeW);
    const maxZ = minZ + blockD;
    const into = {
      x, z, minX, maxX, minZ, maxZ, w: blockW, d: blockD,
      cx: (minX + maxX) / 2, cz: (minZ + maxZ) / 2,
    };

    const park = (x === 1 && z === 1);
    // The lawn runs right up to the footway: the strip of bare terrain that
    // used to show between them was the clearest tell that this was a blockout.
    surface('grass', blockW, blockD, into.cx, 0.022, into.cz);

    if (park) into.park = { x: into.cx, z: into.cz, r: Math.min(blockW, blockD) * 0.35 };

    blockData.push(into);
  }

  // ---- NS roads between columns ----
  for (let x = 0; x < blocksX - 1; x++) {
    const rdX = -totalX / 2 + (x + 1) * blockW + x * edgeW + (roadW / 2) + sidewalkW;
    for (let z = 0; z < blocksZ; z++) {
      const blk = blockData[z * blocksX + x];
      carriageway(rdX, blk.cz, roadW, blockD, 'ns');
      footway(rdX - roadW / 2 - sidewalkW / 2, blk.cz, sidewalkW, blockD);
      footway(rdX + roadW / 2 + sidewalkW / 2, blk.cz, sidewalkW, blockD);
      kerb(rdX - roadW / 2, blk.cz, blockD, 'ns', -1);
      kerb(rdX + roadW / 2, blk.cz, blockD, 'ns', 1);
    }
  }

  // ---- EW roads between rows ----
  for (let z = 0; z < blocksZ - 1; z++) {
    const rdZ = -totalZ / 2 + (z + 1) * blockD + z * edgeW + (roadW / 2) + sidewalkW;
    for (let x = 0; x < blocksX; x++) {
      const blk = blockData[z * blocksX + x];
      carriageway(blk.cx, rdZ, blockW, roadW, 'ew');
      footway(blk.cx, rdZ - roadW / 2 - sidewalkW / 2, blockW, sidewalkW);
      footway(blk.cx, rdZ + roadW / 2 + sidewalkW / 2, blockW, sidewalkW);
      kerb(blk.cx, rdZ - roadW / 2, blockW, 'ew', -1);
      kerb(blk.cx, rdZ + roadW / 2, blockW, 'ew', 1);
    }
  }

  // ---- Intersections ----
  for (let x = 0; x < blocksX - 1; x++) for (let z = 0; z < blocksZ - 1; z++) {
    const rdX = -totalX / 2 + (x + 1) * blockW + x * edgeW + roadW / 2 + sidewalkW;
    const rdZ = -totalZ / 2 + (z + 1) * blockD + z * edgeW + roadW / 2 + sidewalkW;
    // Fill the crossing square and the four footway corners.
    surface('asphalt', edgeW, edgeW, rdX, Y_ROAD, rdZ);
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
      surface('paving', sidewalkW, sidewalkW,
              rdX + sx * (roadW / 2 + sidewalkW / 2), Y_WALK,
              rdZ + sz * (roadW / 2 + sidewalkW / 2));
      dropKerb(rdX + sx * (roadW / 2 + sidewalkW / 2), rdZ + sz * (roadW / 2 + sidewalkW / 2));
    }
    crosswalk(rdX, rdZ - roadW / 2 - 0.9, roadW, 'x');
    crosswalk(rdX, rdZ + roadW / 2 + 0.9, roadW, 'x');
    crosswalk(rdX - roadW / 2 - 0.9, rdZ, roadW, 'z');
    crosswalk(rdX + roadW / 2 + 0.9, rdZ, roadW, 'z');
  }

  // ---- The road out of town ----
  const rightEdge = totalX / 2;
  const avenueZ = 0;
  carriageway(rightEdge + TOWN.avenueLen / 2, avenueZ, TOWN.avenueLen, roadW, 'ew');
  footway(rightEdge + TOWN.avenueLen / 2, avenueZ - roadW / 2 - sidewalkW / 2, TOWN.avenueLen, sidewalkW);
  footway(rightEdge + TOWN.avenueLen / 2, avenueZ + roadW / 2 + sidewalkW / 2, TOWN.avenueLen, sidewalkW);
  kerb(rightEdge + TOWN.avenueLen / 2, avenueZ - roadW / 2, TOWN.avenueLen, 'ew', -1);
  kerb(rightEdge + TOWN.avenueLen / 2, avenueZ + roadW / 2, TOWN.avenueLen, 'ew', 1);
}

// ============================================================
// STREET ELEMENTS
// ============================================================

/** Carriageway plus its edge lines and dashed centre line. */
function carriageway(cx, cz, w, d, dir) {
  surface('asphalt', w, d, cx, Y_ROAD, cz);

  const len = dir === 'ns' ? d : w;
  const across = dir === 'ns' ? w : d;

  // Edge lines, held 0.35 m off the kerb face as they would really be.
  for (const s of [-1, 1]) {
    if (dir === 'ns') surface('marking', 0.12, len, cx + s * (across / 2 - 0.35), Y_MARK, cz);
    else              surface('marking', len, 0.12, cx, Y_MARK, cz + s * (across / 2 - 0.35));
  }

  // Dashed centre line: 2 m mark, 3 m gap.
  const step = 5;
  const n = Math.floor(len / step);
  const start = -n * step / 2 + step / 2;
  for (let i = 0; i < n; i++) {
    const o = start + i * step;
    if (dir === 'ns') surface('marking', 0.14, 2.0, cx, Y_MARK, cz + o);
    else              surface('marking', 2.0, 0.14, cx + o, Y_MARK, cz);
  }
}

/** Raised footway at y = 0.35. */
function footway(cx, cz, w, d) {
  surface('paving', w, d, cx, Y_WALK, cz);
}

/**
 * Kerb: a 0.35 m upstand with a lit top chamfer.  The chamfer is the
 * detail that makes the step read at street level instead of
 * disappearing into the shadow under the footway edge.
 */
function kerb(x, z, len, dir, side) {
  const H = 0.35, T = 0.2;
  const face = '#b0aa9c', top = '#cfc9ba';
  if (dir === 'ns') {
    slab('opaque', face, T, H, len, x, H / 2, z, { jitter: 0.015 });
    slab('opaque', top, 0.09, 0.05, len, x + side * (T / 2 - 0.045), H + 0.01, z);
  } else {
    slab('opaque', face, len, H, T, x, H / 2, z, { jitter: 0.015 });
    slab('opaque', top, len, 0.05, 0.09, x, H + 0.01, z + side * (T / 2 - 0.045));
  }
}

/** Tactile paving square where a crossing meets the footway. */
function dropKerb(x, z) {
  surface('marking', 1.1, 1.1, x, Y_WALKMARK, z);
}

/** Ladder-pattern crossing across a carriageway. */
function crosswalk(x, z, roadW, dir) {
  const bars = 6, pitch = roadW * 0.86 / bars;
  for (let i = 0; i < bars; i++) {
    const o = -roadW * 0.43 + (i + 0.5) * pitch;
    if (dir === 'x') surface('marking', 0.42, 2.6, x + o, Y_MARK, z);
    else             surface('marking', 2.6, 0.42, x, Y_MARK, z + o);
  }
}

// ============================================================
// TERRAIN
//
// The settlement sat on a 452 m plate whose edge met the sky as a
// hard line.  It now runs to the fog distance and carries low
// ridges beyond the town, which is what gives Eagle a background
// and Walk a horizon to read distance against.
// ============================================================

function buildTerrain() {
  // Two triangles, so the size costs nothing.  It has to out-reach the
  // procedural cover in every direction the camera can pan to, or the
  // world ends in a visible edge.
  const plainSize = 14000;
  const plainMap = plainTex();
  plainMap.repeat.set(plainSize / TILE_M.plain, plainSize / TILE_M.plain);
  const terrain = new THREE.Mesh(
    new THREE.PlaneGeometry(plainSize, plainSize, 1, 1),
    new THREE.MeshStandardMaterial({ map: plainMap, roughness: 1, metalness: 0 })
  );
  terrain.rotation.x = -Math.PI / 2;
  // Well below the procedural land cover at y=0.0025.  At the old -0.02
  // the two surfaces were within a depth-buffer hair of each other and
  // fought across the whole middle distance, which showed from Eagle as
  // horizontal hatching through the fields.  Half a metre settles it,
  // and the step is only ever seen at the cover boundary 1.5 km out,
  // where it is well under a pixel.
  terrain.position.y = -0.5;
  terrain.receiveShadow = true;
  terrain.frustumCulled = false;
  ground.add(terrain);

  // ---- Relief ----
  // The ridges used to be 46 cones on a fixed ring 520-1420 m out, placed
  // with no knowledge of where the procedural world builds.  Since the
  // procedural world reaches 2000 m, whole neighbourhoods ended up inside
  // hillsides.  Relief now comes from the same landform field the
  // settlement catalogue is sited against, so hills take the high ground
  // and civilization takes the basins between them.
  const relief = buildRelief();
  if (relief) ground.add(relief);
}
