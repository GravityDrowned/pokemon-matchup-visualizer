# Attribution

The JavaScript files in this directory are vendored, **unmodified**, from:

- **Upstream repo:** https://github.com/nerd-of-now/NCP-VGC-Damage-Calculator
- **Pinned commit:** `1369b359b85f0a6343df006acde92cc4a7d07805`
- **Upstream path:** `script_res/` (and `LICENSE` from the repo root)

## License

MIT License

Copyright (c) 2013-2021 Honko, Tapin, Firestorm, Jake White (squirrelboyVGC),
nerd-of-now, and other contributors

Permission is hereby granted, free of charge, to any person obtaining a copy of
this software and associated documentation files (the "Software"), to deal in
the Software without restriction, including without limitation the rights to
use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of
the Software, and to permit persons to whom the Software is furnished to do so,
subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

The full license text is also present as `LICENSE` in this directory.

## Vendored files

| Local name | Upstream path |
|---|---|
| `jquery.min.js` | `script_res/jquery-2.1.0.min.js` |
| `pokedex.js` | `script_res/pokedex.js` |
| `move_data.js` | `script_res/move_data.js` |
| `item_data.js` | `script_res/item_data.js` |
| `ability_data.js` | `script_res/ability_data.js` |
| `nature_data.js` | `script_res/nature_data.js` |
| `stat_data.js` | `script_res/stat_data.js` |
| `type_data.js` | `script_res/type_data.js` |
| `damage_MASTER.js` | `script_res/damage_MASTER.js` |
| `damage_SV.js` | `script_res/damage_SV.js` |
| `damage_xy.js` | `script_res/damage_xy.js` |
| `damage_dpp.js` | `script_res/damage_dpp.js` |
| `damage_rse.js` | `script_res/damage_rse.js` |
| `damage_gsc.js` | `script_res/damage_gsc.js` |
| `damage_rby.js` | `script_res/damage_rby.js` |
| `ko_chance.js` | `script_res/ko_chance.js` |
| `LICENSE` | `LICENSE` |

The upstream `ap_calc.js` (jQuery UI glue) and the `setdex_*.js` preset files
are deliberately **not** vendored. `ap_calc.js` is replaced by
`../scaffold.js`; the setdex files are preset teams and are not needed for the
damage math.

## Updating

1. Pick a new upstream commit SHA.
2. Re-download every file listed above from
   `https://raw.githubusercontent.com/nerd-of-now/NCP-VGC-Damage-Calculator/<SHA>/<path>`.
3. Update the pinned commit in this file and in `DESIGN.md`.
4. Re-run the smoke test at `static/calc/test.html` and confirm the globals,
   species keys, and damage output still match expectations.
