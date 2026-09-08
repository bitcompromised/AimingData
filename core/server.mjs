import http from 'node:http';
import zlib from 'node:zlib';
import {spawn} from 'node:child_process';
import {mkdir,writeFile,readdir,readFile,stat} from 'node:fs/promises';
import {existsSync,createReadStream,statSync,readFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import Metrics from '../web/metrics.js';

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

// Gzip anything big enough to be worth it. Telemetry JSON compresses ~10x, and
// even on loopback the win is mostly in bytes the browser has to buffer.
const GZIP_MIN=8192;
const acceptsGzip=req=>String(req&&req.headers&&req.headers['accept-encoding']||'').includes('gzip');
function json(res,status,obj,req){
  const body=Buffer.from(JSON.stringify(obj));
  const h={'Content-Type':'application/json','Access-Control-Allow-Origin':'*','Cache-Control':'no-store'};
  if(body.length>=GZIP_MIN&&acceptsGzip(req)){
    const gz=zlib.gzipSync(body,{level:zlib.constants.Z_BEST_SPEED});
    h['Content-Encoding']='gzip';h['Content-Length']=gz.length;h.Vary='Accept-Encoding';
    res.writeHead(status,h);return res.end(gz);
  }
  h['Content-Length']=body.length;
  res.writeHead(status,h);res.end(body);
}
async function collector(path){const r=await fetch(COLLECTOR+path);if(!r.ok)throw new Error(`collector ${r.status}`);return r.json()}
async function body(req){let s='';for await(const c of req)s+=c;return s?JSON.parse(s):{}}
// ---- session storage -------------------------------------------------------
// Sessions are big (tens of MB of raw events). The listing endpoint used to
// parse every one of them on every request and ship the events to the browser;
// now each session gets a small `meta.json` sidecar holding everything the
// listing and statistics screens need, and raw events are fetched only for the
// one session actually being viewed.

function metaOf(session){
  const {events,...rest}=session;
  return {...rest,eventCount:session.eventCount??(events||[]).length,
    digest:Metrics.digest(events||[],session.endTimestamp)};
}

async function saveSession(session){
  const dir=join(DATA,session.sessionId);
  await mkdir(dir,{recursive:true});
  await writeFile(join(dir,'session.json'),JSON.stringify(session));
  const meta=metaOf(session);
  await writeFile(join(dir,'meta.json'),JSON.stringify(meta));
  metaCache.set(session.sessionId,{mtimeMs:Date.now(),meta});
  return meta;
}

const metaCache=new Map();   // sessionId -> {mtimeMs, meta}

// Read a session's metadata without touching the raw events when possible:
// use the sidecar if it is at least as new as session.json, otherwise parse the
// session once and backfill the sidecar so it never happens again.
async function readMeta(id){
  const dir=join(DATA,id);
  const sf=join(dir,'session.json'),mf=join(dir,'meta.json');
  let sst;try{sst=await stat(sf)}catch{return null}
  const hit=metaCache.get(id);
  if(hit&&hit.mtimeMs>=sst.mtimeMs)return hit.meta;
  try{
    const mst=await stat(mf);
    if(mst.mtimeMs>=sst.mtimeMs){
      const meta=JSON.parse(await readFile(mf,'utf8'));
      metaCache.set(id,{mtimeMs:sst.mtimeMs,meta});
      return meta;
    }
  }catch{}
  try{
    const session=JSON.parse(await readFile(sf,'utf8'));
    const meta=metaOf(session);
    await writeFile(mf,JSON.stringify(meta));
    metaCache.set(id,{mtimeMs:sst.mtimeMs,meta});
    console.log(`[sessions] indexed ${id} (${meta.eventCount} events)`);
    return meta;
  }catch(e){console.error(`[sessions] cannot index ${id}:`,e.message);return null}
}

async function sessionIds(){
  const names=await readdir(DATA,{withFileTypes:true});
  return names.filter(n=>n.isDirectory()).map(n=>n.name);
}

// Metadata for every session, newest first. No raw events, no full parse after
// the first indexing pass.
async function sessionMetas(){
  const out=[];
  for(const id of await sessionIds()){const m=await readMeta(id);if(m)out.push(m)}
  return out.sort((a,b)=>String(b.createdAt).localeCompare(String(a.createdAt)));
}

async function readSession(id){
  try{return JSON.parse(await readFile(join(DATA,id,'session.json'),'utf8'))}catch{return null}
}

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

// Static assets are served from an mtime-keyed memory cache with an ETag, so a
// reload revalidates instead of re-reading and re-sending every script.
const STATIC_TYPES={html:'text/html; charset=utf-8',js:'text/javascript; charset=utf-8',css:'text/css; charset=utf-8',json:'application/json',svg:'image/svg+xml',png:'image/png',ico:'image/x-icon'};
const staticCache=new Map();
function serveStatic(req,res,file){
  const st=statSync(file);
  let hit=staticCache.get(file);
  if(!hit||hit.mtimeMs!==st.mtimeMs){
    const buf=readFileSync(file);
    hit={mtimeMs:st.mtimeMs,buf,gz:zlib.gzipSync(buf),etag:`W/"${st.mtimeMs.toString(36)}-${buf.length.toString(36)}"`};
    staticCache.set(file,hit);
  }
  if(req.headers['if-none-match']===hit.etag){res.writeHead(304,{ETag:hit.etag,'Cache-Control':'no-cache'});return res.end()}
  const ext=file.split('.').pop();
  const h={'Content-Type':STATIC_TYPES[ext]||'application/octet-stream','Cache-Control':'no-cache',ETag:hit.etag,Vary:'Accept-Encoding'};
  if(acceptsGzip(req)&&hit.buf.length>1024){
    h['Content-Encoding']='gzip';h['Content-Length']=hit.gz.length;
    res.writeHead(200,h);return res.end(hit.gz);
  }
  h['Content-Length']=hit.buf.length;
  res.writeHead(200,h);res.end(hit.buf);
}

const server=http.createServer(async(req,res)=>{
 try{
  const u=new URL(req.url,'http://127.0.0.1');
  if(req.method==='OPTIONS'){res.writeHead(204,{'Access-Control-Allow-Origin':'*','Access-Control-Allow-Methods':'GET,POST,OPTIONS','Access-Control-Allow-Headers':'Content-Type'});return res.end()}
  if(req.method==='GET' && !u.pathname.startsWith('/api/')) {
    const safe=u.pathname==='/'?'/index.html':u.pathname;
    const file=resolve(WEB,'.'+safe);
    if(file.startsWith(WEB) && existsSync(file)) return serveStatic(req,res,file);
  }
  if(req.method==='GET'&&u.pathname==='/api/health'){let c;try{c=await collector('/health')}catch(e){c={ok:false,error:e.message}}return json(res,c.ok?200:503,{ok:c.ok,collector:c,game:c?.game||null,activeSession:active?.sessionId??null,active:active},req)}
  // Metadata only. Raw events are hundreds of MB across all sessions and no
  // screen needs them in aggregate — each session's `digest` carries the
  // statistics. `?full=1` still returns everything, for export tooling.
  if(req.method==='GET'&&u.pathname==='/api/sessions'){
    if(u.searchParams.get('full')==='1'){
      const list=[];for(const id of await sessionIds()){const s=await readSession(id);if(s)list.push(s)}
      list.sort((a,b)=>String(b.createdAt).localeCompare(String(a.createdAt)));
      return json(res,200,{sessions:list},req);
    }
    return json(res,200,{sessions:await sessionMetas()},req);
  }
  if(req.method==='GET'&&u.pathname==='/api/sessions/active')return json(res,200,{session:active},req);
  if(req.method==='POST'&&u.pathname==='/api/sessions/start'){
    if(active)return json(res,409,{error:'session_already_active',session:active},req);
    const b=await body(req);const c=await collector('/health');
    active={sessionId:randomUUID(),createdAt:new Date().toISOString(),startTimestamp:Number(c.nowMonotonic),game:b.game||'VALORANT',mode:b.mode||'Competitive',map:b.map||'Unknown',auto:false,settings:b.settings||{dpi:settings.dpi,pollingRate:settings.pollingRate,sensitivity:settings.sensitivity,resolution:settings.resolution}};
    return json(res,200,{ok:true,session:active},req);
  }
  if(req.method==='POST'&&u.pathname==='/api/sessions/stop'){
    if(!active)return json(res,409,{error:'no_active_session'},req);
    const s=await stopActive('manual');
    return json(res,200,{ok:true,session:s},req);
  }
  if(req.method==='POST'&&u.pathname==='/api/sessions/active/map'){
    if(!active)return json(res,409,{error:'no_active_session'},req);
    const b=await body(req);
    if(b.map)active.map=b.map;
    if(b.mapCodename!==undefined)active.mapCodename=b.mapCodename;
    if(b.agent)active.agent=b.agent;
    if(b.matchId)active.matchId=b.matchId;
    return json(res,200,{ok:true,session:active},req);
  }
  const mNotes=u.pathname.match(/^\/api\/sessions\/([^/]+)\/notes$/);
  if(req.method==='POST'&&mNotes){
    const s=await readSession(mNotes[1]);
    if(!s)return json(res,404,{error:'not_found'},req);
    const b=await body(req);s.notes=String(b.notes??'');
    const meta=await saveSession(s);
    return json(res,200,{ok:true,session:meta},req);
  }
  const m=u.pathname.match(/^\/api\/sessions\/([^/]+)$/);
  // Stream the stored JSON straight through (gzipped) instead of parsing a
  // multi-MB file into objects just to re-serialise it.
  if(req.method==='GET'&&m){
    const file=join(DATA,m[1],'session.json');
    if(!existsSync(file))return json(res,404,{error:'not_found'},req);
    const gzip=acceptsGzip(req);
    const h={'Content-Type':'application/json','Access-Control-Allow-Origin':'*','Cache-Control':'no-store',Vary:'Accept-Encoding'};
    if(gzip)h['Content-Encoding']='gzip';
    res.writeHead(200,h);
    const rs=createReadStream(file);
    // The envelope has to go through the same encoder as the body, or a gzip
    // client gets plaintext braces wrapped around a deflate stream.
    const sink=gzip?zlib.createGzip({level:zlib.constants.Z_BEST_SPEED}):res;
    if(gzip)sink.pipe(res);
    sink.write('{"session":');
    rs.pipe(sink,{end:false});
    rs.on('end',()=>sink.end('}'));
    rs.on('error',()=>sink.end('null}'));
    return;
  }
  if(req.method==='DELETE'&&m){
    const {rmSync}=await import('node:fs');
    try{rmSync(join(DATA,m[1]),{recursive:true,force:true})}catch{}
    metaCache.delete(m[1]);
    return json(res,200,{ok:true},req);
  }
  if(req.method==='GET'&&u.pathname==='/api/settings')return json(res,200,settings,req);
  if(req.method==='POST'&&u.pathname==='/api/settings'){const b=await body(req);settings={...settings,...b,markerColors:{...DEFAULT_SETTINGS.markerColors,...(b.markerColors||{})}};await saveSettings();return json(res,200,settings,req)}
  if(req.method==='GET'&&u.pathname==='/api/live/events'){const c=await collector('/health');return json(res,200,c,req)}
  if(req.method==='GET'&&u.pathname==='/api/collector/events'){
    const s=u.searchParams.get('start'),e=u.searchParams.get('end');return json(res,200,await collector(`/events?start=${s||''}&end=${e||''}`),req)
  }
  if(req.method==='GET'&&u.pathname==='/api/collector/events/full')return json(res,200,await collector('/events'),req);
  if(req.method==='GET'&&u.pathname==='/api/collector/recent'){const n=Math.max(1,Math.min(1000,Number(u.searchParams.get('limit')||200)));return json(res,200,await collector(`/events?limit=${n}`),req);}
  if(req.method==='POST'&&u.pathname==='/api/collector/restart'){
    if(collectorProc){collectorProc.kill();collectorProc=null;}
    await new Promise(r=>setTimeout(r,400));spawnCollector();
    return json(res,200,{ok:true},req);
  }
  if(req.method==='POST'&&u.pathname==='/api/collector/stop'){if(collectorProc){collectorProc.kill();collectorProc=null;}return json(res,200,{ok:true},req)}
  if(req.method==='POST'&&u.pathname==='/api/collector/start'){if(!collectorProc)spawnCollector();return json(res,200,{ok:true},req)}
  json(res,404,{error:'not_found'},req);
 }catch(e){console.error(e);json(res,500,{error:'server_error',message:e.message},req)}
});
server.listen(PORT,'127.0.0.1',()=>console.log(`Mouse-Stats API: http://127.0.0.1:${PORT}`));
