'use strict';
// Which static history still gets downloaded? Builds rounds that are already finished with an empty
// cache overlay (only the committed data/cache, data/archive and compact stores are available) and
// lists every source that had to go to the network:
//   HISTORIC — requested as historic but not in data/archive yet (run scripts/warm_archive.js, commit)
//   LIVE     — current data (this season's pages, today's tables, injuries): expected
// A historic-looking URL showing up as LIVE means its code asks for it with a short TTL: give it a
// TTL >= HISTORIC_TTL (lib/fetch.js) so it is stored.
//
//   NODE_USE_ENV_PROXY=1 node scripts/archive_audit.js [league ...]     (default: every competition)
const fs = require('fs');
const os = require('os');
const path = require('path');

const overlay = fs.mkdtempSync(path.join(os.tmpdir(), 'futbol-audit-'));
process.env.FUTBOL_CACHE_DIR = overlay; // fresh overlay: nothing cached this session counts
process.env.FUTBOL_NO_ARCHIVE = '1'; // read the archive, don't add to it
const { Fetcher } = require('../lib/fetch');
const model = require('../lib/model');
const ucl = require('../lib/ucl');
const nations = require('../lib/nations');

const comps = [
  ...Object.keys(model.LEAGUES).map((k) => [k, (f) => model.listRounds(k, f), (n, f) => model.build(k, n, null, f, new model.RunLog())]),
  ['ucl', (f) => ucl.listRounds(f), (n, f) => ucl.build(n, null, f, new model.RunLog())],
  ...nations.LETTERS.map((lg) => [nations.info(lg).key, (f) => nations.listRounds(lg, f), (n, f) => nations.build(lg, n, null, f, new model.RunLog())]),
];

(async () => {
  const want = process.argv.slice(2);
  let historicMissing = 0;
  for (const [key, list, build] of comps) {
    if (want.length && !want.includes(key)) continue;
    const r = await list(new Fetcher({ mode: 'auto' })).catch(() => null);
    const done = r && r.rounds.filter((x) => x.total && x.played === x.total).pop();
    if (!done) { console.log(`${key}: no finished round to audit`); continue; }
    const f = new Fetcher({ mode: 'auto' });
    try { await build(done.n, f); } catch (e) { console.log(`${key}: build failed (${e.message})`); continue; }
    const net = f.sources.filter((s) => /network|FAILED/.test(s.how));
    const hist = net.filter((s) => s.historic);
    historicMissing += hist.length;
    console.log(`${key} round ${done.n}: ${f.sources.length} sources, ${net.length} from the network (${hist.length} historic not yet stored, ${net.length - hist.length} live)`);
    const group = (xs) => Object.entries(xs.reduce((a, s) => { const u = s.url.replace(/^https?:\/\//, '').replace(/\?.*$/, '?…'); a[u] = (a[u] || 0) + 1; return a; }, {}));
    for (const [u, n] of group(hist)) console.log(`   HISTORIC ${n}× ${u}`);
    for (const [u, n] of group(net.filter((s) => !s.historic))) console.log(`   live     ${n}× ${u}`);
  }
  fs.rmSync(overlay, { recursive: true, force: true });
  console.log(historicMissing ? `\n${historicMissing} historic fetch(es) not stored yet: run scripts/warm_archive.js and commit data/archive`
    : '\nall historic data used by these rounds is stored');
})();
