// lib/time.js
// "6:00 ~ 8:00" 같은 한 자리 시 표기를 "06:00~08:00"으로 통일한다.

const TIME_RE = /(\d{1,2}):(\d{2})/g;

function pad2(n) {
  return String(n).padStart(2, '0');
}

function normalizeRange(raw) {
  if (!raw) return null;
  const matches = [...String(raw).matchAll(TIME_RE)];
  if (matches.length < 2) return null;
  const [h1, m1] = matches[0].slice(1);
  const [h2, m2] = matches[1].slice(1);
  return `${pad2(h1)}:${m1}~${pad2(h2)}:${m2}`;
}

function normalizeTime(raw) {
  const m = /(\d{1,2}):(\d{2})/.exec(String(raw || ''));
  if (!m) return raw;
  return `${pad2(m[1])}:${m[2]}`;
}

module.exports = { normalizeRange, normalizeTime };
