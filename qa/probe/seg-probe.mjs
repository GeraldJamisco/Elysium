import { buildSettlements, allSettlements } from '../../src/procedural/settlement.js';
import { generateHighways, ensureSettlementRoads, segmentsForChunk } from '../../src/procedural/roads.js';
buildSettlements(); generateHighways();
const list = allSettlements();
for (const s of list.filter(s => Math.hypot(s.x,s.z) < 1400)) ensureSettlementRoads(s);
// tally by type across the region
const seen = new Map();
for (let cz = -8; cz <= 8; cz++) for (let cx = -8; cx <= 8; cx++)
  for (const g of segmentsForChunk(cx, cz, 200, 0)) seen.set(g.id, g);
const tally = {};
let len = {};
for (const g of seen.values()) { tally[g.type] = (tally[g.type]||0)+1; len[g.type]=(len[g.type]||0)+g.len; }
console.log('segments within +/-1600m:', tally);
console.log('total km by type:', Object.fromEntries(Object.entries(len).map(([k,v])=>[k,(v/1000).toFixed(2)])));
