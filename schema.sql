-- Wepic Live — Cloudflare D1 스키마 (회원관리)
--
-- 적용 방법:
--   로컬(개발):  npx wrangler d1 execute wepic-db --local  --file=./schema.sql
--   운영(배포):  npx wrangler d1 execute wepic-db --remote --file=./schema.sql
--
-- 설계 원칙: OIDC 제공자(구글·카카오·네이버)가 신원을 보증하므로, 우리 DB에는
-- "이 사람이 누구인지 알아볼 최소 정보"만 둔다. 비밀번호는 저장하지 않는다(애초에 받지 않음).

CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,

  -- 로그인 제공자와 그쪽에서 주는 계정 고유 ID.
  -- 이메일은 바뀔 수 있어 회원 식별 키로 쓰지 않고, (provider, provider_sub)를 키로 쓴다.
  provider      TEXT NOT NULL,                      -- 'google' | 'kakao' | 'naver'
  provider_sub  TEXT NOT NULL,                      -- OIDC의 sub (카카오·네이버는 회원번호)

  email         TEXT,                               -- 제공자가 안 주면 NULL 가능
  name          TEXT,

  -- 권한: 'admin'(Wepic 관리자) | 'user'(Wepic 사용자)
  -- Wepic 조회자는 로그인이 없으므로 이 표에 없다.
  role          TEXT NOT NULL DEFAULT 'user',
  -- 상태: 'active'(정상) | 'blocked'(차단). 신규 가입은 자동 승인이라 바로 active.
  status        TEXT NOT NULL DEFAULT 'active',

  created_at    TEXT NOT NULL,                      -- ISO8601
  last_login_at TEXT,

  -- 저장용량 한도(바이트). NULL이면 기본값(100MB)을 쓴다 — 기본값을 바꾸고 싶을 때
  -- 이미 가입한 회원 전체를 UPDATE하지 않아도 되도록 NULL을 "기본값 따름"으로 둔다.
  -- 관리자가 개별로 늘려주면 그때 값이 채워진다.
  quota_bytes   INTEGER,

  UNIQUE (provider, provider_sub)
);
-- ⚠️ users 테이블이 이미 있는 DB에는 위 CREATE가 건너뛰어지므로 quota_bytes가 생기지 않는다.
--    그런 DB에는 migrations/002_add_quota.sql을 한 번 실행해야 한다(아래 파일 참고).
--    SQLite에는 ALTER TABLE ... ADD COLUMN IF NOT EXISTS가 없어서 이 파일에 넣으면
--    재실행할 때마다 "duplicate column" 오류로 멈춘다 → 별도 파일로 분리했다.

-- 관리자 판정·회원 검색에서 이메일로 찾는 경우가 있어 인덱스를 둔다.
CREATE INDEX IF NOT EXISTS idx_users_email ON users (email);
-- 관리자 화면의 회원 목록은 최근 가입순으로 보여준다.
CREATE INDEX IF NOT EXISTS idx_users_created_at ON users (created_at);

-- "전체공유"(PIN 없이 누구나 볼 수 있는 공유)에 붙는 좋아요.
-- share_id는 R2의 액자(공유) id를 그대로 쓴다 — R2가 원본이라 D1에 별도 share 테이블을
-- 두지 않는다. (share_id, user_id) UNIQUE로 "누른 적 있음(행 존재)"만 의미하고,
-- 취소하면 행을 지운다(카운트는 COUNT(*)로 그때그때 계산).
-- 향후 댓글 기능을 추가한다면 같은 모양(share_id + user_id + 내용)의 별도 테이블로 두면 된다.
CREATE TABLE IF NOT EXISTS share_likes (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  share_id   TEXT NOT NULL,
  user_id    INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (share_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_share_likes_share ON share_likes (share_id);

-- 로그인하지 않은 방문자의 좋아요. 위 share_likes는 user_id가 NOT NULL이라(이미 운영 중인
-- 표라 컬럼 제약을 바꾸려면 표를 다시 만들어야 한다) 비로그인용은 별도 표로 둔다.
-- 좋아요 수는 두 표를 합해서 센다. visitor_id는 브라우저에 심는 wvid 쿠키 값이다.
CREATE TABLE IF NOT EXISTS share_likes_anon (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  share_id   TEXT NOT NULL,
  visitor_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (share_id, visitor_id)
);
CREATE INDEX IF NOT EXISTS idx_share_likes_anon_share ON share_likes_anon (share_id);

-- wepic 댓글. 로그인하지 않은 사람도 남길 수 있어 user_id는 NULL을 허용하고,
-- 그때는 visitor_id(브라우저 쿠키)로 같은 사람인지 구분한다.
-- author는 "표시 이름 스냅샷"이다 — 나중에 회원이 이름을 바꿔도 이미 쓴 댓글은 그대로 남고,
-- 비로그인 방문자의 "색깔 동물" 별명도 여기에 굳는다.
CREATE TABLE IF NOT EXISTS share_comments (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  share_id   TEXT NOT NULL,
  user_id    INTEGER,
  visitor_id TEXT,
  author     TEXT NOT NULL,
  body       TEXT NOT NULL,            -- 50자 이내(서버에서 자름)
  created_at TEXT NOT NULL
);
-- 최신 댓글부터 읽고, "내가 본 것 이후"만 가져오는 실시간 갱신에 쓰는 인덱스.
CREATE INDEX IF NOT EXISTS idx_share_comments_share ON share_comments (share_id, id);
