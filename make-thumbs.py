#!/usr/bin/env python3
"""Generate grid thumbnails for Fumobooru.

The gallery draws previews at --size (120-270px), but the source files are up
to 3072x4096 / ~190KB, so every preview was pulling a full-size image. This
writes thumbs/<name>.webp sized for the grid and records a `thumb` field on
each post. The post view keeps using `src`, so full resolution is preserved.

Idempotent: safe to re-run. Pass a height to override the default:

    python3 make-thumbs.py          # 300px tall (default)
    python3 make-thumbs.py 540      # true 2x for the 270px grid size
"""
import json
import pathlib
import re
import subprocess
import sys
import tempfile

ROOT = pathlib.Path(__file__).resolve().parent
THUMBS = ROOT / "thumbs"
DATA = ROOT / "fumosData.js"
HEIGHT = int(sys.argv[1]) if len(sys.argv) > 1 else 300
QUALITY = 80
METHOD = 6

HEADER = (
    "// Post data. Images live in ./fumos and are referenced with relative paths,\n"
    "// so the site works from file:// and from any Vercel subpath.\n"
)


def video_frame(src, dest):
    """Grab a representative frame ~1s in, past any fade-in."""
    subprocess.run(
        ["ffmpeg", "-y", "-loglevel", "error", "-ss", "1", "-i", str(src),
         "-vframes", "1", str(dest)],
        check=True,
    )


def main():
    raw = DATA.read_text()
    data = json.loads(re.search(r"window\.FUMO_DATA = (.*);\s*$", raw, re.S).group(1))
    THUMBS.mkdir(exist_ok=True)

    made, total, skipped = 0, 0, 0
    for post in data["posts"]:
        src = ROOT / post["src"]
        name = pathlib.Path(post["src"]).stem
        out = THUMBS / f"{name}.webp"
        post["thumb"] = f"thumbs/{name}.webp"

        if not src.exists():
            print(f"  MISSING {post['src']}")
            continue

        # skip work already done, unless the requested height changed
        if out.exists() and post.get("thumb_height") == HEIGHT:
            skipped += 1
            total += out.stat().st_size
            post["srcBytes"] = src.stat().st_size
            post["thumbBytes"] = out.stat().st_size
            continue

        with tempfile.TemporaryDirectory() as td:
            stage = src
            if post["type"] == "video":
                # ImageMagick can't demux mp4, so take a frame first
                stage = pathlib.Path(td) / "frame.png"
                video_frame(src, stage)
            # fit inside HEIGHT x HEIGHT: height is what the grid constrains
            subprocess.run(
                ["magick", f"{stage}[0]" if stage.suffix != ".mp4" else str(stage),
                 "-resize", f"{HEIGHT}x{HEIGHT}", "-quality", str(QUALITY),
                 "-define", f"webp:method={METHOD}", str(out)],
                check=True,
            )

        post["thumb_height"] = HEIGHT
        post["srcBytes"] = src.stat().st_size
        post["thumbBytes"] = out.stat().st_size
        made += 1
        total += out.stat().st_size

    DATA.write_text(HEADER + "window.FUMO_DATA = " + json.dumps(data, indent=2) + ";\n")

    src_bytes = sum((ROOT / p["src"]).stat().st_size for p in data["posts"])
    print(f"thumbs at {HEIGHT}px, q{QUALITY} webp method {METHOD}")
    print(f"  wrote {made}, reused {skipped}")
    print(f"  gallery payload: {src_bytes/1024/1024:.1f} MB -> {total/1024/1024:.1f} MB "
          f"({src_bytes/max(total,1):.0f}x smaller)")


if __name__ == "__main__":
    main()
