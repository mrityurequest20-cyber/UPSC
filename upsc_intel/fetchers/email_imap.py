"""Premium route 1: newsletters and e-paper emails from your own mailbox over IMAP.

Works with Gmail (app password + a label such as "UPSC"), Outlook, Zoho, anything with IMAP.
Each email becomes a "newsletter" item, and every headline-like link inside it becomes its own
item, so the stories your paid subscriptions email you land in the same feed as everything else.
The mailbox is opened read-only; nothing is marked as read or moved.
"""
from __future__ import annotations

import email
import imaplib
import re
from datetime import datetime, timedelta, timezone
from email.policy import default as default_policy
from email.utils import parseaddr, parsedate_to_datetime
from urllib.parse import quote

from bs4 import BeautifulSoup

from ..models import FetchError, RawItem
from ..pipeline.normalize import collapse, html_to_text

LINK_JUNK = re.compile(
    r"(unsubscribe|privacy|terms|preferences|manage (your )?subscription|view (it )?in (your )?browser|"
    r"download (the|our) app|app store|google play|facebook|twitter|instagram|linkedin|youtube|whatsapp|"
    r"telegram|contact us|help ?cent(er|re)|advertise|forward to a friend|sign ?in|log ?in|update profile|"
    r"refer a friend|gift)",
    re.I,
)
EPAPER = re.compile(r"(e-?paper|today'?s paper|download (the )?(pdf|paper)|digital edition|replica)", re.I)


def _html_and_text(msg: email.message.EmailMessage) -> tuple[str, str]:
    html_part = msg.get_body(preferencelist=("html",))
    text_part = msg.get_body(preferencelist=("plain",))
    html = html_part.get_content() if html_part else ""
    text = text_part.get_content() if text_part else html_to_text(html)
    return html, collapse(text)


def parse_email(raw: bytes, max_links: int = 40) -> tuple[str, list[RawItem]]:
    msg = email.message_from_bytes(raw, policy=default_policy)
    msg_id = (msg.get("Message-ID") or "").strip().strip("<>")
    subject = collapse(str(msg.get("Subject") or "(no subject)"))
    name, addr = parseaddr(str(msg.get("From") or ""))
    sender = collapse(name) or addr or "Newsletter"
    try:
        published = parsedate_to_datetime(str(msg.get("Date"))).astimezone(timezone.utc)
    except (TypeError, ValueError):
        published = datetime.now(timezone.utc)
    html, text = _html_and_text(msg)
    key = msg_id or f"{addr}:{subject}:{published.isoformat()}"

    items: list[RawItem] = [RawItem(
        title=f"{subject}",
        url=f"https://mail.google.com/mail/u/0/#search/rfc822msgid%3A{quote(msg_id)}" if msg_id else "",
        summary=text[:700],
        content=text[:20000],
        published=published,
        publisher=sender,
        guid=f"email:{key}",
        extra={"newsletter": True, "from": addr},
    )]

    if html:
        soup = BeautifulSoup(html, "html.parser")
        seen: set[str] = set()
        for a in soup.find_all("a", href=True):
            href = a["href"].strip()
            label = collapse(a.get_text(" ", strip=True))
            if not href.startswith("http") or href in seen:
                continue
            if EPAPER.search(label) or EPAPER.search(href):
                seen.add(href)
                items.append(RawItem(
                    title=f"Today's e-paper: {sender}", url=href, published=published, publisher=sender,
                    guid=f"email:{key}:epaper", extra={"epaper": True, "via": subject},
                ))
                continue
            if len(label) < 30 or len(label.split()) < 5 or LINK_JUNK.search(label) or LINK_JUNK.search(href):
                continue
            seen.add(href)
            items.append(RawItem(
                title=label[:220], url=href, published=published, publisher=sender,
                guid=f"email:{key}:{len(seen)}", extra={"via": subject},
            ))
            if len(seen) >= max_links:
                break
    items = [i for i in items if i.url]
    return key, items


def fetch_imap(ctx, step: dict, src: dict) -> list[RawItem]:
    s = ctx.settings
    if not s.imap_enabled:
        raise FetchError("IMAP not configured")
    since = (datetime.now(timezone.utc) - timedelta(days=s.imap_since_days)).strftime("%d-%b-%Y")
    try:
        conn = imaplib.IMAP4_SSL(s.imap_host, s.imap_port)
        conn.login(s.imap_user, s.imap_password)
    except (imaplib.IMAP4.error, OSError) as exc:
        raise FetchError(f"IMAP login failed: {exc}") from exc
    try:
        folder = s.imap_folder if s.imap_folder.upper() == "INBOX" else f'"{s.imap_folder}"'
        typ, _ = conn.select(folder, readonly=True)
        if typ != "OK":
            raise FetchError(f"IMAP folder not found: {s.imap_folder}")
        uids: set[bytes] = set()
        queries = [f'(SINCE {since} FROM "{snd}")' for snd in s.imap_senders] or [f"(SINCE {since})"]
        for q in queries:
            typ, data = conn.uid("search", None, q)
            if typ == "OK" and data and data[0]:
                uids.update(data[0].split())
        items: list[RawItem] = []
        for uid in sorted(uids, key=int)[-300:]:
            seen_key = f"imap:{s.imap_user}:{s.imap_folder}:{uid.decode()}"
            if ctx.db.seen(seen_key):
                continue
            typ, data = conn.uid("fetch", uid, "(BODY.PEEK[])")
            if typ != "OK" or not data or not isinstance(data[0], tuple):
                continue
            _, parsed = parse_email(data[0][1])
            items.extend(parsed)
            ctx.db.mark_seen(seen_key)
        return items
    finally:
        try:
            conn.logout()
        except Exception:
            pass
