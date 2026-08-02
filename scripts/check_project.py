#!/usr/bin/env python3
"""Validate OS course coverage and the imported project tutorial library."""

from __future__ import annotations

import hashlib
import re
from pathlib import Path
from urllib.parse import unquote


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

PROJECT_TUTORIALS = {
    "cubesandbox": {"chapter_count": 11, "tutorial_dirs": ("guide",)},
    "e2b": {"chapter_count": 12, "tutorial_dirs": ("guide",)},
    "minimind": {
        "chapter_count": 24,
        "tutorial_dirs": ("main", "agentic-rl"),
    },
    "ray": {"chapter_count": 30, "tutorial_dirs": ("source", "usage")},
    "strix": {"chapter_count": 14, "tutorial_dirs": ("guide",)},
    "arvo": {"chapter_count": 2, "tutorial_dirs": ("guide",)},
    "mini-swe-agent": {"chapter_count": 1, "tutorial_dirs": ("guide",)},
    "openhands": {"chapter_count": 15, "tutorial_dirs": ("guide",)},
    "codex": {"chapter_count": 19, "tutorial_dirs": ("guide",)},
    "openclaw": {"chapter_count": 14, "tutorial_dirs": ("guide",)},
    "hands-on-modern-rl": {"chapter_count": 14, "tutorial_dirs": ("guide",)},
    "verl": {"chapter_count": 13, "tutorial_dirs": ("guide",)},
    "pwn-college": {
        "chapter_count": 67,
        "tutorial_dirs": (
            "docs/00-start-here",
            "docs/01-linux-luminarium",
            "docs/02-computing-101",
            "docs/03-playing-with-programs",
            "docs/04-intro-to-cybersecurity",
            "docs/05-program-security",
            "docs/06-system-security",
            "docs/07-software-exploitation",
            "docs/90-community",
            "docs/99-appendices",
        ),
    },
}

EXPECTED_PROJECT_CHAPTERS = 236
PROJECT_CHAPTER_SUMMARY = (
    "CubeSandbox 11, E2B 12, MiniMind 24, Ray 30, "
    "Strix 14, ARVO 2, mini-swe-agent 1, OpenHands 15, Codex 19, "
    "OpenClaw 14, Hands-On Modern RL 14, verl 13, pwn.college 67"
)
ALLOWED_PROJECT_SUFFIXES = {".md", ".py"}
NON_CHAPTER_DIRECTORY_NAMES = {"example", "examples", "sample", "samples"}
NON_CHAPTER_FILENAME = re.compile(
    r"^(?:readme|licen[cs]e|example|examples|sample|samples)"
    r"(?:[._-].*)?\.md$",
    flags=re.IGNORECASE,
)
FENCE_LINE = re.compile(r"^[ \t]{0,3}(`{3,}|~{3,})(.*)$")
H1_LINE = re.compile(r"^[ \t]{0,3}#[ \t]+\S")

SENSITIVE_CONTENT_RULES = (
    (
        "private key block",
        re.compile(
            r"-----BEGIN (?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----"
        ),
    ),
    ("AWS access key literal", re.compile(r"\b(?:AKIA|ASIA)[A-Z0-9]{16}\b")),
    (
        "GitHub token literal",
        re.compile(
            r"\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{50,})\b"
        ),
    ),
    (
        "API token literal",
        re.compile(r"\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{32,}\b"),
    ),
    ("Hugging Face token literal", re.compile(r"\bhf_[A-Za-z0-9]{30,}\b")),
    (
        "Slack token literal",
        re.compile(r"\bxox[baprs]-[A-Za-z0-9-]{24,}\b"),
    ),
    ("Google API key literal", re.compile(r"\bAIza[0-9A-Za-z_-]{35}\b")),
    (
        "live payment key literal",
        re.compile(r"\b(?:sk|rk)_live_[0-9A-Za-z]{20,}\b"),
    ),
)

PDF_LIBRARY_FILES = {
    "Agent_Architecture_Design_Tutorial_2026_Expanded.pdf": {
        "pages": 102,
        "sha256": "86aaa6512500b190ae680bef1373ed86d5860151aae3f35be99ac2f75ca3bd8a",
    },
    "CTF二进制与网络安全进阶教程_LaTeX精排版.pdf": {
        "pages": 86,
        "sha256": "d27b88978f3e3ddef0769408c7db6da857c8c033f61fee93b2acd592344bea30",
    },
    "LLM_Jailbreak_Zero_to_Defense_CN.pdf": {
        "pages": 137,
        "sha256": "7f6b0b59d92079464a512670e1d1fcda2728e039f557fde04a18ea1ab25210eb",
    },
    "LLM基础知识概念大全_教科书增强版.pdf": {
        "pages": 181,
        "sha256": "ff1f1e4e8c922b0b1e29c81d28372f6fac9a6fc6978e8776af5e2f37c726dbee",
    },
    "PMPP_CUDA_Tutorial_CN_Revised.pdf": {
        "pages": 191,
        "sha256": "2754caea367171b4c1c5fbac4ac4d498bb2ae4992fa91de9e2d5ae95a421b1cb",
    },
    "PPO_GRPO_DPO_From_Scratch_CN.pdf": {
        "pages": 81,
        "sha256": "19251965213584f3faab4459c4fc495e36ce0c8c9981ffbe044681b3538f5b08",
    },
    "cyber_benchmark_data_construction_report_zh.pdf": {
        "pages": 31,
        "sha256": "8a87718dcc722b9e3433ce163631b0a73b4e1abf978a221c181848a7e60c8f0c",
    },
    "大模型安全与智能体安全面试题库_小红书牛客归纳版.pdf": {
        "pages": 49,
        "sha256": "ac6b266a0f11caf303f349f3626dd9e01e2bafaa8197dc363edd1987d9faca75",
    },
    "大模型面经八股详解_小红书牛客汇总_公式修复版.pdf": {
        "pages": 22,
        "sha256": "cc269d1be106a7e2ccc804aa84c7190d258d4fc21cb82de68c251a65dfb4833b",
    },
    "网络安全面经八股详解_小红书与牛客整理.pdf": {
        "pages": 68,
        "sha256": "86f14d9196bf1e1fd18212f5c0103a04c7a497cffbf714fdcd0332d7499edf10",
    },
}


def require(path: Path, errors: list[str]) -> None:
    if not path.exists():
        errors.append(f"missing: {path.relative_to(ROOT)}")


def check_pdf_library(pdf_root: Path, errors: list[str]) -> tuple[int, int]:
    require(pdf_root, errors)
    if not pdf_root.is_dir():
        return 0, 0

    actual_names = {path.name for path in pdf_root.iterdir()}
    expected_names = set(PDF_LIBRARY_FILES)
    for filename in sorted(actual_names - expected_names):
        errors.append(f"unexpected PDF library file: pdf/{filename}")
    for filename in sorted(expected_names - actual_names):
        errors.append(f"missing PDF library file: pdf/{filename}")

    for filename, spec in PDF_LIBRARY_FILES.items():
        document = pdf_root / filename
        if not document.exists():
            continue
        relative_document = document.relative_to(ROOT)
        if document.is_symlink():
            errors.append(f"symbolic link not allowed: {relative_document}")
            continue
        if not document.is_file():
            errors.append(f"not a regular PDF file: {relative_document}")
            continue
        data = document.read_bytes()
        if not data.startswith(b"%PDF-"):
            errors.append(f"invalid PDF signature: {relative_document}")
        if len(data) > 95 * 1024 * 1024:
            errors.append(f"PDF exceeds safe GitHub object size: {relative_document}")
        digest = hashlib.sha256(data).hexdigest()
        if digest != spec["sha256"]:
            errors.append(f"PDF snapshot mismatch: {relative_document}")

    return len(PDF_LIBRARY_FILES), sum(
        int(spec["pages"]) for spec in PDF_LIBRARY_FILES.values()
    )


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


def markdown_prose_and_shape(text: str) -> tuple[str, bool, bool]:
    """Return prose, whether an H1 exists, and whether a fence is left open."""
    prose: list[str] = []
    open_fence: tuple[str, int] | None = None
    has_h1 = False

    for line in text.splitlines():
        fence = FENCE_LINE.match(line)
        if fence:
            marker, remainder = fence.groups()
            if open_fence is None:
                open_fence = (marker[0], len(marker))
                continue
            if (
                marker[0] == open_fence[0]
                and len(marker) >= open_fence[1]
                and not remainder.strip()
            ):
                open_fence = None
                continue
        if open_fence is not None:
            continue
        if H1_LINE.match(line):
            has_h1 = True
        prose.append(line)

    prose_text = "\n".join(prose)
    prose_text = re.sub(r"`[^`\n]*`", "", prose_text)
    return prose_text, has_h1, open_fence is not None


def is_within(path: Path, directory: Path) -> bool:
    try:
        path.relative_to(directory)
    except ValueError:
        return False
    return True


def is_imported_tutorial_link(
    resolved: Path,
    target: str,
    tutorial_dirs: tuple[Path, ...],
) -> bool:
    if resolved.is_file():
        return any(is_within(resolved, directory) for directory in tutorial_dirs)
    if resolved.parent in tutorial_dirs:
        return True

    # A link that names one of the imported tutorial roots is intended to be
    # internal even when it has the wrong number of ``..`` components.  Other
    # missing nested paths commonly refer to upstream docs that were not
    # imported and must not be treated as broken tutorial links.
    target_parts = [
        part.lower() for part in Path(target).parts if part not in {".", ".."}
    ]
    return bool(target_parts) and any(
        directory.name.lower() == target_parts[0] for directory in tutorial_dirs
    )


def check_project_markdown(
    document: Path,
    project_root: Path,
    tutorial_dirs: tuple[Path, ...],
    errors: list[str],
) -> None:
    text = document.read_text(encoding="utf-8")
    prose, has_h1, has_unpaired_fence = markdown_prose_and_shape(text)
    relative_document = document.relative_to(ROOT)

    if has_unpaired_fence:
        errors.append(f"unpaired code fence: {relative_document}")
    if not has_h1:
        errors.append(f"missing H1: {relative_document}")

    for match in re.finditer(r"\[[^\]]*\]\(([^)]+)\)", prose):
        target = match.group(1).strip()
        if target.startswith(
            ("http://", "https://", "mailto:", "data:", "tel:", "#", "/")
        ):
            continue
        if target.startswith("<") and ">" in target:
            target = target[1 : target.index(">")]
        else:
            target = target.split(maxsplit=1)[0]
        target = unquote(target.split("#", 1)[0].split("?", 1)[0])
        if not target.lower().endswith(".md"):
            continue

        resolved = (document.parent / target).resolve()
        if not is_imported_tutorial_link(resolved, target, tutorial_dirs):
            # Imported tutorials intentionally retain some links to upstream
            # source trees and datasets that are not part of this repository.
            continue
        target_parts = [
            part for part in Path(target).parts if part not in {".", ".."}
        ]
        candidates = [resolved]
        if target_parts and any(
            directory.name.lower() == target_parts[0].lower()
            for directory in tutorial_dirs
        ):
            # Some imported tracks were copied out of a shared upstream
            # tutorial directory.  The renderer preserves that upstream
            # repoPath, so a link such as ``agentic-rl/README.md`` from the
            # MiniMind main track maps to the imported sibling track.
            candidates.append((project_root / Path(*target_parts)).resolve())
        if not any(
            candidate.is_file()
            and any(is_within(candidate, directory) for directory in tutorial_dirs)
            for candidate in candidates
        ):
            errors.append(f"broken tutorial link: {relative_document} -> {target}")


def is_display_chapter(document: Path, project_root: Path) -> bool:
    relative = document.relative_to(project_root)
    if NON_CHAPTER_FILENAME.match(document.name):
        return False
    return not any(
        part.lower() in NON_CHAPTER_DIRECTORY_NAMES for part in relative.parts[:-1]
    )


def check_project_files(projects_root: Path, errors: list[str]) -> int:
    require(projects_root, errors)
    if not projects_root.is_dir():
        return 0

    project_markdown_count = 0
    chapter_total = 0
    actual_project_dirs = {
        path.name for path in projects_root.iterdir() if path.is_dir()
    }
    unexpected_project_dirs = actual_project_dirs - PROJECT_TUTORIALS.keys()
    for project_name in sorted(unexpected_project_dirs):
        errors.append(f"unexpected project directory: projects/{project_name}")

    for project_name, spec in PROJECT_TUTORIALS.items():
        project_root = projects_root / project_name
        require(project_root, errors)
        if not project_root.is_dir():
            continue

        tutorial_dirs = tuple(
            (project_root / directory).resolve()
            for directory in spec["tutorial_dirs"]
        )
        for directory in tutorial_dirs:
            require(directory, errors)

        chapters = {
            document
            for directory in tutorial_dirs
            if directory.is_dir()
            for document in directory.rglob("*.md")
            if is_display_chapter(document, project_root)
        }
        expected_count = spec["chapter_count"]
        if len(chapters) != expected_count:
            errors.append(
                f"chapter count mismatch: projects/{project_name} "
                f"(expected {expected_count}, found {len(chapters)})"
            )
        chapter_total += len(chapters)

        markdown_documents = sorted(project_root.rglob("*.md"))
        project_markdown_count += len(markdown_documents)
        for document in markdown_documents:
            check_project_markdown(document, project_root, tutorial_dirs, errors)

    if chapter_total != EXPECTED_PROJECT_CHAPTERS:
        errors.append(
            "project chapter total mismatch: "
            f"expected {EXPECTED_PROJECT_CHAPTERS}, found {chapter_total}"
        )

    for document in sorted(projects_root.rglob("*")):
        if not document.is_file():
            continue
        relative_document = document.relative_to(ROOT)
        if (
            document.name != "UPSTREAM_LICENSE"
            and document.suffix.lower() not in ALLOWED_PROJECT_SUFFIXES
        ):
            errors.append(
                "disallowed project file type: "
                f"{relative_document} (allowed: .md, .py, UPSTREAM_LICENSE)"
            )

        lower_name = document.name.lower()
        if lower_name == ".env" or lower_name.startswith(".env."):
            errors.append(f"sensitive file: {relative_document} (rule: .env file)")
        if (
            lower_name in {"id_rsa", "id_dsa", "id_ecdsa", "id_ed25519"}
            or document.suffix.lower() in {".key", ".pem", ".p12", ".pfx"}
        ):
            errors.append(
                f"sensitive file: {relative_document} (rule: private key filename)"
            )

        text = document.read_text(encoding="utf-8", errors="ignore")
        for rule_name, pattern in SENSITIVE_CONTENT_RULES:
            if pattern.search(text):
                errors.append(
                    f"sensitive content: {relative_document} (rule: {rule_name})"
                )

    return project_markdown_count


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

    project_markdown_count = check_project_files(ROOT / "projects", errors)
    pdf_count, pdf_page_count = check_pdf_library(ROOT / "pdf", errors)

    if errors:
        print("validation failed:")
        for error in errors:
            print(f"- {error}")
        return 1

    print(
        "validated: 30 lectures, 9 MiniLabs, "
        f"17 thematic chapters, 30 detailed lecture chapters, "
        f"{len(image_references)} course images, "
        f"{len(authored)} authored Markdown files, "
        f"{len(PROJECT_TUTORIALS)} imported project tutorials "
        f"({PROJECT_CHAPTER_SUMMARY}; "
        f"total {EXPECTED_PROJECT_CHAPTERS}), "
        f"{project_markdown_count} project Markdown files, "
        f"{pdf_count} public PDFs ({pdf_page_count} pages)"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
