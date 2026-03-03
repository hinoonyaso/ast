# AST Project State

## 기술 스택
- Client: Cocos Creator 3.8.2 + TypeScript 5.0 + Zustand 4.4
- Server: Node.js 20 LTS + Express 4.18 + Prisma 5.0
- Database: MySQL 8.0 (AWS RDS) + Redis 7.0 (ElastiCache)
- AI: OpenAI Whisper API (음성 인식)
- Infra: AWS EC2 (c5.large) + ALB + CloudFront

## 현재 진행 중인 작업
- [ ] 난이도 계산 알고리즘 (DifficultyCalculator) 5항 공식 튜닝
- [ ] 콤보 시스템 6단계 타이틀 애니메이션 연동
- [ ] Redis 캐시 전략 구현 (user:skill, leaderboard)

## 알려진 이슈
- 음성 분석 API 응답이 4초 이상 지연될 경우 클라이언트 타임아웃 발생
- Cocos 씬 전환 시 메모리 누수 가능성 (onDestroy 확인 필요)
- MySQL N+1 쿼리 발생 지점: /api/user/stats 엔드포인트

## 제약사항
- Whisper API 비용: $0.006/min (오디오 압축 필수, 5MB→500KB)
- EC2 인스턴스 메모리 4GB (메모리 누수 시 서버 다운)
- Cocos WebGL 빌드 크기 50MB 제한 (텍스처 압축 필수)
