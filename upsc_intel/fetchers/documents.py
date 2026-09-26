"""Premium route 2: your downloaded PDFs / HTML / text notes, dropped into ./inbox.

Coaching monthly magazines, e-paper PDFs, class notes: each page (PDF) or heading section
(HTML/Markdown) becomes a searchable, GS-tagged item in the Library tab, linking straight back
to the file at the right page. Files are re-indexed only when they change.
"""
from __future__ import annotations

import calendar
import re
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import quote

from bs4 import BeautifulSoup

from ..models import RawItem
from ..pipeline.normalize import IST, collapse

EXTS = {".pdf", ".html", ".htm", ".txt", ".md"}
MONTHS = {m.lower(): i for i, m in enumerate(calendar.month_name) if m}
MONTHS.update({m.lower(): i for i, m in enumerate(calendar.month_abbr) if m})


def doc_title(path: Path) -> str:
    return collapse(re.sub(r"[_\-]+", " ", path.stem)).strip() or path.name


def doc_date(path: Path) -> datetime:
    name = path.stem.lower()
    m = re.search(r"(20\d\d)[-_ .]?(0[1-9]|1[0-2])(?:[-_ .]?(0[1-9]|[12]\d|3[01]))?", name)
    if m:
        return datetime(int(m.group(1)), int(m.group(2)), int(m.group(3) or 1), 12, tzinfo=IST)
    year = re.search(r"(20\d\d)", name)
    for word in re.findall(r"[a-z]+", name):
        if word in MONTHS and year:
            return datetime(int(year.group(1)), MONTHS[word], 1, 12, tzinfo=IST)
    return datetime.fromtimestamp(path.stat().st_mtime, tz=timezone.utc)


def _heading(text: str) -> str | None:
    for line in text.splitlines()[:25]:
        line = collapse(line)
        words = line.split()
        if not (3 <= len(words) <= 16) or not (12 <= len(line) <= 140) or line.endswith((".", ",", ";")):
            continue
        letters = [c for c in line if c.isalpha()]
        if len(letters) < 0.7 * len(line.replace(" ", "")):
            continue
        caps = sum(1 for w in words if w[0].isupper())
        if line.isupper() or caps >= 0.6 * len(words):
            return line.title() if line.isupper() else line
    return None


def sections_pdf(path: Path) -> list[tuple[str | None, str, int]]:
    from pypdf import PdfReader

    out = []
    reader = PdfReader(str(path))
    for i, page in enumerate(reader.pages, start=1):
        try:
            text = page.extract_text() or ""
        except Exception:
            text = ""
        if len(collapse(text)) < 200:
            continue  # covers, adverts, image-only pages
        out.append((_heading(text), text, i))
    return out


def sections_html(path: Path) -> list[tuple[str | None, str, int]]:
    soup = BeautifulSoup(path.read_text(encoding="utf-8", errors="ignore"), "html.parser")
    for tag in soup(["script", "style", "nav", "footer"]):
        tag.decompose()
    heads = soup.find_all(["h1", "h2", "h3"])
    if not heads:
        return [(None, soup.get_text("\n", strip=True), 1)]
    out = []
    for n, h in enumerate(heads, start=1):
        chunks = []
        for sib in h.find_all_next():
            if sib in heads:
                break
            if sib.name in {"p", "li", "td"}:
                chunks.append(sib.get_text(" ", strip=True))
        body = "\n".join(chunks)
        if len(body) > 80:
            out.append((collapse(h.get_text(" ", strip=True)), body, n))
    return out


def sections_text(path: Path) -> list[tuple[str | None, str, int]]:
    text = path.read_text(encoding="utf-8", errors="ignore")
    parts = re.split(r"(?m)^#{1,3}\s+(.+)$", text)
    if len(parts) > 1:
        out = []
        for n, i in enumerate(range(1, len(parts), 2), start=1):
            body = parts[i + 1] if i + 1 < len(parts) else ""
            if len(body.strip()) > 80:
                out.append((collapse(parts[i]), body, n))
        return out
    blocks = [b for b in re.split(r"\n\s*\n", text) if len(b.strip()) > 80]
    return [(_heading(b), b, n) for n, b in enumerate(blocks, start=1)]


def extract_sections(path: Path) -> list[tuple[str | None, str, int]]:
    ext = path.suffix.lower()
    if ext == ".pdf":
        return sections_pdf(path)
    if ext in {".html", ".htm"}:
        return sections_html(path)
    return sections_text(path)


def fetch_documents(ctx, step: dict, src: dict) -> list[RawItem]:
    inbox: Path = ctx.settings.inbox_dir
    if not inbox.exists():
        return []
    items: list[RawItem] = []
    known = {r["path"]: r["mtime"] for r in ctx.db.q("SELECT path, mtime FROM documents")}
    present: set[str] = set()
    for path in sorted(inbox.rglob("*")):
        if not path.is_file() or path.suffix.lower() not in EXTS or path.name.startswith("."):
            continue
        rel = path.relative_to(inbox).as_posix()
        present.add(rel)
        mtime = path.stat().st_mtime
        if known.get(rel) == mtime:
            continue
        # changed or new → drop old sections, re-index
        ctx.stale_story_ids.extend(ctx.db.delete_items("source_id='library' AND json_extract(extra,'$.doc')=?", (rel,)))
        title = doc_title(path)
        published = doc_date(path)
        try:
            sections = extract_sections(path)
        except Exception as exc:  # a broken PDF shouldn't stop the run
            ctx.warnings.append(f"library: could not read {rel}: {exc}")
            sections = []
        is_pdf = path.suffix.lower() == ".pdf"
        for head, body, n in sections:
            text = collapse(body)
            label = head or (f"{title}: page {n}" if is_pdf else f"{title}: section {n}")
            anchor = f"#page={n}" if is_pdf else ""
            items.append(RawItem(
                title=label[:200],
                url=f"/files/{quote(rel)}{anchor}",
                summary=text[:600],
                content=text[:15000],
                published=published.astimezone(timezone.utc),
                publisher=title,
                guid=f"doc:{rel}:{n}",
                extra={"doc": rel, "page": n if is_pdf else None, "section": n},
            ))
        ctx.db.x(
            "INSERT INTO documents (path, mtime, n_sections, indexed_at) VALUES (?,?,?,?) "
            "ON CONFLICT(path) DO UPDATE SET mtime=excluded.mtime, n_sections=excluded.n_sections, "
            "indexed_at=excluded.indexed_at",
            (rel, mtime, len(sections), datetime.now(timezone.utc).isoformat(timespec="seconds")),
        )
    for rel in set(known) - present:  # file removed from inbox
        ctx.stale_story_ids.extend(ctx.db.delete_items("source_id='library' AND json_extract(extra,'$.doc')=?", (rel,)))
        ctx.db.x("DELETE FROM documents WHERE path=?", (rel,))
    return items
