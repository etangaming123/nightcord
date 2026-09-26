"""Serve the homepage and the client locally, laid out like GitHub Pages:

    /       -> site/    (homepage)
    /app/   -> client/  (the Nightcord client)

    python tools/localhost.py [--port 8000]
"""

import argparse
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, unquote, urlencode

ROOT = Path(__file__).resolve().parents[1]
SITE = ROOT / "site"
CLIENT = ROOT / "client"


class Handler(SimpleHTTPRequestHandler):
	def translate_path(self, path):
		# /app and /app/... come from client/, everything else from site/.
		clean = path.split("?", 1)[0].split("#", 1)[0]
		if clean == "/app":
			return str(CLIENT)  # SimpleHTTPRequestHandler redirects to /app/
		if clean.startswith("/app/"):
			return str(CLIENT / clean[len("/app/"):])
		return super().translate_path(path)

	def do_GET(self):
		# Deep links into the client (/app/servers/…) have no file behind them.
		# Send them to /app/?route=… like site/404.html does on GitHub Pages.
		clean, _, query = self.path.partition("?")
		clean = clean.split("#", 1)[0]
		if clean.startswith("/app/") and not Path(self.translate_path(clean)).exists():
			params = parse_qs(query, keep_blank_values=True)
			params["route"] = [unquote(clean[len("/app/"):])]
			self.send_response(302)
			self.send_header("Location", "/app/?" + urlencode(params, doseq=True))
			self.end_headers()
			return
		super().do_GET()

	def end_headers(self):
		# Always fetch fresh files while developing.
		self.send_header("Cache-Control", "no-store")
		super().end_headers()


def main() -> None:
	parser = argparse.ArgumentParser(description="Host the homepage and client locally.")
	parser.add_argument("--port", "-p", type=int, default=8000)
	args = parser.parse_args()

	handler = partial(Handler, directory=str(SITE))
	with ThreadingHTTPServer(("127.0.0.1", args.port), handler) as server:
		print(f"Homepage: http://127.0.0.1:{args.port}/")
		print(f"Client:   http://127.0.0.1:{args.port}/app/")
		try:
			server.serve_forever()
		except KeyboardInterrupt:
			print("\nServer stopped.")


if __name__ == "__main__":
	main()
