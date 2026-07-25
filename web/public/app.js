// ---------- 화면 전환 (홈 / 사진선택·동기화 / 슬라이드쇼) ----------
const homeShell = document.getElementById('home-shell');
const pickerShell = document.getElementById('picker-shell');
const slideshowEl = document.getElementById('screen-slideshow');
const pickerScreens = {
  source: document.getElementById('screen-source'),
  sync: document.getElementById('screen-sync'),
};

function showHome() {
  pickerShell.classList.add('hidden');
  slideshowEl.classList.add('hidden');
  homeShell.classList.remove('hidden');
}
function showPicker(name) {
  homeShell.classList.add('hidden');
  slideshowEl.classList.add('hidden');
  pickerShell.classList.remove('hidden');
  Object.entries(pickerScreens).forEach(([k, el]) => el.classList.toggle('hidden', k !== name));
}
function showSlideshow() {
  homeShell.classList.add('hidden');
  pickerShell.classList.add('hidden');
  slideshowEl.classList.remove('hidden');
}

// ---------- 홈 좌측 메뉴 / 우측 패널 ----------
function selectPanel(name) {
  showHome();
  document.querySelectorAll('#home-menu .menu-item').forEach((b) =>
    b.classList.toggle('active', b.dataset.panel === name));
  document.querySelectorAll('.home-frame .panel').forEach((p) =>
    p.classList.toggle('hidden', p.id !== 'panel-' + name));
}
document.querySelectorAll('#home-menu .menu-item').forEach((b) =>
  b.addEventListener('click', () => selectPanel(b.dataset.panel)));
document.querySelectorAll('[data-goto]').forEach((el) =>
  el.addEventListener('click', (e) => { e.preventDefault(); selectPanel(el.dataset.goto); }));

async function api(url, opts) {
  const res = await fetch(url, { credentials: 'same-origin', ...opts });
  if (res.status === 401) { selectPanel('login'); throw new Error('로그인이 필요합니다.'); }
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `요청 실패 (${res.status})`);
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
    qrEl.src = s.qrDataUrl;
    qrEl.classList.remove('hidden');
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
      // "사진 추가": 기존 사진에 새 사진을 덧붙이고(중복 id 제거) 촬영일 오름차순 정렬
      const seen = new Set(allPhotos.map((p) => p.id));
      const fresh = items.filter((it) => !seen.has(it.id));
      finalItems = allPhotos.concat(fresh).sort((a, b) => new Date(a.createTime) - new Date(b.createTime));
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

function preload(url) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = resolve;
    img.onerror = resolve;
    img.src = url;
  });
}

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
  updateFullscreenCaption(photo);
  updateActiveThumb();
  updateProgress();
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
  const nextLayer = document.getElementById(activeLayer === 'a' ? 'photo-b' : 'photo-a');
  const prevLayer = document.getElementById(activeLayer === 'a' ? 'photo-a' : 'photo-b');
  await preload(photo.fullUrl);
  if (requested !== currentIndex) return;
  nextLayer.src = photo.fullUrl;
  nextLayer.classList.add('active');
  prevLayer.classList.remove('active');
  activeLayer = activeLayer === 'a' ? 'b' : 'a';
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
  const btn = document.getElementById('btn-pause');
  btn.textContent = paused ? '▶ 화면 재개' : '⏸ 화면 잠시멈춤';
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
document.getElementById('btn-pause').addEventListener('click', () => setSlideshowPaused(!slideshowPaused));

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
function setFullscreen(on) {
  document.body.classList.toggle('fullscreen', on);
  if (on) document.documentElement.requestFullscreen?.().catch(() => {});
  else if (document.fullscreenElement) document.exitFullscreen?.().catch(() => {});
}
const toggleFullscreen = () => setFullscreen(!document.body.classList.contains('fullscreen'));
document.getElementById('btn-fullscreen').addEventListener('click', toggleFullscreen);
document.addEventListener('fullscreenchange', () => {
  // 사용자가 F11/Esc로 직접 빠져나온 경우 상태 동기화
  document.body.classList.toggle('fullscreen', !!document.fullscreenElement);
});

let toastHandle = null;
function showToast(msg) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.classList.remove('hidden');
  if (toastHandle) clearTimeout(toastHandle);
  toastHandle = setTimeout(() => el.classList.add('hidden'), 2500);
}

// ---------- 다운로드 (이 사진만 / 전체) ----------
// blob으로 받아 <a download>로 저장한다. 원본(프록시가 내려주는 원본 화질)을 그대로 저장하며
// 모바일에서도 같은 방식으로 동작한다(캔버스 변환·재압축 없음).
function fileExtFromType(type) {
  if (/png/.test(type)) return 'png';
  if (/webp/.test(type)) return 'webp';
  if (/gif/.test(type)) return 'gif';
  if (/mp4/.test(type)) return 'mp4';
  if (/quicktime|mov/.test(type)) return 'mov';
  if (/webm/.test(type)) return 'webm';
  return 'jpg';
}
function photoFileName(photo, idx, type) {
  const d = new Date(photo.createTime);
  const stamp = Number.isNaN(d.getTime())
    ? String(idx + 1).padStart(3, '0')
    : `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}_${String(d.getHours()).padStart(2, '0')}${String(d.getMinutes()).padStart(2, '0')}`;
  return `wepic_${String(idx + 1).padStart(3, '0')}_${stamp}.${fileExtFromType(type)}`;
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
// 동영상이면 원본(videoUrl), 사진이면 fullUrl을 내려받는다.
async function downloadOne(photo, idx) {
  const src = photo.type === 'video' && photo.videoUrl ? photo.videoUrl : photo.fullUrl;
  const res = await fetch(src, { credentials: 'same-origin' });
  if (!res.ok) throw new Error(`다운로드 실패 (${res.status})`);
  const blob = await res.blob();
  saveBlob(blob, photoFileName(photo, idx, blob.type));
}

const downloadMenu = document.getElementById('download-menu');
const hideDownloadMenu = () => downloadMenu.classList.add('hidden');

document.getElementById('btn-download').addEventListener('click', (e) => {
  e.stopPropagation();
  if (!filteredPhotos.length) { showToast('저장할 사진이 없습니다.'); return; }
  downloadMenu.classList.toggle('hidden');
});
// 메뉴 밖을 누르면 닫기
document.addEventListener('click', (e) => {
  if (!downloadMenu.classList.contains('hidden') && !downloadMenu.contains(e.target)) hideDownloadMenu();
});

document.getElementById('dl-current').addEventListener('click', async () => {
  hideDownloadMenu();
  const photo = filteredPhotos[currentIndex];
  if (!photo) return;
  try {
    showToast('저장 중...');
    await downloadOne(photo, currentIndex);
    showToast('저장되었습니다.');
  } catch (err) {
    showToast('저장 실패: ' + err.message);
  }
});

document.getElementById('dl-all').addEventListener('click', async () => {
  hideDownloadMenu();
  const list = filteredPhotos.slice();
  if (!list.length) return;
  let ok = 0, fail = 0;
  for (let i = 0; i < list.length; i++) {
    showToast(`전체 저장 중... (${i + 1}/${list.length})`);
    try {
      await downloadOne(list[i], i);
      ok++;
    } catch { fail++; }
    // 브라우저가 연속 다운로드를 차단하지 않도록 약간의 간격을 둔다
    await new Promise((r) => setTimeout(r, 350));
  }
  showToast(fail ? `저장 완료 ${ok}장 (실패 ${fail}장)` : `전체 ${ok}장 저장되었습니다.`);
});

// ---------- 배경음악 (YouTube IFrame API) ----------
// 데모·로그인 모두 처음 진입 시 이 곡을 기본 배경음악으로 채운다.
const DEFAULT_MUSIC_URL = 'https://www.youtube.com/watch?v=wqX7AxcYTj8';
let ytPlayer = null;
let ytReady = null;
let musicLoaded = false;
let musicPlaying = false;
let musicTitle = '';

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
  const playBtn = document.getElementById('btn-music-load');
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
              playBtn.textContent = '⏸'; musicPlaying = true;
              muteVideoForBackgroundMusic();
            }
            else if (e.data === YT.PlayerState.PAUSED) { playBtn.textContent = '▶'; musicPlaying = false; }
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
  playBtn.textContent = '⏸';
  setTimeout(() => {
    try { musicTitle = ytPlayer.getVideoData()?.title || ''; titleEl.textContent = musicTitle; refreshCaption(); } catch {}
  }, 900);
  try { localStorage.setItem('bgMusicUrl', url); } catch {}
}

// "▶ 재생하기" 버튼: 처음이거나 링크가 바뀌었으면 로드/재생, 이미 로드됐으면 재생↔일시정지 토글
document.getElementById('btn-music-load').addEventListener('click', () => {
  const url = document.getElementById('music-url').value.trim();
  const id = url ? extractYouTubeId(url) : null;
  if (!musicLoaded || (id && id !== loadedVideoId)) {
    if (url) loadBgMusic(url);
    else showToast('YouTube 링크를 입력하세요.');
    return;
  }
  if (ytPlayer.getPlayerState() === YT.PlayerState.PLAYING) ytPlayer.pauseVideo();
  else ytPlayer.playVideo();
});
document.getElementById('music-volume').addEventListener('input', (e) => ytPlayer?.setVolume(Number(e.target.value)));
document.getElementById('btn-music-clear').addEventListener('click', () => {
  const i = document.getElementById('music-url'); i.value = ''; i.focus();
});

// ---------- 실시간 공유 링크 ----------
const shareModal = document.getElementById('share-modal');

// 현재 화면의 사진·제목·음악·전환설정을 서버에 올린다.
// 서버는 세션마다 같은 shareId를 재사용하므로, 다시 올리면 "같은 링크"의 내용이 갱신된다.
// mode: 'create'(팝업으로 링크 안내) | 'update'(조용히 반영 후 토스트)
async function pushShare(mode) {
  const btn = document.getElementById(mode === 'update' ? 'btn-update-share' : 'btn-make-share');
  // 공유 링크는 사진만 지원한다(동영상은 서버가 정지 이미지로만 저장돼 오해 소지). 동영상은 제외.
  const sharePhotos = allPhotos.filter((p) => p.type !== 'video');
  const excludedVideos = allPhotos.length - sharePhotos.length;
  if (!sharePhotos.length) { showToast('공유할 사진이 없습니다. (동영상은 공유 링크에 포함되지 않습니다)'); return; }
  const orig = btn.innerHTML;
  btn.disabled = true;
  btn.textContent = mode === 'update' ? '반영 중...' : '사진 저장 중... (사진이 많으면 시간이 걸립니다)';
  try {
    const musicUrl = document.getElementById('music-url').value.trim();
    // 공유 시점의 제목·전환 간격·전환 효과를 함께 저장해 공유 화면에도 동일 적용.
    const title = document.getElementById('title-input').value.trim();
    const intervalSec = Math.round(slideIntervalMs / 1000);
    let r;
    if (isSharedMode) {
      // 구글 포토 "공유"로 받은 사진은 구글 서버 baseUrl이 없고, 이 브라우저가 이미
      // 파일(blob)을 들고 있다. 구글에서 다시 받아오는 대신 그 파일을 그대로 올린다.
      const form = new FormData();
      const meta = [];
      for (const p of sharePhotos) {
        const blob = await fetch(p.fullUrl).then((res) => res.blob());
        const ext = blob.type === 'image/png' ? 'png' : 'jpg';
        form.append('files', blob, `${p.id}.${ext}`);
        meta.push({ createTime: p.createTime, width: p.width, height: p.height });
      }
      form.append('meta', JSON.stringify(meta));
      form.append('musicUrl', musicUrl);
      form.append('title', title);
      form.append('intervalSec', String(intervalSec));
      form.append('effect', slideEffect);
      r = await api('/api/share/blob', { method: 'POST', body: form });
    } else {
      const items = sharePhotos.map((p) => ({
        id: p.id, createTime: p.createTime, width: p.width, height: p.height, fullUrl: p.fullUrl,
      }));
      r = await api('/api/share', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ items, musicUrl, title, intervalSec, effect: slideEffect }),
      });
    }
    document.getElementById('share-url').value = r.url;
    document.getElementById('btn-open-share').href = r.url;
    // 링크가 생겼으면 "링크변경 반영" 버튼을 노출한다.
    document.getElementById('btn-update-share').classList.remove('hidden');
    if (mode === 'update') {
      showToast(`공유 링크에 반영되었습니다. (사진 ${r.count}장)`);
    } else {
      document.getElementById('share-copied').classList.add('hidden');
      shareModal.classList.remove('hidden');
      if (excludedVideos) showToast(`동영상 ${excludedVideos}개는 공유 링크에서 제외되었습니다.`);
    }
  } catch (err) {
    showToast((mode === 'update' ? '반영 실패: ' : '공유 링크 생성 실패: ') + err.message);
  } finally {
    btn.disabled = false;
    btn.innerHTML = orig;
  }
}

document.getElementById('btn-make-share').addEventListener('click', () => pushShare('create'));
document.getElementById('btn-update-share').addEventListener('click', () => pushShare('update'));

document.getElementById('btn-copy-share').addEventListener('click', async () => {
  const input = document.getElementById('share-url');
  try {
    await navigator.clipboard.writeText(input.value);
  } catch {
    input.select(); document.execCommand('copy'); // 폴백
  }
  document.getElementById('share-copied').classList.remove('hidden');
});
document.getElementById('btn-share-close').addEventListener('click', (e) => {
  e.preventDefault(); shareModal.classList.add('hidden');
});
shareModal.addEventListener('click', (e) => { if (e.target === shareModal) shareModal.classList.add('hidden'); });

document.getElementById('btn-revoke-share').addEventListener('click', async () => {
  if (!confirm('공유 링크를 지금 폐기할까요? 이후 이 링크로는 접속할 수 없습니다.')) return;
  const btn = document.getElementById('btn-revoke-share');
  btn.disabled = true;
  try {
    await api('/api/share', { method: 'DELETE' });
    shareModal.classList.add('hidden');
    document.getElementById('btn-update-share').classList.add('hidden'); // 반영할 링크가 없어짐
    showToast('공유 링크를 폐기했습니다.');
  } catch (err) {
    showToast('폐기 실패: ' + err.message);
  } finally {
    btn.disabled = false;
  }
});

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
document.getElementById('btn-logout').addEventListener('click', async (e) => {
  e.preventDefault();
  await api('/api/logout', { method: 'POST' }).catch(() => {});
  location.href = '/';
});

// ---------- 사진 제외 (체크박스 선택 삭제) ----------
function setExcludeMode(on) {
  excludeMode = on;
  excludeSel.clear();
  document.getElementById('exclude-count').textContent = '0';
  document.getElementById('exclude-actions').classList.toggle('hidden', !on);
  document.getElementById('btn-exclude').textContent = on ? '제외 취소' : '사진 제외';
  if (on && intervalHandle) clearInterval(intervalHandle); // 선택 중엔 슬라이드 정지
  renderPhotoList();
  if (!on) resetTimer();
}
document.getElementById('btn-exclude').addEventListener('click', (e) => {
  e.preventDefault();
  setExcludeMode(!excludeMode);
});
document.getElementById('btn-exclude-cancel').addEventListener('click', () => setExcludeMode(false));
document.getElementById('btn-exclude-apply').addEventListener('click', () => {
  if (!excludeSel.size) { setExcludeMode(false); return; }
  allPhotos = allPhotos.filter((p) => !excludeSel.has(p.id));
  excludeMode = false;
  excludeSel.clear();
  document.getElementById('exclude-actions').classList.add('hidden');
  document.getElementById('btn-exclude').textContent = '사진 제외';
  if (!allPhotos.length) { showToast('모든 사진이 제외되었습니다. 사진을 다시 선택해주세요.'); }
  recomputeFiltered();
});

// ---------- 데모 (계정 없이 보기) ----------
let isDemoMode = false;
let isSharedMode = false; // 구글 포토 "공유"로 사진을 받아 로그인 없이 보는 상태(PWA 공유 타깃)

async function startDemo() {
  try {
    const res = await fetch('/demo/photos.json');
    if (!res.ok) throw new Error(`데모 데이터를 불러오지 못했습니다 (${res.status})`);
    const data = await res.json();
    isDemoMode = true;
    if (data.musicUrl) document.getElementById('music-url').value = data.musicUrl;
    boot(data.items || []);
  } catch (err) {
    alert(err.message);
  }
}
document.getElementById('btn-demo').addEventListener('click', startDemo);

// ---------- 홈 메뉴 동작 (사진 선택 시작 / 로그아웃 / 피드백) ----------
document.getElementById('btn-start-picker').addEventListener('click', () => {
  if (!isLoggedIn) { selectPanel('login'); return; } // 로그인 먼저
  appendMode = false;
  startPickerFlow();
});
document.getElementById('btn-logout-home').addEventListener('click', async (e) => {
  e.preventDefault();
  await api('/api/logout', { method: 'POST' }).catch(() => {});
  location.href = '/';
});
document.getElementById('btn-feedback-send').addEventListener('click', () => {
  const txt = document.getElementById('feedback-text').value.trim();
  const subject = encodeURIComponent('Wepic Live Feedback');
  const body = encodeURIComponent(txt);
  window.location.href = `mailto:garzette@paran.com?subject=${subject}&body=${body}`;
});

// 슬라이드쇼 하단의 "홈페이지로 가기"(데모/공유 모드)
document.getElementById('btn-demo-home').addEventListener('click', (e) => {
  e.preventDefault();
  location.href = '/';
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
function applyTitle(text) {
  const ov = document.getElementById('title-overlay');
  ov.textContent = text;
  const has = !!text.trim();
  ov.classList.toggle('hidden', !has);
  document.body.classList.toggle('has-title', has);
  lsSet('slideTitle', text);
}

// 배경음악을 "동영상 재생용"으로 잠시 정지 (재생 중일 때만). 나중에 복귀할 수 있게 표시.
function pauseMusicForVideo() {
  if (musicPlaying && ytPlayer) {
    try { ytPlayer.pauseVideo(); } catch {}
    musicPausedForVideo = true;
  }
}
// 동영상 때문에 정지했던 배경음악을 다시 재생.
function resumeMusicAfterVideo() {
  if (musicPausedForVideo && ytPlayer) {
    try { ytPlayer.playVideo(); } catch {}
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
  const title = lsGet('slideTitle', '');
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

// ---------- 부팅 ----------
function boot(photos) {
  allPhotos = photos;
  currentIndex = 0;
  // 방향 필터는 새로 시작할 때 항상 전체보기로 초기화
  orientationMode = 'all';
  const allRadio = document.querySelector('#orientation-radios input[value="all"]');
  if (allRadio) allRadio.checked = true;
  // 데모·공유 유입은 로그인 없이 보는 "게스트" 상태
  const guest = isDemoMode || isSharedMode;
  if (!guest) {
    // 이전에 직접 설정한 곡이 있으면 그것을, 없으면 기본 곡을 채운다.
    const saved = (() => { try { return localStorage.getItem('bgMusicUrl'); } catch { return null; } })();
    document.getElementById('music-url').value = saved || DEFAULT_MUSIC_URL;
  }
  document.getElementById('demo-badge').classList.toggle('hidden', !isDemoMode);
  document.getElementById('account-links').classList.toggle('hidden', guest);
  document.getElementById('demo-links').classList.toggle('hidden', !guest);
  // 사진 재선택 등은 로그인 사용자만 가능(게스트는 토큰이 없어 불가)하지만, 실시간 공유
  // 링크는 구글 포토 "공유"로 받은 사진(isSharedMode)의 경우 브라우저가 이미 파일을 들고
  // 있어 로그인 없이도 만들 수 있다(/api/share/blob). 샘플 데모 사진만 제외.
  document.getElementById('share-block').classList.toggle('hidden', isDemoMode);
  loadDisplaySettings();
  showSlideshow();
  recomputeFiltered();
}

let loggedInName = null;
let isLoggedIn = false;

// 로그인 상태를 홈의 로그인/사진 패널에 반영 (자동 진입은 하지 않음)
function applyLoginState(status) {
  isLoggedIn = !!status.loggedIn;
  // 이전에 만든 공유 링크가 있으면 "링크변경 반영"을 바로 쓸 수 있게 노출
  if (status.hasShare) document.getElementById('btn-update-share').classList.remove('hidden');
  loggedInName = isLoggedIn ? (status.name || status.email || null) : null;
  const btnLogin = document.getElementById('btn-login');
  const loginActions = document.getElementById('login-actions');
  const loginStatus = document.getElementById('login-status');
  const photosNote = document.getElementById('photos-login-note');
  if (isLoggedIn) {
    btnLogin.classList.add('hidden');
    loginActions.classList.remove('hidden');
    loginStatus.textContent = `✓ ${loggedInName || '내 계정'}으로 로그인됨`;
    loginStatus.classList.remove('hidden');
    photosNote.classList.add('hidden');
  } else {
    btnLogin.classList.remove('hidden');
    loginActions.classList.add('hidden');
    loginStatus.classList.add('hidden');
    photosNote.classList.remove('hidden');
  }
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
      createTime: new Date(m.lastModified || Date.now()).toISOString(),
      width: null, height: null,
      fullUrl: objUrl, thumbUrl: objUrl,
    };
    if (type === 'video') it.videoUrl = objUrl;
    items.push(it);
  }
  // 파일 수정시각(촬영시각 근사) 오름차순 — 앱 전반 정렬 규칙과 동일
  items.sort((a, b) => new Date(a.createTime) - new Date(b.createTime));
  return items;
}

async function init() {
  const params = new URLSearchParams(location.search);

  // 1) 구글 포토 "공유"로 들어온 경우: 곧바로 슬라이드쇼
  if (params.has('shared')) {
    history.replaceState(null, '', '/');
    let shared = null;
    try { shared = await loadSharedMedia(); } catch { /* 무시 */ }
    if (shared && shared.length) { isSharedMode = true; boot(shared); return; }
    if (params.get('shared') === 'empty') alert('공유된 사진을 찾지 못했습니다.');
  }

  // 2) 로그인 상태 확인 → 홈의 로그인/사진 패널에 반영 (자동 진입 없음: 항상 홈부터)
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
    showHome(); // 홈(소개) 화면을 먼저 보여주고, 사용자가 메뉴로 진입
  }
}

// PWA 서비스워커 등록 (공유 타깃 수신용). 실패해도 앱 기능에는 영향 없음.
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => navigator.serviceWorker.register('/sw.js').catch(() => {}));
}

init();
