// analysis.js — canvas chart engine.
//
// The telemetry math that used to live here now lives in metrics.js, shared
// with the Node core and structured so it runs incrementally. This file is only
// rendering, plus re-exports of the formatting/translation helpers the views
// already call through `An`.
window.An=(function(){
const M=window.Metrics;
const C=M.C;

// ---- draw scheduling -------------------------------------------------------
// Views ask for redraws on a 500ms data tick; without coalescing, several
// canvases would each force their own layout/paint in the same frame.
const pending=new Map();
let rafId=0;
function schedule(key,fn){
  pending.set(key,fn);
  if(rafId)return;
  rafId=requestAnimationFrame(()=>{
    rafId=0;
    const jobs=[...pending.values()];pending.clear();
    for(const j of jobs){try{j()}catch(e){console.error('[chart]',e)}}
  });
}

// Canvas backing-store sizing. Capped at 2x so a high-DPI display does not
// quadruple the fill cost of every chart.
function prep(canvas){
  const w=canvas.clientWidth||600,h=canvas.clientHeight||180;
  const ratio=Math.min(2,window.devicePixelRatio||1);
  const bw=Math.round(w*ratio),bh=Math.round(h*ratio);
  if(canvas.width!==bw||canvas.height!==bh){canvas.width=bw;canvas.height=bh}
  const x=canvas.getContext('2d');
  x.setTransform(ratio,0,0,ratio,0,0);
  x.clearRect(0,0,w,h);
  return {x,w,h};
}

// Generic time-based multi-series line chart with optional right axis and
// vertical event markers.
function lineChart(canvas,cfg){
  const {x,w,h}=prep(canvas);
  const padL=44,padR=cfg.rightAxis?44:14,padT=10,padB=20;
  const iw=w-padL-padR,ih=h-padT-padB;
  const t0=cfg.t0,t1=Math.max(cfg.t1,t0+0.001);
  const series=cfg.series||[];
  const lmax=cfg.yLeft?.max||M.niceMax(seriesMax(series,'left'));
  const rmax=cfg.rightAxis?(cfg.yRight?.max||M.niceMax(seriesMax(series,'right'))):1;
  x.strokeStyle=C.grid;x.fillStyle=C.muted;x.font='10px Segoe UI';x.lineWidth=1;
  const yticks=cfg.yLeft?.ticks||5;
  x.beginPath();
  for(let i=0;i<=yticks;i++){const y=padT+ih-ih*i/yticks;x.moveTo(padL,y);x.lineTo(w-padR,y)}
  x.stroke();
  x.textAlign='right';
  for(let i=0;i<=yticks;i++){const y=padT+ih-ih*i/yticks;x.fillText(M.fmtNum(lmax*i/yticks),padL-6,y+3)}
  if(cfg.rightAxis){
    x.textAlign='left';x.fillStyle=series.find(s=>s.axis==='right')?.color||C.purple;
    for(let i=0;i<=yticks;i++){const y=padT+ih-ih*i/yticks;x.fillText(M.fmtNum(rmax*i/yticks),w-padR+6,y+3)}
  }
  const X=t=>padL+(t-t0)/(t1-t0)*iw;
  const Y=(v,ax)=>padT+ih-((ax==='right'?v/rmax:v/lmax))*ih;
  for(const m of cfg.markers||[]){
    x.strokeStyle=m.color;x.setLineDash([3,3]);x.beginPath();x.moveTo(X(m.t),padT);x.lineTo(X(m.t),padT+ih);x.stroke();x.setLineDash([]);
  }
  for(const s of series){
    const pts=s.points;
    if(!pts.length)continue;
    x.strokeStyle=s.color;x.fillStyle=s.color;x.lineWidth=s.width||1.6;
    x.beginPath();
    for(let i=0;i<pts.length;i++){const px=X(pts[i].x),py=Y(pts[i].y,s.axis);i?x.lineTo(px,py):x.moveTo(px,py)}
    x.stroke();
    if(s.fill){x.lineTo(X(pts[pts.length-1].x),Y(0,s.axis));x.lineTo(X(pts[0].x),Y(0,s.axis));x.closePath();x.globalAlpha=0.18;x.fill();x.globalAlpha=1}
  }
  x.fillStyle=C.muted;x.textAlign='center';
  const nt=cfg.xTicks||6;
  for(let i=0;i<=nt;i++){
    const t=t0+(t1-t0)*i/nt;
    x.fillText(cfg.xFmt?cfg.xFmt(t):M.fmtT(t),Math.min(w-padR-10,Math.max(padL+10,X(t))),h-6);
  }
  if(cfg.legend!==false&&series.length){
    let lx=padL+4;x.textAlign='left';x.font='10px Segoe UI';
    for(const s of series){x.fillStyle=s.color;x.fillRect(lx,4,8,3);x.fillStyle=C.muted;x.fillText(s.name,lx+12,9);lx+=12+x.measureText(s.name).width+14}
  }
}
// Max over an axis' series without spreading the point arrays into apply()
// (`Math.max(...pts)` blows the argument limit past ~100k points).
function seriesMax(series,axis){
  let m=1;
  for(const s of series){
    if((s.axis==='right')!==(axis==='right'))continue;
    const p=s.points;
    for(let i=0;i<p.length;i++)if(p[i].y>m)m=p[i].y;
  }
  return m;
}

// Horizontal event tick strips (input overlay).
function tickStrip(canvas,cfg){
  const {x,w,h}=prep(canvas);
  const padL=70,padR=10,padT=6,padB=16;
  const iw=w-padL-padR,lanes=cfg.lanes||[];
  const lh=(h-padT-padB)/Math.max(1,lanes.length);
  const t0=cfg.t0,t1=Math.max(cfg.t1,t0+0.001);
  x.font='10px Segoe UI';
  lanes.forEach((ln,i)=>{
    const y=padT+lh*i+lh/2;
    x.fillStyle=C.muted;x.textAlign='right';x.fillText(ln.name,padL-8,y+3);
    x.strokeStyle=C.grid;x.beginPath();x.moveTo(padL,y);x.lineTo(w-padR,y);x.stroke();
    x.fillStyle=ln.color;
    // Thousands of ticks collapse onto the same pixel column; drawing each one
    // is pure overdraw, so mark columns once.
    const seen=new Uint8Array(Math.max(1,Math.ceil(iw))+2);
    const ticks=ln.ticks,span=t1-t0;
    for(let k=0;k<ticks.length;k++){
      const col=Math.round((ticks[k]-t0)/span*iw);
      if(col<0||col>iw||seen[col])continue;
      seen[col]=1;
      x.fillRect(padL+col,y-4,1.6,8);
    }
  });
  x.fillStyle=C.muted;x.textAlign='center';
  for(let i=0;i<=6;i++){const t=t0+(t1-t0)*i/6;x.fillText(cfg.xFmt?cfg.xFmt(t):M.fmtT(t),Math.min(w-padR-10,Math.max(padL+10,padL+iw*i/6)),h-4)}
}

// Heatmap. Painted as a grid-resolution ImageData scaled up by the compositor
// rather than ~4600 individual arc() fills per redraw.
let heatBuf=null;
function heatmap(canvas,cfg){
  const {x,w,h}=prep(canvas);
  const gw=cfg.gridW||M.HEAT_W,gh=cfg.gridH||M.HEAT_H;
  const grid=cfg.grid;
  let max=cfg.max||0;
  if(!max)for(let i=0;i<grid.length;i++)if(grid[i]>max)max=grid[i];
  if(!max)max=1;
  if(!heatBuf||heatBuf.width!==gw||heatBuf.height!==gh){
    heatBuf=document.createElement('canvas');heatBuf.width=gw;heatBuf.height=gh;
  }
  const hx=heatBuf.getContext('2d');
  const img=hx.createImageData(gw,gh);
  const px=img.data;
  for(let i=0;i<gw*gh;i++){
    const v=grid[i]||0;
    const o=i*4;
    if(!v){px[o+3]=0;continue}
    const t=v/max;
    px[o]=59+(255-59)*t;
    px[o+1]=130+(82-130)*t;
    px[o+2]=246+(66-246)*t;
    px[o+3]=(0.12+0.75*t)*255;
  }
  hx.putImageData(img,0,0);
  x.imageSmoothingEnabled=true;x.imageSmoothingQuality='high';
  x.drawImage(heatBuf,0,0,gw,gh,0,0,w-14,h);
  // colourbar
  const bx=w-8;
  const gradient=x.createLinearGradient(0,h,0,0);
  gradient.addColorStop(0,'rgb(59,130,246)');gradient.addColorStop(1,'rgb(255,82,66)');
  x.fillStyle=gradient;x.fillRect(bx,0,4,h);
  x.fillStyle=C.muted;x.font='9px Segoe UI';x.textAlign='right';
  x.fillText('High',w-2,10);x.fillText('Low',w-2,h-2);
}

// Radial gauge (donut).
function donut(canvas,cfg){
  const {x,w,h}=prep(canvas);
  const cx=w/2,cy=h/2+4,r=Math.min(w,h)/2-16;
  x.lineWidth=9;x.strokeStyle=C.grid;x.beginPath();x.arc(cx,cy,r,0,Math.PI*2);x.stroke();
  x.strokeStyle=cfg.color||C.green;x.lineCap='round';
  x.beginPath();x.arc(cx,cy,r,-Math.PI/2,-Math.PI/2+Math.PI*2*(cfg.value||0));x.stroke();
  x.fillStyle=C.text;x.font='bold 20px Segoe UI';x.textAlign='center';
  x.fillText(cfg.center??`${Math.round((cfg.value||0)*100)}%`,cx,cy+2);
  x.fillStyle=C.muted;x.font='10px Segoe UI';x.fillText(cfg.label||'',cx,cy+18);
}

// Horizontal bars (top keys, kill outcomes).
function bars(canvas,cfg){
  const {x,w,h}=prep(canvas);
  const items=(cfg.items||[]).slice(0,8);
  let max=1;for(const i of items)if(i.value>max)max=i.value;
  const bh=Math.min(22,(h-8)/Math.max(1,items.length));
  x.font='11px Segoe UI';
  items.forEach((it,i)=>{
    const y=6+i*((h-12)/Math.max(1,items.length));
    x.fillStyle=C.text;x.textAlign='left';x.fillText(it.label,4,y+11,110);
    const bx=120,bw=w-190;
    x.fillStyle=C.grid;x.fillRect(bx,y+4,bw,bh-8);
    x.fillStyle=it.color||C.blue;x.fillRect(bx,y+4,bw*(it.value/max),bh-8);
    x.fillStyle=C.muted;x.textAlign='right';x.fillText(it.text??String(Math.round(it.value*100)/100),w-6,y+11);
  });
}

// Spectrum bars.
function spectrumChart(canvas,cfg){
  const {x,w,h}=prep(canvas);
  const mags=cfg.mags||[];
  if(!mags.length)return;
  let max=1;for(const m of mags)if(m.mag>max)max=m.mag;
  const bw=(w-50)/mags.length;
  x.strokeStyle=C.grid;x.fillStyle=C.muted;x.font='10px Segoe UI';
  for(let i=0;i<=4;i++){const y=10+(h-30)*(1-i/4);x.beginPath();x.moveTo(40,y);x.lineTo(w-8,y);x.stroke();x.textAlign='right';x.fillText(M.fmtNum(max*i/4),36,y+3)}
  x.fillStyle=C.blue;
  mags.forEach((m,i)=>{const bh=(h-30)*(m.mag/max);x.fillRect(42+i*bw,h-20-bh,Math.max(1,bw-2),bh)});
  x.fillStyle=C.muted;x.textAlign='center';
  for(let i=0;i<=4;i++)x.fillText(`${Math.round(mags.length*i/4)} Hz`,42+(w-50)*i/4,h-6);
}

return {C,YAW:M.YAW,HEAT_W:M.HEAT_W,HEAT_H:M.HEAT_H,
  niceMax:M.niceMax,fmtT:M.fmtT,fmtNum:M.fmtNum,
  degPerCount:M.degPerCount,cmPerCount:M.cmPerCount,edpi:M.edpi,cm360:M.cm360,
  spectrum:M.spectrum,Analyzer:M.Analyzer,analyze:M.analyze,
  prep,schedule,lineChart,tickStrip,heatmap,donut,bars,spectrumChart};
})();
