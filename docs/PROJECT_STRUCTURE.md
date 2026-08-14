# 저장소 구조 / Repository structure

[한국어](#한국어) · [English](#english)

## 한국어

PunchGrow에는 공개 macOS 제품 하나, 공개 정적 홈페이지 하나와 별도의 로컬 프로토타입이 함께 있습니다. 비슷해 보이는 폴더 이름은 역할과 배포 경계가 서로 다릅니다.

| 경로 | 역할 | 공개 배포 여부 |
| --- | --- | --- |
| `macos/` | 배포 중인 Swift/SwiftUI 메뉴 막대 앱, 테스트, 빌드 스크립트와 Homebrew 릴리스 템플릿 | macOS 앱으로 배포 |
| `website/` | `punchgrow.thundo.kr` 홈페이지와 256종 공개 도감 | GitHub Pages로 배포 |
| `web/` | 로컬 풀스택 MVP용 TypeScript 브라우저 클라이언트 | 배포하지 않음 |
| `server/` | `web/`과 Expo 프로토타입이 사용하는 PostgreSQL API | 로컬 루프백에서만 실행 |
| `app/`, `components/`, `constants/`, `hooks/`, `src/mobile/` | Expo 모바일·웹 프로토타입 | 공개 릴리스 없음 |
| `assets/creatures/mobile/` | 로컬 프로토타입이 공유하는 실행 크기 크리처 이미지 | 로컬 실행·기여용으로 포함, 별도 자산 라이선스 적용 |
| `production/` | 정본 카탈로그, 계약과 재현 가능한 검증 증거 | 앱 진입점이 아닌 저장소 데이터 |
| `scripts/`, `config/` | 카탈로그·자산·계약 빌드 및 검증 도구 | 배포하지 않음 |
| `docs/` | 사용자·기여자용 공개 문서 | 저장소에서 공개 |
| `문서/` | 한국어 제품 스펙, 결정 기록, 디자인과 구현 현황 | 사용자 설치 문서가 아닌 기준 자료 |
| `에셋/` | Expo 아이콘과 시작 화면 원본 | 배포하지 않음 |

### 웹 경계

`website/`만 이 저장소가 공개 배포하는 웹 프로젝트입니다. `.github/workflows/punchgrow-site.yml`이 `website/dist/`를 만들고 검증한 뒤 GitHub Pages에 게시합니다.

`web/`과 `server/`는 루트 `compose.yaml`로 함께 실행하는 별도 로컬 MVP입니다. 루프백 포트만 사용하며 인터넷 공개용 인증·운영 경계를 갖추지 않았습니다. 홈페이지 변경을 `web/`에 넣거나 로컬 API를 운영 중인 PunchGrow 서비스로 설명하지 마세요.

### 생성물과 로컬 전용 파일

의존성 폴더, `.build/`, `dist/`, Expo·OMX 상태, 임시 출력과 원본 아트 작업공간은 `.gitignore`에서 제외합니다. 기존 production 계약이 명시적으로 추적하는 결과가 아니라면 생성물을 커밋하지 않고 소스에서 다시 만듭니다.

### 작업별 시작 위치

- macOS 동작·UI: `macos/`
- 공개 홈페이지·도감: `website/`
- 로컬 브라우저 MVP: `web/`, API 계약까지 바꾸면 `server/`도 함께 확인
- 모바일 프로토타입: `app/`, `src/mobile/`
- 공개 안내: `README*.md`, `docs/`
- 제품 결정·용어: `문서/`, 비자명한 결정은 `문서/DECISIONS.md`에 기록

풀 리퀘스트 전 [한국어 기여 가이드](../CONTRIBUTING.md)의 영역별 검사를 실행하세요.

## English

PunchGrow contains one public macOS product, one public static website, and additional local prototypes. Similar directory names are intentional but have different deployment boundaries.

| Path | Role | Publicly deployed? |
| --- | --- | --- |
| `macos/` | Shipping Swift/SwiftUI menu-bar app, tests, build scripts, and Homebrew release template | Yes, as the macOS app |
| `website/` | Dependency-free project homepage and creature dex for `punchgrow.thundo.kr` | Yes, through GitHub Pages |
| `web/` | TypeScript browser client for the local full-stack MVP | No; local development only |
| `server/` | PostgreSQL-backed API used by `web/` and the Expo prototype | No; loopback/local development only |
| `app/`, `components/`, `constants/`, `hooks/`, `src/mobile/` | Expo mobile/web prototype | No public release yet |
| `assets/creatures/mobile/` | Runtime-sized creature images shared by local prototypes | Included for local execution and contribution; separate artwork terms apply |
| `production/` | Canonical catalog, contracts, and reproducible verification evidence | Repository data, not an application entry point |
| `scripts/`, `config/` | Catalog, asset, and contract build/verification tooling | No |
| `docs/` | Public user and contributor documentation | Yes, in the repository |
| `문서/` | Korean product specifications, decisions, design notes, and implementation status | Reference material, not user setup documentation |
| `에셋/` | Expo icon and splash source files | No |

## Web boundary

`website/` is the only web project deployed by this repository. The workflow in `.github/workflows/punchgrow-site.yml` builds `website/dist/`, validates it, and publishes that generated output to GitHub Pages.

`web/` and `server/` form a separate local MVP. They are started together through the root `compose.yaml`, bind to loopback ports, and are not production-hardened for internet exposure. Do not place public-homepage changes in `web/`, and do not describe the local API as a hosted PunchGrow service.

## Generated and local-only output

Dependency directories, `.build/`, `dist/`, Expo state, OMX state, temporary output, and source artwork workspaces are excluded through `.gitignore`. Generated output should be rebuilt from source instead of committed unless an existing production contract explicitly tracks it.

## Where to make a change

- macOS behavior or UI: `macos/`
- public homepage or dex: `website/`
- local browser MVP: `web/` together with `server/` when its API contract changes
- mobile prototype: `app/` and `src/mobile/`
- public instructions: `README*.md` and `docs/`
- product decisions or terminology: `문서/`, with non-trivial decisions recorded in `문서/DECISIONS.md`

Run the area-specific checks in the [contribution guide](../CONTRIBUTING.en.md) before opening a pull request.
