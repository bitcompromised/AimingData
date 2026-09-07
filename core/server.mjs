import http from 'node:http';
import {spawn} from 'node:child_process';
import {mkdir,writeFile,readdir,readFile} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';

const ROOT=resolve(fileURLToPath(new URL('..',import.meta.url)));
const WEB=resolve(ROOT,'web');
let DATA=resolve(ROOT,'data','sessions');
const SETTINGS_FILE=resolve(ROOT,'data','settings.json');
const COLLECTOR=process.env.COLLECTOR_URL||'http://127.0.0.1:8765';
const PORT=3001;
let active=null;
let collectorProc=null;

const DEFAULT_SETTINGS={dpi:800,pollingRate:1000,sensitivity:0.5,resolution:'1920x1080',
  autoCapture:true,autoStop:true,skipTheRange:true,bufferSize:1000000,logLevel:'Info',
  theme:'Dark',language:'English',showNotifications:true,minimizeToTray:false,
  dataDirectory:'',retentionDays:90,autoCleanup:true,debug:false,verbose:false,
  markerColors:{kill:'#22C55E',death:'#EF4444',round:'#3B82F6'}};
let settings={...DEFAULT_SETTINGS};
try{ if(existsSync(SETTINGS_FILE)){ settings={...DEFAULT_SETTINGS, ...JSON.parse(await readFile(SETTINGS_FILE,'utf8'))}; if(settings.dataDirectory) DATA=resolve(ROOT,settings.dataDirectory,'sessions'); } }catch{}
async function saveSettings(){ await mkdir(resolve(ROOT,'data'),{recursive:true}); await writeFile(SETTINGS_FILE,JSON.stringify(settings,null,2)); }

await mkdir(DATA,{recursive:true});

function json(res,status,obj){const body=JSON.stringify(obj);res.writeHead(status,{'Content-Type':'application/json','Access-Control-Allow-Origin':'*','Cache-Control':'no-store'});res.end(body)}
async function collector(path){const r=await fetch(COLLECTOR+path);if(!r.ok)throw new Error(`collector ${r.status}`);return r.json()}
async function body(req){let s='';for await(const c of req)s+=c;return s?JSON.parse(s):{}}
async function saveSession(session){const dir=join(DATA,session.sessionId);await mkdir(dir,{recursive:true});await writeFile(join(dir,'session.json'),JSON.stringify(session,null,2));}
async function sessions(){const names=await readdir(DATA,{withFileTypes:true});const out=[];for(const n of names){if(!n.isDirectory())continue;try{out.push(JSON.parse(await readFile(join(DATA,n.name,'session.json'),'utf8')))}catch{}}return out.sort((a,b)=>b.createdAt.localeCompare(a.createdAt));}

function spawnCollector(){
  collectorProc=spawn(process.env.PYTHON||'python',[join(ROOT,'collector','main.py')],{stdio:['ignore','pipe','pipe'],windowsHide:true,env:{...process.env,MOUSE_STATS_BUFFER:String(settings.bufferSize||1000000)}});
  collectorProc.stdout.on('data',d=>process.stdout.write(`[collector] ${d}`));
  collectorProc.stderr.on('data',d=>process.stderr.write(`[collector] ${d}`));
  collectorProc.on('exit',()=>{collectorProc=null});
}
spawnCollector();
process.on('SIGINT',()=>collectorProc&&collectorProc.kill());process.on('exit',()=>collectorProc&&collectorProc.kill());
await new Promise(r=>setTimeout(r,350));

// ---- Valorant-driven automatic capture ------------------------------------
// The collector tails ShooterGame.log (read-only) and exposes the game phase in
// /health. We poll it and drive the session lifecycle:
//   agent_select -> start session (+ map as soon as the log reveals it)
//   live         -> mark sawLive
//   postmatch    -> stop & save
//   menu         -> stop & save (if we saw a live game) or cancel (lobby blip)
let lastPhase='unknown';

async function stopActive(reason){
  if(!active)return null;
  const sess=active;active=null;
  const c=await collector('/health').catch(()=>null);
  const end=c?Number(c.nowMonotonic):Number(sess.startTimestamp);
  const ev=await collector(`/events?start=${encodeURIComponent(sess.startTimestamp)}&end=${encodeURIComponent(end)}`).catch(()=>({events:[]}));
  const evs=ev.events||[];
  const stats={matches:evs.filter(e=>e.type==='game_match_start').length,rounds:evs.filter(e=>e.type==='game_round_start').length,kills:evs.filter(e=>e.type==='game_kill').length,deaths:evs.filter(e=>e.type==='game_death').length,headshots:evs.filter(e=>e.type==='game_headshot').length};
  const session={...sess,endTimestamp:end,durationSeconds:Math.max(0,end-Number(sess.startTimestamp)),eventCount:evs.length,events:evs,rounds:[],stats,stoppedBy:reason};
  await saveSession(session);
  return session;
}

setInterval(async()=>{
  let h=null;
  try{h=await collector('/health');}catch{lastPhase='unknown';return;}
  const g=h.game||null;
  if(!g){return;}
  const phase=g.phase||'menu';
  const isRange=g.mapCodename==='Poveglia'||g.mapCodename==='PovegliaV2';
  try{
    if(phase==='agent_select'&&lastPhase!=='agent_select'&&!active){
      if(settings.autoCapture&&!(settings.skipTheRange&&isRange)){
        active={sessionId:randomUUID(),createdAt:new Date().toISOString(),startTimestamp:Number(h.nowMonotonic),game:'VALORANT',mode:g.mode||'Unknown',map:g.map||'Pending',mapCodename:g.mapCodename||null,auto:true,agent:g.agent||null,matchId:g.matchId||null,settings:{dpi:settings.dpi,pollingRate:settings.pollingRate,sensitivity:settings.sensitivity,resolution:settings.resolution}};
        console.log(`[capture] auto-start (agent select) ${g.map||''}`);
      }
    }
    if(active&&(phase==='agent_select'||phase==='live')&&g.map&&active.map!==g.map){
      active.map=g.map;active.mapCodename=g.mapCodename||null;
      if(g.agent)active.agent=g.agent;
      if(g.matchId)active.matchId=g.matchId;
      console.log(`[capture] map ${g.map}`);
    }
    if(active&&phase==='live')active.sawLive=true;
    if(active&&active.auto&&settings.autoStop){
      if(phase==='postmatch'){
        console.log('[capture] auto-stop (postmatch)');
        await stopActive('postmatch');
      }else if(phase==='menu'&&lastPhase!=='menu'&&lastPhase!=='unknown'){
        if(active.sawLive){console.log('[capture] auto-stop (menu)');await stopActive('menu');}
        else{console.log('[capture] cancel (left lobby)');active=null;}
      }
    }
    lastPhase=phase;
  }catch(e){console.error('[capture] poller error',e);}
},1500);

const server=http.createServer(async(req,res)=>{
 try{
  const u=new URL(req.url,'http://127.0.0.1');
  if(req.method==='OPTIONS'){res.writeHead(204,{'Access-Control-Allow-Origin':'*','Access-Control-Allow-Methods':'GET,POST,OPTIONS','Access-Control-Allow-Headers':'Content-Type'});return res.end()}
  if(req.method==='GET' && !u.pathname.startsWith('/api/')) {
    const safe=u.pathname==='/'?'/index.html':u.pathname;
    const file=resolve(WEB,'.'+safe);
    if(file.startsWith(WEB) && existsSync(file)) {
      const {readFileSync}=await import('node:fs');
      const ext=file.split('.').pop();
      const types={html:'text/html; charset=utf-8',js:'text/javascript; charset=utf-8',css:'text/css; charset=utf-8',json:'application/json',svg:'image/svg+xml',png:'image/png',ico:'image/x-icon'};
      res.writeHead(200,{'Content-Type':types[ext]||'application/octet-stream','Cache-Control':'no-store'});
      res.end(readFileSync(file)); return;
    }
  }
  if(req.method==='GET'&&u.pathname==='/api/health'){let c;try{c=await collector('/health')}catch(e){c={ok:false,error:e.message}}return json(res,c.ok?200:503,{ok:c.ok,collector:c,game:c?.game||null,activeSession:active?.sessionId??null,active:active})}
  if(req.method==='GET'&&u.pathname==='/api/sessions'){const meta=u.searchParams.get('meta')==='1';const list=(await sessions()).map(s=>meta?{...s,events:null}:s);return json(res,200,{sessions:list})}
  if(req.method==='GET'&&u.pathname==='/api/sessions/active')return json(res,200,{session:active});
  if(req.method==='POST'&&u.pathname==='/api/sessions/start'){
    if(active)return json(res,409,{error:'session_already_active',session:active});
    const b=await body(req);const c=await collector('/health');
    active={sessionId:randomUUID(),createdAt:new Date().toISOString(),startTimestamp:Number(c.nowMonotonic),game:b.game||'VALORANT',mode:b.mode||'Competitive',map:b.map||'Unknown',auto:false,settings:b.settings||{dpi:settings.dpi,pollingRate:settings.pollingRate,sensitivity:settings.sensitivity,resolution:settings.resolution}};
    return json(res,200,{ok:true,session:active});
  }
  if(req.method==='POST'&&u.pathname==='/api/sessions/stop'){
    if(!active)return json(res,409,{error:'no_active_session'});
    const s=await stopActive('manual');
    return json(res,200,{ok:true,session:s});
  }
  if(req.method==='POST'&&u.pathname==='/api/sessions/active/map'){
    if(!active)return json(res,409,{error:'no_active_session'});
    const b=await body(req);
    if(b.map)active.map=b.map;
    if(b.mapCodename!==undefined)active.mapCodename=b.mapCodename;
    if(b.agent)active.agent=b.agent;
    if(b.matchId)active.matchId=b.matchId;
    return json(res,200,{ok:true,session:active});
  }
  const mNotes=u.pathname.match(/^\/api\/sessions\/([^/]+)\/notes$/);
  if(req.method==='POST'&&mNotes){
    const all=await sessions();const s=all.find(x=>x.sessionId===mNotes[1]);
    if(!s)return json(res,404,{error:'not_found'});
    const b=await body(req);s.notes=String(b.notes??'');
    await saveSession(s);return json(res,200,{ok:true,session:s});
  }
  const m=u.pathname.match(/^\/api\/sessions\/([^/]+)$/);
  if(req.method==='GET'&&m){const all=await sessions();const s=all.find(x=>x.sessionId===m[1]);return s?json(res,200,{session:s}):json(res,404,{error:'not_found'})}
  if(req.method==='DELETE'&&m){
    const {rmSync}=await import('node:fs');
    try{rmSync(join(DATA,m[1]),{recursive:true,force:true})}catch{}
    return json(res,200,{ok:true});
  }
  if(req.method==='GET'&&u.pathname==='/api/settings')return json(res,200,settings);
  if(req.method==='POST'&&u.pathname==='/api/settings'){const b=await body(req);settings={...settings,...b,markerColors:{...DEFAULT_SETTINGS.markerColors,...(b.markerColors||{})}};await saveSettings();return json(res,200,settings)}
  if(req.method==='GET'&&u.pathname==='/api/live/events'){const c=await collector('/health');return json(res,200,c)}
  if(req.method==='GET'&&u.pathname==='/api/collector/events'){
    const s=u.searchParams.get('start'),e=u.searchParams.get('end');return json(res,200,await collector(`/events?start=${s||''}&end=${e||''}`))
  }
  if(req.method==='GET'&&u.pathname==='/api/collector/events/full')return json(res,200,await collector('/events'));
  if(req.method==='GET'&&u.pathname==='/api/collector/recent'){const n=Math.max(1,Math.min(1000,Number(u.searchParams.get('limit')||200)));return json(res,200,await collector(`/events?limit=${n}`));}
  if(req.method==='POST'&&u.pathname==='/api/collector/restart'){
    if(collectorProc){collectorProc.kill();collectorProc=null;}
    await new Promise(r=>setTimeout(r,400));spawnCollector();
    return json(res,200,{ok:true});
  }
  if(req.method==='POST'&&u.pathname==='/api/collector/stop'){if(collectorProc){collectorProc.kill();collectorProc=null;}return json(res,200,{ok:true})}
  if(req.method==='POST'&&u.pathname==='/api/collector/start'){if(!collectorProc)spawnCollector();return json(res,200,{ok:true})}
  json(res,404,{error:'not_found'});
 }catch(e){console.error(e);json(res,500,{error:'server_error',message:e.message})}
});
server.listen(PORT,'127.0.0.1',()=>console.log(`Mouse-Stats API: http://127.0.0.1:${PORT}`));
