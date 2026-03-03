# AST Regression Test Cases

## Case 1: 난이도 계산 정확성
**모듈**: DifficultyCalculator  
**조건**:
- pronunciationScore: 80, fluencyScore: 70, retryRate: 10, comprehensionScore: 75
- 최근 5세션 점수: [60, 65, 70, 75, 80] (상승세)

**기대결과**:
- 계산 난이도 68 ± 3 (모멘텀 보너스 +1.5 반영)
- 5항 공식 가중치 정확히 적용 (Accuracy 0.4, Fluency 0.3 등)

**검증 명령**:
```bash
cd server && npm test -- --testPathPattern=difficulty-calculator
```

## Case 2: 가우시안 퀘스트 선택
**모듈**: QuizSelector  
**조건**:
- 사용자 레벨: 50
- 퀘스트 풀: 난이도 40, 45, 50, 55, 60 각 1개씩 (총 5개)
- 최근 출제 ID: [id_40, id_45] (제외 대상)

**기대결과**:
- 100번 샘플링 시 난이도 50 선택 확률이 60(0.14)보다 5배 이상 높음
- 난이도 40, 45는 선택되지 않음 (recentIds 필터)

## Case 3: 음성 분석 파이프라인
**모듈**: SpeechService  
**조건**:
- 10초 길이 MP3 (64kbps, 16kHz)
- 텍스트: "I go to work every day"

**기대결과**:
- 처리 시간 4초 이내
- pronunciationScore 0-100 범위
- Whisper API 호출 1회 (재시도 없음)
- S3 임시 파일 분석 후 자동 삭제 확인

## Case 4: 콤보 시스템
**모듈**: ComboSystem  
**조건**:
- 연속 성공 5회 -> 10회 -> 20회
- 5초 이내 간격으로 성공

**기대결과**:
- 5회: 타이틀 "GOOD START", 배율 1.2x
- 10회: 타이틀 "KILLING SPREE", 배율 1.5x
- 20회: 타이틀 "RAMPAGE", 배율 2.0x
- 6초 지연 후 성공 시 콤보 초기화

## Case 5: 레벨업 임계값
**모듈**: LevelSystem  
**조건**:
- 현재 레벨: 9 (누적 EXP 2200)
- 획득 EXP: 600

**기대결과**:
- 레벨 10 달성 (임계값 2700)
- 진행률 0% (새 레벨 시작)
- 10레벨 이후 지수적 증가 적용 (2700 * 1.2^1 = 3240)

## Case 6: Redis 캐시 정합성
**모듈**: UserService + Redis  
**조건**:
- /api/user/stats 호출 (캐시 없음)
- 30분 내 동일 API 재호출

**기대결과**:
- 1차: DB 조회 1회, Redis 캐싱 (TTL 3600)
- 2차: Redis Hit, DB 조회 0회
- 캐시 TTL 만료 후 DB 재조회
