import os,sys,subprocess,time,webbrowser
from pathlib import Path
ROOT=Path(__file__).resolve().parent
web=ROOT/'web'
procs=[]

def main():
    if os.name!='nt': print('Note: the collector has full input hooks only on Windows.')
    if not (ROOT/'core/server.mjs').exists(): raise SystemExit('core/server.mjs is missing')
    env=os.environ.copy(); env['PYTHON']=sys.executable
    p=subprocess.Popen(['node',str(ROOT/'core/server.mjs')],cwd=ROOT,env=env);procs.append(p)
    import urllib.request
    ready=False
    for _ in range(50):
        try:
            with urllib.request.urlopen('http://127.0.0.1:3001/api/health',timeout=.2) as r:
                if r.status in (200,503): ready=True; break
        except Exception: time.sleep(.2)
    if not ready and p.poll() is not None:
        raise SystemExit(f'Core server exited with code {p.returncode}')
    if '--no-browser' not in sys.argv: webbrowser.open('http://127.0.0.1:3001')
    print('Mouse-Stats: http://127.0.0.1:3001')
    try:
        while p.poll() is None: time.sleep(.5)
        raise SystemExit(p.returncode or 0)
    except KeyboardInterrupt: pass
    finally:
        for x in procs:
            if x.poll() is None: x.terminate()
if __name__=='__main__': main()
