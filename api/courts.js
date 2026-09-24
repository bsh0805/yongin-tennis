// api/courts.js
//
// courts.json은 배포할 때 프로젝트에 같이 번들되는 정적 파일이다. Vercel 서버리스
// 함수는 쓰기 가능한 영구 디스크가 없으므로, 로컬에서 refresh-courts.mjs를 돌려
// courts.json을 다시 만들고 git push(또는 vercel deploy)해야 반영된다.

const fs = require('fs');
const path = require('path');
const { checkAccess } = require('../lib/access');

module.exports = (req, res) => {
  if (!checkAccess(req, res)) return;
  try {
    const filePath = path.join(process.cwd(), 'courts.json');
    const raw = fs.readFileSync(filePath, 'utf-8');
    res.status(200).json(JSON.parse(raw));
  } catch (err) {
    res.status(500).json({ error: 'courts.json을 읽을 수 없습니다: ' + err.message });
  }
};
