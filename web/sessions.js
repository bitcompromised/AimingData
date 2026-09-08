// sessions.js — sessions browser + expanded session detail with replay player.
//
// The list and the side panel run entirely off session metadata (each session's
// `digest`, computed once by the core). Raw events are downloaded only when a
// session is actually opened for replay, and then analysed in a single pass
// instead of a dozen full-history scans, one per panel.
const Sess={
  view:'list',filter:'all',sel:null,stage:null,tl:null,raf:0,lastFrame:0,an:null,

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
    $('#exportAll').onclick=async()=>{
      // metadata only — exporting every session's raw events would be hundreds of MB
      const btn=$('#exportAll');btn.disabled=true;
      try{downloadJSON(S.sessions,'mouse-stats-sessions.json')}finally{btn.disabled=false}
    };
    this.drawRows();
    const sel=this.sel?S.sessions.find(x=>x.sessionId===this.sel):S.sessions[0];
    if(sel)this.drawDetails(sel);
    $('#sdViewAll').onclick=()=>{if(this.sel)this.openDetail(this.sel)};
  },

  drawRows(){
    const rows=S.sessions.filter(s=>this.filter==='all'||(this.filter==='1'?new Date(s.createdAt).toDateString()===new Date().toDateString():Date.now()-new Date(s.createdAt).getTime()<7*864e5));
    setHTML($('#sessRows'),rows.map(s=>`<tr data-sess="${s.sessionId}" class="${this.sel===s.sessionId?'sel':''}">
      <td><b>${new Date(s.createdAt).toLocaleString()}</b><small>${relDay(s.createdAt)}</small></td>
      <td>${fmtDur(s.durationSeconds)}</td>
      <td>${s.stats?.matches??'—'}</td><td>${s.stats?.rounds??s.digest?.rounds??'—'}</td>
      <td>${s.stats?(s.stats.kills??0)+' / '+(s.stats.deaths??0):'—'}</td>
      <td>${badge('Completed','green')}</td>
      <td><div class="actions"><button class="primary small" data-view="${s.sessionId}">View All</button>
        <button class="ghost small" data-menu="${s.sessionId}">⋯</button>
        <div class="menu hidden" data-menufor="${s.sessionId}"><button data-view="${s.sessionId}">View All</button><button data-export="${s.sessionId}">Export JSON</button><button data-del="${s.sessionId}" class="danger">Delete</button></div></div></td>
      </tr>`).join('')||'<tr><td colspan="7" class="empty">No saved sessions yet — start a capture or queue a VALORANT match.</td></tr>');
    $$('#sessRows tr[data-sess]').forEach(tr=>tr.onclick=e=>{if(e.target.closest('button'))return;this.sel=tr.dataset.sess;this.drawRows();const s=S.sessions.find(x=>x.sessionId===this.sel);if(s)this.drawDetails(s)});
    $$('#sessRows [data-view]').forEach(b=>b.onclick=()=>this.openDetail(b.dataset.view));
    $$('#sessRows [data-export]').forEach(b=>b.onclick=async()=>{b.disabled=true;try{const s=await api('/sessions/'+b.dataset.export);downloadJSON(s.session,'session-'+b.dataset.export.slice(0,8)+'.json')}finally{b.disabled=false}});
    $$('#sessRows [data-del]').forEach(b=>b.onclick=async()=>{if(!confirm('Delete this session permanently?'))return;await api('/sessions/'+b.dataset.del,{method:'DELETE'});if(this.sel===b.dataset.del)this.sel=null;if(S.latest?.sessionId===b.dataset.del)S.latest=null;await loadSessions();this.drawRows()});
    $$('#sessRows [data-menu]').forEach(b=>b.onclick=e=>{e.stopPropagation();const m=$(`[data-menufor="${b.dataset.menu}"]`);$$('.menu').forEach(x=>x!==m&&x.classList.add('hidden'));m.classList.toggle('hidden')});
  },

  // Side panel: metadata only, no raw-event fetch.
  drawDetails(s){
    this.sel=s.sessionId;
    const d=s.digest||{};
    setText($('#sdTitle'),`Session Details - ${fmtDate(s.createdAt)}`);
    setHTML($('#sdBadge'),badge('Completed','green'));
    const st=s.stats||{};
    setHTML($('#sdBox'),`<div class="sd-grid">
      <div class="mapthumb ${esc((s.map||'unknown').toLowerCase().replace(/[^a-z0-9]/g,''))}">${esc((s.map||'?').slice(0,2).toUpperCase())}</div>
      <div class="kv"><span>Match ID</span><b>${esc(s.matchId||'local session')}</b></div>
      <div class="kv"><span>Game Mode</span><b>${esc(s.mode||'—')}</b></div>
      <div class="kv"><span>Map</span><b>${esc(s.map||'—')}</b></div>
      <div class="kv"><span>Total Rounds</span><b>${st.rounds??d.rounds??'—'}</b></div>
      <div class="kv"><span>Duration</span><b>${fmtDur(s.durationSeconds)}</b></div>
      <div class="kv"><span>Events</span><b>${(s.eventCount??d.events??0).toLocaleString()}</b></div></div>
      <button class="primary" id="sdOpen">View All</button>`);
    const rounds=d.roundList||[];
    setHTML($('#sdRounds'),rounds.length?rounds.map(roundRow).join(''):'<p class="empty">No round markers in this session.</p>');
    $('#sdOpen').onclick=()=>this.openDetail(s.sessionId);
  },

  async openDetail(id){
    const row=$(`#sessRows [data-view="${id}"]`);
    if(row){row.disabled=true;row.textContent='Loading…'}
    try{
      const s=(await api('/sessions/'+id)).session;
      S.selected=s;S.selEvents=s.events||[];
      // One pass over the session feeds every panel below.
      this.an=new An.Analyzer({ringCap:Math.max(1024,S.selEvents.length)}).feed(S.selEvents).finalize();
      S.play={playing:false,pos:0,speed:S.play.speed,raf:0};
      this.view='detail';render();
    }catch(e){
      console.error('[session]',e);
      if(row){row.disabled=false;row.textContent='View All'}
      alert('Could not load that session: '+e.message);
    }
  },

  mountDetail(){
    const s=S.selected,ev=S.selEvents,a=this.an;
    const t0=s.startTimestamp,t1=s.endTimestamp||t0+1;
    this.stage=new InputStage($('#playerStage'));
    this.stage.reset(ev,t0);this.stage.advanceTo(0);this.stage.draw();

    // ---- timeline scrubber --------------------------------------------------
    // The marker set never changes, so cache it instead of rebuilding it on
    // every animation frame of playback.
    const marks=a.timeline;
    const tl=$('#timeline');
    const drawTl=()=>{
      const {x,w,h}=An.prep(tl);
      x.fillStyle='#0d1424';x.fillRect(0,0,w,h);
      for(const m of marks){const px=(m.t-t0)/(t1-t0)*w;x.fillStyle=m.color;x.fillRect(px-0.75,4,1.5,h-8)}
      const prog=S.play.pos/(t1-t0)*w;
      x.fillStyle='rgba(59,130,246,0.25)';x.fillRect(0,0,prog,h);
      x.fillStyle='#3B82F6';x.fillRect(prog-1,0,2,h);
      x.font='9px Segoe UI';x.textAlign='center';
      const step=Math.max(1,Math.floor(marks.length/10));
      for(let i=0;i<marks.length;i+=step){
        const m=marks[i],px=(m.t-t0)/(t1-t0)*w;
        x.fillStyle=m.color;x.fillText(An.fmtT(m.t-t0),Math.min(w-14,Math.max(14,px)),h-8);
      }
    };
    this.tl=drawTl;drawTl();

    const updTime=()=>{setText($('#timeLabel'),`${An.fmtT(S.play.pos)} / ${An.fmtT(t1-t0)}`);$('#seek').value=Math.min(1000,S.play.pos/(t1-t0)*1000)};
    this.updTime=updTime;updTime();

    $('#seek').oninput=e=>{S.play.pos=Number(e.target.value)/1000*(t1-t0);this.stage.seek(t0+S.play.pos);this.stage.draw();drawTl();updTime()};
    $('#playBtn').onclick=()=>{S.play.playing=!S.play.playing;$('#playBtn').textContent=S.play.playing?'❚❚':'▶';if(S.play.playing)this.loop()};
    $('#speedSel').onchange=e=>S.play.speed=Number(e.target.value);
    $('#fsBtn').onclick=()=>{const p=$('.player-panel');if(document.fullscreenElement)document.exitFullscreen();else p.requestFullscreen&&p.requestFullscreen()};
    $('#backBtn').onclick=()=>{cancelAnimationFrame(this.raf);S.play.playing=false;this.view='list';S.selected=null;S.selEvents=[];this.an=null;render()};
    $('#exportOne').onclick=()=>downloadJSON(s,'session-'+s.sessionId.slice(0,8)+'.json');

    this.loopFn=()=>{
      if(!S.play.playing)return;
      const now=performance.now();
      const dt=Math.min(0.1,(now-(this.lastFrame||now))/1000);
      this.lastFrame=now;
      S.play.pos=Math.min(t1-t0,S.play.pos+dt*S.play.speed);
      this.stage.seek(t0+S.play.pos);this.stage.draw();drawTl();updTime();
      if(S.play.pos>=t1-t0){S.play.playing=false;$('#playBtn').textContent='▶'}
      else this.raf=requestAnimationFrame(this.loopFn);
    };
    this.loop=()=>{this.lastFrame=performance.now();cancelAnimationFrame(this.raf);this.raf=requestAnimationFrame(this.loopFn)};

    // ---- analysis panels, all off the single analyzer pass ------------------
    const sens=S.settings?.sensitivity??0.5,dpi=S.settings?.dpi??800;
    const deg=An.degPerCount(sens);
    const X=t=>An.fmtT(t-t0);

    const {xs,ys}=a.moveSeries(t0,600);
    const xy=$('[data-chart="xy"]');
    if(xy)An.schedule('d-xy',()=>An.lineChart(xy,{t0,t1,xFmt:X,series:[{name:'X',color:An.C.blue,points:xs},{name:'Y',color:An.C.purple,points:ys}]}));

    const binsC=a.speedBins(t0,t1,240,'max');
    let cmax=1;for(const b of binsC)if(b.v>cmax)cmax=b.v;
    const dual=$('[data-chart="dual"]');
    if(dual)An.schedule('d-dual',()=>An.lineChart(dual,{t0,t1,xFmt:X,rightAxis:true,
      yLeft:{max:An.niceMax(cmax)},yRight:{max:An.niceMax(cmax*deg)},
      series:[{name:'Raw (counts/s)',color:An.C.blue,points:binsC.map(b=>({x:b.t,y:b.v}))},
              {name:'Translated (°/s)',color:An.C.purple,points:binsC.map(b=>({x:b.t,y:b.v*deg})),axis:'right'}]}));

    const fl=a.flicks;
    setHTML($('#aimFlicks'),fl.length?`<table class="mini"><thead><tr><th>Time</th><th>Peak c/s</th><th>Peak °/s</th><th>Angle</th><th>Dur</th><th>Micro</th><th>Correct</th><th>Flick-back</th></tr></thead><tbody>${fl.slice(-12).reverse().map(f=>`<tr><td>${An.fmtT(f.t0-t0)}</td><td>${Math.round(f.peak)}</td><td>${Math.round(f.peak*deg)}</td><td>${f.angleDeg}°</td><td>${f.durMs.toFixed(0)}ms</td><td>${f.micro}</td><td>${f.correctionMs}ms</td><td>${f.flickBack?`✓ ${f.flickBack.delayMs}ms`:'—'}</td></tr>`).join('')}</tbody></table><p class="muted">Yaw 0.022°/count: °/s = c/s × 0.022 × sens (${sens}); DPI (${dpi}) affects physical cm only, eDPI (${An.edpi(dpi,sens)}) affects in-game rotation. Micro = mid-flick direction reversals (micro-adjustments); Correct = correction time after peak. ${fl.length} flicks total.</p>`:'<p class="empty">No flick bursts detected.</p>');

    const keys=$('[data-chart="keys"]');
    if(keys){const items=a.topKeys(8).map(i=>({...i,color:An.C.purple}));An.schedule('d-keys',()=>An.bars(keys,{items}))}

    const heat=$('[data-chart="heat"]');
    if(heat)An.schedule('d-heat',()=>An.heatmap(heat,{grid:a.heatFlat,max:a.heatFlatMax}));
    const aimh=$('[data-chart="aimheat"]');
    if(aimh)An.schedule('d-aimheat',()=>An.heatmap(aimh,{grid:a.heat,max:a.heatMax}));

    const mags=An.spectrum(a.speedBins(t0,t1,256,'mean'),48);
    const spec=$('[data-chart="spec"]');
    if(spec)An.schedule('d-spec',()=>An.spectrumChart(spec,{mags}));
    let dom=null;for(const m of mags)if(!dom||m.mag>dom.mag)dom=m;
    setText($('#specNote'),dom&&dom.mag>1?`Dominant component ≈ ${(dom.freq*((t1-t0)/256)).toFixed(1)} Hz`:'Not enough motion.');

    const ov=$('[data-chart="overlay"]');
    if(ov){
      const lanes=[
        {name:'Mouse Move',color:An.C.blue,ticks:a.moveTicks(t0)},
        {name:'Left Click',color:An.C.green,ticks:a.clickLeft},
        {name:'Right Click',color:An.C.orange,ticks:a.clickRight},
        {name:'Key Press',color:An.C.purple,ticks:a.keyTicks(t0)}];
      An.schedule('d-overlay',()=>An.tickStrip(ov,{t0,t1,xFmt:X,lanes}));
    }

    const rounds=a.roundsAt(t1);
    setHTML($('#roundTable'),rounds.length?`<table class="mini"><thead><tr><th>Round</th><th>Start</th><th>Duration</th><th>Kills</th><th>Deaths</th><th>HS</th><th>Distance</th><th>Avg speed</th></tr></thead><tbody>
      ${rounds.map(r=>{const rs=a.roundStats(r);return `<tr><td><b>${r.n}</b></td><td>${An.fmtT(r.t0-t0)}</td><td>${fmtDur((r.t1||t1)-r.t0)}</td><td>${r.kills}</td><td>${r.deaths}</td><td>${r.headshots}</td><td>${An.fmtNum(r.distance)}</td><td>${Math.round(rs.avg)} c/s</td></tr>`}).join('')}</tbody></table>`:'<p class="empty">No VALORANT round markers in this session.</p>');
  },

  tick(){/* static page; replay loop drives updates */}
};

function relDay(iso){const d=new Date(iso);const t=new Date();const dd=Math.floor((t-d)/864e5);if(dd===0)return 'Today';if(dd===1)return 'Yesterday';return `${dd} days ago`}
function downloadJSON(obj,name){const b=new Blob([JSON.stringify(obj)],{type:'application/json'});const a=document.createElement('a');a.href=URL.createObjectURL(b);a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(a.href),1000)}
