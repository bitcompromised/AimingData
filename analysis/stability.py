def variance(values):
    v=list(values)
    if len(v)<2:return 0.0
    m=sum(v)/len(v)
    return sum((x-m)**2 for x in v)/(len(v)-1)
