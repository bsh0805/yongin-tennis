// api/status.js
const { Redis } = require('@upstash/redis');
const { checkAccess } = require('../lib/access');

const redis = Redis.fromEnv();

module.exports = async (req, res) => {
  if (!checkAccess(req, res)) return;

  const [blockedUntilRaw, failCountRaw, inflightRaw] = await Promise.all([
    redis.get('breaker:blockedUntil'),
    redis.get('breaker:failCount'),
    redis.get('inflight'),
  ]);

  const blockedUntil = Number(blockedUntilRaw) || 0;
  const now = Date.now();

  res.status(200).json({
    consecutiveFailures: Number(failCountRaw) || 0,
    inflight: Number(inflightRaw) || 0,
    blocked: now < blockedUntil,
    blockedRemainingMs: Math.max(0, blockedUntil - now),
  });
};
