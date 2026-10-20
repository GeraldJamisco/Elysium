// ============================================================
// PHASE 6 — BUILDING INTERIOR FOUNDATION
//
// Defines the first enterable interior in Veridian Cap: a warm
// community hall inside the civic corner building at b@-44.5,-8.5
// (SE corner of block (0,1), east entrance facing the central park).
// The interior is built once at world-build time and toggled via
// visible = false when the player is outside.
//
// The interior keeps its OWN geometry accumulator so the whole
// group can be shown/hidden as one unit, lights included.
// Collision bodies carry type='interior'; the walk controller's
// bodyFilter picks them up inside and drops them outside.
// ============================================================

import * as THREE from 'three';
import { scene } from '../scene.js';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { collisionRegistry } from './collision.js';

// ---- Interior-specific materials ----
const MAT = {
  opaque: new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.9, metalness: 0.02 }),
  metal:  new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.4, metalness: 0.7 }),
  glass:  new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.1, metalness: 0.2, envMapIntensity: 1.5 }),
  // The lit face of a fitting. Emissive so a lamp reads as the source of its
  // own pool of light rather than as a pale disc that happens to be bright.
  glow:   new THREE.MeshStandardMaterial({
    vertexColors: true, roughness: 0.5, metalness: 0,
    emissive: 0xffd9a0, emissiveIntensity: 0.9,
  }),
};

const WALL_THICK = 0.15;
// The room's floor datum.
//
// The building's exterior plinth is 0.42 m tall and runs right under this
// room, so a floor whose surface sat at 0.40 was buried 20 mm beneath it and
// the timber never rendered — the pale stone of the plinth showed instead.
// Everything in the room is keyed to this value, so raising it lifts the
// floor clear and carries the furniture with it.
const FLOOR_Y = 0.42;
// The storey the exterior actually has. FAMILY.civic in facades.js gives this
// building a 5.1 m ground floor on a 3.9 m bay with 0.62 m piers; the room
// inside is set out from the same numbers so the two agree.
const CEIL_Y = 4.95;
const CIVIC_PIER = 0.62;
const BAYS = 3;
const PLAYER_HEIGHT = 2.05;

// ============================================================
// PALETTE
//
// Four material families, each with its own value range: plaster (walls),
// stone (base, columns, trim), timber (floor, furniture) and the hall's
// green accent. Keeping them apart in value is what stops an interior
// collapsing into one beige field under ambient light.
// ============================================================

const PALETTE = {
  // Plaster
  wall:       0xd9d4c4,
  wallPanel:  0xe7e2d2,
  wallSunk:   0xbcb7a4,
  frieze:     0xe8e3d4,
  // Stone
  base:       0x9aa09a,
  baseCap:    0xb9beb6,
  dado:       0xc6c2b2,
  cornice:    0xeeeade,
  trim:       0xece7d9,
  trimHi:     0xf6f2e6,
  pilaster:   0xeae5d7,
  reveal:     0xc2beae,
  column:     0xe6e1d3,
  colBase:    0xb6bbb2,
  colFlute:   0xd2cec0,
  sill:       0xe9e4d6,
  apron:      0xcdc8b8,
  thresh:     0x8f9490,
  // Ceiling
  ceil:       0xe4dfd0,
  coffer:     0xd8d3c4,
  beam:       0xc3bfae,
  beamLt:     0xdcd7c8,
  // Floor
  floor:      0x8a6a42,
  floorLine:  0x775431,
  floorBorder:0x6d5133,
  runner:     0x3c5a40,
  runnerEdge: 0x4c6c4d,
  mat:        0x3f5c45,
  matEdge:    0x6a8468,
  // Timber
  timber:     0xa07f56,
  timberLt:   0xba9668,
  timberDk:   0x7d6142,
  // Casework
  case_:      0x9c7d55,
  caseDark:   0x6f5739,
  caseSunk:   0x8a6c49,
  counterTop: 0xd6cdb8,
  cork:       0x8a7350,
  platRiser:  0x84683f,
  platDeck:   0xb59468,
  platNose:   0xcaa87a,
  // Accent
  accent:     0x3f7050,
  accentDark: 0x2f5a3f,
  // Fittings
  frame:      0x9aa1a0,
  shade:      0xf0ead8,
  lamp:       0xffe6bc,
  glass:      0x7fa3b2,
  // Planting
  pot:        0xb8b0a0,
  potDark:    0x8b8478,
  soil:       0x4a3e2e,
  leaf:       0x5f9048,
  leafDk:     0x497339,
  // Paper
  note1: 0xeee8d6, note2: 0xdce6cc, note3: 0xece0c6, note4: 0xe2e8dc,
  book1: 0x8a6a4a, book2: 0x5d5344, book3: 0xa8875f,
  book4: 0x4f6b4a, book5: 0x94704e, book6: 0x6b6152,
};

// ============================================================
// INTERIOR DEFINITION
// ============================================================

export const LOUNGE_INTERIOR = {
  id: 'lounge',
  name: 'Community Hall',
  buildingTag: 'b@-44.5,-8.5',

  // Building bounds (civic corner building, SE corner of block (0,1),
  // east entrance facing the central park).  Runtime collision data:
  //   body x[-51.6,-37.3] z[-15.5,-1.6], plinth east gap z[-9.1,-7.9]
  bounds: {
    minX: -51.6, maxX: -37.3,
    minZ: -15.5, maxZ: -1.6,
    cx: -44.45, cz: -8.55,
    w: 14.31, d: 13.91,
  },

  entry: { x: -40.5, z: -8.55, y: PLAYER_HEIGHT },
  exit: { x: -36.3, z: -8.55, y: PLAYER_HEIGHT },
  exitDoor: { x: -37.45, z: -8.55 },
  entrance: { x: -36.3, z: -8.55 },
};

// ============================================================
// LOCAL GEOMETRY ACCUMULATOR (separate from town-wide buckets)
// ============================================================

const buckets = { opaque: [], metal: [], glass: [], glow: [] };
const _c = new THREE.Color();

function ipart(geo, bucket, color, opt = {}) {
  const { ao = 1, jitter = 0, at } = opt;
  if (geo.index) { const f = geo.toNonIndexed(); geo.dispose(); geo = f; }
  if (at) geo.translate(at[0], at[1], at[2]);
  _c.set(color);
  const j = jitter ? 1 + (Math.random() - 0.5) * 2 * jitter : 1;
  const r = _c.r * ao * j, g = _c.g * ao * j, b = _c.b * ao * j;
  const pos = geo.attributes.position;
  const n = pos.count;
  const col = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    col[i * 3] = r; col[i * 3 + 1] = g; col[i * 3 + 2] = b;
  }
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  if (!geo.attributes.uv) {
    geo.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(n * 2), 2));
  }
  buckets[bucket].push(geo);
  return geo;
}

function islab(bucket, color, w, h, d, x, y, z, opt = {}) {
  const g = new THREE.BoxGeometry(w, h, d);
  return ipart(g, bucket, color, { ...opt, at: [x, y, z] });
}

function mergeBuckets(group) {
  for (const key of Object.keys(buckets)) {
    const list = buckets[key];
    if (!list.length) continue;
    const merged = mergeGeometries(list, false);
    list.forEach(g => g.dispose());
    buckets[key] = [];
    if (!merged) continue;
    merged.computeBoundingSphere();
    const mesh = new THREE.Mesh(merged, MAT[key]);
    mesh.name = `interior-${key}`;
    mesh.castShadow = key !== 'glow';
    mesh.receiveShadow = true;
    mesh.frustumCulled = false;
    group.add(mesh);
  }
}

// ============================================================
// STATE
// ============================================================

let interiorGroup = null;
let currentId = null;
let _renderer = null;
let _sceneRef = null;

export function setInteriorContext(renderer, sceneRef) {
  _renderer = renderer;
  _sceneRef = sceneRef;
}

export function getInteriorGroup() { return interiorGroup; }

// ============================================================
// BUILD
// ============================================================

export function buildInteriors() {
  interiorGroup = new THREE.Group();
  interiorGroup.name = 'interiors';

  buildLounge();
  registerLoungeCollision();
  buildInteriorLights();

  mergeBuckets(interiorGroup);
  interiorGroup.visible = false;
  scene.add(interiorGroup);
  return interiorGroup;
}

/**
 * Interior lighting, in a deliberate hierarchy.
 *
 *   1. DAYLIGHT is the loudest thing in the room and it comes from the east
 *      windows, so the frontage end is bright and the platform end is not.
 *   2. AMBIENT and bounce fill the rest, kept low enough that the falloff
 *      from window to back wall is actually visible.
 *   3. FIXTURES are local: two pendants over the seating, each a small warm
 *      pool with its own emissive shade.
 *
 * The previous version inverted this — a heavy ambient plus a heavy
 * hemisphere flattened everything to one beige value, and the windows might
 * as well not have been there. Six lights total, which is what the room can
 * afford in a forward renderer.
 */
function buildInteriorLights() {
  if (!interiorGroup) return;
  const B = LOUNGE_INTERIOR.bounds;

  // 1. Daylight through the frontage.
  const day = new THREE.DirectionalLight(0xe8f0f4, 0.95);
  day.name = 'int-day';
  day.position.set(B.maxX + 16, 7.5, B.cz + 5);
  day.target.position.set(B.minX + 3, 0.6, B.cz - 1);
  interiorGroup.add(day);
  interiorGroup.add(day.target);

  // Spill at each window, so the light has a source you can point at.
  for (const dz of [-4.53, 4.53]) {
    const spill = new THREE.PointLight(0xdcebf2, 0.80, 10, 2);
    spill.name = 'int-spill';
    spill.position.set(B.maxX - 1.5, 2.5, B.cz + dz);
    interiorGroup.add(spill);
  }

  // 2. Fill, kept modest so the room keeps its gradient.
  const ambient = new THREE.AmbientLight(0xe8ece8, 0.26);
  ambient.name = 'int-ambient';
  interiorGroup.add(ambient);

  const bounce = new THREE.HemisphereLight(0xf6efdd, 0x9b9282, 1.15);
  bounce.name = 'int-bounce';
  bounce.position.set(B.cx, CEIL_Y, B.cz);
  interiorGroup.add(bounce);

  // A low raking light down the length of the room. Without it the side
  // walls have no directional component at all, and mouldings with no
  // grazing light on them are mouldings you cannot see.
  const rake = new THREE.DirectionalLight(0xf2ece0, 0.42);
  rake.name = 'int-rake';
  rake.position.set(B.maxX + 4, 3.2, B.cz + 16);
  rake.target.position.set(B.minX, 1.6, B.cz - 4);
  interiorGroup.add(rake);
  interiorGroup.add(rake.target);

  // 3. Fixtures.
  for (const dx of [0.9, -6.6]) {
    const pend = new THREE.PointLight(0xffd39a, 1.55, 9.5, 2);
    pend.name = 'int-pendant';
    pend.position.set(B.cx + dx, CEIL_Y - 1.75, B.cz);
    interiorGroup.add(pend);
  }
}

function buildLounge() {
  const def = LOUNGE_INTERIOR;
  const B = def.bounds;
  const cx = B.cx, cz = B.cz;

  // ---- Shell, set out from the SAME numbers as the exterior ----
  //
  // The building outside is a `civic` family block: 5.1 m ground storey on a
  // 3.9 m structural bay with 0.62 m piers (see facades.js FAMILY.civic).
  // Every rhythm in this room is taken from those figures — the bay lines
  // the beams sit on, the pilasters on the walls, the window centres — so
  // the structure a player sees inside is the structure they saw outside.
  const innerX0 = B.minX + WALL_THICK;
  const innerX1 = B.maxX - WALL_THICK;
  const innerZ0 = B.minZ + WALL_THICK;
  const innerZ1 = B.maxZ - WALL_THICK;
  const iw = innerX1 - innerX0;
  const id_ = innerZ1 - innerZ0;
  const bayW = id_ / BAYS;

  // Bay LINES — the two interior structural lines. Beams sit on them,
  // columns stand under them, pilasters answer them on the walls.
  const bayLines = [innerZ0 + bayW, innerZ0 + 2 * bayW];

  const solids = [];
  const solid = (mnx, mxx, mnz, mxz, tag) => solids.push({ mnx, mxx, mnz, mxz, tag });
  def._solids = solids;

  const P = PALETTE;

  // ---- Floor ----
  // A boarded field with a plain border, and a runner down the aisle. The
  // border stops the boards dying into the skirting, and the runner is what
  // tells a player where to walk before anyone explains it.
  islab('opaque', P.floor, iw, 0.10, id_, cx, FLOOR_Y, cz, { jitter: 0.01 });
  for (let z = innerZ0 + 0.5; z < innerZ1 - 0.2; z += 0.62) {
    islab('opaque', P.floorLine, iw - 1.6, 0.012, 0.03, cx, FLOOR_Y + 0.056, z, { jitter: 0.04 });
  }
  // Border band
  for (const e of [-1, 1]) {
    islab('opaque', P.floorBorder, iw, 0.014, 0.55, cx, FLOOR_Y + 0.057, cz + e * (id_ / 2 - 0.28));
    islab('opaque', P.floorBorder, 0.55, 0.014, id_, cx + e * (iw / 2 - 0.28), FLOOR_Y + 0.057, cz);
  }
  // Aisle runner, from the threshold to the platform step
  islab('opaque', P.runner, iw - 4.6, 0.018, 1.5, cx - 0.4, FLOOR_Y + 0.062, cz, { jitter: 0.015 });
  islab('opaque', P.runnerEdge, iw - 4.6, 0.02, 0.08, cx - 0.4, FLOOR_Y + 0.064, cz - 0.75);
  islab('opaque', P.runnerEdge, iw - 4.6, 0.02, 0.08, cx - 0.4, FLOOR_Y + 0.064, cz + 0.75);

  // ---- Ceiling: coffers between transverse beams ----
  islab('opaque', P.ceil, iw, 0.12, id_, cx, CEIL_Y, cz, { jitter: 0.01 });
  const beamDrop = 0.34, beamW = 0.42;
  for (const bz of bayLines) {
    islab('opaque', P.beam, iw, beamDrop, beamW, cx, CEIL_Y - beamDrop / 2 - 0.06, bz, { jitter: 0.015 });
    islab('opaque', P.beamLt, iw, 0.06, beamW + 0.14, cx, CEIL_Y - beamDrop - 0.03, bz);
  }
  // Longitudinal ribs, shallower than the beams they cross.
  for (const rx of [cx - 3.7, cx + 3.7]) {
    islab('opaque', P.beam, 0.30, 0.22, id_, rx, CEIL_Y - 0.17, cz, { jitter: 0.015 });
  }
  // Recessed coffer panels, one per compartment.
  const zEdges = [innerZ0, bayLines[0], bayLines[1], innerZ1];
  for (let i = 0; i < 3; i++) {
    const z0 = zEdges[i] + (i === 0 ? 0.3 : beamW / 2 + 0.12);
    const z1 = zEdges[i + 1] - (i === 2 ? 0.3 : beamW / 2 + 0.12);
    for (const [xa, xb] of [[innerX0 + 0.35, cx - 3.85], [cx - 3.55, cx + 3.55], [cx + 3.85, innerX1 - 0.35]]) {
      islab('opaque', P.coffer, xb - xa, 0.05, z1 - z0, (xa + xb) / 2, CEIL_Y - 0.10, (z0 + z1) / 2,
            { jitter: 0.02, ao: 0.93 });
    }
  }

  // ---- Walls: base, panelled field, frieze, cornice ----
  dressWall('x', innerZ0, +1, innerX0, innerX1, bayLines, P);
  dressWall('x', innerZ1, -1, innerX0, innerX1, bayLines, P);
  dressWall('z', innerX0, +1, innerZ0, innerZ1, bayLines, P);

  // ---- East wall: the park frontage ----
  const eastSlab = (z0, z1, y0, y1, col) => {
    if (z1 - z0 < 0.01 || y1 - y0 < 0.01) return;
    islab('opaque', col || P.wall, WALL_THICK, y1 - y0, z1 - z0,
          innerX1, (y0 + y1) / 2, (z0 + z1) / 2, { jitter: 0.012 });
  };

  const openW = bayW - CIVIC_PIER;
  const sillY = FLOOR_Y + 0.62;
  const headY = CEIL_Y - 0.92;
  const doorBay = Math.floor(BAYS / 2);
  const DH = 1.55;
  const doorZ0 = cz - DH, doorZ1 = cz + DH;
  const doorTop = FLOOR_Y + 2.75;

  const openings = [];
  let cursorZ = innerZ0;
  for (let i = 0; i < BAYS; i++) {
    const bz = innerZ0 + (i + 0.5) * bayW;
    const z0 = bz - openW / 2, z1 = bz + openW / 2;
    eastSlab(cursorZ, z0, 0, CEIL_Y);
    if (i === doorBay) {
      eastSlab(z0, doorZ0, 0, CEIL_Y);
      eastSlab(doorZ0, doorZ1, doorTop, CEIL_Y);
      eastSlab(doorZ1, z1, 0, CEIL_Y);
    } else {
      eastSlab(z0, z1, 0, sillY);
      eastSlab(z0, z1, headY, CEIL_Y);
      openings.push({ z0, z1, bz });
    }
    cursorZ = z1;
  }
  eastSlab(cursorZ, innerZ1, 0, CEIL_Y);
  // East wall base and frieze, matching the other three.
  islab('opaque', P.base, WALL_THICK + 0.10, 0.26, id_, innerX1 - 0.05, FLOOR_Y + 0.18, cz);
  islab('opaque', P.baseCap, WALL_THICK + 0.14, 0.05, id_, innerX1 - 0.07, FLOOR_Y + 0.33, cz);
  islab('opaque', P.frieze, WALL_THICK + 0.08, 0.20, id_, innerX1 - 0.04, CEIL_Y - 0.62, cz);
  islab('opaque', P.cornice, WALL_THICK + 0.16, 0.13, id_, innerX1 - 0.08, CEIL_Y - 0.42, cz);
  // Pilasters between the openings, answering the exterior piers.
  for (let i = 0; i <= BAYS; i++) {
    const bz = innerZ0 + i * bayW;
    const w = (i === 0 || i === BAYS) ? 0.5 : CIVIC_PIER;
    islab('opaque', P.pilaster, 0.22, CEIL_Y - 0.62 - FLOOR_Y, w, innerX1 - 0.18,
          FLOOR_Y + (CEIL_Y - 0.62 - FLOOR_Y) / 2, bz, { jitter: 0.015 });
    islab('opaque', P.trim, 0.30, 0.12, w + 0.16, innerX1 - 0.22, CEIL_Y - 0.68, bz);
  }

  // ---- Structure: four columns on the bay lines, flanking the seating ----
  //
  // They stand where the beams above them land, clear of the platform and
  // clear of the benches. A column that meets nothing overhead is a post;
  // these carry the transverse beams, which is what makes the room read as
  // built rather than decorated.
  const colX = [cx - 2.75, cx + 3.6];
  for (const px of colX) {
    for (const bz of bayLines) {
      buildColumn(px, bz, P);
      solid(px - 0.31, px + 0.31, bz - 0.31, bz + 0.31, 'hall-column');
    }
  }

  // ---- Windows ----
  def._panes = [];
  for (const o of openings) buildWindow(o, innerX1, sillY, headY, P, def);

  // ---- Doorway, seen from inside ----
  buildDoorway(innerX1, cz, DH, doorTop, P);

  // ---- Pendants ----
  for (const [lx, lz] of [[cx + 0.9, cz], [innerX0 + 2.9, cz]]) buildPendant(lx, lz, P);

  // ---- Programme ----
  buildHallFurniture(cx, cz, innerX0, innerX1, innerZ0, innerZ1, bayLines, P, solid);
}

// ============================================================
// WALL DRESSING
// ============================================================

/**
 * Give a wall architectural depth.
 *
 * A wall in a civic room is not one surface: it is a base that takes wear, a
 * panelled field at body height, a frieze above door height and a cornice
 * where it meets the ceiling. Built as one flat plane, four metres of
 * unbroken colour reads as a backdrop and no amount of lighting fixes it.
 *
 * DEPTHS ARE MEASURED FROM THE WALL'S INNER FACE, not from its centre line.
 * Measured from the centre, every moulding thinner than the wall ends up
 * buried inside it — which is exactly what happened here first time round,
 * and why three of these walls stayed perfectly flat.
 *
 * Panels are a raised surround with a darker field inside rather than a cut
 * recess: on a solid wall that reads the same way and costs four thin strips
 * instead of a hole.
 *
 * @param {'x'|'z'} runAxis  the axis the wall runs along
 * @param {number} fixed     the wall plane's coordinate on the other axis
 * @param {number} inward    +1 or -1, the direction into the room
 */
function dressWall(runAxis, fixed, inward, from, to, bayLines, P) {
  const alongX = runAxis === 'x';
  const len = to - from;
  const mid = (from + to) / 2;
  const face = fixed + inward * WALL_THICK;   // the inner face of the wall

  // Field
  if (alongX) islab('opaque', P.wall, len, CEIL_Y, WALL_THICK, mid, CEIL_Y / 2, fixed + inward * WALL_THICK / 2, { jitter: 0.012 });
  else        islab('opaque', P.wall, WALL_THICK, CEIL_Y, len, fixed + inward * WALL_THICK / 2, CEIL_Y / 2, mid, { jitter: 0.012 });

  /** Place a moulding projecting `proj` into the room from the inner face. */
  const put = (col, u, y, proj, su, sh, opt) => {
    const sd = proj + 0.05;                    // a little embedded in the wall
    const at = face + inward * (proj - sd / 2 + 0.025);
    if (alongX) islab('opaque', col, su, sh, sd, u, y, at, opt);
    else        islab('opaque', col, sd, sh, su, at, y, u, opt);
  };

  // Base, cap, dado, frieze, cornice
  put(P.base,    mid, FLOOR_Y + 0.19, 0.105, len, 0.30);
  put(P.baseCap, mid, FLOOR_Y + 0.37, 0.145, len, 0.07);
  put(P.dado,    mid, FLOOR_Y + 1.04, 0.115, len, 0.10);
  put(P.frieze,  mid, CEIL_Y - 0.60,  0.085, len, 0.24);
  put(P.cornice, mid, CEIL_Y - 0.40,  0.185, len, 0.17);

  // Pilasters on the structural lines, plus one at each end. The long walls
  // get the same count as the frontage so all four read to one rhythm.
  const lines = alongX
    ? [from + 0.34, from + (len * 1) / 3, from + (len * 2) / 3, to - 0.34]
    : [from + 0.34, ...bayLines, to - 0.34];
  for (const u of lines) {
    put(P.pilaster, u, FLOOR_Y + (CEIL_Y - 0.60 - FLOOR_Y) / 2, 0.175, 0.54, CEIL_Y - 0.60 - FLOOR_Y, { jitter: 0.015 });
    put(P.trim,     u, CEIL_Y - 0.70, 0.225, 0.70, 0.14);          // capital
    put(P.trim,     u, FLOOR_Y + 0.44, 0.225, 0.68, 0.11);         // plinth block
  }

  // Panelled field between the pilasters.
  //
  // Each bay is subdivided into panels of roughly 1.8 m. Left as one panel
  // per bay they came out over six metres wide, which from anywhere in the
  // room means looking at the middle of a single flat field with its frame
  // somewhere off to the sides — indistinguishable from an undressed wall.
  for (let i = 0; i < lines.length - 1; i++) {
    const a = lines[i] + 0.34, b = lines[i + 1] - 0.34;
    const span = b - a;
    if (span < 0.7) continue;
    const n = Math.max(1, Math.round(span / 1.8));
    const pw = span / n;
    for (let k = 0; k < n; k++) {
      const u = a + (k + 0.5) * pw;
      const w = pw - 0.16;
      if (w < 0.4) continue;
      panel(put, P, u, FLOOR_Y + 1.18, CEIL_Y - 0.80, w);   // above the dado
      panel(put, P, u, FLOOR_Y + 0.52, FLOOR_Y + 0.94, w);  // below it
      // A slim muntin between panels, so the divisions read as joinery.
      if (k < n - 1) {
        put(P.wallPanel, a + (k + 1) * pw, FLOOR_Y + 1.18 + (CEIL_Y - 0.80 - FLOOR_Y - 1.18) / 2,
            0.115, 0.10, CEIL_Y - 0.80 - FLOOR_Y - 1.18);
      }
    }
  }
}

/** A raised surround with a darker field inside it. */
function panel(put, P, u, y0, y1, w) {
  const h = y1 - y0, yc = (y0 + y1) / 2;
  const t = 0.09;
  put(P.wallSunk, u, yc, 0.030, w, h, { ao: 0.84, jitter: 0.02 });   // sunk field
  put(P.wallPanel, u, y1 - t / 2, 0.115, w, t);                      // head
  put(P.wallPanel, u, y0 + t / 2, 0.115, w, t);                      // foot
  put(P.wallPanel, u - w / 2 + t / 2, yc, 0.115, t, h);              // left stile
  put(P.wallPanel, u + w / 2 - t / 2, yc, 0.115, t, h);              // right stile
}

/** A column: base, shaft with a slight taper expressed as a band, capital. */
function buildColumn(x, z, P) {
  const shaftH = CEIL_Y - 0.62 - FLOOR_Y;
  islab('opaque', P.colBase, 0.62, 0.10, 0.62, x, FLOOR_Y + 0.10, z);
  islab('opaque', P.colBase, 0.54, 0.16, 0.54, x, FLOOR_Y + 0.23, z);
  islab('opaque', P.column, 0.44, shaftH - 0.6, 0.44, x, FLOOR_Y + 0.31 + (shaftH - 0.6) / 2, z,
        { jitter: 0.015 });
  // Shallow flutes: two strips per face, enough to catch a highlight.
  for (const e of [-1, 1]) {
    islab('opaque', P.colFlute, 0.06, shaftH - 0.9, 0.46, x + e * 0.12, FLOOR_Y + 0.42 + (shaftH - 0.9) / 2, z, { ao: 0.9 });
    islab('opaque', P.colFlute, 0.46, shaftH - 0.9, 0.06, x, FLOOR_Y + 0.42 + (shaftH - 0.9) / 2, z + e * 0.12, { ao: 0.9 });
  }
  // Capital
  islab('opaque', P.colBase, 0.54, 0.12, 0.54, x, FLOOR_Y + shaftH - 0.20, z);
  islab('opaque', P.trim, 0.66, 0.12, 0.66, x, FLOOR_Y + shaftH - 0.08, z);
}

/**
 * A window: splayed reveal, sill with a nosing, apron, architrave, and a
 * frame divided by one mullion and one transom.
 */
function buildWindow(o, wallX, sillY, headY, P, def) {
  const w = o.z1 - o.z0;
  const h = headY - sillY;
  const cz = o.bz;

  // Reveal — the thickness of the wall, seen edge-on through the opening.
  for (const e of [-1, 1]) {
    islab('opaque', P.reveal, WALL_THICK * 0.96, h, 0.10,
          wallX - 0.004, (sillY + headY) / 2, cz + e * (w / 2 - 0.05), { ao: 0.82 });
  }
  islab('opaque', P.reveal, WALL_THICK * 0.96, 0.10, w, wallX - 0.004, headY - 0.05, cz, { ao: 0.74 });

  // Architrave around the opening, on the room face.
  islab('opaque', P.trim, 0.13, h + 0.44, 0.17, wallX - 0.10, (sillY + headY) / 2 + 0.1, cz - w / 2 - 0.08);
  islab('opaque', P.trim, 0.13, h + 0.44, 0.17, wallX - 0.10, (sillY + headY) / 2 + 0.1, cz + w / 2 + 0.08);
  islab('opaque', P.trim, 0.14, 0.17, w + 0.5, wallX - 0.11, headY + 0.20, cz);
  islab('opaque', P.trimHi, 0.17, 0.07, w + 0.62, wallX - 0.13, headY + 0.32, cz);

  // Sill: a board with a nosing, and an apron under it.
  islab('opaque', P.sill, 0.40, 0.08, w + 0.30, wallX - 0.19, sillY - 0.02, cz);
  islab('opaque', P.trimHi, 0.46, 0.04, w + 0.38, wallX - 0.22, sillY - 0.08, cz);
  islab('opaque', P.apron, 0.10, 0.22, w - 0.10, wallX - 0.10, sillY - 0.22, cz, { jitter: 0.02 });

  // Frame: jambs, head, transom and a single mullion.
  const fx = wallX - 0.085;
  islab('metal', P.frame, 0.07, h, 0.09, fx, (sillY + headY) / 2, cz - w / 2 + 0.05);
  islab('metal', P.frame, 0.07, h, 0.09, fx, (sillY + headY) / 2, cz + w / 2 - 0.05);
  islab('metal', P.frame, 0.07, 0.09, w, fx, headY - 0.05, cz);
  islab('metal', P.frame, 0.07, 0.09, w, fx, sillY + 0.05, cz);
  islab('metal', P.frame, 0.065, h, 0.075, fx, (sillY + headY) / 2, cz);      // mullion
  islab('metal', P.frame, 0.065, 0.075, w, fx, sillY + h * 0.62, cz);          // transom

  def._panes.push({ z0: o.z0, z1: o.z1, y0: sillY, y1: headY, cz });
}

/**
 * The doorway from inside.
 *
 * No leaf here: the door itself belongs to the exterior entrance, whose
 * recess is hollow for this building, so one door serves both sides. What
 * the room owns is the opening — its reveal, architrave, entablature and
 * the fanlight over it.
 */
function buildDoorway(wallX, cz, DH, doorTop, P) {
  const h = doorTop - FLOOR_Y;
  for (const e of [-1, 1]) {
    islab('opaque', P.reveal, WALL_THICK * 0.96, h + 0.55, 0.13,
          wallX - 0.004, FLOOR_Y + (h + 0.55) / 2, cz + e * (DH - 0.065), { ao: 0.8 });
    // Architrave
    islab('opaque', P.trim, 0.15, h + 0.78, 0.20, wallX - 0.11, FLOOR_Y + (h + 0.78) / 2, cz + e * (DH + 0.14));
    islab('opaque', P.trimHi, 0.19, h + 0.78, 0.07, wallX - 0.14, FLOOR_Y + (h + 0.78) / 2, cz + e * (DH + 0.26));
  }
  islab('opaque', P.reveal, WALL_THICK * 0.96, 0.13, DH * 2, wallX - 0.004, doorTop + 0.49, cz, { ao: 0.72 });

  // Entablature over the door: a lintel, a frieze band and a cornice shelf.
  islab('opaque', P.trim, 0.15, 0.20, DH * 2 + 0.55, wallX - 0.11, doorTop + 0.72, cz);
  islab('opaque', P.frieze, 0.13, 0.22, DH * 2 + 0.40, wallX - 0.10, doorTop + 0.93, cz);
  islab('opaque', P.trimHi, 0.20, 0.09, DH * 2 + 0.70, wallX - 0.14, doorTop + 1.08, cz);

  // Fanlight, divided by three slim bars.
  islab('glass', P.glass, 0.05, 0.40, DH * 2 - 0.10, wallX - 0.115, doorTop + 0.26, cz, { jitter: 0.03 });
  islab('metal', P.frame, 0.065, 0.06, DH * 2 - 0.10, wallX - 0.135, doorTop + 0.06, cz);
  islab('metal', P.frame, 0.065, 0.06, DH * 2 - 0.10, wallX - 0.135, doorTop + 0.46, cz);
  for (const e of [-1, 0, 1]) {
    islab('metal', P.frame, 0.06, 0.40, 0.055, wallX - 0.135, doorTop + 0.26, cz + e * 0.72);
  }

  // Threshold and mat: the outside step repeated inside.
  islab('opaque', P.thresh, 0.42, 0.04, DH * 2 + 0.2, wallX - 0.24, FLOOR_Y + 0.072, cz);
  islab('opaque', P.mat, 1.7, 0.03, DH * 2 - 0.5, wallX - 1.25, FLOOR_Y + 0.066, cz, { jitter: 0.02 });
  islab('opaque', P.matEdge, 1.82, 0.02, DH * 2 - 0.36, wallX - 1.25, FLOOR_Y + 0.058, cz);
}

/** Pendant: rod, canopy, shade, and a lit disc inside it. */
function buildPendant(x, z, P) {
  const dropTo = CEIL_Y - 1.42;
  islab('opaque', P.trim, 0.26, 0.07, 0.26, x, CEIL_Y - 0.13, z);
  islab('metal', P.frame, 0.045, CEIL_Y - 0.16 - dropTo, 0.045, x, (CEIL_Y - 0.16 + dropTo) / 2, z);
  const cone = new THREE.ConeGeometry(0.52, 0.40, 12);
  cone.rotateX(Math.PI);
  cone.translate(x, dropTo + 0.20, z);
  ipart(cone, 'opaque', P.shade, { jitter: 0.015 });
  const rim = new THREE.CylinderGeometry(0.53, 0.53, 0.05, 12);
  rim.translate(x, dropTo + 0.02, z);
  ipart(rim, 'metal', P.frame);
  islab('glow', P.lamp, 0.40, 0.05, 0.40, x, dropTo + 0.06, z);
}

/**
 * The room's contents.
 *
 * Every piece is the one that was already here — platform, lectern, benches,
 * counter, noticeboard, shelves, planting — rebuilt with the parts that make
 * furniture read as furniture: legs rather than end slabs, aprons under
 * seats, nosings on edges, plinths under casework. The layout is unchanged,
 * because the layout was already saying the right thing.
 */
function buildHallFurniture(cx, cz, x0, x1, z0, z1, bayLines, P, solid) {
  // ---- Platform at the closed end ----
  const platX = x0 + 2.4, platH = 0.42;
  const platHW = 1.5, platHD = 3.6;
  const platY = FLOOR_Y + 0.05;
  // Riser, recessed under an overhanging deck, so the deck reads as a lid.
  islab('opaque', P.platRiser, platHW * 2 - 0.16, platH, platHD * 2 - 0.16,
        platX, platY + platH / 2, cz, { jitter: 0.015 });
  islab('opaque', P.platDeck, platHW * 2, 0.09, platHD * 2, platX, platY + platH + 0.045, cz,
        { jitter: 0.015 });
  islab('opaque', P.platNose, platHW * 2 + 0.06, 0.04, platHD * 2 + 0.06, platX, platY + platH - 0.005, cz);
  // A single step up at the front, on the aisle.
  islab('opaque', P.platRiser, 0.42, platH / 2, 1.7, platX + platHW + 0.21, platY + platH / 4, cz);
  islab('opaque', P.platDeck, 0.48, 0.07, 1.76, platX + platHW + 0.21, platY + platH / 2 + 0.035, cz);
  solid(platX - platHW, platX + platHW + 0.45, cz - platHD, cz + platHD, 'hall-platform');

  // Panelled back wall behind the platform, in the hall's accent.
  islab('opaque', P.accentDark, 0.12, 2.6, platHD * 2, x0 + 0.30, FLOOR_Y + 1.75, cz, { jitter: 0.02 });
  for (let i = -1; i <= 1; i++) {
    islab('opaque', P.accent, 0.07, 2.1, 1.7, x0 + 0.37, FLOOR_Y + 1.75, cz + i * 2.0, { jitter: 0.03 });
    islab('opaque', P.trim, 0.09, 0.07, 1.86, x0 + 0.39, FLOOR_Y + 2.84, cz + i * 2.0);
    islab('opaque', P.trim, 0.09, 0.07, 1.86, x0 + 0.39, FLOOR_Y + 0.66, cz + i * 2.0);
  }

  // ---- Lectern ----
  const lx = platX + 0.85, lz = cz - 1.9, lTop = platY + platH + 0.09;
  islab('opaque', P.timberDk, 0.46, 0.08, 0.38, lx, lTop + 0.04, lz);            // foot
  islab('opaque', P.timber, 0.20, 0.86, 0.18, lx, lTop + 0.51, lz);              // shaft
  islab('opaque', P.timberDk, 0.34, 0.07, 0.30, lx, lTop + 0.97, lz);            // collar
  const desk = new THREE.BoxGeometry(0.50, 0.06, 0.40);
  desk.rotateZ(-0.22);
  desk.translate(lx, lTop + 1.10, lz);
  ipart(desk, 'opaque', P.timberLt, { jitter: 0.02 });
  islab('opaque', P.timberDk, 0.52, 0.04, 0.05, lx + 0.02, lTop + 1.04, lz + 0.19);  // book stop
  solid(lx - 0.3, lx + 0.3, lz - 0.28, lz + 0.28, 'hall-lectern');

  // ---- Benches: four rows either side of the aisle ----
  for (let r = 0; r < 4; r++) {
    const bx = platX + 2.9 + r * 1.42;
    for (const s of [-1, 1]) {
      buildBench(bx, cz + s * 1.95, P);
      solid(bx - 0.30, bx + 0.30, cz + s * 1.95 - 1.68, cz + s * 1.95 + 1.68, 'hall-bench-' + r + s);
    }
  }

  // ---- Counter beside the door ----
  const coX = x1 - 2.4, coZ = cz - 4.5, coH = 1.06, coL = 3.0;
  islab('opaque', P.caseDark, 0.72, 0.12, coL - 0.14, coX, FLOOR_Y + 0.11, coZ);          // plinth
  islab('opaque', P.case_, 0.80, coH - 0.22, coL, coX, FLOOR_Y + 0.17 + (coH - 0.22) / 2, coZ,
        { jitter: 0.015 });
  // Two recessed panels on the public face.
  for (const e of [-1, 1]) {
    islab('opaque', P.caseSunk, 0.05, coH - 0.52, coL / 2 - 0.34, coX + 0.40,
          FLOOR_Y + 0.17 + (coH - 0.22) / 2, coZ + e * coL / 4, { ao: 0.9 });
  }
  islab('opaque', P.counterTop, 0.94, 0.07, coL + 0.14, coX, FLOOR_Y + coH, coZ);         // top
  islab('opaque', P.trimHi, 0.98, 0.03, coL + 0.18, coX, FLOOR_Y + coH - 0.045, coZ);     // nosing
  // Return end, so it reads as built-in rather than a free block.
  islab('opaque', P.case_, 0.80, coH - 0.22, 0.8, coX - 0.75, FLOOR_Y + 0.17 + (coH - 0.22) / 2, coZ + coL / 2 - 0.4,
        { jitter: 0.015 });
  islab('opaque', P.counterTop, 0.94, 0.07, 0.94, coX - 0.75, FLOOR_Y + coH, coZ + coL / 2 - 0.4);
  solid(coX - 1.18, coX + 0.5, coZ - coL / 2, coZ + coL / 2, 'hall-counter');

  // ---- Noticeboard ----
  const nbX = cx + 0.6, nbY = FLOOR_Y + 1.95;
  islab('opaque', P.timberDk, 3.6, 1.66, 0.09, nbX, nbY, z0 + 0.13);
  islab('opaque', P.cork, 3.3, 1.36, 0.04, nbX, nbY, z0 + 0.185, { jitter: 0.02 });
  islab('opaque', P.trim, 3.72, 0.08, 0.14, nbX, nbY + 0.87, z0 + 0.14);
  const notes = [P.note1, P.note2, P.note3, P.note4];
  for (let i = 0; i < 10; i++) {
    const nx = nbX + ((i % 5) - 2) * 0.62 + (Math.random() - 0.5) * 0.1;
    const ny = nbY - 0.34 + Math.floor(i / 5) * 0.62 + (Math.random() - 0.5) * 0.07;
    islab('opaque', notes[i % notes.length], 0.36, 0.28, 0.015, nx, ny, z0 + 0.21, { jitter: 0.03 });
    islab('metal', P.frame, 0.03, 0.03, 0.02, nx, ny + 0.15, z0 + 0.225);
  }

  // ---- Reading shelves ----
  const shZ = z1 - 0.32;
  islab('opaque', P.caseDark, 4.3, 0.12, 0.38, cx - 1.0, FLOOR_Y + 0.11, shZ);
  islab('opaque', P.case_, 4.3, 2.16, 0.34, cx - 1.0, FLOOR_Y + 1.25, shZ, { jitter: 0.015 });
  islab('opaque', P.caseSunk, 4.0, 1.9, 0.06, cx - 1.0, FLOOR_Y + 1.25, shZ - 0.16, { ao: 0.85 });
  const bookClr = [P.book1, P.book2, P.book3, P.book4, P.book5, P.book6];
  for (let s = 0; s < 3; s++) {
    const sy = FLOOR_Y + 0.55 + s * 0.58;
    islab('opaque', P.timberLt, 4.0, 0.05, 0.30, cx - 1.0, sy, shZ - 0.03);
    for (let i = 0; i < 15; i++) {
      islab('opaque', bookClr[(i * 2 + s) % bookClr.length],
            0.07 + Math.random() * 0.05, 0.23 + Math.random() * 0.13, 0.20,
            cx - 2.85 + i * 0.26 + Math.random() * 0.04, sy + 0.17, shZ - 0.05, { jitter: 0.05 });
    }
  }
  // End stiles, so the case has sides.
  for (const e of [-1, 1]) {
    islab('opaque', P.case_, 0.12, 2.16, 0.36, cx - 1.0 + e * 2.15, FLOOR_Y + 1.25, shZ);
  }
  islab('opaque', P.trim, 4.46, 0.08, 0.44, cx - 1.0, FLOOR_Y + 2.37, shZ);
  solid(cx - 3.25, cx + 1.25, shZ - 0.38, shZ + 0.24, 'hall-shelves');

  // ---- Planting ----
  for (const [px, pz] of [[x1 - 1.6, z1 - 1.7], [x1 - 1.6, z0 + 1.7], [x0 + 1.5, z1 - 1.8]]) {
    islab('opaque', P.potDark, 0.60, 0.10, 0.60, px, FLOOR_Y + 0.10, pz);
    islab('opaque', P.pot, 0.68, 0.46, 0.68, px, FLOOR_Y + 0.33, pz, { jitter: 0.02 });
    islab('opaque', P.trimHi, 0.76, 0.06, 0.76, px, FLOOR_Y + 0.59, pz);
    islab('opaque', P.soil, 0.60, 0.05, 0.60, px, FLOOR_Y + 0.60, pz);
    for (let i = 0; i < 4; i++) {
      const g = new THREE.IcosahedronGeometry(0.26 + Math.random() * 0.13, 1);
      g.scale(1, 1.4, 1);
      g.translate(px + (Math.random() - 0.5) * 0.34, FLOOR_Y + 0.92 + Math.random() * 0.4,
                  pz + (Math.random() - 0.5) * 0.34);
      ipart(g, 'opaque', i % 2 ? P.leaf : P.leafDk, { jitter: 0.07 });
    }
    solid(px - 0.42, px + 0.42, pz - 0.42, pz + 0.42, 'hall-planter');
  }
}

/**
 * A bench: four legs, an apron, a seat with a nosing, and a slatted back.
 *
 * The old version was a slab on two end blocks, which is why the seating read
 * as blocking-out. The parts below are the minimum that makes a bench a
 * bench — you can see under it, and the back is boards rather than a panel.
 */
function buildBench(x, z, P) {
  const seatY = FLOOR_Y + 0.46;
  const L = 3.25, W = 0.50;
  // Legs
  for (const e of [-1, 1]) {
    for (const f of [-1, 1]) {
      islab('opaque', P.timberDk, 0.08, seatY - FLOOR_Y - 0.04, 0.08,
            x + f * (W / 2 - 0.08), FLOOR_Y + (seatY - FLOOR_Y) / 2, z + e * (L / 2 - 0.22));
    }
  }
  // Apron rails
  for (const f of [-1, 1]) {
    islab('opaque', P.timberDk, 0.05, 0.09, L - 0.36, x + f * (W / 2 - 0.08), seatY - 0.13, z);
  }
  // Seat: two boards with a gap, and a nosing along the front.
  islab('opaque', P.timber, W * 0.46, 0.055, L, x - W * 0.26, seatY, z, { jitter: 0.02 });
  islab('opaque', P.timber, W * 0.46, 0.055, L, x + W * 0.26, seatY, z, { jitter: 0.02 });
  // Nosing on the FRONT edge — the west side, facing the platform.
  islab('opaque', P.timberLt, 0.05, 0.035, L + 0.04, x - W / 2 + 0.01, seatY + 0.012, z);

  // Back: two rails on short posts, on the EAST side of the seat.
  //
  // A bench's back is behind the sitter, so putting it on the west put the
  // whole congregation with their backs to the platform and their faces to
  // the door. The platform is at the west end of the hall; the backs belong
  // at the east end, and everything in the room — aisle, seating, lectern —
  // then points the same way.
  const backX = x + W / 2 - 0.07;
  for (const e of [-1, 0, 1]) {
    islab('opaque', P.timberDk, 0.07, 0.56, 0.07, backX, seatY + 0.30, z + e * (L / 2 - 0.30));
  }
  islab('opaque', P.timber, 0.05, 0.15, L - 0.06, backX, seatY + 0.26, z, { jitter: 0.02 });
  islab('opaque', P.timber, 0.05, 0.13, L - 0.06, backX, seatY + 0.50, z, { jitter: 0.02 });
  islab('opaque', P.timberLt, 0.06, 0.05, L, backX, seatY + 0.59, z);
}

/**
 * Collision for the room.
 *
 * The four walls stay SOLID across their full span, exactly as before: the
 * exterior shell is filtered out while the player is inside, so an opening
 * left in an interior wall would let them walk out through the building.
 * Leaving is the E key at the door, not a gap in the geometry.
 */
function registerLoungeCollision() {
  const def = LOUNGE_INTERIOR;
  const B = def.bounds;
  const innerX0 = B.minX + WALL_THICK;
  const innerX1 = B.maxX - WALL_THICK;
  const innerZ0 = B.minZ + WALL_THICK;
  const innerZ1 = B.maxZ - WALL_THICK;

  registerBody(innerX0 - WALL_THICK, innerX0 + WALL_THICK, innerZ0, innerZ1, 'hall-wall-west');
  registerBody(innerX0, innerX1, innerZ1 - WALL_THICK, innerZ1 + WALL_THICK, 'hall-wall-north');
  registerBody(innerX0, innerX1, innerZ0 - WALL_THICK, innerZ0 + WALL_THICK, 'hall-wall-south');
  registerBody(innerX1 - WALL_THICK, innerX1 + WALL_THICK, innerZ0, innerZ1, 'hall-wall-east');

  // Everything else — columns, platform, benches, counter, shelves,
  // planters — is registered from the list the builders themselves filled
  // in as they placed the geometry. Nothing here is an invented volume:
  // each body corresponds to a thing that was actually built.
  for (const s of (def._solids || [])) {
    registerBody(s.mnx, s.mxx, s.mnz, s.mxz, s.tag);
  }
}

function registerBody(minX, maxX, minZ, maxZ, tag) {
  collisionRegistry.registerBody({
    minX, maxX, minY: 0, maxY: 4.5, minZ, maxZ,
    type: 'interior', tag,
  });
}

// ============================================================
// ENTER / EXIT
// ============================================================

export function enterInterior(id) {
  if (id !== 'lounge' || !interiorGroup) return null;
  const def = LOUNGE_INTERIOR;
  interiorGroup.visible = true;
  currentId = id;
  captureWindowView();
  return { ...def.entry };
}

export function exitInterior() {
  if (!currentId || !interiorGroup) return null;
  const def = LOUNGE_INTERIOR;
  interiorGroup.visible = false;
  disposeWindowMeshes();
  if (def._renderTarget) { def._renderTarget.dispose(); def._renderTarget = null; }
  currentId = null;
  return { ...def.exit };
}

/**
 * Fill the windows with the view out of them.
 *
 * The previous version built its camera at
 *   position(_winX, _winCY, _winX + 0.5)
 * using the wall's X coordinate as a Z coordinate, so it stood roughly 30 m
 * south of the building and looked at nothing. That is why the window read
 * as a blank grey panel rather than as a window.
 *
 * One wide render is taken from the wall looking out across the park and the
 * panes each show their own slice of it. Three panes on one wall all face
 * the same way, so slicing a single frame is both cheaper than three renders
 * and very close to correct.
 */
function captureWindowView() {
  const def = LOUNGE_INTERIOR;
  if (!def._panes || !def._panes.length || !_renderer || !_sceneRef) return;

  const W = 1024, H = 512;
  const target = new THREE.WebGLRenderTarget(W, H, { samples: 4 });
  target.texture.colorSpace = _renderer.outputColorSpace;

  const B = def.bounds;
  const eyeY = FLOOR_Y + 1.7;
  // Far enough out to clear the building's own frontage. The civic
  // colonnade's columns project about 0.9 m and the entrance canopy 1.7 m,
  // so a camera set just outside the wall face ends up INSIDE a column and
  // renders the inside of a box — a flat grey panel, which is precisely what
  // the windows were showing.
  const camX = B.maxX + 3.4;
  const hFov = 96;                      // wide enough to cover all three bays

  const cam = new THREE.PerspectiveCamera(60, W / H, 0.2, 1200);
  // Vertical fov from the horizontal one, so the slice maths below is honest.
  cam.fov = 2 * Math.atan(Math.tan(hFov * Math.PI / 360) / cam.aspect) * 180 / Math.PI;
  cam.position.set(camX, eyeY, B.cz);
  // Aim below the horizon. A window at eye height mostly shows ground, road
  // and planting; pointed level, the frame fills with sky and every pane
  // reads as a flat pale panel — which is what these were doing.
  cam.lookAt(camX + 10, eyeY - 2.6, B.cz);
  cam.updateProjectionMatrix();

  const wasVisible = interiorGroup.visible;
  interiorGroup.visible = false;
  const prev = _renderer.getRenderTarget();
  _renderer.setRenderTarget(target);
  _renderer.render(_sceneRef, cam);
  _renderer.setRenderTarget(prev);
  interiorGroup.visible = wasVisible;

  // Map each pane to its own slice of the wide frame.
  //
  // The previous mapping divided a metre offset by a tangent as though it
  // were already a ratio, which sent every pane's UVs off the end of the
  // texture; clamped, they all collapsed to a single column and the windows
  // rendered as one smeared colour. Panes are now spread across the frame in
  // proportion to where they sit along the wall, which is what the single
  // wide capture is for.
  const zs = def._panes.map(q => q.cz);
  const zMin = Math.min(...zs), zMax = Math.max(...zs);
  const half = Math.max(1e-3, (zMax - zMin) / 2 + 2.2);
  const SPREAD = 0.78;
  const uOf = z => 0.5 + ((z - (zMin + zMax) / 2) / half) * 0.5 * SPREAD;

  disposeWindowMeshes();
  def._renderTarget = target;
  def._windowMeshes = [];

  for (const pane of def._panes) {
    const w = pane.z1 - pane.z0;
    const h = pane.y1 - pane.y0;
    const geo = new THREE.PlaneGeometry(w, h);
    geo.rotateY(-Math.PI / 2);          // face into the room
    const uv = geo.attributes.uv;
    const uA = Math.max(0, Math.min(1, uOf(pane.z0)));
    const uB = Math.max(0, Math.min(1, uOf(pane.z1)));
    for (let i = 0; i < uv.count; i++) {
      // Squeeze the pane's UVs into its own slice of the wide frame.
      uv.setX(i, uA + uv.getX(i) * (uB - uA));
      // Span from the near footway at the sill up to the trees and the park
      // at the head. Sat lower in the frame the panes showed nothing but
      // empty carriageway, which is a correct view of the road and a useless
      // thing to put in a window.
      uv.setY(i, 0.22 + uv.getY(i) * 0.74);
    }
    const mesh = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ map: target.texture }));
    mesh.position.set(B.maxX - WALL_THICK - 0.14, (pane.y0 + pane.y1) / 2, pane.cz);
    mesh.name = 'hall-window';
    interiorGroup.add(mesh);
    def._windowMeshes.push(mesh);
  }
}

function disposeWindowMeshes() {
  const def = LOUNGE_INTERIOR;
  for (const m of (def._windowMeshes || [])) {
    if (m.parent) m.parent.remove(m);
    m.geometry.dispose();
    m.material.dispose();
  }
  def._windowMeshes = [];
}

export function getCurrentInterior() {
  return currentId === 'lounge' ? LOUNGE_INTERIOR : null;
}