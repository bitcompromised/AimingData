// stage.js — input replay stage: integrates mouse deltas into a cursor,
// draws trail, click rings and key flashes. Shared by the live dashboard and
// the session replay player.
window.InputStage=class{
  constructor(canvas){
    this.canvas=canvas;
    this.reset([],0);
  }
  reset(events,t0){
    this.events=events;this.t0=t0;
    this.idx=0;this.x=0.5;this.y=0.5;this.trail=[];this.rings=[];this.keys=new Map();this.lastDrawnT=t0;
  }
  seek(t){
    if(t<this.lastDrawnT||t<this.t0){this.idx=0;this.x=0.5;this.y=0.5;this.trail=[];this.rings=[];this.keys=new Map()}
    this.advanceTo(t);
  }
  advanceTo(t){
    const ev=this.events;
    while(this.idx<ev.length&&ev[this.idx].timestamp<=t){
      const e=ev[this.idx++];
      if(e.type==='mouse_move'){
        this.x+=(e.data.dx||0)*0.0006;this.y+=(e.data.dy||0)*0.0006;
        this.x=Math.min(1,Math.max(0,this.x));this.y=Math.min(1,Math.max(0,this.y));
        this.trail.push({x:this.x,y:this.y});if(this.trail.length>60)this.trail.shift();
      }else if(e.type==='mouse_button'&&e.data.state==='down'){
        this.rings.push({x:this.x,y:this.y,t0:t,btn:e.data.button});
        if(this.rings.length>24)this.rings.shift();
      }else if(e.device==='keyboard'&&e.type==='key_down'){
        this.keys.set(e.data.key,t);
      }
    }
    this.lastDrawnT=t;
  }
  draw(){
    const c=this.canvas;
    const w=c.clientWidth||600,h=c.clientHeight||240,ratio=devicePixelRatio||1;
    if(c.width!==w*ratio||c.height!==h*ratio){c.width=w*ratio;c.height=h*ratio}
    const x=c.getContext('2d');x.setTransform(ratio,0,0,ratio,0,0);
    x.fillStyle='#0B0F1A';x.fillRect(0,0,w,h);
    x.fillStyle='#101a2e';
    for(let gx=0;gx<w;gx+=40)for(let gy=0;gy<h;gy+=40)x.fillRect(gx,gy,1,1);
    // click rings
    for(const r of this.rings){
      x.strokeStyle=r.btn==='left'?'rgba(34,197,94,0.7)':'rgba(249,115,22,0.7)';
      x.lineWidth=1.5;x.beginPath();x.arc(r.x*w,r.y*h,7,0,7);x.stroke();
    }
    // trail
    x.strokeStyle='rgba(59,130,246,0.35)';x.lineWidth=1.4;x.beginPath();
    this.trail.forEach((p,i)=>i?x.lineTo(p.x*w,p.y*h):x.moveTo(p.x*w,p.y*h));
    x.stroke();
    // cursor crosshair
    const cx=this.x*w,cy=this.y*h;
    x.strokeStyle='#3B82F6';x.lineWidth=1.6;
    x.beginPath();x.moveTo(cx-10,cy);x.lineTo(cx-3,cy);x.moveTo(cx+3,cy);x.lineTo(cx+10,cy);
    x.moveTo(cx,cy-10);x.lineTo(cx,cy-3);x.moveTo(cx,cy+3);x.lineTo(cx,cy+10);x.stroke();
    x.fillStyle='rgba(59,130,246,0.9)';x.fillRect(cx-1,cy-1,2,2);
    // key flashes
    x.font='10px Segoe UI';x.textAlign='left';
    let kx=10;const bottom=h-14;
    for(const [k,t] of this.keys){
      const age=(this.lastDrawnT-t);
      if(age>1.2){this.keys.delete(k);continue}
      x.fillStyle=`rgba(168,85,247,${1-age/1.2})`;x.fillText(k,kx,bottom);kx+=x.measureText(k).width+8;
    }
  }
};
