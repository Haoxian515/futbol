'use strict';
// Prediction-market prices (Kalshi, Polymarket) for the same quantities as the MODEL column:
// home/draw/away, each team scoring 1+ / 2+, both teams to score, over 2.5 goals.
//
// Price = probability: the midpoint of the yes bid and ask (each contract pays $1). A quote is used
// only when bid and ask are both present and at most MAX_SPREAD apart; otherwise "—". Home/draw/
// away are rescaled to sum to 1 (removes the small overround).
//   - fixture not started: the live quote
//   - fixture started or finished: the last quote before kickoff (price history), so a finished
//     game shows what the market expected, next to what happened
// Games are found by kickoff time (±3h) and team-name similarity, since both venues name clubs
// their own way ("Man City", "Real Racing Club", "RCD Espanyol de Barcelona").

const T = require('./time');

const MAX_SPREAD = 0.05;
const TTL_LIVE = 0.25; // hours
const TTL_PAST = 24 * 365;
const KALSHI = 'https://api.elections.kalshi.com/trade-api/v2';
const GAMMA = 'https://gamma-api.polymarket.com';
const CLOB = 'https://clob.polymarket.com';
const K_PREFIX = { pl: 'KXEPL', laliga: 'KXLALIGA', seriea: 'KXSERIEA', ligue1: 'KXLIGUE1' };
const P_SERIES = { pl: 10188, laliga: 10193, seriea: 10203, ligue1: 10195 };

// ------------------------------------------------------------------ name matching
const STOP = new Set(['fc', 'cf', 'afc', 'club', 'de', 'del', 'la', 'el', 'ac', 'as', 'ss', 'ssc', 'us', 'sc', 'rc', 'rcd',
  'cd', 'ud', 'sd', 'ca', 'calcio', 'futbol', 'balompie', 'hotspur', 'albion', 'and', 'town', 'city', 'united', 'utd', '1913', '1907', '1909']);
const fold = (s) => (s || '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ');
const toks = (s) => fold(s).split(/\s+/).filter((t) => t && !STOP.has(t));
// share of tokens that agree (one is a prefix of the other: "man" ~ "manchester", "nott" ~ "nottingham")
function sim(a, b) {
  const A = toks(a);
  const B = toks(b);
  if (!A.length || !B.length) return fold(a).trim() === fold(b).trim() ? 1 : 0;
  const hit = A.filter((x) => B.some((y) => x.startsWith(y) || y.startsWith(x))).length;
  return hit / Math.max(A.length, B.length);
}
function nameMatch(raw, club, canon) {
  if (canon(raw) === club) return 1;
  return Math.max(sim(raw, club), sim(canon(raw), club));
}

const mid = (bid, ask) => {
  const b = parseFloat(bid);
  const a = parseFloat(ask);
  if (!(b > 0) || !(a > 0) || a < b || a - b > MAX_SPREAD) return null;
  return (a + b) / 2;
};

function finish(r) {
  const s = (r.pH ?? NaN) + (r.pD ?? NaN) + (r.pA ?? NaN);
  if (s > 0) { r.pH /= s; r.pD /= s; r.pA /= s; } else { r.pH = null; r.pD = null; r.pA = null; }
  return r;
}

const sleep = (ms) => new Promise((res) => setTimeout(res, ms));

// ------------------------------------------------------------------ Kalshi
async function kalshiRound(fetcher, league, fixtures, canon, nowMs, log) {
  const P = K_PREFIX[league];
  const out = new Map();
  if (!P || !fixtures.length) return out;
  const kos = fixtures.map((f) => f.ko);
  const lo = Math.floor(Math.min(...kos) / 1000) - 86400;
  const hi = Math.floor(Math.max(...kos) / 1000) + 5 * 86400;
  const list = await fetcher.getJson(`${KALSHI}/markets?series_ticker=${P}GAME&min_close_ts=${lo}&max_close_ts=${hi}&limit=200`, TTL_LIVE);
  if (!list || !Array.isArray(list.markets)) { log.warn('Kalshi: game markets unavailable — KALSHI column is —'); return out; }
  const events = new Map();
  for (const m of list.markets) {
    if (!events.has(m.event_ticker)) events.set(m.event_ticker, { ko: Date.parse(m.occurrence_datetime || m.expected_expiration_time), sides: [] });
    events.get(m.event_ticker).sides.push(m);
  }
  for (const f of fixtures) {
    let best = null;
    for (const [ev, e] of events) {
      if (!(Math.abs(e.ko - f.ko) <= 3 * 3600e3)) continue;
      const team = e.sides.filter((m) => m.yes_sub_title !== 'Tie');
      for (const [h, a] of [[team[0], team[1]], [team[1], team[0]]]) {
        if (!h || !a) continue;
        const sc = nameMatch(h.yes_sub_title, f.home, canon) + nameMatch(a.yes_sub_title, f.away, canon);
        if (sc >= 1.2 && (!best || sc > best.sc)) best = { sc, ev, h, a, tie: e.sides.find((m) => m.yes_sub_title === 'Tie') };
      }
    }
    if (!best) { log.cell('KALSHI', 'no Kalshi game market found for this fixture', f.label); continue; }
    const suf = best.ev.slice(`${P}GAME-`.length);
    const code = (m) => m.ticker.slice(best.ev.length + 1);
    const ch = code(best.h);
    const ca = code(best.a);
    const tick = {
      pH: best.h.ticker, pD: best.tie && best.tie.ticker, pA: best.a.ticker,
      h1: `${P}TEAMTOTAL-${suf}-${ch}1`, h2: `${P}TEAMTOTAL-${suf}-${ch}2`, a1: `${P}TEAMTOTAL-${suf}-${ca}1`, a2: `${P}TEAMTOTAL-${suf}-${ca}2`,
      btts: `${P}BTTS-${suf}-BTTS`, o25: `${P}TOTAL-${suf}-3`,
    };
    const all = Object.values(tick).filter(Boolean);
    const r = { source: 'Kalshi', event: best.ev };
    if (nowMs < f.ko) {
      const q = await fetcher.getJson(`${KALSHI}/markets?tickers=${all.join(',')}`, TTL_LIVE);
      const by = new Map(((q && q.markets) || []).map((m) => [m.ticker, m]));
      for (const [k, t] of Object.entries(tick)) { const m = by.get(t); r[k] = m ? mid(m.yes_bid_dollars, m.yes_ask_dollars) : null; }
      r.asOf = 'live';
    } else {
      const ko = Math.floor(f.ko / 1000);
      const q = await fetcher.getJson(`${KALSHI}/markets/candlesticks?market_tickers=${all.join(',')}&start_ts=${ko - 4 * 3600}&end_ts=${ko}&period_interval=60`, TTL_PAST);
      const by = new Map(((q && q.markets) || []).map((m) => [m.market_ticker, m.candlesticks || []]));
      for (const [k, t] of Object.entries(tick)) {
        const cs = (by.get(t) || []).filter((c) => c.end_period_ts <= ko);
        const c = cs[cs.length - 1];
        r[k] = c ? mid((c.yes_bid || {}).close_dollars, (c.yes_ask || {}).close_dollars) : null;
      }
      r.asOf = 'pre-kickoff';
    }
    out.set(f.label, finish(r));
    await sleep(150); // stay under Kalshi's request rate limit
  }
  return out;
}

// ------------------------------------------------------------------ Polymarket
async function polyRound(fetcher, league, fixtures, canon, nowMs, log) {
  const S = P_SERIES[league];
  const out = new Map();
  if (!S || !fixtures.length) return out;
  const kos = fixtures.map((f) => f.ko);
  const iso = (ms) => new Date(ms).toISOString().slice(0, 19) + 'Z';
  const events = [];
  for (let off = 0; off < 1000; off += 100) {
    const page = await fetcher.getJson(`${GAMMA}/events?series_id=${S}&end_date_min=${iso(Math.min(...kos) - 86400e3)}`
      + `&end_date_max=${iso(Math.max(...kos) + 86400e3)}&limit=100&offset=${off}`, TTL_LIVE);
    if (!Array.isArray(page)) break;
    events.push(...page);
    if (page.length < 100) break;
  }
  if (!events.length) { log.warn('Polymarket: no events found for this round — POLYMARKET column is —'); return out; }
  const games = events.filter((e) => !/ - /.test(e.title) && / vs\. /.test(e.title));
  await Promise.all(fixtures.map(async (f) => {
    let best = null;
    for (const e of games) {
      const ko = Date.parse(e.endDate);
      if (!(Math.abs(ko - f.ko) <= 3 * 3600e3)) continue;
      const [h, a] = e.title.split(' vs. ');
      const sc = nameMatch(h, f.home, canon) + nameMatch(a, f.away, canon);
      if (sc >= 1.2 && (!best || sc > best.sc)) best = { sc, e, h, a };
    }
    if (!best) { log.cell('POLYMARKET', 'no Polymarket game market found for this fixture', f.label); return; }
    const more = events.find((e) => e.title === `${best.e.title} - More Markets`);
    const ms = [...best.e.markets, ...((more && more.markets) || [])];
    const q = (re, type) => ms.find((m) => (!type || m.sportsMarketType === type) && re.test(m.question || ''));
    const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const pick = {
      pH: q(new RegExp(`^Will ${esc(best.h)} win`), 'moneyline'), pD: q(/end in a draw\?$/, 'moneyline'), pA: q(new RegExp(`^Will ${esc(best.a)} win`), 'moneyline'),
      h1: q(new RegExp(`: ${esc(best.h)} O/U 0\\.5$`), 'soccer_team_totals'), h2: q(new RegExp(`: ${esc(best.h)} O/U 1\\.5$`), 'soccer_team_totals'),
      a1: q(new RegExp(`: ${esc(best.a)} O/U 0\\.5$`), 'soccer_team_totals'), a2: q(new RegExp(`: ${esc(best.a)} O/U 1\\.5$`), 'soccer_team_totals'),
      btts: q(/: Both Teams to Score$/, 'both_teams_to_score'), o25: q(/: O\/U 2\.5$/, 'totals'),
    };
    const r = { source: 'Polymarket', event: best.e.slug };
    if (nowMs < f.ko) {
      for (const [k, m] of Object.entries(pick)) r[k] = m ? mid(m.bestBid, m.bestAsk) : null;
      r.asOf = 'live';
    } else {
      const ko = Math.floor(f.ko / 1000);
      await Promise.all(Object.entries(pick).map(async ([k, m]) => {
        let tok = null;
        try { tok = m && JSON.parse(m.clobTokenIds)[0]; } catch { tok = null; } // [0] = "Yes" / "Over"
        const h = tok && await fetcher.getJson(`${CLOB}/prices-history?market=${tok}&startTs=${ko - 4 * 3600}&endTs=${ko}&fidelity=60`, TTL_PAST);
        const pts = ((h && h.history) || []).filter((x) => x.t <= ko);
        r[k] = pts.length ? +pts[pts.length - 1].p : null;
      }));
      r.asOf = 'pre-kickoff';
    }
    out.set(f.label, finish(r));
  }));
  return out;
}

// fixtures: [{ label, home, away, ko (epoch ms) }] with canonical club names
async function loadRound(fetcher, league, fixtures, canon, nowMs, log) {
  const fx = fixtures.filter((f) => f.ko != null);
  for (const f of fixtures) if (f.ko == null) log.cell('KALSHI / POLYMARKET', 'no kickoff time to match markets on', f.label);
  const [kalshi, poly] = [await kalshiRound(fetcher, league, fx, canon, nowMs, log), await polyRound(fetcher, league, fx, canon, nowMs, log)];
  return { kalshi, poly };
}

module.exports = { loadRound, sim, MAX_SPREAD };
