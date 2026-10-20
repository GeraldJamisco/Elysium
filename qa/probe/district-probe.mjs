import { buildSettlements, allSettlements, developmentAt, BAND } from '../../src/procedural/settlement.js';
import { landformAt, reliefAt } from '../../src/procedural/terrain.js';
buildSettlements();
const vc = allSettlements()[0];
console.log('Veridian Cap', vc.coreR, vc.edgeR, 'spokes', vc.spokes, 'blockM', vc.blockM, 'grain', vc.grain.toFixed(2));

// Sample the disc: how much of it passes each street test?
let tot=0, okDev=0, okLand=0, okAll=0;
for (let r = 100; r < 700; r += 10) {
  for (let a = 0; a < Math.PI*2; a += 0.05) {
    const x = vc.x + Math.cos(a)*r, z = vc.z + Math.sin(a)*r;
    tot++;
    const dev = developmentAt(x,z);
    const d1 = dev.settlement === vc && dev.intensity >= BAND.EDGE.min;
    const d2 = landformAt(x,z) <= 2.5;
    if (d1) okDev++;
    if (d2) okLand++;
    if (d1 && d2 && Math.hypot(x,z) >= vc.authoredR) okAll++;
  }
}
console.log('samples', tot, 'pass dev', (okDev/tot*100).toFixed(1)+'%', 'pass landform', (okLand/tot*100).toFixed(1)+'%', 'pass all', (okAll/tot*100).toFixed(1)+'%');
console.log('relief at a few points:', [200,400,600].map(r=>landformAt(r,0).toFixed(1)).join(' '));
