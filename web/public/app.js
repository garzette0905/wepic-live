// ---------- 화면 전환 (홈 / 사진선택·동기화 / 슬라이드쇼) ----------
const homeShell = document.getElementById('home-shell');
const pickerShell = document.getElementById('picker-shell');
const slideshowEl = document.getElementById('screen-slideshow');
const pickerScreens = {
  source: document.getElementById('screen-source'),
  sync: document.getElementById('screen-sync'),
};

const heroEl = document.querySelector('.hero');
const homeBodyEl = document.querySelector('.home-body');
const homeFrameEl = document.querySelector('.home-frame');

// wepic 메인화면(슬라이드쇼)은 홈페이지의 "하위 프레임"으로 보여준다 — 상단 메뉴는 그대로
// 두고 그 아래 영역만 사진으로 채운다. 그래서 마크업상 별도 형제였던 슬라이드쇼를 시작할 때
// home-body 안으로 옮겨 flex 레이아웃에 참여시킨다(고정 오프셋 계산이 필요 없어 반응형에
// 강하다). 전체화면은 이 요소 자체를 대상으로 하므로 메뉴 없이 사진만 꽉 찬다.
homeBodyEl.appendChild(slideshowEl);

// 슬라이드쇼 재생을 멈춘다(타이머·동영상·배경음악). 홈으로 나가는 모든 경로가 이걸 거치므로
// Demo든 실제 액자든 어떤 경로로 나가도 사운드가 뒤에서 계속 흐르는 일이 없다.
function stopSlideshowPlayback() {
  if (intervalHandle) { clearInterval(intervalHandle); intervalHandle = null; }
  const v = document.getElementById('video-layer');
  try { v.pause(); v.removeAttribute('src'); v.load(); } catch { /* 무시 */ }
  v.classList.remove('active');
  try { ytPlayer?.pauseVideo?.(); } catch { /* 무시 */ }
  try { previewAudio?.pause?.(); } catch { /* 무시 */ } // 미리듣기 오디오도 함께 멈춘다
  musicPlaying = false;
  syncMusicButton();
}
function showHome() {
  pickerShell.classList.add('hidden');
  slideshowEl.classList.add('hidden');
  heroEl.classList.remove('hidden');      // 로고 배너 복귀
  homeFrameEl.classList.remove('hidden'); // 패널 영역 복귀
  homeShell.classList.remove('hidden');
  setWakeLock(false);                     // 사진을 안 보는 화면에서는 절전을 막지 않는다
  stopSlideshowPlayback();                // 재생 중이던 동영상·배경음악도 함께 멈춘다
}
function showPicker(name) {
  // QR·동기화는 짧게 지나가는 중간 단계라 지금처럼 전체 화면으로 둔다.
  homeShell.classList.add('hidden');
  slideshowEl.classList.add('hidden');
  setWakeLock(false);
  pickerShell.classList.remove('hidden');
  Object.entries(pickerScreens).forEach(([k, el]) => el.classList.toggle('hidden', k !== name));
}
function showSlideshow() {
  pickerShell.classList.add('hidden');
  homeShell.classList.remove('hidden');   // 상단 메뉴를 보이게 하려고 홈 셸은 유지한다
  heroEl.classList.add('hidden');         // 로고 배너는 숨겨 사진 영역을 최대한 넓힌다
  homeFrameEl.classList.add('hidden');    // 안내 패널 영역은 숨긴다
  document.getElementById('admin-side-menu').classList.add('hidden');
  document.getElementById('my-side-menu').classList.add('hidden');
  slideshowEl.classList.remove('hidden');
  setWakeLock(true);                      // 액자로 보는 화면이므로 자동으로 꺼지지 않게 한다
  resetSlideshowScroll();
}

// 모바일에서는 사진 아래로 설정 패널이 이어지는 세로 배치라, 진입 시 스크롤이 아래에
// 남아 있으면 사진이 안 보인다 → 항상 맨 위(사진)부터 보이도록 되돌린다.
// 사진 목록이 그려진 뒤에 높이가 바뀌므로 즉시 + 다음 프레임 + 짧은 지연에서 각각 되돌린다
// (한 번만 하면 렌더링 전에 실행돼 효과가 없을 수 있다).
function resetSlideshowScroll() {
  const doReset = () => {
    slideshowEl.scrollTop = 0;               // 모바일: 슬라이드쇼가 스크롤 컨테이너
    document.querySelector('.info-pane')?.scrollTo?.({ top: 0 }); // 데스크톱: 설정 패널이 스크롤
    homeBodyEl.scrollTop = 0;
  };
  doReset();
  requestAnimationFrame(doReset);
  setTimeout(doReset, 120);
}

// ---------- 홈 상단 메뉴 / 관리자·My사진관리 좌측 메뉴 / 패널 ----------
// 홈에서 보여줄 패널. 예전에는 서비스 소개(about)였지만, 들어오자마자 실제 사진이
// 보이는 편이 낫다는 판단으로 전체공유 목록(feed)을 홈으로 쓴다("사진 보기"와 같은 화면).
const HOME_PANEL = 'feed';

function selectPanel(name) {
  showHome();
  const isAdminPanel = name.startsWith('admin-');
  const isMyPanel = name.startsWith('my-');
  // 상단 메뉴: 관리자/My사진관리 패널을 보고 있으면 그 상위 메뉴 항목을 켠 상태로 둔다.
  // 홈 아이콘(.menu-home)도 함께 다룬다. 로그인 상태 표시(.menu-status)는 누를 수 없는
  // 항목이라 active 대상에서 제외한다.
  document.querySelectorAll('#home-menu .menu-item, #home-menu .menu-home').forEach((b) => {
    if (b.classList.contains('menu-status')) return;
    // 로고(홈)는 "사진 보기"와 같은 패널을 가리키므로, 켜면 둘이 함께 강조돼 헷갈린다.
    // 로고는 언제나 로고로만 보이게 두고 강조는 메뉴 항목에만 준다.
    if (b.classList.contains('menu-home')) { b.classList.remove('active'); return; }
    let on;
    if (isAdminPanel) on = b.id === 'menu-admin';
    else if (isMyPanel) on = b.id === 'menu-my';
    else on = b.dataset.panel === name;
    b.classList.toggle('active', on);
  });
  // 좌측 하위 메뉴: 각각 자기 패널 그룹일 때만 나타나고, 현재 항목을 표시한다.
  document.getElementById('admin-side-menu').classList.toggle('hidden', !isAdminPanel);
  document.getElementById('my-side-menu').classList.toggle('hidden', !isMyPanel);
  document.querySelectorAll('#admin-side-menu .menu-item, #my-side-menu .menu-item').forEach((b) =>
    b.classList.toggle('active', b.dataset.panel === name));
  document.querySelectorAll('.home-frame .panel').forEach((p) =>
    p.classList.toggle('hidden', p.id !== 'panel-' + name));
  // 관리자 패널을 보고 있을 때만 좌측 상단 ADMIN 배지 표시
  document.getElementById('admin-badge').classList.toggle('hidden', !isAdminPanel);
  if (name === 'admin-screens') loadShareList('admin-shares-list', 'admin');
  if (name === 'admin-pins') loadShareList('admin-pins-list', 'admin');
  if (name === 'admin-defaults') fillDefaultsForm();
  if (name === 'admin-members') loadMemberList();
  if (name === 'my-screens') loadShareList('my-shares-list', 'my');
  if (name === 'my-pins') loadShareList('my-pins-list', 'my');
  if (name === 'signup') refreshSignupGate(); // 동의 상태에 맞춰 가입 버튼 활성/비활성
  // "갤러리에서 사진 추가"는 이미 보고 있는 사진이 있을 때만 노출한다.
  if (name === 'photos') {
    document.getElementById('btn-pick-local-add').classList.toggle('hidden', allPhotos.length === 0);
    // 버튼을 누르는 순간 frames가 준비돼 있어야 "새로 만들기 / 기존 수정"을 물을 수 있다.
    // (기기 갤러리 경로는 사용자 클릭 안에서 input.click()을 해야 해 await를 걸 수 없다)
    if (isLoggedIn) loadFrames();
  }
  // "사진 보기": 전체공유 카드 목록을 매번 새로 불러온다(다른 회원이 그새 새로 공개했을 수 있음).
  if (name === 'feed') loadPublicFeed();
}
// data-panel이 있는 항목만 클릭으로 이동한다(로그인 상태 표시는 data-panel이 없어 제외됨).
document.querySelectorAll(
  '#home-menu .menu-item[data-panel], #home-menu .menu-home[data-panel],'
  + ' #admin-side-menu .menu-item, #my-side-menu .menu-item'
).forEach((b) => b.addEventListener('click', () => selectPanel(b.dataset.panel)));
document.querySelectorAll('[data-goto]').forEach((el) =>
  el.addEventListener('click', (e) => { e.preventDefault(); selectPanel(el.dataset.goto); }));

async function api(url, opts) {
  const res = await fetch(url, { credentials: 'same-origin', ...opts });
  if (res.status === 401) { selectPanel('login'); throw new Error('로그인이 필요합니다.'); }
  if (!res.ok) {
    // 원인 파악을 위해 JSON의 error, 없으면 본문 텍스트라도 보여준다.
    const body = await res.text().catch(() => '');
    let msg = '';
    try { msg = JSON.parse(body).error || ''; } catch { msg = body.slice(0, 300).trim(); }
    throw new Error(msg || `요청 실패 (${res.status})`);
  }
  return res.json();
}

// ---------- 로그인 안내 ----------
const AUTH_ERROR_MESSAGES = {
  missing_photos_scope:
    '로그인 중 "Google 포토" 권한에 동의하지 않아 사진을 가져올 수 없습니다. ' +
    '아래 버튼으로 다시 로그인하시고, 동의 화면에서 사진 관련 권한 체크박스를 꼭 체크해주세요.',
};

// ---------- 사진 선택 (Picker) ----------
let pickerSessionId = null;
let pickerPollTimer = null;

async function startPickerFlow() {
  // 구글 포토 Picker는 구글 계정 권한이 필요하다. 카카오·네이버로 로그인한 상태에서
  // 여기까지 들어오면 구글 인증 오류가 나므로, 아예 시작하지 않고 사진 선택 패널로
  // 되돌려 "기기 갤러리에서 올리기" UI를 쓰게 한다.
  if (!canUseGooglePhotos) {
    selectPanel('photos');
    showToast('구글 계정으로 로그인한 경우에만 구글 포토에서 고를 수 있습니다. 기기 갤러리에서 선택해주세요.');
    return;
  }
  showPicker('source');
  const qrEl = document.getElementById('source-qr');
  const statusEl = document.getElementById('source-status-text');
  const backEl = document.getElementById('btn-back-to-slideshow');
  const errEl = document.getElementById('source-error');
  const openBtn = document.getElementById('btn-open-picker');
  const noticeEl = document.getElementById('account-notice-picker');
  qrEl.classList.add('hidden');
  errEl.classList.add('hidden');
  statusEl.textContent = '선택 화면을 준비하는 중...';
  // 이미 보고 있던 사진이 있을 때만 "돌아가기"를 보여준다 (최초 선택 시에는 돌아갈 곳이 없음)
  backEl.classList.toggle('hidden', allPhotos.length === 0);

  if (loggedInName) {
    noticeEl.textContent = `사진은 ${loggedInName} 계정으로만 가능합니다.`;
    noticeEl.classList.remove('hidden');
  } else {
    noticeEl.classList.add('hidden');
  }

  try {
    const s = await api('/api/picker/session', { method: 'POST' });
    pickerSessionId = s.id;
    // QR은 서버가 보내주면 그대로 쓰고, 없으면(Cloudflare Workers 등 CPU 제한 환경)
    // 브라우저에서 직접 만든다. pickerUri를 외부로 보내지 않는다.
    const qrSrc = s.qrDataUrl || (window.makeQrDataUrl ? window.makeQrDataUrl(s.pickerUri) : '');
    qrEl.src = qrSrc;
    qrEl.classList.toggle('hidden', !qrSrc);
    openBtn.onclick = () => window.open(s.pickerUri, '_blank');
    statusEl.textContent = '사진을 선택하면 자동으로 이어집니다...';
    pollPicker();
  } catch (err) {
    statusEl.textContent = '';
    errEl.textContent = err.message;
    errEl.classList.remove('hidden');
  }
}

document.getElementById('btn-back-to-slideshow').addEventListener('click', (e) => {
  e.preventDefault();
  if (pickerPollTimer) clearTimeout(pickerPollTimer);
  if (pickerSessionId) api(`/api/picker/session/${pickerSessionId}`, { method: 'DELETE' }).catch(() => {});
  showSlideshow();
  resetTimer();
});
document.getElementById('btn-picker-home').addEventListener('click', (e) => {
  e.preventDefault();
  if (pickerPollTimer) clearTimeout(pickerPollTimer);
  if (pickerSessionId) api(`/api/picker/session/${pickerSessionId}`, { method: 'DELETE' }).catch(() => {});
  selectPanel('photos');
});

function pollPicker() {
  if (pickerPollTimer) clearTimeout(pickerPollTimer);
  const tick = async () => {
    try {
      const s = await api(`/api/picker/session/${pickerSessionId}`);
      if (s.mediaItemsSet) { startSync(); return; }
    } catch { /* 네트워크 순단 무시 */ }
    pickerPollTimer = setTimeout(tick, 3000);
  };
  pickerPollTimer = setTimeout(tick, 3000);
}

// ---------- 동기화 ----------
async function startSync() {
  if (pickerPollTimer) clearTimeout(pickerPollTimer);
  showPicker('sync');
  const statusEl = document.getElementById('sync-status');
  const barEl = document.getElementById('sync-bar');
  statusEl.textContent = '선택한 사진을 불러오는 중...';
  barEl.style.width = '30%';

  try {
    const { items } = await api(`/api/picker/media?sessionId=${encodeURIComponent(pickerSessionId)}`);
    barEl.style.width = '100%';
    api(`/api/picker/session/${pickerSessionId}`, { method: 'DELETE' }).catch(() => {});
    if (!items.length) {
      statusEl.textContent = '선택된 사진이 없습니다. 다시 선택해주세요.';
      setTimeout(startPickerFlow, 1500);
      return;
    }
    let finalItems = items;
    if (appendMode && allPhotos.length) {
      // "사진 추가": 기존 사진 순서를 그대로 두고 **맨 뒤에** 덧붙인다(중복 id 제거).
      // 새 사진의 촬영일이 더 앞서더라도 앞으로 끼어들지 않는다 — 이미 남은 댓글이
      // 가리키는 사진 번호가 밀리지 않게 하기 위함이다.
      const seen = new Set(allPhotos.map((p) => p.id));
      const fresh = items.filter((it) => !seen.has(it.id))
        .sort((a, b) => new Date(a.createTime) - new Date(b.createTime));
      finalItems = allPhotos.concat(fresh);
    }
    appendMode = false;
    boot(finalItems);
  } catch (err) {
    appendMode = false;
    statusEl.textContent = '불러오기 실패: ' + err.message;
  }
}

// ---------- 슬라이드쇼 ----------
let allPhotos = [];
let filteredPhotos = [];
let currentIndex = 0;
let intervalHandle = null;
let activeLayer = 'a';
let slideshowPaused = false;
let appendMode = false;      // "사진 추가" 진행 중이면 새 사진을 기존에 덧붙임
let excludeMode = false;     // "사진 제외" 선택 모드
const excludeSel = new Set(); // 제외로 체크된 사진 id

// 재생/표시 설정 (localStorage에 저장)
let slideIntervalMs = 10000; // 전환 간격
let slideEffect = 'fade';    // 'fade' | 'slide' | 'kenburns'
let videoSoundOn = true;     // 동영상 소리 재생(재생 중 배경음악 정지) 여부
let musicPausedForVideo = false; // 동영상 재생을 위해 배경음악을 우리가 일시정지했는지
const photoPane = document.querySelector('.photo-pane');

function formatDate(iso) {
  const d = new Date(iso);
  const main = new Intl.DateTimeFormat('ko-KR', { year: 'numeric', month: 'long', day: 'numeric' }).format(d);
  const weekday = new Intl.DateTimeFormat('ko-KR', { weekday: 'long' }).format(d);
  const time = new Intl.DateTimeFormat('ko-KR', { hour: 'numeric', minute: '2-digit' }).format(d);
  return { main, sub: `${weekday} · ${time}` };
}

function renderPhotoList() {
  const strip = document.getElementById('photo-list-strip');
  strip.innerHTML = '';
  strip.classList.toggle('selecting', excludeMode);
  document.getElementById('photo-list-count').textContent = filteredPhotos.length;
  if (!filteredPhotos.length) {
    const span = document.createElement('span');
    span.className = 'empty';
    span.textContent = '표시할 사진이 없습니다.';
    strip.appendChild(span);
    return;
  }
  filteredPhotos.forEach((p) => {
    const cell = document.createElement('div');
    cell.className = 'thumb-cell';
    const img = document.createElement('img');
    img.src = p.thumbUrl;
    img.title = formatDate(p.createTime).main;
    if (p.type === 'video') {
      // 동영상 썸네일(정지 프레임) 요청이 간헐적으로 실패하면 깨진 이미지 아이콘이 보이므로,
      // 한 번은 원본 크기 이미지로 재시도하고, 그래도 실패하면 깨진 아이콘 대신 재생 배지만
      // 보이는 빈 박스로 대체한다.
      img.onerror = () => {
        if (!img.dataset.retried) { img.dataset.retried = '1'; img.src = p.fullUrl; return; }
        cell.classList.add('thumb-error');
      };
    }
    cell.appendChild(img);
    if (p.type === 'video') {
      const badge = document.createElement('span');
      badge.className = 'vid-badge';
      badge.textContent = '▶';
      cell.appendChild(badge);
    }

    if (excludeMode) {
      // 제외 모드: 클릭하면 선택 토글 (재생 이동 대신)
      if (excludeSel.has(p.id)) cell.classList.add('sel');
      const mark = document.createElement('span');
      mark.className = 'check-mark';
      mark.textContent = '✓';
      cell.appendChild(mark);
      cell.addEventListener('click', () => {
        if (excludeSel.has(p.id)) excludeSel.delete(p.id);
        else excludeSel.add(p.id);
        cell.classList.toggle('sel');
        document.getElementById('exclude-count').textContent = excludeSel.size;
      });
    } else {
      cell.addEventListener('click', () => jumpTo(p.id));
    }
    strip.appendChild(cell);
  });
  if (!excludeMode) updateActiveThumb();
}

function updateActiveThumb() {
  const strip = document.getElementById('photo-list-strip');
  [...strip.children].forEach((el, idx) => el.classList?.toggle('current', idx === currentIndex));
  strip.children[currentIndex]?.scrollIntoView?.({ block: 'nearest' });
}

function jumpTo(id) {
  const idx = filteredPhotos.findIndex((p) => p.id === id);
  if (idx === -1) return;
  currentIndex = idx;
  showCurrent();
  resetTimer();
}

// 로드된 Image를 그대로 넘겨준다(naturalWidth/Height로 화면비를 판단하기 위해).
function preload(url) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => resolve(img);
    img.src = url;
  });
}

// ---------- 세로 사진 배경 채우기 (가우시안 블러) ----------
// 사진 화면비가 화면과 5% 이상 다르면 object-fit:contain 때문에 양옆(또는 위아래)에 검은
// 여백이 생긴다. 그럴 때만 같은 사진을 흐리게 깔아 여백을 메운다(여백이 없는 사진에는
// 불필요한 blur 연산을 하지 않는다).
let lastShownImg = null;
function needsBackdrop(im) {
  if (!im || !im.naturalWidth || !im.naturalHeight) return false;
  const box = document.querySelector('.photo-pane');
  const w = box?.clientWidth, h = box?.clientHeight;
  if (!w || !h) return false;
  const screenRatio = w / h;
  return Math.abs(im.naturalWidth / im.naturalHeight - screenRatio) / screenRatio > 0.05;
}
function applyBackdrop(layer, im, url) {
  const bg = document.getElementById(`photo-${layer}-bg`);
  if (im && needsBackdrop(im)) {
    bg.src = url;
    bg.classList.add('active');
  } else {
    bg.classList.remove('active');
  }
}
function clearBackdrops() {
  document.getElementById('photo-a-bg').classList.remove('active');
  document.getElementById('photo-b-bg').classList.remove('active');
}
// 전체화면 전환·창 크기 변경으로 화면비가 바뀌면 여백 여부도 달라진다 → 지금 보이는 사진만 다시 판단.
function refreshBackdrop() {
  if (!lastShownImg) return;
  applyBackdrop(activeLayer, lastShownImg, lastShownImg.src);
}
window.addEventListener('resize', refreshBackdrop);

// ---------- 화면 자동 꺼짐 방지 (Screen Wake Lock) ----------
// 액자로 세워둔 태블릿·PC가 절전으로 화면을 끄면 사진이 안 보인다 → 슬라이드쇼를 보는 동안은
// 화면을 깨워 둔다. 지원하지 않는 브라우저(iOS 사파리 등)나 사용자가 막은 경우에는 조용히
// 넘어가고 기능만 없이 정상 동작한다.
let wakeLock = null;
let wantWakeLock = false;
async function acquireWakeLock() {
  if (!wantWakeLock || wakeLock || !('wakeLock' in navigator)) return;
  try {
    wakeLock = await navigator.wakeLock.request('screen');
    // 다른 탭·앱으로 넘어가면 브라우저가 알아서 해제한다 → 참조를 비워 다시 잡을 수 있게 한다.
    wakeLock.addEventListener('release', () => { wakeLock = null; });
  } catch { wakeLock = null; }
}
function setWakeLock(on) {
  wantWakeLock = !!on;
  if (on) { acquireWakeLock(); return; }
  const l = wakeLock; wakeLock = null;
  try { l?.release(); } catch { /* 무시 */ }
}
// 돌아왔을 때는 잠금이 풀려 있으므로 다시 잡는다.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') acquireWakeLock();
});

// 현재 재생 중인 동영상을 멈추고 정리한다.
function stopVideo() {
  const v = document.getElementById('video-layer');
  if (!v) return;
  try { v.pause(); } catch {}
  v.onended = null;
  v.onerror = null;
  if (v.getAttribute('src')) { v.removeAttribute('src'); try { v.load(); } catch {} }
  v.classList.remove('active');
}

function updateMeta(photo) {
  const { main, sub } = formatDate(photo.createTime);
  document.getElementById('cur-date-main').textContent = main;
  document.getElementById('cur-date-sub').textContent = sub;
  renderPhotoCounter();
  updateFullscreenCaption(photo);
  updateActiveThumb();
  updateProgress();
  updateDownloadBtn(); // 동영상이면 저장 버튼 비활성
}

// 하단 진행바: 현재 사진이 전체에서 몇 번째인지 (희미한 참고용)
function updateProgress() {
  const fill = document.getElementById('progress-strip-fill');
  if (!fill) return;
  const total = filteredPhotos.length;
  const pct = total ? ((currentIndex + 1) / total) * 100 : 0;
  fill.style.width = pct + '%';
}

async function showCurrent() {
  if (!filteredPhotos.length) return;
  const photo = filteredPhotos[currentIndex];
  const requested = currentIndex;
  const video = document.getElementById('video-layer');

  if (photo.type === 'video' && photo.videoUrl) {
    // 동영상: 사진 레이어를 숨기고 비디오를 재생한다. 자동 전환 타이머 대신
    // 재생이 끝나면(onended) 다음으로 넘어간다. 배경음악과 충돌하지 않도록 음소거.
    stopVideo();
    document.getElementById('photo-a').classList.remove('active');
    document.getElementById('photo-b').classList.remove('active');
    lastShownImg = null;
    clearBackdrops(); // 동영상은 원본 그대로 재생한다(흐린 배경을 깔지 않는다)
    video.poster = photo.fullUrl;
    if (videoSoundOn) {
      video.muted = false;
      pauseMusicForVideo(); // 소리 있는 동영상 재생 동안 배경음악 정지
    } else {
      video.muted = true;   // 옵션 꺼짐: 음소거로 재생(배경음악 유지)
    }
    video.src = photo.videoUrl;
    video.classList.add('active');
    if (intervalHandle) { clearInterval(intervalHandle); intervalHandle = null; }
    video.onended = () => { if (!slideshowPaused) advance(); };
    // 재생 불가(코덱 미지원·손상 등)로 onended가 안 오면 슬라이드쇼가 멈추므로,
    // 오류 시 잠시 뒤 다음 항목으로 넘어가 정지되지 않게 한다.
    video.onerror = () => {
      // 조용히 지나가면 "왜 이 동영상만 안 나오지?"가 되므로 이유를 알려준다.
      // (동영상은 이제 사진 추가에서 막지 않는다 — 대신 못 트는 포맷일 때만 이렇게 안내한다)
      showToast('이 동영상은 포맷(코덱)이 맞지 않아 재생할 수 없습니다. 다음 사진으로 넘어갑니다.');
      setTimeout(() => { if (!slideshowPaused && filteredPhotos[currentIndex] === photo) advance(); }, 1500);
    };
    if (!slideshowPaused) {
      video.play().catch(() => {
        // 소리 있는 자동재생이 브라우저에 막히면 음소거로 폴백하고 배경음악은 복귀시킨다.
        if (videoSoundOn) { video.muted = true; resumeMusicAfterVideo(); video.play().catch(() => {}); }
      });
    }
    updateMeta(photo);
    return;
  }

  // 사진: 기존 두 레이어 크로스페이드
  stopVideo();
  resumeMusicAfterVideo(); // 동영상 → 사진 전환 시 정지했던 배경음악 복귀
  const nextName = activeLayer === 'a' ? 'b' : 'a';
  const nextLayer = document.getElementById('photo-' + nextName);
  const prevLayer = document.getElementById('photo-' + activeLayer);
  const im = await preload(photo.fullUrl);
  if (requested !== currentIndex) return;
  nextLayer.src = photo.fullUrl;
  // 켄번즈: 이 레이어에 새 애니메이션을 처음부터 다시 건다. 지금 보이는(나가는) 레이어의
  // .kb-run은 **그대로 둔다** — 벗기면 확대돼 있던 사진이 원래 크기로 툭 되돌아가며 사라진다.
  nextLayer.classList.remove('kb-run');
  void nextLayer.offsetWidth;         // 리플로우 강제 — 안 하면 애니메이션이 재시작되지 않는다
  nextLayer.classList.add('kb-run');
  applyBackdrop(nextName, im, photo.fullUrl);    // 여백이 생기는 사진이면 흐린 배경을 함께 띄운다
  document.getElementById(`photo-${activeLayer}-bg`).classList.remove('active');
  nextLayer.classList.add('active');
  prevLayer.classList.remove('active');
  lastShownImg = im;
  activeLayer = nextName;
  updateMeta(photo);
}

function updateFullscreenCaption(photo) {
  const el = document.getElementById('fullscreen-caption');
  const d = new Date(photo.createTime);
  const dateStr = new Intl.DateTimeFormat('ko-KR', { year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
  const timeStr = new Intl.DateTimeFormat('ko-KR', { hour: '2-digit', minute: '2-digit' }).format(d);
  const lines = [`${dateStr} ${timeStr}`];
  if (photo.place) lines.push(photo.place);
  if (musicPlaying && musicTitle) lines.push(`♪ ${musicTitle}`);
  el.textContent = '';
  lines.forEach((line, i) => {
    if (i > 0) el.appendChild(document.createElement('br'));
    el.appendChild(document.createTextNode(line));
  });
}
function refreshCaption() {
  const photo = filteredPhotos[currentIndex];
  if (photo) updateFullscreenCaption(photo);
}

function advance() {
  if (!filteredPhotos.length) return;
  currentIndex = (currentIndex + 1) % filteredPhotos.length;
  showCurrent();
  resetTimer(); // 새 항목이 사진이면 다음 전환 타이머를, 동영상이면 재생 종료 대기로 전환
}

// 사용자가 좌측 아이콘으로 직접 이전(-1)/다음(+1)으로 넘긴다. wepic 공유화면의 step()과 동일하게,
// 자동 전환 타이머를 끊고 처음부터 다시 걸어 방금 넘긴 사진이 곧바로 지나가지 않게 한다.
function goToPhoto(delta) {
  if (!filteredPhotos.length) return;
  if (intervalHandle) { clearInterval(intervalHandle); intervalHandle = null; }
  currentIndex = (currentIndex + delta + filteredPhotos.length) % filteredPhotos.length;
  showCurrent();
  resetTimer();
}
function resetTimer() {
  if (intervalHandle) clearInterval(intervalHandle);
  intervalHandle = null;
  if (slideshowPaused) return;
  // 동영상은 재생이 끝날 때 넘어가므로(고정 타이머 X) 타이머를 걸지 않는다.
  const cur = filteredPhotos[currentIndex];
  if (cur && cur.type === 'video') return;
  intervalHandle = setInterval(advance, slideIntervalMs);
}

function setSlideshowPaused(paused) {
  slideshowPaused = paused;
  // 설정 패널의 "화면 잠시멈춤" 버튼은 없앴다 — 사진 위 좌측 아이콘 줄의 ⏸ 버튼만 쓴다.
  const iconBtn = document.getElementById('btn-photo-pause');
  if (iconBtn) {
    iconBtn.classList.toggle('paused', paused);
    iconBtn.title = paused ? '사진 슬라이드 재개' : '사진 슬라이드 멈춤';
  }
  const video = document.getElementById('video-layer');
  const cur = filteredPhotos[currentIndex];
  if (paused) {
    if (intervalHandle) clearInterval(intervalHandle);
    intervalHandle = null;
    try { video.pause(); } catch {}
  } else if (cur && cur.type === 'video') {
    video.play().catch(() => {}); // 현재 항목이 동영상이면 이어서 재생
  } else {
    resetTimer();
  }
}
document.getElementById('btn-photo-pause').addEventListener('click', () => setSlideshowPaused(!slideshowPaused));
document.getElementById('btn-photo-prev').addEventListener('click', () => goToPhoto(-1));
document.getElementById('btn-photo-next').addEventListener('click', () => goToPhoto(1));
document.getElementById('btn-photo-home').addEventListener('click', stopEverythingAndGoHome);

// ---------- 방향 필터 ----------
let orientationMode = 'all'; // 'all' | 'landscape' | 'portrait'

function orientationOf(p) {
  if (!p.width || !p.height) return null; // 크기 정보 없으면 방향 미상
  return p.width >= p.height ? 'landscape' : 'portrait';
}

// 방향 조건을 적용해 현재 표시할 사진 목록을 다시 계산한다.
function recomputeFiltered() {
  let list = allPhotos;
  if (orientationMode !== 'all') {
    const byOrient = list.filter((p) => orientationOf(p) === orientationMode);
    if (!byOrient.length) {
      showToast(orientationMode === 'landscape' ? '가로 사진이 없습니다.' : '세로 사진이 없습니다.');
      orientationMode = 'all';
      const allRadio = document.querySelector('#orientation-radios input[value="all"]');
      if (allRadio) allRadio.checked = true;
    } else {
      list = byOrient;
    }
  }
  filteredPhotos = list;
  currentIndex = 0;
  renderPhotoList();
  showCurrent();
  resetTimer();
}

document.querySelectorAll('#orientation-radios input').forEach((r) =>
  r.addEventListener('change', () => { if (r.checked) { orientationMode = r.value; recomputeFiltered(); } })
);

// ---------- 전체화면 / 공유 ----------
// 슬라이드쇼가 홈페이지 하위 프레임 안에 있으므로, 페이지 전체(documentElement)를 전체화면으로
// 만들면 상단 메뉴까지 같이 커진다. 슬라이드쇼 요소 자체를 전체화면 대상으로 삼아 사진만
// 화면을 꽉 채우게 한다.
function setFullscreen(on) {
  document.body.classList.toggle('fullscreen', on);
  if (on) slideshowEl.requestFullscreen?.().catch(() => {});
  else if (document.fullscreenElement) document.exitFullscreen?.().catch(() => {});
}
const toggleFullscreen = () => setFullscreen(!document.body.classList.contains('fullscreen'));
document.getElementById('btn-fullscreen').addEventListener('click', toggleFullscreen);
document.addEventListener('fullscreenchange', () => {
  // 사용자가 F11/Esc로 직접 빠져나온 경우 상태 동기화
  document.body.classList.toggle('fullscreen', !!document.fullscreenElement);
  refreshBackdrop(); // 화면비가 바뀌므로 흐린 배경이 필요한지 다시 판단
});

let toastHandle = null;
function showToast(msg) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.classList.remove('hidden');
  if (toastHandle) clearTimeout(toastHandle);
  toastHandle = setTimeout(() => el.classList.add('hidden'), 2500);
}

// ---------- 다운로드 (현재 사진 1장) ----------
// 서버가 ?dl=<파일명>에 Content-Disposition: attachment 를 붙여주므로, blob을 만들지 않고
// "실제 URL"을 가리키는 <a>만 클릭한다. blob: URL은 카카오톡 등 인앱 브라우저(WebView)의
// 다운로드 매니저가 받아올 수 없어 저장이 실패하기 때문이다.
// 동영상은 저장 대상이 아니다(아이콘 비활성).
function photoFileName(photo, idx) {
  const d = new Date(photo.createTime);
  const stamp = Number.isNaN(d.getTime())
    ? String(idx + 1).padStart(3, '0')
    : `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}_${String(d.getHours()).padStart(2, '0')}${String(d.getMinutes()).padStart(2, '0')}`;
  return `wepic_${String(idx + 1).padStart(3, '0')}_${stamp}.jpg`;
}
function downloadPhoto(photo, idx) {
  const filename = photoFileName(photo, idx);
  const sep = photo.fullUrl.includes('?') ? '&' : '?';
  const a = document.createElement('a');
  a.href = `${photo.fullUrl}${sep}dl=${encodeURIComponent(filename)}`;
  a.download = filename; // PC 브라우저용 힌트(실제 강제는 서버 헤더가 담당)
  document.body.appendChild(a);
  a.click();
  a.remove();
}

// 현재 항목이 동영상이면 저장 불가 → 버튼 비활성화
function updateDownloadBtn() {
  const btn = document.getElementById('btn-download');
  if (!btn) return;
  const cur = filteredPhotos[currentIndex];
  const isVideo = !!(cur && cur.type === 'video');
  btn.disabled = !cur || isVideo;
  btn.title = isVideo ? '동영상은 저장할 수 없습니다' : '이 사진 저장';
}

document.getElementById('btn-download').addEventListener('click', () => {
  const photo = filteredPhotos[currentIndex];
  if (!photo) { showToast('저장할 사진이 없습니다.'); return; }
  if (photo.type === 'video') { showToast('동영상은 저장할 수 없습니다.'); return; }
  downloadPhoto(photo, currentIndex);
  showToast('저장을 시작했습니다.');
});

// ---------- 배경음악 (YouTube IFrame API) ----------
// 데모·로그인 모두 처음 진입 시 이 곡을 기본 배경음악으로 채운다.
const DEFAULT_MUSIC_URL = 'https://www.youtube.com/watch?v=wqX7AxcYTj8';
let ytPlayer = null;
let ytReady = null;
let musicLoaded = false;
let musicPlaying = false;
let musicTitle = '';

// 설정 패널의 "▶/⏸ 재생하기" 텍스트 버튼과, 사진 위 좌측 아이콘 줄의 음악 아이콘은
// 같은 상태(musicLoaded·musicPlaying)를 보여주는 두 개의 표시일 뿐이다 — 한 곳에서 갱신한다.
function syncMusicButton() {
  const textBtn = document.getElementById('btn-music-load');
  if (textBtn) textBtn.textContent = musicPlaying ? '⏸' : '▶';
  const iconBtn = document.getElementById('btn-photo-music');
  if (iconBtn) {
    iconBtn.classList.toggle('hidden', !musicLoaded); // 곡이 준비되기 전에는 숨긴다(공유화면과 동일)
    iconBtn.classList.toggle('paused', !musicPlaying);
    iconBtn.title = musicPlaying ? '배경음악 일시정지' : '배경음악 재생';
  }
}

// 유튜브 곡 제목은 매우 길 때가 많아(가수·앨범·태그까지 붙음) 화면을 밀어낸다.
// 20자까지만 보여주고 넘치면 …로 줄인다.
const MUSIC_TITLE_MAX = 20;
function shortMusicTitle(t) {
  const s = String(t || '').trim();
  return s.length > MUSIC_TITLE_MAX ? s.slice(0, MUSIC_TITLE_MAX) + '…' : s;
}

function loadYouTubeApi() {
  if (ytReady) return ytReady;
  ytReady = new Promise((resolve) => {
    if (window.YT && window.YT.Player) return resolve();
    window.onYouTubeIframeAPIReady = resolve;
    const tag = document.createElement('script');
    tag.src = 'https://www.youtube.com/iframe_api';
    document.head.appendChild(tag);
  });
  return ytReady;
}

function extractYouTubeId(url) {
  const pats = [/youtu\.be\/([\w-]{11})/, /youtube\.com\/watch\?v=([\w-]{11})/, /youtube\.com\/embed\/([\w-]{11})/, /youtube\.com\/shorts\/([\w-]{11})/];
  for (const re of pats) { const m = url.match(re); if (m) return m[1]; }
  return null;
}

let loadedVideoId = null;

async function loadBgMusic(url) {
  const videoId = extractYouTubeId(url);
  const titleEl = document.getElementById('music-title');
  if (!videoId) { showToast('올바른 YouTube 링크가 아닙니다.'); return; }

  await loadYouTubeApi();
  if (ytPlayer) {
    ytPlayer.loadVideoById(videoId);
  } else {
    await new Promise((resolve) => {
      ytPlayer = new YT.Player('yt-player', {
        videoId,
        playerVars: { autoplay: 1, loop: 1, playlist: videoId, controls: 0 },
        events: {
          onReady: (e) => { e.target.playVideo(); resolve(); },
          onStateChange: (e) => {
            // 재생/일시정지 버튼을 하나로 통합: 재생 중이면 일시정지, 아니면 재생하기
            if (e.data === YT.PlayerState.PLAYING) {
              musicPlaying = true;
              muteVideoForBackgroundMusic();
            }
            else if (e.data === YT.PlayerState.PAUSED) { musicPlaying = false; }
            syncMusicButton();
            refreshCaption();
          },
          onError: () => showToast('이 영상은 재생할 수 없습니다 (퍼가기 금지 등).'),
        },
      });
    });
    ytPlayer.setVolume(Number(document.getElementById('music-volume').value));
  }
  loadedVideoId = videoId;
  musicLoaded = true;
  musicPlaying = true;
  musicTitle = '';
  syncMusicButton();
  setTimeout(() => {
    try {
      musicTitle = shortMusicTitle(ytPlayer.getVideoData()?.title || '');
      titleEl.textContent = musicTitle;
      refreshCaption();
    } catch {}
  }, 900);
}

// ---------- 음악찾기 30초 미리듣기 ----------
// 검색으로 고른 곡은 **30초 미리듣기 오디오 URL**이라 YouTube 플레이어로는 못 틀고
// <audio>로 반복 재생한다. musicUrl 한 칸에 YouTube 링크와 미리듣기 URL이 모두 들어올 수
// 있어 주소를 보고 어느 쪽인지 판단한다(별도 필드를 두지 않아 기존 wepic과 그대로 호환).
// p.scdn.co는 예전에 Spotify로 만들어 둔 wepic이 계속 재생되도록 남겨둔 것이다.
const PREVIEW_HOSTS = /^https?:\/\/([\w-]+\.)*(mzstatic\.com|itunes\.apple\.com|scdn\.co)\//i;
const isPreviewUrl = (u) => PREVIEW_HOSTS.test(String(u || ''));
let previewAudio = null;
function ensurePreviewAudio() {
  if (!previewAudio) {
    previewAudio = new Audio();
    previewAudio.loop = true; // 30초뿐이라 계속 반복해야 배경음악 구실을 한다
    previewAudio.addEventListener('play', () => { musicPlaying = true; syncMusicButton(); refreshCaption(); });
    previewAudio.addEventListener('pause', () => { musicPlaying = false; syncMusicButton(); refreshCaption(); });
  }
  return previewAudio;
}
// 지금 로드된 배경음악이 미리듣기 오디오인가(=YouTube 플레이어가 아니라 <audio>를 쓰는가)
const musicIsPreview = () => !!(previewAudio && previewAudio.src && musicLoaded && isPreviewUrl(previewAudio.src));

async function loadPreviewMusic(url, title) {
  const a = ensurePreviewAudio();
  a.src = url;
  a.volume = Number(document.getElementById('music-volume').value) / 100;
  // 다른 쪽(YouTube)이 울리고 있으면 멈춘다 — 둘이 동시에 나면 안 된다.
  try { ytPlayer?.pauseVideo?.(); } catch { /* 무시 */ }
  loadedVideoId = null;
  musicLoaded = true;
  musicTitle = shortMusicTitle(title || '미리듣기');
  document.getElementById('music-title').textContent = musicTitle + ' (30초 미리듣기)';
  try {
    await a.play();
  } catch {
    // 사용자 조작 없이 자동재생이 막힌 경우 — 버튼을 눌러 재생하도록 상태만 맞춘다.
    musicPlaying = false;
  }
  syncMusicButton();
  refreshCaption();
}

// 재생/일시정지 토글 — YouTube든 미리듣기든 같은 버튼으로 다룬다.
function toggleMusicPlayback() {
  if (musicIsPreview()) {
    const a = ensurePreviewAudio();
    if (a.paused) a.play().catch(() => showToast('재생할 수 없습니다.'));
    else a.pause();
    return;
  }
  if (!ytPlayer) return;
  if (ytPlayer.getPlayerState() === YT.PlayerState.PLAYING) ytPlayer.pauseVideo();
  else ytPlayer.playVideo();
}

// "▶ 재생하기" 버튼: 처음이거나 링크가 바뀌었으면 로드/재생, 이미 로드됐으면 재생↔일시정지 토글
document.getElementById('btn-music-load').addEventListener('click', () => {
  const url = document.getElementById('music-url').value.trim();
  // 미리듣기 주소가 들어와 있으면 그것으로 재생한다(팝업에서 고르면 이 칸이 채워진다).
  if (isPreviewUrl(url)) {
    if (previewAudio && previewAudio.src === url && musicLoaded) toggleMusicPlayback();
    else loadPreviewMusic(url, musicTitle);
    return;
  }
  const id = url ? extractYouTubeId(url) : null;
  if (!musicLoaded || musicIsPreview() || (id && id !== loadedVideoId)) {
    if (!url) { showToast('음악 링크를 붙여넣거나 "음악찾기"로 곡을 고르세요.'); return; }
    if (!id) { showToast('YouTube 링크가 아닙니다. 옆의 "음악찾기"로 곡을 골라주세요.'); return; }
    loadBgMusic(url);
    return;
  }
  toggleMusicPlayback();
});
// 사진 위 좌측 아이콘 줄의 음악 아이콘 — 곡이 이미 준비된 뒤에만 보이므로 재생↔일시정지만 토글한다
// (링크 입력·최초 로드는 설정 패널의 "▶ 재생하기"에서 한다).
document.getElementById('btn-photo-music').addEventListener('click', () => {
  if (!musicLoaded) return;
  toggleMusicPlayback();
});
document.getElementById('music-volume').addEventListener('input', (e) => {
  const v = Number(e.target.value);
  ytPlayer?.setVolume(v);
  if (previewAudio) previewAudio.volume = v / 100;
});
document.getElementById('btn-music-clear').addEventListener('click', () => {
  const i = document.getElementById('music-url'); i.value = ''; i.focus();
});

// ---------- 음악찾기 팝업 ----------
const musicModal = document.getElementById('music-modal');
document.getElementById('btn-music-find').addEventListener('click', () => {
  musicModal.classList.remove('hidden');
  document.getElementById('music-q').focus();
});
document.getElementById('btn-music-close').addEventListener('click', (e) => {
  e.preventDefault(); musicModal.classList.add('hidden');
});
musicModal.addEventListener('click', (e) => { if (e.target === musicModal) musicModal.classList.add('hidden'); });
document.getElementById('music-q').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); searchMusic(); }
});
document.getElementById('btn-music-search').addEventListener('click', searchMusic);

// ⚠️ 곡 검색은 **브라우저에서 직접** 한다. 처음에는 Worker가 대신 호출했는데 배포하고 나면
// 항상 실패했다 — 이 검색 API는 **IP당 분당 약 20회** 제한이라, Worker를 거치면 우리 앱의
// 모든 사용자가 Cloudflare의 같은 출구 IP를 공유하고(게다가 그 IP는 같은 API를 쓰는 다른
// Worker들과도 공유된다) 한도가 늘 소진돼 있다. 로컬(wrangler dev)에서는 집 IP로 나가기
// 때문에 잘 됐고, 그래서 배포 후에야 드러났다.
// → 브라우저에서 부르면 **사용자마다 자기 IP의 한도**를 쓰므로 이 문제가 사라진다.
// 이 API는 CORS 헤더를 주지 않지만 JSONP(callback=)를 지원해서 브라우저에서 쓸 수 있다.
let jsonpSeq = 0;
function searchMusicDirect(q, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    const cbName = `__wepicMusicCb${++jsonpSeq}`;
    const script = document.createElement('script');
    let settled = false;
    const cleanup = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      delete window[cbName];
      script.remove();
    };
    const timer = setTimeout(() => { cleanup(); reject(new Error('검색이 지연되고 있습니다')); }, timeoutMs);
    window[cbName] = (data) => { const d = data; cleanup(); resolve(d); };
    script.onerror = () => { cleanup(); reject(new Error('검색 서버에 연결하지 못했습니다')); };
    const u = new URL('https://itunes.apple.com/search');
    u.searchParams.set('term', q);
    u.searchParams.set('media', 'music');
    u.searchParams.set('entity', 'song');
    u.searchParams.set('limit', '25');
    u.searchParams.set('country', 'KR'); // 한국 스토어 기준(국내 곡·한글 검색이 잘 나온다)
    u.searchParams.set('callback', cbName);
    script.src = u.toString();
    document.head.appendChild(script);
  });
}

// 검색 응답을 화면이 쓰는 모양으로 정리한다(서버 응답과 같은 형태로 맞춘다).
function normalizeTracks(results) {
  const all = (results || []).map((t) => ({
    id: String(t.trackId || ''),
    name: t.trackName || '',
    artist: t.artistName || '',
    previewUrl: t.previewUrl || null,   // 30초 미리듣기. 없는 곡은 배경음악으로 쓸 수 없다.
    image: t.artworkUrl60 || t.artworkUrl100 || null,
  }));
  const tracks = all.filter((t) => t.previewUrl && t.name);
  return { tracks, totalFound: all.length };
}

async function searchMusic() {
  const q = document.getElementById('music-q').value.trim();
  const statusEl = document.getElementById('music-status');
  const listEl = document.getElementById('music-results');
  if (!q) { statusEl.textContent = '검색어를 입력하세요.'; return; }
  listEl.innerHTML = '';
  statusEl.textContent = '검색 중...';

  let r = null;
  try {
    const d = await searchMusicDirect(q);
    r = normalizeTracks(d.results);
  } catch (directErr) {
    // 브라우저에서 직접 못 받아온 경우(확장 프로그램 차단·사내망 등)에는 서버를 거쳐 한 번 더.
    try {
      r = await api(`/api/music/search?q=${encodeURIComponent(q)}`);
    } catch (proxyErr) {
      statusEl.textContent = `검색 실패: ${directErr.message} (서버 경유도 실패: ${proxyErr.message})`;
      return;
    }
  }

  if (!r.tracks.length) {
    // 미리듣기가 없는 곡은 배경음악으로 쓸 수 없어 걸러진다 → 왜 비었는지 알려준다.
    statusEl.textContent = r.totalFound
      ? `${r.totalFound}곡을 찾았지만 미리듣기를 제공하는 곡이 없습니다. 다른 검색어로 시도해보세요.`
      : '검색 결과가 없습니다.';
    return;
  }
  statusEl.textContent = `미리듣기 가능한 ${r.tracks.length}곡`;
  r.tracks.forEach((t) => listEl.appendChild(musicRow(t)));
}

function musicRow(t) {
  const row = document.createElement('div');
  row.className = 'music-pick-row';
  if (t.image) {
    const img = document.createElement('img');
    img.className = 'music-pick-cover';
    img.src = t.image;
    img.alt = '';
    row.appendChild(img);
  }
  const meta = document.createElement('div');
  meta.className = 'music-pick-meta';
  const name = document.createElement('div');
  name.className = 'music-pick-name';
  name.textContent = t.name;
  const artist = document.createElement('div');
  artist.className = 'music-pick-artist';
  artist.textContent = t.artist;
  meta.append(name, artist);
  row.appendChild(meta);

  const pick = document.createElement('button');
  pick.className = 'secondary slim';
  pick.textContent = '이 곡으로';
  pick.addEventListener('click', () => {
    document.getElementById('music-url').value = t.previewUrl;
    loadPreviewMusic(t.previewUrl, `${t.name} - ${t.artist}`);
    musicModal.classList.add('hidden');
    showToast('배경음악을 바꿨습니다. 30초 미리듣기가 반복 재생됩니다.');
  });
  row.appendChild(pick);
  return row;
}

// ---------- 실시간 공유 링크 ----------
// 지금 만들어져 있는 wepic 주소. 예전에는 팝업 안의 <input>에 담아뒀는데 팝업을 없애면서
// 이 변수 하나로 관리한다(주소 줄·복사 아이콘이 모두 이 값을 쓴다).
let currentShareUrl = '';
// 이 wepic에 달린 댓글 수. 0보다 크면 **사진을 뺄 수 없다**(추가만 가능) —
// 보던 분들이 남긴 글이 가리키는 사진이 사라지면 대화가 어긋나기 때문이다.
// /api/status와 "공유하기" 응답이 알려준다.
let shareCommentCount = 0;
const photosAreLocked = () => shareCommentCount > 0;

// 저장 버튼의 이름·설명을 지금 상태에 맞춘다.
//   · 아직 wepic이 없으면 → "공유하기" (누르면 만들어진다)
//   · 이미 만들었으면    → "수정저장" (같은 링크에 최신 내용을 반영할 뿐, 새로 보내지는 않는다)
// 실제로 남에게 보내는 일은 옆의 "보내기"(공유 아이콘)가 맡는다.
function renderShareButton(has) {
  const btn = document.getElementById('btn-share');
  btn.textContent = has ? '수정저장' : '공유하기';
  btn.title = has
    ? '사진·제목·배경음악·PIN의 변경 내용을 이 링크에 반영합니다'
    : '사진·제목·배경음악·PIN을 저장하고 공유 링크를 만듭니다';
  // "보내기"는 보낼 링크가 있을 때만 의미가 있다.
  document.getElementById('btn-share-send').classList.toggle('hidden', !has);
}

// 만들어진 뒤에만 링크 복사·삭제 아이콘과 주소, 그리고 "보내기" 버튼이 보인다.
function setShareLinkState(hasLink, url) {
  const has = !!hasLink;
  document.getElementById('btn-frame-copy').classList.toggle('hidden', !has);
  document.getElementById('btn-frame-delete').classList.toggle('hidden', !has);
  renderShareButton(has);
  if (url !== undefined) currentShareUrl = url || '';
  showShareUrlInline(has ? currentShareUrl : '');
}

// wepic이 만들어지면 그 주소를 보여준다(눌러서 바로 열 수 있게).
function showShareUrlInline(url) {
  const box = document.getElementById('share-url-inline');
  const link = document.getElementById('share-url-link');
  const has = !!url;
  // 화면에는 "https://"를 떼고 보여준다 — 그만큼 짧아 보이고, 누르면 그대로 열린다.
  link.textContent = has ? url.replace(/^https?:\/\//, '') : '';
  link.href = has ? url : '#';
  link.title = has ? url : '';
  box.classList.toggle('hidden', !has);
}

// 공유 주소를 클립보드로. (구형 브라우저·비보안 컨텍스트에서는 임시 textarea로 폴백)
async function copyShareUrl() {
  if (!currentShareUrl) { showToast('아직 공유 링크가 없습니다.'); return false; }
  try {
    await navigator.clipboard.writeText(currentShareUrl);
  } catch {
    const t = document.createElement('textarea');
    t.value = currentShareUrl;
    t.style.position = 'fixed';
    t.style.opacity = '0';
    document.body.appendChild(t);
    t.select();
    try { document.execCommand('copy'); } finally { t.remove(); }
  }
  return true;
}

// 공유 열람용 PIN(4자리). 링크를 만들면 서버가 발급해 내려주고, 사용자가 직접 고칠 수도 있다.
// 고친 뒤 "링크변경 반영"을 누르면 서버에 새 PIN이 저장된다.
function setSharePin(pin) {
  const row = document.getElementById('share-pin-row');
  document.getElementById('share-pin').value = pin || '';
  row.classList.toggle('hidden', !pin);
}
const getSharePin = () => {
  const v = document.getElementById('share-pin').value.trim();
  return /^\d{4}$/.test(v) ? v : '';
};
document.getElementById('btn-pin-new').addEventListener('click', () => {
  const pin = String(Math.floor(Math.random() * 10000)).padStart(4, '0');
  document.getElementById('share-pin').value = pin;
  showToast('새 PIN이 준비됐습니다. "링크변경 반영"을 누르면 적용됩니다.');
});

// 전체공유: 체크하면 PIN이 필요 없으므로 그 자리에서 바로 PIN 행을 숨긴다
// (저장 결과를 기다리지 않고 즉시 피드백). 실제 PIN 제거는 다음 저장 때 서버가 처리한다.
document.getElementById('share-public').addEventListener('change', (e) => {
  if (e.target.checked) document.getElementById('share-pin-row').classList.add('hidden');
  else setSharePin(document.getElementById('share-pin').value.trim());
});

// ---------- wepic 이름 ----------
// 메인화면은 "새 wepic을 만드는" 화면이다. 예전 wepic을 골라 불러오는 리스트박스는
// My사진관리가 그 역할을 하므로 없앴고, 여기서는 이름만 정한다(만들기 전까지 수정 가능).
let frames = [];
let currentFrameId = null;

// 이름을 매번 짓기 번거로우니 "색깔 + 동물"로 자동 제안한다(예: "파란 여우").
const NAME_COLORS = ['빨간', '주황', '노란', '초록', '파란', '남색', '보라', '분홍',
  '하늘', '연두', '금빛', '은빛', '하얀', '검은', '민트', '살구'];
const NAME_ANIMALS = ['여우', '고양이', '강아지', '토끼', '사슴', '곰', '판다', '펭귄',
  '돌고래', '부엉이', '다람쥐', '호랑이', '코알라', '수달', '거북이', '고래', '너구리', '앵무새'];
const pickRandom = (arr) => arr[Math.floor(Math.random() * arr.length)];
const randomFrameName = () => `${pickRandom(NAME_COLORS)} ${pickRandom(NAME_ANIMALS)}`;

// 이름을 정하는 UI는 없앴다(요청). 그래도 My사진관리·관리자 목록에서 "액자 1, 액자 2"보다는
// 알아보기 쉬우므로, 새 wepic을 만들 때 이 이름을 조용히 붙여준다.
let pendingFrameName = randomFrameName();
const currentFrameName = () => pendingFrameName;
// 새 wepic을 시작할 때(공유를 삭제했을 때 등) 다음 이름을 새로 뽑아둔다.
const renewFrameName = () => { pendingFrameName = randomFrameName(); };

// 제목·배경음악을 관리자 Default 설정으로 리셋한다. 새 액자로 시작할 때, 방금 전까지
// 다른 액자를 편집하며 입력해 둔 값이 그대로 남아있지 않도록 하기 위함이다.
function resetTitleAndMusicToDefault() {
  const title = globalSettings.title || '';
  document.getElementById('title-input').value = title;
  applyTitle(title);
  document.getElementById('music-url').value = globalSettings.musicUrl || DEFAULT_MUSIC_URL;
}

// 액자 매니페스트(요약 정보 포함)에 저장된 제목·음악·전환설정을 화면에 그대로 반영한다.
function applyFrameSettingsToUI(m) {
  const title = m.title || '';
  document.getElementById('title-input').value = title;
  applyTitle(title);
  if (m.musicUrl) document.getElementById('music-url').value = m.musicUrl;
  if (m.intervalSec) {
    const sec = Math.min(60, Math.max(3, Number(m.intervalSec)));
    const sel = document.getElementById('interval-select');
    if ([...sel.options].some((o) => o.value === String(sec))) sel.value = String(sec);
    applyInterval(sec);
  }
  if (m.effect) {
    const r = document.querySelector(`#effect-radios input[value="${m.effect}"]`);
    if (r) { r.checked = true; applyEffect(m.effect); }
  }
}

// 현재 선택된 액자에 맞춰 공유 상태(URL·PIN·반영 버튼)와 제목·음악·전환설정을 화면에 반영한다.
// 기존 액자를 선택했으면 그 액자의 값을, 새 액자(선택 안 됨) 상태면 Default 값을 사용한다
// (다른 액자를 편집하던 값이 이어지지 않도록).
function applyCurrentFrameToShareUI() {
  const f = frames.find((x) => x.id === currentFrameId);
  const publicBox = document.getElementById('share-public');
  if (f && f.hasContent) {
    setShareLinkState(true, f.url || '');
    publicBox.checked = !!f.isPublic;
    // 전체공유면 서버가 애초에 pin을 두지 않으므로 f.pin이 없다 — setSharePin이 알아서 숨긴다.
    if (f.pin) setSharePin(f.pin); else setSharePin('');
    applyFrameSettingsToUI(f);
  } else {
    setShareLinkState(false, '');
    setSharePin('');
    publicBox.checked = false;
    resetTitleAndMusicToDefault();
  }
}

async function loadFrames() {
  try {
    const r = await api('/api/frames');
    frames = r.frames || [];
    currentFrameId = r.currentFrameId || null;
    applyCurrentFrameToShareUI();
  } catch { /* 로그인 전이거나 세션이 없으면 조용히 무시 */ }
}

// ---------- wepic 시작 선택 (새로 만들기 / 기존 수정) ----------
// 세션은 로그인해 있는 동안 "현재 wepic"을 기억한다. 그래서 사진을 새로 고르면 예전
// wepic이 조용히 덮어써질 수 있었다 → 사진을 고르기 **전에** 무엇을 할지 먼저 묻는다.
// 한 세션에서 한 번 고르면 다시 묻지 않는다(매번 물으면 성가시다).
let startChoiceMade = false;
let startPickedId = null;

// 사진을 고르러 가기 전에 확인이 필요한지 판단한다.
// - 내용이 있는 wepic이 하나도 없으면 물을 게 없다.
// - 관리자·회원이 /?frame=로 특정 wepic을 열어 온 상태(isFrameMode)면 이미 대상이 정해졌다.
function needStartChoice() {
  if (startChoiceMade || isFrameMode || !isLoggedIn) return false;
  return frames.some((f) => f.hasContent);
}

function openStartModal() {
  const list = document.getElementById('start-list');
  const withContent = frames.filter((f) => f.hasContent);
  document.getElementById('start-count').textContent = String(withContent.length);
  startPickedId = null;
  list.innerHTML = '';
  withContent.forEach((f) => {
    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'start-item' + (f.id === currentFrameId ? ' current' : '');
    const t = document.createElement('b');
    t.textContent = f.title || f.name || '(제목 없음)';
    const meta = document.createElement('span');
    meta.className = 'start-item-meta';
    meta.textContent = `사진 ${f.count || 0}장`
      + (f.updatedAt ? ` · ${fmtDateTime(f.updatedAt)}` : '')
      + (f.isPublic ? ' · 전체공유' : '');
    row.append(t, meta);
    row.addEventListener('click', () => {
      startPickedId = f.id;
      [...list.children].forEach((c) => c.classList.toggle('picked', c === row));
      document.getElementById('start-edit').disabled = false;
    });
    list.appendChild(row);
  });
  document.getElementById('start-edit').disabled = true;
  document.getElementById('start-modal').classList.remove('hidden');
}
const closeStartModal = () => document.getElementById('start-modal').classList.add('hidden');

// "새 wepic 만들기": 세션의 현재 wepic 선택을 풀어 다음 저장이 **새 링크**를 만들게 한다.
document.getElementById('start-new').addEventListener('click', async () => {
  startChoiceMade = true;
  closeStartModal();
  try { await api('/api/frames/deselect', { method: 'POST' }); } catch { /* 무시 */ }
  await loadFrames();               // 선택 없음 → 제목·음악이 Default로 되돌아간다
  shareCommentCount = 0;
  updateExcludeAvailability();
  showToast('새 wepic으로 시작합니다. 사진을 고르면 새 링크가 만들어집니다.');
  startPickerOrGallery();
});
// "선택한 wepic 수정하기": 이미 검증된 경로(/?frame=<id>)로 그 wepic을 그대로 불러온다.
document.getElementById('start-edit').addEventListener('click', () => {
  if (!startPickedId) return;
  startChoiceMade = true;
  location.href = `/?frame=${encodeURIComponent(startPickedId)}`;
});

// 로그인 제공자에 맞는 사진 고르기 경로로 보낸다(구글=Picker, 그 외=기기 갤러리).
function startPickerOrGallery() {
  if (canUseGooglePhotos) startPickerFlow();
  else document.getElementById('local-file-input').click();
}

// ---------- 링크 카드용 흐린 표지 (og.jpg) ----------
// 카카오톡 등에 링크를 붙이면 미리보기 카드에 그림이 붙는다. **PIN이 걸린 wepic**은 거기에
// 원본을 쓰면 링크만 받은 사람에게 사진이 선명하게 노출되어 PIN을 건 의미가 없다.
// 그래서 첫 사진을 캔버스로 크게 흐리게 만들어(색만 남는 수준) 표지로 올려 둔다.
// (전체공유 wepic은 어차피 누구나 볼 수 있으므로 서버가 첫 사진을 그대로 카드에 쓴다.)
//
// PIN은 나중에 "My사진관리"에서 걸 수도 있으므로 표지는 **공개 여부와 무관하게 항상** 만든다.
//
// 서버(Worker)에서 흐리게 만들 수단이 없어서 화면이 맡는다 — Worker에는 이미지 처리 API가
// 없고, 무료 플랜은 요청당 CPU가 10ms라 JS로 인코딩하는 것도 위험하다(QR 때 겪었다).
const OG_COVER_W = 1200;
const OG_COVER_H = 630;

function buildOgCover(url) {
  return new Promise((resolve) => {
    const im = new Image();
    im.onerror = () => resolve(null);
    im.onload = () => {
      try {
        const c = document.createElement('canvas');
        c.width = OG_COVER_W;
        c.height = OG_COVER_H;
        const ctx = c.getContext('2d');
        // 1) 화면을 꽉 채우도록(cover) 크기를 맞춘다
        const s = Math.max(OG_COVER_W / im.naturalWidth, OG_COVER_H / im.naturalHeight);
        const w = im.naturalWidth * s;
        const h = im.naturalHeight * s;
        // 2) 아주 강하게 흐리게. blur는 그림 가장자리에서 잘려 테두리가 비어 보이므로
        //    12% 크게 그려 경계를 화면 밖으로 밀어낸다(공유화면의 흐린 배경과 같은 요령).
        ctx.filter = 'blur(44px)';
        ctx.drawImage(im,
          (OG_COVER_W - w * 1.12) / 2, (OG_COVER_H - h * 1.12) / 2, w * 1.12, h * 1.12);
        ctx.filter = 'none';
        // 3) 살짝 어둡게 눌러 카드 위 글자가 잘 읽히게 한다(공유화면과 같은 톤)
        ctx.fillStyle = 'rgba(6, 10, 20, 0.3)';
        ctx.fillRect(0, 0, OG_COVER_W, OG_COVER_H);
        c.toBlob((b) => resolve(b), 'image/jpeg', 0.72);
      } catch { resolve(null); } // 다른 출처 이미지 등으로 캔버스를 읽을 수 없는 경우
    };
    im.src = url;
  });
}

// 표지를 만들어 올린다. 실패해도 저장 자체는 이미 끝난 뒤이므로 조용히 넘어간다
// (표지가 없으면 서버가 카드에 wepic 로고를 쓴다 — 원본 사진으로 되돌아가지는 않는다).
async function uploadOgCover(frameId, photo) {
  if (!frameId || !photo) return;
  try {
    const cover = await buildOgCover(photo.thumbUrl || photo.fullUrl);
    if (!cover) return;
    const form = new FormData();
    form.append('cover', cover, 'og.jpg');
    await fetch(`/api/share/${encodeURIComponent(frameId)}/og-cover`, {
      method: 'POST', body: form, credentials: 'same-origin',
    });
  } catch { /* 표지는 있으면 좋은 것이라 실패해도 흐름을 막지 않는다 */ }
}

// 현재 화면의 사진·제목·음악·전환설정을 서버에 올린다.
// 서버는 세션마다 같은 shareId를 재사용하므로, 다시 올리면 "같은 링크"의 내용이 갱신된다.
// 아직 wepic이 없으면 "공유하기"로 만들고, 이미 있으면 "수정저장"으로 같은 링크에 반영한다.
async function pushShare() {
  const mode = currentShareUrl ? 'update' : 'create';
  const btn = document.getElementById('btn-share');
  // 사진과 동영상을 **모두** 공유한다. 예전에는 브라우저가 든 파일을 올리는 경로
  // (구글 포토 "공유" 수신·기기 갤러리)에서만 동영상을 빼고 "포함되지 않는다"고 안내했는데,
  // 이제는 그 경로도 동영상 원본을 그대로 올려 공유 화면에서 재생된다.
  const sharePhotos = allPhotos;
  if (!sharePhotos.length) { showToast('공유할 사진이 없습니다.'); return; }
  const hasVideo = sharePhotos.some((p) => p.type === 'video');
  btn.disabled = true;
  btn.textContent = mode === 'update'
    ? '반영 중...'
    : (hasVideo ? '사진·동영상 저장 중... (동영상은 시간이 더 걸립니다)' : '사진 저장 중... (사진이 많으면 시간이 걸립니다)');
  try {
    const musicUrl = document.getElementById('music-url').value.trim();
    // 공유 시점의 제목·전환 간격·전환 효과를 함께 저장해 공유 화면에도 동일 적용.
    const title = document.getElementById('title-input').value.trim();
    const intervalSec = Math.round(slideIntervalMs / 1000);
    // 화면에 표시/수정된 PIN을 함께 보낸다(비어 있으면 서버가 기존 유지 또는 새로 발급).
    const pin = getSharePin();
    // 전체공유: 체크하면 서버가 PIN 없이 저장한다(기존 PIN이 있었다면 지운다).
    const isPublic = document.getElementById('share-public').checked;
    let r;
    if (isSharedMode || isLocalMode) {
      // 구글 포토 "공유"로 받은 사진(isSharedMode)이나 기기 갤러리에서 고른 사진
      // (isLocalMode)은 구글 서버 baseUrl이 없고, 이 브라우저가 이미 파일(blob)을
      // 들고 있다. 구글에서 다시 받아오는 대신 그 파일을 그대로 올린다.
      const form = new FormData();
      const meta = [];
      for (const p of sharePhotos) {
        const isVid = p.type === 'video' && p.videoUrl;
        const src = isVid ? p.videoUrl : p.fullUrl;
        const blob = await fetch(src).then((res) => res.blob());
        const ext = isVid
          ? (/quicktime/.test(blob.type) ? 'mov' : (/webm/.test(blob.type) ? 'webm' : 'mp4'))
          : (blob.type === 'image/png' ? 'png' : 'jpg');
        form.append('files', blob, `${p.id}.${ext}`);
        // 동영상은 정지 프레임(포스터)을 함께 올린다 — 목록 썸네일·재생 전 화면·공유 미리보기에 쓰인다.
        // 고를 때 못 뽑았으면(코덱 문제 등) 여기서 한 번 더 시도한다.
        if (isVid) {
          const poster = p.posterBlob || (await videoPosterBlob(src).catch(() => null));
          if (poster) form.append(`poster_${meta.length}`, poster, `${p.id}_poster.jpg`);
        }
        meta.push({
          createTime: p.createTime, width: p.width, height: p.height,
          type: isVid ? 'video' : 'photo',
        });
      }
      form.append('meta', JSON.stringify(meta));
      form.append('musicUrl', musicUrl);
      // 미리듣기는 주소만으로 곡 제목을 알 수 없어(YouTube는 플레이어가 알려준다)
      // 지금 화면에 표시된 제목을 함께 저장한다 → 공유화면에서도 곡목이 보인다.
      form.append('musicTitle', musicTitle || '');
      form.append('frameName', currentFrameName()); // 이 wepic의 이름(화면 입력칸)
      form.append('title', title);
      form.append('intervalSec', String(intervalSec));
      form.append('effect', slideEffect);
      form.append('isPublic', isPublic ? '1' : '0');
      if (pin) form.append('pin', pin);
      r = await api('/api/share/blob', { method: 'POST', body: form });
    } else {
      // type/videoUrl까지 보내면 서버가 동영상 원본을 함께 저장해 공유 화면에서도 재생된다.
      const items = sharePhotos.map((p) => ({
        id: p.id, createTime: p.createTime, width: p.width, height: p.height, fullUrl: p.fullUrl,
        type: p.type === 'video' ? 'video' : 'photo',
        ...(p.videoUrl ? { videoUrl: p.videoUrl } : {}),
        ...(p.thumbUrl ? { thumbUrl: p.thumbUrl } : {}),
      }));
      r = await api('/api/share', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          items, musicUrl, title, intervalSec, effect: slideEffect, pin, isPublic,
          musicTitle: musicTitle || '', // 미리듣기용 곡목 스냅샷(위 blob 경로 주석 참고)
          frameName: currentFrameName(), // 이 wepic의 이름(화면 입력칸)
        }),
      });
    }
    setSharePin(r.pin || ''); // 전체공유면 서버가 pin을 null로 돌려주므로 PIN 행이 사라진다
    // wepic이 생겼으니 링크 복사·삭제 아이콘과 주소를 띄운다("공유하기"를 누르면 링크가 보인다).
    setShareLinkState(true, r.url);
    shareCommentCount = Number(r.commentCount || 0);
    // 링크 카드에 쓸 흐린 표지를 첫 사진으로 만들어 올린다(저장이 끝난 뒤라 실패해도 무해).
    await uploadOgCover(r.frameId, sharePhotos[0]);
    updateExcludeAvailability();
    await loadFrames(); // 액자 이름·설정 갱신(자동 생성된 첫 액자 포함)
    if (mode === 'update') {
      const pinNote = r.isPublic ? '전체공유(PIN 없음)' : `PIN ${r.pin || '없음'}`;
      showToast(`사진·제목·배경음악·PIN을 모두 반영했습니다. (사진 ${r.count}장, ${pinNote})`);
    } else {
      // 팝업 없이 토스트로만 알린다 — 주소는 버튼 바로 아래 "wepic 주소" 줄에 나타난다.
      const pinNote = r.isPublic ? '전체공유(PIN 없음)' : `PIN ${r.pin || '없음'}`;
      showToast(`wepic을 만들었습니다. (사진 ${r.count}장, ${pinNote}) `
        + '옆의 "보내기"로 카카오톡·문자에 바로 보낼 수 있습니다.');
    }
    // 동영상이 너무 커서 담기지 못한 경우 — 왜 빠졌는지 알려준다.
    if (r.skippedBigVideos) {
      showToast(`동영상 ${r.skippedBigVideos}개는 용량이 너무 커서(1개 ${r.videoLimitText} 초과) 담지 못했습니다.`);
    }
    // 저장용량 한도에 걸려 일부만 저장된 경우 — 조용히 넘기면 사진이 왜 빠졌는지 알 수 없다.
    if (r.quotaStopped) {
      showToast(`저장용량 한도(${r.quotaLimitText})에 도달해 ${r.count}장만 저장했습니다. `
        + '기존 wepic을 삭제하거나 관리자에게 용량 증설을 요청해주세요.');
    }
  } catch (err) {
    showToast((mode === 'update' ? '반영 실패: ' : '공유 링크 생성 실패: ') + err.message);
  } finally {
    btn.disabled = false;
    // 저장에 성공했으면 이제 wepic이 있는 상태 → 버튼 이름이 "수정저장"으로 바뀌고
    // 옆에 "보내기"가 나타난다. (실패했다면 원래 이름 그대로 되돌아간다)
    renderShareButton(!!currentShareUrl);
  }
}

document.getElementById('btn-share').addEventListener('click', () => pushShare());

// ---------- 보내기 (폰·PC의 기본 공유 화면) ----------
// Web Share API가 있으면 카카오톡·문자·메일 등 기기에 설치된 앱 목록이 그대로 뜬다
// (안드로이드 크롬·iOS 사파리·윈도우11 엣지 등). 지원하지 않는 브라우저(데스크톱 크롬 일부)
// 에서는 주소를 클립보드에 복사해 붙여넣을 수 있게 한다 — 어느 쪽이든 빈손으로 끝나지 않는다.
async function sendShareLink() {
  if (!currentShareUrl) { showToast('먼저 "공유하기"로 wepic을 만들어주세요.'); return; }

  if (navigator.share) {
    try {
      // ⚠️ **주소만** 보낸다. title·text를 함께 넘기면 카카오톡이 그 문구를 메시지 본문으로
      //    따로 찍어("바다사진 — 사진을 함께 보세요. https://...") 바로 아래 미리보기 카드와
      //    같은 말이 두 번 나온다. 제목·설명·사진은 카드가 이미 보여주므로 주소면 충분하다.
      await navigator.share({ url: currentShareUrl });
      return;
    } catch (err) {
      // 사용자가 공유 창을 그냥 닫은 경우(AbortError)는 실패가 아니다 — 조용히 넘어간다.
      if (err && err.name === 'AbortError') return;
      // 그 외(정책 차단 등)는 아래 복사 방식으로 넘어간다.
    }
  }
  if (await copyShareUrl()) {
    showToast('이 브라우저는 바로 보내기를 지원하지 않아 주소를 복사했습니다. 카카오톡 등에 붙여넣어 주세요.');
  }
}
document.getElementById('btn-share-send').addEventListener('click', sendShareLink);

// 아이콘 줄 ① 링크 복사하기
document.getElementById('btn-frame-copy').addEventListener('click', async () => {
  if (await copyShareUrl()) showToast('공유 주소를 복사했습니다.');
});
// 아이콘 줄 ② 링크 삭제하기
document.getElementById('btn-frame-delete').addEventListener('click', (e) =>
  revokeCurrentShare(e.currentTarget));

// 현재 wepic의 공유 링크를 삭제한다(🗑 아이콘).
async function revokeCurrentShare(btn) {
  if (!confirm('공유 링크를 지금 삭제할까요? 이후 이 링크로는 접속할 수 없습니다.')) return;
  if (btn) btn.disabled = true;
  try {
    await api('/api/share', { method: 'DELETE' });
    setShareLinkState(false, ''); // 링크가 없어짐 → 주소 줄과 복사·삭제 아이콘이 사라진다
    setSharePin('');
    renewFrameName(); // 다음 wepic에 붙일 이름을 새로 뽑아둔다
    await loadFrames();
    showToast('공유 링크를 삭제했습니다.');
  } catch (err) {
    showToast('삭제 실패: ' + err.message);
  } finally {
    if (btn) btn.disabled = false;
  }
}

// ---------- 하단 링크 ----------
document.getElementById('btn-reselect').addEventListener('click', (e) => {
  e.preventDefault();
  appendMode = false; // 다시 선택 = 교체
  if (intervalHandle) clearInterval(intervalHandle);
  startPickerFlow();
});
document.getElementById('btn-add').addEventListener('click', (e) => {
  e.preventDefault();
  appendMode = true; // 사진 추가 = 기존에 덧붙임
  if (intervalHandle) clearInterval(intervalHandle);
  startPickerFlow();
});
// 구글 포토를 쓸 수 없는 로그인(카카오·네이버)에서 쓰는 "갤러리에서 다시 선택"
document.getElementById('btn-local-reselect').addEventListener('click', (e) => {
  e.preventDefault();
  if (intervalHandle) clearInterval(intervalHandle);
  document.getElementById('local-file-input').click();
});
// 로그아웃은 여러 곳(슬라이드쇼 하단 링크·회원정보 화면·상단 메뉴의 이름)에서 부른다.
async function doLogout() {
  await api('/api/logout', { method: 'POST' }).catch(() => {});
  location.href = '/';
}
// 상단 메뉴의 로그인 이름 — 예전에는 눌러도 아무 일이 없었다. 확인 후 로그아웃한다.
document.getElementById('menu-whoami').addEventListener('click', async () => {
  if (!isLoggedIn) return;
  if (!confirm('로그아웃하시겠습니까?')) return;
  await doLogout();
});
// (슬라이드쇼 하단의 로그아웃 링크는 없앴다 — 상단 메뉴의 내 이름을 누르면 로그아웃된다)

// 전체화면을 해제하고 홈으로 이동한다. 홈은 전체공유 사진 목록(feed)이다.
// 재생 중이던 동영상·배경음악은 selectPanel → showHome()이 stopSlideshowPlayback()으로 함께 멈춘다.
function stopEverythingAndGoHome() {
  exitFullscreenIfAny();
  selectPanel(HOME_PANEL);
}
// 전체화면 상태로 홈에 가면 화면이 갇힌 것처럼 보이므로 함께 해제한다.
function exitFullscreenIfAny() {
  try { if (document.fullscreenElement) document.exitFullscreen(); } catch { /* 무시 */ }
}

// ---------- 사진 제외 (체크박스 선택 삭제) ----------
// 아이콘 버튼이라 글자를 바꾸지 않는다(바꾸면 아이콘이 사라진다). 눌린 상태는
// .active 클래스와 툴팁으로 알린다.
function setExcludeBtnState(on) {
  const b = document.getElementById('btn-exclude');
  b.classList.toggle('active', on);
  updateExcludeAvailability();   // 툴팁은 여기서 한 번에 정한다(잠금 안내가 지워지지 않게)
}
function setExcludeMode(on) {
  excludeMode = on;
  excludeSel.clear();
  document.getElementById('exclude-count').textContent = '0';
  document.getElementById('exclude-actions').classList.toggle('hidden', !on);
  setExcludeBtnState(on);
  if (on && intervalHandle) clearInterval(intervalHandle); // 선택 중엔 슬라이드 정지
  renderPhotoList();
  if (!on) resetTimer();
}
// 댓글이 달린 wepic이면 "사진 제외"를 아예 켜지 않고 이유를 알려준다.
function updateExcludeAvailability() {
  const b = document.getElementById('btn-exclude');
  if (!b) return;
  const locked = photosAreLocked();
  b.classList.toggle('locked', locked);
  b.title = locked
    ? `댓글이 ${shareCommentCount}개 달려 있어 사진을 뺄 수 없습니다 (사진 추가만 가능)`
    : (excludeMode ? '제외 취소' : '사진 제외');
  b.setAttribute('aria-label', b.title);
}
document.getElementById('btn-exclude').addEventListener('click', (e) => {
  e.preventDefault();
  if (photosAreLocked()) {
    showToast(`댓글이 ${shareCommentCount}개 달려 있어 사진을 삭제할 수 없습니다. 사진 추가만 가능합니다.`);
    return;
  }
  setExcludeMode(!excludeMode);
});
document.getElementById('btn-exclude-cancel').addEventListener('click', () => setExcludeMode(false));
document.getElementById('btn-exclude-apply').addEventListener('click', () => {
  if (!excludeSel.size) { setExcludeMode(false); return; }
  allPhotos = allPhotos.filter((p) => !excludeSel.has(p.id));
  excludeMode = false;
  excludeSel.clear();
  document.getElementById('exclude-actions').classList.add('hidden');
  setExcludeBtnState(false);
  if (!allPhotos.length) { showToast('모든 사진이 제외되었습니다. 사진을 다시 선택해주세요.'); }
  recomputeFiltered();
});

let isSharedMode = false; // 구글 포토 "공유"로 사진을 받아 로그인 없이 보는 상태(PWA 공유 타깃)
// 관리자 모드: 관리자가 특정 액자를 wepic 메인화면으로 열어(/?frame=<id>) 자기 세션에
// 편입시킨 상태. frameManifest는 최초 진입 시 제목·전환설정 초기값을 채우는 용도일 뿐,
// 이후에는 일반 메인화면과 동일하게 자유롭게 편집·저장할 수 있다.
let isFrameMode = false;
let frameManifest = null;

// "사진 보기" 카드를 누르면 **wepic 공유화면**(/f/<id>)을 홈페이지 안에서 그대로 띄운다.
// - 보여주는 화면은 공유화면이어야 한다(메인화면은 내 사진을 편집하는 곳이라 맞지 않는다).
// - 그렇다고 페이지를 통째로 옮기면 홈페이지 상단 메뉴가 사라진다.
// → iframe으로 하위 프레임에 끼워 넣어 둘 다 만족시킨다.
function viewPublicShare(id, title) {
  const frame = document.getElementById('feed-frame');
  frame.src = `/f/${encodeURIComponent(id)}`;
  document.getElementById('feed-viewer-title').textContent = title || '';
  document.getElementById('feed-viewer-open').href = `/f/${encodeURIComponent(id)}`;
  document.getElementById('feed-browse').classList.add('hidden');
  document.getElementById('feed-viewer').classList.remove('hidden');
}
// 목록으로 돌아가기 — iframe을 비워 뒤에서 음악이 계속 흐르지 않게 한다.
function closePublicViewer() {
  const frame = document.getElementById('feed-frame');
  frame.removeAttribute('src');
  document.getElementById('feed-viewer').classList.add('hidden');
  document.getElementById('feed-browse').classList.remove('hidden');
}
document.getElementById('btn-feed-back').addEventListener('click', closePublicViewer);

// ---------- "사진 보기" 카드 목록 (전체공유 피드) ----------
// 서버가 한 번에 전체 목록을 내려주고(개인 프로젝트 규모라 페이지네이션까지는 과함),
// 화면에는 배치 단위로만 그려서 아래로 스크롤할수록 계속 나오는 것처럼 보이게 한다.
let feedCache = [];
let feedShown = 0;
const FEED_BATCH = 9;
let feedObserver = null;

async function loadPublicFeed() {
  closePublicViewer(); // 메뉴를 다시 누르면 항상 목록부터 보여준다
  const listEl = document.getElementById('feed-list');
  const emptyEl = document.getElementById('feed-empty');
  const loadingEl = document.getElementById('feed-loading');
  if (feedObserver) { feedObserver.disconnect(); feedObserver = null; }
  listEl.innerHTML = '';
  emptyEl.classList.add('hidden');
  loadingEl.classList.remove('hidden');
  feedShown = 0;
  try {
    const r = await fetch('/api/public/shares', { credentials: 'same-origin' }).then((res) => res.json());
    feedCache = r.shares || [];
  } catch {
    feedCache = [];
  }
  loadingEl.classList.add('hidden');
  if (!feedCache.length) { emptyEl.classList.remove('hidden'); return; }
  renderNextFeedBatch();
}

function renderNextFeedBatch() {
  const listEl = document.getElementById('feed-list');
  const next = feedCache.slice(feedShown, feedShown + FEED_BATCH);
  next.forEach((s) => listEl.appendChild(feedCard(s)));
  feedShown += next.length;
  if (feedShown >= feedCache.length) {
    if (feedObserver) { feedObserver.disconnect(); feedObserver = null; }
    return;
  }
  if (!feedObserver) {
    feedObserver = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) renderNextFeedBatch();
    }, { rootMargin: '300px' });
  }
  feedObserver.observe(document.getElementById('feed-sentinel'));
}

function feedDateLabel(iso) {
  if (!iso) return '';
  return new Intl.DateTimeFormat('ko-KR', { year: 'numeric', month: 'long', day: 'numeric' }).format(new Date(iso));
}

function feedCard(s) {
  const card = document.createElement('div');
  card.className = 'feed-card';

  const img = document.createElement('img');
  img.className = 'feed-card-thumb';
  img.loading = 'lazy';
  img.alt = '';
  if (s.thumbUrl) img.src = s.thumbUrl;
  card.appendChild(img);

  const body = document.createElement('div');
  body.className = 'feed-card-body';

  const title = document.createElement('div');
  title.className = 'feed-card-title';
  title.textContent = s.title || '(제목 없음)';
  body.appendChild(title);

  const meta = document.createElement('div');
  meta.className = 'feed-card-meta';
  meta.textContent = `${s.author} · ${feedDateLabel(s.updatedAt)} · 사진 ${s.count}장`
    + (s.commentCount ? ` · 댓글 ${s.commentCount}` : '');
  body.appendChild(meta);

  const likeBtn = document.createElement('button');
  likeBtn.type = 'button';
  likeBtn.className = 'feed-like-btn';
  likeBtn.classList.toggle('liked', !!s.likedByMe);
  setFeedLikeBtnContent(likeBtn, s.likedByMe, s.likeCount);
  likeBtn.addEventListener('click', (e) => {
    e.stopPropagation(); // 카드 클릭(재생)으로 번지지 않게
    toggleFeedLike(s, likeBtn);
  });
  body.appendChild(likeBtn);

  card.appendChild(body);
  card.addEventListener('click', () => viewPublicShare(s.id, s.title));
  return card;
}

function setFeedLikeBtnContent(btn, liked, count) {
  btn.innerHTML = '';
  const heart = document.createElement('span');
  heart.className = 'feed-like-heart';
  heart.textContent = liked ? '♥' : '♡';
  btn.appendChild(heart);
  btn.appendChild(document.createTextNode(String(count)));
}

// 좋아요는 **로그인하지 않아도** 누를 수 있다(공유화면 방문자 대부분이 비로그인이라,
// 로그인만 요구하면 사실상 아무도 못 누른다). 비로그인은 브라우저 쿠키로 중복을 막는다.
async function toggleFeedLike(s, btn) {
  try {
    const r = await api(`/api/wepic/${encodeURIComponent(s.id)}/like`, { method: 'POST' });
    s.likedByMe = r.liked;
    s.likeCount = r.likeCount;
    btn.classList.toggle('liked', r.liked);
    setFeedLikeBtnContent(btn, r.liked, r.likeCount);
  } catch (err) {
    showToast('좋아요 처리 실패: ' + err.message);
  }
}

// ---------- 기기 갤러리에서 사진 직접 올리기 ----------
// 구글 포토 Picker를 쓸 수 없는 로그인(카카오·네이버)의 사진 업로드 경로.
// <input type="file">은 웹 표준이라 iOS 사파리·안드로이드 크롬 모두 기기 사진 선택 화면을
// 그대로 띄운다. 고른 파일은 그대로 슬라이드쇼로 띄우고, "공유 링크 만들기"를 누르면
// 기존 blob 업로드 경로(/api/share/blob)로 올라간다.
let isLocalMode = false;       // 기기 갤러리에서 고른 사진으로 보는 중
let localAppendMode = false;   // true면 고른 사진을 기존 목록에 덧붙인다("사진 추가")
// 갤러리 선택창을 연다. append=true면 기존 사진을 유지하고 뒤에 더한다.
function openLocalPicker(append) {
  if (!isLoggedIn) { selectPanel('login'); return; } // 업로드는 로그인 필수
  // 새로 고르는 경우(append=false)에만 "새로 만들기 / 기존 수정"을 먼저 묻는다
  if (!append && needStartChoice()) { openStartModal(); return; }
  localAppendMode = !!append;
  document.getElementById('local-file-input').click();
}
document.getElementById('btn-pick-local').addEventListener('click', () => openLocalPicker(false));
document.getElementById('btn-pick-local-add').addEventListener('click', () => openLocalPicker(true));
// 슬라이드쇼 하단 링크(카카오·네이버 로그인에서만 보임)
document.getElementById('btn-local-add').addEventListener('click', (e) => {
  e.preventDefault();
  if (intervalHandle) clearInterval(intervalHandle);
  openLocalPicker(true);
});
// 동영상 파일에서 정지 프레임(포스터)을 뽑는다. 목록 썸네일과 재생 전 화면에 쓴다.
// 브라우저가 못 여는 코덱이면 null을 돌려주고, 그 동영상은 포스터 없이 그대로 진행한다
// (재생 자체가 안 되는 포맷이면 재생 시점에 "포맷이 맞지 않는다"고 안내한다).
function videoPosterBlob(src) {
  return new Promise((resolve) => {
    const v = document.createElement('video');
    let settled = false;
    const done = (blob) => { if (!settled) { settled = true; resolve(blob); } };
    v.preload = 'metadata';
    v.muted = true;
    v.playsInline = true;
    v.onloadeddata = () => {
      // 맨 첫 프레임은 검은 화면인 경우가 많아 조금 뒤로 옮겨 잡는다.
      try { v.currentTime = Math.min(0.5, (v.duration || 1) / 3); } catch { done(null); }
    };
    v.onseeked = () => {
      try {
        const c = document.createElement('canvas');
        c.width = v.videoWidth || 640;
        c.height = v.videoHeight || 360;
        c.getContext('2d').drawImage(v, 0, 0, c.width, c.height);
        c.toBlob((b) => done(b), 'image/jpeg', 0.82);
      } catch { done(null); }
    };
    v.onerror = () => done(null);
    setTimeout(() => done(null), 8000); // 아주 큰 파일에서 무한정 기다리지 않는다
    v.src = src;
  });
}

document.getElementById('local-file-input').addEventListener('change', async (e) => {
  // 사진과 **동영상**을 모두 받는다. 예전에는 동영상을 여기서 걸러내 "지원하지 않는다"고
  // 안내했는데, 지금은 공유 링크에도 동영상이 그대로 담겨 재생된다.
  const picked = [...(e.target.files || [])]
    .filter((f) => /^(image|video)\//.test(f.type || ''));
  e.target.value = ''; // 같은 파일을 다시 골라도 change가 뜨도록 초기화
  const statusEl = document.getElementById('local-pick-status');
  // 너무 큰 동영상은 **고르는 순간** 걸러낸다. 서버도 같은 기준으로 한 번 더 막지만,
  // 다 올리고 나서야 빠진 걸 알게 되면 무엇이 왜 빠졌는지 알기 어렵다.
  const limit = maxVideoBytes();
  const tooBig = picked.filter((f) => /^video\//.test(f.type || '') && f.size > limit);
  const files = picked.filter((f) => !tooBig.includes(f));
  if (!files.length) {
    statusEl.textContent = tooBig.length
      ? `동영상 용량이 너무 큽니다. 1개당 ${globalSettings.maxVideoMb}MB 이하만 올릴 수 있습니다.`
      : '사진·동영상을 선택하지 않았습니다.';
    statusEl.classList.remove('hidden');
    return;
  }
  if (tooBig.length) {
    showToast(`동영상 ${tooBig.length}개는 용량이 커서 제외했습니다. `
      + `(1개당 ${globalSettings.maxVideoMb}MB 이하)`);
  }
  statusEl.textContent = `${files.length}개 준비 중...`;
  statusEl.classList.remove('hidden');
  try {
    const items = [];
    for (let i = 0; i < files.length; i++) {
      const f = files[i];
      const objUrl = URL.createObjectURL(f);
      const isVideo = /^video\//.test(f.type || '');
      if (isVideo) {
        // 정지 프레임을 미리 뽑아 두면 목록 썸네일과 재생 전 화면이 곧바로 채워진다.
        const poster = await videoPosterBlob(objUrl);
        const posterUrl = poster ? URL.createObjectURL(poster) : objUrl;
        items.push({
          id: `local-${Date.now()}-${i}`,
          type: 'video',
          createTime: new Date(f.lastModified || Date.now()).toISOString(), // 동영상은 EXIF가 없다
          width: null, height: null,
          fullUrl: posterUrl, thumbUrl: posterUrl,
          videoUrl: objUrl,
          posterBlob: poster || null,   // 공유할 때 함께 올린다
        });
        continue;
      }
      items.push({
        id: `local-${Date.now()}-${i}`,
        type: 'photo',
        // 업로드 시각이 아니라 EXIF 촬영일시를 쓴다(없으면 파일 시각).
        createTime: await bestPhotoTime(f, f.lastModified),
        width: null, height: null,
        fullUrl: objUrl, thumbUrl: objUrl,
      });
    }
    // "사진 추가"면 기존 목록에 덧붙이고(촬영일 순으로 다시 정렬), 아니면 교체한다.
    let finalItems = items;
    if (localAppendMode && allPhotos.length) {
      finalItems = allPhotos.concat(items);
    }
    localAppendMode = false;
    finalItems.sort((a, b) => new Date(a.createTime) - new Date(b.createTime));
    isLocalMode = true;
    statusEl.classList.add('hidden');
    boot(finalItems);
  } catch (err) {
    localAppendMode = false;
    statusEl.textContent = '사진·동영상을 읽지 못했습니다: ' + err.message;
  }
});

// ---------- 홈 메뉴 동작 (사진 선택 시작 / 로그아웃 / 피드백) ----------
document.getElementById('btn-start-picker').addEventListener('click', () => {
  if (!isLoggedIn) { selectPanel('login'); return; } // 로그인 먼저
  appendMode = false;
  // 이미 만들어 둔 wepic이 있으면 "새로 만들기 / 기존 수정"을 먼저 묻는다
  if (needStartChoice()) { openStartModal(); return; }
  startPickerFlow();
});
document.getElementById('btn-logout-home').addEventListener('click', async (e) => {
  e.preventDefault();
  await api('/api/logout', { method: 'POST' }).catch(() => {});
  location.href = '/';
});
document.getElementById('btn-feedback-send').addEventListener('click', () => {
  const txt = document.getElementById('feedback-text').value.trim();
  const subject = encodeURIComponent('Wepic Feedback');
  const body = encodeURIComponent(txt);
  window.location.href = `mailto:garzette@paran.com?subject=${subject}&body=${body}`;
});

// 슬라이드쇼 하단의 "홈페이지로 가기"(데모/공유 모드)
document.getElementById('btn-demo-home').addEventListener('click', (e) => {
  e.preventDefault();
  location.href = '/';
});
// 데모를 보다가 로그인/회원가입으로 — 예전에는 구글로 바로 보냈지만, 제공자가 여러 개라
// 해당 화면으로 데려가 사용자가 고르게 한다. 재생·음악은 멈추고 홈으로 전환한다.
document.getElementById('btn-demo-login').addEventListener('click', (e) => {
  e.preventDefault();
  stopEverythingAndGoHome();
  selectPanel('login');
});
document.getElementById('btn-demo-signup').addEventListener('click', (e) => {
  e.preventDefault();
  stopEverythingAndGoHome();
  selectPanel('signup');
});

// ---------- 재생/표시 설정 ----------
function lsGet(key, fallback) { try { const v = localStorage.getItem(key); return v === null ? fallback : v; } catch { return fallback; } }
function lsSet(key, val) { try { localStorage.setItem(key, val); } catch {} }

function applyInterval(sec) {
  slideIntervalMs = sec * 1000;
  // Ken Burns 애니메이션 길이를 전환 간격과 맞춰 표시되는 동안 천천히 줌되게 한다.
  photoPane.style.setProperty('--kb-duration', sec + 's');
  lsSet('slideIntervalSec', String(sec));
  resetTimer();
}
function applyEffect(effect) {
  slideEffect = effect;
  photoPane.classList.remove('fx-fade', 'fx-slide', 'fx-kenburns');
  photoPane.classList.add('fx-' + effect);
  lsSet('slideEffect', effect);
}
// 제목은 브라우저에 저장하지 않는다 — 새 화면은 관리자 Default 타이틀로 시작하고,
// 기존 액자를 선택하면 그 액자에 저장된 제목을 쓴다(이전 화면의 입력값이 따라오지 않게).
function applyTitle(text) {
  const ov = document.getElementById('title-overlay');
  ov.textContent = text;
  const has = !!text.trim();
  ov.classList.toggle('hidden', !has);
  document.body.classList.toggle('has-title', has);
}

// 제목 아래 사진 번호("3 / 10") — 공유화면과 같은 자리·같은 크기로 보여준다.
function renderPhotoCounter() {
  const el = document.getElementById('photo-counter');
  if (!el) return;
  const show = filteredPhotos.length > 1;   // 한 장뿐이면 "1 / 1"은 의미가 없다
  el.textContent = show ? `${currentIndex + 1} / ${filteredPhotos.length}` : '';
  el.classList.toggle('hidden', !show);
}

// 배경음악을 "동영상 재생용"으로 잠시 정지 (재생 중일 때만). 나중에 복귀할 수 있게 표시.
function pauseMusicForVideo() {
  if (!musicPlaying) return;
  if (musicIsPreview()) {
    try { previewAudio.pause(); } catch {}
    musicPausedForVideo = true;
  } else if (ytPlayer) {
    try { ytPlayer.pauseVideo(); } catch {}
    musicPausedForVideo = true;
  }
}
// 동영상 때문에 정지했던 배경음악을 다시 재생.
function resumeMusicAfterVideo() {
  if (musicPausedForVideo) {
    if (musicIsPreview()) { try { previewAudio.play().catch(() => {}); } catch {} }
    else if (ytPlayer) { try { ytPlayer.playVideo(); } catch {} }
  }
  musicPausedForVideo = false;
}

// 배경음악이 재생되기 시작하면 배경음악과 겹쳐 들리지 않도록, 현재 재생 중인 동영상의
// 소리를 끈다. "동영상 소리 재생" 체크를 사용자가 직접 해제한 것과 동일하게 처리한다.
function muteVideoForBackgroundMusic() {
  if (!videoSoundOn) return;
  document.getElementById('video-sound-toggle').checked = false;
  applyVideoSound(false);
}

function applyVideoSound(on) {
  videoSoundOn = on;
  lsSet('videoSoundOn', on ? '1' : '0');
  // 현재 동영상이 재생 중이면 즉시 반영
  const cur = filteredPhotos[currentIndex];
  const v = document.getElementById('video-layer');
  if (cur && cur.type === 'video' && v.classList.contains('active')) {
    if (on) {
      v.muted = false;
      pauseMusicForVideo();
      v.play().catch(() => { v.muted = true; resumeMusicAfterVideo(); v.play().catch(() => {}); });
    } else {
      v.muted = true;
      resumeMusicAfterVideo();
    }
  }
}

// ---------- 시계 · 날씨 위젯 ----------
let clockTimer = null;
let weatherTimer = null;
let weatherRequested = false;

function startClock() {
  if (clockTimer) return;
  const tick = () => {
    const now = new Date();
    document.getElementById('amb-time').textContent =
      new Intl.DateTimeFormat('ko-KR', { hour: '2-digit', minute: '2-digit' }).format(now);
    document.getElementById('amb-date').textContent =
      new Intl.DateTimeFormat('ko-KR', { month: 'long', day: 'numeric', weekday: 'short' }).format(now);
  };
  tick();
  clockTimer = setInterval(tick, 10000);
}
function stopClock() { if (clockTimer) { clearInterval(clockTimer); clockTimer = null; } }

// WMO 날씨 코드 → 아이콘·한글 라벨
function weatherFromCode(code) {
  if (code === 0) return { icon: '☀️', label: '맑음' };
  if ([1, 2].includes(code)) return { icon: '🌤️', label: '대체로 맑음' };
  if (code === 3) return { icon: '☁️', label: '흐림' };
  if ([45, 48].includes(code)) return { icon: '🌫️', label: '안개' };
  if ([51, 53, 55, 56, 57].includes(code)) return { icon: '🌦️', label: '이슬비' };
  if ([61, 63, 65, 66, 67, 80, 81, 82].includes(code)) return { icon: '🌧️', label: '비' };
  if ([71, 73, 75, 77, 85, 86].includes(code)) return { icon: '❄️', label: '눈' };
  if ([95, 96, 99].includes(code)) return { icon: '⛈️', label: '뇌우' };
  return { icon: '🌡️', label: '' };
}

async function fetchWeather(lat, lon) {
  try {
    // 프라이버시: 외부(open-meteo)로 보내는 좌표는 소수 2자리(~1km)로만 반올림.
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat.toFixed(2)}&longitude=${lon.toFixed(2)}&current=temperature_2m,weather_code`;
    const r = await fetch(url);
    if (!r.ok) return;
    const d = await r.json();
    const t = Math.round(d.current?.temperature_2m);
    const { icon, label } = weatherFromCode(d.current?.weather_code);
    if (Number.isFinite(t)) document.getElementById('amb-weather').textContent = `${icon} ${t}° ${label}`.trim();
  } catch {}
}

// 위치 권한을 최초 1회만 요청한다. 거부/미지원이면 시계만 표시된다.
function initWeatherOnce() {
  if (weatherRequested || !navigator.geolocation) return;
  weatherRequested = true;
  navigator.geolocation.getCurrentPosition(
    (pos) => {
      const { latitude: lat, longitude: lon } = pos.coords;
      fetchWeather(lat, lon);
      if (!weatherTimer) weatherTimer = setInterval(() => fetchWeather(lat, lon), 15 * 60 * 1000);
    },
    () => {},
    { timeout: 8000, maximumAge: 600000 }
  );
}

function applyAmbient(on) {
  document.getElementById('ambient-widget').classList.toggle('hidden', !on);
  lsSet('ambientOn', on ? '1' : '0');
  if (on) { startClock(); initWeatherOnce(); }
  else { stopClock(); }
}

const INTERVAL_OPTIONS = [3, 5, 7, 10, 15, 20, 30];
function loadDisplaySettings() {
  let sec = parseInt(lsGet('slideIntervalSec', '10'), 10) || 10;
  // 저장값이 리스트에 없으면 가장 가까운 옵션으로 맞춘다 (이전 슬라이더 값 호환).
  if (!INTERVAL_OPTIONS.includes(sec)) {
    sec = INTERVAL_OPTIONS.reduce((a, b) => (Math.abs(b - sec) < Math.abs(a - sec) ? b : a), 10);
  }
  document.getElementById('interval-select').value = String(sec);
  applyInterval(sec);
  const eff = lsGet('slideEffect', 'fade');
  const effRadio = document.querySelector(`#effect-radios input[value="${eff}"]`) ||
                   document.querySelector('#effect-radios input[value="fade"]');
  effRadio.checked = true;
  applyEffect(effRadio.value);
  // 제목: 관리자 Default 타이틀로 시작한다(이전 화면에서 입력한 값을 이어받지 않는다).
  // 기존 액자를 선택하면 applyCurrentFrameToShareUI가 그 액자의 제목으로 덮어쓴다.
  const title = globalSettings.title || '';
  document.getElementById('title-input').value = title;
  applyTitle(title);
  const amb = lsGet('ambientOn', '1') !== '0';
  document.getElementById('ambient-toggle').checked = amb;
  applyAmbient(amb);
  const vsound = lsGet('videoSoundOn', '1') !== '0'; // 기본 ON
  document.getElementById('video-sound-toggle').checked = vsound;
  applyVideoSound(vsound);
}

// 설정 컨트롤 이벤트 (모듈 로드 시 1회 등록)
document.getElementById('interval-select').addEventListener('change', (e) => applyInterval(parseInt(e.target.value, 10)));
document.querySelectorAll('#effect-radios input').forEach((r) =>
  r.addEventListener('change', () => { if (r.checked) applyEffect(r.value); })
);
document.getElementById('title-input').addEventListener('input', (e) => applyTitle(e.target.value));
document.getElementById('ambient-toggle').addEventListener('change', (e) => applyAmbient(e.target.checked));
document.getElementById('video-sound-toggle').addEventListener('change', (e) => applyVideoSound(e.target.checked));

// ---------- 추가옵션 접기/펼치기 ----------
// 사진 방향·재생 설정은 한 번 정하면 자주 바꾸지 않아, 기본은 접어두고 필요할 때만 펼친다.
document.getElementById('btn-extra-options').addEventListener('click', (e) => {
  const btn = e.currentTarget;
  const box = document.getElementById('extra-options');
  const open = box.classList.contains('hidden'); // 지금 닫혀 있으면 이제 열린다
  box.classList.toggle('hidden', !open);
  btn.setAttribute('aria-expanded', open ? 'true' : 'false');
  btn.querySelector('.extra-options-caret').textContent = open ? '▾' : '▸';
});

// ---------- Default 정보관리 (전역 설정) ----------
// 모든 화면(데모·wepic 메인화면·wepic 공유화면)이 로딩 시 이 값을 먼저 읽어 적용한다.
// maxVideoMb: 동영상 1개의 크기 상한(서버의 MAX_SHARE_VIDEO_MB). /api/settings가 알려주며,
// 못 받아오면 서버 기본값과 같은 30을 쓴다.
let globalSettings = { title: '', musicUrl: '', titleFont: 'cursive', titleSize: 'medium', maxVideoMb: 30 };
const maxVideoBytes = () => Math.max(1, Number(globalSettings.maxVideoMb) || 30) * 1024 * 1024;

function applyGlobalSettingsToBody(s) {
  const b = document.body;
  ['tf-cursive', 'tf-handwriting-ko', 'tf-sans', 'tf-serif'].forEach((c) => b.classList.remove(c));
  ['ts-small', 'ts-medium', 'ts-large'].forEach((c) => b.classList.remove(c));
  b.classList.add('tf-' + (s.titleFont || 'cursive'));
  b.classList.add('ts-' + (s.titleSize || 'medium'));
}
async function loadGlobalSettings() {
  try {
    const s = await fetch('/api/settings', { credentials: 'same-origin' }).then((r) => r.json());
    globalSettings = { ...globalSettings, ...s };
  } catch { /* 실패해도 기본값으로 진행 */ }
  applyGlobalSettingsToBody(globalSettings);
  // 갤러리 업로드 안내 문구의 용량도 서버가 정한 값으로 맞춘다(관리자가 바꾸면 함께 바뀐다).
  const hint = document.getElementById('hint-video-mb');
  if (hint) hint.textContent = `동영상은 1개당 ${globalSettings.maxVideoMb}MB까지`;
  return globalSettings;
}

// 관리자 화면: Default 정보관리 폼
function fillDefaultsForm() {
  document.getElementById('def-title').value = globalSettings.title || '';
  document.getElementById('def-music').value = globalSettings.musicUrl || '';
  document.getElementById('def-font').value = globalSettings.titleFont || 'cursive';
  document.getElementById('def-size').value = globalSettings.titleSize || 'medium';
  updateDefaultsPreview();
}
function updateDefaultsPreview() {
  const el = document.getElementById('def-preview');
  el.textContent = document.getElementById('def-title').value.trim() || 'Wepic';
  // 미리보기는 선택 중인 폰트/크기를 즉시 반영 (저장 전에도 확인 가능)
  applyGlobalSettingsToBody({
    titleFont: document.getElementById('def-font').value,
    titleSize: document.getElementById('def-size').value,
  });
}
['def-title', 'def-font', 'def-size'].forEach((id) =>
  document.getElementById(id).addEventListener('input', updateDefaultsPreview));
document.getElementById('def-save').addEventListener('click', async () => {
  const body = {
    title: document.getElementById('def-title').value.trim(),
    musicUrl: document.getElementById('def-music').value.trim(),
    titleFont: document.getElementById('def-font').value,
    titleSize: document.getElementById('def-size').value,
  };
  try {
    const saved = await api('/api/admin/settings', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    globalSettings = { ...globalSettings, ...saved };
    applyGlobalSettingsToBody(globalSettings);
    const ok = document.getElementById('def-saved');
    ok.classList.remove('hidden');
    setTimeout(() => ok.classList.add('hidden'), 2000);
  } catch (err) {
    alert('저장 실패: ' + err.message);
  }
});

// ---------- wepic 관리자: 화면관리 / PIN번호관리 ----------
function fmtDateTime(iso) {
  if (!iso) return '-';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '-'
    : new Intl.DateTimeFormat('ko-KR', { dateStyle: 'medium', timeStyle: 'short' }).format(d);
}

// 관리자 화면관리(전체)와 My사진관리(본인 소유만)가 이 렌더링 로직을 함께 쓴다.
// scope: 'admin' | 'my' — API 엔드포인트만 다르고 화면 구성은 동일하다.
const shareApiBase = (scope) => (scope === 'my' ? '/api/my/shares' : '/api/admin/shares');

async function loadShareList(targetId, scope) {
  const box = document.getElementById(targetId);
  box.textContent = '불러오는 중...';
  let shares = [];
  try {
    ({ shares } = await api(shareApiBase(scope)));
  } catch (err) {
    box.innerHTML = '';
    const p = document.createElement('div');
    p.className = 'admin-empty';
    p.textContent = '목록을 불러오지 못했습니다: ' + err.message;
    box.appendChild(p);
    return;
  }
  const countEl = document.getElementById(scope === 'my' ? 'my-shares-count' : 'admin-shares-count');
  if (countEl) countEl.textContent = `총 ${shares.length}개`;

  box.innerHTML = '';
  if (!shares.length) {
    const p = document.createElement('div');
    p.className = 'admin-empty';
    p.textContent = scope === 'my' ? '아직 내가 만든 액자가 없습니다.' : '아직 만들어진 공유가 없습니다.';
    box.appendChild(p);
    return;
  }
  const pinMode = targetId.endsWith('pins-list');
  shares.forEach((s) => box.appendChild(shareRow(s, scope, pinMode)));
}

// 화면관리/PIN번호관리 공용 행. pinMode=false면 삭제·열기 버튼, true면 PIN 입력+저장.
function shareRow(s, scope, pinMode) {
  const base = shareApiBase(scope);
  const row = document.createElement('div');
  row.className = 'admin-row' + (s.expired ? ' expired' : '');

  const img = document.createElement('img');
  img.className = 'admin-thumb';
  img.alt = '';
  if (s.thumbUrl) img.src = s.thumbUrl;
  row.appendChild(img);

  const meta = document.createElement('div');
  meta.className = 'admin-meta';
  const line1 = document.createElement('div');
  const t = document.createElement('b');
  t.textContent = s.title || '(제목 없음)';
  line1.appendChild(t);
  if (s.frameName) line1.appendChild(document.createTextNode(`  [${s.frameName}]`));
  line1.appendChild(document.createTextNode(`  ·  사진 ${s.count}장`));
  if (s.isPublic) line1.appendChild(document.createTextNode('  ·  🌐 전체공유'));
  const line2 = document.createElement('div');
  line2.className = 'dim';
  line2.textContent = pinMode
    ? `${fmtDateTime(s.updatedAt)}  ·  만든사람 ${s.owner || '-'}  ·  ${s.id}`
    : `날짜 ${fmtDateTime(s.updatedAt)}  ·  PIN ${s.pin || '없음'}  ·  만든사람 ${s.owner || '-'}`;
  meta.append(line1, line2);
  if (!pinMode) {
    const line3 = document.createElement('div');
    line3.className = 'dim';
    line3.textContent = `만료 ${fmtDateTime(s.expiresAt)}${s.expired ? ' (만료됨)' : ''}  ·  ${s.id}`;
    meta.appendChild(line3);
  }
  row.appendChild(meta);

  const actions = document.createElement('div');
  actions.className = 'admin-actions';

  if (pinMode) {
    const input = document.createElement('input');
    input.className = 'pin-input';
    input.type = 'text';
    input.maxLength = 4;
    input.inputMode = 'numeric';
    input.value = s.pin || '';
    input.placeholder = '----';
    const save = document.createElement('button');
    save.className = 'secondary slim';
    save.textContent = '저장';
    save.addEventListener('click', async () => {
      const pin = input.value.trim();
      if (!/^\d{4}$/.test(pin)) { alert('PIN은 4자리 숫자여야 합니다.'); return; }
      try {
        await api(`${base}/${s.id}/pin`, {
          method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pin }),
        });
        save.textContent = '저장됨';
        setTimeout(() => { save.textContent = '저장'; }, 1500);
      } catch (err) { alert('저장 실패: ' + err.message); }
    });
    actions.append(input, save);
  } else {
    // 액자마다 두 가지로 열 수 있다: 관리용 메인화면(사진 추가/제외·PIN·설정 편집 가능) / 가족이 보는 공유화면
    const openMain = document.createElement('a');
    openMain.className = 'text-link small';
    openMain.href = `/?frame=${encodeURIComponent(s.id)}`;
    openMain.target = '_blank';
    openMain.title = '이 액자를 wepic 메인화면에서 열어 사진 추가/제외·PIN·설정을 바로 편집합니다';
    openMain.textContent = 'wepic 메인화면 열기';
    const openShare = document.createElement('a');
    openShare.className = 'text-link small';
    openShare.href = s.url; openShare.target = '_blank';
    openShare.textContent = 'wepic 공유화면 열기';
    const del = document.createElement('button');
    del.className = 'btn-danger';
    del.textContent = '삭제';
    del.addEventListener('click', async () => {
      if (!confirm(`이 공유 폴더를 삭제할까요?\n\n제목: ${s.title || '(없음)'}\n사진 ${s.count}장\n\n삭제하면 이 링크는 즉시 열리지 않습니다.`)) return;
      try {
        await api(`${base}/${s.id}`, { method: 'DELETE' });
        loadShareList(scope === 'my' ? 'my-shares-list' : 'admin-shares-list', scope);
      } catch (err) { alert('삭제 실패: ' + err.message); }
    });
    actions.append(openMain, openShare, del);
  }
  row.appendChild(actions);
  return row;
}

// ---------- 관리자: 회원관리 (Quota·사용량) ----------
async function loadMemberList() {
  const box = document.getElementById('admin-members-list');
  const countEl = document.getElementById('admin-members-count');
  box.textContent = '불러오는 중...';
  countEl.textContent = '';
  try {
    const r = await api('/api/admin/members');
    document.getElementById('admin-default-quota').textContent =
      Math.round(r.defaultQuotaBytes / (1024 * 1024));
    box.innerHTML = '';
    if (!r.members.length) { box.innerHTML = '<div class="admin-empty">회원이 없습니다.</div>'; return; }
    countEl.textContent = `${r.members.length}명`;
    r.members.forEach((mem) => box.appendChild(memberRow(mem)));
  } catch (err) {
    box.textContent = '불러오지 못했습니다: ' + err.message;
  }
}

function memberRow(mem) {
  const row = document.createElement('div');
  row.className = 'admin-row';

  const meta = document.createElement('div');
  meta.className = 'admin-meta';
  const line1 = document.createElement('div');
  const nameEl = document.createElement('b');
  nameEl.textContent = mem.name || '(이름 없음)';
  line1.appendChild(nameEl);
  line1.appendChild(document.createTextNode(
    `  ·  ${PROVIDER_LABELS[mem.provider] || mem.provider}`
    + `  ·  ${mem.role === 'admin' ? 'Wepic 관리자' : 'Wepic 사용자'}`
    + (mem.status === 'blocked' ? '  ·  ⛔ 차단됨' : '')
  ));
  const line2 = document.createElement('div');
  line2.className = 'dim';
  line2.textContent = `${mem.email || '(이메일 없음)'}  ·  가입 ${fmtDateTime(mem.createdAt)}  ·  최근 로그인 ${fmtDateTime(mem.lastLoginAt)}`;
  // 사용량: 막대 + 숫자. 기본값을 쓰는 회원은 그렇다고 표시해 둔다(관리자가 늘려준 것과 구분).
  const line3 = document.createElement('div');
  line3.className = 'dim';
  line3.textContent = `저장용량 ${mem.usedText} / ${mem.quotaText} (${mem.usedPercent}%)`
    + (mem.isDefaultQuota ? ' · 기본값' : ' · 개별 지정');
  const bar = document.createElement('div');
  bar.className = 'quota-bar';
  const fill = document.createElement('div');
  fill.className = 'quota-bar-fill' + (mem.usedPercent >= 90 ? ' over' : '');
  fill.style.width = mem.usedPercent + '%';
  bar.appendChild(fill);
  meta.append(line1, line2, line3, bar);
  row.appendChild(meta);

  // Quota 변경: MB로 입력받는다. 비우거나 0이면 기본값으로 되돌린다.
  const actions = document.createElement('div');
  actions.className = 'admin-actions';
  const input = document.createElement('input');
  input.className = 'pin-input quota-input';
  input.type = 'number';
  input.min = '0';
  input.placeholder = 'MB';
  input.value = mem.isDefaultQuota ? '' : String(Math.round(mem.quotaBytes / (1024 * 1024)));
  input.title = '저장용량(MB). 비우면 기본값을 따릅니다.';
  const save = document.createElement('button');
  save.className = 'secondary slim';
  save.textContent = '용량 저장';
  save.addEventListener('click', async () => {
    save.disabled = true;
    try {
      await api(`/api/admin/members/${mem.id}/quota`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ quotaMb: input.value.trim() === '' ? null : Number(input.value) }),
      });
      showToast(`${mem.name || mem.id} 회원의 저장용량을 변경했습니다.`);
      loadMemberList();
    } catch (err) {
      showToast('변경 실패: ' + err.message);
      save.disabled = false;
    }
  });
  actions.append(input, save);
  row.appendChild(actions);
  return row;
}
document.getElementById('admin-members-reload').addEventListener('click', loadMemberList);

document.getElementById('admin-shares-reload').addEventListener('click', () => loadShareList('admin-shares-list', 'admin'));
document.getElementById('admin-seed-showcase').addEventListener('click', async (e) => {
  const btn = e.currentTarget;
  btn.disabled = true;
  try {
    const r = await api('/api/admin/seed-showcase', { method: 'POST' });
    showToast(r.alreadySeeded ? '이미 등록되어 있습니다.' : '"사진 보기" 예시를 등록했습니다.');
    loadShareList('admin-shares-list', 'admin'); // 방금 만든 예시가 목록에 보이도록 갱신
  } catch (err) {
    showToast('등록 실패: ' + err.message);
  } finally {
    btn.disabled = false;
  }
});
document.getElementById('admin-pins-reload').addEventListener('click', () => loadShareList('admin-pins-list', 'admin'));
document.getElementById('my-shares-reload').addEventListener('click', () => loadShareList('my-shares-list', 'my'));
document.getElementById('my-pins-reload').addEventListener('click', () => loadShareList('my-pins-list', 'my'));

// ---------- 부팅 ----------
function boot(photos) {
  allPhotos = photos;
  currentIndex = 0;
  // 방향 필터는 새로 시작할 때 항상 전체보기로 초기화
  orientationMode = 'all';
  const allRadio = document.querySelector('#orientation-radios input[value="all"]');
  if (allRadio) allRadio.checked = true;
  // 공유(shared) 유입은 실제로 로그인하지 않은 경우만 게스트다 — 로그인한 회원이 공유로
  // 받은 사진을 여는 경우도 있어(그때는 업로드 가능).
  const guest = isSharedMode && !isLoggedIn;
  // 배경음악: 관리자 Default 설정 > 앱 기본곡. 이전에 듣던 곡을 브라우저에서 이어받지 않는다.
  // (액자 데이터에 musicUrl이 있으면 호출부가 이미 채워두므로 비어있을 때만 건드린다)
  const musicEl = document.getElementById('music-url');
  if (!musicEl.value.trim()) {
    musicEl.value = globalSettings.musicUrl || DEFAULT_MUSIC_URL;
  }
  document.getElementById('account-links').classList.toggle('hidden', guest);
  document.getElementById('demo-links').classList.toggle('hidden', !guest);
  // 사진 업로드·공유 링크 생성은 로그인한 Wepic 회원만 가능하다(서버가 requireMember로 막음).
  // 구글 포토 "공유"로 받은 사진(isSharedMode)도 예외 없이 로그인이 필요하므로, 게스트
  // 상태에서는 공유 블록을 숨기고 위 demo-links의 로그인 유도만 보여준다.
  document.getElementById('share-block').classList.toggle('hidden', guest);
  // 세션당 액자 목록. 관리자가 액자를 열었을 때(isFrameMode)도 서버가 이미 그 액자를
  // currentFrameId로 선택해 두었으므로 그대로 반영된다.
  loadFrames();
  loadDisplaySettings();
  // 관리자가 액자를 열었을 때: 그 액자에 저장된 제목·전환설정을 초기값으로 재현한다
  // (이후에는 일반 메인화면처럼 자유롭게 사진 추가·제외, PIN 변경, 링크변경 반영이 가능하다).
  if (isFrameMode && frameManifest) {
    const badge = document.getElementById('frame-badge');
    // 관리자가 남의 액자를 연 경우와, 회원이 자기 wepic을 고치려고 연 경우를 구분해 적는다.
    badge.textContent = (isWepicAdmin ? '관리자 모드' : 'wepic 수정 중')
      + ` — ${frameManifest.title || '(제목 없음)'}`;
    badge.classList.remove('hidden');
    applyTitle(frameManifest.title || '');
    if (frameManifest.intervalSec) {
      const sec = Math.min(60, Math.max(3, Number(frameManifest.intervalSec)));
      const sel = document.getElementById('interval-select');
      if ([...sel.options].some((o) => o.value === String(sec))) sel.value = String(sec);
      applyInterval(sec);
    }
    if (frameManifest.effect) {
      const r = document.querySelector(`#effect-radios input[value="${frameManifest.effect}"]`);
      if (r) { r.checked = true; applyEffect(frameManifest.effect); }
    }
  }
  showSlideshow();
  recomputeFiltered();
  // 사진 목록·설정 패널이 그려진 **뒤에** 한 번 더 맨 위로 되돌린다
  // (showSlideshow 시점에는 아직 내용이 없어 스크롤 높이가 정해지지 않았다).
  resetSlideshowScroll();
}

let loggedInName = null;
let isLoggedIn = false;
// 구글로 로그인해서 구글 포토(Picker·/img·/video)를 쓸 수 있는 상태인가.
// 카카오·네이버 로그인은 false — 이 값을 보고 구글 전용 UI·동작을 전부 막는다.
let canUseGooglePhotos = false;
let isWepicAdmin = false;    // wepic 관리자인지(프레임 모드 배지 문구를 가르는 데 쓴다)

// 로그인 제공자 버튼 정의. 서버(/api/status의 availableProviders)가 "키가 설정된" 제공자만
// 알려주므로, 나머지는 눌러도 오류가 나지 않게 "준비중"으로 비활성 표시한다.
// name은 "Google로", "카카오로"처럼 조사까지 붙인 형태로 둔다(버튼 문구 조립용).
const LOGIN_PROVIDERS = [
  { key: 'google', name: 'Google로', icon: 'G', href: '/auth/login' },
  { key: 'kakao', name: '카카오로', icon: 'K', href: '/auth/kakao/login' },
  { key: 'naver', name: '네이버로', icon: 'N', href: '/auth/naver/login' },
  { key: 'facebook', name: 'Facebook으로', icon: 'f', href: '/auth/facebook/login' },
];
// 로그인 화면과 회원가입 화면이 같은 버튼을 쓰므로 대상 컨테이너를 인자로 받는다.
// verb: 버튼에 쓸 동작 이름("계속하기" / "가입하기")
function renderLoginProviders(available, boxId = 'login-providers', verb = '계속하기') {
  const box = document.getElementById(boxId);
  if (!box) return;
  const ready = Array.isArray(available) ? available : [];
  box.innerHTML = '';
  LOGIN_PROVIDERS.forEach((p) => {
    const on = ready.includes(p.key);
    // 준비된 제공자는 링크(a), 아직 설정 안 된 것은 누를 수 없는 span으로 그린다.
    const el = document.createElement(on ? 'a' : 'span');
    el.className = `btn-provider prov-${on ? p.key : 'soon'}`;
    if (on) el.href = p.href;
    // 회원가입 화면의 Google 버튼만: 구글 인증으로 바로 보내지 않고 안내를 한 번 더 띄운다.
    // 구글 포토 접근은 운영자가 최초 1회 등록해야 열리므로, 등록 없이 인증만 하면
    // 사진을 못 골라 원인을 알 수 없는 실패로 보인다.
    if (on && p.key === 'google' && boxId === 'signup-providers') {
      el.addEventListener('click', (ev) => {
        ev.preventDefault();
        openGoogleNotice(p.href);
      });
    }
    const icon = document.createElement('span');
    icon.className = 'prov-icon';
    icon.textContent = p.icon;
    el.appendChild(icon);
    const label = `${p.name} ${verb}`;
    el.appendChild(document.createTextNode(on ? label : `${label} (준비중)`));
    box.appendChild(el);
  });
}

// Google 가입 안내 팝업 — "다음"을 누르면 그때 구글 인증으로 넘어가고, "취소"면 회원가입 화면에 머문다.
let googleNoticeHref = '/auth/login';
function openGoogleNotice(href) {
  googleNoticeHref = href || '/auth/login';
  document.getElementById('google-notice-modal').classList.remove('hidden');
}
document.getElementById('google-notice-next').addEventListener('click', () => {
  document.getElementById('google-notice-modal').classList.add('hidden');
  location.href = googleNoticeHref;
});
document.getElementById('google-notice-cancel').addEventListener('click', () => {
  document.getElementById('google-notice-modal').classList.add('hidden');
  selectPanel('signup');   // 취소하면 회원가입 화면으로 되돌아온다
});

// 회원가입: 필수 동의 2개를 모두 체크해야 가입 버튼이 눌린다.
function refreshSignupGate() {
  const ok = document.getElementById('agree-terms').checked
    && document.getElementById('agree-privacy').checked;
  document.getElementById('signup-providers').classList.toggle('gated', !ok);
  document.getElementById('signup-gate-note').classList.toggle('hidden', ok);
}
['agree-terms', 'agree-privacy'].forEach((id) =>
  document.getElementById(id).addEventListener('change', refreshSignupGate));

// 로그인 상태를 홈의 로그인/사진 패널에 반영 (자동 진입은 하지 않음)
function applyLoginState(status) {
  isLoggedIn = !!status.loggedIn;
  // 이전에 만든 공유 링크가 있으면 "링크변경 반영"을 바로 쓸 수 있게 노출
  if (status.hasShare) {
    setShareLinkState(true, status.shareUrl || '');
    shareCommentCount = Number(status.shareCommentCount || 0);
    updateExcludeAvailability();
    if (status.sharePin) setSharePin(status.sharePin); // 기존 공유의 PIN 표시
    document.getElementById('share-public').checked = !!status.sharePublic;
  }
  // wepic 관리자 화면 진입 메뉴는 관리자(role='admin')로 로그인했을 때만 노출
  isWepicAdmin = !!status.isAdmin;
  // 액자 목록을 미리 읽어 둔다. 예전에는 슬라이드쇼가 뜰 때만 읽어서, 홈에서 바로
  // "사진 고르기"를 누르면 frames가 비어 있어 "새로 만들기 / 기존 수정" 확인이
  // 아예 뜨지 않았다(needStartChoice가 false). 여기서 읽으면 항상 준비돼 있다.
  if (status.loggedIn) loadFrames();
  document.getElementById('menu-admin').classList.toggle('hidden', !status.isAdmin);
  // My사진관리는 로그인한 Wepic 사용자(관리자 포함)라면 누구나 노출
  document.getElementById('menu-my').classList.toggle('hidden', !status.loggedIn);
  loggedInName = isLoggedIn ? (status.name || status.email || null) : null;
  // 구글로 로그인했는지 여기 한 곳에서 판단해 화면 전체가 같은 기준을 쓰게 한다.
  // (예전에는 이 구분이 없어 카카오 로그인인데도 구글 포토 인증을 시도해 오류가 났다)
  canUseGooglePhotos = !!(isLoggedIn && status.canPickGooglePhotos);

  // 상단 메뉴 — 로그인 전: [로그인] [회원가입]
  //             로그인 후: [정보수정] ["Google 홍길동"(표시만)]  ※ 회원가입은 숨김
  const menuLogin = document.getElementById('menu-login');
  const menuSignup = document.getElementById('menu-signup');
  const menuMe = document.getElementById('menu-me');
  const menuWhoami = document.getElementById('menu-whoami');
  menuLogin.classList.toggle('hidden', isLoggedIn);
  menuSignup.classList.toggle('hidden', isLoggedIn); // 이미 회원이면 가입할 이유가 없다
  menuMe.classList.toggle('hidden', !isLoggedIn);
  menuWhoami.classList.toggle('hidden', !isLoggedIn);
  if (isLoggedIn) {
    // "Google 홍길동" / "카카오 홍길동" 처럼 어느 계정으로 들어왔는지 함께 보여준다.
    const via = PROVIDER_LABELS[status.provider] || status.provider || '';
    menuWhoami.textContent = `${via ? via + ' ' : ''}${loggedInName || '사용자'}`;
    menuWhoami.title = '누르면 로그아웃합니다';
  }

  const providers = document.getElementById('login-providers');
  const loginActions = document.getElementById('login-actions');
  const loginStatus = document.getElementById('login-status');
  const photosNote = document.getElementById('photos-login-note');
  renderLoginProviders(status.availableProviders, 'login-providers', '계속하기');
  renderLoginProviders(status.availableProviders, 'signup-providers', '가입하기');
  refreshSignupGate();
  if (isLoggedIn) {
    providers.classList.add('hidden');
    loginActions.classList.remove('hidden');
    const via = status.provider ? ` (${PROVIDER_LABELS[status.provider] || status.provider})` : '';
    loginStatus.textContent = `✓ ${loggedInName || '내 계정'}으로 로그인됨${via}`;
    loginStatus.classList.remove('hidden');
  } else {
    providers.classList.remove('hidden');
    loginActions.classList.add('hidden');
    loginStatus.classList.add('hidden');
  }

  // 사진 선택 패널: 구글이면 Picker, 그 외 제공자면 기기 갤러리 업로드 UI를 보여준다.
  const photosGoogle = document.getElementById('photos-google');
  const photosLocal = document.getElementById('photos-local');
  photosGoogle.classList.toggle('hidden', !canUseGooglePhotos);
  photosLocal.classList.toggle('hidden', !(isLoggedIn && !canUseGooglePhotos));
  // "사진 추가"는 이미 보고 있는 사진이 있을 때만 의미가 있다.
  document.getElementById('btn-pick-local-add').classList.toggle('hidden', allPhotos.length === 0);
  // 로그인 전에는 두 블록 모두 감추고 "로그인이 필요합니다"만 남긴다.
  photosNote.classList.toggle('hidden', isLoggedIn);

  // "사진선택" 섹션의 사진 고르기 아이콘도 같은 기준으로 나눈다.
  // 구글 전용(포토 다시 선택·추가)은 구글 로그인일 때만 보인다.
  // ("계정 다시 연결하기" 링크는 없앴다 — 토큰이 만료되면 어차피 로그인 화면으로 보낸다)
  document.getElementById('google-only-links').classList.toggle('hidden', !canUseGooglePhotos);
  document.getElementById('local-only-links').classList.toggle('hidden', canUseGooglePhotos || !isLoggedIn);

  // 회원정보 패널 채우기
  fillMeForm(status.me, status.provider);
}

// 제공자 코드를 사람이 읽는 이름으로
const PROVIDER_LABELS = { google: 'Google', kakao: '카카오', naver: '네이버', facebook: 'Facebook' };

// 회원정보 패널: **이메일만** 수정 가능하고 나머지(이름 포함)는 읽기 전용으로 표시한다.
//   이름은 로그인 제공자에서 온 값이므로 여기서 고치지 않는다. 다만 PUT /api/me는 name도
//   함께 받으므로, 저장할 때 되돌려 보낼 현재 이름을 meName에 담아둔다.
let meName = '';
function fillMeForm(me, provider) {
  if (!me) return;
  meName = me.name || '';
  document.getElementById('me-name').textContent = meName || '-';
  document.getElementById('me-email').value = me.email || '';
  document.getElementById('me-provider').textContent =
    PROVIDER_LABELS[me.provider || provider] || me.provider || provider || '-';
  document.getElementById('me-role').textContent =
    me.role === 'admin' ? 'Wepic 관리자' : 'Wepic 사용자';
  document.getElementById('me-created').textContent = fmtDateTime(me.createdAt);
  document.getElementById('me-last').textContent = fmtDateTime(me.lastLoginAt);
  // 저장용량: 한도는 /api/status(me)가 알려주고, 실제 사용량은 R2를 훑어야 해서 따로 받아온다.
  document.getElementById('me-quota').textContent = `한도 ${fmtMb(me.quotaBytes)} · 사용량 확인 중...`;
  loadMyUsage();
}

const fmtMb = (n) => {
  const mb = (Number(n) || 0) / (1024 * 1024);
  return mb >= 1024 ? `${(mb / 1024).toFixed(2)}GB` : `${mb.toFixed(1)}MB`;
};
async function loadMyUsage() {
  const el = document.getElementById('me-quota');
  const fill = document.getElementById('me-quota-fill');
  try {
    const r = await api('/api/me/usage');
    const pct = r.limit > 0 ? Math.min(100, Math.round((r.used / r.limit) * 100)) : 0;
    el.textContent = `${r.usedText} / ${r.limitText} (${pct}%)`;
    fill.style.width = pct + '%';
    fill.classList.toggle('over', pct >= 90);
  } catch {
    el.textContent = '사용량을 불러오지 못했습니다.';
    fill.style.width = '0%';
  }
}

document.getElementById('me-save').addEventListener('click', async () => {
  const name = meName;   // 이름은 화면에서 고치지 않고 그대로 되돌려 보낸다
  const email = document.getElementById('me-email').value.trim();
  // 서버도 검사하지만, 저장을 누르고 나서야 알게 되는 것보다 여기서 먼저 알려준다.
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) {
    alert('이메일 형식이 올바르지 않습니다. (비워두셔도 됩니다)');
    return;
  }
  const btn = document.getElementById('me-save');
  btn.disabled = true;
  try {
    const r = await api('/api/me', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, email }),
    });
    // 저장된 값을 화면에 다시 반영(상단 메뉴 이름 포함)
    loggedInName = r.me?.name || name;
    // 상단 바에서 이름을 보여주는 건 #menu-whoami다(#menu-me는 "정보수정" 라벨 고정).
    // 예전에는 여기서 menu-me의 글자를 "👤 이름"으로 덮어써 메뉴 이름이 사라졌다.
    const whoami = document.getElementById('menu-whoami');
    const via = whoami.textContent.replace(/\s*\S+$/, '').trim();
    whoami.textContent = `${via ? via + ' ' : ''}${loggedInName}`;
    if (r.me) fillMeForm(r.me, r.me.provider);
    const ok = document.getElementById('me-saved');
    ok.classList.remove('hidden');
    setTimeout(() => ok.classList.add('hidden'), 2000);
  } catch (err) {
    alert('저장 실패: ' + err.message);
  } finally {
    btn.disabled = false;
  }
});
document.getElementById('btn-logout-me').addEventListener('click', async (e) => {
  e.preventDefault();
  await doLogout();
});

// ---------- 회원탈퇴 ----------
// 계정과 이 회원이 만든 wepic 컨텐츠가 모두 지워지는 되돌릴 수 없는 작업이라,
// (1) 무엇이 지워지는지 먼저 보여주고 (2) 팝업에서 한 번 더 확인받은 뒤에 실행한다.
const withdrawModal = document.getElementById('withdraw-modal');
document.getElementById('btn-withdraw').addEventListener('click', async (e) => {
  e.preventDefault();
  const summary = document.getElementById('withdraw-summary');
  summary.textContent = '삭제될 내용을 확인하는 중...';
  withdrawModal.classList.remove('hidden');
  try {
    const r = await api('/api/me/withdraw-preview');
    summary.textContent = `삭제 대상 — 만든 wepic ${r.shareCount}개 · 사진 ${r.photoCount}장 (${r.usedText})`;
  } catch {
    summary.textContent = '삭제될 내용을 확인하지 못했습니다. 계속하면 계정과 만든 wepic이 모두 지워집니다.';
  }
});
document.getElementById('btn-withdraw-cancel').addEventListener('click', (e) => {
  e.preventDefault();
  withdrawModal.classList.add('hidden');
});
withdrawModal.addEventListener('click', (e) => { if (e.target === withdrawModal) withdrawModal.classList.add('hidden'); });
document.getElementById('btn-withdraw-confirm').addEventListener('click', async (e) => {
  const btn = e.currentTarget;
  btn.disabled = true;
  btn.textContent = '탈퇴 처리 중...';
  try {
    // confirm 값은 서버에서도 한 번 더 검사한다(실수로 호출되는 것을 막기 위한 방어).
    const r = await api('/api/me/withdraw', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ confirm: 'DELETE' }),
    });
    alert(`탈퇴가 완료되었습니다. (삭제된 wepic ${r.deletedShares}개)`);
    location.href = '/';
  } catch (err) {
    showToast('탈퇴 실패: ' + err.message);
    btn.disabled = false;
    btn.textContent = '확인 — 탈퇴하겠습니다';
  }
});

// ---------- 촬영일시 읽기 (EXIF) ----------
// 기기에서 올린 사진은 파일의 lastModified가 "촬영 시각"이 아니라 "기기에 복사/저장된
// 시각"인 경우가 많다(갤러리에서 공유하거나 다운로드받은 사진). 그래서 날짜가 오늘로
// 보이는 문제가 있었다 → JPEG의 EXIF DateTimeOriginal(0x9003)을 먼저 읽고,
// 없을 때만 lastModified로 대체한다.
//
// 외부 라이브러리를 쓸 수 없어(정적 자산만 서빙) 필요한 부분만 직접 파싱한다:
// JPEG 세그먼트를 훑어 APP1(Exif) → TIFF 헤더 → IFD0 → ExifIFD → DateTimeOriginal.
async function readExifDateTime(blob) {
  try {
    // EXIF는 파일 앞부분에 있다. 전체를 읽지 않고 앞 256KB만 본다(대용량 사진 대비).
    const buf = await blob.slice(0, 256 * 1024).arrayBuffer();
    const v = new DataView(buf);
    if (v.byteLength < 4 || v.getUint16(0) !== 0xffd8) return null; // JPEG(SOI) 아님

    let off = 2;
    while (off + 4 <= v.byteLength) {
      if (v.getUint8(off) !== 0xff) break;         // 마커 정렬이 깨졌으면 중단
      const marker = v.getUint8(off + 1);
      if (marker === 0xda) break;                   // SOS(이미지 데이터) — 여기까진 EXIF 없음
      const segLen = v.getUint16(off + 2);
      if (segLen < 2) break;
      // APP1 + "Exif\0\0" 이면 그 안의 TIFF 구조를 읽는다
      if (marker === 0xe1 && off + 10 <= v.byteLength &&
          v.getUint32(off + 4) === 0x45786966 && v.getUint16(off + 8) === 0x0000) {
        const tiff = off + 10;
        if (tiff + 8 > v.byteLength) return null;
        const bomVal = v.getUint16(tiff);
        if (bomVal !== 0x4949 && bomVal !== 0x4d4d) return null;
        const le = bomVal === 0x4949;               // 'II'=little endian, 'MM'=big endian
        if (v.getUint16(tiff + 2, le) !== 0x002a) return null;
        const ifd0 = tiff + v.getUint32(tiff + 4, le);

        // 태그 하나에서 ASCII 문자열을 꺼낸다(날짜는 "YYYY:MM:DD HH:MM:SS" 형식).
        const readAscii = (entry) => {
          const count = v.getUint32(entry + 4, le);
          const valOff = count > 4 ? tiff + v.getUint32(entry + 8, le) : entry + 8;
          if (valOff + count > v.byteLength) return '';
          let s = '';
          for (let i = 0; i < count; i++) {
            const c = v.getUint8(valOff + i);
            if (c === 0) break;
            s += String.fromCharCode(c);
          }
          return s;
        };
        // IFD를 훑어 원하는 태그를 찾는다. exifPtr(0x8769)는 하위 IFD 위치.
        const scanIfd = (ifdOff, wanted) => {
          if (ifdOff + 2 > v.byteLength) return {};
          const n = v.getUint16(ifdOff, le);
          const found = {};
          for (let i = 0; i < n; i++) {
            const entry = ifdOff + 2 + i * 12;
            if (entry + 12 > v.byteLength) break;
            const tag = v.getUint16(entry, le);
            if (wanted.includes(tag)) found[tag] = entry;
          }
          return found;
        };

        // DateTimeOriginal은 보통 ExifIFD 안에 있고, DateTime(0x0132)은 IFD0에 있다.
        const f0 = scanIfd(ifd0, [0x8769, 0x0132]);
        let raw = '';
        if (f0[0x8769]) {
          const sub = tiff + v.getUint32(f0[0x8769] + 8, le);
          const fe = scanIfd(sub, [0x9003, 0x9004]); // DateTimeOriginal, DateTimeDigitized
          if (fe[0x9003]) raw = readAscii(fe[0x9003]);
          else if (fe[0x9004]) raw = readAscii(fe[0x9004]);
        }
        if (!raw && f0[0x0132]) raw = readAscii(f0[0x0132]);

        // "2024:05:01 14:30:00" → Date. 값이 비었거나 0이면 무효로 본다.
        const mm = raw.match(/^(\d{4}):(\d{2}):(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/);
        if (!mm) return null;
        const [, Y, Mo, D, H, Mi, S] = mm.map(Number);
        if (!Y || !Mo || !D) return null;
        const d = new Date(Y, Mo - 1, D, H, Mi, S); // EXIF는 시간대가 없어 로컬 시각으로 해석
        return Number.isNaN(d.getTime()) ? null : d.toISOString();
      }
      off += 2 + segLen;
    }
    return null;
  } catch {
    return null; // 파싱 실패는 조용히 무시하고 lastModified로 대체
  }
}

// 촬영일시 결정: EXIF가 있으면 그것, 없으면 파일 수정시각, 그것도 없으면 현재 시각.
async function bestPhotoTime(blob, lastModified) {
  const exif = await readExifDateTime(blob);
  if (exif) return exif;
  return new Date(lastModified || Date.now()).toISOString();
}

// ---------- PWA: 공유 타깃으로 받은 사진 읽어오기 ----------
// 구글 포토 "공유" → 서비스워커가 파일을 Cache에 저장 → /?shared=1 로 이동.
// 여기서 그 파일들을 꺼내 슬라이드쇼 항목(오브젝트 URL)으로 만든다.
async function loadSharedMedia() {
  if (!('caches' in window)) return null;
  const cache = await caches.open('shared-media-v1');
  const metaRes = await cache.match('/shared-media/manifest');
  if (!metaRes) return null;
  const meta = await metaRes.json();
  const items = [];
  for (const m of meta) {
    const res = await cache.match(m.key);
    if (!res) continue;
    const blob = await res.blob();
    const objUrl = URL.createObjectURL(blob);
    const type = m.type === 'video' ? 'video' : 'photo';
    const it = {
      id: m.key,
      type,
      // 사진은 EXIF 촬영일시를 우선한다(동영상은 EXIF가 없어 파일 시각을 쓴다).
      createTime: type === 'video'
        ? new Date(m.lastModified || Date.now()).toISOString()
        : await bestPhotoTime(blob, m.lastModified),
      width: null, height: null,
      fullUrl: objUrl, thumbUrl: objUrl,
    };
    if (type === 'video') it.videoUrl = objUrl;
    items.push(it);
  }
  // 촬영일시 오름차순 — 앱 전반 정렬 규칙과 동일
  items.sort((a, b) => new Date(a.createTime) - new Date(b.createTime));
  return items;
}

// ---------- 관리자 모드 (/?frame=<shareId>) ----------
// 관리자 화면관리에서 "wepic 메인화면 열기"로 진입한다. 그 액자를 관리자 자신의 세션에
// 편입시켜(currentFrameId) 저장된 사진·설정을 그대로 불러오고, 이후 일반 메인화면과 똑같이
// 사진 추가/제외·PIN 변경·"링크변경 반영"으로 이어서 관리할 수 있게 한다(더 이상 읽기 전용 아님).
// 사진 파일은 서버가 PIN으로 보호하며 관리자·소유자만 통과한다.
async function loadFrame(id) {
  const res = await fetch(`/shares/${encodeURIComponent(id)}/photos.json`, {
    cache: 'no-store', credentials: 'same-origin',
  });
  if (res.status === 401) throw new Error('이 액자를 볼 권한이 없습니다. (관리자 계정으로 로그인했는지 확인하세요)');
  if (!res.ok) throw new Error('액자를 찾을 수 없습니다. 링크가 만료되었거나 삭제되었을 수 있습니다.');
  const m = await res.json();
  if (!(m.items || []).length) throw new Error('이 액자에는 사진이 없습니다.');
  return m;
}

async function init() {
  const params = new URLSearchParams(location.search);

  // 0) 관리자가 정한 Default 정보(타이틀·배경음악·폰트/크기)를 가장 먼저 읽어 적용한다.
  //    데모·wepic 메인화면·wepic 공유화면 모두 이 값을 기준으로 시작한다.
  await loadGlobalSettings();

  // 0-1) 관리자 모드: 특정 액자를 wepic 메인화면에서 그대로 이어서 관리
  const frameId = params.get('frame');
  if (frameId) {
    try {
      // 이 액자를 내 세션의 "현재 액자"로 선택한다(관리자면 목록에 없어도 자동 편입).
      // 이후의 사진 추가/제외·PIN 변경·"링크변경 반영"이 전부 이 액자를 대상으로 동작한다.
      await api(`/api/frames/${encodeURIComponent(frameId)}/select`, { method: 'POST' });
      const m = await loadFrame(frameId);
      isFrameMode = true;
      frameManifest = m;
      // 하단 링크(구글 전용 vs 갤러리)와 상단 이름 표시가 로그인 제공자에 맞게 나오도록
      // 여기서도 로그인 상태를 반영한다 — 이 분기는 아래 공통 처리까지 가지 않고 return한다.
      applyLoginState(await api('/api/status').catch(() => ({ loggedIn: false })));
      if (m.musicUrl) document.getElementById('music-url').value = m.musicUrl;
      // 액자에 저장된 동영상은 type/videoUrl을 그대로 살려야 한다 — 그렇지 않으면
      // "링크변경 반영"으로 다시 저장할 때 동영상이 사진으로 바뀌어 사라진다.
      boot((m.items || []).map((it) => ({
        id: it.id,
        type: it.type === 'video' ? 'video' : 'photo',
        createTime: it.createTime,
        width: it.width || null, height: it.height || null,
        fullUrl: it.fullUrl, thumbUrl: it.thumbUrl || it.fullUrl,
        ...(it.videoUrl ? { videoUrl: it.videoUrl } : {}),
      })));
      return;
    } catch (err) {
      alert(err.message);
      history.replaceState(null, '', '/'); // 주소 정리 후 일반 홈으로
    }
  }

  // 1) 구글 포토 "공유"로 들어온 경우: 곧바로 슬라이드쇼
  if (params.has('shared')) {
    history.replaceState(null, '', '/');
    let shared = null;
    try { shared = await loadSharedMedia(); } catch { /* 무시 */ }
    if (shared && shared.length) {
      isSharedMode = true;
      // 실제 로그인한 회원이 공유로 받은 사진을 올릴 수도 있으므로(업로드는 로그인 필요),
      // isLoggedIn을 먼저 정확히 반영해둔다 — boot()의 guest 판정이 이 값을 쓴다.
      const status = await api('/api/status').catch(() => ({ loggedIn: false }));
      applyLoginState(status);
      boot(shared);
      return;
    }
    if (params.get('shared') === 'empty') alert('공유된 사진을 찾지 못했습니다.');
  }

  // 2) 로그인 상태 확인 → 홈의 로그인/사진 패널에 반영 (자동 진입 없음: 항상 홈부터)
  //    이때 액자 선택도 해제해 메인화면이 항상 "새 액자"로 시작하게 한다(이전에 만든
  //    액자를 실수로 덮어쓰지 않도록. 기존 액자를 이어서 쓰려면 목록에서 고르면 된다).
  //    이 호출은 로그인 여부와 무관하게 홈에 들어올 때마다 조용히 시도되므로, 로그인
  //    회원 전용 API(requireMember → 게스트는 401)라도 api()를 쓰지 않는다 — api()는 401을
  //    받으면 곧바로 로그인 패널로 이동시키는데, 그러면 게스트가 홈만 열어도 매번 로그인
  //    화면으로 튕기게 된다. 여기서는 결과가 필요 없으니 그냥 무시한다.
  await fetch('/api/frames/deselect', { method: 'POST', credentials: 'same-origin' }).catch(() => {});
  const status = await api('/api/status').catch(() => ({ loggedIn: false }));
  applyLoginState(status);

  // 3) 로그인 오류(auth_error)가 있으면 로그인 패널에 안내, 아니면 항상 홈(소개)부터
  const code = params.get('auth_error');
  if (code) {
    const el = document.getElementById('login-error');
    el.textContent = AUTH_ERROR_MESSAGES[code] || '로그인 오류: ' + code;
    el.classList.remove('hidden');
    history.replaceState(null, '', '/');
    selectPanel('login');
  } else {
    // 홈 = 전체공유 사진 목록. selectPanel이 showHome()까지 함께 처리하고 목록도 불러온다.
    // (예전에는 showHome()만 불러 소개 패널이 그대로 남아 있었다 — 이제 소개 패널은 없다)
    selectPanel(HOME_PANEL);
  }
}

// PWA 서비스워커 등록 (공유 타깃 수신용). 실패해도 앱 기능에는 영향 없음.
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => navigator.serviceWorker.register('/sw.js').catch(() => {}));
}

init();
