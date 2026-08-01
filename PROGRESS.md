# PROGRESS — 회사↔집 인계 문서

## Last updated
2026-08-02 (Phase 0 완료 세션)

## Current goal
Phase 0.5 (Tauri 셸 + 구글 OAuth 딥링크 + 사용자 승인 + 백업/복원) — SOT §14, §8.7, §7.0

## Done this session
- **Phase 0 완료 (evaluator PASS, 12/12 항목)**:
  - `supabase/migrations/20260802000000_initial_schema.sql` — 테이블 25종(본 20 + 조인 5), RLS 전수, RPC 8종(is_approved/handle_new_user/approve_user/deactivate_user/create_year/delete_year/delete_stage/delete_project), Realtime 17테이블, app_settings 기본 행. dev DB에 push 완료.
  - `types/index.ts`(§5 인터페이스 전부), `lib/constants.ts`(부록 A/C, MAX_TASK_DEPTH)
  - `lib/db/` — client/mapper/schema(Zod)/errors + 리포지토리 16종 (클라이언트 첫 인자 주입 패턴, expectedVersion 낙관적 잠금)
  - `supabase/seed.sql`(부록 B.1 구조, 고정 UUID 멱등) + 테스트 48건 통과 (mapper 단위 17 + 통합 31: CRUD 전수·연쇄 삭제 H-4~H-8·낙관적 잠금·app_settings 보호)
  - `next-env.d.ts`, `types/css.d.ts` 추가로 tsc 에러 0

## In progress
없음

## Next steps
1. `/phase-run 0.5` — Tauri 셸(사이드카), 구글 OAuth 딥링크(wbs://), 첫 사용자 자동 승인/두 번째 승인 대기, 백업/복원(§8.7 — 무료 플랜의 유일한 안전망)
2. Phase 0.5 전에 Supabase 대시보드에서 Google OAuth provider 설정 필요할 수 있음 (redirect URL 등)

## Blockers
없음

## How to run
- 테스트: `npm test` (통합 테스트는 실제 dev DB 사용, 네트워크 필요) / 타입: `npx tsc --noEmit` / 개발 서버: `npm run dev`
- DB 마이그레이션: **supabase link 불가(CLI 로그인 없음)** — 직결 사용:
  `npx supabase db push --db-url "postgresql://postgres.oqdcvdmodnpxmosnuitz:<암호URL인코딩>@aws-1-ap-northeast-2.pooler.supabase.com:5432/postgres"`
  (암호는 루트 `데이터베이스 비밀번호(gitignore).txt`, 리전은 aws-1-ap-northeast-2 서울)
- 테스트 직결 SQL: `.env.test.local`의 TEST_DATABASE_URL (gitignore됨)
- Supabase URL·publishable key: `.env.local` (원본은 루트 URL_KEY.txt, gitignore됨)
