"""Serve the homepage and the client locally, laid out like GitHub Pages:

    /       -> site/    (homepage)
    /app/   -> client/  (the Nightcord client)

    python tools/localhost.py [--port 8000]
"""

import argparse
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

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
