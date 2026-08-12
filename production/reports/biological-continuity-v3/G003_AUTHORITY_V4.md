# G003 authority v4

새 G003 작업은 `continuity-g003-review-protocol-v4`와 `production/reports/biological-continuity-v3/g003-evidence-v3`만 사용한다. 공개 권한 기록은 `production/contracts/g003-public-authority-v1.json`에 두었다. 계약 파일은 코드와 증거 양쪽에서 참조하는 공개 신뢰 기준이므로 변경 가능한 실행 결과 폴더보다 `production/contracts`가 더 적합하다.

모든 쓰기 명령은 파일을 만들기 전에 입력 키가 고정된 Ed25519 fingerprint, SPKI, HMAC commitment를 모두 파생하는지 확인한다. 서명은 authority epoch, artifact purpose, schema digest에 도메인 분리되어 있으며 G002 서명이나 G003 v1~v3 패키지는 v4 입력으로 인정하지 않는다. 숨은 키는 저장소나 로그에 저장하지 않는다.

G002-v2 공개 증거와 240개 런타임 자산, 활성 팩 보호 파일 4개 검증은 v4에서도 필수 선행 조건이다. `g003-evidence-v2`와 그 이전 증거는 수정하지 않고 레거시 검증 자료로 남긴다.
