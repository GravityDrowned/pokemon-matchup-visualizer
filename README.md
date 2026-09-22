# Pokemon Matchup Visualizer

An interactive visualizer for competitive Pokemon VGC matchups. Load your team
and compare it against the top tournament teams from
[munchstats.com](https://munchstats.com): for every pairing of your Pokemon
against theirs, see how many hits each side needs to KO the other — in both
directions — as a color-coded 6×6 heatmap. From that matrix the app also ranks
all 15 "bring 4 of 6" combinations and recommends one with reasons, so you can
see at a glance where your team is strong and where it is weak.

The damage math is not reimplemented here. It runs entirely client-side using
the vendored, MIT-licensed
[NCP-VGC-Damage-Calculator](https://github.com/nerd-of-now/NCP-VGC-Damage-Calculator)
engine (see [`static/calc/vendor/ATTRIBUTION.md`](static/calc/vendor/ATTRIBUTION.md)
for the pinned revision).

---

## Prerequisites

- Python 3.11+
- [`uv`](https://docs.astral.sh/uv/) (or plain `pip`)

No Node, bundler, or build step is required — the frontend is plain JavaScript
served as static files.

## Install & Run

```bash
# Install dependencies
uv sync
# OR: pip install flask requests

# Start the server
uv run python server.py
# OR: python server.py
```

Then open <http://localhost:5000> in your browser.

## How to use

1. **Load your team.** Paste a `https://pokepast.es/...` URL into the pokepaste
   field and click **Load**. Or click **or paste team text** to expand the
   textarea and paste a Showdown-format export, then click **Load Team**.
2. **Pick an opponent.** Choose a tournament from the sidebar dropdown (newest
   first), choose a **day filter** (All / Day 2 / Top 16 / Top 8), then click a
   team in the list.
3. **Read the 6×6 matrix.** Rows are your team, columns are the opponent's.
   The cell color shows how fast *your* best move KOs them (OHKO → 4HKO+). The
   corner badge shows how dangerous *they* are to you (danger / risky / safe).
4. **Click any cell** for the full breakdown: every move on both sides, the 16
   damage rolls, KO odds, and KO text — for both directions.
5. **Try other spreads.** Each opponent Pokemon has a dropdown of its other
   common spreads, ranked by usage %. An **assumed** badge means no usage data
   existed, so a default spread was supplied.
6. **Toggle field conditions** (weather, terrain, Reflect, Light Screen,
   Tailwind, Helping Hand). The whole matrix recomputes.
7. **Read the Best 4 panel.** It ranks all 15 four-Pokemon combinations and
   recommends a bring with reasons. This is a heuristic, not a verdict.

## How it works

- **Backend (Flask):** `server.py` serves the page and JSON API. `munchstats_api.py`
  wraps the MunchStats tournament/usage endpoints, `pokepaste_api.py` fetches
  raw pastes, `showdown_parser.py` normalizes Showdown text into sets, and
  `cache.py` is a small on-disk TTL cache.
- **Frontend (vanilla JS):** `static/app.js` owns the UI and state,
  `static/matrix.js` builds and renders the heatmap and detail panel, and
  `static/scoring.js` ranks the best-4 subsets. No build step.
- **Damage engine:** vendored under `static/calc/` (loaded as global scripts,
  wrapped by `static/calc/scaffold.js` and `static/calc/adapter.js`). Damage is
  computed **client-side**; the Python side never computes damage.
- **Caching:** MunchStats responses are cached on disk for 24 hours and
  pokepaste responses for 7 days, so repeated lookups do not hammer upstream.

## Data sources & caveats

- **Tournament and usage data** come from MunchStats.
- **Tournament teams have no EV/SP spreads**, so spreads are supplied from
  usage statistics (the most common spread by default; alternatives are
  selectable per Pokemon).
- **Champions uses Stat Points (SPs)** — 0–32 per stat, 66 total — not EVs.
  Standard-EV pastes are converted with `floor(ev / 8)`, with a warning.
- **MunchStats silently fuzzy-substitutes unknown Pokemon.** We detect this and
  surface it via the **assumed** flag rather than presenting the substitute's
  data as if it were the real thing.
- **The engine's Champions roster is curated**, so some species or items may be
  unknown to it. These are shown as warnings and are never recommended.
- **Some legal items are missing from the curated list** — `Choice Band` is one
  example — so they surface as an "unknown item" warning and are ignored in
  damage calcs; unknown items/species are never silently guessed.

## Development

Run the Python test suite. pytest lives in the project venv, so use `uv`:

```bash
uv run python -m pytest tests/ -v
```

With a manually created `.venv`, activate it first (`source .venv/bin/activate`)
or call the interpreter directly:

```bash
.venv/bin/python -m pytest tests/ -v
```

The browser-side tests are plain HTML pages you can open directly:

- `static/calc/test.html` — engine smoke test
- `static/calc/adapter.test.html` — adapter round-trip tests
- `static/scoring.test.html` — best-4 scoring tests

## Regenerating the vendored engine

The engine is pinned to an exact upstream commit (see
`static/calc/vendor/ATTRIBUTION.md`). To update:

1. Pick a new upstream commit SHA.
2. Re-download every file listed in `ATTRIBUTION.md` from
   `https://raw.githubusercontent.com/nerd-of-now/NCP-VGC-Damage-Calculator/<SHA>/<path>`.
3. Update the pinned commit in `ATTRIBUTION.md` and `DESIGN.md`.
4. Re-run the browser test pages above and confirm the globals, species keys,
   and damage output still match expectations.
