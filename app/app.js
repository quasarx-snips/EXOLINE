
(() => {
  const $=id=>document.getElementById(id);
  const canvas=$('scene'), ctx=canvas.getContext('2d');
  const mapCanvas=$('mapCanvas');
  let DATA=null, TERRAIN=null, POS={};
  let selected=null, mode='system', trackingId=null, trackingMoonId=null;
  let simDate=new Date('2026-10-05T12:00:00Z');
  let posDate=new Date(simDate);
  let running=true;
  const warps=[1,10,100,1000,10000,100000,1000000];
  const simulationRate=.25;
  let warpIndex=0;
  let lastFrame=performance.now();
  let orbitalTimer=0;
  let dpr=1;
  let stars=[];
  const cam={x:0,y:0,zoom:1};
  let drag=null, vx=0, vy=0;
  let mapRenderer=null;
  let renderId=0;
  let renderBusy=false;
  let renderQueued=false;
  const orbitCache=new Map();
  const moonPositions=new Map();
  const imageCache=new Map();

  const primaryIds=['mercury','venus','earth','mars','jupiter','saturn','uranus','neptune','pluto','ceres','haumea','makemake','eris'];

  function resize(){
    dpr=Math.min(2,devicePixelRatio||1);
    const w=Math.max(1,innerWidth),h=Math.max(1,innerHeight);
    canvas.width=Math.floor(w*dpr); canvas.height=Math.floor(h*dpr);
    canvas.style.width=w+'px';canvas.style.height=h+'px';ctx.setTransform(dpr,0,0,dpr,0,0);
    if(mapRenderer)mapRenderer.resize(); draw();
  }
  addEventListener('resize',resize);

  function toast(msg){const t=$('toast');t.textContent=msg;t.classList.add('show');clearTimeout(toast.t);toast.t=setTimeout(()=>t.classList.remove('show'),1500)}
  function loadImage(src){
    if(imageCache.has(src))return imageCache.get(src);
    const p=new Promise((res,rej)=>{const im=new Image();im.onload=()=>res(im);im.onerror=()=>rej(new Error(src));im.src='../'+src});
    imageCache.set(src,p);return p;
  }
  function bodyById(id){return DATA.bodies.find(b=>b.id===id)}
  function parentMoons(parentName){return DATA.bodies.filter(b=>b.kind==='major_moon'&&b.parent===parentName)}
  function bodyColor(b){return ({ocean:'#4b8eaa',gas_giant:'#bb8e63',ice_giant:'#78b7c8',volcanic:'#c65f2d',desert:'#c88f58',ice:'#c8d5d8',barren:'#938d87',rocky:'#a68c73'})[b?.type]||'#9aa5a7'}
  function setLoading(v,text){$('loading').classList.toggle('hidden',!v);if(text)$('loadingText').textContent=text}
  function closeMission(){ $('missionScreen').classList.add('hidden');$('app').classList.remove('mission-active'); }
  function showMission(){ $('missionScreen').classList.remove('hidden');$('app').classList.add('mission-active'); }
  function updateSimulationControls(){
    const warpBtn=$('warpBtn');
    if(!warpBtn)return;
    warpBtn.classList.toggle('is-paused',!running);
    warpBtn.setAttribute('aria-label',running?'Pause simulation':'Resume simulation');
    warpBtn.textContent=running?formatWarp(warps[warpIndex]):'Ⅱ';
  }

  function initStars(){
    let s=0x4f1bbcdc;stars=[];for(let i=0;i<1800;i++){s=(Math.imul(s^s>>>16,2246822507)>>>0);stars.push({x:(s%10000)/10000,y:((s>>>10)%10000)/10000,a:.22+((s>>>20)%70)/1000,size:1+(s%3)/2});}
  }
  function drawStars(w,h){
    const ox=((cam.x)%w+w)%w,oy=((cam.y)%h+h)%h;
    for(const s of stars){
      const x=(s.x*w+ox)%w,y=(s.y*h+oy)%h;
      ctx.fillStyle=`rgba(185,215,225,${s.a*.68})`;ctx.fillRect(x,y,s.size,s.size);
    }
  }

  function visualRadius(au,w,h){
    const span=Math.min(w,h)*.46;
    const normalized=Math.max(.01,au)/70;
    return span*Math.pow(normalized,.56);
  }
  function worldToScreen(p){
    const w=innerWidth,h=innerHeight;
    const cx=w/2+cam.x,cy=h/2+cam.y;
    const rr=visualRadius(Math.hypot(p.x,p.y),w,h)*cam.zoom;
    const a=Math.atan2(p.y,p.x);
    return {x:cx+rr*Math.cos(a),y:cy+rr*Math.sin(a)};
  }
  function trackSelected(){
    if(trackingMoonId){
      const moon=moonPositions.get(trackingMoonId);
      if(moon){cam.x+=innerWidth/2-moon.x;cam.y+=innerHeight/2-moon.y}
      return;
    }
    if(!trackingId||!selected)return;
    const p=POS[trackingId];if(!p)return;
    const w=innerWidth,h=innerHeight,rr=visualRadius(Math.hypot(p.x,p.y),w,h)*cam.zoom;
    const a=Math.atan2(p.y,p.x);
    cam.x=-rr*Math.cos(a);cam.y=-rr*Math.sin(a);
  }
  function drawOrbit(id){
    const segments=Math.min(2048,Math.max(160,Math.round(160*Math.sqrt(Math.max(1,Math.log2(cam.zoom+1))))));
    const key=`${id}:${posDate.getTime()}:${segments}`;
    let pts=orbitCache.get(key);
    if(!pts){pts=ExolineOrbit.orbitPath(id,segments,posDate);if(orbitCache.size>96)orbitCache.clear();orbitCache.set(key,pts)}
    if(!pts.length)return;
    ctx.beginPath();
    pts.forEach((p,i)=>{const s=worldToScreen(p);if(i===0)ctx.moveTo(s.x,s.y);else ctx.lineTo(s.x,s.y)});
    ctx.closePath();ctx.strokeStyle=selected?.id===id?'rgba(119,222,252,.62)':'rgba(109,143,156,.28)';ctx.lineWidth=selected?.id===id?1.35:0.7;ctx.stroke();
  }
  function bodyRadius(b){
    const radiusKm={
      mercury:2439.7,venus:6051.8,earth:6371,mars:3389.5,jupiter:69911,saturn:58232,
      uranus:25362,neptune:24622,pluto:1188.3,ceres:469.7,haumea:620,
      makemake:715,eris:1163,moon:1737.4,io:1821.6,europa:1560.8,
      ganymede:2634.1,callisto:2410.3,titan:2574.7,rhea:763.8,
      iapetus:735.6,dione:561.4,tethys:531.1,enceladus:252.1,mimas:198.2,
      triton:1353.4,ariel:578.9,umbriel:584.7,titania:788.4,oberon:761.4,
      miranda:235.8,phobos:11.1,deimos:6.2,charon:606
    };
    const km=radiusKm[b.id.split(':').pop().toLowerCase()]||3;
    const sunR=9*Math.pow(cam.zoom,.72);
    if(b.id==='sun')return sunR;
    if(b.kind==='major_moon')return Math.max(.2,sunR*(km/696340)*.045);
    return Math.min(Math.min(innerWidth,innerHeight)*.42,Math.max(.45,sunR*(km/696340)));
  }
  const rotationHours={
    mercury:1407.6,venus:-5832.5,earth:23.934,mars:24.623,jupiter:9.925,
    saturn:10.656,uranus:-17.24,neptune:16.11,pluto:-153.3,ceres:9.07,
    haumea:3.915,makemake:22.5,eris:25.9,moon:655.72,io:42.46,
    europa:85.22,ganymede:171.7,callisto:400.5,titan:382.7,rhea:108.4,
    iapetus:1904,dione:65.7,tethys:45.3,enceladus:32.9,mimas:22.6,
    triton:141.0,ariel:25.4,umbriel:27.4,titania:216,oberon:323,
    miranda:33.9,phobos:7.65,deimos:30.3,charon:153.3
  };
  function rotationAngle(b){
    const key=b.id.split(':').pop().toLowerCase();
    const hours=rotationHours[key]||24;
    const elapsed=(simDate.getTime()-Date.parse('2000-01-01T12:00:00Z'))/3600000;
    return (elapsed/hours)*Math.PI*2;
  }
  function atmosphereFor(b){
    if(b.type==='gas_giant')return {color:'#e5a86c',strength:.36,width:1.2};
    if(b.type==='ice_giant')return {color:'#7fdcff',strength:.34,width:1.15};
    if(b.id==='venus')return {color:'#f0b06c',strength:.28,width:1};
    if(b.id==='earth'||b.id==='jupiter:europa'||b.id==='saturn:titan')return {color:'#69cfff',strength:.3,width:1};
    if(b.type==='ice')return {color:'#b8eaff',strength:.22,width:.8};
    return null;
  }
  function lightDirection(worldPosition){
    const len=Math.hypot(worldPosition.x,worldPosition.y)||1;
    return {x:-worldPosition.x/len,y:-worldPosition.y/len};
  }
  function drawDayNight(s,r,b,worldPosition=POS[b.id]){
    const light=lightDirection(worldPosition||{x:0,y:0});
    ctx.save();
    ctx.beginPath();ctx.arc(s.x,s.y,r,0,Math.PI*2);ctx.clip();
    const gradient=ctx.createLinearGradient(
      s.x-light.x*r*1.45,s.y-light.y*r*1.45,
      s.x+light.x*r*1.45,s.y+light.y*r*1.45
    );
    gradient.addColorStop(0,'rgba(0,2,8,.96)');
    gradient.addColorStop(.24,'rgba(1,4,11,.82)');
    gradient.addColorStop(.44,'rgba(2,7,14,.48)');
    gradient.addColorStop(.56,'rgba(0,0,0,.08)');
    gradient.addColorStop(.68,'rgba(0,0,0,0)');
    gradient.addColorStop(1,'rgba(0,0,0,0)');
    ctx.fillStyle=gradient;ctx.fillRect(s.x-r,s.y-r,r*2,r*2);
    ctx.restore();
    const atmosphere=atmosphereFor(b);
    if(!atmosphere)return;
    ctx.save();
    ctx.globalCompositeOperation='lighter';
    ctx.shadowColor=atmosphere.color;ctx.shadowBlur=Math.max(2,r*atmosphere.width);
    ctx.globalAlpha=atmosphere.strength;
    ctx.globalAlpha=atmosphere.strength*.55;
    const glow=ctx.createRadialGradient(s.x-light.x*r*.55,s.y-light.y*r*.55,r*.55,s.x,s.y,r*1.22);
    glow.addColorStop(0,'rgba(255,220,150,0)');
    glow.addColorStop(.7,atmosphere.color);
    glow.addColorStop(1,'rgba(0,0,0,0)');
    ctx.fillStyle=glow;ctx.beginPath();ctx.arc(s.x,s.y,r*1.25,0,Math.PI*2);ctx.fill();
    ctx.restore();
  }
  async function drawBody(b,token){
    const p=POS[b.id];if(!p)return;
    const s=worldToScreen(p),r=bodyRadius(b),src=b.orbital_asset;
    if(!imageCache.has(src)){loadImage(src).then(()=>{if(mode==='system')draw()}).catch(()=>{});}
    const promise=imageCache.get(src);
    if(promise){
      try{
        const im=await promise;
        if(token!==renderId)return;
        ctx.save();ctx.translate(s.x,s.y);ctx.rotate(rotationAngle(b));ctx.drawImage(im,-r,-r,r*2,r*2);ctx.restore();
      }catch{fallbackBody(b,s,r)}
    }else fallbackBody(b,s,r);
    drawDayNight(s,r,b);
    if(cam.zoom>1.25||selected?.id===b.id){drawBodyLabel(b.name,s.x,s.y,r,10)}
  }
  function drawBodyLabel(name,x,y,r,size){
    const w=innerWidth;
    ctx.fillStyle='#d6e6eb';ctx.font=`${size}px "Denmark", "TW Cen MT", "Teen Light", sans-serif`;
    ctx.textAlign=x+r+8+ctx.measureText(name).width>w-8?'right':'left';
    ctx.fillText(name,ctx.textAlign==='right'?x-r-5:x+r+5,y+3);ctx.textAlign='left';
  }
  function fallbackBody(b,s,r){ctx.fillStyle=bodyColor(b);ctx.beginPath();ctx.arc(s.x,s.y,r,0,Math.PI*2);ctx.fill()}

  async function drawSystem(token){
    trackSelected();
    const w=innerWidth,h=innerHeight;ctx.clearRect(0,0,w,h);ctx.fillStyle='#02070a';ctx.fillRect(0,0,w,h);drawStars(w,h);
    moonPositions.clear();
    for(const b of DATA.bodies.filter(b=>b.kind!=='major_moon'&&b.id!=='sun'))drawOrbit(b.id);
    // asteroid belt particles
    let seed=77;const W=innerWidth,H=innerHeight,cx=W/2+cam.x,cy=H/2+cam.y;
    for(let i=0;i<260;i++){seed=(Math.imul(seed^seed>>>16,2246822507)>>>0);const f=(seed%10000)/10000,a=((seed>>>7)%6283)/1000;const au=2.1+1.2*f;const rr=visualRadius(au,W,H)*cam.zoom;ctx.fillStyle='rgba(106,151,166,.30)';ctx.fillRect(cx+rr*Math.cos(a),cy+rr*Math.sin(a),1,1)}
    // Sun
    const sx=cx,sy=cy;const sr=Math.min(Math.min(W,H)*.42,9*Math.pow(cam.zoom,.72));ctx.save();ctx.shadowColor='rgba(255,199,76,.5)';ctx.shadowBlur=18;ctx.fillStyle='#ffd66a';ctx.beginPath();ctx.arc(sx,sy,sr,0,Math.PI*2);ctx.fill();ctx.restore();
    await Promise.all(DATA.bodies.filter(b=>b.kind!=='major_moon').map(b=>drawBody(b,token)));
    if(token!==renderId)return;
    // Selected body's moons: local schematic only when zoomed/selected; their periods are real data-driven.
    const moonParents=DATA.bodies.filter(b=>b.kind!=='major_moon'&&parentMoons(b.name).length);
    for(const parent of moonParents){await drawLocalMoons(parent,token);if(token!==renderId)return}
    updateSimulationControls();const dateEl=$('simDate');if(dateEl)dateEl.textContent=simDate.toISOString().replace('T',' ').slice(0,16)+' UTC';
  }
  async function drawLocalMoons(parent,token){
    const p=POS[parent.id];if(!p)return;const center=worldToScreen(p);const moons=parentMoons(parent.name);
    const states=await Promise.all(moons.map(m=>ExolineOrbit.moon(m.id,posDate)));
    const maxA=Math.max(...states.filter(Boolean).map(m=>m.r),1);
    const parentRadius=bodyRadius(parent);
    const showMoonLabels=cam.zoom>8&&parentRadius>18;
    for(let i=0;i<moons.length;i++){
      const m=moons[i],md=states[i];if(!md)continue;
      const ratio=Math.sqrt(md.r/maxA);
      const ring=parentRadius*(1.25+ratio*2.25);
      if(token!==renderId)return;
      ctx.save();ctx.strokeStyle='rgba(130,190,210,.24)';ctx.lineWidth=.7;ctx.beginPath();ctx.arc(center.x,center.y,ring,0,Math.PI*2);ctx.stroke();ctx.restore();
      const angle=Math.atan2(md.y,md.x);const x=center.x+ring*Math.cos(angle),y=center.y+ring*Math.sin(angle);const r=Math.max(.35,Math.min(1.8,bodyRadius(m)));
      moonPositions.set(m.id,{x,y,r});
      ctx.fillStyle=bodyColor(m);ctx.beginPath();ctx.arc(x,y,r,0,Math.PI*2);ctx.fill();drawDayNight({x,y},r,m,{x:p.x+md.x,y:p.y+md.y});
      if(showMoonLabels||selected?.id===m.id){drawBodyLabel(m.name,x,y,r,9)}
    }
  }

  function draw(){
    if(mode!=='system')return;
    if(renderBusy){renderQueued=true;return}
    renderBusy=true;
    const token=++renderId;
    drawSystem(token).catch(err=>console.error('Orbital render failed',err)).finally(()=>{
      renderBusy=false;
      if(renderQueued){renderQueued=false;requestAnimationFrame(draw)}
    });
  }
  function renderDetail(b){
    $('detailPanel').classList.remove('hidden');
    $('detailKicker').textContent=b.kind==='major_moon'?'MAJOR MOON':'PLANETARY BODY';
    $('detailName').textContent=b.name;
    $('detailSub').textContent=b.parent?`${pretty(b.type)} · moon of ${b.parent}`:`${pretty(b.type)} · Sol System`;
    $('detailType').textContent=pretty(b.type);
    $('detailOrbit').textContent=b.distance_au?`${Number(b.distance_au).toFixed(3)} AU`:(b.kind==='major_moon'?'Local orbit':'—');
    const st=ExolineOrbit.state(b.id,simDate);$('detailPeriod').textContent=st?formatPeriod(st.periodDays):'—';
    $('detailSeed').textContent=String(b.seed??'—');
    $('detailNote').textContent=noteFor(b);
    $('openMapBtn').textContent=(b.type==='gas_giant'||b.type==='ice_giant')?'OPEN ATMOSPHERE MAP':'OPEN PLANET MAP';
    const rows=Object.entries(b.mineral_profile||{}).sort((a,c)=>c[1]-a[1]);
    $('minerals').innerHTML=rows.map(([k,v])=>`<div class="mineral-row"><span class="name">${escapeHtml(k)}</span><div class="mineral-bar"><i style="width:${Math.max(1,Math.min(100,Number(v)*100))}%"></i></div><span class="value">${(Number(v)*100).toFixed(1)}%</span></div>`).join('');
    const moons=parentMoons(b.name);$('moonSection').classList.toggle('hidden',moons.length===0);$('moonList').innerHTML=moons.map(m=>`<button class="moon-btn" data-id="${m.id}">${escapeHtml(m.name)}</button>`).join('');
    $('moonList').querySelectorAll('.moon-btn').forEach(btn=>btn.onclick=()=>{const m=bodyById(btn.dataset.id);if(m)inspectBody(m)});
  }
  function noteFor(b){
    const p=b.mineral_profile||{};const top=Object.entries(p).sort((a,c)=>c[1]-a[1])[0]?.[0]||'resources';
    if(b.kind==='major_moon')return `${b.name} is represented as a deterministic explorable moon. Dominant gameplay channel: ${top}.`;
    if(b.type==='gas_giant'||b.type==='ice_giant')return `Atmospheric gameplay world. Dominant gameplay channel: ${top}. Surface map is treated as an atmosphere map in this version.`;
    return `${pretty(b.type)} world. Dominant gameplay channel: ${top}. Terrain and mineral data are rendered from the canonical Phase 1 dataset.`;
  }
  function pretty(s){return String(s||'unknown').replaceAll('_',' ')}
  function formatPeriod(days){if(days<1)return `${(days*24).toFixed(2)} h`;if(days<365.25)return `${days.toFixed(2)} d`;return `${(days/365.25).toFixed(2)} y`}
  function formatWarp(v){if(v===1)return '1×';if(v>=1e6)return '1M×';if(v>=1e3)return `${v/1e3}k×`;return `${v}×`}
  function escapeHtml(s){return String(s).replace(/[&<>'"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c]))}

  async function openMap(){
    if(!selected)return;
    mode='map';$('detailPanel').classList.add('hidden');$('mapTopbar').classList.add('hidden');$('scene').style.display='none';mapCanvas.classList.remove('hidden');mapCanvas.style.display='block';
    $('mapBodyName').textContent=selected.name.toUpperCase();
    $('systemName').textContent=selected.name.toUpperCase();
    const m=TERRAIN.bodies[selected.id];
    if(!m){toast('No terrain dataset for this body');return;}
    if(!mapRenderer)mapRenderer=new ExolineMap.MapRenderer(mapCanvas,{terrainManifest:m,onLoading:setLoading,onZoom:z=>$('mapReadout').textContent=`MAP · ${z.toFixed(1)}×`});
    await mapRenderer.open(selected,m);mapRenderer.reset();
  }
  function backSystem(){mode='system';$('mapTopbar').classList.add('hidden');mapCanvas.classList.add('hidden');mapCanvas.style.display='none';$('scene').style.display='block';$('systemName').textContent='ORBITAL VIEW';draw()}
  function inspectBody(b){selected=b;trackingMoonId=b.kind==='major_moon'?b.id:null;trackingId=b.kind==='major_moon'?(b.parent?bodyByName(b.parent)?.id:null):b.id;renderDetail(b);draw()}
  function bodyByName(name){return DATA.bodies.find(b=>b.name===name)}
  function pointerLocal(e){const r=canvas.getBoundingClientRect();return{x:e.clientX-r.left,y:e.clientY-r.top}}
  function pickBody(x,y){
    let best=null,bd=Infinity;
    for(const b of DATA.bodies.filter(x=>x.kind==='major_moon')){const s=moonPositions.get(b.id);if(!s)continue;const d=Math.hypot(x-s.x,y-s.y);if(d<Math.max(18,s.r+10)&&d<bd){best=b;bd=d}}
    for(const b of DATA.bodies.filter(x=>x.kind!=='major_moon')){const p=POS[b.id];if(!p)continue;const s=worldToScreen(p);const d=Math.hypot(x-s.x,y-s.y);const hit=Math.max(9,bodyRadius(b)+5);if(d<hit&&d<bd){best=b;bd=d}}
    return best;
  }
  canvas.addEventListener('pointerdown',e=>{trackingId=null;const p=pointerLocal(e);drag={x:p.x,y:p.y,cx:cam.x,cy:cam.y};vx=vy=0;canvas.setPointerCapture?.(e.pointerId);canvas.classList.add('dragging')});
  canvas.addEventListener('pointermove',e=>{if(!drag)return;const p=pointerLocal(e);cam.x=drag.cx+(p.x-drag.x);cam.y=drag.cy+(p.y-drag.y);vx=e.movementX||0;vy=e.movementY||0;draw()});
  const end=()=>{drag=null;canvas.classList.remove('dragging')};  canvas.addEventListener('pointerup',e=>{if(drag){const moved=Math.hypot(e.clientX-canvas.getBoundingClientRect().left-drag.x,e.clientY-canvas.getBoundingClientRect().top-drag.y);end();if(moved<7){const p=pointerLocal(e),b=pickBody(p.x,p.y);if(b)inspectBody(b);else{$('detailPanel').classList.add('hidden');selected=null;trackingId=null;trackingMoonId=null;draw()}}}});canvas.addEventListener('pointercancel',end);
  canvas.addEventListener('dblclick',e=>{const p=pointerLocal(e),b=pickBody(p.x,p.y);if(b){inspectBody(b);openMap()}});
  canvas.addEventListener('wheel',e=>{e.preventDefault();const f=e.deltaY<0?1.18:1/1.18;if(trackingId){cam.zoom=Math.max(.55,cam.zoom*f);draw();return}const p=pointerLocal(e),before=screenWorld(p.x,p.y);cam.zoom=Math.max(.55,cam.zoom*f);const after=worldScreen(before);cam.x+=p.x-after.x;cam.y+=p.y-after.y;draw()},{passive:false});
  function screenWorld(x,y){const w=innerWidth,h=innerHeight,cx=w/2+cam.x,cy=h/2+cam.y;const dx=x-cx,dy=y-cy;const span=Math.min(w,h)*.46;const rr=Math.hypot(dx,dy)/(span*cam.zoom);const au=70*Math.pow(Math.max(0,rr),1/.56);const a=Math.atan2(dy,dx);return{x:au*Math.cos(a),y:au*Math.sin(a)}}
  function worldScreen(p){return worldToScreen(p)}

  $('closeDetail').onclick=()=>{$('detailPanel').classList.add('hidden');selected=null;trackingId=null;trackingMoonId=null;draw()};
  $('openMapBtn').onclick=openMap;$('backBtn').onclick=backSystem;$('homeBtn').onclick=()=>{cam.x=cam.y=0;cam.zoom=1;trackingId=null;trackingMoonId=null;backSystem()};$('resetBtn').onclick=()=>{cam.x=cam.y=0;cam.zoom=1;trackingId=null;trackingMoonId=null;if(mode==='map')mapRenderer?.reset();else draw()};
  function zoomActive(f){
    if(mode==='map'&&mapRenderer){mapRenderer.zoomAt(f,mapCanvas.clientWidth/2,mapCanvas.clientHeight/2);return}
    if(trackingId){cam.zoom=Math.max(.55,cam.zoom*f);draw();return}
    const before=screenWorld(innerWidth/2,innerHeight/2);cam.zoom=Math.max(.55,cam.zoom*f);const after=worldScreen(before);cam.x+=innerWidth/2-after.x;cam.y+=innerHeight/2-after.y;draw();
  }
  $('mapResetBtn')?.addEventListener('click',()=>mapRenderer?.reset());
  $('mapZoomIn')?.addEventListener('click',()=>zoomActive(1.3));
  $('mapZoomOut')?.addEventListener('click',()=>zoomActive(1/1.3));
  $('exploreSolBtn').onclick=()=>{closeMission();backSystem()};
  $('continueMissionBtn').onclick=()=>{closeMission();openMap()};
  $('newCampaignBtn').onclick=()=>{cam.x=cam.y=0;cam.zoom=1;trackingId=null;selected=bodyById('earth');closeMission();openMap()};
  $('missionEnter').onclick=()=>{closeMission();openMap()};
  function changeWarp(delta){warpIndex=Math.max(0,Math.min(warps.length-1,warpIndex+delta));toast(formatWarp(warps[warpIndex]))}
  function toggleRunning(){running=!running;updateSimulationControls();draw()}
  $('slower').onclick=()=>changeWarp(-1);$('faster').onclick=()=>changeWarp(1);$('warpBtn').onclick=toggleRunning;
  addEventListener('keydown',e=>{if(e.key==='Escape'){if(mode==='map')backSystem();else{$('detailPanel').classList.add('hidden');selected=null;trackingId=null;trackingMoonId=null;draw()}}else if(e.key==='[')changeWarp(-1);else if(e.key===']')changeWarp(1);else if(e.code==='Space'){e.preventDefault();toggleRunning()}else if(e.key.toLowerCase()==='r'){cam.x=cam.y=0;cam.zoom=1;trackingId=null;trackingMoonId=null;draw()}});

  async function tick(now){const dt=Math.min(.25,Math.max(0,(now-lastFrame)/1000));lastFrame=now;if(running){simDate=new Date(simDate.getTime()+dt*warps[warpIndex]*simulationRate*1000)}if(now-orbitalTimer>100){orbitalTimer=now;const snapshot=new Date(simDate);POS=await ExolineOrbit.positions(snapshot);posDate=snapshot}if(!drag&&!mode.includes('map')){cam.x+=vx;cam.y+=vy;vx*=.88;vy*=.88}if(mode==='system')draw();requestAnimationFrame(tick)}

  async function start(){
    try{
      setLoading(true,'LOADING SOLAR SYSTEM');
      DATA=await (await fetch('../data/solar_system.json',{cache:'no-store'})).json();
      TERRAIN=await (await fetch('../data/terrain_manifest.json',{cache:'no-store'})).json();
      await ExolineOrbit.load();
      POS=await ExolineOrbit.positions(simDate);
      initStars();
      for(const b of DATA.bodies.filter(b=>b.kind!=='major_moon'))loadImage(b.orbital_asset).catch(()=>{});
      selected=bodyById('earth');
      setLoading(false);resize();updateSimulationControls();draw();
      await openMap();
      setTimeout(()=>$('introScreen').classList.add('is-exiting'),4200);
      setTimeout(()=>{$('introScreen').remove();showMission()},5000);
      requestAnimationFrame(tick);
    }catch(err){console.error(err);setLoading(false,'LOAD ERROR');toast('Load error: '+err.message)}
  }
  start();
})();
