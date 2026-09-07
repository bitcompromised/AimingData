// dashboard.js — live analytics dashboard (reference: AimingData 1.png).
const Dash={
  tab:'movement',rtab:'details',statTab:'overview',scope:'all',stage:null,built:false,

  ctx(){
    if(S.active&&S.health?.collector){
      return {live:true,sessionId:S.active.sessionId,events:S.live.events,
        t0:S.active.startTimestamp,t1:S.health.collector.nowMonotonic,
        title:`Session: ${fmtDate(S.active.createdAt)}`,
        meta:`Valorant · ${S.active.mode||'—'} · ${S.active.map||'Pending'} · R${S.game?.round??'—'} · live`,
        mode:S.active.mode,map:S.active.map,matchId:S.active.matchId};
    }
    const s=S.sessions[0];
    if(s){return {live:false,sessionId:s.sessionId,events:s.events||[],t0:s.startTimestamp,t1:s.endTimestamp||s.startTimestamp+1,
      title:`Session: ${fmtDate(s.createdAt)}`,
      meta:`Valorant · ${s.mode||'—'} · ${s.map||'—'} · ${An.rounds(s.events||[],s.endTimestamp).length} rounds · ${fmtDur(s.durationSeconds)}`,
      mode:s.mode,map:s.map,matchId:s.matchId}}
    return {live:false,sessionId:null,events:[],t0:0,t1:1,title:'No session yet',meta:'Waiting for capture…',mode:'—',map:'—',matchId:null};
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
    $$('[data-tab]').forEach(b=>b.onclick=()=>{this.tab=b.dataset.tab;$$('[data-tab]').forEach(x=>x.classList.toggle('active',x===b));$$('.tabpane[data-pane]').forEach(p=>p.classList.toggle('hidden',p.dataset.pane!==this.tab));this.drawAnalytics()});
    $$('[data-rtab]').forEach(b=>b.onclick=()=>{this.rtab=b.dataset.rtab;$$('[data-rtab]').forEach(x=>x.classList.toggle('active',x===b));this.tick(true)});
    $$('[data-stattab]').forEach(b=>b.onclick=async()=>{this.statTab=b.dataset.stattab;$$('[data-stattab]').forEach(x=>x.classList.toggle('active',x===b));await this.drawStats()});
    $('#statScope').onchange=async e=>{this.scope=e.target.value;await this.drawStats()};
    $('#btnStopCap')?.addEventListener('click',async()=>{await api('/sessions/stop',{method:'POST'});S.live={events:[],lastT:0};render()});
    $('#btnStartCap')?.addEventListener('click',async()=>{
      await api('/sessions/start',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({game:'VALORANT',mode:'Competitive',map:'Unknown',settings:{dpi:S.settings?.dpi,sensitivity:S.settings?.sensitivity,pollingRate:S.settings?.pollingRate,resolution:S.settings?.resolution}})});
      render();
    });
    this.built=true;
    this.tick(true);
    this.drawAnalytics();
    this.drawStats();
  },

  // --- per-tick updates (never rebuilds the page shell) ----------------------
  async tick(force){
    const c=this.ctx();
    if(!c.sessionId){return}
    const ev=c.events;
    const sum=An.summary(ev,S.settings||{});
    // KPI cards
    setKpi('kd',sum.deaths?sum.kd.toFixed(2):sum.kills?sum.kd.toFixed(2):'—',`${sum.kills} / ${sum.deaths}`);
    setKpi('hs',sum.kills?sum.hsPct.toFixed(1)+'%':'—',`${sum.hs} HS of ${sum.kills} kills`);
    setKpi('flt',sum.flickLatency?`${sum.flickLatency.median} ms`:'—',sum.flickLatency?`min ${sum.flickLatency.min} · max ${sum.flickLatency.max}`:`${sum.flicks} flicks detected`);
    setKpi('spd',`${Math.round(sum.avg)} c/s`,`σ ${Math.round(sum.sd)} · peak ${An.fmtNum(sum.peak)}`);
    setKpi('keys',sum.keys.toLocaleString(),`${c.t1>c.t0?(sum.keys/(c.t1-c.t0)).toFixed(1):0}/s`);
    const el=$('#capElapsed');if(el)el.textContent=An.fmtT(c.t1-c.t0);
    // stage
    this.stage.reset(ev,c.t0);
    this.stage.advanceTo(c.t1);this.stage.draw();
    // rounds
    const rounds=An.rounds(ev,c.t1);
    const rc=$('#roundsCount');if(rc)rc.textContent=rounds.length?`${rounds.length} rounds`:'';
    const rl=$('#roundsList');
    if(rl)rl.innerHTML=rounds.slice().reverse().map(r=>roundRow(r)).join('')||'<p class="empty">No rounds yet — waiting for VALORANT.</p>';
    // round details / key events
    const box=$('#roundDetailsBox');
    if(box){
      if(this.rtab==='details'){
        const r=rounds[rounds.length-1];
        box.innerHTML=r?`<div class="round-head"><h3>Round ${r.n}</h3>${badge(r.kills>=r.deaths&&r.kills>0?'Ahead':'—',r.kills>=r.deaths&&r.kills>0?'green':'gray')}</div>
          <div class="kv"><span>Start</span><b>${An.fmtT(r.t0-c.t0)}</b></div>
          <div class="kv"><span>Duration</span><b>${fmtDur(c.live?(c.t1-r.t0):(r.t1-r.t0))}</b></div>
          <div class="kv"><span>Kills / Deaths</span><b>${r.kills} / ${r.deaths}</b></div>
          <div class="kv"><span>Distance</span><b>${An.fmtNum(r.distance)} counts</b></div>
          <div class="kv"><span>Headshots</span><b>${r.headshots}</b></div>`:'<p class="empty">No round data — VALORANT log not detected yet.</p>';
      }else{
        const tl=An.gameTimeline(ev).slice(-12).reverse();
        box.innerHTML=tl.length?`<div class="vtimeline">${tl.map(e=>`<div class="vevent"><i style="background:${e.color}"></i><span>${An.fmtT(e.t-c.t0)}</span><b>${esc(e.label)}</b></div>`).join('')}</div>`:'<p class="empty">No game events yet.</p>';
      }
    }
    // round analysis (right rail)
    const ra=$('#roundAnalysis');
    if(ra){
      const r=rounds[rounds.length-1];
      const sumR=r?An.summary(ev.filter(e=>e.timestamp>=r.t0&&e.timestamp<=(r.t1||c.t1)),S.settings||{}):null;
      ra.innerHTML=`<div class="ra-grid"><canvas id="raDonut" width="140" height="110"></canvas>
        <div class="kv"><span>Headshots</span><b>${r?r.headshots:0}</b></div>
        <div class="kv"><span>Kills / Deaths</span><b>${r?`${r.kills} / ${r.deaths}`:'—'}</b></div>
        <div class="kv"><span>Avg Speed</span><b>${sumR?Math.round(sumR.avg)+' c/s':'—'}</b></div>
        <div class="kv"><span>Distance</span><b>${sumR?An.fmtNum(sumR.dist):'—'}</b></div>
        <div class="kv"><span>Flick Latency</span><b>${sumR&&sumR.flickLatency?sumR.flickLatency.median+' ms':'—'}</b></div></div>`;
      const dc=$('#raDonut');if(dc)An.donut(dc,{value:sumR&&sumR.flicks?Math.min(1,sumR.flicks?avgEff(c.events,sumR):0):0,center:sumR&&sumR.flicks?Math.round(avgEff(c.events,sumR)*100)+'%':'—',label:'Flick efficiency',color:An.C.green});
    }
    if(force||this.tab)this.drawAnalytics();
  },

  drawAnalytics(){
    const c=this.ctx();const ev=c.events;
    const sens=S.settings?.sensitivity??0.5,dpi=S.settings?.dpi??800;
    const win=c.live?[Math.max(c.t0,c.t1-60),c.t1]:[c.t0,c.t1];
    const X=t=>An.fmtT(t-c.t0);
    const ge=An.gameTimeline(ev);
    const markers=ge.map(e=>({t:e.t,color:e.color}));
    if(this.tab==='movement'){
      const cv=$('[data-chart="xy"]');if(!cv)return;
      const mv=An.moves(ev).filter(e=>e.timestamp>=win[0]);
      const step=Math.max(1,Math.floor(mv.length/600));
      const xs=[],ys=[];
      for(let i=0;i<mv.length;i+=step){xs.push({x:mv[i].timestamp,y:mv[i].data.dx||0});ys.push({x:mv[i].timestamp,y:mv[i].data.dy||0})}
      An.lineChart(cv,{t0:win[0],t1:win[1],xFmt:X,series:[{name:'X (horizontal)',color:An.C.blue,points:xs},{name:'Y (vertical)',color:An.C.purple,points:ys}]});
    }
    if(this.tab==='aim'){
      const cv=$('[data-chart="dual"]');if(!cv)return;
      const sig=An.speedSignal(ev).filter(s=>s.t>=win[0]);
      const n=160;const binsC=An.binSignal(sig,win[0],win[1],n,'max');
      const binsD=binsC.map(b=>({x:b.x,y:b.v*An.degPerCount(sens)}));
      An.lineChart(cv,{t0:win[0],t1:win[1],xFmt:X,rightAxis:true,yLeft:{max:An.niceMax(Math.max(1,...binsC.map(b=>b.v)))},yRight:{max:An.niceMax(Math.max(1,...binsD.map(b=>b.v)))},
        series:[{name:'Raw speed (counts/s)',color:An.C.blue,points:binsC.map(b=>({x:b.x,y:b.v}))},
                {name:`Translated (${An.edpi(dpi,sens)} eDPI → °/s)`,color:An.C.purple,points:binsD,axis:'right'}]});
      const fl=An.detectFlicks(ev).slice(-8).reverse();
      const ft=$('#flickTable');
      if(ft)ft.innerHTML=fl.length?`<table class="mini"><thead><tr><th>Time</th><th>Peak (c/s)</th><th>Peak (°/s)</th><th>Angle</th><th>Dur</th><th>Micro</th><th>Correct</th><th>Flick-back</th></tr></thead><tbody>
        ${fl.map(f=>`<tr><td>${An.fmtT(f.t0-c.t0)}</td><td>${Math.round(f.peak)}</td><td>${Math.round(f.peak*An.degPerCount(sens))}</td><td>${f.angleDeg}°</td><td>${f.durMs}ms</td><td>${f.micro}</td><td>${f.correctionMs}ms</td><td>${f.flickBack?`✓ ${f.flickBack.delayMs}ms`:'—'}</td></tr>`).join('')}</tbody></table>
        <p class="muted">Translation uses yaw 0.022°/count: deg/s = counts/s × 0.022 × sens (${sens}) — DPI (${dpi}) scales physical distance, eDPI (${An.edpi(dpi,sens)}) scales in-game rotation. Left axis is hardware counts/s; right axis is the in-game speed it produces.</p>`:'<p class="muted">No flicks detected yet in this window.</p>';
    }
    if(this.tab==='keyboard'){
      const kv=$('[data-chart="keys"]'),kt=$('[data-chart="keyticks"]');
      const counts={};for(const e of An.keyPresses(ev))counts[e.data.key]=(counts[e.data.key]||0)+1;
      const items=Object.entries(counts).sort((a,b)=>b[1]-a[1]).map(([label,value])=>({label,value,color:An.C.purple}));
      if(kv)An.bars(kv,{items});
      if(kt)An.tickStrip(kt,{t0:win[0],t1:win[1],xFmt:X,lanes:[{name:'Key Press',color:An.C.purple,ticks:An.keyPresses(ev).map(e=>e.timestamp)}]});
    }
    if(this.tab==='heatmap'){
      const cv=$('[data-chart="heat"]');if(!cv)return;
      An.heatmap(cv,{grid:An.heatmapGrid(ev,96,48,true)});
    }
    if(this.tab==='freq'){
      const cv=$('[data-chart="spec"]');if(!cv)return;
      const sig=An.speedSignal(ev).filter(s=>s.t>=win[0]);
      const bins=An.binSignal(sig,win[0],win[1],256,'mean');
      const mags=An.spectrum(bins,48);
      An.spectrumChart(cv,{mags});
      const dom=mags.slice().sort((a,b)=>b.mag-a.mag)[0];
      const note=$('#freqNote');if(note)note.textContent=dom&&dom.mag>1?`Dominant tremor component ≈ ${(dom.freq*((win[1]-win[0])/256)).toFixed(1)} Hz (${dom.freq}th harmonic of a ${(win[1]-win[0]).toFixed(0)}s window)`:'Not enough motion to estimate a spectrum.';
    }
  },

  async drawStats(){
    const box=$('#statBox');if(!box)return;
    let list=S.sessions;
    if(this.scope==='all'&&!S.statSessions.length){
      try{S.statSessions=(await api('/sessions')).sessions.filter(s=>(s.events||[]).length)}catch{}
    }
    const c=this.ctx();
    const src=this.scope==='all'?S.statSessions:[c.sessionId?{...c,events:c.events,createdAt:(S.active?S.active.createdAt:(S.sessions[0]&&S.sessions[0].createdAt))||new Date().toISOString()}:null].filter(Boolean);
    if(!src.length){box.innerHTML='<p class="empty">No session data available yet.</p>';return}
    const sens=S.settings?.sensitivity??0.5,dpi=S.settings?.dpi??800;
    const sums=src.map(s=>({s,sum:An.summary(s.events||[],S.settings||{})}));
    const agg=sums.reduce((a,x)=>({kills:a.kills+x.sum.kills,deaths:a.deaths+x.sum.deaths,hs:a.hs+x.sum.hs,keys:a.keys+x.sum.keys,btn:a.btn+x.sum.btn,dist:a.dist+x.sum.dist,dur:a.dur+x.sum.duration,events:a.events+x.sum.events,flicks:a.flicks+x.sum.flicks}),{kills:0,deaths:0,hs:0,keys:0,btn:0,dist:0,dur:0,events:0,flicks:0});
    const kdm=agg.deaths?agg.kills/agg.deaths:agg.kills;
    const hsm=agg.kills?agg.hs/agg.kills*100:0;
    const lat=sums.map(x=>x.sum.flickLatency).filter(Boolean);
    const medLat=lat.length?lat.map(l=>l.median).sort((a,b)=>a-b)[Math.floor(lat.length/2)]:null;
    if(this.statTab==='overview'){
      box.innerHTML=`<section class="kpi4">
        ${kpi('Sessions','',src.length,'saved','list',An.C.blue)}
        ${kpi('Total Events','',An.fmtNum(agg.events),'raw input','mouse',An.C.purple)}
        ${kpi('Total Time','',fmtDur(agg.dur),'captured','clock',An.C.teal)}
        ${kpi('K/D','',kdm.toFixed(2),`${agg.kills} / ${agg.deaths}`,'target',An.C.green)}</section>
        <table class="mini"><thead><tr><th>Session</th><th>Mode</th><th>Map</th><th>Duration</th><th>Events</th><th>K/D</th></tr></thead><tbody>
        ${sums.slice(0,8).map(x=>`<tr><td>${esc(new Date(x.s.createdAt).toLocaleString())}</td><td>${esc(x.s.mode||'—')}</td><td>${esc(x.s.map||'—')}</td><td>${fmtDur(x.sum.duration)}</td><td>${x.sum.events}</td><td>${x.sum.deaths?x.sum.kd.toFixed(2):x.sum.kills?x.sum.kd.toFixed(2):'—'}</td></tr>`).join('')}</tbody></table>`;
    }else if(this.statTab==='saim'){
      box.innerHTML=`<section class="kpi4">
        ${kpi('Headshot %','',agg.kills?hsm.toFixed(1)+'%':'—',`${agg.hs} HS`,'aim',An.C.blue)}
        ${kpi('K/D','',kdm.toFixed(2),`${agg.kills} kills`,'target',An.C.blue)}
        ${kpi('Flick Latency','',medLat?medLat+' ms':'—','median flick → click','react',An.C.teal)}
        ${kpi('Flicks','',agg.flicks,'detected bursts','bolt',An.C.orange)}</section>
        <div class="grid2">${canvasEl('statTrend',220)}${canvasEl('statPerf',220)}</div>`;
      const t1=$('[data-chart="statTrend"]'),p1=$('[data-chart="statPerf"]');
      if(t1)An.lineChart(t1,{t0:0,t1:Math.max(1,sums.length-1),xFmt:i=>`#${Math.round(i)+1}`,xTicks:Math.min(6,sums.length-1),
        series:[{name:'Headshot %',color:An.C.blue,points:sums.map((x,i)=>({x:i,y:x.sum.hsPct}))},{name:'K/D ×20',color:An.C.purple,points:sums.map((x,i)=>({x:i,y:x.sum.kd*20}))}]});
      if(p1)An.lineChart(p1,{t0:0,t1:Math.max(1,sums.length-1),xFmt:i=>`#${Math.round(i)+1}`,xTicks:Math.min(6,sums.length-1),
        series:[{name:'Avg speed (c/s)',color:An.C.green,points:sums.map((x,i)=>({x:i,y:x.sum.avg}))},{name:'Peak (c/s)',color:An.C.orange,points:sums.map((x,i)=>({x:i,y:x.sum.peak}))}]});
    }else if(this.statTab==='smovement'){
      box.innerHTML=`<div class="grid2">${canvasEl('statDist',220)}${canvasEl('statHist',220)}</div>`;
      const d1=$('[data-chart="statDist"]'),h1=$('[data-chart="statHist"]');
      if(d1)An.bars(d1,{items:sums.slice(0,8).map(x=>({label:new Date(x.s.createdAt).toLocaleDateString(),value:x.sum.dist,text:An.fmtNum(x.sum.dist),color:An.C.blue}))});
      if(h1){const all=src.flatMap(s=>s.events||[]);const sig=An.speedSignal(all);const bins=An.binSignal(sig,0,Math.max(1,Math.max(...sig.map(x=>x.speed),1)),30,'max');
        An.bars(h1,{items:bins.map((b,i)=>({label:`${Math.round(bins[i].v)}`,value:b.v,text:Math.round(b.v)+'',color:An.C.purple}))});}
    }else if(this.statTab==='sinput'){
      box.innerHTML=`<section class="kpi4">
        ${kpi('Key Presses','',agg.keys.toLocaleString(),'keyboard','keys',An.C.violet)}
        ${kpi('Mouse Buttons','',agg.btn.toLocaleString(),'clicks','mouse',An.C.blue)}
        ${kpi('Distance','',An.fmtNum(agg.dist),'counts','move',An.C.purple)}
        ${kpi('Input Rate','',agg.dur?(agg.events/agg.dur).toFixed(1)+'/s':'—','events per second','rate',An.C.teal)}</section>
        <canvas class="chart" data-chart="statKeys" style="width:100%;height:220px"></canvas>`;
      const all=src.flatMap(s=>s.events||[]);const counts={};for(const e of An.keyPresses(all))counts[e.data.key]=(counts[e.data.key]||0)+1;
      const cv=$('[data-chart="statKeys"]');if(cv)An.bars(cv,{items:Object.entries(counts).sort((a,b)=>b[1]-a[1]).slice(0,8).map(([label,value])=>({label,value,color:An.C.violet}))});
    }else{
      // Weapon analysis — honest proxy panel: the log gives no weapon data.
      box.innerHTML=`<div class="grid2">
        <div class="panel inset"><div class="panel-head"><h2>Headshot vs Body</h2></div><canvas class="chart" data-chart="statHs" style="width:100%;height:180px"></canvas></div>
        <div class="panel inset"><div class="panel-head"><h2>Kill Outcomes</h2></div><canvas class="chart" data-chart="statWeap" style="width:100%;height:180px"></canvas></div></div>
        <p class="muted">Weapon-level attribution (Vandal/Phantom/…) requires match details from Riot's authenticated endpoints; the local ShooterGame.log exposes only voice-line kill signals, so this panel tracks headshot vs bodyshot kills until that integration exists.</p>`;
      const h=$('[data-chart="statHs"]');if(h)An.donut(h,{value:agg.kills?agg.hs/agg.kills:0,center:hsm.toFixed(1)+'%',label:'Headshot share',color:An.C.blue});
      const w=$('[data-chart="statWeap"]');if(w)An.bars(w,{items:[{label:'Kills',value:agg.kills,color:An.C.green},{label:'Deaths',value:agg.deaths,color:An.C.red},{label:'Headshot kills',value:agg.hs,color:An.C.blue},{label:'Body kills',value:Math.max(0,agg.kills-agg.hs),color:An.C.purple}]});
    }
  }
};
function avgEff(events,sum){const fl=An.detectFlicks(events);if(!fl.length)return 0;return fl.reduce((a,f)=>a+f.efficiency,0)/fl.length}
function kpi(label,id,value,sub,icon,color){return `<div class="card"><span class="kpi-ico" style="color:${color};border-color:${color}33">${({target:'◎',aim:'⊙',react:'⚡',mouse:'🖱',keys:'⌨',list:'☰',clock:'◷',move:'⇄',rate:'≈',bolt:'✦'}[icon]||'●')}</span><span class="kpi-label">${label}</span><strong data-kpi="${id}">${value??''}</strong><small data-kpisub="${id}">${sub??''}</small></div>`}
function setKpi(id,value,sub){const v=$(`[data-kpi="${id}"]`);if(v&&value!=='')v.textContent=value;const s2=$(`[data-kpisub="${id}"]`);if(s2&&sub!==undefined)s2.textContent=sub}
function badge(text,cls){return `<span class="badge ${cls||'gray'}">${text}</span>`}
function roundRow(r){
  const color=r.kills&&!r.deaths?'#22C55E':r.deaths&&!r.kills?'#EF4444':r.kills&&r.deaths?'#3B82F6':'#64748B';
  const label=r.kills||r.deaths?`K ${r.kills} / D ${r.deaths}`:'no contact';
  return `<div class="rrow"><b>${r.n}</b><i style="background:${color}"></i><span>${label}</span><small>${An.fmtT((r.t1||r.t0)-r.t0)}</small></div>`;
}
function fmtDate(iso){const d=new Date(iso);const p=n=>String(n).padStart(2,'0');return `${d.getFullYear()}-${p(d.getMonth()+1)}-${p(d.getDate())}_${p(d.getHours())}-${p(d.getMinutes())}`}
