// ============================================================
// PLANET: AMARINE — a green, livable near-future colony world.
// First settlement: VERIDIAN CAP.
// Human-scaled, relaxing, soft sci-fi.
// ============================================================

export const PLANET = {
  name: 'Amarine',
  title: 'VERIDIAN CAP',
  subtitle: 'first colony of Amarine · click the settlement to descend',
};

export const PINS = [
  { name: 'Veridian Cap', real: true,  lat:  8, lon:  40 },
  { name: 'Lapis Strand',  real: false, lat: 22, lon:  85 },
  { name: 'Warmont',       real: false, lat: 36, lon:  -4 },
  { name: 'Ember Reach',   real: false, lat: 14, lon: 102 },
  { name: 'Cordoba Bay',   real: false, lat: 44, lon:  74 },
  { name: 'Solace',        real: false, lat: -6, lon: -50 },
  { name: 'Aegir Haven',   real: false, lat:-24, lon: -14 },
  { name: 'Talus',         real: false, lat: 28, lon: -78 },
  { name: 'Marin',         real: false, lat:-14, lon:  30 },
  { name: 'Palisade',      real: false, lat: 10, lon: -32 },
];

// ---- 3-stage camera parameters ----
export const STAGES = {
  orbit: {
    // Planet fills ~55–65% of viewport height from the resting camera, fully
    // visible limb, space around it, planet sitting a touch below center.
    cameraPos: [84, 72, 80],
    target: [0, 0, 0],
    minDist: 118,
    maxDist: 320,
    enablePan: false,
    globeAutoRotateSpeed: 0.0001,
  },
  eagle: {
    cameraPos: [5, 70, 35],
    target: [0, 0, 0],
    minDist: 38,
    maxDist: 1000,
    enablePan: true,
    panSpeed: 0.5,
    // Survey envelope: eagle target cannot pan beyond these bounds. Tight to the
    // settlement + avenue + a modest buffer, so panning can't drift into empty space.
    surveyHalfWidth: 120,
    surveyHalfDepth: 120,
    panScale: 0.6,          // target pan speed scales with camera distance
  },
  walk: {
    // Eye height is absolute world-space Y (cameraControls pins it every frame via
    // camera.position.y = STAGES.walk.height). Sidewalks sit at y=0.35, so a
    // height of 2.05 floats the eye ~1.7 above the sidewalk surface.
    height: 2.05,
    speed: 5.0,
    sensitivity: 0.002,
    // Spawn stands on the south sidewalk of EW road 1 (z range -32..-29.5),
    // on the east sidewalk of NS road 1 (x range -23.5..-21), facing north
    // toward the central park across the road.
    spawnPos: [-22, 2.05, -30.75],     // Veridian Cap walk spawn, x/y/z
    spawnRot: [0, 0, 0, 'YXZ'],       // Euler angles for spawn orientation (north)
  },
};

// ---- Town layout: gentle organic grid with a central green ----
export const TOWN = {
  blocksX: 3,
  blocksZ: 3,
  blockW: 42,
  blockD: 38,
  roadW:  8,
  sidewalkW: 2.5,
  curbH: 0.14,

  // Phase 3 spatial grammar
  setback: 3.5,           // building front face → block boundary
  entranceWidth: 1.2,
  entranceHeight: 2.0,

  avenueDir: 8,
  avenueLen: 200,
};

// ---- Architecture: footprint envelopes and target heights ----
// FOOTPRINTS ARE THE PHASE 3 SPATIAL GRAMMAR AND MUST NOT CHANGE.
// Heights are targets only: facades.js snaps each to a whole number of
// floors. The ranges are spread wider than Phase 3 so the settlement has a
// legible skyline — low domestic blocks, a mid-rise commercial grain, and a
// clearly taller anchor group at the head of the avenue.
export const ARCH = {
  villa: {
    h: [7, 11],      // 3 storeys over a raised ground floor
    w: [9, 14],
    d: [8, 13],
  },
  arcade: {
    h: [12, 21],     // 4-5 storeys
    w: [10, 16],
    d: [9, 14],
  },
  terrace: {
    h: [28, 44],     // 8-12 storeys — the landmark anchors
    w: [9, 13],
    d: [8, 12],
  },
};

export const CAMERA = {
  globeRadius: 55,
};

// ---- ORBIT: how Amarine is lit and coloured from space ----
// Separate from ATMOS, which describes the sky seen from the SURFACE.
// The two are different places and want different light; sharing one set
// of values is what left the planet rendered against a daytime sky.
export const ORBIT = {
  // Sun to the right of and slightly behind the opening camera, so the
  // planet reads as three-quarter lit with a terminator down its left.
  sunDir: [0.86, 0.30, -0.42],
  sunColor: 0xfff2dc,
  surfaceExposure: 1.62,

  // Night side. Low enough to read as night, high enough that the
  // continents do not vanish into the background.
  nightAmbient: 0x2a3f52,

  atmoColor: 0x86c6e8,
  atmoStrength: 1.35,

  cloudColor: 0xf2f6f6,
  cloudOpacity: 0.42,

  // Veridian Cap's lights, seen from orbit.
  cityLight: 0xffd9a2,
};

// ---- Phase 7: Procedural planetary infrastructure ----
//
// Phase 7 originally described the world as one density ring around
// Veridian Cap.  The visual-sanitation pass replaced that with a
// catalogue of settlements of different sizes (settlement.js), so the
// parameters here are about how the civilization is DISTRIBUTED rather
// than how far it extends from the origin.
export const PROC = {
  chunkSize: 200,
  // The old pair of numbers contradicted each other: maxGenDistance said
  // 2000 m but unloadDistance threw away anything past 800, so the land
  // cover ended in a hard circle 800 m from the camera with the bare
  // ground plane beyond it — clearly visible from high Eagle as the edge
  // of the world.  Land cover now runs to the same distance it is kept.
  unloadDistance: 1500,
  maxGenDistance: 1500,
  // Phase 9A: how far the world is built WHEN LOOKING AT IT FROM EAGLE.
  //
  // Eagle is the only stage that can see a region; from Walk the horizon
  // and the haze make anything past a few hundred metres irrelevant, and
  // from Orbit the planet is a globe.  Building 2.5 km of world for a
  // camera at eye height would be paid for in every walk session and
  // seen in none of them, so the radius follows the stage.
  //
  // 2500 m was chosen by measurement, not by preference.  Across the ten
  // fixed regional viewpoints the worst-case cost was:
  //
  //   1500 m  244 calls / 1.45 M tris   (Thornwater edge only)
  //   2000 m  365 calls / 1.76 M tris   (+ Thornwater, Aldfold)
  //   2500 m  459 calls / 1.81 M tris   (+ Elmmere)
  //   3000 m  555 calls / 1.81 M tris   (nothing new)
  //
  // Triangles plateau at 2500 because everything beyond it is empty
  // countryside: 3 km costs another ~96 draw calls per frame and shows
  // no additional civilization at all.
  regionalGenDistance: 2500,
  // Phase 9A regional mass (LOD 3).  A runtime switch, so a measurement
  // run can compare with and without it on one build instead of trusting
  // two separate builds to differ only in the thing being measured.
  regionalMass: true,
  lod0Dist: 200,          // full detail within this distance
  lod1Dist: 500,          // building masses within this distance

  // Per-chunk building budget.  Frontage placement produces far fewer
  // candidates per chunk than the old 26 m grid did, and they are all in
  // the right places, so the cap is a safety net rather than a shaper.
  maxBuildingsPerChunk: 90,
  procSeed: 0x7EED,

  // ---- Settlement distribution ----
  // Sites are drawn on a lattice of this pitch out to this reach.  Only
  // `settlementOccupancy` of the cells are settled at all, and the
  // separation rule rejects most of those, so the planet ends up with a
  // few dozen places in a great deal of open country — which is the
  // ratio that makes the world feel large.
  settlementCell: 900,
  settlementReach: 6500,
  settlementOccupancy: 0.55,
  countrysideBelt: 240,     // minimum open land between two settlements

  // Extra inter-settlement links beyond the spanning tree are only worth
  // building between places this close together.
  regionalLinkMax: 2600,

  // ---- Landform ----
  // Relief is suppressed under development, so these describe the
  // countryside.  The thresholds that decide what counts as high ground
  // live in terrain.js, expressed against the measured range of the
  // habitability field rather than against an assumed 0..1.
  reliefHeight: 82,
  reliefReach: 3400,

  // ---- Countryside occupation ----
  farmsteadChance: 0.24,    // per 170 m cell, before land-use filtering
  // Phase 9C: a farm must be reachable, not adjacent.
  //
  // At 95 m a farmstead had to sit almost on the verge, because the
  // connection to the road was implied rather than drawn — and the
  // filter rejected so many candidates that 1600 m of farmland carried
  // three farms.  Now that ruralinfra.js lays the TRACK, a farm can sit
  // where a farm actually sits: back from the lane, in its own fields,
  // with a visible way in.
  farmAccessRange: 210,

  // ---- Reserved land ----
  //
  // Ground inside the settlement that is deliberately NOT for sale.  The
  // procedural layer treats every buildable parcel as developable unless
  // something says otherwise, so a reservation has to be explicit or the
  // next generation pass simply builds houses on it.
  //
  // The stadium site: the large open field south-east of the centre,
  // measured off a calibrated top-down capture rather than estimated
  // from a perspective view.  Its north-west corner meets the central
  // green's corner, and its eastern edge runs within ~25 m of The Reach
  // Road — so the site the settlement had already left open is also the
  // one with the best access it could have, which is why it is the right
  // place for a stadium and not merely an available one.
  //
  // Access hierarchy for the future stadium:
  //   regional road -> gateway roundabout -> The Reach Road (arterial)
  //   -> stadium approach -> pedestrian plaza -> stadium
  reservations: [
    {
      id: 'stadium',
      name: 'Stadium Reservation',
      kind: 'stadium',
      // Set from two positions the mayor walked to and marked with P:
      //   (222.45, 124.84) and (106.48, 222.23) — opposite corners.
      // The previous box (95..215, 90..205) was my own reading of a
      // screenshot and was never confirmed; it sat too far north-west.
      minX: 106.48, maxX: 222.45, minZ: 124.84, maxZ: 222.23,
    },
  ],

  // Eagle expansion beyond Veridian Cap
  eaglePanLimit: 5000,
};

export const ATMOS = {
  // ---- Canonical sun ----
  // Late afternoon, ~41 degrees elevation, sitting off the north-east so the
  // north- and east-facing street frontages are the lit ones.  Those are the
  // facades the player meets on entering Walk and the far side of the green
  // from every southern approach, so they are the ones worth the key light.
  // Shared by the sky shader and the directional light, so the visible sun
  // and the cast shadows always agree.
  sunDir: [0.44, 0.66, 0.61],
  sunColor: 0xffe8c8,
  sunIntensity: 2.75,

  // ---- Sky dome ----
  zenith:    0x3f7cba,
  skyMid:    0x8fbcd6,
  horizon:   0xdcd2bc,
  hazeColor: 0xcfc9b6,

  // ---- Bounce ----
  skyBounce:    0xa8c8e4,   // hemisphere up colour
  groundBounce: 0x7a7c52,   // hemisphere down colour (green terrain)
  hemiIntensity: 1.05,
  ambientColor: 0x9db0c4,
  ambientIntensity: 0.20,

  // ---- Aerial perspective ----
  // Re-tuned in the Phase 7 visual-sanitation pass.  The old density was
  // set when the world ended at a 452 m plate: at 1500 m it reaches 98%
  // opacity, which was fine for hiding the edge of a small plate and
  // useless for a planet that now carries settlements and countryside out
  // past 2000 m.  From high Eagle the whole region simply disappeared
  // into haze, so there was no aerial read left to judge.
  //
  // This is aerial perspective doing its actual job rather than fog
  // covering for missing content: under 1% at 100 m, ~8% at 500 m — so
  // the settlement is still never veiled — rising to ~75% at 2000 m,
  // which puts the far regions behind distance without erasing them.
  fogColor:  0xc4c8b6,
  fogDensity: 0.00058,
  // Phase 9A: aerial perspective at EAGLE only.
  //
  // 0.00058 is tuned for the street, where haze a few hundred metres out
  // is most of the soft-daylight look, and it stays exactly that for
  // Walk and for the descent.  From Eagle the same number is measuring a
  // different thing: the camera sits 2.2 km up, so the ground beneath it
  // is already a fog distance away and the neighbouring towns are 3-4 km
  // out — FogExp2 saturates past 95% and the whole region renders as a
  // pale wash.  The regional LOD was building settlements that could not
  // be seen at all.
  //
  // 0.00028 keeps roughly half the contrast at 3 km instead of 12%, so
  // depth still reads — near fields stay crisp, far towns still sit
  // behind air — without erasing what is there.  It is a reduction in
  // saturation, not a removal of atmosphere.
  fogDensityEagle: 0.00028,
};