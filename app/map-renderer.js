
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
      this.assetVersion=null;
      this.images=new Map();
      // v0.2.1 tile streaming: a bounded LRU of decoded tiles, the in-flight
      // requests (each with its own AbortController), and the src set that the
      // current view actually wants. Tiles outside that set are aborted.
      this.radiusM=0;
      this.tileCache=new Map();      // src -> { bmp, used }
      this.tilePending=new Map();    // src -> { promise, controller }
      this.tileWanted=new Set();
      this.tileSeq=0;
      this.tileStats={hits:0,misses:0,cancelled:0};
      this.tileCacheCap=256;
      this.tileCacheVersion=null;    // manifest revision the decoded tiles belong to
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
    async open(body,manifest,radiusM){
      this.body=body; this.manifest=manifest||null;
      if(radiusM>0)this.radiusM=radiusM;
      this._abortPendingTiles();
      // Surface assets are not cache-busted by index.html, so a regenerated
      // map would otherwise keep showing the browser's stale copy forever.
      // The terrain manifest's version is the cache key.
      this.assetVersion=(manifest&&manifest.version)||this.assetVersion||null;
      this.zoom=1; this.cx=.5; this.cy=.5; this.vx=this.vy=0;
      this.images.clear();
      // Tiles are keyed by PATH, so a regenerated pyramid served under the same
      // path would otherwise be drawn from this in-memory cache forever. Drop
      // the decoded tiles whenever the manifest revision changes, and on every
      // body switch (the old code did the same to its tile image map).
      if(this.tileCacheVersion!==this.assetVersion){this.tileCache.clear();this.tileCacheVersion=this.assetVersion;}
      this.opts.onZoom?.(this.zoom);
      this.opts.onLoading?.(true);
      try{this.master=await this.load(body.surface_asset)}finally{this.opts.onLoading?.(false)}
      this.draw();
    }
    versionQuery(src){
      return this.assetVersion?('?'+(/\?/.test(src)?'&':'')+'v='+encodeURIComponent(this.assetVersion)):'';
    }
    load(src){
      if(this.images.has(src)) return this.images.get(src);
      const p=new Promise((res,rej)=>{const im=new Image();im.onload=()=>res(im);im.onerror=()=>rej(new Error('Asset failed: '+src));im.src='../'+src+this.versionQuery(src)});
      this.images.set(src,p); return p;
    }
    // ---- v0.2.1 level selection. Levels are ordered coarse -> fine; a level's
    // native resolution is its (tile_size * tiles_x) pixels across 360 deg, so
    // its native metres-per-pixel is arc*360/that. We want the COARSEST level
    // that is still at least as fine as the requested mPerPx, which is the same
    // rule as "never cover the screen with fewer pixels than we display", just
    // expressed in metres. When mPerPx is finer than every level we fall back to
    // the finest level (the only case where magnification is unavoidable).
    chooseLevel(mPerPx){
      const m=this.manifest;
      if(!m?.levels)return null;
      const levels=Object.keys(m.levels).map(Number).filter(Number.isFinite).sort((a,b)=>a-b);
      if(!levels.length)return null;
      const tile=(m.tile_size|0)||128;
      const arc=this._arcPerDeg();
      const finest=m.levels[String(levels[levels.length-1])];
      if(!(arc>0)||!(mPerPx>0))return finest;
      // Levels run coarse -> fine, so native m/px falls as k rises. The FIRST
      // level that is at least as fine as the request is therefore the coarsest
      // one that still avoids upscaling — the cheapest level that can draw this
      // view sharply. (Taking the LAST match would always end on the finest
      // level, loading 4x the tiles needed for the same pixels.)
      for(const k of levels){
        const level=m.levels[String(k)];
        if(!level)continue;
        const nativeMPerPx=(arc*360)/(tile*(level.tiles_x|0));
        if(nativeMPerPx<=mPerPx)return level;
      }
      return finest;
    }
    _arcPerDeg(){
      if(this.surf&&this.surf.radiusM)return Math.PI*this.surf.radiusM/180;
      if(this.radiusM)return Math.PI*this.radiusM/180;
      return 0;
    }
    // The metres-per-pixel the current view is asking for.
    _modeMPerPx(){
      const arc=this._arcPerDeg();
      if(!(arc>0))return 0;
      if(this.surf&&this.surf.mPerPx>0)return this.surf.mPerPx;
      return (arc*360)/Math.max(1e-9,this.mapWidth());
    }
    // Fallback when the body radius is unknown: pick the lowest level whose
    // native width still covers the on-screen width.
    _levelByNativeWidth(){
      const m=this.manifest;
      if(!m?.levels)return null;
      const levels=Object.keys(m.levels).map(Number).filter(Number.isFinite).sort((a,b)=>a-b);
      if(!levels.length)return null;
      const tile=(m.tile_size|0)||128;
      const need=this.mapWidth();
      for(const k of levels){
        const level=m.levels[String(k)];
        if(level&&tile*(level.tiles_x|0)>=need)return level;
      }
      return m.levels[String(levels[levels.length-1])];
    }
    levelForZoom(){
      const mPerPx=this._modeMPerPx();
      return (mPerPx>0?this.chooseLevel(mPerPx):null)||this._levelByNativeWidth();
    }
    mapWidth(){return Math.min(this.width*0.96,this.height*1.62)*this.zoom}
    mapRect(){const w=this.mapWidth();const h=w/2;return{x:this.width/2-w*this.cx+this.xOffset(),y:this.height/2-h*this.cy+this.yOffset(),w,h}}
    xOffset(){return 0}
    yOffset(){return 0}
    tileSrc(tile){return tile.path}
    // ---- v0.2.1 tile requests: fetch + decode with one AbortController each,
    // bounded by an LRU of decoded bitmaps.
    _decodeTile(src,controller){
      const url='../'+src+this.versionQuery(src);
      const viaImage=()=>new Promise((res,rej)=>{
        const image=new Image();
        image.onload=()=>res(image);
        image.onerror=()=>rej(new Error('tile decode failed '+src));
        image.src=url;
      });
      const viaFetch=()=>fetch(url,{signal:controller.signal}).then(response=>{
        if(!response.ok)throw new Error('tile '+response.status+' '+src);
        return response.blob();
      }).then(blob=>{
        if(typeof createImageBitmap==='function')return createImageBitmap(blob);
        return new Promise((res,rej)=>{
          const objectUrl=URL.createObjectURL(blob);
          const image=new Image();
          image.onload=()=>{URL.revokeObjectURL(objectUrl);res(image)};
          image.onerror=()=>{URL.revokeObjectURL(objectUrl);rej(new Error('tile decode failed '+src))};
          image.src=objectUrl;
        });
      });
      return viaFetch().catch(error=>{
        // An abort is deliberate; anything else (no fetch outside a document
        // served over http, a decode the browser refuses) falls back to the
        // v0.2.0 <img> path so tiles still appear.
        if(error&&error.name==='AbortError')throw error;
        if(controller.signal.aborted)throw error;
        return viaImage();
      });
    }
    _trimTileCache(){
      while(this.tileCache.size>this.tileCacheCap){
        let oldestKey=null,oldestUsed=Infinity;
        for(const [key,entry] of this.tileCache){
          if(entry.used<oldestUsed){oldestUsed=entry.used;oldestKey=key;}
        }
        if(oldestKey===null)return;
        this.tileCache.delete(oldestKey);
      }
    }
    requestTile(src){
      const cached=this.tileCache.get(src);
      if(cached){this.tileStats.hits++;cached.used=++this.tileSeq;return Promise.resolve(cached);}
      const inflight=this.tilePending.get(src);
      if(inflight)return inflight.promise;
      this.tileStats.misses++;
      const controller=new AbortController();
      const promise=this._decodeTile(src,controller).then(bitmap=>{
        this.tilePending.delete(src);
        const entry={bmp:bitmap,used:++this.tileSeq};
        this.tileCache.set(src,entry);
        this._trimTileCache();
        return entry;
      }).catch(error=>{
        this.tilePending.delete(src);
        if(error&&error.name==='AbortError'){this.tileStats.cancelled++;return null;}
        return null;
      });
      this.tilePending.set(src,{promise,controller});
      return promise;
    }
    _abortPendingTiles(){
      for(const [,entry] of this.tilePending)entry.controller.abort();
    }
    getTileCacheStats(){
      return {hits:this.tileStats.hits,misses:this.tileStats.misses,size:this.tileCache.size,cancelled:this.tileStats.cancelled};
    }
    async drawLevel(level, rect){
      const ctx=this.ctx;
      const baseW=level.tiles_x, baseH=level.tiles_y;
      const tw=rect.w/baseW, th=rect.h/baseH;
      const vw=this.width, vh=this.height;
      // Same scale-matched filtering as _drawMaster: tiles are 128px, so a tile
      // drawn narrower than that is a minification.
      ctx.imageSmoothingEnabled=tw<128;
      if(tw<128)ctx.imageSmoothingQuality='high';
      // Only tiles that touch the viewport are drawn. A hero body's finest
      // level can hold hundreds of tiles and a deep zoom shows a handful of
      // them, so culling keeps high-resolution pyramids cheap without changing
      // a single pixel of what ends up on screen. The map wraps in x, so a tile
      // can land at up to three horizontal positions; draw the visible copies.
      const draws=[];
      const visible=new Set();
      for(const tile of level.tiles){
        const src=this.tileSrc(tile);
        const x0=rect.x+tile.x*tw, y0=rect.y+tile.y*th;
        let onScreen=false;
        for(const k of [-1,0,1]){
          const dx=x0+k*rect.w;
          if(dx+tw<=0||dx>=vw||y0+th<=0||y0>=vh)continue;
          onScreen=true;
          draws.push({src,dx,y:y0});
        }
        if(onScreen)visible.add(tile.x+','+tile.y);
      }
      // 8-neighbour ring of the visible set, requested after it. Deterministic:
      // tiles come from the manifest array order, so the same view always asks
      // for the same tiles in the same order.
      const ring=[];
      const neighbours=new Map();
      for(const tile of level.tiles)neighbours.set(tile.x+','+tile.y,tile);
      for(const key of visible){
        const comma=key.indexOf(',');
        const tx=Number(key.slice(0,comma)),ty=Number(key.slice(comma+1));
        for(let dy=-1;dy<=1;dy++){
          for(let dx=-1;dx<=1;dx++){
            if(!dx&&!dy)continue;
            if(visible.has((tx+dx)+','+(ty+dy)))continue;
            const tile=neighbours.get((tx+dx)+','+(ty+dy));
            if(tile)ring.push(this.tileSrc(tile));
          }
        }
      }
      // Remember what this view wants, then cancel anything that left the set
      // (a flick-pan must not keep paying for tiles already scrolled away).
      const wanted=new Set();
      for(const entry of draws)wanted.add(entry.src);
      for(const src of ring)wanted.add(src);
      this.tileWanted=wanted;
      for(const [src,entry] of this.tilePending){
        if(!wanted.has(src))entry.controller.abort();
      }
      // Draw whatever is already decoded; the master underneath covers the rest.
      for(const entry of draws){
        const cached=this.tileCache.get(entry.src);
        if(!cached)continue;
        this.tileStats.hits++;
        cached.used=++this.tileSeq;
        ctx.drawImage(cached.bmp,entry.dx,entry.y,tw,th);
      }
      const visibleRequests=[];
      for(const src of wanted)if(!this.tileCache.has(src))visibleRequests.push(this.requestTile(src));
      for(const src of ring)if(!this.tileCache.has(src))this.requestTile(src);
      if(visibleRequests.length){
        Promise.all(visibleRequests).then(()=>{
          // Repaint once the visible tiles land, so the planet-map path (which is
          // event-driven) is not left showing only the master until the next input.
          if(this.tileWanted===wanted)this.draw();
        }).catch(()=>{});
      }
      ctx.imageSmoothingEnabled=false;
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
      this._drawMaster(ctx,rect);
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
    // Master image plus its two horizontal wrap copies. Filtering follows the
    // scale: BILINEAR when minifying (a 4096px master shown at ~900px would
    // otherwise drop 3 of every 4 pixels and alias into noise), NEAREST when
    // magnifying, which is the documented pixel-art look and is what every
    // body does today.
    _drawMaster(ctx,rect){
      if(!this.master)return;
      const smooth=rect.w<this.master.naturalWidth;
      ctx.imageSmoothingEnabled=smooth;
      if(smooth)ctx.imageSmoothingQuality='high';
      ctx.drawImage(this.master,rect.x,rect.y,rect.w,rect.h);
      if(rect.x>0)ctx.drawImage(this.master,rect.x-rect.w,rect.y,rect.w,rect.h);
      if(rect.x+rect.w<this.width)ctx.drawImage(this.master,rect.x+rect.w,rect.y,rect.w,rect.h);
      ctx.imageSmoothingEnabled=false;
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
      this.assetVersion=(manifest&&manifest.version)||this.assetVersion||null;
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
    closeSurface(){ this.surf = null; this.vx = this.vy = 0; this._abortPendingTiles(); this.opts.onZoom?.(this.zoom); this.draw(); }
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
              this._drawMaster(ctx, rect);
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
