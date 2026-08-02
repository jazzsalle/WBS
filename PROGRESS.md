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
없음 — Phase 0.5 검증 대부분 완료 (아래 잔여 3건은 자연 검증으로 남김)

## 수동 검증 결과 (2026-08-02)
- ✅ 구글 콘솔 OAuth + Supabase provider 설정 (`google: true` 확인)
- ✅ 실제 구글 로그인 성공 (브라우저 모드) — 첫 사용자 자동 승인(sangraedo@unes.co.kr, active=true), lastSeenAt 갱신
- ✅ 홈·/settings·사용자 관리·백업 패널 화면 확인 (크롬 원격 검증)
- ✅ 내보내기 실동작 — BackupFile 형식(4키·25테이블)·UTF-8 정상
- ✅ Rust 툴체인 설치(winget: Rustup + VS BuildTools) → `cargo check` 에러 0
- ✅ `npm run tauri:dev` 실기동 — 사이드카 기동, WebView가 /login 로드
- ✅ `wbs://` 딥링크 전 구간 — 앱 도달 → 교환 시도 → 실패 명시 표시(/login?error=callback) + 세션 정리
- ⏳ 잔여(자연 검증): ① Tauri 안에서 실제 구글 로그인 전체 왕복(시스템 브라우저→딥링크→키체인) ② 두 PC 동일 데이터 ③ 동료 첫 로그인 시 /pending→승인 흐름 (두 번째 회사 계정이 현재 없음)

## Next steps
1. `/phase-run 1` — 계층 CRUD + WBS 트리 + 4단계 진척률 롤업 + 우선순위 (§6.1, §6.6~6.9, §7.4)
2. Phase 1 검증 중 Tauri 실로그인 왕복도 겸사 확인 권장
3. 집 PC 첫 세팅 시: git pull → npm install → `winget install Rustlang.Rustup` + VS BuildTools → .env.local 복사(다른 PC에서 가져오기 — gitignore라 저장소에 없음!)

## Blockers
없음

## How to run
- 테스트: `npm test` (통합은 실제 dev DB, 네트워크 필요) / 타입: `npx tsc --noEmit` / 개발 서버: `npm run dev` (브라우저 모드 로그인: http://localhost:3000)
- Tauri: `npm run tauri:dev` (Rust 설치 후) / 빌드: `npm run tauri:build`
- DB 마이그레이션: supabase link 불가(CLI 로그인 없음) — 직결:
  `npx supabase db push --db-url "postgresql://postgres.oqdcvdmodnpxmosnuitz:<암호URL인코딩>@aws-1-ap-northeast-2.pooler.supabase.com:5432/postgres"`
  (암호는 루트 `데이터베이스 비밀번호(gitignore).txt`, 리전 aws-1-ap-northeast-2 서울)
- 테스트 직결 SQL: `.env.test.local`의 TEST_DATABASE_URL / 앱 키: `.env.local` (+`ALLOWED_EMAIL_DOMAIN=unes.co.kr`)
- 테스트 중단 시 잔여물: `wbs-test+%` 패턴 사용자를 auth.users에서 직결 삭제
