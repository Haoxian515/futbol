"""Match-analysis chart for one league round.

    python chart.py --league pl --round 4
    python chart.py --league laliga --round 5 --refresh
    python chart.py --league pl --round 4 --history-round 2
    python chart.py --league pl --round 4 --verify-only

The loop is fetch -> verify -> render (CLAUDE.md):
  fetch    network, cached under data/cache/
  verify   offline; writes data/verified/<league>/<season>/round-<n>.json where every cell
           carries {v, src, at}, plus the pending ledger, then runs checks/gates.py
  render   deterministic code, and only once every gate passes
"""
import argparse
import os
import sys
import time

ROOT = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, ROOT)

from src import model  # noqa: E402
from src import verify as V  # noqa: E402
from src.fetch import Fetcher  # noqa: E402


def rel(p):
    return os.path.relpath(p, ROOT)


def main():
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    except AttributeError:
        pass
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--league", required=True, choices=sorted(model.LEAGUES))
    ap.add_argument("--round", required=True, type=int, help="matchweek / jornada")
    ap.add_argument("--refresh", action="store_true", help="re-fetch every source instead of using the cache")
    ap.add_argument("--history-round", type=int, help="round N for the MATCH-N HIST block (default: --round)")
    ap.add_argument("--verify-only", action="store_true", help="fetch and verify, then stop before rendering")
    args = ap.parse_args()

    t0 = time.time()
    fetcher = Fetcher(refresh=args.refresh)
    log = model.RunLog()

    # ---- fetch: the only stage allowed on the network
    try:
        payload = model.build(args.league, args.round, args.history_round, fetcher, log)
    except model.ChartError as e:
        print(log.dump(fetcher, f"Run log — {args.league} round {args.round}"))
        print(f"\nERROR: {e}")
        return 2

    # ---- verify: offline. Records every rendered cell with its source, then gates the round.
    doc = payload["verified"]
    teams = V.spec_teams(args.league, doc["teams"], log)
    round_path, pending_path, open_items, failures = V.verify(doc, log, teams)

    print(log.dump(fetcher, payload["header"]))
    n_ok, n_empty = V.counts(doc)
    print(f"\nVerified {n_ok} sourced cells, {n_empty} shown as —/new/TBC → {rel(round_path)}")
    print(f"Pending: {open_items} open item(s) → {rel(pending_path)}")

    if failures:
        print(f"\nGATES FAILED ({len(failures)}) — render blocked, CLAUDE.md rule 9:")
        for f in failures:
            print(f"  ✗ {f}")
        print("\nNothing was rendered. Fix the source or the ledger entry, then re-run.")
        return 3
    print("Gates: ALL PASS (checks/gates.py)")

    if args.verify_only:
        print(f"--verify-only: stopped before render ({time.time() - t0:.1f}s, {fetcher.network} network requests)")
        return 0

    # ---- render: deterministic, unblocked
    from src import render  # matplotlib import deferred until there is something to draw
    out_dir = os.path.join(ROOT, "out")
    os.makedirs(out_dir, exist_ok=True)
    path = os.path.join(out_dir, payload["out"])
    render.render(path, **payload["render"])
    print(f"Wrote {rel(path)} in {time.time() - t0:.1f}s ({fetcher.network} network requests)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
