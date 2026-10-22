# Futbol chart system — constitution (all agents inherit this)

## Non-negotiables
1. VERIFIED-ONLY: every rendered cell traces to a cached source record
   {value, source, fetched_at} or renders "—" (or "new"/"TBC"). No cell is
   ever filled from model memory. The verifier agent has no network access
   by design — it can only bless or reject cached data.
2. COMPLETE-ROUND RULE: a round chart contains every fixture of the round
   (PL/La Liga/Serie A 10, Ligue 1/Bundesliga 9, UCL/UEL league phase 18,
   NL League A 8). The
   FIXTURE CALENDAR is the authority for what exists; odds feeds only
   decorate. Missing odds/times/forecasts = "—", never omitted rows.
   Moved/catch-up games appear in their labeled round with FT score.
3. ROUND LABELS, NOT DATES: take "Round N"/"Matchday N" from the source's
   own label. Round dates shift between seasons.
4. MATCH-N HISTORY: the history block shows each club's result in game N
   of past seasons where N = the charted round (--history-round overrides).
5. FULL COLUMN SET, never drop a column:
   DAY|DATE|TIME (PT)|TEAM|H/A|INJURED|SUSP.|STANDING('26,'24,'25,NOW)|GF/G|
   GA/G|GF/GA|TOT/G|LAST|MATCH-N HIST '23-'26|SEASON RECORD '23-'26+NOW|
   FT/WIN%|H2H LAST 5 and LAST 20 (each: results, W-D-L, GF-GA with non-penalty line, and per
   goal count 0/1/2/3+ the games with that many scored over the games with that many conceded)|WEATHER|IMPORTANCE. League extra_columns append
   after the core set.
6. INJURED / SUSP. (formerly STAR / STATUS, repurposed by the owner) come
   only from a dated injuries & suspensions source (SportsGambler league
   pages) whose "Updated" stamp is ≤3 days old, and only for fixtures not
   yet played; otherwise "—". Agents never guess a player's availability.
7. Weather only from a real forecast ≤7 days out (Open-Meteo, kickoff
   hour, stadium coords); otherwise "TBC".
8. Live standings overrule running tallies for NOW records and positions.
9. HISTORY IS STORED, NOT RE-PULLED: anything finished (past seasons, played games' penalties,
   pre-kickoff market prices, past weather, settled rounds' market listings) is fetched with a
   TTL >= HISTORIC_TTL (lib/fetch.js) so it lands in data/archive and is never downloaded again;
   heavy history goes to compact committed stores instead (data/ucl/history.json, data/h2h/,
   data/penalties/, data/markets/). Commit new data/archive + store files with the change.
   scripts/archive_audit.js lists what finished rounds still download; scripts/warm_archive.js
   fills the archive.
10. Renderer (chart.py -> src/render.py) is deterministic code, never an
   agent. Blocked until checks/gates.py passes for the round. chart.py runs
   the whole loop itself: fetch (network) -> verify (offline) -> gates ->
   render, and exits 3 without drawing anything if a gate fails.

## Escalate to the human (do not improvise)
- A source's schema changed or a gate fails twice.
- Two sources disagree on a result.
- A league spec requests a stat with no fetchable source (scout must
  report alternatives, not substitute silently).
