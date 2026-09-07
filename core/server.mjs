import http from 'node:http';
import {spawn} from 'node:child_process';
import {mkdir,writeFile,readdir,readFile} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';

const ROOT=resolve(fileURLToPath(new URL('..',import.meta.url)));
const WEB=resolve(ROOT,'web');
const DATA=resolve(ROOT,'data','sessions');
const COLLECTOR=process.env.COLLECTOR_URL||'http://127.0.0.1:8765';
const PORT=3001;
let active=null;
await mkdir(DATA,{recursive:true});

function json(res,status,obj){const body=JSON.stringify(obj);res.writeHead(status,{'Content-Type':'application/json','Access-Control-Allow-Origin':'*','Cache-Control':'no-store'});res.end(body)}
async function collector(path){const r=await fetch(COLLECTOR+path);if(!r.ok)throw new Error(`collector ${r.status}`);return r.json()}
async function body(req){let s='';for await(const c of req)s+=c;return s?JSON.parse(s):{}}
async function saveSession(session){const dir=join(DATA,session.sessionId);await mkdir(dir,{recursive:true});await writeFile(join(dir,'session.json'),JSON.stringify(session,null,2));}
async function sessions(){const names=await readdir(DATA,{withFileTypes:true});const out=[];for(const n of names){if(!n.isDirectory())continue;try{out.push(JSON.parse(await readFile(join(DATA,n.name,'session.json'),'utf8')))}catch{}}return out.sort((a,b)=>b.createdAt.localeCompare(a.createdAt));}

const collectorProc=spawn(process.env.PYTHON||'python',[join(ROOT,'collector','main.py')],{stdio:['ignore','pipe','pipe'],windowsHide:true});
collectorProc.stdout.on('data',d=>process.stdout.write(`[collector] ${d}`));collectorProc.stderr.on('data',d=>process.stderr.write(`[collector] ${d}`));
process.on('SIGINT',()=>collectorProc.kill());process.on('exit',()=>collectorProc.kill());
await new Promise(r=>setTimeout(r,350));

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
      const types={html:'text/html; charset=utf-8',js:'text/javascript; charset=utf-8',css:'text/css; charset=utf-8',json:'application/json'};
      res.writeHead(200,{'Content-Type':types[ext]||'application/octet-stream','Cache-Control':'no-store'});
      res.end(readFileSync(file)); return;
    }
  }
  if(req.method==='GET'&&u.pathname==='/api/health'){let c;try{c=await collector('/health')}catch(e){c={ok:false,error:e.message}}return json(res,c.ok?200:503,{ok:c.ok,collector:c,activeSession:active?.sessionId??null})}
  if(req.method==='GET'&&u.pathname==='/api/sessions')return json(res,200,{sessions:await sessions()});
  if(req.method==='GET'&&u.pathname==='/api/sessions/active')return json(res,200,{session:active});
  if(req.method==='POST'&&u.pathname==='/api/sessions/start'){
    if(active)return json(res,409,{error:'session_already_active',session:active});
    const b=await body(req);const c=await collector('/health');
    active={sessionId:randomUUID(),createdAt:new Date().toISOString(),startTimestamp:Number(c.nowMonotonic),game:b.game||'VALORANT',mode:b.mode||'Competitive',map:b.map||'Unknown',settings:b.settings||{dpi:800,pollingRate:1000,sensitivity:0.5,resolution:'1920x1080'}};
    return json(res,200,{ok:true,session:active});
  }
  if(req.method==='POST'&&u.pathname==='/api/sessions/stop'){
    if(!active)return json(res,409,{error:'no_active_session'});
    const c=await collector('/health');const end=Number(c.nowMonotonic);
    const ev=await collector(`/events?start=${encodeURIComponent(active.startTimestamp)}&end=${encodeURIComponent(end)}`);
    const session={...active,endTimestamp:end,durationSeconds:Math.max(0,end-active.startTimestamp),eventCount:ev.events.length,events:ev.events,rounds:[]};
    await saveSession(session);active=null;return json(res,200,{ok:true,session});
  }
  const m=u.pathname.match(/^\/api\/sessions\/([^/]+)$/);if(req.method==='GET'&&m){const all=await sessions();const s=all.find(x=>x.sessionId===m[1]);return s?json(res,200,{session:s}):json(res,404,{error:'not_found'})}
  if(req.method==='GET'&&u.pathname==='/api/live/events'){const c=await collector('/health');return json(res,200,c)}
  if(req.method==='GET'&&u.pathname==='/api/collector/events'){
    const s=u.searchParams.get('start'),e=u.searchParams.get('end');return json(res,200,await collector(`/events?start=${s||''}&end=${e||''}`))
  }
  if(req.method==='GET'&&u.pathname==='/api/collector/events/full')return json(res,200,await collector('/events'));
  if(req.method==='GET'&&u.pathname==='/api/collector/recent'){const n=Math.max(1,Math.min(1000,Number(u.searchParams.get('limit')||200)));return json(res,200,await collector(`/events?limit=${n}`));}
  json(res,404,{error:'not_found'});
 }catch(e){console.error(e);json(res,500,{error:'server_error',message:e.message})}
});
server.listen(PORT,'127.0.0.1',()=>console.log(`Mouse-Stats API: http://127.0.0.1:${PORT}`));
