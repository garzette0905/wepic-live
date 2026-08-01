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
