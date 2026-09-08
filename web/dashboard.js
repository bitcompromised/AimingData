// dashboard.js — live analytics dashboard.
//
// The tick used to re-derive everything from the full event history at 2Hz —
// several complete flick-detection passes, a full stage replay and a handful of
// innerHTML rebuilds per second. It now keeps one incremental Analyzer per data
// source, so a tick costs only the events that arrived since the last one, and
// charts redraw on a slower cadence than the counters.
const CHART_MS=1000;      // heavy charts redraw at most this often
const LIVE_WINDOW=60;     // seconds of history shown by the live charts

const Dash={
  tab:'movement',rtab:'details',statTab:'overview',scope:'all',stage:null,built:false,
  an:null,anKey:null,lastRev:-1,lastChart:0,statsRev:-1,

  ctx(){
    if(S.active&&S.health?.collector){
      return {live:true,key:'live:'+S.active.sessionId,sessionId:S.active.sessionId,events:S.live.events,
        t0:S.active.startTimestamp,t1:S.health.collector.nowMonotonic,
        title:`Session: ${fmtDate(S.active.createdAt)}`,
        meta:`Valorant · ${S.active.mode||'—'} · ${S.active.map||'Pending'} · R${S.game?.round??'—'} · live`,
        mode:S.active.mode,map:S.active.map,matchId:S.active.matchId,createdAt:S.active.createdAt};
    }
    const s=S.latest,meta=S.sessions[0];
    if(s&&meta){
      return {live:false,key:'saved:'+s.sessionId,sessionId:s.sessionId,events:s.events||[],
        t0:s.startTimestamp,t1:s.endTimestamp||s.startTimestamp+1,
        title:`Session: ${fmtDate(s.createdAt)}`,
        meta:`Valorant · ${s.mode||'—'} · ${s.map||'—'} · ${meta.digest?.rounds??0} rounds · ${fmtDur(s.durationSeconds)}`,
        mode:s.mode,map:s.map,matchId:s.matchId,createdAt:s.createdAt};
    }
    return {live:false,key:'none',sessionId:null,events:[],t0:0,t1:1,title:'No session yet',meta:'Waiting for capture…',mode:'—',map:'—',matchId:null};
  },

  // One analyzer per data source, fed only the events it has not seen.
  analyzer(c){
    if(this.anKey!==c.key){this.an=new An.Analyzer();this.anKey=c.key}
    this.an.feed(c.events);
    if(!c.live)this.an.finalize();
    return this.an;
  },

  render(){
    const c=this.ctx();const live=!!S.active;
    const indicator=live
      ?`<span class="cap live"><i class="pulse"></i>Capturing · <b id="capElapsed">0:00</b></span><button class="ghost" id="btnStopCap">■ Stop</button>`
      :`<span class="cap idle"><i class="dotoff"></i>Idle</span><button class="primary" id="btnStartCap">● Start Capture</button>`;
    return header(c.title,c.meta,indicator)
    +`<section class="kpi5">
      ${kpi('K/D','kd','—','—','target',An.C.blue)}
      ${kpi('Headshot %','hs','—','—','aim',An.C.purple)}
      ${kpi('Flick Latency','flt','—','—','react',An.C.teal)}
      ${kpi('Avg Mouse Speed','spd','—','—','mouse',An.C.purple)}
      ${kpi('Keys Pressed','keys','—','—','keys',An.C.violet)}
    </section>
    <div class="dash-mid">
      <section class="panel stage-panel">
        <div class="panel-head"><h2>${live?'Live Input Stage':'Input Stage'}</h2><span class="muted">${live?'1:1 realtime':''}</span></div>
        <div class="chart-wrap" style="height:320px"><canvas id="stageCanvas"></canvas></div>
      </section>
      <section class="panel">
        <div class="tabs">
          <button class="tab ${this.rtab==='details'?'active':''}" data-rtab="details">Round Details</button>
          <button class="tab ${this.rtab==='events'?'active':''}" data-rtab="events">Key Events</button>
        </div>
        <div id="roundDetailsBox"></div>
      </section>
      <section class="panel">
        <div class="panel-head"><h2>Rounds</h2><span class="muted" id="roundsCount"></span></div>
        <div id="roundsList" class="rounds"></div>
      </section>
      <section class="panel">
        <div class="panel-head"><h2>Round Analysis</h2></div>
        <div id="roundAnalysis"></div>
      </section>
    </div>
    <section class="panel">
      <div class="tabs">
        ${[['movement','Mouse Movement'],['aim','Aim Analysis'],['keyboard','Keyboard'],['heatmap','Heatmap'],['freq','Frequency Analysis']].map(t=>`<button class="tab ${this.tab===t[0]?'active':''}" data-tab="${t[0]}">${t[1]}</button>`).join('')}
      </div>
      <div class="tabpane ${this.tab==='movement'?'':'hidden'}" data-pane="movement">${canvasEl('xy',240)}</div>
      <div class="tabpane ${this.tab==='aim'?'':'hidden'}" data-pane="aim">${canvasEl('dual',220)}<div id="flickTable"></div></div>
      <div class="tabpane ${this.tab==='keyboard'?'':'hidden'}" data-pane="keyboard"><div class="grid2">${canvasEl('keys',200)}${canvasEl('keyticks',200)}</div></div>
      <div class="tabpane ${this.tab==='heatmap'?'':'hidden'}" data-pane="heatmap">${canvasEl('heat',280)}</div>
      <div class="tabpane ${this.tab==='freq'?'':'hidden'}" data-pane="freq">${canvasEl('spec',220)}<p class="muted" id="freqNote"></p></div>
    </section>
    <section class="panel">
      <div class="panel-head"><h2>Statistics</h2>
        <div class="scope"><label>Scope</label><select id="statScope"><option value="all">All sessions</option><option value="session">This session</option></select></div>
      </div>
      <div class="tabs">
        ${[['overview','Overview'],['saim','Aim Analysis'],['smovement','Movement Analysis'],['sinput','Input Analysis'],['sweapon','Weapon Analysis']].map(t=>`<button class="tab ${this.statTab===t[0]?'active':''}" data-stattab="${t[0]}">${t[1]}</button>`).join('')}
      </div>
      <div id="statBox"></div>
    </section>`;
  },

  mount(){
    this.stage=new InputStage($('#stageCanvas'));
    this.lastRev=-1;this.lastChart=0;this.statsRev=-1;
    $$('[data-tab]').forEach(b=>b.onclick=()=>{this.tab=b.dataset.tab;$$('[data-tab]').forEach(x=>x.classList.toggle('active',x===b));$$('.tabpane[data-pane]').forEach(p=>p.classList.toggle('hidden',p.dataset.pane!==this.tab));this.lastChart=0;this.drawAnalytics()});
    $$('[data-rtab]').forEach(b=>b.onclick=()=>{this.rtab=b.dataset.rtab;$$('[data-rtab]').forEach(x=>x.classList.toggle('active',x===b));this.lastRev=-1;this.tick()});
    $$('[data-stattab]').forEach(b=>b.onclick=()=>{this.statTab=b.dataset.stattab;$$('[data-stattab]').forEach(x=>x.classList.toggle('active',x===b));this.statsRev=-1;this.drawStats()});
    $('#statScope').value=this.scope;
    $('#statScope').onchange=e=>{this.scope=e.target.value;this.statsRev=-1;this.drawStats()};
    $('#btnStopCap')?.addEventListener('click',async()=>{await api('/sessions/stop',{method:'POST'});S.live={events:[],lastT:0,sessionId:null};S.latest=null;S.rev++;render()});
    $('#btnStartCap')?.addEventListener('click',async()=>{
      await api('/sessions/start',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({game:'VALORANT',mode:'Competitive',map:'Unknown',settings:{dpi:S.settings?.dpi,sensitivity:S.settings?.sensitivity,pollingRate:S.settings?.pollingRate,resolution:S.settings?.resolution}})});
      render();
    });
    this.built=true;
    this.tick();
    this.drawStats();
  },

  // --- per-tick updates (never rebuilds the page shell) ----------------------
  tick(){
    // A poll cycle can land between renders, before mount() has built the page.
    if(!this.stage||!document.getElementById('stageCanvas'))return;
    const c=this.ctx();
    if(!c.sessionId)return;
    // Elapsed time moves every tick even when no events arrived.
    setText($('#capElapsed'),An.fmtT(c.t1-c.t0));
    // Everything else is derived from event data; skip it when nothing changed.
    if(S.rev===this.lastRev&&this.anKey===c.key)return;
    const rev=S.rev;

    const a=this.analyzer(c);
    const sum=a.summary();
    setKpi('kd',sum.deaths||sum.kills?sum.kd.toFixed(2):'—',`${sum.kills} / ${sum.deaths}`);
    setKpi('hs',sum.kills?sum.hsPct.toFixed(1)+'%':'—',`${sum.hs} HS of ${sum.kills} kills`);
    setKpi('flt',sum.flickLatency?`${sum.flickLatency.median} ms`:'—',sum.flickLatency?`min ${sum.flickLatency.min} · max ${sum.flickLatency.max}`:`${sum.flicks} flicks detected`);
    setKpi('spd',`${Math.round(sum.avg)} c/s`,`σ ${Math.round(sum.sd)} · peak ${An.fmtNum(sum.peak)}`);
    setKpi('keys',sum.keys.toLocaleString(),`${c.t1>c.t0?(sum.keys/(c.t1-c.t0)).toFixed(1):0}/s`);

    // stage — attach() keeps the integrated cursor across ticks
    this.stage.attach(c.events,c.t0);
    this.stage.advanceTo(c.t1);
    An.schedule('stage',()=>this.stage.draw());

    const rounds=a.roundsAt(c.t1);
    setText($('#roundsCount'),rounds.length?`${rounds.length} rounds`:'');
    setHTML($('#roundsList'),rounds.length?rounds.slice().reverse().map(roundRow).join(''):'<p class="empty">No rounds yet — waiting for VALORANT.</p>');

    const last=rounds[rounds.length-1];
    const box=$('#roundDetailsBox');
    if(box){
      if(this.rtab==='details'){
        setHTML(box,last?`<div class="round-head"><h3>Round ${last.n}</h3>${badge(last.kills>=last.deaths&&last.kills>0?'Ahead':'—',last.kills>=last.deaths&&last.kills>0?'green':'gray')}</div>
          <div class="kv"><span>Start</span><b>${An.fmtT(last.t0-c.t0)}</b></div>
          <div class="kv"><span>Duration</span><b>${fmtDur(c.live?(c.t1-last.t0):(last.t1-last.t0))}</b></div>
          <div class="kv"><span>Kills / Deaths</span><b>${last.kills} / ${last.deaths}</b></div>
          <div class="kv"><span>Distance</span><b>${An.fmtNum(last.distance)} counts</b></div>
          <div class="kv"><span>Headshots</span><b>${last.headshots}</b></div>`:'<p class="empty">No round data — VALORANT log not detected yet.</p>');
      }else{
        const tl=a.timeline.slice(-12).reverse();
        setHTML(box,tl.length?`<div class="vtimeline">${tl.map(e=>`<div class="vevent"><i style="background:${e.color}"></i><span>${An.fmtT(e.t-c.t0)}</span><b>${esc(e.label)}</b></div>`).join('')}</div>`:'<p class="empty">No game events yet.</p>');
      }
    }

    // round analysis (right rail) — O(1) rollup, no per-round re-analysis
    const ra=$('#roundAnalysis');
    if(ra){
      const rs=a.roundStats(last);
      const eff=rs?rs.efficiency:0;
      setHTML(ra,`<div class="ra-grid"><canvas id="raDonut" width="140" height="110"></canvas>
        <div class="kv"><span>Headshots</span><b>${last?last.headshots:0}</b></div>
        <div class="kv"><span>Kills / Deaths</span><b>${last?`${last.kills} / ${last.deaths}`:'—'}</b></div>
        <div class="kv"><span>Avg Speed</span><b>${rs?Math.round(rs.avg)+' c/s':'—'}</b></div>
        <div class="kv"><span>Distance</span><b>${rs?An.fmtNum(rs.dist):'—'}</b></div>
        <div class="kv"><span>Flicks</span><b>${rs?rs.flicks:'—'}</b></div></div>`);
      const dc=$('#raDonut');
      if(dc)An.schedule('raDonut',()=>An.donut(dc,{value:Math.min(1,eff),center:rs&&rs.flicks?Math.round(eff*100)+'%':'—',label:'Flick efficiency',color:An.C.green}));
    }

    // Charts are the expensive half; run them on their own, slower cadence.
    const now=performance.now();
    if(now-this.lastChart>=CHART_MS){this.lastChart=now;this.drawAnalytics(a,c)}
    this.lastRev=rev;
  },

  drawAnalytics(a,c){
    c=c||this.ctx();
    a=a||this.analyzer(c);
    const sens=S.settings?.sensitivity??0.5,dpi=S.settings?.dpi??800;
    const win=c.live?[Math.max(c.t0,c.t1-LIVE_WINDOW),c.t1]:[c.t0,c.t1];
    const X=t=>An.fmtT(t-c.t0);

    if(this.tab==='movement'){
      const cv=$('[data-chart="xy"]');if(!cv)return;
      const {xs,ys}=a.moveSeries(win[0],600);
      An.schedule('xy',()=>An.lineChart(cv,{t0:win[0],t1:win[1],xFmt:X,series:[
        {name:'X (horizontal)',color:An.C.blue,points:xs},
        {name:'Y (vertical)',color:An.C.purple,points:ys}]}));
      return;
    }
    if(this.tab==='aim'){
      const cv=$('[data-chart="dual"]');if(!cv)return;
      const binsC=a.speedBins(win[0],win[1],160,'max');
      const deg=An.degPerCount(sens);
      let cmax=1;for(const b of binsC)if(b.v>cmax)cmax=b.v;
      An.schedule('dual',()=>An.lineChart(cv,{t0:win[0],t1:win[1],xFmt:X,rightAxis:true,
        yLeft:{max:An.niceMax(cmax)},yRight:{max:An.niceMax(cmax*deg)},
        series:[{name:'Raw speed (counts/s)',color:An.C.blue,points:binsC.map(b=>({x:b.t,y:b.v}))},
                {name:`Translated (${An.edpi(dpi,sens)} eDPI → °/s)`,color:An.C.purple,points:binsC.map(b=>({x:b.t,y:b.v*deg})),axis:'right'}]}));
      const fl=a.flicks.slice(-8).reverse();
      setHTML($('#flickTable'),fl.length?`<table class="mini"><thead><tr><th>Time</th><th>Peak (c/s)</th><th>Peak (°/s)</th><th>Angle</th><th>Dur</th><th>Micro</th><th>Correct</th><th>Flick-back</th></tr></thead><tbody>
        ${fl.map(f=>`<tr><td>${An.fmtT(f.t0-c.t0)}</td><td>${Math.round(f.peak)}</td><td>${Math.round(f.peak*deg)}</td><td>${f.angleDeg}°</td><td>${f.durMs.toFixed(0)}ms</td><td>${f.micro}</td><td>${f.correctionMs}ms</td><td>${f.flickBack?`✓ ${f.flickBack.delayMs}ms`:'—'}</td></tr>`).join('')}</tbody></table>
        <p class="muted">Translation uses yaw 0.022°/count: deg/s = counts/s × 0.022 × sens (${sens}) — DPI (${dpi}) scales physical distance, eDPI (${An.edpi(dpi,sens)}) scales in-game rotation. Left axis is hardware counts/s; right axis is the in-game speed it produces.</p>`:'<p class="muted">No flicks detected yet in this window.</p>');
      return;
    }
    if(this.tab==='keyboard'){
      const kv=$('[data-chart="keys"]'),kt=$('[data-chart="keyticks"]');
      const items=a.topKeys(8).map(i=>({...i,color:An.C.purple}));
      if(kv)An.schedule('keys',()=>An.bars(kv,{items}));
      if(kt){const ticks=a.keyTicks(win[0]);An.schedule('keyticks',()=>An.tickStrip(kt,{t0:win[0],t1:win[1],xFmt:X,lanes:[{name:'Key Press',color:An.C.purple,ticks}]}))}
      return;
    }
    if(this.tab==='heatmap'){
      const cv=$('[data-chart="heat"]');if(!cv)return;
      An.schedule('heat',()=>An.heatmap(cv,{grid:a.heat,max:a.heatMax}));
      return;
    }
    if(this.tab==='freq'){
      const cv=$('[data-chart="spec"]');if(!cv)return;
      const bins=a.speedBins(win[0],win[1],256,'mean');
      const mags=An.spectrum(bins,48);
      An.schedule('spec',()=>An.spectrumChart(cv,{mags}));
      let dom=null;for(const m of mags)if(!dom||m.mag>dom.mag)dom=m;
      setText($('#freqNote'),dom&&dom.mag>1
        ?`Dominant tremor component ≈ ${(dom.freq*((win[1]-win[0])/256)).toFixed(1)} Hz (${dom.freq}th harmonic of a ${(win[1]-win[0]).toFixed(0)}s window)`
        :'Not enough motion to estimate a spectrum.');
    }
  },

  // Statistics run entirely off session metadata digests computed by the core.
  // No screen downloads raw events for more than one session at a time.
  drawStats(){
    const box=$('#statBox');if(!box)return;
    const c=this.ctx();
    const key=`${this.statTab}|${this.scope}|${S.sessions.length}|${S.rev}`;
    if(this.statsRev===key)return;
    this.statsRev=key;

    let src;
    if(this.scope==='all'){
      src=S.sessions.filter(s=>s.digest&&s.digest.events);
    }else{
      const a=c.sessionId?this.analyzer(c):null;
      src=a?[{createdAt:c.createdAt||new Date().toISOString(),mode:c.mode,map:c.map,
        digest:{...a.summary(),rounds:a.roundsAt(c.t1).length,topKeys:a.topKeys(12),
          avgFlickEfficiency:a.avgFlickEfficiency()}}]:[];
    }
    if(!src.length){setHTML(box,'<p class="empty">No session data available yet.</p>');return}

    const agg=src.reduce((x,s)=>{const d=s.digest;return{
      kills:x.kills+d.kills,deaths:x.deaths+d.deaths,hs:x.hs+d.hs,keys:x.keys+d.keys,
      btn:x.btn+d.btn,dist:x.dist+d.dist,dur:x.dur+d.duration,events:x.events+d.events,
      flicks:x.flicks+d.flicks};},
      {kills:0,deaths:0,hs:0,keys:0,btn:0,dist:0,dur:0,events:0,flicks:0});
    const kdm=agg.deaths?agg.kills/agg.deaths:agg.kills;
    const hsm=agg.kills?agg.hs/agg.kills*100:0;
    const lat=src.map(s=>s.digest.flickLatency).filter(Boolean).map(l=>l.median).sort((a,b)=>a-b);
    const medLat=lat.length?lat[lat.length>>1]:null;

    if(this.statTab==='overview'){
      setHTML(box,`<section class="kpi4">
        ${kpi('Sessions','',src.length,'saved','list',An.C.blue)}
        ${kpi('Total Events','',An.fmtNum(agg.events),'raw input','mouse',An.C.purple)}
        ${kpi('Total Time','',fmtDur(agg.dur),'captured','clock',An.C.teal)}
        ${kpi('K/D','',kdm.toFixed(2),`${agg.kills} / ${agg.deaths}`,'target',An.C.green)}</section>
        <table class="mini"><thead><tr><th>Session</th><th>Mode</th><th>Map</th><th>Duration</th><th>Events</th><th>K/D</th></tr></thead><tbody>
        ${src.slice(0,8).map(s=>`<tr><td>${esc(new Date(s.createdAt).toLocaleString())}</td><td>${esc(s.mode||'—')}</td><td>${esc(s.map||'—')}</td><td>${fmtDur(s.digest.duration)}</td><td>${s.digest.events}</td><td>${s.digest.deaths||s.digest.kills?s.digest.kd.toFixed(2):'—'}</td></tr>`).join('')}</tbody></table>`);
    }else if(this.statTab==='saim'){
      setHTML(box,`<section class="kpi4">
        ${kpi('Headshot %','',agg.kills?hsm.toFixed(1)+'%':'—',`${agg.hs} HS`,'aim',An.C.blue)}
        ${kpi('K/D','',kdm.toFixed(2),`${agg.kills} kills`,'target',An.C.blue)}
        ${kpi('Flick Latency','',medLat?medLat+' ms':'—','median flick → click','react',An.C.teal)}
        ${kpi('Flicks','',agg.flicks,'detected bursts','bolt',An.C.orange)}</section>
        <div class="grid2">${canvasEl('statTrend',220)}${canvasEl('statPerf',220)}</div>`);
      const t1=$('[data-chart="statTrend"]'),p1=$('[data-chart="statPerf"]');
      const xa={t0:0,t1:Math.max(1,src.length-1),xFmt:i=>`#${Math.round(i)+1}`,xTicks:Math.min(6,Math.max(1,src.length-1))};
      if(t1)An.schedule('statTrend',()=>An.lineChart(t1,{...xa,series:[
        {name:'Headshot %',color:An.C.blue,points:src.map((s,i)=>({x:i,y:s.digest.hsPct}))},
        {name:'K/D ×20',color:An.C.purple,points:src.map((s,i)=>({x:i,y:s.digest.kd*20}))}]}));
      if(p1)An.schedule('statPerf',()=>An.lineChart(p1,{...xa,series:[
        {name:'Avg speed (c/s)',color:An.C.green,points:src.map((s,i)=>({x:i,y:s.digest.avg}))},
        {name:'Peak (c/s)',color:An.C.orange,points:src.map((s,i)=>({x:i,y:s.digest.peak}))}]}));
    }else if(this.statTab==='smovement'){
      setHTML(box,`<div class="grid2">${canvasEl('statDist',220)}${canvasEl('statSpeed',220)}</div>`);
      const d1=$('[data-chart="statDist"]'),h1=$('[data-chart="statSpeed"]');
      if(d1)An.schedule('statDist',()=>An.bars(d1,{items:src.slice(0,8).map(s=>({label:new Date(s.createdAt).toLocaleDateString(),value:s.digest.dist,text:An.fmtNum(s.digest.dist),color:An.C.blue}))}));
      if(h1)An.schedule('statSpeed',()=>An.bars(h1,{items:src.slice(0,8).map(s=>({label:new Date(s.createdAt).toLocaleDateString(),value:s.digest.avg,text:Math.round(s.digest.avg)+' c/s',color:An.C.purple}))}));
    }else if(this.statTab==='sinput'){
      setHTML(box,`<section class="kpi4">
        ${kpi('Key Presses','',agg.keys.toLocaleString(),'keyboard','keys',An.C.violet)}
        ${kpi('Mouse Buttons','',agg.btn.toLocaleString(),'clicks','mouse',An.C.blue)}
        ${kpi('Distance','',An.fmtNum(agg.dist),'counts','move',An.C.purple)}
        ${kpi('Input Rate','',agg.dur?(agg.events/agg.dur).toFixed(1)+'/s':'—','events per second','rate',An.C.teal)}</section>
        <canvas class="chart" data-chart="statKeys" style="width:100%;height:220px"></canvas>`);
      const counts=new Map();
      for(const s of src)for(const k of s.digest.topKeys||[])counts.set(k.label,(counts.get(k.label)||0)+k.value);
      const items=[...counts.entries()].sort((a,b)=>b[1]-a[1]).slice(0,8).map(([label,value])=>({label,value,color:An.C.violet}));
      const cv=$('[data-chart="statKeys"]');
      if(cv)An.schedule('statKeys',()=>An.bars(cv,{items}));
    }else{
      // Weapon analysis — honest proxy panel: the log gives no weapon data.
      setHTML(box,`<div class="grid2">
        <div class="panel inset"><div class="panel-head"><h2>Headshot vs Body</h2></div><canvas class="chart" data-chart="statHs" style="width:100%;height:180px"></canvas></div>
        <div class="panel inset"><div class="panel-head"><h2>Kill Outcomes</h2></div><canvas class="chart" data-chart="statWeap" style="width:100%;height:180px"></canvas></div></div>
        <p class="muted">Weapon-level attribution (Vandal/Phantom/…) requires match details from Riot's authenticated endpoints; the local ShooterGame.log exposes only voice-line kill signals, so this panel tracks headshot vs bodyshot kills until that integration exists.</p>`);
      const h=$('[data-chart="statHs"]');
      if(h)An.schedule('statHs',()=>An.donut(h,{value:agg.kills?agg.hs/agg.kills:0,center:hsm.toFixed(1)+'%',label:'Headshot share',color:An.C.blue}));
      const w=$('[data-chart="statWeap"]');
      if(w)An.schedule('statWeap',()=>An.bars(w,{items:[
        {label:'Kills',value:agg.kills,color:An.C.green},
        {label:'Deaths',value:agg.deaths,color:An.C.red},
        {label:'Headshot kills',value:agg.hs,color:An.C.blue},
        {label:'Body kills',value:Math.max(0,agg.kills-agg.hs),color:An.C.purple}]}));
    }
  }
};

function kpi(label,id,value,sub,icon,color){return `<div class="card"><span class="kpi-ico" style="color:${color};border-color:${color}33">${({target:'◎',aim:'⊙',react:'⚡',mouse:'🖱',keys:'⌨',list:'☰',clock:'◷',move:'⇄',rate:'≈',bolt:'✦'}[icon]||'●')}</span><span class="kpi-label">${label}</span><strong data-kpi="${id}">${value??''}</strong><small data-kpisub="${id}">${sub??''}</small></div>`}
function setKpi(id,value,sub){setText($(`[data-kpi="${id}"]`),String(value));setText($(`[data-kpisub="${id}"]`),String(sub??''))}
function badge(text,cls){return `<span class="badge ${cls||'gray'}">${text}</span>`}
function roundRow(r){
  const color=r.kills&&!r.deaths?'#22C55E':r.deaths&&!r.kills?'#EF4444':r.kills&&r.deaths?'#3B82F6':'#64748B';
  const label=r.kills||r.deaths?`K ${r.kills} / D ${r.deaths}`:'no contact';
  return `<div class="rrow"><b>${r.n}</b><i style="background:${color}"></i><span>${label}</span><small>${An.fmtT((r.t1||r.t0)-r.t0)}</small></div>`;
}
function fmtDate(iso){const d=new Date(iso);const p=n=>String(n).padStart(2,'0');return `${d.getFullYear()}-${p(d.getMonth()+1)}-${p(d.getDate())}_${p(d.getHours())}-${p(d.getMinutes())}`}
