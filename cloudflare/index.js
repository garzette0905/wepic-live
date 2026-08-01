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
    // 이메일(account_email)은 카카오가 앱마다 별도 "개인정보 동의항목" 심사를 요구해
    // 신청 전에는 요청 자체가 KOE205(invalid_scope)로 거부된다. 심사 없이도 로그인은
    // 가능해야 하므로 우선 닉네임만 받는다 — 이메일은 NULL로 저장되고(스키마도 허용),
    // 나중에 심사를 통과하면 이 scope에 'account_email'을 다시 추가하면 된다.
    scope: 'openid profile_nickname',
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
  // ⚠️ 기본값으로 넘어가지 않는다. 예전에는 `env.SESSION_SECRET || '고정문자열'`이었는데,
  // 시크릿을 빼고 배포하면 **아무 경고 없이** 서명 키가 공개된 값이 되어 PIN 열람 쿠키를
  // 누구나 위조할 수 있었다. 설정이 빠졌으면 조용히 취약해지는 대신 명확히 실패시킨다.
  const secret = env.SESSION_SECRET;
  if (!secret) throw new Error('SESSION_SECRET이 설정되지 않았습니다. (PIN 보호를 사용할 수 없습니다)');
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${id}:${pin}`));
  return b64url(new Uint8Array(sig)).slice(0, 32);
}
const pinCookieName = (id) => `sp_${id}`;

// ---------- PIN 시도 횟수 제한 (무차별 대입 방어) ----------
// PIN은 4자리(10,000가지)라 제한이 없으면 스크립트로 수 초 안에 전수 조사할 수 있다.
// 같은 IP가 같은 액자에서 반복 실패하면 잠시 막는다.
//
// 막아야 하는 경로가 **두 개**라는 점이 중요하다:
//   (1) POST /api/share/:id/verify-pin  — 정상 입력 경로
//   (2) GET  /shares/:id/...            — 열람 쿠키(sp_<id>)를 위조해 직접 찔러보는 경로
// (2)를 빼놓으면 SESSION_SECRET이 새어나갔을 때 후보 쿠키 10,000개를 그대로 시도할 수 있다.
//
// 한계: KV는 최종 일관성이라 아주 빠른 동시 요청 일부는 카운터를 앞질러 통과할 수 있다.
// 확실히 막으려면 Cloudflare 대시보드의 WAF 레이트리밋 규칙(엣지 차단)을 함께 두는 것이 좋다.
const PIN_TRY_MAX = 10;        // 창 안에서 허용할 실패 횟수
const PIN_TRY_WINDOW = 60;     // 초 (KV expirationTtl 최소값이 60이다)
const clientIp = (request) => request.headers.get('CF-Connecting-IP') || 'unknown';
const pinTryKey = (id, request) => `pinfail:${id}:${clientIp(request)}`;

async function pinTriesExceeded(env, id, request) {
  const raw = await env.SESSIONS.get(pinTryKey(id, request));
  return Number(raw || 0) >= PIN_TRY_MAX;
}
// 실패를 1 올린다(성공은 세지 않는다). 실패가 이어지는 동안 창이 갱신되는 슬라이딩 방식.
async function bumpPinTries(env, id, request) {
  const k = pinTryKey(id, request);
  const n = Number((await env.SESSIONS.get(k)) || 0) + 1;
  await env.SESSIONS.put(k, String(n), { expirationTtl: PIN_TRY_WINDOW });
}
const tooManyPinTries = () =>
  json({ error: 'PIN 시도가 너무 많습니다. 잠시 후 다시 시도해주세요.', retryAfter: PIN_TRY_WINDOW },
    429, { 'Retry-After': String(PIN_TRY_WINDOW) });

// ---------- CSRF 방어 ----------
// 세션 쿠키가 SameSite=Lax라 크로스사이트 POST에는 쿠키가 실리지 않아 이미 대부분 막혀 있다.
// 다만 multipart form(/api/share/blob)은 외부 HTML form으로도 보낼 수 있고, 일부 브라우저의
// "Lax+POST" 예외 창이 있어 한 겹 더 둔다.
//
// Origin으로 판단하는 이유: 브라우저는 POST/PUT/DELETE에 Origin을 항상 붙인다.
// BASE_URL과 비교하지 않고 **요청 자신의 출처**와 비교한다 — 그래야 로컬 개발(localhost)에서도
// 그대로 동작한다(BASE_URL은 운영 주소로 고정되어 있다).
// Origin이 아예 없는 요청(curl 등)은 브라우저가 만든 것이 아니므로 CSRF가 성립하지 않고,
// 쿠키도 스스로 붙여야 하니 여기서 막지 않는다(인증 가드가 따로 처리한다).
function sameOriginRequest(request) {
  if (request.method === 'GET' || request.method === 'HEAD') return true;
  const origin = request.headers.get('Origin');
  if (!origin) return true;
  try {
    return new URL(origin).origin === new URL(request.url).origin;
  } catch {
    return false;
  }
}

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
    isPublic: !!m?.isPublic, // "전체공유" 체크 상태 — 액자를 전환할 때 화면에 그대로 복원한다
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
// 이 세션이 구글 포토(Picker·/img·/video)를 쓸 수 있는가.
// ⚠️ "refreshToken이 있으면 구글"이라고 판단하면 안 된다 — 카카오도 refresh_token을 준다.
// 반드시 제공자가 사진 권한까지 받는 곳(grantsPhotos)인지 함께 확인해야 한다.
const canUseGooglePhotos = (data) =>
  !!(data && OIDC_PROVIDERS[data.provider]?.grantsPhotos && data.refreshToken);

// 세션에서 유효한 access token 확보(만료 임박 시 갱신 후 KV에 다시 저장). 실패 시 NOT_LOGGED_IN.
// 사진 API용이므로 구글 로그인 세션만 통과한다 — 카카오 토큰을 구글 토큰 엔드포인트로 보내면
// 엉뚱한 오류가 나므로(예전에 카카오 로그인 후 "사진 선택"에서 에러가 났던 원인) 아예 막는다.
async function getAccessToken(env, sid, data) {
  if (!canUseGooglePhotos(data)) throw new Error('NOT_LOGGED_IN');
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
       -- 이미 값이 있으면 그것을 유지한다(users.X 우선). 회원이 회원정보 화면에서 직접
       -- 고친 이름·이메일이 다음 로그인 때 제공자 값으로 되돌아가지 않게 하기 위함이다.
       -- 비어 있을 때만 제공자가 준 값으로 채운다(예: 카카오 이메일 동의를 나중에 한 경우).
       email = COALESCE(users.email, excluded.email),
       name = COALESCE(users.name, excluded.name),
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
    `SELECT id, provider, provider_sub, email, name, role, status, created_at, last_login_at, quota_bytes
     FROM users WHERE id = ?1`
  )
    .bind(id)
    .first();
}

// ---------- 회원별 저장용량(Quota) ----------
// 기본 100MB. users.quota_bytes가 NULL이면 이 값을 쓴다(기본값을 바꿀 때 기존 회원을
// 전부 UPDATE하지 않아도 되도록). 관리자가 개별로 늘려주면 그 값이 우선한다.
const DEFAULT_QUOTA_BYTES = 100 * 1024 * 1024;
const quotaOf = (user) => {
  const v = Number(user?.quota_bytes);
  return Number.isFinite(v) && v > 0 ? v : DEFAULT_QUOTA_BYTES;
};

// 이 회원이 R2에서 실제로 쓰고 있는 바이트 수. 액자(공유) 폴더를 훑어 소유자가 맞는 것만
// 더한다 — 별도 집계 테이블을 두지 않는 대신, 업로드할 때와 관리자 화면에서만 계산한다.
// (photos.json 자체도 저장 공간을 쓰지만 수 KB라 사진·동영상 크기에 비해 무시할 수준이다.)
async function usedBytesOf(env, userId) {
  if (!userId) return 0;
  let total = 0;
  let cursor;
  do {
    const list = await env.SHARES.list({ cursor, delimiter: '/' });
    for (const pfx of list.delimitedPrefixes || []) {
      const id = pfx.replace(/\/$/, '');
      const m = await readManifest(env, id);
      if (!m || m.ownerUserId !== userId) continue;
      let inner;
      do {
        inner = await env.SHARES.list({ prefix: id + '/', cursor: inner?.truncated ? inner.cursor : undefined });
        for (const o of inner.objects || []) total += o.size || 0;
      } while (inner.truncated);
    }
    cursor = list.truncated ? list.cursor : null;
  } while (cursor);
  return total;
}

const fmtBytes = (n) => {
  const mb = (Number(n) || 0) / (1024 * 1024);
  return mb >= 1024 ? `${(mb / 1024).toFixed(2)}GB` : `${mb.toFixed(1)}MB`;
};
// 한 액자(공유) 폴더가 차지하는 바이트.
async function shareBytes(env, shareId) {
  let total = 0;
  let inner;
  do {
    inner = await env.SHARES.list({ prefix: shareId + '/', cursor: inner?.truncated ? inner.cursor : undefined });
    for (const o of inner.objects || []) total += o.size || 0;
  } while (inner.truncated);
  return total;
}

// 업로드 전 확인용. 이번에 올릴 크기(addBytes)를 더해도 한도를 넘지 않는지 본다.
// replaceShareId를 주면 그 액자의 현재 용량은 빼고 계산한다 — "링크변경 반영"은 기존 파일을
// 지우고 다시 올리는 것이라, 빼지 않으면 같은 사진을 다시 올릴 때 두 배로 계산돼 억울하게 막힌다.
async function quotaCheck(env, user, addBytes, replaceShareId) {
  const limit = quotaOf(user);
  const all = await usedBytesOf(env, user.id);
  const freed = replaceShareId ? await shareBytes(env, replaceShareId) : 0;
  const used = Math.max(0, all - freed);
  return { ok: used + addBytes <= limit, limit, used, addBytes };
}
const quotaExceeded = (q) =>
  json({
    error: `저장용량을 초과했습니다. (사용 ${fmtBytes(q.used)} / 한도 ${fmtBytes(q.limit)}, `
      + `이번 업로드 ${fmtBytes(q.addBytes)}) 사진을 줄이거나 기존 wepic을 삭제한 뒤 다시 시도해주세요.`,
    quotaExceeded: true, used: q.used, limit: q.limit,
  }, 413);

// ---------- 내 회원정보 ----------
// 회원이 직접 고칠 수 있는 것은 **이름과 이메일**이다. 제공자·권한·가입일은 읽기 전용.
// 여기서 고친 값은 다음 로그인 때 제공자 값으로 덮이지 않는다(upsertUser의 COALESCE 참고).
//
// 참고: 이메일은 "연락용 표시값"일 뿐이고 로그인·권한 판정에는 쓰이지 않는다
// (로그인은 provider+provider_sub, 관리자 판정은 users.role). 그래서 이메일을 바꿔도
// 남의 계정이 되거나 권한이 올라가지 않는다.
function meInfo(user, provider) {
  return {
    id: user.id,
    provider: provider || user.provider,
    email: user.email || null,
    name: user.name || null,
    role: user.role,
    status: user.status,
    createdAt: user.created_at || null,
    lastLoginAt: user.last_login_at || null,
    quotaBytes: quotaOf(user), // 사용량(usedBytes)은 계산 비용이 있어 /api/me/usage에서 따로 준다
  };
}
// 아주 느슨한 형식 검사(로컬@도메인.tld). 실제 도달 여부는 확인하지 않는다.
const isEmailLike = (s) => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(s);

async function apiMeUpdate(request, env, sess, user) {
  const body = await request.json().catch(() => ({}));
  const name = typeof body.name === 'string' ? body.name.trim().slice(0, 30) : '';
  if (!name) return json({ error: '이름을 입력하세요.' }, 400);

  // 이메일은 비워두는 것도 허용한다(카카오처럼 제공자가 안 주는 경우가 있으므로).
  // 값이 있으면 형식만 확인한다.
  const rawEmail = typeof body.email === 'string' ? body.email.trim().slice(0, 120) : '';
  if (rawEmail && !isEmailLike(rawEmail)) {
    return json({ error: '이메일 형식이 올바르지 않습니다.' }, 400);
  }
  const email = rawEmail || null;

  await env.DB.prepare('UPDATE users SET name = ?1, email = ?2 WHERE id = ?3')
    .bind(name, email, user.id)
    .run();
  // 세션 캐시(화면 상단 이름 표시용)도 함께 맞춘다.
  sess.data.name = name;
  sess.data.email = email;
  await putSession(env, sess.sid, sess.data);
  const fresh = await getUserById(env, user.id);
  return json({ ok: true, me: meInfo(fresh, sess.data.provider) });
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
    // refreshToken 유무만으로 판단하면 안 된다 — 카카오도 refresh_token을 준다.
    canPickGooglePhotos: loggedIn && canUseGooglePhotos(data),
    hasShare: !!manifest,
    sharePin: manifest ? manifest.pin || null : null, // 현재 공유의 PIN(메인화면 표시용)
    sharePublic: manifest ? !!manifest.isPublic : false, // 전체공유 체크박스 초기 상태용
    // 만들어 둔 wepic 주소 — 메인화면이 "링크변경 반영" 위에 바로 보여준다.
    shareUrl: manifest ? `${env.BASE_URL}/f/${data.currentFrameId}` : null,
    isAdmin: loggedIn && user.role === 'admin',       // Admin 메뉴 노출 여부
    // 회원정보 화면에서 쓸 값(가입일·최근 로그인). 로그인 안 했으면 null.
    me: loggedIn ? meInfo(user, data.provider) : null,
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
// 아래 액자 쓰기 API(생성·이름변경·선택·선택해제·삭제)는 모두 requireMember로 감싸서 호출되므로
// sess.data는 항상 로그인된 회원의 세션(userId 포함)이다 — 게스트 세션 생성 분기가 필요 없다.
async function apiFramesCreate(request, env, sess) {
  const { sid, data } = sess;
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
  });
}
async function apiFramesRename(request, env, sess, id) {
  const { sid, data } = sess;
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
async function apiFramesDeselect(request, env, sess) {
  const { sid, data } = sess;
  ensureFrames(data);
  data.currentFrameId = null;
  await putSession(env, sid, data);
  return json({ ok: true, currentFrameId: null });
}

async function apiFramesSelect(request, env, sess, id) {
  const { sid, data } = sess;
  ensureFrames(data);
  let f = data.frames.find((x) => x.id === id);
  if (!f) {
    // 지금 세션의 액자 목록엔 없지만, 다른 기기/세션에서 만든 "내 소유" 액자이거나
    // 관리자가 "wepic 메인화면 열기"로 여는 경우엔 자기 목록에 편입시킨 뒤 선택한다
    // (My사진관리·관리자 화면관리의 "wepic 메인화면 열기"가 이 경로를 탄다).
    const m = await readManifest(env, id);
    if (!m) return json({ error: '없는 액자입니다.' }, 404);
    const isOwner = !!m.ownerUserId && m.ownerUserId === data.userId;
    if (data.role !== 'admin' && !isOwner) return json({ error: '없는 액자입니다.' }, 404);
    f = { id, name: m.frameName || m.title || (isOwner ? '내 액자' : '관리자로 연 액자') };
    data.frames.push(f);
  }
  data.currentFrameId = f.id;
  await putSession(env, sid, data);
  return json({ ok: true, currentFrameId: f.id });
}
// 액자 삭제: R2의 폴더(사진·매니페스트)까지 완전히 지우고 목록에서도 제거한다.
async function apiFramesDelete(request, env, sess, id) {
  const { sid, data } = sess;
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

// 공유(폴더) 목록 — R2 프리픽스를 훑어 매니페스트를 읽는다(별도 DB 불필요).
// filterFn이 있으면 통과한 것만 담는다 — 관리자 화면관리(전체)와 "My사진관리"(본인
// 소유만, ownerUserId로 판별)가 이 함수를 함께 쓴다.
async function listShares(env, filterFn) {
  const shares = [];
  let cursor;
  do {
    const list = await env.SHARES.list({ cursor, delimiter: '/' });
    for (const pfx of list.delimitedPrefixes || []) {
      const id = pfx.replace(/\/$/, '');
      const m = await readManifest(env, id);
      if (!m) continue;
      if (filterFn && !filterFn(m)) continue;
      shares.push({
        id,
        title: m.title || '',
        pin: m.pin || null,
        owner: m.owner || null,
        // 전체공유 피드용 표시 이름(이메일 없이 이름만). 관리자 목록의 owner(이메일)와는
        // 용도가 달라 별도 필드로 둔다 — 회원 이름이 준비돼 있지 않던 예전 공유는 null이다.
        authorName: m.authorName || null,
        isPublic: !!m.isPublic,
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
  return shares;
}
async function adminShares(env) {
  return json({ shares: await listShares(env, null) });
}
// My사진관리: 화면관리. 이름·이메일이 아니라 D1 회원 id(ownerUserId)로 본인 소유만 걸러낸다
// — 이메일이 없거나(카카오 등) 나중에 바뀌어도 정확히 본인 것만 보이게 하기 위함이다.
async function myShares(env, userId) {
  return json({ shares: await listShares(env, (m) => m.ownerUserId === userId) });
}

// ---------- "사진 보기" 전체공유 피드 ----------
// 로그인 없이도 볼 수 있다("Wepic 조회자" 대상). isPublic인 액자만 모아 대표사진·작성자·
// 좋아요 수를 붙여 돌려준다. 좋아요는 D1(share_likes)에 있으므로 여기서만 조인한다
// (R2 매니페스트에는 좋아요를 두지 않는다 — 매번 늘어나는 값을 JSON 파일에 담으면 매
// 좋아요 클릭마다 photos.json 전체를 다시 쓰게 되어 낭비다).
async function publicShares(request, env) {
  const shares = await listShares(env, (m) => m.isPublic === true);
  const ids = shares.map((s) => s.id);
  const likeCounts = {};
  let likedByMe = new Set();
  if (ids.length) {
    const ph = ids.map(() => '?').join(',');
    const countRows = await env.DB.prepare(
      `SELECT share_id, COUNT(*) as cnt FROM share_likes WHERE share_id IN (${ph}) GROUP BY share_id`
    ).bind(...ids).all();
    for (const r of countRows.results || []) likeCounts[r.share_id] = r.cnt;

    const sess = await getSession(request, env);
    const userId = sess.data?.userId;
    if (userId) {
      const likedRows = await env.DB.prepare(
        `SELECT share_id FROM share_likes WHERE user_id = ? AND share_id IN (${ph})`
      ).bind(userId, ...ids).all();
      likedByMe = new Set((likedRows.results || []).map((r) => r.share_id));
    }
  }
  return json({
    shares: shares.map((s) => ({
      id: s.id,
      title: s.title || s.frameName || '',
      author: s.authorName || '위픽 사용자', // 이메일(owner)은 여기서 절대 내려주지 않는다
      thumbUrl: s.thumbUrl,
      count: s.count,
      updatedAt: s.updatedAt,
      likeCount: likeCounts[s.id] || 0,
      likedByMe: likedByMe.has(s.id),
    })),
  });
}

// 좋아요 토글(있으면 취소, 없으면 추가). 전체공유가 아닌 액자에는 걸 수 없다.
async function togglePublicLike(env, id, userId) {
  if (!/^[\w-]{6,}$/.test(id)) return json({ error: '잘못된 id' }, 400);
  const m = await readManifest(env, id);
  if (!m || !m.isPublic) return json({ error: '없는 공유입니다.' }, 404);
  const existing = await env.DB.prepare(
    'SELECT id FROM share_likes WHERE share_id = ?1 AND user_id = ?2'
  ).bind(id, userId).first();
  if (existing) {
    await env.DB.prepare('DELETE FROM share_likes WHERE share_id = ?1 AND user_id = ?2').bind(id, userId).run();
  } else {
    await env.DB.prepare(
      'INSERT INTO share_likes (share_id, user_id, created_at) VALUES (?1, ?2, ?3)'
    ).bind(id, userId, new Date().toISOString()).run();
  }
  const row = await env.DB.prepare('SELECT COUNT(*) as cnt FROM share_likes WHERE share_id = ?1').bind(id).first();
  return json({ ok: true, liked: !existing, likeCount: row?.cnt || 0 });
}

// "사진 보기" 예시 콘텐츠 등록(관리자 전용, 1회성). 원래 있던 데모 사진(web/public/demo/)을
// 실제 R2 공유로 복사해 isPublic:true로 만든다 — 이러면 "사진 보기"를 처음 눌러도 빈
// 화면이 아니라 예시가 보인다. 이미 등록되어 있으면 다시 만들지 않는다(멱등).
const SHOWCASE_ID = 'wepic-showcase';
async function seedShowcase(env) {
  const already = await readManifest(env, SHOWCASE_ID);
  if (already) return json({ ok: true, alreadySeeded: true, url: `${env.BASE_URL}/f/${SHOWCASE_ID}` });

  const srcRes = await env.ASSETS.fetch(new Request(env.BASE_URL + '/demo/photos.json'));
  if (!srcRes.ok) return json({ error: '예시 원본(web/public/demo)을 찾지 못했습니다.' }, 500);
  const src = await srcRes.json();

  const items = [];
  for (const it of src.items || []) {
    const [fullRes, thumbRes] = await Promise.all([
      env.ASSETS.fetch(new Request(env.BASE_URL + '/' + it.fullUrl)),
      env.ASSETS.fetch(new Request(env.BASE_URL + '/' + it.thumbUrl)),
    ]);
    if (!fullRes.ok || !thumbRes.ok) continue;
    const fullKey = `${SHOWCASE_ID}/photos/${it.id}_full.jpg`;
    const thumbKey = `${SHOWCASE_ID}/photos/${it.id}_thumb.jpg`;
    await env.SHARES.put(fullKey, new Uint8Array(await fullRes.arrayBuffer()), { httpMetadata: { contentType: 'image/jpeg' } });
    await env.SHARES.put(thumbKey, new Uint8Array(await thumbRes.arrayBuffer()), { httpMetadata: { contentType: 'image/jpeg' } });
    items.push({
      id: it.id, createTime: it.createTime, width: it.width || null, height: it.height || null,
      fullUrl: `/shares/${fullKey}`, thumbUrl: `/shares/${thumbKey}`,
    });
  }
  if (!items.length) return json({ error: '예시 사진을 하나도 옮기지 못했습니다.' }, 500);

  await writeManifest(env, SHOWCASE_ID, {
    title: 'Wepic 사진 보기 예시', musicUrl: src.musicUrl || '', intervalSec: 8, effect: 'fade',
    pin: null, isPublic: true, owner: null, authorName: 'Wepic', ownerUserId: null,
    frameName: 'Wepic 예시', items,
  });
  return json({ ok: true, url: `${env.BASE_URL}/f/${SHOWCASE_ID}` });
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

// My사진관리: PIN 수정. 본인 소유(ownerUserId 일치) 액자만 바꿀 수 있다.
async function mySetPin(request, env, userId, id) {
  if (!/^[\w-]{6,}$/.test(id)) return json({ error: '잘못된 id' }, 400);
  const m = await readManifest(env, id);
  if (!m) return json({ error: '없는 공유입니다.' }, 404);
  if (m.ownerUserId !== userId) return json({ error: '권한이 없습니다.' }, 403);
  const body = await request.json().catch(() => ({}));
  const pin = normalizePin(body.pin);
  if (!pin) return json({ error: 'PIN은 4자리 숫자여야 합니다.' }, 400);
  await env.SHARES.put(`${id}/photos.json`, JSON.stringify({ ...m, pin }, null, 2),
    { httpMetadata: { contentType: 'application/json; charset=utf-8' } });
  return json({ ok: true, pin });
}
// My사진관리: 삭제. 본인 소유(ownerUserId 일치) 액자만 지울 수 있다.
async function myDeleteShare(env, userId, id) {
  if (!/^[\w-]{6,}$/.test(id)) return json({ error: '잘못된 id' }, 400);
  const m = await readManifest(env, id);
  if (!m) return json({ error: '없는 공유입니다.' }, 404);
  if (m.ownerUserId !== userId) return json({ error: '권한이 없습니다.' }, 403);
  await deleteShare(env, id);
  return json({ ok: true });
}

// 내 저장용량 사용 현황(회원정보 화면에서 표시). R2를 훑으므로 필요할 때만 호출한다.
async function apiMeUsage(env, user) {
  const used = await usedBytesOf(env, user.id);
  const limit = quotaOf(user);
  return json({ used, limit, usedText: fmtBytes(used), limitText: fmtBytes(limit) });
}

// ---------- 회원탈퇴 ----------
// 탈퇴하면 (1) 이 회원이 만든 wepic 컨텐츠(R2 폴더)를 모두 지우고, (2) 좋아요 기록을 지우고,
// (3) users 행을 지우고, (4) 세션을 없앤다. 되돌릴 수 없다.
// 확인 대화상자는 화면에서 띄우고, 서버는 confirm 필드로 한 번 더 방어한다(실수 호출 방지).
async function apiWithdraw(request, env, sess, user) {
  const body = await request.json().catch(() => ({}));
  if (body.confirm !== 'DELETE') {
    return json({ error: '탈퇴 확인이 필요합니다.' }, 400);
  }
  // (1) 내가 만든 wepic 전부 삭제 — ownerUserId로 판별한다(이름·이메일이 아니라 고유 id).
  const mine = [];
  let cursor;
  do {
    const list = await env.SHARES.list({ cursor, delimiter: '/' });
    for (const pfx of list.delimitedPrefixes || []) {
      const id = pfx.replace(/\/$/, '');
      const m = await readManifest(env, id);
      if (m && m.ownerUserId === user.id) mine.push(id);
    }
    cursor = list.truncated ? list.cursor : null;
  } while (cursor);
  for (const id of mine) await deleteShare(env, id);

  // (2) 좋아요 기록 (남의 공유에 눌러둔 것도 함께 정리)
  await env.DB.prepare('DELETE FROM share_likes WHERE user_id = ?1').bind(user.id).run();
  // (3) 회원 행
  await env.DB.prepare('DELETE FROM users WHERE id = ?1').bind(user.id).run();
  // (4) 세션 — 쿠키까지 지워 즉시 로그아웃 상태가 되게 한다.
  await delSession(env, sess.sid);
  return json({ ok: true, deletedShares: mine.length }, 200, { 'Set-Cookie': clearCookie() });
}

// 탈퇴 전에 "무엇이 지워지는지" 미리 보여주기 위한 요약(팝업에서 사용).
async function apiWithdrawPreview(env, user) {
  const shares = await listShares(env, (m) => m.ownerUserId === user.id);
  const used = await usedBytesOf(env, user.id);
  const photos = shares.reduce((n, s) => n + (s.count || 0), 0);
  return json({ shareCount: shares.length, photoCount: photos, usedText: fmtBytes(used) });
}

// ---------- 관리자: 회원관리 ----------
// 회원 목록 + 개인별 Quota·현재 사용량. 사용량은 R2를 훑어 계산하므로 회원 수가 많아지면
// 느려질 수 있다 — 지금 규모(수십 명)에서는 충분하고, 커지면 집계 테이블로 옮기면 된다.
async function adminMembers(env) {
  const rows = await env.DB.prepare(
    `SELECT id, provider, provider_sub, email, name, role, status, created_at, last_login_at, quota_bytes
     FROM users ORDER BY created_at DESC`
  ).all();
  const users = rows.results || [];

  // 회원별 사용량을 한 번의 R2 순회로 모아 계산한다(회원마다 훑으면 N배 느려진다).
  const usedByUser = new Map();
  let cursor;
  do {
    const list = await env.SHARES.list({ cursor, delimiter: '/' });
    for (const pfx of list.delimitedPrefixes || []) {
      const id = pfx.replace(/\/$/, '');
      const m = await readManifest(env, id);
      if (!m || !m.ownerUserId) continue;
      let sum = 0;
      let inner;
      do {
        inner = await env.SHARES.list({ prefix: id + '/', cursor: inner?.truncated ? inner.cursor : undefined });
        for (const o of inner.objects || []) sum += o.size || 0;
      } while (inner.truncated);
      usedByUser.set(m.ownerUserId, (usedByUser.get(m.ownerUserId) || 0) + sum);
    }
    cursor = list.truncated ? list.cursor : null;
  } while (cursor);

  return json({
    defaultQuotaBytes: DEFAULT_QUOTA_BYTES,
    members: users.map((u) => {
      const used = usedByUser.get(u.id) || 0;
      const limit = quotaOf(u);
      return {
        id: u.id, provider: u.provider, email: u.email || null, name: u.name || null,
        role: u.role, status: u.status, createdAt: u.created_at || null, lastLoginAt: u.last_login_at || null,
        quotaBytes: limit,
        isDefaultQuota: !(Number(u.quota_bytes) > 0), // 기본값을 따르는 중인지(관리자 화면 표시용)
        usedBytes: used,
        usedText: fmtBytes(used), quotaText: fmtBytes(limit),
        usedPercent: limit > 0 ? Math.min(100, Math.round((used / limit) * 100)) : 0,
      };
    }),
  });
}

// 관리자: 특정 회원의 Quota 변경. quotaMb를 비우거나 0으로 보내면 기본값(NULL)으로 돌린다.
async function adminSetQuota(request, env, id) {
  const target = await getUserById(env, Number(id));
  if (!target) return json({ error: '없는 회원입니다.' }, 404);
  const body = await request.json().catch(() => ({}));
  const mb = Number(body.quotaMb);
  if (body.quotaMb !== null && body.quotaMb !== '' && !(Number.isFinite(mb) && mb >= 0)) {
    return json({ error: '용량(MB)은 0 이상의 숫자여야 합니다.' }, 400);
  }
  // 0이나 빈 값 → NULL(기본값 따름). 그 외에는 MB를 바이트로 바꿔 저장한다.
  const bytes = Number.isFinite(mb) && mb > 0 ? Math.round(mb * 1024 * 1024) : null;
  await env.DB.prepare('UPDATE users SET quota_bytes = ?1 WHERE id = ?2').bind(bytes, target.id).run();
  return json({ ok: true, quotaBytes: bytes || DEFAULT_QUOTA_BYTES, isDefaultQuota: bytes === null });
}

// ---------- Spotify (30초 미리듣기) ----------
// Client Credentials 플로우로 앱 토큰을 받아 곡을 검색한다(사용자 Spotify 로그인 불필요).
// 반환하는 preview_url은 Spotify가 제공하는 **30초 미리듣기 MP3**다 — 전체 곡 재생은
// Spotify 정책상 웹 임베드/SDK로만 가능하고 유료 계정이 필요해서, 여기서는 미리듣기만 쓴다.
let spotifyToken = null; // { value, expiresAt } — Worker 인스턴스 메모리에 잠깐 캐시
const spotifyConfigured = (env) => !!(env.SPOTIFY_CLIENT_ID && env.SPOTIFY_CLIENT_SECRET);
async function spotifyAccessToken(env) {
  if (spotifyToken && spotifyToken.expiresAt > Date.now() + 10_000) return spotifyToken.value;
  const basic = btoa(`${env.SPOTIFY_CLIENT_ID}:${env.SPOTIFY_CLIENT_SECRET}`);
  const r = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: { Authorization: 'Basic ' + basic, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=client_credentials',
  });
  if (!r.ok) throw new Error(`Spotify 토큰 요청 실패 (${r.status})`);
  const d = await r.json();
  spotifyToken = { value: d.access_token, expiresAt: Date.now() + (d.expires_in || 3600) * 1000 };
  return spotifyToken.value;
}

async function spotifySearch(env, url) {
  const q = (url.searchParams.get('q') || '').trim();
  if (!q) return json({ error: '검색어를 입력하세요.' }, 400);
  // 키가 없으면 "서버 오류"가 아니라 아직 준비되지 않았다고 분명히 알려준다
  // (YouTube는 그대로 쓸 수 있으므로 치명적 오류가 아니다).
  if (!spotifyConfigured(env)) {
    return json({ error: 'Spotify 연동이 아직 설정되지 않았습니다. 배경음악은 YouTube 링크를 써주세요.' }, 503);
  }
  let token;
  try {
    token = await spotifyAccessToken(env);
  } catch (err) {
    return json({ error: 'Spotify 인증에 실패했습니다: ' + err.message }, 502);
  }
  const api = new URL('https://api.spotify.com/v1/search');
  api.searchParams.set('q', q);
  api.searchParams.set('type', 'track');
  api.searchParams.set('limit', '20');
  const r = await fetch(api.toString(), { headers: { Authorization: 'Bearer ' + token } });
  if (!r.ok) return json({ error: `Spotify 검색 실패 (${r.status})` }, 502);
  const d = await r.json();
  const tracks = (d.tracks?.items || []).map((t) => ({
    id: t.id,
    name: t.name,
    artist: (t.artists || []).map((a) => a.name).join(', '),
    // preview_url이 없는 곡도 많다(권리사 정책·앱 등록 시점에 따라 다름) → 화면에서 걸러 표시한다.
    previewUrl: t.preview_url || null,
    image: t.album?.images?.[t.album.images.length - 1]?.url || null,
  }));
  const playable = tracks.filter((t) => t.previewUrl);
  return json({ tracks: playable, totalFound: tracks.length, playableCount: playable.length });
}

// PIN 입력 → 맞으면 열람 쿠키 발급(24시간)
async function verifyPin(request, env, id) {
  if (!/^[\w-]{6,}$/.test(id)) return json({ error: '잘못된 링크입니다.' }, 404);
  const m = await readManifest(env, id);
  if (!m) return json({ error: '공유 사진을 찾을 수 없습니다.' }, 404);
  if (!m.pin) return json({ ok: true }); // PIN 없는 공유(기존 링크)
  // 무차별 대입 방어: 이 IP가 이 액자에서 이미 너무 많이 틀렸으면 검사 자체를 하지 않는다.
  if (await pinTriesExceeded(env, id, request)) return tooManyPinTries();
  const body = await request.json().catch(() => ({}));
  const pin = normalizePin(body.pin);
  if (!pin || pin !== m.pin) {
    await bumpPinTries(env, id, request);
    return json({ error: 'PIN 번호가 올바르지 않습니다.' }, 403);
  }
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

// 구글 자산을 액세스 토큰으로 가져온다. **리다이렉트를 자동으로 따라가지 않는다** —
// fetch가 리다이렉트를 따라갈 때 Authorization 헤더가 같이 전달되므로, 구글 쪽에 오픈
// 리다이렉트가 있으면 사용자의 액세스 토큰이 제3자에게 새어나갈 수 있다.
// 직접 받아서 이동 대상 호스트를 다시 검증하고, 허용 호스트일 때만 따라간다.
async function fetchGoogleAsset(target, token, extraHeaders = {}) {
  let next = target;
  for (let hop = 0; hop < 3; hop++) {
    const r = await fetch(next, {
      headers: { Authorization: 'Bearer ' + token, ...extraHeaders },
      redirect: 'manual',
    });
    if (r.status < 300 || r.status >= 400) return r;
    const loc = r.headers.get('location');
    if (!loc) return r;
    const dest = new URL(loc, next).toString();
    if (!allowedHost(dest)) throw new Error('허용되지 않은 호스트로 리다이렉트되었습니다.');
    next = dest;
  }
  throw new Error('리다이렉트가 너무 많습니다.');
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
  let r;
  try {
    r = await fetchGoogleAsset(`${u}=${sz}`, token);
  } catch {
    return text('image fetch failed', 502); // 허용 안 된 리다이렉트 등
  }
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
  const range = request.headers.get('Range');
  let r;
  try {
    r = await fetchGoogleAsset(`${u}=dv`, token, range ? { Range: range } : {});
  } catch {
    return text('video fetch failed', 502); // 허용 안 된 리다이렉트 등
  }
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
  // 리다이렉트 대상 호스트를 검증하는 안전한 fetch를 쓴다(토큰 유출 방지 — fetchGoogleAsset 참고)
  const r = await fetchGoogleAsset(`${base}=${sz}`, token);
  if (!r.ok) throw new Error('image fetch ' + r.status);
  return new Uint8Array(await r.arrayBuffer());
}

// 동영상 원본(=dv)을 R2에 그대로 저장한다. 공유 화면은 로그인이 없어 구글 원본 URL
// (/video 프록시)을 쓸 수 없으므로, 파일 자체를 저장해야 재생할 수 있다.
// 응답 본문을 스트림으로 그대로 넘겨 메모리에 다 올리지 않는다(큰 파일 대비).
// budgetBytes를 주면 "남은 저장용량"으로도 함께 제한한다(넘으면 throw → 호출부가 포스터만 남긴다).
async function putVideoToR2(env, base, token, key, budgetBytes) {
  const r = await fetchGoogleAsset(`${base}=dv`, token);
  if (!r.ok) throw new Error('video fetch ' + r.status);
  const len = Number(r.headers.get('content-length') || 0);
  const max = Math.min(maxShareVideoBytes(env), Number.isFinite(budgetBytes) ? budgetBytes : Infinity);
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
  // Spotify 미리듣기는 주소만으로 곡목을 알 수 없어 화면이 보내준 값을 저장한다.
  const musicTitle = typeof body.musicTitle === 'string' ? body.musicTitle.slice(0, 60) : '';
  // 화면에서 정한 wepic 이름. 새로 만들 때는 이 이름으로 액자를 만들고,
  // 이미 있는 액자면 이름을 바꾸지 않는다(만든 뒤에는 이름 고정).
  const wantName = typeof body.frameName === 'string' ? body.frameName.trim().slice(0, 30) : '';
  const title = typeof body.title === 'string' ? body.title.slice(0, 40) : '';
  const intervalSec = Math.min(60, Math.max(3, Number(body.intervalSec) || 10));
  const effect = ['fade', 'slide', 'kenburns'].includes(body.effect) ? body.effect : 'fade';
  const isPublic = !!body.isPublic; // "전체공유" 체크 — 켜면 PIN 없이 누구나 볼 수 있게 만든다
  if (!items.length) return json({ error: '공유할 사진이 없습니다.' }, 400);

  ensureFrames(sess.data);
  if (!sess.data.currentFrameId) {
    const newId = randomId(9);
    sess.data.frames.push({ id: newId, name: wantName || `액자 ${sess.data.frames.length + 1}` });
    sess.data.currentFrameId = newId;
  }
  const shareId = sess.data.currentFrameId;
  await putSession(env, sess.sid, sess.data);

  // 저장용량: 구글에서 받아오는 방식은 **미리 크기를 알 수 없다**(파일이 아니라 URL을 받는다).
  // 그래서 (1) 시작 전에 이미 한도를 넘었는지 보고, (2) 한 장씩 저장하면서 누적 크기를 재
  // 한도에 닿으면 그 시점에서 멈춘다. 멈췄으면 응답에 몇 장만 저장됐는지 알려준다.
  const quotaUser = await getUserById(env, sess.data?.userId);
  const quotaLimit = quotaOf(quotaUser);
  // 이 액자는 아래에서 덮어쓰므로(기존 파일 정리) 현재 용량은 빼고 시작점을 잡는다.
  const quotaBase = Math.max(0, (await usedBytesOf(env, sess.data?.userId)) - (await shareBytes(env, shareId)));
  if (quotaBase >= quotaLimit) {
    return quotaExceeded({ used: quotaBase, limit: quotaLimit, addBytes: 0 });
  }
  let quotaRunning = 0;   // 이번에 새로 저장한 바이트 누적
  let quotaStopped = false; // 한도 때문에 중단했는지

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
    if (quotaStopped) break; // 한도에 닿았으면 더 받아오지 않는다
    const base = baseUrlFromImgPath(it.fullUrl || '');
    if (!base) continue;
    const n = String(++maxIdx).padStart(3, '0');
    try {
      // 동영상도 정지 프레임(포스터)은 항상 저장한다 — 재생 전 표시 및 재생 실패 시 대체용.
      const full = await downloadImage(base, 'w1920-h1080', token);
      const thumb = await downloadImage(base, 'w300-h300-c', token);
      // 받아온 실제 크기로 한도를 확인한다. 넘으면 이 사진은 저장하지 않고 여기서 멈춘다.
      if (quotaBase + quotaRunning + full.byteLength + thumb.byteLength > quotaLimit) {
        quotaStopped = true;
        maxIdx--; // 쓰지 않은 번호는 돌려놓는다
        break;
      }
      quotaRunning += full.byteLength + thumb.byteLength;
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
          const budget = quotaLimit - (quotaBase + quotaRunning);
          await putVideoToR2(env, base, token, `${shareId}/photos/${n}_video.mp4`, budget);
          keepKeys.add(`${shareId}/photos/${n}_video.mp4`);
          entry.type = 'video';
          entry.videoUrl = `/shares/${shareId}/photos/${n}_video.mp4`;
          // 스트리밍으로 올렸으므로 실제 저장된 크기를 다시 읽어 누적한다.
          const head = await env.SHARES.head(`${shareId}/photos/${n}_video.mp4`);
          quotaRunning += head?.size || 0;
        } catch (err) {
          console.warn(`동영상 저장 실패(${it.id}): ${err.message} → 정지 이미지로 대체`);
        }
      }
      manifestItems.push(entry);
    } catch { /* 개별 실패는 건너뜀 */ }
  }
  if (!manifestItems.length) {
    // 한 장도 못 넣은 이유가 용량이면 그렇게 알려준다(원인을 알 수 없는 500보다 낫다).
    if (quotaStopped) return quotaExceeded({ used: quotaBase, limit: quotaLimit, addBytes: 0 });
    return json({ error: '사진을 저장하지 못했습니다. 다시 시도해주세요.' }, 500);
  }

  // 이번에 쓰이지 않는 예전 파일 정리(제외된 사진·동영상)
  const old = await env.SHARES.list({ prefix: `${shareId}/` });
  const stale = (old.objects || []).map((o) => o.key).filter((k) => !keepKeys.has(k));
  if (stale.length) await env.SHARES.delete(stale);
  manifestItems.sort((a, b) => new Date(a.createTime) - new Date(b.createTime));
  // PIN: 전체공유(isPublic)면 PIN을 아예 두지 않는다(비공개→공개로 바꾼 경우 기존 PIN도
  // 씻어낸다). 전체공유가 아니면 기존 로직 그대로 — 클라이언트가 보낸 값이 유효하면 그것
  // (=링크변경 반영 시 수정된 PIN), 없으면 기존 유지, 그것도 없으면 새로 4자리 발급.
  const prev = await readManifest(env, shareId);
  const pin = isPublic ? null : (normalizePin(body.pin) || (prev && prev.pin) || genPin());
  const owner = sess.data?.email || sess.data?.name || null;
  // 전체공유 피드에는 이메일을 노출하지 않는다 — 이름만 스냅샷해 둔다.
  const authorName = sess.data?.name || '위픽 사용자';
  const curFrameName = frameNameOf(sess.data, shareId);
  await writeManifest(env, shareId, {
    musicUrl, musicTitle, title, intervalSec, effect, pin, owner, authorName, isPublic,
    ownerUserId: sess.data?.userId || null, // "My사진관리"에서 본인 소유만 걸러낼 고유 키(D1 회원 id)
    frameName: curFrameName, items: manifestItems,
  });
  return json({
    url: `${env.BASE_URL}/f/${shareId}`, count: manifestItems.length, pin, isPublic,
    frameId: shareId, frameName: curFrameName,
    // 용량 때문에 일부만 저장했으면 화면에서 안내할 수 있게 알려준다.
    ...(quotaStopped ? { quotaStopped: true, quotaLimitText: fmtBytes(quotaLimit) } : {}),
  });
}

// 구글 포토 "공유"로 받은 사진 등: 브라우저가 가진 파일(blob)을 그대로 올려 공유 링크 생성.
// requireMember로 감싸 호출되므로 로그인한 Wepic 회원만 쓸 수 있다(게스트는 401).
async function shareBlob(request, env, sess, user) {
  const form = await request.formData();
  const files = form.getAll('files').filter((f) => f && typeof f.size === 'number' && f.size > 0);
  if (!files.length) return json({ error: '공유할 사진이 없습니다.' }, 400);
  let meta = [];
  try { meta = JSON.parse(form.get('meta') || '[]'); } catch { /* 무시 */ }
  const musicUrl = typeof form.get('musicUrl') === 'string' ? form.get('musicUrl') : '';
  const musicTitle = String(form.get('musicTitle') || '').slice(0, 60);
  const wantName = String(form.get('frameName') || '').trim().slice(0, 30);
  const title = String(form.get('title') || '').slice(0, 40);
  const intervalSec = Math.min(60, Math.max(3, Number(form.get('intervalSec')) || 10));
  const effect = ['fade', 'slide', 'kenburns'].includes(form.get('effect')) ? form.get('effect') : 'fade';
  const isPublic = ['true', '1', 'on'].includes(String(form.get('isPublic') || '').toLowerCase());

  const { sid: ssid, data: sdata } = sess;
  ensureFrames(sdata);
  if (!sdata.currentFrameId) {
    const newId = randomId(9);
    sdata.frames.push({ id: newId, name: wantName || `액자 ${sdata.frames.length + 1}` });
    sdata.currentFrameId = newId;
  }
  const shareId = sdata.currentFrameId;
  await putSession(env, ssid, sdata);

  // 저장용량 확인 — 실제로 R2에 쓰기 전에 막는다(쓰고 나서 되돌리면 이미 용량을 쓴 상태가 된다).
  // 이 액자를 덮어쓰는 것이므로 기존 용량은 빼고 계산한다.
  const incomingBytes = files.reduce((n, f) => n + (f.size || 0), 0);
  const quota = await quotaCheck(env, user, incomingBytes, shareId);
  if (!quota.ok) return quotaExceeded(quota);

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
  const pin = isPublic ? null : (normalizePin(form.get('pin')) || (prev && prev.pin) || genPin());
  const owner = user.email || user.name || null;
  const authorName = user.name || '위픽 사용자';
  const curFrameName = frameNameOf(sdata, shareId);
  await writeManifest(env, shareId, {
    musicUrl, musicTitle, title, intervalSec, effect, pin, owner, authorName, isPublic,
    ownerUserId: user.id, // "My사진관리"에서 본인 소유만 걸러낼 고유 키(D1 회원 id)
    frameName: curFrameName, items: manifestItems,
  });
  return json({ url: `${env.BASE_URL}/f/${shareId}`, count: manifestItems.length, pin, isPublic, frameId: shareId, frameName: curFrameName });
}

// 공유 링크 즉시 폐기: "현재 액자"를 목록에서 완전히 제거한다.
async function shareDelete(request, env, sess) {
  const { sid, data } = sess;
  ensureFrames(data);
  const id = data.currentFrameId;
  if (id) {
    await deleteShare(env, id);
    const idx = data.frames.findIndex((f) => f.id === id);
    if (idx !== -1) data.frames.splice(idx, 1);
    data.currentFrameId = data.frames[0]?.id || null;
  }
  await putSession(env, sid, data);
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
  // 경로 이탈 패턴 방어(심층 방어). R2는 평면 키-값 저장소라 `..`에 상위 디렉터리 의미가
  // 없고 위 정규식이 접두사를 강제하므로 현재 구조에서는 악용되지 않지만, 나중에 키 파싱이
  // 바뀌어도 안전하도록 명시적으로 막아둔다.
  if (key.includes('..') || key.includes('//') || /%2e%2e/i.test(key)) return text('not found', 404);
  const id = key.split('/')[0];

  // PIN이 걸린 공유는 열람 쿠키가 없으면 차단한다. 화면에서만 막으면 이 URL을 직접 열어
  // 우회할 수 있으므로 photos.json과 사진 파일 자체를 서버에서 막아야 한다.
  const manifest = await readManifest(env, id);
  if (manifest && manifest.pin && !(await canViewShare(request, env, id, manifest))) {
    // 쿠키 위조로 이 경로를 반복해서 찔러보는 것도 무차별 대입이므로 같이 제한한다.
    if (await pinTriesExceeded(env, id, request)) return tooManyPinTries();
    await bumpPinTries(env, id, request);
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
      // CSRF 방어: 상태를 바꾸는 요청은 같은 출처에서 온 것만 받는다.
      // 라우팅 맨 앞에서 한 번 검사해 엔드포인트를 하나라도 빠뜨리는 일이 없게 한다.
      if (!sameOriginRequest(request)) {
        return json({ error: '잘못된 요청 출처입니다.' }, 403);
      }

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

      // 세션당 액자 목록(다중 액자). 조회(GET)는 게스트도 허용하지만(자기 세션 조회일 뿐),
      // 생성·이름변경·선택·선택해제·삭제는 모두 KV/R2 쓰기 작업이라 requireMember로 막는다.
      if (p === '/api/frames' && m === 'GET') return apiFramesGet(request, env);
      if (p === '/api/frames' && m === 'POST') {
        return requireMember(request, env, (rq, en, sess) => apiFramesCreate(rq, en, sess));
      }
      if (p === '/api/frames/deselect' && m === 'POST') {
        return requireMember(request, env, (rq, en, sess) => apiFramesDeselect(rq, en, sess));
      }
      const mFrameSelect = p.match(/^\/api\/frames\/([\w-]{6,})\/select$/);
      if (mFrameSelect && m === 'POST') {
        return requireMember(request, env, (rq, en, sess) => apiFramesSelect(rq, en, sess, mFrameSelect[1]));
      }
      const mFrame = p.match(/^\/api\/frames\/([\w-]{6,})$/);
      if (mFrame && m === 'PUT') {
        return requireMember(request, env, (rq, en, sess) => apiFramesRename(rq, en, sess, mFrame[1]));
      }
      if (mFrame && m === 'DELETE') {
        return requireMember(request, env, (rq, en, sess) => apiFramesDelete(rq, en, sess, mFrame[1]));
      }

      if (p === '/api/picker/session' && m === 'POST') return requireLogin(request, env, (rq, en, tok) => pickerCreate(rq, en, tok));
      const mSess = p.match(/^\/api\/picker\/session\/([^/]+)$/);
      if (mSess && m === 'GET') return requireLogin(request, env, (rq, en, tok) => pickerPoll(en, tok, mSess[1]));
      if (mSess && m === 'DELETE') return requireLogin(request, env, (rq, en, tok) => pickerDelete(en, tok, mSess[1]));
      if (p === '/api/picker/media' && m === 'GET') return requireLogin(request, env, (rq, en, tok) => pickerMedia(en, tok, url));

      if (p === '/img' && m === 'GET') return requireLogin(request, env, (rq, en, tok) => imgProxy(en, tok, url));
      if (p === '/video' && m === 'GET') return requireLogin(request, env, (rq, en, tok) => videoProxy(rq, en, tok, url));

      if (p === '/api/share' && m === 'POST') return requireLogin(request, env, (rq, en, tok, sess) => shareCreate(rq, en, tok, sess));
      if (p === '/api/share' && m === 'DELETE') {
        return requireMember(request, env, (rq, en, sess) => shareDelete(rq, en, sess));
      }
      if (p === '/api/share/blob' && m === 'POST') {
        return requireMember(request, env, (rq, en, sess, user) => shareBlob(rq, en, sess, user));
      }
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
      // "사진 보기" 예시 콘텐츠 등록(1회성, 멱등) — 관리자 화면의 버튼이 호출한다.
      if (p === '/api/admin/seed-showcase' && m === 'POST') {
        return requireAdmin(request, env, (rq, en) => seedShowcase(en));
      }
      // 관리자: 회원관리 (목록 + 개인별 Quota·사용량)
      if (p === '/api/admin/members' && m === 'GET') {
        return requireAdmin(request, env, (rq, en) => adminMembers(en));
      }
      const mAdminQuota = p.match(/^\/api\/admin\/members\/(\d+)\/quota$/);
      if (mAdminQuota && m === 'PUT') {
        return requireAdmin(request, env, (rq, en) => adminSetQuota(rq, en, mAdminQuota[1]));
      }

      // Spotify 곡 검색 (30초 미리듣기 URL을 돌려준다). 로그인한 회원만.
      if (p === '/api/spotify/search' && m === 'GET') {
        return requireMember(request, env, (rq, en) => spotifySearch(en, url));
      }

      // 내 저장용량 사용 현황 / 회원탈퇴
      if (p === '/api/me/usage' && m === 'GET') {
        return requireMember(request, env, (rq, en, sess, user) => apiMeUsage(en, user));
      }
      if (p === '/api/me/withdraw-preview' && m === 'GET') {
        return requireMember(request, env, (rq, en, sess, user) => apiWithdrawPreview(en, user));
      }
      if (p === '/api/me/withdraw' && m === 'POST') {
        return requireMember(request, env, (rq, en, sess, user) => apiWithdraw(rq, en, sess, user));
      }

      // "사진 보기": 전체공유(isPublic) 액자 피드. 로그인 없이도 볼 수 있다(Wepic 조회자 대상).
      if (p === '/api/public/shares' && m === 'GET') return publicShares(request, env);
      const mPubLike = p.match(/^\/api\/public\/shares\/([\w-]{6,})\/like$/);
      if (mPubLike && m === 'POST') {
        return requireMember(request, env, (rq, en, sess, user) => togglePublicLike(en, mPubLike[1], user.id));
      }

      // 내 회원정보: 표시 이름만 수정 가능(제공자·이메일·가입일은 읽기 전용)
      if (p === '/api/me' && m === 'PUT') {
        return requireMember(request, env, (rq, en, sess, user) => apiMeUpdate(rq, en, sess, user));
      }

      // My사진관리: 로그인한 회원 본인이 만든 액자만 보임(ownerUserId로 필터)
      if (p === '/api/my/shares' && m === 'GET') {
        return requireMember(request, env, (rq, en, sess, user) => myShares(en, user.id));
      }
      const mMyShare = p.match(/^\/api\/my\/shares\/([\w-]{6,})$/);
      if (mMyShare && m === 'DELETE') {
        return requireMember(request, env, (rq, en, sess, user) => myDeleteShare(en, user.id, mMyShare[1]));
      }
      const mMyPin = p.match(/^\/api\/my\/shares\/([\w-]{6,})\/pin$/);
      if (mMyPin && m === 'PUT') {
        return requireMember(request, env, (rq, en, sess, user) => mySetPin(rq, en, user.id, mMyPin[1]));
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
