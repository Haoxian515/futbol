'use strict';
// Build data/<ucl|uel>/history.json: compact Champions League / Europa League history (every match
// with score, round, matchday, penalty goals; each season's league-/group-phase table; each club's
// country) from UEFA's feeds, for the finished seasons the chart uses (raw feed pages are ~8 MB per
// season; this file is small).
//
//   node scripts/build_ucl_history.js [ucl|uel]        (re-run once a season finishes)
// the raw feed pages (~8 MB per season) are only needed to build the compact file: don't archive them
process.env.FUTBOL_NO_ARCHIVE = '1';
const fs = require('fs');
const path = require('path');
const KEYS = { ucl: '../lib/ucl', uel: '../lib/uel' };
const key = process.argv[2] || 'ucl';
if (!KEYS[key]) throw new Error(`competition must be one of ${Object.keys(KEYS).join(', ')}`);
const ucl = require(KEYS[key]);
const { Fetcher } = require('../lib/fetch');

(async () => {
  const fetcher = new Fetcher({ mode: 'auto' });
  const cur = ucl.currentSeason(new Date().toISOString().slice(0, 10));
  const out = { source: `UEFA match & standings feeds (${ucl.INFO.name})`, built: new Date().toISOString().slice(0, 10), seasons: {} };
  for (let e = cur - ucl.HISTORY_SEASONS; e < cur; e++) {
    let ms = null;
    for (let tries = 0; tries < 3 && !ms; tries++) ms = await ucl.loadMatches(fetcher, e, 24 * 365);
    const table = await ucl.loadStandings(fetcher, e, 24 * 365);
    if (!ms || !table) throw new Error(`season ${e} unavailable`);
    out.seasons[e] = {
      matches: ms.filter((m) => m.done).map((m) => [m.date, m.home, m.away, m.hg, m.ag, m.hp, m.ap, m.phase ? 1 : 0, m.md, m.round]),
      table: Object.fromEntries([...table].map(([t, r]) => [t, [r.group, r.rank, r.W, r.D, r.L]])),
      countries: Object.fromEntries(ms.flatMap((m) => [[m.home, m.hc], [m.away, m.ac]]).filter(([, c]) => c)),
    };
    console.log(e, out.seasons[e].matches.length, 'matches,', table.size, 'table rows');
  }
  fs.mkdirSync(path.dirname(ucl.HISTORY_FILE), { recursive: true });
  fs.writeFileSync(ucl.HISTORY_FILE, JSON.stringify(out));
  console.log('wrote', path.relative(path.resolve(__dirname, '..'), ucl.HISTORY_FILE), fs.statSync(ucl.HISTORY_FILE).size, 'bytes');
})();
