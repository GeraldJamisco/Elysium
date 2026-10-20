import { TOWN } from '../config.js';
import { settledSite } from './places.js';

// ============================================================
// ELYSIUM NAVIGATION — THE LOCATOR
//
// Answers one question, continuously, at every scale:
// WHERE AM I?
//
//   orbit     Amarine, and what the survey knows of it
//   eagle     the settlement, its region and coordinates
//   walk      the quarter and the street underfoot
//   interior  the room
//
// The walk-level names are not decoration.  They are resolved
// from the SAME grid constants that generate the roads, so the
// street a player is told they are standing on is the street
// they are standing on, and it stays correct if the town is
// ever regenerated.
// ============================================================

const { blocksX, blocksZ, blockW, blockD, roadW, sidewalkW } = TOWN;
const edgeW = roadW + sidewalkW * 2;
const totalX = blocksX * blockW + (blocksX - 1) * edgeW;
const totalZ = blocksZ * blockD + (blocksZ - 1) * edgeW;

/** Centre-lines of the carriageways, derived exactly as layout.js derives them. */
const NS_ROADS = [];
for (let x = 0; x < blocksX - 1; x++) {
  NS_ROADS.push(-totalX / 2 + (x + 1) * blockW + x * edgeW + roadW / 2 + sidewalkW);
}
const EW_ROADS = [];
for (let z = 0; z < blocksZ - 1; z++) {
  EW_ROADS.push(-totalZ / 2 + (z + 1) * blockD + z * edgeW + roadW / 2 + sidewalkW);
}

// In world terms north is +Z (see facades.js), so the first EW road is the
// southern one. Names are plain and settled-sounding rather than technical:
// Veridian Cap is a farming town, not a facility.
const NS_NAMES = ['Fernway', 'Lantern Row'];
const EW_NAMES = ['Cinder Walk', 'Harvest Walk'];
const AVENUE_NAME = 'The Reach Road';

const QUARTERS = {
  '0,0': 'Southwest Quarter', '1,0': 'South Quarter', '2,0': 'Southeast Quarter',
  '0,1': 'West Quarter', '1,1': 'The Green', '2,1': 'East Quarter',
  '0,2': 'Northwest Quarter', '1,2': 'North Quarter', '2,2': 'Northeast Quarter',
};

// Half-width of a street corridor: carriageway plus both footways.
const CORRIDOR = roadW / 2 + sidewalkW;

function blockIndex(v, min, size) {
  for (let i = 0; i < 3; i++) {
    const lo = min + i * (size + edgeW);
    if (v >= lo && v <= lo + size) return i;
  }
  return -1;
}

/**
 * Name the place a walking player is standing in.
 * @returns {{place: string, detail: string}}
 */
export function walkLocation(x, z, interiorName) {
  if (interiorName) return { place: interiorName, detail: 'Interior' };

  // The road out of town, east of the settlement edge.
  if (x > totalX / 2 - 2 && Math.abs(z) < CORRIDOR + 2) {
    return { place: AVENUE_NAME, detail: 'Leaving the settlement' };
  }

  const onNS = NS_ROADS.findIndex(r => Math.abs(x - r) <= CORRIDOR + 0.6);
  const onEW = EW_ROADS.findIndex(r => Math.abs(z - r) <= CORRIDOR + 0.6);

  // A crossing is named by both streets — the clearest possible fix on
  // position, and the moment a player most wants one.
  if (onNS >= 0 && onEW >= 0) {
    return { place: `${NS_NAMES[onNS]} & ${EW_NAMES[onEW]}`, detail: 'Crossing' };
  }
  if (onNS >= 0) return { place: NS_NAMES[onNS], detail: sideOf(x, NS_ROADS[onNS], 'we') };
  if (onEW >= 0) return { place: EW_NAMES[onEW], detail: sideOf(z, EW_ROADS[onEW], 'sn') };

  const bx = blockIndex(x, -totalX / 2, blockW);
  const bz = blockIndex(z, -totalZ / 2, blockD);
  if (bx < 0 || bz < 0) return { place: 'Veridian Cap', detail: 'Outskirts' };

  const quarter = QUARTERS[`${bx},${bz}`] || 'Veridian Cap';
  if (bx === 1 && bz === 1) {
    const r = Math.hypot(x, z);
    if (r < 7.0) return { place: 'The Green', detail: 'Founders’ Plaza' };
    if (r < 11.5) return { place: 'The Green', detail: 'Ring walk' };
    return { place: 'The Green', detail: 'Central park' };
  }
  return { place: quarter, detail: 'Veridian Cap' };
}

function sideOf(v, centre, axis) {
  const d = v - centre;
  if (Math.abs(d) < roadW / 2) return 'Carriageway';
  if (axis === 'we') return d < 0 ? 'West footway' : 'East footway';
  return d < 0 ? 'South footway' : 'North footway';
}

/**
 * The full locator readout for the current stage.
 * @param {object} ctx { stage, walking, interiorName, camera }
 * @returns {{body: string, place: string, context: string}}
 */
export function locate(ctx) {
  const site = settledSite();

  if (ctx.stage === 'orbit') {
    return {
      body: 'Amarine',
      place: 'Orbital Survey',
      context: ctx.summary || '',
    };
  }

  if (ctx.stage === 'eagle') {
    return {
      body: site ? site.name : 'Veridian Cap',
      place: 'Settlement Survey',
      context: site ? `${site.region} · ${site.coord}` : '',
    };
  }

  const p = ctx.camera
    ? walkLocation(ctx.camera.position.x, ctx.camera.position.z, ctx.interiorName)
    : { place: 'Veridian Cap', detail: '' };
  return {
    body: site ? site.name : 'Veridian Cap',
    place: p.place,
    context: p.detail,
  };
}

export { NS_NAMES, EW_NAMES, AVENUE_NAME };
