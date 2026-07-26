/**
 * Wepic Live - 웹 버전 백엔드
 *
 * 브라우저에 클라이언트 시크릿·토큰을 노출하지 않기 위해, OAuth 토큰 교환과
 * 구글 API 호출을 모두 이 서버에서 처리한다. 브라우저는 세션 쿠키만 들고
 * /api/* 엔드포인트를 호출하며, 실제 토큰은 서버 세션에만 보관된다.
 *
 * 필요 환경변수 (.env 또는 실행 시 지정):
 *   GOOGLE_CLIENT_ID     - 웹 애플리케이션 OAuth 클라이언트 ID
 *   GOOGLE_CLIENT_SECRET - 그 클라이언트의 시크릿
 *   BASE_URL             - 이 서버의 공개 주소 (기본 http://localhost:3000)
 *   SESSION_SECRET       - 세션 쿠키 서명 키 (미지정 시 임시값)
 *   PORT                 - 포트 (기본 3000)
 */

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const express = require('express');
const session = require('express-session');
const FileStore = require('session-file-store')(session);
const QRCode = require('qrcode');
const multer = require('multer');

const PORT = process.env.PORT || 3000;
const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;
const CLIENT_ID = process.env.GOOGLE_CLIENT_ID || '';
const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || '';
const REDIRECT_URI = `${BASE_URL}/auth/callback`;
const SCOPE = 'email profile https://www.googleapis.com/auth/photospicker.mediaitems.readonly';
// HTTPS 배포(Render 등)에서는 secure 쿠키를 쓴다. BASE_URL이 https이면 자동 감지.
const IS_HTTPS = BASE_URL.startsWith('https://');

const PICKER_BASE = 'https://photospicker.googleapis.com/v1';
const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';

// 공유 링크용 사진 저장 폴더 (public 하위 → /shares/<id>/... 로 정적 서빙)
const SHARES_DIR = path.join(__dirname, 'public', 'shares');
fs.mkdirSync(SHARES_DIR, { recursive: true });

// wepic 관리자: 아래 이메일로 로그인한 사용자에게만 Admin 메뉴/API를 허용한다.
// 쉼표로 여러 개 지정 가능 (환경변수 ADMIN_EMAILS).
const ADMIN_EMAILS = (process.env.ADMIN_EMAILS || 'garzette@gmail.com')
  .split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
const isAdminEmail = (email) => !!email && ADMIN_EMAILS.includes(String(email).toLowerCase());

// Default 정보관리(전역 설정) 저장 파일. 값이 하나뿐이라 DB 없이 JSON 파일로 충분하다.
// (주의: Render 무료 플랜은 디스크가 임시라 재배포 시 초기화된다 → Cloudflare는 KV 사용)
const SETTINGS_FILE = path.join(__dirname, 'settings.json');
const DEFAULT_SETTINGS = { title: '', musicUrl: '', titleFont: 'cursive', titleSize: 'medium' };
const TITLE_FONTS = ['cursive', 'handwriting-ko', 'sans', 'serif'];
const TITLE_SIZES = ['small', 'medium', 'large'];

function readSettings() {
  try { return { ...DEFAULT_SETTINGS, ...JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8')) }; }
  catch { return { ...DEFAULT_SETTINGS }; }
}
function writeSettings(patch) {
  const cur = readSettings();
  const next = {
    title: typeof patch.title === 'string' ? patch.title.slice(0, 40) : cur.title,
    musicUrl: typeof patch.musicUrl === 'string' ? patch.musicUrl.slice(0, 300) : cur.musicUrl,
    titleFont: TITLE_FONTS.includes(patch.titleFont) ? patch.titleFont : cur.titleFont,
    titleSize: TITLE_SIZES.includes(patch.titleSize) ? patch.titleSize : cur.titleSize,
  };
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(next, null, 2));
  return next;
}

// 공유 열람용 PIN: 4자리 숫자. 쿠키에는 PIN 자체가 아니라 HMAC 토큰을 담는다.
const genPin = () => String(crypto.randomInt(0, 10000)).padStart(4, '0');
const normalizePin = (v) => (/^\d{4}$/.test(String(v || '').trim()) ? String(v).trim() : null);
function pinToken(id, pin) {
  const secret = process.env.SESSION_SECRET || 'memory-frame-dev-secret-change-me';
  return crypto.createHmac('sha256', secret).update(`${id}:${pin}`).digest('base64url').slice(0, 32);
}
const pinCookieName = (id) => `sp_${id}`;

// ---------- 세션당 액자(다중 액자) ----------
// 한 세션이 여러 액자(shareId)를 동시에 만들고, 각각을 계속 갱신하며 운영할 수 있게 한다.
// 옛 버전은 세션당 shareId 하나만 있었다 — 그런 세션을 만나면 액자 1개로 자동 이전한다.
function ensureFrames(req) {
  if (!Array.isArray(req.session.frames)) req.session.frames = [];
  if (req.session.shareId && !req.session.frames.some((f) => f.id === req.session.shareId)) {
    req.session.frames.push({ id: req.session.shareId, name: '액자 1' });
    if (!req.session.currentFrameId) req.session.currentFrameId = req.session.shareId;
  }
  delete req.session.shareId; // frames로 완전히 이전
  if (req.session.currentFrameId && !req.session.frames.some((f) => f.id === req.session.currentFrameId)) {
    req.session.currentFrameId = req.session.frames[0]?.id || null;
  }
  if (!req.session.currentFrameId && req.session.frames.length) {
    req.session.currentFrameId = req.session.frames[0].id;
  }
}
function frameNameOf(req, id) {
  return (req.session.frames || []).find((f) => f.id === id)?.name || '';
}
// 액자 하나의 요약 정보(선택 UI·관리자 목록용)
function frameInfo(req, f) {
  const m = readShareManifest(f.id);
  return {
    id: f.id,
    name: f.name,
    isCurrent: req.session.currentFrameId === f.id,
    hasContent: !!m,
    title: m?.title || '',
    pin: m?.pin || null,
    count: m?.items?.length || 0,
    thumbUrl: m?.items?.[0]?.thumbUrl || null,
    url: m ? `${BASE_URL}/f/${f.id}` : null,
    updatedAt: m?.updatedAt || null,
    expiresAt: m?.expiresAt || null,
    expired: m ? isShareExpired(m) : false,
  };
}

const app = express();
app.use(express.json({ limit: '4mb' })); // 공유 생성 시 사진 목록(메타데이터) 전송 대비

// Render 등은 앞단 프록시(HTTPS 종단)를 통해 요청이 들어온다. 이 설정이 있어야
// Express가 원 요청을 HTTPS로 인식해 secure 쿠키가 정상 발급된다.
if (IS_HTTPS) app.set('trust proxy', 1);

app.use(
  session({
    // 세션을 파일에 저장한다. 무료 호스팅이 15분 유휴 후 재시작해도 로그인이
    // 유지된다(메모리 저장 시엔 재시작마다 재로그인 필요). ./sessions 폴더에 저장.
    store: new FileStore({ path: path.join(__dirname, 'sessions'), retries: 1, ttl: 30 * 24 * 60 * 60 }),
    secret: process.env.SESSION_SECRET || 'memory-frame-dev-secret-change-me',
    resave: false,
    saveUninitialized: false,
    cookie: {
      maxAge: 30 * 24 * 60 * 60 * 1000, // 30일
      httpOnly: true,
      secure: IS_HTTPS,
      sameSite: 'lax', // OAuth 리디렉션(구글 → 콜백) 시 쿠키가 유지되도록
    },
  })
);

if (!CLIENT_ID || !CLIENT_SECRET) {
  console.warn('\n[경고] GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET 환경변수가 설정되지 않았습니다.');
  console.warn('       web/README.md의 설정 방법을 참고하세요.\n');
}

// ---------- 토큰 관리 ----------

async function exchangeCode(code) {
  const body = new URLSearchParams({
    client_id: CLIENT_ID,
    client_secret: CLIENT_SECRET,
    code,
    grant_type: 'authorization_code',
    redirect_uri: REDIRECT_URI,
  });
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  if (!res.ok) throw new Error(`토큰 교환 실패 (${res.status}): ${await res.text()}`);
  return res.json();
}

async function refreshToken(refresh) {
  const body = new URLSearchParams({
    client_id: CLIENT_ID,
    client_secret: CLIENT_SECRET,
    refresh_token: refresh,
    grant_type: 'refresh_token',
  });
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  if (!res.ok) throw new Error(`토큰 갱신 실패 (${res.status}): ${await res.text()}`);
  return res.json();
}

// 세션에서 유효한 access token을 확보한다 (만료 임박 시 자동 갱신).
async function getAccessToken(req) {
  const t = req.session.tokens;
  if (!t) throw new Error('NOT_LOGGED_IN');
  if (Date.now() < t.expiresAt - 60_000) return t.accessToken;
  if (!t.refreshToken) throw new Error('NOT_LOGGED_IN');
  const data = await refreshToken(t.refreshToken);
  t.accessToken = data.access_token;
  t.expiresAt = Date.now() + data.expires_in * 1000;
  return t.accessToken;
}

function requireLogin(handler) {
  return async (req, res) => {
    try {
      const token = await getAccessToken(req);
      await handler(req, res, token);
    } catch (err) {
      if (err.message === 'NOT_LOGGED_IN') return res.status(401).json({ error: '로그인이 필요합니다.' });
      console.error(err);
      res.status(500).json({ error: err.message });
    }
  };
}

// ---------- OAuth ----------

app.get('/auth/login', (req, res) => {
  const url = new URL(AUTH_URL);
  url.searchParams.set('client_id', CLIENT_ID);
  url.searchParams.set('redirect_uri', REDIRECT_URI);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', SCOPE);
  url.searchParams.set('access_type', 'offline');
  // select_account: 구글이 이전 세션을 재사용해 자동으로 로그인해버리지 않고,
  // 계정 선택 화면을 항상 띄우게 한다. ("계정 다시 연결하기"가 다른 계정으로
  // 전환되도록 하려면 필수)
  url.searchParams.set('prompt', 'select_account consent');
  res.redirect(url.toString());
});

app.get('/auth/callback', async (req, res) => {
  const { code, error } = req.query;
  if (error) return res.redirect('/?auth_error=' + encodeURIComponent(error));
  if (!code) return res.redirect('/?auth_error=no_code');
  try {
    const data = await exchangeCode(code);

    // 구글의 "개별 권한 동의" 화면에서 사용자가 사진 선택 권한 체크박스를 빼먹으면,
    // 로그인 자체는 성공하지만 이후 사진 선택 단계에서야 스코프 부족 에러(403)로
    // 터진다. 로그인 시점에 바로 확인해서, 그런 경우 여기서 명확히 안내하고
    // 세션을 만들지 않는다 (사진 접근이 안 되는 반쪽짜리 로그인 방지).
    const grantedScopes = (data.scope || '').split(' ');
    if (!grantedScopes.includes('https://www.googleapis.com/auth/photospicker.mediaitems.readonly')) {
      return res.redirect('/?auth_error=missing_photos_scope');
    }

    // 사진 선택(Picker) 세션은 이 계정의 권한으로만 완료할 수 있다. 다른 계정으로
    // QR/링크를 열면 선택이 되지 않으므로, 화면에 표시해 사용자가 헷갈리지 않게 한다.
    const profile = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
      headers: { Authorization: `Bearer ${data.access_token}` },
    }).then((r) => (r.ok ? r.json() : null)).catch(() => null);

    req.session.tokens = {
      accessToken: data.access_token,
      refreshToken: data.refresh_token,
      expiresAt: Date.now() + data.expires_in * 1000,
      email: profile?.email || null,
      name: profile?.name || null,
    };
    res.redirect('/');
  } catch (err) {
    console.error(err);
    res.redirect('/?auth_error=' + encodeURIComponent(err.message));
  }
});

app.post('/api/logout', (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

// ---------- 상태 ----------

app.get('/api/status', (req, res) => {
  ensureFrames(req);
  const loggedIn = !!(req.session.tokens && req.session.tokens.refreshToken);
  const email = loggedIn ? req.session.tokens.email || null : null;
  const manifest = req.session.currentFrameId ? readShareManifest(req.session.currentFrameId) : null;
  res.json({
    loggedIn,
    email,
    name: loggedIn ? req.session.tokens.name || null : null,
    // 이미 만들어 둔 공유 링크(현재 선택된 액자)가 있으면 "링크변경 반영" 버튼을 바로 노출
    hasShare: !!manifest,
    sharePin: manifest ? manifest.pin || null : null, // 현재 액자의 PIN(메인화면 표시용)
    isAdmin: loggedIn && isAdminEmail(email),         // Admin 메뉴 노출 여부
  });
});

// ---------- 세션당 액자(다중 액자) 관리 ----------
app.get('/api/frames', (req, res) => {
  ensureFrames(req);
  res.json({
    frames: req.session.frames.map((f) => frameInfo(req, f)),
    currentFrameId: req.session.currentFrameId || null,
  });
});

app.post('/api/frames', (req, res) => {
  ensureFrames(req);
  const name = (typeof req.body?.name === 'string' && req.body.name.trim().slice(0, 30))
    || `액자 ${req.session.frames.length + 1}`;
  const id = crypto.randomBytes(9).toString('base64url');
  req.session.frames.push({ id, name });
  req.session.currentFrameId = id;
  res.json({
    frame: frameInfo(req, { id, name }),
    frames: req.session.frames.map((f) => frameInfo(req, f)),
    currentFrameId: id,
  });
});

app.put('/api/frames/:id', (req, res) => {
  ensureFrames(req);
  const f = req.session.frames.find((x) => x.id === req.params.id);
  if (!f) return res.status(404).json({ error: '없는 액자입니다.' });
  const name = typeof req.body?.name === 'string' ? req.body.name.trim().slice(0, 30) : '';
  if (!name) return res.status(400).json({ error: '이름을 입력하세요.' });
  f.name = name;
  res.json({ ok: true, frame: frameInfo(req, f) });
});

app.post('/api/frames/:id/select', (req, res) => {
  ensureFrames(req);
  let f = req.session.frames.find((x) => x.id === req.params.id);
  if (!f) {
    // 관리자는 다른 세션이 만든 액자도 wepic 메인화면에서 그대로 이어서 관리할 수 있도록,
    // "wepic 메인화면 열기" 진입 시 자기 액자 목록에 편입시킨 뒤 선택한다.
    if (!isAdminEmail(req.session.tokens?.email)) return res.status(404).json({ error: '없는 액자입니다.' });
    const m = readShareManifest(req.params.id);
    if (!m) return res.status(404).json({ error: '없는 액자입니다.' });
    f = { id: req.params.id, name: m.frameName || m.title || '관리자로 연 액자' };
    req.session.frames.push(f);
  }
  req.session.currentFrameId = f.id;
  res.json({ ok: true, currentFrameId: f.id });
});

// 액자 삭제: 폴더(사진·매니페스트)까지 완전히 지우고 목록에서도 제거한다.
app.delete('/api/frames/:id', (req, res) => {
  ensureFrames(req);
  const idx = req.session.frames.findIndex((x) => x.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: '없는 액자입니다.' });
  deleteShareDir(req.params.id);
  req.session.frames.splice(idx, 1);
  if (req.session.currentFrameId === req.params.id) {
    req.session.currentFrameId = req.session.frames[0]?.id || null;
  }
  res.json({
    ok: true,
    currentFrameId: req.session.currentFrameId,
    frames: req.session.frames.map((f) => frameInfo(req, f)),
  });
});

// ---------- Default 정보관리 (전역 설정) ----------
// 모든 화면(데모·wepic 메인화면·wepic 공유화면)이 로딩 시 이 값을 먼저 읽어 적용한다.
app.get('/api/settings', (req, res) => res.json(readSettings()));

// 관리자 전용 가드
function requireAdmin(handler) {
  return (req, res) => {
    const loggedIn = !!(req.session.tokens && req.session.tokens.refreshToken);
    const email = loggedIn ? req.session.tokens.email : null;
    if (!loggedIn) return res.status(401).json({ error: '로그인이 필요합니다.' });
    if (!isAdminEmail(email)) return res.status(403).json({ error: '관리자만 사용할 수 있습니다.' });
    return handler(req, res);
  };
}

app.put('/api/admin/settings', requireAdmin((req, res) => {
  res.json(writeSettings(req.body || {}));
}));

// ---------- Picker API 프록시 ----------

// 업스트림(구글) 실패를 사용자에게 읽히는 메시지로 만든다. 본문이 비어 있으면 상태코드라도 보이게.
async function upstreamError(label, r) {
  let body = '';
  try { body = (await r.text()) || ''; } catch { /* 무시 */ }
  const brief = body.slice(0, 300).replace(/\s+/g, ' ').trim();
  return `${label} 실패 (Google ${r.status})${brief ? ': ' + brief : ' — 응답 본문 없음'}`;
}

app.post(
  '/api/picker/session',
  requireLogin(async (req, res, token) => {
    const r = await fetch(`${PICKER_BASE}/sessions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    if (!r.ok) return res.status(r.status).json({ error: await upstreamError('사진 선택 세션 생성', r) });
    const s = await r.json();
    const qrDataUrl = await QRCode.toDataURL(s.pickerUri);
    res.json({ id: s.id, pickerUri: s.pickerUri, qrDataUrl, pollingConfig: s.pollingConfig });
  })
);

app.get(
  '/api/picker/session/:id',
  requireLogin(async (req, res, token) => {
    const r = await fetch(`${PICKER_BASE}/sessions/${encodeURIComponent(req.params.id)}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!r.ok) return res.status(r.status).json({ error: await r.text() });
    const s = await r.json();
    res.json({ mediaItemsSet: !!s.mediaItemsSet, pollingConfig: s.pollingConfig });
  })
);

app.delete(
  '/api/picker/session/:id',
  requireLogin(async (req, res, token) => {
    await fetch(`${PICKER_BASE}/sessions/${encodeURIComponent(req.params.id)}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${token}` },
    }).catch(() => {});
    res.json({ ok: true });
  })
);

// 선택된 사진 목록. baseUrl은 그대로 노출하지 않고, 인증이 필요한 다운로드는
// /img 프록시를 거치도록 변환해서 내려준다.
app.get(
  '/api/picker/media',
  requireLogin(async (req, res, token) => {
    const sessionId = req.query.sessionId;
    if (!sessionId) return res.status(400).json({ error: 'sessionId 필요' });

    const items = [];
    let pageToken;
    do {
      const url = new URL(`${PICKER_BASE}/mediaItems`);
      url.searchParams.set('sessionId', sessionId);
      url.searchParams.set('pageSize', '100');
      if (pageToken) url.searchParams.set('pageToken', pageToken);
      const r = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
      if (!r.ok) return res.status(r.status).json({ error: await r.text() });
      const data = await r.json();
      (data.mediaItems || []).forEach((it) => {
        const base = it.mediaFile?.baseUrl;
        if (!base) return;
        const meta = it.mediaFile?.mediaFileMetadata || {};
        // 동영상 여부: Picker의 type(VIDEO) 또는 mimeType(video/*)로 판별.
        const isVideo = it.type === 'VIDEO' || /^video\//.test(it.mediaFile?.mimeType || '');
        const item = {
          id: it.id,
          createTime: it.createTime,
          type: isVideo ? 'video' : 'photo',
          width: Number(meta.width) || null,
          height: Number(meta.height) || null,
          // 동영상도 baseUrl에 크기 파라미터를 붙이면 정지 프레임(포스터) 이미지를 준다.
          fullUrl: `/img?u=${encodeURIComponent(base)}&sz=w1920-h1080`,
          thumbUrl: `/img?u=${encodeURIComponent(base)}&sz=w300-h300-c`,
        };
        // 실제 동영상 재생은 baseUrl에 '=dv'가 필요하며 인증이 걸려 있어 /video 프록시로 받는다.
        if (isVideo) item.videoUrl = `/video?u=${encodeURIComponent(base)}`;
        items.push(item);
      });
      pageToken = data.nextPageToken;
    } while (pageToken);

    // 촬영일 오름차순(가장 먼저 찍은 사진부터)으로 정렬
    items.sort((a, b) => new Date(a.createTime) - new Date(b.createTime));
    res.json({ items });
  })
);

// ?dl=<파일명> 이 오면 Content-Disposition: attachment 를 붙여 브라우저가 저장하게 만든다.
// (헤더 인젝션·경로 이탈을 막기 위해 개행·따옴표·슬래시를 제거하고 길이를 제한)
function setDownloadHeader(res, dl) {
  if (!dl) return;
  const safe = String(dl).replace(/[\r\n"\\/]/g, '').replace(/[^\w.\-()가-힣 ]/g, '').slice(0, 120);
  if (!safe) return;
  res.set('Content-Disposition', `attachment; filename="${safe}"; filename*=UTF-8''${encodeURIComponent(safe)}`);
}

// 이미지 프록시: baseUrl은 Authorization 헤더가 있어야 받을 수 있어 서버가 대신 받아 전달.
// 오픈 프록시가 되지 않도록 구글 사용자 콘텐츠 호스트만 허용한다.
app.get(
  '/img',
  requireLogin(async (req, res, token) => {
    const u = req.query.u;
    const sz = (req.query.sz || 'w800-h800').replace(/[^\w-]/g, '');
    if (!u) return res.status(400).send('missing url');
    let host;
    try { host = new URL(u).hostname; } catch { return res.status(400).send('bad url'); }
    if (!/(^|\.)googleusercontent\.com$/.test(host)) return res.status(403).send('forbidden host');

    const r = await fetch(`${u}=${sz}`, { headers: { Authorization: `Bearer ${token}` } });
    if (!r.ok) return res.status(r.status).send('image fetch failed');
    res.set('Content-Type', r.headers.get('content-type') || 'image/jpeg');
    res.set('Cache-Control', 'private, max-age=3000');
    res.set('X-Robots-Tag', 'noindex, nofollow');
    // ?dl=<파일명> 이 있으면 브라우저가 "저장"하도록 한다. blob 대신 이 실제 URL을 쓰면
    // 카카오톡 등 인앱 브라우저(WebView)의 다운로드 매니저도 파일을 받을 수 있다.
    setDownloadHeader(res, req.query.dl);
    const buf = Buffer.from(await r.arrayBuffer());
    res.send(buf);
  })
);

// 동영상 프록시: 인증이 필요한 '=dv'(원본 동영상) 다운로드를 서버가 대신 받아 전달.
// 브라우저의 Range 요청(탐색·부분 재생)을 그대로 구글로 전달하고 응답 상태·헤더를 넘겨준다.
// /img와 마찬가지로 구글 사용자 콘텐츠 호스트만 허용해 오픈 프록시가 되지 않게 한다.
app.get(
  '/video',
  requireLogin(async (req, res, token) => {
    const u = req.query.u;
    if (!u) return res.status(400).send('missing url');
    let host;
    try { host = new URL(u).hostname; } catch { return res.status(400).send('bad url'); }
    if (!/(^|\.)googleusercontent\.com$/.test(host)) return res.status(403).send('forbidden host');

    const headers = { Authorization: `Bearer ${token}` };
    if (req.headers.range) headers.Range = req.headers.range;
    const r = await fetch(`${u}=dv`, { headers });
    if (!r.ok && r.status !== 206) return res.status(r.status).send('video fetch failed');

    res.status(r.status);
    ['content-type', 'content-length', 'content-range', 'accept-ranges'].forEach((h) => {
      const v = r.headers.get(h);
      if (v) res.set(h, v);
    });
    if (!r.headers.get('accept-ranges')) res.set('Accept-Ranges', 'bytes');
    res.set('Cache-Control', 'private, max-age=3000');
    const buf = Buffer.from(await r.arrayBuffer());
    res.send(buf);
  })
);

// ---------- 실시간 공유 링크 ----------
// 로그인한 사용자가 현재 고른 사진을 서버에 실제 파일로 내려받아 저장하고,
// 로그인 없이 볼 수 있는 공개 링크(/f/<id>)를 만든다. 같은 사용자는 같은 id를
// 재사용하므로("실시간 공유링크"), 사진을 다시 골라 다시 만들면 같은 링크에 최신 사진이 반영된다.
//
// 링크는 생성 시점으로부터 SHARE_TTL_HOURS(기본 24시간) 뒤 자동 만료된다. 만료된 폴더는
// /f/:id 접근 시 즉시 지워지고, 그 외에도 주기적으로(cleanupExpiredShares) 정리된다.

const SHARE_TTL_MS = Math.max(1, Number(process.env.SHARE_TTL_HOURS) || 24) * 60 * 60 * 1000;
const MAX_SHARE_ITEMS = 60;
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024, files: MAX_SHARE_ITEMS },
});

function baseUrlFromImgPath(imgPath) {
  // fullUrl 예: "/img?u=<encoded baseUrl>&sz=w1920-h1080" → baseUrl 추출
  try {
    const u = new URL(imgPath, 'http://x').searchParams.get('u');
    if (!u) return null;
    const host = new URL(u).hostname;
    if (!/(^|\.)googleusercontent\.com$/.test(host)) return null;
    return u;
  } catch { return null; }
}

async function downloadImage(baseUrl, sz, token) {
  const r = await fetch(`${baseUrl}=${sz}`, { headers: { Authorization: `Bearer ${token}` } });
  if (!r.ok) throw new Error(`image fetch ${r.status}`);
  return Buffer.from(await r.arrayBuffer());
}

function shareDir(id) {
  return path.join(SHARES_DIR, id);
}

function writeShareManifest(id, data) {
  fs.writeFileSync(
    path.join(shareDir(id), 'photos.json'),
    JSON.stringify(
      { ...data, updatedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + SHARE_TTL_MS).toISOString() },
      null,
      2
    )
  );
}

function readShareManifest(id) {
  try {
    return JSON.parse(fs.readFileSync(path.join(shareDir(id), 'photos.json'), 'utf8'));
  } catch {
    return null;
  }
}

function isShareExpired(manifest) {
  return !manifest.expiresAt || Date.now() > new Date(manifest.expiresAt).getTime();
}

function deleteShareDir(id) {
  if (!/^[\w-]{6,}$/.test(id || '')) return;
  fs.rmSync(shareDir(id), { recursive: true, force: true });
}

// 서버 시작 시 + 매시간 만료된 공유 폴더를 정리한다 (링크를 다시 열어보지 않아도 정리됨).
function cleanupExpiredShares() {
  let ids;
  try { ids = fs.readdirSync(SHARES_DIR); } catch { return; }
  for (const id of ids) {
    const manifest = readShareManifest(id);
    if (manifest && isShareExpired(manifest)) deleteShareDir(id);
  }
}
cleanupExpiredShares();
setInterval(cleanupExpiredShares, 60 * 60 * 1000);

app.post(
  '/api/share',
  requireLogin(async (req, res, token) => {
    ensureFrames(req);
    const items = Array.isArray(req.body.items) ? req.body.items : [];
    const musicUrl = typeof req.body.musicUrl === 'string' ? req.body.musicUrl : '';
    // 공유 화면에도 동일하게 적용할 제목·전환 간격·전환 효과 (값이 없거나 이상하면 기본값).
    const title = typeof req.body.title === 'string' ? req.body.title.slice(0, 40) : '';
    const intervalSec = Math.min(60, Math.max(3, Number(req.body.intervalSec) || 10));
    const effect = ['fade', 'slide', 'kenburns'].includes(req.body.effect) ? req.body.effect : 'fade';
    if (!items.length) return res.status(400).json({ error: '공유할 사진이 없습니다.' });

    // "현재 액자"에 저장한다(세션당 여러 액자를 각각 독립적으로 갱신할 수 있다).
    // 아직 액자가 하나도 없으면(첫 공유) 자동으로 하나 만든다.
    if (!req.session.currentFrameId) {
      const id = crypto.randomBytes(9).toString('base64url');
      req.session.frames.push({ id, name: `액자 ${req.session.frames.length + 1}` });
      req.session.currentFrameId = id;
    }
    const shareId = req.session.currentFrameId;
    const dir = shareDir(shareId);

    // 관리자가 이 액자를 열어(/?frame=<id>) 기존 사진은 그대로 두고 몇 장만 추가/제외하는
    // 경우, 넘어온 항목 중 "이미 이 액자에 저장된 파일"은 구글에서 다시 받지 않고 그대로
    // 들고 온다(구글 base URL이 없어 재다운로드가 불가능하므로 폴더를 지우기 전에 미리 읽어둔다).
    const keepRe = new RegExp(`^/shares/${shareId}/photos/(\\d+)_(full)\\.(\\w+)$`);
    const kept = new Map();
    for (const it of items) {
      const m = keepRe.exec(it.fullUrl || '');
      if (!m) continue;
      try {
        const full = fs.readFileSync(path.join(dir, 'photos', `${m[1]}_full.${m[3]}`));
        let thumb = null;
        try { thumb = fs.readFileSync(path.join(dir, 'photos', `${m[1]}_thumb.${m[3]}`)); } catch { /* 썸네일 없으면 원본으로 대체 */ }
        kept.set(it.fullUrl, { full, thumb, ext: m[3] });
      } catch { /* 파일이 이미 없으면 새로 받도록 건너뜀(아래에서 baseUrl이 없어 결국 제외됨) */ }
    }

    fs.rmSync(dir, { recursive: true, force: true }); // 이전 내용 제거 후 최신본으로 교체
    fs.mkdirSync(path.join(dir, 'photos'), { recursive: true });

    const manifestItems = [];
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      const n = String(i + 1).padStart(3, '0');
      const carry = kept.get(it.fullUrl);
      if (carry) {
        fs.writeFileSync(path.join(dir, 'photos', `${n}_full.${carry.ext}`), carry.full);
        if (carry.thumb) fs.writeFileSync(path.join(dir, 'photos', `${n}_thumb.${carry.ext}`), carry.thumb);
        manifestItems.push({
          id: it.id, createTime: it.createTime,
          width: it.width || null, height: it.height || null,
          fullUrl: `/shares/${shareId}/photos/${n}_full.${carry.ext}`,
          thumbUrl: carry.thumb ? `/shares/${shareId}/photos/${n}_thumb.${carry.ext}` : `/shares/${shareId}/photos/${n}_full.${carry.ext}`,
        });
        continue;
      }
      const base = baseUrlFromImgPath(it.fullUrl || '');
      if (!base) continue;
      try {
        const full = await downloadImage(base, 'w1920-h1080', token);
        const thumb = await downloadImage(base, 'w300-h300-c', token);
        fs.writeFileSync(path.join(dir, 'photos', `${n}_full.jpg`), full);
        fs.writeFileSync(path.join(dir, 'photos', `${n}_thumb.jpg`), thumb);
        manifestItems.push({
          id: it.id, createTime: it.createTime,
          width: it.width || null, height: it.height || null,
          fullUrl: `/shares/${shareId}/photos/${n}_full.jpg`,
          thumbUrl: `/shares/${shareId}/photos/${n}_thumb.jpg`,
        });
      } catch { /* 개별 실패는 건너뜀 */ }
    }
    if (!manifestItems.length) return res.status(500).json({ error: '사진을 저장하지 못했습니다. 다시 시도해주세요.' });

    manifestItems.sort((a, b) => new Date(a.createTime) - new Date(b.createTime));
    // PIN: 클라이언트가 보낸 값이 유효하면 그것(=링크변경 반영 시 수정된 PIN), 없으면
    // 기존 PIN을 유지하고, 그것도 없으면 새로 4자리 발급.
    const prev = readShareManifest(shareId);
    const pin = normalizePin(req.body.pin) || (prev && prev.pin) || genPin();
    const owner = req.session.tokens?.email || req.session.tokens?.name || null;
    const curFrameName = frameNameOf(req, shareId);
    writeShareManifest(shareId, { musicUrl, title, intervalSec, effect, pin, owner, frameName: curFrameName, items: manifestItems });
    res.json({ url: `${BASE_URL}/f/${shareId}`, count: manifestItems.length, pin, frameId: shareId, frameName: curFrameName });
  })
);

// 구글 계정 로그인 없이도(예: 구글 포토 "공유"로 받은 사진을 보는 화면) 브라우저가 이미
// 들고 있는 파일(blob)을 그대로 올려 같은 방식의 공유 링크를 만든다. 동영상은 공유 링크가
// 정지 이미지만 지원하므로 위 /api/share와 동일하게 사진만 저장한다.
app.post('/api/share/blob', upload.array('files', MAX_SHARE_ITEMS), (req, res) => {
  try {
    const files = req.files || [];
    if (!files.length) return res.status(400).json({ error: '공유할 사진이 없습니다.' });
    let meta = [];
    try { meta = JSON.parse(req.body.meta || '[]'); } catch { /* 형식 오류면 빈 메타로 진행 */ }
    const musicUrl = typeof req.body.musicUrl === 'string' ? req.body.musicUrl : '';
    const title = typeof req.body.title === 'string' ? req.body.title.slice(0, 40) : '';
    const intervalSec = Math.min(60, Math.max(3, Number(req.body.intervalSec) || 10));
    const effect = ['fade', 'slide', 'kenburns'].includes(req.body.effect) ? req.body.effect : 'fade';

    ensureFrames(req);
    if (!req.session.currentFrameId) {
      const newId = crypto.randomBytes(9).toString('base64url');
      req.session.frames.push({ id: newId, name: `액자 ${req.session.frames.length + 1}` });
      req.session.currentFrameId = newId;
    }
    const shareId = req.session.currentFrameId;

    const dir = shareDir(shareId);
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(path.join(dir, 'photos'), { recursive: true });

    const manifestItems = [];
    files.forEach((f, i) => {
      if (!/^image\//.test(f.mimetype || '')) return; // 사진만 지원 (동영상 제외)
      const m = meta[i] || {};
      const n = String(i + 1).padStart(3, '0');
      const ext = f.mimetype === 'image/png' ? 'png' : 'jpg';
      fs.writeFileSync(path.join(dir, 'photos', `${n}_full.${ext}`), f.buffer);
      manifestItems.push({
        id: `blob-${i}`,
        createTime: m.createTime || new Date().toISOString(),
        width: m.width || null, height: m.height || null,
        fullUrl: `/shares/${shareId}/photos/${n}_full.${ext}`,
        thumbUrl: `/shares/${shareId}/photos/${n}_full.${ext}`,
      });
    });
    if (!manifestItems.length) {
      return res.status(500).json({ error: '사진을 저장하지 못했습니다. (동영상은 공유 링크에 포함되지 않습니다)' });
    }

    manifestItems.sort((a, b) => new Date(a.createTime) - new Date(b.createTime));
    const prev = readShareManifest(shareId);
    const pin = normalizePin(req.body.pin) || (prev && prev.pin) || genPin();
    const owner = req.session.tokens?.email || req.session.tokens?.name || '(게스트)';
    const curFrameName = frameNameOf(req, shareId);
    writeShareManifest(shareId, { musicUrl, title, intervalSec, effect, pin, owner, frameName: curFrameName, items: manifestItems });
    res.json({ url: `${BASE_URL}/f/${shareId}`, count: manifestItems.length, pin, frameId: shareId, frameName: curFrameName });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// 공유 링크 즉시 폐기: 이 브라우저 세션이 만든 "현재 액자"의 링크를 지금 지운다.
// 로그인 여부와 무관하게(게스트가 만든 링크도 있으므로) 세션에 저장된 정보만으로 동작한다.
// 액자 자체를 목록에서 제거하므로, 삭제 후에는 남은 액자 중 하나(또는 없음)가 현재 액자가 된다.
app.delete('/api/share', (req, res) => {
  ensureFrames(req);
  const id = req.session.currentFrameId;
  if (id) {
    deleteShareDir(id);
    const idx = req.session.frames.findIndex((f) => f.id === id);
    if (idx !== -1) req.session.frames.splice(idx, 1);
    req.session.currentFrameId = req.session.frames[0]?.id || null;
  }
  res.json({ ok: true, currentFrameId: req.session.currentFrameId, frames: req.session.frames.map((f) => frameInfo(req, f)) });
});

// ---------- PIN 검증 ----------
function readCookies(req) {
  const out = {};
  (req.headers.cookie || '').split(';').forEach((p) => {
    const i = p.indexOf('=');
    if (i > 0) out[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim());
  });
  return out;
}
// 이 요청이 해당 공유를 볼 자격이 있는지. PIN이 없는 공유(기존 링크)는 그대로 통과.
function canViewShare(req, id, manifest) {
  if (!manifest || !manifest.pin) return true;                       // 하위 호환
  if (isAdminEmail(req.session?.tokens?.email)) return true;          // 관리자는 통과
  if ((req.session?.frames || []).some((f) => f.id === id)) return true; // 만든 본인(다중 액자)
  if (req.session?.shareId === id) return true;                       // 구버전 세션 안전망
  return readCookies(req)[pinCookieName(id)] === pinToken(id, manifest.pin);
}

// PIN 입력 → 맞으면 열람 쿠키 발급(24시간). 공유 화면이 재생 전에 호출한다.
app.post('/api/share/:id/verify-pin', (req, res) => {
  const id = req.params.id;
  if (!/^[\w-]{6,}$/.test(id)) return res.status(404).json({ error: '잘못된 링크입니다.' });
  const manifest = readShareManifest(id);
  if (!manifest) return res.status(404).json({ error: '공유 사진을 찾을 수 없습니다.' });
  if (!manifest.pin) return res.json({ ok: true }); // PIN 없는 공유
  const pin = normalizePin(req.body?.pin);
  if (!pin || pin !== manifest.pin) return res.status(403).json({ error: 'PIN 번호가 올바르지 않습니다.' });
  res.cookie(pinCookieName(id), pinToken(id, manifest.pin), {
    maxAge: 24 * 60 * 60 * 1000, httpOnly: true, secure: IS_HTTPS, sameSite: 'lax',
  });
  res.json({ ok: true });
});

// 공유 사진 파일(/shares/...): 검색엔진 색인 금지 + ?dl=<파일명> 이면 저장(attachment) +
// PIN이 걸린 공유는 열람 쿠키가 없으면 차단(화면에서만 막으면 URL 직접 접근으로 우회되므로
// 파일과 photos.json 자체를 서버에서 막아야 한다). express.static 보다 먼저 등록.
app.use('/shares', (req, res, next) => {
  res.set('X-Robots-Tag', 'noindex, nofollow');
  setDownloadHeader(res, req.query.dl);
  const id = (req.path || '').split('/').filter(Boolean)[0];
  if (id && /^[\w-]{6,}$/.test(id)) {
    const manifest = readShareManifest(id);
    if (manifest && manifest.pin && !canViewShare(req, id, manifest)) {
      return res.status(401).json({ error: 'PIN 번호가 필요합니다.', pinRequired: true });
    }
  }
  next();
});

// ---------- wepic 관리자 API ----------
// 화면관리: 공유(폴더) 목록. 폴더를 훑어 매니페스트를 읽는다(별도 DB 불필요).
app.get('/api/admin/shares', requireAdmin((req, res) => {
  let ids = [];
  try { ids = fs.readdirSync(SHARES_DIR); } catch { /* 폴더 없음 */ }
  const shares = [];
  for (const id of ids) {
    const m = readShareManifest(id);
    if (!m) continue;
    shares.push({
      id,
      title: m.title || '',
      pin: m.pin || null,
      owner: m.owner || null,
      frameName: m.frameName || null,
      updatedAt: m.updatedAt || null,
      expiresAt: m.expiresAt || null,
      expired: isShareExpired(m),
      count: (m.items || []).length,
      thumbUrl: m.items?.[0]?.thumbUrl || null,
      url: `${BASE_URL}/f/${id}`,
    });
  }
  shares.sort((a, b) => new Date(b.updatedAt || 0) - new Date(a.updatedAt || 0));
  res.json({ shares });
}));

// 폴더 삭제
app.delete('/api/admin/shares/:id', requireAdmin((req, res) => {
  const id = req.params.id;
  if (!/^[\w-]{6,}$/.test(id)) return res.status(400).json({ error: '잘못된 id' });
  if (!readShareManifest(id)) return res.status(404).json({ error: '없는 공유입니다.' });
  deleteShareDir(id);
  res.json({ ok: true });
}));

// PIN 수정
app.put('/api/admin/shares/:id/pin', requireAdmin((req, res) => {
  const id = req.params.id;
  const pin = normalizePin(req.body?.pin);
  if (!/^[\w-]{6,}$/.test(id)) return res.status(400).json({ error: '잘못된 id' });
  if (!pin) return res.status(400).json({ error: 'PIN은 4자리 숫자여야 합니다.' });
  const m = readShareManifest(id);
  if (!m) return res.status(404).json({ error: '없는 공유입니다.' });
  // 만료시각을 유지하면서 PIN만 교체 (writeShareManifest는 만료를 새로 계산하므로 직접 기록)
  fs.writeFileSync(path.join(shareDir(id), 'photos.json'), JSON.stringify({ ...m, pin }, null, 2));
  res.json({ ok: true, pin });
}));

// 공개 보기 페이지 (로그인 불필요)
app.get('/f/:id', (req, res) => {
  res.set('X-Robots-Tag', 'noindex, nofollow');
  if (!/^[\w-]{6,}$/.test(req.params.id)) return res.status(404).send('잘못된 링크입니다.');
  const manifest = readShareManifest(req.params.id);
  if (!manifest) {
    return res.status(404).send('공유 사진을 찾을 수 없습니다. 링크가 만료되었거나 삭제되었을 수 있습니다.');
  }
  if (isShareExpired(manifest)) {
    deleteShareDir(req.params.id);
    return res.status(404).send('링크가 만료되었습니다. 공유한 분에게 새 링크를 요청해주세요.');
  }
  res.sendFile(path.join(__dirname, 'public', 'share.html'));
});

// PWA 공유 타깃 폴백: 정상적으로는 서비스워커(sw.js)가 이 POST를 가로채 처리한다.
// 서비스워커가 아직 활성화/제어 전인 드문 경우에도 에러 대신 홈으로 부드럽게 보낸다.
app.post('/share-target', (req, res) => res.redirect('/'));

// ---------- 정적 파일 ----------

app.use(express.static(path.join(__dirname, 'public')));

app.listen(PORT, () => {
  console.log(`\nWepic Live (웹) 실행 중: ${BASE_URL}`);
  console.log(`OAuth 리디렉션 URI: ${REDIRECT_URI}\n`);
});
