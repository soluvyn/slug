#!/usr/bin/env python
"""static server for slug. PORT sets the first port to try"""

import errno
import os
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

DIR = os.path.dirname(os.path.abspath(__file__))
PORT = int(os.environ.get("PORT", 3000))

HEADERS = {
    # revalidate every time, so edits show on reload and the model is a 304
    "Cache-Control": "max-age=0",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    # cross-origin isolation, which mi-gan needs for multithreaded wasm.
    # everything is same-origin, so require-corp blocks nothing
    "Cross-Origin-Opener-Policy": "same-origin",
    "Cross-Origin-Embedder-Policy": "require-corp",
}


class Handler(SimpleHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    # older pythons lack wasm and mjs, and on windows the registry can map .js
    # to text/plain, which module scripts refuse under nosniff
    extensions_map = {
        **SimpleHTTPRequestHandler.extensions_map,
        ".js": "text/javascript",
        ".mjs": "text/javascript",
        ".wasm": "application/wasm",
    }

    def end_headers(self):
        for name, value in HEADERS.items():
            self.send_header(name, value)
        super().end_headers()

    # failed requests only, minus the probes devtools makes to /.well-known
    def log_request(self, code="-", size="-"):
        if isinstance(code, int) and code >= 400 and ".well-known" not in getattr(self, "path", ""):
            super().log_request(code, size)

    def log_error(self, *args):
        pass  # every error also reaches log_request, which shows the request line


def bind(start, tries=20):
    """the first free port from start, so a second copy just runs"""
    for port in range(start, start + tries):
        try:
            return ThreadingHTTPServer(("localhost", port), partial(Handler, directory=DIR))
        except OSError as err:
            if err.errno != errno.EADDRINUSE:
                raise
    raise SystemExit(f"no free port in {start}-{start + tries - 1}")


if __name__ == "__main__":
    with bind(PORT) as httpd:
        print(f"Slug online at http://localhost:{httpd.server_port}", flush=True)
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            print("\nServer stopped.")
