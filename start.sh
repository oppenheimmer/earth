#!/usr/bin/env bash
#
# Launch earth::wind locally — starts a static file server (if not already running)
# and opens the visualization in the default browser. Double-click "earth-wind.desktop"
# or run this script directly.

set -u
cd "$(dirname "$0")"
PORT=8420
URL="http://localhost:${PORT}"

if ! curl -s -m 2 -o /dev/null "$URL"; then
    nohup python3 -m http.server "$PORT" -d public >/dev/null 2>&1 &
    # Wait for the server to accept connections.
    for _ in $(seq 1 20); do
        curl -s -m 1 -o /dev/null "$URL" && break
        sleep 0.25
    done
fi

xdg-open "$URL" 2>/dev/null || sensible-browser "$URL" 2>/dev/null || echo "Open $URL in your browser"
