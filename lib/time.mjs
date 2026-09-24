// lib/time.mjs
//
// 용인 응답은 "6:00 ~ 8:00"처럼 한 자리 시를 그대로 준다.
// 정렬/비교/축 생성을 위해 "06:00~08:00" 형태로 통일한다.
// 코트마다 운영 시간대가 다르므로(대부분 2시간 단위, 수지구는 1시간씩 겹치기도 함)
// 축은 하드코딩하지 않고 실제로 조회된 시간대를 모아서 만든다.

const TIME_RE = /(\d{1,2}):(\d{2})/g;

function pad2(n) {
  return String(n).padStart(2, '0');
}

/** "6:00 ~ 8:00" / "11:00~13:00" 등 -> "06:00~08:00" */
export function normalizeRange(raw) {
  if (!raw) return null;
  const matches = [...String(raw).matchAll(TIME_RE)];
  if (matches.length < 2) return null;
  const [h1, m1] = matches[0].slice(1);
  const [h2, m2] = matches[1].slice(1);
  return `${pad2(h1)}:${m1}~${pad2(h2)}:${m2}`;
}

/** 단일 시각 "6:00" -> "06:00" */
export function normalizeTime(raw) {
  const m = /(\d{1,2}):(\d{2})/.exec(String(raw || ''));
  if (!m) return raw;
  return `${pad2(m[1])}:${m[2]}`;
}

/** 정렬용 분 단위 시작 시각 ("06:00~08:00" -> 360) */
export function rangeStartMinutes(range) {
  const m = /^(\d{2}):(\d{2})/.exec(range);
  if (!m) return 0;
  return parseInt(m[1], 10) * 60 + parseInt(m[2], 10);
}

export function sortRanges(ranges) {
  return [...ranges].sort((a, b) => rangeStartMinutes(a) - rangeStartMinutes(b));
}
