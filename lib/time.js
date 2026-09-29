'use strict';
// Date helpers. Dates are ISO strings (YYYY-MM-DD); instants are epoch milliseconds.
// Time-zone conversion uses Intl, so no tz database dependency is needed.

const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const WD = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'];
const DAY_MS = 86400000;
const formatters = new Map();

function formatter(tz) {
  if (!formatters.has(tz)) {
    formatters.set(tz, new Intl.DateTimeFormat('en-US', {
      timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    }));
  }
  return formatters.get(tz);
}

function parts(ms, tz) {
  const o = {};
  for (const p of formatter(tz).formatToParts(new Date(ms))) o[p.type] = p.value;
  return { y: +o.year, m: +o.month, d: +o.day, h: +o.hour % 24, mi: +o.minute, s: +o.second };
}

function offsetMs(ms, tz) {
  const p = parts(ms, tz);
  return Date.UTC(p.y, p.m - 1, p.d, p.h, p.mi, p.s) - Math.floor(ms / 1000) * 1000;
}

// Wall-clock time in `tz` -> epoch ms (second pass settles DST edges).
function zonedToUtc(dateIso, hhmm, tz) {
  const [y, m, d] = dateIso.split('-').map(Number);
  const [h, mi] = hhmm.split(':').map(Number);
  const wall = Date.UTC(y, m - 1, d, h, mi);
  let ms = wall - offsetMs(wall, tz);
  ms = wall - offsetMs(ms, tz);
  return ms;
}

const pad = (n) => String(n).padStart(2, '0');
const iso = (y, m, d) => `${y}-${pad(m)}-${pad(d)}`;

function validIso(y, m, d) {
  const t = new Date(Date.UTC(y, m - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d ? iso(y, m, d) : null;
}

const isoToMs = (s) => Date.UTC(+s.slice(0, 4), +s.slice(5, 7) - 1, +s.slice(8, 10));
const msToIso = (ms) => new Date(ms).toISOString().slice(0, 10);
const addDays = (s, n) => msToIso(isoToMs(s) + n * DAY_MS);
const diffDays = (a, b) => Math.round((isoToMs(a) - isoToMs(b)) / DAY_MS);

function localDate(ms, tz) {
  const p = parts(ms, tz);
  return iso(p.y, p.m, p.d);
}

function fmtTime(ms, tz) {
  const p = parts(ms, tz);
  return `${p.h % 12 || 12}:${pad(p.mi)}${p.h < 12 ? 'a' : 'p'}`;
}

const weekday = (s) => WD[new Date(isoToMs(s)).getUTCDay()];
const monDay = (s) => `${MON[+s.slice(5, 7) - 1]} ${+s.slice(8, 10)}`;
const monDayPadded = (s) => `${MON[+s.slice(5, 7) - 1]} ${s.slice(8, 10)}`;

function rangeLabel(a, b) {
  if (!a) return 'dates TBC';
  if (a === b) return `${monDay(a)}, ${a.slice(0, 4)}`;
  if (a.slice(0, 7) === b.slice(0, 7)) return `${monDay(a)}–${+b.slice(8, 10)}, ${b.slice(0, 4)}`;
  return `${monDay(a)} – ${monDay(b)}, ${b.slice(0, 4)}`;
}

module.exports = {
  MON, parts, zonedToUtc, iso, validIso, isoToMs, addDays, diffDays, localDate, fmtTime,
  weekday, monDay, monDayPadded, rangeLabel,
};
