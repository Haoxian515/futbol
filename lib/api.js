'use strict';
// JSON API shared by the local server (server.js) and the Vercel functions (api/*.js).
//
//   GET /api/leagues
//   GET /api/rounds?league=pl[&data=auto|cache|fresh]
//   GET /api/chart?league=pl&round=4[&data=cache|fresh][&historyRound=2]
//
// data=cache (chart default) builds from already-fetched data and only hits the network for
// sources never fetched before; data=fresh re-pulls every source; data=auto (rounds default)
// re-pulls only entries past their TTL, so the round list tracks new results. refresh=1 = fresh.
// Builds run one at a time per process so shared cache files are never written concurrently.

const { Fetcher, MODES } = require('./fetch');
const model = require('./model');

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

async function handleApi(res, url) {
  const q = url.searchParams;
  if (url.pathname === '/api/leagues') {
    return sendJson(res, 200, Object.entries(model.LEAGUES).map(([key, L]) => ({ key, name: L.name, roundWord: L.roundWord })));
  }

  const league = q.get('league');
  const L = model.LEAGUES[league];
  if (!L) return sendJson(res, 400, { error: `unknown league '${league}'` });
  const maxRound = (L.teams - 1) * 2;
  const mode = dataMode(q, url.pathname === '/api/rounds' ? 'auto' : 'cache');
  if (!mode) return sendJson(res, 400, { error: `data must be one of ${MODES.join(', ')}` });

  if (url.pathname === '/api/rounds') {
    try {
      return sendJson(res, 200, await exclusive(() => model.listRounds(league, new Fetcher({ mode }))));
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
    const fetcher = new Fetcher({ mode });
    const log = new model.RunLog();
    const meta = () => ({ elapsedMs: Date.now() - t0, network: fetcher.network, data: mode, refresh: mode === 'fresh' });
    try {
      const chart = await exclusive(() => model.build(league, round, historyRound, fetcher, log));
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
