# PunchGrow 첫 출시 크리처 240종 제작 보고서

## 결과

- 카탈로그: `PG-001`~`PG-240` 총 240종
- 구성: 시작형 60 / 일반 진화 121 / 분기·혼합·특수 34 / 변이 25
- 중복: ID·한글 이름·영문 이름 0건
- 필드: 이름, 계열, 단계, 등급, 몸 형태, 분위기, 정체성, 서사, 형태 DNA 3개, 팔레트, 공통 모티프, 진화 연결, 이미지 경로, 재생성 프롬프트
- 이미지: `cute-redesign-v2` 마스터 240장과 360×360 모바일 파생본 240장, 시각 QA 최소 90점, 세 플랫폼 배포 경로 해시 검증 통과
- 시각 증거: 40종 단위 컨택트 시트 6장

## 정본 위치

- 통합 도감: `production/catalog/creatures.json`
- 구간별 원본: `production/catalog/creatures-001-080.json`, `creatures-081-160.json`, `creatures-161-240.json`
- 이미지: `assets/creatures/generated/PG-###.png`
- 이미지 인덱스: `production/manifests/image-manifest.json`
- 전역 QA: `production/reports/global-image-qa.json`
- 컨택트 시트: `production/reports/contact-sheets/`
- 대표 6계열 시각 승인: `production/reports/representative-six-audit.md`
- 대표 6계열 기술 증거: `production/reports/representative-six-technical.json`

## 검증 결과

- 카탈로그 검증: PASS — 240/240, 분류 수량 정확, 연속 ID, 필수 필드·이름 중복 오류 0
- 진화 검증: PASS — 부모 참조·직전 단계·계보 ID·팔레트·형태 DNA 2개 이상·공통 모티프 연속성 오류 0
- 프롬프트 검증: PASS — 카탈로그 단계와 프롬프트 단계 표기 불일치 0
- 이미지 매핑: PASS — 240/240, 누락 0
- PNG 디코드: PASS — 240/240
- v2 이미지 규격: PASS — 마스터 정사각형 1024px 이상, 모바일 360×360, 마스터·모바일 SHA-256 일치
- v2 시각 QA: PASS — Visual Ralph 24개 배치, 240종 모두 최소 90점, 실패 0
- v2 배포 일치: PASS — 카탈로그·모바일/웹·macOS 번들 720개 파일 해시 일치
- 계열 발광색: PASS — 60개 일반 진화 계열의 인접 단계 RGB 거리 120 이하
- 이미지 SHA-256 중복: 0
- 카탈로그 경로 불일치: 0
- TypeScript: `npx tsc --noEmit` PASS
- Expo Web: `npx expo export --platform web` PASS

## 품질 경계

이번 240장은 앱 도감, 가챠 프로토타입, 성장·진화 연결과 축소 가독성 검증에 사용하는 카드형 기본 전신 자산이다. 활성 v2는 `#08111F` 배경과 96px 가독성 게이트를 사용한다. 과거 투명 PNG 대표 감사는 `legacy-v1`의 역사적 증거이며 v2 승인 근거로 사용하지 않는다. 삼면도·표정·모션·변형·컬러는 후속 상세 제작 범위다.

## AI 슬롭 정리

- 범위: 이번 작업에서 추가한 카탈로그·이미지 처리 스크립트와 생산 문서
- 행동 잠금: 카탈로그 검증, 이미지 매핑, TypeScript, Expo Web 빌드
- 마스킹 fallback: 이미지 폴더 누락을 빈 배열로 숨기던 처리 1건 제거; 이제 명시적으로 실패
- 죽은 코드·중복·임시 우회: 발견 없음
- 가독성: 매니페스트 변수명, 검증 도우미 선언 방식, PNG `sRGB` 탐색과 팔레트·발광색 임계값을 명확하게 정리
- QA 재현 의존성: `pngjs`를 개발 의존성으로 명시해 Pillow 없이 동일 검사를 재실행 가능
- 대표 검증: 기술 보고서 SHA-256·sRGB 태그·96px 축소본·등급·카탈로그 팔레트의 작업서 일치를 자동 확인
