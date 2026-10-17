'use strict';
// Domestic league results for clubs in UEFA club competitions (football-data.co.uk), so a club's
// "last 10" can include the games it played at home as well as in Europe.
//
// Two file layouts on football-data.co.uk:
//   main — one CSV per division and season: /mmz4281/<2526>/<DIV>.csv (Date, HomeTeam, AwayTeam, FTHG, FTAG)
//   new  — one CSV per country, every season: /new/<CC>.csv (Date, Home, Away, HG, AG)
// A UEFA club is matched to its domestic name by country + name similarity (with aliases for names
// that don't resemble each other). Countries without a file (e.g. Czechia, Ukraine) get nothing,
// and the caller falls back to the club's UEFA games only.
// Penalty goals: the big-four leagues' stored per-match records (data/penalties, ESPN), this season
// from ESPN; other leagues have no penalty source, so their games count all goals.

const intl = require('./intl');
const T = require('./time');
const PEN = require('./penalties');

const MAIN = { ENG: 'E0', ESP: 'SP1', ITA: 'I1', FRA: 'F1', GER: 'D1', NED: 'N1', POR: 'P1', BEL: 'B1', TUR: 'T1', GRE: 'G1', SCO: 'SC0' };
const NEW = { AUT: 'AUT', NOR: 'NOR', SUI: 'SWZ', DEN: 'DNK', POL: 'POL', ROU: 'ROU', SWE: 'SWE' };
const LEAGUE_NAME = {
  E0: 'Premier League', SP1: 'La Liga', I1: 'Serie A', F1: 'Ligue 1', D1: 'Bundesliga', N1: 'Eredivisie', P1: 'Primeira Liga',
  B1: 'Belgian Pro League', T1: 'Süper Lig', G1: 'Greek Super League', SC0: 'Scottish Premiership', AUT: 'Austrian Bundesliga',
  NOR: 'Eliteserien', SWZ: 'Swiss Super League', DNK: 'Danish Superliga', POL: 'Ekstraklasa', ROU: 'Liga I', SWE: 'Allsvenskan',
};
const PEN_LEAGUE = { E0: 'pl', SP1: 'laliga', I1: 'seriea', F1: 'ligue1', D1: 'bundesliga' };
const TTL_CUR = 6;
const TTL_PAST = 24 * 30;
// UEFA name -> football-data name where token matching can't bridge them
const ALIAS = {
  Atleti: 'Ath Madrid', 'Athletic Club': 'Ath Bilbao', 'Real Sociedad': 'Sociedad', 'Real Betis': 'Betis', 'Man Utd': 'Man United',
  Paris: 'Paris SG', 'B. Dortmund': 'Dortmund', 'Bayern München': 'Bayern Munich', Leipzig: 'RB Leipzig', Frankfurt: 'Ein Frankfurt',
  'Sporting CP': 'Sp Lisbon', Braga: 'Sp Braga', 'Union SG': 'St. Gilloise', PSV: 'PSV Eindhoven', Olympiacos: 'Olympiakos',
  Copenhagen: 'FC Copenhagen', 'AEK Athens': 'AEK', 'N.E.C.': 'Nijmegen', Salzburg: 'Salzburg', 'Sturm Graz': 'Sturm Graz', Milan: 'Milan',
};

const code = (y) => `${String(y).slice(2)}${String(y + 1).slice(2)}`;
const fold = (s) => (s || '').replace(/[øØ]/g, 'o').replace(/[æÆ]/g, 'ae').replace(/ß/g, 'ss').replace(/[ıİ]/g, 'i')
  .normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ');
const STOP = new Set(['fc', 'cf', 'ac', 'sc', 'afc', 'club', 'de', 'the', 'fk', 'sk', 'if', 'bk', 'as', 'ss', 'ssc', 'us', 'cd', 'sd', 'ud', 'rc', 'rcd', 'sv', 'vfb', 'vfl', 'tsg', 'bv', 'kv', 'krc', 'rsc']);
const toks = (s) => fold(s).split(/\s+/).filter((w) => w && !STOP.has(w));
function sim(a, b) {
  const A = toks(a);
  const B = toks(b);
  if (!A.length || !B.length) return 0;
  const hit = (x, ys) => ys.some((y) => (x.length >= 3 && y.length >= 3 ? x.startsWith(y.slice(0, 4)) || y.startsWith(x.slice(0, 4)) : x === y));
  return (A.filter((x) => hit(x, B)).length + B.filter((y) => hit(y, A)).length) / (A.length + B.length);
}

function fdDate(s) {
  const m = (s || '').match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
  if (!m) return null;
  return T.validIso(m[3].length === 2 ? 2000 + +m[3] : +m[3], +m[2], +m[1]);
}

function rowsToGames(rows, cols, label) {
  const out = [];
  for (const r of rows) {
    const date = fdDate(r.Date);
    const hg = r[cols.hg];
    const ag = r[cols.ag];
    if (!date || !r[cols.home] || !/^\d+$/.test(hg || '') || !/^\d+$/.test(ag || '')) continue;
    out.push({ date, home: r[cols.home], away: r[cols.away], hg: +hg, ag: +ag, comp: LEAGUE_NAME[label] || label });
  }
  return out;
}

// every domestic league game of one country from `from` (ISO date) on, oldest first; null = no file
async function loadCountry(fetcher, cc, from, today) {
  const curY = +today.slice(0, 4) - (+today.slice(5, 7) < 7 ? 1 : 0);
  if (MAIN[cc]) {
    const div = MAIN[cc];
    const games = [];
    for (let y = +from.slice(0, 4) - 1; y <= curY; y++) {
      const text = await fetcher.get(`https://football-data.co.uk/mmz4281/${code(y)}/${div}.csv`, y === curY ? TTL_CUR : TTL_PAST);
      if (text) games.push(...rowsToGames(intl.parseCsv(text), { home: 'HomeTeam', away: 'AwayTeam', hg: 'FTHG', ag: 'FTAG' }, div));
    }
    return { div, games: games.filter((g) => g.date >= from).sort((p, q) => (p.date < q.date ? -1 : 1)) };
  }
  if (NEW[cc]) {
    const text = await fetcher.get(`https://football-data.co.uk/new/${NEW[cc]}.csv`, 24);
    if (!text) return null;
    const games = rowsToGames(intl.parseCsv(text), { home: 'Home', away: 'Away', hg: 'HG', ag: 'AG' }, NEW[cc]);
    return { div: NEW[cc], games: games.filter((g) => g.date >= from).sort((p, q) => (p.date < q.date ? -1 : 1)) };
  }
  return null;
}

// penalty goals for big-four games: stored records matched by date + names, ESPN for the rest
async function attachPenalties(fetcher, div, games) {
  const league = PEN_LEAGUE[div];
  if (!league) return;
  const stored = PEN.loadStored(league).matches;
  const byDate = new Map();
  for (const [k, v] of Object.entries(stored)) {
    const [date, home, away] = k.split('|');
    if (!byDate.has(date)) byDate.set(date, []);
    byDate.get(date).push({ home, away, v });
  }
  const rest = [];
  for (const g of games) {
    let best = null;
    for (const e of byDate.get(g.date) || []) {
      const sc = sim(e.home, g.home) + sim(e.away, g.away);
      if (sc >= 1.2 && (!best || sc > best.sc)) best = { sc, e };
    }
    if (best) { g.hp = best.e.v[0]; g.ap = best.e.v[1]; } else rest.push(g);
  }
  if (!rest.length) return;
  const found = await PEN.forGames(fetcher, league, rest, (x) => x, { useStored: false });
  for (const g of rest) {
    const p = found.get(PEN.key(g));
    if (p) { g.hp = p.hp; g.ap = p.ap; }
  }
}

// clubs: Map UEFA name -> country code. Returns { games: Map UEFA name -> domestic games (with the
// club under its UEFA name), covered: [...], missing: [[club, reason]] }
async function forClubs(fetcher, clubs, from, today) {
  const byCountry = new Map();
  for (const [club, cc] of clubs) { if (!byCountry.has(cc)) byCountry.set(cc, []); byCountry.get(cc).push(club); }
  const games = new Map();
  const covered = [];
  const missing = [];
  for (const [cc, list] of byCountry) {
    const d = cc ? await loadCountry(fetcher, cc, from, today) : null;
    if (!d || !d.games.length) { for (const c of list) missing.push([c, `no ${cc || 'country'} league file on football-data.co.uk`]); continue; }
    await attachPenalties(fetcher, d.div, d.games);
    const names = [...new Set(d.games.flatMap((g) => [g.home, g.away]))];
    for (const club of list) {
      const want = ALIAS[club];
      let name = want && names.includes(want) ? want : null;
      if (!name) {
        let best = null;
        for (const n of names) { const s = sim(club, n); if (s >= 0.5 && (!best || s > best.s)) best = { s, n }; }
        name = best && best.n;
      }
      if (!name) { missing.push([club, `not found in ${d.div} (alias missing?)`]); continue; }
      covered.push([club, name, d.div]);
      games.set(club, d.games.filter((g) => g.home === name || g.away === name)
        .map((g) => ({ ...g, home: g.home === name ? club : g.home, away: g.away === name ? club : g.away })));
    }
  }
  return { games, covered, missing };
}

module.exports = { forClubs, loadCountry, sim, MAIN, NEW };
