# Wepic Live

구글 포토의 사진·동영상을 골라 감성 슬라이드쇼로 보여주고, 링크 하나로 가족과 함께
감상하는 **웹 사진 액자**입니다. (태그라인: *capture moments, real-time joy*)

> 향후 기능 방향과 상용 전자액자 대비 격차 분석은 [docs/ROADMAP.md](docs/ROADMAP.md) 참고.

## 구성

| 폴더 | 내용 |
|---|---|
| `web/public/` | 프론트엔드 (HTML·CSS·JS·아이콘·데모 사진) — Worker의 정적 자산으로 그대로 서빙 |
| `cloudflare/` | 백엔드 Worker (`index.js`) — 세션=KV, 공유 사진=R2, 회원=D1 |
| `schema.sql` | 회원 테이블(D1) 스키마 |
| `docs/` | 로드맵·기획 노트 |

**Cloudflare Workers 단일 백엔드**입니다. 예전에는 Node/Express(`web/server.js`)를 Render에
함께 배포했지만, Render를 쓰지 않기로 하면서 제거했습니다(2026-07).

## 로컬 실행

```bash
npm install
cp .dev.vars.example .dev.vars   # 실제 시크릿 값을 채운다
npm run db:local                 # 로컬 D1에 회원 테이블 생성 (최초 1회)
npm run dev                      # wrangler dev — 기본 http://localhost:8787
```

> 로컬에서 구글·카카오 로그인을 테스트하려면 각 개발자 콘솔의 **승인된 리디렉션 URI**에
> `http://localhost:8787/auth/callback`(구글) 등 로컬 주소도 등록해야 합니다.

## 주요 기능

- 구글 포토 Picker로 사진·동영상 선택 → 자동 슬라이드쇼(페이드/슬라이드/Ken Burns 전환)
- 배경음악(YouTube), 시계·날씨, 제목 오버레이, 동영상 재생(소리 옵션)
- **실시간 공유 링크**(로그인 없이 열람), 자동 만료 없이 계속 보관
- **PWA**: 안드로이드에서 구글 포토 "공유" → Wepic Live로 사진 전송(홈 화면 설치 시)

## 배포

**Cloudflare Workers** — 설정 절차(R2·KV·D1·시크릿·OAuth 리디렉션)는
[cloudflare/README.md](cloudflare/README.md) 참고. `main`에 push하면 자동 배포됩니다.

## Google Cloud 설정(공통)

1. Google Cloud Console에서 프로젝트 생성 → **Google Photos Picker API** 사용 설정
2. OAuth 동의 화면(브랜딩·대상): 게시 상태 **테스트**면 **테스트 사용자**에 사용할 계정 이메일 추가
3. 스코프 추가: `https://www.googleapis.com/auth/photospicker.mediaitems.readonly`
4. **클라이언트 만들기**: 배포 도메인에 맞춰 **승인된 리디렉션 URI**로 `https://<배포도메인>/auth/callback` 등록,
   생성된 **클라이언트 ID / 시크릿**을 배포 환경변수(시크릿)로 설정

## 알려진 제약

- 위치(GPS) 표시 미지원(Photos API가 GPS 미제공) — 촬영 날짜만 표시
- 새 사진 자동 반영 미지원(Picker는 선택 시점 스냅샷) — "사진 다시 선택하기" 필요
- 공개 배포 시 구글 앱 심사 필요(테스트 단계는 테스트 사용자 등록으로 충분)
