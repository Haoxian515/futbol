'use strict';
// Match-outcome model and its backtest.
//
// Model: independent Poisson goals with a Dixon–Coles low-score correction.
//   λ_home = league home goals/game × attack(home) × defence(away)
//   λ_away = league away goals/game × attack(away) × defence(home)
// attack / defence are a team's goals scored / conceded per game relative to the league average.
// Each is last season's value blended with this season's to date, weighted K : games played, so a
// small sample is pulled towards last season (and last season towards the average via the blend).
// A team with no top-flight season last year starts at the mean of last season's bottom three
// (the clubs it replaced). Everything is computed from cached match results; nothing is assumed.
//
// Backtest data: football-data.co.uk season CSVs (results + bookmaker odds). Each game is predicted
// using only games played on earlier dates, then scored against the result and against the
// bookmakers' closing odds (margin removed) and a base rate (last season's H/D/A frequencies).

const F = require('./fetch');
const T = require('./time');
const intl = require('./intl');

const TTL_CUR = 6;
const TTL_PAST = 24 * 30;
const MAX_GOALS = 10;
// Chosen by the backtest's tuning seasons (2022-23, 2023-24, all four leagues) — see tune() and
// /api/backtest. Not re-fitted at chart time so charts are deterministic.
const PARAMS = { K: 12, rho: -0.1 };
const DIV = { pl: 'E0', laliga: 'SP1', seriea: 'I1', ligue1: 'F1' };
const FIRST_SEASON = 2021; // football-data seasons used: 2021-22 (prior only) onward

const code = (y) => `${String(y).slice(2)}${String(y + 1).slice(2)}`;
const fdUrl = (div, y) => `https://football-data.co.uk/mmz4281/${code(y)}/${div}.csv`;

// ------------------------------------------------------------------ data
function fdDate(s) {
  const m = (s || '').match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
  if (!m) return null;
  const y = m[3].length === 2 ? 2000 + +m[3] : +m[3];
  return T.validIso(y, +m[2], +m[1]);
}

function num(r, ...keys) {
  for (const k of keys) {
    const v = parseFloat(r[k]);
    if (v > 1) return v;
  }
  return null;
}

// Closing 1X2 and over/under 2.5 prices -> probabilities with the bookmaker margin removed.
function marketProbs(r) {
  const h = num(r, 'PSCH', 'AvgCH', 'B365CH', 'AvgH');
  const d = num(r, 'PSCD', 'AvgCD', 'B365CD', 'AvgD');
  const a = num(r, 'PSCA', 'AvgCA', 'B365CA', 'AvgA');
  const o = num(r, 'PC>2.5', 'AvgC>2.5', 'Avg>2.5');
  const u = num(r, 'PC<2.5', 'AvgC<2.5', 'Avg<2.5');
  const out = {};
  if (h && d && a) {
    const s = 1 / h + 1 / d + 1 / a;
    Object.assign(out, { pH: 1 / h / s, pD: 1 / d / s, pA: 1 / a / s });
  }
  if (o && u) out.o25 = (1 / o) / (1 / o + 1 / u);
  return out;
}

// One league season from football-data.co.uk: completed games, oldest first.
async function loadSeason(fetcher, league, y, canon, ttl) {
  const div = DIV[league];
  if (!div) return null;
  const text = await fetcher.get(fdUrl(div, y), ttl);
  if (text == null) return null;
  const rows = intl.parseCsv(text);
  const games = [];
  for (const r of rows) {
    const date = fdDate(r.Date);
    if (!date || !r.HomeTeam || !/^\d+$/.test(r.FTHG || '') || !/^\d+$/.test(r.FTAG || '')) continue;
    games.push({ date, home: canon(r.HomeTeam), away: canon(r.AwayTeam), hg: +r.FTHG, ag: +r.FTAG, market: marketProbs(r) });
  }
  games.sort((p, q) => (p.date < q.date ? -1 : p.date > q.date ? 1 : 0));
  return games;
}

// ------------------------------------------------------------------ model
function tally(games) {
  const t = new Map();
  const tot = { hg: 0, ag: 0, n: 0 };
  for (const g of games) add(t, tot, g);
  return { t, tot };
}

function add(t, tot, g) {
  for (const [team, gf, ga] of [[g.home, g.hg, g.ag], [g.away, g.ag, g.hg]]) {
    if (!t.has(team)) t.set(team, { gf: 0, ga: 0, n: 0 });
    const r = t.get(team);
    r.gf += gf; r.ga += ga; r.n += 1;
  }
  tot.hg += g.hg; tot.ag += g.ag; tot.n += 1;
}

// prior: tally of last season; cur: tally of this season to date. -> strength lookup
function strengths(prior, cur, params) {
  const pAvg = (prior.tot.hg + prior.tot.ag) / (2 * prior.tot.n);
  const rel = new Map();
  for (const [team, r] of prior.t) rel.set(team, { att: r.gf / r.n / pAvg, def: r.ga / r.n / pAvg, pts: 0 });
  // bottom three of last season by goal difference per game (points are not in the tally; GD is a
  // close proxy and needs no extra source) -> prior for promoted clubs
  const bottom = [...prior.t.entries()].sort((p, q) => (p[1].gf - p[1].ga) / p[1].n - (q[1].gf - q[1].ga) / q[1].n).slice(0, 3);
  const promo = {
    att: bottom.reduce((a, [, r]) => a + r.gf / r.n / pAvg, 0) / bottom.length,
    def: bottom.reduce((a, [, r]) => a + r.ga / r.n / pAvg, 0) / bottom.length,
  };
  const cAvg = cur.tot.n >= 30 ? (cur.tot.hg + cur.tot.ag) / (2 * cur.tot.n) : pAvg;
  const homeAvg = (prior.tot.hg + cur.tot.hg) / (prior.tot.n + cur.tot.n);
  const awayAvg = (prior.tot.ag + cur.tot.ag) / (prior.tot.n + cur.tot.n);
  const get = (team) => {
    const base = rel.get(team) || promo;
    const c = cur.t.get(team);
    if (!c || !c.n) return { att: base.att, def: base.def, n: 0, promoted: !rel.has(team) };
    const w = c.n / (c.n + params.K);
    return {
      att: (1 - w) * base.att + w * (c.gf / c.n / cAvg),
      def: (1 - w) * base.def + w * (c.ga / c.n / cAvg),
      n: c.n, promoted: !rel.has(team),
    };
  };
  return { get, homeAvg, awayAvg };
}

const pois = (l, k) => {
  let p = Math.exp(-l);
  for (let i = 1; i <= k; i++) p *= l / i;
  return p;
};

function predict(S, home, away, params) {
  const h = S.get(home);
  const a = S.get(away);
  const lh = S.homeAvg * h.att * a.def;
  const la = S.awayAvg * a.att * h.def;
  const ph = []; const pa = [];
  for (let k = 0; k <= MAX_GOALS; k++) { ph.push(pois(lh, k)); pa.push(pois(la, k)); }
  const r = params.rho;
  let pH = 0; let pD = 0; let pA = 0; let btts = 0; let o25 = 0; let tot = 0;
  for (let i = 0; i <= MAX_GOALS; i++) {
    for (let j = 0; j <= MAX_GOALS; j++) {
      let p = ph[i] * pa[j];
      if (i === 0 && j === 0) p *= 1 - lh * la * r;
      else if (i === 0 && j === 1) p *= 1 + lh * r;
      else if (i === 1 && j === 0) p *= 1 + la * r;
      else if (i === 1 && j === 1) p *= 1 - r;
      tot += p;
      if (i > j) pH += p; else if (i === j) pD += p; else pA += p;
      if (i > 0 && j > 0) btts += p;
      if (i + j > 2) o25 += p;
    }
  }
  return {
    lh, la, pH: pH / tot, pD: pD / tot, pA: pA / tot, btts: btts / tot, o25: o25 / tot,
    h1: 1 - ph[0], h2: 1 - ph[0] - ph[1], a1: 1 - pa[0], a2: 1 - pa[0] - pa[1],
    hN: h.n, aN: a.n, hPromoted: h.promoted, aPromoted: a.promoted,
  };
}

// ------------------------------------------------------------------ backtest
// Walk a season in date order; predict each date's games from games on earlier dates only.
function walk(prior, season, params, onGame) {
  const P = tally(prior);
  const cur = { t: new Map(), tot: { hg: 0, ag: 0, n: 0 } };
  let i = 0;
  while (i < season.length) {
    const d = season[i].date;
    const S = strengths(P, cur, params);
    let j = i;
    while (j < season.length && season[j].date === d) {
      onGame(season[j], predict(S, season[j].home, season[j].away, params));
      j++;
    }
    for (let k = i; k < j; k++) add(cur.t, cur.tot, season[k]);
    i = j;
  }
}

const outcome = (g) => (g.hg > g.ag ? 'H' : g.hg === g.ag ? 'D' : 'A');
const brier3 = (p, o) => ['H', 'D', 'A'].reduce((s, k) => s + ((p[`p${k}`] || 0) - (o === k ? 1 : 0)) ** 2, 0);
const logloss = (p, o) => -Math.log(Math.max(1e-9, p[`p${o}`]));
const brier1 = (p, hit) => (p - (hit ? 1 : 0)) ** 2;

function score(prior, season, params) {
  // base rate = last season's H/D/A frequencies (known before the season starts)
  const base = { pH: 0, pD: 0, pA: 0 };
  for (const g of prior) base[`p${outcome(g)}`] += 1 / prior.length;
  const baseO25 = prior.filter((g) => g.hg + g.ag > 2).length / prior.length;
  const baseBtts = prior.filter((g) => g.hg > 0 && g.ag > 0).length / prior.length;
  const s = {
    n: 0, model: 0, market: 0, base: 0, nMarket: 0, llModel: 0, llMarket: 0, pickModel: 0, pickMarket: 0,
    o25Model: 0, o25Market: 0, o25Base: 0, nO25: 0, bttsModel: 0, bttsBase: 0,
    modelOnMarket: 0, calib: Array.from({ length: 10 }, () => ({ n: 0, p: 0, hit: 0 })),
  };
  const pick = (p) => ['H', 'D', 'A'].reduce((b, k) => (p[`p${k}`] > p[`p${b}`] ? k : b), 'H');
  walk(prior, season, params, (g, p) => {
    const o = outcome(g);
    s.n += 1;
    s.model += brier3(p, o); s.base += brier3(base, o); s.llModel += logloss(p, o);
    s.pickModel += pick(p) === o ? 1 : 0;
    const over = g.hg + g.ag > 2;
    const both = g.hg > 0 && g.ag > 0;
    s.bttsModel += brier1(p.btts, both); s.bttsBase += brier1(baseBtts, both);
    const c = s.calib[Math.min(9, Math.floor(p.pH * 10))];
    c.n += 1; c.p += p.pH; c.hit += o === 'H' ? 1 : 0;
    if (g.market.pH != null) {
      s.nMarket += 1; s.market += brier3(g.market, o); s.llMarket += logloss(g.market, o);
      s.modelOnMarket += brier3(p, o);
      s.pickMarket += pick(g.market) === o ? 1 : 0;
    }
    if (g.market.o25 != null) {
      s.nO25 += 1; s.o25Model += brier1(p.o25, over); s.o25Market += brier1(g.market.o25, over); s.o25Base += brier1(baseO25, over);
    }
  });
  const r = (x, n) => (n ? +(x / n).toFixed(4) : null);
  return {
    games: s.n,
    brier: { model: r(s.model, s.n), market: r(s.market, s.nMarket), base: r(s.base, s.n), modelOnMarketGames: r(s.modelOnMarket, s.nMarket) },
    logLoss: { model: r(s.llModel, s.n), market: r(s.llMarket, s.nMarket) },
    topPick: { model: r(s.pickModel, s.n), market: r(s.pickMarket, s.nMarket) },
    over25: { model: r(s.o25Model, s.nO25), market: r(s.o25Market, s.nO25), base: r(s.o25Base, s.nO25) },
    btts: { model: r(s.bttsModel, s.n), base: r(s.bttsBase, s.n) },
    calibration: s.calib.filter((c) => c.n).map((c) => ({ games: c.n, predicted: +(c.p / c.n).toFixed(3), actual: +(c.hit / c.n).toFixed(3) })),
  };
}

// grid search on the tuning seasons; returns every combination's Brier so the choice is visible
function tune(data, seasons) {
  const grid = [];
  for (const K of [4, 8, 12, 20, 30]) {
    for (const rho of [0, -0.05, -0.1, -0.15]) {
      let b = 0; let n = 0;
      for (const { prior, season } of data.filter((d) => seasons.includes(d.y))) {
        walk(prior, season, { K, rho }, (g, p) => { b += brier3(p, outcome(g)); n += 1; });
      }
      grid.push({ K, rho, brier: +(b / n).toFixed(4), games: n });
    }
  }
  grid.sort((p, q) => p.brier - q.brier);
  return grid;
}

const TUNE = [2022, 2023];

// Full backtest for one league: every season from FIRST_SEASON+1 to the current one.
async function backtest(fetcher, league, canon, currentY) {
  const seasons = [];
  for (let y = FIRST_SEASON; y <= currentY; y++) {
    seasons.push({ y, games: await loadSeason(fetcher, league, y, canon, y === currentY ? TTL_CUR : TTL_PAST) });
  }
  const data = [];
  for (let i = 1; i < seasons.length; i++) {
    if (seasons[i - 1].games && seasons[i].games && seasons[i].games.length) {
      data.push({ y: seasons[i].y, prior: seasons[i - 1].games, season: seasons[i].games });
    }
  }
  return {
    league, params: PARAMS, tuneSeasons: TUNE.map((y) => `${y}-${String(y + 1).slice(2)}`),
    seasons: data.map((d) => ({
      season: `${d.y}-${String(d.y + 1).slice(2)}`, role: TUNE.includes(d.y) ? 'tuning' : 'test',
      ...score(d.prior, d.season, PARAMS),
    })),
    source: `football-data.co.uk ${DIV[league]} ${FIRST_SEASON}-${String(FIRST_SEASON + 1).slice(2)} onward`,
  };
}

module.exports = {
  PARAMS, DIV, TUNE, loadSeason, tally, add, strengths, predict, walk, score, tune, backtest, fdUrl, code,
};
