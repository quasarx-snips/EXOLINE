
window.ExolineMap = (() => {
  const DPR_CAP = 2;
  class MapRenderer {
    constructor(canvas, opts={}) {
      this.canvas=canvas;
      this.ctx=canvas.getContext('2d');
      this.ctx.imageSmoothingEnabled=false;
      this.opts=opts;
      this.body=null;
      this.manifest=null;
      this.images=new Map();
      this.tileImages=new Map();
      this.width=1; this.height=1;
      this.zoom=1; this.cx=.5; this.cy=.5;
      this.drag=null; this.vx=0; this.vy=0;
      this.pending=0;
      this.resize();
      this.bind();
    }
    bind(){
      addEventListener('resize',()=>this.resize());
      this.canvas.addEventListener('pointerdown',e=>{
        const p=this.local(e);
        if (this.surf) {
          // Grab-time surface anchor so the dragged delta stays exact no
          // matter how far the stroke has already moved the center.
          this.drag={x:p.x,y:p.y,slon:this.surf.centerLon,slat:this.surf.centerLat||0};
        } else {
          this.drag={x:p.x,y:p.y,cx:this.cx,cy:this.cy};
        }
        this.vx=this.vy=0;
        this.canvas.setPointerCapture?.(e.pointerId);
        this.canvas.classList.add('dragging');
      });
      this.canvas.addEventListener('pointermove',e=>{
        if(!this.drag) return;
        const p=this.local(e), mapW=this.mapWidth();
        if (this.surf) {
          // Surface-mode drag: shift the calibrated center with a hard pan
          // clamp vs the site (no bounce). Deltas run from the grab-time
          // anchor so long strokes stay exact.
          const s = this.surf, arc = this._surfArcPerDeg();
          const dEraw = ((this.drag.slon ?? s.centerLon) - s.siteLon) * arc - (p.x - this.drag.x) * s.mPerPx;
          const dNraw = (this.drag.slat ?? 0) * arc + (p.y - this.drag.y) * s.mPerPx;
          const wrapped = (v) => ((v + 180) % 360 + 360) % 360 - 180;
          s.centerLon = wrapped(s.siteLon + Math.max(-100000, Math.min(100000, dEraw)) / arc);
          s.centerLat = Math.max(-25000, Math.min(25000, dNraw)) / arc;
          if (Math.abs(s.centerLat) < 1e-12) s.centerLat = 0;
          s.cx = ((s.centerLon + 180) / 360) % 1; if (s.cx < 0) s.cx += 1;
          s.cy = 0.5; this.cx = s.cx; this.cy = s.cy;
          this.vx = e.movementX || 0; this.vy = e.movementY || 0;
          this.draw();
          return;
        }
        this.cx=this.wrap01(this.drag.cx-(p.x-this.drag.x)/mapW);
        this.cy=Math.max(0,Math.min(1,this.drag.cy-(p.y-this.drag.y)/(mapW/2)));
        this.vx=e.movementX||0; this.vy=e.movementY||0;
        this.draw();
      });
      const end=()=>{this.drag=null;this.canvas.classList.remove('dragging')};
      this.canvas.addEventListener('pointerup',end);
      this.canvas.addEventListener('pointercancel',end);
      this.canvas.addEventListener('wheel',e=>{
        e.preventDefault();
        const p=this.local(e);
        if (this.surf) {
          // Surface-mode wheel: 1.22x steps on mPerPx, anchored on the
          // pointer so the terrain under the cursor stays put.
          const s = this.surf, arc = this._surfArcPerDeg();
          const f = e.deltaY < 0 ? 1.22 : 1 / 1.22;
          const mWas = s.mPerPx, mNow = this._clampSurfZoom(mWas / f);
          const dxPx = p.x - this.width / 2;
          const wrapped = (v) => ((v + 180) % 360 + 360) % 360 - 180;
          const dEraw = (s.centerLon - s.siteLon) * arc + dxPx * (mWas - mNow);
          s.centerLon = wrapped(s.siteLon + Math.max(-100000, Math.min(100000, dEraw)) / arc);
          s.mPerPx = mNow;
          this._syncSurfView();
          return;
        }
        const f=e.deltaY<0?1.22:1/1.22;
        this.zoomAt(f,p.x,p.y);
      },{passive:false});
    }
    local(e){const r=this.canvas.getBoundingClientRect();return{x:e.clientX-r.left,y:e.clientY-r.top}}
    resize(){
      const d=Math.min(DPR_CAP,devicePixelRatio||1);
      this.width=Math.max(1,this.canvas.clientWidth); this.height=Math.max(1,this.canvas.clientHeight);
      this.canvas.width=Math.floor(this.width*d); this.canvas.height=Math.floor(this.height*d);
      this.ctx.setTransform(d,0,0,d,0,0); this.draw();
    }
    wrap01(v){v%=1;if(v<0)v+=1;return v}
    async open(body,manifest){
      this.body=body; this.manifest=manifest||null;
      this.zoom=1; this.cx=.5; this.cy=.5; this.vx=this.vy=0;
      this.images.clear(); this.tileImages.clear();
      this.opts.onZoom?.(this.zoom);
      this.opts.onLoading?.(true);
      try{this.master=await this.load(body.surface_asset)}finally{this.opts.onLoading?.(false)}
      this.draw();
    }
    load(src){
      if(this.images.has(src)) return this.images.get(src);
      const p=new Promise((res,rej)=>{const im=new Image();im.onload=()=>res(im);im.onerror=()=>rej(new Error('Asset failed: '+src));im.src='../'+src});
      this.images.set(src,p); return p;
    }
    levelForZoom(){
      if(!this.manifest?.levels)return null;
      const levels=Object.keys(this.manifest.levels).map(Number).sort((a,b)=>a-b);
      if(!levels.length)return null;
      if(this.zoom<1.45)return this.manifest.levels[String(levels[0])];
      if(this.zoom<3)return this.manifest.levels[String(levels[Math.min(1,levels.length-1)])];
      return this.manifest.levels[String(levels[levels.length-1])];
    }
    mapWidth(){return Math.min(this.width*0.96,this.height*1.62)*this.zoom}
    mapRect(){const w=this.mapWidth();const h=w/2;return{x:this.width/2-w*this.cx+this.xOffset(),y:this.height/2-h*this.cy+this.yOffset(),w,h}}
    xOffset(){return 0}
    yOffset(){return 0}
    tileSrc(tile){return tile.path}
    async drawLevel(level, rect){
      const ctx=this.ctx;
      const baseW=level.tiles_x, baseH=level.tiles_y;
      const tw=rect.w/baseW, th=rect.h/baseH;
      const tasks=[];
      for(let y=0;y<baseH;y++){
        for(let x=0;x<baseW;x++){
          const tile=level.tiles.find(t=>t.x===x&&t.y===y);
          if(!tile)continue;
          const drawX=rect.x+x*tw, drawY=rect.y+y*th;
          const src=this.tileSrc(tile);
          tasks.push(this.load(src).then(im=>{
            ctx.drawImage(im,drawX,drawY,tw,th);
          }).catch(()=>{}));
        }
      }
      await Promise.all(tasks);
      // Wrapped copy when the map straddles viewport edges.
      if(rect.x>0) {
        for(const tile of level.tiles){const src=tile.path; const x=rect.x+(tile.x-baseW)*tw; const y=rect.y+tile.y*th; try{const im=await this.load(src);ctx.drawImage(im,x,y,tw,th)}catch{}}
      }
      if(rect.x+rect.w<this.width) {
        for(const tile of level.tiles){const src=tile.path; const x=rect.x+(tile.x+baseW)*tw; const y=rect.y+tile.y*th; try{const im=await this.load(src);ctx.drawImage(im,x,y,tw,th)}catch{}}
      }
    }
    async draw(){
      const token=++this.pending;
      const ctx=this.ctx; ctx.imageSmoothingEnabled=false;
      ctx.clearRect(0,0,this.width,this.height);
      ctx.fillStyle='#061015';ctx.fillRect(0,0,this.width,this.height);
      // v0.2.0 FIX: the old gate (body AND master) killed the whole surface
      // view — markers, zoom label, tiles — when the master was slow/missing.
      // Tiles stay gated on the master, but the calibrated surface frame
      // (fallback tiles + markers + zoom stroke) always runs.
      if (this.surf) { this._surfaceFrame(ctx, true); return; }
      if(!this.body||!this.master)return;
      const rect=this.mapRect();
      ctx.drawImage(this.master,rect.x,rect.y,rect.w,rect.h);
      // wrap the master horizontally
      if(rect.x>0)ctx.drawImage(this.master,rect.x-rect.w,rect.y,rect.w,rect.h);
      if(rect.x+rect.w<this.width)ctx.drawImage(this.master,rect.x+rect.w,rect.y,rect.w,rect.h);
      const level=this.levelForZoom();
      if(level && this.zoom>=1.45){
        try{await this.drawLevel(level,rect)}catch{}
      }
      if(token!==this.pending)return;
      ctx.strokeStyle='rgba(130,208,230,.2)';ctx.lineWidth=1;ctx.strokeRect(rect.x,rect.y,rect.w,rect.h);
      // longitude seam hint and latitude guide kept extremely subtle, not baked into terrain.
      ctx.fillStyle='rgba(0,0,0,.16)';ctx.fillRect(0,0,this.width,62);
      if(!this.drag){this.cx=this.wrap01(this.cx-this.vx/Math.max(1,this.mapWidth())*.04);this.cy=Math.max(0,Math.min(1,this.cy-this.vy/Math.max(1,this.mapWidth())*.02));this.vx*=.9;this.vy*=.9}
    }
    zoomAt(f,sx,sy){
      const before=this.screenToWorld(sx,sy);
      this.zoom=Math.max(.75,this.zoom*f);
      const afterScale=this.mapWidth();
      this.cx=this.wrap01(before.x-(sx-this.width/2)/afterScale);
      this.cy=Math.max(0,Math.min(1,before.y-(sy-this.height/2)/(afterScale/2)));
      this.opts.onZoom?.(this.zoom); this.draw();
    }
    screenToWorld(sx,sy){
      const r=this.mapRect();
      return {x:this.wrap01((sx-r.x)/r.w),y:Math.max(0,Math.min(1,(sy-r.y)/r.h))};
    }
    reset(){this.zoom=1;this.cx=.5;this.cy=.5;this.vx=this.vy=0;this.opts.onZoom?.(1);this.draw()}
    // ---- v0.2.0 surface mode: meter-calibrated extension ON TOP of the tile
    // renderer. All tile loading/LOD/nearest-neighbour code above is reused
    // untouched; surface mode only remaps (zoom,cx,cy) <-> meters-per-pixel
    // so that 1 screen pixel = mPerPx meters of equatorial arc at the body's
    // surface, centred on (centerLon, 0). EQUATORIAL BAND DOCTRINE: EXOLINE
    // orbits in a 2D plane and that plane maps to each body's equator, so
    // centerLat stays 0 and v reads 0.5 forever; the full lat math is kept
    // for the marker layer but lat never changes in this version.
    openSurface(manifest, bodyId, lonDeg, mPerPx, radiusM){
      this.surf = {
        bodyId, radiusM: Math.max(1, radiusM || 1),
        mPerPx: this._clampSurfZoom(Number(mPerPx) > 0 ? Number(mPerPx) : 50),
        centerLon: Number(lonDeg) || 0, centerLat: 0,
        siteLon: Number(lonDeg) || 0,
        zoom: 1, cx: (Number(lonDeg) + 180) / 360, cy: 0.5,
        markers: null,
      };
      this.manifest = manifest || null;
      return this._syncSurfView();
    }
    _clampSurfZoom(m){ return Math.max(0.5, Math.min(20000, m)); }
    _surfArcPerDeg(){ return Math.PI * (this.surf ? this.surf.radiusM : 1) / 180; }
    // Meters-per-pixel -> zoom/cx/cy so 1 screen px = mPerPx equatorial arc.
    _syncSurfView(){
      const s = this.surf; if (!s) return null;
      const arc = this._surfArcPerDeg(); // meters per degree longitude
      const mapW = Math.min(this.width * 0.96, this.height * 1.62);
      // Full 360 deg of arc spans arc*360 meters -> mapWidth px at this zoom.
      s.zoom = Math.max(0.75, (arc * 360) / Math.max(1e-9, s.mPerPx * Math.max(1, mapW)));
      s.cx = ((s.centerLon + 180) / 360) % 1; if (s.cx < 0) s.cx += 1;
      s.cy = 0.5;
      this.zoom = s.zoom; this.cx = s.cx; this.cy = s.cy;
      this.opts.onZoom?.(s.mPerPx);
      this.draw();
      return this.getSurfaceTransform();
    }
    setSurfaceCenter(lonDeg, latDeg){
      const s = this.surf; if (!s) return null;
      const arc = this._surfArcPerDeg();
      // Pan clamp vs the active site: dE +/-100 km, dN +/-25 km.
      const dE = (Number(lonDeg) - s.siteLon) * arc;
      const dEcl = Math.max(-100000, Math.min(100000, dE));
      const wrapped = (v) => ((v + 180) % 360 + 360) % 360 - 180;
      s.centerLon = wrapped(s.siteLon + dEcl / arc);
      s.centerLat = 0; // equatorial band: lat fixed
      if (latDeg !== undefined && Number.isFinite(Number(latDeg))) {
        const dN = Number(latDeg) * arc;
        s.centerLat = Math.max(-25000, Math.min(25000, dN)) / arc;
        if (Math.abs(s.centerLat) < 1e-12) s.centerLat = 0;
      }
      return this._syncSurfView();
    }
    getSurfaceTransform(){
      const s = this.surf;
      if (!s) return null;
      return { mPerPx: s.mPerPx, centerLon: s.centerLon, centerLat: s.centerLat, bodyId: s.bodyId };
    }
    surfaceMetersToScreen(dE, dN){
      const s = this.surf; if (!s) return null;
      return { x: this.width / 2 + dE / s.mPerPx, y: this.height / 2 - dN / s.mPerPx };
    }
    screenToSurfaceMeters(sx, sy){
      const s = this.surf; if (!s) return null;
      return { dE: (sx - this.width / 2) * s.mPerPx, dN: (this.height / 2 - sy) * s.mPerPx };
    }
    zoomSurface(f){
      const s = this.surf; if (!s) return null;
      s.mPerPx = this._clampSurfZoom(s.mPerPx / f);
      return this._syncSurfView();
    }
    registerMarkerLayer(drawFn){ if (this.surf) this.surf.markers = (typeof drawFn === 'function') ? drawFn : null; return this; }
    closeSurface(){ this.surf = null; this.vx = this.vy = 0; this.opts.onZoom?.(this.zoom); this.draw(); }
    _surfaceFrame(ctx, fromTop){
      // Reuse the uncalibrated tile path (master + LOD + wrap), then fire the
      // marker layer. Inertial glide is applied to the SURFACE center with a
      // hard-stop clamp (no bounce) and cx/cy are re-synced after.
      // Paints tiles ONLY when called from the top of draw() (fromTop=true):
      // draw() routes surf mode here BEFORE its body/master gate, so without
      // this the master-gated path below would never run for surface bodies
      // whose master is slow or missing — markers/zoom would survive but the
      // terrain would stay a flat fill.
      const s = this.surf;
      if (!s) return Promise.resolve();
      if (fromTop) {
        const paint = (async () => {
          try {
            if (this.master) {
              const rect = this.mapRect();
              ctx.drawImage(this.master, rect.x, rect.y, rect.w, rect.h);
              if (rect.x > 0) ctx.drawImage(this.master, rect.x - rect.w, rect.y, rect.w, rect.h);
              if (rect.x + rect.w < this.width) ctx.drawImage(this.master, rect.x + rect.w, rect.y, rect.w, rect.h);
              const level = this.levelForZoom();
              if (level && this.zoom >= 1.45) { try { await this.drawLevel(level, rect); } catch {} }
              ctx.strokeStyle = 'rgba(130,208,230,.2)'; ctx.lineWidth = 1;
              ctx.strokeRect(rect.x, rect.y, rect.w, rect.h);
              ctx.fillStyle = 'rgba(0,0,0,.16)'; ctx.fillRect(0, 0, this.width, 62);
            }
          } catch {} // tiles optional: markers must still draw
        })();
        return paint.then(() => this._surfaceTail(ctx));
      }
      return Promise.resolve(this._surfaceTail(ctx));
    }
    _surfaceTail(ctx){
      // Glide + marker layer shared by both entry points.
      const s = this.surf;
      if (!s) return;
      if (this.vx || this.vy) {
        const arc = this._surfArcPerDeg();
        const dEpx = this.vx * 0.04, dNpx = this.vy * 0.02;
        const dE = (s.centerLon - s.siteLon) * arc + dEpx * s.mPerPx;
        const dN = s.centerLat * arc + dNpx * s.mPerPx;
        const wrapped = (v) => ((v + 180) % 360 + 360) % 360 - 180;
        s.centerLon = wrapped(s.siteLon + Math.max(-100000, Math.min(100000, dE)) / arc);
        s.centerLat = Math.max(-25000, Math.min(25000, dN)) / arc;
        if (Math.abs(s.centerLat) < 1e-12) s.centerLat = 0;
        this.vx *= 0.9; this.vy *= 0.9;
        if (Math.abs(this.vx) < 0.01) this.vx = 0;
        if (Math.abs(this.vy) < 0.01) this.vy = 0;
        s.cx = ((s.centerLon + 180) / 360) % 1; if (s.cx < 0) s.cx += 1;
        s.cy = 0.5; this.cx = s.cx; this.cy = s.cy;
      }
      if (typeof s.markers === 'function') {
        try { s.markers(ctx, this.getSurfaceTransform()); } catch (e) { /* markers must never break tiles */ }
      }
    }
  }
  return {MapRenderer};
})();
