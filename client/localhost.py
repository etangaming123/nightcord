"""Serve just the client, from this directory, at the root of localhost.

    python client/localhost.py [--port 8000]

tools/localhost.py serves the homepage too, laid out like GitHub Pages
(client at /app/); this one is for when you only want the client.
"""

import argparse
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, unquote, urlencode

CLIENT = Path(__file__).resolve().parent


class Handler(SimpleHTTPRequestHandler):
	def do_GET(self):
		# Deep links into the client (/servers/…, /settings/…) have no file
		# behind them. Send them to /?route=… so the client puts the address
		# back (router.js), like site/404.html does on GitHub Pages. A missing
		# file (anything with an extension) still 404s.
		clean, _, query = self.path.partition("?")
		clean = clean.split("#", 1)[0]
		last = clean.rstrip("/").rsplit("/", 1)[-1]
		if clean != "/" and "." not in last and not Path(self.translate_path(clean)).exists():
			params = parse_qs(query, keep_blank_values=True)
			params["route"] = [unquote(clean.lstrip("/"))]
			self.send_response(302)
			self.send_header("Location", "/?" + urlencode(params, doseq=True))
			self.end_headers()
			return
		super().do_GET()

	def end_headers(self):
		# Always fetch fresh files while developing.
		self.send_header("Cache-Control", "no-store")
		super().end_headers()


def main() -> None:
	parser = argparse.ArgumentParser(description="Host the local client files.")
	parser.add_argument("--port", "-p", type=int, default=8000)
	args = parser.parse_args()

	handler = partial(Handler, directory=str(CLIENT))
	with ThreadingHTTPServer(("127.0.0.1", args.port), handler) as server:
		print(f"Serving {CLIENT} at http://127.0.0.1:{args.port}")
		try:
			server.serve_forever()
		except KeyboardInterrupt:
			print("\nServer stopped.")


if __name__ == "__main__":
	main()
