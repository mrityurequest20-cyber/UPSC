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

CREATE TABLE IF NOT EXISTS videos (
    id TEXT PRIMARY KEY,
    channel TEXT,
    channel_id TEXT,
    title TEXT,
    url TEXT,
    published_at TEXT,
    date_ist TEXT,
    tokens TEXT,
    trusted INTEGER DEFAULT 1,
    source TEXT,
    seen_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_videos_date ON videos(date_ist);

CREATE TABLE IF NOT EXISTS brief_picks (
    date_ist TEXT NOT NULL,
    story_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    rank INTEGER,
    picked_at TEXT,
    PRIMARY KEY (date_ist, story_id)
);
CREATE INDEX IF NOT EXISTS idx_brief_story ON brief_picks(story_id);

-- the free full text of a brief card, read at build time (pipeline/articles.py); miss=1: no free copy yet
CREATE TABLE IF NOT EXISTS article_text (
    story_id TEXT PRIMARY KEY,
    url TEXT,
    domain TEXT,
    via TEXT,
    paragraphs TEXT,
    points TEXT,
    miss INTEGER DEFAULT 0,
    fetched_at TEXT
);

-- Gemini's same-event groups among a day's brief cards (pipeline/triage.py → dedupe); sig: the card ids it saw
CREATE TABLE IF NOT EXISTS ai_groups (
    day TEXT PRIMARY KEY,
    sig TEXT,
    ids TEXT,
    groups TEXT,
    at TEXT
);

-- the glossary (pipeline/glossary.py): each term once, with its two-line meaning; key: the term in lower case
CREATE TABLE IF NOT EXISTS glossary (
    key TEXT PRIMARY KEY,
    term TEXT,
    meaning TEXT,
    first_day TEXT,
    at TEXT
);

-- India in global indices (pipeline/rankings.py): each index's editions as articles reported them; id: key|edition
CREATE TABLE IF NOT EXISTS rankings (
    id TEXT PRIMARY KEY,
    index_key TEXT,
    name TEXT,
    publisher TEXT,
    edition TEXT,
    rank INTEGER,
    total INTEGER,
    previous INTEGER,
    score TEXT,
    why TEXT,
    day TEXT,
    story_id TEXT,
    url TEXT,
    source TEXT,
    at TEXT
);
CREATE TABLE IF NOT EXISTS index_checks (
    key TEXT PRIMARY KEY,
    at TEXT,
    found TEXT
);

-- places in the news (pipeline/glossary.py): each place once, with its coordinates; key: name|country in lower case
CREATE TABLE IF NOT EXISTS places (
    key TEXT PRIMARY KEY,
    name TEXT,
    kind TEXT,
    country TEXT,
    state TEXT,
    lat REAL,
    lon REAL,
    at TEXT
);

-- running topics (pipeline/glossary.py names them, pipeline/dossiers.py builds each one's timeline and story so far)
CREATE TABLE IF NOT EXISTS topics (
    key TEXT PRIMARY KEY,
    name TEXT,
    query TEXT,
    first_day TEXT,
    last_day TEXT,
    n INTEGER DEFAULT 0,
    sig TEXT,
    summary TEXT,
    summarized_sig TEXT,
    at TEXT
);

CREATE VIRTUAL TABLE IF NOT EXISTS items_fts USING fts5(
    item_id UNINDEXED, title, body, tokenize='porter unicode61'
);
"""

JSON_COLS_ITEMS = {"tokens", "subjects", "tags", "watch", "extra"}
JSON_COLS_STORIES = {"dates", "publishers", "subjects", "gs", "tags", "watch", "tokens", "ai", "video", "video_hi", "triage", "terms", "extras"}
MIGRATIONS = [  # (table, column, type): added when missing, so old databases keep working
    ("stories", "video", "TEXT"),
    ("stories", "video_checked_at", "TEXT"),
    ("items", "is_explained", "INTEGER DEFAULT 0"),
    ("stories", "is_explained", "INTEGER DEFAULT 0"),
    ("stories", "video_hi", "TEXT"),
    ("videos", "lang", "TEXT"),
    ("brief_picks", "tier", "TEXT"),  # "top" (Must-know card) / "prelims" (Prelims facts card) / "more" (the list)
    ("brief_picks", "lead", "TEXT"),  # folded into this story's card (same event, another outlet)
    ("article_text", "published", "TEXT"),  # the article's own publish date ("": the page doesn't say; NULL: not checked)
    ("stories", "triage", "TEXT"),  # Gemini's verdict for the brief: {upsc 0-3, subject, gs, prelims, why, t}
    ("stories", "terms", "TEXT"),  # the card's glossary keys (pipeline/glossary.py); [] when it has none
    ("stories", "ranking", "TEXT"),  # read for India's rank (pipeline/rankings.py): {key, rank}, or {} when it has none
    ("stories", "extras", "TEXT"),  # the card's places and running topics (pipeline/glossary.py): {places: [keys], topics: [keys]}
]


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
            for table, col, typ in MIGRATIONS:
                cols = {r[1] for r in self.conn.execute(f"PRAGMA table_info({table})")}
                if col not in cols:
                    self.conn.execute(f"ALTER TABLE {table} ADD COLUMN {col} {typ}")
            self.conn.commit()

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
        updates = ",".join(f"{c}=excluded.{c}" for c in cols if c not in {"id", "ai", "video", "video_hi", "video_checked_at"})
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

    def set_story_video(self, story_id: str, video: dict | None, checked_at: str | None,
                        video_hi: dict | None = None) -> None:
        """video: best English match (or a search link); video_hi: best Hindi match."""
        self.x("UPDATE stories SET video=?, video_hi=?, video_checked_at=? WHERE id=?",
               (_dump(video), _dump(video_hi), checked_at, story_id))

    # ── brief picks ──
    def save_brief(self, date_ist: str, picks: list[tuple]) -> None:
        """picks: [(story_id, kind, rank[, tier, lead])] for one day; replaces that day's picks."""
        now = iso(utcnow())
        rows = [(date_ist, p[0], p[1], p[2], p[3] if len(p) > 3 else "top", p[4] if len(p) > 4 else None, now)
                for p in picks]
        with self.lock:
            self.conn.execute("DELETE FROM brief_picks WHERE date_ist=?", (date_ist,))
            self.conn.executemany(
                "INSERT OR REPLACE INTO brief_picks (date_ist, story_id, kind, rank, tier, lead, picked_at) "
                "VALUES (?,?,?,?,?,?,?)", rows)

    def brief_between(self, date_from: str, date_to: str) -> list[dict]:
        return [dict(r) for r in self.q(
            "SELECT date_ist, story_id, kind, rank, COALESCE(tier, 'top') AS tier, lead FROM brief_picks "
            "WHERE date_ist BETWEEN ? AND ? ORDER BY date_ist, kind, rank", (date_from, date_to))]

    def brief_for_stories(self, ids: list[str]) -> dict[str, dict]:
        """{story_id: {"d": day, "k": kind, "t": tier, "l": lead}}: the brief each story was picked for
        (a story is picked on one day)."""
        out: dict[str, dict] = {}
        for i in range(0, len(ids), 500):
            chunk = ids[i:i + 500]
            for r in self.q(f"SELECT story_id, date_ist, kind, COALESCE(tier, 'top') AS tier, lead FROM brief_picks "
                            f"WHERE story_id IN ({','.join('?' * len(chunk))})", chunk):
                out[r["story_id"]] = {"d": r["date_ist"], "k": r["kind"], "t": r["tier"], "l": r["lead"]}
        return out

    def brief_dates(self, date_from: str, date_to: str) -> set[str]:
        return {r["date_ist"] for r in self.q(
            "SELECT DISTINCT date_ist FROM brief_picks WHERE date_ist BETWEEN ? AND ?", (date_from, date_to))}

    # ── videos ──
    def upsert_video(self, v: dict) -> bool:
        cols = list(v.keys())
        vals = [_dump(v[c]) if c == "tokens" else v[c] for c in cols]
        cur = self.x(f"INSERT OR IGNORE INTO videos ({','.join(cols)}) VALUES ({','.join('?' * len(cols))})", vals)
        return cur.rowcount > 0

    def videos_between(self, date_from: str, date_to: str) -> list[dict]:
        rows = self.q("SELECT * FROM videos WHERE date_ist BETWEEN ? AND ? ORDER BY published_at DESC",
                      (date_from, date_to))
        out = []
        for r in rows:
            d = dict(r)
            d["tokens"] = _load(d.get("tokens")) or []
            out.append(d)
        return out

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
                        since: str | None = None, ai: bool = False) -> list[dict]:
        """ai: Gemini's grades are on, so a story the rules graded LOW that Gemini rates 2 or 3 is included too
        (web/app.py ai_list then drops the ones Gemini grades LOW)."""
        where = ["s.id IN (SELECT story_id FROM story_dates WHERE date_ist BETWEEN ? AND ?)"]
        params: list[Any] = [date_from, date_to]
        if not include_low:
            where.append("(s.grade != 'LOW' OR COALESCE(json_extract(s.triage, '$.upsc'), 0) >= 2)" if ai
                         else "s.grade != 'LOW'")
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

    def articles(self, story_ids: list[str]) -> dict[str, dict]:
        """{story_id: {url, domain, via, paragraphs, points, miss, fetched_at}} for the stories that have a row."""
        out: dict[str, dict] = {}
        for i in range(0, len(story_ids), 500):
            chunk = story_ids[i:i + 500]
            for r in self.q(f"SELECT * FROM article_text WHERE story_id IN ({','.join('?' * len(chunk))})", chunk):
                d = dict(r)
                d["paragraphs"] = _load(d["paragraphs"]) or []
                d["points"] = _load(d["points"]) or []
                out[d["story_id"]] = d
        return out

    def save_article(self, story_id: str, row: dict) -> None:
        self.x("INSERT OR REPLACE INTO article_text (story_id, url, domain, via, paragraphs, points, miss, fetched_at, published) "
               "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
               (story_id, row.get("url"), row.get("domain"), row.get("via"), _dump(row.get("paragraphs") or []),
                _dump(row.get("points") or []), int(bool(row.get("miss"))), row.get("fetched_at"), row.get("published") or ""))

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
