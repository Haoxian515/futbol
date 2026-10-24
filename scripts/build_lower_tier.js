'use strict';
// Build data/lower/<league>.json: compact second-tier results (Championship, Segunda, Serie B,
// Ligue 2, 2. Bundesliga) for the finished seasons the scorelines chart covers, so a promoted
// club's 2C / 2D columns show the games it played in the division below instead of "—".
//
//   FUTBOL_NO_ARCHIVE=1 NODE_USE_ENV_PROXY=1 node scripts/build_lower_tier.js [firstSeason] [lastSeason]
const fs = require('fs');
const path = require('path');
const P = require('../lib/predict');
const BT = require('../lib/btts');
const { Fetcher } = require('../lib/fetch');

const now = new Date();
const curY = now.getUTCMonth() >= 6 ? now.getUTCFullYear() : now.getUTCFullYear() - 1; // season start year
const from = +(process.argv[2] || curY - 4);
const to = +(process.argv[3] || curY - 1); // finished seasons only

(async () => {
  const fetcher = new Fetcher({ mode: 'auto' });
  for (const [league, [div, name]] of Object.entries(P.LOWER)) {
    const file = BT.lowerFile(league);
    let out;
    try { out = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { out = { seasons: {} }; }
    out = { source: `football-data.co.uk ${div}`, division: name, built: now.toISOString().slice(0, 10), seasons: out.seasons };
    for (let y = from; y <= to; y++) {
      const games = await P.loadDiv(fetcher, div, y, (x) => x, 24);
      if (!games || !games.length) throw new Error(`${league} ${div} ${y} unavailable`);
      out.seasons[y] = games.map((g) => [g.date, g.home, g.away, g.hg, g.ag]);
    }
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(out));
    console.log(league, div, Object.keys(out.seasons).join(','), fs.statSync(file).size, 'bytes');
  }
})();
