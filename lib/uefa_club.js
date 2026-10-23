'use strict';
// UEFA club competitions with a 36-club league phase (Champions League, Europa League): one chart
// per matchday (8 matchdays, 18 games each). make(cfg) builds the module for one competition;
// lib/ucl.js and lib/uel.js are the configurations.
//
// Sources (UEFA's own feeds, the fixture authority for the competition):
//   match.uefa.com/v5/matches?competitionId=C&seasonYear=S      fixtures, results, kickoffs, stadium
//                                                               coords, "Matchday N" labels, goal events
//   standings.uefa.com/v1/standings?competitionId=C&seasonYear=S  the league-phase table (NOW)
// Seasons are named by the year they end (2026-27 = 2027). Finished seasons come from
// data/<key>/history.json (scripts/build_ucl_history.js <key>): every match and each season's table.
// Form, LAST, GF/G and H2H use the clubs' games in the competition (qualifiers, league/group phase,
// knockouts) — the one source covering all 36 clubs, many of which play in leagues not charted
// here. LAST 20 also mixes in their domestic league games (lib/domestic.js).

const fs = require('fs');
const path = require('path');
const F = require('./fetch');
const T = require('./time');
const model = require('./model');
const intl = require('./intl');
const P = require('./predict');
const M = require('./markets');
const UB = require('./ucl_btts');
const CC = require('./club_context');
const D = require('./domestic');
const { formGame, FORM_GAMES } = require('./form');

// cfg: { comp: UEFA competitionId, key, name, short ('Champions League'), abbr ('UCL'),
//        odds: The Odds API key, sg: SportsGambler slug, tuned: model settings were picked on this
//        competition's seasons (the Europa League reuses the Champions League's) }
function make(cfg) {
  const COMP = cfg.comp;
  const CN = cfg.short;
  const MDS = 8;
  const PER_MD = 18;
  const LA = 'America/Los_Angeles';
  const TTL_CUR = 6;
  const HISTORY_SEASONS = 4;
  const HISTORY_FILE = path.join(F.ROOT, 'data', cfg.key, 'history.json');
  const INFO = { key: cfg.key, name: cfg.name, roundWord: 'Matchday' };
  const L = { name: INFO.name, tz: 'auto', odds: cfg.odds };
  const TOP = 8; // 1–8 straight to the round of 16
  const PLAYOFF = 24; // 9–24 knockout play-offs, 25–36 out

  // MODEL: the league charts' Poisson / Dixon–Coles model (lib/predict.js), rated on Champions League
  // games only — clubs come from different leagues, so their domestic numbers aren't comparable.
  // Qualifiers are left out (thrashings of part-time sides inflate ratings), the prior is the last two
  // seasons pooled, and ratings are shrunk halfway to average: UCL samples are small (6–17 games a
  // season). Settings picked on the 2023-24 / 2024-25 seasons; 2025-26 held out — see backtest().
  const PARAMS = { ...P.PARAMS, K: 4, shrink: 0.5 };
  const TUNE = cfg.tuned ? [2024, 2025] : [];
  const QUAL = /qualifying|preliminary|^play-offs$/i;
  const forModel = (ms) => ms.filter((m) => m.done && !QUAL.test(m.round || '')).map((m) => ({ ...m, market: null }));
  const seasonModelGames = (H, y) => (H.get(y) ? forModel(H.get(y).matches) : []);

  const lab = (e) => `'${String(e).slice(2)}`;
  const nm = (t) => t.internationalName.normalize('NFC');
  const currentSeason = (today) => +today.slice(0, 4) + (+today.slice(5, 7) >= 7 ? 1 : 0);

  // club-name similarity for sources that spell clubs differently (SportsGambler, The Odds API):
  // share of name tokens that prefix-match a token of the other name
  const toks = (x) => x.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9 ]/g, ' ')
    .split(/\s+/).filter((w) => w.length > 2 && !['fc', 'cf', 'ac', 'sc', 'afc', 'club', 'de', 'the'].includes(w));
  function sim(p, q) {
    const a = toks(p);
    const b = toks(q);
    if (!a.length || !b.length) return 0;
    const hit = (x, ys) => ys.some((y) => y.startsWith(x.slice(0, 4)) || x.startsWith(y.slice(0, 4)));
    return (a.filter((x) => hit(x, b)).length + b.filter((y) => hit(y, a)).length) / (a.length + b.length);
  }

  function loadJson(file, fallback) {
    try {
      return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      return fallback;
    }
  }

  // Every match of a season (all rounds). phase = league/group phase; md = matchday within its round.
  async function loadMatches(fetcher, e, ttl) {
    const out = [];
    for (let off = 0; off < 1000; off += 100) {
      const page = await fetcher.getJson(`https://match.uefa.com/v5/matches?competitionId=${COMP}&seasonYear=${e}&limit=100&offset=${off}&order=ASC`, ttl);
      if (!Array.isArray(page)) return off ? out : null;
      for (const m of page) {
        if (!m.homeTeam || !m.awayTeam) continue;
        const kick = m.kickOffTime || {};
        const ms = kick.dateTime ? Date.parse(kick.dateTime) : null;
        const offH = typeof kick.utcOffsetInHours === 'number' ? kick.utcOffsetInHours : null;
        const local = ms != null && offH != null ? new Date(ms + offH * 3600000) : null;
        const total = (m.score && m.score.total) || {};
        const done = m.status === 'FINISHED' && total.home != null && total.away != null;
        const sc = (m.playerEvents && m.playerEvents.scorers) || [];
        const itemised = done && sc.length === total.home + total.away;
        const pens = (id) => sc.filter((g) => g.goalType === 'PENALTY' && String(g.teamId) === String(id)).length;
        const st = m.stadium || {};
        const geo = st.geolocation || {};
        out.push({
          home: nm(m.homeTeam), away: nm(m.awayTeam), hc: m.homeTeam.countryCode || null, ac: m.awayTeam.countryCode || null, hg: done ? total.home : null, ag: done ? total.away : null, done, status: m.status,
          hp: itemised ? pens(m.homeTeam.id) : null, ap: itemised ? pens(m.awayTeam.id) : null,
          phase: m.type === 'GROUP_STAGE', md: m.matchday ? +m.matchday.sequenceNumber : null,
          round: (m.round && m.round.metaData && m.round.metaData.name) || '',
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
    const d = await fetcher.getJson(`https://standings.uefa.com/v1/standings?competitionId=${COMP}&seasonYear=${e}`, ttl);
    if (!Array.isArray(d)) return null;
    const by = new Map();
    for (const g of d) {
      const group = ((g.group && g.group.metaData && g.group.metaData.groupName) || '').replace(/^Group\s+/, '');
      for (const r of g.items || []) by.set(nm(r.team), { group, rank: r.rank, P: r.played, W: r.won, D: r.drawn, L: r.lost });
    }
    return by;
  }

  // Finished seasons from data/ucl/history.json -> { matches, table } per season year
  function history() {
    const h = loadJson(HISTORY_FILE, { seasons: {} });
    const out = new Map();
    for (const [e, s] of Object.entries(h.seasons)) {
      out.set(+e, {
        matches: s.matches.map(([date, home, away, hg, ag, hp, ap, phase, md, round]) => ({ date, home, away, hg, ag, hp, ap, phase: !!phase, md, round, done: true })),
        table: new Map(Object.entries(s.table).map(([t, [group, rank, W, D, Lo]]) => [t, { group, rank, W, D, L: Lo }])),
        countries: new Map(Object.entries(s.countries || {})),
      });
    }
    return out;
  }

  const dayOf = (m) => (m.et != null ? T.localDate(m.et, LA) : m.date);
  const isDone = (m) => m.done;

  async function listRounds(fetcher, nowMs = Date.now()) {
    const e = currentSeason(T.localDate(nowMs, LA));
    const ms = await loadMatches(fetcher, e, TTL_CUR);
    if (!ms) throw new model.ChartError(`UEFA match feed unavailable for ${e - 1}-${String(e).slice(2)}`);
    const lp = ms.filter((m) => m.phase);
    if (!lp.length) throw new model.ChartError(`no league-phase fixtures yet in the ${e - 1}-${String(e).slice(2)} UEFA feed`);
    const rounds = [];
    for (let n = 1; n <= MDS; n++) {
      const g = lp.filter((m) => m.md === n);
      const today = T.localDate(nowMs, LA);
      const sh = model.roundShape(g, dayOf, isDone, today);
      rounds.push({
        n, played: g.filter((m) => m.done).length, total: g.length, open: sh.open, movedOpen: sh.movedOpen, from: sh.from, to: sh.to, range: sh.range,
        next: sh.next(today), catchup: sh.catchup(today),
      });
    }
    // first matchday with unplayed games inside its own dates (a rescheduled game alone doesn't count)
    const current = rounds.find((r) => r.open > 0) || rounds[rounds.length - 1];
    return { league: INFO.key, name: INFO.name, roundWord: INFO.roundWord, season: `${e - 1}-${String(e).slice(2)}`, rounds, defaultRound: current.n, maxRound: MDS, next: T.nextFixture(rounds), catchup: T.nextCatchup(rounds) };
  }

  function persp(m, team) {
    const [gf, ga] = m.home === team ? [m.hg, m.ag] : [m.ag, m.hg];
    return [gf > ga ? 'W' : gf === ga ? 'D' : 'L', gf, ga];
  }

  // league-phase table before a fixture from this season's results (points, GD, GF; UEFA's other
  // tiebreakers not applied — this only feeds the IMPORTANCE wording)
  function preTable(cur, before) {
    const t = new Map();
    for (const m of cur) {
      if (!m.phase) continue;
      for (const c of [m.home, m.away]) if (!t.has(c)) t.set(c, { P: 0, Pts: 0, GD: 0, GF: 0 });
      if (!m.done || !(m.date < before)) continue;
      for (const c of [m.home, m.away]) {
        const [o, gf, ga] = persp(m, c);
        const r = t.get(c);
        r.P += 1; r.Pts += { W: 3, D: 1, L: 0 }[o]; r.GD += gf - ga; r.GF += gf;
      }
    }
    [...t.entries()].sort(([p, P], [q, Q]) => (Q.Pts - P.Pts) || (Q.GD - P.GD) || (Q.GF - P.GF) || (p < q ? -1 : 1))
      .forEach(([, r], i) => { r.rank = i + 1; });
    return t;
  }

  function importanceUCL(f, pre, closest) {
    const h = pre.get(f.home);
    const a = pre.get(f.away);
    if (!h || !a || (!h.P && !a.P)) {
      if (closest) return ['modhi', `Closest odds: ${model.fmt0(f.winH)}% v ${model.fmt0(f.winA)}%`];
      return ['mod', 'League phase opener'];
    }
    const tag = `${model.ordinal(h.rank)} v ${model.ordinal(a.rank)}`;
    if (h.rank <= TOP && a.rank <= TOP) return ['high', `Top-8 clash: ${tag}`];
    const near = (r, line) => Math.abs(r - line) <= 4;
    if (near(h.rank, TOP) && near(a.rank, TOP)) return ['modhi', `Top-8 race: ${tag}`];
    if (near(h.rank, PLAYOFF) && near(a.rank, PLAYOFF)) return ['modhi', `Play-off line (24th): ${tag}`];
    if (closest) return ['modhi', `Closest odds: ${model.fmt0(f.winH)}% v ${model.fmt0(f.winA)}%`];
    return ['mod', `League phase: ${tag}`];
  }

  // SportsGambler names clubs its own way ("Bayern Munich" v UEFA "Bayern München"): map each
  // club in the round to its best-matching team on the injuries page
  // UEFA short names fuzzy matching can't reach
  // market venues' club names -> UEFA's, where token matching can't bridge them
  const MK_ALIAS = {
    'Paris Saint-Germain': 'Paris', 'Paris Saint Germain': 'Paris', PSG: 'Paris', 'Atlético Madrid': 'Atleti', 'Atletico Madrid': 'Atleti',
    'Club Atlético de Madrid': 'Atleti', 'Atlético de Madrid': 'Atleti', 'Manchester United': 'Man Utd', 'Manchester City': 'Man City',
    'Borussia Dortmund': 'B. Dortmund', 'Shakhtar Donetsk': 'Shakhtar', 'Slovan Bratislava': 'S. Bratislava', 'Slavia Prague': 'Slavia Praha',
    Eindhoven: 'PSV', 'PSV Eindhoven': 'PSV',
    'Stade Rennais': 'Rennes', 'Stade Rennais FC 1901': 'Rennes', 'Sparta Prague': 'Sparta Praha', Lillestroem: 'Lillestrøm',
    Nijmegen: 'N.E.C.', NEC: 'N.E.C.', 'Dinamo Zagreb': 'GNK Dinamo', 'GNK Dinamo Zagreb': 'GNK Dinamo',
    "MH Hapoel Be'er Sheva": 'H. Beer-Sheva', 'Be`er Sheva': 'H. Beer-Sheva', 'RU Saint-Gilloise': 'Union SG', 'Union Gilloise': 'Union SG',
    'AS Omónoia Leukosías': 'Omonia', 'Omonia Nicosia': 'Omonia', 'Olympiakós SFP': 'Olympiacos', AZ: 'AZ Alkmaar', Alkmaar: 'AZ Alkmaar',
  };
  // venue name -> the round's UEFA club: alias, else the one club whose name words all appear in the
  // venue's name or vice versa ("LASK Linz" -> LASK, "AEK" -> AEK Athens, "Racing Club de Lens" -> Lens)
  function marketCanon(clubs) {
    const sub = (p, q) => p.length && p.every((w) => q.includes(w));
    return (raw) => {
      if (MK_ALIAS[raw]) return MK_ALIAS[raw];
      const r = toks(raw);
      const hits = clubs.filter((c) => sub(toks(c), r) || sub(r, toks(c)));
      return hits.length === 1 ? hits[0] : raw;
    };
  }
  const SG_ALIAS = {
    'Man Utd': 'Man United', Paris: 'PSG', Atleti: 'Atlético Madrid', Shakhtar: 'Sh. Donetsk', 'N.E.C.': 'NEC Nijmegen', 'H. Beer-Sheva': "Hapoel Be'er-Sheva",
  };
  function remapAbsences(abs, clubs) {
    if (!abs) return null;
    const by = new Map();
    for (const c of clubs) {
      const exact = abs.by.get(SG_ALIAS[c] || c);
      if (exact) { by.set(c, exact); continue; }
      let best = null;
      for (const [name, list] of abs.by) {
        const s = sim(name, c);
        if (s >= 0.5 && (!best || s > best.s)) best = { s, list };
      }
      if (best) by.set(c, best.list);
    }
    return { ...abs, by };
  }

  // Every finished UCL season (and this one so far): league/group-phase games predicted from games on
  // earlier dates only, prior = the two seasons before. No bookmaker closing odds for the UCL in the
  // backtest source, so "odds" is — and the model is compared with the base rate.
  function backtest(H, e, curGames) {
    const seasons = [];
    for (let y = e - HISTORY_SEASONS + 1; y <= e; y++) {
      const games = y === e ? curGames : seasonModelGames(H, y);
      const prior = [...seasonModelGames(H, y - 2), ...seasonModelGames(H, y - 1)];
      if (!prior.length || !games.some((g) => g.phase)) continue;
      seasons.push({
        season: `${y - 1}-${String(y).slice(2)}`, role: TUNE.includes(y) ? 'tuning' : y === e ? 'test (so far)' : 'test',
        ...P.score(prior, games, PARAMS, (g) => g.phase),
      });
    }
    return {
      league: INFO.key, params: PARAMS, seasons,
      tuneSeasons: cfg.tuned ? TUNE.map((y) => `${y - 1}-${String(y).slice(2)}`) : ['Champions League 2023-24', '2024-25'],
      source: `UEFA match feeds (league/group-phase games scored; qualifiers excluded from ratings; no closing odds for the ${cfg.abbr}, so "odds" is —)`
        + (cfg.tuned ? '' : '; settings were chosen on Champions League seasons, so every Europa League season here is a test'),
    };
  }

  async function build(n, histRound, fetcher, log, nowMs = Date.now()) {
    if (!(n >= 1 && n <= MDS)) throw new model.ChartError(`Matchday must be 1–${MDS}`);
    const today = T.localDate(nowMs, LA);
    const e = currentSeason(today);
    const sLabel = `${e - 1}-${String(e).slice(2)}`;
    const histN = histRound || n;

    // ---- this season: fixtures (authority) + live table
    const cur = await loadMatches(fetcher, e, TTL_CUR);
    if (!cur) throw new model.ChartError(`UEFA match feed unavailable for ${sLabel}`);
    const fixtures = cur.filter((m) => m.phase && m.md === n);
    const shape = model.roundShape(fixtures, dayOf, isDone, today);
    const seen = fixtures.flatMap((m) => [m.home, m.away]);
    const problems = [];
    if (fixtures.length !== PER_MD) problems.push(`${fixtures.length} fixtures (expected ${PER_MD})`);
    if (new Set(seen).size !== seen.length) problems.push('a club appears twice');
    if (problems.length) throw new model.ChartError(`Matchday ${n} failed validation: ${problems.join('; ')}`);
    log.note(`Matchday ${n}: ${fixtures.length} fixtures, ${seen.length} clubs, each once (UEFA 'Matchday ${n}' league-phase label)`);
    const nowTab = (await loadStandings(fetcher, e, TTL_CUR)) || new Map();
    if (!nowTab.size) log.warn('UEFA standings unavailable — NOW columns are —');

    // ---- finished seasons (stored) + this season's results: every UCL match, oldest first
    const H = history();
    const past = [e - 4, e - 3, e - 2, e - 1];
    for (const p of past) if (!H.has(p)) log.warn(`UCL ${p - 1}-${String(p).slice(2)} not in data/ucl/history.json — run scripts/build_ucl_history.js`);
    const all = [...past.flatMap((p) => (H.get(p) ? H.get(p).matches : [])), ...cur.filter((m) => m.done)]
      .sort((p, q) => (p.date < q.date ? -1 : p.date > q.date ? 1 : 0));
    const byTeam = new Map();
    for (const m of all) for (const t of [m.home, m.away]) { if (!byTeam.has(t)) byTeam.set(t, []); byTeam.get(t).push(m); }

    // ---- MODEL: ratings from the last two seasons + this season's games before kickoff
    const curModel = forModel(cur).sort((p, q) => (p.date < q.date ? -1 : p.date > q.date ? 1 : 0));
    const priorGames = [...seasonModelGames(H, e - 2), ...seasonModelGames(H, e - 1)];
    const priorTally = priorGames.length ? P.tally(priorGames) : null;
    if (!priorTally) log.warn('no stored UCL seasons — MODEL column is —');
    const unitemised = curModel.filter((g) => g.hp == null).length;
    if (unitemised) log.cell('MODEL', `${unitemised} match(es) this season have no goal-by-goal record — counted with all goals`);
    const bt = backtest(H, e, curModel);

    // ---- odds, absences
    const odds = await model.loadOdds(fetcher, L, { canon: (x) => x }, log);
    const abs = remapAbsences(await model.loadAbsences(fetcher, cfg.sg, (x) => x, today, log), seen);

    // DOMESTIC: league position (ESPN) and the country's UEFA coefficient rank
    const clubCC = new Map(fixtures.flatMap((m) => [[m.home, m.hc], [m.away, m.ac]]));
    const ctx = await CC.load(fetcher, clubCC, e, log);
    // domestic league games for LAST 20 (football-data.co.uk; clubs from uncovered countries: UCL only)
    const domForm = await D.forClubs(fetcher, clubCC, T.addDays(today, -540), today);
    for (const [c, why] of domForm.missing) log.cell('LAST 20', `${CN} games only (${why})`, c);
    const ord = (n) => model.ordinal(n);
    const domesticCells = (team) => {
      const c = ctx.get(team) || {};
      const p = c.pos;
      const u = c.uefa;
      return [
        p ? { text: `${ord(p.rank)}/${p.of}`, title: `${p.league}: ${ord(p.rank)} of ${p.of}, ${p.played} played, ${p.pts} pts (ESPN)`, tone: p.rank === 1 ? 'good' : p.rank > p.of - 3 ? 'bad' : '' }
          : { text: '—', title: `no live league table for ${c.cc || 'this country'}` },
        u ? { text: `${u.rank} ${c.cc}`, title: `${u.name}: ${ord(u.rank)} of ${u.of} in UEFA's association coefficient ranking (${u.pts} pts)`, tone: u.rank <= 4 ? 'good' : '' }
          : { text: '—', title: 'no UEFA coefficient for this country' },
      ];
    };

    const fx = fixtures.map((m) => {
      let winH = null;
      let winA = null;
      if (!m.done && odds) {
        const ev = odds.find((o) => sim(o.home, m.home) >= 0.5 && sim(o.away, m.away) >= 0.5 && (m.date == null || Math.abs(T.diffDays(o.date, m.date)) <= 3));
        if (ev) { winH = ev.h; winA = ev.a; } else log.cell('WIN%', 'no h2h market on The Odds API yet', `${m.home} v ${m.away}`);
      } else if (!m.done) log.cell('WIN%', 'ODDS_API_KEY not set', `${m.home} v ${m.away}`);
      return { ...m, winH, winA };
    });
    const open = fx.filter((f) => f.winH != null && f.winA != null);
    const closestGap = open.length ? Math.min(...open.map((f) => Math.abs(f.winH - f.winA))) : null;

    // weather (sequential: Open-Meteo throttles bursts)
    const wxs = [];
    for (const f of fx) {
      const label = `${f.home} v ${f.away}`;
      let wx = ['—', f.city || '—', 'tbc'];
      if (f.lat != null && f.lon != null && f.date) {
        wx = await model.weather(f.date, f.hourLocal != null ? f.et : null, { lat: f.lat, lon: f.lon, city: f.city || '' }, L, fetcher, today, log, label, f.hourLocal);
      } else log.cell('WEATHER', 'UEFA feed has no stadium coordinates', label);
      wxs.push(wx);
    }

    // KALSHI / POLYMARKET: live quote before kickoff, last quote before kickoff once started
    let mk = { kalshi: new Map(), poly: new Map() };
    try {
      mk = await M.loadRound(fetcher, INFO.key, fx.map((f) => ({ label: `${f.home} v ${f.away}`, home: f.home, away: f.away, ko: f.et })),
        marketCanon(seen), nowMs, log);
    } catch (err) {
      log.warn(`prediction markets unavailable (${err.message})`);
    }

    const bttsFx = [];
    const out = fx.map((f, i) => {
      const label = `${f.home} v ${f.away}`;
      let pred = null;
      if (priorTally) {
        pred = P.predict(P.strengths(priorTally, P.tally(curModel.filter((x) => x.date < (f.date || '9999'))), PARAMS), f.home, f.away, PARAMS);
        if (f.done) pred.outcome = f.hg > f.ag ? 'H' : f.hg === f.ag ? 'D' : 'A';
      }
      bttsFx.push({ label, home: f.home, away: f.away, date: f.date, pred, result: f.done ? { hg: f.hg, ag: f.ag } : null, moved: shape.note(fixtures[i]) });
      const before = f.date || '9999';
      const prior = (t) => (byTeam.get(t) || []).filter((x) => x.date < before);
      const showDate = f.et != null ? T.localDate(f.et, LA) : f.date;
      const time = f.et != null ? T.fmtTime(f.et, LA) : '—';
      if (f.et == null) log.cell('TIME', 'UEFA feed has no kickoff time', label);
      const closest = closestGap != null && f.winH != null && Math.abs(Math.abs(f.winH - f.winA) - closestGap) < 1e-9;
      const imp = importanceUCL(f, preTable(cur, before), closest);
      const meetings = prior(f.home).filter((x) => x.home === f.away || x.away === f.away).slice(-5).reverse();
      if (meetings.length < 5) log.cell('H2H LAST 5', `only ${meetings.length} earlier ${CN} meeting(s) since ${past[0] - 1}-${String(past[0]).slice(2)}`, label);

      const teams = [[f.home, 'H', f.winH], [f.away, 'A', f.winA]].map(([team, ha, win]) => {
        const absent = model.absencesFor(abs, team, { done: f.done, date: f.date }, log, label);
        const standing = [...past.slice(1).map((p) => {
          const s = H.get(p);
          if (!s) return '—';
          const r = s.table.get(team);
          if (!r) return 'new';
          return r.group && r.group !== 'League' ? `${r.group}·${r.rank}` : String(r.rank);
        }), nowTab.get(team) && nowTab.get(team).P ? String(nowTab.get(team).rank) : '—'];

        const pr = prior(team);
        const last10 = pr.slice(-10);
        let gfg = null; let gag = null; let ratio = null; let total = null; let pen = null;
        if (last10.length) {
          const [gf, ga] = last10.reduce((a, x) => { const [, p, q] = persp(x, team); return [a[0] + p, a[1] + q]; }, [0, 0]);
          gfg = gf / last10.length; gag = ga / last10.length; ratio = ga ? gf / ga : null; total = (gf + ga) / last10.length;
          pen = intl.penSplit(last10, team, log, 'GF/G GA/G excl. pens', team);
          if (last10.length < 10) log.cell('GF/G GA/G GF/GA TOT/G', `only ${last10.length} ${CN} game(s) on record`, team);
        } else log.cell('GF/G GA/G GF/GA TOT/G', `no ${CN} games on record`, team);
        const lx = pr[pr.length - 1];
        const lr = lx ? persp(lx, team) : null;
        // LAST 20: Champions League + domestic league games, newest first, with penalty goals
        const dom = (domForm.games.get(team) || []).filter((x) => x.date < before);
        const mixed = [...pr.map((x) => ({ x, comp: x.round || 'UCL' })), ...dom.map((x) => ({ x, comp: x.comp }))]
          .sort((p, q) => (p.x.date < q.x.date ? -1 : p.x.date > q.x.date ? 1 : 0));
        const last5 = mixed.slice(-FORM_GAMES).reverse().map(({ x, comp }) => formGame(x, team, { comp }));
        if (last5.length < FORM_GAMES) log.cell(`LAST ${FORM_GAMES}`, `only ${last5.length} earlier game(s) on record`, team);

        const hist = past.map((p) => {
          const s = H.get(p);
          if (!s) return '—';
          const mine = s.matches.filter((x) => x.phase && (x.home === team || x.away === team));
          if (!mine.length) { log.cell(`MATCH-${histN} HIST ${lab(p)}`, 'club not in that season\'s league/group phase', team); return 'new'; }
          const mm = mine.find((x) => x.md === histN);
          if (!mm) { log.cell(`MATCH-${histN} HIST ${lab(p)}`, `no Matchday ${histN} that season (group stage had 6)`, team); return '—'; }
          return persp(mm, team)[0];
        });
        const records = past.map((p) => {
          const s = H.get(p);
          if (!s) return '—';
          const r = s.table.get(team);
          return r ? `${r.W}-${r.D}-${r.L}` : 'new';
        });
        const nowRow = nowTab.get(team);
        records.push(nowRow ? `${nowRow.W}-${nowRow.D}-${nowRow.L}` : '—');

        const res = f.done
          ? (() => { const [o, gf, ga] = persp(f, team); return { kind: 'ft', text: `${o} ${gf}-${ga}`, outcome: o }; })()
          : { kind: 'wp', pct: win };
        const h2hGames = meetings.map((x) => formGame(x, team, { season: x.round || '' }));
        return {
          ha, team, absent, last5, standing, gfg, gag, pen, ratio, total, domestic: domesticCells(team),
          last: lr ? `${lr[0]} ${lr[1]}-${lr[2]}` : '—', lastOutcome: lr ? lr[0] : null, hist, records, res,
          h2h: { games: h2hGames, gf: h2hGames.reduce((a, g) => a + g.gf, 0), ga: h2hGames.reduce((a, g) => a + g.ga, 0) },
        };
      });
      return {
        sortKey: f.et != null ? f.et : Number.MAX_SAFE_INTEGER, home: f.home,
        day: showDate ? T.weekday(showDate) : '—', date: showDate ? T.monDay(showDate) : '—', time,
        wx: wxs[i], imp: [imp[0], imp[1].length > 40 ? `${imp[1].slice(0, 39)}…` : imp[1]], done: f.done, teams,
        pred, kalshi: mk.kalshi.get(label) || null, poly: mk.poly.get(label) || null,
        result: f.done ? { hg: f.hg, ag: f.ag } : null, moved: shape.note(fixtures[i]),
      };
    });
    out.sort((p, q) => (p.sortKey - q.sortKey) || (p.home < q.home ? -1 : 1));
    // BTTS correlation study (panel below the round table)
    let btts = null;
    try {
      // the drivers chart shows a matchday with every result in: this one once complete, else the
      // latest complete one before it (a rescheduled game still to play doesn't count)
      const mdGames = (k) => cur.filter((m) => m.phase && m.md === k);
      const complete = (ms) => ms.length > 0 && model.roundShape(ms, dayOf, isDone, today).open === 0;
      let drvN = n;
      if (!complete(fixtures)) for (let k = n - 1; k >= 1; k--) if (complete(mdGames(k))) { drvN = k; break; }
      const drvShape = drvN === n ? null : model.roundShape(mdGames(drvN), dayOf, isDone, today);
      const drvFx = drvN === n ? null : mdGames(drvN).map((m) => ({
        label: `${m.home} v ${m.away}`, home: m.home, away: m.away, date: m.date, moved: drvShape.note(m), result: m.done ? { hg: m.hg, ag: m.ag } : null,
      }));
      btts = await UB.analyse(fetcher, {
        comp: { short: CN, abbr: cfg.abbr },
        H, cur, e, today, params: PARAMS, fixtures: bttsFx, driversFixtures: drvFx, log,
        seasons: (y) => (y === e ? curModel : seasonModelGames(H, y)),
      });
      const order = new Map(out.map((o, k) => [`${o.teams[0].team} v ${o.teams[1].team}`, k]));
      for (const s of [btts, drvFx ? null : btts.drivers]) if (s) s.round.sort((p, q) => (order.get(p.label) ?? 99) - (order.get(q.label) ?? 99));
      if (btts.spread) btts.spread.fixtures.sort((p, q) => (order.get(p.label) ?? 99) - (order.get(q.label) ?? 99));
      if (btts.drivers) Object.assign(btts.drivers, { roundLabel: `${INFO.roundWord} ${drvN}`, roundShift: drvN !== n });
      if (btts.drivers && btts.drivers.current) {
        btts.drivers.current.sort((p, q) => (order.get(p.label) ?? 99) - (order.get(q.label) ?? 99));
        btts.drivers.currentLabel = `${INFO.roundWord} ${n}`;
      }
    } catch (err) {
      log.warn(`BTTS study unavailable (${err.message})`);
    }
    const ks = out.map((x) => x.sortKey).filter((x) => x !== Number.MAX_SAFE_INTEGER);
    const range = ks.length ? T.rangeLabel(T.localDate(Math.min(...ks), LA), T.localDate(Math.max(...ks), LA)) : '';
    const played = fx.filter((f) => f.done).length;

    return {
      league: INFO.key, round: n, season: sLabel, histRound: histN,
      title: `${INFO.name} — Matchday ${n}  ·  ${range}`,
      sub: `${sLabel} league phase · ${played === fx.length ? 'all fixtures final' : `${played}/${fx.length} played`} · kickoffs America/Los_Angeles`,
      foot1: `STANDING = finish that season (league-phase rank; group stage shown as group·place, e.g. B·2; new = not in it), NOW = live league-phase rank `
        + `(1–${TOP} last 16, ${TOP + 1}–${PLAYOFF} play-offs, ${PLAYOFF + 1}–36 out)  ·  GF/G, GA/G, TOT/G, LAST = the club's ${CN} games `
        + '(qualifiers, league/group phase, knockouts), last 10 / last before kickoff; np = excluding penalties  ·  '
        + `LAST 20 = last twenty games, ${CN} + domestic league (football-data.co.uk; ${cfg.abbr} only where the country has no file), newest first; `
        + 'GF-GA = goals over those games, with a small np line underneath: penalty goals excluded, then penalties scored-conceded ((14/20) = only 14 games have a penalty record)  ·  '
        + `MATCH-${histN} HIST = club's Matchday ${histN} result in that season's league/group phase  ·  SEASON RECORD = league/group-phase W-D-L (NOW = UEFA table)  ·  `
        + 'DOMESTIC: LEAGUE POS = current place in the club\'s own league (ESPN live table; — where ESPN has none), UEFA RANK = its country\'s place in UEFA\'s association coefficient ranking this season  ·  '
        + 'H2H LAST 5 and LAST 20 each show the newest 7 games (hover +N for the rest), then over all of them W-D-L, GF-GA (np line underneath) and 0 / 1 / 2 / 3 / 4+ = in how many of those games the club scored (top line, G) and conceded (bottom line, GA) 0, 1, 2, 3, 4+ goals (e.g. 4/20), and 1+ = in how many they scored (G) / conceded (GA) at least once  ·  '
        + `H2H LAST 5 = ${CN} meetings  ·  `
        + 'INJURED (? = doubtful) / SUSP. = players out, upcoming fixtures only  ·  WIN% = odds-implied, overround removed  ·  '
        + `MODEL = Poisson goals model (Dixon–Coles, K=${PARAMS.K}, rho=${PARAMS.rho}, ratings shrunk ×${PARAMS.shrink}): xG, WIN, scores 1+/2+, DRAW, both teams score, over 2.5 goals; `
        + `clubs rated on ${CN} games only (`
        + 'league/group phase + knockouts, no qualifiers), non-penalty goals with the penalty rate added back; '
        + 'built from the last two seasons + this season\'s games before kickoff; outlined = what happened. Accuracy per season: "Model accuracy (backtest)" below  ·  '
        + 'KALSHI / POLYMARKET = prediction-market prices for the same figures (mid of bid and ask; win/draw/loss rescaled to 100%): live before kickoff, '
        + `the last price before kickoff once a game has started; — when there is no market or bid/ask are more than ${Math.round(M.MAX_SPREAD * 100)} pts apart; `
        + 'amber = 5+ pts away from the model',
      foot2: `Sources: UEFA match & standings feeds (fixtures, results, kickoffs, venues, tables; history ${past[0] - 1}-${String(past[0]).slice(2)} on) · `
        + 'Kalshi & Polymarket public market data · SportsGambler injuries & suspensions · The Odds API · Open-Meteo weather at the stadium, kickoff hour.'
        + `${odds == null ? '  Caveats: WIN% — (no ODDS_API_KEY)' : ''}`,
      fixtures: out.map(({ sortKey, home, ...rest }) => rest),
      standLabels: [...past.slice(1).map(lab), 'NOW'],
      histLabels: past.map(lab), histTitle: `MATCH-${histN} HIST`,
      recLabels: [...past.map(lab), 'NOW'], lastLabel: 'LAST',
      top: Array.from({ length: TOP }, (_, k) => String(k + 1)), releg: Array.from({ length: 36 - PLAYOFF }, (_, k) => String(PLAYOFF + 1 + k)),
      goalsSample: `over the last 10 ${CN} games`,
      model: { params: PARAMS, backtest: bt },
      btts,
      domesticLabels: ['LEAGUE POS', 'UEFA RANK'],
      header: `Run log — ${INFO.name} Matchday ${n} (${sLabel})`,
    };
  }

  return { INFO, MDS, HISTORY_SEASONS, HISTORY_FILE, currentSeason, loadMatches, loadStandings, listRounds, build };
}

module.exports = { make };
