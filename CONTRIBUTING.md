# PunchGrow 기여 가이드

[한국어](CONTRIBUTING.md) · [English](CONTRIBUTING.en.md)

PunchGrow에 관심 가져주셔서 감사합니다. 이 문서는 오픈소스 기여가 처음인 분도 따라 할 수 있도록 전체 순서를 설명합니다.

## 핵심 원리: 기여에는 아무 권한도 필요 없습니다

이 저장소에 직접 쓰기(push)할 수 있는 사람은 관리자뿐입니다. 기여자는 저장소를 자기 계정으로 복사(포크)해서 수정한 뒤, "이 수정을 받아주세요"라는 요청(풀 리퀘스트)을 보내는 방식으로 참여합니다.

그래서 `git push` 시 `Permission denied (403)` 오류가 났다면, 권한이 잘못된 게 아니라 원본 저장소에 직접 푸시를 시도한 것입니다. 아래 절차대로 포크에 푸시하면 해결됩니다.

## 기여 절차

1. **포크(fork)** — GitHub에서 [yoonsundo/punchgrow](https://github.com/yoonsundo/punchgrow) 페이지 오른쪽 위 `Fork` 버튼을 누릅니다. 내 계정에 복사본이 생깁니다.

2. **내 포크를 클론(clone)** — 원본이 아니라 내 포크 주소를 받아야 합니다.

   ```bash
   git clone https://github.com/<내계정>/punchgrow.git
   cd punchgrow
   ```

3. **브랜치 생성** — main을 직접 고치지 말고 작업용 줄기를 만듭니다.

   ```bash
   git checkout -b fix/무엇을-고치는지
   ```

4. **수정하고 검증** — macOS 앱 코드는 `macos/`에 있습니다. 수정 후 아래를 실행해 통과를 확인하세요.

   ```bash
   cd macos
   swift test
   ./scripts/build-app.sh
   ```

5. **내 포크로 푸시**

   ```bash
   git push -u origin fix/무엇을-고치는지
   ```

6. **풀 리퀘스트(PR) 생성** — 푸시하면 GitHub가 안내 링크를 보여줍니다. 무엇을 왜 바꿨는지, 어떤 검증을 돌렸는지 적어주세요. 관리자가 검토 후 병합합니다.

이미 원본을 클론해 버렸다면 저장소를 지울 필요 없이 원격 주소만 바꾸면 됩니다.

```bash
git remote set-url origin https://github.com/<내계정>/punchgrow.git
```

## 개발 환경 요구사항

- Apple Silicon(M1 이상) Mac, macOS 14 이상
- Full Xcode와 같은 버전을 가리키는 Command Line Tools (`xcode-select -p`가 Xcode 내부 경로여야 합니다)
- 빌드가 안 되면 [사용 가이드의 문제 해결](docs/USAGE.md)을 먼저 확인하세요.

## 지켜야 할 경계

- 프롬프트, 응답, 소스 코드, 명령어, 원본 경로, 이메일, 계정 식별자를 수집하는 기능은 추가하지 마세요. 자세한 개인정보 경계는 [macOS 문서](macos/README.md)에 있습니다.
- 크리처 이미지 등 시각 자산은 MIT가 아닌 [별도 라이선스](ASSET-LICENSE.md)를 따릅니다. 포크를 재배포하려면 해당 자산을 제거하거나 교체해야 합니다.
- 동작을 바꾸는 수정에는 테스트를 추가하거나 갱신해 주세요.

## 큰 변경은 이슈부터

간단한 오타·버그 수정은 바로 PR을 보내도 됩니다. 기능 추가나 구조 변경은 먼저 [이슈](https://github.com/yoonsundo/punchgrow/issues)를 열어 방향을 논의하면 서로 시간을 아낄 수 있습니다.

보안·개인정보 관련 문제는 공개 이슈 대신 저장소 소유자에게 비공개로 제보해 주세요.
