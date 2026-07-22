#!/usr/bin/env python3
"""Heuristically audit whether each detailed chapter names every lecture slide topic."""

from __future__ import annotations

import re
import sys
import unicodedata
from pathlib import Path


ROOT = Path(__file__).resolve().parent.parent
SOURCES = ROOT / "sources" / "notes"
CHAPTERS = ROOT / "tutorial" / "lectures"


def normalize(text: str) -> str:
    text = re.sub(r"\[([^]]+)\]\([^)]+\)", r"\1", text)
    text = text.replace("\\", "")
    text = text.replace("cont’d", "").replace("cont'd", "").replace("cont’d", "")
    text = unicodedata.normalize("NFKC", text).casefold()
    return "".join(character for character in text if character.isalnum())


def source_topics(path: Path) -> list[tuple[str, str]]:
    seen: set[str] = set()
    topics: list[tuple[str, str]] = []
    for line in path.read_text(encoding="utf-8").splitlines():
        if not line.startswith("# "):
            continue
        title = line[2:].strip()
        key = normalize(title)
        if not key or key in seen or key in {"takeaways", "阅读材料"}:
            continue
        seen.add(key)
        topics.append((title, key))
    return topics


def chapter_for(number: int) -> Path | None:
    candidates = sorted(CHAPTERS.glob(f"{number:02}-*.md"))
    return candidates[0] if len(candidates) == 1 else None


def main() -> int:
    failed = False
    total_topics = 0
    total_covered = 0
    total_lines = 0
    chapter_count = 0
    for number in range(1, 31):
        source = SOURCES / f"lect{number:02}.md"
        chapter = chapter_for(number)
        if chapter is None:
            print(f"L{number:02}: MISSING CHAPTER")
            failed = True
            continue
        chapter_text = normalize(chapter.read_text(encoding="utf-8"))
        topics = source_topics(source)
        missing = [title for title, key in topics if key not in chapter_text]
        lines = len(chapter.read_text(encoding="utf-8").splitlines())
        covered = len(topics) - len(missing)
        chapter_count += 1
        total_topics += len(topics)
        total_covered += covered
        total_lines += lines
        print(
            f"L{number:02}: {covered}/{len(topics)} named topics; "
            f"{lines} lines; {chapter.name}"
        )
        if lines < 180 or missing:
            failed = True
        for title in missing:
            print(f"  - missing: {title}")
    print(
        f"TOTAL: {total_covered}/{total_topics} named topics; "
        f"{total_lines} lines across {chapter_count}/30 chapters"
    )
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
