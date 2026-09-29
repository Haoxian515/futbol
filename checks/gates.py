"""Executable verification gates. Render is blocked until all pass.
Each gate encodes a bug actually caught during the manual chart era."""
import json, sys, collections

def gate_complete_round(round_data, teams):
    fx = round_data["fixtures"]
    assert len(fx) == teams // 2, f"round has {len(fx)} fixtures, need {teams//2}"
    seen = collections.Counter(t for f in fx for t in (f["home"], f["away"]))
    dup = [t for t, c in seen.items() if c != 1]
    assert not dup, f"teams not exactly once: {dup}"   # catches catch-ups mixed in

def gate_round_label(round_data):
    for f in round_data["fixtures"]:
        assert f.get("round_label_src"), f"{f['home']}-{f['away']}: round inferred, not source-labeled"

def gate_provenance(round_data):
    for f in round_data["fixtures"]:
        for side in ("home_cells", "away_cells"):
            for k, cell in f[side].items():
                if cell["v"] not in ("\u2014", "new", "TBC"):
                    assert cell.get("src") and cell.get("at"), f"{k} lacks provenance"

def gate_records(round_data):
    for f in round_data["fixtures"]:
        for side in ("home_cells", "away_cells"):
            now = f[side].get("record_now", {}).get("v")
            gp = f[side].get("games_played", {}).get("v")
            if now not in (None, "\u2014") and gp:
                w, d, l = map(int, now.split("-"))
                assert w + d + l == int(gp), f"record {now} != games played {gp}"

def gate_standings_authority(round_data):
    for f in round_data["fixtures"]:
        for side in ("home_cells", "away_cells"):
            for k in ("now_rank", "record_now"):
                cell = f[side].get(k)
                if cell and cell["v"] != "\u2014":
                    assert cell["src"] != "computed", f"{k} must cite the standings feed"

GATES = [gate_complete_round, gate_round_label, gate_provenance, gate_records, gate_standings_authority]

if __name__ == "__main__":
    path, teams = sys.argv[1], int(sys.argv[2])
    data = json.load(open(path))
    for g in GATES:
        g(data, teams) if g is gate_complete_round else g(data)
    print("ALL GATES PASS")
