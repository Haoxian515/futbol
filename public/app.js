'use strict';
// UI: dropdowns (league / round / history round / cached-or-fresh data) and the chart renderer.
// All cell colouring follows the chart spec (§7); data arrives pre-computed from /api/chart.

const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);
let building = false;

function el(tag, props = {}, ...children) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v == null || v === false) continue;
    if (k === 'class') n.className = v;
    else if (k === 'text') n.textContent = v;
    else n.setAttribute(k, v === true ? '' : String(v));
  }
  for (const c of children.flat()) if (c != null) n.append(c);
  return n;
}

async function api(url) {
  const r = await fetch(url);
  let body;
  try { body = await r.json(); } catch { body = { error: `HTTP ${r.status}` }; }
  if (!r.ok) {
    const err = new Error(body.error || `HTTP ${r.status}`);
    err.body = body;
    throw err;
  }
  return body;
}

const setStatus = (t) => { $('status').textContent = t; };
function showError(msg) { $('error').textContent = msg; $('error').hidden = false; }
function hideError() { $('error').hidden = true; }

// ------------------------------------------------------------------ controls
async function init() {
  try {
    const leagues = await api('/api/leagues');
    $('league').replaceChildren(...leagues.map((l) => el('option', { value: l.key, text: l.name })));
    if (leagues.some((l) => l.key === params.get('league'))) $('league').value = params.get('league');
    await loadRounds(params.get('round'), params.get('historyRound'));
    if (params.get('round')) buildChart();
  } catch (e) {
    showError(`Could not reach the server: ${e.message}`);
  }
}

async function loadRounds(preferredRound, preferredHistory) {
  const sel = $('round');
  sel.disabled = true;
  $('build').disabled = true;
  setStatus('Loading rounds…');
  try {
    const data = await api(`/api/rounds?league=${encodeURIComponent($('league').value)}`);
    sel.replaceChildren(...data.rounds.map((r) => {
      const state = r.played === r.total ? 'final' : r.played ? `${r.played}/${r.total} played` : 'upcoming';
      return el('option', { value: r.n, text: `${data.roundWord} ${r.n} · ${r.range} · ${state}` });
    }));
    const want = String(preferredRound ?? '');
    sel.value = data.rounds.some((r) => String(r.n) === want) ? want : String(data.defaultRound);

    const hist = $('historyRound');
    const keep = preferredHistory ?? hist.value;
    hist.replaceChildren(el('option', { value: '', text: 'Same as round' }),
      ...Array.from({ length: data.maxRound }, (_, i) => el('option', { value: i + 1, text: `Round ${i + 1}` })));
    hist.value = keep && +keep <= data.maxRound ? String(keep) : '';

    sel.disabled = false;
    $('build').disabled = false;
    setStatus(`${data.name} ${data.season}`);
  } catch (e) {
    showError(`Could not load rounds: ${e.message}`);
    setStatus('');
  }
}

async function buildChart() {
  if (building || $('round').disabled) return;
  building = true;
  const league = $('league').value;
  const round = $('round').value;
  const historyRound = $('historyRound').value;
  const mode = $('data').value;
  const refresh = mode === 'fresh';

  const shown = new URLSearchParams({ league, round });
  if (historyRound) shown.set('historyRound', historyRound);
  history.replaceState(null, '', `?${shown}`);
  const qs = new URLSearchParams(shown);
  qs.set('data', mode);

  $('build').disabled = true;
  hideError();
  const t0 = performance.now();
  const tick = () => setStatus(`Building… ${Math.round((performance.now() - t0) / 1000)}s${refresh ? ' (re-fetching every source)' : ''}`);
  tick();
  const timer = setInterval(tick, 500);
  try {
    const data = await api(`/api/chart?${qs}`);
    renderChart(data.chart);
    renderLog(data.log);
    const n = data.meta.network;
    const ms = data.meta.elapsedMs;
    setStatus(`Built in ${ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)}s`} · ${n} network request${n === 1 ? '' : 's'}`
      + `${n === 0 ? ' (all from cache)' : ''}${data.meta.refresh ? ' · refreshed' : ''}`);
    $('data').value = 'cache'; // one-shot: what was just pulled is now the cache
  } catch (e) {
    showError(e.message);
    if (e.body && e.body.log) renderLog(e.body.log);
    setStatus('');
  } finally {
    clearInterval(timer);
    $('build').disabled = false;
    building = false;
  }
}

$('controls').addEventListener('submit', (ev) => { ev.preventDefault(); buildChart(); });
$('league').addEventListener('change', () => loadRounds(null, null));
$('round').addEventListener('change', buildChart);
$('historyRound').addEventListener('change', buildChart);

// ------------------------------------------------------------------ chart
const RES = { W: 'res-w', D: 'res-d', L: 'res-l' };
const STAT = { fit: ['fit', 'st-fit'], 'exp.': ['exp.', 'st-exp'], eased: ['eased', 'st-exp'], out: ['OUT', 'st-out'], '—': ['—', 'muted'] };
const IMP = { high: ['HIGH', 'imp-high'], modhi: ['MOD-HI', 'imp-modhi'], mod: ['MOD', 'imp-mod'], low: ['LOW', 'imp-low'] };
const WXC = { wet: 'wx-wet', mix: 'wx-mix', dry: 'wx-dry', hot: 'wx-hot', tbc: 'wx-tbc' };
const f2 = (v) => (v == null ? '—' : v.toFixed(2));
const cls = (...xs) => xs.filter(Boolean).join(' ');
const td = (text, className, rowspan) => el('td', { class: className, rowspan, text });

function dayCell(d) {
  const c = ['FRI', 'THU'].includes(d) ? 'day-purp' : ['SUN', 'MON'].includes(d) ? 'day-acc'
    : d === 'SAT' || d === '—' ? 'muted' : 'muted b';
  return td(d, cls('l', c), 2);
}

function rankCell(v, releg, sep) {
  if (v === 'PROM') return td('PROM', cls('num prom', sep));
  if (v === 'new') return td('new', cls('num new', sep));
  if (v == null || v === '—') return td('—', cls('num muted', sep));
  const c = ['1', '2', '3', '4'].includes(v) ? 'good b' : releg.includes(v) ? 'bad b' : '';
  return td(v, cls('num big', c, sep));
}

function histCell(v, sep) {
  if (v === 'new') return td('new', cls('num new', sep));
  if (RES[v]) return td(v, cls('num big', RES[v], sep));
  return td('—', cls('num big muted', sep));
}

function recCell(v, sep) {
  if (v === 'new') return td('new', cls('num new', sep));
  if (v == null || v === '—') return td('—', cls('num muted', sep));
  const [w, , l] = v.split('-').map(Number);
  const c = w > 0 && l === 0 ? 'good b' : w === 0 && l > 0 ? 'bad b' : '';
  return td(v, cls('num rec', c, sep));
}

function ratioCell(r) {
  const c = r == null ? 'muted' : r >= 1.3 ? 'good b' : r >= 1.0 ? 'good' : r >= 0.9 ? '' : 'bad b';
  return td(f2(r), cls('num big', c));
}

function totalCell(t) {
  const c = t == null ? 'muted' : t >= 3.0 ? 'bad b' : t <= 2.5 ? 'good b' : '';
  return td(f2(t), cls('num', c));
}

// rounds exact .5 ties to even, matching the Python chart tool
function fmt0(x) {
  const f = Math.floor(x);
  const diff = x - f;
  return String(diff > 0.5 ? f + 1 : diff < 0.5 ? f : (f % 2 === 0 ? f : f + 1));
}

function resCell(res) {
  if (res.kind === 'ft') return td(res.text, cls('num big sep', RES[res.outcome]));
  if (res.pct == null) return td('—', 'num big muted sep');
  return td(`${fmt0(res.pct)}%`, cls('num big sep', res.pct >= 50 && 'good', res.pct >= 55 && 'b'));
}

function h2hCells(h, since) {
  if (!h) return [td('—', 'l muted sep'), td('—', 'num muted')];
  if (!h.games.length) return [td(`none since ${since}`, 'l muted h2h sep'), td('—', 'num muted')];
  const games = el('td', { class: 'l h2h sep' }, h.games.map((g) => el('span', {
    class: cls('h2h-g', RES[g.o]),
    title: `${g.season}${g.date ? ` · ${g.date}` : ''} · ${g.ha === 'H' ? 'home' : 'away'}`,
    text: `${g.o} ${g.gf}-${g.ga}`,
  })));
  const c = h.gf > h.ga ? 'good b' : h.gf < h.ga ? 'bad b' : '';
  return [games, td(`${h.gf}-${h.ga}`, cls('num big', c))];
}

function twoLine(a, aClass, b, bClass, extra) {
  return el('td', { class: cls('l two', extra), rowspan: 2 }, el('div', { class: aClass, text: a }), el('div', { class: bClass, text: b }));
}

function renderChart(c) {
  const th = (text, props = {}) => el('th', { rowspan: 2, ...props, text });
  const group = (text, n, extra) => el('th', { colspan: n, class: cls('group', extra), text });
  const subs = (labels) => labels.map((lb, i) => el('th', { class: cls(lb === 'NOW' && 'now', i === 0 && 'sep'), text: lb }));

  const head = el('thead', {},
    el('tr', {},
      th('DAY', { class: 'l' }), th('DATE', { class: 'l' }), th('TIME', { class: 'l' }), th('TEAM', { class: 'l' }),
      th('H/A'), th('STAR', { class: 'l' }), th('STATUS'),
      group('STANDING', 4, 'sep'),
      th('GF/G'), th('GA/G'), th('GF/GA'), th('TOT/G'), th(c.lastLabel),
      group(c.histTitle, 4, 'sep'),
      group('SEASON RECORD  W-D-L', 5, 'sep'),
      th('FT / WIN%', { colspan: 2, class: 'sep' }), group('H2H LAST 5', 2, 'sep'), th('WEATHER', { class: 'l sep' }), th('IMPORTANCE', { class: 'l sep' })),
    el('tr', { class: 'sub' }, ...subs(c.standLabels), ...subs(c.histLabels), ...subs(c.recLabels),
      el('th', { class: 'l sep', text: 'NEWEST →' }), el('th', { text: 'GF-GA' })));

  const bodies = c.fixtures.map((fx, i) => el('tbody', { class: cls('fx', fx.done ? 'done' : i % 2 === 1 && 'band') },
    fx.teams.map((t, ti) => {
      const cells = [];
      if (ti === 0) {
        cells.push(dayCell(fx.day), td(fx.date, 'l', 2), td(fx.time, cls('l', fx.time === '—' && 'muted'), 2));
      }
      const st = STAT[t.status] || STAT['—'];
      cells.push(
        td(t.team, cls('l team', ['1', '2'].includes(t.standing[0]) && 'b')),
        td(t.ha, t.ha === 'H' ? 'ha-h b' : 'ha-a'),
        td(t.star, cls('l', t.star === '—' && 'muted')),
        td(st[0], st[1]),
        ...t.standing.map((v, k) => rankCell(v, c.releg, k === 0 && 'sep')),
        td(f2(t.gfg), cls('num', t.gfg == null && 'muted')),
        td(f2(t.gag), cls('num', t.gag == null && 'muted')),
        ratioCell(t.ratio),
        totalCell(t.total),
        td(t.last, cls('num', RES[t.lastOutcome] || 'muted')),
        ...t.hist.map((v, k) => histCell(v, k === 0 && 'sep')),
        ...t.records.map((v, k) => recCell(v, k === 0 && 'sep')),
        resCell(t.res),
      );
      if (ti === 0) {
        cells.push(
          el('td', { class: 'ft-tag', rowspan: 2 }, fx.done ? el('span', { text: 'FT' }) : null),
          ...h2hCells(t.h2h, c.histLabels[0]),
          twoLine(fx.wx[0], cls('wx1', WXC[fx.wx[2]]), fx.wx[1], 'wx2', 'sep'),
          twoLine(IMP[fx.imp[0]][0], cls('imp1', IMP[fx.imp[0]][1]), fx.imp[1], 'imp2', 'sep'),
        );
      }
      if (ti === 1) cells.push(...h2hCells(t.h2h, c.histLabels[0]));
      return el('tr', {}, cells);
    })));

  $('chart').replaceChildren(
    el('h1', { text: c.title }),
    el('p', { class: 'subtitle', text: c.sub }),
    el('div', { class: 'table-wrap' }, el('table', { class: 'match' }, head, ...bodies)),
    el('p', { class: 'foot', text: c.foot1 }),
    el('p', { class: 'foot', text: c.foot2 }),
  );
  $('chart').hidden = false;
  document.title = c.title;
}

// ------------------------------------------------------------------ run log
function howClass(how) {
  if (how.startsWith('network')) return 'how-net';
  if (how.startsWith('STALE') || how.startsWith('FAILED')) return 'how-bad';
  return 'how-cache';
}

function renderLog(log) {
  const section = (title, items, render) => (items.length
    ? el('section', {}, el('h3', { text: title }), el('ul', {}, items.map(render)))
    : null);
  $('logBody').replaceChildren(
    el('p', { class: 'log-head', text: log.header }),
    section(`Sources (${log.sources.length})`, log.sources,
      (s) => el('li', {}, el('span', { class: cls('how', howClass(s.how)), text: s.how }), ' ', el('code', { text: s.url }))),
    section('Notes', log.notes, (n) => el('li', { text: n })),
    section('Cells shown as —/TBC/new, and why', log.cells,
      (x) => el('li', {}, el('b', { text: `${x.field}: ` }), x.reason,
        x.items.length ? el('span', { class: 'items', text: ` [${x.items.join(', ')}]` }) : null)),
    section('Warnings', log.warnings, (w) => el('li', { class: 'warn', text: w })),
  );
  $('log').hidden = false;
}

init();
