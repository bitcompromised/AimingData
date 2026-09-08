// stage.js — input replay stage: integrates mouse deltas into a cursor, draws
// trail, click rings and key flashes. Shared by the live dashboard and the
// session replay player.
//
// The live dashboard used to call reset() + advanceTo() every tick, replaying
// the whole capture from the first event each time. attach() now keeps the
// existing cursor state when the event array has only grown, so a tick costs
// only the events that actually arrived.
const TRAIL_MAX=60,RING_MAX=24;
window.InputStage=class{
  constructor(canvas){
    this.canvas=canvas;
    this.events=[];this.t0=0;
    this._clear(0);
  }
  _clear(t0){
    this.idx=0;this.x=0.5;this.y=0.5;
    this.trail=new Float32Array(TRAIL_MAX*2);this.trailN=0;this.trailHead=0;
    this.rings=[];this.keys=new Map();
    this.lastDrawnT=t0;
  }
  reset(events,t0){
    this.events=events;this.t0=t0;
    this._clear(t0);
  }
  // Point the stage at an event array that may be the same one as last time,
  // grown by a few hundred entries. Only a shrink or a swap forces a rewind.
  attach(events,t0){
    if(this.events!==events||events.length<this.idx||t0!==this.t0)this.reset(events,t0);
    else this.events=events;
  }
  seek(t){
    if(t<this.lastDrawnT||t<this.t0)this._clear(this.t0);
    this.advanceTo(t);
  }
  advanceTo(t){
    const ev=this.events;
    let i=this.idx;
    const n=ev.length;
    while(i<n&&ev[i].timestamp<=t){
      const e=ev[i++];
      const d=e.data;
      if(e.type==='mouse_move'){
        let x=this.x+(d.dx||0)*0.0006,y=this.y+(d.dy||0)*0.0006;
        this.x=x<0?0:x>1?1:x;
        this.y=y<0?0:y>1?1:y;
        const h=this.trailHead;
        this.trail[h*2]=this.x;this.trail[h*2+1]=this.y;
        this.trailHead=(h+1)%TRAIL_MAX;
        if(this.trailN<TRAIL_MAX)this.trailN++;
      }else if(e.type==='mouse_button'&&d.state==='down'){
        this.rings.push({x:this.x,y:this.y,t0:t,btn:d.button});
        if(this.rings.length>RING_MAX)this.rings.splice(0,this.rings.length-RING_MAX);
      }else if(e.device==='keyboard'&&e.type==='key_down'){
        this.keys.set(d.key,t);
      }
    }
    this.idx=i;
    this.lastDrawnT=t;
  }
  draw(){
    const c=this.canvas;
    if(!c)return;
    const w=c.clientWidth||600,h=c.clientHeight||240;
    const ratio=Math.min(2,window.devicePixelRatio||1);
    const bw=Math.round(w*ratio),bh=Math.round(h*ratio);
    if(c.width!==bw||c.height!==bh){c.width=bw;c.height=bh}
    const x=c.getContext('2d');x.setTransform(ratio,0,0,ratio,0,0);
    x.fillStyle='#0B0F1A';x.fillRect(0,0,w,h);
    // background grid — one path instead of a fillRect per dot
    x.fillStyle='#101a2e';
    x.beginPath();
    for(let gx=0;gx<w;gx+=40)for(let gy=0;gy<h;gy+=40)x.rect(gx,gy,1,1);
    x.fill();
    // click rings, batched per colour so the context switches twice, not 2N times
    for(let pass=0;pass<2;pass++){
      const btn=pass?'other':'left';
      x.strokeStyle=pass?'rgba(249,115,22,0.7)':'rgba(34,197,94,0.7)';
      x.lineWidth=1.5;x.beginPath();
      let any=false;
      for(const r of this.rings){
        if((r.btn==='left')!==(btn==='left'))continue;
        x.moveTo(r.x*w+7,r.y*h);
        x.arc(r.x*w,r.y*h,7,0,Math.PI*2);
        any=true;
      }
      if(any)x.stroke();
    }
    // trail
    if(this.trailN>1){
      x.strokeStyle='rgba(59,130,246,0.35)';x.lineWidth=1.4;x.beginPath();
      const start=(this.trailHead-this.trailN+TRAIL_MAX*2)%TRAIL_MAX;
      for(let k=0;k<this.trailN;k++){
        const i=(start+k)%TRAIL_MAX;
        const px=this.trail[i*2]*w,py=this.trail[i*2+1]*h;
        k?x.lineTo(px,py):x.moveTo(px,py);
      }
      x.stroke();
    }
    // cursor crosshair
    const cx=this.x*w,cy=this.y*h;
    x.strokeStyle='#3B82F6';x.lineWidth=1.6;
    x.beginPath();
    x.moveTo(cx-10,cy);x.lineTo(cx-3,cy);x.moveTo(cx+3,cy);x.lineTo(cx+10,cy);
    x.moveTo(cx,cy-10);x.lineTo(cx,cy-3);x.moveTo(cx,cy+3);x.lineTo(cx,cy+10);
    x.stroke();
    x.fillStyle='rgba(59,130,246,0.9)';x.fillRect(cx-1,cy-1,2,2);
    // key flashes
    x.font='10px Segoe UI';x.textAlign='left';
    let kx=10;const bottom=h-14;
    for(const [k,t] of this.keys){
      const age=this.lastDrawnT-t;
      if(age>1.2){this.keys.delete(k);continue}
      x.fillStyle=`rgba(168,85,247,${1-age/1.2})`;
      x.fillText(k,kx,bottom);
      kx+=x.measureText(k).width+8;
    }
  }
};
