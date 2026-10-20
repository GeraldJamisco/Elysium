import { buildSettlements, allSettlements } from '../../src/procedural/settlement.js';
import { generateHighways, ensureSettlementRoads, segmentsForChunk } from '../../src/procedural/roads.js';
import { parcelsForSegment, farmsteadsForChunk } from '../../src/procedural/parcels.js';
buildSettlements(); generateHighways();
for (const s of allSettlements().filter(s => Math.hypot(s.x,s.z) < 1400)) ensureSettlementRoads(s);

const kinds = {}, bands = {}, floors = {};
let total = 0, maxPerChunk = 0, chunksWith = 0;
const t0 = Date.now();
for (let cz = -5; cz <= 5; cz++) for (let cx = -5; cx <= 5; cx++) {
  if (cx===0&&cz===0) continue;
  const b = { minX: cx*200, maxX: cx*200+200, minZ: cz*200, maxZ: cz*200+200 };
  const near = segmentsForChunk(cx, cz, 200, 70);
  const out = [];
  for (const s of near) parcelsForSegment(s, b, near, out);
  farmsteadsForChunk(b, near, out);
  total += out.length;
  if (out.length) chunksWith++;
  maxPerChunk = Math.max(maxPerChunk, out.length);
  for (const p of out) { kinds[p.kind]=(kinds[p.kind]||0)+1; bands[p.band]=(bands[p.band]||0)+1; floors[p.floors]=(floors[p.floors]||0)+1; }
}
console.log('parcels in +/-1000m:', total, 'chunks with content:', chunksWith, 'max/chunk:', maxPerChunk, `(${Date.now()-t0}ms)`);
console.log('by kind:', kinds);
console.log('by band:', bands);
console.log('by floors:', floors);
