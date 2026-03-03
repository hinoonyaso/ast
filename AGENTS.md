# AST Agent Rules

## 목표
- 최소 수정으로 문제를 해결한다.
- 기존 게임 로직/학습 알고리즘 변경 시 사이드이펙트 분석을 필수로 수행한다.

## 수정 전 필수 단계
1. 변경 파일 목록 출력 (`client/` vs `server/` 구분)
2. 수정 이유 요약 (3줄 이내)
3. 영향 범위 분석 (`SpeechStateMachine`, `DifficultyCalculator` 등 핵심 클래스 영향도)
4. DB 스키마 변경 시 마이그레이션 필요 여부 체크

## 수정 후 필수 단계
1. TypeScript 컴파일 체크 (`tsc --noEmit` for server, Cocos 빌드 체크 for client)
2. 단위 테스트 실행 (`npm run test:unit` - `DifficultyCalculator`, `QuizSelector` 등 핵심 로직)
3. 변경 diff 요약 (API 인터페이스 변경 여부 명시)

## 금지 사항
- public API (REST 엔드포인트, Zustand Store 인터페이스) 변경 금지
- Prisma 스키마 무단 수정 금지 (마이그레이션 없이는 금지)
- Cocos 씬 파일(`.scene`) 직접 텍스트 수정 금지 (Cocos Editor 내에서만)
- Whisper API 호출 로직의 retry 로직 제거/약화 금지 (비용 폭발 방지)
- 새 npm 패키지 추가 시 보안 검증 없이 추가 금지

## 컨텍스트 우선순위
1. `PROJECT_STATE.md` (현재 작업 중인 기능/이슈)
2. `AST_기술설계서_v2.docx` (아키텍처 규칙)
3. `server/src/modules/**/types/*.ts` (인터페이스 정의)
4. `shared/types/*.ts` (공유 타입)
5. `client/assets/scripts/stores/*.ts` (상태 관리)
6. 기타 소스코드
