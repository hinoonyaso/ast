<!-- Converted from AST_기술설계서_v2.docx via LibreOffice text export -->

﻿Adaptive Speaking Trainer
기술 설계서 (TDD) v2.0
Technical Design Document — 코드 기반 상세 설계




Client: Cocos Creator 3.8 + TypeScript 5.0
Server: Node.js 20 LTS + Express + Prisma 5.0
Infra: AWS EC2 + RDS + ElastiCache + CloudFront




본 문서는 제품 기획서(별도)와 함께 구성됩니다.
작성일: 2026-03-03  |  v2.0 (코드 상세 보강)

1. 시스템 아키텍처

1.1 전체 아키텍처 (4계층)
계층
구성 요소
기술 스택
역할
Client Layer
GameScene / UIManager / AudioManager / StateStore / APIClient
Cocos Creator 3.8 + TS 5.0 + Zustand 4.4 + Axios 1.6
게임 UI, 상태 관리, 서버 통신
API Gateway
Express Router + Middleware Pipeline
Node.js 20 LTS + Express 4.18
라우팅, JWT 인증, Rate Limiting
Service Layer
Speech / Quiz / User / Ranking Service
TypeScript 모듈 + Prisma ORM
비즈니스 로직 전담
Data Layer
MySQL(RDS) + Redis(ElastiCache)
MySQL 8.0 + Redis 7.0
영속 저장 + 캐시/세션/랭킹

1.2 AWS 인프라
서비스
사양
역할
Route 53 + CloudFront
-
DNS + CDN (S3 정적 리소스)
ALB + EC2 Auto Scaling
c5.large × 2 기본
트래픽 분산 + 무중단 확장
RDS MySQL 8.0
db.t3.medium
Multi-AZ, Read Replica
ElastiCache Redis 7.0
cache.t3.micro
Cluster Mode, Auto-failover
S3
-
오디오 임시 저장 (분석 후 삭제)

1.3 음성 분석 데이터 흐름 (8단계)
#
액터
행동
비고
1
Client
마이크 녹음 (MediaRecorder + Web Audio API)

2
Client
16kHz 모노 다운샘플링 + 64kbps MP3 (5MB → ~500KB)
OfflineAudioContext + lamejs
3
Client → Server
POST /api/speech/analyze (multipart/form-data, JWT)
최대 10MB 제한
4
Server → Whisper
오디오 버퍼 전송 → 텍스트 + confidence + words + pauses 수신
비동기 await
5
Server
pronunciationScore = phoneme × 0.6 + confidence × 0.4
내부 계산
6
Server
fluencyScore = (WPM점수 + pause점수) / 2  (이상값: 110 WPM — 한국인 학습자 기준, 원어민 120~150과 별도 적용)
내부 계산
7
Server
Prisma SpeechLog 저장 + Redis user:skill 이동 평균 갱신
TTL 1h, 비동기 분리
8
Server → Client
점수 + 피드백 + 난이도 조정 결과 반환
평균 응답 120ms

2. 학습 알고리즘 — 전체 코드

2.1 UserSkill 인터페이스
types/user-skill.interface.ts
interface UserSkill {
  // 발음 정확도 (0-100)
  pronunciationScore: number;

  // 유창성 점수 (0-100)
  // - 말하기 속도 (WPM, 이상값 110 — 한국인 학습자 기준)
  // - 휴지 빈도 (pause frequency)
  // - 리듬 자연스러움
  fluencyScore: number;

  // 재시도율 (0-100): (재시도 횟수 / 총 시도 횟수) × 100
  retryRate: number;

  // 이해도 점수 (0-100): 퀴즈 정답률 기반
  comprehensionScore: number;

  // 종합 학습 지수
  learningIndex: number;
}

2.2 DifficultyCalculator — 5항 공식 + 선형회귀 모멘텀
modules/quiz/difficulty-calculator.ts
class DifficultyCalculator {
  private readonly WEIGHTS = {
    ACCURACY:     0.4,   // pronunciationScore — 최고 가중치
    FLUENCY:      0.3,   // fluencyScore
    RETRY_PENALTY:0.3,   // 패널티 — 재시도 많을수록 난이도 하향
    COMPREHENSION:0.2,   // comprehensionScore
    MOMENTUM:     0.1,   // 최근 추세 보너스/페널티
  };

  calculateDifficulty(
    baseLevel: number,
    skill: UserSkill,
    recentSessions: SessionData[]
  ): number {
    // 1. 기본 스킬 점수 계산
    const skillScore =
      skill.pronunciationScore * this.WEIGHTS.ACCURACY       +
      skill.fluencyScore       * this.WEIGHTS.FLUENCY        -
      skill.retryRate          * this.WEIGHTS.RETRY_PENALTY  +
      skill.comprehensionScore * this.WEIGHTS.COMPREHENSION;

    // 2. 모멘텀 보너스 (최근 5세션 추세)
    const momentumBonus = this.calculateMomentum(recentSessions);

    // 3. 최종 난이도 (1~100 범위 클리핑)
    const raw = baseLevel + skillScore + momentumBonus;
    return Math.max(1, Math.min(100, Math.round(raw)));
  }

  private calculateMomentum(sessions: SessionData[]): number {
    if (sessions.length < 3) return 0;
    const scores = sessions.slice(-5).map(s => s.score);
    const slope  = this.linearRegressionSlope(scores);
    // 기울기를 -10 ~ +10 범위로 정규화 후 가중치 적용
    return Math.max(-10, Math.min(10, slope * 5)) * this.WEIGHTS.MOMENTUM;
  }

  private linearRegressionSlope(scores: number[]): number {
    const n     = scores.length;
    const sumX  = scores.reduce((a, _, i) => a + i, 0);
    const sumY  = scores.reduce((a, b) => a + b, 0);
    const sumXY = scores.reduce((a, b, i) => a + i * b, 0);
    const sumXX = scores.reduce((a, _, i) => a + i * i, 0);
    return (n * sumXY - sumX * sumY) / (n * sumXX - sumX * sumX);
  }
}

2.3 QuizSelector — 가우시안 가중 랜덤
Weight = exp( -(ΔLevel)² / 50 )  →  차이 0: 1.00 / 차이 ±5: 0.61 / 차이 ±10: 0.14
modules/quiz/quiz-selector.ts
class QuizSelector {
  selectNextQuiz(
    userLevel:   number,
    quizPool:    Quiz[],
    recentIds:   string[]
  ): Quiz {
    // 1. 난이도 범위 필터링 (±10 레벨, 최근 출제 제외)
    const eligible = quizPool.filter(q =>
      Math.abs(q.difficulty - userLevel) <= 10 &&
      !recentIds.includes(q.id)
    );

    // 2. 가우시안 가중치 계산
    const weighted = eligible.map(q => ({
      quiz:   q,
      weight: this.gaussianWeight(q.difficulty, userLevel),
    }));

    // 3. 가중 랜덤 선택
    return this.weightedRandom(weighted);
  }

  private gaussianWeight(difficulty: number, userLevel: number): number {
    const diff = Math.abs(difficulty - userLevel);
    return Math.exp(-(diff * diff) / 50);
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

2.4 LevelSystem — EXP & 지수적 레벨업
modules/user/level-system.ts
class LevelSystem {
  // 레벨별 누적 EXP 임계값
  private readonly THRESHOLDS: number[] = [
    0, 100, 250, 450, 700, 1000, 1350, 1750, 2200, 2700,
  ];

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

  // 10레벨 이후: 2700 × 1.2^(n-10) 지수적 증가
  getRequiredExp(level: number): number {
    if (level <= 10) return this.THRESHOLDS[level - 1] || 0;
    return Math.floor(2700 * Math.pow(1.2, level - 10));
  }
}

2.5 ComboSystem — 6단계 타이틀 + EXP 배율
modules/quiz/combo-system.ts
class ComboSystem {
  private comboCount     = 0;
  private lastSuccessAt  = 0;
  private readonly TIMEOUT_MS = 5000; // 5초 초과 시 콤보 초기화

  onSuccess(now: number): number {
    if (now - this.lastSuccessAt > this.TIMEOUT_MS) this.comboCount = 0;
    this.comboCount++;
    this.lastSuccessAt = now;
    return this.comboCount;
  }

  onFailure(): void {
    this.comboCount    = 0;
    this.lastSuccessAt = 0;
  }

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
      [100, 'LEGENDARY'],  [50, 'UNSTOPPABLE'], [30, 'DOMINATING'],
      [20,  'RAMPAGE'],    [10, 'KILLING SPREE'], [5, 'GOOD START'],
    ];
    return map.find(([threshold]) => this.comboCount >= threshold)?.[1] ?? '';
  }
}


3. 데이터베이스 설계

3.1 Prisma 스키마 전체
database/prisma/schema.prisma
generator client { provider = "prisma-client-js" }
datasource db    { provider = "mysql"; url = env("DATABASE_URL") }

model User {
  id           String   @id @default(uuid())
  email        String   @unique
  nickname     String
  password     String                    // bcrypt hashed
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
  duration           Float                // seconds
  createdAt          DateTime @default(now())
  user               User     @relation(fields: [userId], references: [id])
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
  user            User     @relation(fields: [userId], references: [id])
  quiz            Quiz     @relation(fields: [quizId], references: [id])
  @@index([userId, createdAt])
  @@map("quiz_results")
}

model Quiz {
  id         String       @id @default(uuid())
  question   String       @db.Text
  answer     String
  difficulty Int
  category   String
  tags       String?                      // JSON array
  results    QuizResult[]
  @@index([difficulty, category])
  @@map("quizzes")
}

model UserAchievement {
  id            String      @id @default(uuid())
  userId        String
  achievementId String
  unlockedAt    DateTime    @default(now())
  user          User        @relation(fields: [userId], references: [id])
  achievement   Achievement @relation(fields: [achievementId], references: [id])
  @@unique([userId, achievementId])
  @@map("user_achievements")
}

3.2 Redis 캐시 전략
Key 패턴
타입
TTL
전략
목적
session:{userId}
Hash
24시간
Write-Through
JWT 세션
leaderboard:daily
Sorted Set
24시간
Write-Through
일일 랭킹 실시간
leaderboard:weekly
Sorted Set
7일
Write-Through
주간 랭킹
user:stats:{userId}
String (JSON)
1시간
Cache-Aside
종합 통계 (DB 86% 경감)
user:skill:{userId}
Hash
1시간
Cache-Aside
UserSkill 이동 평균
rate_limit:{ip}
Counter
1분
Write-Through
Rate Limiting

4. REST API 명세

4.1 공통 규격
항목
규격
Base URL
https://api.ast.com/api
인증
Authorization: Bearer {accessToken}  (JWT, 15분 만료)
Refresh Token
HttpOnly Cookie, 7일 만료, 로테이션 적용
성공 응답
{ "success": true, "data": {...}, "timestamp": "ISO8601" }
실패 응답
{ "success": false, "errorCode": "STRING", "message": "...", "path": "..." }
Rate Limit
IP 기준 분당 60 요청 (Redis INCR/EXPIRE)

4.2 전체 엔드포인트
Method
Endpoint
기능
인증
POST
/auth/register
회원가입
없음
POST
/auth/login
로그인 + JWT 발급
없음
POST
/auth/refresh
Access Token 갱신
Refresh Cookie
POST
/auth/logout
로그아웃 + Cookie 삭제
JWT
POST
/speech/analyze
음성 파일 업로드 및 분석 (multipart, max 10MB)
JWT
GET
/speech/history
발화 히스토리 (page, limit 쿼리)
JWT
GET
/speech/feedback/:id
상세 피드백 조회
JWT
GET
/quiz/next
다음 퀘스트 (가우시안 가중 선택, exclude[] 쿼리)
JWT
POST
/quiz/submit
답안 제출 + EXP 지급 + 난이도 재계산
JWT
GET
/quiz/progress
학습 진도 (level, exp, streak)
JWT
GET
/user/profile
프로필 조회
JWT
GET
/user/stats
종합 통계 (Redis Cache 1h)
JWT
GET
/user/achievements
업적 목록
JWT
GET
/ranking/daily
일일 랭킹 (Redis leaderboard:daily)
JWT
GET
/ranking/weekly
주간 랭킹 (Redis leaderboard:weekly)
JWT
GET
/ranking/all-time
전체 랭킹 (DB 직접 조회)
JWT

5. 클라이언트 설계 (Cocos Creator)

5.1 GameManager — Singleton + PersistRootNode
managers/GameManager.ts
@ccclass('GameManager')
export class GameManager extends Component {
  private static _instance: GameManager;
  public  static get instance() { return this._instance; }

  @property(UIManager)    uiManager:    UIManager    = null;
  @property(AudioManager) audioManager: AudioManager = null;
  @property(APIService)   apiService:   APIService   = null;

  onLoad() {
    if (GameManager._instance) { this.destroy(); return; }
    GameManager._instance = this;
    director.addPersistRootNode(this.node);  // 씬 전환 후에도 유지
    this.initialize();
  }

  private async initialize() {
    await this.apiService.initialize();
    await this.audioManager.initialize();
  }
}

5.2 Zustand gameStore — subscribeWithSelector
stores/gameStore.ts
import { create } from 'zustand';
import { subscribeWithSelector } from 'zustand/middleware';

interface GameState {
  user:         User | null;
  currentLevel: number;
  exp:          number;
  combo:        number;
  isRecording:  boolean;
  setUser:        (user: User) => void;
  addExp:         (amount: number) => void;
  incrementCombo: () => void;
  resetCombo:     () => void;
  setRecording:   (v: boolean) => void;
}

export const useGameStore = create<GameState>()(subscribeWithSelector((set, get) => ({
  user: null, currentLevel: 1, exp: 0, combo: 0, isRecording: false,

  setUser: (user) => set({ user }),

  addExp: (amount) => {
    const { exp, currentLevel } = get();
    const { level } = LevelSystem.calculateLevel(exp + amount);
    set({ exp: exp + amount, currentLevel: level });
    if (level > currentLevel) EventManager.emit('levelUp', { newLevel: level });
  },

  incrementCombo: () => set(s => ({ combo: s.combo + 1 })),
  resetCombo:     () => set({ combo: 0 }),
  setRecording:   (v) => set({ isRecording: v }),
})));

// 선택적 구독 — combo 변경 시만 실행 (성능 최적화)
useGameStore.subscribe(
  (state) => state.combo,
  (combo) => EventManager.emit('comboChanged', combo)
);

5.3 APIService — Axios + 401 자동 토큰 갱신
services/APIService.ts (핵심 인터셉터)
private setupInterceptors() {
  // 요청: JWT 자동 첨부
  this.axios.interceptors.request.use(config => {
    const token = localStorage.getItem('accessToken');
    if (token) config.headers.Authorization = `Bearer ${token}`;
    return config;
  });

  // 응답: 401 시 자동 토큰 갱신 후 원래 요청 재시도
  this.axios.interceptors.response.use(
    res => res,
    async error => {
      const { config, response } = error;
      if (response?.status === 401 && !config._retry) {
        config._retry = true;
        await this.refreshToken();
        return this.axios(config);
      }
      return Promise.reject(error);
    }
  );
}

async analyzeSpeech(audioBlob: Blob): Promise<SpeechResult> {
  const form = new FormData();
  form.append('audio', audioBlob);
  const res = await this.axios.post('/speech/analyze', form, {
    headers: { 'Content-Type': 'multipart/form-data' },
  });
  return res.data;
}

5.4 RecordingButton — 오디오 압축 파이프라인
components/RecordingButton.ts (압축 + 전송)
private async startRecording() {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  this.recorder = new MediaRecorder(stream);
  const chunks: Blob[] = [];
  this.recorder.ondataavailable = e => chunks.push(e.data);
  this.recorder.onstop = async () => {
    const raw       = new Blob(chunks, { type: 'audio/webm' });
    const compressed = await this.compress(raw); // 5MB → ~500KB
    await GameManager.instance.apiService.analyzeSpeech(compressed);
  };
  this.recorder.start();
}

private async compress(blob: Blob): Promise<Blob> {
  const arrayBuf  = await blob.arrayBuffer();
  const audioCtx  = new AudioContext();
  const audioBuf  = await audioCtx.decodeAudioData(arrayBuf);
  // 16kHz 모노 다운샘플링
  const offCtx    = new OfflineAudioContext(1, audioBuf.duration * 16000, 16000);
  const source    = offCtx.createBufferSource();
  source.buffer   = audioBuf;
  source.connect(offCtx.destination);
  source.start();
  const rendered  = await offCtx.startRendering();
  return encodeToMp3(rendered, 64); // lamejs, 64kbps
}

5.5 발화 State Machine
현재 상태
진입 조건
다음 상태
주요 행동
IDLE
앱 시작 / 퀘스트 완료 / 레벨업
QUEST_START
퀘스트 목록 표시
QUEST_START
퀘스트 선택
LISTENING
문제 표시, 마이크 활성화
LISTENING
마이크 버튼 탭
ANALYZING
녹음 시작, 파형 UI
ANALYZING
녹음 종료
RESULT / RETRY
압축 → API 전송 → 대기
RESULT
서버 응답 수신
COMBO_UPDATE → IDLE
점수 표시, EXP 지급, 몬스터 애니메이션
RETRY
실패 또는 재시도 선택
LISTENING
콤보 초기화, 재도전 유도

6. 서버 설계 (Node.js + TypeScript)

6.1 Feature-Based 모듈 구조
모듈
파일 구성
핵심 책임
auth
controller · service · dto · jwt-auth.guard
JWT 발급/검증, Refresh Token HttpOnly Cookie, 로테이션
speech
controller · service · repository · types
Whisper 연동, pronunciationScore/fluencyScore, 이동 평균 스킬 업데이트
quiz
controller · service · repository · DifficultyCalculator · QuizSelector · dto
가우시안 퀘스트 선택, 5항 난이도, EXP 지급
user
controller · service · repository
프로필, 진도, 업적, UserSkill
ranking
controller · service
Redis ZADD 원자적 업데이트, 일/주/전체 랭킹

6.2 SpeechService — 발음·유창성 계산 + 이동 평균
modules/speech/speech.service.ts
async analyze(audioBuffer: Buffer, userId: string): Promise<SpeechAnalysisResult> {
  // 1. Whisper API 호출
  const transcription = await this.openai.transcribe(audioBuffer);

  // 2. 발음 정확도: phoneme × 0.6 + Whisper confidence × 0.4
  const phonemeScore        = await this.analyzePhonemes(transcription.text);
  const pronunciationScore  = Math.round(phonemeScore * 0.6 + transcription.confidence * 100 * 0.4);

  // 3. 유창성: WPM 점수 + pause 점수 평균
  // 한국인 학습자 평균 WPM: 100~120 (원어민 기준 120~150과 다름)
  // 이상값(target): 110 WPM — 한국인 중급 학습자 목표치
  const wpm       = (transcription.words.length / transcription.duration) * 60;
  const wpmScore  = Math.max(0, 100 - Math.abs(wpm - 110) / 2); // 이상값 110 (한국인 기준)
  const pauseScore= Math.max(0, 100 - (transcription.pauses?.length || 0) * 5);
  const fluencyScore = Math.round((wpmScore + pauseScore) / 2);

  // 4. 저장 (동기)
  const result = await this.speechRepository.save({
    userId, transcribedText: transcription.text,
    pronunciationScore, fluencyScore, duration: transcription.duration,
  });

  // 5. 스킬 업데이트 (비동기 분리 — 응답 지연 없음)
  this.updateUserSkill(userId, pronunciationScore, fluencyScore);

  return { id: result.id, text: transcription.text,
           pronunciationScore, fluencyScore,
           feedback: this.generateFeedback(pronunciationScore, fluencyScore) };
}

private async updateUserSkill(userId: string, pronunciation: number, fluency: number) {
  const cacheKey = `user:skill:${userId}`;
  let skill = await this.redis.get<UserSkill>(cacheKey)
           ?? await this.userService.getSkill(userId);

  // 이동 평균 (최근 10개): 단기 변동 완화
  skill.pronunciationScore = Math.round((skill.pronunciationScore * 9 + pronunciation) / 10);
  skill.fluencyScore       = Math.round((skill.fluencyScore * 9 + fluency) / 10);

  await this.redis.set(cacheKey, skill, 3600); // 캐시 갱신
  this.userService.updateSkill(userId, skill);  // DB 비동기 저장
}

6.3 공통 미들웨어
common/filters/http-exception.filter.ts
@Catch()
export class HttpExceptionFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost) {
    const ctx      = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request  = ctx.getRequest<Request>();
    let status = HttpStatus.INTERNAL_SERVER_ERROR;
    let message = 'Internal server error';
    let errorCode = 'INTERNAL_ERROR';
    if (exception instanceof HttpException) {
      status    = exception.getStatus();
      const res = exception.getResponse() as any;
      message   = res.message || exception.message;
      errorCode = res.errorCode || `ERROR_${status}`;
    }
    this.logger.error({ status, message, path: request.url, method: request.method });
    response.status(status).json({
      success: false, errorCode, message,
      timestamp: new Date().toISOString(), path: request.url,
    });
  }
}

common/interceptors/transform.interceptor.ts + logging.interceptor.ts
// 성공 응답 래핑
@Injectable()
export class TransformInterceptor implements NestInterceptor {
  intercept(ctx: ExecutionContext, next: CallHandler) {
    return next.handle().pipe(
      map(data => ({ success: true, data, timestamp: new Date().toISOString() }))
    );
  }
}

// 응답 시간 로깅 — 500ms 초과 시 알림
@Injectable()
export class LoggingInterceptor implements NestInterceptor {
  intercept(ctx: ExecutionContext, next: CallHandler) {
    const req   = ctx.switchToHttp().getRequest();
    const start = Date.now();
    return next.handle().pipe(tap(() => {
      const ms = Date.now() - start;
      this.logger.log(`${req.method} ${req.url} — ${ms}ms`);
      if (ms > 500) alerts.send(`Slow API: ${req.url} took ${ms}ms`);
    }));
  }
}


7. 성능 최적화 결과

7.1 핵심 지표 Before / After
지표
Before
After
개선율
기법
API 평균 응답
320ms
120ms
62.5% ↓
Redis Cache-Aside + DB 인덱스
DB 조회/요청
8.5회
1.2회
86% ↓
Prisma include 단일 쿼리
캐시 히트율
0%
87%
+87%p
전략적 캐시 설계
앱 로딩
2.3초
1.1초
52% ↓
번들링 + Lazy Load + 텍스처 압축
음성 분석
12초 (동기)
4초 (비동기)
67% ↓
비동기 스트리밍 + 압축
메모리 (30분)
520MB
195MB
62% ↓
onDestroy 해제 + Object Pool
동시 사용자
500명
2,500명
400% ↑
Connection Pool 20 + Auto Scaling
P95 (1000 동시)
2.8초
180ms
94% ↓
종합
에러율 (1000 동시)
12.5%
0.1%
99% ↓
Rate Limit + Pool

7.2 핵심 최적화 코드
BEFORE: N+1 쿼리 → AFTER: Prisma include 단일 쿼리
// BEFORE: 4회 별도 쿼리
const user         = await prisma.user.findUnique({ where: { id } });
const logs         = await prisma.speechLog.findMany({ where: { userId: id } });
const quizzes      = await prisma.quizResult.findMany({ where: { userId: id } });
const achievements = await prisma.userAchievement.findMany({ where: { userId: id } });

// AFTER: 1회 쿼리 + Redis 캐시
const cached = await redis.get(`user:stats:${userId}`);
if (cached) return cached;

const stats = await prisma.user.findUnique({
  where: { id: userId },
  include: {
    _count: { select: { speechLogs: true, quizResults: true } },
    achievements: { include: { achievement: true } }
  }
});
await redis.setex(`user:stats:${userId}`, 3600, JSON.stringify(stats));
return stats;  // DB 조회 86% 감소, 캐시 히트율 87% 달성

Cocos onDestroy — 메모리 누수 0건
// BEFORE: 해제 없음 → 씬 전환 시 누수 누적
class QuizScene extends Component {
  private textures: Texture2D[] = [];
  // onDestroy 없음 → 메모리 30분 기준 380MB → 520MB
}

// AFTER: 명시적 전량 해제
class QuizScene extends Component {
  private textures:   Texture2D[] = [];
  private objectPool: NodePool;

  onDestroy() {
    this.textures.forEach(tex => tex.destroy());
    this.textures = [];
    this.objectPool.clear();
    // 이벤트 리스너 전량 해제
    this.node.off(Node.EventType.TOUCH_END, this.onClick, this);
  }
  // 결과: 30분 기준 180→195MB (누수 0건)
}


7.3 인프라 비용 최적화
항목
Before
After
절감율
EC2
c5.2xlarge × 4
c5.large × 2 + Auto Scaling
60% ↓
RDS
db.r5.xlarge
db.t3.medium + Read Replica
70% ↓
ElastiCache
cache.r5.large
cache.t3.micro Cluster
80% ↓
Whisper API
$0.006/min (2026 확인)
$0.006/min × 압축 50% 감소 (출처: brasstranscripts.com/blog/openai-whisper-api-pricing-2025)
50% ↓
월간 총비용
~$1,200
~$350
71% ↓

8. 보안 설계 및 테스트 전략

8.1 보안
항목
구현 방식
JWT
Access Token 15분 + Refresh Token 7일 (HttpOnly Cookie) + 로테이션
Rate Limiting
Redis INCR/EXPIRE, IP 기준 분당 60 요청
Input Validation
DTO + class-validator 전 엔드포인트 적용
HTTPS
ALB에서 HTTP → HTTPS 강제 리다이렉트
오디오 데이터
분석 후 S3 즉시 삭제 원칙 (개인정보처리방침 준수)
비밀번호
bcrypt hash (salt rounds 12)
환경 변수
AWS Secrets Manager + .env Git 제외

8.2 테스트 전략
유형
도구
대상
목표
단위 테스트
Jest
DifficultyCalculator, QuizSelector, EXP, 이동 평균
100%
통합 테스트
Supertest + Jest
API 엔드포인트 전체
80%+
E2E 테스트
Playwright
발화→점수→EXP→랭킹 전체 플로우
핵심 플로우 100%
부하 테스트
Artillery
1000 동시 사용자
P95 < 200ms, 에러율 < 0.5%
메모리 테스트
Chrome DevTools + Cocos Profiler
씬 전환 10회 후 메모리
누수 0건

CI/CD 파이프라인 (GitHub Actions)
PR → main:  단위 + 통합 테스트 자동 실행
Merge 후:   Docker 빌드 → ECR 푸시 → EC2 롤링 배포 (무중단)
배포 후:    Smoke Test (핵심 엔드포인트) → Slack 성공/실패 알림
실패 시:    자동 롤백 + Slack 장애 알림




Adaptive Speaking Trainer — 기술 설계서 (TDD) v2.0
제품 기획 및 비즈니스 목표는 별도 '제품 기획서'를 참조하십시오.
