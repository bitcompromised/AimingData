def reaction_time(stimulus_timestamp, response_events):
    for e in sorted(response_events,key=lambda x:x['timestamp']):
        if e['timestamp']>=stimulus_timestamp and (e['type']=='mouse_move' or e['type']=='key_down' or e['type']=='mouse_button'):
            return e['timestamp']-stimulus_timestamp
    return None
