const path=require('path'), fs=require('fs');
let puppet; try{puppet=require(path.join(process.env.TEMP||'/tmp','node_modules','puppeteer-core'));}catch(e){console.error(e.message)}
const chromePath=['C:/Program Files/Google/Chrome/Application/chrome.exe','C:/Program Files (x86)/Google/Chrome/Application/chrome.exe'].find(p=>{try{fs.accessSync(p);return true}catch{return false}});
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
(async()=>{
  const b=await puppet.launch({executablePath:chromePath,headless:'new',args:['--no-sandbox','--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader','--enable-webgl']});
  const page=(await b.pages())[0];
  await page.setViewport({width:1280,height:800});
  await page.goto('http://localhost:5173/',{waitUntil:'domcontentloaded',timeout:180000});
  await page.waitForSelector('#mc-canvas',{timeout:20000}); await sleep(2500);
  for(let i=0;i<25;i++){const pin=await page.evaluate(()=>window.MC.getPinScreen('Veridian Cap'));
    if(pin&&pin.visible){await page.mouse.click(pin.x,pin.y);break;}
    await page.mouse.move(700,300);await page.mouse.down();await page.mouse.move(400,300,{steps:20});await page.mouse.up();await sleep(300);}
  await sleep(800); const go=await page.$('.c-go'); if(go) await go.click();
  for(let i=0;i<80;i++){if(await page.evaluate(()=>window.MC.stageState?.current)==='eagle')break;await sleep(250);}
  await page.evaluate(()=>{const e=window.MC.eagle;e.target.x=1050;e.target.z=500;e.distance=55;e.pitch=0.14;e.yaw=0.3;window.MC.applyEagleCam();});
  await sleep(12000);
  const info=await page.evaluate(()=>{
    const {THREE,camera,scene}=window.MC;
    const rc=new THREE.Raycaster();
    const out=[];
    // Fire through the black dome: screen ~ (660, 270) in a 1280x800 view
    for(const [sx,sy] of [[660,270],[640,290],[700,300]]){
      rc.setFromCamera(new THREE.Vector2((sx/1280)*2-1, -(sy/800)*2+1), camera);
      rc.far = 20000;
      const hits=rc.intersectObjects(scene.children,true).slice(0,3);
      out.push({px:[sx,sy],hits:hits.map(h=>({name:h.object.name||h.object.type,dist:Math.round(h.distance),mat:h.object.material&&h.object.material.type,side:h.object.material&&h.object.material.side,vc:h.object.material&&h.object.material.vertexColors}))});
    }
    const gg=scene.getObjectByName('globe')||scene.children.find(c=>c.getObjectByName&&c.getObjectByName('planet-surface'));
    const ps=scene.getObjectByName('planet-surface');
    let chain=[],o=ps; while(o){chain.push((o.name||o.type)+':vis='+o.visible);o=o.parent;}
    const relief=scene.getObjectByName('relief');
    const st=scene.children.filter(c=>/star/i.test(c.name||c.type)).map(c=>(c.name||c.type)+':'+c.visible);
    const gnd=scene.children.filter(c=>c.type==='Group').map(c=>(c.name||'(unnamed Group)')+':'+c.visible);
    return {stars:st, groups:gnd, chain, camPos:camera.position.toArray().map(v=>Math.round(v)), out, relief: relief?{visible:relief.visible,recv:relief.receiveShadow,matColor:'#'+relief.material.color.getHexString(),flat:relief.material.flatShading,tris:relief.geometry.attributes.position.count/3}:null};
  });
  console.log(JSON.stringify(info,null,1));
  await b.close();
})();
