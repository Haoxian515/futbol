'use strict';
// Local web server: static UI from public/ plus a small JSON API.
//
//   GET /api/leagues
//   GET /api/rounds?league=pl
//   GET /api/chart?league=pl&round=4[&refresh=1][&historyRound=2]
//
// Binds to 127.0.0.1 only. Builds run one at a time so shared files (cache, stadiums.json)
// are never written concurrently.

const http = require('http');
const fs = require('fs');
const path = require('path');
const { Fetcher } = require('./lib/fetch');
const model = require('./lib/model');

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '127.0.0.1';
const PUBLIC = path.join(__dirname, 'public');
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

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

async function handleApi(res, url) {
  const q = url.searchParams;
  if (url.pathname === '/api/leagues') {
    return sendJson(res, 200, Object.entries(model.LEAGUES).map(([key, L]) => ({ key, name: L.name, roundWord: L.roundWord })));
  }

  const league = q.get('league');
  const L = model.LEAGUES[league];
  if (!L) return sendJson(res, 400, { error: `unknown league '${league}'` });
  const maxRound = (L.teams - 1) * 2;

  if (url.pathname === '/api/rounds') {
    try {
      return sendJson(res, 200, await exclusive(() => model.listRounds(league, new Fetcher())));
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
    const refresh = ['1', 'true', 'on'].includes(q.get('refresh'));

    const t0 = Date.now();
    const fetcher = new Fetcher({ refresh });
    const log = new model.RunLog();
    const meta = () => ({ elapsedMs: Date.now() - t0, network: fetcher.network, refresh });
    try {
      const chart = await exclusive(() => model.build(league, round, historyRound, fetcher, log));
      const m = meta();
      console.log(`${new Date().toLocaleTimeString()}  ${league} round ${round}${historyRound ? ` (history ${historyRound})` : ''}`
        + `${refresh ? ' [refresh]' : ''} -> ${(m.elapsedMs / 1000).toFixed(1)}s, ${m.network} network requests`);
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

function serveStatic(res, url) {
  let rel;
  try {
    rel = decodeURIComponent(url.pathname);
  } catch {
    res.writeHead(400);
    return res.end();
  }
  if (rel === '/') rel = '/index.html';
  const file = path.resolve(PUBLIC, `.${rel}`);
  if (!file.startsWith(PUBLIC + path.sep)) {
    res.writeHead(403);
    return res.end();
  }
  fs.readFile(file, (err, buf) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('not found');
    }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream' });
    res.end(buf);
  });
}

const server = http.createServer((req, res) => {
  if (req.method !== 'GET') {
    res.writeHead(405);
    return res.end();
  }
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname.startsWith('/api/')) {
    handleApi(res, url).catch((e) => {
      console.error(e);
      if (!res.headersSent) sendJson(res, 500, { error: e.message });
    });
    return;
  }
  serveStatic(res, url);
});

server.listen(PORT, HOST, () => {
  console.log(`Football charts running at http://localhost:${PORT}  (Ctrl+C to stop)`);
});
