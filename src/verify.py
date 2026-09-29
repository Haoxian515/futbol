"""Verify stage: cached fetches -> a verified round file -> the gates that unblock rendering.

Offline by design (CLAUDE.md rule 1). Nothing here touches the network: it consumes what
build() assembled from the cache and decides whether the chart may be drawn. It may reject;
it may never invent. checks/gates.py is the authority on pass/fail — this module only shapes
the data for it, reports failures usefully, and keeps the pending ledger.
"""
import datetime as dt
import importlib.util
import json
import os

from src import fetch as F

ROOT = F.ROOT
VERIFIED = os.path.join(ROOT, "data", "verified")
LEAGUES_DIR = os.path.join(ROOT, "leagues")
EMPTIES = ("—", "new", "TBC")


# ------------------------------------------------------------------ league spec
def _read_yaml(path):
    try:
        import yaml
    except ImportError:
        return None
    try:
        with open(path, encoding="utf-8") as fh:
            d = yaml.safe_load(fh)
    except Exception:  # noqa: BLE001
        return None
    return d if isinstance(d, dict) else None


def load_spec(code):
    """leagues/<code>.yaml — the spec is the authority for how many fixtures a round has.

    The filename need not match the code, so fall back to scanning for `code:` in each spec.
    """
    direct = os.path.join(LEAGUES_DIR, f"{code}.yaml")
    if os.path.exists(direct):
        d = _read_yaml(direct)
        if d:
            return dict(d, _file=f"leagues/{code}.yaml")
    if not os.path.isdir(LEAGUES_DIR):
        return None
    for name in sorted(os.listdir(LEAGUES_DIR)):
        if not name.endswith(".yaml") or name.startswith("_"):
            continue
        d = _read_yaml(os.path.join(LEAGUES_DIR, name))
        if d and d.get("code") == code:
            return dict(d, _file=f"leagues/{name}")
    return None


def spec_teams(code, fallback, log=None):
    """Fixture count comes from the league spec; disagreement with the model is loud."""
    spec = load_spec(code)
    if not spec or not spec.get("teams"):
        if log:
            log.note(f"no league spec with code '{code}' in leagues/ — used the model's {fallback} teams")
        return fallback
    if spec["teams"] != fallback and log:
        log.warn(f"{spec.get('_file', code)} says {spec['teams']} teams but the model says {fallback} "
                 f"— gated on the spec ({spec['teams']})")
    return spec["teams"]


# ------------------------------------------------------------------ gates
def load_gates():
    path = os.path.join(ROOT, "checks", "gates.py")
    if not os.path.exists(path):
        raise FileNotFoundError(f"{path} is missing — rendering stays blocked without the gates")
    spec = importlib.util.spec_from_file_location("gates", path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def unsourced(doc):
    """Which cells would fail gate_provenance, named — the gate itself only names the key."""
    out = []
    for f in doc["fixtures"]:
        label = f"{f['home']} v {f['away']}"
        groups = [("fixture", f.get("cells", {})), (f["home"], f["home_cells"]), (f["away"], f["away_cells"])]
        for who, cells in groups:
            for k, c in cells.items():
                if c.get("v") not in EMPTIES and not (c.get("src") and c.get("at")):
                    out.append(f"{label} [{who}] {k}={c.get('v')!r}")
    return out


def run_gates(doc, teams):
    """-> list of failure strings; empty means the render is unblocked."""
    g = load_gates()
    failures = []
    for fn in g.GATES:
        try:
            fn(doc, teams) if fn is g.gate_complete_round else fn(doc)
        except AssertionError as e:
            failures.append(f"{fn.__name__}: {e}")
        except Exception as e:  # noqa: BLE001
            failures.append(f"{fn.__name__}: {type(e).__name__}: {e}")
    # the fixture-level columns (DAY/DATE/TIME/WEATHER/IMPORTANCE) are rendered cells too, so
    # they face the same rule — reuse the gate rather than writing a second copy of it
    shadow = {"fixtures": [{"home": f["home"], "away": f["away"],
                            "home_cells": f.get("cells", {}), "away_cells": {}} for f in doc["fixtures"]]}
    try:
        g.gate_provenance(shadow)
    except AssertionError as e:
        failures.append(f"gate_provenance [fixture columns]: {e}")
    if any("provenance" in f for f in failures):
        for d in unsourced(doc)[:20]:
            failures.append(f"  unsourced: {d}")
    return failures


# ------------------------------------------------------------------ pending ledger
HINTS = (
    ("season table unavailable", "pull that season's table (lastseason.co.uk CSV, then the HTML page)"),
    ("season table could not be downloaded", "pull that season's table (lastseason.co.uk CSV, then the HTML page)"),
    ("results page for that season unavailable", "pull that season's topscorersfootball page"),
    ("absent from its Round", "re-pull that season's results page and check the round block"),
    ("no score on the results page", "re-pull that season's results page once the fixture is filled in"),
    ("not in data/stars.json", "curate data/stars.json for this club (human-curated, rule 6)"),
    ("not confirmed by a dated source", "add a dated status source ≤3 days old, or leave it as exp."),
    ("ODDS_API_KEY not set", "set ODDS_API_KEY and re-run"),
    ("no h2h market", "re-pull odds nearer kickoff"),
    (">7 days out", "re-pull the forecast within 7 days of kickoff"),
    ("Open-Meteo", "re-pull the forecast, or fix the stadium coords in data/stadiums.json"),
    ("no city in data/team_cities.json", "add the club's city to data/team_cities.json"),
    ("kickoff source", "re-pull the kickoff source, or wait for it to publish the slot"),
    ("not listed with a time", "re-pull the kickoff source once it publishes the slot"),
    ("missing from live standings", "re-pull the standings feed"),
    ("provisional", "re-pull the kickoff source once the slot is confirmed; the * comes off then"),
    ("date is the results page", "re-pull the kickoff source for a time, which also fixes the date"),
    ("kickoff hour unknown", "re-pull the kickoff source for a time, then re-pull the forecast at that hour"),
)
STRUCTURAL = ("not in the top flight that season", "promoted — not in last season",
              "completed fixture", "no completed league match")


def hint(reason):
    for needle, h in HINTS:
        if needle in reason:
            return h
    return None


def write_pending(doc, log, path=None):
    """The exact pulls that would fill the gaps — the backfiller's work queue.

    One ledger per league, accumulated across rounds: entries for the round just built
    replace their previous selves, entries for other rounds are left standing, so charting
    round 8 does not erase what round 4 still needs.
    """
    season, rnd = doc["season"], doc["round"]
    items, structural = [], []
    for (field, reason), things in log.cells.items():
        entry = {"season": season, "round": rnd, "field": field, "reason": reason, "subjects": list(things)}
        if any(s in reason for s in STRUCTURAL):
            structural.append(entry)
        else:
            entry["resolve"] = hint(reason) or "investigate: no known pull resolves this"
            items.append(entry)
    warnings = [{"season": season, "round": rnd, "text": w} for w in log.warnings]

    path = path or os.path.join(VERIFIED, doc["league"], "pending.json")
    prev = {"open": [], "structural": [], "warnings": []}
    if os.path.exists(path):
        try:
            with open(path, encoding="utf-8") as fh:
                prev = json.load(fh)
        except (OSError, ValueError):
            pass

    def others(key):
        return [e for e in prev.get(key, []) if (e.get("season"), e.get("round")) != (season, rnd)]

    items = others("open") + items
    structural = others("structural") + structural
    warnings = others("warnings") + warnings
    items.sort(key=lambda e: (e.get("season", ""), e.get("round", 0),
                              e.get("resolve", "").startswith("investigate"), e.get("field", "")))
    out = {"league": doc["league"], "updated_at": dt.datetime.now().isoformat(timespec="seconds"),
           "open": items, "structural": structural, "warnings": warnings}
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as fh:
        json.dump(out, fh, indent=1, ensure_ascii=False)
    return path, len(items)


def write_round(doc):
    path = os.path.join(VERIFIED, doc["league"], doc["season"], f"round-{doc['round']}.json")
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as fh:
        json.dump(doc, fh, indent=1, ensure_ascii=False)
    return path


def counts(doc):
    """-> (verified cells, sanctioned empties) across every rendered cell."""
    v = e = 0
    for f in doc["fixtures"]:
        for cells in (f.get("cells", {}), f["home_cells"], f["away_cells"]):
            for c in cells.values():
                if c.get("v") in EMPTIES:
                    e += 1
                else:
                    v += 1
    return v, e


def verify(doc, log, teams):
    """Write the verified round + ledger, then gate it.

    -> (round path, pending path, open pending count, gate failures)
    """
    rp = write_round(doc)
    pp, n_open = write_pending(doc, log)
    return rp, pp, n_open, run_gates(doc, teams)
