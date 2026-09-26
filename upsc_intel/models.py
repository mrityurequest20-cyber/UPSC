"""Plain data containers passed between fetchers and the pipeline."""
from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime
from typing import Any


@dataclass
class RawItem:
    """What a fetcher returns: minimally cleaned, not yet classified."""
    title: str
    url: str
    summary: str = ""
    content: str = ""                # longer body text (emails, PDFs) used for search only
    published: datetime | None = None  # timezone-aware UTC if known
    publisher: str | None = None     # overrides the source name (e.g. Google News origin outlet)
    guid: str | None = None          # stable id when the URL is not stable
    extra: dict[str, Any] = field(default_factory=dict)


class FetchError(Exception):
    """A fetch step failed; the fallback chain moves on to the next step."""
