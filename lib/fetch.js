'use strict';
// Cached HTTP + parsers for each source.
//
// Cache layout is shared with the Python tool (src/fetch.py): data/cache/<slug>__<sha1[:10]>.body
// plus .meta.json {url, status, fetched_at (epoch seconds), fetched_at_iso}. 404/410 answers are
// cached too, so a missing season file costs no request on re-runs. Parsed results are memoised in
// <base>.parsed.node.json (separate from Python's .parsed.json so the two never fight).

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');
const cheerio = require('cheerio');
const { validIso } = require('./time');

const ROOT = path.resolve(__dirname, '..');
const CACHE_DIR = path.join(ROOT, 'data', 'cache');
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';
const PARSER_VERSION = 2;
const MISSING = new Set([404, 410]);
const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
const DAYS = 'Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday';

const mask = (url) => url.replace(/(apiKey=)[^&]+/, '$1***');

function ageLabel(hours) {
  if (hours < 1) return `${Math.round(hours * 60)}m`;
  if (hours < 48) return `${hours.toFixed(1)}h`;
  return `${Math.round(hours / 24)}d`;
}

function cachePaths(url) {
  const m = mask(url);
  const stem = m.replace(/^https?:\/\/(www\.)?/, '');
  const slug = stem.split('?')[0].replace(/[^A-Za-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 80);
  const h = crypto.createHash('sha1').update(m, 'utf8').digest('hex').slice(0, 10);
  const base = path.join(CACHE_DIR, `${slug}__${h}`);
  return { body: `${base}.body`, meta: `${base}.meta.json`, parsed: `${base}.parsed.node.json` };
}

function writeMeta(file, url, status) {
  const now = Date.now();
  const local = new Date(now - new Date(now).getTimezoneOffset() * 60000).toISOString().slice(0, 19);
  fs.writeFileSync(file, JSON.stringify({ url: mask(url), status, fetched_at: now / 1000, fetched_at_iso: local }, null, 1));
}

// Some hosts (NBC) reset non-browser TLS clients but serve curl fine.
function curl(url) {
  return new Promise((resolve, reject) => {
    execFile('curl', ['-s', '-L', '--max-time', '40', '-A', UA, '-H', 'Accept-Language: en-US,en;q=0.9',
      '-w', '\n%{http_code}', url], { encoding: 'buffer', maxBuffer: 64 * 1024 * 1024, timeout: 60000 },
    (err, stdout) => {
      if (err && !(stdout && stdout.length)) return reject(err);
      const out = stdout.toString('utf8');
      const i = out.lastIndexOf('\n');
      resolve({ status: parseInt(out.slice(i + 1), 10) || null, text: out.slice(0, i) });
    });
  });
}

class Fetcher {
  constructor({ refresh = false } = {}) {
    this.refresh = refresh;
    this.sources = [];
    this.network = 0;
    this.inflight = new Map(); // per-run memo: one download/parse per URL even when requested concurrently
    fs.mkdirSync(CACHE_DIR, { recursive: true });
  }

  note(url, how) {
    const u = mask(url);
    if (!this.sources.some((s) => s.url === u)) this.sources.push({ url: u, how });
  }

  async download(url) {
    this.network += 1;
    try {
      const r = await fetch(url, {
        headers: {
          'User-Agent': UA, 'Accept-Language': 'en-US,en;q=0.9',
          Accept: 'text/html,application/xhtml+xml,application/json,text/csv;q=0.9,*/*;q=0.8',
        },
        signal: AbortSignal.timeout(40000),
      });
      return { status: r.status, text: Buffer.from(await r.arrayBuffer()).toString('utf8') };
    } catch (e) {
      try {
        return await curl(url);
      } catch (e2) {
        return { status: null, text: null, err: `${e.name} / curl ${e2.code || e2.message}` };
      }
    }
  }

  get(url, ttlHours) {
    const key = `get|${url}`;
    if (!this.inflight.has(key)) this.inflight.set(key, this.#get(url, ttlHours));
    return this.inflight.get(key);
  }

  async #get(url, ttlHours) {
    const p = cachePaths(url);
    let meta = null;
    try { meta = JSON.parse(fs.readFileSync(p.meta, 'utf8')); } catch { meta = null; }
    const age = meta ? (Date.now() / 1000 - meta.fetched_at) / 3600 : null;
    const haveBody = !!meta && meta.status === 200 && fs.existsSync(p.body);
    if (meta && !this.refresh && age < ttlHours) {
      if (haveBody) {
        this.note(url, `cache ${ageLabel(age)}`);
        return fs.readFileSync(p.body, 'utf8');
      }
      if (MISSING.has(meta.status)) {
        this.note(url, `cache ${ageLabel(age)}: HTTP ${meta.status}`);
        return null;
      }
    }
    const { status, text, err } = await this.download(url);
    if (status === 200 && text) {
      fs.writeFileSync(p.body, text, 'utf8');
      writeMeta(p.meta, url, 200);
      this.note(url, 'network');
      return text;
    }
    if (MISSING.has(status)) {
      writeMeta(p.meta, url, status);
      this.note(url, `network: HTTP ${status}`);
      return null;
    }
    if (haveBody) {
      this.note(url, `STALE cache ${ageLabel(age)} (refetch failed: ${status || err})`);
      return fs.readFileSync(p.body, 'utf8');
    }
    this.note(url, `FAILED: ${status || err}`);
    return null;
  }

  async getJson(url, ttlHours) {
    const text = await this.get(url, ttlHours);
    if (text == null) return null;
    try { return JSON.parse(text); } catch { return null; }
  }

  getParsed(url, ttlHours, parser, ...args) {
    const key = `parsed|${url}|${parser.name}|${JSON.stringify(args)}`;
    if (!this.inflight.has(key)) this.inflight.set(key, this.#getParsed(url, ttlHours, parser, args));
    return this.inflight.get(key);
  }

  async #getParsed(url, ttlHours, parser, args) {
    const text = await this.get(url, ttlHours);
    if (text == null) return null;
    const p = cachePaths(url);
    let mtime = 0;
    try { mtime = fs.statSync(p.body).mtimeMs; } catch { /* body only exists for cached 200s */ }
    const key = `${parser.name}:${PARSER_VERSION}:${mtime}:${JSON.stringify(args)}`;
    try {
      const d = JSON.parse(fs.readFileSync(p.parsed, 'utf8'));
      if (d.key === key) return d.data;
    } catch { /* no memo yet */ }
    const data = parser(text, ...args);
    fs.writeFileSync(p.parsed, JSON.stringify({ key, data }), 'utf8');
    return data;
  }
}

// ---------------------------------------------------------------- helpers
function textLines(html) {
  const $ = cheerio.load(html);
  $('script, style, noscript, template').remove();
  const out = [];
  const walk = (nodes) => {
    for (const n of nodes) {
      if (n.type === 'text') out.push(n.data);
      else if (n.children) walk(n.children);
    }
  };
  walk($.root().get(0).children);
  return out.join('\n').split('\n').map((s) => s.trim()).filter(Boolean);
}

const clock = (h, mi, ampm) => {
  const hh = (+h % 12) + (ampm.toLowerCase() === 'pm' ? 12 : 0);
  return `${String(hh).padStart(2, '0')}:${String(+(mi || 0)).padStart(2, '0')}`;
};

function strictInt(v) {
  const s = String(v ?? '').trim();
  if (!/^[+-]?\d+$/.test(s)) throw new Error(`not an integer: '${s}'`);
  return parseInt(s, 10);
}

function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; } else quoted = false;
      } else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') { row.push(field); field = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(field); rows.push(row); row = []; field = '';
    } else field += ch;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows.filter((r) => !(r.length === 1 && r[0] === ''));
}

// ---------------------------------------------------------------- lastseason.co.uk
function parseSeasonCsv(text) {
  const rows = parseCsv(text.replace(/^﻿/, ''));
  const hdr = (rows[0] || []).map((h) => h.trim());
  const need = ['position', 'club', 'played', 'wins', 'draws', 'losses', 'goals_for', 'goals_against', 'points'];
  if (!need.every((n) => hdr.includes(n))) throw new Error('unexpected CSV header');
  const ix = Object.fromEntries(hdr.map((h, i) => [h, i]));
  return rows.slice(1).map((r) => ({
    pos: strictInt(r[ix.position]), club: r[ix.club].trim(), P: strictInt(r[ix.played]), W: strictInt(r[ix.wins]),
    D: strictInt(r[ix.draws]), L: strictInt(r[ix.losses]), GF: strictInt(r[ix.goals_for]),
    GA: strictInt(r[ix.goals_against]), Pts: strictInt(r[ix.points]),
  }));
}

function parseSeasonHtml(text) {
  const $ = cheerio.load(text);
  for (const tb of $('table').toArray()) {
    const trs = $(tb).find('tr').toArray();
    if (!trs.length) continue;
    const hdr = $(trs[0]).find('th, td').toArray().map((c) => $(c).text().trim().toLowerCase());
    if (!['p', 'w', 'd', 'l', 'gf', 'ga', 'pts'].every((h) => hdr.includes(h))) continue;
    const ix = {};
    hdr.forEach((h, i) => { ix[h] = i; });
    const clubI = ix.club ?? ix.team;
    const posI = ix['#'] ?? ix.pos;
    const rows = [];
    for (const tr of trs.slice(1)) {
      const c = $(tr).find('td, th').toArray().map((x) => $(x).text().trim());
      if (c.length < hdr.length || clubI == null || posI == null) continue;
      try {
        rows.push({
          pos: strictInt(c[posI].replace(/\D/g, '')), club: c[clubI], P: strictInt(c[ix.p]), W: strictInt(c[ix.w]),
          D: strictInt(c[ix.d]), L: strictInt(c[ix.l]), GF: strictInt(c[ix.gf]), GA: strictInt(c[ix.ga]),
          Pts: strictInt(c[ix.pts]),
        });
      } catch { /* skip malformed row */ }
    }
    if (rows.length) return rows;
  }
  throw new Error('no standings table found');
}

// ---------------------------------------------------------------- topscorersfootball.com
function parseTopscorers(text) {
  const $ = cheerio.load(text);
  const rounds = {};
  $('div.match-round').each((_, rd) => {
    const m = $(rd).text().replace(/\s+/g, ' ').match(/Round\s+(\d+)/);
    if (!m) return;
    rounds[m[1]] = rounds[m[1]] || [];
    const items = rounds[m[1]];
    const box = $(rd).nextAll('div').first();
    if (!box.length || !box.hasClass('match-round-matches')) return;
    box.find('div.match-result').each((__, mr) => {
      const names = $(mr).contents().toArray().filter((n) => n.type === 'text').map((n) => n.data).join('').trim();
      const parts = names.split(' - ').map((s) => s.trim());
      const sc = $(mr).find('span.match-score').first();
      const d = $(mr).find('div.date').first();
      let hg = null;
      let ag = null;
      if (sc.length) {
        const ms = sc.text().match(/^\s*(\d+)\s*-\s*(\d+)\s*$/);
        if (ms) { hg = +ms[1]; ag = +ms[2]; }
      }
      let date = null;
      if (d.length) {
        const md = d.text().trim().match(/^(\d{1,2})\s+([A-Za-z]+)\s+(\d{4})$/);
        const mon = md && MONTHS[md[2].slice(0, 3).toLowerCase()];
        if (mon) date = validIso(+md[3], mon, +md[1]);
      }
      items.push({
        raw: names, home: parts.length === 2 ? parts[0] : null, away: parts.length === 2 ? parts[1] : null,
        hg, ag, date, id: $(mr).closest('div.match-details-comp').attr('data-apif-id') ?? null,
      });
    });
  });
  const table = [];
  const tb = $('table').first();
  if (tb.length) {
    tb.find('tbody tr').each((_, tr) => {
      const c = $(tr).find('td').toArray().map((td) => $(td).text().trim());
      if (c.length < 8) return;
      try {
        const g = c[6].split('-');
        if (g.length !== 2) return;
        table.push({
          pos: strictInt(c[0].replace(/\.+$/, '')), club: c[1], P: strictInt(c[2]), W: strictInt(c[3]),
          D: strictInt(c[4]), L: strictInt(c[5]), GF: strictInt(g[0]), GA: strictInt(g[1]), Pts: strictInt(c[7]),
        });
      } catch { /* skip malformed row */ }
    });
  }
  const upd = $('.gen-last-update').first();
  return {
    rounds, table,
    updated: upd.length ? upd.text().replace('Last updated:', '').trim() : null,
  };
}

// ---------------------------------------------------------------- NBC Sports schedule article (ET)
function parseNbc(text, startYear) {
  const rdate = new RegExp(`^(?:${DAYS}),?\\s+(\\d{1,2})\\s+([A-Za-z]+)(?:,?\\s+(\\d{4}))?$`);
  // a trailing "* Match will move to ..." note marks a kickoff that may still change
  const rfix = /^(\d{1,2})(?::(\d{2}))?\s*(am|pm)(?:\s*ET)?:\s*(.+?)\s+v\s+(.+?)(\*.*|\s+[-—–](?:\s.*)?)?$/i;
  const rres = /^(.+?)\s+(\d+)-(\d+)\s+(.+?)(?:\s+[-—–](?:\s.*)?)?$/;
  let cur = null;
  const out = [];
  for (const line of textLines(text)) {
    let m = line.match(rdate);
    if (m) {
      const mon = MONTHS[m[2].slice(0, 3).toLowerCase()];
      cur = null;
      if (mon) {
        const yr = m[3] ? +m[3] : (mon >= 7 ? startYear : startYear + 1);
        cur = validIso(yr, mon, +m[1]);
      }
      continue;
    }
    if (!cur) continue;
    m = line.match(rfix);
    if (m) {
      const trail = (m[6] || '').trimStart();
      const tentative = trail.startsWith('*');
      out.push({
        home: m[4].trim(), away: m[5].trim(), date_et: cur, time_et: clock(m[1], m[2], m[3]), hg: null, ag: null,
        tentative, note: tentative ? trail.replace(/^[* ]+/, '').trim() : null,
      });
      continue;
    }
    m = line.match(rres);
    if (m) out.push({ home: m[1].trim(), away: m[4].trim(), date_et: cur, time_et: null, hg: +m[2], ag: +m[3] });
  }
  return out;
}

// ---------------------------------------------------------------- sportbusy.com (ET, upcoming only)
function parseSportbusy(text) {
  const rdate = new RegExp(`^(?:${DAYS}),\\s+([A-Za-z]+)\\s+(\\d{1,2}),\\s+(\\d{4})$`);
  const rtime = /^(\d{1,2}):(\d{2})\s*(AM|PM)\s*ET$/i;
  const rpair = /^(.+?)\s+at\s+(.+)$/;
  const rround = /^Round\s+(\d+)\b/;
  const lines = textLines(text);
  const out = [];
  let cur = null;
  for (let i = 0; i < lines.length; i++) {
    let m = lines[i].match(rdate);
    if (m && MONTHS[m[1].slice(0, 3).toLowerCase()]) {
      cur = validIso(+m[3], MONTHS[m[1].slice(0, 3).toLowerCase()], +m[2]);
      continue;
    }
    m = lines[i].match(rtime);
    if (m && cur && i + 2 < lines.length) {
      const pm = lines[i + 1].match(rpair);
      const rm = lines[i + 2].match(rround);
      if (pm && rm) {
        out.push({
          home: pm[2].trim(), away: pm[1].trim(), date_et: cur, time_et: clock(m[1], m[2], m[3]), round: +rm[1],
        });
        i += 2;
      }
    }
  }
  return out;
}

module.exports = {
  ROOT, CACHE_DIR, Fetcher, cachePaths, mask,
  parseSeasonCsv, parseSeasonHtml, parseTopscorers, parseNbc, parseSportbusy,
};
