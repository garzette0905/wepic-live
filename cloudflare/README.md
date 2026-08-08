# Wepic Live — Cloudflare Workers 배포

Wepic Live의 **유일한 백엔드**입니다. (예전에는 `web/server.js`의 Express 백엔드를 Render에
함께 배포했지만, Render를 쓰지 않기로 하면서 2026-07에 제거하고 Worker 단일 구성이 되었습니다.)

- **Worker 코드**: `cloudflare/index.js`
- **설정**: 저장소 **루트**의 `wrangler.toml` (Cloudflare가 루트 설정을 기대하므로 루트에 둠)
- **세션**: Workers KV(`SESSIONS`) · **공유 파일**: R2(`wepic-shares`) · **정적**: `web/public`(복사 없이 그대로 서빙) · **만료 정리**: Cron(매시간)

도메인: **`https://wepic.kr`** (예전 주소 `https://wepic-live.wepiclab.workers.dev`도 계속 살아
있습니다 — 이미 나눠준 링크가 죽으면 안 되므로 두 주소를 함께 씁니다.)

절대주소(공유 링크·OAuth 콜백·미리보기 카드)는 고정값이 아니라 **요청이 들어온 주소**를
기준으로 만듭니다(`baseUrlOf`). 그래서 어느 주소로 들어와도 그 주소 기준으로 동작합니다.

---

## 0. 도메인 연결 (wepic.kr — 가비아에서 산 도메인)

Workers의 커스텀 도메인은 **그 도메인이 Cloudflare에 등록(영역 추가)되어 있어야** 씁니다.
네임서버를 가비아 → Cloudflare로 바꾸는 작업이 필요합니다.

### (1) Cloudflare에 도메인 추가

1. Cloudflare 대시보드 → **Add a domain** → `wepic.kr` 입력 → **Free** 요금제 선택
2. 기존 DNS 레코드 스캔 결과가 나오면 그대로 두고 **Continue**
3. 마지막 화면에 **Cloudflare 네임서버 2개**가 나옵니다 (예: `xxx.ns.cloudflare.com`,
   `yyy.ns.cloudflare.com`) — 이 값을 복사해 둡니다. **계정마다 값이 다릅니다.**

### (2) 가비아에서 네임서버 변경

가비아 My가비아 → **도메인 관리 → 네임서버 설정**에서, 지금 들어 있는

| | 현재 (가비아 기본) | 바꿀 값 |
|---|---|---|
| 1차 | `ns.gabia.co.kr` | Cloudflare가 준 **첫 번째** 네임서버 |
| 2차 | `ns1.gabia.co.kr` | Cloudflare가 준 **두 번째** 네임서버 |
| 3차 | `ns.gabia.net` | **비움** (Cloudflare는 2개만 씁니다) |

> `.kr` 도메인은 반영에 보통 **10분~2시간**, 늦으면 24시간까지 걸립니다.
> Cloudflare 대시보드에서 상태가 **Active**로 바뀌면 완료입니다.

### (3) Worker에 커스텀 도메인 연결

상태가 **Active**가 된 뒤에 루트 `wrangler.toml`의 `[[routes]]` 두 블록 주석을 풀고 배포:

```bash
npx wrangler deploy
```

이러면 Cloudflare가 `wepic.kr` · `www.wepic.kr`의 DNS 레코드와 SSL 인증서를 자동으로
만들어 줍니다(대시보드에서 손댈 것 없음).

> 대시보드로 하고 싶다면: Workers & Pages → `wepic-live` → **Settings → Domains & Routes**
> → **Add → Custom domain** → `wepic.kr` (그리고 `www.wepic.kr`).

### (4) 로그인 제공자에 새 콜백 주소 등록 — ⚠️ 반드시 먼저

새 주소로 로그인하면 콜백도 새 주소로 갑니다. 콘솔에 등록되어 있지 않으면
`redirect_uri_mismatch`로 로그인이 실패합니다. **기존 주소는 지우지 말고 추가**하세요.

| 제공자 | 등록할 곳 | 추가할 값 |
|---|---|---|
| Google | Cloud Console → OAuth 클라이언트 → 승인된 리디렉션 URI | `https://wepic.kr/auth/callback` |
| Google | 같은 화면 → 승인된 JavaScript 원본 | `https://wepic.kr` |
| 카카오 | 카카오 로그인 → Redirect URI | `https://wepic.kr/auth/kakao/callback` |
| 카카오 | 앱 설정 → 플랫폼 → Web 사이트 도메인 | `https://wepic.kr` |
| 네이버 | 애플리케이션 → API 설정 → Callback URL | `https://wepic.kr/auth/naver/callback` |
| 페이스북 | Facebook 로그인 → 설정 → 유효한 OAuth 리디렉션 URI | `https://wepic.kr/auth/facebook/callback` |

### (5) 저장된 데이터는?

**바꿀 것이 없습니다.** R2 매니페스트(`photos.json`)는 사진 경로를 `/shares/...` 상대경로로만
저장하고, 절대주소는 매 요청마다 조립합니다. D1·KV에도 도메인이 들어가지 않습니다.

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

Google Cloud Console → **웹 애플리케이션** OAuth 클라이언트 → 승인된 리디렉션 URI에
**둘 다** 등록합니다(예전 주소로 들어온 사람도 로그인할 수 있어야 하므로):

```
https://wepic.kr/auth/callback
https://wepic-live.wepiclab.workers.dev/auth/callback
```

## 5. 배포

`main`에 push하면 자동 배포. 확인:
- `/` → Wepic Live 홈, 로그인 → 사진 선택 → 공유 링크 → `/f/<id>`
- 공유 링크 자동 만료는 비활성화되어 있다(따로 얘기하기 전까지 삭제하지 않음)

> 📌 Cloudflare가 자동 생성한 `cloudflare/workers-autoconfig` 브랜치/PR은 **오래된 상태**(renderer 정적)라 **머지하지 말고 무시/삭제**하세요.

---

## 로컬 개발 (선택)

```bash
npm install
# .dev.vars 에 GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET / SESSION_SECRET 작성
npx wrangler dev
```
