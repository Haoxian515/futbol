'use strict';
// International friendlies: one chart per international window.
//
// Source: martj42/international_results results.csv on GitHub — every men's full international
// since 1872 (date, teams, score, tournament, city, country, neutral). It lists played matches
// only, so a window appears once its games are in the file. Friendlies have no round labels;
// a "window" is a run of friendly dates with no gap longer than WINDOW_GAP days, numbered from
// the first window on or after WINDOWS_FROM so the numbers stay stable as the file grows.
// Form, H2H and records count every international (any tournament), not just friendlies.

const T = require('./time');
const { formGame } = require('./form');

const URL = 'https://raw.githubusercontent.com/martj42/international_results/master/results.csv';
const GOALS_URL = 'https://raw.githubusercontent.com/martj42/international_results/master/goalscorers.csv';
const TTL = 24;
const WINDOW_GAP = 10;
const WINDOWS_FROM = '2024-01-01';
const KEY = 'intl';
const INFO = { key: KEY, name: 'International friendlies', roundWord: 'Window' };

class IntlError extends Error {}

// Plain CSV with quoted fields allowed; returns rows as objects keyed by the header.
function parseCsv(text) {
  const lines = text.replace(/^﻿/, '').split(/\r?\n/).filter((l) => l.trim());
  const split = (line) => {
    const out = [];
    let cur = '';
    let q = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (q) {
        if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; } else if (ch === '"') q = false; else cur += ch;
      } else if (ch === '"') q = true;
      else if (ch === ',') { out.push(cur); cur = ''; } else cur += ch;
    }
    out.push(cur);
    return out;
  };
  const head = split(lines[0]);
  return lines.slice(1).map((l) => Object.fromEntries(split(l).map((v, i) => [head[i], v])));
}

async function load(fetcher) {
  const text = await fetcher.get(URL, TTL);
  if (text == null) throw new IntlError(`international results unavailable: ${URL}`);
  const rows = parseCsv(text);
  const need = ['date', 'home_team', 'away_team', 'home_score', 'away_score', 'tournament', 'city', 'country', 'neutral'];
  if (!rows.length || need.some((k) => !(k in rows[0]))) {
    throw new IntlError(`results.csv columns changed (expected ${need.join(', ')}) — schema change, escalate`);
  }
  // goal-by-goal file: penalty goals per side, only for matches whose listed goals add up to the
  // score (friendlies are not itemised, so they get hp/ap = null)
  const goals = new Map();
  const gtext = await fetcher.get(GOALS_URL, TTL);
  if (gtext != null) {
    for (const g of parseCsv(gtext)) {
      const k = `${g.date}|${g.home_team}|${g.away_team}`;
      if (!goals.has(k)) goals.set(k, { n: 0, hp: 0, ap: 0 });
      const e = goals.get(k);
      e.n += 1;
      if (g.penalty === 'TRUE' && g.own_goal !== 'TRUE') {
        if (g.team === g.home_team) e.hp += 1; else if (g.team === g.away_team) e.ap += 1;
      }
    }
  }
  const matches = [];
  for (const r of rows) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(r.date)) continue;
    const hg = /^\d+$/.test(r.home_score) ? +r.home_score : null;
    const ag = /^\d+$/.test(r.away_score) ? +r.away_score : null;
    const g = goals.get(`${r.date}|${r.home_team}|${r.away_team}`);
    const itemised = hg != null && (hg + ag === 0 || (g && g.n === hg + ag));
    matches.push({
      date: r.date, home: r.home_team, away: r.away_team, hg, ag, comp: r.tournament,
      city: r.city, country: r.country, neutral: r.neutral === 'TRUE',
      hp: itemised ? (g ? g.hp : 0) : null, ap: itemised ? (g ? g.ap : 0) : null,
    });
  }
  matches.sort((p, q) => (p.date < q.date ? -1 : p.date > q.date ? 1 : 0));
  const byTeam = new Map();
  for (const m of matches) {
    if (m.hg == null) continue;
    for (const t of [m.home, m.away]) {
      if (!byTeam.has(t)) byTeam.set(t, []);
      byTeam.get(t).push(m);
    }
  }
  return { matches, byTeam, latest: matches.length ? matches[matches.length - 1].date : null };
}

function windows(matches) {
  const fr = matches.filter((m) => m.comp === 'Friendly' && m.date >= WINDOWS_FROM);
  const out = [];
  for (const m of fr) {
    const w = out[out.length - 1];
    if (w && T.diffDays(m.date, w.to) <= WINDOW_GAP) {
      w.games.push(m);
      w.to = m.date;
    } else {
      out.push({ from: m.date, to: m.date, games: [m] });
    }
  }
  return out.map((w, i) => ({ ...w, n: i + 1 }));
}

async function listWindows(fetcher) {
  const d = await load(fetcher);
  const ws = windows(d.matches);
  if (!ws.length) throw new IntlError(`no friendlies since ${WINDOWS_FROM} in ${URL}`);
  return {
    league: KEY, kind: 'intl', name: INFO.name, roundWord: INFO.roundWord, season: `data to ${T.monDay(d.latest)}, ${d.latest.slice(0, 4)}`,
    rounds: ws.map((w) => ({
      n: w.n, played: w.games.length, total: w.games.length, from: w.from, to: w.to, range: T.rangeLabel(w.from, w.to),
    })),
    defaultRound: ws[ws.length - 1].n, maxRound: 0, updated: d.latest,
  };
}

// Penalty split over a sample of matches from one team's side. Friendlies have no goal-by-goal
// record, so the split uses the itemised games only (n of `of`), and needs at least MIN_ITEMISED.
const MIN_ITEMISED = 5;
function penSplit(sample, team, log, field, label) {
  if (!sample.length) return null;
  const it = sample.filter((x) => x.hp != null && x.ap != null);
  const miss = sample.length - it.length;
  if (it.length < MIN_ITEMISED) {
    log.cell(field, `fewer than ${MIN_ITEMISED} of the last ${sample.length} games have a goal-by-goal record (friendlies are not itemised)`, label);
    return null;
  }
  if (miss) log.cell(field, `split over the ${it.length} itemised games of the last ${sample.length} (friendlies are not itemised)`, label);
  let gf = 0; let ga = 0; let pf = 0; let pa = 0;
  for (const x of it) {
    const home = x.home === team;
    gf += home ? x.hg : x.ag; ga += home ? x.ag : x.hg;
    pf += home ? x.hp : x.ap; pa += home ? x.ap : x.hp;
  }
  return { pf, pa, npgfg: (gf - pf) / it.length, npgag: (ga - pa) / it.length, n: it.length, of: sample.length };
}

function persp(m, team) {
  const [gf, ga] = m.home === team ? [m.hg, m.ag] : [m.ag, m.hg];
  return [gf > ga ? 'W' : gf === ga ? 'D' : 'L', gf, ga];
}

async function build(n, fetcher, log, nowMs = Date.now()) {
  const d = await load(fetcher);
  const ws = windows(d.matches);
  const w = ws.find((x) => x.n === n);
  if (!w) throw new IntlError(`Window ${n} not found — ${ws.length} windows since ${WINDOWS_FROM}`);
  const today = T.localDate(nowMs, 'America/Los_Angeles');
  log.note(`Window ${n}: ${w.games.length} friendlies ${T.rangeLabel(w.from, w.to)} (a window = friendly dates with gaps ≤ ${WINDOW_GAP} days)`);
  log.cell('TIME', 'results.csv has no kickoff times');
  log.cell('WEATHER', 'no kickoff time to take a forecast at (CLAUDE.md rule 7)');
  log.cell('IMPORTANCE', 'no importance model for friendlies yet');
  log.cell('INJURED / SUSP.', 'no injuries & suspensions source for friendlies');

  const fixtures = w.games.map((m) => {
    const label = `${m.home} v ${m.away}`;
    const h2hAll = (d.byTeam.get(m.home) || []).filter((x) => x.date < m.date
      && ((x.home === m.home && x.away === m.away) || (x.home === m.away && x.away === m.home)));
    const h2hLast = h2hAll.slice(-5).reverse();
    if (h2hLast.length < 5) log.cell('H2H LAST 5', `only ${h2hLast.length} earlier meeting(s) in the dataset`, label);

    const teams = [[m.home, m.neutral ? 'N' : 'H'], [m.away, m.neutral ? 'N' : 'A']].map(([team, ha]) => {
      const prior = (d.byTeam.get(team) || []).filter((x) => x.date < m.date);
      // LAST 10, with penalty goals where the game has a goal-by-goal record (friendlies don't)
      const form = prior.slice(-10).reverse().map((x) => formGame(x, team, { comp: x.comp }));
      if (form.length < 10) log.cell('LAST 10', 'fewer than 10 earlier internationals in the dataset', team);
      const last10 = prior.slice(-10);
      const g10 = last10.reduce((a, x) => { const [, gf, ga] = persp(x, team); return [a[0] + gf, a[1] + ga]; }, [0, 0]);
      const yr = prior.filter((x) => T.diffDays(m.date, x.date) <= 365);
      const rec = [0, 0, 0];
      for (const x of yr) rec['WDL'.indexOf(persp(x, team)[0])] += 1;

      const h2hGames = h2hLast.map((x) => formGame(x, team, { season: x.comp }));
      const [o, gf, ga] = persp(m, team);
      return {
        team, ha, absent: null, last5: form,
        gfg: last10.length ? g10[0] / last10.length : null,
        gag: last10.length ? g10[1] / last10.length : null,
        n10: last10.length,
        pen: penSplit(last10, team, log, 'GF/G GA/G excl. pens', team),
        rec12: yr.length ? rec.join('-') : '—',
        h2h: { games: h2hGames, gf: h2hGames.reduce((a, g) => a + g.gf, 0), ga: h2hGames.reduce((a, g) => a + g.ga, 0) },
        res: { kind: 'ft', text: `${o} ${gf}-${ga}`, outcome: o },
      };
    });
    return {
      day: T.weekday(m.date), date: T.monDay(m.date), time: '—',
      venue: [m.city, m.country].filter(Boolean).join(', ') || '—', neutral: m.neutral, done: true, teams,
    };
  });

  return {
    kind: 'intl', league: KEY, round: n,
    title: `International friendlies — Window ${n}  ·  ${T.rangeLabel(w.from, w.to)}`,
    sub: `${w.games.length} friendlies · all played · results to ${T.monDay(d.latest)}, ${d.latest.slice(0, 4)} · N = neutral venue`,
    foot1: 'H2H LAST 5 and LAST 10 each show the games, W-D-L, GF-GA (np line underneath) and 0 G / 1 G / 2 G / 3+ G = in how many of those games the club scored 0, 1, 2, 3+ goals (e.g. 4/10), 0 GA … 3+ GA = in how many it conceded 0, 1, 2, 3+  ·  LAST 10 = last 10 internationals before the match, any competition, newest first; GF-GA = goals over those games, with a small np line underneath: penalty goals excluded, then penalties scored-conceded ((7/10) = only 7 games have a penalty record) (friendlies have no goal-by-goal record)  ·  GF/G, GA/G = goals per game over the last 10 internationals (np = excluding penalties, over the games with goal-by-goal records, e.g. 7/10)  ·  '
      + '12-MO W-D-L = record in the 365 days before  ·  H2H LAST 5 = last five meetings, any competition, newest first; GF-GA = goals over those games',
    foot2: 'Source: martj42/international_results (GitHub) — men\'s full internationals, played matches only; upcoming windows appear once played.  '
      + 'TIME / WEATHER / IMPORTANCE — (no kickoff times in the source).',
    fixtures,
    header: `Run log — International friendlies, Window ${n}`,
  };
}

module.exports = { KEY, INFO, IntlError, listWindows, build, load, penSplit, parseCsv, URL };
