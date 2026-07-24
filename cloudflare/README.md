# Wepic Live — Cloudflare Workers 배포

`web/server.js`(Express) 백엔드를 Cloudflare Worker로 포팅한 버전입니다.
프론트엔드는 `web/public`을 그대로 재사용합니다.

- **세션(로그인)**: Workers KV
- **공유 파일(사진 + photos.json)**: R2 (서버가 자거나 재배포돼도 유지)
- **정적 파일**: 빌드 시 `web/public` → `cloudflare/public` 복사 후 Assets로 서빙
- **만료 정리**: Cron(매시간)

도메인: `https://wepic-live.garzette.workers.dev`

---

## 1. Cloudflare 리소스 만들기 (대시보드)

1. **R2 버킷 생성**: R2 → *Create bucket* → 이름 **`wepic-shares`**
2. **KV 네임스페이스 생성**: Workers & Pages → KV → *Create namespace* → 이름 **`SESSIONS`**
   - 생성 후 나오는 **Namespace ID**를 복사 → [`wrangler.toml`](wrangler.toml)의
     `id = "REPLACE_WITH_KV_NAMESPACE_ID"` 자리에 붙여넣고 커밋

> CLI가 있으면 대신: `npx wrangler r2 bucket create wepic-shares` /
> `npx wrangler kv namespace create SESSIONS` (출력된 id를 wrangler.toml에 입력)

## 2. 시크릿 등록

Worker 설정 → **Settings → Variables and Secrets → Add (Encrypt)** 로 3개 등록:

| 이름 | 값 |
|---|---|
| `GOOGLE_CLIENT_ID` | 구글 OAuth **웹 애플리케이션** 클라이언트 ID |
| `GOOGLE_CLIENT_SECRET` | 그 클라이언트 시크릿 |
| `SESSION_SECRET` | 아무 긴 랜덤 문자열 |

> CLI: `npx wrangler secret put GOOGLE_CLIENT_ID` (SECRET, SESSION_SECRET 각각)

## 3. GitHub 연동 빌드 설정

Worker → **Settings → Build**:

- **Root directory**: `cloudflare`
- **Build command**: `npm install && cp -r ../web/public ./public`
- **Deploy command**: `npx wrangler deploy`

(정적 자산은 빌드 때 `web/public`을 `cloudflare/public`으로 복사해 올립니다. `public/`은 gitignore.)

## 4. Google OAuth 리디렉션 URI 추가

Google Cloud Console → 사용자 인증 정보 → **웹 애플리케이션** OAuth 클라이언트
(= Render에서 쓰던 그 클라이언트) → **승인된 리디렉션 URI**에 추가:

```
https://wepic-live.garzette.workers.dev/auth/callback
```

> ⚠️ Picker 리디렉션 흐름은 **"웹 애플리케이션"** 유형 클라이언트여야 합니다(데스크톱 유형 아님).
> 게시 상태가 **테스트**면 사용할 계정을 **테스트 사용자**에 추가해야 로그인됩니다.

## 5. 배포

`main` 브랜치에 push하면 Workers Builds가 위 설정으로 자동 배포합니다.
(KV id 입력 + 시크릿 등록 + 빌드 설정이 끝난 뒤 push해야 성공합니다.)

배포 후 확인:
- `https://wepic-live.garzette.workers.dev/` → Wepic Live 홈
- 로그인 → 사진 선택 → 공유 링크 생성 → `/f/<id>` 열람
- 공유 링크는 24시간 자동 만료(`SHARE_TTL_HOURS` 변수로 조절)

---

## 로컬 개발 (선택)

```bash
cd cloudflare
npm install
cp -r ../web/public ./public
# .dev.vars 에 GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET / SESSION_SECRET 작성
npx wrangler dev
```

R2/KV는 `wrangler dev`가 로컬 에뮬레이션을 제공합니다(`--remote`로 실제 리소스 사용 가능).
