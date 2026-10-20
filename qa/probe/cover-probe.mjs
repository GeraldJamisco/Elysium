import { buildSettlements, developmentAt, BAND } from '../../src/procedural/settlement.js';
import { landformAt } from '../../src/procedural/terrain.js';
buildSettlements();
const tally = {};
const cols = {};
for (let z=-1200; z<=1200; z+=88) for (let x=-1200; x<=1200; x+=88) {
  const dev = developmentAt(x,z), relief = landformAt(x,z);
  let kind;
  if (relief > 3.0) kind='wood';
  else if (relief > 1.2) kind='scrub';
  else if (dev.intensity >= BAND.EDGE.min) kind='park';
  else if (dev.intensity >= BAND.FRINGE.min) kind='meadow';
  else kind = 'country';
  tally[kind]=(tally[kind]||0)+1;
  if (kind==='country') cols[`r=${dev.r.toFixed(0)}`]=(cols[`r=${dev.r.toFixed(0)}`]||0)+1;
}
console.log(tally);
console.log('dev.r values seen in countryside:', Object.keys(cols).slice(0,8));
