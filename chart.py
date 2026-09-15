"""Match-analysis chart for one league round.

    python chart.py --league pl --round 4
    python chart.py --league laliga --round 5 --refresh
    python chart.py --league pl --round 4 --history-round 2
"""
import argparse
import os
import sys
import time

ROOT = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, ROOT)

from src import model  # noqa: E402
from src.fetch import Fetcher  # noqa: E402


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
    args = ap.parse_args()

    t0 = time.time()
    fetcher = Fetcher(refresh=args.refresh)
    log = model.RunLog()
    try:
        payload = model.build(args.league, args.round, args.history_round, fetcher, log)
    except model.ChartError as e:
        print(log.dump(fetcher, f"Run log — {args.league} round {args.round}"))
        print(f"\nERROR: {e}")
        return 2

    from src import render  # matplotlib import deferred until there is something to draw
    out_dir = os.path.join(ROOT, "out")
    os.makedirs(out_dir, exist_ok=True)
    path = os.path.join(out_dir, payload["out"])
    render.render(path, **payload["render"])
    print(log.dump(fetcher, payload["header"]))
    print(f"\nWrote {os.path.relpath(path, ROOT)} in {time.time() - t0:.1f}s ({fetcher.network} network requests)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
