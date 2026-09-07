from collections import deque
from threading import Lock

class EventBuffer:
    def __init__(self, max_events=1_000_000):
        self._events = deque(maxlen=max_events)
        self._lock = Lock()
        self.dropped = 0
        self.max_events = max_events

    def append(self, event):
        with self._lock:
            if len(self._events) == self.max_events:
                self.dropped += 1
            self._events.append(event)

    def query(self, start=None, end=None):
        with self._lock:
            return [e for e in self._events if (start is None or e['timestamp'] >= start) and (end is None or e['timestamp'] <= end)]

    def snapshot(self):
        with self._lock:
            return list(self._events)

    def clear(self):
        with self._lock:
            self._events.clear()
            self.dropped = 0

    def stats(self):
        with self._lock:
            return {'bufferedEvents': len(self._events), 'droppedEvents': self.dropped, 'capacity': self.max_events}
