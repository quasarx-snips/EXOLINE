
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
        this.drag={x:p.x,y:p.y,cx:this.cx,cy:this.cy};
        this.vx=this.vy=0;
        this.canvas.setPointerCapture?.(e.pointerId);
        this.canvas.classList.add('dragging');
      });
      this.canvas.addEventListener('pointermove',e=>{
        if(!this.drag) return;
        const p=this.local(e), mapW=this.mapWidth();
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
  }
  return {MapRenderer};
})();
