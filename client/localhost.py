"""Serve the contents of this client directory on localhost."""

import argparse
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path


def main() -> None:
	parser = argparse.ArgumentParser(description="Host the local client files.")
	parser.add_argument("--port", "-p", type=int, default=8000)
	args = parser.parse_args()

	directory = Path(__file__).resolve().parent
	handler = partial(SimpleHTTPRequestHandler, directory=str(directory))

	with ThreadingHTTPServer(("127.0.0.1", args.port), handler) as server:
		print(f"Serving {directory} at http://127.0.0.1:{args.port}")
		try:
			server.serve_forever()
		except KeyboardInterrupt:
			print("\nServer stopped.")


if __name__ == "__main__":
	main()
