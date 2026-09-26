"""Rule-based UPSC classifier: syllabus subjects → GS papers, Prelims tags, watch areas, examinability grade.

Offline, free and deterministic. All vocabulary lives in config/topics.yaml.
"""
from __future__ import annotations

import math
import re
from collections import defaultdict
from dataclasses import dataclass, field

DEFAULT_TIERS = {"official": 3.0, "examprep": 2.5, "premium": 2.5, "quality": 1.5, "library": 2.0,
                 "watch": 1.25, "general": 1.0, "intl": 1.0}
PRELIMS_TAGS = {"Scheme", "Report/Index", "Species", "Place in news", "Award", "Day/Observance",
                "Exercise", "Appointment", "Agreement/MoU"}
GS_ORDER = ["GS1", "GS2", "GS3", "GS4", "Prelims"]


def _norm(text: str) -> str:
    return re.sub(r"[\s\-]+", " ", text.strip())


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


class Classifier:
    def __init__(self, topics: dict):
        topics = topics or {}
        sc = topics.get("scoring") or {}
        self.tier_weight = {**DEFAULT_TIERS, **(sc.get("tier_weight") or {})}
        self.subject_threshold = float(sc.get("subject_threshold", 2))
        self.max_subjects = int(sc.get("max_subjects", 3))
        self.no_subject_penalty = float(sc.get("no_subject_penalty", 1.5))
        grades = sc.get("grades") or {}
        self.grade_cut = [("NOTE", float(grades.get("NOTE", 5.0))), ("SKIM", float(grades.get("SKIM", 3.2))),
                          ("READ", float(grades.get("READ", 1.6)))]

        self.subject_meta: dict[str, dict] = {}
        kw_entries: dict[str, list[tuple[str, float]]] = defaultdict(list)
        for sid, meta in (topics.get("subjects") or {}).items():
            self.subject_meta[sid] = {"label": meta.get("label", sid), "gs": meta.get("gs")}
            for term, w in (meta.get("kw") or {}).items():
                kw_entries[str(term)].append((sid, float(w)))
        self.kw = TermMatcher(kw_entries)
        self.signals = TermMatcher({str(t): [("s", float(w))] for t, w in (topics.get("signals") or {}).items()})
        self.noise = TermMatcher({str(t): [("n", float(w))] for t, w in (topics.get("noise") or {}).items()})
        self.tag_rx = {name: re.compile(p, re.I) for name, p in (topics.get("tags") or {}).items()}

        ia = topics.get("india_angle") or {}
        self.india_penalty = float(ia.get("penalty", 0))
        self.india_tiers = set(ia.get("applies_to") or [])
        self.india_terms = TermMatcher({str(t): [("i", 1.0)] for t in ia.get("terms") or []})
        self.india_exempt = TermMatcher({str(t): [("x", 1.0)] for t in ia.get("exempt") or []})

        self.watch_meta: dict[str, str] = {}
        self.watch_rules: dict[str, list[TermMatcher]] = {}
        for wid, meta in (topics.get("watch_areas") or {}).items():
            self.watch_meta[wid] = meta.get("label", wid)
            groups = meta.get("all") or [meta.get("any") or []]
            self.watch_rules[wid] = [TermMatcher({str(t): [("w", 1.0)] for t in g}) for g in groups]

    # ── per item ──
    def analyze(self, title: str, summary: str = "", hint: str = "") -> Analysis:
        a = Analysis()
        scores: dict[str, float] = defaultdict(float)
        body = f"{summary} {hint}".strip()
        for text, mult in ((title, 2.0), (body, 1.0)):
            for _, entries in self.kw.find(text).items():
                for sid, w in entries:
                    scores[sid] += w * mult
        ranked = sorted(scores.items(), key=lambda kv: -kv[1])
        a.subject_scores = {k: round(v, 2) for k, v in ranked}
        a.subjects = [sid for sid, s in ranked if s >= self.subject_threshold][: self.max_subjects]

        a.signal = sum(w for es in self.signals.find(title).values() for _, w in es)
        a.signal += 0.5 * sum(w for k, es in self.signals.find(summary).items() for _, w in es)
        a.noise = sum(w for es in self.noise.find(title).values() for _, w in es)
        a.noise += 0.3 * sum(w for es in self.noise.find(summary[:400]).values() for _, w in es)

        head = f"{title} {summary[:220]}"
        a.tags = [name for name, rx in self.tag_rx.items() if rx.search(head)]
        full = f"{title} {summary}"
        a.watch = [wid for wid, groups in self.watch_rules.items() if all(g.find(full) for g in groups)]
        if self.india_penalty:
            a.india = bool(a.watch or self.india_terms.find(full) or self.india_exempt.find(full))
        return a

    def score(self, a: Analysis, tier: str) -> float:
        s = self.tier_weight.get(tier, 1.0)
        s += min(a.signal, 4.0)
        best = max(a.subject_scores.values()) if a.subject_scores else 0.0
        s += min(best / 4.0, 2.0) if a.subjects else -self.no_subject_penalty
        s += min(0.5 * len(a.tags), 1.5)
        s -= a.noise
        if not a.india and tier in self.india_tiers:
            s -= self.india_penalty
        return round(s, 2)

    def grade(self, score: float) -> str:
        for name, cut in self.grade_cut:
            if score >= cut:
                return name
        return "LOW"

    @staticmethod
    def coverage_bonus(n_publishers: int) -> float:
        return min(0.8 * math.log2(max(n_publishers, 1)), 3.0)

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
