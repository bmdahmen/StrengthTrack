# StrengthTrack

Personal workout log: 60 notebook pages transcribed into a Cloudflare D1
database, served by a small Cloudflare Worker with a searchable UI and
strength-progression charts.

Live at https://strengthtrack.bmdahmen.workers.dev/

## Layout

- `src/api.js` — JSON API (workouts, exercise progression, body weights, notes)
- `src/routes.js` — request routing + frontend asset embedding
- `src/app.html`, `src/app.js` — the single-page frontend
- `build.py` — assembles `dist/worker.js` from `src/` (embeds HTML/JS as literals)
- `wrangler.toml` — worker name, D1 bindings
- `data/batch{1..6}.json` — raw transcriptions of the 57 unique notebook spreads
  (2026-04-23 → 2026-10-03)
- `tools/seed.py` — canonicalizes exercise names, infers units, and loads the
  batches into D1 (also creates the schema)

## Local dev

```sh
python3 build.py        # writes dist/worker.js
npx wrangler dev        # serves locally with remote D1
```

## Deploy

Pushing to `main` triggers `.github/workflows/deploy.yml`, which builds and
runs `wrangler deploy`. The workflow needs a `CLOUDFLARE_API_TOKEN` repository
secret with Workers edit access.

To deploy manually:

```sh
python3 build.py
npx wrangler deploy
```

## Data conventions

- Page headers are `MM/DD - bodyweight`; every workout carries that date's body
  weight (notebook header first, CalProTrack measurements backfilled where the
  header is missing).
- Dumbbell weights are kg per dumbbell; everything else is pounds.
- `tools/seed.py` merges ~40 raw name variants into canonical exercise names;
  grip variants (wide/neutral/close grip) are kept as distinct exercises.
- Exercise view charts Epley estimated-1RM per set number over time, with ring
  markers on sessions where the exercise led the day.
