// api/slots.js
const { Redis } = require('@upstash/redis');
const { checkAccess } = require('../lib/access');
const { normalizeRange, normalizeTime } = require('../lib/time');
const { run, BlockedError } = require('../lib/redis-limiter');

const SLOTS_URL =
  'https://publicsports.yongin.go.kr/publicsports/sports/selectRegistTimeByChosenDateFcltyRceptResveApply.do';

const redis = Redis.fromEnv();

async function callUpstreamSlots(date, resveId) {
  const body = `dateVal=${encodeURIComponent(date)}&resveId=${encodeURIComponent(resveId)}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10000);
  let res;
  try {
    res = await fetch(SLOTS_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) throw new Error(`업스트림 응답 실패 (status ${res.status})`);

  let json;
  try {
    json = await res.json();
  } catch {
    throw new Error('업스트림 응답 파싱 실패 (JSON 아님)');
  }

  const free = [];
  for (const t of json.resveTmList || []) {
    const label = normalizeRange(t.timeContent) || t.timeContent;
    free.push({ start: normalizeTime(t.usageBgnTm), label });
  }

  const booked = [];
  for (const t of json.fcltRceptRsvctmTime || []) {
    if (t.rsvctmStts !== 'RESVECOMPT') continue;
    // frstRegisterNmApply(예약자명) 등 개인정보 필드는 절대 그대로 내려주지 않는다.
    const label = normalizeRange(t.useTm) || t.useTm;
    booked.push({ label });
  }

  return { free, booked, day: json.formatedDay || null, date: json.formatedDate || date };
}

module.exports = async (req, res) => {
  if (!checkAccess(req, res)) return;

  const { date, resveId } = req.query;
  if (!/^\d{8}$/.test(date || '')) {
    return res.status(400).json({ error: 'date는 YYYYMMDD 8자리 숫자여야 합니다' });
  }
  if (!/^\d+$/.test(resveId || '')) {
    return res.status(400).json({ error: 'resveId는 숫자여야 합니다' });
  }

  const cacheKey = `slots:${date}:${resveId}`;

  try {
    const { data, cached } = await run(redis, cacheKey, () => callUpstreamSlots(date, resveId));
    res.status(200).json({ ...data, cached });
  } catch (err) {
    if (err instanceof BlockedError) {
      res.status(429).json({ error: err.message, blockedRemainingMs: err.remainingMs });
    } else {
      res.status(502).json({ error: `조회 실패: ${err.message}` });
    }
  }
};
