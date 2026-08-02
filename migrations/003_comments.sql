-- wepic 댓글 + 비로그인 방문자 좋아요 — 이미 만들어진 DB에 1회 실행한다.
--
--   로컬:  npx wrangler d1 execute wepic-db --local  --file=./migrations/003_comments.sql
--   운영:  npx wrangler d1 execute wepic-db --remote --file=./migrations/003_comments.sql
--          (오타 주의: 데이터베이스 이름은 wepic-db 다)
--
-- 전부 IF NOT EXISTS라 여러 번 실행해도 안전하다(002와 달리 ALTER TABLE이 없다).

-- 로그인하지 않은 방문자의 좋아요. 기존 share_likes는 user_id가 NOT NULL이어서
-- 컬럼 제약을 바꾸려면 표를 다시 만들어야 하므로, 비로그인용은 별도 표로 둔다.
-- 좋아요 수는 두 표를 합해서 센다.
CREATE TABLE IF NOT EXISTS share_likes_anon (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  share_id   TEXT NOT NULL,
  visitor_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (share_id, visitor_id)
);
CREATE INDEX IF NOT EXISTS idx_share_likes_anon_share ON share_likes_anon (share_id);

-- wepic 댓글. 비로그인도 남길 수 있어 user_id는 NULL 허용, 그때는 visitor_id로 구분한다.
-- author는 표시 이름 스냅샷(회원 이름 또는 "색깔 동물" 별명).
CREATE TABLE IF NOT EXISTS share_comments (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  share_id   TEXT NOT NULL,
  user_id    INTEGER,
  visitor_id TEXT,
  author     TEXT NOT NULL,
  body       TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_share_comments_share ON share_comments (share_id, id);
