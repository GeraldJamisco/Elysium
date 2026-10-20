#!/usr/bin/env node
// Quick targeted capture: walk + eagle spots given on the command line.
// node qa/spot.cjs <outdir> <name:x,z,yaw|E:name:x,z,dist,pitch,yaw> ...
const path=require('path'),fs=require('fs');
let puppet;try{puppet=require(path.join(process.env.TEMP||'/tmp','node_modules','puppeteer-core'));}catch{}
const chrome=['C:/Program Files/Google/Chrome/Application/chrome.exe','C:/Program Files (x86)/Google/Chrome/Application/chrome.exe']
  .find(p=>{try{fs.accessSync(p);return true;}catch{return false;}});
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const outDir=path.resolve(__dirname, process.argv[2]);
const specs=process.argv.slice(3);
(async()=>{
  const b=await puppet.launch({executablePath:chrome,headless:'new',args:['--no-sandbox','--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader','--enable-webgl']});
  const pg=(await b.pages())[0]; await pg.setViewport({width:1280,height:800});
  pg.on('pageerror',e=>console.log('ERR:',e.message));
  fs.mkdirSync(outDir,{recursive:true});
  await pg.goto('http://localhost:5173/',{waitUntil:'domcontentloaded',timeout:180000});
  await pg.waitForSelector('#mc-canvas',{timeout:20000}); await sleep(2500);
  for(let i=0;i<25;i++){const pin=await pg.evaluate(()=>window.MC.getPinScreen('Veridian Cap'));
    if(pin&&pin.visible){await pg.mouse.click(pin.x,pin.y);break;}
    await pg.mouse.move(700,300);await pg.mouse.down();await pg.mouse.move(400,300,{steps:20});await pg.mouse.up();await sleep(300);}
  await sleep(800); const go=await pg.$('.c-go'); if(go)await go.click();
  for(let i=0;i<80;i++){if(await pg.evaluate(()=>window.MC.stageState?.current)==='eagle')break;await sleep(250);}
  await pg.evaluate(()=>{document.querySelectorAll('.card-close').forEach(x=>x.click());
    const r=document.getElementById('nav-reg-toggle'); if(r)r.click();});
  await sleep(4000);
  // Eagle views ALWAYS run before walk views, whatever order they were
  // given in.  Descending to walk is one-way in this harness, so an E:
  // view listed after a W: view used to be taken with the walk camera —
  // producing a screenshot of a wall labelled as an Eagle plan.  Sorting
  // here is cheaper than trusting the caller to remember.
  const ordered = [...specs.filter(x=>x.startsWith('E:')), ...specs.filter(x=>!x.startsWith('E:'))];
  let walked=false;
  for(const spec of ordered){
    const parts=spec.split(':');
    if(parts[0]==='E'){
      const [,n,coords]=parts; const [x,z,dist,pitch,yaw]=coords.split(',').map(Number);
      await pg.evaluate(v=>{const e=window.MC.eagle;e.target.set(v.x,0,v.z);e.distance=v.dist;e.pitch=v.pitch;e.yaw=v.yaw;window.MC.applyEagleCam();},{x,z,dist,pitch,yaw});
      await sleep(9000);
      const st=await pg.evaluate(()=>window.MC.stageState?.current);
      if(st!=='eagle'){console.log(n,'SKIPPED — stage is '+st+', not eagle');continue;}
      await pg.screenshot({path:path.join(outDir,n+'.png')}); console.log(n,'ok');
    } else {
      if(!walked){ await pg.keyboard.press('f');
        for(let i=0;i<80;i++){if(await pg.evaluate(()=>window.MC.stageState?.current)==='walk')break;await sleep(250);}
        await sleep(2000); walked=true; }
      const [n,coords]=parts; const [x,z,yaw]=coords.split(',').map(Number);
      const r=await pg.evaluate(v=>{const {camera,ws,collisionRegistry}=window.MC;
        camera.position.set(v.x,2.05,v.z); ws.euler.set(0,v.yaw,0,'YXZ'); camera.quaternion.setFromEuler(ws.euler);
        return collisionRegistry.query(v.x,v.z,0.4).filter(b=>b.type!=='interior').length;},{x,z,yaw});
      await sleep(3500); await pg.screenshot({path:path.join(outDir,n+'.png')}); console.log(n, r?'SOLID':'ok');
    }
  }
  await b.close();
})();
