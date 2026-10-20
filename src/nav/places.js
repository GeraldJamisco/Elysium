import { PINS } from '../config.js';
import { REGIONS, toVec, sampleAll, resolveSettlement, inlandDepth } from '../world.js';

// ============================================================
// ELYSIUM NAVIGATION — THE SURVEY REGISTER
//
// The data layer behind the navigation system: one record per
// charted site on Amarine.
//
// Everything measurable here is SAMPLED FROM THE WORLD, not
// typed in — region, elevation band, terrain, how far inland a
// site sits.  That matters because the register is the thing
// that tells a player a place is worth visiting; if it described
// a site the planet does not actually show, the whole navigation
// chain would be decoration rather than information.
//
// Only the prose is authored.
// ============================================================

/**
 * Human copy for each site. Everything else is derived.
 *
 * The epithet does a lot of work: a name alone is an index entry, a name
 * with an epithet is a place with a character, and that is the difference
 * between a list you scan and a list you choose from.
 */
const LORE = {
  'Veridian Cap': {
    epithet: 'The First Landing',
    blurb: 'The first landing. A close-built town of terraces and colonnades around a walled green, ' +
           'where the survey road turns east into open country.',
    founded: 'Year 4 of the survey',
    character: ['Walkable', 'Temperate', 'Inhabited'],
    // Places worth going once you are there. Every one of these is a real
    // location in the built world, at its real coordinates.
    highlights: [
      {
        id: 'green', name: 'The Green',
        note: 'Walled park, ring walk and the founders’ marker at its centre.',
        at: [0, 0],
        arrive: { x: 0, z: 11.5, yaw: 0 },
        shot: { pos: [0, 13, 25], look: [0, 1.5, 0], fov: 54 },
      },
      {
        id: 'hall', name: 'Community Hall',
        note: 'The civic building on the park’s west frontage. You can go inside.',
        at: [-36.3, -8.55],
        arrive: { x: -22.25, z: -8.55, yaw: Math.PI / 2 },
        shot: { pos: [-22.5, 5.4, -3.5], look: [-44, 5.0, -9.5], fov: 54 },
      },
      {
        id: 'row', name: 'Lantern Row',
        note: 'The eastern street, under the tallest terraces in the settlement.',
        at: [27.5, -6],
        arrive: { x: 23.2, z: -12, yaw: Math.PI },
        shot: { pos: [23.2, 2.3, -16], look: [23.2, 7, 14], fov: 62 },
      },
      {
        id: 'reach', name: 'The Reach Road',
        note: 'The avenue out of town, running east into open country.',
        at: [88, 0],
        arrive: { x: 84, z: -5.25, yaw: -Math.PI / 2 },
        shot: { pos: [84, 2.6, 0], look: [200, 6, 0], fov: 56 },
      },
    ],
    // The establishing view of the settlement, used as the card's hero.
    hero: { pos: [62, 33, 66], look: [2, 7, 0], fov: 46 },
  },
  'Lapis Strand': {
    epithet: 'The Long Shelf',
    character: ["Coastal","Shallow","Unlanded"],
    blurb: 'A long shelving coast of pale sand and shallow water. Charted from orbit; no party has landed.',
  },
  'Warmont': {
    epithet: 'The Standing Wood',
    character: ["Island","Wooded","Unlanded"],
    blurb: 'High ground standing alone in the middle ocean, wooded to the shoreline.',
  },
  'Ember Reach': {
    epithet: 'The Reefed Isle',
    character: ["Island","Warm","Unlanded"],
    blurb: 'The largest of the eastern isles. Warm, steep, and ringed by reef.',
  },
  'Cordoba Bay': {
    epithet: 'The Sheltered Inlet',
    character: ["Coastal","Cold","Unlanded"],
    blurb: 'A sheltered northern inlet under the Verdance ranges. Good water, hard winters.',
  },
  'Solace': {
    epithet: 'The Open Rim',
    character: ["Grassland","Dry","Unlanded"],
    blurb: 'Open grassland running to the horizon on the basin’s northern rim.',
  },
  'Aegir Haven': {
    epithet: 'The Deep Harbour',
    character: ["Coastal","Sheltered","Unlanded"],
    blurb: 'A deep natural harbour on the eastern basin coast, sheltered from the prevailing weather.',
  },
  'Talus': {
    epithet: 'The Broken Upland',
    character: ["Upland","Exposed","Unlanded"],
    blurb: 'Broken upland at the southern end of Calder Reach. Thin soil, long views.',
  },
  'Marin': {
    epithet: 'The Green Headland',
    character: ["Coastal","Wooded","Unlanded"],
    blurb: 'A green headland on the southern Verdance coast, a week overland from the Cap.',
  },
  'Palisade': {
    epithet: 'The Standing Ridge',
    character: ["Island","Steep","Unlanded"],
    blurb: 'A solitary ridge breaking the mid-ocean swell. Steep on every side.',
  },
};

/** Which authored landmass a point falls in — the site's region name. */
function regionOf(lat, lon) {
  const p = toVec(lat, lon);
  let best = null, bestDot = -2;
  for (const reg of REGIONS) {
    for (const lb of reg.lobes) {
      const c = toVec(lb[0], lb[1]);
      const d = c[0] * p[0] + c[1] * p[1] + c[2] * p[2];
      if (d > bestDot) { bestDot = d; best = reg; }
    }
  }
  return best ? best.name : 'Open Ocean';
}

/** Plain-language terrain for a sampled point. */
function terrainOf(elev, moist) {
  if (elev > 0.50) return 'Alpine ridge';
  if (elev > 0.37) return 'Rock and scree';
  if (elev > 0.24) return 'Upland';
  if (moist > 0.62) return 'Closed forest';
  if (moist > 0.50) return 'Wooded country';
  if (moist > 0.38) return 'Open grassland';
  return 'Dry grassland';
}

function elevationBand(elev) {
  // The elevation field is normalised 0..1; presenting it as a band rather
  // than a fake metre figure keeps the register honest about what it knows.
  if (elev > 0.50) return 'High';
  if (elev > 0.37) return 'Elevated';
  if (elev > 0.24) return 'Rolling';
  if (elev > 0.10) return 'Low';
  return 'Coastal';
}

/** Format a coordinate the way a survey would write it. */
/**
 * Four comparable measures per site, each 0..1.
 *
 * Gauges rather than numbers because the register's job is COMPARISON —
 * a player deciding where to go wants to see at a glance that one site is
 * wetter and lower than another, not to read two decimal places.
 */
function gaugesFor(elev, moist, inland) {
  return [
    { k: 'Relief', v: Math.max(0.04, Math.min(1, elev / 0.62)) },
    { k: 'Green cover', v: Math.max(0.04, Math.min(1, (moist - 0.25) / 0.5)) },
    { k: 'Shelter', v: Math.max(0.04, Math.min(1, inland / 6)) },
    { k: 'Survey depth', v: 0.08 },
  ];
}

export function formatCoord(lat, lon) {
  const ns = lat >= 0 ? 'N' : 'S';
  const ew = lon >= 0 ? 'E' : 'W';
  return `${Math.abs(lat).toFixed(1)}°${ns}  ${Math.abs(lon).toFixed(1)}°${ew}`;
}

let _sites = null;

/**
 * The full register, built once.
 * Sites are ordered settled-first, then by region, so the one place a
 * player can actually go is never buried in the list.
 */
export function sites() {
  if (_sites) return _sites;

  const resolved = resolveSettlement(PINS);
  const list = resolved.map(p => {
    const v = toVec(p.lat, p.lon);
    const s = sampleAll(v);
    const lore = LORE[p.name] || {};
    return {
      id: p.name.toLowerCase().replace(/[^a-z]+/g, '-'),
      name: p.name,
      settled: !!p.real,
      status: p.real ? 'Settled' : 'Surveyed',
      lat: p.lat,
      lon: p.lon,
      coord: formatCoord(p.lat, p.lon),
      region: regionOf(p.lat, p.lon),
      elev: s.elev,
      moist: s.moist,
      terrain: terrainOf(s.elev, s.moist),
      band: elevationBand(s.elev),
      inland: p.inland !== undefined ? p.inland : inlandDepth(p.lat, p.lon),
      epithet: lore.epithet || '',
      hero: lore.hero || null,
      character: lore.character || [],
      highlights: lore.highlights || [],
      gauges: gaugesFor(s.elev, s.moist, p.inland !== undefined ? p.inland : 0)
        .map(g => (g.k === 'Survey depth' ? { ...g, v: p.real ? 1 : 0.12 } : g)),
      blurb: lore.blurb || '',
      founded: lore.founded || null,
      // Why a site cannot be entered. Shown instead of a dead button, so the
      // player learns something rather than being told no.
      lockNote: p.real ? null : 'Charted from orbit. No landing site prepared.',
    };
  });

  list.sort((a, b) => {
    if (a.settled !== b.settled) return a.settled ? -1 : 1;
    if (a.region !== b.region) return a.region.localeCompare(b.region);
    return a.name.localeCompare(b.name);
  });

  _sites = list;
  return _sites;
}

/** Sites grouped by region, settled region first. */
export function sitesByRegion() {
  const groups = new Map();
  for (const s of sites()) {
    if (!groups.has(s.region)) groups.set(s.region, []);
    groups.get(s.region).push(s);
  }
  return [...groups.entries()].map(([region, list]) => ({ region, list }));
}

export function siteById(id) { return sites().find(s => s.id === id) || null; }
export function settledSite() { return sites().find(s => s.settled) || null; }

export function registerSummary() {
  const all = sites();
  const settled = all.filter(s => s.settled).length;
  return { total: all.length, settled, surveyed: all.length - settled };
}
