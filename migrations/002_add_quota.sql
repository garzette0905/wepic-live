-- 회원별 저장용량(Quota) 컬럼 추가 — 이미 users 테이블이 있는 DB에만 1회 실행한다.
--
--   로컬:  npx wrangler d1 execute wepic-db --local  --file=./migrations/002_add_quota.sql
--   운영:  npx wrangler d1 execute wepic-db --remote --file=./migrations/002_add_quota.sql
--
-- 이미 실행했다면 "duplicate column name: quota_bytes" 오류가 난다 — 그건 정상이며
-- 이미 적용되었다는 뜻이므로 무시하면 된다(SQLite에 ADD COLUMN IF NOT EXISTS가 없다).
--
-- NULL = "기본값(100MB)을 따름". 관리자가 개별로 늘려주면 그때 값이 채워진다.

ALTER TABLE users ADD COLUMN quota_bytes INTEGER;
