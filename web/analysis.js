// analysis.js — shared telemetry math + canvas chart engine.
// All translation math is exact: Valorant yaw is 0.022 deg per raw count at
// sensitivity 1.0. Raw counts are DPI-independent hardware units; physical
// cursor distance is counts / DPI (inches) and in-game rotation is
// counts * 0.022 * sens (degrees). eDPI = DPI * sens only scales the *in-game*
// translation, never the hardware counts.
window.An=(function(){
const YAW=0.022;
const C={blue:'#3B82F6',purple:'#A855F7',violet:'#8B5CF6',green:'#22C55E',red:'#EF4444',orange:'#F97316',teal:'#2DD4BF',text:'#F1F5F9',muted:'#64748B',grid:'#1E2A3F',panel:'#111A2B'};

function degPerCount(sens){return YAW*(sens||0.5)}
function cmPerCount(dpi){return 2.54/(dpi||800)}
function edpi(dpi,sens){return Math.round((dpi||0)*(sens||0))}
function cm360(dpi,sens){return 360/(YAW*(sens||0.5))/(dpi||800)*2.54}

function moves(events){return events.filter(e=>e.type==='mouse_move')}
function clicks(events){return events.filter(e=>e.type==='mouse_button'&&e.data.state==='down')}
function keyPresses(events){return events.filter(e=>e.device==='keyboard'&&e.type==='key_down')}
function gameEvents(events){return events.filter(e=>e.device==='game')}

// Per-move instantaneous speed in raw counts/s (dt capped so buffer gaps
// between packets don't create fake spikes).
function speedSignal(events){
  const ev=moves(events);const out=[];let prev=null;
  for(const e of ev){
    if(prev!==null){
      let dt=e.timestamp-prev;
      if(dt<=0)dt=1/8000; if(dt>0.25)dt=0.25;
      const dx=e.data.dx||0,dy=e.data.dy||0;
      out.push({t:e.timestamp,dt,dx,dy,speed:Math.hypot(dx,dy)/dt});
    }
    prev=e.timestamp;
  }
  return out;
}

// Bin a signal into n buckets across [t0,t1]. agg='max' catches flick peaks.
function binSignal(sig,t0,t1,n,agg='max'){
  const bins=new Array(n).fill(0);const w=(t1-t0)/n;
  for(const s of sig){
    let i=Math.floor((s.t-t0)/w);
    if(i<0)i=0; if(i>=n)i=n-1;
    const v=s.speed;
    if(agg==='max'){if(v>bins[i])bins[i]=v}
    else bins[i]+=v;
  }
  if(agg==='mean'){const cnt=new Array(n).fill(0);for(const s of sig){let i=Math.floor((s.t-t0)/w);if(i<0)i=0;if(i>=n)i=n-1;cnt[i]++}for(let i=0;i<n;i++)bins[i]=cnt[i]?bins[i]/cnt[i]:0}
  return bins.map((v,i)=>({t:t0+(i+0.5)*w,v}));
}

// Flick detection on the raw speed signal. A flick is a burst above
// max(floor, k*baseline). Baseline is a rolling median of recent speed.
function detectFlicks(events,opts={}){
  const sig=speedSignal(events);
  if(sig.length<20)return [];
  const floor=opts.floor??900;            // counts/s
  const k=opts.k??4;                      // baseline multiplier
  const win=opts.win??80;                 // rolling window (events)
  const flicks=[];
  let base=new Array(Math.min(win,sig.length));
  let inFlick=false,cur=null,quiet=0;
  const rolling=[];
  for(let i=0;i<sig.length;i++){
    const s=sig[i];
    rolling.push(s.speed); if(rolling.length>win)rolling.shift();
    const sorted=[...rolling].sort((a,b)=>a-b);
    const med=sorted[Math.floor(sorted.length/2)]||0;
    const thr=Math.max(floor,k*med);
    if(!inFlick){
      if(s.speed>thr){
        inFlick=true;quiet=0;
        cur={t0:s.t,t1:s.t,peak:s.speed,peakT:s.t,path:0,nx:0,ny:0,heading:[],reversals:0,lastAngle:null,peakSeen:false};
      }
    }else{
      cur.t1=s.t;cur.path+=Math.hypot(s.dx,s.dy);cur.nx+=s.dx;cur.ny+=s.dy;
      if(s.speed>cur.peak){cur.peak=s.speed;cur.peakT=s.t;cur.peakSeen=true;quiet=0}
      const ang=Math.atan2(s.dy,s.dx);
      if(cur.lastAngle!==null){
        let d=Math.abs(ang-cur.lastAngle);if(d>Math.PI)d=2*Math.PI-d;
        if(d>1.75&&s.speed>med)cur.reversals++;   // >100 deg reversal while moving
      }
      cur.lastAngle=ang;
      if(s.speed>thr)quiet=0;else quiet++;
      const gap=s.dt>0.25;
      if(quiet>=8||gap||(i===sig.length-1)){
        inFlick=false;
        if(cur.peakSeen&&cur.t1-cur.t0>0.01)flicks.push(cur);
        cur=null;
      }
    }
  }
  // Enrich: micro-adjustments, correction time, flick-back.
  for(let f=0;f<flicks.length;f++){
    const fl=flicks[f];
    fl.durMs=(fl.t1-fl.t0)*1000;
    fl.angleDeg=Math.round(Math.atan2(fl.ny,fl.nx)*180/Math.PI);
    fl.net=Math.hypot(fl.nx,fl.ny);
    fl.efficiency=fl.path?fl.net/fl.path:0;
    fl.micro=fl.reversals;
    fl.correctionMs=Math.round((fl.t1-fl.peakT)*1000); // time spent correcting after peak
    // Flick-back: next flick within 1.5s whose direction is near-opposite.
    fl.flickBack=null;
    for(let j=f+1;j<flicks.length;j++){
      const g=flicks[j];
      if(g.t0-fl.t1>1.5)break;
      let d=Math.abs(g.angleDeg-fl.angleDeg);if(d>180)d=360-d;
      if(d>145){fl.flickBack={delayMs:Math.round((g.t0-fl.t1)*1000),angleDeg:g.angleDeg,peak:g.peak};break}
    }
  }
  return flicks;
}

// Flick -> first click latency after each flick end.
function flickLatency(flicks,events){
  const cl=clicks(events).map(e=>e.timestamp);
  if(!flicks.length||!cl.length)return null;
  const lat=[];
  for(const f of flicks){
    const next=cl.find(t=>t>=f.t1);
    if(next!==undefined&&next-f.t1<2)lat.push((next-f.t1)*1000);
  }
  if(!lat.length)return null;
  lat.sort((a,b)=>a-b);
  return {median:Math.round(lat[Math.floor(lat.length/2)]),min:Math.round(lat[0]),max:Math.round(lat[lat.length-1]),n:lat.length};
}

// Cursor position integration for heatmaps (origin at canvas center).
function heatmapGrid(events,w,h,weightBySpeed=false){
  const grid=new Float32Array(w*h);
  let x=w/2,y=h/2;
  const scale=0.22;
  for(const e of moves(events)){
    x+=(e.data.dx||0)*scale; y+=(e.data.dy||0)*scale;
    if(x<0)x=0; if(x>w-1)x=w-1; if(y<0)y=0; if(y>h-1)y=h-1;
    const weight=weightBySpeed?Math.min(3,(e.data.dx?Math.hypot(e.data.dx,e.data.dy):0)/400+0.2):1;
    grid[(y|0)*w+(x|0)]+=weight;
    if(e.type==='mouse_button'&&e.data.state==='down')grid[(y|0)*w+(x|0)]+=8;
  }
  return grid;
}

// Simple DFT magnitude spectrum of a binned speed signal.
function spectrum(bins,binsWanted=48){
  const N=bins.length;const out=[];
  const mean=bins.reduce((a,b)=>a+b.v,0)/N;
  const xs=bins.map(b=>b.v-mean);
  for(let f=1;f<=binsWanted;f++){
    let re=0,im=0;
    for(let t=0;t<N;t++){const ang=2*Math.PI*f*t/N;re+=xs[t]*Math.cos(ang);im-=xs[t]*Math.sin(ang)}
    out.push({freq:f,mag:2*Math.hypot(re,im)/N});
  }
  return out;
}

// Reconstruct rounds from game events. tEnd closes the final round.
function rounds(events,tEnd){
  const rs=[];let cur=null;
  const ensure=t=>{if(!cur){cur={n:rs.length+1,t0:t,t1:t,kills:0,deaths:0,headshots:0,distance:0};rs.push(cur)}return cur};
  for(const e of events){
    if(e.type==='game_round_start'){if(cur){cur.t1=e.timestamp}cur=null;const r=ensure(e.timestamp);r.n=e.data.round||rs.length;continue}
    if(e.type==='game_match_end'){if(cur){cur.t1=e.timestamp;cur=null}continue}
    if(cur){
      if(e.type==='game_kill')cur.kills++;
      if(e.type==='game_death')cur.deaths++;
      if(e.type==='game_headshot')cur.headshots++;
      if(e.type==='mouse_move')cur.distance+=Math.hypot(e.data.dx||0,e.data.dy||0);
    }
  }
  for(const r of rs){if(!r.t1)r.t1=tEnd||r.t0+1}
  return rs;
}

function gameTimeline(events){
  return gameEvents(events).map(e=>({t:e.timestamp,kind:e.data.kind,color:e.data.kind==='kill'?C.green:e.data.kind==='death'?C.red:e.data.kind.startsWith('round')||e.data.kind==='agent_select'?C.blue:e.data.kind==='headshot'?C.orange:C.muted,label:e.data.kind==='round_start'?`Round ${e.data.round} started`:e.data.kind==='kill'?`Kill${e.data.headshot?' (HS)':''}`:e.data.kind==='death'?'Died':e.data.kind==='agent_select'?'Agent select':e.data.kind==='map'?`Map: ${e.data.map}`:e.data.kind.replace(/_/g,' ')}));
}

function summary(events,settings){
  const mv=moves(events);const sig=speedSignal(events);
  let dist=0;for(const e of mv)dist+=Math.hypot(e.data.dx||0,e.data.dy||0);
  const speeds=sig.map(s=>s.speed);
  const avg=speeds.length?speeds.reduce((a,b)=>a+b,0)/speeds.length:0;
  const peak=speeds.length?Math.max(...speeds):0;
  const sd=speeds.length?Math.sqrt(speeds.reduce((a,b)=>a+(b-avg)*(b-avg),0)/speeds.length):0;
  const keys=keyPresses(events).length,btn=clicks(events).length;
  const ge=gameEvents(events);
  const kills=ge.filter(e=>e.data.kind==='kill').length;
  const deaths=ge.filter(e=>e.data.kind==='death').length;
  const hs=ge.filter(e=>e.data.kind==='headshot').length;
  const fl=detectFlicks(events);
  const flLat=flickLatency(fl,events);
  const t0=events.length?events[0].timestamp:0;
  const t1=events.length?events[events.length-1].timestamp:t0;
  return {dist,keys,btn,avg,peak,sd,kills,deaths,hs,kd:deaths?kills/deaths:kills,hsPct:kills?hs/kills*100:(hs?100:0),
    flicks:fl.length,flickLatency:flLat,duration:t1-t0,events:events.length,t0,t1};
}

// ---- chart engine ----------------------------------------------------------
function prep(canvas){
  const w=canvas.clientWidth||600,h=canvas.clientHeight||180,ratio=devicePixelRatio||1;
  if(canvas.width!==w*ratio||canvas.height!==h*ratio){canvas.width=w*ratio;canvas.height=h*ratio}
  const x=canvas.getContext('2d');x.setTransform(ratio,0,0,ratio,0,0);x.clearRect(0,0,w,h);
  return {x,w,h};
}
function niceMax(v){if(v<=0)return 1;const p=Math.pow(10,Math.floor(Math.log10(v)));const m=v/p;const n=m<=1?1:m<=2?2:m<=5?5:10;return n*p}
function fmtT(t){const m=Math.floor(t/60),s=Math.floor(t%60);return `${m}:${String(s).padStart(2,'0')}`}

// Generic time-based multi-series line/area chart with optional right axis and
// vertical event markers.
function lineChart(canvas,cfg){
  const {x,w,h}=prep(canvas);
  const padL=44,padR=cfg.rightAxis?44:14,padT=10,padB=20;
  const iw=w-padL-padR,ih=h-padT-padB;
  const t0=cfg.t0,t1=Math.max(cfg.t1,t0+0.001);
  const series=cfg.series||[];
  const lmax=cfg.yLeft?.max||niceMax(Math.max(1,...series.filter(s=>s.axis!=='right').flatMap(s=>s.points.map(p=>p.y))));
  const rmax=cfg.rightAxis?(cfg.yRight?.max||niceMax(Math.max(1,...series.filter(s=>s.axis==='right').flatMap(s=>s.points.map(p=>p.y))))):1;
  x.strokeStyle=C.grid;x.fillStyle=C.muted;x.font='10px Segoe UI';x.lineWidth=1;
  const yticks=cfg.yLeft?.ticks||5;
  for(let i=0;i<=yticks;i++){
    const v=lmax*i/yticks,y=padT+ih-ih*i/yticks;
    x.beginPath();x.moveTo(padL,y);x.lineTo(w-padR,y);x.stroke();
    x.textAlign='right';x.fillText(fmtNum(v),padL-6,y+3);
  }
  if(cfg.rightAxis){
    x.textAlign='left';x.fillStyle=series.find(s=>s.axis==='right')?.color||C.purple;
    for(let i=0;i<=yticks;i++){const v=rmax*i/yticks,y=padT+ih-ih*i/yticks;x.fillText(fmtNum(v),w-padR+6,y+3)}
  }
  const X=t=>padL+ (t-t0)/(t1-t0)*iw;
  const Y=(v,ax)=>padT+ih-( (ax==='right'?v/rmax:v/lmax) )*ih;
  // markers behind data
  for(const m of cfg.markers||[]){
    x.strokeStyle=m.color;x.setLineDash([3,3]);x.beginPath();x.moveTo(X(m.t),padT);x.lineTo(X(m.t),padT+ih);x.stroke();x.setLineDash([]);
  }
  for(const s of series){
    if(!s.points.length)continue;
    x.strokeStyle=s.color;x.fillStyle=s.color;x.lineWidth=s.width||1.6;
    x.beginPath();
    s.points.forEach((p,i)=>{const px=X(p.x),py=Y(p.y,s.axis);i?x.lineTo(px,py):x.moveTo(px,py)});
    x.stroke();
    if(s.fill){x.lineTo(X(s.points[s.points.length-1].x),Y(0,s.axis));x.lineTo(X(s.points[0].x),Y(0,s.axis));x.closePath();x.globalAlpha=0.18;x.fill();x.globalAlpha=1}
  }
  // x ticks (time)
  x.fillStyle=C.muted;x.textAlign='center';
  const nt=cfg.xTicks||6;
  for(let i=0;i<=nt;i++){
    const t=t0+(t1-t0)*i/nt;
    x.fillText(cfg.xFmt?cfg.xFmt(t):fmtT(t),Math.min(w-padR-10,Math.max(padL+10,X(t))),h-6);
  }
  // legend
  if(cfg.legend!==false&&series.length){
    let lx=padL+4;x.textAlign='left';x.font='10px Segoe UI';
    for(const s of series){x.fillStyle=s.color;x.fillRect(lx,4,8,3);x.fillStyle=C.muted;x.fillText(s.name,lx+12,9);lx+=12+x.measureText(s.name).width+14}
  }
}
function fmtNum(v){return v>=10000?(v/1000).toFixed(0)+'k':v>=1000?(v/1000).toFixed(1)+'k':v>=100?Math.round(v):v>=10?v.toFixed(0):v.toFixed(1)}

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
    for(const t of ln.ticks){
      const px=padL+(t-t0)/(t1-t0)*iw;
      if(px>=padL-1&&px<=w-padR+1)x.fillRect(px,y-4,1.6,8);
    }
  });
  x.fillStyle=C.muted;x.textAlign='center';
  for(let i=0;i<=6;i++){const t=t0+(t1-t0)*i/6;x.fillText(cfg.xFmt?cfg.xFmt(t):fmtT(t),Math.min(w-padR-10,Math.max(padL+10,padL+iw*i/6)),h-4)}
}

// Heatmap with blue->red ramp + optional colorbar.
function heatmap(canvas,cfg){
  const {x,w,h}=prep(canvas);
  const gw=cfg.gridW||96,gh=cfg.gridH||48;
  const cw=(w-14)/gw,ch=h/gh;
  let max=0;for(const v of cfg.grid)if(v>max)max=v;
  for(let gy=0;gy<gh;gy++)for(let gx=0;gx<gw;gx++){
    const v=cfg.grid[gy*gw+gx]||0;
    if(!v)continue;
    const i=v/max;
    const r=Math.round(59+ (255-59)*i), g=Math.round(130+(82-130)*i), b=Math.round(246+(66-246)*i);
    x.fillStyle=`rgba(${r},${g},${b},${0.12+0.75*i})`;
    x.beginPath();x.arc(gx*cw+cw/2,gy*ch+ch/2,Math.max(2,cw*0.7),0,7);x.fill();
  }
  // colorbar
  const bx=w-8;
  for(let yy=0;yy<h;yy++){const i=1-yy/h;const r=Math.round(59+(255-59)*i),g=Math.round(130+(82-130)*i),b=Math.round(246+(66-246)*i);x.fillStyle=`rgb(${r},${g},${b})`;x.fillRect(bx,yy,4,1)}
  x.fillStyle=C.muted;x.font='9px Segoe UI';x.textAlign='right';x.fillText('High',w-2,10);x.fillText('Low',w-2,h-2);
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

// Horizontal bars (weapons, top keys).
function bars(canvas,cfg){
  const {x,w,h}=prep(canvas);
  const items=(cfg.items||[]).slice(0,8);
  const max=Math.max(1,...items.map(i=>i.value));
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
  const mags=cfg.mags||[];const max=Math.max(1,...mags.map(m=>m.mag));
  const bw=(w-50)/mags.length;
  x.strokeStyle=C.grid;x.fillStyle=C.muted;x.font='10px Segoe UI';
  for(let i=0;i<=4;i++){const y=10+(h-30)*(1-i/4);x.beginPath();x.moveTo(40,y);x.lineTo(w-8,y);x.stroke();x.textAlign='right';x.fillText(fmtNum(max*i/4),36,y+3)}
  mags.forEach((m,i)=>{
    const bh=(h-30)*(m.mag/max);
    x.fillStyle=C.blue;x.fillRect(42+i*bw,h-20-bh,Math.max(1,bw-2),bh);
  });
  x.fillStyle=C.muted;x.textAlign='center';
  for(let i=0;i<=4;i++)x.fillText(`${Math.round(mags.length*i/4)} Hz`,42+(w-50)*i/4,h-6);
}

return {C,YAW,niceMax,degPerCount,cmPerCount,edpi,cm360,moves,clicks,keyPresses,gameEvents,speedSignal,binSignal,detectFlicks,flickLatency,heatmapGrid,spectrum,rounds,gameTimeline,summary,lineChart,tickStrip,heatmap,donut,bars,spectrumChart,fmtT,fmtNum,prep};
})();
