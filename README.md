# Fumobooru

A static booru for plush photos — mostly Touhou, but not entirely. Built **just
for fun**. No build step, no framework, no backend, no accounts. Three
hand-written front-end files, two Python scripts, and one generated data file;
open `index.html` and it works.

## Credits

**Danbooru** — <https://github.com/danbooru/danbooru>
Fumobooru is a parody, and it borrows a lot:

- the search DSL — bare tags, `-negation`, `rating:s`, `order:score`, `fav:me`
- the tag taxonomy, and colour-coding tags by category
- the grid gallery: a uniform grid of tracks holding variable-aspect-ratio
  previews, bottom-aligned in each cell
- the BSD 2-Clause license text in `LICENSE`, which is Danbooru's, copyright
  (c) 2013~2026 Danbooru Project

Fumobooru is not affiliated with, endorsed by, or
connected to the Danbooru Project or danbooru.donmai.us.

**Touhou Project** — created by **ZUN** (上海アリス幻樂団)
Most of this collection is Touhou, and ZUN is the reason this site exists. The
plush of Touhou characters are copyright ZUN.

The collection is **not** all Touhou. It also includes plush of characters and
franchises that have nothing to do with the Touhou Project. Those are the
property of their own rights holders, not of ZUN, and nothing here should be
read as a claim on them. Every photograph in `fumos/` remains the property of
whoever took it.

Nothing on this site is used with permission or endorsement from ZUN or from
any of the other rights holders involved.

## For fun

This is a personal hobby project. It exists because the plush are good and the
search is fun to build, not because it serves a purpose.

## Running it

Open `index.html`. That's the whole thing.

To serve it instead, so per-post share links and stubs resolve:

```sh
python3 -m http.server 8000
```

## How the images get there

```sh
python3 ingest.py ~/Downloads/plushies   # add media as untagged posts
python3 make-thumbs.py                   # build thumbs, mids, card.jpg, p/*.html
```

`ingest.py` copies new files in, reads their dimensions, and appends a post row
with placeholder tags — a tagging pass owns the tags afterwards. `make-thumbs.py`
generates every derived asset the HTML needs (grid previews, post-view images,
the Open Graph card, and one redirect stub per post for social previews). Both
are idempotent, so re-running after adding files is cheap.

`make-thumbs.py` wants ImageMagick. `exiftool` is optional — without it, ImageMagick
strips metadata instead. **Be aware `make-thumbs.py` deletes files**: it sweeps
orphans out of `thumbs/`, `mids/` and `p/`, and it strips metadata from the
originals in `fumos/` in place.

## Tests

`app.js` carries its own assertions. Open `index.html?selftest`; the page title
becomes `SELFTEST PASS` or `SELFTEST FAIL <n>`, and the results print to a
`<pre>` overlay and the console.
