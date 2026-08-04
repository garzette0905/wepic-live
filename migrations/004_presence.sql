-- wepic 공유화면 "함께 보고 있는 사람" 추적 — 이미 만들어진 DB에 1회 실행한다.
--
--   로컬:  npx wrangler d1 execute wepic-db --local  --file=./migrations/004_presence.sql
--   운영:  npx wrangler d1 execute wepic-db --remote --file=./migrations/004_presence.sql
--          (오타 주의: 데이터베이스 이름은 wepic-db 다)
--
-- 전부 IF NOT EXISTS라 여러 번 실행해도 안전하다.

-- 지금 이 wepic을 보고 있는 사람. 시청자가 25초마다 한 번씩 자기 행을 갱신(UPSERT)하고,
-- 서버는 "최근 45초 안에 갱신된 행"만 접속 중으로 센다.
--
-- KV가 아니라 D1을 쓴 이유: KV는 같은 키에 동시에 쓰면 마지막 쓰기만 남아(last-write-wins)
-- 여러 시청자가 동시에 하트비트를 보내면 서로를 지워버린다. D1은 행 단위 UPSERT라 안전하다.
--
-- 시각을 TEXT(ISO) 대신 INTEGER(epoch ms)로 두는 이유: "45초 안"처럼 시간 차를 계산하는
-- 비교가 대부분이라 숫자 비교가 더 단순하고 인덱스도 잘 탄다.
CREATE TABLE IF NOT EXISTS share_presence (
  share_id   TEXT NOT NULL,
  visitor_id TEXT NOT NULL,   -- 방문자 쿠키(wvid) 또는 'u<회원id>'
  first_seen INTEGER NOT NULL, -- 이 wepic에 처음 들어온 시각 → "새로 접속했다" 판정에 쓴다
  last_seen  INTEGER NOT NULL, -- 마지막 하트비트 시각 → 접속 중 판정에 쓴다
  PRIMARY KEY (share_id, visitor_id)
);
-- 접속자 수를 셀 때(share_id + last_seen) 함께 걸리도록
CREATE INDEX IF NOT EXISTS idx_share_presence_seen ON share_presence (share_id, last_seen);
