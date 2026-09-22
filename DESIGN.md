# Design

## Stack

- **Backend:** Flask (Python 3.11+). Serves the pages and proxies/parses
  external data. No database.
- **Frontend:** vanilla JavaScript. No Node, no bundler, no build step. Plain
  `<script>` tags and static files served from `static/`.
- **Damage calculation:** runs **client-side** in the browser using the vendored
  NCP-VGC-Damage-Calculator engine (`static/calc/vendor/`). The Python side
  never computes damage.

## External data

- **MunchStats JSON API** — tournament lists plus per-Pokemon usage and spread
  statistics. Used to build the "top tournament teams" the user compares
  against.
- **pokepaste.es raw text** — the user pastes a team; we fetch the raw paste
  and parse it.

## Directory layout

```
pokemon-matchup-visualizer/
├── pyproject.toml
├── README.md
├── DESIGN.md
├── .gitignore
├── templates/                  # Jinja templates (index.html later)
├── static/
│   ├── app.js                  # planned: page bootstrap / wiring
│   ├── matrix.js               # planned: matchup matrix rendering
│   ├── scoring.js              # planned: best-4-of-6 scoring
│   └── calc/
│       ├── scaffold.js         # engine globals + thin CalcEngine API
│       ├── test.html           # headless engine smoke test
│       └── vendor/             # pinned NCP engine (unmodified) + LICENSE
├── server.py                   # planned: Flask app + routes
├── munchstats_api.py           # planned: MunchStats client
├── pokepaste_api.py            # planned: pokepaste.es client
├── showdown_parser.py          # planned: Showdown paste -> sets
└── cache.py                    # planned: on-disk response cache
```

## Pinned upstream

The damage engine is vendored from
`nerd-of-now/NCP-VGC-Damage-Calculator` at commit
`1369b359b85f0a6343df006acde92cc4a7d07805`.

We pin to an exact commit rather than tracking `main` because:

- The engine's data files (Pokemon, moves, items, abilities, type chart) change
  as new regulations release. An unpinned dependency would silently change the
  numbers the app reports.
- The engine is loaded as global-scope scripts, so a future refactor upstream
  could break our `scaffold.js` assumptions without warning.
- A pinned revision makes results reproducible and lets us re-run the smoke test
  after a deliberate upgrade.

To update: change the SHA, re-download the files listed in
`static/calc/vendor/ATTRIBUTION.md`, and re-run `static/calc/test.html`.

## Engine integration notes

The engine is a set of global-scope scripts. It does not expose a module. The
calculator's own UI glue (`ap_calc.js`) is deliberately **not** vendored; instead
`scaffold.js` sets the globals the math files read and exposes a small
`window.CalcEngine` API. See the header of `static/calc/scaffold.js` for the
exact global names and the shape the engine expects.
