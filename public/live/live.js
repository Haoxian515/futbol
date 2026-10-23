'use strict';
// /live/: every game in play across the charted competitions, side by side, each updating on
// its own. The list of games comes from /api/live (every LIST_MS); each game in play polls
// /api/live?event=ID for goals, stats and commentary (every DETAIL_MS), all in parallel.
// Polling pauses while the tab is hidden and catches up as soon as it is visible again.

const LIST_MS = 20000;
const DETAIL_MS = 10000;
const COMM_SHORT = 6;
const TZ = 'America/Los_Angeles';

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const state = {
  board: null,
  details: new Map(), // id -> match detail
  score: new Map(), // id -> "h-a" last seen, to spot new goals
  flash: new Map(), // id -> {until, side}
  seen: new Map(), // id -> Set of commentary ids already shown (new ones get highlighted)
  fresh: new Map(), // id -> Set of commentary ids that arrived on the latest poll
  open: new Set(), // finished / upcoming games expanded into a card
  allComm: new Set(), // cards showing the full commentary
  hidden: loadHidden(), // competitions switched off in the filter
  lastOk: null,
};

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
function goalList(list) {
  if (!list || !list.length) return '';
  return `<ul class="goals">${list.map((g) => `<li><span class="min">${esc(g.minute)}</span><span>${esc(g.player || 'Goal')}${MARK[g.kind] || ''}</span></li>`).join('')}</ul>`;
}
function reds(d, side) {
  const r = (d.events || []).filter((e) => e.kind === 'red' && e.side === side);
  return r.length ? `<ul class="reds">${r.map((e) => `<li><span class="min"><span class="card-red"></span>${esc(e.minute)}</span><span>${esc(e.player)}</span></li>`).join('')}</ul>` : '';
}

function teamCell(t, side, d) {
  if (!t) return `<div class="team ${side}">—</div>`;
  const logo = t.logo ? `<img src="${esc(t.logo)}" alt="" width="28" height="28" loading="lazy">` : '';
  return `<div class="team ${side}">
    <div class="tname">${logo}<span>${esc(t.name)}</span></div>
    ${d ? goalList(d.goals && d.goals[side]) + reds(d, side) : ''}
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

function card(m) {
  const d = state.details.get(m.id);
  const f = state.flash.get(m.id);
  const flashing = f && f.until > Date.now();
  const closable = m.status.state !== 'in';
  return `<article class="mcard${flashing ? ' goal-flash' : ''}" data-id="${esc(m.id)}">
    <header class="mhead">
      <span class="comp">${esc(m.compName)}</span>
      ${statusChip(m)}
      ${closable ? `<button type="button" class="linkbtn close" data-close="${esc(m.id)}" aria-label="Close">✕</button>` : ''}
    </header>
    ${flashing ? `<div class="goal-banner">GOAL — ${esc((f.side === 'home' ? m.home : m.away).name)}</div>` : ''}
    <div class="score-row">
      ${teamCell(m.home, 'home', d)}
      <div class="score"><span class="g h">${goalsText(m.home && m.home.goals)}</span><span class="dash">–</span><span class="g a">${goalsText(m.away && m.away.goals)}</span>
        ${m.home && m.home.shootout != null ? `<div class="pens">pens ${m.home.shootout}–${m.away.shootout}</div>` : ''}</div>
      ${teamCell(m.away, 'away', d)}
    </div>
    ${d ? `<details class="sect" open><summary>Stats</summary>${statRows(d.stats)}</details>
      <details class="sect" open><summary>Commentary</summary>${commentary(m.id, d)}</details>
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
  document.title = live.length ? `(${live.length}) Live Matches` : 'Live Matches';
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
  $('liveStatus').textContent = document.hidden ? 'Paused' : `Updated ${s < 2 ? 'just now' : `${s}s ago`}`;
}

function noteDetail(id, d) {
  const prev = state.score.get(id);
  const now = `${d.home && d.home.goals}-${d.away && d.away.goals}`;
  if (prev && prev !== now && d.status.state === 'in') {
    const [ph, pa] = prev.split('-').map(Number);
    const side = d.home.goals > ph ? 'home' : d.away.goals > pa ? 'away' : null;
    if (side) state.flash.set(id, { until: Date.now() + 20000, side });
  }
  state.score.set(id, now);
  const seen = state.seen.get(id);
  const ids = new Set((d.commentary || []).map((c) => c.id));
  state.fresh.set(id, seen ? new Set([...ids].filter((x) => !seen.has(x))) : new Set());
  state.seen.set(id, ids);
  state.details.set(id, d);
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
      else if (!state.score.has(m.id) && m.status.state === 'in') state.score.set(m.id, `${m.home.goals}-${m.away.goals}`);
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
document.addEventListener('visibilitychange', () => (document.hidden ? stop() : start()));
start();
