#!/usr/bin/env python3
"""Add a directory of new media to the site as untagged posts.

Copies every file whose bytes are not already in fumos/ into fumos/<n>-<name>
and appends a post row to fumosData.js. Dimensions and format come from
ImageMagick; the counts are invented, exactly like the ones already in the
data. Tags are placeholders — a tagging pass owns those, and the counts,
thumbnails, card and stubs are make-thumbs.py's job.

Idempotent: a file already in fumos/ is skipped by content hash, so re-running
after adding more files only appends what is new.

    python3 ingest.py                        # ~/pinterest_fumo
    python3 ingest.py ~/Downloads/plushies
"""
import hashlib
import json
import pathlib
import random
import re
import shutil
import subprocess
import sys
import time

ROOT = pathlib.Path(__file__).resolve().parent
FUMOS = ROOT / "fumos"
DATA = ROOT / "fumosData.js"

SOURCE = pathlib.Path(sys.argv[1]).expanduser() if len(sys.argv) > 1 \
    else pathlib.Path.home() / "pinterest_fumo"

VIDEO = {".mp4", ".webm", ".mov", ".m4v"}
# No browser but Safari renders HEIC, and a post whose src cannot decode is a
# broken tile: those are converted to jpg on the way in.
RECODE = {".heic", ".heif", ".avif"}
# Files that are not media: the crawler's own bookkeeping.
SKIP = {"archive.db"}


def sha256(path):
    digest = hashlib.sha256()
    with path.open("rb") as fh:
        for block in iter(lambda: fh.read(1 << 20), b""):
            digest.update(block)
    return digest.hexdigest()


def read_data(raw):
    """The posts and the comment block above them, which stays untouched."""
    body = re.search(r"window\.FUMO_DATA = (.*);\s*$", raw, re.S)
    return json.loads(body.group(1)), raw[:body.start()]


def dimensions(paths):
    """One identify for the whole batch: width/height/format per file.

    The [0] is what keeps an animated GIF or a multi-page file from printing
    once per frame, and it is also how the video posts get their size.
    """
    out = subprocess.run(
        ["magick", "identify", "-format", "%f|%w|%h|%m\n"]
        + [f"{p}[0]" for p in paths],
        capture_output=True, text=True, check=True).stdout.splitlines()
    dims = {}
    for line in out:
        name, w, h, fmt = line.split("|")
        dims[name] = (int(w), int(h), fmt)
    return dims


def counts(digest):
    """Stand-in numbers, stable per file so a re-run does not reshuffle them."""
    r = random.Random(digest)
    return {
        "rating": "s",
        "score": r.randint(40, 340),
        "pitems": r.randint(1, 4),
        "favs": r.randint(8, 140),
        "comments": r.randint(0, 6),
        "views": r.randint(900, 14000),
    }


def main():
    if not SOURCE.is_dir():
        raise SystemExit(f"no such directory: {SOURCE}")
    raw = DATA.read_text()
    data, header = read_data(raw)
    posts = data["posts"]
    known = {sha256(f): f.name for f in FUMOS.iterdir() if f.is_file()}
    fresh = []
    for src in sorted(SOURCE.iterdir()):
        if not src.is_file() or src.name in SKIP:
            continue
        digest = sha256(src)
        if digest in known:
            print(f"  have {known[digest]} <- {src.name}")
            continue
        known[digest] = src.name
        fresh.append((src, digest))
    if not fresh:
        print("nothing new")
        return

    dims = dimensions([src for src, _ in fresh])
    first_id = max(p["id"] for p in posts) + 1
    first_num = max(int(p["src"].split("/")[1][:3]) for p in posts) + 1
    added = 0
    for offset, (src, digest) in enumerate(fresh):
        if src.name not in dims:
            print(f"  UNREADABLE {src.name}")
            continue
        width, height, fmt = dims[src.name]
        num = first_num + offset
        name = f"{num:03d}-{src.name}"
        target = FUMOS / name
        if src.suffix.lower() in RECODE:
            target = target.with_suffix(".jpg")
            subprocess.run(["magick", f"{src}[0]", "-auto-orient", "-strip",
                            "-quality", "92", str(target)], check=True)
        else:
            shutil.copy2(src, target)
        stamp = time.strftime("%Y-%m-%d %H:%M", time.localtime(src.stat().st_mtime))
        posts.append({
            "id": first_id + offset,
            "type": "video" if src.suffix.lower() in VIDEO else "image",
            "src": f"fumos/{target.name}",
            "width": width,
            "height": height,
            "date": stamp,
            "source": f"local://{SOURCE.name}",
            "tags": {
                "character": [],
                "copyright": ["touhou"],
                "artist": [],
                "general": ["plush", "photo"],
                "meta": ["tagme"],
            },
            **counts(digest),
        })
        added += 1
        print(f"  {fmt:5} {width}x{height} {name}")

    DATA.write_text(header + "window.FUMO_DATA = "
                    + json.dumps(data, indent=2) + ";\n")
    print(f"added {added} posts, ids {first_id}-{first_id + added - 1}")
    print("now run make-thumbs.py")


if __name__ == "__main__":
    main()
