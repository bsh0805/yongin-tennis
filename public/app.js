// public/app.js
// 코트 목록 로드 -> 조회 범위 결정 -> /api/slots를 코트별로 호출(클라이언트 동시 4개;
// 실제 업스트림 레이트 리밋은 서버 큐가 담당) -> 도착하는 대로 점진적 렌더링.

const FAVORITES_KEY = 'yongin-tennis-favorites';
const TOKEN_KEY = 'yongin-tennis-access-token';
const THRESHOLD = 20;

// Vercel 배포판에서는 정적 파일(public/)이 서버리스 함수를 거치지 않고 바로 나가기
// 때문에, 로컬 서버판처럼 페이지 요청 자체에 쿠키를 심을 수 없다. 그래서 접근
// 토큰은 매 /api 호출마다 쿼리스트링으로 직접 실어 보낸다. (ACCESS_TOKEN을 설정하지
// 않은 배포라면 이 값은 그냥 비어 있고 아무 영향도 없다.)
const urlToken = new URLSearchParams(location.search).get('t');
if (urlToken) {
  try {
    localStorage.setItem(TOKEN_KEY, urlToken);
  } catch {
    /* localStorage 불가 환경이면 이번 세션에서만 사용 */
  }
  history.replaceState(null, '', location.pathname); // 주소창에서 토큰 지우기
}
function getToken() {
  if (urlToken) return urlToken;
  try {
    return localStorage.getItem(TOKEN_KEY) || '';
  } catch {
    return '';
  }
}
function apiFetch(path) {
  const token = getToken();
  if (!token) return fetch(path);
  const sep = path.includes('?') ? '&' : '?';
  return fetch(`${path}${sep}t=${encodeURIComponent(token)}`);
}
const CLIENT_CONCURRENCY = 4;
const VIEW_URL = (resveId) =>
  `https://publicsports.yongin.go.kr/publicsports/sports/selectFcltyRceptResveViewU.do?key=4236&resveId=${resveId}`;

const state = {
  courts: [],
  favorites: new Set(loadFavorites()),
  view: 'time',
  freeOnly: true,
  results: new Map(), // courtKey -> { court, status, free, booked, day, error }
  pendingScope: null, // 임계값 경고에서 "그래도 조회" 눌렀을 때 실행할 스코프
  running: false,
};

const el = {
  dateInput: document.getElementById('date-input'),
  guSelect: document.getElementById('gu-select'),
  favoritesOnly: document.getElementById('favorites-only'),
  favoritesCount: document.getElementById('favorites-count'),
  scopeLine: document.getElementById('scope-line'),
  thresholdWarning: document.getElementById('threshold-warning'),
  thresholdCount: document.getElementById('threshold-count'),
  warningProceed: document.getElementById('warning-proceed'),
  searchBtn: document.getElementById('search-btn'),
  progressSection: document.getElementById('progress-section'),
  progressFill: document.getElementById('progress-fill'),
  progressText: document.getElementById('progress-text'),
  blockedBanner: document.getElementById('blocked-banner'),
  blockedText: document.getElementById('blocked-text'),
  summary: document.getElementById('summary'),
  statFreeCourts: document.getElementById('stat-free-courts'),
  statFreeSlots: document.getElementById('stat-free-slots'),
  statChecked: document.getElementById('stat-checked'),
  resultsControls: document.getElementById('results-controls'),
  freeOnly: document.getElementById('free-only'),
  viewTime: document.getElementById('view-time'),
  viewCourt: document.getElementById('view-court'),
  emptyHint: document.getElementById('empty-hint'),
};

function courtKey(c) {
  return `${c.name}::${c.gu}::${c.emd}`;
}

function loadFavorites() {
  try {
    const raw = localStorage.getItem(FAVORITES_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

function saveFavorites() {
  try {
    localStorage.setItem(FAVORITES_KEY, JSON.stringify([...state.favorites]));
  } catch {
    /* localStorage 불가 환경이면 조용히 무시 */
  }
}

function tomorrowStr() {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  return d.toISOString().slice(0, 10);
}

function dateToApi(dateStr) {
  return dateStr.replace(/-/g, '');
}

// ---- 초기화 ----
async function init() {
  const min = tomorrowStr();
  el.dateInput.min = min;
  el.dateInput.value = min;

  try {
    const res = await apiFetch('/api/courts');
    state.courts = await res.json();
  } catch {
    state.courts = [];
  }

  buildGuSelect();
  updateFavoritesCount();
  updateScopeLine();

  el.guSelect.addEventListener('change', updateScopeLine);
  el.favoritesOnly.addEventListener('change', updateScopeLine);
  el.dateInput.addEventListener('change', updateScopeLine);
  el.searchBtn.addEventListener('click', () => startSearch(false));
  el.warningProceed.addEventListener('click', () => startSearch(true));
  el.freeOnly.addEventListener('change', () => {
    state.freeOnly = el.freeOnly.checked;
    render();
  });
  document.querySelectorAll('.tab-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.tab-btn').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      state.view = btn.dataset.tab;
      el.viewTime.classList.toggle('hidden', state.view !== 'time');
      el.viewCourt.classList.toggle('hidden', state.view !== 'court');
      render();
    });
  });

  if (state.courts.length === 0) {
    el.scopeLine.textContent = '코트 목록이 비어 있습니다. refresh-courts.mjs를 먼저 실행해 courts.json을 만들어주세요.';
    el.searchBtn.disabled = true;
  }
}

function buildGuSelect() {
  const counts = { 전체: state.courts.length };
  for (const c of state.courts) counts[c.gu] = (counts[c.gu] || 0) + 1;
  const gus = ['전체', ...new Set(state.courts.map((c) => c.gu))];
  el.guSelect.innerHTML = gus
    .map((g) => `<option value="${g}">${g} (${counts[g] || 0}곳)</option>`)
    .join('');
}

function updateFavoritesCount() {
  el.favoritesCount.textContent = state.favorites.size;
}

function currentMonth() {
  return parseInt(el.dateInput.value.split('-')[1], 10);
}

function getScope() {
  const gu = el.guSelect.value;
  const favOnly = el.favoritesOnly.checked;
  const month = currentMonth();
  let candidates = state.courts;
  if (gu !== '전체') candidates = candidates.filter((c) => c.gu === gu);
  if (favOnly) candidates = candidates.filter((c) => state.favorites.has(courtKey(c)));
  const included = candidates.filter((c) => c.months && c.months[String(month)]);
  const excluded = candidates.filter((c) => !(c.months && c.months[String(month)]));
  return { included, excluded, month };
}

function updateScopeLine() {
  if (state.courts.length === 0) return;
  const { included, excluded } = getScope();
  let line = `조회 대상 ${included.length}곳`;
  if (excluded.length > 0) line += ` (해당 월 공고 없어 제외 ${excluded.length}곳)`;
  el.scopeLine.textContent = line;
  el.thresholdWarning.classList.add('hidden');
}

// ---- 조회 실행 ----
async function startSearch(confirmedThreshold) {
  const scope = getScope();
  if (!confirmedThreshold && scope.included.length > THRESHOLD) {
    el.thresholdCount.textContent = scope.included.length;
    el.thresholdWarning.classList.remove('hidden');
    return;
  }
  el.thresholdWarning.classList.add('hidden');

  if (state.running) return;
  state.running = true;
  el.searchBtn.disabled = true;

  state.results = new Map();
  for (const c of scope.excluded) {
    state.results.set(courtKey(c), { court: c, status: 'excluded' });
  }
  for (const c of scope.included) {
    state.results.set(courtKey(c), { court: c, status: 'pending' });
  }

  el.summary.classList.remove('hidden');
  el.resultsControls.classList.remove('hidden');
  el.emptyHint.classList.add('hidden');
  el.blockedBanner.classList.add('hidden');
  el.progressSection.classList.remove('hidden');
  el.progressFill.style.width = '0%';
  el.progressText.textContent = `0 / ${scope.included.length}`;
  render();

  const dateApi = dateToApi(el.dateInput.value);
  let done = 0;
  let blocked = false;

  async function worker(queue) {
    while (queue.length > 0 && !blocked) {
      const c = queue.shift();
      const key = courtKey(c);
      const monthInfo = c.months[String(scope.month)];
      try {
        const res = await apiFetch(`/api/slots?date=${dateApi}&resveId=${encodeURIComponent(monthInfo.id)}`);
        if (res.status === 429) {
          const body = await res.json().catch(() => ({}));
          blocked = true;
          showBlocked(body.blockedRemainingMs || 300000);
          state.results.set(key, { court: c, status: 'error', error: '차단으로 중단됨' });
        } else if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          state.results.set(key, { court: c, status: 'error', error: body.error || `오류 (${res.status})` });
        } else {
          const data = await res.json();
          state.results.set(key, { court: c, status: 'ok', ...data });
        }
      } catch (err) {
        state.results.set(key, { court: c, status: 'error', error: '네트워크 오류' });
      }
      done++;
      el.progressFill.style.width = `${Math.round((done / scope.included.length) * 100)}%`;
      el.progressText.textContent = `${done} / ${scope.included.length}`;
      render();
    }
  }

  const queue = [...scope.included];
  const workers = Array.from({ length: Math.min(CLIENT_CONCURRENCY, queue.length) }, () => worker(queue));
  await Promise.all(workers);

  el.progressSection.classList.add('hidden');
  state.running = false;
  el.searchBtn.disabled = false;
}

function showBlocked(remainingMs) {
  el.blockedBanner.classList.remove('hidden');
  let remaining = Math.ceil(remainingMs / 1000);
  const tick = () => {
    const m = Math.floor(remaining / 60);
    const s = remaining % 60;
    el.blockedText.textContent = `용인 서버 레이트 리밋 차단이 감지되어 조회를 멈췄습니다. 약 ${m}분 ${s}초 후 다시 시도할 수 있어요.`;
    remaining -= 1;
    if (remaining < 0) {
      clearInterval(timer);
      el.blockedText.textContent = '차단 시간이 지났습니다. 다시 조회해보세요.';
    }
  };
  tick();
  const timer = setInterval(tick, 1000);
}

// ---- 렌더링 ----
function render() {
  renderSummary();
  if (state.view === 'time') renderTimeView();
  else renderCourtView();
}

function renderSummary() {
  const all = [...state.results.values()];
  const okResults = all.filter((r) => r.status === 'ok');
  const freeCourts = okResults.filter((r) => r.free && r.free.length > 0).length;
  const freeSlots = okResults.reduce((sum, r) => sum + (r.free ? r.free.length : 0), 0);
  el.statFreeCourts.textContent = freeCourts;
  el.statFreeSlots.textContent = freeSlots;
  el.statChecked.textContent = okResults.length;
}

function rangeStartMinutes(range) {
  const m = /^(\d{2}):(\d{2})/.exec(range);
  if (!m) return 0;
  return parseInt(m[1], 10) * 60 + parseInt(m[2], 10);
}

function renderTimeView() {
  const okResults = [...state.results.values()].filter((r) => r.status === 'ok');
  const byLabel = new Map(); // label -> [{court, resveId}]
  for (const r of okResults) {
    for (const f of r.free) {
      if (!byLabel.has(f.label)) byLabel.set(f.label, []);
      byLabel.get(f.label).push({ court: r.court, resveId: r.court.months[String(currentMonth())].id });
    }
  }
  const labels = [...byLabel.keys()].sort((a, b) => rangeStartMinutes(a) - rangeStartMinutes(b));

  if (labels.length === 0) {
    el.viewTime.innerHTML = okResults.length
      ? '<p class="empty-hint">이 조건에서 빈 시간대가 없습니다.</p>'
      : '';
    return;
  }

  el.viewTime.innerHTML = labels
    .map((label) => {
      const courts = byLabel.get(label);
      const chips = courts
        .map(
          (c) =>
            `<a class="chip" href="${VIEW_URL(c.resveId)}" target="_blank" rel="noopener">${escapeHtml(c.court.name)}</a>`,
        )
        .join('');
      return `
        <div class="time-block">
          <div class="time-block-head">
            <span class="time-block-range">${label}</span>
            <span class="time-block-count">${courts.length}곳 비어있음</span>
          </div>
          <div class="chip-row">${chips}</div>
        </div>`;
    })
    .join('');
}

function renderCourtView() {
  const rows = [...state.results.values()];
  const visible = state.freeOnly
    ? rows.filter((r) => r.status !== 'ok' || (r.free && r.free.length > 0))
    : rows;

  if (visible.length === 0) {
    el.viewCourt.innerHTML = '<p class="empty-hint">표시할 코트가 없습니다.</p>';
    return;
  }

  el.viewCourt.innerHTML = visible
    .map((r) => {
      const key = courtKey(r.court);
      const isFav = state.favorites.has(key);
      const resveId = r.court.months[String(currentMonth())]?.id;

      let statusHtml = '';
      let slotsHtml = '';
      if (r.status === 'excluded') {
        statusHtml = '<p class="court-status">이번 달 공고 없음 — 제외됨</p>';
      } else if (r.status === 'pending') {
        statusHtml = '<p class="court-status">조회 중...</p>';
      } else if (r.status === 'error') {
        statusHtml = `<p class="court-status err">${escapeHtml(r.error || '오류')}</p>`;
      } else {
        const all = [
          ...r.free.map((f) => ({ label: f.label, free: true })),
          ...r.booked.map((b) => ({ label: b.label, free: false })),
        ].sort((a, b) => rangeStartMinutes(a.label) - rangeStartMinutes(b.label));
        if (all.length === 0) {
          statusHtml = '<p class="court-status">운영 시간대 정보 없음</p>';
        } else {
          slotsHtml = `<div class="slot-grid">${all
            .map((s) =>
              s.free
                ? `<a class="slot free" href="${VIEW_URL(resveId)}" target="_blank" rel="noopener">${s.label}</a>`
                : `<span class="slot booked">${s.label}</span>`,
            )
            .join('')}</div>`;
        }
      }

      return `
        <div class="court-card ${r.status}">
          <div class="court-card-head">
            <div>
              <div class="court-name">${escapeHtml(r.court.name)}</div>
              <div class="court-loc">${escapeHtml(r.court.gu)} · ${escapeHtml(r.court.emd)}</div>
            </div>
            <button class="fav-btn ${isFav ? 'active' : ''}" data-key="${escapeHtml(key)}" aria-label="관심 코트 등록">${isFav ? '★' : '☆'}</button>
          </div>
          ${statusHtml}
          ${slotsHtml}
        </div>`;
    })
    .join('');

  el.viewCourt.querySelectorAll('.fav-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const key = btn.dataset.key;
      if (state.favorites.has(key)) state.favorites.delete(key);
      else state.favorites.add(key);
      saveFavorites();
      updateFavoritesCount();
      renderCourtView();
    });
  });
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

init();
