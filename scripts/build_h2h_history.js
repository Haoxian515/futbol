'use strict';
// Build data/h2h/<league>.json: compact league results for 1993-94 up to (not including) the
// seasons the app loads in full, used only for long-range head-to-head in the BTTS study.
// Raw football-data.co.uk season files are ~100-200 KB each; this keeps ~23 seasons per league small.
//
//   FUTBOL_NO_ARCHIVE=1 NODE_USE_ENV_PROXY=1 node scripts/build_h2h_history.js
const fs = require('fs');
const path = require('path');
const P = require('../lib/predict');
const BT = require('../lib/btts');
const { Fetcher } = require('../lib/fetch');

(async () => {
  const fetcher = new Fetcher({ mode: 'auto' });
  for (const league of Object.keys(P.DIV)) {
    const out = { source: `football-data.co.uk ${P.DIV[league]}`, built: new Date().toISOString().slice(0, 10), seasons: {} };
    for (let y = BT.DEEP_FROM; y < BT.H2H_FROM; y++) {
      const games = await P.loadSeason(fetcher, league, y, (x) => x, 24);
      if (!games || !games.length) throw new Error(`${league} ${y} unavailable`);
      out.seasons[y] = games.map((g) => [g.date, g.home, g.away, g.hg, g.ag]);
    }
    const file = BT.deepFile(league);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(out));
    console.log(league, Object.keys(out.seasons).length, 'seasons,', fs.statSync(file).size, 'bytes');
  }
})();
