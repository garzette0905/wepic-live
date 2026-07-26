// 공유 보기 페이지 (로그인 불필요) — /f/<id> 에서 열리며 /shares/<id>/photos.json 을 읽어 재생.
const shareId = location.pathname.split('/').filter(Boolean).pop();

let photos = [];
let idx = 0;
let activeLayer = 'a';
let timer = null;
let intervalMs = 10000; // 링크 생성 시점의 전환 간격 (없으면 10초)
let slidePaused = false; // 사진 슬라이드 멈춤 여부 (음악 소리 on/off와는 별개)
// 관리자 Default 정보관리 값 (공유 매니페스트에 값이 없을 때 대체로 사용)
let defaultTitle = '';
let defaultMusicUrl = '';
let pollStarted = false;

function formatDate(iso) {
  const d = new Date(iso);
  const date = new Intl.DateTimeFormat('ko-KR', { year: 'numeric', month: 'long', day: 'numeric' }).format(d);
  const time = new Intl.DateTimeFormat('ko-KR', { hour: '2-digit', minute: '2-digit' }).format(d);
  return `${date} · ${time}`;
}

function preload(url) {
  return new Promise((resolve) => { const im = new Image(); im.onload = resolve; im.onerror = resolve; im.src = url; });
}

// 동영상 재생을 멈추고 비디오 레이어를 숨긴다(사진으로 돌아갈 때).
function stopVideo() {
  const v = document.getElementById('video-layer');
  v.classList.remove('active');
  v.onended = null;
  v.onerror = null;
  try { v.pause(); v.removeAttribute('src'); v.load(); } catch { /* 무시 */ }
  resumeMusicAfterVideo();
}

// 동영상 항목 재생. 끝나면 다음 항목으로 넘어간다(타이머 대신 재생 종료가 신호).
// 실패 신호는 error 이벤트와 play() 거부 두 곳에서 올 수 있으므로, 한 항목당 한 번만
// 다음으로 넘어가게 막는다(둘 다 처리하면 두 칸씩 건너뛰어 제자리를 맴돈다).
function showVideo(p) {
  const v = document.getElementById('video-layer');
  document.getElementById('photo-a').classList.remove('active');
  document.getElementById('photo-b').classList.remove('active');
  if (timer) { clearInterval(timer); timer = null; } // 재생 중에는 자동 전환을 멈춘다
  v.poster = p.fullUrl || '';
  v.src = p.videoUrl;
  v.classList.add('active');
  // 소리는 배경음악 토글(▶)을 따른다: 소리가 켜져 있으면 동영상 소리를 내고 음악을 잠시 멈춘다.
  if (soundOn) { v.muted = false; pauseMusicForVideo(); } else { v.muted = true; }

  let done = false;
  const goNext = (delay) => {
    if (done) return;
    done = true;
    // 이미 다른 항목으로 넘어갔다면 아무것도 하지 않는다.
    setTimeout(() => { if (photos[idx] === p && !slidePaused) advance(); }, delay);
  };
  v.onended = () => goNext(0);
  // 코덱 미지원 등으로 재생이 안 되면 멈추지 않고 다음으로 넘어간다.
  v.onerror = () => goNext(1500);
  v.play().catch(() => {
    // 소리 있는 자동재생이 막히면 음소거로 다시 시도한다(브라우저 정책).
    v.muted = true;
    resumeMusicAfterVideo();
    v.play().catch(() => goNext(1500));
  });
}

async function show() {
  if (!photos.length) return;
  const p = photos[idx];
  const req = idx;
  if (p.type === 'video' && p.videoUrl) {
    showVideo(p);
    renderCaption();
    updateProgress();
    return;
  }
  stopVideo();
  const next = document.getElementById(activeLayer === 'a' ? 'photo-b' : 'photo-a');
  const prev = document.getElementById(activeLayer === 'a' ? 'photo-a' : 'photo-b');
  await preload(p.fullUrl);
  if (req !== idx) return;
  next.src = p.fullUrl;
  next.classList.add('active');
  prev.classList.remove('active');
  activeLayer = activeLayer === 'a' ? 'b' : 'a';
  renderCaption();
  updateProgress();
  // 동영상 다음에 온 사진이면 멈춰 있던 자동 전환 타이머를 다시 걸어준다.
  if (!timer) resetTimer();
}

// 캡션: 우측 하단에 날짜(시계 자리) + 그 아래 곡목(♪). 소리 여부와 무관하게 곡목을 표시한다.
function renderCaption() {
  const p = photos[idx];
  const el = document.getElementById('share-caption');
  el.textContent = '';
  const lines = [];
  if (p) lines.push(formatDate(p.createTime));
  if (musicTitle) lines.push('♪ ' + musicTitle);
  lines.forEach((ln, i) => {
    if (i > 0) el.appendChild(document.createElement('br'));
    el.appendChild(document.createTextNode(ln));
  });
}

// 하단 진행바: 현재 사진이 전체에서 몇 번째인지 (희미한 참고용)
function updateProgress() {
  const fill = document.getElementById('progress-strip-fill');
  if (!fill) return;
  fill.style.width = (photos.length ? ((idx + 1) / photos.length) * 100 : 0) + '%';
}

const isVideoItem = (p) => !!(p && p.type === 'video' && p.videoUrl);

function advance() { if (photos.length) { idx = (idx + 1) % photos.length; show(); } }
function resetTimer() {
  if (timer) clearInterval(timer);
  timer = null;
  if (slidePaused) return; // 멈춤 상태면 타이머를 다시 걸지 않는다
  // 동영상은 재생이 끝날 때 넘어간다(타이머로 중간에 끊지 않는다).
  if (isVideoItem(photos[idx])) return;
  timer = setInterval(advance, intervalMs);
}

// ---- 전체화면 ----
function setFullscreen(on) {
  document.body.classList.toggle('fullscreen', on);
  if (on) document.documentElement.requestFullscreen?.().catch(() => {});
  else if (document.fullscreenElement) document.exitFullscreen?.().catch(() => {});
}
document.getElementById('btn-fullscreen').addEventListener('click', () =>
  setFullscreen(!document.body.classList.contains('fullscreen')));
document.addEventListener('fullscreenchange', () =>
  document.body.classList.toggle('fullscreen', !!document.fullscreenElement));

// ---- 배경음악 (선택) ----
// 기본은 "무음": 음소거 자동재생으로 곡 제목만 얻어 캡션에 표시하고, ▶ 버튼을 눌러야 소리가 난다.
let ytPlayer = null, ytReady = null, soundOn = false, musicUrl = '', musicTitle = '';
function loadYouTubeApi() {
  if (ytReady) return ytReady;
  ytReady = new Promise((resolve) => {
    if (window.YT && window.YT.Player) return resolve();
    window.onYouTubeIframeAPIReady = resolve;
    const t = document.createElement('script'); t.src = 'https://www.youtube.com/iframe_api';
    document.head.appendChild(t);
  });
  return ytReady;
}
function ytId(url) {
  const pats = [/youtu\.be\/([\w-]{11})/, /youtube\.com\/watch\?v=([\w-]{11})/, /youtube\.com\/embed\/([\w-]{11})/, /youtube\.com\/shorts\/([\w-]{11})/];
  for (const re of pats) { const m = url.match(re); if (m) return m[1]; }
  return null;
}
// 플레이어는 페이지당 딱 한 번만 만든다. (같은 요소에 두 번 new YT.Player를 하면 두 번째
// 객체는 API 메서드가 없는 깨진 객체가 되어 재생·곡목·곡교체가 전부 실패한다.)
let playerPromise = null; // 생성 1회 보장 + 준비 완료 대기용

function ensurePlayer(videoId) {
  if (playerPromise) return playerPromise;
  playerPromise = (async () => {
    await loadYouTubeApi();
    await new Promise((resolve) => {
      ytPlayer = new YT.Player('yt-player', {
        videoId,
        playerVars: { autoplay: 1, mute: 1, loop: 1, playlist: videoId, controls: 0 },
        events: {
          onReady: (e) => { try { e.target.mute(); e.target.playVideo(); } catch {} resolve(); kickPlay(); },
          // 재생 불가(퍼가기 금지·삭제된 영상 등)면 곡목 안내를 지운다
          onError: () => { musicTitle = ''; renderCaption(); },
        },
      });
    });
  })();
  return playerPromise;
}

// 제목 읽기 (소리와 무관). 메타데이터 로딩 지연 대비 두 번 시도.
function readMusicTitleSoon() {
  const readTitle = () => {
    try { musicTitle = ytPlayer?.getVideoData?.()?.title || musicTitle; renderCaption(); } catch {}
  };
  setTimeout(readTitle, 900);
  setTimeout(readTitle, 2500);
}

// 무음으로 재생을 시작해 곡 제목만 확보한다(소리는 ▶ 버튼으로). 여러 번 호출해도 안전.
async function initMusic() {
  const id = musicUrl ? ytId(musicUrl) : null;
  const btn = document.getElementById('btn-music');
  if (!id) { btn.style.display = 'none'; return; }
  await ensurePlayer(id);
  readMusicTitleSoon();
  btn.style.display = 'flex';
  updateMusicBtn();
}

// loadVideoById 직후의 playVideo()는 아직 로딩 중이라 무시될 수 있다(미시작 -1 상태로 멈춤).
// 재생/버퍼링 상태가 될 때까지 몇 번 더 눌러준다.
function kickPlay(attempts = 8) {
  let n = 0;
  const tick = () => {
    if (!ytPlayer) return;
    let st;
    try { st = ytPlayer.getPlayerState(); } catch { return; }
    if (st === 1 || st === 3) return; // 1=재생중, 3=버퍼링 → 성공
    try { ytPlayer.playVideo(); } catch {}
    if (++n < attempts) setTimeout(tick, 700);
  };
  setTimeout(tick, 250);
}

// 곡 교체 (플레이어가 아직 준비 중이면 준비된 뒤에 적용)
async function changeMusic(id) {
  await ensurePlayer(id); // 아직 없으면 이 곡으로 생성됨
  try {
    if (ytPlayer.getVideoData?.()?.video_id !== id) ytPlayer.loadVideoById(id);
    if (soundOn) { ytPlayer.unMute(); ytPlayer.setVolume(80); } else { ytPlayer.mute(); }
  } catch {}
  kickPlay();
  musicTitle = '';
  readMusicTitleSoon();
  document.getElementById('btn-music').style.display = 'flex';
  updateMusicBtn();
}

async function playSound() {
  if (playerPromise) await playerPromise; // 준비 전 클릭 대비
  if (!ytPlayer) return;
  try { ytPlayer.unMute(); ytPlayer.setVolume(80); ytPlayer.playVideo(); } catch {}
  kickPlay(); // 미시작 상태였다면 재생까지 확실히
  soundOn = true;
  updateMusicBtn();
}
function muteSound() {
  if (!ytPlayer) return;
  try { ytPlayer.mute(); } catch {} // 계속 무음으로 재생(곡목 유지), 소리만 끔
  soundOn = false;
  updateMusicBtn();
}
function updateMusicBtn() {
  const b = document.getElementById('btn-music');
  b.classList.toggle('playing', soundOn); // ▷(무음) ↔ ⏸(소리 켜짐)
  b.style.opacity = soundOn ? '1' : '0.7';
  b.title = soundOn ? '소리 끄기' : '소리 켜기';
}

// 동영상 소리와 배경음악이 겹치지 않도록, 동영상 재생 중에는 음악을 잠시 멈춘다.
let musicPausedForVideo = false;
function pauseMusicForVideo() {
  if (!ytPlayer || musicPausedForVideo) return;
  try { ytPlayer.pauseVideo(); musicPausedForVideo = true; } catch { /* 무시 */ }
}
function resumeMusicAfterVideo() {
  if (!ytPlayer || !musicPausedForVideo) return;
  musicPausedForVideo = false;
  try { ytPlayer.playVideo(); } catch { /* 무시 */ }
}
document.getElementById('btn-music').addEventListener('click', () => (soundOn ? muteSound() : playSound()));

// ---- 홈으로 이동 ----
document.getElementById('btn-home').addEventListener('click', () => {
  try { ytPlayer?.pauseVideo(); } catch {}
  location.href = '/';
});

// ---- 다운로드 (이 사진만 / 전체) ----
let toastHandle = null;
function showToast(msg) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.classList.remove('hidden');
  if (toastHandle) clearTimeout(toastHandle);
  toastHandle = setTimeout(() => el.classList.add('hidden'), 2500);
}
// 서버가 ?dl=<파일명>에 Content-Disposition: attachment 를 붙여주므로, blob을 만들지 않고
// "실제 URL"을 가리키는 <a>만 클릭한다. blob: URL은 카카오톡 등 인앱 브라우저(WebView)의
// 다운로드 매니저가 받아올 수 없어 저장이 실패한다.
function dlName(p, i) {
  const d = new Date(p.createTime);
  const stamp = Number.isNaN(d.getTime())
    ? String(i + 1).padStart(3, '0')
    : `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}_${String(d.getHours()).padStart(2, '0')}${String(d.getMinutes()).padStart(2, '0')}`;
  // 동영상은 원본(mp4)을, 사진은 표시 중인 이미지를 저장한다.
  const src = isVideoItem(p) ? p.videoUrl : p.fullUrl;
  const ext = isVideoItem(p) ? 'mp4' : (/\.png($|\?)/i.test(p.fullUrl) ? 'png' : 'jpg');
  return { filename: `wepic_${String(i + 1).padStart(3, '0')}_${stamp}.${ext}`, src };
}
function downloadPhoto(p, i) {
  const { filename, src } = dlName(p, i);
  const sep = src.includes('?') ? '&' : '?';
  const a = document.createElement('a');
  a.href = `${src}${sep}dl=${encodeURIComponent(filename)}`;
  a.download = filename; // PC 브라우저용 힌트(실제 강제는 서버 헤더가 담당)
  document.body.appendChild(a);
  a.click();
  a.remove();
}

document.getElementById('btn-download').addEventListener('click', () => {
  const p = photos[idx];
  if (!p) { showToast('저장할 사진이 없습니다.'); return; }
  downloadPhoto(p, idx);
  showToast('저장을 시작했습니다.');
});

// ---- 사진 슬라이드 멈춤/재개 (음악 토글과 별개) ----
function updateSlideBtn() {
  const b = document.getElementById('btn-slide');
  b.classList.toggle('paused', slidePaused);
  b.title = slidePaused ? '사진 슬라이드 재개' : '사진 슬라이드 멈춤';
  b.style.opacity = slidePaused ? '1' : '0.7';
}
function setSlidePaused(paused) {
  slidePaused = paused;
  const v = document.getElementById('video-layer');
  if (paused) {
    if (timer) clearInterval(timer);
    timer = null;
    if (isVideoItem(photos[idx])) { try { v.pause(); } catch { /* 무시 */ } }
  } else {
    if (isVideoItem(photos[idx])) { v.play().catch(() => {}); }
    resetTimer();
  }
  updateSlideBtn();
}
document.getElementById('btn-slide').addEventListener('click', () => setSlidePaused(!slidePaused));

// ---- 매니페스트 적용 (최초 로드 / 변경 반영 공용) ----
let lastUpdatedAt = null;

function applyManifest(data) {
  const view = document.querySelector('.share-view');
  photos = data.items || [];
  lastUpdatedAt = data.updatedAt || null;

  // 제목 (공유에 제목이 없으면 관리자 Default 타이틀을 쓴다)
  const t = document.getElementById('share-title');
  const title = (data.title || defaultTitle || '').trim();
  t.textContent = title;
  t.classList.toggle('hidden', !title);

  // 전환 효과 · 간격
  const effect = ['fade', 'slide', 'kenburns'].includes(data.effect) ? data.effect : 'fade';
  view.classList.remove('fx-fade', 'fx-slide', 'fx-kenburns');
  view.classList.add('fx-' + effect);
  const sec = Math.min(60, Math.max(3, Number(data.intervalSec) || 10));
  intervalMs = sec * 1000;
  view.style.setProperty('--kb-duration', sec + 's');

  // 배경음악: 곡이 바뀌면 새 곡으로 교체(무음/소리 상태는 유지).
  // 공유에 음악이 없으면 관리자 Default 배경음악을 쓴다.
  const newMusic = data.musicUrl || defaultMusicUrl || '';
  if (newMusic !== musicUrl) {
    musicUrl = newMusic;
    const newId = musicUrl ? ytId(musicUrl) : null;
    if (!newId) {
      // 음악이 제거된 경우: 정지하고 버튼·곡목 숨김
      try { ytPlayer?.pauseVideo?.(); } catch {}
      musicTitle = '';
      document.getElementById('btn-music').style.display = 'none';
      renderCaption();
    } else {
      changeMusic(newId); // 최초 생성/곡 교체 모두 여기서 처리(중복 생성 없음)
    }
  }
}

// ---- 변경 감지: 공유자가 "링크변경 반영"을 누르면 여기서 자동으로 최신본으로 갈아끼운다 ----
const POLL_MS = 20000;
async function pollForUpdates() {
  try {
    const res = await fetch(`/shares/${shareId}/photos.json`, { cache: 'no-store' });
    if (!res.ok) return;
    const data = await res.json();
    if (!data.items || !data.items.length) return;
    if (data.updatedAt && data.updatedAt === lastUpdatedAt) return; // 변경 없음
    const keepId = photos[idx]?.id;
    applyManifest(data);
    // 보고 있던 사진이 그대로 있으면 그 자리를 유지, 없으면 처음부터
    const found = photos.findIndex((p) => p.id === keepId);
    idx = found >= 0 ? found : 0;
    await show();
    resetTimer();
  } catch { /* 네트워크 순단 무시 */ }
}

// ---- PIN 입력 게이트 ----
// PIN이 걸린 공유는 서버가 photos.json과 사진 파일까지 막는다(401 pinRequired).
// 맞는 PIN을 넣으면 서버가 열람 쿠키를 주고, 그 뒤부터 정상 재생된다.
function showPinGate(message) {
  document.getElementById('share-loading').classList.add('hidden');
  const gate = document.getElementById('pin-gate');
  gate.classList.remove('hidden');
  const err = document.getElementById('pin-error');
  if (message) { err.textContent = message; err.classList.remove('hidden'); }
  else err.classList.add('hidden');
  const input = document.getElementById('pin-entry');
  input.focus();
  input.select();
}

async function submitPin() {
  const input = document.getElementById('pin-entry');
  const pin = input.value.trim();
  const err = document.getElementById('pin-error');
  if (!/^\d{4}$/.test(pin)) {
    err.textContent = '4자리 숫자를 입력하세요.';
    err.classList.remove('hidden');
    return;
  }
  const btn = document.getElementById('pin-submit');
  btn.disabled = true;
  try {
    const res = await fetch(`/api/share/${shareId}/verify-pin`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pin }), credentials: 'same-origin',
    });
    if (!res.ok) {
      const msg = await res.json().then((d) => d.error).catch(() => '');
      err.textContent = msg || 'PIN 번호가 올바르지 않습니다.';
      err.classList.remove('hidden');
      input.select();
      return;
    }
    document.getElementById('pin-gate').classList.add('hidden');
    await start(); // 통과 → 재생 시작
  } catch {
    err.textContent = '확인 중 오류가 났습니다. 다시 시도해주세요.';
    err.classList.remove('hidden');
  } finally {
    btn.disabled = false;
  }
}
document.getElementById('pin-submit').addEventListener('click', submitPin);
document.getElementById('pin-entry').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') submitPin();
});

// ---- 초기화 ----
// 재생 시작(PIN 통과 후 또는 PIN이 없는 공유). 실패 사유에 따라 PIN 게이트/에러를 띄운다.
async function start() {
  try {
    const res = await fetch(`/shares/${shareId}/photos.json`, { cache: 'no-store', credentials: 'same-origin' });
    if (res.status === 401) { showPinGate(); return false; } // PIN 필요
    if (!res.ok) throw new Error();
    const data = await res.json();
    if (!(data.items || []).length) throw new Error();
    applyManifest(data);
  } catch {
    document.getElementById('share-loading').classList.add('hidden');
    const e = document.getElementById('share-error');
    e.textContent = '공유 사진을 찾을 수 없습니다. 링크가 만료되었거나 삭제되었을 수 있습니다.';
    e.classList.remove('hidden');
    return false;
  }

  document.getElementById('share-loading').classList.add('hidden');
  idx = 0;
  await show();
  resetTimer();
  updateSlideBtn(); // 슬라이드 멈춤/재개 버튼 초기 상태(재생 중 = ⏸ 표시)

  // 음악은 위 applyManifest에서 이미 무음 재생으로 시작됨(중복 생성 방지). 여기서는
  // 혹시 누락된 경우만 보정한다(initMusic은 여러 번 호출해도 안전).
  if (musicUrl && !playerPromise) initMusic();
  // 변경 감지 폴링은 재생이 시작된 뒤 한 번만 걸어둔다(PIN 통과 전에는 돌지 않음).
  if (!pollStarted) { pollStarted = true; setInterval(pollForUpdates, POLL_MS); }
  return true;
}

async function init() {
  // 관리자가 정한 Default 정보(타이틀 폰트·크기)를 먼저 적용한다.
  try {
    const s = await fetch('/api/settings').then((r) => r.json());
    const b = document.body;
    b.classList.add('tf-' + (s.titleFont || 'cursive'));
    b.classList.add('ts-' + (s.titleSize || 'medium'));
    defaultTitle = s.title || '';
    defaultMusicUrl = s.musicUrl || '';
  } catch { /* 실패해도 기본값으로 진행 */ }

  await start(); // 폴링은 start() 안에서 재생 시작 후 설정된다
}
init();
