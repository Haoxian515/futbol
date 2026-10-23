'use strict';
// JSON API shared by the local server (server.js) and the Vercel functions (api/*.js).
//
//   GET /api/leagues
//   GET /api/rounds?league=pl[&data=auto|cache|fresh]
//   GET /api/chart?league=pl&round=4[&data=auto|cache|fresh][&historyRound=2]
//   GET /api/upcoming   each competition's next unplayed fixture (date + round), soonest first
//
// data=auto (default) re-pulls only cached entries past their TTL (current-season pages after 6h,
// past seasons after 30 days) that were not fetched this match week (lib/weekcache.js: kept until the
// next week or until one of the competition's games has finished); data=cache uses whatever was already
// fetched, whatever its age, and only goes online for sources never fetched; data=fresh re-pulls
// every source. refresh=1 = fresh.
// Builds run one at a time per process so shared cache files are never written concurrently.

const { Fetcher, MODES, WRITE_DIR } = require('./fetch');
const W = require('./weekcache');
const model = require('./model');
const intl = require('./intl');
const nations = require('./nations');
const ucl = require('./ucl');
const uel = require('./uel');

// Competitions outside the club-league model: their own rounds list and builder.
const COMPS = {
  ...Object.fromEntries([ucl, uel].map((C) => [C.INFO.key, {
    info: C.INFO, maxRound: C.MDS,
    listRounds: (f) => C.listRounds(f), build: (n, h, f, log) => C.build(n, h, f, log),
    known: (e) => e instanceof model.ChartError,
  }])),
  ...Object.fromEntries(nations.LETTERS.map((lg) => [nations.info(lg).key, {
    info: nations.info(lg), maxRound: nations.MDS,
    listRounds: (f) => nations.listRounds(lg, f), build: (n, h, f, log) => nations.build(lg, n, h, f, log),
    known: (e) => e instanceof model.ChartError,
  }])),
  [intl.KEY]: {
    info: intl.INFO, maxRound: 999,
    listRounds: (f) => intl.listWindows(f), build: (n, h, f, log) => intl.build(n, f, log),
    known: (e) => e instanceof intl.IntlError,
  },
};

// Which git branch/commit this server runs: Vercel's build env, else the local checkout.
let ver = null;
function version() {
  if (ver) return ver;
  let branch = process.env.VERCEL_GIT_COMMIT_REF || null;
  let commit = process.env.VERCEL_GIT_COMMIT_SHA || null;
  if (!branch || !commit) {
    try {
      const git = (a) => require('child_process').execFileSync('git', a, { cwd: require('path').resolve(__dirname, '..'), encoding: 'utf8' }).trim();
      branch = branch || git(['rev-parse', '--abbrev-ref', 'HEAD']);
      commit = commit || git(['rev-parse', 'HEAD']);
    } catch { /* not a git checkout */ }
  }
  ver = { branch: branch || 'unknown', commit: commit ? commit.slice(0, 7) : null };
  return ver;
}

// A fetcher for one competition: its week-cache floor moves past each of its games once finished.
async function fetcherFor(comp, mode) {
  return new Fetcher({ mode, weekFloor: W.floor(await W.kickoffs(comp, WRITE_DIR)) });
}
// remember the built round's kickoffs, so the week cache lapses once those games are played
const recordKickoffs = (comp, fetcher) => W.recordKickoffs(comp, fetcher.kickoffs, WRITE_DIR);

let queue = Promise.resolve();
function exclusive(task) {
  const run = queue.then(() => task());
  queue = run.catch(() => {});
  return run;
}

function sendJson(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

function intParam(value, lo, hi) {
  if (value == null || value === '') return null;
  if (!/^\d+$/.test(value)) return NaN;
  const n = Number(value);
  return n >= lo && n <= hi ? n : NaN;
}

function dataMode(q, fallback) {
  if (['1', 'true', 'on'].includes(q.get('refresh'))) return 'fresh';
  const d = q.get('data');
  if (d == null || d === '') return fallback;
  return MODES.includes(d) ? d : null;
}

// Next match per competition, from each one's own fixture list (the same lists the round dropdown
// uses). Friendlies only list played games, so they have no "next". Kept for UPCOMING_TTL.
const UPCOMING_TTL = 20 * 60 * 1000;
let upcomingMemo = null;
async function upcoming() {
  if (upcomingMemo && Date.now() - upcomingMemo.at < UPCOMING_TTL) return upcomingMemo.body;
  const T = require('./time');
  const comps = [
    ...Object.entries(model.LEAGUES).map(([key, L]) => ({ key, name: L.name, roundWord: L.roundWord, list: (f) => model.listRounds(key, f) })),
    ...Object.values(COMPS).filter((C) => C.info.key !== intl.KEY)
      .map((C) => ({ key: C.info.key, name: C.info.name, roundWord: C.info.roundWord, list: (f) => C.listRounds(f) })),
  ];
  const items = [];
  const none = [];
  await Promise.all(comps.map(async (c) => {
    try {
      const r = await c.list(await fetcherFor(c.key, 'auto'));
      if (!r.next) { none.push({ key: c.key, name: c.name, reason: 'no upcoming fixture in the source' }); return; }
      // the next match week; a rescheduled game played before it is a separate note (catch-up)
      const cu = r.catchup && r.catchup.date < r.next.date ? r.catchup : null;
      items.push({
        key: c.key, name: c.name, roundWord: c.roundWord, round: r.next.round, date: r.next.date,
        day: T.weekday(r.next.date), label: T.monDay(r.next.date),
        catchup: cu && { round: cu.round, date: cu.date, day: T.weekday(cu.date), label: T.monDay(cu.date) },
      });
    } catch (e) {
      none.push({ key: c.key, name: c.name, reason: e.message });
    }
  }));
  items.sort((p, q) => (p.date < q.date ? -1 : p.date > q.date ? 1 : p.name < q.name ? -1 : 1));
  const body = { today: T.localDate(Date.now(), 'America/Los_Angeles'), items, none };
  upcomingMemo = { at: Date.now(), body };
  return body;
}

async function handleApi(res, url) {
  const q = url.searchParams;
  if (url.pathname === '/api/version') return sendJson(res, 200, version());
  if (url.pathname === '/api/upcoming') return sendJson(res, 200, await upcoming());
  if (url.pathname === '/api/leagues') {
    return sendJson(res, 200, [
      ...Object.entries(model.LEAGUES).map(([key, L]) => ({ key, name: L.name, roundWord: L.roundWord })),
      ...Object.values(COMPS).map(({ info }) => ({ key: info.key, name: info.name, roundWord: info.roundWord })),
    ]);
  }

  const league = q.get('league');
  if (COMPS[league]) return handleComp(res, url, COMPS[league]);
  const L = model.LEAGUES[league];
  if (!L) return sendJson(res, 400, { error: `unknown league '${league}'` });
  const maxRound = (L.teams - 1) * 2;
  const mode = dataMode(q, 'auto');
  if (!mode) return sendJson(res, 400, { error: `data must be one of ${MODES.join(', ')}` });

  if (url.pathname === '/api/rounds') {
    try {
      return sendJson(res, 200, await exclusive(async () => model.listRounds(league, await fetcherFor(league, mode))));
    } catch (e) {
      if (!(e instanceof model.ChartError)) console.error(e);
      return sendJson(res, 502, { error: e.message });
    }
  }

  if (url.pathname === '/api/chart') {
    const round = intParam(q.get('round'), 1, maxRound);
    const historyRound = intParam(q.get('historyRound'), 1, maxRound);
    if (round == null || Number.isNaN(round)) return sendJson(res, 400, { error: `round must be 1–${maxRound}` });
    if (Number.isNaN(historyRound)) return sendJson(res, 400, { error: `historyRound must be 1–${maxRound}` });

    const t0 = Date.now();
    const fetcher = await fetcherFor(league, mode);
    const log = new model.RunLog();
    const meta = () => ({ elapsedMs: Date.now() - t0, network: fetcher.network, data: mode, refresh: mode === 'fresh' });
    try {
      const chart = await exclusive(() => model.build(league, round, historyRound, fetcher, log));
      await recordKickoffs(league, fetcher);
      const m = meta();
      console.log(`${new Date().toLocaleTimeString()}  ${league} round ${round}${historyRound ? ` (history ${historyRound})` : ''}`
        + ` [${mode}] -> ${(m.elapsedMs / 1000).toFixed(1)}s, ${m.network} network requests`);
      return sendJson(res, 200, { chart, log: log.toJSON(fetcher, chart.header), meta: m });
    } catch (e) {
      const known = e instanceof model.ChartError;
      if (!known) console.error(e);
      return sendJson(res, known ? 422 : 500, {
        error: known ? e.message : `internal error: ${e.message}`,
        log: log.toJSON(fetcher, `Run log — ${L.name} round ${round}`),
        meta: meta(),
      });
    }
  }

  return sendJson(res, 404, { error: 'not found' });
}

// Nations League, friendlies: same endpoints, their own rounds list and builder.
async function handleComp(res, url, C) {
  const q = url.searchParams;
  const mode = dataMode(q, 'auto');
  if (!mode) return sendJson(res, 400, { error: `data must be one of ${MODES.join(', ')}` });
  if (url.pathname === '/api/rounds') {
    try {
      return sendJson(res, 200, await exclusive(async () => C.listRounds(await fetcherFor(C.info.key, mode))));
    } catch (e) {
      if (!C.known(e)) console.error(e);
      return sendJson(res, 502, { error: e.message });
    }
  }
  if (url.pathname === '/api/chart') {
    const n = intParam(q.get('round'), 1, C.maxRound);
    const historyRound = intParam(q.get('historyRound'), 1, C.maxRound);
    if (n == null || Number.isNaN(n)) return sendJson(res, 400, { error: `round must be 1–${C.maxRound}` });
    if (Number.isNaN(historyRound)) return sendJson(res, 400, { error: `historyRound must be 1–${C.maxRound}` });
    const t0 = Date.now();
    const fetcher = await fetcherFor(C.info.key, mode);
    const log = new model.RunLog();
    const meta = () => ({ elapsedMs: Date.now() - t0, network: fetcher.network, data: mode, refresh: mode === 'fresh' });
    try {
      const chart = await exclusive(() => C.build(n, historyRound, fetcher, log));
      await recordKickoffs(C.info.key, fetcher);
      return sendJson(res, 200, { chart, log: log.toJSON(fetcher, chart.header), meta: meta() });
    } catch (e) {
      if (!C.known(e)) console.error(e);
      return sendJson(res, C.known(e) ? 422 : 500, {
        error: C.known(e) ? e.message : `internal error: ${e.message}`,
        log: log.toJSON(fetcher, `Run log — ${C.info.name} ${C.info.roundWord} ${n}`),
        meta: meta(),
      });
    }
  }
  return sendJson(res, 404, { error: 'not found' });
}

// Node (req, res) handler, used as-is by the Vercel functions.
function handler(req, res) {
  if (req.method !== 'GET') {
    res.writeHead(405);
    return res.end();
  }
  const url = new URL(req.url, 'http://localhost');
  return handleApi(res, url).catch((e) => {
    console.error(e);
    if (!res.headersSent) sendJson(res, 500, { error: e.message });
  });
}

module.exports = { handler, handleApi, sendJson };
