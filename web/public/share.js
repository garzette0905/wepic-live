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

// 로드된 Image를 그대로 넘겨준다(naturalWidth/Height로 화면비를 판단하기 위해).
function preload(url) {
  return new Promise((resolve) => {
    const im = new Image();
    im.onload = () => resolve(im);
    im.onerror = () => resolve(im);
    im.src = url;
  });
}

// ---- 세로 사진 배경 채우기 (가우시안 블러) ----
// 사진 화면비가 화면과 5% 이상 다르면 양옆(또는 위아래)에 검은 여백이 생긴다. 그럴 때만
// 같은 사진을 흐리게 깔아 여백을 메운다(여백이 없는 사진에 불필요한 blur 연산을 하지 않도록).
let lastShownImg = null;
function needsBackdrop(im) {
  if (!im || !im.naturalWidth || !im.naturalHeight) return false;
  const box = document.querySelector('.share-view');
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
// 전체화면 전환·화면 회전으로 화면비가 바뀌면 여백 여부도 달라진다 → 지금 보이는 사진만 다시 판단.
function refreshBackdrop() {
  if (!lastShownImg) return;
  applyBackdrop(activeLayer, lastShownImg, lastShownImg.src);
}
window.addEventListener('resize', refreshBackdrop);

let videoStallTimer = null;

// 동영상 재생을 멈추고 비디오 레이어를 숨긴다(사진으로 돌아갈 때).
function stopVideo() {
  const v = document.getElementById('video-layer');
  v.classList.remove('active');
  v.onended = null;
  v.onerror = null;
  v.oncanplay = null;
  if (videoStallTimer) { clearTimeout(videoStallTimer); videoStallTimer = null; }
  try { v.pause(); v.removeAttribute('src'); v.load(); } catch { /* 무시 */ }
  resumeMusicAfterVideo();
}

// 동영상 항목 재생. 끝나면 다음 항목으로 넘어간다(타이머 대신 재생 종료가 신호).
// 촬영 원본 그대로인 동영상은 메타데이터(moov)가 파일 맨 끝에 있는 경우가 많아,
// 큰 파일일수록 재생 가능해지기까지 시간이 좀 걸린다(끝부분을 한 번 더 받아와야 함).
// 그래서 play()가 한 번 거절됐다고 바로 실패로 보지 않고 canplay가 오면 다시 시도하며,
// 실제로 넘어가는 것은 재생 종료(onended)·진짜 디코딩 실패(onerror)·너무 오래 준비가
// 안 될 때(정체 타임아웃)뿐이다.
function showVideo(p) {
  const v = document.getElementById('video-layer');
  document.getElementById('photo-a').classList.remove('active');
  document.getElementById('photo-b').classList.remove('active');
  if (timer) { clearInterval(timer); timer = null; } // 재생 중에는 자동 전환을 멈춘다
  if (videoStallTimer) { clearTimeout(videoStallTimer); videoStallTimer = null; }
  v.poster = p.fullUrl || '';
  v.src = p.videoUrl;
  v.classList.add('active');
  // 소리는 배경음악 토글(▶)을 따른다: 소리가 켜져 있으면 동영상 소리를 내고 음악을 잠시 멈춘다.
  if (soundOn) { v.muted = false; pauseMusicForVideo(); } else { v.muted = true; }

  let done = false;
  const goNext = (delay) => {
    if (done) return;
    done = true;
    if (videoStallTimer) { clearTimeout(videoStallTimer); videoStallTimer = null; }
    // 이미 다른 항목으로 넘어갔다면 아무것도 하지 않는다.
    setTimeout(() => { if (photos[idx] === p && !slidePaused) advance(); }, delay);
  };
  v.onended = () => goNext(0);
  // 진짜 디코딩 실패(코덱 미지원 등)일 때만 즉시 넘어간다.
  v.onerror = () => goNext(1500);

  let started = false;
  const tryPlay = () => {
    if (started || done) return;
    v.play().then(() => { started = true; if (videoStallTimer) { clearTimeout(videoStallTimer); videoStallTimer = null; } }).catch(() => {
      if (!v.muted) {
        // 소리 있는 자동재생이 브라우저 정책으로 막힌 경우: 음소거로 다시 시도.
        v.muted = true;
        resumeMusicAfterVideo();
        tryPlay();
      }
      // 그 외(아직 메타데이터 준비 전 등)는 실패로 보지 않는다 — canplay가 오면 재시도된다.
    });
  };
  v.oncanplay = tryPlay;
  tryPlay(); // 이미 준비돼 있으면(작은 동영상 등) 곧바로 재생
  // 그래도 너무 오래 멈춰 있으면(정말 재생 불가) 넘어간다.
  videoStallTimer = setTimeout(() => { if (!started) goNext(0); }, 15000);
}

async function show() {
  if (!photos.length) return;
  const p = photos[idx];
  const req = idx;
  if (p.type === 'video' && p.videoUrl) {
    showVideo(p);
    lastShownImg = null;
    clearBackdrops(); // 동영상은 원본 그대로 재생한다(흐린 배경을 깔지 않는다)
    renderCaption();
    updateProgress();
    return;
  }
  stopVideo();
  const nextLayer = activeLayer === 'a' ? 'b' : 'a';
  const next = document.getElementById('photo-' + nextLayer);
  const prev = document.getElementById('photo-' + activeLayer);
  const im = await preload(p.fullUrl);
  if (req !== idx) return;
  next.src = p.fullUrl;
  applyBackdrop(nextLayer, im, p.fullUrl);       // 여백이 생기는 사진이면 흐린 배경을 함께 띄운다
  document.getElementById(`photo-${activeLayer}-bg`).classList.remove('active');
  next.classList.add('active');
  prev.classList.remove('active');
  lastShownImg = im;
  activeLayer = nextLayer;
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

// 사용자가 직접 이전(-1)/다음(+1)으로 넘긴다. 자동 전환 타이머는 처음부터 다시 세어,
// 방금 넘긴 사진이 곧바로 지나가 버리지 않게 한다. (멈춤 상태면 멈춘 채로 한 장만 이동)
function step(delta) {
  if (!photos.length) return;
  idx = (idx + delta + photos.length) % photos.length;
  if (timer) { clearInterval(timer); timer = null; }
  show();
  resetTimer();
}

function resetTimer() {
  if (timer) clearInterval(timer);
  timer = null;
  if (slidePaused) return; // 멈춤 상태면 타이머를 다시 걸지 않는다
  // 동영상은 재생이 끝날 때 넘어간다(타이머로 중간에 끊지 않는다).
  if (isVideoItem(photos[idx])) return;
  timer = setInterval(advance, intervalMs);
}

// ---- 화면 자동 꺼짐 방지 (Screen Wake Lock) ----
// 액자로 세워둔 태블릿·PC가 절전으로 화면을 끄면 사진이 안 보인다 → 사진이 재생되는 동안은
// 화면을 깨워 둔다. 지원하지 않는 브라우저(iOS 사파리 등)나 사용자가 막은 경우에는
// 조용히 넘어가고 기능만 없이 정상 동작한다.
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

// ---- 전체화면 ----
function setFullscreen(on) {
  document.body.classList.toggle('fullscreen', on);
  if (on) document.documentElement.requestFullscreen?.().catch(() => {});
  else if (document.fullscreenElement) document.exitFullscreen?.().catch(() => {});
}
document.getElementById('btn-fullscreen').addEventListener('click', () =>
  setFullscreen(!document.body.classList.contains('fullscreen')));
document.addEventListener('fullscreenchange', () => {
  document.body.classList.toggle('fullscreen', !!document.fullscreenElement);
  refreshBackdrop(); // 화면비가 바뀌므로 흐린 배경이 필요한지 다시 판단
});

// ---- 배경음악 (선택) ----
// 기본은 "무음": 음소거 자동재생으로 곡 제목만 얻어 캡션에 표시하고, ▶ 버튼을 눌러야 소리가 난다.
let ytPlayer = null, ytReady = null, soundOn = false, musicUrl = '', musicTitle = '';
// 유튜브 곡 제목은 매우 길 때가 많아 캡션이 화면을 밀어낸다 → 20자까지만 보여준다.
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
    try {
      musicTitle = shortMusicTitle(ytPlayer?.getVideoData?.()?.title || musicTitle);
      renderCaption();
    } catch {}
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
  // Spotify 미리듣기(<audio>)를 쓰는 중이면 그쪽 음소거를 푼다.
  if (usingPreview()) {
    previewAudio.muted = false;
    try { await previewAudio.play(); } catch { /* 무시 */ }
    soundOn = true;
    updateMusicBtn();
    return;
  }
  if (playerPromise) await playerPromise; // 준비 전 클릭 대비
  if (!ytPlayer) return;
  try { ytPlayer.unMute(); ytPlayer.setVolume(80); ytPlayer.playVideo(); } catch {}
  kickPlay(); // 미시작 상태였다면 재생까지 확실히
  soundOn = true;
  updateMusicBtn();
}
function muteSound() {
  if (usingPreview()) {
    previewAudio.muted = true; // 계속 재생하되 소리만 끈다(YouTube 쪽과 동일한 동작)
    soundOn = false;
    updateMusicBtn();
    return;
  }
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

// ---- Spotify 30초 미리듣기 ----
// 메인화면에서 Spotify로 고른 곡은 musicUrl이 p.scdn.co의 미리듣기 MP3다.
// YouTube 플레이어로는 못 틀기 때문에 <audio>로 반복 재생한다.
// 공유화면 규칙(기본은 무음, ▶를 눌러야 소리)을 그대로 지키려고 muted로 시작한다.
const isSpotifyPreview = (u) => /^https?:\/\/p\.scdn\.co\//i.test(String(u || ''));
let previewAudio = null;
function startPreviewMusic(url, title) {
  try { ytPlayer?.pauseVideo?.(); } catch { /* 무시 */ } // 둘이 동시에 나지 않게
  if (!previewAudio) {
    previewAudio = new Audio();
    previewAudio.loop = true; // 30초뿐이라 반복해야 배경음악 구실을 한다
  }
  previewAudio.src = url;
  previewAudio.muted = !soundOn;
  previewAudio.volume = 0.8;
  previewAudio.play().catch(() => { /* 자동재생 차단 — ▶를 누르면 재생된다 */ });
  musicTitle = shortMusicTitle(title || 'Spotify 미리듣기');
  const b = document.getElementById('btn-music');
  b.style.display = 'flex';
  updateMusicBtn();
  renderCaption();
}
function stopPreviewMusic() {
  if (!previewAudio) return;
  try { previewAudio.pause(); previewAudio.removeAttribute('src'); } catch { /* 무시 */ }
}
// 지금 배경음악이 Spotify 미리듣기인가
const usingPreview = () => !!(previewAudio && previewAudio.src);

// 동영상 소리와 배경음악이 겹치지 않도록, 동영상 재생 중에는 음악을 잠시 멈춘다.
let musicPausedForVideo = false;
function pauseMusicForVideo() {
  if (musicPausedForVideo) return;
  if (usingPreview()) { try { previewAudio.pause(); musicPausedForVideo = true; } catch { /* 무시 */ } return; }
  if (!ytPlayer) return;
  try { ytPlayer.pauseVideo(); musicPausedForVideo = true; } catch { /* 무시 */ }
}
function resumeMusicAfterVideo() {
  if (!musicPausedForVideo) return;
  musicPausedForVideo = false;
  if (usingPreview()) { try { previewAudio.play().catch(() => {}); } catch { /* 무시 */ } return; }
  if (!ytPlayer) return;
  try { ytPlayer.playVideo(); } catch { /* 무시 */ }
}
document.getElementById('btn-music').addEventListener('click', () => (soundOn ? muteSound() : playSound()));

// ---- 홈으로 이동 ----
document.getElementById('btn-home').addEventListener('click', () => {
  try { ytPlayer?.pauseVideo(); } catch {}
  stopPreviewMusic();
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
document.getElementById('btn-prev').addEventListener('click', () => step(-1));
document.getElementById('btn-next').addEventListener('click', () => step(1));

// ---- 매니페스트 적용 (최초 로드 / 변경 반영 공용) ----
let lastUpdatedAt = null;

function applyManifest(data) {
  const view = document.querySelector('.share-view');
  photos = data.items || [];
  lastUpdatedAt = data.updatedAt || null;
  // 볼 사진이 실제로 있는 시점부터 화면이 꺼지지 않게 잡는다(PIN 게이트를 통과한 뒤).
  if (photos.length) setWakeLock(true);

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
    // Spotify 미리듣기(p.scdn.co)면 YouTube 플레이어가 아니라 <audio>로 재생한다.
    // 곡목은 주소에서 알 수 없으므로 매니페스트에 저장된 musicTitle을 쓴다.
    if (isSpotifyPreview(musicUrl)) {
      startPreviewMusic(musicUrl, data.musicTitle || '');
    } else {
      stopPreviewMusic();
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
