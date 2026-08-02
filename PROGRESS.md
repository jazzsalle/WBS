# PROGRESS — 회사↔집 인계 문서

## Last updated
2026-08-02 (Phase 0.5 코드 완료 세션)

## Current goal
Phase 0.5 수동 검증 마무리 → Phase 1 (계층 + WBS 트리 + 진척률 롤업)

## Done this session
- **Phase 0 완료** (evaluator PASS 12/12, 커밋 07fa94a)
- **Phase 0.5 코드 완료 (evaluator 조건부 PASS)** — 테스트 10파일 91건 전체 통과, tsc 0, build 성공:
  - Tauri v2 셸: 랜덤 포트 사이드카(node.exe 동봉), `wbs://` 딥링크 + single-instance, Windows 키체인, opener/fs/dialog 플러그인
  - 인증: PKCE auth 클라이언트, httpOnly 쿠키 세션, requireApprovedUser 가드, §7.0 미들웨어, /login·/pending·온보딩·사용자 승인 UI
  - RLS 검증: 미승인 세션 전 테이블 0행 통합 테스트 통과
  - 백업(§8.7): exportAll/importAll + restore_backup RPC(safeupdate fix 포함), 복원 왕복 테스트, BackupPanel UI, 자동 백업 7일/12개 보존, 스키마 버전 게이트(§8.8)
  - SOT §8.3 X-2 예외 목록 갱신 (deactivate_user·is_approved·restore_backup 추가)
- 로그인 방식 결정: **구글 OAuth 유지** (HR API는 표준 SSO 미지원 — 로그인 부적합). HR API(hr.unes.kr)는 Phase 2에서 직원 명부 가져오기로 활용 검토

## In progress
Phase 0.5 수동 검증 (아래 목록) — 완료 후 Phase 0.5 최종 종결 선언

## Next steps
1. **사용자 선행 작업**:
   - 구글 클라우드 콘솔(console.cloud.google.com — Developer Program 포털 아님!)에서 OAuth 클라이언트 생성 → Supabase 대시보드 Google provider + Redirect URLs(`wbs://auth-callback`, `http://localhost:3000/auth/callback`) 등록
   - Rust 툴체인 설치: `winget install Rustlang.Rustup` (검증 절차는 src-tauri/README.md)
2. **수동 검증 6건**: ① cargo check/tauri build ② 사이드카 실기동 ③ 실제 구글 로그인 + 딥링크 왕복 + 키체인 복원 ④ 첫/두 번째 사용자 승인 흐름 실화면 ⑤ 두 PC 동일 데이터 조회 ⑥ Tauri 자동 백업 실파일 동작
3. 수동 검증 통과 후 `/phase-run 1`

## Blockers
- 구글 OAuth 콘솔 설정 미완 (사용자 진행 중 — Developer Program 포털에서 헤맴, console.cloud.google.com으로 안내됨)
- Rust 툴체인 미설치 (cargo check 미수행 — Rust 컴파일 에러 가능성 잔존)

## How to run
- 테스트: `npm test` (통합은 실제 dev DB, 네트워크 필요) / 타입: `npx tsc --noEmit` / 개발 서버: `npm run dev` (브라우저 모드 로그인: http://localhost:3000)
- Tauri: `npm run tauri:dev` (Rust 설치 후) / 빌드: `npm run tauri:build`
- DB 마이그레이션: supabase link 불가(CLI 로그인 없음) — 직결:
  `npx supabase db push --db-url "postgresql://postgres.oqdcvdmodnpxmosnuitz:<암호URL인코딩>@aws-1-ap-northeast-2.pooler.supabase.com:5432/postgres"`
  (암호는 루트 `데이터베이스 비밀번호(gitignore).txt`, 리전 aws-1-ap-northeast-2 서울)
- 테스트 직결 SQL: `.env.test.local`의 TEST_DATABASE_URL / 앱 키: `.env.local` (+`ALLOWED_EMAIL_DOMAIN=unes.co.kr`)
- 테스트 중단 시 잔여물: `wbs-test+%` 패턴 사용자를 auth.users에서 직결 삭제
