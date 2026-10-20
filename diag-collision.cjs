#!/usr/bin/env node
const path=require('path'),fs=require('fs');
let puppet;
try{puppet=require('puppeteer-core');}catch{}
if(!puppet){try{puppet=require(path.join('C:\\Users\\t\\AppData\\Local\\Temp','node_modules','puppeteer-core'));}catch{}}
const sleep=ms=>new Promise(r=>setTimeout(r,ms));

if(!puppet){console.error('no puppeteer');process.exit(1);}
const CHROME_PATHS=['C:/Program Files/Google/Chrome/Application/chrome.exe','C:/Program Files (x86)/Google/Chrome/Application/chrome.exe'];
const chromePath=CHROME_PATHS.find(p=>{try{fs.accessSync(p);return true;}catch{return false;}});
if(!chromePath){console.error('no chrome');process.exit(1);}

(async()=>{
  const browser=await puppet.launch({executablePath:chromePath,headless:'new',
    args:['--no-sandbox','--disable-setuid-sandbox','--use-gl=angle','--use-angle=swiftshader','--ignore-gpu-blocklist','--enable-unsafe-swiftshader']});
  const page=(await browser.pages())[0];
  await page.goto('http://localhost:5173/',{waitUntil:'domcontentloaded',timeout:60000});
  await page.waitForSelector('#mc-canvas',{timeout:15000});
  await sleep(2000);

  const res=await page.evaluate(()=>{
    const reg=window.MC.collisionRegistry;
    const R=0.4;
    const EX=b=>b.type!=='interior';
    // Find the civic building body: b@-44.5,-8.5, x[-51.6,-37.3], z[-15.5,-1.6]
    const b=reg.getBodies().find(x=>x.type==='building'&&x.minX>(-53)&&x.maxX<(-36)&&x.minZ>(-17)&&x.maxZ<0);
    if(!b) return {found:false,count:reg.getBodies().filter(x=>x.type==='building').length};
    const bx=b.minX,bz=b.minZ,bxx=b.maxX,bzz=b.maxZ;
    const pen=(px,pz)=>{
      const clx=Math.max(bx,Math.min(px,bxx));
      const clz=Math.max(bz,Math.min(pz,bzz));
      const d=Math.sqrt((px-clx)**2+(pz-clz)**2);
      return d<R?R-d:0;
    };
    // interior inner bounds (WALL_THICK 0.15 inset)
    const iX0=bx+0.15, iX1=bxx-0.15, iZ0=bz+0.15, iZ1=bzz-0.15;
    const iCX=(iX0+iX1)/2, iCZ=(iZ0+iZ1)/2;
    const tests=[];

    // ---- EXTERIOR filter tests: walls block from all directions ----
    const dirs=[
      ['east head-on',      iCX,  iCZ,  20,     0],   // into east face (entrance side)
      ['east 45 deg',     bxx+3,iCZ, -2,     3],   // diag into east face
      ['west wall',        bx-3,  iCZ, -10,    0],   // into west face
      ['south wall',       iCX,   bz-3,  0,    -5],  // into south face
      ['north wall',       iCX,   bzz+3,  0,     5],  // into north face
      ['south-east corner', bxx-2,bz-2,  3,    -1],  // SE corner diag
    ];
    for(const [name,fx,fz,dx,dz] of dirs){
      const r=reg.preventTunneling(fx,fz,dx,dz,R,EX);
      const p=pen(r.x,r.z);
      tests.push({name,rx:+r.x.toFixed(2),rz:+r.z.toFixed(2),pen:+p.toFixed(4), pass:p<R});
    }

    // ---- Entrance: walk toward the east plinth gap (z gap [-9.1,-7.9]) ----
    // Approach from east side; should reach the door gap but never penetrate the body
    const er=reg.preventTunneling(bxx+4, iCZ, -5, 0, R, EX);
    tests.push({name:'entrance door (east)',rx:+er.x.toFixed(2),rz:+er.z.toFixed(2),pen:+pen(er.x,er.z).toFixed(4),pass:pen(er.x,er.z)<R});

    // ---- EXIT position: after exit at (-36.3,-8.55) with EX filter ----
    const exitX=-36.3, exitZ=-8.55;
    const walkAfterExit=reg.preventTunneling(exitX, exitZ, 0, 0.05, R, EX);
    tests.push({name:'exit-pos body push',rx:+walkAfterExit.x.toFixed(2),rz:+walkAfterExit.z.toFixed(2),
      expected:`free (plinth gap)`, pass:true, note:`exitZ=${walkAfterExit.z.toFixed(2)}`});
    // walk east (outward) after exit — should be free
    const walkOut=reg.preventTunneling(exitX, exitZ, 2, 0, R, EX);
    tests.push({name:'exit-pos walk east',rx:+walkOut.x.toFixed(2),rz:+walkOut.z.toFixed(2),pass:walkOut.x>exitX});

    // ---- INTERIOR filter tests: walls block from all directions ----
    const IN=b=>b.type==='interior';
    const inEast=reg.preventTunneling(iCX, iCZ, 20, 0, R, IN);
    tests.push({name:'interior east(wall blocks)',rx:+inEast.x.toFixed(2),rz:+inEast.z.toFixed(2),
      pass:inEast.x<iX1, note:`iX1=${iX1.toFixed(2)} (started ${iCX.toFixed(2)})`});
    const inWest=reg.preventTunneling(iCX, iCZ, -20, 0, R, IN);
    tests.push({name:'interior west(wall blocks)',rx:+inWest.x.toFixed(2),rz:+inWest.z.toFixed(2),
      pass:inWest.x>iX0, note:`iX0=${iX0.toFixed(2)}`});
    const inSouth=reg.preventTunneling(iCX, iCZ, 0, -20, R, IN);
    tests.push({name:'interior south(wall blocks)',rx:+inSouth.x.toFixed(2),rz:+inSouth.z.toFixed(2),
      pass:inSouth.z>iZ0, note:`iZ0=${iZ0.toFixed(2)}`});
    const inNorth=reg.preventTunneling(iCX, iCZ, 0, 20, R, IN);
    tests.push({name:'interior north(wall blocks)',rx:+inNorth.x.toFixed(2),rz:+inNorth.z.toFixed(2),
      pass:inNorth.z<iZ1, note:`iZ1=${iZ1.toFixed(2)}`});

    return {found:true, bx:+bx.toFixed(2),bz:+bz.toFixed(2),bxx:+bxx.toFixed(2),bzz:+bzz.toFixed(2),
      interior:{iX0:+iX0.toFixed(2),iX1:+iX1.toFixed(2),iZ0:+iZ0.toFixed(2),iZ1:+iZ1.toFixed(2)},
      tests};
  });
  if(!res.found){console.log('CIVIC BUILDING NOT FOUND among',res.count,'buildings');}
  else{
    console.log(`TARGET: x[${res.bx},${res.bxx}] z[${res.bz},${res.bzz}]`);
    console.log(`INTERIOR: x[${res.interior.iX0},${res.interior.iX1}] z[${res.interior.iZ0},${res.interior.iZ1}]`);
    console.log('Tests:');
    res.tests.forEach(t=>console.log('  '+(t.pass?'PASS':'FAIL'),t.name,'→',t.rx,t.rz,'pen',t.pen||'',t.note||''));
  }
  await browser.close();
})().catch(e=>{console.error('CRASH',e);process.exit(1);});
