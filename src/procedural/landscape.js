// ============================================================
// LAND COVER — Phase 7 visual sanitation
//
// The Phase 7 landscape layer scattered large axis-aligned rectangles at
// random over the ground: park patches on a 40 m grid, field patches on
// a 60–100 m grid, utility strips at random points.  They overlapped
// each other, they overlapped the roads, their edges all ran
// north–south, and their sizes had nothing to do with anything.  From
// Eagle they read as translucent decals laid on grass, which is much of
// what made the world look like objects placed on a landscape rather
// than a landscape.
//
// Land cover is now a PARTITION, not a scatter.  A Voronoi diagram over
// jittered field centres divides the countryside into parcels whose
// straight irregular edges meet exactly, the way enclosed farmland does.
// Each field takes one crop colour, so a field reads as a field rather
// than as a patch, and hedgerows are planted along every boundary
// between two of them — which is what gives farmland its drawn quality
// from altitude.
//
// What a field becomes depends on the same world model everything else
// reads: development intensity decides whether land is farmed or kept as
// parkland inside a settlement, and the landform field decides where
// woodland takes the high ground.
//
// The rule the brief is most insistent about is enforced here: empty
// space is a feature.  A field is not an error, and most of the planet
// is meant to be one.
// ============================================================

import * as THREE from 'three';
import { hash2, fbm2 } from './seed.js';
import { developmentAt, BAND, reservationAt } from './settlement.js';
import { buildFarmAccess, buildDrainage, classifyBoundary, recordBoundary, buildUtilityCorridors } from './ruralinfra.js';
import { landformAt } from './terrain.js';
import { onRoad } from './roads.js';

// Field centres sit on a jittered lattice at this pitch; the Voronoi
// cells they generate are the fields.  Large enough that a field reads
// as one at altitude, small enough to give the countryside grain.
const FIELD_PITCH = 88;

const Y_COVER = 0.0025;

// ---- Palettes --------------------------------------------------------
//
// Crops are warm and varied — the variation is the point, since a single
// green is what made the old countryside read as a blank sheet.
const CROP = [
  0x9aaa6e, 0x8fa15e, 0xa8b67b, 0x7e8c50, 0x889a5a,
  0xbaa76a, 0xa39455, 0xc2b47e, 0x94a765, 0x6f8248,
];
// Pasture: cooler and closer together, so grazing land reads as calmer
// than arable and the two stay distinguishable from above.
const PASTURE = [0x84a06a, 0x7b9663, 0x8daa72, 0x759160];
const MEADOW  = [0x8fab6f, 0x9cb578, 0x85a367];
const WOOD    = [0x4f6b43, 0x577248, 0x47603c];
// Amenity green inside a settlement.  Wider and closer to the meadow and
// pasture tones than the first version, which used three near-identical
// bright greens and turned every town into a flat green disc with an
// obvious circular boundary.  The land under a town should keep the same
// grain as the land around it; what marks the settlement out from
// altitude is its roofs and streets, not a change of ground colour.
const PARK    = [0x7ba876, 0x86b07d, 0x71a06d, 0x82a374, 0x8fab77, 0x789c6e, 0x93ad7c];
// Hedges are seen edge-on from a country road as often as from above.
// The first value was dark enough that a run of them read as a black
// wall across the fields whenever the sun was behind them.
const HEDGE   = 0x5f7a4e;
const SCRUB   = [0x8a9268, 0x939a72, 0x7f8a60];

/**
 * A tree crown.
 *
 * A single tapered cylinder reads as a lampshade on a pole, which is
 * exactly what the procedural planting looked like beside Veridian Cap's
 * authored trees.  Three overlapping flattened lobes cost two more
 * primitives and read as a broadleaf canopy from the footway and as a
 * soft blob from altitude, which is what the authored planting does.
 */
function crown(key, accPart, x, y, z, r, col, jitter) {
  const LOBES = [
    [0, 0.10, 0, 1.00],
    [0.52, -0.22, 0.30, 0.68],
    [-0.46, -0.16, -0.34, 0.62],
  ];
  for (const [ox, oy, oz, sc] of LOBES) {
    const g = new THREE.SphereGeometry(1, 6, 4);
    g.scale(r * sc, r * sc * 0.82, r * sc);
    g.translate(x + ox * r, y + oy * r, z + oz * r);
    accPart(key, g, 'foliage', col, { jitter, gradeY: [y - r, y + r] });
  }
}

/** Centre of the field belonging to lattice cell (i, j). */
function fieldCentre(i, j) {
  return [
    (i + 0.15 + hash2(i * 37 + 5, j * 61 + 13) * 0.7) * FIELD_PITCH,
    (j + 0.15 + hash2(j * 43 + 7, i * 71 + 3) * 0.7) * FIELD_PITCH,
  ];
}

/**
 * The HOLDING a lattice cell belongs to.
 *
 * Cells are the unit the Voronoi diagram is built from, but a field is
 * not always one cell.  Where this low-frequency field is high, blocks
 * of four cells share one holding id: they take the same crop colour and
 * the boundary between them carries no hedge, so they read as a single
 * large field.  Everywhere else a cell is its own small enclosure.
 *
 * Without this every field on the planet came out the same size, which
 * from altitude reads as a tiling rather than as farmland.
 */
function fieldId(i, j) {
  if (fbm2(i * 0.34 + 11.3, j * 0.34 - 4.7, 2) > 0.565) {
    return (((i >> 1) * 73856093) ^ ((j >> 1) * 19349663) ^ 0x5bf03635) | 0;
  }
  return ((i * 73856093) ^ (j * 19349663)) | 0;
}

/**
 * What a piece of land is.  One function, consulted by both the cover
 * pass and the planting pass, so ground colour and trees always agree.
 */
// Reserved ground: mown, level, unplanted.  It must not read as a crop
// field or as parkland, because it is neither — it is a site waiting for
// what the settlement has decided to put on it.
const RESERVED = [0x8fae74, 0x96b47b];

function coverAt(x, z, fid) {
  const res = reservationAt(x, z, 0);
  if (res) return { kind: 'reserved', pal: RESERVED };

  const dev = developmentAt(x, z);
  const relief = landformAt(x, z);

  // High ground is wooded.  This is what ties the relief into the land
  // cover instead of leaving hills as bare cones standing on grass.
  //
  // The thresholds are in metres of landform and they are deliberately
  // high.  At 3 m and 1.2 m better than a third of the countryside came
  // out as closed forest, which reads as wilderness rather than as a
  // settled landscape with woods in it.
  if (relief > 21) return { kind: 'wood', pal: WOOD };
  if (relief > 7) return { kind: 'scrub', pal: SCRUB };

  // Inside a settlement the land between the buildings is amenity green,
  // never a crop field — a wheat field between two terraces is the kind
  // of thing that breaks the whole read.
  if (dev.intensity >= BAND.EDGE.min) return { kind: 'park', pal: PARK };
  if (dev.intensity >= BAND.FRINGE.min) return { kind: 'meadow', pal: MEADOW };

  // Countryside: farmed near settlements, wilder further out, with a
  // noise term so the boundary between the two is not a ring.
  const farmness = 1 - Math.min(1, dev.r / 2400)
                 + (fbm2(x * 0.0006 + 7.7, z * 0.0006 - 3.1, 2) - 0.5) * 0.7;
  if (farmness > 0.34) {
    return hash2(fid & 0xffff, (fid >>> 16) & 0xffff) < 0.42
      ? { kind: 'pasture', pal: PASTURE }
      : { kind: 'crop', pal: CROP };
  }
  return { kind: 'meadow', pal: MEADOW };
}

// ---- Polygon clipping ------------------------------------------------
//
// A field is the Voronoi cell of its centre, clipped to the chunk.  The
// first version of this rasterised the diagram onto a 22 m grid, which
// gave every field a staircased edge — the strongest remaining "this was
// generated" tell in the aerial survey once the buildings were fixed.
// Clipping the cell as an actual polygon costs about the same and gives
// the straight irregular boundaries that enclosed farmland really has.
//
// Each vertex carries the identity of the edge LEAVING it, so once a
// polygon is built we know which of its sides are field boundaries
// (worth a hedgerow) and which are merely the chunk edge (not).

const EDGE_CHUNK = -1;

/**
 * Clip a polygon to the half-plane { p : n·p <= c }, preserving the
 * provenance of each edge.
 * @param {Array} poly  vertices { x, z, e }
 */
function clipHalfPlane(poly, nx, nz, c, edgeId) {
  const out = [];
  for (let i = 0; i < poly.length; i++) {
    const cur = poly[i];
    const nxt = poly[(i + 1) % poly.length];
    const dc = nx * cur.x + nz * cur.z - c;
    const dn = nx * nxt.x + nz * nxt.z - c;

    if (dc <= 0) {
      out.push(cur);
      if (dn > 0) {
        const t = dc / (dc - dn);
        // Leaving the region: from the crossing point onward the
        // boundary runs along the clip line itself.
        out.push({ x: cur.x + (nxt.x - cur.x) * t, z: cur.z + (nxt.z - cur.z) * t, e: edgeId });
      }
    } else if (dn <= 0) {
      const t = dc / (dc - dn);
      // Re-entering: the crossing point continues along the original edge.
      out.push({ x: cur.x + (nxt.x - cur.x) * t, z: cur.z + (nxt.z - cur.z) * t, e: cur.e });
    }
  }
  return out;
}

/**
 * The Voronoi cell of field (i, j), clipped to the chunk rectangle.
 * Returns null if the cell does not reach this chunk.
 */
function fieldPolygon(i, j, bounds) {
  const { minX, minZ, maxX, maxZ } = bounds;
  const [px, pz] = fieldCentre(i, j);

  let poly = [
    { x: minX, z: minZ, e: EDGE_CHUNK },
    { x: maxX, z: minZ, e: EDGE_CHUNK },
    { x: maxX, z: maxZ, e: EDGE_CHUNK },
    { x: minX, z: maxZ, e: EDGE_CHUNK },
  ];

  for (let dj = -2; dj <= 2; dj++) {
    for (let di = -2; di <= 2; di++) {
      if (!di && !dj) continue;
      const [qx, qz] = fieldCentre(i + di, j + dj);
      // Perpendicular bisector of p and q: keep the side nearer p.
      const nx = qx - px, nz = qz - pz;
      const c = (qx * qx + qz * qz - px * px - pz * pz) / 2;
      poly = clipHalfPlane(poly, nx, nz, c, fieldId(i + di, j + dj));
      if (poly.length < 3) return null;
    }
  }
  return poly;
}

/**
 * A convex polygon as an upward-facing triangle fan.
 *
 * The winding matters and is easy to get wrong: looking down the +Y axis
 * the Z axis runs DOWN the screen, so a polygon listed in increasing
 * (x, z) order is clockwise as seen from above and computeVertexNormals
 * gives it a downward normal.  Every field was being back-face culled,
 * which left the countryside showing the bare ground plane underneath.
 * The fan is emitted in reverse and the normals are set explicitly,
 * because for a flat horizontal polygon there is nothing to compute.
 */
function fanGeometry(poly) {
  const pos = [];
  for (let v = 1; v < poly.length - 1; v++) {
    pos.push(poly[0].x, Y_COVER, poly[0].z,
             poly[v + 1].x, Y_COVER, poly[v + 1].z,
             poly[v].x, Y_COVER, poly[v].z);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  const n = new Float32Array(pos.length);
  for (let i = 1; i < n.length; i += 3) n[i] = 1;
  geo.setAttribute('normal', new THREE.BufferAttribute(n, 3));
  return geo;
}

/** Unsigned area, used to reject slivers. */
function polyArea(poly) {
  let a = 0;
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i], q = poly[(i + 1) % poly.length];
    a += p.x * q.z - q.x * p.z;
  }
  return Math.abs(a) / 2;
}

/** Convex point-in-polygon, for rejection sampling inside a cell. */
function pointInPoly(x, z, poly) {
  let sign = 0;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i], b = poly[(i + 1) % poly.length];
    const cross = (b.x - a.x) * (z - a.z) - (b.z - a.z) * (x - a.x);
    if (cross === 0) continue;
    const s = cross > 0 ? 1 : -1;
    if (sign === 0) sign = s;
    else if (s !== sign) return false;
  }
  return true;
}

// ============================================================
// CHUNK LAND COVER
// ============================================================

/**
 * Build one chunk's land cover.
 *
 * @param {string} key      chunk key
 * @param {object} bounds   { minX, minZ, maxX, maxZ }
 * @param {Array}  segs     road segments near the chunk
 * @param {number} lod      0 full, 1 cover + belts, 2 cover only
 * @param {object} io       { accPart, accSlab }
 */
export function buildChunkLandscape(key, bounds, segs, lod, io) {
  const { minX, minZ, maxX, maxZ } = bounds;
  const { accPart, accSlab } = io;

  const i0 = Math.floor(minX / FIELD_PITCH) - 1;
  const i1 = Math.floor(maxX / FIELD_PITCH) + 1;
  const j0 = Math.floor(minZ / FIELD_PITCH) - 1;
  const j1 = Math.floor(maxZ / FIELD_PITCH) + 1;

  // Hedgerows are emitted once per shared boundary.  Both neighbouring
  // fields see the same clipped edge inside this chunk, so a key on the
  // rounded endpoints keeps the second one from doubling it.
  const hedged = new Set();
  const woods = [];

  for (let j = j0; j <= j1; j++) {
    for (let i = i0; i <= i1; i++) {
      const poly = fieldPolygon(i, j, bounds);
      if (!poly || poly.length < 3) continue;
      if (polyArea(poly) < 12) continue;

      const [px, pz] = fieldCentre(i, j);
      const fid = fieldId(i, j);
      const cov = coverAt(px, pz, fid);
      const col = cov.pal[Math.abs(fid + (fid >> 7)) % cov.pal.length];

      accPart(key, fanGeometry(poly), 'foliage', col, { jitter: 0.03 });

      if (cov.kind === 'wood' || cov.kind === 'scrub') woods.push({ poly, kind: cov.kind, fid });

      if (lod >= 2) continue;

      // ---- Hedgerows ----
      // Planted on every boundary between two fields, but not around
      // parkland or woods, which carry their own edges.
      if (cov.kind === 'park' || cov.kind === 'wood' || cov.kind === 'reserved') continue;
      for (let v = 0; v < poly.length; v++) {
        if (poly[v].e === EDGE_CHUNK) continue;
        // Internal to the same holding: one field, so no hedge.
        if (poly[v].e === fid) continue;
        const a = poly[v], b = poly[(v + 1) % poly.length];
        const hk = Math.round((a.x + b.x) * 2) + ':' + Math.round((a.z + b.z) * 2);
        if (hedged.has(hk)) continue;
        hedged.add(hk);
        // Name the boundary, then let the hedge pass record WHERE it
        // actually planted.  Recording only the midpoint described a
        // boundary that crosses a road as sitting in the carriageway,
        // when the hedge there is correctly suppressed — the audit has to
        // be able to test the geometry that exists, not the centre of a
        // line that may have a gap in it.
        const rec = classifyBoundary(a.x, a.z, b.x, b.z, segs);
        hedgerow(key, a, b, segs, accPart, rec);
        recordBoundary(rec);
      }
    }
  }

  if (lod >= 2) return;

  plantWoodland(key, woods, lod, accPart, accSlab);
  plantRoadside(key, bounds, segs, accPart, accSlab);

  // Phase 9C: how the land is reached and drained.  Detail LODs only —
  // a farm track is a Walk-scale reading, and at regional distance the
  // field pattern already carries the agriculture.
  if (lod <= 1) {
    buildFarmAccess(key, bounds, segs, accPart);
    buildDrainage(key, bounds, segs, accPart);
    buildUtilityCorridors(key, bounds, segs, accPart);
  }
}

/**
 * One hedgerow along a field boundary, broken where a road crosses it —
 * a hedge growing across a carriageway is exactly the kind of detail
 * that undoes the rest of the work.
 */
function hedgerow(key, a, b, segs, accPart, rec) {
  const len = Math.hypot(b.x - a.x, b.z - a.z);
  if (len < 8) return;
  const dx = (b.x - a.x) / len, dz = (b.z - a.z) / len;

  const n = Math.max(1, Math.round(len / 11));
  const seg = len / n;
  for (let i = 0; i < n; i++) {
    const t = (i + 0.5) * seg;
    const x = a.x + dx * t, z = a.z + dz * t;
    if (onRoad(x, z, segs, 3)) { if (rec) rec.gaps++; continue; }
    // Occasional gaps: a gateway, or a stretch that was grubbed out.
    if (hash2(Math.round(x), Math.round(z)) < 0.12) { if (rec) rec.gaps++; continue; }
    if (rec) rec.drawn.push([+x.toFixed(1), +z.toFixed(1)]);

    const g = new THREE.BoxGeometry(seg * 0.96, 1.05, 0.8);
    g.rotateY(-Math.atan2(dz, dx));
    g.translate(x, 0.52, z);
    accPart(key, g, 'foliage', HEDGE, { jitter: 0.09 });
  }
}

/**
 * Woodland.  Trees are scattered inside the field polygons the cover
 * pass marked as wood or scrub, so a wood has the same boundary as the
 * land parcel it occupies and sits on the high ground the landform field
 * put there.
 */
function plantWoodland(key, woods, lod, accPart, accSlab) {
  const perArea = lod === 0 ? 1 / 70 : 1 / 190;

  for (const w of woods) {
    const area = polyArea(w.poly);
    // Stocking varies field by field, so a wood has thin edges, clearings
    // and dense heart rather than being a uniform carpet of crowns.
    const stocking = 0.45 + hash2(w.fid & 0xffff, (w.fid >>> 13) & 0xffff) * 0.75;
    const density = (w.kind === 'wood' ? 1 : 0.22) * stocking;
    const n = Math.min(lod === 0 ? 130 : 50, Math.round(area * perArea * density));
    if (n < 1) continue;

    let bx0 = Infinity, bx1 = -Infinity, bz0 = Infinity, bz1 = -Infinity;
    for (const v of w.poly) {
      if (v.x < bx0) bx0 = v.x;
      if (v.x > bx1) bx1 = v.x;
      if (v.z < bz0) bz0 = v.z;
      if (v.z > bz1) bz1 = v.z;
    }

    let placed = 0;
    for (let i = 0; i < 420 && placed < n; i++) {
      const hx = hash2(w.fid + i * 131, i * 17 + 3);
      const hz = hash2(i * 71 + 5, w.fid + i * 29);
      const x = bx0 + hx * (bx1 - bx0);
      const z = bz0 + hz * (bz1 - bz0);
      if (!pointInPoly(x, z, w.poly)) continue;
      placed++;

      // Crowns were 12 m across and 9 m tall, which at hamlet scale made
      // the woods bigger than the buildings and turned every hillside
      // into an unbroken carpet.  These are tree-sized.
      const scale = 0.72 + hash2(Math.round(x), Math.round(z)) * 0.55;
      const trunkH = (2.4 + hash2(Math.round(z), Math.round(x)) * 1.9) * scale;
      const crownR = (1.5 + hash2(Math.round(x) + 5, Math.round(z) - 3) * 1.3) * scale;
      const y = landformAt(x, z);

      accSlab(key, 'opaque', 0x6d5a46, 0.28, trunkH, 0.28, x, y + trunkH / 2, z, { jitter: 0.07 });
      crown(key, accPart, x, y + trunkH + crownR * 0.55, z, crownR * 1.15,
            WOOD[Math.abs(Math.round(x * 3) + Math.round(z)) % WOOD.length], 0.10);
    }
  }
}

/**
 * Roadside tree belts.  Regional roads get an avenue; arterials get an
 * intermittent one.  Streets get nothing here — the street layer already
 * draws footways, and a tree on every plot would bury the buildings.
 */
function plantRoadside(key, bounds, segs, accPart, accSlab) {
  const { minX, minZ, maxX, maxZ } = bounds;

  for (const seg of segs) {
    // Streets inside a settlement are planted too.  Veridian Cap's own
    // streets are lined, and carrying that out to the procedural world is
    // most of what keeps a generated town in the same register as the
    // authored one: green, calm and at human scale rather than a grid of
    // buildings on bare ground.
    const street = seg.type === 'street';
    if (!street && seg.type !== 'regional' && seg.type !== 'arterial') continue;
    const spacing = seg.type === 'regional' ? 15 : street ? 19 : 22;
    const chance = seg.type === 'regional' ? 0.85 : street ? 0.52 : 0.45;

    const dx = (seg.x2 - seg.x1) / seg.len;
    const dz = (seg.z2 - seg.z1) / seg.len;
    const nx = -dz, nz = dx;
    // Street trees stand on the verge between kerb and footway; avenue
    // trees on a trunk road stand clear of the carriageway.
    const off = street ? seg.width / 2 + 1.7 : seg.width / 2 + 3.2;
    const n = Math.floor(seg.len / spacing);

    for (let i = 0; i < n; i++) {
      const t = (i + 0.5) * spacing;
      for (const s of [-1, 1]) {
        const x = seg.x1 + dx * t + nx * s * off;
        const z = seg.z1 + dz * t + nz * s * off;
        if (x < minX || x >= maxX || z < minZ || z >= maxZ) continue;
        if (hash2(seg.id * 97 + i, s * 13 + 7) > chance) continue;
        // Clear of every OTHER road too.  A tree placed correctly beside
        // the road it lines still ends up in the carriageway of a second
        // road that passes close by, and thirteen of them did.
        if (onRoad(x, z, segs, 1.8)) continue;

        const dev = developmentAt(x, z);
        if (street) {
          // Only where there is a street scene to line.
          if (dev.intensity < BAND.EDGE.min) continue;
        } else if (dev.intensity >= BAND.OUTER.min) {
          // An avenue stops where the frontage takes over; otherwise the
          // trees stand in people's front rooms.
          continue;
        }

        const trunkH = street ? 3.0 + hash2(Math.round(x), Math.round(z)) * 1.3
                              : 3.4 + hash2(Math.round(x), Math.round(z)) * 1.8;
        const crownR = street ? 1.5 + hash2(Math.round(z), Math.round(x)) * 0.8
                              : 1.9 + hash2(Math.round(z), Math.round(x)) * 0.9;
        accSlab(key, 'opaque', 0x6d5a46, 0.26, trunkH, 0.26, x, trunkH / 2, z, { jitter: 0.06 });
        crown(key, accPart, x, trunkH + crownR * 0.6, z, crownR * 1.2,
              PARK[i % PARK.length], 0.09);
      }
    }
  }
}

/**
 * A settlement's central open space.  Every significant settlement gets
 * one, so from altitude each place has a findable middle rather than
 * being a uniform patch of roofs.  Veridian Cap is excluded — it has an
 * authored green already, and a second one on top of it would be a bug.
 */
export function buildSettlementCore(key, s, bounds, io) {
  if (!s || s.authored) return;
  const { minX, minZ, maxX, maxZ } = bounds;
  if (s.x < minX || s.x >= maxX || s.z < minZ || s.z >= maxZ) return;

  const { accPart, accSlab } = io;
  const r = s.coreR * 0.42;

  const disc = new THREE.CircleGeometry(r, 18);
  disc.rotateX(-Math.PI / 2);
  disc.translate(s.x, 0.010, s.z);

  if (s.core === 'water') {
    accPart(key, disc, 'glass', 0x4f7d8c, { jitter: 0.03 });
    // A planted rim, so the water has a bank rather than a cut edge.
    const rim = new THREE.RingGeometry(r, r * 1.22, 20);
    rim.rotateX(-Math.PI / 2);
    rim.translate(s.x, 0.009, s.z);
    accPart(key, rim, 'foliage', PARK[1], { jitter: 0.05 });
    return;
  }

  if (s.core === 'civic-square' || s.core === 'market-street' || s.core === 'interchange') {
    accPart(key, disc, 'opaque', 0xb8b3a4, { jitter: 0.03 });
    // A ring of trees turns a paved square into a place.
    const n = 14;
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2 + s.grain;
      const x = s.x + Math.cos(a) * r * 0.88;
      const z = s.z + Math.sin(a) * r * 0.88;
      accSlab(key, 'opaque', 0x6d5a46, 0.28, 3.6, 0.28, x, 1.8, z, { jitter: 0.05 });
      crown(key, accPart, x, 4.9, z, 2.3, PARK[i % PARK.length], 0.08);
    }
    return;
  }

  // green / park
  accPart(key, disc, 'foliage', PARK[0], { jitter: 0.04 });
  const n = 9;
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2 + s.grain * 1.7;
    const rr = r * (0.45 + hash2(i * 13, Math.round(s.x)) * 0.45);
    const x = s.x + Math.cos(a) * rr;
    const z = s.z + Math.sin(a) * rr;
    const trunkH = 3.2 + hash2(i, Math.round(s.z)) * 1.6;
    accSlab(key, 'opaque', 0x6d5a46, 0.30, trunkH, 0.30, x, trunkH / 2, z, { jitter: 0.06 });
    crown(key, accPart, x, trunkH + 1.5, z, 2.6, PARK[i % PARK.length], 0.09);
  }
}
