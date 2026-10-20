import { buildSettlements, developmentAt } from '../../src/procedural/settlement.js';
import { reliefAt, landformAt } from '../../src/procedural/terrain.js';
import { fbm2 } from '../../src/procedural/seed.js';
buildSettlements();
const rs=[], hs=[], fs=[];
for (let z=-3000; z<=3000; z+=60) for (let x=-3000; x<=3000; x+=60) {
  fs.push(fbm2(x*0.00042+91.3, z*0.00042-12.7, 3));
  rs.push(reliefAt(x,z)); hs.push(landformAt(x,z));
}
const q = (a,p)=>{const s=[...a].sort((x,y)=>x-y); return s[Math.min(s.length-1, Math.floor(s.length*p))].toFixed(3);};
console.log('fbm2 habitability  min/p10/p50/p90/max:', q(fs,0), q(fs,.1), q(fs,.5), q(fs,.9), q(fs,1));
console.log('reliefAt           min/p10/p50/p90/max:', q(rs,0), q(rs,.1), q(rs,.5), q(rs,.9), q(rs,1));
console.log('landformAt (m)     p50/p90/p99/max:', q(hs,.5), q(hs,.9), q(hs,.99), q(hs,1));
