# PunchGrow 구현 현황

기준 시각: 2026-08-19. 이 문서는 완료를 과장하지 않고 현재 실행 가능한 범위와 남은 차단점을 기록한다.

## 현재 실행 가능한 것

- Docker PostgreSQL 17: 256종 카탈로그, 플레이어, 토큰 수집 원장, 가챠 요청, 개체, 아이템 인벤토리.
- Node API: HMAC 서명 세션, 수집기 비밀키, 개인정보 필드 거부형 토큰 적립, 중복 방지, 주간 활동 보너스, 500,000토큰 가챠, 300회 실패 후 다음 ORIGIN 천장, 유니크 컬러 0.1%, 먹이 성장.
- 웹 MVP: 실제 PostgreSQL 데이터로 주간 사용량, 잔액, 가챠, 천장, 보유 크리처, 도감, 먹이 성장을 표시한다.
- Expo 기반: iOS·Android·Web 공용 화면이 같은 API의 실제 상태를 읽고 가챠와 먹이를 실행한다. `Cute Clarity v2` 기본 240종과 원초 계보 16종 카드 이미지, 가상화 도감, 미발견 실루엣, 안전 영역과 기본 접근성을 포함한다.
- macOS 소스: SwiftUI `MenuBarExtra`, 실제 256종 이미지, 로컬 게임/백업, 제한 메모리 JSONL 자동 수집, 실제 Claude/Codex 주간 플랜 사용률, 대형·특대형 먹이, 240ms 누름 뒤 80→35ms로 가속하는 반복 실행, 레거시 일반 먹이의 5:1 전환·잔여분 환급, 등급별 효과와 Lv.15·25·40 진화 단계표, 대표 크리처를 표시하는 선택형 데스크톱 펫이 구현되어 있다.
- 배포 준비: 코드 MIT와 이미지 권리 유보를 분리했다. Homebrew Cask는 무결성 검증을 우회하지 않는 생성 템플릿만 제공한다.

## 검증된 것

- 카탈로그 256종(시작형 64 / 일반 진화 133 / 분기·혼합·특수 34 / 변이 25)과 공통 경제 계약 검증 통과.
- `cute-redesign-v2` 마스터·모바일 파생본 각 240종, 시각 QA 240종, 모바일·웹·macOS 720개 배포 파일 SHA-256 검증 통과. v2→legacy-v1→v2 전환 명령의 롤백 회귀 검증도 통과.
- Expo TypeScript, 모바일 도메인 테스트 6개, Expo Web production export 통과.
- 서버 TypeScript와 단위 테스트 3개, 웹 TypeScript build 통과.
- Docker 전체 빌드와 health/catalog 240 통과. 256종 확장 뒤 Docker 통합 검증은 후속 실행 대상이다.
- 실제 PostgreSQL 대상 서명 세션 위조 거부, 무서명 수집 거부, 개인정보 거부, 중복 적립, 동시 동일 가챠 멱등성, ORIGIN 풀 누락 시 무과금 실패 통과.
- 브라우저에서 Expo → API → PostgreSQL 실제 잔액 로드와 가챠 차감/개체 획득을 확인.
- Swift 전 파일 파서, macOS 15.4 호환 SDK 기반 Release 링크, 243개 봉인 리소스의 `.app` 조립, ad-hoc 서명 검증, 실제 GUI 프로세스 실행 통과.
- 로컬 ZIP/SHA로 임시 Homebrew Tap을 만들고 Cask 설치 → 설치본 서명 검증 → 제거까지 통과.
- 대용량·불완전·회전·fork replay 로그를 제한 메모리로 처리하는 회귀 테스트를 추가했고, 실제 실행 메모리를 약 120MB 수준으로 확인했다.
- 실제 로컬 공급자 데이터에서 Claude 주간 100%, Codex 주간 45%를 읽어 각 서비스 화면의 값과 일치함을 확인했다.
- 구현·보안·디자인 검토 원장 14회를 완료했고, 마지막 독립 Swift/모바일 재검토에서 남은 P0·P1은 없었다. 검토 증거는 `.omx/reviews/`에 있다.
- 이후 macOS 실빌드/Homebrew와 공급망 감사를 포함해 검토 원장을 16회로 확장했다. 서버·웹은 독립 lockfile과 `npm ci` 재빌드에서 취약점 0, Expo는 `xcode@3.0.1`에만 `uuid@11.1.1`을 제한해 깨끗한 설치·감사·config·export에서 취약점 0을 확인했다.
- Xcode 26.6을 명령별 `DEVELOPER_DIR`로 선택해 macOS 전체 테스트 355개, 데스크톱 펫 전용 테스트 9개, Release 앱 조립과 ad-hoc 서명 검증을 통과했다. 대표 3종의 전경 컷아웃 투명도도 확인했다.

## 아직 완료가 아닌 것

- 이 Mac의 전역 `xcode-select`는 사전 빌드 Swift 모듈이 빠진 Command Line Tools를 가리킨다. 시스템 설정을 바꾸지 않고 각 명령에 `DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer`를 지정하면 일치하는 Xcode 26.6 툴체인으로 빌드·테스트할 수 있다.
- `softwareupdate --list` 재확인 결과 별도 CLT 업데이트는 없고, 약 3.8GB의 macOS Tahoe 26.6 전체 업데이트만 제공된다. 이 작업은 시스템 재시작을 수반하므로 프로젝트 자동 작업 범위에서는 실행하지 않았다.
- Expo 웹은 서명 세션을 브라우저 저장소에 유지한다. 네이티브 iOS·Android의 재실행 간 세션 보존은 `expo-secure-store`를 설치해 Keychain/Keystore에 옮겨야 하며, 현재 개발 환경의 패키지 TLS 오류 때문에 메모리에만 유지된다.
- 현재 서명 세션은 loopback 전용 로컬 MVP 경계다. 외부 공개·멀티 사용자 서비스 전에는 실제 계정 로그인, 키 회전, CSRF/남용 방지 정책을 추가해야 한다.
- 로컬 `brew install --cask`는 통과했다. Developer ID 서명, Apple 공증, 공개 GitHub 릴리스 URL/SHA를 사용하는 공개 설치는 Apple 개발자 계정과 배포 단계가 필요하다.
- 실물 iPhone/Android와 Simulator/Emulator 교차검증은 사용자가 확정한 1차 기능 완료 후 단계로 남아 있다.
- macOS의 기본 레벨 자동 진화(Lv.15·25·40)와 Lv.50 성장 상한은 구현 범위다. 사용자 선택형 분기·진화 재료, 아레나·나, 전체 아이템 상점, 탐험과 배틀은 후속 기능이다.

## 로컬 실행

```bash
docker compose up -d --build
open http://localhost:5173

npm run typecheck:app
npm run test:mobile
npm --prefix server test
npm --prefix server run test:integration
```

Expo 실제 기기에서는 `EXPO_PUBLIC_API_URL`을 기기에서 접근 가능한 개발 서버 주소로 지정한다. 현재 Docker API 포트는 안전을 위해 Mac loopback에만 공개되어 있으므로 실제 휴대폰 테스트 단계에서 인증과 LAN 바인딩을 함께 도입한다.
