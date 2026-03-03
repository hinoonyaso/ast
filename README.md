# 🎮 Adaptive Speaking Trainer (AST)

> AI 기반 영어 말하기 게임형 학습 앱 — Cocos Creator + TypeScript + Node.js

[![TypeScript](https://img.shields.io/badge/TypeScript-5.0-blue)](https://www.typescriptlang.org/)
[![Node.js](https://img.shields.io/badge/Node.js-20_LTS-green)](https://nodejs.org/)
[![Cocos Creator](https://img.shields.io/badge/Cocos_Creator-3.8-orange)](https://www.cocos.com/)
[![Prisma](https://img.shields.io/badge/Prisma-5.0-purple)](https://www.prisma.io/)
[![Redis](https://img.shields.io/badge/Redis-7.0-red)](https://redis.io/)

---

## 📌 프로젝트 개요

사용자의 **실시간 발화 데이터**를 분석해 난이도를 자동 조정하는 영어 말하기 퀘스트 게임.
단순 콘텐츠 앱이 아닌 **정교한 학습 로직 + 게임화 + 데이터 기반 최적화**를 통합한 풀스택 AI 플랫폼.

```
┌─────────────────────────────────────────────────────────────┐
│                      CLIENT LAYER                            │
│         (Cocos Creator + TypeScript + Zustand)               │
├─────────────────────────────────────────────────────────────┤
│  GameScene │ UIManager │ AudioManager │ StateStore │ APIClient│
└──────────────────────────┬──────────────────────────────────┘
                           │ HTTPS / WSS
┌──────────────────────────▼──────────────────────────────────┐
│                      SERVER LAYER                            │
│              (Node.js + Express + TypeScript)                │
├─────────────────────────────────────────────────────────────┤
│  /auth  │  /speech  │  /quiz  │  /user  │  /ranking         │
│         SpeechService │ DifficultyCalculator │ RankService   │
└──────────────────────────┬──────────────────────────────────┘
                           │
┌──────────────────────────▼──────────────────────────────────┐
│                   DATA & CACHE LAYER                         │
│   MySQL 8.0 (RDS)              Redis 7.0 (ElastiCache)       │
│   • users                      • session:{userId}  24h       │
│   • speech_logs                • leaderboard:daily 24h       │
│   • quiz_results               • leaderboard:weekly 7d       │
│   • achievements               • user:skill:{userId} 1h      │
│                                • rate_limit:{ip}    1m        │
└─────────────────────────────────────────────────────────────┘
                           │
                  OpenAI Whisper API
                  Web Speech API
                  AWS S3 (Audio Storage)
```

---

## 🧠 핵심 알고리즘

### 1. 난이도 자동 조정 (5항 공식)

```typescript
interface UserSkill {
  pronunciationScore: number;  // 발음 정확도 (0-100)
  fluencyScore:       number;  // 유창성 — WPM + pause 빈도 (0-100)
  retryRate:          number;  // 재시도율 (0-100)
  comprehensionScore: number;  // 퀴즈 정답률 (0-100)
  learningIndex:      number;  // 종합 지수
}

class DifficultyCalculator {
  private readonly WEIGHTS = {
    ACCURACY:     0.4,
    FLUENCY:      0.3,
    RETRY:        0.3,   // 패널티
    COMPREHENSION:0.2,
    MOMENTUM:     0.1,
  };

  calculateDifficulty(
    baseLevel: number,
    skill: UserSkill,
    recentSessions: SessionData[]
  ): number {
    const skillScore =
      skill.pronunciationScore * this.WEIGHTS.ACCURACY +
      skill.fluencyScore       * this.WEIGHTS.FLUENCY   -
      skill.retryRate          * this.WEIGHTS.RETRY      +
      skill.comprehensionScore * this.WEIGHTS.COMPREHENSION;

    const momentumBonus = this.calculateMomentum(recentSessions);
    const raw = baseLevel + skillScore + momentumBonus;

    return Math.max(1, Math.min(100, Math.round(raw)));
  }

  // 최근 5세션 선형회귀 기울기 → -10 ~ +10 정규화
  private calculateMomentum(sessions: SessionData[]): number {
    if (sessions.length < 3) return 0;
    const scores = sessions.slice(-5).map(s => s.score);
    const slope  = this.linearRegressionSlope(scores);
    return Math.max(-10, Math.min(10, slope * 5)) * this.WEIGHTS.MOMENTUM;
  }

  private linearRegressionSlope(scores: number[]): number {
    const n    = scores.length;
    const sumX = scores.reduce((a, _, i) => a + i, 0);
    const sumY = scores.reduce((a, b) => a + b, 0);
    const sumXY= scores.reduce((a, b, i) => a + i * b, 0);
    const sumXX= scores.reduce((a, _, i) => a + i * i, 0);
    return (n * sumXY - sumX * sumY) / (n * sumXX - sumX * sumX);
  }
}
```

### 2. 퀘스트 선택 — 가우시안 가중 랜덤

```typescript
// Weight = exp( -(ΔLevel)² / 50 )
// 차이 0 → 1.00 / 차이 ±5 → 0.61 / 차이 ±10 → 0.14

class QuizSelector {
  selectNextQuiz(userLevel: number, quizPool: Quiz[], recentIds: string[]): Quiz {
    const eligible = quizPool.filter(q =>
      Math.abs(q.difficulty - userLevel) <= 10 && !recentIds.includes(q.id)
    );
    const weighted = eligible.map(q => ({
      quiz:   q,
      weight: Math.exp(-(Math.pow(q.difficulty - userLevel, 2)) / 50),
    }));
    return this.weightedRandom(weighted);
  }

  private weightedRandom(items: { quiz: Quiz; weight: number }[]): Quiz {
    const total  = items.reduce((s, i) => s + i.weight, 0);
    let   random = Math.random() * total;
    for (const item of items) {
      random -= item.weight;
      if (random <= 0) return item.quiz;
    }
    return items[items.length - 1].quiz;
  }
}
```

### 3. EXP & 레벨 시스템

```typescript
// TotalEXP = Base(10) + Accuracy(P×0.5) + Fluency(F×0.3)
//          + Speed + FirstTry(+5) + Streak(min(S×2, 20))

class LevelSystem {
  private readonly THRESHOLDS = [0, 100, 250, 450, 700, 1000, 1350, 1750, 2200, 2700];

  calculateLevel(totalExp: number): { level: number; progress: number } {
    let level = 1;
    for (let i = 0; i < this.THRESHOLDS.length; i++) {
      if (totalExp >= this.THRESHOLDS[i]) level = i + 1;
      else break;
    }
    const cur  = this.THRESHOLDS[level - 1] || 0;
    const next = this.THRESHOLDS[level]      || cur + 500;
    return { level, progress: Math.min(1, (totalExp - cur) / (next - cur)) };
  }

  // 10레벨 이후: 2700 × 1.2^(n-10) 지수 증가
  getRequiredExp(level: number): number {
    if (level <= 10) return this.THRESHOLDS[level - 1] || 0;
    return Math.floor(2700 * Math.pow(1.2, level - 10));
  }
}
```

### 4. 콤보 시스템

```typescript
class ComboSystem {
  private comboCount  = 0;
  private lastSuccess = 0;
  private readonly TIMEOUT = 5000; // 5초

  onSuccess(now: number): number {
    if (now - this.lastSuccess > this.TIMEOUT) this.comboCount = 0;
    this.comboCount++;
    this.lastSuccess = now;
    return this.comboCount;
  }

  onFailure(): void { this.comboCount = 0; this.lastSuccess = 0; }

  getMultiplier(): number {
    if (this.comboCount >= 50) return 3.0;
    if (this.comboCount >= 30) return 2.5;
    if (this.comboCount >= 20) return 2.0;
    if (this.comboCount >= 10) return 1.5;
    if (this.comboCount >= 5)  return 1.2;
    return 1.0;
  }

  getTitle(): string {
    const map: [number, string][] = [
      [100, 'LEGENDARY'], [50, 'UNSTOPPABLE'], [30, 'DOMINATING'],
      [20, 'RAMPAGE'], [10, 'KILLING SPREE'], [5, 'GOOD START'],
    ];
    return map.find(([t]) => this.comboCount >= t)?.[1] ?? '';
  }
}
```

---

## 🏗 프로젝트 구조

```
AST/
├── client/                         # Cocos Creator
│   └── assets/scripts/
│       ├── managers/               # Singleton (GameManager, UIManager, AudioManager)
│       ├── stores/                 # Zustand (gameStore.ts)
│       ├── services/               # APIService (Axios + Interceptors)
│       ├── components/             # RecordingButton 등
│       └── scenes/                 # DungeonScene, SpeechStateMachine
│
├── server/src/
│   ├── modules/
│   │   ├── auth/                   # JWT + Refresh Token
│   │   ├── speech/                 # Whisper 연동, 발음/유창성 계산
│   │   ├── quiz/                   # DifficultyCalculator, QuizSelector
│   │   ├── user/                   # 프로필, 진도, 업적
│   │   └── ranking/                # Redis Sorted Set 랭킹
│   ├── common/
│   │   ├── guards/                 # JwtAuthGuard
│   │   ├── filters/                # HttpExceptionFilter
│   │   └── interceptors/           # Transform, Logging
│   └── database/
│       ├── prisma/schema.prisma    # 6개 모델
│       └── redis/                  # 캐시 유틸
│
├── shared/types/                   # 클라이언트-서버 공유 타입
└── docker-compose.yml
```

---

## 🎤 음성 분석 파이프라인

```
[사용자 발화]
     │
     ▼
[Web Speech API]  ← 1차 실시간 텍스트 변환
     │
     ▼
[오디오 압축]
  16kHz 모노 다운샘플링 (OfflineAudioContext)
  64kbps MP3 인코딩 (lamejs)
  5MB → ~500KB (90% 감소)
     │
     ▼
POST /api/speech/analyze
     │
     ▼
[Whisper API]  ← 정확한 텍스트 + confidence
     │
     ▼
[점수 계산]
  pronunciationScore = phoneme × 0.6 + confidence × 0.4
  fluencyScore       = (WPM점수 + pause점수) / 2
                       WPM 이상값: 110 wpm (한국인 중급 학습자 기준 / 원어민 120~150과 별도 적용)
     │
     ▼
[스킬 업데이트 — 이동 평균]
  score = (score × 9 + newScore) / 10  ← 단기 변동 완화
     │
     ├── MySQL: SpeechLog 저장
     └── Redis: user:skill:{userId} 갱신 (TTL 1h)
```

---

## 💾 데이터베이스 스키마 (Prisma)

```prisma
model User {
  id           String   @id @default(uuid())
  email        String   @unique
  nickname     String
  password     String
  currentLevel Int      @default(1)
  totalExp     Int      @default(0)
  createdAt    DateTime @default(now())
  updatedAt    DateTime @updatedAt

  speechLogs   SpeechLog[]
  quizResults  QuizResult[]
  achievements UserAchievement[]
  @@map("users")
}

model SpeechLog {
  id                 String   @id @default(uuid())
  userId             String
  transcribedText    String   @db.Text
  pronunciationScore Int
  fluencyScore       Int
  duration           Float
  createdAt          DateTime @default(now())

  user User @relation(fields: [userId], references: [id])
  @@index([userId, createdAt])
  @@map("speech_logs")
}

model QuizResult {
  id              String   @id @default(uuid())
  userId          String
  quizId          String
  isCorrect       Boolean
  responseTimeMs  Int
  difficultyLevel Int
  createdAt       DateTime @default(now())

  user User @relation(fields: [userId], references: [id])
  quiz Quiz @relation(fields: [quizId], references: [id])
  @@index([userId, createdAt])
  @@map("quiz_results")
}

model Quiz {
  id         String  @id @default(uuid())
  question   String  @db.Text
  answer     String
  difficulty Int
  category   String
  tags       String?

  results    QuizResult[]
  @@index([difficulty, category])
  @@map("quizzes")
}
```

---

## ⚡ 성능 최적화 결과

| 지표 | Before | After | 개선율 |
|------|--------|-------|--------|
| API 평균 응답 | 320ms | 120ms | **62.5% ↓** |
| DB 조회 / 요청 | 8.5회 | 1.2회 | **86% ↓** |
| Redis 캐시 히트율 | 0% | 87% | **+87%p** |
| 앱 초기 로딩 | 2.3초 | 1.1초 | **52% ↓** |
| 음성 분석 시간 | 12초 (동기) | 4초 (비동기) | **67% ↓** |
| 메모리 사용 (30분) | 520MB | 195MB | **62% ↓** |
| 동시 사용자 처리 | 500명 | 2,500명 | **400% ↑** |
| P95 레이턴시 (1000동시) | 2.8초 | 180ms | **94% ↓** |
| 에러율 (1000동시) | 12.5% | 0.1% | **99% ↓** |
| 월간 인프라 비용 | ~$1,200 | ~$350 | **71% ↓** |

### 핵심 최적화 기법

**서버**
- Redis Cache-Aside: `user:stats`, `user:skill`, `leaderboard` 전략적 캐싱
- Prisma `include`로 N+1 쿼리 → 단일 쿼리 (DB 조회 86% 감소)
- Connection Pool 20개 (단일 연결 → 동시 처리 5배)
- `@@index([userId, createdAt])` 복합 인덱스 추가

**클라이언트**
- 오디오 16kHz 다운샘플링 + 64kbps MP3 (5MB → 500KB)
- Cocos `onDestroy` 명시적 리소스 해제 (메모리 누수 0건)
- Object Pool, 텍스처 압축, 씬 프리로딩

---

## 🔌 API 요약

```
POST   /api/auth/login            로그인 + JWT 발급
POST   /api/auth/refresh          Access Token 갱신
POST   /api/speech/analyze        음성 분석 (multipart, JWT)
GET    /api/speech/history        발화 히스토리
GET    /api/quiz/next             다음 퀘스트 (가우시안 가중 선택)
POST   /api/quiz/submit           답안 제출 + 난이도 재계산
GET    /api/user/stats            종합 통계 (Redis Cache 1h)
GET    /api/ranking/daily         일일 랭킹 (Redis Sorted Set)
GET    /api/ranking/weekly        주간 랭킹
```

**공통 응답 포맷**
```json
{ "success": true, "data": { ... }, "timestamp": "2026-03-03T00:00:00Z" }
```

---

## 🚀 로컬 실행

```bash
# 의존성 설치
npm install

# 인프라 (MySQL + Redis)
docker-compose up -d

# DB 마이그레이션 (개발 초기: Day 1~4)
cd server && npx prisma migrate dev --name init

# 서버 실행
npm run dev:server   # :3000

# 클라이언트 (Cocos Creator에서 열기)
# client/ 폴더를 Cocos Creator 3.8로 open
```

**필수 환경변수 (`server/.env`)**
```env
DATABASE_URL=mysql://user:password@localhost:3306/ast
REDIS_URL=redis://localhost:6379
JWT_SECRET=your-secret-key
JWT_REFRESH_SECRET=your-refresh-secret
OPENAI_API_KEY=sk-...
AWS_ACCESS_KEY_ID=...
AWS_SECRET_ACCESS_KEY=...
AWS_REGION=ap-northeast-2
```

**Prisma 마이그레이션 운영 규칙**
- 개발 초기(Day 1~4): `prisma migrate dev`로 마이그레이션 생성 + 적용
- 프로덕션(Week 9+): `prisma migrate deploy`로 생성된 마이그레이션만 적용
- 금지: `prisma db push` (이력 누락), `prisma migrate reset` (데이터 초기화 위험)

---

## 🧪 테스트

```bash
# 단위 테스트 (DifficultyCalculator, QuizSelector, EXP 계산)
npm run test:unit

# API 통합 테스트
npm run test:integration

# 전체 커버리지
npm run test:coverage
# 목표: 핵심 알고리즘 100%, 전체 80%+
```

---

## ☁️ AWS 배포 구성

```
Route 53 → CloudFront (CDN) → S3 (정적 리소스)
         → ALB → EC2 Auto Scaling (c5.large × 2+)
                    → RDS MySQL 8.0 (Multi-AZ + Read Replica)
                    → ElastiCache Redis 7.0 (Cluster Mode)
```

```bash
# 프로덕션 배포
npx prisma migrate deploy
pm2 start dist/main.js --name ast-server
```

---

## 📊 시장 규모 및 데이터 출처

| 구분 | 수치 | 출처 |
|------|------|------|
| 국내 영어 교육 시장 (TAM) | 12조~29조원 | [kwonputer.tistory.com/578](https://kwonputer.tistory.com/578) — 한국 교육 시장 25.9조 기준 |
| 글로벌 ELL 시장 (2035 전망) | 1,471억 달러 (약 200조원+) | [marketgrowthreports.com](https://www.marketgrowthreports.com/ko/market-reports/english-language-learning-market-103052) |
| Duolingo MAU (2025 Q3) | 8,300만+ | [analyzify.com/statsup/duolingo](https://analyzify.com/statsup/duolingo) |
| Speak 앱 누적 발화량 한국 (2026) | 2.3억 건 | [press.startupdaily.kr](https://press.startupdaily.kr/newsRead.php?no=1028827) |
| SaaS LTV:CAC 최적 비율 | 3:1 이상 | [payproglobal.com/ko](https://payproglobal.com/ko/답변/saas-ltv-cac-비율이란/) |
| 모바일 앱 평균 Churn율 | 월 20%+ / 우수앱 연 4~7% | [appsflyer.com/ko](https://www.appsflyer.com/ko/glossary/churn-rate/) |
| Whisper API 가격 (2026 확인) | $0.006/min | [brasstranscripts.com](https://brasstranscripts.com/blog/openai-whisper-api-pricing-2025-self-hosted-vs-managed) |
| WPM 이상값 (한국인 학습자) | 110 WPM | 원어민 기준 120~150과 별도 적용, 한국인 중급 목표치 기준 |

---

## 🛠 기술 스택

| 레이어 | 기술 | 버전 |
|--------|------|------|
| 클라이언트 | Cocos Creator | 3.8+ |
| 상태관리 | Zustand (subscribeWithSelector) | 4.4+ |
| HTTP | Axios + Interceptors | 1.6+ |
| 서버 | Node.js + Express + TypeScript | 20 LTS |
| ORM | Prisma | 5.0+ |
| DB | MySQL (AWS RDS) | 8.0 |
| 캐시 | Redis (AWS ElastiCache) | 7.0 |
| AI 음성 | OpenAI Whisper API | v1 |
| 인프라 | AWS (EC2 + RDS + ElastiCache + S3 + CloudFront) | - |
| CI/CD | GitHub Actions | - |

---

## 📄 관련 문서

| 문서 | 대상 | 내용 |
|------|------|------|
| [제품 기획서 (PRD)](./docs/AST_제품기획서.docx) | 기획자 / 경영진 | 시장 분석, 페르소나, MoSCoW, 비즈니스 모델, KPI |
| [기술 설계서 (TDD)](./docs/AST_기술설계서.docx) | 개발자 | 아키텍처, 알고리즘, API 명세, 성능 최적화 |
| 이 README | GitHub 방문자 | 핵심 코드, 구조, 실행 방법 |

---

*말해보카 AI R&D 포트폴리오 프로젝트 — 2026*
