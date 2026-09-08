// metrics.js — pure telemetry math. Single source of truth shared by the
// browser (window.Metrics, classic script) and the Node core (CommonJS import
// from core/server.mjs — web/package.json has no "type", so this stays CJS).
//
// Design note: everything here is *incremental*. The dashboard used to re-run
// full-history analysis every 500ms tick; an Analyzer consumes each event
// exactly once and keeps O(1) accumulators, so a tick costs O(new events).
//
// Translation math is unchanged and exact: Valorant yaw is 0.022 deg per raw
// count at sensitivity 1.0. Raw counts are DPI-independent hardware units;
// physical distance is counts / DPI (inches), in-game rotation is
// counts * 0.022 * sens (degrees). eDPI = DPI * sens scales only the in-game
// translation, never the hardware counts.
(function(root,factory){
  const m=factory();
  if(typeof module==='object'&&module.exports)module.exports=m;else root.Metrics=m;
})(typeof self!=='undefined'?self:globalThis,function(){
'use strict';

const YAW=0.022;
const C={blue:'#3B82F6',purple:'#A855F7',violet:'#8B5CF6',green:'#22C55E',red:'#EF4444',orange:'#F97316',teal:'#2DD4BF',text:'#F1F5F9',muted:'#64748B',grid:'#1E2A3F',panel:'#111A2B'};

function degPerCount(sens){return YAW*(sens||0.5)}
function cmPerCount(dpi){return 2.54/(dpi||800)}
function edpi(dpi,sens){return Math.round((dpi||0)*(sens||0))}
function cm360(dpi,sens){return 360/(YAW*(sens||0.5))/(dpi||800)*2.54}

// ---- flick tuning (unchanged semantics) ------------------------------------
const FLICK_FLOOR=900;   // counts/s
const FLICK_K=4;         // baseline multiplier
const FLICK_WIN=80;      // rolling baseline window, in samples
const FLICK_QUIET=8;     // samples below threshold that close a burst

// Rolling median over a fixed window. The old code did `[...rolling].sort()`
// for *every* sample — an allocation plus an 80-element sort per mouse event.
// This keeps one sorted array and does a binary-search insert/remove instead:
// no allocation, no comparisons, just a short memmove.
class RollingMedian{
  constructor(size){this.size=size;this.raw=new Float64Array(size);this.sorted=new Float64Array(size);this.n=0;this.head=0}
  push(v){
    if(this.n===this.size)this._remove(this.raw[this.head]);
    this.raw[this.head]=v;
    this.head=(this.head+1)%this.size;
    this._insert(v);
  }
  _insert(v){
    const s=this.sorted;let lo=0,hi=this.n;          // n = count before insert
    while(lo<hi){const mid=(lo+hi)>>1;if(s[mid]<v)lo=mid+1;else hi=mid}
    for(let i=this.n;i>lo;i--)s[i]=s[i-1];
    s[lo]=v;this.n++;
  }
  _remove(v){
    const s=this.sorted;let lo=0,hi=this.n-1;
    while(lo<hi){const mid=(lo+hi)>>1;if(s[mid]<v)lo=mid+1;else hi=mid}
    for(let i=lo;i<this.n-1;i++)s[i]=s[i+1];
    this.n--;
  }
  median(){return this.n?this.sorted[this.n>>1]:0}
}

// Bounded ring of recent per-move samples, used by the windowed charts. Full
// history lives in the O(1) accumulators; only the visible window is retained
// sample-by-sample, so memory stays flat during a long capture.
class SampleRing{
  constructor(cap){this.cap=cap;this.t=new Float64Array(cap);this.dt=new Float32Array(cap);this.dx=new Float32Array(cap);this.dy=new Float32Array(cap);this.sp=new Float32Array(cap);this.n=0;this.head=0}
  push(t,dt,dx,dy,sp){
    const i=this.head;
    this.t[i]=t;this.dt[i]=dt;this.dx[i]=dx;this.dy[i]=dy;this.sp[i]=sp;
    this.head=(i+1)%this.cap;
    if(this.n<this.cap)this.n++;
  }
  // Oldest-first index of the k-th retained sample.
  at(k){return (this.head-this.n+k+this.cap*2)%this.cap}
  // First retained index (oldest-first ordinal) with t >= tMin. Binary search
  // over the ring, which is monotonically increasing in time.
  lowerBound(tMin){
    let lo=0,hi=this.n;
    while(lo<hi){const mid=(lo+hi)>>1;if(this.t[this.at(mid)]<tMin)lo=mid+1;else hi=mid}
    return lo;
  }
}

const HEAT_W=96,HEAT_H=48,HEAT_SCALE=0.22;
const KEY_TICK_CAP=20000;   // key timestamps retained for the overlay strip

// ---- incremental analyzer --------------------------------------------------
// feed() may be called repeatedly with the same growing array; only events past
// `consumed` are processed. Everything the UI reads is either an O(1)
// accumulator or a bounded buffer.
class Analyzer{
  constructor(opts){
    opts=opts||{};
    this.ringCap=opts.ringCap||300000;      // ~5 min of 1kHz movement
    this.reset();
  }
  reset(){
    this.consumed=0;
    this.first=null;this.last=0;
    this.count=0;
    // movement accumulators
    this.dist=0;this.moveN=0;this.spSum=0;this.spSqSum=0;this.peak=0;
    this.prevMoveT=null;
    // input counters
    this.keys=0;this.btn=0;this.keyCounts=new Map();
    this.clickTimes=[];this.clickLeft=[];this.clickRight=[];
    this._keyTicks=[];              // bounded tail, for the input-overlay strip
    // game
    this.kills=0;this.deaths=0;this.hs=0;
    this.timeline=[];this.rounds=[];this._curRound=null;
    // flick detection state
    this.baseline=new RollingMedian(FLICK_WIN);
    this.flicks=[];this._inFlick=false;this._cur=null;this._quiet=0;this._enriched=0;
    this.flickPathSum=0;this.flickNetSum=0;
    // windowed data
    this.ring=new SampleRing(this.ringCap);
    // heat grid (full history, fixed cost)
    this.heat=new Float32Array(HEAT_W*HEAT_H);        // speed-weighted + clicks
    this.heatFlat=new Float32Array(HEAT_W*HEAT_H);    // unweighted dwell
    this.heatMax=0;this.heatFlatMax=0;
    this._hx=HEAT_W/2;this._hy=HEAT_H/2;
    // cursor integration for the stage is owned by the stage itself
  }

  feed(events){
    const n=events.length;
    if(n<this.consumed){this.reset()}          // array was replaced/truncated
    for(let i=this.consumed;i<n;i++)this._one(events[i]);
    this.consumed=n;
    if(this._enriched<this.flicks.length)this._enrich();
    return this;
  }

  _one(e){
    const t=e.timestamp;
    if(this.first===null)this.first=t;
    this.last=t;
    this.count++;
    const type=e.type,d=e.data||{};
    if(type==='mouse_move'){
      const dx=d.dx||0,dy=d.dy||0;
      this.dist+=Math.hypot(dx,dy);
      // heat grid
      let hx=this._hx+dx*HEAT_SCALE,hy=this._hy+dy*HEAT_SCALE;
      if(hx<0)hx=0;else if(hx>HEAT_W-1)hx=HEAT_W-1;
      if(hy<0)hy=0;else if(hy>HEAT_H-1)hy=HEAT_H-1;
      this._hx=hx;this._hy=hy;
      const hi=(hy|0)*HEAT_W+(hx|0);
      const v=this.heat[hi]+Math.min(3,Math.hypot(dx,dy)/400+0.2);
      this.heat[hi]=v;
      if(v>this.heatMax)this.heatMax=v;
      const fv=this.heatFlat[hi]+1;
      this.heatFlat[hi]=fv;
      if(fv>this.heatFlatMax)this.heatFlatMax=fv;
      if(this.prevMoveT!==null){
        let dt=t-this.prevMoveT;
        if(dt<=0)dt=1/8000;else if(dt>0.25)dt=0.25;
        const sp=Math.hypot(dx,dy)/dt;
        this.moveN++;this.spSum+=sp;this.spSqSum+=sp*sp;
        if(sp>this.peak)this.peak=sp;
        this.ring.push(t,dt,dx,dy,sp);
        const r=this._curRound;
        if(r){r.spSum+=sp;r.spN++;if(sp>r.peak)r.peak=sp}
        this._flick(t,dt,dx,dy,sp);
      }
      this.prevMoveT=t;
      if(this._curRound)this._curRound.distance+=Math.hypot(dx,dy);
      return;
    }
    if(type==='mouse_button'){
      if(d.state==='down'){
        this.btn++;this.clickTimes.push(t);
        if(d.button==='left')this.clickLeft.push(t);
        else if(d.button==='right')this.clickRight.push(t);
        const hi=((this._hy|0)*HEAT_W)+(this._hx|0);
        const v=this.heat[hi]+8;this.heat[hi]=v;
        if(v>this.heatMax)this.heatMax=v;
      }
      return;
    }
    if(type==='key_down'&&e.device==='keyboard'){
      this.keys++;
      const k=d.key;this.keyCounts.set(k,(this.keyCounts.get(k)||0)+1);
      const kt=this._keyTicks;
      kt.push(t);
      if(kt.length>KEY_TICK_CAP*2)kt.splice(0,kt.length-KEY_TICK_CAP);
      return;
    }
    if(e.device==='game')this._game(e,t,d);
  }

  _game(e,t,d){
    const kind=d.kind;
    this.timeline.push({t,kind,color:gameColor(kind),label:gameLabel(d)});
    if(e.type==='game_round_start'){
      if(this._curRound)this._curRound.t1=t;
      const r={n:d.round||this.rounds.length+1,t0:t,t1:0,kills:0,deaths:0,headshots:0,distance:0,
        spSum:0,spN:0,peak:0,flicks:0,flickPath:0,flickNet:0};
      this.rounds.push(r);this._curRound=r;return;
    }
    if(e.type==='game_match_end'){if(this._curRound){this._curRound.t1=t;this._curRound=null}return}
    if(this._curRound){
      if(e.type==='game_kill')this._curRound.kills++;
      else if(e.type==='game_death')this._curRound.deaths++;
      else if(e.type==='game_headshot')this._curRound.headshots++;
    }
    if(kind==='kill')this.kills++;
    else if(kind==='death')this.deaths++;
    else if(kind==='headshot')this.hs++;
  }

  _flick(t,dt,dx,dy,sp){
    this.baseline.push(sp);
    const med=this.baseline.median();
    const thr=FLICK_FLOOR>FLICK_K*med?FLICK_FLOOR:FLICK_K*med;
    if(!this._inFlick){
      if(sp>thr){
        this._inFlick=true;this._quiet=0;
        this._cur={t0:t,t1:t,peak:sp,peakT:t,path:0,nx:0,ny:0,reversals:0,lastAngle:null,peakSeen:false};
      }
      return;
    }
    const cur=this._cur;
    cur.t1=t;cur.path+=Math.hypot(dx,dy);cur.nx+=dx;cur.ny+=dy;
    if(sp>cur.peak){cur.peak=sp;cur.peakT=t;cur.peakSeen=true;this._quiet=0}
    const ang=Math.atan2(dy,dx);
    if(cur.lastAngle!==null){
      let a=Math.abs(ang-cur.lastAngle);if(a>Math.PI)a=2*Math.PI-a;
      if(a>1.75&&sp>med)cur.reversals++;      // >100 deg reversal while moving
    }
    cur.lastAngle=ang;
    if(sp>thr)this._quiet=0;else this._quiet++;
    if(this._quiet>=FLICK_QUIET||dt>0.25){
      this._inFlick=false;
      if(cur.peakSeen&&cur.t1-cur.t0>0.01){
        cur.round=this._curRound||null;
        this.flicks.push(cur);
        if(cur.round){cur.round.flicks++;cur.round.flickPath+=cur.path;cur.round.flickNet+=Math.hypot(cur.nx,cur.ny)}
      }
      this._cur=null;
    }
  }

  // Derived per-flick fields + flick-back pairing. Only newly closed flicks are
  // enriched; the flick-back scan re-checks a small tail because a later flick
  // can complete an earlier one's pair.
  _enrich(){
    const fl=this.flicks;
    for(let i=this._enriched;i<fl.length;i++){
      const f=fl[i];
      f.durMs=(f.t1-f.t0)*1000;
      f.angleDeg=Math.round(Math.atan2(f.ny,f.nx)*180/Math.PI);
      f.net=Math.hypot(f.nx,f.ny);
      f.efficiency=f.path?f.net/f.path:0;
      f.micro=f.reversals;
      f.correctionMs=Math.round((f.t1-f.peakT)*1000);
      f.flickBack=null;
      this.flickPathSum+=f.path;this.flickNetSum+=f.net;
    }
    // Pair unresolved flicks against anything that closed since last time.
    for(let i=Math.max(0,this._enriched-16);i<fl.length;i++){
      const f=fl[i];
      if(f.flickBack)continue;
      for(let j=i+1;j<fl.length;j++){
        const g=fl[j];
        if(g.t0-f.t1>1.5)break;
        let a=Math.abs(g.angleDeg-f.angleDeg);if(a>180)a=360-a;
        if(a>145){f.flickBack={delayMs:Math.round((g.t0-f.t1)*1000),angleDeg:g.angleDeg,peak:g.peak};break}
      }
    }
    this._enriched=fl.length;
  }

  // Close an in-progress flick. Only for finished sessions — a live capture
  // leaves the burst open so it can still grow on the next feed().
  finalize(){
    if(this._inFlick&&this._cur){
      const c=this._cur;
      if(c.peakSeen&&c.t1-c.t0>0.01)this.flicks.push(c);
      this._inFlick=false;this._cur=null;
    }
    if(this._enriched<this.flicks.length)this._enrich();
    return this;
  }

  // Median/min/max latency from each flick's end to the next click within 2s.
  // Merge scan over two already-sorted lists instead of a linear `find` per
  // flick (was O(flicks x clicks)).
  flickLatency(){
    const fl=this.flicks,cl=this.clickTimes;
    if(!fl.length||!cl.length)return null;
    const lat=[];let j=0;
    for(let i=0;i<fl.length;i++){
      const end=fl[i].t1;
      while(j<cl.length&&cl[j]<end)j++;
      if(j<cl.length&&cl[j]-end<2)lat.push((cl[j]-end)*1000);
    }
    if(!lat.length)return null;
    lat.sort((a,b)=>a-b);
    return {median:Math.round(lat[lat.length>>1]),min:Math.round(lat[0]),max:Math.round(lat[lat.length-1]),n:lat.length};
  }

  avgFlickEfficiency(){return this.flickPathSum?this.flickNetSum/this.flickPathSum:0}

  summary(){
    const avg=this.moveN?this.spSum/this.moveN:0;
    const varr=this.moveN?Math.max(0,this.spSqSum/this.moveN-avg*avg):0;
    const t0=this.first===null?0:this.first;
    return {dist:this.dist,keys:this.keys,btn:this.btn,avg,peak:this.peak,sd:Math.sqrt(varr),
      kills:this.kills,deaths:this.deaths,hs:this.hs,
      kd:this.deaths?this.kills/this.deaths:this.kills,
      hsPct:this.kills?this.hs/this.kills*100:(this.hs?100:0),
      flicks:this.flicks.length,flickLatency:this.flickLatency(),
      duration:this.last-t0,events:this.count,t0,t1:this.last};
  }

  // Close open rounds at tEnd without mutating the incremental state.
  roundsAt(tEnd){
    const out=this.rounds;
    for(let i=0;i<out.length;i++)if(!out[i].t1)out[i].t1=tEnd||out[i].t0+1;
    return out;
  }

  // O(1) rollup for the round panel.
  roundStats(r){
    if(!r)return null;
    return {avg:r.spN?r.spSum/r.spN:0,peak:r.peak,dist:r.distance,flicks:r.flicks,
      efficiency:r.flickPath?r.flickNet/r.flickPath:0,
      kills:r.kills,deaths:r.deaths,headshots:r.headshots};
  }

  topKeys(n){
    return [...this.keyCounts.entries()].sort((a,b)=>b[1]-a[1]).slice(0,n||8).map(([label,value])=>({label,value}));
  }

  // ---- windowed views (bounded work, independent of history length) --------
  // Downsampled dx/dy series for the XY chart.
  moveSeries(tMin,maxPts){
    const r=this.ring,start=r.lowerBound(tMin),n=r.n-start;
    const step=Math.max(1,Math.ceil(n/(maxPts||600)));
    const xs=[],ys=[];
    for(let k=start;k<r.n;k+=step){const i=r.at(k);xs.push({x:r.t[i],y:r.dx[i]});ys.push({x:r.t[i],y:r.dy[i]})}
    return {xs,ys};
  }
  // Bin the windowed speed signal into n buckets. agg 'max' catches flick peaks.
  speedBins(t0,t1,n,agg){
    const bins=new Float64Array(n),cnt=agg==='mean'?new Float64Array(n):null;
    const w=(t1-t0)/n||1;
    const r=this.ring,start=r.lowerBound(t0);
    for(let k=start;k<r.n;k++){
      const i=r.at(k);
      let b=Math.floor((r.t[i]-t0)/w);
      if(b<0)b=0;else if(b>=n)b=n-1;
      const v=r.sp[i];
      if(cnt){bins[b]+=v;cnt[b]++}
      else if(v>bins[b])bins[b]=v;
    }
    const out=new Array(n);
    for(let i=0;i<n;i++)out[i]={t:t0+(i+0.5)*w,v:cnt?(cnt[i]?bins[i]/cnt[i]:0):bins[i]};
    return out;
  }
  // Key timestamps live outside the movement ring; they are far sparser, so a
  // bounded tail array is enough. Binary search for the window start.
  keyTicks(tMin){
    const a=this._keyTicks;
    let lo=0,hi=a.length;
    while(lo<hi){const mid=(lo+hi)>>1;if(a[mid]<tMin)lo=mid+1;else hi=mid}
    return lo?a.slice(lo):a;
  }
  // Movement tick timestamps from the ring, oldest first.
  moveTicks(tMin){
    const r=this.ring,start=r.lowerBound(tMin),out=new Float64Array(Math.max(0,r.n-start));
    for(let k=start;k<r.n;k++)out[k-start]=r.t[r.at(k)];
    return out;
  }
  clickTicks(tMin){
    const a=this.clickTimes;
    let lo=0,hi=a.length;
    while(lo<hi){const mid=(lo+hi)>>1;if(a[mid]<tMin)lo=mid+1;else hi=mid}
    return lo?a.slice(lo):a;
  }
}

// Simple DFT magnitude spectrum of a binned signal.
function spectrum(bins,binsWanted){
  binsWanted=binsWanted||48;
  const N=bins.length,out=new Array(binsWanted);
  let mean=0;for(let i=0;i<N;i++)mean+=bins[i].v;mean/=N;
  const xs=new Float64Array(N);for(let i=0;i<N;i++)xs[i]=bins[i].v-mean;
  for(let f=1;f<=binsWanted;f++){
    let re=0,im=0;
    const step=2*Math.PI*f/N;
    for(let t=0;t<N;t++){const a=step*t;re+=xs[t]*Math.cos(a);im-=xs[t]*Math.sin(a)}
    out[f-1]={freq:f,mag:2*Math.hypot(re,im)/N};
  }
  return out;
}

function gameColor(kind){
  return kind==='kill'?C.green:kind==='death'?C.red
    :(kind&&(kind.startsWith('round')||kind==='agent_select'))?C.blue
    :kind==='headshot'?C.orange:C.muted;
}
function gameLabel(d){
  const k=d.kind;
  return k==='round_start'?`Round ${d.round} started`
    :k==='kill'?`Kill${d.headshot?' (HS)':''}`
    :k==='death'?'Died'
    :k==='agent_select'?'Agent select'
    :k==='map'?`Map: ${d.map}`
    :String(k||'').replace(/_/g,' ');
}

function niceMax(v){if(v<=0)return 1;const p=Math.pow(10,Math.floor(Math.log10(v)));const m=v/p;return (m<=1?1:m<=2?2:m<=5?5:10)*p}
function fmtT(t){const m=Math.floor(t/60),s=Math.floor(t%60);return `${m}:${String(s).padStart(2,'0')}`}
function fmtNum(v){return v>=10000?(v/1000).toFixed(0)+'k':v>=1000?(v/1000).toFixed(1)+'k':v>=100?Math.round(v):v>=10?v.toFixed(0):v.toFixed(1)}

// One-shot analysis of a finished session — used by the Node core to derive the
// metadata sidecar so the browser never has to download raw events for stats.
function analyze(events,opts){
  return new Analyzer(opts).feed(events||[]).finalize();
}

// Compact, JSON-serialisable rollup of a saved session. This is what the stats
// panel aggregates over, replacing a per-session raw-event download.
function digest(events,tEnd){
  const a=analyze(events,{ringCap:1});     // ring unused; charts read the digest
  const s=a.summary();
  return {
    dist:s.dist,keys:s.keys,btn:s.btn,avg:s.avg,peak:s.peak,sd:s.sd,
    kills:s.kills,deaths:s.deaths,hs:s.hs,kd:s.kd,hsPct:s.hsPct,
    flicks:s.flicks,flickLatency:s.flickLatency,duration:s.duration,
    events:s.events,t0:s.t0,t1:s.t1,
    rounds:a.roundsAt(tEnd).length,
    roundList:a.roundsAt(tEnd).map(r=>({n:r.n,t0:r.t0,t1:r.t1,kills:r.kills,deaths:r.deaths,
      headshots:r.headshots,distance:r.distance,avg:r.spN?r.spSum/r.spN:0,flicks:r.flicks})),
    topKeys:a.topKeys(12),
    heatMax:a.heatMax,
    avgFlickEfficiency:a.avgFlickEfficiency(),
  };
}

return {YAW,C,HEAT_W,HEAT_H,degPerCount,cmPerCount,edpi,cm360,
  Analyzer,RollingMedian,SampleRing,analyze,digest,spectrum,
  gameColor,gameLabel,niceMax,fmtT,fmtNum};
});
