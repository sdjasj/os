#!/usr/bin/env python3
"""Validate downloaded course coverage and authored Markdown links."""

from __future__ import annotations

import re
from pathlib import Path


ROOT = Path(__file__).resolve().parent.parent

LECTURE_CHAPTERS = [
    "01-os-overview.md",
    "02-application-view.md",
    "03-hardware-view.md",
    "04-scaling-agentic-ai.md",
    "05-programs-processes.md",
    "06-address-space.md",
    "07-os-objects.md",
    "08-terminal-shell.md",
    "09-libc-1.md",
    "10-libc-2.md",
    "11-executable-linking.md",
    "12-application-ecosystem.md",
    "13-multiprocessor.md",
    "14-mutual-exclusion.md",
    "15-condition-variables.md",
    "16-semaphores.md",
    "17-concurrency-bugs.md",
    "18-parallel-algorithms.md",
    "19-async-model.md",
    "20-cpu-gpu-simt.md",
    "21-token-journey.md",
    "22-io-devices.md",
    "23-storage.md",
    "24-filesystem-api-1.md",
    "25-filesystem-api-2.md",
    "26-filesystem-implementation.md",
    "27-databases.md",
    "28-security.md",
    "29-vm-containers.md",
    "30-course-summary.md",
]


def require(path: Path, errors: list[str]) -> None:
    if not path.exists():
        errors.append(f"missing: {path.relative_to(ROOT)}")


def check_local_links(document: Path, errors: list[str]) -> None:
    text = document.read_text(encoding="utf-8")
    # Assembly and C examples can legitimately contain text such as
    # ``GOT[x](%rip)``.  Remove code before interpreting Markdown link syntax.
    prose = re.sub(r"```.*?```", "", text, flags=re.DOTALL)
    prose = re.sub(r"`[^`\n]*`", "", prose)
    for match in re.finditer(r"\[[^\]]*\]\(([^)]+)\)", prose):
        target = match.group(1).strip()
        if target.startswith(("http://", "https://", "mailto:", "#", "/")):
            continue
        target = target.split("#", 1)[0]
        if not target:
            continue
        resolved = (document.parent / target).resolve()
        if not resolved.exists():
            errors.append(
                f"broken link: {document.relative_to(ROOT)} -> {target}"
            )


def check_markdown_shape(document: Path, errors: list[str]) -> None:
    text = document.read_text(encoding="utf-8")
    if text.count("```") % 2:
        errors.append(f"unpaired code fence: {document.relative_to(ROOT)}")


def main() -> int:
    errors: list[str] = []
    html = ROOT / "sources" / "site_html"
    notes = ROOT / "sources" / "notes"

    for number in range(1, 31):
        require(html / f"lect{number:02}.html", errors)
        require(notes / f"lect{number:02}.md", errors)
    for number in range(1, 10):
        require(html / f"M{number}.html", errors)
        require(notes / "labs" / f"M{number}.md", errors)
    for number in range(1, 18):
        require(
            next(
                iter(sorted((ROOT / "tutorial").glob(f"{number:02}-*.md"))),
                ROOT / "tutorial" / f"{number:02}-MISSING.md",
            ),
            errors,
        )

    lecture_dir = ROOT / "tutorial" / "lectures"
    for filename in LECTURE_CHAPTERS:
        chapter = lecture_dir / filename
        require(chapter, errors)
        if chapter.exists():
            line_count = len(chapter.read_text(encoding="utf-8").splitlines())
            if line_count < 300:
                errors.append(
                    f"lecture chapter too short ({line_count} lines): "
                    f"{chapter.relative_to(ROOT)}"
                )

    authored = [ROOT / "README.md", ROOT / "sources" / "README.md"]
    authored.extend(sorted((ROOT / "tutorial").glob("*.md")))
    authored.extend(sorted(lecture_dir.glob("*.md")))
    authored.append(ROOT / "examples" / "README.md")
    for document in authored:
        check_local_links(document, errors)
        check_markdown_shape(document, errors)
    for document in notes.rglob("*.md"):
        check_local_links(document, errors)

    image_references: set[str] = set()
    for page in html.glob("*.html"):
        image_references.update(
            re.findall(r'src="(static/img/[^"]+)"', page.read_text(encoding="utf-8"))
        )
    for reference in image_references:
        require(html / reference, errors)

    if errors:
        print("validation failed:")
        for error in errors:
            print(f"- {error}")
        return 1

    print(
        "validated: 30 lectures, 9 MiniLabs, "
        f"17 thematic chapters, 30 detailed lecture chapters, "
        f"{len(image_references)} course images, "
        f"{len(authored)} authored Markdown files"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
