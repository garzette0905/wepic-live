// Wepic Live — Cloudflare Worker 백엔드 (유일한 백엔드)
// 세션: Workers KV(SESSIONS) · 회원: D1(DB) · 공유 파일: R2(SHARES) · 정적: ASSETS(web/public)
// 시크릿: GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, KAKAO_CLIENT_ID, KAKAO_CLIENT_SECRET, SESSION_SECRET
// 변수: BASE_URL
// (QR 코드는 CPU 제한 때문에 서버에서 만들지 않고 브라우저에서 생성한다 — pickerCreate 참고)

const PICKER_BASE = 'https://photospicker.googleapis.com/v1';
const PHOTOS_SCOPE = 'https://www.googleapis.com/auth/photospicker.mediaitems.readonly';
const MAX_SHARE_ITEMS = 60;
// 공유에 담을 동영상 1개의 최대 크기. 넘으면 그 동영상은 정지 이미지(포스터)로만 담긴다.
// (저장공간·전송량 보호. 변수 MAX_SHARE_VIDEO_MB로 조절)
const maxShareVideoBytes = (env) => Math.max(1, Number(env.MAX_SHARE_VIDEO_MB) || 100) * 1024 * 1024;

// ---------- OIDC 로그인 제공자 ----------
// 회원가입·로그인은 OIDC(id_token을 JWKS로 검증)로 처리한다. 우리 DB(D1)에는 신원을 알아볼
// 최소 정보만 두고(schema.sql 참고), 비밀번호는 아예 받지 않는다.
//
// 구글만 사진 접근(Photos Picker) 권한까지 함께 받는다 — 다른 제공자로 가입한 사용자는
// 구글 포토를 쓸 수 없으므로 "기기 갤러리에서 직접 올리기"를 사용한다.
const OIDC_PROVIDERS = {
  google: {
    label: 'Google',
    authUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenUrl: 'https://oauth2.googleapis.com/token',
    jwksUrl: 'https://www.googleapis.com/oauth2/v3/certs',
    // 구글은 iss를 두 형태 중 하나로 보낸다(둘 다 정상).
    issuers: ['https://accounts.google.com', 'accounts.google.com'],
    scope: `openid email profile ${PHOTOS_SCOPE}`,
    // 리프레시 토큰을 받아 사진 API를 계속 쓰기 위한 추가 파라미터
    extraAuthParams: { access_type: 'offline', prompt: 'select_account consent' },
    clientId: (env) => env.GOOGLE_CLIENT_ID,
    clientSecret: (env) => env.GOOGLE_CLIENT_SECRET,
    // 사진 권한까지 확보되는 제공자인지 (Picker 사용 가능 여부)
    grantsPhotos: true,
  },
  kakao: {
    label: '카카오',
    authUrl: 'https://kauth.kakao.com/oauth/authorize',
    tokenUrl: 'https://kauth.kakao.com/oauth/token',
    jwksUrl: 'https://kauth.kakao.com/.well-known/jwks.json',
    issuers: ['https://kauth.kakao.com'],
    // 이메일은 선택 동의라 동의하지 않으면 id_token에 없을 수 있다(스키마도 NULL 허용).
    scope: 'openid account_email profile_nickname',
    extraAuthParams: {},
    clientId: (env) => env.KAKAO_CLIENT_ID,
    clientSecret: (env) => env.KAKAO_CLIENT_SECRET,
    grantsPhotos: false,
  },
};
const isProvider = (p) => Object.prototype.hasOwnProperty.call(OIDC_PROVIDERS, p);

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

// ---------- 세션당 액자(다중 액자) ----------
// 한 세션이 여러 액자(shareId)를 동시에 만들고, 각각을 계속 갱신하며 운영할 수 있게 한다.
// 옛 버전은 세션당 shareId 하나만 있었다 — 그런 세션을 만나면 액자 1개로 자동 이전한다.
function ensureFrames(data) {
  if (!Array.isArray(data.frames)) data.frames = [];
  if (data.shareId && !data.frames.some((f) => f.id === data.shareId)) {
    data.frames.push({ id: data.shareId, name: '액자 1' });
    if (!data.currentFrameId) data.currentFrameId = data.shareId;
  }
  delete data.shareId; // frames로 완전히 이전
  // 이미 지워진 액자를 가리키고 있으면 선택을 해제한다. 남은 액자를 임의로 골라주지는
  // 않는다 — 선택이 없는 상태는 "새 액자"를 뜻하고, 메인화면은 그 상태로 시작한다.
  if (data.currentFrameId && !data.frames.some((f) => f.id === data.currentFrameId)) {
    data.currentFrameId = null;
  }
}
function frameNameOf(data, id) {
  return (data.frames || []).find((f) => f.id === id)?.name || '';
}
// 액자 하나의 요약 정보(선택 UI·관리자 목록용)
async function frameInfo(env, data, f) {
  const m = await readManifest(env, f.id);
  return {
    id: f.id,
    name: f.name,
    isCurrent: data.currentFrameId === f.id,
    hasContent: !!m,
    title: m?.title || '',
    // 액자를 선택하면 그 액자에 저장된 음악·전환설정까지 메인화면에 그대로 복원한다.
    musicUrl: m?.musicUrl || '',
    intervalSec: m?.intervalSec || null,
    effect: m?.effect || null,
    pin: m?.pin || null,
    count: m?.items?.length || 0,
    thumbUrl: m?.items?.[0]?.thumbUrl || null,
    url: m ? `${env.BASE_URL}/f/${f.id}` : null,
    updatedAt: m?.updatedAt || null,
    expiresAt: m?.expiresAt || null,
    expired: m ? isExpired(m) : false,
  };
}
async function framesInfoList(env, data) {
  const out = [];
  for (const f of data.frames || []) out.push(await frameInfo(env, data, f));
  return out;
}

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
// base64url → 바이트. JWT(id_token)의 헤더·페이로드·서명을 읽는 데 쓴다.
function b64urlToBytes(s) {
  const t = String(s).replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(t + '='.repeat((4 - (t.length % 4)) % 4));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
const b64urlToJson = (s) => JSON.parse(new TextDecoder().decode(b64urlToBytes(s)));
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
// 제공자별 토큰 엔드포인트로 교환/갱신 요청. 기본은 구글(사진 API 토큰 갱신에 쓰임).
async function tokenRequest(env, params, providerKey = 'google') {
  const p = OIDC_PROVIDERS[providerKey];
  const body = new URLSearchParams({
    client_id: p.clientId(env),
    client_secret: p.clientSecret(env),
    ...params,
  });
  const r = await fetch(p.tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  if (!r.ok) throw new Error(`토큰 요청 실패 (${r.status}): ${await r.text()}`);
  return r.json();
}
// 세션에서 유효한 access token 확보(만료 임박 시 갱신 후 KV에 다시 저장). 실패 시 NOT_LOGGED_IN.
// 사진 API용이므로 항상 구글 기준이다 — 카카오 등으로 로그인한 회원은 refreshToken이 없어
// NOT_LOGGED_IN이 되고, 사진 선택 대신 "기기 갤러리에서 올리기"를 쓰게 된다.
async function getAccessToken(env, sid, data) {
  if (!data || !data.refreshToken) throw new Error('NOT_LOGGED_IN');
  if (Date.now() < data.expiresAt - 60000) return data.accessToken;
  const d = await tokenRequest(env, { refresh_token: data.refreshToken, grant_type: 'refresh_token' });
  data.accessToken = d.access_token;
  data.expiresAt = Date.now() + d.expires_in * 1000;
  await putSession(env, sid, data);
  return data.accessToken;
}

// ---------- OIDC id_token 검증 ----------
// 제공자의 공개키(JWKS)로 서명을 검증하고 iss·aud·exp·nonce까지 확인한다.
// 이렇게 하면 프로필 조회 API를 따로 호출하지 않고도 신원을 신뢰할 수 있다.
async function verifyIdToken(env, providerKey, idToken, expectedNonce) {
  const p = OIDC_PROVIDERS[providerKey];
  const parts = String(idToken || '').split('.');
  if (parts.length !== 3) throw new Error('id_token 형식이 올바르지 않습니다.');
  const header = b64urlToJson(parts[0]);
  const payload = b64urlToJson(parts[1]);
  if (header.alg !== 'RS256') throw new Error(`지원하지 않는 서명 알고리즘입니다: ${header.alg}`);

  const jwks = await fetch(p.jwksUrl).then((r) => (r.ok ? r.json() : null));
  if (!jwks) throw new Error('공개키(JWKS)를 가져오지 못했습니다.');
  const jwk = (jwks.keys || []).find((k) => k.kid === header.kid);
  if (!jwk) throw new Error('id_token에 해당하는 공개키를 찾을 수 없습니다.');

  const key = await crypto.subtle.importKey(
    'jwk',
    { kty: jwk.kty, n: jwk.n, e: jwk.e, alg: 'RS256', ext: true },
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['verify']
  );
  const ok = await crypto.subtle.verify(
    'RSASSA-PKCS1-v1_5',
    key,
    b64urlToBytes(parts[2]),
    new TextEncoder().encode(`${parts[0]}.${parts[1]}`)
  );
  if (!ok) throw new Error('id_token 서명 검증에 실패했습니다.');

  if (!p.issuers.includes(payload.iss)) throw new Error('id_token 발급자(iss)가 올바르지 않습니다.');
  const aud = p.clientId(env);
  const audOk = Array.isArray(payload.aud) ? payload.aud.includes(aud) : payload.aud === aud;
  if (!audOk) throw new Error('id_token 대상(aud)이 올바르지 않습니다.');
  const now = Math.floor(Date.now() / 1000);
  if (payload.exp && now >= payload.exp) throw new Error('id_token이 만료되었습니다.');
  // nonce: 로그인 시작 때 우리가 만든 값과 같아야 한다(재사용 공격 방지).
  if (expectedNonce && payload.nonce !== expectedNonce) throw new Error('id_token nonce가 일치하지 않습니다.');
  return payload;
}

// ---------- 회원(D1) ----------
// 로그인할 때마다 upsert. (provider, provider_sub)가 회원 식별 키다 — 이메일은 바뀔 수 있어
// 키로 쓰지 않는다. 신규 가입은 자동 승인(status='active')이고 권한은 기본 'user'다.
// 관리자(role='admin')는 DB에서 직접 지정한다(환경변수로 자동 부여하지 않음).
async function upsertUser(env, { provider, sub, email, name }) {
  const now = new Date().toISOString();
  await env.DB.prepare(
    `INSERT INTO users (provider, provider_sub, email, name, created_at, last_login_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?5)
     ON CONFLICT (provider, provider_sub) DO UPDATE SET
       email = COALESCE(excluded.email, users.email),
       name = COALESCE(excluded.name, users.name),
       last_login_at = excluded.last_login_at`
  )
    .bind(provider, sub, email || null, name || null, now)
    .run();
  return env.DB.prepare(
    `SELECT id, provider, provider_sub, email, name, role, status FROM users
     WHERE provider = ?1 AND provider_sub = ?2`
  )
    .bind(provider, sub)
    .first();
}
// 세션이 가리키는 회원의 현재 상태를 DB에서 다시 읽는다(권한·차단이 바뀌면 바로 반영되도록).
async function getUserById(env, id) {
  if (!id) return null;
  return env.DB.prepare(
    `SELECT id, provider, provider_sub, email, name, role, status FROM users WHERE id = ?1`
  )
    .bind(id)
    .first();
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

// ---------- OIDC 로그인 / 회원가입 ----------
// 구글은 예전부터 쓰던 /auth/callback 을 그대로 유지한다(구글 콘솔에 이미 등록된 주소).
// 다른 제공자는 /auth/<provider>/callback 을 쓴다.
const oidcRedirectUri = (env, providerKey) =>
  providerKey === 'google'
    ? `${env.BASE_URL}/auth/callback`
    : `${env.BASE_URL}/auth/${providerKey}/callback`;

// 로그인 시작: state(CSRF 방지)와 nonce(id_token 재사용 방지)를 만들어 KV에 10분간 보관하고
// 제공자의 동의 화면으로 보낸다.
async function authLogin(env, providerKey) {
  const p = OIDC_PROVIDERS[providerKey];
  if (!p.clientId(env)) {
    return redirect('/?auth_error=' + encodeURIComponent(`${p.label} 로그인이 아직 설정되지 않았습니다.`));
  }
  const state = randomId();
  const nonce = randomId();
  await env.SESSIONS.put(
    'oauth:' + state,
    JSON.stringify({ provider: providerKey, nonce }),
    { expirationTtl: 600 }
  );

  const u = new URL(p.authUrl);
  u.searchParams.set('client_id', p.clientId(env));
  u.searchParams.set('redirect_uri', oidcRedirectUri(env, providerKey));
  u.searchParams.set('response_type', 'code');
  u.searchParams.set('scope', p.scope);
  u.searchParams.set('state', state);
  u.searchParams.set('nonce', nonce);
  for (const [k, v] of Object.entries(p.extraAuthParams)) u.searchParams.set(k, v);
  return redirect(u.toString());
}

async function authCallback(env, url, providerKey) {
  const code = url.searchParams.get('code');
  const error = url.searchParams.get('error');
  const state = url.searchParams.get('state');
  if (error) return redirect('/?auth_error=' + encodeURIComponent(error));
  if (!code) return redirect('/?auth_error=no_code');

  try {
    // state 검증: 우리가 만든 로그인 시도인지 확인하고, 짝이 되는 nonce를 꺼낸다.
    const rawState = state ? await env.SESSIONS.get('oauth:' + state) : null;
    if (!rawState) return redirect('/?auth_error=' + encodeURIComponent('로그인 요청이 만료되었습니다. 다시 시도해주세요.'));
    await env.SESSIONS.delete('oauth:' + state); // 1회용
    const { provider: statedProvider, nonce } = JSON.parse(rawState);
    if (statedProvider !== providerKey) {
      return redirect('/?auth_error=' + encodeURIComponent('로그인 제공자가 일치하지 않습니다.'));
    }

    const p = OIDC_PROVIDERS[providerKey];
    const d = await tokenRequest(
      env,
      { code, grant_type: 'authorization_code', redirect_uri: oidcRedirectUri(env, providerKey) },
      providerKey
    );

    // 신원은 id_token(JWKS 검증)에서 얻는다 — 프로필 조회 API를 따로 부르지 않는다.
    if (!d.id_token) return redirect('/?auth_error=' + encodeURIComponent('id_token을 받지 못했습니다. (OpenID Connect 설정 확인)'));
    const claims = await verifyIdToken(env, providerKey, d.id_token, nonce);

    // 구글은 사진 권한까지 함께 받아야 Picker를 쓸 수 있다.
    if (p.grantsPhotos && !(d.scope || '').split(' ').includes(PHOTOS_SCOPE)) {
      return redirect('/?auth_error=missing_photos_scope');
    }

    const name = claims.name || claims.nickname || null;
    const user = await upsertUser(env, {
      provider: providerKey,
      sub: String(claims.sub),
      email: claims.email || null,
      name,
    });
    if (!user) return redirect('/?auth_error=' + encodeURIComponent('회원 정보를 저장하지 못했습니다.'));
    if (user.status === 'blocked') {
      return redirect('/?auth_error=' + encodeURIComponent('이 계정은 사용이 중지되었습니다. 관리자에게 문의해주세요.'));
    }

    const sid = randomId();
    await putSession(env, sid, {
      provider: providerKey,
      userId: user.id,
      role: user.role,
      email: user.email,
      name: user.name,
      // 사진 API용 토큰(구글만 존재). 다른 제공자는 null이라 Picker를 쓸 수 없다.
      accessToken: d.access_token || null,
      refreshToken: d.refresh_token || null,
      expiresAt: d.expires_in ? Date.now() + d.expires_in * 1000 : 0,
      frames: [],
      currentFrameId: null,
    });
    return redirect('/', { 'Set-Cookie': sidCookie(sid) });
  } catch (err) {
    return redirect('/?auth_error=' + encodeURIComponent(err.message));
  }
}
async function apiStatus(request, env) {
  // 실제로 키가 설정된 로그인 제공자만 화면에 버튼으로 노출한다
  // (설정 안 된 제공자를 눌러 오류 화면을 보는 일이 없도록).
  const availableProviders = Object.keys(OIDC_PROVIDERS).filter((k) => !!OIDC_PROVIDERS[k].clientId(env));
  const anon = {
    loggedIn: false, email: null, name: null, provider: null,
    canPickGooglePhotos: false, hasShare: false, sharePin: null, isAdmin: false,
    availableProviders,
  };
  const { sid, data } = await getSession(request, env);
  if (!data) return json(anon);
  ensureFrames(data);
  // 로그인 판정은 "회원(D1)에 연결된 세션인가"로 한다. 옛 세션(userId 없음)은 재로그인 필요.
  // 권한·차단 상태는 매번 DB에서 다시 읽어, 관리자가 바꾸면 즉시 반영되게 한다.
  const user = await getUserById(env, data.userId);
  const loggedIn = !!user && user.status !== 'blocked';
  if (user && (data.role !== user.role || data.email !== user.email)) {
    data.role = user.role;          // 세션 캐시를 DB 기준으로 맞춘다
    data.email = user.email;
  }
  await putSession(env, sid, data);
  // 이미 만들어 둔 공유 링크가 있으면 "링크변경 반영" 버튼을 바로 노출하기 위한 힌트
  const manifest = data.currentFrameId ? await readManifest(env, data.currentFrameId) : null;
  return json({
    loggedIn,
    email: loggedIn ? user.email || null : null,
    name: loggedIn ? user.name || null : null,
    provider: loggedIn ? data.provider || null : null,
    // 구글로 로그인한 회원만 구글 포토 Picker를 쓸 수 있다(그 외는 기기 갤러리 업로드).
    canPickGooglePhotos: loggedIn && !!data.refreshToken,
    hasShare: !!manifest,
    sharePin: manifest ? manifest.pin || null : null, // 현재 공유의 PIN(메인화면 표시용)
    isAdmin: loggedIn && user.role === 'admin',       // Admin 메뉴 노출 여부
    availableProviders,
  });
}

// ---------- 세션당 액자(다중 액자) 관리 ----------
async function apiFramesGet(request, env) {
  const { sid, data } = await getSession(request, env);
  if (!data) return json({ frames: [], currentFrameId: null });
  ensureFrames(data);
  await putSession(env, sid, data);
  return json({ frames: await framesInfoList(env, data), currentFrameId: data.currentFrameId || null });
}
async function apiFramesCreate(request, env) {
  let { sid, data } = await getSession(request, env);
  let setCookie = null;
  if (!data) data = { frames: [], currentFrameId: null };
  if (!sid) { sid = randomId(); setCookie = sidCookie(sid); }
  ensureFrames(data);
  const body = await request.json().catch(() => ({}));
  const name = (typeof body.name === 'string' && body.name.trim().slice(0, 30))
    || `액자 ${data.frames.length + 1}`;
  const id = randomId(9);
  data.frames.push({ id, name });
  data.currentFrameId = id;
  await putSession(env, sid, data);
  return json({
    frame: await frameInfo(env, data, { id, name }),
    frames: await framesInfoList(env, data),
    currentFrameId: id,
  }, 200, setCookie ? { 'Set-Cookie': setCookie } : {});
}
async function apiFramesRename(request, env, id) {
  const { sid, data } = await getSession(request, env);
  if (!data) return json({ error: '없는 액자입니다.' }, 404);
  ensureFrames(data);
  const f = data.frames.find((x) => x.id === id);
  if (!f) return json({ error: '없는 액자입니다.' }, 404);
  const body = await request.json().catch(() => ({}));
  const name = typeof body.name === 'string' ? body.name.trim().slice(0, 30) : '';
  if (!name) return json({ error: '이름을 입력하세요.' }, 400);
  f.name = name;
  await putSession(env, sid, data);
  return json({ ok: true, frame: await frameInfo(env, data, f) });
}
// 선택 해제 = "새 액자"로 시작. 다음 "실시간 공유 링크 만들기"가 새 액자를 만든다.
async function apiFramesDeselect(request, env) {
  const { sid, data } = await getSession(request, env);
  if (!data) return json({ ok: true, currentFrameId: null });
  ensureFrames(data);
  data.currentFrameId = null;
  await putSession(env, sid, data);
  return json({ ok: true, currentFrameId: null });
}

async function apiFramesSelect(request, env, id) {
  const { sid, data } = await getSession(request, env);
  if (!data) return json({ error: '없는 액자입니다.' }, 404);
  ensureFrames(data);
  let f = data.frames.find((x) => x.id === id);
  if (!f) {
    // 관리자는 다른 세션이 만든 액자도 wepic 메인화면에서 그대로 이어서 관리할 수 있도록,
    // "wepic 메인화면 열기" 진입 시 자기 액자 목록에 편입시킨 뒤 선택한다.
    if (data.role !== 'admin') return json({ error: '없는 액자입니다.' }, 404);
    const m = await readManifest(env, id);
    if (!m) return json({ error: '없는 액자입니다.' }, 404);
    f = { id, name: m.frameName || m.title || '관리자로 연 액자' };
    data.frames.push(f);
  }
  data.currentFrameId = f.id;
  await putSession(env, sid, data);
  return json({ ok: true, currentFrameId: f.id });
}
// 액자 삭제: R2의 폴더(사진·매니페스트)까지 완전히 지우고 목록에서도 제거한다.
async function apiFramesDelete(request, env, id) {
  const { sid, data } = await getSession(request, env);
  if (!data) return json({ error: '없는 액자입니다.' }, 404);
  ensureFrames(data);
  const idx = data.frames.findIndex((x) => x.id === id);
  if (idx === -1) return json({ error: '없는 액자입니다.' }, 404);
  await deleteShare(env, id);
  data.frames.splice(idx, 1);
  if (data.currentFrameId === id) data.currentFrameId = data.frames[0]?.id || null;
  await putSession(env, sid, data);
  return json({ ok: true, currentFrameId: data.currentFrameId, frames: await framesInfoList(env, data) });
}
async function apiLogout(request, env) {
  const { sid } = await getSession(request, env);
  await delSession(env, sid);
  return json({ ok: true }, 200, { 'Set-Cookie': clearCookie() });
}

// 관리자 전용 가드. 권한은 세션 캐시가 아니라 D1에서 다시 읽어 판정한다
// (관리자를 DB에서 내리면 즉시 막히도록).
async function requireAdmin(request, env, handler) {
  const sess = await getSession(request, env);
  const user = await getUserById(env, sess.data?.userId);
  if (!user || user.status === 'blocked') return json({ error: '로그인이 필요합니다.' }, 401);
  if (user.role !== 'admin') return json({ error: '관리자만 사용할 수 있습니다.' }, 403);
  return handler(request, env, sess, user);
}

// 로그인한 Wepic 사용자(또는 관리자)만 통과하는 가드. 사진 업로드·공유 생성에 쓴다.
// 구글 사진 API 토큰이 필요한 곳은 requireLogin(위)을 쓰고, "회원이면 되는" 곳은 이걸 쓴다.
async function requireMember(request, env, handler) {
  const sess = await getSession(request, env);
  const user = await getUserById(env, sess.data?.userId);
  if (!user) return json({ error: '로그인이 필요합니다.', loginRequired: true }, 401);
  if (user.status === 'blocked') {
    return json({ error: '이 계정은 사용이 중지되었습니다.', loginRequired: true }, 403);
  }
  return handler(request, env, sess, user);
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
        frameName: m.frameName || null,
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
  if (sess.data?.role === 'admin') return true;                 // 관리자 통과
  if ((sess.data?.frames || []).some((f) => f.id === id)) return true; // 만든 본인(다중 액자)
  if (sess.data?.shareId === id) return true;                   // 구버전 세션 안전망
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
// 자동 만료 삭제는 비활성화했다(2026-07, 사용자 요청 — 무료 저장 용량이 넉넉해 따로
// 얘기하기 전까지는 어떤 공유도 자동으로 지우지 않는다). m이 없으면(파싱 실패 등) 여전히
// "만료"로 취급해 그 요청만 404 처리한다(진짜 손상된 데이터 방어용이지 시간 만료가 아님).
// 되살리려면 writeManifest에 expiresAt 계산을 되돌리고 아래를 시간 비교로 복원하면 된다.
const isExpired = (m) => !m;

async function writeManifest(env, id, data) {
  const body = JSON.stringify(
    { ...data, updatedAt: new Date().toISOString(), expiresAt: null },
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

// 동영상 원본(=dv)을 R2에 그대로 저장한다. 공유 화면은 로그인이 없어 구글 원본 URL
// (/video 프록시)을 쓸 수 없으므로, 파일 자체를 저장해야 재생할 수 있다.
// 응답 본문을 스트림으로 그대로 넘겨 메모리에 다 올리지 않는다(큰 파일 대비).
async function putVideoToR2(env, base, token, key) {
  const r = await fetch(`${base}=dv`, { headers: { Authorization: 'Bearer ' + token } });
  if (!r.ok) throw new Error('video fetch ' + r.status);
  const len = Number(r.headers.get('content-length') || 0);
  const max = maxShareVideoBytes(env);
  if (len > max) throw new Error('video too large');
  // content-length가 없으면 크기를 미리 알 수 없다 → R2가 거부할 수 있으므로 그대로 시도한다.
  await env.SHARES.put(key, r.body, {
    httpMetadata: { contentType: r.headers.get('content-type') || 'video/mp4' },
  });
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

  ensureFrames(sess.data);
  if (!sess.data.currentFrameId) {
    const newId = randomId(9);
    sess.data.frames.push({ id: newId, name: `액자 ${sess.data.frames.length + 1}` });
    sess.data.currentFrameId = newId;
  }
  const shareId = sess.data.currentFrameId;
  await putSession(env, sess.sid, sess.data);

  // 이미 이 액자에 저장된 파일(관리자가 액자를 열어 몇 장만 추가/제외한 경우)은 구글에서
  // 다시 받을 수 없다(원본 URL이 없음). 그래서 **키를 바꾸지 않고 그대로 재사용**한다
  // — 다시 쓰지도, 옮기지도 않으므로 큰 동영상도 안전하다. 새로 받는 항목만 남는 번호를 쓴다.
  const ownRe = new RegExp(`^/shares/${shareId}/photos/(\\d+)_`);
  let maxIdx = 0;
  for (const it of items) {
    const m = ownRe.exec(it.fullUrl || '');
    if (m) maxIdx = Math.max(maxIdx, parseInt(m[1], 10));
  }
  const keepKeys = new Set([`${shareId}/photos.json`]); // 이번 저장 후에도 남겨둘 키
  const keyOf = (url) => (ownRe.test(url || '') ? `${shareId}/photos/${url.slice(url.lastIndexOf('/') + 1)}` : null);

  const manifestItems = [];
  for (const it of items) {
    const isVideo = it.type === 'video';
    // (1) 이미 이 액자에 있는 파일 → 그대로 유지
    if (ownRe.test(it.fullUrl || '')) {
      const fullKey = keyOf(it.fullUrl);
      if (!fullKey || !(await env.SHARES.head(fullKey))) continue;
      keepKeys.add(fullKey);
      const keep = {
        id: it.id, createTime: it.createTime,
        width: it.width || null, height: it.height || null,
        fullUrl: it.fullUrl,
      };
      const thumbKey = keyOf(it.thumbUrl);
      if (thumbKey && (await env.SHARES.head(thumbKey))) {
        keepKeys.add(thumbKey);
        keep.thumbUrl = it.thumbUrl;
      } else {
        keep.thumbUrl = it.fullUrl;
      }
      const videoKey = keyOf(it.videoUrl);
      if (isVideo && videoKey && (await env.SHARES.head(videoKey))) {
        keepKeys.add(videoKey);
        keep.type = 'video';
        keep.videoUrl = it.videoUrl;
      }
      manifestItems.push(keep);
      continue;
    }
    // (2) 새 항목 → 구글에서 내려받아 저장
    const base = baseUrlFromImgPath(it.fullUrl || '');
    if (!base) continue;
    const n = String(++maxIdx).padStart(3, '0');
    try {
      // 동영상도 정지 프레임(포스터)은 항상 저장한다 — 재생 전 표시 및 재생 실패 시 대체용.
      const full = await downloadImage(base, 'w1920-h1080', token);
      const thumb = await downloadImage(base, 'w300-h300-c', token);
      await env.SHARES.put(`${shareId}/photos/${n}_full.jpg`, full, { httpMetadata: { contentType: 'image/jpeg' } });
      await env.SHARES.put(`${shareId}/photos/${n}_thumb.jpg`, thumb, { httpMetadata: { contentType: 'image/jpeg' } });
      keepKeys.add(`${shareId}/photos/${n}_full.jpg`);
      keepKeys.add(`${shareId}/photos/${n}_thumb.jpg`);
      const entry = {
        id: it.id, createTime: it.createTime,
        width: it.width || null, height: it.height || null,
        fullUrl: `/shares/${shareId}/photos/${n}_full.jpg`,
        thumbUrl: `/shares/${shareId}/photos/${n}_thumb.jpg`,
      };
      if (isVideo) {
        // 동영상 원본까지 저장되면 공유 화면에서 재생된다. 너무 크거나 실패하면
        // 포스터만 남겨 사진으로 표시한다(공유가 통째로 실패하지 않도록).
        try {
          await putVideoToR2(env, base, token, `${shareId}/photos/${n}_video.mp4`);
          keepKeys.add(`${shareId}/photos/${n}_video.mp4`);
          entry.type = 'video';
          entry.videoUrl = `/shares/${shareId}/photos/${n}_video.mp4`;
        } catch (err) {
          console.warn(`동영상 저장 실패(${it.id}): ${err.message} → 정지 이미지로 대체`);
        }
      }
      manifestItems.push(entry);
    } catch { /* 개별 실패는 건너뜀 */ }
  }
  if (!manifestItems.length) return json({ error: '사진을 저장하지 못했습니다. 다시 시도해주세요.' }, 500);

  // 이번에 쓰이지 않는 예전 파일 정리(제외된 사진·동영상)
  const old = await env.SHARES.list({ prefix: `${shareId}/` });
  const stale = (old.objects || []).map((o) => o.key).filter((k) => !keepKeys.has(k));
  if (stale.length) await env.SHARES.delete(stale);
  manifestItems.sort((a, b) => new Date(a.createTime) - new Date(b.createTime));
  // PIN: 클라이언트가 보낸 값이 유효하면 그것(=링크변경 반영 시 수정된 PIN), 없으면 기존 유지,
  // 그것도 없으면 새로 4자리 발급.
  const prev = await readManifest(env, shareId);
  const pin = normalizePin(body.pin) || (prev && prev.pin) || genPin();
  const owner = sess.data?.email || sess.data?.name || null;
  const curFrameName = frameNameOf(sess.data, shareId);
  await writeManifest(env, shareId, { musicUrl, title, intervalSec, effect, pin, owner, frameName: curFrameName, items: manifestItems });
  return json({ url: `${env.BASE_URL}/f/${shareId}`, count: manifestItems.length, pin, frameId: shareId, frameName: curFrameName });
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

  // 게스트도 액자 목록 유지를 위해 세션을 발급/재사용
  let ssid = sid, sdata = data, setCookie = null;
  if (!sdata) sdata = { frames: [], currentFrameId: null };
  if (!ssid) { ssid = randomId(); setCookie = sidCookie(ssid); }
  ensureFrames(sdata);
  if (!sdata.currentFrameId) {
    const newId = randomId(9);
    sdata.frames.push({ id: newId, name: `액자 ${sdata.frames.length + 1}` });
    sdata.currentFrameId = newId;
  }
  const shareId = sdata.currentFrameId;
  await putSession(env, ssid, sdata);

  // 기존 공유를 먼저 지우지 않고 새 파일부터 저장한다. 재업로드한 파일이 전부
  // 걸러지거나(이미지가 아님) 저장에 실패해도 기존 공유가 지워지지 않도록 하기 위함 —
  // 유효한 새 파일이 실제로 저장된 뒤에만 이전 파일을 정리한다.
  const keepKeys = new Set([`${shareId}/photos.json`]);
  const manifestItems = [];
  for (let i = 0; i < files.length; i++) {
    const f = files[i];
    if (!/^image\//.test(f.type || '')) continue; // 사진만 (동영상 제외)
    const m = meta[i] || {};
    const n = String(i + 1).padStart(3, '0');
    const ext = f.type === 'image/png' ? 'png' : 'jpg';
    const key = `${shareId}/photos/${n}_full.${ext}`;
    const bytes = new Uint8Array(await f.arrayBuffer());
    await env.SHARES.put(key, bytes, { httpMetadata: { contentType: f.type || 'image/jpeg' } });
    keepKeys.add(key);
    manifestItems.push({
      id: `blob-${i}`, createTime: m.createTime || new Date().toISOString(),
      width: m.width || null, height: m.height || null,
      fullUrl: `/shares/${shareId}/photos/${n}_full.${ext}`,
      thumbUrl: `/shares/${shareId}/photos/${n}_full.${ext}`,
    });
  }
  if (!manifestItems.length) return json({ error: '사진을 저장하지 못했습니다. (동영상은 공유 링크에 포함되지 않습니다)' }, 500);
  manifestItems.sort((a, b) => new Date(a.createTime) - new Date(b.createTime));

  // 이번에 쓰이지 않는 예전 파일 정리(제외된 사진·이전 확장자 등)
  const old = await env.SHARES.list({ prefix: `${shareId}/` });
  const stale = (old.objects || []).map((o) => o.key).filter((k) => !keepKeys.has(k));
  if (stale.length) await env.SHARES.delete(stale);

  const prev = await readManifest(env, shareId);
  const pin = normalizePin(form.get('pin')) || (prev && prev.pin) || genPin();
  const owner = sdata.email || sdata.name || '(게스트)';
  const curFrameName = frameNameOf(sdata, shareId);
  await writeManifest(env, shareId, { musicUrl, title, intervalSec, effect, pin, owner, frameName: curFrameName, items: manifestItems });
  return json({ url: `${env.BASE_URL}/f/${shareId}`, count: manifestItems.length, pin, frameId: shareId, frameName: curFrameName }, 200, setCookie ? { 'Set-Cookie': setCookie } : {});
}

// 공유 링크 즉시 폐기: "현재 액자"를 목록에서 완전히 제거한다.
async function shareDelete(request, env) {
  const { sid, data } = await getSession(request, env);
  if (!data) return json({ ok: true, currentFrameId: null, frames: [] });
  ensureFrames(data);
  const id = data.currentFrameId;
  if (id) {
    await deleteShare(env, id);
    const idx = data.frames.findIndex((f) => f.id === id);
    if (idx !== -1) data.frames.splice(idx, 1);
    data.currentFrameId = data.frames[0]?.id || null;
  }
  if (sid) await putSession(env, sid, data);
  return json({ ok: true, currentFrameId: data.currentFrameId, frames: await framesInfoList(env, data) });
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
  if (key.endsWith('.mp4') || key.endsWith('.m4v')) return 'video/mp4';
  if (key.endsWith('.mov')) return 'video/quicktime';
  if (key.endsWith('.webm')) return 'video/webm';
  return 'application/octet-stream';
}
// "bytes=시작-끝" 한 구간만 해석한다(동영상 재생·탐색에 필요한 형태).
function parseRange(header, size) {
  const m = /^bytes=(\d*)-(\d*)$/.exec((header || '').trim());
  if (!m) return null;
  const [, s, e] = m;
  if (s === '' && e === '') return null;
  let start, end;
  if (s === '') { // 마지막 N바이트
    const suffix = Number(e);
    if (!suffix) return null;
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(s);
    end = e === '' ? size - 1 : Math.min(Number(e), size - 1);
  }
  if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= size) return null;
  return { offset: start, length: end - start + 1, start, end };
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

  // 동영상 재생은 부분 요청(Range)에 의존한다. Range가 오면 206으로 그 구간만 돌려준다
  // (없으면 iOS/사파리가 재생을 거부하고 탐색도 되지 않는다).
  const rangeHeader = request.headers.get('Range');
  if (rangeHeader) {
    const head = await env.SHARES.head(key);
    if (!head) return text('not found', 404);
    const r = parseRange(rangeHeader, head.size);
    if (!r) {
      return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${head.size}` } });
    }
    const part = await env.SHARES.get(key, { range: { offset: r.offset, length: r.length } });
    if (!part) return text('not found', 404);
    const h = new Headers();
    h.set('Content-Type', head.httpMetadata?.contentType || guessType(key));
    h.set('X-Robots-Tag', 'noindex, nofollow');
    h.set('Accept-Ranges', 'bytes');
    h.set('Content-Range', `bytes ${r.start}-${r.end}/${head.size}`);
    h.set('Content-Length', String(r.length));
    h.set('Cache-Control', 'public, max-age=300');
    setDownloadHeader(h, url && url.searchParams.get('dl'));
    return new Response(part.body, { status: 206, headers: h });
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
  headers.set('Accept-Ranges', 'bytes'); // 브라우저가 부분 요청을 쓸 수 있음을 알린다
  setDownloadHeader(headers, url && url.searchParams.get('dl')); // ?dl=<파일명> → 저장
  return new Response(obj.body, { status: 200, headers });
}

// 예전에는 크론이 매시간 만료된 공유를 정리했으나(cleanupExpired), 자동 만료를
// 비활성화하면서 더 이상 호출하지 않는다(위 isExpired 참고).

// ---------- 라우팅 ----------
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const p = url.pathname;
    const m = request.method;
    try {
      // 로그인/회원가입 (OIDC). 구글은 예전 주소를 그대로 유지한다.
      if (p === '/auth/login' && m === 'GET') return authLogin(env, 'google');
      if (p === '/auth/callback' && m === 'GET') return authCallback(env, url, 'google');
      const mAuthLogin = p.match(/^\/auth\/([a-z]+)\/login$/);
      if (mAuthLogin && m === 'GET') {
        if (!isProvider(mAuthLogin[1])) return text('지원하지 않는 로그인 제공자입니다.', 404);
        return authLogin(env, mAuthLogin[1]);
      }
      const mAuthCb = p.match(/^\/auth\/([a-z]+)\/callback$/);
      if (mAuthCb && m === 'GET') {
        if (!isProvider(mAuthCb[1])) return text('지원하지 않는 로그인 제공자입니다.', 404);
        return authCallback(env, url, mAuthCb[1]);
      }
      if (p === '/api/status' && m === 'GET') return apiStatus(request, env);
      if (p === '/api/logout' && m === 'POST') return apiLogout(request, env);

      // 세션당 액자 목록(다중 액자)
      if (p === '/api/frames' && m === 'GET') return apiFramesGet(request, env);
      if (p === '/api/frames' && m === 'POST') return apiFramesCreate(request, env);
      if (p === '/api/frames/deselect' && m === 'POST') return apiFramesDeselect(request, env);
      const mFrameSelect = p.match(/^\/api\/frames\/([\w-]{6,})\/select$/);
      if (mFrameSelect && m === 'POST') return apiFramesSelect(request, env, mFrameSelect[1]);
      const mFrame = p.match(/^\/api\/frames\/([\w-]{6,})$/);
      if (mFrame && m === 'PUT') return apiFramesRename(request, env, mFrame[1]);
      if (mFrame && m === 'DELETE') return apiFramesDelete(request, env, mFrame[1]);

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
    // 자동 만료 정리 비활성화(위 isExpired 참고) — 크론은 등록돼 있지만 더 이상 지우지 않는다.
  },
};
