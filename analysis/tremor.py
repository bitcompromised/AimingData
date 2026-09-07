def reversal_count(samples):
    dirs=[]
    for s in samples:
        dx=s.get('dx',0); dy=s.get('dy',0)
        if dx or dy: dirs.append((1 if dx>0 else -1 if dx<0 else 0,1 if dy>0 else -1 if dy<0 else 0))
    return sum(a!=b for a,b in zip(dirs,dirs[1:]))
