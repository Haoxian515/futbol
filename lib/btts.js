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
const H2H_MIN = 3; // meetings needed for the H2H measures (leagues)
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
    key: 'h2h', label: 'H2H BTTS share, all meetings ({h2h})', fmt: (v, x) => `${x.h2hK}/${x.h2hN}`,
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
    key: 'h2hgf', label: 'H2H home GF/G (all meetings, {h2h})', fmt: f2, buckets: RATE4,
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

// BTTS drivers (second chart): the model's 1+ chances by side, last-10 goal difference, and how
// many of the last 10 games each side scored 0, 1, 2, 3+ in
const pts = (v) => `${v >= 0 ? '+' : ''}${Math.round(v * 100)}`;
const LMH = [[(v) => v < 0.6, 'Low <60%'], [(v) => v < 0.75, 'Medium 60–74%'], [() => true, 'High 75%+']];
const GD4 = [[(v) => v <= -5, '≤−5'], [(v) => v <= -1, '−4 to −1'], [(v) => v <= 4, '0 to +4'], [() => true, '+5+']];
const DRIVER_FEATURES = [
  { key: 'h1', label: 'Home scores 1+ (model)', fmt: (v) => `${Math.round(v * 100)}%`, buckets: LMH },
  { key: 'a1', label: 'Away scores 1+ (model)', fmt: (v) => `${Math.round(v * 100)}%`, buckets: LMH },
  {
    key: 'min1', label: 'Lower 1+ of the two (model)', fmt: (v) => `${Math.round(v * 100)}%`,
    buckets: [[(v) => v < 0.5, '<50%'], [(v) => v < 0.6, '50–59%'], [(v) => v < 0.7, '60–69%'], [() => true, '70%+']],
  },
  {
    key: 'd1', label: '1+ delta, home − away (pts)', fmt: pts,
    buckets: [[(v) => v <= -0.195, '≤−20'], [(v) => v < -0.055, '−19 to −6'], [(v) => v < 0.055, '−5 to +5'], [(v) => v < 0.195, '+6 to +19'], [() => true, '+20+']],
  },
  { key: 'gdh', label: 'Home GF−GA, last 10', fmt: (v) => `${v > 0 ? '+' : ''}${v}`, buckets: GD4 },
  { key: 'gda', label: 'Away GF−GA, last 10', fmt: (v) => `${v > 0 ? '+' : ''}${v}`, buckets: GD4 },
  {
    key: 'gdgap', label: 'GF−GA gap between the two (last 10)', fmt: (v) => String(v),
    buckets: [[(v) => v <= 3, '0–3'], [(v) => v <= 7, '4–7'], [(v) => v <= 11, '8–11'], [() => true, '12+']],
  },
  {
    key: 'gamin', label: 'Goals conceded, tighter side (last 10)', fmt: (v) => String(v),
    buckets: [[(v) => v <= 7, '0–7'], [(v) => v <= 10, '8–10'], [(v) => v <= 13, '11–13'], [() => true, '14+']],
  },
  {
    key: 'c0max', label: '0G games, side with more (of 10)', fmt: (v) => `${v}/10`,
    buckets: [[(v) => v <= 2, '0–2'], [(v) => v === 3, '3'], [(v) => v === 4, '4'], [() => true, '5+']],
  },
  {
    key: 'c0', label: '0G games, both sides (of 20)', fmt: (v) => `${v}/20`,
    buckets: [[(v) => v <= 3, '0–3'], [(v) => v <= 5, '4–5'], [(v) => v <= 7, '6–7'], [() => true, '8+']],
  },
  {
    key: 'c1', label: '1G games, both sides (of 20)', fmt: (v) => `${v}/20`,
    buckets: [[(v) => v <= 5, '0–5'], [(v) => v <= 7, '6–7'], [(v) => v <= 9, '8–9'], [() => true, '10+']],
  },
  {
    key: 'c2', label: '2G games, both sides (of 20)', fmt: (v) => `${v}/20`,
    buckets: [[(v) => v <= 2, '0–2'], [(v) => v <= 4, '3–4'], [(v) => v <= 6, '5–6'], [() => true, '7+']],
  },
  {
    key: 'c3', label: '3+G games, both sides (of 20)', fmt: (v) => `${v}/20`,
    buckets: [[(v) => v <= 1, '0–1'], [(v) => v <= 3, '2–3'], [(v) => v <= 5, '4–5'], [() => true, '6+']],
  },
];
const DRIVER_GRIDS = [
  { key: 'lmh', label: 'Model 1+ band — home (rows) × away (columns)', h: 'h1', a: 'a1', buckets: LMH },
  { key: 'gd', label: 'GF−GA over the last 10 — home (rows) × away (columns)', h: 'gdh', a: 'gda', buckets: GD4 },
  {
    key: 'c0', label: '0G games in the last 10 — home (rows) × away (columns)', h: 'c0h', a: 'c0a',
    buckets: [[(v) => v <= 1, '0–1'], [(v) => v === 2, '2'], [(v) => v === 3, '3'], [() => true, '4+']],
  },
];
// raw values the drivers chart shows for this round's fixtures
const DRIVER_VALUES = ['h1', 'a1', 'd1', 'gfh', 'gah', 'gfa', 'gaa', 'gdh', 'gda', 'gdgap', 'c0h', 'c1h', 'c2h', 'c3h', 'c0a', 'c1a', 'c2a', 'c3a'];

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
// byH2H: games to find meetings in (defaults to byTeam; the UCL uses its own games for H2H while
// form also counts domestic league games)
function formFeatures(byTeam, home, away, date, byH2H = byTeam, h2hMin = H2H_MIN) {
  const prior = (t) => (byTeam.get(t) || []).filter((x) => x.date < date);
  // form only from the last FORM_DAYS (a promoted club's last top-flight games may be years old)
  const recent = (t) => prior(t).filter((x) => T.diffDays(date, x.date) <= FORM_DAYS).slice(-FORM_N);
  const lh = recent(home);
  const la = recent(away);
  const h2h = (byH2H.get(home) || []).filter((x) => x.date < date && (x.home === away || x.away === away));
  const full = (g) => g.length === FORM_N;
  const out = { l5h: full(lh) ? lh.filter(bt).length : null, l5a: full(la) ? la.filter(bt).length : null, h2hN: h2h.length, h2hK: h2h.filter(bt).length };
  out.l5 = out.l5h != null && out.l5a != null ? out.l5h + out.l5a : null;
  out.h2h = h2h.length >= h2hMin ? out.h2hK / h2h.length : null;
  if (h2h.length >= h2hMin) {
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
  // all goals (as the LAST 10 column): totals for / against, and games by goals scored (0, 1, 2, 3+)
  const tally = (games, t) => {
    const o = { gf: 0, ga: 0, c: [0, 0, 0, 0] };
    for (const x of games) {
      const f = x.home === t ? x.hg : x.ag;
      o.gf += f; o.ga += x.home === t ? x.ag : x.hg; o.c[Math.min(f, 3)] += 1;
    }
    return o;
  };
  if (full(lh) && full(la)) {
    const h = np(lh, home);
    const a = np(la, away);
    Object.assign(out, {
      np5h: h.gf, np5a: a.gf, np5min: Math.min(h.gf, a.gf), np5delta: Math.abs(h.gf - a.gf), gddelta: Math.abs(h.gd - a.gd),
      s1h: h.s1, s1a: a.s1, s1min: Math.min(h.s1, a.s1),
    });
    const th = tally(lh, home);
    const ta = tally(la, away);
    Object.assign(out, {
      gfh: th.gf, gah: th.ga, gfa: ta.gf, gaa: ta.ga, gdh: th.gf - th.ga, gda: ta.gf - ta.ga,
      gdgap: Math.abs(th.gf - th.ga - (ta.gf - ta.ga)), gamin: Math.min(th.ga, ta.ga),
      c0h: th.c[0], c1h: th.c[1], c2h: th.c[2], c3h: th.c[3], c0a: ta.c[0], c1a: ta.c[1], c2a: ta.c[2], c3a: ta.c[3],
      c0max: Math.max(th.c[0], ta.c[0]), c0: th.c[0] + ta.c[0], c1: th.c[1] + ta.c[1], c2: th.c[2] + ta.c[2], c3: th.c[3] + ta.c[3],
    });
  }
  return out;
}

const modelFeatures = (p) => (p ? {
  one: p.h1 * p.a1, xgmin: Math.min(p.lh, p.la), xgsum: p.lh + p.la, model: p.btts, xgH: p.lh, xgA: p.la,
  h1: p.h1, a1: p.a1, d1: p.h1 - p.a1, min1: Math.min(p.h1, p.a1),
} : {});

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
// driversFixtures: a different (completed) round for the drivers chart, { label, home, away, date,
// result, pred? } — without pred, the MODEL figures come from the walk below (earlier games only)
async function analyse(fetcher, league, canon, currentY, fixtures, log, { keepRows = false, driversFixtures = null } = {}) {
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
  const preds = new Map(); // this season's walk predictions, home|away -> p
  for (let y = EVAL_FROM; y <= currentY; y++) {
    if (!seasons.has(y) || !seasons.has(y - 1)) continue;
    P.walk(seasons.get(y - 1), seasons.get(y), P.PARAMS, (g, p) => {
      rows.push({ o: bt(g) ? 1 : 0, ...formFeatures(byTeam, g.home, g.away, g.date), ...modelFeatures(p) });
      if (y === currentY) preds.set(`${g.home}|${g.away}`, p);
    });
  }
  const yrs = [...seasons.keys()].filter((y) => y >= EVAL_FROM);
  return {
    ...summarise(rows, byTeam, byTeam, fixtures, log, `fewer than ${FORM_N} league games in the last 12 months (promoted club?)`),
    spreadAll: spread(rows),
    drivers: drivers(rows, byTeam, byTeam, driversFixtures
      ? driversFixtures.map((f) => ({ ...f, pred: f.pred || preds.get(`${f.home}|${f.away}`) || null })).sort((p, q) => (p.date < q.date ? -1 : p.date > q.date ? 1 : 0))
      : fixtures),
    seasons: yrs.length ? `${yrs[0]}-${String(yrs[0] + 1).slice(2)} to ${yrs[yrs.length - 1]}-${String(yrs[yrs.length - 1] + 1).slice(2)}` : '',
    h2hFrom: `${deep.length ? DEEP_FROM : H2H_FROM}-${String((deep.length ? DEEP_FROM : H2H_FROM) + 1).slice(2)}`,
    ...(keepRows ? { rows } : {}),
    source: 'football-data.co.uk results; MODEL figures from the same Poisson model as the MODEL column, built from earlier games only',
  };
}

// rows: one per past game { o: 0/1 BTTS, ...features } -> correlations, buckets, grids, and where
// this round's fixtures fall
function summarise(rows, byTeam, byH2H, fixtures, log, missingNote, h2hMin = H2H_MIN, { features: FS = FEATURES, grids: GS = GRIDS } = {}) {
  const base = rows.length ? rows.reduce((a, x) => a + x.o, 0) / rows.length : null;
  const features = FS.map((f) => {
    const rr = rows.filter((x) => x[f.key] != null);
    const buckets = f.buckets.map(([, label]) => ({ label, n: 0, hits: 0 }));
    for (const x of rr) {
      const b = buckets[bucketOf(f, x[f.key])];
      b.n += 1; b.hits += x.o;
    }
    const r = pearson(rr.map((x) => x[f.key]), rr.map((x) => x.o));
    return {
      key: f.key, label: f.label.replace('{h2h}', `${h2hMin}+`), n: rr.length, r: r == null ? null : +r.toFixed(3),
      buckets: buckets.map((b) => ({ label: b.label, n: b.n, rate: b.n ? +(b.hits / b.n).toFixed(3) : null })),
    };
  });

  const grids = GS.map((g) => {
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
    const v = { ...formFeatures(byTeam, fx.home, fx.away, fx.date || '9999', byH2H, h2hMin), ...modelFeatures(fx.pred) };
    const cells = {};
    for (const f of FS) {
      const b = bucketOf(f, v[f.key]);
      const fb = b == null ? null : features.find((x) => x.key === f.key).buckets[b];
      cells[f.key] = v[f.key] == null ? null : { text: f.fmt(v[f.key], v), bucket: fb.label, rate: fb.rate, n: fb.n };
    }
    if (v.l5 == null) log.cell('BTTS STUDY', missingNote, fx.label);
    return {
      label: fx.label, l5h: v.l5h, l5a: v.l5a, xgH: v.xgH ?? null, xgA: v.xgA ?? null, cells, result: fx.result || null,
      np5h: v.np5h ?? null, np5a: v.np5a ?? null, s1h: v.s1h ?? null, s1a: v.s1a ?? null, h2hgf: v.h2hgf ?? null, h2hga: v.h2hga ?? null,
      v: Object.fromEntries(DRIVER_VALUES.map((k) => [k, v[k] ?? null])),
      moved: fx.moved || null,
    };
  });

  return { games: rows.length, base: base == null ? null : +base.toFixed(3), minBucket: MIN_BUCKET, formN: FORM_N, h2hMin, features, grids, round };
}

// BTTS spread: every game played, home 1+ chance (rows) × away 1+ chance (columns) in 10-pt steps,
// with row / column totals. rows: [{ o, h1, a1 }]; fixtures: this round's [{ label, pred }]
const SPREAD = [[(v) => v < 0.5, '<50%'], [(v) => v < 0.6, '50s'], [(v) => v < 0.7, '60s'], [(v) => v < 0.8, '70s'], [(v) => v < 0.9, '80s'], [() => true, '90%+']];
const spreadBin = (v) => SPREAD.findIndex(([t]) => t(v));
function spread(rows) {
  const k = SPREAD.length;
  const cells = Array.from({ length: k }, () => Array.from({ length: k }, () => ({ n: 0, hits: 0 })));
  const rowT = Array.from({ length: k }, () => ({ n: 0, hits: 0 }));
  const colT = Array.from({ length: k }, () => ({ n: 0, hits: 0 }));
  let n = 0; let hits = 0;
  for (const x of rows) {
    if (x.h1 == null || x.a1 == null) continue;
    const i = spreadBin(x.h1); const j = spreadBin(x.a1);
    for (const c of [cells[i][j], rowT[i], colT[j]]) { c.n += 1; c.hits += x.o; }
    n += 1; hits += x.o;
  }
  const fin = (c) => ({ n: c.n, rate: c.n ? +(c.hits / c.n).toFixed(3) : null });
  return {
    labels: SPREAD.map(([, l]) => l), games: n, base: n ? +(hits / n).toFixed(3) : null,
    cells: cells.map((r) => r.map(fin)), rows: rowT.map(fin), cols: colT.map(fin),
  };
}
const spreadPos = (pred) => (pred ? [spreadBin(pred.h1), spreadBin(pred.a1)] : null);

// the drivers chart: same past games and fixtures, the DRIVER feature set (round notes already logged)
const drivers = (rows, byTeam, byH2H, fixtures, h2hMin = H2H_MIN) => summarise(rows, byTeam, byH2H, fixtures, { cell() {} }, '', h2hMin,
  { features: DRIVER_FEATURES, grids: DRIVER_GRIDS });

module.exports = {
  drivers, DRIVER_FEATURES, DRIVER_GRIDS, spread, spreadPos,
  analyse, summarise, formFeatures, modelFeatures, bt, FEATURES, GRIDS, pearson, deepFile, DEEP_FROM, H2H_FROM, FORM_N,
};
