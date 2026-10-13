'use strict';
// Fill data/archive (the committed store of historic fetches — see lib/fetch.js) by building every
// played round of every competition, plus the current round. Anything fetched or read from cache
// with a historic TTL is copied into data/archive; commit that folder afterwards.
//
//   NODE_USE_ENV_PROXY=1 node scripts/warm_archive.js [league ...]     (default: all)
const fs = require('fs');
const path = require('path');
const { Fetcher, ARCHIVE_DIR } = require('../lib/fetch');
const model = require('../lib/model');
const ucl = require('../lib/ucl');
const nations = require('../lib/nations');

const count = () => (fs.existsSync(ARCHIVE_DIR) ? fs.readdirSync(ARCHIVE_DIR).filter((f) => f.endsWith('.meta.json')).length : 0);

const comps = [
  ...Object.keys(model.LEAGUES).map((k) => [k, (f) => model.listRounds(k, f), (n, f, log) => model.build(k, n, null, f, log)]),
  ['ucl', (f) => ucl.listRounds(f), (n, f, log) => ucl.build(n, null, f, log)],
  ...nations.LETTERS.map((lg) => [nations.info(lg).key, (f) => nations.listRounds(lg, f), (n, f, log) => nations.build(lg, n, null, f, log)]),
];

(async () => {
  const want = process.argv.slice(2);
  for (const [key, list, build] of comps) {
    if (want.length && !want.includes(key)) continue;
    const f = new Fetcher({ mode: 'auto' });
    let rounds;
    try {
      rounds = await list(f);
    } catch (e) {
      console.log(key, 'rounds unavailable:', e.message);
      continue;
    }
    const todo = rounds.rounds.filter((r) => r.played > 0 || r.n === rounds.defaultRound).map((r) => r.n);
    for (const n of todo) {
      const before = count();
      try {
        await build(n, f, new model.RunLog());
        console.log(`${key} round ${n}: +${count() - before} archived`);
      } catch (e) {
        console.log(`${key} round ${n}: ${e.message}`);
      }
    }
  }
  const files = fs.readdirSync(ARCHIVE_DIR);
  const bytes = files.reduce((a, x) => a + fs.statSync(path.join(ARCHIVE_DIR, x)).size, 0);
  console.log(`data/archive: ${count()} entries, ${(bytes / 1e6).toFixed(1)} MB`);
})();
