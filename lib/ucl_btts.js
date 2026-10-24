'use strict';
// BTTS correlation study for the UEFA club-competition charts (Champions League, Europa League;
// see lib/btts.js for the measures). Names below say Champions League; comp gives the actual one.
//   Form (last 10): each club's Champions League games (qualifiers to final) merged with its
//     domestic league games from football-data.co.uk (lib/domestic.js); clubs from countries
//     without a file use their UCL games only.
//   H2H: Champions League meetings only (stored seasons from 2022-23 — thin by nature).
//   MODEL figures: the UCL model (lib/ucl.js PARAMS), rebuilt game by game as in its backtest.
// Scored: league-/group-phase games from the first season with a model prior.

const P = require('./predict');
const BT = require('./btts');
const D = require('./domestic');

const H2H_MIN = 1; // UCL pairs rarely meet more than once or twice

const byTeamOf = (games) => {
  const m = new Map();
  for (const g of games) for (const t of [g.home, g.away]) { if (!m.has(t)) m.set(t, []); m.get(t).push(g); }
  for (const list of m.values()) list.sort((p, q) => (p.date < q.date ? -1 : p.date > q.date ? 1 : 0));
  return m;
};

// H: stored seasons (lib/ucl.js history()); cur: this season's matches; e: this season's year;
// seasons(y): model games of season y (no qualifiers); params: UCL model settings;
// fixtures: this round [{ label, home, away, date, pred, result }]
// driversFixtures: a completed matchday for the drivers chart (no MODEL figures: taken from the walk)
async function analyse(fetcher, { comp = { short: 'Champions League', abbr: 'UCL' }, H, cur, e, today, seasons, params, fixtures, driversFixtures = null, log, firstEval }) {
  const stored = [...H.keys()].sort();
  const from = firstEval || stored[0] + 1;
  // every club in a scored season's league/group phase, and this round's, with its country
  const clubs = new Map();
  for (const y of stored) {
    const s = H.get(y);
    if (y < from) continue;
    for (const m of s.matches) if (m.phase) for (const t of [m.home, m.away]) clubs.set(t, s.countries.get(t) || clubs.get(t) || null);
  }
  for (const m of cur) if (m.phase) { clubs.set(m.home, m.hc || null); clubs.set(m.away, m.ac || null); }

  const formFrom = `${from - 2}-07-01`; // a year before the first scored season starts
  const dom = await D.forClubs(fetcher, clubs, formFrom, today);
  const uclGames = [...stored.flatMap((y) => H.get(y).matches), ...cur.filter((m) => m.done)].map((m) => ({ ...m, comp: comp.abbr }));
  const byH2H = byTeamOf(uclGames);
  const byForm = new Map();
  for (const club of clubs.keys()) {
    byForm.set(club, [...(byH2H.get(club) || []), ...(dom.games.get(club) || [])].sort((p, q) => (p.date < q.date ? -1 : p.date > q.date ? 1 : 0)));
  }

  const rows = [];
  const scored = [];
  const preds = new Map(); // this season's walk predictions, home|away -> p
  const seasonRows = []; // this season's games, for the spread's "This season" scope
  for (let y = from; y <= e; y++) {
    const prior = [...seasons(y - 2), ...seasons(y - 1)];
    const games = seasons(y);
    if (!prior.length || !games.some((g) => g.phase)) continue;
    scored.push(y);
    P.walk(prior, games, params, (g, p) => {
      if (!g.phase) return;
      const row = {
        o: BT.bt(g) ? 1 : 0, hg: g.hg, ag: g.ag, ...BT.formFeatures(byForm, g.home, g.away, g.date, byH2H, H2H_MIN), ...BT.modelFeatures(p),
        // season goals = this competition's games so far that season (league phase on)
        ...BT.seasonGoals(games.filter((x) => x.phase && x.date < g.date), g.home, g.away),
      };
      rows.push(row);
      if (y === e) { preds.set(`${g.home}|${g.away}`, p); seasonRows.push(row); }
    });
  }

  const inRound = new Set(fixtures.flatMap((f) => [f.home, f.away]));
  const uclOnly = dom.missing.filter(([c]) => inRound.has(c));
  for (const [c, why] of uclOnly) log.cell('BTTS STUDY', `last 10 = ${comp.short} games only (${why})`, c);
  const lab = (y) => `${y - 1}-${String(y).slice(2)}`;
  // exact scores: league/group phase of the last 4 finished seasons, and this season so far
  const past = [4, 3, 2, 1].map((k) => e - k).filter((y) => seasons(y).some((g) => g.phase));
  return {
    scores: {
      all: BT.scorelines(past.flatMap((y) => seasons(y).filter((g) => g.phase)),
        past.length ? `${lab(past[0])} to ${lab(past[past.length - 1])}, league/group phase` : ''),
      bySeason: past.map((y) => ({ label: lab(y), ...BT.scorelines(seasons(y).filter((g) => g.phase), `${lab(y)}, ${y >= 2025 ? 'league' : 'group'} phase`) })),
      season: BT.scorelines(seasons(e).filter((g) => g.phase), `${lab(e)}, league phase so far`),
      teams: BT.teamScorelines(fixtures, {
        bySeason: past.map((y) => [lab(y), seasons(y).filter((g) => g.phase)]), season: seasons(e).filter((g) => g.phase),
      }),
    },
    ...BT.summarise(rows, byForm, byH2H, fixtures, log, `fewer than ${BT.FORM_N} games in the last 12 months`, H2H_MIN),
    spread: {
      all: { ...BT.spread(rows), from: scored.length ? `${lab(scored[0])} to ${lab(scored[scored.length - 1])}, league phase` : '' },
      season: { ...BT.spread(seasonRows), from: `${lab(e)}, league phase so far` },
      fixtures: fixtures.map((f) => ({
        label: f.label, h1: f.pred ? f.pred.h1 : null, a1: f.pred ? f.pred.a1 : null, pos: BT.spreadPos(f.pred), result: f.result,
        ...BT.seasonGoals(cur.filter((x) => x.phase && x.done && x.date < (f.date || '9999')), f.home, f.away),
      })),
    },
    drivers: driversFixtures ? {
      ...BT.drivers(rows, byForm, byH2H, driversFixtures.map((f) => ({ ...f, pred: preds.get(`${f.home}|${f.away}`) || null }))
        .sort((p, q) => (p.date < q.date ? -1 : p.date > q.date ? 1 : 0)), H2H_MIN),
      current: BT.drivers(rows, byForm, byH2H, fixtures, H2H_MIN).round, // this matchday's fixtures, same bands
    } : BT.drivers(rows, byForm, byH2H, fixtures, H2H_MIN),
    seasons: scored.length ? `${lab(scored[0])} to ${lab(scored[scored.length - 1])} (league/group phase)` : '',
    h2hFrom: lab(stored[0]), formDesc: `games (domestic league + ${comp.short})`, h2hDesc: `${comp.short} meeting`,
    source: `UEFA match feeds (${comp.short} games, H2H) + football-data.co.uk domestic league results `
      + `(${dom.covered.length} clubs matched; ${dom.missing.length} from countries without a file use ${comp.abbr} games only); `
      + `MODEL figures from the ${comp.short} model, built from earlier games only`,
  };
}

module.exports = { analyse };
