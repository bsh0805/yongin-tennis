// lib/http-client.mjs
//
// 사내 MITM 프록시 환경 대응:
//  1) Node 전역 fetch는 프로세스 시작 시 NODE_USE_ENV_PROXY=1 이었을 때만 HTTPS_PROXY를 따른다.
//     코드 안에서 process.env.NODE_USE_ENV_PROXY를 나중에 설정해도 이미 늦었으므로,
//     HTTPS_PROXY는 있는데 이 값이 없으면 같은 프로세스를 그 값을 심어서 재실행한다.
//  2) 프록시 CA 키가 약하면 Node TLS 스택이 거부한다(curl은 통과). 그래서 네이티브 fetch를
//     먼저 시도하고 실패하면 curl로 폴백하며, 어느 쪽이 통했는지 기억해서 계속 그 경로만 쓴다.

import { execFile } from 'node:child_process';
import { spawn } from 'node:child_process';

export function ensureProxyEnvOrReexec() {
  const hasProxy = !!(process.env.HTTPS_PROXY || process.env.https_proxy);
  const envProxyFlag = process.env.NODE_USE_ENV_PROXY;
  if (hasProxy && envProxyFlag !== '1') {
    console.log('[http-client] HTTPS_PROXY 감지됨. NODE_USE_ENV_PROXY=1로 프로세스를 재시작합니다...');
    const child = spawn(process.execPath, process.argv.slice(1), {
      stdio: 'inherit',
      env: { ...process.env, NODE_USE_ENV_PROXY: '1' },
    });
    child.on('exit', (code) => process.exit(code ?? 0));
    // 재실행 중이므로 이 프로세스는 더 진행하지 않는다.
    return false;
  }
  return true;
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// 'auto' -> 아직 모름, 매 요청마다 fetch 먼저 시도
// 'fetch' -> fetch로 통과 확인됨, 계속 fetch만 사용
// 'curl'  -> fetch가 막혀서 curl로 통과 확인됨, 계속 curl만 사용
let workingMode = 'auto';

function looksLikeTlsFailure(err) {
  const msg = String(err && (err.cause?.message || err.message) || err || '');
  return /certificate|TLS|SSL|self[- ]signed|CERT_|unable to verify/i.test(msg);
}

async function fetchViaNative(url, options, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...options, signal: controller.signal });
    const text = await res.text();
    return { ok: res.ok, status: res.status, text };
  } finally {
    clearTimeout(timer);
  }
}

function fetchViaCurl(url, options, timeoutMs) {
  return new Promise((resolve, reject) => {
    const args = ['-sS', '-m', String(Math.ceil(timeoutMs / 1000)), '-o', '-', '-w', '\n__STATUS__:%{http_code}'];
    const method = (options.method || 'GET').toUpperCase();
    args.push('-X', method);
    if (options.headers) {
      for (const [k, v] of Object.entries(options.headers)) {
        args.push('-H', `${k}: ${v}`);
      }
    }
    if (options.body != null) {
      args.push('--data-raw', String(options.body));
    }
    args.push(url);
    // execFile: 배열 인자로 넘겨 셸을 타지 않는다 (셸 인젝션 방지)
    execFile('curl', args, { maxBuffer: 10 * 1024 * 1024 }, (err, stdout) => {
      if (err) {
        reject(err);
        return;
      }
      const marker = '\n__STATUS__:';
      const idx = stdout.lastIndexOf(marker);
      if (idx === -1) {
        resolve({ ok: true, status: 200, text: stdout });
        return;
      }
      const text = stdout.slice(0, idx);
      const status = parseInt(stdout.slice(idx + marker.length).trim(), 10) || 0;
      resolve({ ok: status >= 200 && status < 300, status, text });
    });
  });
}

/**
 * 네이티브 fetch를 우선 시도하고, TLS 등으로 실패하면 curl로 폴백한다.
 * 한 번 성공한 경로를 기억해서 이후 요청은 그 경로로 바로 간다.
 */
export async function fetchWithFallback(url, options = {}, timeoutMs = 10000) {
  if (workingMode !== 'curl') {
    try {
      const result = await fetchViaNative(url, options, timeoutMs);
      workingMode = 'fetch';
      return result;
    } catch (err) {
      if (workingMode === 'fetch') throw err; // 이미 fetch가 통하던 경로였다면 이번 실패는 그대로 전달
      if (!looksLikeTlsFailure(err) && workingMode === 'auto') {
        // TLS 문제가 아니면 (네트워크 자체 문제일 수 있음) 그래도 curl로 한 번 더 시도해본다
      }
      // curl로 폴백
    }
  }
  const result = await fetchViaCurl(url, options, timeoutMs);
  workingMode = 'curl';
  return result;
}

export function getWorkingMode() {
  return workingMode;
}
