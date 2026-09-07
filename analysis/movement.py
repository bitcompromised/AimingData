def key_durations(events):
    down={};out=[]
    for e in sorted(events,key=lambda x:x['timestamp']):
        key=e.get('data',{}).get('key')
        if not key: continue
        if e['type']=='key_down': down[key]=e['timestamp']
        elif e['type']=='key_up' and key in down:
            out.append({'key':key,'duration':e['timestamp']-down.pop(key)})
    return out
