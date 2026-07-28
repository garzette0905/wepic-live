# Wepic Live

구글 포토의 사진·동영상을 골라 감성 슬라이드쇼로 보여주고, 링크 하나로 가족과 함께
감상하는 **웹 사진 액자**입니다. (태그라인: *capture moments, real-time joy*)

> 향후 기능 방향과 상용 전자액자 대비 격차 분석은 [docs/ROADMAP.md](docs/ROADMAP.md) 참고.

## 구성

| 폴더 | 내용 |
|---|---|
| `web/` | 웹앱 — 프론트엔드(`web/public`) + Node/Express 백엔드(`web/server.js`). Render 등 Node 호스트에서 실행 |
| `cloudflare/` | 같은 앱의 Cloudflare Workers 백엔드 포팅(세션=KV, 공유=R2). `web/public`을 정적 자산으로 재사용 |
| `docs/` | 로드맵·기획 노트 |

프론트엔드(`web/public`)는 두 배포 방식이 **공유**합니다. 백엔드만 Express(Node) / Worker 두 갈래입니다.

## 주요 기능

- 구글 포토 Picker로 사진·동영상 선택 → 자동 슬라이드쇼(페이드/슬라이드/Ken Burns 전환)
- 배경음악(YouTube), 시계·날씨, 제목 오버레이, 동영상 재생(소리 옵션)
- **실시간 공유 링크**(로그인 없이 열람), 자동 만료 없이 계속 보관
- **PWA**: 안드로이드에서 구글 포토 "공유" → Wepic Live로 사진 전송(홈 화면 설치 시)

## 배포

- **Cloudflare Workers**: [cloudflare/README.md](cloudflare/README.md)의 설정 절차 참고 (R2·KV·시크릿·OAuth 리디렉션)
- **Node(Render 등)**: [web/README.md](web/README.md) 참고

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
