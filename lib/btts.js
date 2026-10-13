'use strict';
// BTTS correlation study: how often both teams actually scored, against what was known before
// kickoff. For every league game from the second model season on (football-data.co.uk results):
//   L10  — BTTS games among each team's last 10 league games (home + away, 0–20)
//   H2H  — share of BTTS over every league meeting since 1993-94 (needs 3+ meetings): seasons from
//          H2H_FROM load in full; older ones come from data/h2h/<league>.json (build_h2h_history.js)
//   1+   — the MODEL's chance that both teams score 1+, treating the two as independent (P(h 1+) × P(a 1+))
//   xG   — the MODEL's expected goals: the lower of the two sides, and the total
//   MODEL — the MODEL's own BTTS probability (Dixon–Coles), for reference
//   H2H GF/GA — goals per game for / against the home side over those meetings (all goals:
//         penalty records only go back to 2021-22), and the lower of the two sides' rates
//   NP GF — each team's non-penalty goals per game over its last 10; the lower of the two, the gap
//         between them, and the gap in non-penalty goal difference per game (strength mismatch)
//   1+ IN L10 — games with a goal in the last 10, for the side with fewer
// GRIDS cross two features (home × away) to show where BTTS clusters.
// Features use games on earlier dates only (the model via predict.walk, as in the backtest).
// Each feature gets a Pearson correlation with the 0/1 BTTS outcome and BTTS rates per bucket.

const fs = require('fs');
const path = require('path');
const F = require('./fetch');
const P = require('./predict');
const T = require('./time');

const H2H_FROM = 2016; // football-data seasons loaded in full (form + H2H)
const DEEP_FROM = 1993; // older seasons, H2H only, from data/h2h/<league>.json
const FORM_N = 10; // form window: last N league games
const EVAL_FROM = 2022; // first season scored (needs a model prior season; penalties from 2021)
const TTL_CUR = 6;
const TTL_PAST = 24 * 30;
const FORM_DAYS = 365;
const MIN_BUCKET = 30; // fewer games than this: rate shown but not highlighted

const bt = (g) => g.hg > 0 && g.ag > 0;
const f2 = (v) => v.toFixed(2);
const RATE4 = [[(v) => v < 0.75, '<0.75'], [(v) => v < 1.25, '0.75–1.24'], [(v) => v < 1.75, '1.25–1.74'], [() => true, '1.75+']];

const FEATURES = [
  {
    key: 'l5', label: 'Last 10 BTTS (home + away)', fmt: (v) => `${v}/20`,
    buckets: [[(v) => v <= 7, '0–7'], [(v) => v <= 9, '8–9'], [(v) => v <= 11, '10–11'], [(v) => v <= 13, '12–13'], [(v) => v <= 15, '14–15'], [() => true, '16–20']],
  },
  {
    key: 'h2h', label: 'H2H BTTS share, all meetings since 1993-94 (3+)', fmt: (v, x) => `${x.h2hK}/${x.h2hN}`,
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
    key: 'h2hgf', label: 'H2H home GF/G (all meetings, 3+)', fmt: f2, buckets: RATE4,
  },
  {
    key: 'h2hga', label: 'H2H home GA/G (= away GF/G)', fmt: f2, buckets: RATE4,
  },
  {
    key: 'h2hmin', label: 'H2H lower GF/G of the two', fmt: f2,
    buckets: [[(v) => v < 0.5, '<0.50'], [(v) => v < 0.8, '0.50–0.79'], [(v) => v < 1.1, '0.80–1.09'], [(v) => v < 1.4, '1.10–1.39'], [() => true, '1.40+']],
  },
  {
    key: 'np5min', label: 'Last 10 np GF/G, lower of the two', fmt: f2,
    buckets: [[(v) => v < 0.8, '<0.8'], [(v) => v < 1.2, '0.8–1.19'], [(v) => v < 1.6, '1.2–1.59'], [(v) => v < 2, '1.6–1.99'], [() => true, '2.0+']],
  },
  {
    key: 'np5delta', label: 'Last 10 np GF/G gap (|home − away|)', fmt: f2,
    buckets: [[(v) => v < 0.4, '<0.4'], [(v) => v < 0.8, '0.4–0.79'], [(v) => v < 1.2, '0.8–1.19'], [(v) => v < 1.6, '1.2–1.59'], [() => true, '1.6+']],
  },
  {
    key: 'gddelta', label: 'Last 10 np GD/G gap (strength mismatch)', fmt: f2,
    buckets: [[(v) => v < 0.5, '<0.5'], [(v) => v < 1, '0.5–0.99'], [(v) => v < 1.5, '1.0–1.49'], [(v) => v < 2, '1.5–1.99'], [() => true, '2.0+']],
  },
  {
    key: 's1min', label: 'Scored 1+ in last 10, side with fewer', fmt: (v) => `${v}/10`,
    buckets: [[(v) => v <= 5, '0–5'], [(v) => v === 6, '6'], [(v) => v === 7, '7'], [(v) => v === 8, '8'], [(v) => v >= 9, '9–10']],
  },
  {
    key: 'model', label: 'Model BTTS probability', fmt: (v) => `${Math.round(v * 100)}%`,
    buckets: [[(v) => v < 0.45, '<45%'], [(v) => v < 0.5, '45–49%'], [(v) => v < 0.55, '50–54%'], [(v) => v < 0.6, '55–59%'], [() => true, '60%+']],
  },
];

// home × away grids: [key, label, home value, away value, buckets]
const GRIDS = [
  {
    key: 's1', label: 'Games scored 1+ in last 10 — home (rows) × away (columns)', h: 's1h', a: 's1a',
    buckets: [[(v) => v <= 6, '0–6'], [(v) => v === 7, '7'], [(v) => v === 8, '8'], [(v) => v >= 9, '9–10']],
  },
  {
    key: 'np5', label: 'Non-penalty GF/G in last 10 — home (rows) × away (columns)', h: 'np5h', a: 'np5a',
    buckets: [[(v) => v < 0.8, '<0.8'], [(v) => v < 1.4, '0.8–1.39'], [(v) => v < 2, '1.4–1.99'], [() => true, '2.0+']],
  },
  {
    key: 'h2hg', label: 'H2H goals per game (all meetings) — home GF (rows) × home GA (columns)', h: 'h2hgf', a: 'h2hga', buckets: RATE4,
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
  const recent = (t) => prior(t).filter((x) => T.diffDays(date, x.date) <= FORM_DAYS).slice(-FORM_N);
  const lh = recent(home);
  const la = recent(away);
  const h2h = prior(home).filter((x) => x.home === away || x.away === away);
  const full = (g) => g.length === FORM_N;
  const out = { l5h: full(lh) ? lh.filter(bt).length : null, l5a: full(la) ? la.filter(bt).length : null, h2hN: h2h.length, h2hK: h2h.filter(bt).length };
  out.l5 = out.l5h != null && out.l5a != null ? out.l5h + out.l5a : null;
  out.h2h = h2h.length >= 3 ? out.h2hK / h2h.length : null;
  if (h2h.length >= 3) {
    let gf = 0; let ga = 0;
    for (const x of h2h) { gf += x.home === home ? x.hg : x.ag; ga += x.home === home ? x.ag : x.hg; }
    out.h2hgf = gf / h2h.length; out.h2hga = ga / h2h.length; out.h2hmin = Math.min(out.h2hgf, out.h2hga);
  }
  // non-penalty goals (a match without a penalty record counts in full, as in the MODEL)
  const np = (games, t) => {
    let gf = 0; let ga = 0; let s1 = 0;
    for (const x of games) {
      const home = x.home === t;
      const f = home ? x.hg - (x.hp || 0) : x.ag - (x.ap || 0);
      const a = home ? x.ag - (x.ap || 0) : x.hg - (x.hp || 0);
      gf += f; ga += a; if ((home ? x.hg : x.ag) > 0) s1 += 1;
    }
    return { gf: gf / games.length, gd: (gf - ga) / games.length, s1 };
  };
  if (full(lh) && full(la)) {
    const h = np(lh, home);
    const a = np(la, away);
    Object.assign(out, {
      np5h: h.gf, np5a: a.gf, np5min: Math.min(h.gf, a.gf), np5delta: Math.abs(h.gf - a.gf), gddelta: Math.abs(h.gd - a.gd),
      s1h: h.s1, s1a: a.s1, s1min: Math.min(h.s1, a.s1),
    });
  }
  return out;
}

const modelFeatures = (p) => (p ? { one: p.h1 * p.a1, xgmin: Math.min(p.lh, p.la), xgsum: p.lh + p.la, model: p.btts, xgH: p.lh, xgA: p.la } : {});

const deepFile = (league) => path.join(F.ROOT, 'data', 'h2h', `${league}.json`);
function loadDeep(league, canon) {
  try {
    const d = JSON.parse(fs.readFileSync(deepFile(league), 'utf8'));
    return Object.values(d.seasons).flat().map(([date, home, away, hg, ag]) => ({ date, home: canon(home), away: canon(away), hg, ag }));
  } catch {
    return [];
  }
}

const bucketOf = (f, v) => (v == null ? null : f.buckets.findIndex(([test]) => test(v)));

// fixtures: this round [{ label, home, away, date, pred }] (canonical names, pred from the MODEL column)
async function analyse(fetcher, league, canon, currentY, fixtures, log, { keepRows = false } = {}) {
  const seasons = new Map();
  for (let y = H2H_FROM; y <= currentY; y++) {
    const games = await P.loadSeason(fetcher, league, y, canon, y === currentY ? TTL_CUR : TTL_PAST);
    if (games && y >= EVAL_FROM - 1 && P.PARAMS.np) await P.attachPenalties(fetcher, league, games, canon, { ttl: y === currentY ? TTL_CUR : TTL_PAST });
    if (games) seasons.set(y, games);
  }
  const deep = loadDeep(league, canon);
  if (!deep.length) log.warn(`BTTS study: data/h2h/${league}.json missing — H2H from ${H2H_FROM}-${String(H2H_FROM + 1).slice(2)} only (run scripts/build_h2h_history.js)`);
  const all = [...deep, ...[...seasons.values()].flat()].sort((p, q) => (p.date < q.date ? -1 : p.date > q.date ? 1 : 0));
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

  const grids = GRIDS.map((g) => {
    const cells = g.buckets.map(() => g.buckets.map(() => ({ n: 0, hits: 0 })));
    for (const x of rows) {
      if (x[g.h] == null || x[g.a] == null) continue;
      const c = cells[g.buckets.findIndex(([t]) => t(x[g.h]))][g.buckets.findIndex(([t]) => t(x[g.a]))];
      c.n += 1; c.hits += x.o;
    }
    return {
      key: g.key, label: g.label, labels: g.buckets.map(([, l]) => l),
      cells: cells.map((row) => row.map((c) => ({ n: c.n, rate: c.n ? +(c.hits / c.n).toFixed(3) : null }))),
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
    if (v.l5 == null) log.cell('BTTS STUDY', `fewer than ${FORM_N} league games in the last 12 months (promoted club?)`, fx.label);
    return {
      label: fx.label, l5h: v.l5h, l5a: v.l5a, xgH: v.xgH ?? null, xgA: v.xgA ?? null, cells, result: fx.result || null,
      np5h: v.np5h ?? null, np5a: v.np5a ?? null, s1h: v.s1h ?? null, s1a: v.s1a ?? null, h2hgf: v.h2hgf ?? null, h2hga: v.h2hga ?? null,
    };
  });

  const yrs = [...seasons.keys()].filter((y) => y >= EVAL_FROM);
  return {
    games: rows.length, base: base == null ? null : +base.toFixed(3), minBucket: MIN_BUCKET,
    seasons: yrs.length ? `${yrs[0]}-${String(yrs[0] + 1).slice(2)} to ${yrs[yrs.length - 1]}-${String(yrs[yrs.length - 1] + 1).slice(2)}` : '',
    h2hFrom: `${deep.length ? DEEP_FROM : H2H_FROM}-${String((deep.length ? DEEP_FROM : H2H_FROM) + 1).slice(2)}`, formN: FORM_N, features, grids, round,
    ...(keepRows ? { rows } : {}),
    source: 'football-data.co.uk results; MODEL figures from the same Poisson model as the MODEL column, built from earlier games only',
  };
}

module.exports = { analyse, FEATURES, GRIDS, pearson, deepFile, DEEP_FROM, H2H_FROM, FORM_N };
