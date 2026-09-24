// lib/access.js
// ACCESS_TOKEN이 설정돼 있으면 ?t=TOKEN으로 최초 1회 접속해야 하고, 이후 쿠키로 기억한다.

const COOKIE_NAME = 'yongin_tennis_t';

function parseCookies(req) {
  const header = req.headers.cookie || '';
  const out = {};
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    out[part.slice(0, idx).trim()] = decodeURIComponent(part.slice(idx + 1).trim());
  }
  return out;
}

function checkAccess(req, res) {
  const token = process.env.ACCESS_TOKEN;
  if (!token) return true;

  const cookies = parseCookies(req);
  if (cookies[COOKIE_NAME] === token) return true;

  const q = req.query && req.query.t;
  if (q === token) {
    res.setHeader(
      'Set-Cookie',
      `${COOKIE_NAME}=${encodeURIComponent(token)}; Path=/; HttpOnly; Max-Age=31536000; SameSite=Lax; Secure`,
    );
    return true;
  }

  res.status(401).json({ error: '접근 토큰이 필요합니다 (?t=...)' });
  return false;
}

module.exports = { checkAccess };
