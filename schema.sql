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

  UNIQUE (provider, provider_sub)
);

-- 관리자 판정·회원 검색에서 이메일로 찾는 경우가 있어 인덱스를 둔다.
CREATE INDEX IF NOT EXISTS idx_users_email ON users (email);
-- 관리자 화면의 회원 목록은 최근 가입순으로 보여준다.
CREATE INDEX IF NOT EXISTS idx_users_created_at ON users (created_at);
