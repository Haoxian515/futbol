'use strict';
// BTTS correlation study: how often both teams actually scored, against what was known before
// kickoff. For every league game from the second model season on (football-data.co.uk results):
//   L5   — BTTS games among each team's last 5 league games (home + away, 0–10)
//   H2H  — share of BTTS in the last 5 league meetings (needs 3+ meetings; results back to H2H_FROM)
//   1+   — the MODEL's chance that both teams score 1+, treating the two as independent (P(h 1+) × P(a 1+))
//   xG   — the MODEL's expected goals: the lower of the two sides, and the total
//   MODEL — the MODEL's own BTTS probability (Dixon–Coles), for reference
// Features use games on earlier dates only (the model via predict.walk, as in the backtest).
// Each feature gets a Pearson correlation with the 0/1 BTTS outcome and BTTS rates per bucket.

const P = require('./predict');
const T = require('./time');

const H2H_FROM = 2016; // football-data seasons loaded for form / H2H history
const EVAL_FROM = 2022; // first season scored (needs a model prior season; penalties from 2021)
const TTL_CUR = 6;
const TTL_PAST = 24 * 30;
const FORM_DAYS = 365;
const MIN_BUCKET = 30; // fewer games than this: rate shown but not highlighted

const bt = (g) => g.hg > 0 && g.ag > 0;

const FEATURES = [
  {
    key: 'l5', label: 'Last 5 BTTS (home + away)', fmt: (v) => `${v}/10`,
    buckets: [[(v) => v <= 3, '0–3'], [(v) => v === 4, '4'], [(v) => v === 5, '5'], [(v) => v === 6, '6'], [(v) => v === 7, '7'], [(v) => v >= 8, '8–10']],
  },
  {
    key: 'h2h', label: 'H2H last 5 BTTS share (3+ meetings)', fmt: (v, x) => `${x.h2hK}/${x.h2hN}`,
    buckets: [[(v) => v <= 0.2, '0–20%'], [(v) => v <= 0.4, '21–40%'], [(v) => v <= 0.6, '41–60%'], [(v) => v <= 0.8, '61–80%'], [() => true, '81–100%']],
  },
  {
    key: 'one', label: 'Both score 1+ (model 1+ × 1+)', fmt: (v) => `${Math.round(v * 100)}%`,
    buckets: [[(v) => v < 0.4, '<40%'], [(v) => v < 0.5, '40–49%'], [(v) => v < 0.55, '50–54%'], [(v) => v < 0.6, '55–59%'], [() => true, '60%+']],
  },
  {
    key: 'xgmin', label: 'Lower xG of the two (model)', fmt: (v) => v.toFixed(2),
    buckets: [[(v) => v < 0.75, '<0.75'], [(v) => v < 1, '0.75–0.99'], [(v) => v < 1.25, '1.00–1.24'], [(v) => v < 1.5, '1.25–1.49'], [() => true, '1.50+']],
  },
  {
    key: 'xgsum', label: 'Total xG (model)', fmt: (v) => v.toFixed(2),
    buckets: [[(v) => v < 2.25, '<2.25'], [(v) => v < 2.75, '2.25–2.74'], [(v) => v < 3.25, '2.75–3.24'], [() => true, '3.25+']],
  },
  {
    key: 'model', label: 'Model BTTS probability', fmt: (v) => `${Math.round(v * 100)}%`,
    buckets: [[(v) => v < 0.45, '<45%'], [(v) => v < 0.5, '45–49%'], [(v) => v < 0.55, '50–54%'], [(v) => v < 0.6, '55–59%'], [() => true, '60%+']],
  },
];

function pearson(xs, ys) {
  const n = xs.length;
  if (n < 3) return null;
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  let sxy = 0; let sx = 0; let sy = 0;
  for (let i = 0; i < n; i++) { sxy += (xs[i] - mx) * (ys[i] - my); sx += (xs[i] - mx) ** 2; sy += (ys[i] - my) ** 2; }
  return sx && sy ? sxy / Math.sqrt(sx * sy) : null;
}

// form / H2H features for a game on `date` between home and away, from games before that date
function formFeatures(byTeam, home, away, date) {
  const prior = (t) => (byTeam.get(t) || []).filter((x) => x.date < date);
  // form only from the last FORM_DAYS (a promoted club's last top-flight games may be years old)
  const recent = (t) => prior(t).filter((x) => T.diffDays(date, x.date) <= FORM_DAYS).slice(-5);
  const lh = recent(home);
  const la = recent(away);
  const h2h = prior(home).filter((x) => x.home === away || x.away === away).slice(-5);
  const out = { l5h: lh.length === 5 ? lh.filter(bt).length : null, l5a: la.length === 5 ? la.filter(bt).length : null, h2hN: h2h.length, h2hK: h2h.filter(bt).length };
  out.l5 = out.l5h != null && out.l5a != null ? out.l5h + out.l5a : null;
  out.h2h = h2h.length >= 3 ? out.h2hK / h2h.length : null;
  return out;
}

const modelFeatures = (p) => (p ? { one: p.h1 * p.a1, xgmin: Math.min(p.lh, p.la), xgsum: p.lh + p.la, model: p.btts, xgH: p.lh, xgA: p.la } : {});

const bucketOf = (f, v) => (v == null ? null : f.buckets.findIndex(([test]) => test(v)));

// fixtures: this round [{ label, home, away, date, pred }] (canonical names, pred from the MODEL column)
async function analyse(fetcher, league, canon, currentY, fixtures, log) {
  const seasons = new Map();
  for (let y = H2H_FROM; y <= currentY; y++) {
    const games = await P.loadSeason(fetcher, league, y, canon, y === currentY ? TTL_CUR : TTL_PAST);
    if (games && y >= EVAL_FROM - 1 && P.PARAMS.np) await P.attachPenalties(fetcher, league, games, canon, { ttl: y === currentY ? TTL_CUR : TTL_PAST });
    if (games) seasons.set(y, games);
  }
  const all = [...seasons.values()].flat().sort((p, q) => (p.date < q.date ? -1 : p.date > q.date ? 1 : 0));
  if (!all.length) return null;
  const byTeam = new Map();
  for (const g of all) for (const t of [g.home, g.away]) { if (!byTeam.has(t)) byTeam.set(t, []); byTeam.get(t).push(g); }

  const rows = [];
  for (let y = EVAL_FROM; y <= currentY; y++) {
    if (!seasons.has(y) || !seasons.has(y - 1)) continue;
    P.walk(seasons.get(y - 1), seasons.get(y), P.PARAMS, (g, p) => {
      rows.push({ o: bt(g) ? 1 : 0, ...formFeatures(byTeam, g.home, g.away, g.date), ...modelFeatures(p) });
    });
  }
  const base = rows.length ? rows.reduce((a, x) => a + x.o, 0) / rows.length : null;
  const features = FEATURES.map((f) => {
    const rr = rows.filter((x) => x[f.key] != null);
    const buckets = f.buckets.map(([, label]) => ({ label, n: 0, hits: 0 }));
    for (const x of rr) {
      const b = buckets[bucketOf(f, x[f.key])];
      b.n += 1; b.hits += x.o;
    }
    const r = pearson(rr.map((x) => x[f.key]), rr.map((x) => x.o));
    return {
      key: f.key, label: f.label, n: rr.length, r: r == null ? null : +r.toFixed(3),
      buckets: buckets.map((b) => ({ label: b.label, n: b.n, rate: b.n ? +(b.hits / b.n).toFixed(3) : null })),
    };
  });

  const round = fixtures.map((fx) => {
    const v = { ...formFeatures(byTeam, fx.home, fx.away, fx.date || '9999'), ...modelFeatures(fx.pred) };
    const cells = {};
    for (const f of FEATURES) {
      const b = bucketOf(f, v[f.key]);
      const fb = b == null ? null : features.find((x) => x.key === f.key).buckets[b];
      cells[f.key] = v[f.key] == null ? null : { text: f.fmt(v[f.key], v), bucket: fb.label, rate: fb.rate, n: fb.n };
    }
    if (v.l5 == null) log.cell('BTTS STUDY', 'fewer than 5 league games in the last 12 months (promoted club?)', fx.label);
    return { label: fx.label, l5h: v.l5h, l5a: v.l5a, xgH: v.xgH ?? null, xgA: v.xgA ?? null, cells, result: fx.result || null };
  });

  const yrs = [...seasons.keys()].filter((y) => y >= EVAL_FROM);
  return {
    games: rows.length, base: base == null ? null : +base.toFixed(3), minBucket: MIN_BUCKET,
    seasons: yrs.length ? `${yrs[0]}-${String(yrs[0] + 1).slice(2)} to ${yrs[yrs.length - 1]}-${String(yrs[yrs.length - 1] + 1).slice(2)}` : '',
    h2hFrom: `${H2H_FROM}-${String(H2H_FROM + 1).slice(2)}`, features, round,
    source: 'football-data.co.uk results; MODEL figures from the same Poisson model as the MODEL column, built from earlier games only',
  };
}

module.exports = { analyse, FEATURES, pearson };
