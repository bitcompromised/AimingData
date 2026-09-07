# Data format

Raw event:
```json
{"timestamp":181.231193336,"device":"mouse","type":"mouse_move","data":{"dx":14,"dy":-3,"x":1200,"y":650}}
```

Keyboard event:
```json
{"timestamp":181.232001112,"device":"keyboard","type":"key_down","data":{"key":"w","vk":87,"scanCode":17}}
```

Mouse button:
```json
{"timestamp":181.233002001,"device":"mouse","type":"mouse_button","data":{"button":"left","state":"down","x":1200,"y":650}}
```

`timestamp` uses Python `time.perf_counter()` and is monotonic. Session start/end timestamps use the same clock domain. This is deliberate: replay ordering must be based on event timestamps, not display frames.
