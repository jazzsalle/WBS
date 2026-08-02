# PROGRESS — 회사↔집 인계 문서

## Last updated
2026-08-02 (Phase 1 완료 세션)

## Current goal
Phase 2 (인력 + 기관: 기관·인력 CRUD, Task 담당자 배정) — SOT §5.10~5.11, §7.10

## Done this session
- **Phase 0 완료** (evaluator PASS 12/12, 커밋 07fa94a) — 스키마 25종+RLS+RPC, 리포지토리 16종, 테스트 48건
- **Phase 0.5 완료** (커밋 85df882→5154e67) — Tauri 셸+딥링크, 구글 OAuth 인증+승인 UI, 백업/복원. **실로그인 왕복 검증 완료** (브라우저·Tauri 양쪽)
- **Phase 1 완료** (evaluator 조건부 PASS, 테스트 232건) — 계층 + WBS:
  - 순수 함수: `lib/tree.ts`(WBS 코드·순환/깊이·날짜 롤업), `lib/progress.ts`(4단계 롤업), `lib/priority.ts`(긴급도·우선순위), `lib/dates.ts` — 부록 B.1(58 / 38.6667 / 59.1111)·B.0 수치 그대로 통과, P-8 중간 반올림 금지 회귀 테스트 포함
  - RPC 8종: `move_task`·`move_task_to_year`·`reorder_tasks`(순환 H-2·깊이 H-3·연차 H-1을 DB에서 차단), `create_project_with_defaults`(단계·연차·비목 12종 자동 생성)·`reorder_projects/stages/years`·`set_year_status`
  - 서버 액션 4종 + WBS 조회 모델(`getYearTree`/`getProjectFullTree`)
  - UI: 공통 프리미티브·`RealtimeRefresher`(R-1~R-7)·과제 목록/생성 → 과제 탭 10개·개요·단계연차 패널 → **WBS 트리 화면**(드래그·Tab/Shift+Tab·깊이 10 UI 차단·상세 패널)
  - O-3 충돌 처리: 상세 패널·인라인 이름 편집 모두 입력값 보존 + 항목별 비교/선택. 저장 payload 키 불변식은 **매핑 타입으로 컴파일 타임 강제**
- SOT 보강 3건: §8.3 X-2 definer 예외 목록, §6.1 P-9(예산 전부 0인 경우), 부록 A.3(과제·연차 상태 색상 + 색상 폴백)

## In progress
없음

## Next steps
1. `/phase-run 2` — 기관·인력 CRUD, 주관기관 삭제 차단(H-8), Member 삭제 시 참조 8곳 정리(H-9), Task 담당자 배정 → WBS 트리 표시
2. Phase 2에서 함께 검토할 것:
   - **HR API 연동 검토** — hr.unes.kr `/api/external/users`로 직원 명부 가져오기 (JWT/API 키, 필드: user_id·email·name·division·team·position·role·is_active). 가이드: https://hr.unes.kr/api/external/guide?t=e00b76d7e911539b3a2ea4fcfa4525f9
   - 단일 과제 조회 액션(`getProject(id)`) 추가 — 현재 과제 탭 공통 헤더에 과제명을 못 띄운다
3. Phase 1 후속 개선(블로킹 아님, evaluator 기록): ① 인라인 이름 편집 중 Enter 연타 시 in-flight 재입력이 제출값으로 되돌아감 ② 같은 이유로 자기 저장에 대한 가짜 STALE 배너(`disabled={saving}` 가드로 해소) ③ `bulkUpdateTasks` 부분 반영 가능성(트랜잭션 RPC화 검토)

## 수동 검증 (누적)
### 완료
- 구글 OAuth 콘솔 + Supabase provider, 브라우저 실로그인(첫 사용자 자동 승인), Tauri 실로그인 전체 왕복(시스템 브라우저→딥링크→키체인→홈), cargo check, 백업 내보내기 실동작
- 검증 중 수정한 결함 2건: opener URL 허용 목록 부재, Windows 자격 증명 관리자 2560바이트 제한(키체인 청크 분할)

### 대기
- Phase 1: ① 두 세션 동시 수정 시 STALE 비교 UI·입력 보존 ② 드래그 이동·Tab/Shift+Tab·깊이 10 초과 거절 문구 ③ 편집 중 R-4 배너 동작
- 공통: 두 PC 동일 데이터 조회, 동료 첫 로그인 시 /pending→승인 흐름(두 번째 회사 계정 필요), Tauri 자동 백업 7일 경과 실동작

## Blockers
없음

## How to run
- 테스트: `npm test` (통합은 실제 dev DB, 네트워크 필요) / 타입: `npx tsc --noEmit` / 빌드: `npm run build`
- 개발 서버: `npm run dev` → http://localhost:3000 (로그인 후 /projects)
- Tauri: `npm run tauri:dev` (Rust 필요) / 빌드: `npm run tauri:build`
- DB 마이그레이션: supabase link 불가(CLI 로그인 없음) — 직결:
  `npx supabase db push --db-url "postgresql://postgres.oqdcvdmodnpxmosnuitz:<암호URL인코딩>@aws-1-ap-northeast-2.pooler.supabase.com:5432/postgres"`
  (암호는 루트 `데이터베이스 비밀번호(gitignore).txt`, 리전 aws-1-ap-northeast-2 서울. 다른 마이그레이션이 먼저 적용돼 있으면 `--include-all` 필요)
- 테스트 직결 SQL: `.env.test.local`의 TEST_DATABASE_URL / 앱 키: `.env.local` (+`ALLOWED_EMAIL_DOMAIN=unes.co.kr`)
- 테스트 중단 시 잔여물: `wbs-test+%` 패턴 사용자를 auth.users에서 직결 삭제
- 집 PC 첫 세팅: git pull → npm install → `winget install Rustlang.Rustup` + VS BuildTools → **`.env.local`·`.env.test.local`은 gitignore라 저장소에 없다 — 회사 PC에서 복사해 올 것**
