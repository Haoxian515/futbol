'use strict';
// Build data/penalties/<league>.json: penalty goals per match for finished seasons, from ESPN,
// cross-checked against football-data.co.uk scores (see lib/penalties.js).
//
//   node scripts/build_penalties.js [league ...]      (default: all four)
//
// Re-run once a season finishes. The current season is read live at chart time instead.
const fs = require('fs');
const path = require('path');
const P = require('../lib/predict');
const PEN = require('../lib/penalties');
const { Fetcher } = require('../lib/fetch');

const ROOT = path.resolve(__dirname, '..');
const aliases = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'aliases.json'), 'utf8'));
const canon = (n) => aliases[n] || n;
const FIRST = 2021;

function seasonStart(d) { return d.getUTCMonth() >= 6 ? d.getUTCFullYear() : d.getUTCFullYear() - 1; }

(async () => {
  const leagues = process.argv.slice(2).length ? process.argv.slice(2) : Object.keys(PEN.ESPN);
  const last = seasonStart(new Date()) - 1; // finished seasons only
  const fetcher = new Fetcher({ mode: 'auto' });
  fs.mkdirSync(path.join(ROOT, 'data', 'penalties'), { recursive: true });
  for (const league of leagues) {
    const matches = {};
    const coverage = {};
    for (let y = FIRST; y <= last; y++) {
      const games = await P.loadSeason(fetcher, league, y, canon, PEN.TTL_PAST);
      if (!games) { coverage[`${y}-${String(y + 1).slice(2)}`] = 'football-data season unavailable'; continue; }
      const found = await PEN.forGames(fetcher, league, games, canon, { ttl: PEN.TTL_PAST, useStored: false });
      let pens = 0;
      for (const g of games) {
        const p = found.get(PEN.key(g));
        if (p) { matches[PEN.key(g)] = [p.hp, p.ap]; pens += p.hp + p.ap; }
      }
      const s = `${y}-${String(y + 1).slice(2)}`;
      coverage[s] = { games: games.length, matched: found.size, penaltyGoals: pens };
      console.log(league, s, coverage[s]);
    }
    const out = { source: 'ESPN scoreboard (penaltyKick goals), cross-checked against football-data.co.uk scores',
      built: new Date().toISOString().slice(0, 10), coverage, matches };
    fs.writeFileSync(PEN.file(league), JSON.stringify(out));
    console.log('wrote', path.relative(ROOT, PEN.file(league)), Object.keys(matches).length, 'matches', `${fetcher.network} requests so far`);
  }
})();
