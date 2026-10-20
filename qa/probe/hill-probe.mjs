import { buildSettlements } from '../../src/procedural/settlement.js';
import { buildRelief, landformAt } from '../../src/procedural/terrain.js';
buildSettlements();
const m = buildRelief();
console.log('relief mesh:', m ? m.geometry.attributes.position.count/3 + ' triangles' : 'NULL');
if (m) { m.geometry.computeBoundingBox(); console.log('bbox', JSON.stringify(m.geometry.boundingBox)); }
