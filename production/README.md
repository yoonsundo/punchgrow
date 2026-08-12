# PunchGrow Creature Production

> 크리처 이미지와 파생 시각물은 오픈소스·CC BY 라이선스 대상이 아닙니다. 사용 범위는 저장소 루트의 `ASSET-LICENSE.md`를 따릅니다.

## 구조

- `catalog/creatures-*.json`: 병렬 제작 구간
- `catalog/creatures.json`: 검증 후 통합 정본
- `manifests/image-manifest.json`: 이미지 파일 크기·SHA-256 인덱스와 누락 목록
- `reports/global-image-qa.json`: 240장 전역 이미지 검수 결과
- `reports/contact-sheets/`: 40종 단위 시각 검수 시트 6장
- `reports/representative-six-audit.md`: 대표 6계열 기본 전신의 형태·등급·축소·비유사성 승인 보고서
- `reports/representative-six-technical.json`: 대표 6계열 2048 RGBA·sRGB·투명 모서리 기계 판독 증거
- `reports/representative-six-thumbnails/`: 재작화 없는 96px 실제 축소 시험 6장
- `../assets/creatures/generated/PG-###.png`: 활성 팩의 정사각형 카드형 마스터 자산

## 검증

```bash
npm run creatures:validate
npm run creatures:manifest
npm run creatures:images
npm run creatures:thumbnails
npm run creatures:representatives
npx tsc --noEmit
npx expo export --platform web
```

한 번에 카탈로그와 이미지 산출물을 모두 검증하려면 다음 명령을 사용한다.

```bash
npm run creatures:verify
```

이미지를 교체한 경우에는 검증 전에 `npm run creatures:reconcile-glow`로 60개 일반 진화 계열의 실제 픽셀 군집과 발광색 계통을 다시 맞춘다. 이 명령은 동일 입력에서 추가 변경이 없는 결정적 정규화 작업이다.

카탈로그 성공 조건은 다음과 같다.

- 240개 고유 ID와 시작형 60 / 일반 진화 121 / 분기·혼합·특수 34 / 변이 25 구성
- 진화 참조의 타입·개수·대상 존재 여부와 직전 단계 연결
- 몸 형태와 공통 모티프의 한글·영문 별칭을 정본 값으로 해석할 수 있음
- 진화 전후 형태 DNA 2개 이상과 공통 모티프 1개 이상을 유지하고, 같은 계열 발광색은 RGB 거리 120 이하이며 각 단계 팔레트는 실제 이미지 픽셀 검증을 통과
- 모든 시작 계열에 일반 진화 자식이 존재하고 단계가 중복·공백 없이 연속됨
- 형태 DNA 2개 이상을 계승하면서 최소 1개는 단계에 맞게 변화함
- 생성 프롬프트에 해당 진화 단계만 명시되고 다른 단계·초기형 표현과 모순되지 않음
- 이미지 경로가 `assets/creatures/generated/PG-###.png`와 정확히 일치함

이미지 성공 조건은 다음과 같다.

- 240장 모두 존재하고 카탈로그 경로와 일치함
- `cute-redesign-v2`: 정사각형 1024px 이상 PNG, `#08111F` 카드 배경, 360×360 모바일 파생본
- v2 마스터와 모바일 파생본 SHA-256이 매니페스트와 일치함
- Visual Ralph 배치 원장이 240종 전체를 포함하고 각 배치 최소 점수가 90 이상임
- 카탈로그·모바일/웹·macOS 번들 배포 경로가 승인본 해시와 일치함

`creatures:images`의 투명도·sRGB·alpha 팔레트 검사는 `legacy-v1` 전용 과거 검사다. 활성 v2는 `creatures:pack:verify`와 `creatures:qa:verify:redesign`으로 검증한다.
