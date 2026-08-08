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
// ---- 조작 아이콘 줄이 잘리지 않게 맞추기 ----
// 아이콘이 11개(전체화면·빈화면·홈·음악·이전·재생·다음·확대·축소·좋아요·댓글)라
// 폭이 좁은 기기에서는 줄이 화면 밖으로 밀려 **마지막 아이콘(댓글)이 잘려** 보였다.
// CSS에서 크기·간격을 먼저 줄이지만(share.html의 max-width:600px), 320px대 화면이나
// 좋아요 숫자가 세 자리가 되면 그것만으로는 모자란다 → 모자란 만큼만 줄 전체를 축소한다.
// 폭이 달라지는 순간(회전·전체화면·음악 버튼 등장·숫자 변화)마다 다시 재야 한다.
function fitActionRow() {
  const row = document.querySelector('.share-actions');
  if (!row) return;
  const left = row.getBoundingClientRect().left;   // 화면 폭에 따라 12~16px
  const avail = window.innerWidth - left * 2;      // 오른쪽에도 같은 여백을 남긴다
  const need = row.scrollWidth;                    // transform은 배치 폭을 바꾸지 않는다
  const k = (need > avail && need > 0) ? Math.max(0.55, avail / need) : 1;
  row.style.setProperty('--fit', String(Math.round(k * 1000) / 1000));
}

// 전체화면 전환·화면 회전으로 화면비가 바뀌면 여백 여부도 달라진다 → 지금 보이는 사진만 다시 판단.
function refreshBackdrop() {
  if (!lastShownImg) return;
  applyBackdrop(activeLayer, lastShownImg, lastShownImg.src);
}
window.addEventListener('resize', refreshBackdrop);
// 가로/세로 회전은 resize보다 늦게 폭이 확정되는 기기가 있어 한 박자 뒤에 한 번 더 잰다.
window.addEventListener('resize', fitActionRow);
window.addEventListener('orientationchange', () => setTimeout(fitActionRow, 250));

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
  // 그냥 조용히 지나가면 "왜 이 동영상만 안 나오지?"가 되므로 이유를 알려준다.
  v.onerror = () => { showVideoFormatError(); goNext(1500); };

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
  videoStallTimer = setTimeout(() => {
    if (!started) { showVideoFormatError(); goNext(0); }
  }, 15000);
}

// 재생 실패 안내. 같은 동영상에서 여러 신호(onerror + 정체 타임아웃)가 겹쳐 들어오므로
// 항목당 한 번만 띄운다. 동영상은 이제 그대로 올릴 수 있고(사진 추가에서 막지 않는다),
// 브라우저가 못 트는 코덱일 때만 이렇게 이유를 알려준다.
let videoErrorShownFor = null;
function showVideoFormatError() {
  const p = photos[idx];
  const key = p ? (p.videoUrl || p.id || idx) : idx;
  if (videoErrorShownFor === key) return;
  videoErrorShownFor = key;
  showToast('이 동영상은 포맷(코덱)이 맞지 않아 재생할 수 없습니다. 다음 사진으로 넘어갑니다.');
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
  // 켄번즈: 이 레이어에 새 애니메이션을 처음부터 다시 건다. 지금 보이는(나가는) 레이어의
  // .kb-run은 **그대로 둔다** — 벗기면 확대돼 있던 사진이 원래 크기로 툭 되돌아가며 사라진다.
  next.classList.remove('kb-run');
  void next.offsetWidth;              // 리플로우 강제 — 안 하면 애니메이션이 재시작되지 않는다
  next.classList.add('kb-run');
  applyBackdrop(nextLayer, im, p.fullUrl);       // 여백이 생기는 사진이면 흐린 배경을 함께 띄운다
  document.getElementById(`photo-${activeLayer}-bg`).classList.remove('active');
  next.classList.add('active');
  prev.classList.remove('active');
  lastShownImg = im;
  activeLayer = nextLayer;
  renderCaption();
  renderCounter();
  updateProgress();
  // 동영상 다음에 온 사진이면 멈춰 있던 자동 전환 타이머를 다시 걸어준다.
  if (!timer) resetTimer();
}

// ---- 시작 화면(스플래시) ----
// 링크를 눌러 들어온 직후에는 원본 사진(수 MB)이 아직 안 받아져 화면이 새까맣게 비어 있었다.
// 그 사이에 wepic 로고를 띄우고, 뒤에는 이 wepic의 **첫 사진 썸네일**(수십 KB라 곧바로
// 받아진다)을 크게 흐려 깔아 둔다 → 빈 화면 대신 곧 나올 사진이 어렴풋이 비친다.
function showSplashPhoto(p) {
  const el = document.getElementById('splash-photo');
  if (!el || !p) return;
  const url = p.thumbUrl || p.fullUrl;
  if (!url) return;
  el.onload = () => el.classList.add('show');
  el.src = url;
}
function setSplashMessage(msg) {
  const el = document.getElementById('splash-msg');
  if (el) el.textContent = msg;
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

// 제목 아래 사진 번호("3 / 10") — 지금 몇 번째 사진을 보고 있는지 바로 알 수 있게.
function renderCounter() {
  const el = document.getElementById('share-counter');
  if (!el) return;
  const show = photos.length > 1;   // 한 장뿐이면 "1 / 1"은 의미가 없다
  el.textContent = show ? `${idx + 1} / ${photos.length}` : '';
  el.classList.toggle('hidden', !show);
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
  if (zoomScale > 1) resetZoom();   // 다른 사진으로 넘어가면 확대는 원래대로
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

// ---- 시계 · 날씨 위젯 (우측 상단) ----
// 메인화면(app.js)과 같은 동작을 공유화면에도 둔다 — 예전에는 메인화면에만 있어서
// "메인에서는 보이는데 공유 링크에서는 안 보인다"는 차이가 있었다.
// 켤지 말지는 보는 사람의 설정이 아니라 **만든 사람이 저장한 값**(매니페스트 ambient)을 따른다.
// 날씨는 보는 사람의 위치 기준이다(액자가 놓인 곳의 날씨가 의미 있으므로).
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
  } catch { /* 날씨는 있으면 좋은 것 — 실패하면 시계만 보인다 */ }
}

// 위치 권한은 최초 1회만 묻는다. 거부하거나 지원하지 않으면 시계만 표시된다.
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
  if (on) { startClock(); initWeatherOnce(); }
  else { stopClock(); }
}

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
// ⚠️ 이 함수는 **YouTube 배경음악 전용**이다. "음악찾기"로 고른 30초 미리듣기는
//    startPreviewMusic()이 <audio>로 따로 재생하므로 여기서 건드리면 안 된다 —
//    예전에는 미리듣기일 때도 이 함수가 불려 ytId()가 null이라며 **음표 버튼을 숨겨버렸다**
//    (그래서 음악찾기로 만든 wepic에서는 음악 아이콘이 아예 사라졌다).
async function initMusic() {
  const id = musicUrl ? ytId(musicUrl) : null;
  const btn = document.getElementById('btn-music');
  if (!id) {
    // 미리듣기가 이미 재생 중이면 그 버튼을 살려둔다(내가 숨길 대상이 아니다).
    if (!usingPreview()) btn.style.display = 'none';
    return;
  }
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
  fitActionRow();   // 음악 아이콘이 하나 늘어 줄이 길어졌다
}

async function playSound() {
  // 미리듣기(<audio>)를 쓰는 중이면 그쪽 음소거를 푼다.
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

// ---- 30초 미리듣기 배경음악 ----
// 메인화면의 "음악찾기"로 고른 곡은 musicUrl이 30초 미리듣기 오디오 주소다.
// YouTube 플레이어로는 못 틀기 때문에 <audio>로 반복 재생한다.
// 공유화면 규칙(기본은 무음, ▶를 눌러야 소리)을 그대로 지키려고 muted로 시작한다.
// scdn.co는 예전에 Spotify로 만들어 둔 wepic이 계속 재생되도록 남겨둔 것이다.
const PREVIEW_HOSTS = /^https?:\/\/([\w-]+\.)*(mzstatic\.com|itunes\.apple\.com|scdn\.co)\//i;
const isPreviewUrl = (u) => PREVIEW_HOSTS.test(String(u || ''));
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
  musicTitle = shortMusicTitle(title || '미리듣기');
  const b = document.getElementById('btn-music');
  b.style.display = 'flex';
  updateMusicBtn();
  renderCaption();
}
function stopPreviewMusic() {
  if (!previewAudio) return;
  try { previewAudio.pause(); previewAudio.removeAttribute('src'); } catch { /* 무시 */ }
}
// 지금 배경음악이 미리듣기 오디오인가
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

// ---- 이 화면이 실제로 보이고 있을 때만 소리가 나게 (떠도는 배경음악 방지) ----
// 창·탭을 닫거나 다른 앱으로 넘어간 뒤에도 배경음악만 계속 흐르는 경우가 있었다.
// 그때는 이 화면이 없으니 **끌 방법조차 없다.** 그래서 화면이 살아 있는지를 직접 확인해서
// 보이지 않으면 멈추고, 돌아오면 원래 상태로 되돌린다.
//
// 세 가지를 모두 듣는다 — 하나만으로는 새는 경우가 있다:
//  · visibilitychange … 다른 탭·앱으로 전환 (되돌아올 수 있으므로 "일시정지")
//  · pagehide ………… 탭·창을 닫거나 다른 주소로 이동 (iOS 사파리는 unload가 안 온다)
//  · freeze …………… 브라우저가 백그라운드 탭을 얼릴 때 (Page Lifecycle)
let mediaHeldForHidden = false;   // 화면이 가려져서 우리가 멈춰 둔 상태인가
function suspendMediaWhileHidden() {
  if (mediaHeldForHidden) return;
  mediaHeldForHidden = true;
  try { document.getElementById('video-layer')?.pause(); } catch { /* 무시 */ }
  if (usingPreview()) { try { previewAudio.pause(); } catch { /* 무시 */ } return; }
  try { ytPlayer?.pauseVideo?.(); } catch { /* 무시 */ }
}
function resumeMediaWhenVisible() {
  if (!mediaHeldForHidden) return;
  mediaHeldForHidden = false;
  // 동영상은 화면이 그 항목을 보여주고 있을 때만 되살린다(사진으로 넘어갔으면 그냥 둔다).
  if (isVideoItem(photos[idx])) {
    try { document.getElementById('video-layer')?.play?.().catch(() => {}); } catch { /* 무시 */ }
  }
  if (musicPausedForVideo) return; // 동영상 때문에 멈춘 것은 그쪽 로직이 되살린다
  if (usingPreview()) { try { previewAudio.play().catch(() => {}); } catch { /* 무시 */ } return; }
  try { ytPlayer?.playVideo?.(); } catch { /* 무시 */ }
}
// 화면을 아주 떠날 때는 되살릴 일이 없으므로 완전히 끊는다(유튜브 iframe까지 없앤다).
function stopAllMediaForGoodbye() {
  try { const v = document.getElementById('video-layer'); v?.pause(); v?.removeAttribute('src'); } catch { /* 무시 */ }
  stopPreviewMusic();
  try { ytPlayer?.stopVideo?.(); } catch { /* 무시 */ }
  try { ytPlayer?.destroy?.(); } catch { /* 무시 */ }
  ytPlayer = null;
  playerPromise = null; // 다시 만들 수 있게 (destroy 뒤 옛 약속이 남아 있으면 영영 못 만든다)
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') suspendMediaWhileHidden();
  else resumeMediaWhenVisible();
});
// ⚠️ pagehide는 **뒤로가기 캐시(bfcache)로 들어갈 때도** 온다. 그때 플레이어를 없애면
//    뒤로가기로 돌아왔을 때 음악이 영영 살아나지 않는다 → 되돌아올 수 있는 경우(persisted)는
//    멈추기만 하고, 정말 떠나는 경우에만 끊는다.
window.addEventListener('pagehide', (e) => {
  if (e.persisted) suspendMediaWhileHidden();
  else stopAllMediaForGoodbye();
});
window.addEventListener('pageshow', (e) => { if (e.persisted) resumeMediaWhenVisible(); });
// 브라우저가 백그라운드 탭을 얼렸다 녹이는 경우(Page Lifecycle) — 되살아날 수 있으므로 멈추기만.
window.addEventListener('freeze', suspendMediaWhileHidden);
window.addEventListener('resume', resumeMediaWhenVisible);

// ---- 홈으로 이동 ----
// 홈페이지의 "사진 보기" 안에 iframe으로 끼워져 열린 경우에는 이미 홈페이지 위에 있는
// 셈이라 "홈으로"가 의미가 없다(눌러도 iframe 안에 홈페이지가 또 열릴 뿐). → 그때는 숨긴다.
const embeddedInHome = window.top !== window.self;
if (embeddedInHome) {
  document.getElementById('btn-home').style.display = 'none';
} else {
  document.getElementById('btn-home').addEventListener('click', () => {
    try { ytPlayer?.pauseVideo(); } catch {}
    stopPreviewMusic();
    location.href = '/';
  });
}

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
document.getElementById('btn-slide').addEventListener('click', () => {
  const next = !slidePaused;
  // 사용자가 직접 ▶로 재개하면 "줌 조작 중 10초 멈춤"도 끝난 것으로 보고 확대를 푼다.
  if (!next && zoomHoldTimer) {
    clearTimeout(zoomHoldTimer);
    zoomHoldTimer = null;
    zoomPausedByUs = false;
    resetZoom();
  }
  setSlidePaused(next);
});
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
  // 제목이 있으면 사진 번호를 제목 **아래**로 내린다(.title-counter의 위치 계산에 쓰인다)
  document.body.classList.toggle('has-title', !!title);

  // 전환 효과 · 간격
  const effect = ['fade', 'slide', 'kenburns'].includes(data.effect) ? data.effect : 'fade';
  view.classList.remove('fx-fade', 'fx-slide', 'fx-kenburns');
  view.classList.add('fx-' + effect);
  const sec = Math.min(60, Math.max(3, Number(data.intervalSec) || 10));
  intervalMs = sec * 1000;
  view.style.setProperty('--kb-duration', sec + 's');

  // 시계·날씨 — 만든 사람이 켜 둔 값이 매니페스트로 함께 온다.
  // 이 값이 없는 예전 wepic은 켜진 것으로 본다(메인화면 기본값과 같게).
  applyAmbient(data.ambient !== false);

  // 배경음악: 곡이 바뀌면 새 곡으로 교체(무음/소리 상태는 유지).
  // 공유에 음악이 없으면 관리자 Default 배경음악을 쓴다.
  const newMusic = data.musicUrl || defaultMusicUrl || '';
  if (newMusic !== musicUrl) {
    musicUrl = newMusic;
    // 미리듣기 주소면 YouTube 플레이어가 아니라 <audio>로 재생한다.
    // 곡목은 주소에서 알 수 없으므로 매니페스트에 저장된 musicTitle을 쓴다.
    if (isPreviewUrl(musicUrl)) {
      startPreviewMusic(musicUrl, data.musicTitle || '');
    } else {
      stopPreviewMusic();
      const newId = musicUrl ? ytId(musicUrl) : null;
      if (!newId) {
        // 음악이 제거된 경우: 정지하고 버튼·곡목 숨김
        try { ytPlayer?.pauseVideo?.(); } catch {}
        musicTitle = '';
        document.getElementById('btn-music').style.display = 'none';
        fitActionRow();
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

// ---- 실시간 댓글 + 좋아요 ----
// 사진을 보는 중에도 좌측 패널에서 읽고 바로 쓸 수 있다. 로그인하지 않아도 쓸 수 있고,
// 그때는 서버가 브라우저 쿠키에서 "색깔 동물" 별명을 만들어 붙여준다.
//
// "동시에 모두 본다"는 **짧은 주기 폴링**으로 구현했다. 진짜 푸시(WebSocket)는 Cloudflare에서
// Durable Objects가 필요해 지금 구성(KV·D1·R2)보다 무거워지므로, 패널을 열어둔 동안 3초마다
// **새로 달린 것만**(after=마지막 id) 받아온다 — 체감상 거의 실시간이고 트래픽도 적다.
const CMT_POLL_OPEN = 3000;    // 댓글창을 열어둔 동안
// 닫아둔 동안에도 5초로 당겼다 — 같이 보는 사람의 댓글·좋아요를 **팝업으로 알려주기** 때문에
// 예전의 20초로는 "잠깐 떠올랐다 사라지는" 느낌이 나지 않았다.
const CMT_POLL_IDLE = 5000;
let lastCommentId = 0;
let commentsOpen = false;
let commentTimer = null;
let likeCount = 0;
let likedByMe = false;
let commentTotal = 0;
// 내가 방금 쓴 댓글 id — 폴링이 같은 글을 되돌려줄 때 나에게는 팝업을 띄우지 않기 위해 기억한다.
const myCommentIds = new Set();

const cmtListEl = () => document.getElementById('comment-list');

// ---------- 잠깐 떠올랐다 사라지는 알림 팝업 ----------
// 같이 보는 사람이 남긴 댓글·좋아요, 그리고 새 접속을 알린다.
// 사라지는 시간은 CSS 애니메이션과 맞춰야 하므로 --pop-life 변수로 함께 넘긴다.
const LIVE_POP_MS = 4200;
const LIVE_POP_MAX = 4;          // 한꺼번에 너무 많이 쌓이면 사진을 가린다
function livePopup(html, kind) {
  const box = document.getElementById('live-popups');
  if (!box) return;
  while (box.children.length >= LIVE_POP_MAX) box.firstElementChild.remove();
  const el = document.createElement('div');
  el.className = 'live-pop' + (kind ? ' ' + kind : '');
  el.style.setProperty('--pop-life', LIVE_POP_MS + 'ms');
  el.innerHTML = html;
  box.appendChild(el);
  setTimeout(() => el.remove(), LIVE_POP_MS);
}
// 사용자가 쓴 글이 그대로 화면에 들어가면 위험하므로 항상 이스케이프해서 넣는다.
const esc = (t) => String(t).replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// ---------- 함께 보고 있는 사람 ----------
// 사진을 서로 맞추지는 않는다(요청) — 인원과 입장만 알린다.
//
// 들어올 때 띄우던 "현재 화면이 재생중입니다. 같이 참여합니다." 안내는 없앴다(요청).
// 혼자 보는 경우가 대부분인데 매번 토스트가 떠서 사진을 가렸다. 대신 **나 말고 다른
// 사람이 실제로 같이 보고 있을 때만** 우측 위에 "N명이 참여중입니다." 알약을 띄운다.
const PRESENCE_BEAT = 25000;
let presenceSince = 0;        // 서버 시각 기준 — 이 시각 이후에 들어온 사람만 "새 접속"
let presenceFirstBeat = true; // 첫 응답에서는 "새로 들어왔다" 팝업을 띄우지 않는다
let presenceStarted = false;  // 하트비트를 이미 걸었는지(PIN 재시도로 두 번 걸리지 않게)

// 동시 접속자 표시. 1명(=나뿐)이면 아무것도 보여주지 않는다.
function renderViewers(n) {
  const pill = document.getElementById('viewers-pill');
  const txt = document.getElementById('viewers-text');
  if (!pill || !txt) return;
  const show = Number(n) > 1;
  if (show) txt.textContent = `${n}명이 참여중입니다.`;
  pill.classList.toggle('hidden', !show);
  // 알림 팝업이 알약과 겹치지 않도록 body에 표시를 남긴다(CSS의 body.has-viewers).
  document.body.classList.toggle('has-viewers', show);
}

async function beatPresence() {
  try {
    const r = await fetch(`/api/wepic/${encodeURIComponent(shareId)}/presence`, {
      method: 'POST', credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ since: presenceSince }),
    });
    if (!r.ok) return;   // PIN 게이트 등 — 조용히 넘어간다
    const d = await r.json();
    // 다음 호출부터는 "이 시각 이후에 들어온 사람"만 새 접속으로 본다.
    // 서버가 준 시각을 쓰므로 내 PC 시계가 틀어져 있어도 상관없다.
    presenceSince = d.now || presenceSince;
    renderViewers(d.viewers || 1);
    if (presenceFirstBeat) {
      presenceFirstBeat = false;   // 입장 안내는 띄우지 않는다
      return;
    }
    if (d.joined > 0) {
      livePopup(d.joined > 1
        ? `새로운 사용자 <b>${d.joined}명</b>이 접속했습니다`
        : '새로운 사용자가 접속했습니다', 'join');
    }
  } catch { /* 네트워크 순단 무시 */ }
}

function fmtCommentTime(iso) {
  const d = new Date(iso);
  return new Intl.DateTimeFormat('ko-KR', { hour: '2-digit', minute: '2-digit' }).format(d);
}

function renderLikeUI() {
  document.getElementById('like-count').textContent = String(likeCount);
  const b = document.getElementById('btn-like');
  b.classList.toggle('liked', likedByMe);
  b.title = likedByMe ? '좋아요 취소' : '좋아요';
  fitActionRow();   // 0 → 12 → 345로 자릿수가 늘면 줄도 길어진다
}
function renderCommentCount() {
  document.getElementById('comment-count').textContent = String(commentTotal);
  fitActionRow();
}

// 댓글을 목록에 덧붙인다. fresh=true면 방금 도착한 것처럼 살짝 강조한다.
function appendComments(list, fresh) {
  const box = cmtListEl();
  const empty = box.querySelector('.comment-empty');
  if (empty && list.length) empty.remove();
  // 거의 맨 아래를 보고 있었다면 새 글이 와도 계속 아래를 따라가게 한다(읽던 위치는 존중).
  const nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 40;
  list.forEach((c) => {
    if (c.id && c.id <= lastCommentId) return; // 중복 방지(폴링과 내가 쓴 글이 겹칠 수 있다)
    const item = document.createElement('div');
    item.className = 'comment-item' + (fresh ? ' fresh' : '');
    const who = document.createElement('span');
    who.className = 'who';
    who.textContent = c.author;
    item.appendChild(who);
    item.appendChild(document.createTextNode(c.body));
    const when = document.createElement('span');
    when.className = 'when';
    when.textContent = fmtCommentTime(c.createdAt);
    item.appendChild(when);
    box.appendChild(item);
    if (c.id) lastCommentId = Math.max(lastCommentId, c.id);
  });
  if (nearBottom) box.scrollTop = box.scrollHeight;
}

async function loadComments(initial) {
  try {
    const url = `/api/wepic/${encodeURIComponent(shareId)}/comments`
      + (initial ? '' : `?after=${lastCommentId}`);
    const r = await fetch(url, { credentials: 'same-origin', cache: 'no-store' });
    if (!r.ok) return; // PIN 게이트 등 — 조용히 넘어간다(사진 재생은 계속)
    const d = await r.json();
    // 좋아요가 늘었으면 = 같이 보는 누군가가 눌렀다는 뜻이라 팝업으로 알린다.
    // (내가 누른 것은 아래 btn-like에서 likeCount를 이미 갱신해 두므로 델타에 걸리지 않는다)
    const grew = (d.likeCount || 0) - likeCount;
    likeCount = d.likeCount || 0;
    likedByMe = !!d.likedByMe;
    renderLikeUI();
    if (!initial && grew > 0) {
      livePopup(grew > 1
        ? `♥ 좋아요 <b>${grew}개</b>가 새로 눌렸어요`
        : '♥ 누군가 좋아요를 눌렀어요', 'like');
    }
    if (initial) {
      cmtListEl().innerHTML = '';
      lastCommentId = 0;
      if (!d.comments.length) {
        const e = document.createElement('div');
        e.className = 'comment-empty';
        e.textContent = '아직 남긴 글이 없습니다. 첫 글을 남겨보세요.';
        cmtListEl().appendChild(e);
      }
      commentTotal = d.comments.length;
      appendComments(d.comments, false);
      cmtListEl().scrollTop = cmtListEl().scrollHeight;
    } else if (d.comments.length) {
      commentTotal += d.comments.length;
      appendComments(d.comments, true);
      // 댓글창을 닫고 보는 사람에게도 내용이 잠깐 보이도록 팝업으로 함께 띄운다.
      // 내가 방금 쓴 글은 sendComment가 이미 화면에 넣었으므로 여기서 제외한다.
      d.comments.forEach((c) => {
        if (myCommentIds.has(c.id)) { myCommentIds.delete(c.id); return; }
        livePopup(`<span class="live-pop-who">${esc(c.author)}</span>${esc(c.body)}`);
      });
    }
    renderCommentCount();
  } catch { /* 네트워크 순단 무시 */ }
}

function scheduleCommentPoll() {
  if (commentTimer) clearInterval(commentTimer);
  commentTimer = setInterval(() => loadComments(false), commentsOpen ? CMT_POLL_OPEN : CMT_POLL_IDLE);
}

function setCommentsOpen(on) {
  commentsOpen = on;
  document.getElementById('comment-pane').classList.toggle('hidden', !on);
  if (on) {
    loadComments(false);
    cmtListEl().scrollTop = cmtListEl().scrollHeight;
  }
  scheduleCommentPoll();
}
document.getElementById('btn-comments').addEventListener('click', () => setCommentsOpen(!commentsOpen));
document.getElementById('btn-comment-close').addEventListener('click', () => setCommentsOpen(false));

async function sendComment() {
  const input = document.getElementById('comment-input');
  const note = document.getElementById('comment-note');
  const text = input.value.trim();
  if (!text) return;
  const btn = document.getElementById('btn-comment-send');
  btn.disabled = true;
  try {
    const r = await fetch(`/api/wepic/${encodeURIComponent(shareId)}/comments`, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ body: text }),
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) { note.textContent = d.error || '남기지 못했습니다.'; return; }
    input.value = '';
    note.textContent = '';
    commentTotal += 1;
    if (d.comment?.id) myCommentIds.add(d.comment.id);
    appendComments([d.comment], true);
    renderCommentCount();
  } catch (err) {
    note.textContent = '남기지 못했습니다: ' + err.message;
  } finally {
    btn.disabled = false;
    input.focus();
  }
}
document.getElementById('btn-comment-send').addEventListener('click', sendComment);
document.getElementById('comment-input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); sendComment(); }
});
// 글을 쓰는 동안에는 사진이 넘어가지 않게 잠시 멈춘다(쓰다가 화면이 바뀌면 산만하다).
document.getElementById('comment-input').addEventListener('focus', () => {
  if (!slidePaused) { setSlidePaused(true); document.getElementById('comment-note').textContent = '글을 쓰는 동안 사진이 멈춥니다.'; }
});

document.getElementById('btn-like').addEventListener('click', async () => {
  const b = document.getElementById('btn-like');
  b.disabled = true;
  try {
    const r = await fetch(`/api/wepic/${encodeURIComponent(shareId)}/like`, {
      method: 'POST', credentials: 'same-origin',
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) { showToast(d.error || '좋아요를 처리하지 못했습니다.'); return; }
    likeCount = d.likeCount || 0;
    likedByMe = !!d.liked;
    renderLikeUI();
  } catch (err) {
    showToast('좋아요를 처리하지 못했습니다: ' + err.message);
  } finally {
    b.disabled = false;
  }
});

// ---------- 화면 줌인 / 줌아웃 ----------
// 사진(동영상 포함)을 확대해서 자세히 볼 수 있게 한다. 조작 방법은 세 가지 —
//   · 아이콘의 ⊕ / ⊖ 버튼
//   · 마우스 휠(사진 위) · 두 손가락 오므리기(핀치)
//   · 두 번 누르기(더블탭/더블클릭)로 확대 ↔ 원래대로 토글
// 확대된 상태에서는 끌어서 보고 싶은 곳으로 옮길 수 있다.
//
// 규칙(요청): 줌 조작을 하는 동안에는 사진 넘김을 멈춘다. 마지막 줌 조작 뒤 10초 동안
// 아무 줌 조작이 없으면 원래 배율로 되돌리고 다시 사진이 재생된다.
const ZOOM_HOLD_MS = 10000;   // 마지막 줌 조작 뒤 이만큼 지나면 재생 재개
const ZOOM_MIN = 1;
const ZOOM_MAX = 4;
const ZOOM_STEP = 0.5;

let zoomScale = 1;
let zoomX = 0, zoomY = 0;      // 확대 상태에서 끌어 옮긴 거리(화면 픽셀)
let zoomHoldTimer = null;
let zoomPausedByUs = false;    // ⏸를 직접 누른 사용자를 우리가 멋대로 재개시키지 않기 위한 표시
let zoomBadgeTimer = null;

const stageEl = () => document.getElementById('photo-stage');

// 확대해도 사진이 화면 밖으로 완전히 빠져나가지 않도록 이동 범위를 제한한다.
function clampPan() {
  const box = document.querySelector('.share-view');
  const w = box?.clientWidth || 0, h = box?.clientHeight || 0;
  const maxX = ((zoomScale - 1) / 2) * w;
  const maxY = ((zoomScale - 1) / 2) * h;
  zoomX = Math.max(-maxX, Math.min(maxX, zoomX));
  zoomY = Math.max(-maxY, Math.min(maxY, zoomY));
}

function applyZoom() {
  const st = stageEl();
  if (!st) return;
  clampPan();
  st.style.transform = `translate(${zoomX}px, ${zoomY}px) scale(${zoomScale})`;
  st.classList.toggle('zoomed', zoomScale > 1);
}

// 배율을 잠깐 보여준다(조작 중에만).
function flashZoomBadge() {
  const b = document.getElementById('zoom-badge');
  if (!b) return;
  b.textContent = Math.round(zoomScale * 100) + '%';
  b.classList.add('show');
  if (zoomBadgeTimer) clearTimeout(zoomBadgeTimer);
  zoomBadgeTimer = setTimeout(() => b.classList.remove('show'), 1400);
}

// 줌 조작이 있었다 → 사진 넘김을 멈추고, 10초 뒤 원래대로 되돌릴 예약을 새로 건다.
function markZoomActivity() {
  if (!slidePaused) { zoomPausedByUs = true; setSlidePaused(true); }
  if (zoomHoldTimer) clearTimeout(zoomHoldTimer);
  zoomHoldTimer = setTimeout(endZoomHold, ZOOM_HOLD_MS);
}

// 10초 동안 줌 조작이 없었다 → 원래 배율로 돌아가고 재생을 재개한다.
function endZoomHold() {
  zoomHoldTimer = null;
  resetZoom();
  if (zoomPausedByUs) { zoomPausedByUs = false; setSlidePaused(false); }
}

// 배율·위치를 원래대로. (재생 재개 여부는 건드리지 않는다)
function resetZoom() {
  zoomScale = 1; zoomX = 0; zoomY = 0;
  applyZoom();
}

// 배율을 delta만큼 바꾼다. center를 주면 그 지점을 기준으로 확대되도록 위치도 함께 옮긴다.
function zoomBy(delta, center) {
  const before = zoomScale;
  const next = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, +(before + delta).toFixed(2)));
  if (next === before) { markZoomActivity(); flashZoomBadge(); return; }
  if (center) {
    // 누른 지점이 제자리에 남도록 이동량을 비례해서 조정한다.
    const box = document.querySelector('.share-view');
    const rect = box.getBoundingClientRect();
    const cx = center.x - rect.left - rect.width / 2;
    const cy = center.y - rect.top - rect.height / 2;
    const k = next / before;
    zoomX = cx - (cx - zoomX) * k;
    zoomY = cy - (cy - zoomY) * k;
  }
  zoomScale = next;
  if (zoomScale === 1) { zoomX = 0; zoomY = 0; }
  applyZoom();
  flashZoomBadge();
  markZoomActivity();
}

document.getElementById('btn-zoom-in').addEventListener('click', () => zoomBy(ZOOM_STEP));
document.getElementById('btn-zoom-out').addEventListener('click', () => zoomBy(-ZOOM_STEP));

// 마우스 휠 — 사진 위에서 굴리면 확대/축소. 페이지 스크롤은 없으므로 그대로 가로챈다.
document.querySelector('.share-view').addEventListener('wheel', (e) => {
  e.preventDefault();
  zoomBy(e.deltaY < 0 ? ZOOM_STEP : -ZOOM_STEP, { x: e.clientX, y: e.clientY });
}, { passive: false });

// 두 번 누르기 — 확대 ↔ 원래대로. (버튼 위에서는 동작하지 않게 막는다)
document.querySelector('.share-view').addEventListener('dblclick', (e) => {
  if (e.target.closest('button, .comment-pane, .pin-gate')) return;
  if (zoomScale > 1) { resetZoom(); flashZoomBadge(); markZoomActivity(); }
  else zoomBy(1, { x: e.clientX, y: e.clientY });
});

// ---- 손가락 조작: 핀치 확대 · 끌어서 옮기기 ----
let pinchStartDist = 0, pinchStartScale = 1;
let dragging = false, dragFromX = 0, dragFromY = 0, dragBaseX = 0, dragBaseY = 0;
const touchDist = (t) => Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY);

const shareViewEl = document.querySelector('.share-view');
shareViewEl.addEventListener('touchstart', (e) => {
  if (e.target.closest('button, input, .comment-pane, .pin-gate')) return;
  if (e.touches.length === 2) {
    pinchStartDist = touchDist(e.touches);
    pinchStartScale = zoomScale;
    markZoomActivity();
  } else if (e.touches.length === 1 && zoomScale > 1) {
    dragging = true;
    dragFromX = e.touches[0].clientX; dragFromY = e.touches[0].clientY;
    dragBaseX = zoomX; dragBaseY = zoomY;
  }
}, { passive: true });

shareViewEl.addEventListener('touchmove', (e) => {
  if (e.touches.length === 2 && pinchStartDist > 0) {
    e.preventDefault();
    const k = touchDist(e.touches) / pinchStartDist;
    zoomScale = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, +(pinchStartScale * k).toFixed(2)));
    if (zoomScale === 1) { zoomX = 0; zoomY = 0; }
    applyZoom();
    flashZoomBadge();
    markZoomActivity();
  } else if (dragging && e.touches.length === 1) {
    e.preventDefault();
    zoomX = dragBaseX + (e.touches[0].clientX - dragFromX);
    zoomY = dragBaseY + (e.touches[0].clientY - dragFromY);
    applyZoom();
    markZoomActivity();
  }
}, { passive: false });

['touchend', 'touchcancel'].forEach((ev) => shareViewEl.addEventListener(ev, () => {
  pinchStartDist = 0;
  dragging = false;
}, { passive: true }));

// ---- 마우스로 끌어서 옮기기 (확대된 상태에서만) ----
shareViewEl.addEventListener('mousedown', (e) => {
  if (zoomScale <= 1 || e.button !== 0) return;
  if (e.target.closest('button, input, .comment-pane, .pin-gate')) return;
  e.preventDefault();
  dragging = true;
  dragFromX = e.clientX; dragFromY = e.clientY;
  dragBaseX = zoomX; dragBaseY = zoomY;
  stageEl()?.classList.add('grabbing');
});
window.addEventListener('mousemove', (e) => {
  if (!dragging) return;
  zoomX = dragBaseX + (e.clientX - dragFromX);
  zoomY = dragBaseY + (e.clientY - dragFromY);
  applyZoom();
  markZoomActivity();
});
window.addEventListener('mouseup', () => {
  if (!dragging) return;
  dragging = false;
  stageEl()?.classList.remove('grabbing');
});

// 키보드 +/- 로도 확대·축소 (액자로 세워둔 PC에서 리모컨처럼 쓸 수 있게)
window.addEventListener('keydown', (e) => {
  if (e.target.matches('input, textarea')) return;
  if (e.key === '+' || e.key === '=') zoomBy(ZOOM_STEP);
  else if (e.key === '-' || e.key === '_') zoomBy(-ZOOM_STEP);
  else if (e.key === '0') { resetZoom(); flashZoomBadge(); markZoomActivity(); }
});

// 사파리(iOS/macOS)는 user-scalable=no를 무시하고 자체 핀치 확대를 건다 → 그것만 막는다
// (우리 핀치 처리는 위 touchmove가 담당한다).
['gesturestart', 'gesturechange', 'gestureend'].forEach((ev) =>
  document.addEventListener(ev, (e) => e.preventDefault()));

// 화면 크기가 바뀌면 이동 한계도 달라진다 → 다시 맞춘다.
window.addEventListener('resize', applyZoom);

// ---------- 빈화면 모드 ----------
// 사진만 남기고 제목·번호·촬영일/곡명·진행바·댓글창·나머지 아이콘을 감춘다(CSS의 body.clean).
// 남는 두 아이콘(빈화면 해제 · 화면 작게)도 손을 대지 않으면 3초 뒤 조용히 사라진다 —
// 벽에 걸어두는 전자액자처럼 보이게 하는 게 이 모드의 목적이다.
const UI_HIDE_MS = 3000;
let uiHideTimer = null;
let cleanMode = false;

// 손을 댔다는 신호가 오면 아이콘을 보여주고, 3초 뒤 다시 감춘다.
function pokeUI() {
  if (!cleanMode) return;
  document.body.classList.remove('ui-hidden');
  if (uiHideTimer) clearTimeout(uiHideTimer);
  uiHideTimer = setTimeout(() => {
    if (cleanMode) document.body.classList.add('ui-hidden');
  }, UI_HIDE_MS);
}

function setCleanMode(on) {
  cleanMode = !!on;
  document.body.classList.toggle('clean', cleanMode);
  const b = document.getElementById('btn-clean');
  b.title = cleanMode ? '빈화면 해제 (제목·정보 다시 보기)' : '빈화면 (사진만 보기)';
  b.setAttribute('aria-label', b.title);
  if (cleanMode) {
    setCommentsOpen(false);   // 댓글창이 열려 있으면 사진만 보이지 않는다
    pokeUI();                 // 켠 직후에는 3초 동안 보여준다(끌 방법을 알 수 있게)
  } else {
    if (uiHideTimer) clearTimeout(uiHideTimer);
    document.body.classList.remove('ui-hidden');
  }
  fitActionRow();   // 빈화면에서는 아이콘 두 개만 남으므로 축소가 필요 없다
}
document.getElementById('btn-clean').addEventListener('click', () => setCleanMode(!cleanMode));
// 마우스·터치·키보드 어느 쪽으로 건드려도 아이콘이 잠깐 나타난다.
['mousemove', 'mousedown', 'touchstart', 'keydown', 'wheel'].forEach((ev) =>
  window.addEventListener(ev, pokeUI, { passive: true }));

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

  // 첫 사진이 실제로 화면에 뜰 때까지는 시작 화면(로고 + 첫 사진을 흐리게)을 유지한다.
  // 예전에는 여기서 곧바로 감춰서, 원본을 받는 동안 새까만 화면이 그대로 보였다.
  showSplashPhoto(photos[0]);
  setSplashMessage('곧 시작합니다...');
  idx = 0;
  await show();
  document.getElementById('share-loading').classList.add('hidden');
  resetTimer();
  updateSlideBtn(); // 슬라이드 멈춤/재개 버튼 초기 상태(재생 중 = ⏸ 표시)

  // 음악은 위 applyManifest에서 이미 무음 재생으로 시작됨(중복 생성 방지). 여기서는
  // 혹시 누락된 경우만 보정한다(initMusic은 여러 번 호출해도 안전).
  // 미리듣기(음악찾기로 고른 곡)는 <audio>가 이미 맡고 있으므로 부르지 않는다.
  if (musicUrl && !isPreviewUrl(musicUrl) && !playerPromise) initMusic();
  // 변경 감지 폴링은 재생이 시작된 뒤 한 번만 걸어둔다(PIN 통과 전에는 돌지 않음).
  if (!pollStarted) { pollStarted = true; setInterval(pollForUpdates, POLL_MS); }
  // 댓글·좋아요도 재생이 시작된 뒤(=볼 자격이 확인된 뒤) 불러온다.
  await loadComments(true);
  scheduleCommentPoll();
  // "함께 보고 있는 사람"도 같은 시점부터 — 첫 호출이 입장 안내를 띄운다.
  if (!presenceStarted) {
    presenceStarted = true;
    beatPresence();
    setInterval(beatPresence, PRESENCE_BEAT);
  }
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

  fitActionRow();  // 첫 그림이 오기 전에 아이콘 줄부터 화면 폭에 맞춰 둔다
  await start(); // 폴링은 start() 안에서 재생 시작 후 설정된다
}
init();
