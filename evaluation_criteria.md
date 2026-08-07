# Phase별 합격 기준 (evaluator 채점표)

evaluator는 이 체크리스트로 PASS/FAIL을 판정한다. 모든 항목은 실행·확인 가능해야 하며, 근거 명세는 `docs/SOT.md`다. 공통 전제: **모든 Phase에서 `npx tsc --noEmit` 에러 0, `npm test` 전체 통과, service_role 키가 앱 코드·클라이언트 번들에 없음.**

## Phase 0 — 기반 (스키마 + 리포지토리)

- [ ] `supabase/migrations/`에 전체 스키마 마이그레이션 존재, `npx supabase db push` 성공
- [ ] SOT §5.1 테이블 전부 생성 (본 테이블 + 조인 5종 + `import_snapshots`), 컬럼은 `sort_order`·`version`·`created_by`/`updated_by` 포함 (N-4, N-9)
- [ ] **모든 테이블 RLS 활성** — `pg_class.relrowsecurity` 전수 true, 정책은 `is_approved()` + `to authenticated` (RLS-1)
- [ ] `app_users` 부트스트랩 트리거(`handle_new_user`, security definer + advisory lock) + `approve_user` RPC 존재 (A-3, RLS-2)
- [ ] FK 삭제 정책이 N-8 표와 일치 (실적·회의록 set null), `delete_year`가 `target_by_year` 키 제거 수행 (N-13)
- [ ] `budget_items unique(year_id, category)`, 연차 생성 시 비목 12종 자동 생성 on conflict do nothing (§5.12)
- [ ] `app_settings` 단일 행 강제 + 기본 행 삽입(schema_version=1) + INSERT/DELETE 불가 (N-10)
- [ ] Realtime publication에 §8.5 구독표 테이블 추가됨 (R-7)
- [ ] `types/index.ts` — SOT §5 인터페이스 전부, `lib/constants.ts` — 부록 A 라벨 전부(A.4 포함)·부록 C 사전·`MAX_TASK_DEPTH`
- [ ] `lib/db/` — client/mapper/schema(Zod)/errors + 리포지토리 16종(app-users 포함)
- [ ] mapper 왕복(스네이크↔카멜) 단위 테스트, 시드(부록 B.1 구조) 기반 리포지토리 CRUD 통합 테스트 통과 — 연쇄 삭제(H-4~H-8)·`version` 낙관적 잠금 충돌 케이스 포함

## Phase 0.5 — 셸 + 인증 + 백업

- [ ] Tauri 셸에서 Next standalone 사이드카 기동 (랜덤 포트)
- [ ] 구글 OAuth 시스템 브라우저 + `wbs://` 딥링크 로그인 성공 (A-1), 서버 측 도메인 재검증 (A-2, `ALLOWED_EMAIL_DOMAIN`)
- [ ] 첫 사용자 자동 승인, 두 번째 사용자 승인 대기 → `/pending` → 승인 후 진입 (§7.0)
- [ ] 미승인 세션은 anon 키로 데이터 0행 (RLS 검증)
- [ ] 전체 내보내기 JSON이 §8.7 형식과 일치, 복원 왕복 테스트 통과 (K-7, K-8)
- [ ] 두 PC(또는 두 브라우저 세션)에서 같은 데이터 조회 확인

## Phase 1 — 계층 + WBS

- [ ] 과제/단계/연차 CRUD + `createProject` 자동 Stage·Year 생성 (§9)
- [ ] WBS 트리 화면: 생성·이동(드래그, Tab/Shift+Tab)·삭제, 깊이 10 초과 거부 (H-3, DB·UI 양쪽)
- [ ] `lib/tree.ts`·`lib/progress.ts` 단위 테스트 — **부록 B.1 수치 그대로 통과** (모델개발 58, 2차년도 38.67, 1단계 59.11)
- [ ] 날짜 롤업 (P-14~16) 테스트 통과
- [ ] `lib/priority.ts` — 부록 B.0 수치 그대로 통과 (긴급도 자동 계산 포함)
- [ ] 순환 부모 지정 시도 시 DB가 거부 (X-4)
- [ ] 낙관적 잠금: 두 세션 동시 수정 시 StaleDataError UI 표시 (O-3)

## Phase 2 — 인력 + 기관

- [ ] 기관·인력 CRUD, 주관기관 삭제 차단 (H-8), Member 삭제 시 참조 8곳 정리 (H-9)
- [ ] Task 담당자 배정(owner + 다중) → WBS 트리에 표시

## Phase 3 — 목표 관리

- [ ] 성과목표·기술목표 CRUD + 실적/측정 기록 (조인 테이블 포함)
- [ ] `lib/goals.ts` 단위 테스트 — **부록 B.2 57.333…(중간 반올림 금지), B.3 수치 그대로 통과**
- [ ] §6.3 전 분기 테스트: direction 3종 × baseline null/유무 (T-1 클램프, T-2 N/A 포함)
- [ ] D-1~D-5, T-3 경고 배지 동작

## Phase 4 — 마일스톤 + 대시보드

- [ ] 마일스톤 CRUD + 연차 기본 마일스톤 자동 생성 옵션 (§7.8)
- [ ] 마감 판정(`lib/dates.ts`) 테스트 — §6.5 표 전 케이스, 기준 타임존 Asia/Seoul
- [ ] 대시보드 §7.2 구성 요소 전부 렌더 + 아카이브 제외

## Phase 5 — 연구비

- [ ] 비목 매트릭스 (12행 × 연차), 예산 인라인 편집 (현금/현물 분리, §7.9)
- [ ] 집행 수동 등록/삭제, `lib/budget.ts` 테스트 — **부록 B.4 수치 그대로 통과**
- [ ] B-1~B-4 규칙 (예산 외 집행 경고, 100% 초과 빨강, 원 단위 정수)

## Phase 5.5 — 엑셀 임포트

- [ ] `lib/import/` 순수 함수 + 단위 테스트 — **부록 B.5 시나리오 그대로 통과** (S-2 리셋, S-6 결합, S-8 합산, 축 라벨, #REF! 오류 차단)
- [ ] 5단계 마법사: 실제 보유 샘플 2종(`samples/`)의 총괄표 시트가 **미매핑 0건**으로 미리보기까지 도달
- [ ] `commitImport` fileHash 대조, `import_snapshots` 기록, 단일 트랜잭션 롤백 (I-17, I-18)
- [ ] 프로파일 저장·재사용 (ministry 프리셋 적용)

## Phase 6 — 리스크 + 노트

- [ ] 리스크 매트릭스·대장 (`lib/risk.ts` 등급 테스트: 경계값 8, 15)
- [ ] 마크다운 노트 + 회의록 템플릿 + Task/Milestone 연결 역참조

## Phase 7 — 간트 + 칸반

- [ ] 간트: 연차 밴드, 마일스톤 레인, 오늘선, 막대 드래그/리사이즈 (§7.5)
- [ ] 칸반 ↔ 매트릭스 뷰 전환, 드래그로 status·중요도 변경 (PR-8, PR-9 준수)

## Phase 8 — To-Do + 설정 + 마감

- [ ] To-Do, 설정 화면(§7.14: 팀 설정 + 사용자 관리 + 백업), 인쇄 레이아웃 3종 (§12)
- [ ] §12 비기능 기준 샘플 검증: 5,000 노드 롤업 100ms 이내
- [ ] `npm run build` 성공 + Tauri 번들 생성

## Phase 9 — 예산 제안 모드 (SOT v4.0)

**스키마·타입**
- [ ] `budget_details` 테이블 + **RLS 활성**(`is_approved()` + `to authenticated`, RLS-1) + N-4 공통 컬럼(`version`·`created_by`/`updated_by`·`sort_order`) + `year_id` cascade
- [ ] `members.annual_salary`·`members.hire_type`, `projects.allowance_rate_limit`·`projects.indirect_rate_limit` 추가 (§5.11, §5.3)
- [ ] Realtime publication에 `budget_details` 추가 (R-7, §8.5 구독표)
- [ ] `budget_details.member_id`가 **`on delete restrict`**, `year_id`·`project_id`는 cascade (PL-D8, H-9a)
- [ ] `types/index.ts`에 `BudgetDetail`(`amount` 포함)·`DetailAxis`·`DetailFormula`·`DetailFactor`·`HireType` (§5.17). **`DetailAxis`는 `lib/constants.ts`의 기존 `BudgetAxis`와 별개 타입**이어야 한다 — 이름을 재사용하면 임포트 파이프라인의 `'unassigned'`가 섞인다
- [ ] `lib/constants.ts`에 `SUBCATEGORY_PRESETS` — 부록 A.5의 세목 33종 전부, 비목별 `formula`·`defaultFactors` 포함. 부록 A.4 라벨(`HireType`·`DetailAxis`·`DetailFormula`) 추가

**순수 함수 — 여기가 틀리면 나머지가 전부 틀린다**
- [ ] `lib/budget-plan.ts` 단위 테스트가 **부록 B.7 수치를 그대로 통과**: 인건비 19행 개별 금액, 셀 합계 현금 `180,840,000` / 현물 `88,650,000` / 계 `269,490,000`, 연구활동비 `27,020,000`, 총액 `298,510,000`
- [ ] **PL-2 회귀 테스트 존재** — 월액(`연봉/12`)을 먼저 반올림하면 박선욱이 `15,540,001`이 됨을 **명시적으로 배제**하는 케이스. (§6.1 P-8·§6.2 D-5와 같은 형태의 테스트)
- [ ] PL-4: 조정액을 **더한 뒤** 반올림. PL-8: 합계는 **반올림된 행 금액**을 더한다 (실수 합계를 나중에 반올림하지 않음)
- [ ] PL-3: `factors` 0개(= `unitPrice + adjustment`)·1개·3개 전부 테스트. `isPercent` 분기 포함
- [ ] PL-5: 최종 금액이 음수인 행을 **0으로 자르지 않고** 오류로 표시. 조정액만 음수인 행은 오류가 아님 (부록 B.7의 7행)
- [ ] PL-11~PL-13: 수정인건비 E1(= `personnel` + `student_personnel`, 연구지원인력 제외), 연구수당 비율, 간접비 비율 = `indirect / 직접비 현금 기준액`. **기준액에서 `international`·`consignment`·`burden` 제외**. 부록 B.7의 `0.9622%`를 소수 4자리까지 통과
- [ ] E1 = 0일 때 0으로 나누지 않고 비율 없음(`—`) 처리 (PL-12)
- [ ] `lib/budget.ts`와 **합치지 않았다** — `lib/budget-plan.ts`가 별도 파일 (§6.10.4)

**RPC·액션 — PL-10 불변식이 핵심**
- [ ] `upsert_budget_detail`·`delete_budget_detail`·`reorder_budget_details` RPC가 **같은 트랜잭션 안에서** `budget_items`의 `planned_amount`/`cash_amount`/`in_kind_amount`를 재계산해 갱신 (PL-10)
- [ ] **PL-10a — RPC에 금액 산식이 없다.** RPC는 `sum(amount)`를 축별로 더하기만 한다. PL/pgSQL에 `annual_salary * rate / 100 * months / 12` 류의 산식이 있으면 **FAIL**. `amount`는 서버 액션이 `lib/budget-plan.ts`로 계산해 넘긴 값이다 (PL-D7 — 클라이언트가 보낸 `amount`는 무시하고 다시 계산)
- [ ] **PL-10b** — `updateMember`가 연봉을 바꾸면 그 인력의 인건비 행 `amount`와 관련 `budget_items`를 같은 트랜잭션에서 재계산. `previewSalaryChange`가 영향 건수·전후 금액을 저장 없이 돌려주고, 인력 화면이 확인을 받은 뒤 저장한다 (§7.10)
- [ ] **H-9a** — 인건비 산출근거가 걸린 Member는 `deleteMember`가 거부. `count_member_references`가 산출근거를 **별도 항목**으로 센다. `setMemberActive(false)`는 그대로 성공
- [ ] **PL-10 불변식 통합 테스트**: 행 추가·수정·삭제 각각 후에 `budget_items`를 재조회해 합계와 일치. 액션이 두 번 왕복하는 구현이면 FAIL. **연봉 변경 후에도 같은 불변식이 유지**되는지 포함 (PL-10b)
- [ ] `actions/budget-plan.ts` 5종 + 조회 2종(`getBudgetPlanData`·`getBudgetDetails`), 반환은 `ActionResult<T>`, supabase 직접 호출 없음(`lib/db/` 경유)
- [ ] **과제 경계 검증**(FK가 못 막는 부분): `yearId`·`memberId`가 남의 과제면 RULE 거부. PL-D2~PL-D5 전부 — `formula`/`category` 조합(PL-D3), 프리셋에 없는 `subcategory`(PL-D4), 음수 `unitPrice`/`factor.value`(PL-D5)
- [ ] PL-9: `updateBudgetPlan`이 `detailCount > 0`인 셀을 거부
- [ ] O-1: `updateBudgetDetail`이 `expectedVersion`을 받고 STALE을 반환 (§8.4)
- [ ] `reorderBudgetDetails`가 **그 세목의 전체 id 배열**을 받는다 (T-D10과 같은 이유)

**기존 코드와의 접점 — 빠뜨리면 조용히 깨진다**
- [ ] §8.7 백업/복원 대상 테이블에 `budget_details` 포함 (누락 시 백업에 산출근거가 빠진다). 복원 왕복 테스트 통과
- [ ] `tests/destructive/guard.ts` 대상 테이블 확장
- [ ] **S-14**: `commit_import`가 `detailCount > 0`인 (연차, 비목)을 덮어쓰지 않는다. 미리보기가 `잠김` 상태로 표시하고 상단 요약에 `잠김 N건`을 **`건너뜀`과 별도로** 센다. 잠김은 반영 버튼을 막지 않는다
- [ ] `create_project_with_defaults`는 변경 없음 (산출근거 자동 생성 안 함)
- [ ] §6.4 집행률·§7.2 대시보드·§6.8 임포트 기존 테스트 **전부 통과** (`plannedAmount` 소유권 변경의 영향권)

**화면**
- [ ] `/projects/[id]/budget`에 `[제안 | 수행]` 토글, 기본 `수행`. 탭은 늘어나지 않음 (§7.9)
- [ ] 제안 모드: 셀 클릭 → **산출근거 패널**(§7.9.2). 세목 섹션, `personnel`/`quantity` 컬럼 분기, 금액 열 **읽기 전용**, 세목 소계 → 셀 합계(현금/현물/계)
- [ ] 인건비 행의 직위·연봉은 Member에서 읽어 회색 표시(여기서 편집 불가). 연봉 미입력 Member 선택 시 경고 + 인력 화면 링크. **같은 인력의 중복 행 허용**
- [ ] 잠긴 셀에 자물쇠 표시 + 인라인 편집 차단. 마지막 행 삭제 시 잠금 해제되고 **직전 합계가 남는다**(0으로 되돌리지 않음, PL-9)
- [ ] 하단 지침 검증 줄: 연구수당·간접비 비율, 한도 초과 시 경고 배지. 한도가 null이면 비율만 표시하고 배지 없음 (PL-15)
- [ ] 인력 화면이 `hireType='new'`를 **채용예정** 배지로 구분, 연봉 입력 필드 존재. **참여율(%) 필드는 없다** (§5.11 — 참여율은 산출근거가 갖는다)
- [ ] 연봉 변경 시 영향 건수·전후 금액 확인 대화상자(PL-10b). 영향 0건이면 확인 없이 저장
- [ ] 인력 삭제 대화상자가 산출근거 건수를 **별도 줄**로 세고, 1건 이상이면 삭제 버튼을 막고 `[연구비로 이동]`을 준다 (H-9a)
- [ ] 설정 또는 과제 개요에서 한도 2종 입력 가능 (`setBudgetRateLimits`)
- [ ] 인쇄(§12 P-R1 연구비 가로)는 현재 모드를 따른다
- [ ] O-3 충돌 다이얼로그가 산출근거 행 편집에서 **입력값을 보존**한 채 항목별 비교
