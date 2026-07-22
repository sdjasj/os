#!/usr/bin/env python3
"""Extract the rendered lecture body from the mirrored Next.js pages."""

from __future__ import annotations

import json
import re
import subprocess
from pathlib import Path


ROOT = Path(__file__).resolve().parent.parent
HTML = ROOT / "sources" / "site_html"
OUTPUT = ROOT / "sources" / "notes"


def next_data(page: Path) -> dict:
    text = page.read_text(encoding="utf-8")
    match = re.search(
        r'<script id="__NEXT_DATA__" type="application/json">(.*?)</script>',
        text,
        re.DOTALL,
    )
    if not match:
        raise RuntimeError(f"cannot find __NEXT_DATA__ in {page}")
    return json.loads(match.group(1))


def raw_source(data: dict, fallback_html: str) -> str:
    value = data.get("props", {}).get("pageProps", {}).get("rawSource")
    return value if isinstance(value, str) else fallback_html


def to_markdown(html: str) -> str:
    proc = subprocess.run(
        ["pandoc", "-f", "html", "-t", "gfm", "--wrap=none", "--quiet"],
        input=html,
        text=True,
        check=True,
        capture_output=True,
    )
    lines = []
    for line in proc.stdout.splitlines():
        if re.fullmatch(r"</?div(?: [^>]*)?>", line.strip()):
            continue
        lines.append(line.rstrip())
    cleaned = "\n".join(lines)
    cleaned = re.sub(r"\n{3,}", "\n\n", cleaned).strip()
    return cleaned + "\n"


def extract(page: Path, destination: Path) -> None:
    page_html = page.read_text(encoding="utf-8")
    markdown = to_markdown(raw_source(next_data(page), page_html))
    if destination.parent == OUTPUT and destination.name.startswith("lect"):
        markdown = markdown.replace("](static/img/", "](../site_html/static/img/")
    if destination.parent == OUTPUT / "labs":
        markdown = markdown.replace("](Labs.md)", "](README.md)")
    destination.parent.mkdir(parents=True, exist_ok=True)
    destination.write_text(markdown, encoding="utf-8")


def main() -> None:
    OUTPUT.mkdir(parents=True, exist_ok=True)
    extract(HTML / "overview.html", OUTPUT / "overview.md")
    extract(HTML / "references.html", OUTPUT / "references.md")
    for number in range(1, 31):
        extract(HTML / f"lect{number:02}.html", OUTPUT / f"lect{number:02}.md")
    extract(HTML / "labs.html", OUTPUT / "labs" / "README.md")
    for number in range(1, 10):
        extract(HTML / f"M{number}.html", OUTPUT / "labs" / f"M{number}.md")


if __name__ == "__main__":
    main()
