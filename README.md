<div align="center">
  <img src="에셋/icon.png" width="132" alt="PunchGrow 앱 아이콘" />

  <h1>PunchGrow</h1>

  <p><strong>코딩이 크리처를 키우는 가장 즐거운 방법</strong></p>
  <p>Claude Code와 Codex 사용량으로 토큰을 얻고,<br />크리처를 부화·육성하며 240종 도감을 완성하세요.</p>

  <p>
    <a href="README.md"><strong>한국어</strong></a>
    ·
    <a href="README.en.md">English</a>
  </p>

  <p>
    <img alt="v0.2.0" src="https://img.shields.io/badge/version-v0.2.0-C6F84E?style=flat-square&logoColor=08111F" />
    <img alt="macOS 14+" src="https://img.shields.io/badge/macOS-14%2B-4DE1FF?style=flat-square&logo=apple&logoColor=white" />
    <img alt="Swift 6" src="https://img.shields.io/badge/Swift-6-FF4D9D?style=flat-square&logo=swift&logoColor=white" />
    <img alt="Local First" src="https://img.shields.io/badge/data-local--first-C6F84E?style=flat-square&logoColor=08111F" />
    <img alt="MIT source license" src="https://img.shields.io/badge/source-MIT-FFB84D?style=flat-square" />
  </p>

  <p>
    <a href="#빠른-시작">빠른 시작</a>
    ·
    <a href="docs/USAGE.md">사용 가이드</a>
    ·
    <a href="macos/README.md">개발 문서</a>
    ·
    <a href="#개인정보-보호-구조">개인정보 보호</a>
    ·
    <a href="#기여하기">기여하기</a>
  </p>
</div>

---

> **프로젝트 상태: v0.2.0 알파.** 이 저장소의 공개 대상은 Apple Silicon macOS 14+ 메뉴 막대 앱입니다.

GitHub Actions의 Full Xcode 환경에서 Swift 테스트, Release 빌드, 240개 크리처 리소스 조립과 ad-hoc 코드서명을 검증합니다. Developer ID 서명과 Apple 공증을 마친 공개 Homebrew 바이너리는 별도의 릴리스 단계입니다.

## 핵심 경험

| 코딩 | 수집 | 성장 | 개인정보 보호 |
| --- | --- | --- | --- |
| Claude Code·Codex 사용량이 게임 토큰으로 쌓입니다. | 6단계 등급과 240종 크리처를 발견합니다. | 먹이, 진화와 유니크 컬러로 나만의 도감을 만듭니다. | 프롬프트와 코드는 수집하지 않고 Mac 안에서 처리합니다. |

## 실제 앱 화면

아래 이미지는 현재 앱의 SwiftUI 화면을 그대로 렌더링한 캡처입니다. 문서 전용 고정 샘플 데이터를 사용하며 사용자의 실제 로그·프롬프트·소스 코드는 포함하지 않습니다.

<p align="center">
  <img src="docs/screenshots/menu-popover.png" width="398" alt="PunchGrow 메인 팝오버: 현재 등급, 성장 잠재력, 주간 사용률, 먹이와 가챠 버튼" />
</p>

<table>
  <tr>
    <td align="center"><img src="docs/screenshots/rarity-guide.png" width="360" alt="PunchGrow 등급표: 직접 획득 확률과 성장 잠재력 계보 비율" /><br /><strong>등급표</strong><br /><sub>직접 가챠와 최종 성장 잠재력을 분리해 표시</sub></td>
    <td align="center"><img src="docs/screenshots/evolution-dex.png" width="372" alt="PunchGrow 진화도감: 단계, 분기, 현재 위치와 자동 진화 경로" /><br /><strong>진화도감</strong><br /><sub>현재 종부터 이어지는 자동 경로와 전체 계보 확인</sub></td>
  </tr>
</table>

[전체 사용 가이드 보기 →](docs/USAGE.md)

## 대표 크리처

<table>
  <tr>
    <td align="center"><img src="macos/Sources/PunchGrowMenuBar/Resources/Creatures/PG-001.png" width="140" alt="에일루" /><br /><strong>에일루</strong><br /><sub>PROCESS · PG-001</sub></td>
    <td align="center"><img src="macos/Sources/PunchGrowMenuBar/Resources/Creatures/PG-102.png" width="140" alt="리토니온" /><br /><strong>리토니온</strong><br /><sub>AGENT · PG-102</sub></td>
    <td align="center"><img src="macos/Sources/PunchGrowMenuBar/Resources/Creatures/PG-109.png" width="140" alt="마젤론라크" /><br /><strong>마젤론라크</strong><br /><sub>DAEMON · PG-109</sub></td>
  </tr>
  <tr>
    <td align="center"><img src="macos/Sources/PunchGrowMenuBar/Resources/Creatures/PG-193.png" width="140" alt="퀴논" /><br /><strong>퀴논</strong><br /><sub>ORACLE · PG-193</sub></td>
    <td align="center"><img src="macos/Sources/PunchGrowMenuBar/Resources/Creatures/PG-166.png" width="140" alt="자르펜라크" /><br /><strong>자르펜라크</strong><br /><sub>ARCHITECT · PG-166</sub></td>
    <td align="center"><img src="macos/Sources/PunchGrowMenuBar/Resources/Creatures/PG-211.png" width="140" alt="피티온" /><br /><strong>피티온</strong><br /><sub>ORIGIN · PG-211</sub></td>
  </tr>
</table>

> 대표 6종을 포함한 크리처 아트워크에는 별도의 [시각 자산 라이선스](ASSET-LICENSE.md)가 적용됩니다.

## 게임 규칙

| 규칙 | 알파 기준 |
| --- | --- |
| 가챠 1회 | `500,000` 토큰 |
| 가챠 결과 | 60종 PROCESS 시작형 중 하나 · PROCESS 100% |
| ORIGIN 계보 | 60개 중 3개 · 성장 잠재력 5% (직접 ORIGIN 뽑기 아님) |
| 일반 먹이 | 구매 `100,000` 토큰 · XP `+25` · 친밀도 `+3` |
| 대형 먹이 | 구매 `500,000` 토큰 · XP `+200` · 친밀도 `+10` |
| 유니크 컬러 | 매 가챠 `0.1%`, 능력 차이 없음 |
| 중복 크리처 | 자동 분해 없이 별도 개체로 보유하고 서로 다르게 육성 가능 |
| 자동 진화 | Lv.15 → 2단계 · Lv.25 → 3단계 · Lv.40 → 4단계 |
| 만렙 | Lv.50. 기존 Lv.51~100 저장은 유지되지만 더 오르지 않음 |

### 성장과 진화

가챠에서는 고등급 진화체를 직접 뽑지 않습니다. 모든 개체는 PROCESS로 시작하며 먹이로 레벨을 올리면 카탈로그 계보에 따라 자동 진화합니다. 카드는 실제 상태인 `현재 <등급>`과 자동 경로의 최종값인 `성장 잠재력 <최종 등급>`을 분리해 보여줍니다. ORIGIN 계보를 뽑아도 현재는 PROCESS며, ORIGIN 전용 공개는 실제 ORIGIN 종을 보유했을 때에만 적용됩니다. 계보에 다음 단계 데이터가 없는 경우 현재 모습으로 계속 성장합니다.

## PunchGrow를 만든 이유

AI 코딩에는 토큰 사용량이라는 유용한 활동 신호가 이미 존재합니다. PunchGrow는 실제 작업 내용을 수집하지 않으면서 이 신호를 놀이로 바꿉니다. 로컬 수집기는 숫자형 사용량만 다루며 프롬프트, 응답, 소스 코드, 명령어, 프로젝트명, 계정 식별자와 원본 파일 경로는 게임 데이터 모델에 포함하지 않습니다.

## 저장소 구성

| 영역 | 상태 | 용도 |
| --- | --- | --- |
| `macos/` | v0.2.0 | Apple Silicon macOS 14+용 네이티브 SwiftUI 메뉴 막대 게임 |

현재 게임에는 60종 시작형 가챠, Lv.15·25·40 자동 진화, 6단계 진화 등급(`PROCESS` → `ORIGIN`), 유니크 컬러, 먹이 주기, 로컬 저장·복원과 240종 크리처 도감이 포함되어 있습니다.

macOS 팝업에서는 일반·대형 먹이의 구매와 급여 버튼을 길게 눌러 가속 연속 실행할 수 있습니다. 가챠 결과와 메인 카드에서 현재 등급과 성장 잠재력을 함께 확인할 수 있습니다. 하단의 `등급표`는 `PROCESS 100%`인 직접 가챠 등급과 `ORIGIN 계보 3/60 (5%)`와 같은 성장 계보 비율, 보유·발견·전체 크리처 수를 분리해 보여줍니다. `진화`에서는 선택한 크리처의 시작형부터 최종형까지 이미지·등급·분기·자동 경로를 진화도감으로 볼 수 있습니다. `도감`과 `설정`은 큰 화면으로 바로 이동하며, 높은 단계일수록 배지·테두리·오라 효과가 강화됩니다.

### 실제 플랜 사용률

메뉴 막대의 `C n%`와 `X n%`는 토큰량으로 추정한 값이 아닙니다.

- `C`: v0.2.0은 `~/.claude/plugins/oh-my-claudecode/.usage-cache-anthropic.json`에 기록된 Claude 실제 주간 사용률을 읽습니다. 이 캐시가 없으면 `확인 대기`로 남습니다.
- `X`: Codex 세션 로그의 실제 주간 `used_percent`
- 자동 수집이 켜져 있으면 약 10초 간격으로 확인합니다.
- 공급자가 새 값을 기록하면 사용 증가와 주간 초기화를 자동 반영합니다.
- 값이 없으면 임의로 `0%`를 표시하지 않고 `확인 대기`로 표시합니다.

## 개인정보 보호 구조

macOS 앱은 로컬에서 실행되며 사용자가 명시적으로 활성화하기 전까지 수집 기능이 꺼져 있습니다.

- Claude Code 사용량은 `~/.claude/projects/**/*.jsonl`에서 탐색합니다.
- Codex 사용량은 `~/.codex/sessions/**/*.jsonl`에서 탐색합니다.
- 플랜 사용률은 Claude의 로컬 사용량 캐시와 Codex 로그의 한도 메타데이터에서 읽으며 인증 토큰은 저장하지 않습니다.
- 최초 스캔은 토큰을 지급하지 않는 기준선을 만들며, 이후 증가분만 게임 토큰으로 적립합니다.
- PunchGrow는 정규화된 토큰 수, 시각, 불투명 해시, 증분 커서와 게임 상태만 저장합니다.
- 프롬프트, 응답, 소스 코드, 명령어, 프로젝트명, 원본 경로, 이메일, 계정·모델 식별자는 저장하지 않습니다.
- PunchGrow 연결을 해제하고 캐시를 삭제해도 원본 Claude Code·Codex 로그는 수정하거나 삭제하지 않습니다.

자세한 수집 방식과 상태 모델은 [macOS 문서](macos/README.md)를 참고하세요.

## 5분 사용 순서

1. 앱을 실행하면 Dock이 아니라 macOS 메뉴 막대에 PunchGrow 크리처가 나타납니다.
2. 메뉴 막대 아이콘을 눌러 팝업을 열고, 하단 `설정`에서 큰 창을 연 다음 사이드바의 `Connections`로 이동합니다.
3. `수집 동의 및 시작`을 누르면 Claude Code·Codex 로컬 로그의 숫자형 사용량만 약 10초 간격으로 확인합니다.
4. 첫 스캔은 기존 기록을 소급 지급하지 않는 기준선입니다. 이후 새 사용량부터 보유 토큰에 반영됩니다.
5. 토큰으로 먹이를 구매하거나 가챠를 실행하고, `등급표`와 `진화`에서 성장 가능성을 확인합니다.

설치·수집 상태·게임 조작·백업·삭제·문제 해결은 [상세 사용 가이드](docs/USAGE.md)에 화면과 함께 정리했습니다.

## 빠른 시작

### Homebrew로 설치 (권장)

Apple Silicon, macOS 14 이상이 필요합니다.

```bash
brew tap yoonsundo/punchgrow https://github.com/yoonsundo/punchgrow
brew trust yoonsundo/punchgrow
brew install --cask punchgrow
xattr -d com.apple.quarantine /Applications/PunchGrow.app
```

현재 배포 바이너리는 Apple 공증(notarization) 전의 ad-hoc 서명 빌드라서, 마지막 `xattr` 명령으로 격리 속성을 제거해야 첫 실행이 차단되지 않습니다. Homebrew 6 미만은 `brew trust` 단계를 건너뜁니다. 과거 안내에 있던 `--no-quarantine` 옵션은 Homebrew 6에서 제거되어 더 이상 동작하지 않습니다.

### 소스에서 빌드

Apple Silicon, macOS 14 이상, 버전이 일치하는 Full Xcode와 Command Line Tools가 필요합니다.

처음 받는 사용자는 GitHub 저장소 화면에서 **Code → Download ZIP**을 선택해 압축을 푼 뒤, 터미널에서 압축을 푼 폴더의 `macos` 디렉터리로 이동하세요. 자세한 초보자 순서는 [사용 가이드](docs/USAGE.md)에 있습니다.

```bash
cd macos
./scripts/build-app.sh
open .build/PunchGrow.app
```

생성된 앱은 로컬 실행용 ad-hoc 서명을 사용합니다. Developer ID 서명과 Apple 공증은 별도의 릴리스 계정 작업으로 남아 있으며, 완료되면 격리 해제(`xattr`) 단계 없이 설치할 수 있게 됩니다.

## 검증

수정한 영역에 맞는 검사를 실행하세요.

```bash
cd macos
swift test
swift build -c release
./scripts/build-app.sh
```

일부 macOS 검사는 호환되는 Apple SDK가 설치된 환경을 요구합니다. 크리처 검증 명령은 저장소에 포함된 실행용 자산 팩을 검사하며, 원본 아트와 생성 이력은 의도적으로 Git에서 제외합니다.

## 기여하기

이슈와 범위가 명확한 풀 리퀘스트를 환영합니다. 오픈소스 기여가 처음이라면 포크부터 풀 리퀘스트까지 전체 순서를 담은 [기여 가이드](CONTRIBUTING.md)를 먼저 읽어주세요. 풀 리퀘스트를 열기 전에 다음 사항을 확인해 주세요.

1. [macOS 상세 문서](macos/README.md)에서 수집·개인정보 경계를 확인하세요.
2. 프롬프트, 응답, 소스 코드, 명령어, 원본 경로, 이메일이나 계정 식별자를 수집하는 기능을 추가하지 마세요.
3. 동작 변경에는 테스트를 추가하거나 갱신하고 위의 관련 검증 명령을 실행하세요.

보안 또는 개인정보 관련 취약점은 공개 이슈 대신 저장소 소유자에게 비공개로 제보해 주세요.

## 라이선스와 아트워크

소스 코드는 [MIT 라이선스](LICENSE)로 공개합니다.

크리처 이미지와 기타 시각 자산에는 MIT 라이선스가 **적용되지 않습니다**. 해당 자산은 PunchGrow를 로컬에서 실행·평가·기여하기 위한 용도로만 제공합니다. 별도 서면 허가가 없는 공개 포크는 보호 대상 아트워크를 제거하거나 교체해야 합니다. 포크를 재배포하기 전에 반드시 [ASSET-LICENSE.md](ASSET-LICENSE.md)를 읽어주세요.

외부 프로젝트와 자산의 출처는 [ATTRIBUTIONS.md](ATTRIBUTIONS.md)에 기록되어 있습니다.

## 감사의 말

PunchGrow의 로컬 사용량 탐색 방식은 [PokeTokenBar](https://github.com/chattymin/PokeTokenBar)에서 영감을 받았습니다. PunchGrow는 독립적으로 구현했으며 포켓몬 이름, 스프라이트 또는 아트워크를 포함하지 않습니다.
