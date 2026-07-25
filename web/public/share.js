// 공유 보기 페이지 (로그인 불필요) — /f/<id> 에서 열리며 /shares/<id>/photos.json 을 읽어 재생.
const shareId = location.pathname.split('/').filter(Boolean).pop();

let photos = [];
let idx = 0;
let activeLayer = 'a';
let timer = null;
let intervalMs = 10000; // 링크 생성 시점의 전환 간격 (없으면 10초)

function formatDate(iso) {
  const d = new Date(iso);
  const date = new Intl.DateTimeFormat('ko-KR', { year: 'numeric', month: 'long', day: 'numeric' }).format(d);
  const time = new Intl.DateTimeFormat('ko-KR', { hour: '2-digit', minute: '2-digit' }).format(d);
  return `${date} · ${time}`;
}

function preload(url) {
  return new Promise((resolve) => { const im = new Image(); im.onload = resolve; im.onerror = resolve; im.src = url; });
}

async function show() {
  if (!photos.length) return;
  const p = photos[idx];
  const req = idx;
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

function advance() { if (photos.length) { idx = (idx + 1) % photos.length; show(); } }
function resetTimer() { if (timer) clearInterval(timer); timer = setInterval(advance, intervalMs); }

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
// 무음으로 플레이어를 만들어(음소거 자동재생) 곡 제목을 얻고 캡션에 표시한다. 소리는 나지 않는다.
async function initMusic() {
  const id = musicUrl ? ytId(musicUrl) : null;
  if (!id) return;
  await loadYouTubeApi();
  await new Promise((resolve) => {
    ytPlayer = new YT.Player('yt-player', {
      videoId: id,
      playerVars: { autoplay: 1, mute: 1, loop: 1, playlist: id, controls: 0 },
      events: { onReady: (e) => { try { e.target.mute(); e.target.playVideo(); } catch {} resolve(); } },
    });
  });
  // 제목 읽기 (소리와 무관). 메타데이터 로딩 지연 대비 두 번 시도.
  const readTitle = () => { try { musicTitle = ytPlayer.getVideoData()?.title || musicTitle; renderCaption(); } catch {} };
  setTimeout(readTitle, 900);
  setTimeout(readTitle, 2500);
  document.getElementById('btn-music').style.display = 'flex';
  updateMusicBtn();
}
function playSound() {
  if (!ytPlayer) return;
  try { ytPlayer.unMute(); ytPlayer.setVolume(80); ytPlayer.playVideo(); } catch {}
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
function saveBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}
function dlName(p, i, type) {
  const d = new Date(p.createTime);
  const stamp = Number.isNaN(d.getTime())
    ? String(i + 1).padStart(3, '0')
    : `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}_${String(d.getHours()).padStart(2, '0')}${String(d.getMinutes()).padStart(2, '0')}`;
  const ext = /png/.test(type) ? 'png' : /webp/.test(type) ? 'webp' : 'jpg';
  return `wepic_${String(i + 1).padStart(3, '0')}_${stamp}.${ext}`;
}
async function downloadOne(p, i) {
  const res = await fetch(p.fullUrl, { cache: 'no-store' });
  if (!res.ok) throw new Error(`다운로드 실패 (${res.status})`);
  const blob = await res.blob();
  saveBlob(blob, dlName(p, i, blob.type));
}

const downloadMenu = document.getElementById('download-menu');
document.getElementById('btn-download').addEventListener('click', (e) => {
  e.stopPropagation();
  if (!photos.length) return;
  downloadMenu.classList.toggle('hidden');
});
document.addEventListener('click', (e) => {
  if (!downloadMenu.classList.contains('hidden') && !downloadMenu.contains(e.target)) downloadMenu.classList.add('hidden');
});
document.getElementById('dl-current').addEventListener('click', async () => {
  downloadMenu.classList.add('hidden');
  const p = photos[idx];
  if (!p) return;
  try {
    showToast('저장 중...');
    await downloadOne(p, idx);
    showToast('저장되었습니다.');
  } catch (err) {
    showToast('저장 실패: ' + err.message);
  }
});
document.getElementById('dl-all').addEventListener('click', async () => {
  downloadMenu.classList.add('hidden');
  const list = photos.slice();
  if (!list.length) return;
  let ok = 0, fail = 0;
  for (let i = 0; i < list.length; i++) {
    showToast(`전체 저장 중... (${i + 1}/${list.length})`);
    try { await downloadOne(list[i], i); ok++; } catch { fail++; }
    await new Promise((r) => setTimeout(r, 350)); // 연속 다운로드 차단 방지
  }
  showToast(fail ? `저장 완료 ${ok}장 (실패 ${fail}장)` : `전체 ${ok}장 저장되었습니다.`);
});

// ---- 매니페스트 적용 (최초 로드 / 변경 반영 공용) ----
let lastUpdatedAt = null;

function applyManifest(data) {
  const view = document.querySelector('.share-view');
  photos = data.items || [];
  lastUpdatedAt = data.updatedAt || null;

  // 제목
  const t = document.getElementById('share-title');
  const title = (data.title || '').trim();
  t.textContent = title;
  t.classList.toggle('hidden', !title);

  // 전환 효과 · 간격
  const effect = ['fade', 'slide', 'kenburns'].includes(data.effect) ? data.effect : 'fade';
  view.classList.remove('fx-fade', 'fx-slide', 'fx-kenburns');
  view.classList.add('fx-' + effect);
  const sec = Math.min(60, Math.max(3, Number(data.intervalSec) || 10));
  intervalMs = sec * 1000;
  view.style.setProperty('--kb-duration', sec + 's');

  // 배경음악: 곡이 바뀌면 새 곡으로 교체(무음/소리 상태는 유지)
  const newMusic = data.musicUrl || '';
  if (newMusic !== musicUrl) {
    musicUrl = newMusic;
    const newId = musicUrl ? ytId(musicUrl) : null;
    if (!newId) {
      try { ytPlayer?.pauseVideo(); } catch {}
      musicTitle = '';
      document.getElementById('btn-music').style.display = 'none';
      renderCaption();
    } else if (ytPlayer) {
      try {
        ytPlayer.loadVideoById(newId);
        if (!soundOn) ytPlayer.mute();
      } catch {}
      musicTitle = '';
      const readTitle = () => { try { musicTitle = ytPlayer.getVideoData()?.title || ''; renderCaption(); } catch {} };
      setTimeout(readTitle, 900);
      setTimeout(readTitle, 2500);
    } else {
      initMusic(); // 원래 음악이 없다가 새로 생긴 경우
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

// ---- 초기화 ----
async function init() {
  try {
    const res = await fetch(`/shares/${shareId}/photos.json`, { cache: 'no-store' });
    if (!res.ok) throw new Error();
    const data = await res.json();
    if (!(data.items || []).length) throw new Error();
    applyManifest(data);
  } catch {
    document.getElementById('share-loading').classList.add('hidden');
    const e = document.getElementById('share-error');
    e.textContent = '공유 사진을 찾을 수 없습니다. 링크가 만료되었거나 삭제되었을 수 있습니다.';
    e.classList.remove('hidden');
    return;
  }

  document.getElementById('share-loading').classList.add('hidden');
  idx = 0;
  await show();
  resetTimer();

  // 음악이 있으면 무음으로 시작해 곡목만 표시(소리는 ▶ 버튼으로). 자동으로 소리 내지 않음.
  if (musicUrl) initMusic();

  setInterval(pollForUpdates, POLL_MS);
}
init();
