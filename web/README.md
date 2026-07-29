# web/ — Wepic Live 프론트엔드

이 폴더에는 **프론트엔드 정적 자산만** 있습니다 (`web/public/`).

- **백엔드**: `cloudflare/index.js` (Cloudflare Worker) — 설정·배포는 [`cloudflare/README.md`](../cloudflare/README.md) 참고
- **로컬 실행**: 저장소 루트에서 `npm run dev` (wrangler dev) — 자세한 건 루트 [`README.md`](../README.md) 참고

> 예전에는 이 폴더에 Express 백엔드(`server.js`)가 함께 있었지만, Render를 쓰지 않기로 하면서
> **Cloudflare Worker 전용으로 전환**하며 제거했습니다(2026-07). 회원관리(D1)를 포함한 모든
> 서버 로직은 `cloudflare/index.js` 한 곳에 있습니다.

## 폴더 구성 (`web/public/`)

| 파일 | 화면 / 역할 |
|---|---|
| `index.html` · `app.js` | **wepic 홈페이지** + **wepic 메인화면**(슬라이드쇼·설정 패널) |
| `share.html` · `share.js` | **wepic 공유화면** (`/f/<id>`, 로그인 불필요) |
| `styles.css` | 전체 스타일 |
| `manifest.json` · `sw.js` | PWA (설치, 안드로이드 "공유"로 사진 수신) |
| `demo/` | 데모용 샘플 사진 + `photos.json` (로그인·PIN 없이 열림) |
| `vendor/qr.js` | QR 생성 (Worker CPU 한도 때문에 브라우저에서 생성) |
| `icon-*.png` · `favicon.svg` · `hero.jpg` | 아이콘·배너 이미지 |

## 데모 모드 (로그인 없이 보기)

홈에서 **"데모로 보기"** 를 누르면 Google 계정 연결 없이 샘플 사진(`public/demo/`)으로
슬라이드쇼 전체 기능을 체험할 수 있습니다. 데모 사진을 교체하려면 `public/demo/photos/`에
이미지를 넣고 `public/demo/photos.json`을 그에 맞게 수정하면 됩니다.
