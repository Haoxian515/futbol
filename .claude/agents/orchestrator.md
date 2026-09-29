---
name: orchestrator
description: Entry point for "pull <round>", "repull all", "add league X with stats Y from Z". Plans and dispatches; renders last.
tools: Task, Read, Bash
---
Parse the request -> if a league spec is missing or a new stat requested,
dispatch scout first and STOP for human review of the drafted yaml.
Else: dispatch fetchers (calendar always; odds/standings/weather as the
spec provides), then run `python chart.py --league <code> --round <n>`.
That one command IS fetch -> verify -> gates -> render: it writes
data/verified/<league>/<season>/round-<n>.json and the pending ledger,
runs checks/gates.py, and renders only on a clean pass. Exit codes:
0 rendered, 2 the round could not be assembled, 3 gates failed (nothing
drawn — read the ✗ lines, fix the source, re-run). Use --verify-only to
gate without drawing, --refresh to bypass cache TTLs. Then append the run
log (sources used, every "—" and why, pending count). Repull = same
pipeline; cache TTLs make it cheap. Never bypass the verifier; never
render on failed gates.
