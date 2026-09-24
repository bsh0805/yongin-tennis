// lib/redis-limiter.js
//
// server.mjs(로컬/VPS 버전)에서는 메모리에 떠 있는 큐 하나가 동시성 2건, 요청 간
// 최소 150ms, 60초 캐시, 연속 3회 실패시 5분 정지를 전부 정확하게 보장했다.
//
// Vercel 서버리스 함수는 요청마다 별도 인스턴스에서 켜졌다 꺼지고 메모리를 공유하지
// 않기 때문에, 같은 규칙을 지키려면 상태를 어딘가 공유 저장소(Upstash Redis)에
// 둬야 한다. 여기 구현은 그 규칙의 "베스트 에포트" 버전이다 — 개인이 혼자 쓰는
// 트래픽 규모에서는 사실상 동일하게 동작하지만, 아주 짧은 순간에 요청이 정확히
// 겹치면 완벽한 CAS(compare-and-swap)가 아니라서 이론적으로 살짝 어긋날 수 있다.
// (동시 사용자가 자기 자신뿐인 개인 앱이라 이 정도 근사로 충분하다고 판단했다.)

const MIN_GAP_MS = 150;
const MAX_CONCURRENT = 2;
const FAILURE_THRESHOLD = 3;
const BLOCK_DURATION_SEC = 5 * 60;
const CACHE_TTL_SEC = 60;
const INFLIGHT_SAFETY_TTL_SEC = 10; // 함수가 비정상 종료해도 슬롯이 영원히 안 풀리는 일 방지
const ACQUIRE_TIMEOUT_MS = 5000;

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

class BlockedError extends Error {
  constructor(remainingMs) {
    super('레이트 리밋 차단 감지로 일시 정지 중입니다');
    this.name = 'BlockedError';
    this.remainingMs = remainingMs;
  }
}

async function getCached(redis, key) {
  const hit = await redis.get(key);
  return hit ?? null;
}

async function setCached(redis, key, data) {
  await redis.set(key, data, { ex: CACHE_TTL_SEC });
}

async function checkBreaker(redis) {
  const blockedUntil = Number(await redis.get('breaker:blockedUntil')) || 0;
  const remaining = blockedUntil - Date.now();
  if (remaining > 0) throw new BlockedError(remaining);
}

async function recordSuccess(redis) {
  await redis.set('breaker:failCount', 0, { ex: BLOCK_DURATION_SEC });
}

async function recordFailure(redis) {
  const fails = await redis.incr('breaker:failCount');
  await redis.expire('breaker:failCount', BLOCK_DURATION_SEC);
  if (fails >= FAILURE_THRESHOLD) {
    await redis.set('breaker:blockedUntil', Date.now() + BLOCK_DURATION_SEC * 1000, {
      ex: BLOCK_DURATION_SEC,
    });
  }
}

// 동시 실행 2건 제한 (INCR 기반, 완벽한 원자성은 아니지만 낮은 트래픽에서 충분)
async function acquireSlot(redis) {
  const deadline = Date.now() + ACQUIRE_TIMEOUT_MS;
  for (;;) {
    const count = await redis.incr('inflight');
    if (count === 1) await redis.expire('inflight', INFLIGHT_SAFETY_TTL_SEC);
    if (count <= MAX_CONCURRENT) return;
    await redis.decr('inflight');
    if (Date.now() > deadline) throw new Error('요청이 몰려 있습니다. 잠시 후 다시 시도하세요.');
    await sleep(80 + Math.random() * 120);
  }
}

async function releaseSlot(redis) {
  const v = await redis.decr('inflight');
  if (v < 0) await redis.set('inflight', 0);
}

// 요청 "시작" 간 최소 150ms 간격
async function waitForGap(redis) {
  const last = Number(await redis.get('lastDispatch')) || 0;
  const wait = Math.max(0, last + MIN_GAP_MS - Date.now());
  if (wait > 0) await sleep(wait);
  await redis.set('lastDispatch', Date.now());
}

/**
 * key: 캐시 키 (예: `slots:${date}:${resveId}`)
 * task: async () => data
 * 반환: { data, cached }
 */
async function run(redis, key, task) {
  const cached = await getCached(redis, key);
  if (cached !== null) return { data: cached, cached: true };

  await checkBreaker(redis);
  await acquireSlot(redis);
  try {
    await waitForGap(redis);
    await checkBreaker(redis); // 대기하는 동안 다른 요청이 차단시켰을 수 있으니 재확인
    const data = await task();
    await recordSuccess(redis);
    await setCached(redis, key, data);
    return { data, cached: false };
  } catch (err) {
    if (!(err instanceof BlockedError)) await recordFailure(redis);
    throw err;
  } finally {
    await releaseSlot(redis);
  }
}

module.exports = { run, BlockedError };
