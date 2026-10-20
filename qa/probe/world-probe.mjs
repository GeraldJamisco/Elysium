import { buildSettlements, allSettlements, developmentAt, TIER } from '../../src/procedural/settlement.js';
import { generateHighways, ensureSettlementRoads, segmentCount, segmentsForChunk } from '../../src/procedural/roads.js';

buildSettlements();
const list = allSettlements();
console.log('settlements:', list.length);
const byTier = {};
for (const s of list) byTier[s.label] = (byTier[s.label] || 0) + 1;
console.log('by tier:', byTier);
console.log('within 2500m:', list.filter(s => Math.hypot(s.x, s.z) < 2500).length);
for (const s of list.filter(s => Math.hypot(s.x,s.z) < 2200).sort((a,b)=>Math.hypot(a.x,a.z)-Math.hypot(b.x,b.z)))
  console.log(`  ${s.name.padEnd(12)} ${s.label.padEnd(16)} (${s.x.toFixed(0)}, ${s.z.toFixed(0)}) d=${Math.hypot(s.x,s.z).toFixed(0)} edgeR=${s.edgeR}`);

console.time('regional');
generateHighways();
console.timeEnd('regional');
console.log('regional segments:', segmentCount());

for (const s of list.filter(s => Math.hypot(s.x,s.z) < 1600)) {
  const t0 = Date.now();
  const before = segmentCount();
  ensureSettlementRoads(s);
  console.log(`  roads ${s.name} (${s.label}) +${segmentCount()-before} segs in ${Date.now()-t0}ms`);
}

// Density profile along +X from Veridian Cap
console.log('\nintensity profile along +X:');
let line = '';
for (let x = 0; x <= 2000; x += 50) {
  const d = developmentAt(x, 0);
  line += `${x}:${d.band.name.slice(0,4)}(${d.intensity.toFixed(2)}) `;
  if (x % 500 === 450) { console.log('  ' + line); line = ''; }
}
console.log('  ' + line);
