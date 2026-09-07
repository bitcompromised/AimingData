// app.js — shell, router, shared state & polling.
const API='http://127.0.0.1:3001/api';
const S={
  page:'Dashboard',health:null,game:null,active:null,sessions:[],settings:null,
  selected:null,selEvents:[],statScope:'all',statSessions:[],
  live:{events:[],lastT:0},play:{playing:false,pos:0,speed:1,raf:0},
};
const $=(s,r=document)=>r.querySelector(s);
const $$=(s,r=document)=>[...r.querySelectorAll(s)];
const esc=x=>String(x??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
async function api(path,opt){const r=await fetch(API+path,opt);const j=await r.json().catch(()=>({}));if(!r.ok)throw Error(j.message||j.error||r.status);return j}
function fmtDur(v){v=Number(v||0);if(v<60)return `${v.toFixed(1)}s`;const m=Math.floor(v/60);if(m<60)return `${m}m ${Math.floor(v%60)}s`;return `${Math.floor(m/60)}h ${m%60}m`}
const nav=[['Dashboard','home'],['Sessions','list'],['Settings','gear']];
const ICONS={home:'⌂',list:'☰',gear:'⚙'};

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
      ${gameBadge()}
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
async function loadSessions(){try{S.sessions=(await api('/sessions')).sessions}catch{S.sessions=[]}}

// ---- live event accumulation (incremental, 1:1 with wall clock) ------------
async function pollLiveEvents(){
  if(!S.active){S.live={events:[],lastT:0,sessionId:null};return null}
  const now=S.health?.collector?.nowMonotonic||0;
  if(!now)return null;
  if(S.live.sessionId!==S.active.sessionId){S.live={events:[],lastT:0,sessionId:S.active.sessionId}}
  const start=Math.max(S.active.startTimestamp,S.live.lastT+1e-4);
  try{
    const r=await api(`/collector/events?start=${start}&end=${now}`);
    const ev=r.events||[];
    if(ev.length){
      S.live.events.push(...ev);
      S.live.lastT=ev[ev.length-1].timestamp;
    }
    return S.live.events;
  }catch(e){return S.live.events.length?S.live.events:null}
}

let tickers={};
function render(){
  (async()=>{
    await refresh();
    if(S.page==='Sessions')await loadSessions();
    if(S.page==='Dashboard')await loadSessions();
    const mod=S.page==='Dashboard'?Dash:S.page==='Sessions'?Sess:Sett;
    shell(mod.render());
    mod.mount();
    tickers={Dashboard:Dash,Sessions:Sess,Settings:Sett};
  })();
}
// Global 500ms tick: live pages update themselves; nothing re-renders the
// settings page (protects input focus).
setInterval(async()=>{
  if(document.hidden)return;                    // 1:1 only while the graph is visible
  await refresh();
  if(S.page==='Dashboard'){await pollLiveEvents();Dash.tick()}
  else if(S.page==='Sessions'){Sess.tick&&Sess.tick()}
  // sidebar status
  const ok=S.health?.collector?.ok;
  const badge=$('.collector');if(badge){$('.collector .dot',badge)?.classList.toggle('on',!!ok);const b=$('.collector b',badge);if(b)b.textContent=`Collector ${ok?'Running':'Offline'}`}
  const gb=$('.gamebadge');if(gb){const g=S.game;const wrap=gameBadge();if(wrap)gb.outerHTML=wrap}
},500);
render();
