"""SQLite storage (WAL + FTS5). One connection shared across threads behind a lock."""
from __future__ import annotations

import json
import sqlite3
import threading
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Iterable

SCHEMA = """
PRAGMA journal_mode=WAL;
PRAGMA synchronous=NORMAL;

CREATE TABLE IF NOT EXISTS items (
    id TEXT PRIMARY KEY,
    source_id TEXT NOT NULL,
    source_name TEXT,
    section TEXT,
    publisher TEXT,
    kind TEXT,
    tier TEXT,
    url TEXT,
    title TEXT,
    summary TEXT,
    published_at TEXT,
    fetched_at TEXT,
    date_ist TEXT,
    is_editorial INTEGER DEFAULT 0,
    is_library INTEGER DEFAULT 0,
    is_private INTEGER DEFAULT 0,
    story_id TEXT,
    tokens TEXT,
    subjects TEXT,
    tags TEXT,
    watch TEXT,
    score REAL,
    extra TEXT
);
CREATE INDEX IF NOT EXISTS idx_items_date ON items(date_ist);
CREATE INDEX IF NOT EXISTS idx_items_story ON items(story_id);
CREATE INDEX IF NOT EXISTS idx_items_source ON items(source_id);

CREATE TABLE IF NOT EXISTS stories (
    id TEXT PRIMARY KEY,
    title TEXT,
    url TEXT,
    date_ist TEXT,
    dates TEXT,
    first_seen TEXT,
    last_seen TEXT,
    updated_at TEXT,
    n_items INTEGER,
    n_publishers INTEGER,
    publishers TEXT,
    subjects TEXT,
    gs TEXT,
    tags TEXT,
    watch TEXT,
    score REAL,
    grade TEXT,
    is_editorial INTEGER DEFAULT 0,
    is_library INTEGER DEFAULT 0,
    is_private INTEGER DEFAULT 0,
    tier TEXT,
    summary TEXT,
    tokens TEXT,
    ai TEXT
);
CREATE INDEX IF NOT EXISTS idx_stories_last_seen ON stories(last_seen);
CREATE INDEX IF NOT EXISTS idx_stories_date ON stories(date_ist);

CREATE TABLE IF NOT EXISTS story_dates (
    story_id TEXT NOT NULL,
    date_ist TEXT NOT NULL,
    PRIMARY KEY (story_id, date_ist)
);
CREATE INDEX IF NOT EXISTS idx_story_dates_date ON story_dates(date_ist);

CREATE TABLE IF NOT EXISTS marks (
    story_id TEXT PRIMARY KEY,
    starred INTEGER DEFAULT 0,
    read INTEGER DEFAULT 0,
    note TEXT DEFAULT '',
    updated_at TEXT
);

CREATE TABLE IF NOT EXISTS runs (
    id TEXT PRIMARY KEY,
    started_at TEXT,
    finished_at TEXT,
    n_sources INTEGER,
    n_ok INTEGER,
    n_items INTEGER,
    n_new INTEGER,
    n_new_stories INTEGER,
    note TEXT
);

CREATE TABLE IF NOT EXISTS fetch_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id TEXT,
    source_id TEXT,
    step INTEGER,
    step_kind TEXT,
    ok INTEGER,
    n_items INTEGER,
    n_new INTEGER,
    error TEXT,
    started_at TEXT,
    duration_ms INTEGER
);
CREATE INDEX IF NOT EXISTS idx_fetch_log_source ON fetch_log(source_id, id);

CREATE TABLE IF NOT EXISTS source_state (
    source_id TEXT PRIMARY KEY,
    active_step INTEGER DEFAULT 0,
    fail_streak INTEGER DEFAULT 0,
    runs_since_probe INTEGER DEFAULT 0,
    last_attempt_at TEXT,
    last_ok_at TEXT,
    last_error TEXT,
    last_count INTEGER DEFAULT 0,
    last_step_kind TEXT,
    total_items INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS documents (
    path TEXT PRIMARY KEY,
    mtime REAL,
    n_sections INTEGER,
    indexed_at TEXT
);

CREATE TABLE IF NOT EXISTS seen_keys (
    key TEXT PRIMARY KEY,
    seen_at TEXT
);

CREATE VIRTUAL TABLE IF NOT EXISTS items_fts USING fts5(
    item_id UNINDEXED, title, body, tokenize='porter unicode61'
);
"""

JSON_COLS_ITEMS = {"tokens", "subjects", "tags", "watch", "extra"}
JSON_COLS_STORIES = {"dates", "publishers", "subjects", "gs", "tags", "watch", "tokens", "ai"}


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


def iso(dt: datetime | None) -> str | None:
    return dt.astimezone(timezone.utc).isoformat(timespec="seconds") if dt else None


def _dump(v: Any) -> str | None:
    return None if v is None else json.dumps(v, ensure_ascii=False)


def _load(v: str | None) -> Any:
    if v is None or v == "":
        return None
    try:
        return json.loads(v)
    except (TypeError, ValueError):
        return v


class DB:
    def __init__(self, path: Path | str):
        self.path = Path(path)
        if str(path) != ":memory:":
            self.path.parent.mkdir(parents=True, exist_ok=True)
        self.conn = sqlite3.connect(str(path), check_same_thread=False, timeout=30)
        self.conn.row_factory = sqlite3.Row
        self.lock = threading.RLock()
        with self.lock:
            self.conn.executescript(SCHEMA)

    # ── low level ──
    def q(self, sql: str, params: Iterable = ()) -> list[sqlite3.Row]:
        with self.lock:
            return self.conn.execute(sql, tuple(params)).fetchall()

    def x(self, sql: str, params: Iterable = ()) -> sqlite3.Cursor:
        with self.lock:
            return self.conn.execute(sql, tuple(params))

    def commit(self) -> None:
        with self.lock:
            self.conn.commit()

    def close(self) -> None:
        with self.lock:
            self.conn.close()

    # ── items ──
    def existing_item_ids(self, ids: list[str]) -> set[str]:
        found: set[str] = set()
        for i in range(0, len(ids), 500):
            chunk = ids[i:i + 500]
            rows = self.q(f"SELECT id FROM items WHERE id IN ({','.join('?' * len(chunk))})", chunk)
            found.update(r["id"] for r in rows)
        return found

    def insert_item(self, item: dict) -> bool:
        item = dict(item)
        content = item.pop("_content", "") or ""
        cols = list(item.keys())
        vals = [_dump(item[c]) if c in JSON_COLS_ITEMS else item[c] for c in cols]
        with self.lock:
            cur = self.conn.execute(
                f"INSERT OR IGNORE INTO items ({','.join(cols)}) VALUES ({','.join('?' * len(cols))})", vals
            )
            if cur.rowcount == 0:
                return False
            self.conn.execute(
                "INSERT INTO items_fts (item_id, title, body) VALUES (?,?,?)",
                (item["id"], item.get("title") or "", (item.get("summary") or "") + "\n" + content),
            )
            return True

    def update_item(self, item_id: str, **fields: Any) -> None:
        if not fields:
            return
        sets = ", ".join(f"{k}=?" for k in fields)
        vals = [_dump(v) if k in JSON_COLS_ITEMS else v for k, v in fields.items()]
        self.x(f"UPDATE items SET {sets} WHERE id=?", [*vals, item_id])

    def items_for_story(self, story_id: str) -> list[dict]:
        return [self._item_row(r) for r in self.q("SELECT * FROM items WHERE story_id=? ORDER BY published_at", (story_id,))]

    def all_items(self, where: str = "1=1", params: Iterable = ()) -> list[dict]:
        return [self._item_row(r) for r in self.q(f"SELECT * FROM items WHERE {where}", params)]

    def delete_items(self, where: str, params: Iterable = ()) -> list[str]:
        """Delete items; returns the story ids they belonged to."""
        with self.lock:
            rows = self.conn.execute(f"SELECT id, story_id FROM items WHERE {where}", tuple(params)).fetchall()
            ids = [r["id"] for r in rows]
            for i in range(0, len(ids), 500):
                chunk = ids[i:i + 500]
                ph = ",".join("?" * len(chunk))
                self.conn.execute(f"DELETE FROM items WHERE id IN ({ph})", chunk)
                self.conn.execute(f"DELETE FROM items_fts WHERE item_id IN ({ph})", chunk)
            return sorted({r["story_id"] for r in rows if r["story_id"]})

    @staticmethod
    def _item_row(r: sqlite3.Row) -> dict:
        d = dict(r)
        for c in JSON_COLS_ITEMS:
            if c in d:
                d[c] = _load(d[c])
        return d

    # ── stories ──
    def upsert_story(self, story: dict) -> None:
        cols = list(story.keys())
        vals = [_dump(story[c]) if c in JSON_COLS_STORIES else story[c] for c in cols]
        updates = ",".join(f"{c}=excluded.{c}" for c in cols if c not in {"id", "ai"})
        with self.lock:
            self.conn.execute(
                f"INSERT INTO stories ({','.join(cols)}) VALUES ({','.join('?' * len(cols))}) "
                f"ON CONFLICT(id) DO UPDATE SET {updates}",
                vals,
            )
            self.conn.execute("DELETE FROM story_dates WHERE story_id=?", (story["id"],))
            self.conn.executemany(
                "INSERT OR IGNORE INTO story_dates (story_id, date_ist) VALUES (?,?)",
                [(story["id"], d) for d in (story.get("dates") or [])],
            )

    def delete_story(self, story_id: str) -> None:
        with self.lock:
            self.conn.execute("DELETE FROM stories WHERE id=?", (story_id,))
            self.conn.execute("DELETE FROM story_dates WHERE story_id=?", (story_id,))

    def set_story_ai(self, story_id: str, ai: dict) -> None:
        self.x("UPDATE stories SET ai=?, updated_at=? WHERE id=?", (_dump(ai), iso(utcnow()), story_id))

    def get_story(self, story_id: str) -> dict | None:
        rows = self.q("SELECT * FROM stories WHERE id=?", (story_id,))
        return self._story_row(rows[0]) if rows else None

    def recent_stories(self, since_iso: str, library: bool = False) -> list[dict]:
        rows = self.q(
            "SELECT id, title, tokens, last_seen, date_ist FROM stories WHERE last_seen >= ? AND is_library=?",
            (since_iso, 1 if library else 0),
        )
        return [self._story_row(r) for r in rows]

    def stories_between(self, date_from: str, date_to: str, *, include_low: bool = False,
                        library: bool | None = False, include_private: bool = True,
                        since: str | None = None) -> list[dict]:
        where = ["s.id IN (SELECT story_id FROM story_dates WHERE date_ist BETWEEN ? AND ?)"]
        params: list[Any] = [date_from, date_to]
        if not include_low:
            where.append("s.grade != 'LOW'")
        if library is not None:
            where.append("s.is_library = ?")
            params.append(1 if library else 0)
        if not include_private:
            where.append("s.is_private = 0")
        if since:
            where.append("s.updated_at > ?")
            params.append(since)
        rows = self.q(f"SELECT s.* FROM stories s WHERE {' AND '.join(where)} ORDER BY s.score DESC", params)
        return self._with_sources([self._story_row(r) for r in rows], include_private=include_private)

    def stories_by_ids(self, ids: list[str]) -> list[dict]:
        if not ids:
            return []
        out = []
        for i in range(0, len(ids), 500):
            chunk = ids[i:i + 500]
            rows = self.q(f"SELECT * FROM stories WHERE id IN ({','.join('?' * len(chunk))})", chunk)
            out.extend(self._story_row(r) for r in rows)
        return self._with_sources(out)

    def library_stories(self) -> list[dict]:
        rows = self.q("SELECT * FROM stories WHERE is_library=1 ORDER BY date_ist DESC, id")
        return self._with_sources([self._story_row(r) for r in rows])

    def _with_sources(self, stories: list[dict], include_private: bool = True) -> list[dict]:
        if not stories:
            return stories
        by_id = {s["id"]: s for s in stories}
        for s in stories:
            s["sources"] = []
        ids = list(by_id)
        for i in range(0, len(ids), 500):
            chunk = ids[i:i + 500]
            extra = "" if include_private else " AND is_private=0"
            rows = self.q(
                "SELECT story_id, publisher, section, url, title, published_at, tier, kind FROM items "
                f"WHERE story_id IN ({','.join('?' * len(chunk))}){extra} ORDER BY published_at",
                chunk,
            )
            for r in rows:
                by_id[r["story_id"]]["sources"].append({
                    "publisher": r["publisher"], "section": r["section"], "url": r["url"],
                    "title": r["title"], "published": r["published_at"], "tier": r["tier"], "kind": r["kind"],
                })
        return stories

    @staticmethod
    def _story_row(r: sqlite3.Row) -> dict:
        d = dict(r)
        for c in JSON_COLS_STORIES:
            if c in d:
                d[c] = _load(d[c])
        return d

    def search(self, query: str, limit: int = 200) -> list[str]:
        """Full-text search across all items ever stored; returns story ids by relevance."""
        terms = [t for t in "".join(ch if ch.isalnum() else " " for ch in query).split() if t]
        if not terms:
            return []
        fts = " ".join(f'"{t}"*' for t in terms)
        rows = self.q(
            "SELECT i.story_id AS sid, MIN(m.rank) AS rank FROM "
            "(SELECT item_id, bm25(items_fts) AS rank FROM items_fts WHERE items_fts MATCH ? "
            " ORDER BY rank LIMIT 5000) m "
            "JOIN items i ON i.id = m.item_id WHERE i.story_id IS NOT NULL "
            "GROUP BY i.story_id ORDER BY rank LIMIT ?",
            (fts, limit),
        )
        return [r["sid"] for r in rows]

    # ── marks ──
    def get_marks(self) -> dict[str, dict]:
        return {r["story_id"]: {"starred": bool(r["starred"]), "read": bool(r["read"]), "note": r["note"] or ""}
                for r in self.q("SELECT * FROM marks")}

    def set_mark(self, story_id: str, starred: bool | None = None, read: bool | None = None,
                 note: str | None = None) -> dict:
        cur = self.get_marks().get(story_id, {"starred": False, "read": False, "note": ""})
        if starred is not None:
            cur["starred"] = bool(starred)
        if read is not None:
            cur["read"] = bool(read)
        if note is not None:
            cur["note"] = note
        self.x(
            "INSERT INTO marks (story_id, starred, read, note, updated_at) VALUES (?,?,?,?,?) "
            "ON CONFLICT(story_id) DO UPDATE SET starred=excluded.starred, read=excluded.read, "
            "note=excluded.note, updated_at=excluded.updated_at",
            (story_id, int(cur["starred"]), int(cur["read"]), cur["note"], iso(utcnow())),
        )
        self.commit()
        return cur

    # ── source state / logs / runs ──
    def get_source_state(self, source_id: str) -> dict:
        rows = self.q("SELECT * FROM source_state WHERE source_id=?", (source_id,))
        if rows:
            return dict(rows[0])
        return {"source_id": source_id, "active_step": 0, "fail_streak": 0, "runs_since_probe": 0,
                "last_attempt_at": None, "last_ok_at": None, "last_error": None, "last_count": 0,
                "last_step_kind": None, "total_items": 0}

    def all_source_states(self) -> dict[str, dict]:
        return {r["source_id"]: dict(r) for r in self.q("SELECT * FROM source_state")}

    def save_source_state(self, st: dict) -> None:
        cols = list(st.keys())
        self.x(
            f"INSERT INTO source_state ({','.join(cols)}) VALUES ({','.join('?' * len(cols))}) "
            f"ON CONFLICT(source_id) DO UPDATE SET {','.join(f'{c}=excluded.{c}' for c in cols if c != 'source_id')}",
            [st[c] for c in cols],
        )

    def log_fetch(self, **row: Any) -> None:
        cols = list(row.keys())
        self.x(f"INSERT INTO fetch_log ({','.join(cols)}) VALUES ({','.join('?' * len(cols))})", [row[c] for c in cols])

    def save_run(self, run: dict) -> None:
        cols = list(run.keys())
        self.x(
            f"INSERT INTO runs ({','.join(cols)}) VALUES ({','.join('?' * len(cols))}) "
            f"ON CONFLICT(id) DO UPDATE SET {','.join(f'{c}=excluded.{c}' for c in cols if c != 'id')}",
            [run[c] for c in cols],
        )
        self.commit()

    def last_run(self) -> dict | None:
        rows = self.q("SELECT * FROM runs WHERE finished_at IS NOT NULL ORDER BY finished_at DESC LIMIT 1")
        return dict(rows[0]) if rows else None

    def seen(self, key: str) -> bool:
        return bool(self.q("SELECT 1 FROM seen_keys WHERE key=?", (key,)))

    def mark_seen(self, key: str) -> None:
        self.x("INSERT OR IGNORE INTO seen_keys (key, seen_at) VALUES (?,?)", (key, iso(utcnow())))

    # ── meta ──
    def date_counts(self, days: int = 62) -> dict[str, int]:
        since = (utcnow() - timedelta(days=days)).date().isoformat()
        rows = self.q(
            "SELECT d.date_ist AS d, COUNT(*) AS n FROM story_dates d JOIN stories s ON s.id=d.story_id "
            "WHERE d.date_ist >= ? AND s.is_library=0 AND s.grade != 'LOW' GROUP BY d.date_ist ORDER BY d.date_ist",
            (since,),
        )
        return {r["d"]: r["n"] for r in rows}

    def date_range(self) -> tuple[str | None, str | None]:
        r = self.q("SELECT MIN(date_ist) AS a, MAX(date_ist) AS b FROM story_dates")[0]
        return r["a"], r["b"]

    def counts(self) -> dict[str, int]:
        return {
            "items": self.q("SELECT COUNT(*) AS n FROM items")[0]["n"],
            "stories": self.q("SELECT COUNT(*) AS n FROM stories WHERE is_library=0")[0]["n"],
            "library": self.q("SELECT COUNT(*) AS n FROM stories WHERE is_library=1")[0]["n"],
        }
