// sessions.js — sessions browser + expanded session detail with replay player.
const Sess={
  view:'list',filter:'all',sel:null,stage:null,tl:null,raf:0,lastFrame:0,

  render(){
    return this.view==='list'?this.renderList():this.renderDetail();
  },

  renderList(){
    return header('Sessions','View and manage your VALORANT sessions and recorded rounds.',
      `<select id="sessFilter" class="pillsel"><option value="all">All time</option><option value="7">Last 7 days</option><option value="1">Today</option></select>
       <button class="primary" id="exportAll">⭳ Export All</button>`)
    +`<section class="panel"><table class="sess-table"><thead><tr>
        <th>Date / Time</th><th>Duration</th><th>Matches</th><th>Rounds</th><th>K / D</th><th>Status</th><th>Actions</th>
      </tr></thead><tbody id="sessRows"></tbody></table></section>
      <div class="grid2">
        <section class="panel"><div class="panel-head"><h2 id="sdTitle">Session Details</h2><span id="sdBadge"></span></div><div id="sdBox"><p class="empty">Select a session row.</p></div></section>
        <section class="panel"><div class="panel-head"><h2 id="sdRoundsTitle">Rounds</h2><button class="link" id="sdViewAll">View all →</button></div><div id="sdRounds" class="rounds"><p class="empty">Select a session row.</p></div></section>
      </div>`;
  },

  renderDetail(){
    const s=S.selected;if(!s)return this.renderList();
    const meta=`Valorant · ${s.mode||'—'} · ${s.map||'—'} · ${s.stats?.rounds??'—'} rounds · ${fmtDur(s.durationSeconds)}`;
    return `<div class="detail-head">
      <button class="back" id="backBtn">←</button>
      <div><h1>Session: ${fmtDate(s.createdAt)}</h1><p>${esc(meta)}</p></div>
      <div class="hdr-actions">${badge('Completed','green')}<button class="ghost" id="exportOne">⭳ Export</button></div>
    </div>
    <section class="panel player-panel">
      <div class="player-stage"><canvas id="playerStage"></canvas></div>
      <canvas id="timeline" style="width:100%;height:36px"></canvas>
      <div class="controls">
        <button class="primary round" id="playBtn">${S.play.playing?'❚❚':'▶'}</button>
        <span class="time" id="timeLabel">0:00 / 0:00</span>
        <input id="seek" type="range" min="0" max="1000" value="0">
        <select id="speedSel" class="pillsel">${[0.25,0.5,1,2,4,8,16].map(v=>`<option value="${v}" ${v===S.play.speed?'selected':''}>${v}x</option>`).join('')}</select>
        <button class="ghost" id="fsBtn">⛶</button>
      </div>
      <div class="legend">
        <span><i style="background:#3B82F6"></i>Round</span><span><i style="background:#22C55E"></i>Kill</span><span><i style="background:#EF4444"></i>Death</span><span><i style="background:#F97316"></i>Headshot</span>
        <em>colored timestamps on the navigation</em>
      </div>
    </section>
    <div class="grid2">
      ${panel('Mouse Movement (X / Y)',canvasEl('xy',220))}
      ${panel('Mouse Speed vs Time',canvasEl('dual',220)+'<p class="muted">Left axis: hardware counts/s. Right axis: translated °/s at current eDPI.</p>')}
      ${panel('Aim Analysis','<div id="aimFlicks"></div>')}
      ${panel('Keyboard',canvasEl('keys',200))}
      ${panel('Heatmap',canvasEl('heat',260))}
      ${panel('Aim Heatmap',canvasEl('aimheat',260)+'<p class="muted">speed-weighted cursor density + clicks</p>')}
      ${panel('Frequency Analysis',canvasEl('spec',200)+'<p class="muted" id="specNote"></p>')}
      ${panel('Input Overlay',canvasEl('overlay',200))}
      ${panel('Round Analysis','<div id="roundTable"></div>')}
    </div>`;
  },

  mount(){
    if(this.view==='list')this.mountList();else this.mountDetail();
  },

  mountList(){
    $('#sessFilter').value=this.filter;
    $('#sessFilter').onchange=e=>{this.filter=e.target.value;this.drawRows()};
    $('#exportAll').onclick=()=>downloadJSON(S.sessions,'mouse-stats-sessions.json');
    this.drawRows();
    const sel=this.sel?S.sessions.find(x=>x.sessionId===this.sel):S.sessions[0];
    if(sel)this.drawDetails(sel);
    $('#sdViewAll').onclick=()=>{if(this.sel)this.openDetail(this.sel)};
  },

  drawRows(){
    const rows=S.sessions.filter(s=>this.filter==='all'||(this.filter==='1'?new Date(s.createdAt).toDateString()===new Date().toDateString():Date.now()-new Date(s.createdAt).getTime()<7*864e5));
    $('#sessRows').innerHTML=rows.map(s=>`<tr data-sess="${s.sessionId}" class="${this.sel===s.sessionId?'sel':''}">
      <td><b>${new Date(s.createdAt).toLocaleString()}</b><small>${relDay(s.createdAt)}</small></td>
      <td>${fmtDur(s.durationSeconds)}</td>
      <td>${s.stats?.matches??'—'}</td><td>${s.stats?.rounds??'—'}</td>
      <td>${s.stats?(s.stats.kills??0)+' / '+(s.stats.deaths??0):'—'}</td>
      <td>${badge('Completed','green')}</td>
      <td><div class="actions"><button class="primary small" data-view="${s.sessionId}">View All</button>
        <button class="ghost small" data-menu="${s.sessionId}">⋯</button>
        <div class="menu hidden" data-menufor="${s.sessionId}"><button data-view="${s.sessionId}">View All</button><button data-export="${s.sessionId}">Export JSON</button><button data-del="${s.sessionId}" class="danger">Delete</button></div></div></td>
      </tr>`).join('')||'<tr><td colspan="7" class="empty">No saved sessions yet — start a capture or queue a VALORANT match.</td></tr>';
    $$('#sessRows tr[data-sess]').forEach(tr=>tr.onclick=e=>{if(e.target.closest('button'))return;this.sel=tr.dataset.sess;this.drawRows();const s=S.sessions.find(x=>x.sessionId===this.sel);if(s)this.drawDetails(s)});
    $$('#sessRows [data-view]').forEach(b=>b.onclick=()=>this.openDetail(b.dataset.view));
    $$('#sessRows [data-export]').forEach(b=>b.onclick=async()=>{const s=await api('/sessions/'+b.dataset.export);downloadJSON(s.session,'session-'+b.dataset.export.slice(0,8)+'.json')});
    $$('#sessRows [data-del]').forEach(b=>b.onclick=async()=>{if(!confirm('Delete this session permanently?'))return;await api('/sessions/'+b.dataset.del,{method:'DELETE'});if(this.sel===b.dataset.del)this.sel=null;await loadSessions();this.drawRows()});
    $$('#sessRows [data-menu]').forEach(b=>b.onclick=e=>{e.stopPropagation();const m=$(`[data-menufor="${b.dataset.menu}"]`);$$('.menu').forEach(x=>x!==m&&x.classList.add('hidden'));m.classList.toggle('hidden')});
  },

  async drawDetails(s){
    this.sel=s.sessionId;
    $('#sdTitle').textContent=`Session Details - ${fmtDate(s.createdAt)}`;
    $('#sdBadge').innerHTML=badge('Completed','green');
    let full=s;
    if(s.events===undefined||s.events===null){full=(await api('/sessions/'+s.sessionId)).session}
    const st=full.stats||{};
    const rounds=full.events?An.rounds(full.events,full.endTimestamp):[];
    $('#sdBox').innerHTML=`<div class="sd-grid">
      <div class="mapthumb ${esc((s.map||'unknown').toLowerCase().replace(/[^a-z0-9]/g,''))}">${esc((s.map||'?').slice(0,2).toUpperCase())}</div>
      <div class="kv"><span>Match ID</span><b>${esc(full.matchId||'local session')}</b></div>
      <div class="kv"><span>Game Mode</span><b>${esc(s.mode||'—')}</b></div>
      <div class="kv"><span>Map</span><b>${esc(s.map||'—')}</b></div>
      <div class="kv"><span>Total Rounds</span><b>${st.rounds??rounds.length??'—'}</b></div>
      <div class="kv"><span>Duration</span><b>${fmtDur(s.durationSeconds)}</b></div>
      <div class="kv"><span>Events</span><b>${s.eventCount??(full.events||[]).length}</b></div></div>
      <button class="primary" id="sdOpen">View All</button>`;
    $('#sdRounds').innerHTML=rounds.length?rounds.map(r=>roundRow(r)).join(''):'<p class="empty">No round markers in this session.</p>';
    $('#sdOpen').onclick=()=>this.openDetail(s.sessionId);
  },

  async openDetail(id){
    const s=(await api('/sessions/'+id)).session;
    S.selected=s;S.selEvents=s.events||[];
    S.play={playing:false,pos:0,speed:S.play.speed,raf:0};
    this.view='detail';render();
  },

  mountDetail(){
    const s=S.selected;const ev=S.selEvents;
    const t0=s.startTimestamp,t1=s.endTimestamp||t0+1;
    this.stage=new InputStage($('#playerStage'));
    this.stage.reset(ev,t0);this.stage.advanceTo(0);this.stage.draw();
    // timeline
    const tl=$('#timeline');
    const drawTl=()=>{
      const {x,w,h}=An.prep(tl);
      x.fillStyle='#0d1424';x.fillRect(0,0,w,h);
      const marks=An.gameTimeline(ev);
      for(const m of marks){const px=(m.t-t0)/(t1-t0)*w;x.fillStyle=m.color;x.fillRect(px-0.75,4,1.5,h-8)}
      const prog=(S.play.pos)/(t1-t0)*w;
      x.fillStyle='rgba(59,130,246,0.25)';x.fillRect(0,0,prog,h);
      x.fillStyle='#3B82F6';x.fillRect(prog-1,0,2,h);
      // colored timestamp labels under a few markers
      x.font='9px Segoe UI';x.textAlign='center';
      const step=Math.max(1,Math.floor(marks.length/10));
      marks.forEach((m,i)=>{if(i%step)return;const px=(m.t-t0)/(t1-t0)*w;x.fillStyle=m.color;x.fillText(An.fmtT(m.t-t0),Math.min(w-14,Math.max(14,px)),h-8)});
    };
    this.tl=drawTl;drawTl();
    $('#seek').oninput=e=>{S.play.pos=Number(e.target.value)/1000*(t1-t0);this.stage.seek(t0+S.play.pos);this.stage.draw();drawTl();updTime()};
    $('#playBtn').onclick=()=>{S.play.playing=!S.play.playing;$('#playBtn').textContent=S.play.playing?'❚❚':'▶';if(S.play.playing)this.loop();};
    $('#speedSel').onchange=e=>S.play.speed=Number(e.target.value);
    $('#fsBtn').onclick=()=>{const p=$('.player-panel');if(document.fullscreenElement)document.exitFullscreen();else p.requestFullscreen&&p.requestFullscreen()};
    $('#backBtn').onclick=()=>{cancelAnimationFrame(this.raf);S.play.playing=false;this.view='list';S.selected=null;render()};
    $('#exportOne').onclick=()=>downloadJSON(s,'session-'+s.sessionId.slice(0,8)+'.json');
    const updTime=()=>{$('#timeLabel').textContent=`${An.fmtT(S.play.pos)} / ${An.fmtT(t1-t0)}`;$('#seek').value=Math.min(1000,S.play.pos/(t1-t0)*1000)};
    this.updTime=updTime;updTime();
    this.loopFn=()=>{
      if(S.play.playing){
        const now=performance.now();
        const dt=Math.min(0.1,(now-(this.lastFrame||now))/1000);
        this.lastFrame=now;
        S.play.pos=Math.min(t1-t0,S.play.pos+dt*S.play.speed);
        this.stage.seek(t0+S.play.pos);this.stage.draw();drawTl();updTime();
        if(S.play.pos>=t1-t0){S.play.playing=false;$('#playBtn').textContent='▶'}
        else this.raf=requestAnimationFrame(this.loopFn);
      }
    };
    this.loop=()=>{this.lastFrame=performance.now();cancelAnimationFrame(this.raf);this.raf=requestAnimationFrame(this.loopFn)};
    // analysis panels
    const sens=S.settings?.sensitivity??0.5,dpi=S.settings?.dpi??800;
    const X=t=>An.fmtT(t-t0);
    const ge=An.gameTimeline(ev);const markers=ge.map(e=>({t:e.t,color:e.color}));
    const mv=An.moves(ev);const step=Math.max(1,Math.floor(mv.length/600));
    const xs=[],ys=[];for(let i=0;i<mv.length;i+=step){xs.push({x:mv[i].timestamp,y:mv[i].data.dx||0});ys.push({x:mv[i].timestamp,y:mv[i].data.dy||0})}
    const xy=$('[data-chart="xy"]');if(xy)An.lineChart(xy,{t0,t1,xFmt:X,series:[{name:'X',color:An.C.blue,points:xs},{name:'Y',color:An.C.purple,points:ys}]});
    const sig=An.speedSignal(ev);const nb=240;
    const binsC=An.binSignal(sig,t0,t1,nb,'max');const binsD=binsC.map(b=>({x:b.x,y:b.v*An.degPerCount(sens)}));
    const dual=$('[data-chart="dual"]');if(dual)An.lineChart(dual,{t0,t1,xFmt:X,rightAxis:true,yLeft:{max:An.niceMax(Math.max(1,...binsC.map(b=>b.v)))},yRight:{max:An.niceMax(Math.max(1,...binsD.map(b=>b.v)))},
      series:[{name:'Raw (counts/s)',color:An.C.blue,points:binsC.map(b=>({x:b.x,y:b.v}))},{name:'Translated (°/s)',color:An.C.purple,points:binsD,axis:'right'}]});
    const fl=An.detectFlicks(ev);
    const ft=$('#aimFlicks');
    if(ft)ft.innerHTML=fl.length?`<table class="mini"><thead><tr><th>Time</th><th>Peak c/s</th><th>Peak °/s</th><th>Angle</th><th>Dur</th><th>Micro</th><th>Correct</th><th>Flick-back</th></tr></thead><tbody>${fl.slice(-12).reverse().map(f=>`<tr><td>${An.fmtT(f.t0-t0)}</td><td>${Math.round(f.peak)}</td><td>${Math.round(f.peak*An.degPerCount(sens))}</td><td>${f.angleDeg}°</td><td>${f.durMs}ms</td><td>${f.micro}</td><td>${f.correctionMs}ms</td><td>${f.flickBack?`✓ ${f.flickBack.delayMs}ms`:f.flickBack===null?'—':'—'}</td></tr>`).join('')}</tbody></table><p class="muted">Yaw 0.022°/count: °/s = c/s × 0.022 × sens (${sens}); DPI (${dpi}) affects physical cm only, eDPI (${An.edpi(dpi,sens)}) affects in-game rotation. Micro = mid-flick direction reversals (micro-adjustments); Correct = correction time after peak.</p>`:'<p class="empty">No flick bursts detected.</p>';
    const counts={};for(const e of An.keyPresses(ev))counts[e.data.key]=(counts[e.data.key]||0)+1;
    const keys=$('[data-chart="keys"]');if(keys)An.bars(keys,{items:Object.entries(counts).sort((a,b)=>b[1]-a[1]).slice(0,8).map(([label,value])=>({label,value,color:An.C.purple}))});
    const heat=$('[data-chart="heat"]');if(heat)An.heatmap(heat,{grid:An.heatmapGrid(ev,96,48,false)});
    const aimh=$('[data-chart="aimheat"]');if(aimh)An.heatmap(aimh,{grid:An.heatmapGrid(ev,96,48,true)});
    const binsF=An.binSignal(sig,t0,t1,256,'mean');const mags=An.spectrum(binsF,48);
    const spec=$('[data-chart="spec"]');if(spec)An.spectrumChart(spec,{mags});
    const note=$('#specNote');if(note){const dom=mags.slice().sort((a,b)=>b.mag-a.mag)[0];note.textContent=dom&&dom.mag>1?`Dominant component ≈ ${(dom.freq*((t1-t0)/256)).toFixed(1)} Hz`:'Not enough motion.'}
    const ov=$('[data-chart="overlay"]');if(ov)An.tickStrip(ov,{t0,t1,xFmt:X,lanes:[
      {name:'Mouse Move',color:An.C.blue,ticks:mv.map(e=>e.timestamp)},
      {name:'Left Click',color:An.C.green,ticks:ev.filter(e=>e.type==='mouse_button'&&e.data.state==='down'&&e.data.button==='left').map(e=>e.timestamp)},
      {name:'Right Click',color:An.C.orange,ticks:ev.filter(e=>e.type==='mouse_button'&&e.data.state==='down'&&e.data.button==='right').map(e=>e.timestamp)},
      {name:'Key Press',color:An.C.purple,ticks:An.keyPresses(ev).map(e=>e.timestamp)}]});
    const rounds=An.rounds(ev,t1);
    const rt=$('#roundTable');
    if(rt)rt.innerHTML=rounds.length?`<table class="mini"><thead><tr><th>Round</th><th>Start</th><th>Duration</th><th>Kills</th><th>Deaths</th><th>HS</th><th>Distance</th></tr></thead><tbody>
      ${rounds.map(r=>`<tr><td><b>${r.n}</b></td><td>${An.fmtT(r.t0-t0)}</td><td>${fmtDur((r.t1||t1)-r.t0)}</td><td>${r.kills}</td><td>${r.deaths}</td><td>${r.headshots}</td><td>${An.fmtNum(r.distance)}</td></tr>`).join('')}</tbody></table>`:'<p class="empty">No VALORANT round markers in this session.</p>';
  },

  tick(){/* static page; replay loop drives updates */}
};

function relDay(iso){const d=new Date(iso);const t=new Date();const dd=Math.floor((t-d)/864e5);if(dd===0)return 'Today';if(dd===1)return 'Yesterday';return `${dd} days ago`}
function downloadJSON(obj,name){const b=new Blob([JSON.stringify(obj,null,2)],{type:'application/json'});const a=document.createElement('a');a.href=URL.createObjectURL(b);a.download=name;a.click();URL.revokeObjectURL(a.href)}
