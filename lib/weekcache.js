'use strict';
// Week cache: data pulled while building a match week's charts is reused for the rest of that week
// instead of being downloaded again, so rebuilding a chart only goes online for what has to be live.
//
// Weeks start Tuesday 00:00 Pacific, so a Fri–Mon weekend round and a Tue–Thu midweek round each sit
// inside one week. In 'auto' mode a current-season cache entry fetched this week is fresh whatever its
// normal TTL, until a game of the competition being built has finished since it was fetched: once a
// recorded kickoff + FINISH_MS has passed, entries fetched before it (+ SETTLE_MS for the sources to post
// the result) fall back to min(their TTL, STALE_TTL), so a rebuild after a game picks up its result.
// Never week-cached:
//   - Kalshi / Polymarket quotes: always fetched live (settled rounds and pre-kickoff price history are
//     historic and archived as before)
//   - SportsGambler injuries: INJURED / SUSP. need an "Updated" stamp <= 3 days old, so the page keeps
//     its normal TTL
//
// Store. Locally data/cache already persists between runs; kickoff records go to <WRITE_DIR>/_week.
// On Vercel the function's /tmp is per instance and wiped on cold start, so with a Blob store connected
// to the project (BLOB_READ_WRITE_TOKEN) entries are also kept in Vercel Blob:
//   week/<week start>/<cache name>.json   this week's current-season sources {url, status, fetched_at, body}
//   archive/<cache name>.json             historic (finished) data fetched at runtime; never expires
//   kickoffs/<competition>.json           kickoff times (epoch ms) of the rounds built in the last 2 weeks
// Old week/ folders are deleted once a new week starts. FUTBOL_BLOB_ACCESS=public for a public store.

const fs = require('fs');
const path = require('path');
const T = require('./time');

const TZ = 'America/Los_Angeles';
const WEEK_START_DAY = 2; // Tuesday
const FINISH_MS = 2.25 * 3600e3;
const SETTLE_MS = 3 * 3600e3;
const STALE_TTL = 1; // hours: a week entry older than a finished game is re-pulled at most hourly
const KEEP_KICKOFFS_MS = 14 * 86400e3;
const LIVE = /^https:\/\/(api\.elections\.kalshi\.com|gamma-api\.polymarket\.com|clob\.polymarket\.com)\//;
const NO_WEEK = /^https:\/\/(www\.)?sportsgambler\.com\//;

// Week containing `ms`: { id: 'YYYY-MM-DD' (its Tuesday, Pacific), start: epoch ms }
function week(ms = Date.now()) {
  const today = T.localDate(ms, TZ);
  const back = (new Date(T.isoToMs(today)).getUTCDay() - WEEK_START_DAY + 7) % 7;
  const id = T.addDays(today, -back);
  return { id, start: T.zonedToUtc(id, '00:00', TZ) };
}

const isLive = (url) => LIVE.test(url);
const weekly = (url) => !LIVE.test(url) && !NO_WEEK.test(url);

// Entries fetched at or after this instant (epoch seconds) are week-fresh. Past games pull it forward to
// the last finish + settle time; while that is still ahead of now nothing is week-fresh.
function floor(kickoffs, nowMs = Date.now()) {
  let at = week(nowMs).start;
  for (const ko of kickoffs || []) if (ko + FINISH_MS <= nowMs) at = Math.max(at, ko + FINISH_MS + SETTLE_MS);
  return at / 1000;
}

// ------------------------------------------------------------------ remote store (Vercel Blob)
const TOKEN = () => process.env.BLOB_READ_WRITE_TOKEN;
const ACCESS = () => (process.env.FUTBOL_BLOB_ACCESS === 'public' ? 'public' : 'private');
let blobLib = null;
const blob = () => (blobLib = blobLib || require('@vercel/blob'));
const remote = () => !!TOKEN() && process.env.FUTBOL_WEEK_CACHE !== '0';
let warned = false;
const warn = (what, e) => {
  if (!warned) console.warn(`week cache: ${what} failed (${e.message}); continuing without it`);
  warned = true;
};

async function readJson(pathname) {
  const r = await blob().get(pathname, { access: ACCESS() });
  if (!r || r.statusCode !== 200) return null;
  return JSON.parse(await new Response(r.stream).text());
}

function writeJson(pathname, data) {
  return blob().put(pathname, JSON.stringify(data), {
    access: ACCESS(), contentType: 'application/json', addRandomSuffix: false, allowOverwrite: true, cacheControlMaxAge: 60,
  });
}

const entryPath = (kind, name, nowMs) => (kind === 'archive' ? `archive/${name}.json` : `week/${week(nowMs).id}/${name}.json`);

// A stored entry { url, status, fetched_at, body } or null. kind: 'week' | 'archive'.
async function load(kind, name, nowMs = Date.now()) {
  if (!remote()) return null;
  try {
    return await readJson(entryPath(kind, name, nowMs));
  } catch (e) {
    warn('read', e);
    return null;
  }
}

async function save(kind, name, entry, nowMs = Date.now()) {
  if (!remote()) return;
  try {
    await writeJson(entryPath(kind, name, nowMs), entry);
    if (kind === 'week') await prune(nowMs);
  } catch (e) {
    warn('write', e);
  }
}

// delete earlier weeks' folders (once per instance per week)
let prunedFor = null;
async function prune(nowMs) {
  const cur = week(nowMs).id;
  if (prunedFor === cur) return;
  prunedFor = cur;
  const { list, del } = blob();
  const { folders = [] } = await list({ prefix: 'week/', mode: 'folded' });
  for (const folder of folders.filter((f) => f.replace(/^week\/|\/$/g, '') < cur)) {
    let cursor;
    do {
      const page = await list({ prefix: folder, cursor, limit: 1000 });
      if (page.blobs.length) await del(page.blobs.map((b) => b.url));
      cursor = page.hasMore ? page.cursor : null;
    } while (cursor);
  }
}

// ------------------------------------------------------------------ kickoff records
const kickoffFile = (dir, comp) => path.join(dir, '_week', `kickoffs-${comp}.json`);

async function kickoffs(comp, dir) {
  try {
    if (remote()) return (await readJson(`kickoffs/${comp}.json`)) || [];
    return JSON.parse(fs.readFileSync(kickoffFile(dir, comp), 'utf8'));
  } catch (e) {
    if (remote()) warn('read', e);
    return [];
  }
}

// merge the kickoffs seen while building into the competition's record
async function recordKickoffs(comp, seen, dir, nowMs = Date.now()) {
  const add = [...new Set((seen || []).filter(Number.isFinite))];
  if (!add.length) return;
  const old = await kickoffs(comp, dir);
  const all = [...new Set([...old, ...add])].filter((ko) => ko > nowMs - KEEP_KICKOFFS_MS).sort((a, b) => a - b);
  if (all.length === old.length && all.every((ko, i) => ko === old[i])) return;
  try {
    if (remote()) await writeJson(`kickoffs/${comp}.json`, all);
    else {
      fs.mkdirSync(path.dirname(kickoffFile(dir, comp)), { recursive: true });
      fs.writeFileSync(kickoffFile(dir, comp), JSON.stringify(all));
    }
  } catch (e) {
    warn('write', e);
  }
}

module.exports = {
  week, floor, isLive, weekly, remote, load, save, kickoffs, recordKickoffs, STALE_TTL, FINISH_MS, SETTLE_MS,
};
