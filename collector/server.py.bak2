import json
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

class CollectorServer(ThreadingHTTPServer):
    allow_reuse_address = True

class Handler(BaseHTTPRequestHandler):
    buffer = None
    collector_info = None

    def _send(self, status, payload):
        body = json.dumps(payload, separators=(',', ':')).encode('utf-8')
        self.send_response(status)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Cache-Control', 'no-store')
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Methods', 'GET,POST,OPTIONS')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type')
        self.end_headers()

    def do_GET(self):
        parsed = urlparse(self.path)
        if parsed.path == '/health':
            self._send(200, {'ok': True, **self.buffer.stats(), **self.collector_info()})
            return
        if parsed.path == '/events':
            q = parse_qs(parsed.query)
            try:
                start = float(q['start'][0]) if 'start' in q else None
                end = float(q['end'][0]) if 'end' in q else None
            except ValueError:
                self._send(400, {'error': 'start/end must be numbers'}); return
            events = self.buffer.query(start, end)
            try:
                limit = max(1, min(10000, int(q['limit'][0]))) if 'limit' in q else None
            except ValueError:
                self._send(400, {'error': 'limit must be an integer'}); return
            if limit is not None:
                events = events[-limit:]
            self._send(200, {'events': events, 'count': len(events), **self.buffer.stats()})
            return
        self._send(404, {'error': 'not_found'})

    def do_POST(self):
        parsed = urlparse(self.path)
        if parsed.path == '/clear':
            self.buffer.clear(); self._send(200, {'ok': True}); return
        self._send(404, {'error': 'not_found'})

    def log_message(self, *_):
        pass
