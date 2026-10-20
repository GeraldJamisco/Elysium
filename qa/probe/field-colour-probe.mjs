import { buildSettlements, developmentAt, BAND } from '../../src/procedural/settlement.js';
import { landformAt, reliefAt } from '../../src/procedural/terrain.js';
import { hash2, fbm2 } from '../../src/procedural/seed.js';
buildSettlements();
const CROP=[0x9aaa6e,0x8fa15e,0xa8b67b,0x7e8c50,0x889a5a,0xbaa76a,0xa39455,0xc2b47e,0x94a765,0x6f8248];
const PASTURE=[0x84a06a,0x7b9663,0x8daa72,0x759160], MEADOW=[0x8fab6f,0x9cb578,0x85a367];
const WOOD=[0x4f6b43,0x577248,0x47603c], PARK=[0x7ba876,0x86b07d,0x71a06d], SCRUB=[0x8a9268,0x939a72];
const P=88;
const fc=(i,j)=>[(i+0.15+hash2(i*37+5,j*61+13)*0.7)*P,(j+0.15+hash2(j*43+7,i*71+3)*0.7)*P];
const fid=(i,j)=>(i*73856093)^(j*19349663);
function coverAt(x,z,f){
  const dev=developmentAt(x,z), relief=landformAt(x,z);
  if(relief>3.0) return {kind:'wood',pal:WOOD};
  if(relief>1.2) return {kind:'scrub',pal:SCRUB};
  if(dev.intensity>=BAND.EDGE.min) return {kind:'park',pal:PARK};
  if(dev.intensity>=BAND.FRINGE.min) return {kind:'meadow',pal:MEADOW};
  const farmness=1-Math.min(1,dev.r/2400)+(fbm2(x*0.0006+7.7,z*0.0006-3.1,2)-0.5)*0.7;
  if(farmness>0.34) return hash2(f&0xffff,(f>>>16)&0xffff)<0.42?{kind:'pasture',pal:PASTURE}:{kind:'crop',pal:CROP};
  return {kind:'meadow',pal:MEADOW};
}
const tally={}, colTally={};
for(let j=-14;j<=14;j++) for(let i=-14;i<=14;i++){
  const [x,z]=fc(i,j), f=fid(i,j), c=coverAt(x,z,f);
  tally[c.kind]=(tally[c.kind]||0)+1;
  const col=c.pal[Math.abs(f+(f>>7))%c.pal.length];
  colTally['#'+col.toString(16)]=(colTally['#'+col.toString(16)]||0)+1;
}
console.log('field kinds:',tally);
console.log('distinct colours emitted:',Object.keys(colTally).length);
console.log(colTally);
