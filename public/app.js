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
async function showBranch() {
  try {
    const v = await api('/api/version');
    $('branchHint').textContent = `Branch: ${v.branch}${v.commit ? ` · ${v.commit}` : ''}`;
    $('branchHint').hidden = false;
  } catch { /* hint is optional */ }
}

async function init() {
  showBranch();
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

// "Next up" strip under the controls: each competition's next match (date + round), soonest
// first; click one to chart that round.
async function loadUpcoming() {
  let data;
  try { data = await api('/api/upcoming'); } catch { return; } // optional strip
  if (!data.items || !data.items.length) return;
  const tomorrow = new Date(`${data.today}T12:00:00Z`);
  tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
  // today / tomorrow: date shown in blue
  const rel = (d) => d === data.today || d === tomorrow.toISOString().slice(0, 10);
  $('upList').replaceChildren(...data.items.map((u) => el('button', {
    type: 'button', class: cls('up-chip', rel(u.date) && 'soon'), title: `${u.name} — ${u.roundWord} ${u.round}, next match ${u.day} ${u.label}`,
  },
  el('span', { class: 'up-date', text: `${u.day} ${u.label}` }),
  el('span', { class: 'up-name', text: u.name.replace(/^UEFA /, '') }),
  el('span', { class: 'up-round', text: `${u.roundWord} ${u.round}` }))));
  [...$('upList').children].forEach((b, i) => b.addEventListener('click', async () => {
    const u = data.items[i];
    $('league').value = u.key;
    await loadRounds(u.round, null);
    buildChart();
  }));
  $('upcoming').hidden = false;
}

async function loadRounds(preferredRound, preferredHistory) {
  const sel = $('round');
  sel.disabled = true;
  $('build').disabled = true;
  setStatus('Loading rounds…');
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  try {
    const data = await api(`/api/rounds?league=${encodeURIComponent($('league').value)}`);
    sel.replaceChildren(...data.rounds.map((r) => {
      // a round whose only unplayed games were rescheduled reads as final, with the moved dates
      const later = (r.movedOpen || []).map((d) => (d ? `${MONTHS[+d.slice(5, 7) - 1]} ${+d.slice(8, 10)}` : 'TBC'));
      const state = r.played === r.total ? 'final'
        : r.open === 0 && later.length ? `final · ${later.length} rescheduled to ${later.join(', ')}`
          : r.played ? `${r.played}/${r.total} played` : 'upcoming';
      return el('option', { value: r.n, text: `${data.roundWord} ${r.n} · ${r.range} · ${state}` });
    }));
    const want = String(preferredRound ?? '');
    sel.value = data.rounds.some((r) => String(r.n) === want) ? want : String(data.defaultRound);

    const hist = $('historyRound');
    const keep = preferredHistory ?? hist.value;
    hist.replaceChildren(el('option', { value: '', text: 'Same as round' }),
      ...Array.from({ length: data.maxRound }, (_, i) => el('option', { value: i + 1, text: `Round ${i + 1}` })));
    hist.value = keep && +keep <= data.maxRound ? String(keep) : '';
    hist.disabled = !data.maxRound; // friendlies have no round history
    $('roundWord').textContent = data.kind === 'intl' ? 'Window' : 'Round';

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
    $('filterBox').hidden = false;
    applyFilter();
    renderLog(data.log);
    const n = data.meta.network;
    const ms = data.meta.elapsedMs;
    setStatus(`Built in ${ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)}s`} · ${n} network request${n === 1 ? '' : 's'}`
      + `${n === 0 ? ' (all from cache)' : ''}${data.meta.refresh ? ' · refreshed' : ''}`);
    if ($('data').value === 'fresh') $('data').value = 'auto'; // one-shot: what was just pulled is now current
    // phones: fold the (multi-line) controls into one summary line so the chart gets the screen
    if (window.matchMedia('(max-width: 700px)').matches) {
      const pick = (id) => $(id).options[$(id).selectedIndex].textContent;
      $('ctlSummary').textContent = `${pick('league')} · ${pick('round').split(' · ')[0]}`;
      document.querySelector('.controls').classList.add('collapsed');
    }
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
$('ctlChange').addEventListener('click', () => document.querySelector('.controls').classList.remove('collapsed'));
$('league').addEventListener('change', () => loadRounds(null, null));
$('round').addEventListener('change', buildChart);
$('historyRound').addEventListener('change', buildChart);

// ------------------------------------------------------------------ chart
const RES = { W: 'res-w', D: 'res-d', L: 'res-l' };
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

function rankCell(v, releg, sep, top = ['1', '2', '3', '4']) {
  if (v === 'PROM') return td('PROM', cls('num prom', sep));
  if (v === 'new') return td('new', cls('num new', sep));
  if (v == null || v === '—') return td('—', cls('num muted', sep));
  const c = top.includes(v) ? 'good b' : releg.includes(v) ? 'bad b' : '';
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

// Goals per game, with the non-penalty rate underneath when the source itemises penalties.
// np: rate excluding penalties; pens: penalty goals in the sample; what: 'scored' | 'conceded';
// sample: e.g. 'last season' or 'last 10 internationals'.
function goalsCell(v, pen, side, sample) {
  if (v == null) return td('—', 'num muted');
  if (!pen) return td(f2(v), 'num');
  const [np, pens, what] = side === 'f' ? [pen.npgfg, pen.pf, 'scored'] : [pen.npgag, pen.pa, 'conceded'];
  const part = pen.n != null && pen.n < pen.of;
  return el('td', {
    class: 'num gp',
    title: `${f2(v)} per game ${what} ${sample}; `
      + `${part ? `of the ${pen.n} games with goal-by-goal records, ` : ''}${pens} from penalties, ${f2(np)} per game excluding them`,
  }, el('div', { text: f2(v) }), el('div', {
    class: cls('np', pens > 0 && 'np-has'), text: `np ${f2(np)} · ${pens}P${part ? ` (${pen.n}/${pen.of})` : ''}`,
  }));
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

// INJURED / SUSP. cells (the repurposed STAR / STATUS columns): count + the two most-used players,
// full list on hover. absent = { inj, susp } or null when there is no source / not applicable.
function absentCells(absent) {
  if (!absent) return [td('—', 'l muted'), td('—', 'l muted')];
  const cell = (list, kind) => {
    if (!list.length) return td('none', 'l muted abs');
    const short = (p) => `${p.name.split(' ').slice(-1)[0]}${p.type === 'doubt' ? '?' : ''}`;
    const shown = list.slice(0, 2).map(short).join(', ') + (list.length > 2 ? ` +${list.length - 2}` : '');
    const tip = list.map((p) => `${p.name}${p.pos ? ` (${p.pos})` : ''} — ${p.type === 'doubt' ? 'doubtful, ' : ''}${p.info || kind}`
      + ` — ${p.apps} apps${p.goals ? `, ${p.goals} G` : ''}${p.ret ? ` — back ${p.ret}` : ''}`).join('\n');
    const key = list.some((p) => p.type !== 'doubt' && p.apps >= 5);
    return el('td', { class: cls('l abs', kind === 'suspended' ? 'abs-susp' : 'abs-inj', key && 'b'), title: `As of ${absent.updated}:\n${tip}` },
      el('span', { class: 'abs-n', text: String(list.length) }), ` ${shown}`);
  };
  return [cell(absent.inj, 'injured'), cell(absent.susp, 'suspended')];
}

// H2H LAST 5 and LAST 10 share one set of columns: the games (newest first), W-D-L, goals
// for-against with a small non-penalty line underneath, and how many of those games the club
// scored 0 / 1 / 2 / 3+ goals in (out of the games shown).
const GOAL_BINS = ['0', '1', '2', '3+'];
const FORM_N_COLS = 3 + GOAL_BINS.length;
const FORM_SUBS = (what) => [
  el('th', { class: 'l sep', text: 'NEWEST →' }), el('th', { text: 'W-D-L' }),
  el('th', { text: 'GF-GA', title: `goals for-against over the ${what}; np line = with penalty goals excluded, then penalties scored-conceded` }),
  ...GOAL_BINS.map((b, k) => el('th', { class: cls('gbin', k === 0 && 'gbin-first'), text: `${b} G`, title: `${what} in which the club scored ${b} goal${b === '1' ? '' : 's'}` })),
];
function formCells(list, { empty = '—', colorGoals = false } = {}) {
  if (!list || !list.length) return [td(empty, 'l muted h2h sep'), ...Array.from({ length: FORM_N_COLS - 1 }, (_, k) => td('—', cls('num muted', k === 2 && 'gbin-first')))];
  const games = el('td', { class: 'l h2h sep' }, list.map((g) => el('span', {
    class: cls('h2h-g', RES[g.o]),
    title: `${g.season ? `${g.season} · ` : ''}${g.date || ''} · ${g.ha === 'H' ? 'home' : g.ha === 'N' ? 'neutral' : 'away'}${g.opp ? ` v ${g.opp}` : ''}`
      + `${g.comp ? ` · ${g.comp}` : ''}${g.pf ? ` · ${g.pf} pen scored` : ''}${g.pa ? ` · ${g.pa} pen conceded` : ''}`,
    text: `${g.o} ${g.gf}-${g.ga}`,
  })));
  const r = [0, 0, 0];
  const bins = [0, 0, 0, 0];
  let gf = 0; let ga = 0; let pf = 0; let pa = 0; let known = 0;
  for (const g of list) {
    r['WDL'.indexOf(g.o)] += 1;
    bins[Math.min(g.gf, 3)] += 1;
    gf += g.gf; ga += g.ga;
    if (g.pf != null && g.pa != null) { pf += g.pf; pa += g.pa; known += 1; }
  }
  const n = list.length;
  const per = (x) => (x / n).toFixed(2);
  // like GF/G: goals on top, a small non-penalty line under them (penalties removed where the game
  // has a record; (k/n) = only k of the n games have one, the rest count with all goals)
  const part = known < n;
  const tone = colorGoals ? (gf > ga ? 'good b' : gf < ga ? 'bad b' : '') : '';
  const gCell = known
    ? el('td', {
      class: 'num gp',
      title: `${n} games: ${gf}-${ga} (${per(gf)} for, ${per(ga)} against per game); `
        + `${part ? `of the ${known} games with penalty records, ` : ''}${pf} penalties scored and ${pa} conceded; `
        + `excluding them ${gf - pf}-${ga - pa} (${per(gf - pf)} for, ${per(ga - pa)} against per game)`,
    }, el('div', { class: tone, text: `${gf}-${ga}` }), el('div', {
      class: cls('np', pf + pa > 0 && 'np-has'), text: `np ${gf - pf}-${ga - pa} · ${pf}-${pa}P${part ? ` (${known}/${n})` : ''}`,
    }))
    : el('td', { class: cls('num', tone), title: `${n} games: ${per(gf)} for, ${per(ga)} against per game; no penalty records` }, `${gf}-${ga}`);
  // goals-scored counts: the most common count in bold, zeros faded
  const top = Math.max(...bins);
  const binCells = bins.map((k, i) => el('td', {
    class: cls('num gp gbin', i === 0 && 'gbin-first'),
    title: `scored ${GOAL_BINS[i]} goal${GOAL_BINS[i] === '1' ? '' : 's'} in ${k} of ${n} games (${Math.round((100 * k) / n)}%)`,
  }, el('div', { class: k === 0 ? 'muted' : k === top ? 'b' : '', text: `${k}/${n}` }),
  el('div', { class: cls('np', k > 0 && 'np-has'), text: `${Math.round((100 * k) / n)}%` })));
  return [games, recCell(r.join('-'), false), gCell, ...binCells];
}
const h2hCells = (h, since) => formCells(h && h.games, { empty: h ? `none since ${since}` : '—', colorGoals: true });
const last5Cells = (list) => formCells(list);

// Form block, one per fixture (spans both team rows), in one set of columns: the home club's
// LAST 10, the away club's LAST 10, then their H2H LAST 5 (shared, so shown once, from the home
// club's side). Matching figures (W-D-L, GF-GA, 0 G … 3+ G) line up vertically; each part keeps its
// own colour classes and tooltip, the cell keeps the column's layout classes.
function fixtureFormCells(fx, since) {
  const [home, away] = fx.teams;
  const parts = [
    { cells: last5Cells(home.last5), tag: 'HOME', tip: `${home.team}: last 10`, cls: 'stk-l10' },
    { cells: last5Cells(away.last5), tag: 'AWAY', tip: `${away.team}: last 10`, cls: 'stk-l10' },
    { cells: h2hCells(home.h2h, since), tag: 'H2H', tip: `${home.team} v ${away.team}: last 5 meetings, from ${home.team}'s side`, cls: 'stk-h2h' },
  ];
  return parts[0].cells.map((first, i) => el('td', { class: cls(first.className, 'stk'), rowspan: 2 }, ...parts.map((p) => {
    const t = p.cells[i];
    const d = el('div', { class: cls('stk-part', p.cls, t.className.replace(/\bsep\b/, '')), title: t.title || (i === 0 ? p.tip : null) });
    // one inner line per part so every part centres the same way (the games column gets its tag)
    const line = el('div', { class: 'stk-line' });
    if (i === 0) line.append(el('span', { class: 'stk-tag', text: p.tag, title: p.tip }));
    if ([...t.childNodes].some((n) => n.nodeType === 1 && n.tagName === 'DIV')) d.append(...t.childNodes);
    else { line.append(...t.childNodes); d.append(line); }
    return d;
  })));
}

// ------------------------------------------------------------------ model (Poisson) column
const pct = (x) => (x == null ? '—' : `${Math.round(100 * x)}%`);
// Which figures came true on a finished game (outlined): win/draw, team 1+ / 2+, BTTS, over 2.5
function hits(r) {
  if (!r) return {};
  return {
    pH: r.hg > r.ag, pD: r.hg === r.ag, pA: r.hg < r.ag, h1: r.hg >= 1, h2: r.hg >= 2, a1: r.ag >= 1, a2: r.ag >= 2,
    btts: r.hg > 0 && r.ag > 0, o25: r.hg + r.ag > 2,
  };
}
const SIDE = { H: ['pH', 'h1', 'h2'], A: ['pA', 'a1', 'a2'] };

// per team: xG, win %, P(scores 1+), P(scores 2+); `hit` outlines the cell that matched the result
function modelTeamCells(p, side, result) {
  if (!p) return [td('—', 'num muted sep'), td('—', 'num muted'), td('—', 'num muted'), td('—', 'num muted')];
  const [xg, win, g1, g2] = side === 'H' ? [p.lh, p.pH, p.h1, p.h2] : [p.la, p.pA, p.a1, p.a2];
  const H = hits(result);
  const [kw, k1, k2] = SIDE[side];
  const hit = H[kw];
  const n = side === 'H' ? p.hN : p.aN;
  const promoted = side === 'H' ? p.hPromoted : p.aPromoted;
  return [
    el('td', { class: 'num sep', title: `expected goals; strength from last season blended with ${n} game(s) this season${promoted ? ' (promoted: starts at last season\'s bottom-three level)' : ''}`, text: xg.toFixed(2) }),
    td(pct(win), cls('num b', win >= 0.5 && 'good', hit && 'm-hit')),
    td(pct(g1), cls('num', H[k1] && 'm-hit')), td(pct(g2), cls('num', H[k2] && 'm-hit')),
  ];
}
// per fixture (rowspan 2): draw, both teams score, over 2.5
function modelFixtureCells(p, result) {
  if (!p) return [td('—', 'num muted', 2), td('—', 'num muted', 2), td('—', 'num muted', 2)];
  const H = hits(result);
  return [td(pct(p.pD), cls('num b', H.pD && 'm-hit'), 2), td(pct(p.btts), cls('num', H.btts && 'm-hit'), 2), td(pct(p.o25), cls('num', H.o25 && 'm-hit'), 2)];
}

// KALSHI / POLYMARKET cells: same figures as the model; amber when ≥5 points from the model
const DIFF = 0.05;
function marketCell(m, key, model, H, rowspan, extra) {
  const v = m ? m[key] : null;
  if (v == null) return td('—', cls('num muted', extra), rowspan);
  const mv = model ? model[key] : null;
  const far = mv != null && Math.abs(v - mv) >= DIFF;
  const when = m.asOf === 'live' ? 'live price' : 'last price before kickoff';
  const title = `${m.source} ${when}: ${pct(v)}${mv != null ? ` · model ${pct(mv)} (${v > mv ? '+' : ''}${Math.round(100 * (v - mv))} pts)` : ''}`;
  return el('td', {
    class: cls('num', extra, key === 'pH' || key === 'pA' || key === 'pD' ? 'b' : '', far && 'm-diff', H[key] && 'm-hit'), rowspan, title, text: pct(v),
  });
}
function marketTeamCells(m, side, model, result) {
  const H = hits(result);
  const [kw, k1, k2] = SIDE[side];
  return [marketCell(m, kw, model, H, null, 'sep'), marketCell(m, k1, model, H), marketCell(m, k2, model, H)];
}
function marketFixtureCells(m, model, result) {
  const H = hits(result);
  return ['pD', 'btts', 'o25'].map((k) => marketCell(m, k, model, H, 2));
}
const MARKETS = [['kalshi', 'KALSHI'], ['poly', 'POLYMARKET']];

// Backtest panel: per season, model vs bookmakers (closing odds) vs base rate; lower Brier = better
function backtestPanel(m) {
  if (!m || !m.backtest) return null;
  const b = m.backtest;
  const f3 = (x) => (x == null ? '—' : x.toFixed(3));
  const best = (vals, v) => (v != null && v === Math.min(...vals.filter((x) => x != null)) ? 'b good' : '');
  const head = el('tr', {}, ...['Season', '', 'Games', 'W/D/L model', 'odds', 'base', 'Top pick model', 'odds',
    'O2.5 model', 'odds', 'base', 'BTTS model', 'base'].map((x) => el('th', { text: x })));
  const rows = b.seasons.map((r) => el('tr', {},
    td(r.season, 'l'), td(r.role, 'l muted'), td(String(r.games), 'num'),
    td(f3(r.brier.model), cls('num', best([r.brier.model, r.brier.market, r.brier.base], r.brier.model))),
    td(f3(r.brier.market), cls('num', best([r.brier.model, r.brier.market, r.brier.base], r.brier.market))),
    td(f3(r.brier.base), 'num muted'),
    td(pct(r.topPick.model), 'num'), td(pct(r.topPick.market), 'num'),
    td(f3(r.over25.model), cls('num', best([r.over25.model, r.over25.market, r.over25.base], r.over25.model))),
    td(f3(r.over25.market), cls('num', best([r.over25.model, r.over25.market, r.over25.base], r.over25.market))),
    td(f3(r.over25.base), 'num muted'),
    td(f3(r.btts.model), cls('num', best([r.btts.model, r.btts.base], r.btts.model))), td(f3(r.btts.base), 'num muted')));
  return el('details', { class: 'notes backtest' }, el('summary', { text: 'Model accuracy (backtest)' }),
    el('p', { class: 'foot', text: `Each game predicted from games on earlier dates only, then scored against the result. Numbers are Brier scores: lower is better; `
      + `"odds" = bookmakers' closing prices with the margin removed, "base" = last season's frequencies. Teams are rated on ${m.params.np ? 'non-penalty' : 'all'} goals. Settings K=${m.params.K}, rho=${m.params.rho}${m.params.shrink != null ? `, shrink=${m.params.shrink}` : ''} were chosen on the `
      + `${b.tuneSeasons.join(' and ')} "tuning" seasons; "test" seasons were not used to choose them. Source: ${b.source}.` }),
    el('div', { class: 'bt-wrap' }, el('table', { class: 'bt' }, el('thead', {}, head), el('tbody', {}, ...rows))));
}

// BTTS drivers panel (test): BTTS rate of past games by the model's 1+ chances (low / medium / high
// bands and the home − away delta), last-10 GF−GA, and last-10 games by goals scored (0G … 3+G)
function driversPanel(d) {
  if (!d || !d.features) return null;
  const { tone, featTable, grid, histCell, result } = btKit(d);
  const F = new Map(d.features.map((f) => [f.key, f]));
  const G = new Map((d.grids || []).map((g) => [g.key, g]));
  const part = (title, note, keys, gridKey) => el('div', { class: 'drv-part' },
    el('h3', { class: 'drv-h', text: title }), el('p', { class: 'drv-note', text: note }),
    el('div', { class: 'drv-row' }, featTable(keys.map((k) => F.get(k)).filter(Boolean)), G.get(gridKey) ? grid(G.get(gridKey)) : null));
  const p0 = (v) => (v == null ? '—' : `${Math.round(v * 100)}%`);
  const sg = (v) => (v == null ? '—' : `${v > 0 ? '+' : ''}${v}`);
  const band = (c) => (c ? c.bucket.split(' ')[0] : '');
  const lmh = (x, k) => {
    const c = x.cells[k];
    if (!c) return td('—', 'muted');
    const cell = histCell(c, `${p0(x.v[k])} `);
    cell.firstChild.append(el('span', { class: cls('drv-band', `drv-${band(c).toLowerCase()}`), text: band(c) }));
    return cell;
  };
  const gd = (x, s) => (x.v[`gf${s}`] == null ? '—' : `${x.v[`gf${s}`]}-${x.v[`ga${s}`]} (${sg(x.v[`gd${s}`])})`);
  const cnt = (x, n) => (x.v[`c${n}h`] == null ? '—' : `${p0(x.v[`c${n}h`] / 10)} · ${p0(x.v[`c${n}a`] / 10)}`);
  const rows = d.round.map((x) => {
    const tones = Object.values(x.cells).filter(Boolean).map((c) => tone(c.rate, c.n));
    const up = tones.filter((t) => t === 'good').length;
    const down = tones.filter((t) => t === 'bad').length;
    return el('tr', {},
      x.moved ? el('td', { class: 'l' }, el('div', { text: x.label }), el('div', { class: 'np np-has moved', text: x.moved })) : td(x.label, 'l'),
      lmh(x, 'h1'), lmh(x, 'a1'), histCell(x.cells.d1, x.cells.d1 && x.cells.d1.text),
      histCell(x.cells.gdh, gd(x, 'h')), histCell(x.cells.gda, gd(x, 'a')), histCell(x.cells.gdgap, x.cells.gdgap && x.cells.gdgap.text),
      histCell(x.cells.c0, cnt(x, 0)), histCell(x.cells.c1, cnt(x, 1)), histCell(x.cells.c2, cnt(x, 2)), histCell(x.cells.c3, cnt(x, 3)),
      el('td', { class: 'drv-sig', title: 'columns whose band ended BTTS 5+ pts above (▲) / below (▼) the base rate' },
        el('span', { class: 'good b', text: `▲${up}` }), ' ', el('span', { class: 'bad b', text: `▼${down}` })),
      result(x));
  });
  const H = [
    ['HOME 1+', 'model · band'], ['AWAY 1+', 'model · band'], ['1+ Δ', 'home − away, pts'],
    ['HOME GF-GA', 'last 10 (GD)'], ['AWAY GF-GA', 'last 10 (GD)'], ['GD GAP', 'between the two'],
    ['0 G', 'home · away'], ['1 G', 'home · away'], ['2 G', 'home · away'], ['3+ G', 'home · away'],
    ['SIGNALS', '▲ above · ▼ below'], ['BTTS?', 'result'],
  ];
  return el('section', { class: 'btts drv' },
    el('h2', { class: 'btts-h' }, 'BTTS drivers (history, test)',
      el('span', { class: 'btts-sub', text: ` — both teams scored in ${pct(d.base)} of ${d.games} past games`
        + `${d.roundShift ? `; fixtures below are ${d.roundLabel}, the last round with every result in` : ''}` })),
    el('details', { class: 'bt-help' }, el('summary', { text: 'How to read this' }), el('p', { class: 'foot', text: 'Every past game is placed in a band by what was known before kickoff, and the bars show how often both teams then scored (rate · games). '
      + 'Green / red = 5+ pts above / below the base rate on ' + `${d.minBucket}+ games; r = correlation with BTTS. `
      + 'MODEL 1+ = the Poisson model\'s chance that a side scores at least once (Low <60%, Medium 60–74%, High 75%+); 1+ Δ = home minus away, in points. '
      + 'GF-GA = goals for and against over the side\'s last 10 league games, GD in brackets. 0 G … 3+ G = share of those 10 games in which the side scored 0, 1, 2, 3+; '
      + 'the BTTS line under a pair uses both sides added (of 20 games). SIGNALS counts this fixture\'s green and red columns.' })),
    part('Model 1+ (goal +1)', 'Each side\'s chance to score, in bands, and the gap between them.', ['h1', 'a1', 'min1', 'd1'], 'lmh'),
    part('Last 10 GF−GA', 'Goal difference over each side\'s last 10, the gap between the two, and how tight the better defence is.', ['gdh', 'gda', 'gdgap', 'gamin'], 'gd'),
    part('Last 10 by goals scored', 'How many of the last 10 each side scored 0, 1, 2, 3+ in.', ['c0max', 'c0', 'c1', 'c2', 'c3'], 'c0'),
    el('div', { class: 'bt-wrap' }, el('table', { class: 'bt btts-round drv-round' },
      el('thead', {}, el('tr', {}, el('th', { class: 'l' }, d.roundLabel || 'This round',
        el('div', { class: 'bt-th2', text: d.roundShift ? 'last complete round' : 'BTTS line = past games like it' })),
        ...H.map(([l, l2]) => el('th', {}, l, el('div', { class: 'bt-th2', text: l2 }))))),
      el('tbody', {}, ...rows))));
}

// BTTS spread: every game played, by the model's home 1+ chance (rows) × away 1+ chance (columns),
// over all seasons or this season; this round's fixtures are outlined in their cells
function spreadPanel(sp) {
  if (!sp || !sp.all || !sp.all.games) return null;
  const MIN = 10; // fewer games: shown grey, not shaded
  const p0 = (v) => (v == null ? '—' : `${Math.round(v * 100)}%`);
  const box = el('div', { class: 'sp-box' });
  const fxAt = (i, j) => sp.fixtures.filter((f) => f.pos && f.pos[0] === i && f.pos[1] === j);
  const draw = (scope) => {
    const g = sp[scope];
    const heat = (c) => {
      if (c.rate == null || c.n < MIN) return '';
      const d = Math.max(-0.2, Math.min(0.2, c.rate - g.base)) / 0.2;
      return d >= 0 ? `background: rgba(26,127,78,${(0.6 * d).toFixed(2)})` : `background: rgba(192,57,43,${(-0.6 * d).toFixed(2)})`;
    };
    const cell = (c, here, cl) => el('td', { class: cls(cl, c.n < MIN && 'muted', here.length && 'sp-here'), style: heat(c),
      title: `${c.n} games${here.length ? ` · this round: ${here.map((f) => f.label).join(', ')}` : ''}` },
    el('div', { class: 'b', text: p0(c.rate) }), el('div', { class: 'bt-n', text: c.n ? String(c.n) : '' }),
    here.length ? el('div', { class: 'sp-tag', text: `◆ ${here.length}` }) : null);
    box.replaceChildren(el('table', { class: 'bt heat sp' },
      el('thead', {}, el('tr', {}, el('th', { text: 'home 1+ ↓ / away 1+ →' }), ...g.labels.map((l) => el('th', { text: l })), el('th', { class: 'sp-tot', text: 'all away' }))),
      el('tbody', {},
        ...g.cells.map((row, i) => el('tr', {}, el('th', { text: g.labels[i] }), ...row.map((c, j) => cell(c, fxAt(i, j))), cell(g.rows[i], [], 'sp-tot'))),
        el('tr', {}, el('th', { class: 'sp-tot', text: 'all home' }), ...g.cols.map((c) => cell(c, [], 'sp-tot')),
          cell({ n: g.games, rate: g.base }, [], 'sp-tot')))));
    drawDelta(g);
    drawFx(scope);
    for (const b of tabs.children) b.classList.toggle('on', b.dataset.scope === scope);
    note.textContent = `${g.games} games, ${g.from}; BTTS in ${p0(g.base)} overall.`;
  };
  // 1+ delta (home − away): BTTS vs no-BTTS games, and the BTTS rate by delta band
  const pts = (v) => { if (v == null) return '—'; const r = Math.round(v * 100) + 0; return `${r >= 0 ? '+' : '−'}${Math.abs(r)}`; };
  const dBox = el('div', { class: 'sp-delta' });
  const drawDelta = (g) => {
    const D = g.delta;
    const g2 = (v) => (v == null ? '—' : v.toFixed(2));
    const tone = (c) => (c.rate == null || c.n < MIN ? '' : c.rate >= g.base + 0.05 ? 'good' : c.rate <= g.base - 0.05 ? 'bad' : '');
    const prof = (name, x, klass) => el('tr', {}, td(name, cls('l b', klass)), td(String(x.n), 'num muted'),
      td(pts(x.median), 'num b'), td(pts(x.mean), 'num'), td(`${pts(x.p25)} to ${pts(x.p75)}`, 'num'), td(pts(x.absMedian).replace('+', ''), 'num'),
      td(p0(x.h1), 'num'), td(p0(x.a1), 'num'));
    const hit = D.bands.findIndex((b, i) => {
      const lo = [-Infinity, -0.295, -0.195, -0.095, -0.005, 0.095, 0.195, 0.295][i];
      const hi = [-0.295, -0.195, -0.095, -0.005, 0.095, 0.195, 0.295, Infinity][i];
      return D.btts.median != null && D.btts.median >= lo && D.btts.median < hi;
    });
    const G = g.goals;
    const sg = (v) => { if (v == null) return '—'; const r = Math.round(v * 100) / 100 + 0; return `${r >= 0 ? '+' : '−'}${Math.abs(r).toFixed(2)}`; };
    const gRow = (name, x, klass) => el('tr', {}, td(name, cls('l b', klass)), td(String(x.n), 'num muted'),
      td(g2(x.hgf), 'num'), td(g2(x.hga), 'num'), td(g2(x.agf), 'num'), td(g2(x.aga), 'num'),
      td(sg(x.gfd.median), 'num b'), td(sg(x.gfd.mean), 'num'), td(`${sg(x.gfd.p25)} to ${sg(x.gfd.p75)}`, 'num'),
      td(sg(x.gad.median), 'num b'), td(sg(x.gad.mean), 'num'), td(`${sg(x.gad.p25)} to ${sg(x.gad.p75)}`, 'num'));
    const bandRow = (title, bs, median) => {
      const at = median == null ? -1 : bs.findIndex((b, i) => [(v) => v <= -1, (v) => v <= -0.5, (v) => v < 0.5, (v) => v < 1, () => true].findIndex((t) => t(median)) === i);
      return [el('div', { class: 'bt-grid-t', text: title }),
        el('div', { class: 'sp-bands' }, ...bs.map((b, i) => el('div', { class: cls('sp-band', i === at && 'sp-here') },
          el('div', { class: 'bt-lab', text: b.label }),
          el('div', { class: cls('bt-bar', tone(b)), title: `${b.n} games` },
            el('span', { class: 'bt-fill', style: `width:${Math.round(100 * (b.rate || 0))}%` }),
            el('span', { class: 'bt-txt', text: b.rate == null ? '—' : `${p0(b.rate)} · ${b.n}` })))))];
    };
    const goalsBlock = G && G.btts.n ? [
      el('div', { class: 'bt-grid-t', text: `Season goals per game before kickoff (both sides ${G.minGp}+ games) — games that ended BTTS vs those that didn't` }),
      el('table', { class: 'bt sp-prof' },
        el('thead', {},
          el('tr', {}, el('th', { class: 'l', rowspan: 2 }), el('th', { rowspan: 2, text: 'Games' }), el('th', { colspan: 4, text: 'Median per game' }),
            el('th', { colspan: 3, text: 'GF/G Δ (home − away)' }), el('th', { colspan: 3, text: 'GA/G Δ (home − away)' })),
          el('tr', {}, ...['Home GF', 'Home GA', 'Away GF', 'Away GA', 'Median', 'Average', 'Middle half', 'Median', 'Average', 'Middle half'].map((l) => el('th', { text: l })))),
        el('tbody', {}, gRow('BTTS', G.btts, 'good'), gRow('No BTTS', G.not, 'bad'))),
      ...bandRow('BTTS rate by season GF/G delta, home − away (rate · games); outlined = the band holding the BTTS median', G.gfBands, G.btts.gfd.median),
      ...bandRow('BTTS rate by season GA/G delta, home − away (rate · games); outlined = the band holding the BTTS median', G.gaBands, G.btts.gad.median),
    ] : [];
    // goals scored in these games, home and away
    const S = g.scored;
    const scoredBlock = S && S.all.n ? (() => {
      const avgRow = (name, x, klass) => el('tr', {}, td(name, cls('l b', klass)), td(String(x.n), 'num muted'),
        td(g2(x.home), 'num b'), td(g2(x.away), 'num b'), td(g2(x.total), 'num'));
      const distRow = (name, d, one) => el('tr', {}, td(name, 'l b'), ...d.map((v) => td(p0(v), 'num')),
        td(p0(one.actual), 'num b'), td(p0(one.model), 'num muted'));
      const maxShare = Math.max(...S.grid.flat().map((c) => c.share || 0));
      return [
        el('div', { class: 'bt-grid-t', text: 'Goals scored in these games — home and away' }),
        el('div', { class: 'drv-row' },
          el('table', { class: 'bt sp-prof' },
            el('thead', {}, el('tr', {}, ...['', 'Games', 'Home goals/G', 'Away goals/G', 'Total/G'].map((l, i) => el('th', { class: i ? '' : 'l', text: l })))),
            el('tbody', {}, avgRow('All games', S.all), avgRow('BTTS', S.btts, 'good'), avgRow('No BTTS', S.not, 'bad'))),
          el('table', { class: 'bt sp-prof' },
            el('thead', {}, el('tr', {}, ...[['', ''], ['0', 'goals'], ['1', 'goal'], ['2', 'goals'], ['3+', 'goals'], ['Scored 1+', 'actual'], ['Model 1+', 'average']]
              .map(([l, l2], i) => el('th', { class: i ? '' : 'l' }, l, l2 ? el('div', { class: 'bt-th2', text: l2 }) : null)))),
            el('tbody', {}, distRow('Home side', S.homeDist, S.home1), distRow('Away side', S.awayDist, S.away1))),
          el('div', { class: 'bt-grid' }, el('div', { class: 'bt-grid-t', text: 'Final score — home goals (rows) × away goals (columns), share of games; outlined = BTTS' }),
            el('table', { class: 'bt heat' },
              el('thead', {}, el('tr', {}, el('th', { text: 'home ↓ / away →' }), ...['0', '1', '2', '3+'].map((l) => el('th', { text: l })))),
              el('tbody', {}, ...S.grid.map((row, h) => el('tr', {}, el('th', { text: h === 3 ? '3+' : String(h) }),
                ...row.map((c, a) => el('td', {
                  class: cls(h > 0 && a > 0 && 'sp-btts'), title: `${c.n} games`,
                  style: c.share ? `background: rgba(43,95,217,${(0.45 * c.share / maxShare).toFixed(2)})` : '',
                }, el('div', { class: 'b', text: p0(c.share) }), el('div', { class: 'bt-n', text: String(c.n) }))))))))),
      ];
    })() : [];
    dBox.replaceChildren(
      ...scoredBlock,
      el('div', { class: 'bt-grid-t', text: '1+ delta (home − away, pts) — games that ended BTTS vs those that didn\'t' }),
      el('table', { class: 'bt sp-prof' },
        el('thead', {}, el('tr', {}, ...[['', ''], ['Games', ''], ['Median Δ', ''], ['Average Δ', ''], ['Middle half', '25th–75th pct'], ['Median gap', 'either way'], ['Median home 1+', ''], ['Median away 1+', '']]
          .map(([l, l2], i) => el('th', { class: i ? '' : 'l' }, l, l2 ? el('div', { class: 'bt-th2', text: l2 }) : null)))),
        el('tbody', {}, prof('BTTS', D.btts, 'good'), prof('No BTTS', D.not, 'bad'))),
      el('div', { class: 'bt-grid-t', text: 'BTTS rate by 1+ delta (rate · games); outlined = the band holding the BTTS median' }),
      el('div', { class: 'sp-bands' }, ...D.bands.map((b, i) => el('div', { class: cls('sp-band', i === hit && 'sp-here') },
        el('div', { class: 'bt-lab', text: b.label }),
        el('div', { class: cls('bt-bar', tone(b)), title: `${b.n} games` },
          el('span', { class: 'bt-fill', style: `width:${Math.round(100 * (b.rate || 0))}%` }),
          el('span', { class: 'bt-txt', text: b.rate == null ? '—' : `${p0(b.rate)} · ${b.n}` }))))),
      ...goalsBlock);
  };
  const tabs = el('div', { class: 'sp-tabs' }, ...[['all', 'All seasons'], ['season', 'This season']].map(([k, l]) =>
    el('button', { type: 'button', 'data-scope': k, text: `${l} (${sp[k].games})` })));
  tabs.addEventListener('click', (ev) => { const b = ev.target.closest('button'); if (b) draw(b.dataset.scope); });
  const note = el('span', { class: 'btts-sub' });
  const rate = (scope, f) => (f.pos ? sp[scope].cells[f.pos[0]][f.pos[1]] : null);
  const fxBody = el('tbody');
  const drawFx = (scope) => fxBody.replaceChildren(...sp.fixtures.map((f) => {
    const both = f.result ? f.result.hg > 0 && f.result.ag > 0 : null;
    const r = (sc) => { const c = rate(sc, f); return c ? td(`${p0(c.rate)} · ${c.n}`, cls('num', c.n < MIN && 'muted')) : td('—', 'muted'); };
    const d = f.h1 != null && f.a1 != null ? f.h1 - f.a1 : null;
    const med = sp[scope].delta.btts.median;
    const sg = (v) => { const r = Math.round(v * 100) / 100 + 0; return `${r >= 0 ? '+' : '−'}${Math.abs(r).toFixed(2)}`; };
    // goals-per-game delta, and under it the distance from the BTTS games' median
    const gd = (v, m) => (v == null ? td('—', 'muted')
      : el('td', { class: 'num' }, el('div', { class: 'b', text: sg(v) }), el('div', { class: 'np', text: m == null ? '' : `${sg(v - m)} vs median` })));
    return el('tr', {}, td(f.label, 'l'), td(p0(f.h1), 'num'), td(p0(f.a1), 'num'),
      td(pts(d), 'num b'), td(d == null || med == null ? '—' : pts(d - med), 'num muted'),
      td(f.hs && f.hs.gp ? `${f.hs.gf}-${f.hs.ga} (${f.hs.gp})` : '—', 'num'), td(f.as && f.as.gp ? `${f.as.gf}-${f.as.ga} (${f.as.gp})` : '—', 'num'),
      gd(f.gfd, sp[scope].goals.btts.gfd.median), gd(f.gad, sp[scope].goals.btts.gad.median),
      td(f.pos ? `${sp.all.labels[f.pos[0]]} × ${sp.all.labels[f.pos[1]]}` : '—', 'num muted'), r('all'), r('season'),
      td(both == null ? '—' : `${both ? 'Yes' : 'No'} · ${f.result.hg}-${f.result.ag}`, cls(both == null ? 'muted' : both ? 'good b' : 'bad b')));
  }));
  const sec = el('section', { class: 'btts drv spread' },
    el('h2', { class: 'btts-h' }, 'BTTS spread — home 1+ × away 1+', el('span', { class: 'btts-sub', text: ' — how often both teams scored, by the model\'s chance of each side scoring' })),
    el('details', { class: 'bt-help' }, el('summary', { text: 'How to read this' }), el('p', { class: 'foot', text: 'Every game played, placed by the MODEL\'s chance (before kickoff) that the home side scores 1+ (rows) and the away side scores 1+ (columns), in 10-point steps: '
      + '"70s" = 70–79%. Each cell = how often both teams then scored, and in how many games. Green / red = above / below the overall rate (darker = further); '
      + `grey = under ${MIN} games. "all home" / "all away" = totals for the row / column. ◆ = this round's fixtures in that cell (listed below). `
      + 'All seasons = league games since the second season with a model prior (backtest model, earlier games only); This season = played games so far, with the MODEL column\'s figures. '
      + '1+ Δ = home 1+ minus away 1+ in points (home 80%, away 70% = +10). The delta table compares games that ended BTTS with those that didn\'t: median, average, the middle half of deltas, '
      + 'and the median gap either way; "vs BTTS median" = how far this fixture\'s delta sits from the BTTS games\' median in the selected scope. '
      + 'Season goals = each side\'s goals for / against per game that season before kickoff (games with both sides 3+ games played); GF/G Δ and GA/G Δ = home minus away, '
      + 'compared the same way, with the BTTS rate by delta band. Goals scored = the final scores of these games: average home / away goals, how often each side scored 0, 1, 2, 3+ '
      + '(and how often it scored at all, beside the model\'s average 1+ chance), and the share of games ending on each score.' })),
    el('div', { class: 'sp-head' }, tabs, note),
    el('div', { class: 'drv-row' }, box,
      el('div', { class: 'bt-wrap' }, el('table', { class: 'bt btts-round sp-fx' },
        el('thead', {}, el('tr', {}, ...[['This round', ''], ['HOME 1+', 'model'], ['AWAY 1+', 'model'], ['1+ Δ', 'home − away'], ['vs BTTS median', 'Δ − median'],
          ['HOME GF-GA', 'season (games)'], ['AWAY GF-GA', 'season (games)'], ['GF/G Δ', 'home − away'], ['GA/G Δ', 'home − away'],
          ['CELL', 'home × away'], ['BTTS', 'all seasons'], ['BTTS', 'this season'], ['BTTS?', 'result']]
          .map(([l, l2], i) => el('th', { class: i ? '' : 'l' }, l, el('div', { class: 'bt-th2', text: l2 }))))),
        fxBody))),
    dBox);
  draw('all');
  return sec;
}

// shared by the BTTS panels: b = a study summary { base, minBucket, features, grids }
function btKit(b) {
  const tone = (rate, n) => (rate == null || n < b.minBucket ? '' : rate >= b.base + 0.05 ? 'good' : rate <= b.base - 0.05 ? 'bad' : '');
  const bar = (rate, n) => el('div', { class: cls('bt-bar', tone(rate, n)), title: `${n} games` },
    el('span', { class: 'bt-fill', style: `width:${Math.round(100 * (rate || 0))}%` }),
    el('span', { class: 'bt-txt', text: rate == null ? '—' : `${pct(rate)} · ${n}` }));
  const r = (x) => (x == null ? '—' : (x >= 0 ? '+' : '') + x.toFixed(3));
  // feature table: one row per feature, BTTS rate per bucket
  const featTable = (features, extra) => {
    const maxB = Math.max(...features.map((f) => f.buckets.length));
    return el('div', { class: 'bt-wrap' }, el('table', { class: cls('bt btts-feat', extra) },
      el('thead', {}, el('tr', {}, el('th', { text: 'Before kickoff' }), el('th', { text: 'r' }), el('th', { text: 'Games' }),
        el('th', { text: 'BTTS rate by bucket (rate · games)', colspan: maxB }))),
      el('tbody', {}, ...features.map((f) => el('tr', {},
        td(f.label, 'l'), td(r(f.r), cls('num', Math.abs(f.r || 0) >= 0.1 && 'b')), td(String(f.n), 'num muted'),
        ...f.buckets.map((k) => el('td', {}, el('div', { class: 'bt-lab', text: k.label }), bar(k.rate, k.n))),
        ...Array.from({ length: maxB - f.buckets.length }, () => td('')))))));
  };
  // heat map: home buckets (rows) × away buckets (columns); shade = distance from the base rate
  const heat = (rate, n) => {
    if (rate == null || n < b.minBucket) return '';
    const d = Math.max(-0.15, Math.min(0.15, rate - b.base)) / 0.15;
    return d >= 0 ? `background: rgba(26,127,78,${(0.6 * d).toFixed(2)})` : `background: rgba(192,57,43,${(-0.6 * d).toFixed(2)})`;
  };
  const grid = (g) => el('div', { class: 'bt-grid' }, el('div', { class: 'bt-grid-t', text: g.label }),
    el('table', { class: 'bt heat' },
      el('thead', {}, el('tr', {}, el('th', { text: 'home ↓ / away →' }), ...g.labels.map((l) => el('th', { text: l })))),
      el('tbody', {}, ...g.cells.map((row, i) => el('tr', {}, el('th', { text: g.labels[i] }),
        ...row.map((c) => el('td', { class: cls(c.n < b.minBucket && 'muted'), style: heat(c.rate, c.n), title: `${c.n} games` },
          el('div', { class: 'b', text: pct(c.rate) }), el('div', { class: 'bt-n', text: String(c.n) }))))))));
  // a round cell: the value, and under it how often past games in the same bucket ended BTTS
  const histCell = (c, text, extra) => (c
    ? el('td', { class: extra, title: `bucket ${c.bucket}: BTTS ${pct(c.rate)} of ${c.n} games` },
      el('div', { class: 'bt-val', text }), el('div', { class: cls('bt-hist', tone(c.rate, c.n)), text: `BTTS ${pct(c.rate)}` }))
    : td('—', 'muted'));
  const result = (x) => {
    const both = x.result ? (x.result.hg > 0 && x.result.ag > 0) : null;
    return td(both == null ? '—' : `${both ? 'Yes' : 'No'} · ${x.result.hg}-${x.result.ag}`, cls(both == null ? 'muted' : both ? 'good b' : 'bad b'));
  };
  return { tone, featTable, grid, histCell, result };
}

// BTTS correlation panel: historic BTTS rate by what was known before kickoff, and where this
// round's fixtures fall. A bucket is coloured when it is 5+ pts off the base rate on enough games.
function bttsPanel(b) {
  if (!b || !b.features) return null;
  const { tone, featTable, grid } = btKit(b);
  const N = b.formN || 5;
  // [key, header, second header line, help]; one format per kind of value: counts "6/10 · 9/10"
  // (home · away), per-game rates "1.40 · 2.00", single figures "0.60", chances "61%"
  const HA = 'home · away';
  const KEYS = [
    ['l5', `LAST ${N} BTTS`, HA, `games with both teams scoring, of each club's last ${N}`],
    ['s1min', `SCORED 1+ L${N}`, HA, `games in which the club scored, of its last ${N}`],
    ['np5min', `NP GF/G L${N}`, HA, `non-penalty goals per game over the last ${N}`],
    ['np5delta', 'NP GF/G GAP', 'between the two', 'difference between the two clubs\' non-penalty goals per game'],
    ['gddelta', 'NP GD/G GAP', 'between the two', 'difference between the two clubs\' non-penalty goal difference per game (a mismatch)'],
    ['h2h', 'H2H BTTS', 'meetings', 'meetings in which both teams scored'],
    ['h2hmin', 'H2H GF/G', HA, 'goals per game in the meetings, home club · away club'],
    ['one', 'BOTH SCORE 1+', 'model', 'model chance each club scores, multiplied'],
    ['xgmin', 'LOWER xG', 'model', 'the lower of the two clubs\' model xG'],
    ['xgsum', 'TOTAL xG', 'model', 'both clubs\' model xG added'],
    ['model', 'MODEL BTTS', 'model', 'the model\'s both-teams-score chance'],
  ];
  const r2 = (v) => (v == null ? '—' : v.toFixed(2));
  const pair = (h, a) => `${h} · ${a}`;
  const SHOW = {
    l5: (x) => pair(`${x.l5h}/${N}`, `${x.l5a}/${N}`),
    s1min: (x) => pair(`${x.s1h}/${N}`, `${x.s1a}/${N}`),
    np5min: (x) => pair(r2(x.np5h), r2(x.np5a)),
    h2h: (x, c) => { const [k, n] = c.text.split('/').map(Number); return `${k}/${n} · ${Math.round((100 * k) / n)}%`; },
    h2hmin: (x) => pair(r2(x.h2hgf), r2(x.h2hga)),
  };
  const grids = (b.grids || []).map(grid);
  const roundRows = b.round.map((x) => {
    const both = x.result ? (x.result.hg > 0 && x.result.ag > 0) : null;
    return el('tr', {},
      td(x.label, 'l'),
      ...KEYS.map(([k]) => {
        const c = x.cells[k];
        if (!c) return td('—', 'muted');
        return el('td', { title: `bucket ${c.bucket}: BTTS ${pct(c.rate)} of ${c.n} games` },
          el('div', { class: 'bt-val', text: SHOW[k] ? SHOW[k](x, c) : c.text }),
          el('div', { class: cls('bt-hist', tone(c.rate, c.n)), text: `BTTS ${pct(c.rate)}` }));
      }),
      td(both == null ? '—' : both ? 'Yes' : 'No', cls(both == null ? 'muted' : both ? 'good b' : 'bad b')));
  });
  // always shown, right under the match table
  return el('section', { class: 'btts' },
    el('h2', { class: 'btts-h' }, 'BTTS correlation (history)',
      el('span', { class: 'btts-sub', text: ` — both teams scored in ${pct(b.base)} of ${b.games} games, ${b.seasons}` })),
    el('details', { class: 'bt-help' }, el('summary', { text: 'How to read this' }), el('p', { class: 'foot', text: 'Each past game is described by what was known before kickoff (earlier games only); bars = how often both teams then scored, with the number of games. '
      + 'r = correlation with BTTS (0 = none, ±1 = perfect; |r| < 0.1 is weak). Green / red = 5+ pts above / below the base rate on '
      + `${b.minBucket}+ games. LAST ${b.formN || 5} = BTTS games in each club's last ${b.formN || 5} ${b.formDesc || 'league games'} (within 12 months); H2H = BTTS share of every ${b.h2hDesc || 'league meeting'} since ${b.h2hFrom} (${b.h2hMin || 3}+ meetings); `
      + `SCORED 1+ = games with a goal in the last ${b.formN || 5}; NP GF/G = non-penalty goals per game over the last ${b.formN || 5}; NP GF/G GAP / NP GD/G GAP = difference between the two sides' `
      + 'non-penalty goals per game / goal difference per game (a mismatch); H2H GF/G = goals per game of the home club · away club over those meetings (all goals); '
      + 'in This round, two values in a cell are home · away, and the BTTS line under each value = how often both teams scored in past games in the same band; '
      + `BOTH 1+ = model chance each team scores, multiplied; xG = the model's expected goals. Heat maps: cells shaded by distance from the base rate; grey = under ${b.minBucket} games. Source: ${b.source}.` })),
    featTable(b.features),
    el('div', { class: 'bt-grids' }, ...grids),
    el('div', { class: 'bt-wrap' }, el('table', { class: 'bt btts-round' },
      el('thead', {}, el('tr', {}, el('th', { class: 'l' }, 'This round', el('div', { class: 'bt-th2', text: 'BTTS line = past games like it' })),
        ...KEYS.map(([, l, l2, help]) => el('th', { title: help }, l, el('div', { class: 'bt-th2', text: l2 }))),
        el('th', {}, 'BTTS?', el('div', { class: 'bt-th2', text: 'result' })))),
      el('tbody', {}, ...roundRows))));
}

// DATE, with a blue note under a rescheduled game ("rescheduled · round Sep 15–17")
function dateCell(fx) {
  if (!fx.moved) return td(fx.date, 'l', 2);
  return el('td', { class: 'l', rowspan: 2, title: 'dated outside its round — rescheduled (weather, cup clash, ...)' },
    el('div', { text: fx.date }), el('div', { class: 'np np-has moved', text: fx.moved }));
}

function twoLine(a, aClass, b, bClass, extra) {
  return el('td', { class: cls('l two', extra), rowspan: 2 }, el('div', { class: aClass, text: a }), el('div', { class: bClass, text: b }));
}

// DOMESTIC group (Champions League): one cell per value, hover for the detail
const domCells = (t, c) => (c.domesticLabels ? (t.domestic || []).map((d, k) => el('td', {
  class: cls('num', k === 0 && 'sep', d.text === '—' && 'muted', d.tone), title: d.title, text: d.text,
})) : []);

function renderChart(c) {
  if (c.kind === 'intl') return renderIntl(c);
  const th = (text, props = {}) => el('th', { rowspan: 2, ...props, text });
  const group = (text, n, extra) => el('th', { colspan: n, class: cls('group', extra), text });
  const subs = (labels) => labels.map((lb, i) => el('th', { class: cls(lb === 'NOW' && 'now', i === 0 && 'sep'), text: lb }));

  const head = el('thead', {},
    el('tr', {},
      th('DAY', { class: 'l' }), th('DATE', { class: 'l' }), th('TIME (PT)', { class: 'l' }), th('TEAM', { class: 'l' }),
      th('H/A'), th('INJURED', { class: 'l' }), th('SUSP.', { class: 'l' }),
      group('STANDING', c.standLabels.length, 'sep'),
      th('GF/G'), th('GA/G'), th('GF/GA'), th('TOT/G'), th(c.lastLabel),
      group(c.histTitle, c.histLabels.length, 'sep'),
      group('SEASON RECORD  W-D-L', c.recLabels.length, 'sep'),
      th('FT / WIN%', { colspan: 2, class: 'sep' }), group('LAST 10 (home, away) · H2H LAST 5', FORM_N_COLS, 'sep'), th('WEATHER', { class: 'l sep' }), th('IMPORTANCE', { class: 'l sep' }),
      ...(c.domesticLabels ? [group('DOMESTIC', c.domesticLabels.length, 'sep')] : []),
      ...(c.model ? [group('MODEL (Poisson)', 7, 'sep'), ...MARKETS.map(([, name]) => group(name, 6, 'sep'))] : []),
      ...(c.extraLabels || []).map((x) => th(x, { class: 'l sep' }))),
    el('tr', { class: 'sub' }, ...subs(c.standLabels), ...subs(c.histLabels), ...subs(c.recLabels),
      ...FORM_SUBS('games'),
      ...(c.domesticLabels || []).map((x, k) => el('th', { class: cls(k === 0 && 'sep'), text: x })),
      ...(c.model ? ['xG', 'WIN', '1+', '2+', 'DRAW', 'BTTS', 'O2.5'].map((x, k) => el('th', { class: cls(k === 0 && 'sep'), text: x })) : []),
      ...(c.model ? MARKETS.flatMap(() => ['WIN', '1+', '2+', 'DRAW', 'BTTS', 'O2.5'].map((x, k) => el('th', {
        class: cls(k === 0 && 'sep'), text: x, title: 'mid of bid/ask; live before kickoff, last price before kickoff once started; amber = ≥5 pts from the model',
      }))) : [])));

  const bodies = c.fixtures.map((fx, i) => el('tbody', {
    class: cls('fx', fx.done ? 'done' : i % 2 === 1 && 'band'), 'data-teams': fx.teams.map((t) => t.team.toLowerCase()).join('|'),
  },
    fx.teams.map((t, ti) => {
      const cells = [];
      if (ti === 0) {
        cells.push(dayCell(fx.day), dateCell(fx), td(fx.time, cls('l', fx.time === '—' && 'muted'), 2));
      }
      cells.push(
        td(t.team, cls('l team', ['1', '2'].includes(t.standing[0]) && 'b')),
        td(t.ha, t.ha === 'H' ? 'ha-h b' : 'ha-a'),
        ...absentCells(t.absent),
        ...t.standing.map((v, k) => rankCell(v, c.releg, k === 0 && 'sep', c.top)),
        goalsCell(t.gfg, t.pen, 'f', c.goalsSample || 'last season'),
        goalsCell(t.gag, t.pen, 'a', c.goalsSample || 'last season'),
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
          ...fixtureFormCells(fx, c.histLabels[0]),
          twoLine(fx.wx[0], cls('wx1', WXC[fx.wx[2]]), fx.wx[1], 'wx2', 'sep'),
          twoLine(IMP[fx.imp[0]][0], cls('imp1', IMP[fx.imp[0]][1]), fx.imp[1], 'imp2', 'sep'),
          ...domCells(t, c),
          ...(c.model ? [...modelTeamCells(fx.pred, 'H', fx.result), ...modelFixtureCells(fx.pred, fx.result),
            ...MARKETS.flatMap(([k]) => [...marketTeamCells(fx[k], 'H', fx.pred, fx.result), ...marketFixtureCells(fx[k], fx.pred, fx.result)])] : []),
          ...(fx.extra || []).map((x) => td(x, 'l b sep', 2)),
        );
      }
      if (ti === 1) {
        cells.push(...domCells(t, c),
          ...(c.model ? [...modelTeamCells(fx.pred, 'A', fx.result), ...MARKETS.flatMap(([k]) => marketTeamCells(fx[k], 'A', fx.pred, fx.result))] : []));
      }
      return el('tr', {}, cells);
    })));

  $('chart').replaceChildren(
    el('h1', { text: c.title }),
    el('p', { class: 'subtitle', text: c.sub }),
    el('div', { class: 'table-wrap' }, el('table', { class: 'match', 'data-lock': 5 }, head, ...bodies)),
    driversPanel(c.btts && c.btts.drivers),
    spreadPanel(c.btts && c.btts.spread),
    bttsPanel(c.btts),
    el('details', { class: 'notes' }, el('summary', { text: 'Notes & sources' }),
      el('p', { class: 'foot', text: c.foot1 }), el('p', { class: 'foot', text: c.foot2 })),
    backtestPanel(c.model),
  );
  $('chart').hidden = false;
  document.title = c.title;
  lockLayout();
}

// ------------------------------------------------------------------ friendlies
function renderIntl(c) {
  const th = (text, props = {}) => el('th', { rowspan: 2, ...props, text });
  const head = el('thead', {},
    el('tr', {},
      th('DAY', { class: 'l' }), th('DATE', { class: 'l' }), th('TIME (PT)', { class: 'l' }), th('VENUE', { class: 'l' }),
      th('TEAM', { class: 'l' }), th('H/A/N'), th('INJURED', { class: 'l' }), th('SUSP.', { class: 'l' }),
      th('GF/G', { class: 'sep' }), th('GA/G'), th('12-MO W-D-L'),
      th('FT', { colspan: 2, class: 'sep' }), el('th', { colspan: FORM_N_COLS, class: 'group sep', text: 'LAST 10 (home, away) · H2H LAST 5' }),
      th('WEATHER', { class: 'l sep' }), th('IMPORTANCE', { class: 'l sep' })),
    el('tr', { class: 'sub' }, ...FORM_SUBS('games')));

  const since = 'records began';
  const bodies = c.fixtures.map((fx, i) => el('tbody', {
    class: cls('fx', i % 2 === 1 && 'band'), 'data-teams': fx.teams.map((t) => t.team.toLowerCase()).join('|'),
  }, fx.teams.map((t, ti) => {
    const cells = [];
    if (ti === 0) {
      cells.push(dayCell(fx.day), dateCell(fx), td(fx.time, 'l muted', 2), td(fx.venue, 'l', 2));
    }
    cells.push(
      td(t.team, 'l team'),
      td(t.ha, t.ha === 'H' ? 'ha-h b' : 'ha-a'),
      ...absentCells(t.absent),
      goalsCell(t.gfg, t.pen, 'f', 'over the last 10 internationals'),
      goalsCell(t.gag, t.pen, 'a', 'over the last 10 internationals'),
      recCell(t.rec12, false),
      resCell(t.res),
    );
    if (ti === 0) cells.push(el('td', { class: 'ft-tag', rowspan: 2 }, el('span', { text: 'FT' })), ...fixtureFormCells(fx, since));
    if (ti === 0) {
      cells.push(td('—', 'l muted sep', 2), td('—', 'l muted sep', 2));
    }
    return el('tr', {}, cells);
  })));

  $('chart').replaceChildren(
    el('h1', { text: c.title }),
    el('p', { class: 'subtitle', text: c.sub }),
    el('div', { class: 'table-wrap' }, el('table', { class: 'match', 'data-lock': 6 }, head, ...bodies)),
    el('details', { class: 'notes' }, el('summary', { text: 'Notes & sources' }),
      el('p', { class: 'foot', text: c.foot1 }), el('p', { class: 'foot', text: c.foot2 })),
  );
  $('chart').hidden = false;
  document.title = c.title;
  lockLayout();
}

// Frozen panes: the header rows stick to the top of the table's scroll box and the first
// data-lock columns (DAY DATE TIME [VENUE] TEAM H/A) stick to its left edge. Cells are mapped to
// logical columns through their rowspans/colspans, and the offsets are measured from the header,
// so this re-runs whenever column widths can change (render, filter, resize).
function lockLayout() {
  const table = $('chart').querySelector('table.match[data-lock]');
  if (!table) return;
  const n = +table.dataset.lock;
  const heads = [...table.tHead.rows[0].cells].slice(0, n);
  const widths = heads.map((th) => th.getBoundingClientRect().width);
  // narrow screens (phones): locking all n would leave no room to scroll, so keep only TEAM and H/A
  const all = widths.reduce((a, w) => a + w, 0);
  const narrow = table.parentElement.clientWidth < 2 * all;
  const locked = narrow ? [n - 2, n - 1] : [...Array(n).keys()];
  const left = {};
  let x = 0;
  for (const c of locked) { left[c] = x; x += widths[c]; }

  const grid = (rows) => {
    const taken = [];
    rows.forEach((tr, r) => {
      let col = 0;
      for (const cell of tr.cells) {
        while (taken[r] && taken[r][col]) col++;
        for (let dr = 0; dr < cell.rowSpan; dr++) {
          for (let dc = 0; dc < cell.colSpan; dc++) {
            taken[r + dr] = taken[r + dr] || [];
            taken[r + dr][col + dc] = true;
          }
        }
        const on = cell.colSpan === 1 && col in left;
        cell.classList.toggle('lock', on);
        cell.classList.toggle('lock-last', on && col === n - 1);
        cell.style.left = on ? `${left[col]}px` : '';
        col += cell.colSpan;
      }
    });
  };
  grid([...table.tHead.rows]);
  for (const tb of table.tBodies) grid([...tb.rows]);

  const top1 = table.tHead.rows[0].getBoundingClientRect().height;
  for (const th of table.tHead.rows[0].cells) th.style.top = '0px';
  if (table.tHead.rows[1]) for (const th of table.tHead.rows[1].cells) th.style.top = `${top1}px`;
  followHead();
}
window.addEventListener('resize', lockLayout);

// The page scrolls (the table shows every row), so the table's box only scrolls sideways — and a
// box that scrolls sideways can't keep a sticky header in view while the page moves. Instead the
// header rows are shifted down by however far the table's top has scrolled above the window,
// stopping just before its last rows.
function followHead() {
  const table = $('chart').querySelector('table.match');
  if (!table || !table.tHead) return;
  const wrap = table.parentElement;
  const r = wrap.getBoundingClientRect();
  const hh = table.tHead.getBoundingClientRect().height;
  const off = Math.max(0, Math.min(-r.top, r.height - hh - 60));
  for (const row of table.tHead.rows) for (const th of row.cells) th.style.transform = off ? `translateY(${off}px)` : '';
}
window.addEventListener('scroll', followHead, { passive: true });

// Team filter: hides fixtures whose teams don't match (all chart types).
function applyFilter() {
  const f = $('filter').value.trim().toLowerCase();
  for (const tb of $('chart').querySelectorAll('tbody[data-teams]')) {
    tb.hidden = !!f && !tb.dataset.teams.includes(f);
  }
  lockLayout();
}
$('filter').addEventListener('input', applyFilter);

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
loadUpcoming();
