"""Per-team / per-fixture assembly, computations and the history method.

Nothing here fills a value from memory: every number comes from a cached source file, and
anything missing becomes "—" (or "new"/"TBC") with a matching run-log entry.
"""
import datetime as dt
import json
import os
import re
import statistics
import unicodedata
from urllib.parse import quote

import pytz

from src import fetch as F

DATA = os.path.join(F.ROOT, "data")
LA = pytz.timezone("America/Los_Angeles")
ET = pytz.timezone("America/New_York")
TTL_CUR = 6
TTL_PAST = 24 * 30

LEAGUES = {
    "pl": dict(name="Premier League", round_word="Matchweek", out="pl-mw{n}.png", slug_ls="premier-league",
               slug_ts="premier-league", tz="Europe/London", country="GB", odds="soccer_epl",
               teams=20, games=38, kickoffs="nbc"),
    "laliga": dict(name="La Liga", round_word="Jornada", out="laliga-j{n}.png", slug_ls="la-liga",
                   slug_ts="la-liga", tz="Europe/Madrid", country="ES", odds="soccer_spain_la_liga",
                   teams=20, games=38, kickoffs="sportbusy", slug_sb="la-liga"),
    "ligue1": dict(name="Ligue 1", round_word="Matchday", out="ligue1-md{n}.png", slug_ls="ligue-1",
                   slug_ts="ligue-1", tz="Europe/Paris", country="FR", odds="soccer_france_ligue_one",
                   teams=18, games=34, kickoffs="sportbusy", slug_sb="ligue-1"),
    "seriea": dict(name="Serie A", round_word="Giornata", out="seriea-g{n}.png", slug_ls="serie-a",
                   slug_ts="serie-a", tz="Europe/Rome", country="IT", odds="soccer_italy_serie_a",
                   teams=20, games=38, kickoffs="sportbusy", slug_sb="serie-a"),
}


class ChartError(Exception):
    pass


class RunLog:
    def __init__(self):
        self.cells, self.notes, self.warnings = {}, [], []

    def cell(self, field, reason, item=None):
        items = self.cells.setdefault((field, reason), [])
        if item is not None and item not in items:
            items.append(item)

    def note(self, msg):
        if msg not in self.notes:
            self.notes.append(msg)

    def warn(self, msg):
        if msg not in self.warnings:
            self.warnings.append(msg)

    def dump(self, fetcher, header):
        out = [header, "Sources:"]
        out += [f"  [{s['how']}] {s['url']}" for s in fetcher.sources]
        if self.notes:
            out.append("Notes:")
            out += [f"  - {n}" for n in self.notes]
        out.append("Cells shown as —/TBC/new, and why:")
        if not self.cells:
            out.append("  (none)")
        for (field, reason), items in self.cells.items():
            out.append(f"  - {field}: {reason}" + (f" [{', '.join(items)}]" if items else ""))
        if self.warnings:
            out.append("Warnings:")
            out += [f"  ! {w}" for w in self.warnings]
        return "\n".join(out)


def load_json(name, default):
    p = os.path.join(DATA, name)
    if not os.path.exists(p):
        return default
    with open(p, encoding="utf-8") as fh:
        return json.load(fh)


def fold(s):
    return re.sub(r"[^a-z0-9]", "", unicodedata.normalize("NFKD", s).encode("ascii", "ignore").decode().lower())


class Names:
    def __init__(self, aliases):
        self.alias = {k: v for k, v in aliases.items() if not k.startswith("_")}
        self.folded = {fold(v): v for v in self.alias.values()}
        self.folded.update({fold(k): v for k, v in self.alias.items()})

    def canon(self, name):
        if not name:
            return None
        n = name.strip()
        return self.alias.get(n) or self.folded.get(fold(n), n)


def season_start(d):
    return d.year if d.month >= 7 else d.year - 1


def sstr(y):
    return f"{y}-{str(y + 1)[2:]}"


def lab(y):
    return "'" + str(y + 1)[2:]


def ordinal(n):
    suf = "th" if 10 <= n % 100 <= 20 else {1: "st", 2: "nd", 3: "rd"}.get(n % 10, "th")
    return f"{n}{suf}"


def clip(s, n=40):
    return s if len(s) <= n else s[:n - 1] + "…"


def fmt_time(t):
    h = t.hour % 12 or 12
    return f"{h}:{t.minute:02d}{'a' if t.hour < 12 else 'p'}"


def persp(m, club):
    gf, ga = (m["hg"], m["ag"]) if m["home"] == club else (m["ag"], m["hg"])
    o = "W" if gf > ga else "D" if gf == ga else "L"
    return o, gf, ga


# ------------------------------------------------------------------ sources
def load_topscorers(fetcher, L, y, names, ttl):
    url = f"https://www.topscorersfootball.com/{L['slug_ts']}/standing-and-matches-{y}/{y + 1}"
    d = fetcher.get_parsed(url, ttl, F.parse_topscorers)
    if not d:
        return None
    rounds = {int(k): [dict(m, home=names.canon(m["home"]), away=names.canon(m["away"]), round=int(k)) for m in ms]
              for k, ms in d["rounds"].items()}
    return dict(url=url, rounds=rounds, table={names.canon(r["club"]): r for r in d["table"]}, updated=d["updated"])


def load_season_table(fetcher, L, y, names, log):
    s = sstr(y)
    rows = src = None
    for url, parser in ((f"https://lastseason.co.uk/data/{L['slug_ls']}/{s}.csv", F.parse_season_csv),
                        (f"https://lastseason.co.uk/{L['slug_ls']}/{s}/", F.parse_season_html)):
        try:
            rows = fetcher.get_parsed(url, TTL_PAST, parser)
        except ValueError as e:
            log.warn(f"{url}: could not parse ({e})")
            rows = None
        if rows:
            src = url
            break
    if not rows:
        ts = load_topscorers(fetcher, L, y, names, TTL_PAST)
        if ts and len(ts["table"]) == L["teams"] and all(r["P"] == L["games"] for r in ts["table"].values()):
            rows, src = list(ts["table"].values()), ts["url"]
            log.note(f"{L['name']} {s} final table: not on lastseason.co.uk (CSV and page 404) — used {ts['url']}")
    if not rows:
        log.warn(f"{L['name']} {s} final table unavailable from every source — its cells are —")
        return None
    table = {}
    for r in rows:
        c = names.canon(r["club"])
        ok = r["W"] + r["D"] + r["L"] == L["games"]
        if not ok:
            log.warn(f"{s} {c}: W+D+L={r['W'] + r['D'] + r['L']} != {L['games']} — season cells for {c} shown as —")
        elif 3 * r["W"] + r["D"] != r["Pts"]:
            log.warn(f"{s} {c}: 3W+D={3 * r['W'] + r['D']} but Pts={r['Pts']} in {src} (points adjustment?) — W-D-L kept")
        table[c] = dict(r, ok=ok)
    if len(table) != L["teams"]:
        log.warn(f"{s} table from {src} has {len(table)} clubs (expected {L['teams']})")
    return dict(rows=table, src=src)


def load_kickoffs(fetcher, L, y, names, clubs, log):
    if L["kickoffs"] == "nbc":
        url = f"https://www.nbcsports.com/soccer/news/premier-league-schedule-for-{sstr(y)}-season-released"
        rows = fetcher.get_parsed(url, TTL_CUR, F.parse_nbc, y)
    else:
        url = f"https://www.sportbusy.com/{L['slug_sb']}-{y}-{str(y + 1)[2:]}/"
        rows = fetcher.get_parsed(url, TTL_CUR, F.parse_sportbusy)
    if rows is None:
        log.warn(f"kickoff source unavailable: {url} — TIME is — for every fixture")
        return {}, set(), url
    by = {}
    for r in rows:
        h, a = names.canon(r["home"]), names.canon(r["away"])
        if h in clubs and a in clubs:
            by.setdefault((h, a), []).append(dict(r, home=h, away=a))
    provisional = set()
    if L["kickoffs"] == "sportbusy":
        per_round = {}
        for lst in by.values():
            for r in lst:
                per_round.setdefault(r["round"], []).append(r)
        for rn, lst in per_round.items():
            if len(lst) >= 4 and len({r["time_et"] for r in lst}) == 1:
                provisional.add(rn)
    return by, provisional, url


def pick_kickoff(entries, fx_date, local_tz):
    """-> (aware ET datetime or None, source entry or None, note or None)"""
    cands = [e for e in entries if e.get("time_et")]
    if not cands:
        return None, None, None
    slots = {}
    for e in cands:
        et = ET.localize(dt.datetime.fromisoformat(f"{e['date_et']}T{e['time_et']}"))
        slots.setdefault((e["date_et"], e["time_et"]), (et, e))
    if len(slots) == 1:
        et, e = next(iter(slots.values()))
        ld = et.astimezone(local_tz).date()
        if fx_date is None or ld == fx_date:
            return et, e, None
        if abs((ld - fx_date).days) <= 1:
            return et, e, f"kickoff source date {ld} vs results page {fx_date}; kickoff source used"
        return None, None, f"kickoff source slot {ld} conflicts with results page date {fx_date} — time not shown"
    match = [(et, e) for et, e in slots.values() if et.astimezone(local_tz).date() == fx_date]
    if len(match) == 1:
        return match[0][0], match[0][1], f"kickoff source lists {len(slots)} slots; used the one matching the results-page date"
    return None, None, f"kickoff source lists {len(slots)} conflicting slots — none uniquely matches"


def load_odds(fetcher, L, names, log):
    """-> (events or None, url or None); the url is the provenance for WIN% cells."""
    key = os.environ.get("ODDS_API_KEY")
    if not key:
        log.note("ODDS_API_KEY not set — no odds requested")
        return None, None
    url = (f"https://api.the-odds-api.com/v4/sports/{L['odds']}/odds/?apiKey={key}"
           f"&regions=uk,eu&markets=h2h&oddsFormat=decimal")
    j = fetcher.get_json(url, TTL_CUR)
    if not isinstance(j, list):
        log.warn("The Odds API returned no usable data")
        return None, url
    out = []
    for ev in j:
        probs = []
        for bk in ev.get("bookmakers", []):
            for mk in bk.get("markets", []):
                if mk.get("key") != "h2h":
                    continue
                pr = {o["name"]: o["price"] for o in mk.get("outcomes", [])}
                ph, pd, pa = pr.get(ev["home_team"]), pr.get("Draw"), pr.get(ev["away_team"])
                if ph and pd and pa:
                    inv = [1 / ph, 1 / pd, 1 / pa]
                    s = sum(inv)
                    probs.append([x / s for x in inv])   # normalise: removes the overround
        if probs:
            out.append(dict(home=names.canon(ev["home_team"]), away=names.canon(ev["away_team"]),
                            date=ev["commence_time"][:10], n=len(probs),
                            h=100 * statistics.mean(p[0] for p in probs),
                            a=100 * statistics.mean(p[2] for p in probs)))
    return out, url


# ------------------------------------------------------------------ weather
WMO = [((0,), "Clear"), ((1,), "Mainly clear"), ((2,), "Partly cloudy"), ((3,), "Overcast"), ((45, 48), "Fog"),
       (tuple(range(51, 58)), "Drizzle"), ((61,), "Light rain"), ((63,), "Rain"), ((65,), "Heavy rain"),
       ((66, 67), "Freezing rain"), (tuple(range(71, 78)), "Snow"), ((80,), "Showers"), ((81, 82), "Heavy showers"),
       ((85, 86), "Snow showers"), ((95, 96, 99), "Thunderstorms")]


def wmo_text(code):
    for codes, txt in WMO:
        if code in codes:
            return txt
    return "—"


def ensure_stadiums(clubs, L, fetcher, log):
    path = os.path.join(DATA, "stadiums.json")
    st = load_json("stadiums.json", {})
    cities = load_json("team_cities.json", {})
    changed = False
    for c in sorted(clubs):
        if c in st:
            continue
        q = cities.get(c)
        if not q:
            log.cell("WEATHER", "club has no city in data/team_cities.json", c)
            continue
        url = f"https://geocoding-api.open-meteo.com/v1/search?name={quote(q['query'])}&count=10&language=en&format=json"
        j = fetcher.get_json(url, TTL_PAST) or {}
        res = [r for r in j.get("results", []) if r.get("country_code") == L["country"]
               and (not q.get("admin1") or r.get("admin1") == q["admin1"])]
        if not res:
            log.cell("WEATHER", "Open-Meteo geocoding found no match", c)
            continue
        r = res[0]
        st[c] = dict(city=q.get("label", q["query"]), lat=r["latitude"], lon=r["longitude"],
                     geocoded=f"{r['name']}, {r.get('admin1', '')}, {r['country_code']}")
        changed = True
    if changed:
        with open(path, "w", encoding="utf-8") as fh:
            json.dump(st, fh, indent=1, ensure_ascii=False)
    return st


def _hourly_at(j, stamp):
    h = (j or {}).get("hourly") or {}
    try:
        i = h["time"].index(stamp)
    except (KeyError, ValueError):
        return None
    g = lambda k: (h.get(k) or [None] * (i + 1))[i]  # noqa: E731
    return dict(t=g("temperature_2m"), pp=g("precipitation_probability"), code=g("weathercode"), mm=g("precipitation"))


def weather(fx_date, kick_local, city, L, fetcher, today_local, log, label):
    """-> (line1, line2, category, [urls read]) — the urls are the cell's provenance."""
    if not city:
        return ("—", "—", "tbc", [])
    if fx_date is None:
        log.cell("WEATHER", "fixture has no date", label)
        return ("—", city["city"], "tbc", [])
    hour = kick_local.hour if kick_local else 15
    stamp = f"{fx_date.isoformat()}T{hour:02d}:00"
    base = f"latitude={city['lat']}&longitude={city['lon']}&timezone={quote(L['tz'])}"
    days = (fx_date - today_local).days
    if days > 7:
        temps, arch = [], []
        for back in (1, 2, 3):
            try:
                d = fx_date.replace(year=fx_date.year - back)
            except ValueError:
                d = fx_date.replace(year=fx_date.year - back, day=28)
            url = (f"https://archive-api.open-meteo.com/v1/archive?{base}&start_date={d - dt.timedelta(days=3)}"
                   f"&end_date={d + dt.timedelta(days=3)}&hourly=temperature_2m")
            arch.append(url)
            h = ((fetcher.get_json(url, TTL_PAST) or {}).get("hourly")) or {}
            temps += [v for t, v in zip(h.get("time", []), h.get("temperature_2m", []))
                      if t.endswith(f"T{hour:02d}:00") and v is not None]
        log.cell("WEATHER", "Forecast TBC (>7 days out); ~temp = Open-Meteo archive mean, same hour, ±3 days, last 3 yrs", label)
        if temps:
            return ("Forecast TBC", f"~{statistics.mean(temps):.0f}°C {city['city']}", "tbc", arch)
        return ("Forecast TBC", city["city"], "tbc", [])
    if kick_local is None:
        log.cell("WEATHER", "kickoff hour unknown — value read at 15:00 local", label)
    if days < -5:
        url = (f"https://archive-api.open-meteo.com/v1/archive?{base}&start_date={fx_date}&end_date={fx_date}"
               f"&hourly=temperature_2m,weathercode,precipitation")
        ttl, observed = TTL_PAST, True
    else:
        url = (f"https://api.open-meteo.com/v1/forecast?{base}&start_date={fx_date}&end_date={fx_date}"
               f"&hourly=temperature_2m,precipitation_probability,weathercode,precipitation")
        ttl, observed = TTL_CUR, days < 0
    v = _hourly_at(fetcher.get_json(url, ttl), stamp)
    if not v or v["t"] is None:
        log.cell("WEATHER", "Open-Meteo returned no value for the kickoff hour", label)
        return ("—", city["city"], "tbc", [])
    code, pp, t, mm = v["code"], (None if observed else v["pp"]), v["t"], v["mm"]
    precip_code = code is not None and code >= 51
    # drizzle codes (51-57) fire on trace amounts; only call it wet with real rain or a high chance of it
    if (precip_code and (code >= 61 or mm is None or mm >= 0.5)) or (pp is not None and pp >= 60):
        cat = "wet"
    elif t >= 28:
        cat = "hot"
    elif precip_code or (pp is not None and pp >= 30) or code in (45, 48):
        cat = "mix"
    else:
        cat = "dry"
    if observed:
        line1 = wmo_text(code) + (f" {mm:.1f}mm" if mm is not None and mm >= 0.1 else "")
    else:
        line1 = wmo_text(code) + (f" {pp:.0f}%" if pp is not None and pp >= 20 else "")
    return (line1, f"~{t:.0f}°C {city['city']}", cat, [url])


# ------------------------------------------------------------------ importance
def importance(fx, c, closest):
    h, a = fx["home"], fx["away"]
    bh, ba = c["base"].get(h), c["base"].get(a)
    prom, pre, prank, last = c["prom"], c["pre"], c["prank"], c["lastres"]
    bottom3 = lambda x: pre[x]["P"] >= 2 and prank[x] > c["teams"] - 3  # noqa: E731
    weak = lambda x: prom[x] or bottom3(x)  # noqa: E731
    tag = lambda x: "promoted" if prom[x] else "bottom-3"  # noqa: E731
    if frozenset((h, a)) in c["derbies"]:
        return "high", "Derby"
    if bh and ba and bh <= 3 and ba <= 3:
        return "high", f"Title rivals: {ordinal(bh)} v {ordinal(ba)} last season"
    if prom[h] and prom[a]:
        return "high", "Promoted v promoted"
    if bh and bh <= 4 and last[h] and last[h][0] == "L" and weak(a):
        return "high", f"Scrutiny: lost last, hosts {tag(a)} side"
    for x in (h, a):
        r = last[x]
        if r and r[0] == "L" and r[2] - r[1] >= 3:
            return "modhi", f"{x} respond to {r[1]}-{r[2]} loss"
    if bh and ba and bh <= 6 and ba <= 6:
        return "modhi", f"Europe chase: {ordinal(bh)} v {ordinal(ba)} last yr"
    if closest:
        return "modhi", f"Closest odds: {fx['win_h']:.0f}% v {fx['win_a']:.0f}%"
    if pre[h]["P"] >= 2 and pre[h]["Pts"] == 0:
        return "modhi", f"{h} 0 pts after {pre[h]['P']} games"
    wh, wa = fx["win_h"], fx["win_a"]
    if wh is not None and wa is not None:
        if wh >= 75 and weak(a):
            return "low", f"{h} {wh:.0f}% v {tag(a)} side"
        if wa >= 75 and weak(h):
            return "low", f"{a} {wa:.0f}% v {tag(h)} side"
    rs = lambda b, p: "PROM" if p else (ordinal(b) if b else "—")  # noqa: E731
    return "mod", f"Last season: {rs(bh, prom[h])} v {rs(ba, prom[a])}"


# ------------------------------------------------------------------ build
# ------------------------------------------------------------------ provenance
def file_stamp(path, kind="curated"):
    """Provenance for a human-curated local file (stars, overrides)."""
    if not os.path.exists(path):
        return None
    return {"src": f"{kind}:{os.path.relpath(path, F.ROOT).replace(os.sep, '/')}",
            "at": dt.datetime.fromtimestamp(os.path.getmtime(path)).isoformat(timespec="seconds")}


def combine(stamps):
    """One stamp covering several source records (weather reads up to 3 archive pages)."""
    ok = [x for x in stamps if x]
    if not ok:
        return None
    return {"src": " + ".join(dict.fromkeys(x["src"] for x in ok)), "at": min(x["at"] for x in ok)}


def cell(v, stamp, how=None):
    """One verified cell.

    "—"/"new"/"TBC" are the sanctioned empties and carry no source. Any other value is
    emitted WITHOUT src/at when no cached record backs it — gate_provenance then blocks
    the render, which is the point: an unsourced value must never reach the chart.
    """
    if v is None or v == "":
        return {"v": "—"}
    if v in ("—", "new", "TBC"):
        return {"v": v}
    c = {"v": v}
    if stamp:
        c["src"], c["at"] = stamp["src"], stamp["at"]
    if how:
        c["how"] = how
    return c


def build(league_key, rnd, hist_round, fetcher, log, now=None):
    L = LEAGUES[league_key]
    now = now or dt.datetime.now(LA)
    today = now.date()
    ltz = pytz.timezone(L["tz"])
    today_local = now.astimezone(ltz).date()
    names = Names(load_json("aliases.json", {}))
    y = season_start(today)
    games, teams = L["games"], L["teams"]

    # ---- current season: results, standings, the round (fixture authority)
    cur = load_topscorers(fetcher, L, y, names, TTL_CUR)
    if not cur:
        raise ChartError(f"results source unavailable for {sstr(y)} — cannot list the round's fixtures")
    if rnd not in cur["rounds"]:
        raise ChartError(f"'Round {rnd}' label not found on {cur['url']}")
    fixtures = cur["rounds"][rnd]
    clubs = set(cur["table"]) or {t for ms in cur["rounds"].values() for m in ms for t in (m["home"], m["away"]) if t}
    bad = [m["raw"] for m in fixtures if not (m["home"] and m["away"])]
    seen = [t for m in fixtures for t in (m["home"], m["away"])]
    problems = []
    if bad:
        problems.append(f"unparsed pairings {bad}")
    if len(fixtures) != teams // 2:
        problems.append(f"{len(fixtures)} fixtures (expected {teams // 2})")
    if len(set(seen)) != len(seen) or len(set(seen)) != teams:
        dup = sorted({t for t in seen if seen.count(t) > 1})
        problems.append(f"{len(set(seen))} distinct clubs (expected {teams}); duplicates {dup}")
    if len(clubs) == teams and set(seen) - clubs:
        problems.append(f"clubs not in the league table: {sorted(set(seen) - clubs)}")
    if problems:
        raise ChartError(f"Round {rnd} failed validation: " + "; ".join(problems))
    clubs = set(seen) if len(clubs) != teams else clubs
    log.note(f"Round {rnd}: {len(fixtures)} fixtures, {teams} clubs, each exactly once (from 'Round {rnd}' label on topscorersfootball)")

    all_cur = [m for ms in cur["rounds"].values() for m in ms if m["home"] and m["away"]]
    done_cur = [m for m in all_cur if m["hg"] is not None and m["date"]]

    # catch-up games inside this round
    fdates = sorted(dt.date.fromisoformat(m["date"]) for m in fixtures if m["date"])
    catchups = []
    if fdates:
        med = fdates[len(fdates) // 2]
        for m in fixtures:
            if m["date"] and abs((dt.date.fromisoformat(m["date"]) - med).days) > 5:
                when = "played early" if dt.date.fromisoformat(m["date"]) < med else "rescheduled"
                catchups.append(f"{m['home']} v {m['away']} ({when}, {dt.date.fromisoformat(m['date']):%b %d})")
        for cu in catchups:
            log.note(f"catch-up fixture kept in Round {rnd} under its label: {cu}")

    # ---- past seasons: tables (records / standings / baseline) and Round-N history
    past = list(range(y - 4, y))
    tables = {py: load_season_table(fetcher, L, py, names, log) for py in past}
    hist_n = hist_round or rnd
    hist_rounds = {}
    for py in past:
        ts = load_topscorers(fetcher, L, py, names, TTL_PAST)
        if not ts:
            log.cell(f"MATCH-{hist_n} HIST {lab(py)}", "results page for that season unavailable")
            hist_rounds[py] = None
            continue
        block = ts["rounds"].get(hist_n)
        bteams = [t for m in (block or []) for t in (m["home"], m["away"])]
        if not block or len(block) != teams // 2 or len(set(bteams)) != len(bteams) or None in bteams:
            log.warn(f"{sstr(py)} 'Round {hist_n}' block invalid ({len(block or [])} matches, clubs unique={len(set(bteams)) == len(bteams)}) — column shown as —")
            hist_rounds[py] = None
            continue
        hist_rounds[py] = dict(block=block, table=ts["table"], url=ts["url"])

    last_t = tables[y - 1]
    base_rank = {}
    promoted = {}
    for c in clubs:
        row = last_t["rows"].get(c) if last_t else None
        promoted[c] = bool(last_t) and row is None
        base_rank[c] = row["pos"] if row else None

    # ---- kickoffs, odds, stadiums, stars
    kick_by, prov_rounds, kick_url = load_kickoffs(fetcher, L, y, names, clubs, log)
    odds, odds_url = load_odds(fetcher, L, names, log)
    stadiums = ensure_stadiums({m["home"] for m in fixtures}, L, fetcher, log)
    stars = {k: v for k, v in load_json("stars.json", {}).items() if not k.startswith("_")}
    derbies = {frozenset(p) for p in load_json("derbies.json", {}).get(league_key, [])}
    overrides = load_json("importance_overrides.json", {}).get(league_key, {}).get(sstr(y), {})

    # provenance stamps — read from cache metadata only, never the network
    st_cur = fetcher.stamp(cur["url"])
    st_tbl = {py: (fetcher.stamp(tables[py]["src"]) if tables[py] else None) for py in past}
    st_hist = {py: (fetcher.stamp(hist_rounds[py]["url"]) if hist_rounds[py] else None) for py in past}
    st_kick = fetcher.stamp(kick_url)
    st_odds = fetcher.stamp(odds_url) if odds_url else None
    st_stars = file_stamp(os.path.join(DATA, "stars.json"))
    verified_fixtures = []

    # NOW records: tally completed results and cross-check against standings
    tally = {c: [0, 0, 0] for c in clubs}
    for m in done_cur:
        for c in (m["home"], m["away"]):
            if c in tally:
                tally[c]["WDL".index(persp(m, c)[0])] += 1
    now_rec = {}
    for c in clubs:
        row = cur["table"].get(c)
        if row is None:
            now_rec[c] = "—"
            log.cell("SEASON RECORD NOW", "club missing from live standings", c)
        elif [row["W"], row["D"], row["L"]] == tally[c]:
            now_rec[c] = "{}-{}-{}".format(*tally[c])
        else:
            now_rec[c] = "—"
            log.warn(f"NOW record mismatch for {c}: results tally {'-'.join(map(str, tally[c]))} vs standings {row['W']}-{row['D']}-{row['L']} — shown as —")

    # ---- per-fixture assembly
    fx_out = []
    for m in fixtures:
        h, a = m["home"], m["away"]
        label = f"{h} v {a}"
        done = m["hg"] is not None
        fx_date = dt.date.fromisoformat(m["date"]) if m["date"] else None
        entries = kick_by.get((h, a), [])
        et, entry, knote = pick_kickoff(entries, fx_date, ltz)
        if knote:
            log.note(f"{label}: {knote}")
        provisional = bool(entry and (entry.get("round") in prov_rounds or entry.get("tentative")))
        if entry and entry.get("tentative"):
            log.cell("TIME", f"provisional — NBC note: {entry.get('note') or 'time may change'}", label)
        if entry and entry.get("round") not in (None, rnd):
            log.note(f"{label}: kickoff source labels it Round {entry['round']}; results page (authority) says Round {rnd}")
        if et:
            la = et.astimezone(LA)
            kick_local = et.astimezone(ltz)
            show_date, time_s = la.date(), fmt_time(la) + ("*" if provisional else "")
            if entry.get("round") in prov_rounds:
                log.cell("TIME", "provisional — the whole round shows one identical placeholder time on sportbusy", label)
            if kick_local.date() != fx_date:
                fx_date = kick_local.date()
        else:
            kick_local, show_date, time_s = None, fx_date, "—"
            if knote:
                log.cell("TIME", "kickoff source conflicts with the results page (see notes)", label)
            elif done and not entries:
                log.cell("TIME", "completed fixture — kickoff source no longer lists it", label)
            elif done:
                log.cell("TIME", "completed fixture — kickoff source shows the score only", label)
            else:
                log.cell("TIME", f"not listed with a time on {kick_url}", label)

        win_h = win_a = None
        if not done and odds is not None:
            for ev in odds:
                if (ev["home"], ev["away"]) == (h, a) and (fx_date is None or abs((dt.date.fromisoformat(ev["date"]) - fx_date).days) <= 3):
                    win_h, win_a = ev["h"], ev["a"]
                    break
            if win_h is None:
                log.cell("WIN%", "no h2h market on The Odds API yet", label)
        elif not done:
            log.cell("WIN%", "ODDS_API_KEY not set", label)

        w1, w2, wcat, wx_urls = weather(fx_date, kick_local, stadiums.get(h), L, fetcher, today_local, log, label)
        wx = (w1, w2, wcat)
        before = m["date"] or "9999"
        prior = [x for x in done_cur if x["date"] < before and not (x["home"] == h and x["away"] == a)]
        fx_out.append(dict(m=m, home=h, away=a, done=done, fx_date=fx_date, show_date=show_date, et=et,
                           time=time_s, wx=wx, wx_urls=wx_urls, win_h=win_h, win_a=win_a, prior=prior))

    # closest fixture by win%
    open_w = [f for f in fx_out if f["win_h"] is not None]
    closest_ids = set()
    if open_w:
        gap = min(abs(f["win_h"] - f["win_a"]) for f in open_w)
        if gap <= 6:
            closest_ids = {id(f) for f in open_w if abs(f["win_h"] - f["win_a"]) == gap}

    fixtures_render = []
    for f in fx_out:
        h, a = f["home"], f["away"]
        label = f"{h} v {a}"
        pre = {c: dict(P=0, Pts=0, GD=0, GF=0) for c in clubs}
        lastres = {h: None, a: None}
        last_date = {h: "", a: ""}
        for x in f["prior"]:
            for c in (x["home"], x["away"]):
                if c not in pre:
                    continue
                o, gf, ga = persp(x, c)
                p = pre[c]
                p["P"] += 1
                p["Pts"] += {"W": 3, "D": 1, "L": 0}[o]
                p["GD"] += gf - ga
                p["GF"] += gf
                if c in lastres and x["date"] >= last_date[c]:
                    lastres[c], last_date[c] = (o, gf, ga), x["date"]
        order = sorted(clubs, key=lambda c: (-pre[c]["Pts"], -pre[c]["GD"], -pre[c]["GF"], c))
        ctx = dict(base=base_rank, prom=promoted, pre=pre, prank={c: i + 1 for i, c in enumerate(order)},
                   lastres=lastres, teams=teams, derbies=derbies)
        grade, reason = importance(f, ctx, id(f) in closest_ids)
        ov = overrides.get(label, {})
        if ov:
            grade, reason = ov.get("grade", grade), ov.get("text", reason)
            log.note(f"{label}: importance override applied from data/importance_overrides.json")
        imp = (grade if grade in ("high", "modhi", "mod", "low") else "mod", clip(reason))

        team_rows = []
        side_cells = {}
        for club, ha, win in ((h, "H", f["win_h"]), (a, "A", f["win_a"])):
            # star + status
            s = stars.get(club)
            if not s:
                star, status = "—", "—"
                log.cell("STAR/STATUS", "club not in data/stars.json", club)
            else:
                star, status = s.get("star") or "—", s.get("status") or "exp."
                if status in ("fit", "eased", "out"):
                    try:
                        age = (today - dt.date.fromisoformat(s.get("as_of", ""))).days
                    except ValueError:
                        age = None
                    if age is None or not 0 <= age <= 3:
                        log.cell("STATUS", f"'{status}' not confirmed by a dated source ≤3 days old — shown as exp.", club)
                        status = "exp."
                if status not in ("fit", "exp.", "eased", "out", "—"):
                    status = "—"
            # standing '26 '24 '25 NOW
            def pos_in(py):
                t = tables[py]
                if not t:
                    return "—"
                row = t["rows"].get(club)
                return str(row["pos"]) if row else "new"
            r26 = "PROM" if promoted[club] else pos_in(y - 1)
            now_row = cur["table"].get(club)
            if now_row is None:
                log.cell("STANDING NOW", "club not in live standings", club)
            standing = [r26, pos_in(y - 3), pos_in(y - 2), str(now_row["pos"]) if now_row else "—"]
            for py, v in ((y - 1, r26), (y - 3, standing[1]), (y - 2, standing[2])):
                if v == "new":
                    log.cell(f"STANDING {lab(py)}", "not in the top flight that season", club)
                elif v == "PROM":
                    log.cell("STANDING '26 / GF-GA baseline", "promoted — not in last season's table, baseline blank", club)
                elif v == "—":
                    log.cell(f"STANDING {lab(py)}", "season table unavailable", club)
            # baseline
            row = last_t["rows"].get(club) if last_t else None
            if row and row["ok"]:
                gfg, gag = row["GF"] / games, row["GA"] / games
                ratio = row["GF"] / row["GA"] if row["GA"] else None
                total = (row["GF"] + row["GA"]) / games
            else:
                gfg = gag = ratio = total = None
                if not last_t:
                    log.cell("GF/G GA/G GF/GA TOT/G", "last season's table unavailable", club)
            # last result
            lr = lastres[club]
            if lr:
                last_s, last_o = f"{lr[0]} {lr[1]}-{lr[2]}", lr[0]
            else:
                last_s, last_o = "—", None
                log.cell("LAST", "no completed league match before this fixture", club)
            # MATCH-N history
            hist = []
            for py in past:
                hr = hist_rounds[py]
                if hr is None:
                    hist.append("—")
                    continue
                mm = next((x for x in hr["block"] if club in (x["home"], x["away"])), None)
                if mm and mm["hg"] is not None:
                    hist.append(persp(mm, club)[0])
                elif mm:
                    hist.append("—")
                    log.cell(f"MATCH-{hist_n} HIST {lab(py)}", "fixture has no score on the results page", club)
                elif club not in hr["table"]:
                    hist.append("new")
                    log.cell(f"MATCH-{hist_n} HIST {lab(py)}", "not in the top flight that season", club)
                else:
                    hist.append("—")
                    log.cell(f"MATCH-{hist_n} HIST {lab(py)}", f"in that season's table but absent from its Round {hist_n} block", club)
            # season records
            records = []
            for py in past:
                t = tables[py]
                rr = t["rows"].get(club) if t else None
                if not t:
                    records.append("—")
                    log.cell(f"SEASON RECORD {lab(py)}", "season table could not be downloaded", club)
                elif rr is None:
                    records.append("new")
                    log.cell(f"SEASON RECORD {lab(py)}", "not in the top flight that season", club)
                elif not rr["ok"]:
                    records.append("—")
                else:
                    records.append(f"{rr['W']}-{rr['D']}-{rr['L']}")
            records.append(now_rec[club])
            # FT / WIN%
            if f["done"]:
                o, gf, ga = persp(f["m"], club)
                res = ("ft", f"{o} {gf}-{ga}", o)
            else:
                res = ("wp", win, None)
            # ---- the same values, recorded with the source each one came from
            vc = {
                "star": cell(star, st_stars),
                "status": cell(status, st_stars),
                "rank_prev": cell(standing[0], st_tbl[y - 1]),
                f"rank_{lab(y - 3)}": cell(standing[1], st_tbl[y - 3]),
                f"rank_{lab(y - 2)}": cell(standing[2], st_tbl[y - 2]),
                "now_rank": cell(standing[3], st_cur),
                "games_played": cell(now_row["P"] if now_row else None, st_cur),
                "gf_g": cell(gfg, st_tbl[y - 1]),
                "ga_g": cell(gag, st_tbl[y - 1]),
                "gf_ga": cell(ratio, st_tbl[y - 1]),
                "tot_g": cell(total, st_tbl[y - 1]),
                "last": cell(last_s, st_cur),
            }
            for py, v in zip(past, hist):
                vc[f"hist_{lab(py)}"] = cell(v, st_hist[py])
            for py, v in zip(past, records):
                vc[f"record_{lab(py)}"] = cell(v, st_tbl[py])
            vc["record_now"] = cell(records[-1], st_cur)
            if res[0] == "ft":
                vc["ft"] = cell(res[1], st_cur)
            else:
                vc["win_pct"] = cell(None if win is None else round(win, 1), st_odds)
            side_cells[ha] = vc

            team_rows.append(dict(ha=ha, team=club, star=star, status=status, standing=standing, gfg=gfg, gag=gag,
                                  ratio=ratio, total=total, last=last_s, last_o=last_o, hist=hist,
                                  records=records, res=res))

        sd = f["show_date"]
        st_when = st_kick if f["et"] else st_cur
        wx_stamp = combine([fetcher.stamp(u) for u in f["wx_urls"]])
        if f["wx"][2] == "tbc":
            # no forecast in range -> TBC per rule 7; keep the archive record when there was one
            wx_cell = {"v": "TBC"}
            if wx_stamp and f["wx"][0] == "Forecast TBC":
                wx_cell.update(src=wx_stamp["src"], at=wx_stamp["at"],
                               how="archive mean, same hour, ±3 days, last 3 yrs")
        else:
            wx_cell = cell(f"{f['wx'][0]} · {f['wx'][1]}", wx_stamp)
        verified_fixtures.append(dict(
            home=h, away=a, date=f["m"]["date"], round_label_src=cur["url"], done=f["done"],
            cells={"day": cell(sd.strftime("%a").upper() if sd else None, st_when),
                   "date": cell(f"{sd:%b} {sd.day}" if sd else None, st_when),
                   "time": cell(f["time"], st_kick),
                   "weather": wx_cell,
                   "importance": cell(f"{imp[0]}: {imp[1]}", st_cur, "derived from results/standings")},
            home_cells=side_cells["H"], away_cells=side_cells["A"]))
        fixtures_render.append(dict(
            sort=(f["et"].astimezone(pytz.utc).replace(tzinfo=None) if f["et"] else
                  dt.datetime.combine(sd or dt.date.max, dt.time(23, 59)), h),
            day=sd.strftime("%a").upper() if sd else "—", date=f"{sd:%b} {sd.day}" if sd else "—",
            time=f["time"], wx=f["wx"], imp=imp, done=f["done"], teams=team_rows))
        if sd and not f["et"]:
            log.cell("DATE", "no kickoff time — date is the results page's local date", label)
    fixtures_render.sort(key=lambda x: x["sort"])

    # ---- titles and footers
    ds = sorted(f["show_date"] for f in fx_out if f["show_date"])
    if ds:
        a, b = ds[0], ds[-1]
        if a == b:
            rng = f"{a:%b} {a.day}, {a.year}"
        elif (a.year, a.month) == (b.year, b.month):
            rng = f"{a:%b} {a.day}–{b.day}, {b.year}"
        else:
            rng = f"{a:%b} {a.day} – {b:%b} {b.day}, {b.year}"
    else:
        rng = "dates TBC"
    n_done = sum(f["done"] for f in fx_out)
    pending = [f"{f['home']} v {f['away']}" for f in fx_out if not f["done"]]
    title = f"{L['name']} — {L['round_word']} {rnd}  ·  {rng}"
    if not pending:
        state = "all fixtures final"
    elif n_done == 0:
        state = "no fixtures played yet"
    else:
        state = f"{n_done} of {len(fx_out)} final · pending: " + ", ".join(pending)
    sub = (f"{sstr(y)} season · data as of {today:%b} {today.day}, {today.year} (results page updated {cur['updated'] or 'n/a'})"
           f" · {state} · kickoffs America/Los_Angeles")

    foot1 = ("STANDING '26 = last season's final position (PROM = promoted), '24/'25 = final positions, NOW = live table  ·  "
             "GF/G, GA/G, TOT/G = last-season goals per game  ·  GF/GA = goals scored per goal conceded  ·  "
             f"LAST = most recent completed league result  ·  MATCH-{hist_n} HIST = club's Round {hist_n} result that season  ·  "
             "SEASON RECORD = league W-D-L (NOW = current)  ·  WIN% = odds-implied, overround removed")
    caveats = []
    if odds is None:
        caveats.append("WIN% — (no ODDS_API_KEY)")
    elif any(f["win_h"] is None and not f["done"] for f in fx_out):
        caveats.append("some odds pending")
    if any(w[2] == "tbc" and w[0] == "Forecast TBC" for w in (f["wx"] for f in fx_out)):
        caveats.append("forecasts only ≤7 days out; TBC temp = 3-yr archive mean")
    if any("*" in f["time"] for f in fx_out):
        caveats.append("* provisional kickoff time")
    if any(f["time"] == "—" for f in fx_out):
        caveats.append("TIME — where the source has no kickoff (completed games)")
    if catchups:
        caveats.append("catch-up in this round: " + "; ".join(catchups))
    for n in log.notes:
        if "not on lastseason" in n:
            caveats.append(n.split(":")[0] + " from topscorersfootball")
    kick_src = "NBC Sports (ET)" if L["kickoffs"] == "nbc" else "sportbusy.com (ET)"
    foot2 = (f"Sources: lastseason.co.uk season tables · topscorersfootball.com results/standings · {kick_src} kickoffs → PT · "
             "The Odds API · Open-Meteo weather.  " + ("Caveats: " + " · ".join(caveats) if caveats else ""))

    releg = tuple(str(i) for i in range(teams - 2, teams + 1))
    render_kw = dict(title=title, sub=sub, fixtures=fixtures_render,
                     stand_labels=[lab(y - 1), lab(y - 3), lab(y - 2), "NOW"],
                     hist_labels=[lab(py) for py in past], hist_title=f"MATCH-{hist_n} HIST",
                     rec_labels=[lab(py) for py in past] + ["NOW"], last_label="LAST",
                     foot1=foot1, foot2=foot2, releg=releg)
    header = f"Run log — {L['name']} {L['round_word']} {rnd} ({sstr(y)})"
    verified = dict(league=league_key, league_name=L["name"], season=sstr(y), round=rnd,
                    round_word=L["round_word"], hist_round=hist_n, teams=teams,
                    built_at=now.isoformat(timespec="seconds"),
                    fixtures=sorted(verified_fixtures, key=lambda x: (x["date"] or "9999", x["home"])))
    return dict(render=render_kw, out=L["out"].format(n=rnd), header=header, verified=verified)
