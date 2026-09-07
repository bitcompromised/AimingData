# Conservative candidate segmentation. A candidate is derived from velocity;
# it does not claim a flick unless thresholds are met.
def candidate_flicks(samples, min_speed=1200.0, max_gap=0.08):
    out=[]; active=None
    for s in samples:
        speed=float(s.get('speed',0))
        if speed>=min_speed:
            if active is None: active={'start':s['timestamp'],'peakVelocity':speed,'end':s['timestamp']}
            else: active['peakVelocity']=max(active['peakVelocity'],speed);active['end']=s['timestamp']
        elif active and s['timestamp']-active['end']<=max_gap:
            active['end']=s['timestamp']
        elif active:
            out.append(active);active=None
    if active: out.append(active)
    for x in out:x['duration']=x['end']-x['start']
    return out
