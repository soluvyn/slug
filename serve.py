#!/usr/bin/env python

import errno
import http.server
import mimetypes
import os
import socketserver
import sys
import time

DIR = os.path.dirname(os.path.abspath(__file__))
PORT = int(os.environ.get("PORT", 3000))

# the stdlib has no entry for these
mimetypes.add_type("application/wasm", ".wasm")
mimetypes.add_type("application/octet-stream", ".onnx")
mimetypes.add_type("text/javascript", ".mjs")

CACHE_CONTROL = "max-age=0"


class Handler(http.server.SimpleHTTPRequestHandler):
    server_version = "Slug/1.0"
    protocol_version = "HTTP/1.1"

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=DIR, **kwargs)

    def end_headers(self) -> None:
        self.send_header("Cache-Control", CACHE_CONTROL)
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "no-referrer")
        super().end_headers()

    def log_request(self, code="-", size="-") -> None:
        pass

    def log_error(self, fmt, *args) -> None:
        if ".well-known" in self.path:
            return
        stamp = time.strftime("%H:%M:%S")
        print(f"[{stamp}]  {self.command}  {self.path}  ->  {fmt % args}", file=sys.stderr)


class Server(socketserver.ThreadingMixIn, socketserver.TCPServer):
    allow_reuse_address = True
    daemon_threads = True


def bind(start: int, tries: int = 20) -> Server:
    """take the first free port from start. a second copy should just run"""
    for port in range(start, start + tries):
        try:
            return Server(("localhost", port), Handler)
        except OSError as err:
            if err.errno != errno.EADDRINUSE:
                raise
    raise SystemExit(f"no free port in {start}-{start + tries - 1}")


def main() -> None:
    httpd = bind(PORT)
    with httpd:
        print(f"Slug online at http://localhost:{httpd.server_address[1]}", flush=True)
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            print("\nServer stopped.")


if __name__ == "__main__":
    main()
