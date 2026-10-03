'use strict';
// UEFA Nations League, League A: one chart per matchday.
//
// Sources (UEFA's own feeds, the fixture authority for this competition):
//   match.uefa.com/v5/matches?competitionId=2014&seasonYear=E   fixtures, results, kickoff, stadium coords,
//                                                              and the labels "Group A1" / "Matchday N"
//   standings.uefa.com/v1/standings?competitionId=2014&seasonYear=E   group tables (NOW and past editions)
// Editions are biennial and named by the year they end (2026-27 = 2027). History columns are the
// four previous editions. Form, LAST, GF/G and H2H use every international: the
// martj42/international_results dataset plus this edition's UEFA results (the dataset lags).

const fs = require('fs');
const path = require('path');
const F = require('./fetch');
const T = require('./time');
const model = require('./model');
const intl = require('./intl');

const KEY = 'nations';
const COMP = 2014;
const LEAGUE = 'A';
const GROUPS = 4;
const PER_MD = 8;
const MDS = 6;
const LA = 'America/Los_Angeles';
const TTL_CUR = 6;
const TTL_PAST = 24 * 30;
const INFO = { key: KEY, name: 'UEFA Nations League (League A)', roundWord: 'Matchday' };
const L = { name: INFO.name, tz: 'auto', odds: 'soccer_uefa_nations_league' };

const lab = (e) => `'${String(e).slice(2)}`;
const nm = (t) => t.internationalName.normalize('NFC').replace(/̇/g, '');
const groupOf = (m) => ((m.group && m.group.metaData && m.group.metaData.groupName) || '').replace(/^Group\s+/, '');

function loadJson(name, fallback) {
  const p = path.join(F.ROOT, 'data', name);
  if (!fs.existsSync(p)) return fallback;
  return JSON.parse(fs.readFileSync(p, 'utf8').replace(/^﻿/, ''));
}

// Edition running (or last run) on a given date: Sep 2026 – Jun 2027 is 2027.
function currentEdition(today) {
  const y = +today.slice(0, 4) - (+today.slice(5, 7) >= 7 ? 0 : 1);
  return (y + 1) % 2 ? y + 1 : y;
}

async function loadMatches(fetcher, e, ttl) {
  const out = [];
  for (let off = 0; off < 1000; off += 100) {
    const url = `https://match.uefa.com/v5/matches?competitionId=${COMP}&seasonYear=${e}&limit=100&offset=${off}&order=ASC`;
    const page = await fetcher.getJson(url, ttl);
    if (!Array.isArray(page)) return off ? out : null;
    for (const m of page) {
      if (m.type !== 'GROUP_STAGE' || !m.homeTeam || !m.awayTeam) continue;
      const kick = m.kickOffTime || {};
      const ms = kick.dateTime ? Date.parse(kick.dateTime) : null;
      const off2 = typeof kick.utcOffsetInHours === 'number' ? kick.utcOffsetInHours : null;
      const local = ms != null && off2 != null ? new Date(ms + off2 * 3600000) : null;
      const total = (m.score && m.score.total) || {};
      const done = m.status === 'FINISHED' && total.home != null && total.away != null;
      const st = m.stadium || {};
      const geo = st.geolocation || {};
      out.push({
        id: m.id, group: groupOf(m), md: m.matchday ? +m.matchday.sequenceNumber : null, mdLabel: m.matchday && m.matchday.longName,
        home: nm(m.homeTeam), away: nm(m.awayTeam), hg: done ? total.home : null, ag: done ? total.away : null, done, status: m.status,
        et: ms, date: local ? local.toISOString().slice(0, 10) : kick.date || null, hourLocal: local ? local.getUTCHours() : null,
        city: st.city && st.city.translations && st.city.translations.name ? st.city.translations.name.EN : null,
        lat: geo.latitude, lon: geo.longitude,
      });
    }
    if (page.length < 100) break;
  }
  return out;
}

async function loadStandings(fetcher, e, ttl) {
  const url = `https://standings.uefa.com/v1/standings?competitionId=${COMP}&seasonYear=${e}`;
  const d = await fetcher.getJson(url, ttl);
  if (!Array.isArray(d)) return null;
  const byTeam = new Map();
  for (const g of d) {
    const group = ((g.group && g.group.metaData && g.group.metaData.groupName) || '').replace(/^Group\s+/, '');
    for (const r of g.items || []) {
      byTeam.set(nm(r.team), { group, rank: r.rank, P: r.played, W: r.won, D: r.drawn, L: r.lost, GF: r.goalsFor, GA: r.goalsAgainst, Pts: r.points });
    }
  }
  return byTeam;
}

async function listRounds(fetcher, nowMs = Date.now()) {
  const e = currentEdition(T.localDate(nowMs, LA));
  const ms = await loadMatches(fetcher, e, TTL_CUR);
  if (!ms) throw new model.ChartError(`UEFA match feed unavailable for the ${e - 1}-${String(e).slice(2)} edition`);
  const la = ms.filter((m) => m.group.startsWith(LEAGUE));
  const rounds = [];
  for (let n = 1; n <= MDS; n++) {
    const g = la.filter((m) => m.md === n);
    const ds = g.map((m) => (m.et != null ? T.localDate(m.et, LA) : m.date)).filter(Boolean).sort();
    rounds.push({ n, played: g.filter((m) => m.done).length, total: g.length, from: ds[0] || null, to: ds[ds.length - 1] || null, range: T.rangeLabel(ds[0], ds[ds.length - 1]) });
  }
  const current = rounds.find((r) => r.played < r.total) || rounds[rounds.length - 1];
  return {
    league: KEY, name: INFO.name, roundWord: INFO.roundWord, season: `${e - 1}-${String(e).slice(2)}`, rounds,
    defaultRound: current.n, maxRound: MDS,
  };
}

function persp(m, team) {
  const [gf, ga] = m.home === team ? [m.hg, m.ag] : [m.ag, m.hg];
  return [gf > ga ? 'W' : gf === ga ? 'D' : 'L', gf, ga];
}

function rankStr(row) {
  if (!row || !row.group) return '—';
  return row.group.startsWith(LEAGUE) ? String(row.rank) : `${row.group[0]}·${row.rank}`;
}

// Group table before a fixture, from this edition's results (points, GD, GF — UEFA's head-to-head
// tiebreakers are not applied, so this only feeds the IMPORTANCE wording).
function preTable(cur, group, before) {
  const t = new Map();
  for (const m of cur) {
    if (m.group !== group) continue;
    for (const c of [m.home, m.away]) if (!t.has(c)) t.set(c, { P: 0, Pts: 0, GD: 0, GF: 0 });
    if (!m.done || !(m.date < before)) continue;
    for (const c of [m.home, m.away]) {
      const [o, gf, ga] = persp(m, c);
      const r = t.get(c);
      r.P += 1; r.Pts += { W: 3, D: 1, L: 0 }[o]; r.GD += gf - ga; r.GF += gf;
    }
  }
  const order = [...t.entries()].sort(([p, P], [q, Q]) => (Q.Pts - P.Pts) || (Q.GD - P.GD) || (Q.GF - P.GF) || (p < q ? -1 : 1));
  order.forEach(([, r], i) => { r.rank = i + 1; });
  return t;
}

function importanceNL(f, pre, closest) {
  const h = pre.get(f.home);
  const a = pre.get(f.away);
  if (!h || !a || !h.P || !a.P) {
    if (closest) return ['modhi', `Closest odds: ${model.fmt0(f.winH)}% v ${model.fmt0(f.winA)}%`];
    return ['mod', `Group ${f.group} opener`];
  }
  const tag = `${model.ordinal(h.rank)} v ${model.ordinal(a.rank)}`;
  if (h.rank <= 2 && a.rank <= 2) return ['high', `Group ${f.group} top-two clash: ${tag}`];
  if (h.rank >= 3 && a.rank >= 3) return ['modhi', `Relegation fight, ${f.group}: ${tag}`];
  if (closest) return ['modhi', `Closest odds: ${model.fmt0(f.winH)}% v ${model.fmt0(f.winA)}%`];
  return ['mod', `Group ${f.group}: ${tag}`];
}

async function build(n, histRound, fetcher, log, nowMs = Date.now()) {
  if (!(n >= 1 && n <= MDS)) throw new model.ChartError(`Matchday must be 1–${MDS}`);
  const today = T.localDate(nowMs, LA);
  const e = currentEdition(today);
  const edLabel = `${e - 1}-${String(e).slice(2)}`;
  const histN = histRound || n;
  const aliases = loadJson('aliases.json', {});
  const canon = (x) => aliases[x] || x;

  // ---- this edition: fixtures (authority) + live tables
  const cur = await loadMatches(fetcher, e, TTL_CUR);
  if (!cur) throw new model.ChartError(`UEFA match feed unavailable for the ${edLabel} edition`);
  const fixtures = cur.filter((m) => m.group.startsWith(LEAGUE) && m.md === n);
  const seen = fixtures.flatMap((m) => [m.home, m.away]);
  const perGroup = new Map();
  for (const m of fixtures) perGroup.set(m.group, (perGroup.get(m.group) || 0) + 1);
  const problems = [];
  if (fixtures.length !== PER_MD) problems.push(`${fixtures.length} fixtures (expected ${PER_MD})`);
  if (new Set(seen).size !== seen.length) problems.push('a nation appears twice');
  if (perGroup.size !== GROUPS || [...perGroup.values()].some((c) => c !== 2)) problems.push(`group split ${JSON.stringify([...perGroup])} (expected 2 per group)`);
  if (problems.length) throw new model.ChartError(`Matchday ${n} failed validation: ${problems.join('; ')}`);
  log.note(`Matchday ${n}: ${fixtures.length} fixtures in ${GROUPS} League ${LEAGUE} groups, each nation once (UEFA 'Matchday ${n}' label)`);
  const nowTab = (await loadStandings(fetcher, e, TTL_CUR)) || new Map();
  if (!nowTab.size) log.warn('UEFA standings unavailable — NOW columns are —');

  // ---- past editions
  const past = [e - 8, e - 6, e - 4, e - 2];
  const pastM = await Promise.all(past.map((p) => loadMatches(fetcher, p, TTL_PAST)));
  const pastS = await Promise.all(past.slice(1).map((p) => loadStandings(fetcher, p, TTL_PAST)));

  // ---- every international: dataset + this edition's UEFA results (dataset lags)
  let ds;
  try {
    ds = await intl.load(fetcher);
  } catch (err) {
    log.warn(`international results unavailable (${err.message}) — FORM/LAST/GF/G/H2H are —`);
    ds = { matches: [] };
  }
  const all = ds.matches.filter((m) => m.hg != null).map((m) => ({ ...m, home: canon(m.home), away: canon(m.away) }));
  const keyOf = (m) => `${m.date}|${[m.home, m.away].sort().join('|')}`;
  const have = new Set(all.map(keyOf));
  for (const m of cur) if (m.done && !have.has(keyOf(m))) all.push({ ...m, comp: 'UEFA Nations League' });
  all.sort((p, q) => (p.date < q.date ? -1 : p.date > q.date ? 1 : 0));
  const byTeam = new Map();
  for (const m of all) for (const t of [m.home, m.away]) { if (!byTeam.has(t)) byTeam.set(t, []); byTeam.get(t).push(m); }

  // ---- odds, stars
  const odds = await model.loadOdds(fetcher, L, { canon }, log);
  const stars = Object.fromEntries(Object.entries(loadJson('stars.json', {})).filter(([k]) => !k.startsWith('_')));

  const fx = fixtures.map((m) => {
    let winH = null;
    let winA = null;
    if (!m.done && odds) {
      const ev = odds.find((o) => o.home === m.home && o.away === m.away && (m.date == null || Math.abs(T.diffDays(o.date, m.date)) <= 3));
      if (ev) { winH = ev.h; winA = ev.a; } else log.cell('WIN%', 'no h2h market on The Odds API yet', `${m.home} v ${m.away}`);
    } else if (!m.done) log.cell('WIN%', 'ODDS_API_KEY not set', `${m.home} v ${m.away}`);
    return { ...m, winH, winA };
  });
  const open = fx.filter((f) => f.winH != null && f.winA != null);
  const closestGap = open.length ? Math.min(...open.map((f) => Math.abs(f.winH - f.winA))) : null;

  const out = [];
  for (const f of fx) {
    const label = `${f.home} v ${f.away}`;
    const before = f.date || '9999';
    const prior = (t) => (byTeam.get(t) || []).filter((x) => x.date < before);

    const showDate = f.et != null ? T.localDate(f.et, LA) : f.date;
    const time = f.et != null ? T.fmtTime(f.et, LA) : '—';
    if (f.et == null) log.cell('TIME', 'UEFA feed has no kickoff time', label);

    let wx = ['—', f.city || '—', 'tbc'];
    if (f.lat != null && f.lon != null && f.date) {
      wx = await model.weather(f.date, f.hourLocal != null ? f.et : null, { lat: f.lat, lon: f.lon, city: f.city || '' }, L, fetcher, today, log, label, f.hourLocal);
    } else log.cell('WEATHER', 'UEFA feed has no stadium coordinates', label);

    const closest = closestGap != null && f.winH != null && Math.abs(Math.abs(f.winH - f.winA) - closestGap) < 1e-9;
    const imp = importanceNL(f, preTable(cur, f.group, f.date || '9999'), closest);

    const h2hAll = prior(f.home).filter((x) => (x.home === f.away || x.away === f.away));
    const meetings = h2hAll.slice(-5).reverse();
    if (meetings.length < 5) log.cell('H2H LAST 5', `only ${meetings.length} earlier meeting(s) in the international results`, label);

    const teams = [[f.home, 'H', f.winH], [f.away, 'A', f.winA]].map(([team, ha, win]) => {
      const s = stars[team];
      let star = '—';
      let status = '—';
      if (s) {
        star = s.star || '—';
        status = s.status || 'exp.';
        if (['fit', 'eased', 'out'].includes(status)) {
          const age = /^\d{4}-\d{2}-\d{2}$/.test(s.as_of || '') ? T.diffDays(today, s.as_of) : null;
          if (age == null || !(age >= 0 && age <= 3)) status = 'exp.';
        }
        if (!['fit', 'exp.', 'eased', 'out', '—'].includes(status)) status = '—';
      } else log.cell('STAR/STATUS', 'nation not in data/stars.json', team);

      const standing = [...pastS.map((t, i) => {
        if (!t) { log.cell(`STANDING ${lab(past[i + 1])}`, 'UEFA standings for that edition unavailable', team); return '—'; }
        return rankStr(t.get(team));
      }), nowTab.get(team) && nowTab.get(team).P ? String(nowTab.get(team).rank) : '—'];

      const pr = prior(team);
      const last10 = pr.slice(-10);
      let gfg = null; let gag = null; let ratio = null; let total = null;
      if (last10.length) {
        const [gf, ga] = last10.reduce((a, x) => { const [, p, q] = persp(x, team); return [a[0] + p, a[1] + q]; }, [0, 0]);
        gfg = gf / last10.length; gag = ga / last10.length; ratio = ga ? gf / ga : null; total = (gf + ga) / last10.length;
      } else log.cell('GF/G GA/G GF/GA TOT/G', 'no earlier internationals', team);
      const lx = pr[pr.length - 1];
      const lr = lx ? persp(lx, team) : null;

      const hist = past.map((p, i) => {
        const ms = pastM[i];
        if (!ms) { log.cell(`MATCH-${histN} HIST ${lab(p)}`, 'UEFA feed for that edition unavailable', team); return '—'; }
        const mine = ms.filter((x) => x.home === team || x.away === team);
        if (!mine.length) { log.cell(`MATCH-${histN} HIST ${lab(p)}`, 'nation not in that edition', team); return 'new'; }
        const mm = mine.find((x) => x.md === histN);
        if (!mm) { log.cell(`MATCH-${histN} HIST ${lab(p)}`, `no Matchday ${histN} in its group that edition`, team); return '—'; }
        return mm.done ? persp(mm, team)[0] : '—';
      });

      const records = past.map((p, i) => {
        const ms = pastM[i];
        if (!ms) return '—';
        const mine = ms.filter((x) => x.done && (x.home === team || x.away === team));
        if (!mine.length) return 'new';
        const r = [0, 0, 0];
        for (const x of mine) r['WDL'.indexOf(persp(x, team)[0])] += 1;
        return r.join('-');
      });
      const nowRow = nowTab.get(team);
      const tally = [0, 0, 0];
      for (const x of cur) if (x.done && (x.home === team || x.away === team)) tally['WDL'.indexOf(persp(x, team)[0])] += 1;
      let now = '—';
      if (nowRow) {
        now = `${nowRow.W}-${nowRow.D}-${nowRow.L}`;
        if (nowRow.W !== tally[0] || nowRow.D !== tally[1] || nowRow.L !== tally[2]) {
          log.warn(`NOW record for ${team}: UEFA standings ${now} vs results tally ${tally.join('-')} — standings used (rule 8)`);
        }
      }
      records.push(now);

      const res = f.done
        ? (() => { const [o, gf, ga] = persp(f, team); return { kind: 'ft', text: `${o} ${gf}-${ga}`, outcome: o }; })()
        : { kind: 'wp', pct: win };
      const h2hGames = meetings.map((x) => {
        const [o, gf, ga] = persp(x, team);
        return { o, gf, ga, ha: x.neutral ? 'N' : x.home === team ? 'H' : 'A', season: x.comp || '', date: x.date };
      });
      return {
        ha, team, star, status, standing, gfg, gag, ratio, total,
        last: lr ? `${lr[0]} ${lr[1]}-${lr[2]}` : '—', lastOutcome: lr ? lr[0] : null,
        hist, records, res,
        h2h: { games: h2hGames, gf: h2hGames.reduce((a, g) => a + g.gf, 0), ga: h2hGames.reduce((a, g) => a + g.ga, 0) },
      };
    });

    out.push({
      sortKey: f.et != null ? f.et : Number.MAX_SAFE_INTEGER, home: f.home,
      day: showDate ? T.weekday(showDate) : '—', date: showDate ? T.monDay(showDate) : '—', time,
      wx, imp: [imp[0], imp[1].length > 40 ? `${imp[1].slice(0, 39)}…` : imp[1]], done: f.done, teams, extra: [f.group],
    });
  }
  out.sort((p, q) => (p.sortKey - q.sortKey) || (p.home < q.home ? -1 : 1));
  const ds0 = out.map((x) => x.sortKey).filter((x) => x !== Number.MAX_SAFE_INTEGER);
  const range = ds0.length ? T.rangeLabel(T.localDate(Math.min(...ds0), LA), T.localDate(Math.max(...ds0), LA)) : '';
  const played = fx.filter((f) => f.done).length;

  return {
    league: KEY, round: n, season: edLabel, histRound: histN,
    title: `UEFA Nations League A — Matchday ${n}  ·  ${range}`,
    sub: `${edLabel} edition · ${played === fx.length ? 'all fixtures final' : `${played}/${fx.length} played`} · kickoffs America/Los_Angeles`,
    foot1: "STANDING '21/'23/'25 = group finish that edition (B·2 = League B, 2nd), NOW = live group position  ·  "
      + 'GF/G, GA/G, TOT/G, LAST = last 10 internationals before kickoff, any competition  ·  '
      + `MATCH-${histN} HIST = nation's Matchday ${histN} result that edition  ·  SEASON RECORD = league-phase W-D-L per edition (NOW = UEFA table)  ·  `
      + 'H2H LAST 5 = last five meetings, any competition, newest first  ·  WIN% = odds-implied, overround removed',
    foot2: 'Sources: UEFA match & standings feeds (fixtures, results, kickoffs, venues, tables) · martj42/international_results (form, H2H) · '
      + 'The Odds API · Open-Meteo weather at the stadium, kickoff hour.'
      + `${odds == null ? '  Caveats: WIN% — (no ODDS_API_KEY)' : ''}`,
    fixtures: out.map(({ sortKey, home, ...rest }) => rest),
    standLabels: [...past.slice(1).map(lab), 'NOW'],
    histLabels: past.map(lab), histTitle: `MATCH-${histN} HIST`,
    recLabels: [...past.map(lab), 'NOW'], lastLabel: 'LAST',
    releg: ['4'], top: ['1'], extraLabels: ['GROUP'],
    header: `Run log — ${INFO.name} Matchday ${n} (${edLabel})`,
  };
}

module.exports = { KEY, INFO, MDS, listRounds, build };
