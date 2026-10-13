'use strict';
// Penalty goals per match, so the model can rate teams on non-penalty goals.
//
// Source: ESPN's public scoreboard, one request per league per match day. Each goal carries
// penaltyKick and the scoring team; own goals are not penalties. A match is recorded only when
// ESPN's final score equals the football-data.co.uk score for the same fixture, so every count
// traces to a feed that agrees on the result.
//
// Finished seasons are stored compactly in data/penalties/<league>.json (built once by
// scripts/build_penalties.js); the current season is read from ESPN at chart time and cached.

const fs = require('fs');
const path = require('path');
const F = require('./fetch');
const { sim } = require('./markets');

const ESPN = { pl: 'eng.1', laliga: 'esp.1', seriea: 'ita.1', ligue1: 'fra.1' };
const TTL_PAST = 24 * 365;
const TTL_CUR = 6;
const key = (g) => `${g.date}|${g.home}|${g.away}`;
const file = (league) => path.join(F.ROOT, 'data', 'penalties', `${league}.json`);

function loadStored(league) {
  try {
    return JSON.parse(fs.readFileSync(file(league), 'utf8'));
  } catch {
    return { matches: {} };
  }
}

// One ESPN match day -> [{ home, away, hg, ag, hp, ap }]
async function espnDay(fetcher, league, date, ttl) {
  const url = `https://site.api.espn.com/apis/site/v2/sports/soccer/${ESPN[league]}/scoreboard?dates=${date.replace(/-/g, '')}`;
  const j = await fetcher.getJson(url, ttl);
  if (!j || !Array.isArray(j.events)) return null;
  const out = [];
  for (const e of j.events) {
    const c = (e.competitions || [])[0] || {};
    if (!((c.status || e.status || {}).type || {}).completed) continue;
    const side = (k) => (c.competitors || []).find((x) => x.homeAway === k) || {};
    const h = side('home');
    const a = side('away');
    if (!h.team || !a.team) continue;
    let hp = 0;
    let ap = 0;
    for (const d of c.details || []) {
      if (!d.scoringPlay || !d.penaltyKick || d.ownGoal) continue;
      const tid = d.team && String(d.team.id);
      if (tid === String(h.team.id)) hp += 1; else if (tid === String(a.team.id)) ap += 1;
    }
    out.push({ home: h.team.displayName, away: a.team.displayName, hg: +h.score, ag: +a.score, hp, ap });
  }
  return out;
}

// games: football-data games (canonical names). Returns Map key -> { hp, ap } for the games whose
// ESPN record matches; `stored` (finished seasons) is used first, ESPN only for the rest.
async function forGames(fetcher, league, games, canon, { ttl = TTL_CUR, useStored = true } = {}) {
  const out = new Map();
  const stored = useStored ? loadStored(league).matches : {};
  const need = [];
  for (const g of games) {
    const s = stored[key(g)];
    if (s) out.set(key(g), { hp: s[0], ap: s[1] }); else need.push(g);
  }
  const byDate = new Map();
  for (const g of need) { if (!byDate.has(g.date)) byDate.set(g.date, []); byDate.get(g.date).push(g); }
  const dates = [...byDate.keys()];
  const POOL = 8;
  for (let i = 0; i < dates.length; i += POOL) {
    await Promise.all(dates.slice(i, i + POOL).map(async (date) => {
      // ESPN files a match under its US-time date: look at the day itself and the day before
      const days = (await Promise.all([date, prevDay(date)].map((d) => espnDay(fetcher, league, d, ttl)))).flat().filter(Boolean);
      for (const g of byDate.get(date)) {
        let best = null;
        for (const e of days) {
          if (e.hg !== g.hg || e.ag !== g.ag) continue; // the two feeds must agree on the score
          const sc = Math.max(sim(e.home, g.home), sim(canon(e.home), g.home)) + Math.max(sim(e.away, g.away), sim(canon(e.away), g.away));
          if (sc >= 1.2 && (!best || sc > best.sc)) best = { sc, e };
        }
        if (best) out.set(key(g), { hp: best.e.hp, ap: best.e.ap });
      }
    }));
  }
  return out;
}

function prevDay(iso) {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

module.exports = { ESPN, forGames, loadStored, file, key, TTL_PAST };
