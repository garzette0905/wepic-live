// Wepic Live — Cloudflare Worker 백엔드 (web/server.js 포팅)
// 세션: Workers KV(SESSIONS) · 공유 파일: R2(SHARES) · 정적: ASSETS(web/public 복사본)
// 시크릿: GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, SESSION_SECRET
// 변수: BASE_URL, SHARE_TTL_HOURS
// (QR 코드는 CPU 제한 때문에 서버에서 만들지 않고 브라우저에서 생성한다 — pickerCreate 참고)

const SCOPE = 'email profile https://www.googleapis.com/auth/photospicker.mediaitems.readonly';
const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const USERINFO_URL = 'https://www.googleapis.com/oauth2/v3/userinfo';
const PICKER_BASE = 'https://photospicker.googleapis.com/v1';
const PHOTOS_SCOPE = 'https://www.googleapis.com/auth/photospicker.mediaitems.readonly';
const MAX_SHARE_ITEMS = 60;

// wepic 관리자: 이 이메일로 로그인한 사용자만 Admin 메뉴/API 사용 가능 (환경변수 ADMIN_EMAILS)
const adminEmails = (env) => (env.ADMIN_EMAILS || 'garzette@gmail.com')
  .split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
const isAdminEmail = (env, email) => !!email && adminEmails(env).includes(String(email).toLowerCase());

// Default 정보관리(전역 설정) — KV에 JSON 하나로 저장(DB 불필요)
const SETTINGS_KEY = 'settings:global';
const DEFAULT_SETTINGS = { title: '', musicUrl: '', titleFont: 'cursive', titleSize: 'medium' };
const TITLE_FONTS = ['cursive', 'handwriting-ko', 'sans', 'serif'];
const TITLE_SIZES = ['small', 'medium', 'large'];
async function readSettings(env) {
  try {
    const raw = await env.SESSIONS.get(SETTINGS_KEY);
    return raw ? { ...DEFAULT_SETTINGS, ...JSON.parse(raw) } : { ...DEFAULT_SETTINGS };
  } catch { return { ...DEFAULT_SETTINGS }; }
}
async function writeSettings(env, patch) {
  const cur = await readSettings(env);
  const next = {
    title: typeof patch.title === 'string' ? patch.title.slice(0, 40) : cur.title,
    musicUrl: typeof patch.musicUrl === 'string' ? patch.musicUrl.slice(0, 300) : cur.musicUrl,
    titleFont: TITLE_FONTS.includes(patch.titleFont) ? patch.titleFont : cur.titleFont,
    titleSize: TITLE_SIZES.includes(patch.titleSize) ? patch.titleSize : cur.titleSize,
  };
  await env.SESSIONS.put(SETTINGS_KEY, JSON.stringify(next));
  return next;
}

// 공유 열람용 PIN(4자리). 쿠키에는 PIN 대신 HMAC 토큰을 담는다.
function genPin() {
  const a = new Uint32Array(1);
  crypto.getRandomValues(a);
  return String(a[0] % 10000).padStart(4, '0');
}
const normalizePin = (v) => (/^\d{4}$/.test(String(v || '').trim()) ? String(v).trim() : null);
async function pinToken(env, id, pin) {
  const secret = env.SESSION_SECRET || 'memory-frame-dev-secret-change-me';
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${id}:${pin}`));
  return b64url(new Uint8Array(sig)).slice(0, 32);
}
const pinCookieName = (id) => `sp_${id}`;

// ---------- 공통 응답 헬퍼 ----------
const json = (obj, status = 200, headers = {}) =>
  new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', ...headers } });
const text = (body, status = 200, headers = {}) =>
  new Response(body, { status, headers: { 'Content-Type': 'text/plain; charset=utf-8', ...headers } });
const html = (body, status = 200) =>
  new Response(body, { status, headers: { 'Content-Type': 'text/html; charset=utf-8' } });
const redirect = (location, headers = {}) => new Response(null, { status: 302, headers: { Location: location, ...headers } });

// ---------- 쿠키 / 세션(KV) ----------
function parseCookies(request) {
  const out = {};
  (request.headers.get('Cookie') || '').split(';').forEach((p) => {
    const i = p.indexOf('=');
    if (i > 0) out[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim());
  });
  return out;
}
const sidCookie = (sid) => `sid=${sid}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${30 * 24 * 60 * 60}`;
const clearCookie = () => 'sid=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0';
function b64url(bytes) {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function randomId(bytes = 18) {
  const a = new Uint8Array(bytes);
  crypto.getRandomValues(a);
  return b64url(a);
}
async function getSession(request, env) {
  const sid = parseCookies(request).sid || null;
  if (!sid) return { sid: null, data: null };
  const raw = await env.SESSIONS.get('sess:' + sid);
  return { sid, data: raw ? JSON.parse(raw) : null };
}
const putSession = (env, sid, data) =>
  env.SESSIONS.put('sess:' + sid, JSON.stringify(data), { expirationTtl: 30 * 24 * 60 * 60 });
const delSession = (env, sid) => (sid ? env.SESSIONS.delete('sess:' + sid) : Promise.resolve());

// ---------- 토큰 ----------
async function tokenRequest(env, params) {
  const body = new URLSearchParams({ client_id: env.GOOGLE_CLIENT_ID, client_secret: env.GOOGLE_CLIENT_SECRET, ...params });
  const r = await fetch(TOKEN_URL, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body });
  if (!r.ok) throw new Error(`토큰 요청 실패 (${r.status}): ${await r.text()}`);
  return r.json();
}
// 세션에서 유효한 access token 확보(만료 임박 시 갱신 후 KV에 다시 저장). 실패 시 NOT_LOGGED_IN.
async function getAccessToken(env, sid, data) {
  if (!data || !data.refreshToken) throw new Error('NOT_LOGGED_IN');
  if (Date.now() < data.expiresAt - 60000) return data.accessToken;
  const d = await tokenRequest(env, { refresh_token: data.refreshToken, grant_type: 'refresh_token' });
  data.accessToken = d.access_token;
  data.expiresAt = Date.now() + d.expires_in * 1000;
  await putSession(env, sid, data);
  return data.accessToken;
}
// 로그인 필요한 핸들러 래퍼
async function requireLogin(request, env, handler) {
  const sess = await getSession(request, env);
  let token;
  try {
    token = await getAccessToken(env, sess.sid, sess.data);
  } catch (err) {
    if (err.message === 'NOT_LOGGED_IN') return json({ error: '로그인이 필요합니다.' }, 401);
    throw err;
  }
  return handler(request, env, token, sess);
}

// ---------- OAuth ----------
function authLogin(env) {
  const u = new URL(AUTH_URL);
  u.searchParams.set('client_id', env.GOOGLE_CLIENT_ID);
  u.searchParams.set('redirect_uri', env.BASE_URL + '/auth/callback');
  u.searchParams.set('response_type', 'code');
  u.searchParams.set('scope', SCOPE);
  u.searchParams.set('access_type', 'offline');
  u.searchParams.set('prompt', 'select_account consent');
  return redirect(u.toString());
}
async function authCallback(env, url) {
  const code = url.searchParams.get('code');
  const error = url.searchParams.get('error');
  if (error) return redirect('/?auth_error=' + encodeURIComponent(error));
  if (!code) return redirect('/?auth_error=no_code');
  try {
    const d = await tokenRequest(env, { code, grant_type: 'authorization_code', redirect_uri: env.BASE_URL + '/auth/callback' });
    const granted = (d.scope || '').split(' ');
    if (!granted.includes(PHOTOS_SCOPE)) return redirect('/?auth_error=missing_photos_scope');
    const profile = await fetch(USERINFO_URL, { headers: { Authorization: 'Bearer ' + d.access_token } })
      .then((r) => (r.ok ? r.json() : null))
      .catch(() => null);
    const sid = randomId();
    await putSession(env, sid, {
      accessToken: d.access_token,
      refreshToken: d.refresh_token || null,
      expiresAt: Date.now() + d.expires_in * 1000,
      email: profile?.email || null,
      name: profile?.name || null,
      shareId: null,
    });
    return redirect('/', { 'Set-Cookie': sidCookie(sid) });
  } catch (err) {
    return redirect('/?auth_error=' + encodeURIComponent(err.message));
  }
}
async function apiStatus(request, env) {
  const { data } = await getSession(request, env);
  const loggedIn = !!(data && data.refreshToken);
  // 이미 만들어 둔 공유 링크가 있으면 "링크변경 반영" 버튼을 바로 노출하기 위한 힌트
  const manifest = data && data.shareId ? await readManifest(env, data.shareId) : null;
  const email = loggedIn ? data.email || null : null;
  return json({
    loggedIn,
    email,
    name: loggedIn ? data.name || null : null,
    hasShare: !!manifest,
    sharePin: manifest ? manifest.pin || null : null, // 현재 공유의 PIN(메인화면 표시용)
    isAdmin: loggedIn && isAdminEmail(env, email),    // Admin 메뉴 노출 여부
  });
}
async function apiLogout(request, env) {
  const { sid } = await getSession(request, env);
  await delSession(env, sid);
  return json({ ok: true }, 200, { 'Set-Cookie': clearCookie() });
}

// 관리자 전용 가드
async function requireAdmin(request, env, handler) {
  const sess = await getSession(request, env);
  const loggedIn = !!(sess.data && sess.data.refreshToken);
  if (!loggedIn) return json({ error: '로그인이 필요합니다.' }, 401);
  if (!isAdminEmail(env, sess.data.email)) return json({ error: '관리자만 사용할 수 있습니다.' }, 403);
  return handler(request, env, sess);
}

// 화면관리: 공유(폴더) 목록 — R2 프리픽스를 훑어 매니페스트를 읽는다(별도 DB 불필요)
async function adminShares(env) {
  const shares = [];
  let cursor;
  do {
    const list = await env.SHARES.list({ cursor, delimiter: '/' });
    for (const pfx of list.delimitedPrefixes || []) {
      const id = pfx.replace(/\/$/, '');
      const m = await readManifest(env, id);
      if (!m) continue;
      shares.push({
        id,
        title: m.title || '',
        pin: m.pin || null,
        owner: m.owner || null,
        updatedAt: m.updatedAt || null,
        expiresAt: m.expiresAt || null,
        expired: isExpired(m),
        count: (m.items || []).length,
        thumbUrl: m.items?.[0]?.thumbUrl || null,
        url: `${env.BASE_URL}/f/${id}`,
      });
    }
    cursor = list.truncated ? list.cursor : null;
  } while (cursor);
  shares.sort((a, b) => new Date(b.updatedAt || 0) - new Date(a.updatedAt || 0));
  return json({ shares });
}

// PIN 수정 (만료시각은 유지하고 pin만 교체)
async function adminSetPin(request, env, id) {
  if (!/^[\w-]{6,}$/.test(id)) return json({ error: '잘못된 id' }, 400);
  const body = await request.json().catch(() => ({}));
  const pin = normalizePin(body.pin);
  if (!pin) return json({ error: 'PIN은 4자리 숫자여야 합니다.' }, 400);
  const m = await readManifest(env, id);
  if (!m) return json({ error: '없는 공유입니다.' }, 404);
  await env.SHARES.put(`${id}/photos.json`, JSON.stringify({ ...m, pin }, null, 2),
    { httpMetadata: { contentType: 'application/json; charset=utf-8' } });
  return json({ ok: true, pin });
}

// PIN 입력 → 맞으면 열람 쿠키 발급(24시간)
async function verifyPin(request, env, id) {
  if (!/^[\w-]{6,}$/.test(id)) return json({ error: '잘못된 링크입니다.' }, 404);
  const m = await readManifest(env, id);
  if (!m) return json({ error: '공유 사진을 찾을 수 없습니다.' }, 404);
  if (!m.pin) return json({ ok: true }); // PIN 없는 공유(기존 링크)
  const body = await request.json().catch(() => ({}));
  const pin = normalizePin(body.pin);
  if (!pin || pin !== m.pin) return json({ error: 'PIN 번호가 올바르지 않습니다.' }, 403);
  const tok = await pinToken(env, id, m.pin);
  return json({ ok: true }, 200, {
    'Set-Cookie': `${pinCookieName(id)}=${tok}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=86400`,
  });
}

// 이 요청이 해당 공유를 볼 자격이 있는지. PIN이 없는 공유(기존 링크)는 그대로 통과.
async function canViewShare(request, env, id, manifest) {
  if (!manifest || !manifest.pin) return true;                 // 하위 호환
  const sess = await getSession(request, env);
  if (isAdminEmail(env, sess.data?.email)) return true;         // 관리자 통과
  if (sess.data?.shareId === id) return true;                   // 만든 본인
  const want = await pinToken(env, id, manifest.pin);
  return parseCookies(request)[pinCookieName(id)] === want;
}

// ---------- Picker 프록시 ----------
// 업스트림(구글) 실패를 사용자에게 읽히는 메시지로 만든다. 본문이 비어 있으면 상태코드라도 보이게.
async function upstreamError(label, r) {
  let body = '';
  try { body = (await r.text()) || ''; } catch { /* 무시 */ }
  const brief = body.slice(0, 300).replace(/\s+/g, ' ').trim();
  return `${label} 실패 (Google ${r.status})${brief ? ': ' + brief : ' — 응답 본문 없음'}`;
}

async function pickerCreate(request, env, token) {
  const r = await fetch(`${PICKER_BASE}/sessions`, {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
    body: '{}',
  });
  if (!r.ok) return json({ error: await upstreamError('사진 선택 세션 생성', r) }, r.status === 401 ? 500 : r.status);
  const s = await r.json();
  // QR은 여기서 만들지 않는다: 무료 플랜의 요청당 CPU 10ms 한도를 QR 인코딩(10~30ms)이
  // 넘겨 Worker가 강제 종료되고, Cloudflare가 HTML 오류 페이지를 반환한다(try/catch로 못 잡음).
  // 대신 브라우저가 pickerUri로 직접 생성한다(web/public/vendor/qr.js).
  return json({ id: s.id, pickerUri: s.pickerUri, qrDataUrl: '', pollingConfig: s.pollingConfig });
}
async function pickerPoll(env, token, id) {
  const r = await fetch(`${PICKER_BASE}/sessions/${encodeURIComponent(id)}`, { headers: { Authorization: 'Bearer ' + token } });
  if (!r.ok) return json({ error: await r.text() }, r.status);
  const s = await r.json();
  return json({ mediaItemsSet: !!s.mediaItemsSet, pollingConfig: s.pollingConfig });
}
async function pickerDelete(env, token, id) {
  await fetch(`${PICKER_BASE}/sessions/${encodeURIComponent(id)}`, {
    method: 'DELETE',
    headers: { Authorization: 'Bearer ' + token },
  }).catch(() => {});
  return json({ ok: true });
}
async function pickerMedia(env, token, url) {
  const sessionId = url.searchParams.get('sessionId');
  if (!sessionId) return json({ error: 'sessionId 필요' }, 400);
  const items = [];
  let pageToken;
  do {
    const u = new URL(`${PICKER_BASE}/mediaItems`);
    u.searchParams.set('sessionId', sessionId);
    u.searchParams.set('pageSize', '100');
    if (pageToken) u.searchParams.set('pageToken', pageToken);
    const r = await fetch(u, { headers: { Authorization: 'Bearer ' + token } });
    if (!r.ok) return json({ error: await r.text() }, r.status);
    const data = await r.json();
    (data.mediaItems || []).forEach((it) => {
      const base = it.mediaFile?.baseUrl;
      if (!base) return;
      const meta = it.mediaFile?.mediaFileMetadata || {};
      const isVideo = it.type === 'VIDEO' || /^video\//.test(it.mediaFile?.mimeType || '');
      const item = {
        id: it.id,
        createTime: it.createTime,
        type: isVideo ? 'video' : 'photo',
        width: Number(meta.width) || null,
        height: Number(meta.height) || null,
        fullUrl: `/img?u=${encodeURIComponent(base)}&sz=w1920-h1080`,
        thumbUrl: `/img?u=${encodeURIComponent(base)}&sz=w300-h300-c`,
      };
      if (isVideo) item.videoUrl = `/video?u=${encodeURIComponent(base)}`;
      items.push(item);
    });
    pageToken = data.nextPageToken;
  } while (pageToken);
  items.sort((a, b) => new Date(a.createTime) - new Date(b.createTime));
  return json({ items });
}

// ---------- 이미지 / 동영상 프록시 ----------
function allowedHost(u) {
  try { return /(^|\.)googleusercontent\.com$/.test(new URL(u).hostname); } catch { return false; }
}
// ?dl=<파일명> 이면 Content-Disposition: attachment 를 붙여 브라우저가 저장하게 만든다.
// (헤더 인젝션·경로 이탈 방지를 위해 개행·따옴표·슬래시 제거 + 길이 제한)
function setDownloadHeader(headers, dl) {
  if (!dl) return;
  const safe = String(dl).replace(/[\r\n"\\/]/g, '').replace(/[^\w.\-()가-힣 ]/g, '').slice(0, 120);
  if (!safe) return;
  headers.set('Content-Disposition', `attachment; filename="${safe}"; filename*=UTF-8''${encodeURIComponent(safe)}`);
}
async function imgProxy(env, token, url) {
  const u = url.searchParams.get('u');
  const sz = (url.searchParams.get('sz') || 'w800-h800').replace(/[^\w-]/g, '');
  if (!u) return text('missing url', 400);
  if (!allowedHost(u)) return text('forbidden host', 403);
  const r = await fetch(`${u}=${sz}`, { headers: { Authorization: 'Bearer ' + token } });
  if (!r.ok) return text('image fetch failed', r.status);
  const h = new Headers({
    'Content-Type': r.headers.get('content-type') || 'image/jpeg',
    'Cache-Control': 'private, max-age=3000',
    'X-Robots-Tag': 'noindex, nofollow',
  });
  setDownloadHeader(h, url.searchParams.get('dl'));
  return new Response(r.body, { status: 200, headers: h });
}
async function videoProxy(request, env, token, url) {
  const u = url.searchParams.get('u');
  if (!u) return text('missing url', 400);
  if (!allowedHost(u)) return text('forbidden host', 403);
  const headers = { Authorization: 'Bearer ' + token };
  const range = request.headers.get('Range');
  if (range) headers.Range = range;
  const r = await fetch(`${u}=dv`, { headers });
  if (!r.ok && r.status !== 206) return text('video fetch failed', r.status);
  const h = new Headers();
  ['content-type', 'content-length', 'content-range', 'accept-ranges'].forEach((k) => {
    const v = r.headers.get(k);
    if (v) h.set(k, v);
  });
  if (!r.headers.get('accept-ranges')) h.set('Accept-Ranges', 'bytes');
  h.set('Cache-Control', 'private, max-age=3000');
  return new Response(r.body, { status: r.status, headers: h });
}

// ---------- 공유(R2) ----------
const shareTtlMs = (env) => Math.max(1, Number(env.SHARE_TTL_HOURS) || 24) * 60 * 60 * 1000;
const isExpired = (m) => !m || !m.expiresAt || Date.now() > new Date(m.expiresAt).getTime();

async function writeManifest(env, id, data) {
  const body = JSON.stringify(
    { ...data, updatedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + shareTtlMs(env)).toISOString() },
    null,
    2
  );
  await env.SHARES.put(`${id}/photos.json`, body, { httpMetadata: { contentType: 'application/json; charset=utf-8' } });
}
async function readManifest(env, id) {
  const o = await env.SHARES.get(`${id}/photos.json`);
  if (!o) return null;
  try { return JSON.parse(await o.text()); } catch { return null; }
}
async function deleteShare(env, id) {
  if (!/^[\w-]{6,}$/.test(id || '')) return;
  const list = await env.SHARES.list({ prefix: id + '/' });
  if (list.objects.length) await env.SHARES.delete(list.objects.map((o) => o.key));
}
function baseUrlFromImgPath(imgPath) {
  try {
    const u = new URL(imgPath, 'http://x').searchParams.get('u');
    if (!u || !allowedHost(u)) return null;
    return u;
  } catch { return null; }
}
async function downloadImage(base, sz, token) {
  const r = await fetch(`${base}=${sz}`, { headers: { Authorization: 'Bearer ' + token } });
  if (!r.ok) throw new Error('image fetch ' + r.status);
  return new Uint8Array(await r.arrayBuffer());
}

// 로그인 사용자: 현재 고른 사진을 구글에서 받아 R2에 저장하고 공유 링크 생성
async function shareCreate(request, env, token, sess) {
  const body = await request.json().catch(() => ({}));
  const items = Array.isArray(body.items) ? body.items : [];
  const musicUrl = typeof body.musicUrl === 'string' ? body.musicUrl : '';
  const title = typeof body.title === 'string' ? body.title.slice(0, 40) : '';
  const intervalSec = Math.min(60, Math.max(3, Number(body.intervalSec) || 10));
  const effect = ['fade', 'slide', 'kenburns'].includes(body.effect) ? body.effect : 'fade';
  if (!items.length) return json({ error: '공유할 사진이 없습니다.' }, 400);

  let shareId = sess.data.shareId;
  if (!shareId) {
    shareId = randomId(9);
    sess.data.shareId = shareId;
    await putSession(env, sess.sid, sess.data);
  }
  await deleteShare(env, shareId);

  const manifestItems = [];
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    const base = baseUrlFromImgPath(it.fullUrl || '');
    if (!base) continue;
    const n = String(i + 1).padStart(3, '0');
    try {
      const full = await downloadImage(base, 'w1920-h1080', token);
      const thumb = await downloadImage(base, 'w300-h300-c', token);
      await env.SHARES.put(`${shareId}/photos/${n}_full.jpg`, full, { httpMetadata: { contentType: 'image/jpeg' } });
      await env.SHARES.put(`${shareId}/photos/${n}_thumb.jpg`, thumb, { httpMetadata: { contentType: 'image/jpeg' } });
      manifestItems.push({
        id: it.id, createTime: it.createTime,
        width: it.width || null, height: it.height || null,
        fullUrl: `/shares/${shareId}/photos/${n}_full.jpg`,
        thumbUrl: `/shares/${shareId}/photos/${n}_thumb.jpg`,
      });
    } catch { /* 개별 실패는 건너뜀 */ }
  }
  if (!manifestItems.length) return json({ error: '사진을 저장하지 못했습니다. 다시 시도해주세요.' }, 500);
  manifestItems.sort((a, b) => new Date(a.createTime) - new Date(b.createTime));
  // PIN: 클라이언트가 보낸 값이 유효하면 그것(=링크변경 반영 시 수정된 PIN), 없으면 기존 유지,
  // 그것도 없으면 새로 4자리 발급.
  const prev = await readManifest(env, shareId);
  const pin = normalizePin(body.pin) || (prev && prev.pin) || genPin();
  const owner = sess.data?.email || sess.data?.name || null;
  await writeManifest(env, shareId, { musicUrl, title, intervalSec, effect, pin, owner, items: manifestItems });
  return json({ url: `${env.BASE_URL}/f/${shareId}`, count: manifestItems.length, pin });
}

// 로그인 없이(구글 포토 "공유"로 받은 사진 등): 브라우저가 가진 파일(blob)을 그대로 올려 공유 링크 생성
async function shareBlob(request, env) {
  const { sid, data } = await getSession(request, env);
  const form = await request.formData();
  const files = form.getAll('files').filter((f) => f && typeof f.size === 'number' && f.size > 0);
  if (!files.length) return json({ error: '공유할 사진이 없습니다.' }, 400);
  let meta = [];
  try { meta = JSON.parse(form.get('meta') || '[]'); } catch { /* 무시 */ }
  const musicUrl = typeof form.get('musicUrl') === 'string' ? form.get('musicUrl') : '';
  const title = String(form.get('title') || '').slice(0, 40);
  const intervalSec = Math.min(60, Math.max(3, Number(form.get('intervalSec')) || 10));
  const effect = ['fade', 'slide', 'kenburns'].includes(form.get('effect')) ? form.get('effect') : 'fade';

  // 게스트도 shareId 유지를 위해 세션을 발급/재사용
  let ssid = sid, sdata = data, setCookie = null;
  if (!sdata) sdata = { shareId: null };
  if (!ssid) { ssid = randomId(); setCookie = sidCookie(ssid); }
  let shareId = sdata.shareId;
  if (!shareId) { shareId = randomId(9); sdata.shareId = shareId; }
  await putSession(env, ssid, sdata);
  await deleteShare(env, shareId);

  const manifestItems = [];
  for (let i = 0; i < files.length; i++) {
    const f = files[i];
    if (!/^image\//.test(f.type || '')) continue; // 사진만 (동영상 제외)
    const m = meta[i] || {};
    const n = String(i + 1).padStart(3, '0');
    const ext = f.type === 'image/png' ? 'png' : 'jpg';
    const bytes = new Uint8Array(await f.arrayBuffer());
    await env.SHARES.put(`${shareId}/photos/${n}_full.${ext}`, bytes, { httpMetadata: { contentType: f.type || 'image/jpeg' } });
    manifestItems.push({
      id: `blob-${i}`, createTime: m.createTime || new Date().toISOString(),
      width: m.width || null, height: m.height || null,
      fullUrl: `/shares/${shareId}/photos/${n}_full.${ext}`,
      thumbUrl: `/shares/${shareId}/photos/${n}_full.${ext}`,
    });
  }
  if (!manifestItems.length) return json({ error: '사진을 저장하지 못했습니다. (동영상은 공유 링크에 포함되지 않습니다)' }, 500);
  manifestItems.sort((a, b) => new Date(a.createTime) - new Date(b.createTime));
  const prev = await readManifest(env, shareId);
  const pin = normalizePin(form.get('pin')) || (prev && prev.pin) || genPin();
  const owner = sdata.email || sdata.name || '(게스트)';
  await writeManifest(env, shareId, { musicUrl, title, intervalSec, effect, pin, owner, items: manifestItems });
  return json({ url: `${env.BASE_URL}/f/${shareId}`, count: manifestItems.length, pin }, 200, setCookie ? { 'Set-Cookie': setCookie } : {});
}

async function shareDelete(request, env) {
  const { sid, data } = await getSession(request, env);
  if (data && data.shareId) {
    await deleteShare(env, data.shareId);
    data.shareId = null;
    if (sid) await putSession(env, sid, data);
  }
  return json({ ok: true });
}

// 공개 보기 페이지: 매니페스트 확인 후 share.html(정적) 반환
async function shareViewPage(env, id) {
  const m = await readManifest(env, id);
  if (!m) return html('공유 사진을 찾을 수 없습니다. 링크가 만료되었거나 삭제되었을 수 있습니다.', 404);
  if (isExpired(m)) {
    await deleteShare(env, id);
    return html('링크가 만료되었습니다. 공유한 분에게 새 링크를 요청해주세요.', 404);
  }
  // 검색엔진 색인 금지 헤더를 붙여 내려준다(share.html의 meta robots와 이중 안전장치).
  const res = await env.ASSETS.fetch(new Request(env.BASE_URL + '/share.html'));
  const h = new Headers(res.headers);
  h.set('X-Robots-Tag', 'noindex, nofollow');
  return new Response(res.body, { status: res.status, headers: h });
}

// /shares/<id>/... → R2에서 서빙
function guessType(key) {
  if (key.endsWith('.png')) return 'image/png';
  if (key.endsWith('.jpg') || key.endsWith('.jpeg')) return 'image/jpeg';
  if (key.endsWith('.json')) return 'application/json; charset=utf-8';
  return 'application/octet-stream';
}
async function shareAsset(request, env, pathname, url) {
  const key = pathname.replace(/^\/shares\//, '');
  if (!/^[\w-]{6,}\//.test(key)) return text('not found', 404);
  const id = key.split('/')[0];

  // PIN이 걸린 공유는 열람 쿠키가 없으면 차단한다. 화면에서만 막으면 이 URL을 직접 열어
  // 우회할 수 있으므로 photos.json과 사진 파일 자체를 서버에서 막아야 한다.
  const manifest = await readManifest(env, id);
  if (manifest && manifest.pin && !(await canViewShare(request, env, id, manifest))) {
    return json({ error: 'PIN 번호가 필요합니다.', pinRequired: true }, 401);
  }

  const obj = await env.SHARES.get(key);
  if (!obj) return text('not found', 404);
  const headers = new Headers();
  headers.set('Content-Type', obj.httpMetadata?.contentType || guessType(key));
  headers.set('X-Robots-Tag', 'noindex, nofollow'); // 검색엔진 색인 금지
  if (key.endsWith('photos.json')) {
    let m = null;
    try { m = JSON.parse(await obj.text()); } catch {}
    if (isExpired(m)) { await deleteShare(env, id); return text('not found', 404); }
    headers.set('Cache-Control', 'no-store');
    return new Response(JSON.stringify(m), { status: 200, headers });
  }
  headers.set('Cache-Control', 'public, max-age=300');
  setDownloadHeader(headers, url && url.searchParams.get('dl')); // ?dl=<파일명> → 저장
  return new Response(obj.body, { status: 200, headers });
}

// 만료 공유 정리 (cron)
async function cleanupExpired(env) {
  let cursor;
  const seen = new Set();
  do {
    const list = await env.SHARES.list({ cursor, delimiter: '/' });
    for (const pfx of list.delimitedPrefixes || []) {
      const id = pfx.replace(/\/$/, '');
      if (seen.has(id)) continue;
      seen.add(id);
      const m = await readManifest(env, id);
      if (m && isExpired(m)) await deleteShare(env, id);
    }
    cursor = list.truncated ? list.cursor : null;
  } while (cursor);
}

// ---------- 라우팅 ----------
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const p = url.pathname;
    const m = request.method;
    try {
      if (p === '/auth/login' && m === 'GET') return authLogin(env);
      if (p === '/auth/callback' && m === 'GET') return authCallback(env, url);
      if (p === '/api/status' && m === 'GET') return apiStatus(request, env);
      if (p === '/api/logout' && m === 'POST') return apiLogout(request, env);

      if (p === '/api/picker/session' && m === 'POST') return requireLogin(request, env, (rq, en, tok) => pickerCreate(rq, en, tok));
      const mSess = p.match(/^\/api\/picker\/session\/([^/]+)$/);
      if (mSess && m === 'GET') return requireLogin(request, env, (rq, en, tok) => pickerPoll(en, tok, mSess[1]));
      if (mSess && m === 'DELETE') return requireLogin(request, env, (rq, en, tok) => pickerDelete(en, tok, mSess[1]));
      if (p === '/api/picker/media' && m === 'GET') return requireLogin(request, env, (rq, en, tok) => pickerMedia(en, tok, url));

      if (p === '/img' && m === 'GET') return requireLogin(request, env, (rq, en, tok) => imgProxy(en, tok, url));
      if (p === '/video' && m === 'GET') return requireLogin(request, env, (rq, en, tok) => videoProxy(rq, en, tok, url));

      if (p === '/api/share' && m === 'POST') return requireLogin(request, env, (rq, en, tok, sess) => shareCreate(rq, en, tok, sess));
      if (p === '/api/share' && m === 'DELETE') return shareDelete(request, env);
      if (p === '/api/share/blob' && m === 'POST') return shareBlob(request, env);
      if (p === '/share-target' && m === 'POST') return redirect('/'); // 보통 서비스워커가 가로챔

      // PIN 검증 (공유화면이 재생 전에 호출)
      const mPin = p.match(/^\/api\/share\/([\w-]{6,})\/verify-pin$/);
      if (mPin && m === 'POST') return verifyPin(request, env, mPin[1]);

      // Default 정보관리 / wepic 관리자
      if (p === '/api/settings' && m === 'GET') return json(await readSettings(env));
      if (p === '/api/admin/settings' && m === 'PUT') {
        return requireAdmin(request, env, async (rq, en) =>
          json(await writeSettings(en, await rq.json().catch(() => ({})))));
      }
      if (p === '/api/admin/shares' && m === 'GET') {
        return requireAdmin(request, env, (rq, en) => adminShares(en));
      }
      const mAdminShare = p.match(/^\/api\/admin\/shares\/([\w-]{6,})$/);
      if (mAdminShare && m === 'DELETE') {
        return requireAdmin(request, env, async (rq, en) => {
          if (!(await readManifest(en, mAdminShare[1]))) return json({ error: '없는 공유입니다.' }, 404);
          await deleteShare(en, mAdminShare[1]);
          return json({ ok: true });
        });
      }
      const mAdminPin = p.match(/^\/api\/admin\/shares\/([\w-]{6,})\/pin$/);
      if (mAdminPin && m === 'PUT') {
        return requireAdmin(request, env, (rq, en) => adminSetPin(rq, en, mAdminPin[1]));
      }

      const mF = p.match(/^\/f\/([\w-]{6,})$/);
      if (mF && m === 'GET') return shareViewPage(env, mF[1]);
      if (p.startsWith('/shares/') && m === 'GET') return shareAsset(request, env, p, url);

      // 그 외에는 정적 자산(web/public)
      return env.ASSETS.fetch(request);
    } catch (err) {
      // 메시지가 비면 화면에 "요청 실패 (500)"만 떠서 원인을 알 수 없다 → 최대한 정보를 담는다.
      const detail = (err && (err.message || err.name)) || String(err) || '알 수 없는 오류';
      console.error('worker error', p, detail, err && err.stack);
      return json({ error: `서버 오류: ${detail}` }, 500);
    }
  },
  async scheduled(event, env, ctx) {
    ctx.waitUntil(cleanupExpired(env));
  },
};
