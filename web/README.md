# 기억 조각 이어주기 — 웹 버전

데스크톱 앱(Electron)과 동일한 디지털 액자 기능을 브라우저에서 제공하는 웹 서비스입니다.
설치 없이 PC·태블릿·스마트TV 브라우저에서 접속만 하면 됩니다.

> 데스크톱 앱은 프로젝트 루트에 그대로 있습니다. 이 `web/` 폴더는 독립적인 웹 서버입니다.

## 데모 모드 (계정 연결 없이 보기)

로그인 화면의 **"데모로 보기"** 버튼을 누르면, Google 계정 연결 없이 샘플 사진(`public/demo/`)과
샘플 배경음악으로 슬라이드쇼 전체 기능(전체화면, 기간필터, 잠시멈춤, 음악, 공유 등)을 바로
체험할 수 있습니다. 사진 선택/계정 관련 메뉴 대신 "Google 계정으로 로그인하고 내 사진으로 보기"
링크가 표시됩니다. 데모용 사진을 교체하려면 `public/demo/photos/`에 이미지를 넣고
`public/demo/photos.json`을 그에 맞게 수정하면 됩니다.

## 데스크톱 앱과의 차이

| 기능 | 데스크톱 앱 | 웹 버전 |
|---|---|---|
| 사진 선택 / 슬라이드쇼 / 전체화면 / 기간필터 / 잠시멈춤 | ✅ | ✅ |
| 배경음악 (YouTube) | ✅ | ✅ (표준 임베드) |
| 광고 자동 건너뛰기 | ✅ | ❌ (브라우저 보안상 불가) |
| 설치 없이 어디서나 접속 | ❌ | ✅ |
| 로그인 유지 | 파일 저장 | 서버 세션(쿠키) |

## 1. Google Cloud Console 설정 (웹용 클라이언트)

데스크톱 앱과 **별도의 OAuth 클라이언트**가 필요합니다.

1. [Google Cloud Console](https://console.cloud.google.com/) → 기존 프로젝트 선택
2. **API 및 서비스 > 라이브러리** → `Google Photos Picker API` 사용 설정 (이미 했다면 생략)
3. **Google 인증 플랫폼 > 데이터 액세스** → 스코프에 아래가 포함되어 있는지 확인
   ```
   https://www.googleapis.com/auth/photospicker.mediaitems.readonly
   ```
4. **Google 인증 플랫폼 > 클라이언트 > + 클라이언트 만들기**
   - 애플리케이션 유형: **웹 애플리케이션(Web application)**
   - **승인된 리디렉션 URI**에 아래 추가:
     - 로컬 테스트: `http://localhost:3000/auth/callback`
     - 실제 배포 시: `https://<도메인>/auth/callback`
   - 생성된 **클라이언트 ID / 시크릿** 복사

## 2. 실행 (권장: `.env` 파일)

```bash
cd web
npm install
cp .env.example .env      # 그 뒤 .env 를 열어 실제 값 입력
npm start
```

`npm start`는 `node --env-file-if-exists=.env server.js`로 실행되어 **`.env`를 자동으로 읽습니다.**
한 번 적어두면 이후에는 `npm start`만 하면 되고, 서버를 껐다 켜도 값이 유지됩니다.

`.env`에 넣는 값 (자세한 설명은 [.env.example](.env.example) 참고):

| 이름 | 설명 |
|---|---|
| `GOOGLE_CLIENT_ID` | OAuth 클라이언트 ID (웹 애플리케이션) |
| `GOOGLE_CLIENT_SECRET` | 그 클라이언트의 시크릿 |
| `SESSION_SECRET` | 세션·PIN 쿠키 서명 키 (아무 긴 랜덤 문자열) |
| `ADMIN_EMAILS` | wepic 관리자 메뉴를 쓸 계정 (쉼표로 여러 개) |
| `BASE_URL` | 공개 주소 (로컬은 생략 → `http://localhost:3000`) |
| ~~`SHARE_TTL_HOURS`~~ | (사용 안 함) 공유 자동 만료를 비활성화해 더 이상 이 값을 읽지 않는다 |

> ⚠️ **`.env`는 커밋하지 마세요.** `.gitignore`에 등록되어 있습니다(`.env.example`만 커밋됨).
> 실제 시크릿이 GitHub에 올라가면 유출됩니다.
>
> ⚠️ **`SESSION_SECRET`은 고정해서 쓰세요.** 값이 바뀌면 기존 로그인 세션과
> PIN 열람 쿠키가 모두 무효화되어 재로그인·PIN 재입력이 필요합니다.
>
> ℹ️ `--env-file-if-exists`는 **파일이 없으면 그냥 건너뜁니다.** 그래서 `.env`가 없는
> 배포 환경(Render/Cloudflare — 대시보드 환경변수 사용)에서도 같은 `npm start`가 정상 동작합니다.
> (Node 22 이상 필요 — `package.json`의 `engines`에 명시)

### `.env` 없이 그때그때 지정하려면

PowerShell:

```powershell
$env:GOOGLE_CLIENT_ID="복사한-클라이언트-ID"
$env:GOOGLE_CLIENT_SECRET="복사한-시크릿"
$env:SESSION_SECRET="아무-긴-랜덤-문자열"
npm start
```

Git Bash / macOS / Linux:

```bash
GOOGLE_CLIENT_ID="..." GOOGLE_CLIENT_SECRET="..." SESSION_SECRET="..." npm start
```

이 방식은 **그 터미널 세션에만** 유효해서, 서버를 껐다 켜면 다시 지정해야 합니다.

브라우저에서 `http://localhost:3000` 접속 → "Google 계정으로 로그인" → 사진 선택 → 슬라이드쇼.

## 3. Render 무료 호스팅으로 배포하기

이 앱은 Render 배포에 맞게 설정되어 있습니다 (HTTPS 프록시 인식·secure 쿠키·파일 세션 저장 자동 처리).

### 3-1. Render 서비스 생성

1. [Render](https://render.com) 가입 후 대시보드에서 **New + → Web Service**
2. 이 GitHub 저장소(`google_photo_electronic_frame`)를 연결
3. 설정값:
   - **Root Directory**: `web`  ← 중요 (웹 서버가 web/ 하위에 있음)
   - **Build Command**: `npm install`
   - **Start Command**: `node server.js`
   - **Instance Type**: Free
4. 먼저 **환경변수 없이 한 번 생성**해서 Render가 배정한 주소(예: `https://memory-frame.onrender.com`)를 확인합니다.

### 3-2. 환경변수 등록 (Render 대시보드 → Environment)

| Key | Value |
|---|---|
| `GOOGLE_CLIENT_ID` | 웹 애플리케이션 OAuth 클라이언트 ID |
| `GOOGLE_CLIENT_SECRET` | 그 클라이언트의 시크릿 |
| `SESSION_SECRET` | 아무 긴 랜덤 문자열 |
| `BASE_URL` | Render가 배정한 https 주소 (예: `https://memory-frame.onrender.com`, 끝에 `/` 없이) |

저장하면 자동으로 재배포됩니다.

### 3-3. Google Cloud Console에 리디렉션 URI 추가

**클라이언트 > 웹 애플리케이션 클라이언트 편집 > 승인된 리디렉션 URI**에 아래를 추가:

```
https://<Render가-배정한-주소>/auth/callback
```

(예: `https://memory-frame.onrender.com/auth/callback`)

### 3-4. 무료 요금제 특성 (알아두기)

- **콜드 스타트**: 15분간 접속이 없으면 서버가 잠들고, 다음 접속 시 깨어나는 데 ~50초 걸립니다. 디지털 액자로 계속 틀어두면 화면이 주기적으로 서버를 호출해 잘 안 잠듭니다.
- **세션 유지**: 로그인 정보는 파일에 저장되어 서버가 재시작해도 유지됩니다. 단, Render 무료는 디스크가 영구 보존되지 않아(재배포 시 초기화) **코드를 다시 배포하면 재로그인**이 필요할 수 있습니다. 완전한 영구 보존이 필요하면 유료 디스크나 외부 세션 스토어(Redis 등)를 붙이면 됩니다.

### 3-5. 그 외 주의

- 공개 서비스로 다른 사람도 쓰게 하려면 구글의 OAuth 앱 심사가 필요합니다. 본인·가족만 쓰면 **테스트 사용자 등록**으로 충분합니다 (Google 인증 플랫폼 > 대상 > 테스트 사용자).
- 로컬 실행 시에는 위 설정이 자동으로 http/비-secure 모드로 동작하므로 별도 변경이 필요 없습니다.

## 4. 구조

```
web/
├── server.js          # Express: OAuth·Picker API·이미지 프록시
├── package.json
├── sessions/          # 로그인 세션 파일 (자동 생성, git 제외)
└── public/
    ├── index.html     # 화면 구조
    ├── styles.css     # 스타일
    ├── app.js         # 프론트엔드 로직
    ├── brand.png      # 브랜딩 이미지
    ├── favicon.svg    # 브라우저 탭 아이콘
    └── demo/          # 데모 모드용 샘플 사진 + 목록
```

토큰과 클라이언트 시크릿은 **서버에만** 보관되며 브라우저로 전달되지 않습니다. 사진 이미지는
인증이 필요하므로 서버의 `/img` 프록시를 통해 전달됩니다.
