# PROGRESS — 회사↔집 인계 문서

## Last updated
2026-08-02 (Phase 2 완료 세션)

## Current goal
Phase 3 (목표 관리: 성과목표·기술목표 CRUD, 실적·측정, 달성률) — SOT §6.2~6.3, §7.7

## Done this session
- **Phase 0 완료** (evaluator PASS 12/12, 커밋 07fa94a) — 스키마 25종+RLS+RPC, 리포지토리 16종, 테스트 48건
- **Phase 0.5 완료** (커밋 85df882→5154e67) — Tauri 셸+딥링크, 구글 OAuth 인증+승인 UI, 백업/복원. **실로그인 왕복 검증 완료** (브라우저·Tauri 양쪽)
- **Phase 1 완료** (evaluator 조건부 PASS, 테스트 232건) — 계층 + WBS:
  - 순수 함수: `lib/tree.ts`(WBS 코드·순환/깊이·날짜 롤업), `lib/progress.ts`(4단계 롤업), `lib/priority.ts`(긴급도·우선순위), `lib/dates.ts` — 부록 B.1(58 / 38.6667 / 59.1111)·B.0 수치 그대로 통과, P-8 중간 반올림 금지 회귀 테스트 포함
  - RPC 8종: `move_task`·`move_task_to_year`·`reorder_tasks`(순환 H-2·깊이 H-3·연차 H-1을 DB에서 차단), `create_project_with_defaults`(단계·연차·비목 12종 자동 생성)·`reorder_projects/stages/years`·`set_year_status`
  - 서버 액션 4종 + WBS 조회 모델(`getYearTree`/`getProjectFullTree`)
  - UI: 공통 프리미티브·`RealtimeRefresher`(R-1~R-7)·과제 목록/생성 → 과제 탭 10개·개요·단계연차 패널 → **WBS 트리 화면**(드래그·Tab/Shift+Tab·깊이 10 UI 차단·상세 패널)
  - O-3 충돌 처리: 상세 패널·인라인 이름 편집 모두 입력값 보존 + 항목별 비교/선택. 저장 payload 키 불변식은 **매핑 타입으로 컴파일 타임 강제**
- **Phase 2 완료** (evaluator PASS, 테스트 281건) — 인력 + 기관:
  - RPC 5종: `delete_member`(H-9 참조 8곳 정리 + 건수 반환), `count_member_references`, `set_lead_organization`(H-8 재지정 트랜잭션), `reorder_organizations`/`reorder_members`
  - `actions/team.ts` 액션 13종 + 조회 2종(getTeam, getTeamScreenData). H-8 삭제 차단·역할 강등 차단을 액션에서 수행
  - **소속 무결성**: createTask/updateTask/assignTaskMembers/bulkUpdateTasks가 남의 과제 인력·기관을 거부. 일괄 수정은 여러 과제 혼합 시 쓰기 전에 거부(부분 반영 방지)
  - UI: `/projects/[id]/team`(기관 카드·인력 기관별 그룹 테이블·PM 지정 경고·삭제 시 참조 8곳 건수·배정 작업 패널), WBS 트리 담당/기관 컬럼 + 필터, 상세 패널 담당자(단일+다중)·기관 편집(O-3 비교 대상 포함), 과제 개요 PM·주관기관 표시, 인력·기관 탭 활성화
- SOT 보강 4건: §8.3 X-2 definer 예외 목록, §6.1 P-9(예산 전부 0인 경우), 부록 A.3(과제·연차 상태 색상 + 색상 폴백), §6.6 H-8(주관 재지정 트랜잭션 규칙)
- **후속 정리 3건** (Phase 3 착수 전):
  - 파괴적 테스트 격리 — `tests/destructive/`로 분리(`npm run test:destructive`), 기본 `npm test`는 안전한 테스트만. 시작 전 실데이터 감지 가드가 테스트 소유가 아닌 행을 찾으면 시드조차 넣지 않고 거부한다
  - `createOrganization`: lead를 joint로 만든 뒤 `set_lead_organization`으로 승격 — 승격 RPC가 실패해도 lead가 2개로 남지 않는다 (H-8)
  - `updateProject`: `pmMemberId`·`leadOrgId`를 patch에서 제외(+`strict()`) — `setProjectPM`/`setLeadOrganization`의 가드를 우회할 수 없다

## In progress
없음

## Next steps
1. `/phase-run 3` — 성과목표·기술목표 CRUD, 실적/측정 기록, 달성률(§6.2 부록 B.2 57.333…, §6.3 direction 3종 × baseline 유무 전 분기)
2. 미뤄둔 것: HR API 연동(hr.unes.kr 직원 명부 — SOT 추가 후 별도 진행), 단일 과제 조회 액션(`getProject(id)`)
3. Phase 1 후속 개선(블로킹 아님): ① 인라인 이름 편집 중 Enter 연타 시 in-flight 재입력이 제출값으로 되돌아감 ② 자기 저장에 대한 가짜 STALE 배너(`disabled={saving}` 가드) ③ `bulkUpdateTasks` 부분 반영(트랜잭션 RPC화 검토)
4. 남은 관찰 항목(블로킹 아님): `tests/integration/wbs-queries.test.ts`는 팀 공유 설정 `app_settings.progress_weight_basis`를 잠시 바꿨다 되돌린다. 데이터를 지우지 않아 기본 실행에 두었지만, **두 PC에서 `npm test`를 동시에 돌리면** 서로의 임시값을 원본으로 착각해 설정이 어긋날 수 있다. 테스트는 한 번에 한 PC에서만 돌린다

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
- 테스트: `npm test` — 단위(`tests/unit`) + 통합(`tests/integration`). 통합은 실제 dev DB를 쓰고(네트워크 필요) **자기가 만든 데이터만** 지운다. 안전하게 아무 때나 돌려도 된다
- ⚠️ 파괴적 테스트: `npm run test:destructive` — `tests/destructive/`(§8.7 K-7 전체 대체 복원 검증)만 돌린다. **대상 25종 테이블의 전 행을 지웠다 백업 시점으로 되돌린다.** 사람이 명시적으로 부를 때만 실행되며, 시작 전 가드(`tests/destructive/guard.ts`)가 테스트 소유가 아닌 데이터(시드 고정 UUID·`wbs-test+%` 사용자 소유가 아닌 projects/todos/notes/import_profiles 행)를 발견하면 아무것도 건드리지 않고 거부한다
  - **실데이터를 입력하기 시작하면 이 명령을 dev DB에서 돌리지 않는다.** 백업 복원 로직을 고칠 때만 빈 전용 DB에서 실행한다
  - 중단된 테스트의 잔여물도 "남의 데이터"로 보고 거부한다 — 아래 잔여물 정리 후 다시 실행
- 타입: `npx tsc --noEmit` / 빌드: `npm run build`
- 개발 서버: `npm run dev` → http://localhost:3000 (로그인 후 /projects)
- Tauri: `npm run tauri:dev` (Rust 필요) / 빌드: `npm run tauri:build`
- DB 마이그레이션: supabase link 불가(CLI 로그인 없음) — 직결:
  `npx supabase db push --db-url "postgresql://postgres.oqdcvdmodnpxmosnuitz:<암호URL인코딩>@aws-1-ap-northeast-2.pooler.supabase.com:5432/postgres"`
  (암호는 루트 `데이터베이스 비밀번호(gitignore).txt`, 리전 aws-1-ap-northeast-2 서울. 다른 마이그레이션이 먼저 적용돼 있으면 `--include-all` 필요)
- 테스트 직결 SQL: `.env.test.local`의 TEST_DATABASE_URL / 앱 키: `.env.local` (+`ALLOWED_EMAIL_DOMAIN=unes.co.kr`)
- 테스트 중단 시 잔여물: `wbs-test+%` 패턴 사용자를 auth.users에서 직결 삭제 + 남은 테스트 과제(`created_by is null`) 삭제
- 집 PC 첫 세팅: git pull → npm install → `winget install Rustlang.Rustup` + VS BuildTools → **`.env.local`·`.env.test.local`은 gitignore라 저장소에 없다 — 회사 PC에서 복사해 올 것**
