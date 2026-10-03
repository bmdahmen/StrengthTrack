#!/usr/bin/env python3
"""Assemble dist/worker.js from src/ parts, embedding HTML/JS via JSON string literals."""
import json
import pathlib

ROOT = pathlib.Path(__file__).resolve().parent
SRC = ROOT / 'src'
DIST = ROOT / 'dist'
DIST.mkdir(exist_ok=True)

api = (SRC / 'api.js').read_text()
routes = (SRC / 'routes.js').read_text()
app_html = (SRC / 'app.html').read_text()
app_js = (SRC / 'app.js').read_text()

routes = routes.replace('__APP_HTML__', json.dumps(app_html))
routes = routes.replace('__APP_JS__', json.dumps(app_js))

out = api + '\n' + routes
(DIST / 'worker.js').write_text(out)
print('wrote', DIST / 'worker.js', len(out), 'bytes')
