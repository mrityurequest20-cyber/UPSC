"""Rule-based UPSC classifier: syllabus subjects → GS papers, Prelims tags, watch areas, examinability grade.

Offline, free and deterministic. All vocabulary lives in config/topics.yaml.
"""
from __future__ import annotations

import math
import re
from collections import defaultdict
from dataclasses import dataclass, field
from datetime import date

DEFAULT_TIERS = {"official": 3.0, "examprep": 2.5, "premium": 2.5, "quality": 1.5, "library": 2.0,
                 "watch": 1.25, "general": 1.0, "intl": 1.0}
PRELIMS_TAGS = {"Scheme", "Report/Index", "Species", "Place in news", "Award", "Day/Observance",
                "Exercise", "Appointment", "Agreement/MoU"}
GS_ORDER = ["GS1", "GS2", "GS3", "GS4", "Prelims"]
# "Prime Minister Narendra Modi", "EAM S. Jaishankar", "Chief Justice B.R. Gavai", "President Trump"
TITLED = re.compile(
    r"\b(Prime Minister|PM|President|Vice[- ]President|Chief Justice|CJI|Justice|External Affairs Minister|EAM|"
    r"Finance Minister|Home Minister|Defence Minister|Union Minister|Chief Minister|CM|Governor|Speaker|"
    r"Secretary[- ]General|Minister)\s+((?:[A-Z]\.\s?)*[A-Z][a-zA-Z'\-]+(?:\s+(?:[A-Z]\.\s?)*[A-Z][a-zA-Z'\-]+){0,2})")


def _norm(text: str) -> str:
    return re.sub(r"[\s\-]+", " ", text.strip())


# Scripts of outlets from other countries (Arabic/Persian/Urdu, Cyrillic, Hebrew, Thai, Sinhala, CJK, Korean).
# Devanagari and the other Indian scripts are Indian outlets, so they don't count.
FOREIGN_SCRIPT = re.compile(r"[\u0590-\u06FF\u0750-\u077F\u0400-\u04FF\u0E00-\u0E7F\u0D80-\u0DFF"
                            r"\u3040-\u30FF\u3400-\u9FFF\uAC00-\uD7AF]")
# Titles in a script other than Latin/Devanagari (a Tamil YouTube title): not readable in English or Hindi
OTHER_SCRIPT_TITLE = re.compile(r"[\u0980-\u0DFF\u0590-\u06FF\u0E00-\u0E7F\u3040-\u9FFF\uAC00-\uD7AF]")
TITLE_DATE = re.compile(r"\b(\d{1,2})\.(\d{1,2})\.(20\d\d)\b")  # "Above the Fold | 17.06.2026"


class TermMatcher:
    """Matches many weighted terms in one pass (two alternation regexes: case-sensitive and not)."""

    def __init__(self, entries: dict[str, list[tuple[str, float]]]):
        # entries: term → [(bucket, weight), ...]
        self.cs: dict[str, list[tuple[str, float]]] = {}
        self.ci: dict[str, list[tuple[str, float]]] = {}
        for term, vals in entries.items():
            term = str(term).strip()
            if not term:
                continue
            case_sensitive = " " not in term and any(c.isupper() for c in term)
            target = self.cs if case_sensitive else self.ci
            key = _norm(term) if case_sensitive else _norm(term).lower()
            target.setdefault(key, []).extend(vals)
        self.rx_cs = self._compile(self.cs, 0)
        self.rx_ci = self._compile(self.ci, re.I)

    @staticmethod
    def _compile(terms: dict, flags: int) -> re.Pattern | None:
        if not terms:
            return None
        alts = []
        for term in sorted(terms, key=len, reverse=True):
            esc = re.escape(term).replace(r"\ ", r"[\s\-]+")
            if term[-1].isalpha() and (term.islower() or flags == 0):
                esc += r"(?:s|es)?" if term.islower() else r"s?"
            alts.append(esc)
        return re.compile(r"(?<![A-Za-z0-9])(?:" + "|".join(alts) + r")(?![A-Za-z0-9])", flags)

    def find(self, text: str) -> dict[str, list[tuple[str, float]]]:
        """Distinct matched terms in text → their (bucket, weight) entries."""
        out: dict[str, list[tuple[str, float]]] = {}
        if not text:
            return out
        if self.rx_cs:
            for m in self.rx_cs.finditer(text):
                key = _norm(m.group(0))
                if key not in self.cs and key.endswith("s"):
                    key = key[:-1]
                if key in self.cs:
                    out[key] = self.cs[key]
        if self.rx_ci:
            for m in self.rx_ci.finditer(text):
                key = _norm(m.group(0)).lower()
                entry = self.ci.get(key)
                if entry is None:
                    for suf in ("es", "s"):
                        if key.endswith(suf) and key[: -len(suf)] in self.ci:
                            key = key[: -len(suf)]
                            entry = self.ci[key]
                            break
                if entry is not None:
                    out[key] = entry
        return out


@dataclass
class Analysis:
    subjects: list[str] = field(default_factory=list)
    subject_scores: dict[str, float] = field(default_factory=dict)
    signal: float = 0.0
    noise: float = 0.0
    tags: list[str] = field(default_factory=list)
    watch: list[str] = field(default_factory=list)
    india: bool = True
    foreign: str = ""  # "neighbourhood" / "world": another country's affairs with no India link
    foreign_local: bool = False  # …and nothing of wider consequence (no war, trade, summit, UN…)
    rejected: str = ""  # why it is not UPSC material at all (kept, graded LOW, never shown)


class Classifier:
    def __init__(self, topics: dict):
        topics = topics or {}
        sc = topics.get("scoring") or {}
        self.tier_weight = {**DEFAULT_TIERS, **(sc.get("tier_weight") or {})}
        self.subject_threshold = float(sc.get("subject_threshold", 2))
        self.max_subjects = int(sc.get("max_subjects", 3))
        self.no_subject_penalty = float(sc.get("no_subject_penalty", 1.5))
        self.require_subject = bool(sc.get("require_subject", False))
        self.reject_noise = float(sc.get("reject_noise", 0) or 0)  # noise at or above this = not UPSC material
        grades = sc.get("grades") or {}
        self.grade_cut = [("NOTE", float(grades.get("NOTE", 5.0))), ("SKIM", float(grades.get("SKIM", 3.2))),
                          ("READ", float(grades.get("READ", 1.6)))]
        # where rejected items land: far below READ, so that no coverage bonus can lift them into view
        # (and plain LOW items, well above it, still get their bonus)
        self.reject_score = self.grade_cut[-1][1] - 3.0

        self.subject_meta: dict[str, dict] = {}
        kw_entries: dict[str, list[tuple[str, float]]] = defaultdict(list)
        for sid, meta in (topics.get("subjects") or {}).items():
            self.subject_meta[sid] = {"label": meta.get("label", sid), "gs": meta.get("gs")}
            for term, w in (meta.get("kw") or {}).items():
                kw_entries[str(term)].append((sid, float(w)))
        self.kw = TermMatcher(kw_entries)
        self.signals = TermMatcher({str(t): [("s", float(w))] for t, w in (topics.get("signals") or {}).items()})
        self.noise = TermMatcher({str(t): [("n", float(w))] for t, w in (topics.get("noise") or {}).items()})
        self.noise_rx = [(float(w), re.compile(rx, re.I)) for w, rx in topics.get("noise_patterns") or []]
        self.tag_rx = {name: re.compile(p, re.I) for name, p in (topics.get("tags") or {}).items()}

        ia = topics.get("india_angle") or {}
        self.india_penalty = float(ia.get("penalty", 0))
        self.india_tiers = set(ia.get("applies_to") or [])
        self.india_terms = TermMatcher({str(t): [("i", 1.0)] for t in ia.get("terms") or []})
        self.india_exempt = TermMatcher({str(t): [("x", 1.0)] for t in ia.get("exempt") or []})
        # watch areas that are about India's region by definition (the neighbourhood); the others
        # (marine, DPI…) only count when the story is about India
        self.regional_watch = set(ia.get("regional_watch") or ["neighbourhood"])

        fa = topics.get("foreign_affairs") or {}
        self.foreign_penalty = float(fa.get("penalty", 0))
        self.neighbour_penalty = float(fa.get("neighbourhood_penalty", 0))
        self.foreign_move = set(fa.get("move_subjects") or [])
        self.foreign_terms = TermMatcher({str(t): [("f", 1.0)] for t in fa.get("countries") or []})
        self.neighbour_terms = TermMatcher({str(t): [("n", 1.0)] for t in fa.get("neighbourhood") or []})
        self.india_link = TermMatcher({str(t): [("i", 1.0)] for t in fa.get("india_link") or []})
        pubs = fa.get("publishers") or {}
        self.foreign_pubs = {str(p).lower(): "neighbourhood" for p in pubs.get("neighbourhood") or []}
        self.foreign_pubs.update({str(p).lower(): "world" for p in pubs.get("world") or []})
        self.foreign_domains = tuple(str(d).lower() for d in fa.get("publisher_domains") or [])
        self.ambiguous_links = {str(t) for t in fa.get("ambiguous_links") or []}
        self.foreign_local_penalty = float(fa.get("local_penalty", 0))
        # a foreign story stays in view only if it touches something of wider consequence
        self.world_terms = TermMatcher({str(t): [("w", 1.0)] for t in fa.get("world_affairs") or []})
        self.country_of = {str(n).lower(): str(canon) for canon, names in (fa.get("aliases") or {}).items()
                           for n in names}

        lv = topics.get("low_value_publishers") or {}
        self.low_value_penalty = float(lv.get("penalty", 0))
        self.low_value = {str(p).strip().lower() for p in lv.get("names") or []}
        self.blocked = {str(p).strip().lower() for p in topics.get("blocked_publishers") or []}

        gz = topics.get("gazetteer") or {}
        self.place_names = {str(t): str(t) for t in (gz.get("india") or []) + (gz.get("world") or [])}
        self.body_names = {str(t): str(t) for t in gz.get("bodies") or []}
        self.places_m = TermMatcher({t: [("p", 1.0)] for t in self.place_names})
        self.bodies_m = TermMatcher({t: [("b", 1.0)] for t in self.body_names})

        self.watch_meta: dict[str, str] = {}
        self.watch_rules: dict[str, list[TermMatcher]] = {}
        for wid, meta in (topics.get("watch_areas") or {}).items():
            self.watch_meta[wid] = meta.get("label", wid)
            groups = meta.get("all") or [meta.get("any") or []]
            self.watch_rules[wid] = [TermMatcher({str(t): [("w", 1.0)] for t in g}) for g in groups]

    # ── per item ──
    def _foreign_publisher(self, publisher: str) -> str:
        """An outlet from another country: listed by name, a foreign web domain, a foreign script,
        or a country in its name ("Radio Pakistan", "Business News Nigeria")."""
        name = publisher.strip()
        low = name.lower()
        if not low:
            return ""
        if low in self.foreign_pubs:
            return self.foreign_pubs[low]
        if FOREIGN_SCRIPT.search(name) or (self.foreign_domains and low.endswith(self.foreign_domains)):
            return "world"
        if self.foreign_terms.find(name):
            return "neighbourhood" if self.neighbour_terms.find(name) else "world"
        return ""

    def analyze(self, title: str, summary: str = "", hint: str = "", publisher: str = "", day: str = "") -> Analysis:
        """day: the item's IST date (spots republished old material such as "… | 17.06.2026")."""
        a = Analysis()
        scores: dict[str, float] = defaultdict(float)
        body = f"{summary} {hint}".strip()
        for text, mult in ((title, 2.0), (body, 1.0)):
            for _, entries in self.kw.find(text).items():
                for sid, w in entries:
                    scores[sid] += w * mult
        # another country's parliament / constitution / courts is world affairs, not Indian polity
        links = self.india_link.find(f"{title} {summary}")
        if links and self.foreign_terms.find(title) and set(links) <= self.ambiguous_links:
            links = {}  # "Punjab governor pushes for Made-in-Pakistan solar policy" is Pakistan's Punjab
        linked = links or self.india_exempt.find(title)
        if self.foreign_terms.find(title) and not linked:
            a.foreign = "neighbourhood" if self.neighbour_terms.find(title) else "world"
        elif publisher and not linked:  # only a foreign outlet carried it
            a.foreign = self._foreign_publisher(publisher)
        if a.foreign:
            moved = sum(scores.pop(s) for s in list(scores) if s in self.foreign_move)
            if moved and "ir" in self.subject_meta:
                scores["ir"] += moved
            # a Michigan summit, a Thai heritage listing, a Sri Lankan bill: nothing that reaches India.
            # Two countries in the headline (Trump-Xi, US-Iran) is world affairs; so is anything touching war,
            # trade, the UN… A neighbour's news is dropped only when it is its own legislation or courts.
            countries = {self.country_of.get(k.lower(), k.lower()) for k in self.foreign_terms.find(title)}
            a.foreign_local = (len(countries) < 2 and not self.world_terms.find(f"{title} {summary[:300]}")
                               and (a.foreign == "world" or bool(moved)))
        ranked = sorted(scores.items(), key=lambda kv: -kv[1])
        a.subject_scores = {k: round(v, 2) for k, v in ranked}
        a.subjects = [sid for sid, s in ranked if s >= self.subject_threshold][: self.max_subjects]

        a.signal = sum(w for es in self.signals.find(title).values() for _, w in es)
        a.signal += 0.5 * sum(w for k, es in self.signals.find(summary).items() for _, w in es)
        a.noise = sum(w for es in self.noise.find(title).values() for _, w in es)
        a.noise += 0.3 * sum(w for es in self.noise.find(summary[:400]).values() for _, w in es)
        a.noise += sum(w for w, rx in self.noise_rx if rx.search(title))
        pub = publisher.strip().lower()
        if pub and pub in self.low_value:
            a.noise += self.low_value_penalty
        if pub and title.strip().lower() == pub:  # a bare site name ("NITI Aayog") is not a story
            a.noise += 5
        if pub and pub in self.blocked:  # stock tickers, press releases, petitions, foreign local news
            a.noise += max(self.reject_noise, 10)
            a.rejected = "outlet that carries no UPSC material"
        if len(OTHER_SCRIPT_TITLE.findall(title)) >= 3:  # neither English nor Hindi
            a.noise += max(self.reject_noise, 10)
            a.rejected = "not in English or Hindi"
        if day:
            for m in TITLE_DATE.finditer(title):
                try:
                    dated = date(int(m.group(3)), int(m.group(2)), int(m.group(1)))
                    if (date.fromisoformat(day) - dated).days > 20:
                        a.noise += max(self.reject_noise, 10)
                        a.rejected = "old material republished"
                except ValueError:
                    pass
        if self.reject_noise and a.noise >= self.reject_noise and not a.rejected:
            a.rejected = "not UPSC material"

        head = f"{title} {summary[:220]}"
        a.tags = [name for name, rx in self.tag_rx.items() if rx.search(head)]
        full = f"{title} {summary}"
        india_hit = bool(self.india_terms.find(full) or self.india_link.find(full))
        # watch areas other than the neighbourhood (marine, DPI…) only count for stories about India:
        # a "blue economy week" in Maine is not India's blue economy
        a.watch = [wid for wid, groups in self.watch_rules.items()
                   if all(g.find(full) for g in groups) and (wid in self.regional_watch or india_hit)]
        if self.india_penalty:
            a.india = bool(india_hit or a.watch or self.india_exempt.find(full))
        return a

    def story_foreign(self, title: str, summary: str = "", publishers: list[str] | None = None) -> str:
        """Another country's affairs: named in the headline, or carried only by foreign outlets; no India link."""
        a = self.analyze(title, summary)
        if a.foreign:
            return a.foreign
        kinds = [self.foreign_pubs.get(str(p).strip().lower()) for p in publishers or []]
        if kinds and all(kinds) and not self.india_link.find(f"{title} {summary}"):
            return "neighbourhood" if "neighbourhood" in kinds else "world"
        return ""

    # ── the Where / Who lines of the write-ups: only names that occur in the text ──
    @staticmethod
    def _in_order(text: str, found: dict, names: dict) -> list[str]:
        lower = text.lower()
        canon = {_norm(n).lower(): n for n in names}
        out = []
        for key in found:
            name = canon.get(key.lower(), key)
            pos = lower.find(name.lower())
            out.append((pos if pos >= 0 else 10**6, name))
        seen, res = set(), []
        for _, name in sorted(out):
            if name.lower() not in seen and not any(name.lower() in r.lower() for r in res):
                seen.add(name.lower())
                res.append(name)
        return res

    def places(self, text: str, limit: int = 4) -> list[str]:
        return self._in_order(text, self.places_m.find(text), self.place_names)[:limit]

    def people_and_bodies(self, text: str, limit: int = 4) -> list[str]:
        people = []
        for m in TITLED.finditer(text or ""):
            name, title = m.group(2).strip(), m.group(1)
            if name.split()[0] not in ("Of", "The", "For") and not any(name in p for p in people):
                people.append(f"{name} ({title})")
        bodies = self._in_order(text, self.bodies_m.find(text), self.body_names)
        return (people + [b for b in bodies if not any(b in p for p in people)])[:limit]

    def score(self, a: Analysis, tier: str, kind: str = "news") -> float:
        """kind: news / editorial / explained. Opinion and explainers on world affairs are
        GS2 material in their own right, so the India-angle penalty only applies to news."""
        s = self.tier_weight.get(tier, 1.0)
        s += min(a.signal, 4.0)
        best = max(a.subject_scores.values()) if a.subject_scores else 0.0
        s += min(best / 4.0, 2.0) if a.subjects else -self.no_subject_penalty
        s += min(0.5 * len(a.tags), 1.5)
        s -= a.noise
        # official Indian sources (an MEA statement on a ship attacked off Oman) and exam-prep sites (their
        # "Ethiopia" is a map item) are UPSC material by definition: no foreign-news mark-down for them
        indian_curated = tier in ("official", "examprep")
        if a.foreign_local and not indian_curated:  # any kind: an explainer on a Spanish eviction isn't GS material
            s = min(s - self.foreign_local_penalty, self.reject_score)
            a.rejected = a.rejected or "another country's local or domestic news"
        elif a.foreign and kind == "news" and not indian_curated:
            s -= self.neighbour_penalty if a.foreign == "neighbourhood" else self.foreign_penalty
        elif not a.india and tier in self.india_tiers and kind == "news":
            s -= self.india_penalty
        # not UPSC material (sports results, stock tickers, weather alerts, job ads…), or no syllabus
        # subject at all: graded LOW, so it never reaches the dashboard (kept in the database)
        no_subject = self.require_subject and not a.subjects and tier != "library"
        if (self.reject_noise and a.noise >= self.reject_noise) or no_subject:
            s = min(s, self.reject_score)
        return round(s, 2)

    def grade(self, score: float) -> str:
        for name, cut in self.grade_cut:
            if score >= cut:
                return name
        return "LOW"

    @staticmethod
    def coverage_bonus(n_publishers: int) -> float:
        return min(0.8 * math.log2(max(n_publishers, 1)), 3.0)

    def story_score(self, best_item_score: float, n_publishers: int) -> float:
        """A story scores as its best item plus a bonus for wide coverage, except that a rejected story
        (not UPSC material) stays rejected however many outlets carried it."""
        if best_item_score <= self.reject_score:
            return round(best_item_score, 2)
        return round(best_item_score + self.coverage_bonus(n_publishers), 2)

    def gs_for(self, subjects: list[str], tags: list[str]) -> list[str]:
        papers = {self.subject_meta.get(s, {}).get("gs") for s in subjects} - {None}
        if PRELIMS_TAGS.intersection(tags):
            papers.add("Prelims")
        return [p for p in GS_ORDER if p in papers]

    def labels(self) -> dict:
        return {
            "subjects": {k: v["label"] for k, v in self.subject_meta.items()},
            "subject_gs": {k: v["gs"] for k, v in self.subject_meta.items()},
            "watch": dict(self.watch_meta),
        }
