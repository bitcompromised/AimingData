import os, sys, time, threading
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent))
from buffer import EventBuffer
from server import CollectorServer, Handler
from mouse import MouseHook
from keyboard import KeyboardHook

HOST='127.0.0.1'; PORT=int(os.getenv('MOUSE_STATS_COLLECTOR_PORT','8765'))
buffer=EventBuffer(int(os.getenv('MOUSE_STATS_BUFFER','1000000')))
start_perf=time.perf_counter()

def now():
    # perf_counter is monotonic; seconds retain enough precision for replay.
    return time.perf_counter()

def record(device, kind, data):
    buffer.append({'timestamp':now(),'device':device,'type':kind,'data':data})

def info():
    return {'platform':sys.platform,'pid':os.getpid(),'clock':'time.perf_counter','startedAtMonotonic':start_perf,'nowMonotonic':now()}

Handler.buffer=buffer; Handler.collector_info=staticmethod(info)

def run_hook(hook):
    try: hook.run()
    except Exception as exc: print(f'hook error: {exc}', file=sys.stderr)

if __name__=='__main__':
    if sys.platform=='win32':
        threading.Thread(target=run_hook,args=(MouseHook(record),),daemon=True).start()
        threading.Thread(target=run_hook,args=(KeyboardHook(record),),daemon=True).start()
    else:
        print('WARNING: global Windows input hooks are unavailable on this platform; HTTP collector remains active.')
    print(f'Collector listening on http://{HOST}:{PORT}', flush=True)
    server=CollectorServer((HOST,PORT),Handler)
    try: server.serve_forever()
    except KeyboardInterrupt: pass
    finally: server.server_close()
