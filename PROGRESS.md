# PROGRESS — 회사↔집 인계 문서

## Last updated
2026-08-02 (하네스 구성 세션)

## Current goal
Phase 0 (기반: Supabase 스키마+RLS+리포지토리) 착수 준비 완료 상태 만들기

## Done this session
- SOT v3.3 확정 (설계 최종 리뷰 반영) — 커밋 571e036
- 하네스 구성: planner/generator/evaluator 에이전트, /phase-run, /handoff, /resume-work, evaluation_criteria.md, PROGRESS.md, SessionStart hook
- 스캐폴드 준비됨(미커밋): package.json(Next 15/React 19/Tailwind 4/Vitest/supabase CLI), app/ 뼈대, supabase/config.toml, .env.local(Supabase dev URL·publishable key)

## In progress
없음

## Next steps
1. Claude Code 세션 재시작 (subagent·스킬 로드)
2. `/phase-run 0` — Supabase 스키마+RLS 마이그레이션, 타입·Zod, 리포지토리 16종, 매퍼, 시드 CRUD 테스트
3. Phase 0 중 `npx supabase link --project-ref oqdcvdmodnpxmosnuitz` 필요 (DB 비밀번호는 루트의 gitignore된 파일)

## Blockers
없음

## How to run
- 테스트: `npm test` / 타입: `npx tsc --noEmit` / 개발 서버: `npm run dev`
- DB 마이그레이션: `npm run db:push` (link 이후)
- Supabase URL·publishable key: `.env.local` (원본은 루트 URL_KEY.txt, gitignore됨)
