"""Each gate must actually fire — a gate that cannot fail protects nothing.

Takes the most recent verified round, mutates one thing, and checks the gate catches it:

    python checks/test_gates.py

Run it after touching gates.py, the verified-round shape, or src/verify.py.
"""
import copy
import glob
import json
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)

from src import verify as V  # noqa: E402


def newest_round():
    pat = os.path.join(ROOT, "data", "verified", "*", "*", "round-*.json")
    files = sorted(glob.glob(pat), key=os.path.getmtime, reverse=True)
    return files[0] if files else None


def check(doc, teams, name, mutate, expect):
    d = copy.deepcopy(doc)
    mutate(d)
    fails = V.run_gates(d, teams)
    hit = [f for f in fails if expect in f]
    print(f"  {'ok  ' if hit else 'FAIL'} {name:38} {hit[0][:80] if hit else '-- NOT CAUGHT --'}")
    return bool(hit)


def main():
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    except AttributeError:
        pass
    path = newest_round()
    if not path:
        print("no verified round yet — run: python chart.py --league pl --round <n> --verify-only")
        return 2
    with open(path, encoding="utf-8") as fh:
        doc = json.load(fh)
    teams = doc["teams"]
    print(f"Gate tests against {os.path.relpath(path, ROOT)} ({teams} teams)\n")

    base = V.run_gates(copy.deepcopy(doc), teams)
    print(f"  {'ok  ' if not base else 'FAIL'} {'unmutated round passes':38} {base[0][:80] if base else ''}")
    ok = not base

    cases = [
        ("provenance: cell loses its source", lambda d: d["fixtures"][0]["home_cells"]["gf_g"].pop("src", None),
         "gate_provenance"),
        ("provenance: fixture column", lambda d: d["fixtures"][0]["cells"]["importance"].pop("src", None),
         "fixture columns"),
        ("records: W-D-L vs games played",
         lambda d: d["fixtures"][0]["home_cells"].update(record_now={"v": "9-9-9", "src": "x", "at": "y"}),
         "gate_records"),
        ("standings authority: src=computed",
         lambda d: d["fixtures"][0]["home_cells"]["now_rank"].update(src="computed"), "gate_standings_authority"),
        ("round label: not source-labeled", lambda d: d["fixtures"][0].update(round_label_src=""),
         "gate_round_label"),
        ("complete round: fixture missing", lambda d: d["fixtures"].pop(), "gate_complete_round"),
        ("complete round: team twice",
         lambda d: d["fixtures"][1].update(home=d["fixtures"][0]["home"]), "gate_complete_round"),
    ]
    for name, mutate, expect in cases:
        ok &= check(doc, teams, name, mutate, expect)

    d = copy.deepcopy(doc)
    d["fixtures"][0]["home_cells"]["gf_g"].pop("src", None)
    named = [f for f in V.run_gates(d, teams) if "unsourced:" in f]
    print(f"  {'ok  ' if named else 'FAIL'} {'failure names the offending cell':38} {named[0].strip()[:80] if named else ''}")
    ok &= bool(named)

    print("\nALL GATE TESTS PASS" if ok else "\nSOME GATE TESTS FAILED")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
