'use strict';
// Live match centre for /live/: scores, key events, team stats and text commentary.
//
//   scoreboard()  today's games in every competition the app charts, polled in parallel
//   match(id)     one game: score, goals/cards/subs split home vs away, stats, commentary
//
// Source: ESPN's public JSON feed (site.api.espn.com). It is fed by the same live data providers
// as the big scoreboards, sits behind a ~10 s CDN cache and needs no key. Sofascore and FotMob
// were tried first: Sofascore answers servers with empty bodies and FotMob's match pages need a
// signed header. Live data is never written to the cache or archive — it is stale within seconds.
// Every payload carries {source, fetchedAt} so the page can show where and when it came from.

const BASE = 'https://site.api.espn.com/apis/site/v2/sports/soccer';
const SOURCE = 'ESPN live feed';

// App competition key -> ESPN league slug. Nations League A-D share one ESPN feed.
const COMPS = [
  { key: 'pl', name: 'Premier League', slug: 'eng.1' },
  { key: 'laliga', name: 'La Liga', slug: 'esp.1' },
  { key: 'ligue1', name: 'Ligue 1', slug: 'fra.1' },
  { key: 'seriea', name: 'Serie A', slug: 'ita.1' },
  { key: 'bundesliga', name: 'Bundesliga', slug: 'ger.1' },
  { key: 'ucl', name: 'UEFA Champions League', slug: 'uefa.champions' },
  { key: 'uel', name: 'UEFA Europa League', slug: 'uefa.europa' },
  { key: 'nations', name: 'UEFA Nations League', slug: 'uefa.nations' },
  { key: 'intl', name: 'International friendlies', slug: 'fifa.friendly' },
];
const BY_SLUG = Object.fromEntries(COMPS.map((c) => [c.slug, c]));

// Stats shown on a match card, in order: [ESPN name, label]
const STATS = [
  ['possessionPct', 'Possession %'],
  ['totalShots', 'Shots'],
  ['shotsOnTarget', 'On target'],
  ['wonCorners', 'Corners'],
  ['foulsCommitted', 'Fouls'],
  ['offsides', 'Offsides'],
  ['yellowCards', 'Yellow cards'],
  ['redCards', 'Red cards'],
  ['saves', 'Saves'],
  ['accuratePasses', 'Accurate passes'],
];

// ESPN keyEvent types worth listing under the score (everything else is in the commentary).
const EVENT_KIND = {
  goal: 'goal', 'goal---header': 'goal', 'goal---free-kick': 'goal', 'penalty---scored': 'pen',
  'own-goal': 'og', 'yellow-card': 'yellow', 'red-card': 'red', 'yellow-red-card': 'red',
  substitution: 'sub', 'penalty---missed': 'penmiss', 'penalty---saved': 'penmiss',
};

class LiveError extends Error {}

// Short in-process memo so many viewers (or many cards) polling at once cost one upstream call.
const MEMO_MS = 5000;
const memo = new Map();
async function getJson(url) {
  const hit = memo.get(url);
  if (hit && Date.now() - hit.at < MEMO_MS) return hit.p;
  const p = (async () => {
    const r = await fetch(url, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(8000) });
    if (!r.ok) throw new LiveError(`${SOURCE} answered ${r.status}`);
    return { body: await r.json(), fetchedAt: new Date().toISOString() };
  })();
  memo.set(url, { at: Date.now(), p });
  p.catch(() => memo.delete(url));
  if (memo.size > 300) for (const [k, v] of memo) if (Date.now() - v.at > MEMO_MS) memo.delete(k);
  return p;
}

const num = (v) => (v == null || v === '' || Number.isNaN(Number(v)) ? null : Number(v));

function status(s) {
  const t = (s && s.type) || {};
  return {
    state: t.state || 'pre', // pre | in | post
    detail: t.shortDetail || t.detail || '',
    clock: s && s.displayClock,
    period: s && s.period,
    completed: !!t.completed,
  };
}

// pre: no score yet — ESPN sends "0", the page must show "—", not a 0-0
function side(c, pre) {
  if (!c) return null;
  const t = c.team || {};
  return {
    id: t.id,
    name: t.displayName || t.name,
    short: t.shortDisplayName || t.abbreviation || t.displayName,
    abbr: t.abbreviation,
    logo: t.logo || (t.logos && t.logos[0] && t.logos[0].href) || null,
    goals: pre ? null : num(c.score),
    shootout: pre ? null : num(c.shootoutScore),
  };
}

function pair(comp, st) {
  const cs = (comp && comp.competitors) || [];
  const pre = st.state === 'pre';
  return { home: side(cs.find((c) => c.homeAway === 'home'), pre), away: side(cs.find((c) => c.homeAway === 'away'), pre) };
}

// One competition's games for the scoreboard. dates: YYYYMMDD (ESPN's own day), default = ESPN's "today".
async function competition(c, dates) {
  const { body, fetchedAt } = await getJson(`${BASE}/${c.slug}/scoreboard${dates ? `?dates=${dates}` : ''}`);
  return (body.events || []).map((e) => {
    const comp = (e.competitions || [])[0] || {};
    const st = status(comp.status || e.status);
    const { home, away } = pair(comp, st);
    return {
      id: e.id, comp: c.key, compName: c.name, kickoff: e.date,
      status: st, home, away,
      venue: comp.venue && comp.venue.fullName, fetchedAt,
    };
  });
}

// ESPN's day for a timestamp (its scoreboard days run on US Eastern time), as YYYYMMDD.
function espnDay(ms) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' })
    .formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  return `${p.year}${p.month}${p.day}`;
}

// Window shown by default: every game in play, plus games that ended in the last WINDOW_BACK or
// kick off within WINDOW_AHEAD. The feeds' undated default is their current matchday, which for
// cups can be days old, so it is topped up with ESPN's today and tomorrow and then filtered.
const H = 3600 * 1000;
const WINDOW_BACK = 12 * H;
const WINDOW_AHEAD = 30 * H;

// All charted competitions in parallel; one failing feed is reported, not fatal.
// dates (YYYYMMDD) asks for that one day, unfiltered.
async function scoreboard(dates) {
  if (dates != null && !/^\d{8}$/.test(dates)) throw new LiveError('date must be YYYYMMDD');
  const now = Date.now();
  const days = dates ? [dates] : [undefined, espnDay(now), espnDay(now + 24 * H)];
  const jobs = COMPS.flatMap((c) => days.map((d) => ({ c, p: competition(c, d) })));
  const results = await Promise.allSettled(jobs.map((j) => j.p));
  const seen = new Map();
  const failed = new Map();
  results.forEach((r, i) => {
    const { c } = jobs[i];
    if (r.status === 'rejected') { failed.set(c.key, { comp: c.key, name: c.name, error: r.reason.message }); return; }
    for (const m of r.value) if (!seen.has(m.id)) seen.set(m.id, m);
  });
  let matches = [...seen.values()];
  if (!dates) {
    matches = matches.filter((m) => {
      if (m.status.state === 'in') return true;
      const t = Date.parse(m.kickoff);
      return t >= now - WINDOW_BACK && t <= now + WINDOW_AHEAD;
    });
  }
  const rank = { in: 0, pre: 1, post: 2 };
  matches.sort((a, b) => rank[a.status.state] - rank[b.status.state]
    || (a.status.state === 'post' ? (a.kickoff > b.kickoff ? -1 : 1) : a.kickoff < b.kickoff ? -1 : a.kickoff > b.kickoff ? 1 : 0));
  // a competition counts as failed only if none of its requests worked
  const errors = [...failed.values()].filter((e) => results.every((r, i) => jobs[i].c.key !== e.comp || r.status === 'rejected'));
  return { source: SOURCE, fetchedAt: new Date().toISOString(), comps: COMPS.map(({ key, name }) => ({ key, name })), matches, errors };
}

function minute(ev) {
  return (ev.clock && ev.clock.displayValue) || (ev.time && ev.time.displayValue) || '';
}

// Goals, cards and subs, each tagged with the side whose team ESPN attaches to the event.
function events(key, ids) {
  const out = [];
  for (const k of key || []) {
    const kind = EVENT_KIND[k.type && k.type.type];
    if (!kind) continue;
    const tid = k.team && k.team.id;
    const names = (k.participants || []).map((p) => p.athlete && p.athlete.displayName).filter(Boolean);
    out.push({
      kind, side: tid === ids.home ? 'home' : tid === ids.away ? 'away' : null, minute: minute(k),
      player: names[0] || null, other: kind === 'sub' ? names[1] || null : null, shootout: !!k.shootout,
    });
  }
  return out;
}

// Goals per side. An own goal counts for the other club; ESPN feeds differ on which team they
// attach it to, so own goals are flipped only when that is what makes the lists add up to the score.
function goals(ev, home, away) {
  const scored = ev.filter((e) => ['goal', 'pen', 'og'].includes(e.kind) && !e.shootout && e.side);
  const split = (flipOg) => {
    const g = { home: [], away: [] };
    for (const e of scored) {
      const s = e.kind === 'og' && flipOg ? (e.side === 'home' ? 'away' : 'home') : e.side;
      g[s].push({ ...e, side: s });
    }
    return g;
  };
  const fits = (g) => g.home.length === home && g.away.length === away;
  const asIs = split(false);
  if (fits(asIs)) return asIs;
  const flipped = split(true);
  return fits(flipped) ? flipped : asIs;
}

function stats(box, ids) {
  const teams = (box && box.teams) || [];
  const of = (id) => {
    const t = teams.find((x) => x.team && x.team.id === id);
    return Object.fromEntries(((t && t.statistics) || []).map((s) => [s.name, s.displayValue]));
  };
  const h = of(ids.home);
  const a = of(ids.away);
  return STATS.filter(([n]) => h[n] != null || a[n] != null)
    .map(([n, label]) => ({ key: n, label, home: num(h[n]), away: num(a[n]) }));
}

// Text commentary, newest first. Lines carry an id so the page can tell which ones are new.
function commentary(list) {
  return (list || []).map((c, i) => ({
    id: (c.play && c.play.id) || `${i}`,
    minute: (c.time && c.time.displayValue) || '',
    text: c.text || '',
    kind: c.play && c.play.type && EVENT_KIND[c.play.type.type] || null,
  })).filter((c) => c.text).reverse();
}

async function match(id) {
  if (!/^\d{1,12}$/.test(String(id))) throw new LiveError('event must be a numeric id');
  const { body, fetchedAt } = await getJson(`${BASE}/all/summary?event=${id}`);
  const comp = ((body.header && body.header.competitions) || [])[0];
  if (!comp) throw new LiveError(`no match ${id} in ${SOURCE}`);
  const st = status(comp.status);
  const { home, away } = pair(comp, st);
  const ids = { home: home && home.id, away: away && away.id };
  const lg = (body.header && body.header.league) || {};
  const c = BY_SLUG[lg.slug];
  const ev = events(body.keyEvents, ids);
  const lines = commentary(body.commentary);
  return {
    source: SOURCE, fetchedAt, id: String(id),
    comp: c ? c.key : lg.slug || null, compName: c ? c.name : lg.name || null,
    kickoff: comp.date, status: st, home, away,
    venue: body.gameInfo && body.gameInfo.venue && body.gameInfo.venue.fullName,
    // home and away goals kept apart, as in the charts
    goals: goals(ev, home && home.goals, away && away.goals),
    events: ev,
    stats: stats(body.boxscore, ids),
    commentary: lines,
  };
}

module.exports = { scoreboard, match, LiveError, COMPS, SOURCE };
