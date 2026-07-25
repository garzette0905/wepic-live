# Wepic Live — Cloudflare Workers 배포

`web/server.js`(Express) 백엔드를 Cloudflare Worker로 포팅한 버전입니다.

- **Worker 코드**: `cloudflare/index.js`
- **설정**: 저장소 **루트**의 `wrangler.toml` (Cloudflare가 루트 설정을 기대하므로 루트에 둠)
- **세션**: Workers KV(`SESSIONS`) · **공유 파일**: R2(`wepic-shares`) · **정적**: `web/public`(복사 없이 그대로 서빙) · **만료 정리**: Cron(매시간)

도메인: `https://wepic-live.garzette.workers.dev`

---

## 1. 리소스 (대시보드)

- **R2 버킷**: `wepic-shares` 생성
- **KV 네임스페이스**: `SESSIONS` — 이미 `wrangler.toml`에 id 설정됨(`df7d7a…`)

## 2. 시크릿 (Settings → Variables and secrets → Add → **Encrypt**)

| 이름 | 값 |
|---|---|
| `GOOGLE_CLIENT_ID` | 구글 OAuth **웹 애플리케이션** 클라이언트 ID |
| `GOOGLE_CLIENT_SECRET` | 그 클라이언트 시크릿 |
| `SESSION_SECRET` | 아무 긴 랜덤 문자열 |

> ⚠️ 빌드가 성공해 **스크립트가 배포된 뒤**에야 시크릿 추가가 가능합니다("static assets only" 상태 해제).

## 3. 빌드 설정 (Settings → Build)

- **Root directory**: (비움 = 저장소 루트)
- **Build command**: `npm install`
- **Deploy command**: `npx wrangler deploy`

> ⚠️ **무료 플랜 CPU 한도(요청당 10ms) 주의** — QR 코드 인코딩은 10~30ms가 걸려
> 이 한도를 넘기고, 그러면 Worker가 강제 종료되어 Cloudflare의 **HTML 오류 페이지**가
> 반환된다(코드의 try/catch로 잡을 수 없음). 그래서 QR은 서버에서 만들지 않고
> **브라우저에서 생성**한다(`web/public/vendor/qr.js`). 새 기능을 추가할 때도
> 요청당 무거운 CPU 작업(이미지 인코딩·압축·대량 루프)은 피할 것.

> 루트 `wrangler.toml`에 `main`(핸들러)과 `assets`(web/public)가 함께 있어,
> `wrangler deploy`가 **스크립트 Worker**로 배포합니다(정적 전용 아님).

## 4. Google OAuth 리디렉션 URI

Google Cloud Console → **웹 애플리케이션** OAuth 클라이언트 → 승인된 리디렉션 URI에 추가:

```
https://wepic-live.garzette.workers.dev/auth/callback
```

## 5. 배포

`main`에 push하면 자동 배포. 확인:
- `/` → Wepic Live 홈, 로그인 → 사진 선택 → 공유 링크 → `/f/<id>`
- 공유 링크는 24시간 자동 만료(`SHARE_TTL_HOURS`로 조절)

> 📌 Cloudflare가 자동 생성한 `cloudflare/workers-autoconfig` 브랜치/PR은 **오래된 상태**(renderer 정적)라 **머지하지 말고 무시/삭제**하세요.

---

## 로컬 개발 (선택)

```bash
npm install
# .dev.vars 에 GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET / SESSION_SECRET 작성
npx wrangler dev
```
