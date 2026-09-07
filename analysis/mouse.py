from math import atan2, degrees, hypot

def counts_to_cm(counts, dpi):
    if dpi <= 0: raise ValueError('DPI must be positive')
    return counts / dpi * 2.54

def vector(dx, dy): return hypot(dx, dy)
def angle(dx, dy): return degrees(atan2(dy, dx))
def velocity(distance, dt): return distance / dt if dt > 0 else 0.0
def acceleration(dv, dt): return dv / dt if dt > 0 else 0.0
def jerk(da, dt): return da / dt if dt > 0 else 0.0
