// Check pixel variance of interior screenshots - if black/empty, variance ~0
const fs = require('fs');
const path = require('path');
const { PNG } = require('pngjs') || {};
if (!PNG) {
  // fallback - check if pngjs available
  console.log('pngjs not found - trying to load from temp');
  try { module = require('C:/Users/t/AppData/Local/Temp/node_modules/pngjs'); } catch {}
}

try {
  const pngjs = require('pngjs');
  const dir = path.resolve(__dirname, 'screenshots');
  for (const f of ['03-interior-wide.png','04-interior-detail.png','05-window-view.png','01-exterior-entrance.png']) {
    const data = fs.readFileSync(path.join(dir,f));
    const png = pngjs.PNG.sync.read(data);
    let sum=0, sum2=0, min=255, max=0, n=0;
    const { width, height } = png;
    for (let i=0;i<width*height;i++){
      const idx=i*4;
      const lum = 0.299*png.data[idx]+0.587*png.data[idx+1]+0.114*png.data[idx+2];
      sum+=lum; sum2+=lum*lum; n++;
      if(lum<min)min=lum; if(lum>max)max=lum;
    }
    const mean=sum/n;
    const variance=sum2/n - mean*mean;
    console.log(`${f}: w=${width} h=${height} meanLum=${mean.toFixed(1)} std=${Math.sqrt(variance).toFixed(1)} min=${min} max=${max}`);
  }
} catch(e) { console.log('ERR', e.message); }
