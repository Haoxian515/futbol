'use strict';
// Domestic context for clubs in the Champions League chart:
//   LEAGUE POS — the club's current place in its domestic league table (ESPN standings, live)
//   UEFA RANK  — its country's place in UEFA's association coefficient ranking for this season
//                (UEFA's own coefficients feed, all 55 associations)
// Clubs are matched to ESPN's names within their country (aliases + name similarity). A country
// ESPN has no table for, or a table for another season, gives "—" (no guessing).

const D = require('./domestic');

const ESPN = {
  ENG: 'eng.1', ESP: 'esp.1', ITA: 'ita.1', FRA: 'fra.1', GER: 'ger.1', NED: 'ned.1', POR: 'por.1', BEL: 'bel.1', TUR: 'tur.1',
  GRE: 'gre.1', SCO: 'sco.1', AUT: 'aut.1', NOR: 'nor.1', DEN: 'den.1', SWE: 'swe.1',
};
// UEFA name -> ESPN name where name similarity can't bridge them
const ALIAS = {
  Inter: 'Internazionale', Milan: 'AC Milan', Atleti: 'Atletico Madrid', Paris: 'Paris Saint-Germain', 'Man Utd': 'Manchester United',
  'Man City': 'Manchester City', 'B. Dortmund': 'Borussia Dortmund', 'Bayern München': 'Bayern Munich', Copenhagen: 'F.C. København',
  'Athletic Club': 'Athletic Club', PSV: 'PSV Eindhoven', 'N.E.C.': 'NEC Nijmegen',
};
const TTL_TABLE = 6;
const TTL_RANK = 24;

const stat = (entry, name) => {
  const s = (entry.stats || []).find((x) => x.name === name || x.type === name);
  return s ? s.value : null;
};

async function espnTable(fetcher, cc, seasonTag) {
  const code = ESPN[cc];
  if (!code) return null;
  const d = await fetcher.getJson(`https://site.api.espn.com/apis/v2/sports/soccer/${code}/standings`, TTL_TABLE);
  const kids = (d && d.children) || [];
  if (kids.length !== 1) return null; // split tables (championship / relegation groups) are not a single ranking
  const t = kids[0];
  const name = t.name || (d && d.name) || code;
  const season = (t.standings && t.standings.seasonDisplayName) || name;
  if (seasonTag && !seasonTag.some((s) => String(season).includes(s) || String(name).includes(s))) return { stale: season, name };
  const entries = (t.standings && t.standings.entries) || [];
  const rows = entries.map((e, i) => ({
    team: e.team.displayName, short: e.team.shortDisplayName, rank: stat(e, 'rank') || i + 1, played: stat(e, 'gamesPlayed'), pts: stat(e, 'points'),
  }));
  return { name: (d && d.name) || name, rows, of: rows.length };
}

async function uefaRanking(fetcher, e) {
  const d = await fetcher.getJson(`https://comp.uefa.com/v2/coefficients?coefficientRange=OVERALL&coefficientType=MEN_ASSOCIATION&language=EN&page=1&pagesize=60&seasonYear=${e}`, TTL_RANK);
  const rows = (d && d.data && d.data.members) || [];
  const by = new Map();
  for (const r of rows) {
    const o = r.overallRanking || {};
    if (r.member && r.member.countryCode && o.position) by.set(r.member.countryCode, { rank: o.position, pts: o.totalValue, name: r.member.countryName, of: rows.length });
  }
  return by;
}

// clubs: Map UEFA name -> country code; e: season year (2026-27 = 2027)
async function load(fetcher, clubs, e, log) {
  const tags = [`${e - 1}-${String(e).slice(2)}`, `${e - 1}-${e}`, `${e - 1}/${e}`, String(e - 1)];
  const ranks = await uefaRanking(fetcher, e);
  if (!ranks.size) log.warn('UEFA association coefficients unavailable — UEFA RANK is —');
  const tables = new Map();
  const out = new Map();
  for (const [club, cc] of clubs) {
    if (!tables.has(cc)) tables.set(cc, await espnTable(fetcher, cc, tags));
    const t = tables.get(cc);
    let pos = null;
    if (!t) log.cell('LEAGUE POS', `no ESPN league table for ${cc || 'this country'}`, club);
    else if (t.stale) log.cell('LEAGUE POS', `ESPN table is for ${t.stale}, not this season`, club);
    else {
      const want = ALIAS[club];
      let row = want && t.rows.find((r) => r.team === want);
      if (!row) {
        let best = null;
        for (const r of t.rows) {
          const s = Math.max(D.sim(club, r.team), D.sim(club, r.short || ''));
          if (s >= 0.5 && (!best || s > best.s)) best = { s, r };
        }
        row = best && best.r;
      }
      if (row) pos = { ...row, of: t.of, league: t.name };
      else log.cell('LEAGUE POS', `club not found in ESPN's ${t.name} table (alias missing?)`, club);
    }
    out.set(club, { pos, cc, uefa: ranks.get(cc) || null });
  }
  return out;
}

module.exports = { load, ESPN };
