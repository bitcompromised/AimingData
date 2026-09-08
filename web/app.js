// app.js — shell, router, shared state & polling.
const API='http://127.0.0.1:3001/api';
const S={
  page:'Dashboard',health:null,game:null,active:null,sessions:[],settings:null,
  selected:null,selEvents:[],
  live:{events:[],lastT:0,sessionId:null},play:{playing:false,pos:0,speed:1,raf:0},
  latest:null,          // full events for the newest saved session (lazy)
  rev:0,                // bumped whenever event data changes; views use it to skip idle work
};
const $=(s,r=document)=>r.querySelector(s);
const $$=(s,r=document)=>[...r.querySelectorAll(s)];
const esc=x=>String(x??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
async function api(path,opt){const r=await fetch(API+path,opt);const j=await r.json().catch(()=>({}));if(!r.ok)throw Error(j.message||j.error||r.status);return j}
function fmtDur(v){v=Number(v||0);if(v<60)return `${v.toFixed(1)}s`;const m=Math.floor(v/60);if(m<60)return `${m}m ${Math.floor(v%60)}s`;return `${Math.floor(m/60)}h ${m%60}m`}
const nav=[['Dashboard','home'],['Sessions','list'],['Settings','gear']];
const ICONS={home:'⌂',list:'☰',gear:'⚙'};

// Write innerHTML only when the markup actually changed. The dashboard rebuilds
// several lists on every 500ms tick; without this each one re-parses HTML and
// invalidates layout even when nothing moved.
function setHTML(el,html){if(el&&el._h!==html){el._h=html;el.innerHTML=html}}
function setText(el,text){if(el&&el.textContent!==text)el.textContent=text}

function shell(content){
  const ok=S.health?.collector?.ok;
  $('#app').innerHTML=`<div class="app">
  <aside>
    <div class="brand"><span class="logo">🖱</span><b>Mouse<span>Stats</span></b></div>
    <nav>${nav.map(n=>`<button class="nav ${S.page===n[0]?'active':''}" data-page="${n[0]}"><i>${ICONS[n[1]]||''}</i>${n[0]}</button>`).join('')}</nav>
    <div class="collector">
      <div class="row"><i class="dot ${ok?'on':''}"></i><b>Collector ${ok?'Running':'Offline'}</b></div>
      <small>${esc(S.health?.collector?.platform||'waiting')} · pid ${S.health?.collector?.pid||'—'}</small>
      <small>Node.js core connected</small>
      <div id="gameBadgeSlot">${gameBadge()}</div>
    </div>
  </aside>
  <main id="main">${content}</main></div>`;
  $$('aside [data-page]').forEach(b=>b.onclick=()=>go(b.dataset.page));
}
function gameBadge(){
  const g=S.game;if(!g)return '';
  const phase=g.phase||'menu';
  const cls=phase==='live'?'live':phase==='agent_select'?'sel':phase==='postmatch'?'post':'';
  const label=phase==='live'?'In match':phase==='agent_select'?'Agent select':phase==='postmatch'?'Post match':'In menus';
  return `<div class="gamebadge ${cls}"><small>VALORANT</small><b>${esc(label)}</b>${g.map?`<small>${esc(g.map)} · R${g.round??'-'}</small>`:''}</div>`;
}
function header(title,sub,action=''){
  return `<header><div><div class="eyebrow">VALORANT · RAW INPUT TELEMETRY</div><h1>${esc(title)}</h1><p>${esc(sub)}</p></div><div class="hdr-actions">${action}</div></header>`;
}
function panel(title,inner,extra=''){
  return `<section class="panel"><div class="panel-head"><h2>${title}</h2>${extra}</div>${inner}</section>`;
}
function canvasEl(kind,h=180){return `<div class="chart-wrap" style="height:${h}px"><canvas class="chart" data-chart="${kind}"></canvas></div>`}
function go(page){S.page=page;render()}

async function refresh(){
  try{
    S.health=await api('/health');
    S.game=S.health.game||null;
    S.active=S.health.active||null;
  }catch(e){S.health={collector:{ok:false}};S.game=null;S.active=null}
  try{if(!S.settings)S.settings=await api('/settings')}catch(e){}
}

// Session metadata only — the listing endpoint no longer ships raw events, so
// this is a couple of KB regardless of how much has been captured.
async function loadSessions(){try{S.sessions=(await api('/sessions')).sessions}catch{S.sessions=[]}}

// Raw events for the newest saved session, fetched once and cached. The
// dashboard falls back to this when nothing is being captured live.
async function loadLatestEvents(){
  const s=S.sessions[0];
  if(!s){S.latest=null;return null}
  if(S.latest&&S.latest.sessionId===s.sessionId)return S.latest;
  try{
    const full=(await api('/sessions/'+s.sessionId)).session;
    S.latest={sessionId:s.sessionId,events:full.events||[],
      startTimestamp:full.startTimestamp,endTimestamp:full.endTimestamp,
      createdAt:full.createdAt,mode:full.mode,map:full.map,matchId:full.matchId,
      durationSeconds:full.durationSeconds,stats:full.stats};
    S.rev++;
  }catch{S.latest=null}
  return S.latest;
}

// ---- live event accumulation (incremental, 1:1 with wall clock) ------------
async function pollLiveEvents(){
  if(!S.active){
    if(S.live.events.length){S.live={events:[],lastT:0,sessionId:null};S.rev++}
    return null;
  }
  const now=S.health?.collector?.nowMonotonic||0;
  if(!now)return null;
  if(S.live.sessionId!==S.active.sessionId){S.live={events:[],lastT:0,sessionId:S.active.sessionId};S.rev++}
  const start=Math.max(S.active.startTimestamp,S.live.lastT+1e-4);
  try{
    const r=await api(`/collector/events?start=${start}&end=${now}`);
    const ev=r.events||[];
    if(ev.length){
      // push.apply/spread on a batch this size can exceed the argument limit
      const dst=S.live.events;
      for(let i=0;i<ev.length;i++)dst.push(ev[i]);
      S.live.lastT=ev[ev.length-1].timestamp;
      S.rev++;
    }
    return S.live.events;
  }catch(e){return S.live.events.length?S.live.events:null}
}

function render(){
  return (async()=>{
    await refresh();
    if(S.page==='Sessions'||S.page==='Dashboard')await loadSessions();
    if(S.page==='Dashboard'&&!S.active)await loadLatestEvents();
    const mod=S.page==='Dashboard'?Dash:S.page==='Sessions'?Sess:Sett;
    shell(mod.render());
    mod.mount();
  })();
}

// One self-scheduling poll cycle. setInterval could stack overlapping cycles
// whenever a fetch or a tick ran long; this never starts a cycle before the
// previous one has finished, and backs off while the tab is hidden.
const TICK_MS=500;
async function pollCycle(){
  try{
    if(document.hidden)return;
    await refresh();
    if(S.page==='Dashboard'){
      if(S.active)await pollLiveEvents();
      else await loadLatestEvents();
      Dash.tick();
    }else if(S.page==='Sessions'){
      Sess.tick&&Sess.tick();
    }
    // sidebar status
    const ok=S.health?.collector?.ok;
    const dot=$('.collector .dot');if(dot)dot.classList.toggle('on',!!ok);
    setText($('.collector b'),`Collector ${ok?'Running':'Offline'}`);
    setHTML($('#gameBadgeSlot'),gameBadge());
  }catch(e){
    console.error('[poll]',e);
  }finally{
    setTimeout(pollCycle,document.hidden?2000:TICK_MS);
  }
}
document.addEventListener('visibilitychange',()=>{if(!document.hidden&&S.page==='Dashboard')Dash.tick()});
// Build the page before the poll loop starts, so the first tick never runs
// against a shell that has not been mounted yet.
render().then(pollCycle);
