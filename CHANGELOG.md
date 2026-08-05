# Changelog

## 0.1.0 — 2026-08-05

PunchGrow의 첫 macOS 알파 릴리스 후보입니다.

### Added

- Claude Code와 Codex 로컬 사용량을 게임 토큰으로 적립하는 자동 수집
- 공급자가 기록한 실제 주간 플랜 사용률 `C n%` / `X n%`
- 240종 크리처와 6단계 등급, 활동 보너스, ORIGIN 천장
- 등급별 배지·테두리·오라 효과와 확률표
- 일반 먹이와 대형 먹이 구매·급여
- 클릭 및 길게 누르기 가속 연속 실행
- 로컬 저장, 백업·복원, 도감, 대표 크리처

### Performance

- 대용량 JSONL을 청크 단위로 읽는 제한 메모리 스캐너
- 공급자별 장애 격리, 증분 커서, fork replay 제거
- 실제 실행 기준 약 120MB 수준의 메모리 사용 확인

### Known limitations

- 공개 바이너리는 Developer ID 서명과 Apple 공증이 필요합니다.
- GitHub Actions의 Full Xcode 환경에서 Swift 테스트 104개와 Release 앱 빌드·서명 검증을 통과했습니다.
- 공급자가 새로운 한도 값을 기록하기 전에는 직전 플랜 사용률이 유지될 수 있습니다.
