from statistics import mean, median, stdev

def describe(values):
    v=list(values)
    return {'count':len(v),'mean':mean(v) if v else None,'median':median(v) if v else None,'stddev':stdev(v) if len(v)>1 else (0.0 if v else None),'min':min(v) if v else None,'max':max(v) if v else None}
