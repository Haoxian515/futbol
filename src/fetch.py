"""Cached HTTP + parsers for each source.

Every raw response is stored under data/cache/ as <slug>__<hash>.body with a .meta.json
(url, fetched_at, status). 404/410 answers are cached too, so a missing season file does not
cost a network request on every run. Parsed results are memoised next to the body.
"""
import csv
import datetime as dt
import hashlib
import io
import json
import os
import re
import subprocess
import time

import requests
from bs4 import BeautifulSoup

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CACHE_DIR = os.path.join(ROOT, "data", "cache")
UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36"
PARSER_VERSION = 2
MISSING = (404, 410)

MONTHS = {m: i for i, m in enumerate(
    ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"], 1)}
DAYS = "Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday"


def mask(url):
    return re.sub(r"(apiKey=)[^&]+", r"\1***", url)


def _age(hours):
    if hours < 1:
        return f"{hours * 60:.0f}m"
    if hours < 48:
        return f"{hours:.1f}h"
    return f"{hours / 24:.0f}d"


class Fetcher:
    def __init__(self, refresh=False):
        self.refresh = refresh
        self.sources = []
        self.network = 0
        os.makedirs(CACHE_DIR, exist_ok=True)

    def _paths(self, url):
        m = mask(url)
        stem = re.sub(r"^https?://(www\.)?", "", m)
        slug = re.sub(r"[^A-Za-z0-9]+", "_", stem.split("?")[0]).strip("_")[:80]
        h = hashlib.sha1(m.encode("utf-8")).hexdigest()[:10]
        base = os.path.join(CACHE_DIR, f"{slug}__{h}")
        return base + ".body", base + ".meta.json", base + ".parsed.json"

    def _note(self, url, how):
        u = mask(url)
        for s in self.sources:
            if s["url"] == u:
                return
        self.sources.append({"url": u, "how": how})

    def _download(self, url):
        self.network += 1
        headers = {"User-Agent": UA, "Accept-Language": "en-US,en;q=0.9",
                   "Accept": "text/html,application/xhtml+xml,application/json,text/csv;q=0.9,*/*;q=0.8"}
        try:
            r = requests.get(url, headers=headers, timeout=40)
            try:
                text = r.content.decode("utf-8")
            except UnicodeDecodeError:
                text = r.text
            return r.status_code, text, None
        except requests.RequestException as e:
            err = e
        # some hosts (NBC) reset python-requests connections but serve curl fine
        try:
            p = subprocess.run(["curl", "-s", "-L", "--max-time", "40", "-A", UA,
                                "-H", "Accept-Language: en-US,en;q=0.9", "-w", "\n%{http_code}", url],
                               capture_output=True, timeout=60)
            out = p.stdout.decode("utf-8", errors="replace")
            body, _, code = out.rpartition("\n")
            return int(code or 0), body, None
        except Exception as e2:  # noqa: BLE001
            return None, None, f"{type(err).__name__} / curl {type(e2).__name__}"

    def get(self, url, ttl_hours):
        body, meta_p, _ = self._paths(url)
        meta = None
        if os.path.exists(meta_p):
            with open(meta_p, encoding="utf-8") as fh:
                meta = json.load(fh)
        age = (time.time() - meta["fetched_at"]) / 3600 if meta else None
        have_body = meta is not None and meta.get("status") == 200 and os.path.exists(body)
        if meta and not self.refresh and age < ttl_hours:
            if have_body:
                self._note(url, f"cache {_age(age)}")
                with open(body, encoding="utf-8") as fh:
                    return fh.read()
            if meta.get("status") in MISSING:
                self._note(url, f"cache {_age(age)}: HTTP {meta['status']}")
                return None
        status, text, err = self._download(url)
        if status == 200 and text:
            with open(body, "w", encoding="utf-8") as fh:
                fh.write(text)
            self._write_meta(meta_p, url, 200)
            self._note(url, "network")
            return text
        if status in MISSING:
            self._write_meta(meta_p, url, status)
            self._note(url, f"network: HTTP {status}")
            return None
        if have_body:
            self._note(url, f"STALE cache {_age(age)} (refetch failed: {status or err})")
            with open(body, encoding="utf-8") as fh:
                return fh.read()
        self._note(url, f"FAILED: {status or err}")
        return None

    def _write_meta(self, path, url, status):
        now = time.time()
        with open(path, "w", encoding="utf-8") as fh:
            json.dump({"url": mask(url), "status": status, "fetched_at": now,
                       "fetched_at_iso": dt.datetime.fromtimestamp(now).isoformat(timespec="seconds")}, fh, indent=1)

    def get_json(self, url, ttl_hours):
        text = self.get(url, ttl_hours)
        if text is None:
            return None
        try:
            return json.loads(text)
        except ValueError:
            return None

    def get_parsed(self, url, ttl_hours, parser, *args):
        text = self.get(url, ttl_hours)
        if text is None:
            return None
        body, _, parsed_p = self._paths(url)
        key = f"{parser.__name__}:{PARSER_VERSION}:{os.path.getmtime(body) if os.path.exists(body) else 0}:{json.dumps(args)}"
        if os.path.exists(parsed_p):
            with open(parsed_p, encoding="utf-8") as fh:
                d = json.load(fh)
            if d.get("key") == key:
                return d["data"]
        data = parser(text, *args)
        with open(parsed_p, "w", encoding="utf-8") as fh:
            json.dump({"key": key, "data": data}, fh, ensure_ascii=False)
        return data


def _lines(html):
    txt = BeautifulSoup(html, "html.parser").get_text("\n")
    return [l.strip() for l in txt.split("\n") if l.strip()]


def _clock(h, mi, ampm):
    return f"{int(h) % 12 + (12 if ampm.lower() == 'pm' else 0):02d}:{int(mi or 0):02d}"


# ---------------------------------------------------------------- lastseason.co.uk
def parse_season_csv(text):
    reader = csv.DictReader(io.StringIO(text))
    need = {"position", "club", "played", "wins", "draws", "losses", "goals_for", "goals_against", "points"}
    if not reader.fieldnames or not need.issubset(reader.fieldnames):
        raise ValueError("unexpected CSV header")
    return [dict(pos=int(r["position"]), club=r["club"].strip(), P=int(r["played"]), W=int(r["wins"]),
                 D=int(r["draws"]), L=int(r["losses"]), GF=int(r["goals_for"]), GA=int(r["goals_against"]),
                 Pts=int(r["points"])) for r in reader]


def parse_season_html(text):
    soup = BeautifulSoup(text, "html.parser")
    for tb in soup.find_all("table"):
        trs = tb.find_all("tr")
        if not trs:
            continue
        hdr = [c.get_text(strip=True).lower() for c in trs[0].find_all(["th", "td"])]
        if not {"p", "w", "d", "l", "gf", "ga", "pts"}.issubset(hdr):
            continue
        ix = {h: i for i, h in enumerate(hdr)}
        club_i = ix.get("club", ix.get("team"))
        pos_i = ix.get("#", ix.get("pos"))
        rows = []
        for tr in trs[1:]:
            c = [x.get_text(strip=True) for x in tr.find_all(["td", "th"])]
            if len(c) < len(hdr):
                continue
            try:
                rows.append(dict(pos=int(re.sub(r"\D", "", c[pos_i])), club=c[club_i], P=int(c[ix["p"]]),
                                 W=int(c[ix["w"]]), D=int(c[ix["d"]]), L=int(c[ix["l"]]), GF=int(c[ix["gf"]]),
                                 GA=int(c[ix["ga"]]), Pts=int(c[ix["pts"]])))
            except (ValueError, TypeError):
                continue
        if rows:
            return rows
    raise ValueError("no standings table found")


# ---------------------------------------------------------------- topscorersfootball.com
def parse_topscorers(text):
    soup = BeautifulSoup(text, "html.parser")
    rounds = {}
    for rd in soup.select("div.match-round"):
        m = re.search(r"Round\s+(\d+)", rd.get_text(" ", strip=True))
        if not m:
            continue
        items = rounds.setdefault(m.group(1), [])
        box = rd.find_next_sibling("div")
        if box is None or "match-round-matches" not in (box.get("class") or []):
            continue
        for mr in box.select("div.match-result"):
            names = "".join(mr.find_all(string=True, recursive=False)).strip()
            parts = [p.strip() for p in names.split(" - ")]
            sc, d = mr.select_one("span.match-score"), mr.select_one("div.date")
            hg = ag = None
            if sc:
                ms = re.match(r"^\s*(\d+)\s*-\s*(\d+)\s*$", sc.get_text())
                if ms:
                    hg, ag = int(ms.group(1)), int(ms.group(2))
            date = None
            if d:
                md = re.match(r"^(\d{1,2})\s+([A-Za-z]+)\s+(\d{4})$", d.get_text(strip=True))
                if md and md.group(2)[:3].lower() in MONTHS:
                    date = dt.date(int(md.group(3)), MONTHS[md.group(2)[:3].lower()], int(md.group(1))).isoformat()
            parent = mr.find_parent("div", class_="match-details-comp")
            items.append(dict(raw=names, home=parts[0] if len(parts) == 2 else None,
                              away=parts[1] if len(parts) == 2 else None, hg=hg, ag=ag, date=date,
                              id=parent.get("data-apif-id") if parent else None))
    table = []
    tb = soup.find("table")
    if tb:
        for tr in tb.select("tbody tr"):
            c = [td.get_text(strip=True) for td in tr.find_all("td")]
            if len(c) < 8:
                continue
            try:
                gf, ga = [int(x) for x in c[6].split("-")]
                table.append(dict(pos=int(c[0].rstrip(".")), club=c[1], P=int(c[2]), W=int(c[3]), D=int(c[4]),
                                  L=int(c[5]), GF=gf, GA=ga, Pts=int(c[7])))
            except ValueError:
                continue
    upd = soup.select_one(".gen-last-update")
    return dict(rounds=rounds, table=table,
                updated=upd.get_text(strip=True).replace("Last updated:", "").strip() if upd else None)


# ---------------------------------------------------------------- NBC Sports schedule article (ET)
def parse_nbc(text, start_year):
    rdate = re.compile(rf"^(?:{DAYS}),?\s+(\d{{1,2}})\s+([A-Za-z]+)(?:,?\s+(\d{{4}}))?$")
    # a trailing "* Match will move to ..." note marks a kickoff that may still change
    rfix = re.compile(r"^(\d{1,2})(?::(\d{2}))?\s*(am|pm)(?:\s*ET)?:\s*(.+?)\s+v\s+(.+?)(\*.*|\s+[-—–](?:\s.*)?)?$", re.I)
    rres = re.compile(r"^(.+?)\s+(\d+)-(\d+)\s+(.+?)(?:\s+[-—–](?:\s.*)?)?$")
    cur, out = None, []
    for line in _lines(text):
        m = rdate.match(line)
        if m:
            mon = MONTHS.get(m.group(2)[:3].lower())
            cur = None
            if mon:
                yr = int(m.group(3)) if m.group(3) else (start_year if mon >= 7 else start_year + 1)
                try:
                    cur = dt.date(yr, mon, int(m.group(1)))
                except ValueError:
                    pass
            continue
        if cur is None:
            continue
        m = rfix.match(line)
        if m:
            trail = m.group(6) or ""
            out.append(dict(home=m.group(4).strip(), away=m.group(5).strip(), date_et=cur.isoformat(),
                            time_et=_clock(m.group(1), m.group(2), m.group(3)), hg=None, ag=None,
                            tentative=trail.lstrip().startswith("*"),
                            note=trail.lstrip("* ").strip() if trail.lstrip().startswith("*") else None))
            continue
        m = rres.match(line)
        if m:
            out.append(dict(home=m.group(1).strip(), away=m.group(4).strip(), date_et=cur.isoformat(),
                            time_et=None, hg=int(m.group(2)), ag=int(m.group(3))))
    return out


# ---------------------------------------------------------------- sportbusy.com (ET, upcoming only)
def parse_sportbusy(text):
    rdate = re.compile(rf"^(?:{DAYS}),\s+([A-Za-z]+)\s+(\d{{1,2}}),\s+(\d{{4}})$")
    rtime = re.compile(r"^(\d{1,2}):(\d{2})\s*(AM|PM)\s*ET$", re.I)
    rpair = re.compile(r"^(.+?)\s+at\s+(.+)$")
    rround = re.compile(r"^Round\s+(\d+)\b")
    lines, cur, out, i = _lines(text), None, [], 0
    while i < len(lines):
        line = lines[i]
        m = rdate.match(line)
        if m and m.group(1)[:3].lower() in MONTHS:
            cur = dt.date(int(m.group(3)), MONTHS[m.group(1)[:3].lower()], int(m.group(2)))
            i += 1
            continue
        m = rtime.match(line)
        if m and cur and i + 2 < len(lines):
            pm, rm = rpair.match(lines[i + 1]), rround.match(lines[i + 2])
            if pm and rm:
                out.append(dict(home=pm.group(2).strip(), away=pm.group(1).strip(), date_et=cur.isoformat(),
                                time_et=_clock(m.group(1), m.group(2), m.group(3)), round=int(rm.group(1))))
                i += 3
                continue
        i += 1
    return out
