import { slab } from './architecture.js';

// ============================================================
// VERIDIAN CAP — BUILDING FAMILIES (Phase 5A / 5B)
//
// Four families, one grammar.  See architecture.js for the
// plinth / body / crown rule and the merge strategy.
//
// Every dimension below is metres.  The settlement is walked at
// 1.7 m eye height, so floor heights, sill heights, door heights
// and canopy clearances are all authored against a human body —
// that is what makes the massing read as buildable rather than
// as scaled-up boxes.
// ============================================================

// ---- Material colours ----
const C = {
  // Residential: warm plaster and clay, the domestic end of the palette.
  wallHome:  ['#e0cfae', '#d8c3a0', '#e7dcc2', '#cdb694', '#dbc9ac', '#c9ae8d'],
  // Commercial: paler cast stone with a ceramic sheen.
  wallShop:  ['#e6dfd0', '#dcd4c2', '#ece6d8', '#d3cab6'],
  // Civic: cool structural stone — the settlement's institutional material.
  wallCivic: ['#cfd0c9', '#c4c8c2', '#d8d7cd'],
  // Landmark: a cooler, greyer mineral that reads against the sky.
  wallTall:  ['#d6d3c8', '#c8c7bd', '#dedbd0'],

  baseStone: '#9aa09c',
  baseWarm:  '#a89a83',
  baseDeep:  '#828884',
  trimLight: '#f1ece0',
  trimShade: '#b6b0a1',
  glassDay:  '#4a6f7c',
  glassPale: '#6f95a4',
  bronze:    '#96794f',
  steel:     '#a6acad',
  greenRoof: '#6d9e53',
  greenRoofLt: '#84b263',
  roofDeck: '#6b6f66',
  roofDeckWarm: '#77726a',
  lampWarm:  '#ffd9a0',
  paving:    '#c8c1ae',
};

const ACCENT = {
  residence:  '#a07c52',   // warm timber
  commercial: '#4f9089',   // teal ceramic
  civic:      '#40714a',   // deep planted green
  landmark:   '#5c7489',   // slate blue
};

// ---- Family definitions ----
// bay      structural bay width — the rhythm of the whole facade
// floorH   typical floor-to-floor above the ground storey
// groundH  the ground storey, always taller: it is the public one
// winFrac  window height as a fraction of the floor height
// crown    how the building stops against the sky
export const FAMILY = {
  residence: {
    bay: 3.1, floorH: 3.15, groundH: 3.7, winFrac: 0.52,
    crown: 'planted', ground: 'punched', balconies: true,
    wall: C.wallHome, base: C.baseWarm, pierW: 0.46, pierProj: 0.09, recess: 0.34,
  },
  commercial: {
    bay: 2.95, floorH: 3.45, groundH: 4.5, winFrac: 0.64,
    crown: 'cornice', ground: 'shopfront', balconies: false,
    wall: C.wallShop, base: C.baseStone, pierW: 0.42, pierProj: 0.12, recess: 0.38,
  },
  civic: {
    bay: 3.9, floorH: 4.1, groundH: 5.1, winFrac: 0.68,
    crown: 'eave', ground: 'colonnade', balconies: false,
    wall: C.wallCivic, base: C.baseStone, pierW: 0.62, pierProj: 0.18, recess: 0.44,
  },
  landmark: {
    bay: 2.55, floorH: 3.4, groundH: 4.7, winFrac: 0.58,
    crown: 'setback', ground: 'tall', balconies: false,
    wall: C.wallTall, base: C.baseStone, pierW: 0.40, pierProj: 0.17, recess: 0.40,
  },
};

/**
 * How many panes a window opening is divided into.  Openings are kept near
 * a 0.95 m pane so that windows stay vertical whatever the bay width — the
 * single most reliable cue that a facade is at human scale.
 */
function panes(openW) { return Math.max(1, Math.round(openW / 0.95)); }

const PLINTH_OVERHANG = 0.7;   // must match collision.registerBuildingCollision
const GROUND_Y = 0.5;          // top of the terrace plinth = building datum

// Deterministic per-building noise so a rebuild looks identical.
function mulberry(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Face-local coordinate frame.
 *
 *   u — along the facade run, 0 at the centre
 *   y — world height
 *   t — outward from the footprint face plane (t = 0 is the face,
 *       positive projects toward the street)
 */
function faceFrame(side, cx, cz, w, d) {
  const half = (side === 'north' || side === 'south') ? d / 2 : w / 2;
  const runLen = (side === 'north' || side === 'south') ? w : d;
  const sx = side === 'east' ? 1 : side === 'west' ? -1 : 0;
  const sz = side === 'north' ? 1 : side === 'south' ? -1 : 0;
  return {
    side, runLen, sx, sz,
    /** Emit a box: su size along the run, sh height, st size in depth. */
    box(bucket, color, u, y, t, su, sh, st, opt) {
      if (sx) slab(bucket, color, st, sh, su, cx + sx * (half + t), y, cz + u, opt);
      else    slab(bucket, color, su, sh, st, cx + u, y, cz + sz * (half + t), opt);
    },
  };
}

/**
 * Build one building.  Footprint (cx, cz, w, d) is fixed by the
 * Phase 3 spatial grammar and is never altered here — only the
 * height is snapped to a whole number of floors.
 *
 * @returns {number} the realised height above the plinth top
 */
export function buildBuilding(opts) {
  const {
    cx, cz, w, d, targetH, family, fronts, entrance, seed, accentOverride, seeThrough,
  } = opts;
  const F = FAMILY[family];
  const rnd = mulberry(seed);
  const accent = accentOverride || ACCENT[family];
  const wall = F.wall[Math.floor(rnd() * F.wall.length)];

  // ---- Snap height to a whole number of floors ----
  const floors = Math.max(1, Math.round((targetH - F.groundH) / F.floorH));
  const bodyTop = GROUND_Y + F.groundH + floors * F.floorH;
  const height = bodyTop - GROUND_Y;

  const R = F.recess;
  const skinT = -R / 2 + F.pierProj / 2;     // centre of the outer skin layer
  const skinD = R + F.pierProj;              // its depth
  const isFront = s => fronts.includes(s);

  // ---- Terrace plinth (footprint matches the collision plinth exactly) ----
  slab('opaque', C.baseStone, w + PLINTH_OVERHANG * 2, 0.42, d + PLINTH_OVERHANG * 2,
       cx, 0.21, cz, { jitter: 0.02 });
  // A nosing band catches the sun and separates the building from the ground.
  slab('opaque', C.trimShade, w + PLINTH_OVERHANG * 2 + 0.06, 0.08, d + PLINTH_OVERHANG * 2 + 0.06,
       cx, 0.46, cz);

  // ---- Core mass (inset so the skin layer sits proud of it) ----
  slab('opaque', wall, w - 2 * R, height, d - 2 * R, cx, GROUND_Y + height / 2, cz,
       { jitter: 0.015, grade: true });

  // ---- Facades ----
  for (const side of ['north', 'south', 'east', 'west']) {
    const f = faceFrame(side, cx, cz, w, d);
    buildFacade(f, {
      F, wall, accent, floors, front: isFront(side), rnd,
      isEntrance: side === entrance,
      skinT, skinD, R, seeThrough,
    });
  }

  // ---- Crown ----
  buildCrown({ cx, cz, w, d, bodyTop, F, wall, accent, rnd, R });

  return height;
}

// ============================================================
// FACADE
// ============================================================

function buildFacade(f, ctx) {
  const { F, wall, accent, floors, front, rnd, isEntrance, skinT, skinD, R } = ctx;
  const run = f.runLen;
  const totalH = F.groundH + floors * F.floorH;

  // ---- Bay setting-out ----
  const cornerW = F.pierW + 0.24;              // quoin pier at each end
  const usable = run - 2 * cornerW;
  if (usable < 1.2) {
    // Too narrow to articulate: close it with a solid panel.
    f.box('opaque', wall, 0, GROUND_Y + totalH / 2, skinT, run, totalH, skinD,
          { jitter: 0.02, grade: true });
    return;
  }
  const bays = Math.max(1, Math.round(usable / F.bay));
  const bayW = usable / bays;
  const openW = Math.max(0.7, bayW - F.pierW);
  const bodyY0 = GROUND_Y + F.groundH;

  // ---- Corner quoins: full height, slightly deeper than the field piers ----
  for (const s of [-1, 1]) {
    f.box('opaque', wall, s * (run - cornerW) / 2, GROUND_Y + totalH / 2, skinT + 0.02,
          cornerW, totalH, skinD + 0.04, { jitter: 0.02, grade: true });
  }

  // ---- Field piers between bays (full body height, unbroken vertical) ----
  for (let i = 1; i < bays; i++) {
    const u = -usable / 2 + i * bayW;
    f.box('opaque', wall, u, bodyY0 + floors * F.floorH / 2, skinT,
          F.pierW, floors * F.floorH, skinD, { jitter: 0.02 });
  }

  // ---- Upper floors ----
  const winH = F.floorH * F.winFrac;
  const sillH = (F.floorH - winH) * 0.58;
  const headH = F.floorH - winH - sillH;

  for (let fl = 0; fl < floors; fl++) {
    const y0 = bodyY0 + fl * F.floorH;
    const topFloor = fl === floors - 1;

    for (let b = 0; b < bays; b++) {
      const u = -usable / 2 + (b + 0.5) * bayW;

      // Spandrel below the window and header above: these two, plus the
      // piers, ARE the outer skin. The gap they leave is the window recess.
      f.box('opaque', wall, u, y0 + sillH / 2, skinT, openW, sillH, skinD, { jitter: 0.02 });
      f.box('opaque', wall, u, y0 + sillH + winH + headH / 2, skinT, openW, headH, skinD,
            { jitter: 0.02 });

      // Glazing, set back inside the reveal.
      const lit = rnd() < 0.13;
      const tint = lit ? C.lampWarm : (rnd() < 0.35 ? C.glassPale : C.glassDay);
      f.box(lit ? 'glow' : 'glass', tint, u, y0 + sillH + winH / 2, -R + 0.07,
            openW - 0.14, winH - 0.12, 0.09, { jitter: 0.10 });

      // Transom and mullions: without them a window is just a dark rectangle.
      // They are also the only cue at 20 m that tells the player how big it is.
      f.box('metal', C.steel, u, y0 + sillH + winH * 0.74, -R + 0.13, openW - 0.16, 0.05, 0.05);
      for (let m = 1; m < panes(openW); m++) {
        f.box('metal', C.steel, u - openW / 2 + m * openW / panes(openW),
              y0 + sillH + winH / 2, -R + 0.13, 0.06, winH - 0.12, 0.06);
      }

      // Projecting sill: a real ledge, lit from above, shading the wall below.
      f.box('opaque', C.trimLight, u, y0 + sillH - 0.05, 0.07, openW + 0.20, 0.09, skinD + 0.28);

      // Balconies on alternating bays of the street front.
      if (F.balconies && front && !topFloor && (b + fl) % 2 === 0 && openW > 1.4) {
        buildBalcony(f, u, y0 + sillH, openW, accent);
      }
    }

    // Horizontal floor band ties the bays together at every level.
    f.box('opaque', C.trimShade, 0, y0 + F.floorH - 0.10, 0.045,
          run - 0.1, 0.16, skinD + 0.19, { jitter: 0.015 });
  }

  // ---- Ground storey ----
  buildGroundStorey(f, ctx, { run, usable, bays, bayW, openW, cornerW });

  // ---- Entrance ----
  if (isEntrance) buildEntrance(f, ctx, { openW: Math.max(1.6, Math.min(openW, 2.6)) });
}

function buildBalcony(f, u, y, openW, accent) {
  const bw = openW + 0.5;
  // Floor slab
  f.box('opaque', C.trimLight, u, y - 0.09, 0.62, bw, 0.18, 1.30);
  // Solid front panel in the family accent, at a real 1.05 m guard height
  f.box('opaque', accent, u, y + 0.52, 1.18, bw, 1.05, 0.14, { jitter: 0.04 });
  f.box('metal', C.steel, u, y + 1.07, 1.18, bw, 0.06, 0.20);
  // Side cheeks
  for (const s of [-1, 1]) {
    f.box('opaque', accent, u + s * (bw / 2 - 0.07), y + 0.52, 0.62, 0.14, 1.05, 1.30,
          { jitter: 0.04 });
  }
}

function buildGroundStorey(f, ctx, geom) {
  const { F, wall, accent, front, rnd, skinT, skinD, R, isEntrance, seeThrough } = ctx;
  const { run, usable, bays, bayW, openW, cornerW } = geom;
  const gh = F.groundH;
  const y0 = GROUND_Y;

  // The ground floor always reads in a heavier stone than the body. That
  // single move is most of what makes a building feel founded rather than
  // floating; the family chooses how warm or cool that stone is.
  const baseCol = F.base;

  if (F.ground === 'colonnade') {
    // Civic: square columns standing forward of a deeply shaded glass wall.
    //
    // On a building you can walk into, that back wall is broken either side
    // of the entrance. Run unbroken it seals the doorway from behind — the
    // door opens onto a metre of recess and then a solid wall, which is what
    // the Community Hall's doorway was showing from inside.
    const backW = run - 2 * cornerW;
    if (seeThrough) {
      // No back panel on ANY elevation of a building with a room in it.
      //
      // It is a half-metre slab set 0.69 m behind the facade line, so on a
      // hollow building it lands 0.6 m inside the room, in front of that
      // room's own wall. Opened on the entrance face alone it still sealed
      // the other three: the Community Hall's panelling, dado and cornice
      // were all built correctly and all hidden behind this slab, which is
      // why three of its walls looked like flat colour no matter what was
      // modelled on them. Where there is an interior, the interior's wall is
      // the wall, and the colonnade is columns standing in front of it.
    } else {
      f.box('opaque', baseCol, 0, y0 + gh / 2, -R - 0.25, backW, gh, 0.5, { ao: 0.7 });
    }
    for (let b = 0; b <= bays; b++) {
      const u = -usable / 2 + b * bayW;
      f.box('opaque', C.trimLight, u, y0 + gh / 2, 0.34, 0.72, gh, 1.05, { jitter: 0.02, grade: true });
      f.box('opaque', C.trimLight, u, y0 + gh - 0.12, 0.34, 0.92, 0.24, 1.25);
    }
    for (let b = 0; b < bays; b++) {
      const u = -usable / 2 + (b + 0.5) * bayW;
      // Never glaze across the doorway of a building you can enter.
      // Where there is an interior, the room supplies its own glazing; the
      // colonnade's glass would stand in front of every one of its windows.
      if (seeThrough) continue;
      f.box('glass', C.glassDay, u, y0 + gh / 2 - 0.2, -R - 0.06, bayW - 0.9, gh - 1.0, 0.09,
            { jitter: 0.06 });
    }
  } else if (F.ground === 'shopfront') {
    // Commercial: a glazed public edge under a continuous shading canopy.
    f.box('opaque', baseCol, 0, y0 + 0.30, skinT + 0.03, run, 0.60, skinD + 0.06,
          { jitter: 0.02, grade: true });
    for (const s of [-1, 1]) {
      f.box('opaque', baseCol, s * (run - cornerW) / 2, y0 + gh / 2, skinT + 0.03,
            cornerW, gh, skinD + 0.06, { jitter: 0.02, grade: true });
    }
    const glazH = gh - 1.35;
    for (let b = 0; b < bays; b++) {
      const u = -usable / 2 + (b + 0.5) * bayW;
      f.box('opaque', wall, u, y0 + gh - 0.36, skinT, openW + F.pierW, 0.72, skinD);
      const lit = front && rnd() < 0.5;
      f.box(lit ? 'glow' : 'glass', lit ? C.lampWarm : C.glassPale,
            u, y0 + 0.6 + glazH / 2, -R + 0.08, openW + F.pierW - 0.30, glazH - 0.12, 0.09,
            { jitter: 0.08 });
      f.box('metal', C.bronze, u, y0 + 0.6 + glazH / 2, -R + 0.14, 0.07, glazH - 0.12, 0.07);
    }
    for (let b = 1; b < bays; b++) {
      const u = -usable / 2 + b * bayW;
      f.box('opaque', baseCol, u, y0 + gh / 2, skinT, F.pierW + 0.1, gh, skinD, { jitter: 0.02 });
    }
    // Continuous canopy — the thing that makes a street feel sheltered.
    if (front) {
      f.box('opaque', C.trimLight, 0, y0 + gh - 0.22, 0.86, run - 0.4, 0.20, 1.80);
      f.box('opaque', accent, 0, y0 + gh - 0.40, 1.70, run - 0.4, 0.16, 0.16, { jitter: 0.03 });
    }
  } else {
    // Residence / landmark: punched openings in a solid heavy base.
    for (const s of [-1, 1]) {
      f.box('opaque', baseCol, s * (run - cornerW) / 2, y0 + gh / 2, skinT + 0.02,
            cornerW, gh, skinD + 0.04, { jitter: 0.02, grade: true });
    }
    for (let b = 1; b < bays; b++) {
      const u = -usable / 2 + b * bayW;
      f.box('opaque', baseCol, u, y0 + gh / 2, skinT, F.pierW, gh, skinD, { jitter: 0.02 });
    }
    const wH = F.ground === 'tall' ? gh * 0.62 : gh * 0.46;
    const sH = F.ground === 'tall' ? gh * 0.24 : gh * 0.36;
    for (let b = 0; b < bays; b++) {
      const u = -usable / 2 + (b + 0.5) * bayW;
      f.box('opaque', baseCol, u, y0 + sH / 2, skinT, openW, sH, skinD, { jitter: 0.02, grade: true });
      f.box('opaque', baseCol, u, y0 + sH + wH + (gh - sH - wH) / 2, skinT,
            openW, gh - sH - wH, skinD, { jitter: 0.02 });
      const lit = rnd() < 0.22;
      f.box(lit ? 'glow' : 'glass', lit ? C.lampWarm : C.glassDay,
            u, y0 + sH + wH / 2, -R + 0.07, openW - 0.14, wH - 0.12, 0.09, { jitter: 0.09 });
      for (let m = 1; m < panes(openW); m++) {
        f.box('metal', C.steel, u - openW / 2 + m * openW / panes(openW),
              y0 + sH + wH / 2, -R + 0.13, 0.06, wH - 0.12, 0.06);
      }
      f.box('opaque', C.trimLight, u, y0 + sH - 0.05, 0.07, openW + 0.20, 0.10, skinD + 0.28);
    }
    // Base course band
    f.box('opaque', C.baseDeep, 0, y0 + 0.22, skinT + 0.04, run, 0.44, skinD + 0.10,
          { jitter: 0.02, grade: true });
  }

  // Head band closing the ground storey against the body above.
  f.box('opaque', C.trimShade, 0, y0 + gh - 0.06, 0.06, run, 0.20, skinD + 0.22, { jitter: 0.015 });
}

// ============================================================
// ENTRANCE
//
// The boundary between public street and private building, read
// as a sequence visible from across the road:
//   approach paving -> landing -> canopy -> recess -> frame -> door
// ============================================================

function buildEntrance(f, ctx, { openW }) {
  const { F, accent } = ctx;
  const gh = F.groundH;
  const y0 = GROUND_Y;
  const doorH = Math.min(2.6, gh - 1.3);
  const recess = 1.0;
  const halfW = openW / 2;

  // 1. Recess — the door plane pushed back into the mass.  Its lining is a
  // PALE stone, not a dark one: a recess is already the darkest part of a
  // facade, and on the shaded side of a street a dark lining turns the one
  // thing the player most needs to read into a black hole.
  //
  // For a building with an interior the recess is built HOLLOW: jambs, head
  // and soffit, with nothing filling the middle. Built solid it is a metre
  // of stone pushed through the wall into the room beyond, which is exactly
  // what was covering the Community Hall's door from the inside. Hollow, the
  // same door — the same leaf, mullion, handles and kick plate — serves the
  // street and the room, which is the continuity this is all for.
  const rw = openW + 0.5, rh = doorH + 0.5, rt = -recess / 2 - 0.1;
  if (ctx.seeThrough) {
    const jamb = 0.26;
    for (const s of [-1, 1]) {
      f.box('opaque', C.trimLight, s * (rw / 2 - jamb / 2), y0 + rh / 2, rt,
            jamb, rh, recess, { ao: 0.98 });
    }
    f.box('opaque', C.trimLight, 0, y0 + rh - 0.13, rt, rw, 0.26, recess, { ao: 0.95 });
    f.box('opaque', C.baseDeep, 0, y0 + 0.03, rt, rw, 0.06, recess, { ao: 0.9 });
  } else {
    f.box('opaque', C.trimShade, 0, y0 + doorH / 2 + 0.25, rt, rw, rh, recess, { ao: 0.95 });
  }
  f.box('opaque', C.trimLight, 0, y0 + doorH + 0.55, rt, rw, 0.12, recess);

  // 2. Bronze frame around the opening — material change at the threshold.
  for (const s of [-1, 1]) {
    f.box('metal', C.bronze, s * (halfW + 0.11), y0 + doorH / 2 + 0.2, -0.04, 0.22, doorH + 0.4, 0.28);
  }
  f.box('metal', C.bronze, 0, y0 + doorH + 0.44, -0.04, openW + 0.44, 0.22, 0.28);

  // 3. Door leaves, central mullion, and HANDLES.
  //
  // A door without a handle is a panel. The pull bars below are the single
  // cheapest part in this file and they do more than anything else to say
  // "this opens" — at street distance they are the only thing that
  // distinguishes a doorway from a dark recess in the stonework.
  f.box('glass', C.glassDay, 0, y0 + doorH / 2, -recess + 0.12, openW - 0.1, doorH, 0.10,
        { jitter: 0.05 });
  f.box('metal', C.bronze, 0, y0 + doorH / 2, -recess + 0.18, 0.09, doorH, 0.09);

  // A vertical pull bar on each leaf, held off the glass on two standoffs,
  // at the height a hand actually reaches.
  const grip = Math.min(1.15, doorH * 0.46);
  for (const s of [-1, 1]) {
    const hx = s * openW * 0.24;
    f.box('metal', C.bronze, hx, y0 + 1.02, -recess + 0.26, 0.055, grip, 0.055);
    for (const e of [-1, 1]) {
      f.box('metal', C.bronze, hx, y0 + 1.02 + e * grip * 0.42, -recess + 0.205,
            0.045, 0.045, 0.085);
    }
  }
  // Kick plate: the band of a door that takes the wear.
  f.box('metal', C.bronze, 0, y0 + 0.16, -recess + 0.17, openW - 0.16, 0.26, 0.055);

  // On a door the player can stand behind, the handles are repeated on the
  // room face. A door with a handle on one side only is a door you can see
  // is fake the moment you turn round.
  if (ctx.seeThrough) {
    for (const s of [-1, 1]) {
      const hx = s * openW * 0.24;
      f.box('metal', C.bronze, hx, y0 + 1.02, -recess - 0.02, 0.055, grip, 0.055);
      for (const e of [-1, 1]) {
        f.box('metal', C.bronze, hx, y0 + 1.02 + e * grip * 0.42, -recess + 0.035,
              0.045, 0.045, 0.085);
      }
    }
    f.box('metal', C.bronze, 0, y0 + 0.16, -recess + 0.07, openW - 0.16, 0.26, 0.055);
  }

  // 4. Canopy over the threshold, with a pale soffit and a warm light strip.
  f.box('opaque', C.trimLight, 0, y0 + doorH + 0.80, 0.75, openW + 2.0, 0.22, 1.70);
  f.box('opaque', C.trimLight, 0, y0 + doorH + 0.68, 0.75, openW + 1.9, 0.06, 1.60, { ao: 0.95 });
  f.box('opaque', accent, 0, y0 + doorH + 0.66, 1.53, openW + 2.0, 0.14, 0.16, { jitter: 0.03 });
  f.box('glow', C.lampWarm, 0, y0 + doorH + 0.67, 0.75, openW + 1.2, 0.06, 0.30);

  // 4b. A lamp on each jamb, inside the recess, and a name plate beside them.
  //
  // These sit INSIDE the reveal rather than on the face. On a colonnaded
  // civic front anything mounted flush with the wall disappears behind the
  // columns, and the recess is where an entrance light belongs in any case:
  // it is the one part of a facade that is always in shadow, so a small
  // warm source there is what makes the doorway findable at all.
  for (const s of [-1, 1]) {
    const lx = s * (openW / 2 + 0.08);
    f.box('opaque', C.trimLight, lx, y0 + 2.18, -0.30, 0.16, 0.52, 0.18);
    f.box('glow', C.lampWarm, lx, y0 + 2.18, -0.40, 0.13, 0.38, 0.14);
    f.box('glow', C.lampWarm, lx, y0 + 2.46, -0.30, 0.20, 0.05, 0.20);
  }
  // Name plate on the jamb, at reading height.
  f.box('opaque', C.trimLight, openW / 2 + 0.08, y0 + 1.42, -0.30, 0.10, 0.40, 0.26);
  f.box('opaque', accent, openW / 2 + 0.04, y0 + 1.42, -0.30, 0.03, 0.28, 0.18);

  // 4c. Threshold: a band of a different stone laid across the opening, so
  // the boundary between street and building is something you can see.
  f.box('opaque', C.baseDeep, 0, y0 + 0.02, -0.18, openW + 0.4, 0.06, 0.62, { ao: 0.9 });

  // 5. Landing and two steps down to the forecourt.
  f.box('opaque', C.trimLight, 0, y0 - 0.09, 0.62, openW + 1.6, 0.18, 1.30);
  f.box('opaque', C.trimShade, 0, y0 - 0.26, 0.90, openW + 1.9, 0.17, 1.70);

  // 6. Approach paving running out toward the footway — narrower than the
  // landing so the sequence reads as a funnel toward the door.
  f.box('opaque', C.paving, 0, 0.37, 2.45, openW + 1.2, 0.06, 3.30, { jitter: 0.02 });
}

// ============================================================
// CROWN
// ============================================================

function buildCrown({ cx, cz, w, d, bodyTop, F, wall, accent, rnd, R }) {
  // The roof deck is a darker mineral than the walls. A pale deck reads as a
  // lid from Eagle; a dark one lets the parapet and the planting on it read.
  const roofCol = F.crown === 'planted' ? C.roofDeckWarm : C.roofDeck;

  if (F.crown === 'cornice') {
    slab('opaque', C.trimLight, w + 0.95, 0.40, d + 0.95, cx, bodyTop + 0.20, cz);
    slab('opaque', C.trimShade, w + 0.55, 0.18, d + 0.55, cx, bodyTop + 0.46, cz);
    slab('opaque', roofCol, w - 2 * R, 0.22, d - 2 * R, cx, bodyTop + 0.50, cz);
    parapet(cx, cz, w - 0.5, d - 0.5, bodyTop + 0.42, 0.62, wall);
    // Even commercial roofs carry a planted strip: Veridian Cap has to read
    // green from above as well as from the footway.
    terrace(cx, cz, w - 3.0, d * 0.42, bodyTop + 0.6, rnd, 0.5);
    rooftop(cx, cz, w, d, bodyTop + 0.6, rnd);
  } else if (F.crown === 'planted') {
    parapet(cx, cz, w - 0.2, d - 0.2, bodyTop, 0.86, wall);
    slab('opaque', roofCol, w - 1.4, 0.16, d - 1.4, cx, bodyTop + 0.08, cz);
    // A full roof garden — the residential signature, seen from every
    // taller building and from the survey view.
    terrace(cx, cz, w - 2.2, d - 2.2, bodyTop + 0.16, rnd, 1.0);
    rooftop(cx, cz, w, d, bodyTop + 0.4, rnd);
  } else if (F.crown === 'eave') {
    // Civic: a thin roof plane floating clear of the walls on a shadow gap.
    // The deck sits BELOW the plane — stacked above it, it turned the
    // building into a grey slab when seen from the survey view.
    slab('opaque', roofCol, w - 2.4, 0.24, d - 2.4, cx, bodyTop + 0.12, cz);
    slab('opaque', C.trimShade, w - 3.4, 0.34, d - 3.4, cx, bodyTop + 0.36, cz);
    slab('opaque', accent, w + 2.5, 0.10, d + 2.5, cx, bodyTop + 0.52, cz, { jitter: 0.03 });
    slab('opaque', C.trimLight, w + 2.4, 0.30, d + 2.4, cx, bodyTop + 0.68, cz);
    // A clerestory band under the eave: the civic buildings are daylit from
    // above, which is what distinguishes them from the commercial grain.
    for (const s of [-1, 1]) {
      slab('glass', C.glassPale, w - 3.4, 0.30, 0.10, cx, bodyTop + 0.30, cz + s * (d - 3.4) / 2,
           { jitter: 0.04 });
      slab('glass', C.glassPale, 0.10, 0.30, d - 3.4, cx + s * (w - 3.4) / 2, bodyTop + 0.30, cz,
           { jitter: 0.04 });
    }
  } else {
    // Landmark: cornice, recessed top storey, parapet and a slim mast.
    slab('opaque', C.trimLight, w + 0.7, 0.34, d + 0.7, cx, bodyTop + 0.17, cz);
    const tw = w - 3.2, td = d - 3.2, th = F.floorH * 1.05;
    if (tw > 2 && td > 2) {
      slab('opaque', roofCol, w - 2 * R, 0.2, d - 2 * R, cx, bodyTop + 0.44, cz);
      terrace(cx + (w - 2 * R) * 0.3, cz, (w - 2 * R) * 0.3, td, bodyTop + 0.5, rnd, 0.6);
      slab('opaque', wall, tw, th, td, cx, bodyTop + 0.34 + th / 2, cz, { jitter: 0.02 });
      slab('glass', C.glassPale, tw + 0.05, th * 0.62, td * 0.55, cx, bodyTop + 0.34 + th * 0.52, cz,
           { jitter: 0.05 });
      slab('glass', C.glassPale, tw * 0.55, th * 0.62, td + 0.05, cx, bodyTop + 0.34 + th * 0.52, cz,
           { jitter: 0.05 });
      slab('opaque', C.trimLight, tw + 0.8, 0.26, td + 0.8, cx, bodyTop + 0.34 + th + 0.13, cz);
      slab('opaque', accent, tw * 0.3, 0.5, td * 0.3, cx, bodyTop + 0.34 + th + 0.5, cz);
      const mastH = 3.4 + rnd() * 2.2;
      slab('metal', C.steel, 0.16, mastH, 0.16, cx, bodyTop + 0.6 + th + mastH / 2, cz);
      slab('glow', C.lampWarm, 0.3, 0.3, 0.3, cx, bodyTop + 0.6 + th + mastH, cz);
    } else {
      parapet(cx, cz, w - 0.4, d - 0.4, bodyTop + 0.34, 0.8, wall);
    }
  }
}

/**
 * A planted roof terrace: a bed of substrate with a few clumps standing
 * proud of it, so it reads as planting rather than as a green rectangle.
 */
function terrace(cx, cz, w, d, y, rnd, density) {
  if (w < 1.5 || d < 1.5) return;
  slab('opaque', C.greenRoof, w, 0.30, d, cx, y + 0.15, cz, { jitter: 0.06 });
  const n = Math.max(2, Math.round(w * d * 0.035 * density));
  for (let i = 0; i < n; i++) {
    const bw = 0.5 + rnd() * 0.9;
    slab('opaque', rnd() > 0.5 ? C.greenRoofLt : C.greenRoof,
         bw, 0.30 + rnd() * 0.45, bw,
         cx + (rnd() - 0.5) * (w - bw), y + 0.35, cz + (rnd() - 0.5) * (d - bw),
         { jitter: 0.10 });
  }
}

/** A hollow parapet wall: four thin slabs plus a light coping. */
function parapet(cx, cz, w, d, y, h, col) {
  const t = 0.30;
  slab('opaque', col, w, h, t, cx, y + h / 2, cz + d / 2 - t / 2, { jitter: 0.02 });
  slab('opaque', col, w, h, t, cx, y + h / 2, cz - d / 2 + t / 2, { jitter: 0.02 });
  slab('opaque', col, t, h, d - t * 2, cx + w / 2 - t / 2, y + h / 2, cz, { jitter: 0.02 });
  slab('opaque', col, t, h, d - t * 2, cx - w / 2 + t / 2, y + h / 2, cz, { jitter: 0.02 });
  slab('opaque', C.trimLight, w + 0.16, 0.11, d + 0.16, cx, y + h + 0.05, cz);
}

/** Roof plant: the small volumes that stop a roofline reading as a lid. */
function rooftop(cx, cz, w, d, y, rnd) {
  const n = 1 + Math.floor(rnd() * 2);
  for (let i = 0; i < n; i++) {
    const bw = 1.2 + rnd() * 2.0, bd = 1.0 + rnd() * 1.6, bh = 0.7 + rnd() * 1.0;
    const ox = (rnd() - 0.5) * Math.max(0, w - bw - 2.4);
    const oz = (rnd() - 0.5) * Math.max(0, d - bd - 2.4);
    slab('opaque', '#a9aaa2', bw, bh, bd, cx + ox, y + bh / 2, cz + oz, { jitter: 0.05 });
    slab('metal', C.steel, bw * 0.5, 0.1, bd * 0.5, cx + ox, y + bh + 0.06, cz + oz);
  }
}
