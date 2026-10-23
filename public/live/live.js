'use strict';
// /live/: every game in play across the charted competitions, side by side, each updating on
// its own. The list of games comes from /api/live (every LIST_MS); each game in play polls
// /api/live?event=ID for goals, stats and commentary (every DETAIL_MS), all in parallel.
// A score change plays a goal animation in that game's card and, with goal alerts on, a sound
// and a browser notification. Polling pauses while the tab is hidden unless goal alerts are on.

const LIST_MS = 20000;
const DETAIL_MS = 10000;
const COMM_SHORT = 6;
const BURST_MS = 6500; // the in-card goal animation
const GLOW_MS = 30000; // card glow and scorer highlight after a goal
const TZ = 'America/Los_Angeles';

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const state = {
  board: null,
  details: new Map(), // id -> match detail
  score: new Map(), // id -> "h-a" last seen, to spot new goals
  flash: new Map(), // id -> {at, side, kind: 'goal'|'disallowed', scorer, minute}
  seen: new Map(), // id -> Set of commentary ids already shown (new ones get highlighted)
  fresh: new Map(), // id -> Set of commentary ids that arrived on the latest poll
  open: new Set(), // finished / upcoming games expanded into a card
  allComm: new Set(), // cards showing the full commentary
  hidden: loadHidden(), // competitions switched off in the filter
  lastOk: null,
  alerts: loadAlerts(), // goal alerts on: sound + browser notification
};

function loadAlerts() {
  try { return localStorage.getItem('live.alerts') === '1'; } catch { return false; }
}

function loadHidden() {
  try { return new Set(JSON.parse(localStorage.getItem('live.hidden') || '[]')); } catch { return new Set(); }
}
function saveHidden() {
  try { localStorage.setItem('live.hidden', JSON.stringify([...state.hidden])); } catch { /* private mode */ }
}

async function api(url) {
  const r = await fetch(url, { cache: 'no-store' });
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(body.error || `HTTP ${r.status}`);
  return body;
}

const timeFmt = new Intl.DateTimeFormat('en-US', { timeZone: TZ, hour: 'numeric', minute: '2-digit' });
const dayFmt = new Intl.DateTimeFormat('en-US', { timeZone: TZ, weekday: 'short' });
function kickoff(iso) {
  const d = new Date(iso);
  const today = dayFmt.format(new Date());
  const day = dayFmt.format(d);
  return `${day === today ? '' : `${day} `}${timeFmt.format(d)}`;
}

function goalsText(g) { return g == null ? '—' : String(g); }

function statusChip(m) {
  const s = m.status;
  if (s.state === 'in') {
    const ht = /HT|half/i.test(s.detail);
    return `<span class="chip live${ht ? ' ht' : ''}">${ht ? 'HT' : esc(s.clock || s.detail || 'LIVE')}</span>`;
  }
  if (s.state === 'post') return `<span class="chip ft">${esc(s.detail || 'FT')}</span>`;
  if (/postp|cancel|susp|delay/i.test(s.detail)) return `<span class="chip off">${esc(s.detail)}</span>`;
  return `<span class="chip pre">${esc(kickoff(m.kickoff))}</span>`;
}

const MARK = { pen: ' (pen)', og: ' (og)' };
function goalList(list, hot) {
  if (!list || !list.length) return '';
  return `<ul class="goals">${list.map((g, i) => `<li${hot && i === list.length - 1 ? ' class="hot"' : ''}><span class="min">${esc(g.minute)}</span><span>${esc(g.player || 'Goal')}${MARK[g.kind] || ''}</span></li>`).join('')}</ul>`;
}
function reds(d, side) {
  const r = (d.events || []).filter((e) => e.kind === 'red' && e.side === side);
  return r.length ? `<ul class="reds">${r.map((e) => `<li><span class="min"><span class="card-red"></span>${esc(e.minute)}</span><span>${esc(e.player)}</span></li>`).join('')}</ul>` : '';
}

function teamCell(t, side, d, hot) {
  if (!t) return `<div class="team ${side}">—</div>`;
  const logo = t.logo ? `<img src="${esc(t.logo)}" alt="" width="28" height="28" loading="lazy">` : '';
  return `<div class="team ${side}">
    <div class="tname">${logo}<span>${esc(t.name)}</span></div>
    ${d ? goalList(d.goals && d.goals[side], hot) + reds(d, side) : ''}
  </div>`;
}

function statRows(stats) {
  if (!stats || !stats.length) return '<p class="muted">No team stats in the feed yet.</p>';
  return `<table class="stats"><tbody>${stats.map((s) => {
    const h = s.home == null ? 0 : s.home;
    const a = s.away == null ? 0 : s.away;
    const tot = h + a;
    const hp = tot ? (h / tot) * 100 : 50;
    const hv = s.home == null ? '—' : s.key === 'possessionPct' ? `${Math.round(h)}%` : h;
    const av = s.away == null ? '—' : s.key === 'possessionPct' ? `${Math.round(a)}%` : a;
    return `<tr><td class="sv h${h > a ? ' lead' : ''}">${hv}</td>
      <td class="sl"><div>${esc(s.label)}</div><div class="bar"><span class="bh" style="width:${hp}%"></span><span class="ba" style="width:${100 - hp}%"></span></div></td>
      <td class="sv a${a > h ? ' lead' : ''}">${av}</td></tr>`;
  }).join('')}</tbody></table>`;
}

const KIND_ICON = { goal: '⚽', pen: '⚽', og: '⚽', yellow: '🟨', red: '🟥', sub: '🔁', penmiss: '✖' };
function commentary(id, d) {
  const lines = d.commentary || [];
  if (!lines.length) return '<p class="muted">No text commentary in the feed for this game.</p>';
  const all = state.allComm.has(id);
  const shown = all ? lines : lines.slice(0, COMM_SHORT);
  const fresh = state.fresh.get(id) || new Set();
  return `<ol class="comm">${shown.map((c) => `<li class="${c.kind ? `k-${c.kind}` : ''}${fresh.has(c.id) ? ' fresh-line' : ''}">
      <span class="min">${esc(c.minute)}</span><span class="ic">${KIND_ICON[c.kind] || ''}</span><span class="tx">${esc(c.text)}</span></li>`).join('')}</ol>
    ${lines.length > COMM_SHORT ? `<button type="button" class="linkbtn" data-comm="${esc(id)}">${all ? 'Show latest only' : `Show all ${lines.length} lines`}</button>` : ''}`;
}

// The goal animation laid over the card. It is rebuilt on every refresh, so its CSS animations
// start at a negative delay (time already elapsed) and carry on where they were.
function burst(m, f, age) {
  const t = f.side === 'home' ? m.home : m.away;
  const logo = t && t.logo ? `<img src="${esc(t.logo)}" alt="" width="44" height="44">` : '';
  const who = f.scorer ? `${esc(f.scorer)}${f.minute ? ` <span class="bmin">${esc(f.minute)}</span>` : ''}` : '';
  const g = (x) => goalsText(x && x.goals);
  const score = `<span class="${f.side === 'home' ? 'bnew' : ''}">${g(m.home)}</span> – <span class="${f.side === 'away' ? 'bnew' : ''}">${g(m.away)}</span>`;
  return `<div class="goal-burst ${f.kind} from-${f.side}" style="--t:-${age}ms">
    <div class="b-word">${f.kind === 'goal' ? '<span class="b-ball">⚽</span>GOAL!' : 'Goal disallowed'}</div>
    <div class="b-team">${logo}<span>${esc(t && t.name)}</span></div>
    ${who ? `<div class="b-who">${who}</div>` : ''}
    <div class="b-score">${score}</div>
  </div>`;
}

function card(m) {
  const d = state.details.get(m.id);
  const f = state.flash.get(m.id);
  const age = f ? Date.now() - f.at : Infinity;
  const flashing = f && f.kind === 'goal' && age < GLOW_MS;
  const closable = m.status.state !== 'in';
  return `<article class="mcard${flashing ? ' goal-flash' : ''}" data-id="${esc(m.id)}">
    <header class="mhead">
      <span class="comp">${esc(m.compName)}</span>
      ${statusChip(m)}
      ${closable ? `<button type="button" class="linkbtn close" data-close="${esc(m.id)}" aria-label="Close">✕</button>` : ''}
    </header>
    ${f && age < BURST_MS ? burst(m, f, age) : ''}
    <div class="score-row">
      ${teamCell(m.home, 'home', d, flashing && f.side === 'home')}
      <div class="score"><span class="g h${flashing && f.side === 'home' ? ' scored' : ''}">${goalsText(m.home && m.home.goals)}</span><span class="dash">–</span><span class="g a${flashing && f.side === 'away' ? ' scored' : ''}">${goalsText(m.away && m.away.goals)}</span>
        ${m.home && m.home.shootout != null ? `<div class="pens">pens ${m.home.shootout}–${m.away.shootout}</div>` : ''}</div>
      ${teamCell(m.away, 'away', d, flashing && f.side === 'away')}
    </div>
    ${d ? `<details class="sect" open><summary>Commentary</summary>${commentary(m.id, d)}</details>
      <details class="sect" open><summary>Stats</summary>${statRows(d.stats)}</details>
      <p class="stamp">${esc(d.source)} · fetched ${esc(timeFmt.format(new Date(d.fetchedAt)))}${m.venue ? ` · ${esc(m.venue)}` : ''}</p>`
    : m.status.state === 'pre' ? '<p class="muted">Stats and commentary start at kickoff.</p>' : '<p class="muted">Loading stats and commentary…</p>'}
  </article>`;
}

function row(m) {
  const done = m.status.state === 'post';
  const hw = done && m.home.goals > m.away.goals;
  const aw = done && m.away.goals > m.home.goals;
  return `<button type="button" class="mrow" data-open="${esc(m.id)}">
    ${statusChip(m)}
    <span class="rc">${esc(m.compName)}</span>
    <span class="rt h${hw ? ' win' : ''}">${esc(m.home && m.home.name)}</span>
    <span class="rs">${goalsText(m.home && m.home.goals)} – ${goalsText(m.away && m.away.goals)}</span>
    <span class="rt a${aw ? ' win' : ''}">${esc(m.away && m.away.name)}</span>
  </button>`;
}

function visible(list) { return list.filter((m) => !state.hidden.has(m.comp)); }

// Keep each card's element so scroll position and open/closed sections survive a refresh.
function renderGrid(el, list) {
  const want = new Set(list.map((m) => m.id));
  for (const c of [...el.children]) if (!want.has(c.dataset.id)) c.remove();
  list.forEach((m, i) => {
    let c = el.querySelector(`[data-id="${CSS.escape(m.id)}"]`);
    const html = card(m);
    if (!c) {
      const t = document.createElement('template');
      t.innerHTML = html.trim();
      c = t.content.firstChild;
    } else {
      const closed = [...c.querySelectorAll('details.sect')].map((x) => !x.open);
      const t = document.createElement('template');
      t.innerHTML = html.trim();
      const n = t.content.firstChild;
      n.querySelectorAll('details.sect').forEach((x, j) => { if (closed[j]) x.open = false; });
      c.replaceWith(n);
      c = n;
    }
    if (el.children[i] !== c) el.insertBefore(c, el.children[i] || null);
  });
}

function render() {
  const b = state.board;
  if (!b) return;
  const live = visible(b.matches.filter((m) => m.status.state === 'in'));
  const opened = visible(b.matches.filter((m) => m.status.state !== 'in' && state.open.has(m.id)));
  renderGrid($('liveGrid'), [...live, ...opened]);
  $('nLive').textContent = live.length ? `(${live.length})` : '';
  $('noLive').hidden = live.length > 0;
  const next = visible(b.matches.filter((m) => m.status.state === 'pre' && !state.open.has(m.id)));
  const done = visible(b.matches.filter((m) => m.status.state === 'post' && !state.open.has(m.id)));
  $('nextList').innerHTML = next.map(row).join('') || '<p class="live-empty">Nothing scheduled.</p>';
  $('doneList').innerHTML = done.map(row).join('') || '<p class="live-empty">Nothing finished yet.</p>';
  const goalNow = [...state.flash.values()].some((f) => f.kind === 'goal' && Date.now() - f.at < GLOW_MS);
  document.title = `${goalNow ? '⚽ GOAL · ' : ''}${live.length ? `(${live.length}) ` : ''}Live Matches`;
  renderAlertBtn();
  renderFilter();
  const errs = b.errors.length ? ` · unavailable: ${b.errors.map((e) => e.name).join(', ')}` : '';
  $('liveSrc').textContent = `Source: ${b.source}. Scores and events are shown exactly as the feed gives them; a dash means the feed has no value yet.${errs}`;
}

function renderFilter() {
  const b = state.board;
  const counts = {};
  for (const m of b.matches) counts[m.comp] = (counts[m.comp] || 0) + (m.status.state === 'in' ? 1 : 0);
  $('compFilter').innerHTML = b.comps.map((c) => `<label class="cf${state.hidden.has(c.key) ? '' : ' on'}">
      <input type="checkbox" data-comp="${esc(c.key)}"${state.hidden.has(c.key) ? '' : ' checked'}>${esc(c.name)}${counts[c.key] ? ` <b>${counts[c.key]}</b>` : ''}</label>`).join('');
}

function tickStatus() {
  if (!state.lastOk) return;
  const s = Math.round((Date.now() - state.lastOk) / 1000);
  $('liveStatus').textContent = document.hidden && !state.alerts ? 'Paused' : `Updated ${s < 2 ? 'just now' : `${s}s ago`}`;
}

// Compare a game's score with the last one seen; a change starts the goal animation (and the
// alert, if on). A score that goes down is a goal taken back (VAR), shown as such.
function checkScore(id, m) {
  if (!m.home || !m.away || m.home.goals == null || m.away.goals == null) return;
  const now = `${m.home.goals}-${m.away.goals}`;
  const prev = state.score.get(id);
  state.score.set(id, now);
  if (!prev || prev === now || m.status.state !== 'in') return;
  const [ph, pa] = prev.split('-').map(Number);
  const side = m.home.goals > ph ? 'home' : m.away.goals > pa ? 'away' : m.home.goals < ph ? 'home' : 'away';
  const kind = m.home.goals > ph || m.away.goals > pa ? 'goal' : 'disallowed';
  state.flash.set(id, { at: Date.now(), side, kind, scorer: null, minute: null });
  setTimeout(render, BURST_MS + 50);
  setTimeout(render, GLOW_MS + 50);
  if (kind === 'goal') alertGoal(id, m, side);
}

// the detail names the scorer, which the list does not: fill it in on the running animation
function fillScorer(id, d) {
  const f = state.flash.get(id);
  if (!f || f.kind !== 'goal' || f.scorer) return;
  const list = d.goals && d.goals[f.side];
  const g = list && list[list.length - 1];
  if (g) Object.assign(f, { scorer: `${g.player || 'Goal'}${MARK[g.kind] || ''}`, minute: g.minute });
}

function noteDetail(id, d) {
  checkScore(id, d);
  const seen = state.seen.get(id);
  const ids = new Set((d.commentary || []).map((c) => c.id));
  state.fresh.set(id, seen ? new Set([...ids].filter((x) => !seen.has(x))) : new Set());
  state.seen.set(id, ids);
  state.details.set(id, d);
  fillScorer(id, d);
  // the detail is newer than the list: carry its score and clock into the list entry
  const m = state.board && state.board.matches.find((x) => x.id === id);
  if (m) Object.assign(m, { status: d.status, home: d.home, away: d.away });
}

async function pollList() {
  try {
    state.board = await api('/api/live');
    for (const m of state.board.matches) {
      const d = state.details.get(m.id);
      // keep the fresher detail score if the list lags behind it
      if (d && Date.parse(d.fetchedAt) > Date.parse(m.fetchedAt)) Object.assign(m, { status: d.status, home: d.home, away: d.away });
      else checkScore(m.id, m);
    }
    state.lastOk = Date.now();
    $('error').hidden = true;
  } catch (e) {
    showError(`Could not load games: ${e.message}`);
  }
  render();
}

let detailBusy = false;
async function pollDetails(only) {
  if (!state.board || (!only && detailBusy)) return;
  if (!only) detailBusy = true;
  const ids = only || state.board.matches
    .filter((m) => m.status.state === 'in' && !state.hidden.has(m.comp)).map((m) => m.id);
  await Promise.all(ids.map(async (id) => {
    try { noteDetail(id, await api(`/api/live?event=${encodeURIComponent(id)}`)); } catch { /* keep the last good one */ }
  }));
  if (ids.length) state.lastOk = Date.now();
  if (!only) detailBusy = false;
  render();
}

// ---------------------------------------------------------------- goal alerts
function renderAlertBtn() {
  const b = $('alertBtn');
  b.classList.toggle('on', state.alerts);
  b.setAttribute('aria-pressed', String(state.alerts));
  b.textContent = state.alerts ? '🔔 Goal alerts on' : '🔕 Goal alerts off';
  b.title = state.alerts
    ? 'A sound and a notification for every goal, in any game shown. Click to turn off.'
    : 'Turn on a sound and a notification for every goal';
}

let audio = null;
function chime() {
  try {
    audio = audio || new (window.AudioContext || window.webkitAudioContext)();
    const t0 = audio.currentTime;
    [[660, 0], [880, 0.14], [1320, 0.28]].forEach(([hz, dt]) => {
      const o = audio.createOscillator();
      const g = audio.createGain();
      o.type = 'triangle';
      o.frequency.value = hz;
      g.gain.setValueAtTime(0.0001, t0 + dt);
      g.gain.exponentialRampToValueAtTime(0.25, t0 + dt + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + dt + 0.35);
      o.connect(g).connect(audio.destination);
      o.start(t0 + dt);
      o.stop(t0 + dt + 0.4);
    });
  } catch { /* no audio */ }
}

function alertGoal(id, m, side) {
  if (!state.alerts || state.hidden.has(m.comp)) return;
  chime();
  if (!('Notification' in window) || Notification.permission !== 'granted') return;
  const t = side === 'home' ? m.home : m.away;
  try {
    const n = new Notification(`⚽ GOAL! ${t.name}`, {
      body: `${m.home.name} ${m.home.goals} – ${m.away.goals} ${m.away.name}${m.status.clock ? ` (${m.status.clock})` : ''}`,
      icon: t.logo || undefined, tag: `goal-${id}`,
    });
    n.onclick = () => { window.focus(); n.close(); };
  } catch { /* some mobile browsers only notify from a service worker */ }
}

$('alertBtn').addEventListener('click', async () => {
  state.alerts = !state.alerts;
  try { localStorage.setItem('live.alerts', state.alerts ? '1' : '0'); } catch { /* private mode */ }
  if (state.alerts) {
    chime(); // also unlocks audio, which browsers allow only after a click
    if ('Notification' in window && Notification.permission === 'default') await Notification.requestPermission();
  }
  renderAlertBtn();
});

function showError(msg) {
  $('error').textContent = msg;
  $('error').hidden = false;
}

document.addEventListener('click', (e) => {
  const t = e.target.closest('button');
  if (!t) return;
  if (t.dataset.open) {
    state.open.add(t.dataset.open);
    render();
    const m = state.board.matches.find((x) => x.id === t.dataset.open);
    if (m && m.status.state !== 'pre') pollDetails([t.dataset.open]);
  } else if (t.dataset.close) {
    state.open.delete(t.dataset.close);
    render();
  } else if (t.dataset.comm) {
    const id = t.dataset.comm;
    if (state.allComm.has(id)) state.allComm.delete(id); else state.allComm.add(id);
    render();
  }
});

$('compFilter').addEventListener('change', (e) => {
  const k = e.target.dataset.comp;
  if (!k) return;
  if (e.target.checked) state.hidden.delete(k); else state.hidden.add(k);
  saveHidden();
  render();
  pollDetails();
});

let timers = [];
function start() {
  stop();
  pollList().then(() => pollDetails());
  timers = [setInterval(pollList, LIST_MS), setInterval(() => pollDetails(), DETAIL_MS), setInterval(tickStatus, 1000)];
}
function stop() { timers.forEach(clearInterval); timers = []; tickStatus(); }
// hidden tab: pause, unless goal alerts are on (browsers may still slow timers in background tabs)
document.addEventListener('visibilitychange', () => {
  if (document.hidden) { if (!state.alerts) stop(); } else start();
});
renderAlertBtn();
start();
