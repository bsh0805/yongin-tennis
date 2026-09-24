#!/usr/bin/env node
// refresh-courts.mjs
//
// 용인 공공체육시설 테니스장 코트 목록을 스크레이핑해서 courts.json을 다시 만든다.
// resveId는 매월 바뀌므로 정기적으로(예: 매달) 이 스크립트를 다시 돌려야 한다.
//
// 목록 페이지는 인증이 필요 없지만, 이 파일도 같은 용인 서버를 호출하므로
// 레이트 리밋 규칙을 그대로 지킨다: 페이지 사이 1.5초 대기, 병렬 호출 없음.

import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { ensureProxyEnvOrReexec, fetchWithFallback, sleep } from './lib/http-client.mjs';

if (!ensureProxyEnvOrReexec()) {
  // 프록시 환경변수를 심어서 재실행 중 - 이 프로세스는 여기서 끝낸다.
  process.exit(0);
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_PATH = path.join(__dirname, 'courts.json');

const BASE = 'https://publicsports.yongin.go.kr/publicsports/sports/selectFcltyRceptResveListU.do';
const KEY = '4236';
const FIELD = 'ITEM_01'; // 테니스
const PAGE_UNIT = 8; // 무시되지만 명세대로 보냄
const TOTAL_PAGES = 12;
const PAGE_DELAY_MS = 1500;

function extractByClass(html, className) {
  const re = new RegExp(`class="${className}"[^>]*>([\\s\\S]*?)<`);
  const m = re.exec(html);
  if (!m) return '';
  return m[1].replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
}

function parseTitle(rawTitle) {
  // "(유료) 성복배수지 테니스장6코트_10월" -> 이름 / 월
  let t = rawTitle.replace(/^[[(]유료[\])]\s*/, '').trim();
  const monthMatch = /_(\d{1,2})월\s*$/.exec(t);
  const month = monthMatch ? parseInt(monthMatch[1], 10) : null;
  const name = monthMatch ? t.slice(0, monthMatch.index).trim() : t;
  return { name, month };
}

function parsePosition(rawPosition) {
  // "수지구, 풍덕천1동" -> gu / emd
  const parts = rawPosition.split(',').map((s) => s.trim()).filter(Boolean);
  return { gu: parts[0] || '', emd: parts[1] || '' };
}

function parseItems(html) {
  const blocks = html.split('reserve_box_item').slice(1); // 첫 조각은 li 이전 부분이라 버림
  const items = [];
  for (const block of blocks) {
    const rawTitle = extractByClass(block, 'reserve_title');
    const rawPosition = extractByClass(block, 'reserve_position');
    const applyType = extractByClass(block, 'above_item');
    const idMatch = /resveId=(\d+)/.exec(block);
    if (!rawTitle || !idMatch) continue;
    const { name, month } = parseTitle(rawTitle);
    const { gu, emd } = parsePosition(rawPosition);
    items.push({ name, month, gu, emd, type: applyType || '일반예약', resveId: idMatch[1] });
  }
  return items;
}

async function fetchPage(pageIndex) {
  const url = `${BASE}?key=${KEY}&searchFcltyFieldNm=${FIELD}&pageUnit=${PAGE_UNIT}&checkSearchMonthNow=false&pageIndex=${pageIndex}`;
  const res = await fetchWithFallback(url, { method: 'GET' }, 15000);
  if (!res.ok) {
    throw new Error(`페이지 ${pageIndex} 요청 실패 (status ${res.status})`);
  }
  return res.text;
}

async function main() {
  console.log(`코트 목록 ${TOTAL_PAGES}페이지를 ${PAGE_DELAY_MS}ms 간격으로 받아옵니다...`);
  const allItems = [];

  for (let page = 1; page <= TOTAL_PAGES; page++) {
    process.stdout.write(`  페이지 ${page}/${TOTAL_PAGES} ... `);
    const html = await fetchPage(page);
    const items = parseItems(html);
    console.log(`${items.length}건`);
    allItems.push(...items);
    if (page < TOTAL_PAGES) {
      await sleep(PAGE_DELAY_MS);
    }
  }

  console.log(`총 ${allItems.length}건 파싱 완료. 코트 단위로 병합합니다...`);

  const byKey = new Map();
  for (const it of allItems) {
    if (!it.month) continue;
    const key = `${it.name}::${it.gu}::${it.emd}`;
    if (!byKey.has(key)) {
      byKey.set(key, { name: it.name, gu: it.gu, emd: it.emd, months: {} });
    }
    byKey.get(key).months[String(it.month)] = { id: it.resveId, type: it.type };
  }

  const courts = [...byKey.values()].sort((a, b) => a.gu.localeCompare(b.gu, 'ko') || a.name.localeCompare(b.name, 'ko'));

  await writeFile(OUT_PATH, JSON.stringify(courts, null, 1), 'utf-8');
  console.log(`courts.json 저장 완료: 코트 ${courts.length}곳 -> ${OUT_PATH}`);

  const guCounts = {};
  for (const c of courts) guCounts[c.gu] = (guCounts[c.gu] || 0) + 1;
  console.log('구별 코트 수:', guCounts);

  if (courts.length !== 48) {
    console.warn(`주의: 예상 코트 수(48)와 다릅니다 (${courts.length}). 사이트 구조가 바뀌었을 수 있습니다.`);
  }
}

main().catch((err) => {
  console.error('실패:', err.message);
  process.exit(1);
});
