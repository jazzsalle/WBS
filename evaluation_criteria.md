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

## Phase 10 — 산출근거 시트 임포트 (SOT v4.1)

**파싱 — 여기가 틀리면 나머지가 전부 틀린다**
- [ ] `lib/import/detail-sheet.ts` — **SheetJS를 import하지 않는다**(I-13, `RawSheet` 경계). 단위 테스트 필수
- [ ] **D-1** 섹션 감지: `1. 직접비 소요명세`·`2. 간접비 소요명세` 2개. **섹션 밖(실측 1~59행 총괄표·요약)은 전부 무시** — 여기서 금액을 읽으면 이중 계상이다. 섹션이 없으면 명시적 거부
- [ ] **D-2** 비목 감지 + **섹션 문맥 우선**: 간접비 섹션의 `가./나./다.`가 비목이 아니라 `indirect`의 세목으로 잡히는가. **`다.`가 직접비에서는 `연구시설·장비비`, 간접비에서는 `성과활용지원비`임을 구분하는 테스트가 있는가** (없으면 FAIL — 접두어만 보면 반드시 틀린다)
- [ ] **D-3** 세목: 번호와 라벨을 **둘 다** 본다. `⑪ 그 밖의 비용`/`⑪ 기타`, `⑦ 연구실 운영비(삭감)` 변형 통과. 부록 C.2 `SUBCATEGORY_ALIASES` 존재. **`⑤ 출장비` 한 번호에 국내/국외 두 표**가 오는 경우 처리(C.2 주의 2)
- [ ] **D-4** 컬럼 헤더 감지(힌트 어휘 3개 이상) + **2행 병합 헤더**(`산출내역` 아래 `단가|회|월`) 결합. S-11 병합 확장 재사용
- [ ] **D-5** 소계에서 **멈추지 않는다** — 인건비 3단(`합계`→`합계`→`소 계`)을 넘어 다음 비목·세목·섹션까지 읽는가. **첫 소계에서 멈추면 신규채용 34,000,000을 놓친다**는 회귀 테스트
- [ ] **D-6** 컬럼 헤더 범위 밖 메모 열(실측 N~P: `서울역↔실증지`·`KTX 금액`) 무시
- [ ] **D-7** 컬럼을 **위치가 아니라 헤더 텍스트로** 매핑. 산자부/행안부 인건비 열 위치가 다른데 둘 다 통과하는가
- [ ] **D-21** 금액 0 행: 근거 필드가 전부 비면 버리고, 이름·단가가 있으면 **건너뜀 제안으로 남긴다**(조용히 버리지 않음)

**변환·매칭**
- [ ] **D-8 조정액 흡수** — 파일의 `합계` 열이 최종 금액이 되도록 `adjustment = 파일 합계 − 산식 결과`. 부록 B.7.1의 조정액 열이 그대로 재현되는가(지동민 −270,000 등). 차액이 0이 아니면 미리보기에 **표시**한다
- [ ] **D-8a** — 인건비 산식 기준 연봉이 **명부(`Member.annualSalary`)**인가. 파일 연봉으로 역산하면 저장값과 재계산값이 어긋난다. **파일 연봉 ≠ 명부 연봉인 단위 테스트**가 있고, 저장 후 `computeDetailAmount`로 재계산해도 같은 금액이 나오는가(실측 샘플은 두 값이 같아 이 분기가 안 드러난다). 명부 연봉이 null이면 "연봉 미입력" 경고를 함께 띄우는가
- [ ] **D-9** 축: 현금·현물 열이 둘 다 있으면 **행을 둘로 나눈다**. 합계만 있으면 현금 **제안**(자동 확정 아님)
- [ ] **D-10** 원화 아닌 통화 기호(실측 행안부 `합계($)`) 감지 → 확인 없이는 그 세목 반영 안 됨
- [ ] **D-11~D-13** 성명 → Member 자동 제안 + 미매칭 3선택(기존 선택 / **새 인력 생성** / 건너뛰기). 동명이인 자동 매칭 금지
- [ ] **D-12** 새 Member는 **반영 트랜잭션에서만** 만든다. 미리보기가 인력 명부를 건드리면 FAIL
- [ ] **D-14** 파일 연봉 ≠ 명부 연봉이면 경고만. **임포트가 `members.annual_salary`를 고치면 FAIL**(PL-10b 우회)

**반영**
- [ ] **D-15** 기존 산출근거가 있는 셀은 **기본 건너뜀** + 셀별 `[기존 삭제 후 교체]` 선택. 조용히 덮으면 FAIL
- [ ] **D-16** 단일 트랜잭션. `budget_items` 총액은 **PL-10이 재계산**한다 — 임포트가 총액을 직접 쓰면 FAIL
- [ ] **D-15a** 미리보기 이후 커밋 전에 셀에 행이 생기면 **건너뛰고 건수를 반환**(전체 롤백 아님). 결과에 `건너뜀(반영 중 추가됨) N셀`을 별도로 세는가
- [ ] **D-17** `import_snapshots`에 스냅샷. **삭제되는 `budget_details` 행 전체**를 담는가(계획액만 담으면 D-15 교체를 되돌릴 수 없다). `details` 키는 비어 있어도 **항상 존재**
- [ ] **D-17a** `details` 키가 있는 스냅샷의 복원이 **그 셀의 현재 행을 지우고** 되살리는가(I-17의 명시적 예외 — 안 지우면 금액이 두 배가 된다). `budget_items` 행 자체는 여전히 지우지 않는다. **`details` 키가 없는 기존 스냅샷의 복원 동작이 한 글자도 안 바뀌었는가**(회귀)
- [ ] **D-18** 세목 소계·비목 합계를 파일 값과 대조해 경고. 반영은 막지 않는다
- [ ] **D-19** 시트 하나 = 연차 하나. 시트명 `N차년도`는 **제안만**
- [ ] **D-20** 프로파일을 저장하지 않는다. `ImportKind`에 `'budget_detail'` 추가
- [ ] **PL-10a 유지** — `commit_detail_import` RPC에 금액 산식이 없다. `amount`는 서버 액션이 `lib/budget-plan.ts`로 계산해 넘긴다
- [ ] `previewDetailImport`와 `commitDetailImport`가 **같은 파이프라인**을 쓰고 `fileHash`를 대조하는가

**화면 (§7.9.3)**
- [ ] 제안 모드 툴바에만 **[산출근거 가져오기]**. 수행 모드에는 없다
- [ ] 4단계: 파일·연차 / 시트·구조(트리 + 컬럼 매핑 수정) / 성명 매핑 / 미리보기·반영
- [ ] 총괄표를 넣으면 §7.9.1로 안내하고 거부
- [ ] 미리보기가 D-8 조정액 흡수·D-18 소계 불일치·D-15 셀 충돌·새로 만들 인력 수를 전부 드러내는가
- [ ] 반영 전까지 저장되는 것이 없다(새 인력 포함). 모달을 닫으면 상태 폐기

**검증 (부록 B.8)**
- [ ] `tests/unit/import-detail-sheet.ts` — 부록 B.8.1 블록 감지·B.8.2 행 수와 금액 통과
- [ ] 통합: 실측 `1차년도_250520`을 임포트하면 `budget_items`가 **현금 180,840,000 / 현물 88,650,000 / 계 269,490,000**, 활동비 **27,020,000**
- [ ] **B.7 ↔ B.8 등가**: 손으로 넣은 결과와 임포트한 결과가 같은 `budget_items`에 도달하는가
- [ ] 회귀: §6.8 총괄표 임포트·§6.10 산출근거 편집·§6.4 집행률 기존 테스트 **전부 통과**

## Phase 11 — 제출 서식 엑셀 내보내기 (SOT v4.2)

**템플릿·좌표 맵**
- [ ] `templates/산출근거_표준.xlsx`가 커밋돼 있고 **실데이터가 없다** (X-2): 수식 아닌 숫자 셀 0, 수식 셀의 캐시 계산값 0. 검증을 **테스트로 고정**했는가 — 템플릿을 갈아 끼울 때 다시 확인돼야 한다
- [ ] **셀 좌표 맵이 코드가 아니라 데이터다** (X-3). 부처가 늘면 템플릿 파일 + 맵을 추가하는 것으로 끝나고 파서·화면 코드가 바뀌지 않는가
- [ ] 맵이 **템플릿과 어긋나면 즉시 드러나는가** — 맵이 가리키는 셀이 템플릿에 없거나 병합 안쪽이면 조용히 쓰지 말고 실패해야 한다

**값 쓰기**
- [ ] **X-4 행 단위 금액 셀은 값으로 덮어쓴다.** 서식의 행 금액 수식에는 원본 과제의 조정액이 상수로 박혀 있어(실측 7개) 그 줄에 다른 인력을 쓰면 금액이 조용히 어긋난다. 수식을 지우지 않고 값만 쓰면 **FAIL**
- [ ] **X-4a 블록 소계·총계 수식은 살린다.** 소계·합계·비율 셀에 값을 박으면 **FAIL** — 거기가 검산이 사는 자리다
- [ ] **X-4b 템플릿에서 조정상수를 떼어냈는가.** 미사용 슬롯에 남으면 그대로 오염된다
- [ ] **X-4a 검산**: 내보낸 파일에 **살아남은 수식을 계산한 값이 앱의 값과 일치**하는가. 인건비 현금 **180,840,000** / 현물 **88,650,000**, 활동비 **27,020,000**, 총액 **298,510,000**. (SheetJS는 재계산하지 않으므로 수식을 직접 파싱해 계산한다 — 모르는 함수를 만나면 건너뛰지 말고 실패시켜야 검산이 유지된다)
- [ ] **X-5 넘치면 자르지 않는다.** 템플릿의 빈 줄보다 데이터 행이 많으면 **행을 삽입하거나 명시적으로 거부**한다. 조용히 잘리면 **FAIL**. 실측 인건비 19행이 이 경우인지 확인하고, 그 경로가 테스트로 고정됐는가
- [ ] **X-5a 근거를 적을 열이 없는 경우도 알리는가.** X-5가 세로(행 수)라면 이건 가로(열)다. 금액은 맞으므로 막지 않지만 조용하면 안 된다. **인자 개수만 세면 인자가 0개인 행이 판정을 빠져나간다** — 실측 `나. 연구지원비` 표에는 단가 열조차 없어 단가 2,000,000원이 소리 없이 사라졌다. `unitPrice`가 있는데 단가 열이 없는 경우를 **따로** 세는가
- [ ] **X-6** 금액은 원 단위 정수 그대로 (표시 단위 환산 금지)
- [ ] **X-7** 참여율이 백분율 서식 셀에 맞춰 **100으로 나눠** 쓰이는가. D-22의 반대 방향이며 **양방향 왕복 테스트**가 있는가 (`10.0` → `0.1` → 다시 읽으면 `10.0`)
- [ ] **X-8** 값이 없는 세목·비목도 서식의 자리를 남긴다 (행 삭제 금지)

**범위·안전**
- [ ] **X-9** 한 번에 한 연차. **X-10** 산출근거 + 총괄표가 한 파일
- [ ] **X-10a~X-10e 총괄표의 연차 열은 전부 값으로 쓴다.** 그 셀들은 총괄표 안의 SUM이 아니라 `산출근거!G21` 같은 **시트 간 참조**인데 산출근거에는 내보내는 연차 하나만 들어간다 — 수식을 살려 두면 2차년도 값이 1차년도 칸에 찍힌다. 집계·비율 행도 마찬가지다(X-10c). 앱에 데이터가 없는 괄호 메모 행(통합관리비·연구실 안전관리비)과 라벨/수식이 어긋나는 행(24·25)은 **지어내지 말고 비운 뒤 알린다**(X-10b·X-10d). 비율 행의 합계 열은 연차별 비율의 합이 되므로 비운다(X-10e)
- [ ] **템플릿 생성 절차가 저장소에 있는가** — 산출물만 커밋하고 만드는 법이 없으면 부처가 늘 때 손작업을 기억에 의존해 반복하게 된다. `samples/`가 gitignore라 CI에 걸 수는 없지만 스크립트는 남긴다
- [ ] **X-11 읽기 전용** — 내보내기가 DB를 한 행도 바꾸지 않는가(스냅샷도 안 남긴다). 통합 테스트로 전후 행 수 비교
- [ ] **X-12** 파일명에 과제명·연차·생성일. 파일명 금지 문자 치환
- [ ] `lib/export/`가 **SheetJS를 import하지 않는다**(`lib/import/`와 같은 경계). 워크북 조작은 어댑터만
- [ ] 파싱·생성은 **서버에서만**(I-13). SheetJS가 클라이언트 번들에 없다

**화면 (§7.9.4)**
- [ ] **제안 모드 툴바에만** [제출 서식 내보내기]. 수행 모드에 없다
- [ ] 연차 선택 → xlsx 다운로드. 템플릿이 하나면 묻지 않는다
- [ ] 내보내기 전 확인: 반영 행 수·합계 금액·**넘치는 세목**(X-5). 넘치면 **무엇이 몇 행 넘쳤는지** 밝히고 거부
- [ ] 경고(PL-5 음수·D-8a 연봉 미입력·PL-12/13 한도 초과)를 **알리되 막지 않는다**(PL-15와 같은 태도)

**완료 기준 — 왕복**
- [ ] ⭐ 내보낸 파일을 **§6.11 임포트에 다시 넣으면 같은 `budget_details`에 도달**하는가. B.7↔B.8 등가와 같은 방식으로 고정했는가
- [ ] 회귀: §6.11 임포트·§6.10 산출근거 편집·§6.8 총괄표 임포트·§6.4 집행률 기존 테스트 **전부 통과**

## Phase 12 — 사내 인사 명부 연동 (SOT v4.3)

> 이 Phase는 **타이핑을 줄이는 것이 전부다** (§6.13, §11). 자동 동기화·명부 복제·재직 상태 반영·연봉 채움 중 하나라도 들어 있으면 범위 초과로 **FAIL**.

**순수 함수 `lib/hr.ts` (fetch 없음)**
- [ ] `lib/hr.ts`가 `fetch`·`server-only`·supabase를 import하지 않는다. 네트워크는 서버 액션의 몫이다 (§6.13.5)
- [ ] **HR-16 `parseHrUsers`**: `success !== true`이거나 `users`가 배열이 아니면 실패로 다룬다(예외 또는 명시적 실패값 — 빈 배열 반환이면 **FAIL**). 필드가 빠지거나 타입이 다른 항목은 **버리지 않고** `malformed[]`에 사유와 함께 남긴다. `count !== users.length`가 결과에 드러난다
- [ ] **HR-4 `toMemberDraft`**: 결과 키가 정확히 `name`·`position`·`email` 3개다. `annualSalary`·`hireType`·`field`·`phone`·`orgId`·`role`·`active`가 어떤 경로로도 채워지지 않는다 (테스트로 키 집합 고정)
- [ ] **HR-8·HR-9 `markSelectable`**: 같은 이메일(대소문자·공백 정규화 후)의 Member가 있으면 `이미 등록됨`, 이메일이 빈 문자열/공백이면 `이메일 없음`, 두 경우 모두 선택 불가. `user_is_active === false`는 `퇴사` 표시만 하고 **선택 가능**이다 (HR-5)
- [ ] **HR-14 `formatHrError`**: 401/403/429/500/503 각각 사람 말로 옮기고, 본문의 `code`와 `message`가 있으면 **둘 다** 문장에 포함된다. 403은 "허용 IP가 아님" 가능성을 언급한다
- [ ] 위 4 함수 전부 단위 테스트가 있다. HR-1의 8개 필드 정상 케이스 + 결손·타입 오류·count 불일치·중복 이메일·빈 이메일·퇴사자 케이스

**서버 액션 (`actions/team.ts` 2종, §9)**
- [ ] `fetchHrDirectory(apiKey, projectId)`: 서버에서 `GET https://hr.unes.kr/api/external/users`를 호출한다. 키는 **인자로만** 받고 어디에도 저장하지 않으며 **로그·에러 메시지·반환값에 키가 실리지 않는다** (grep으로 확인: `console.*apiKey`, 에러 문자열에 키 보간 없음)
- [ ] HR 호출 실패(네트워크·비2xx·검증 실패)는 `ActionResult` 실패로 돌려주고 **빈 목록 폴백이 없다** (HR-14, 절대 규칙 5). **429에서 재시도하지 않는다** (HR-15 — 재시도 루프·`retry` 코드가 있으면 FAIL)
- [ ] `이미 등록됨` 판정을 **서버가** 이 과제의 기존 Member를 읽어 수행한다 (§9 근거 — 화면이 두 목록을 맞추지 않는다)
- [ ] `createMembersFromHr(projectId, drafts)`: 각 draft를 Zod로 검증하고(`name`·`position`·`email`만 허용, `strict()`), 리포지토리 경유로 Member를 생성한다. 같은 이메일의 Member가 이미 있으면 그 항목을 거부한다(HR-8 — 모달을 연 뒤 다른 사용자가 추가한 경우). `active`는 기본값 true, `annualSalary`·`orgId` 등은 null/미설정
- [ ] 응답을 앱 DB에 저장하거나 캐시하지 않는다 (HR-17). `hr_` 접두 테이블·마이그레이션이 없다
- [ ] 자동 실행 경로가 없다 — cron·interval·useEffect 자동 호출·백그라운드 폴링 없음 (HR-7)

**API 키 보관 (§7.14, HR-10~HR-12)**
- [ ] 키는 `lib/tauri/keychain.ts`를 통해 OS 키체인에만 저장된다. `localStorage`·`sessionStorage`·cookie·앱 DB·`.env`·`app_settings`에 키가 들어가지 않는다 (grep)
- [ ] Tauri가 아니면 `not-tauri`를 화면이 밝히고("이 창에서만 유지됩니다") 그 세션의 메모리 값으로만 동작한다. 조용히 못 쓰는 상태가 아니다
- [ ] 설정 화면: `password` 입력, 저장 후 **끝 4자리만** 표시하고 값을 다시 읽어 입력칸에 채우지 않는다. `[연결 확인]`이 HR을 한 번 호출해 성공/실패와 인원 수를 보여 준다. `[키 삭제]`가 키체인에서 지운다
- [ ] 화면에 두 문장이 있다: ① 발급 방법 `hr.unes.kr 로그인 → 🔑 API 키 → 용도 입력 → 이메일 인증` + 키는 발급 화면에서 한 번만 보인다 ② 키는 백업 파일에 들어가지 않으므로 PC마다 등록해야 한다
- [ ] §8.7 백업 내보내기에 키가 포함되지 않는다 (백업 코드가 키체인을 읽지 않음)
- [ ] 키가 브라우저에서 HR로 직접 전송되지 않는다 — 클라이언트 코드에 `hr.unes.kr` fetch가 없다 (HR-13)

**인력 화면 (§7.10.1)**
- [ ] `[사내 명부에서 추가]` 버튼이 `[인력 추가]` 옆에 있고 **수동 입력 경로가 그대로 남아 있다**
- [ ] 키가 없어도 버튼이 보이고, 누르면 "설정에서 HR API 키를 등록하세요" + `/settings` 링크
- [ ] 목록 컬럼: 이름·직위·본부·팀·이메일. 이름·이메일 부분 검색. 본부·팀은 저장되지 않는다 (HR-6 — `createMembersFromHr` 입력에 division/team이 없다)
- [ ] 선택 불가 행(`이미 등록됨`·`이메일 없음`·`읽을 수 없음`)이 사유와 함께 회색으로 남고 체크박스가 비활성이다. 목록에서 제거하면 **FAIL**
- [ ] `퇴사` 배지는 선택을 막지 않는다
- [ ] 다중 선택 → `[N명 추가]`. 추가 후 화면에 `N명을 추가했습니다. 연봉은 사내 명부에 없어 비어 있습니다 — 인건비 산출근거를 쓰려면 채워야 합니다`가 남는다 (HR-2). 이 문장이 없으면 **FAIL**
- [ ] `count`와 행 수가 다르면 목록 상단에 표시된다 (HR-16)
- [ ] 모달을 닫으면 명부 상태가 버려진다 (HR-17) — 재오픈 시 다시 호출
- [ ] 생성된 Member가 `Member.active`를 HR의 `user_is_active`로 결정하지 않는다 (HR-5)

**회귀·위생**
- [ ] `npm test` 전체 통과, `npx tsc --noEmit` 통과, `npm run build` 통과
- [ ] 스키마 변경 없음 (`supabase/migrations/`에 새 파일 없음 — HR-6·HR-9·HR-17이 필드 추가를 금지한다)
- [ ] 절대 규칙 3: UI·액션이 supabase를 직접 호출하지 않는다 (리포지토리 경유)

## Phase 13 — 연구비 사용 규칙 (SOT v4.4)

> 규칙은 **데이터**이고 판정은 **경고**다. 저장·반영·내보내기를 막는 코드가 하나라도 있으면 **FAIL**(RL-1). 출처(조문) 없는 한도값이 코드에 있으면 **FAIL**(PL-16·RL-D5).

**스키마·이관**
- [ ] `budget_rules` 테이블 + RLS 정책이 같은 마이그레이션에 있다. `(project_id, code)` 유일 제약, `project_id on delete cascade`, `version` 컬럼
- [ ] `projects.allowance_rate_limit`·`indirect_rate_limit`가 **행으로 이관된 뒤 삭제**된다. 값이 있던 과제는 `allowance_max`·`indirect_max` 행이 생기고(`base='direct_cash_excl_intl_consign_burden'`, source 명시), null이던 과제는 행이 없다. 이관을 **통합 테스트로 고정**했는가(마이그레이션 전 값 → 후 행)
- [ ] `schema_version` 2 → 3, `EXPECTED_SCHEMA_VERSION` 갱신, `BACKUP_TABLES`에 `budget_rules` 포함. 구 백업(버전 2) 복원 시 K-5 게이트 메시지가 맞는가
- [ ] RL-D2·D3·D5가 **DB check 제약 + Zod** 양쪽에 있다: 값 필요 코드의 null, 값 불필요 코드의 non-null, `base`의 코드 제한, 빈 `source`

**순수 함수 `lib/rules.ts`**
- [ ] fetch·supabase·next 무의존. `lib/budget-plan.ts`의 집계를 **입력으로 받고** 금액 산식·E1을 다시 구현하지 않는다(grep: `annualSalary`·`unitPrice` 곱셈이 rules.ts에 없다)
- [ ] **RL-3 수정직접비**: 직접비 **전 비목**(promotion·other 포함) 현금 합에서 `base`별 제외. `promotion`이나 `other`에 현금이 있는 케이스에서 Phase 9 분모와 달라지는 것을 테스트로 고정. 두 `base`가 위탁이 있는 연차에서 다른 비율을 내는 테스트
- [ ] **부록 B.9.1 수치 그대로**: 0.9622% / 0.00% / 69.2308% / 11.35%, `allowance_min` info 1건. value 67·`ownBudget` 90,000,000 변형에서 error
- [ ] **B.9.2**: A 행 1건(RL-14), C 행 1건(RL-16), RL-15 통과 → B 참여율 30%에서 위반. E1 = 44,500,000 불변
- [ ] **B.9.3**: 35,000,000 장비 warn / 같은 품명 12,000,000+9,000,000 **합산** warn / 29,990,000 외주 통과(경계 미만). `≥` 경계값 정확히(30,000,000은 대상)
- [ ] **B.9.4 `skipped`**: 분모 0·필드 null이 `findings`가 아니라 `skipped`에 사유와 함께 남는다. 조용히 빠지면 **FAIL**
- [ ] 비율 비교에 **중간 반올림이 없다**(69.2308을 69.23으로 자른 뒤 비교하는 코드 없음). 표시는 소수 4자리
- [ ] `enabled=false` 행은 판정하지 않고 `ratios`에는 남는다(비율은 보여 준다)
- [ ] RL-16 같은 Member의 행 여럿을 **합산**해 판정한다. `student_personnel`은 제외
- [ ] `approximate`가 RL-7·RL-9에서 true

**프리셋 `lib/rules-presets.ts`**
- [ ] 부록 D.1·D.2와 **값·출처가 1:1**. 프리셋 값마다 `source`가 타입으로 강제된다(빈 문자열 불가). 부록 D 표 → 상수 대조 테스트
- [ ] `gov_share_max`가 두 후보(75/67)를 제안하고 기본은 75
- [ ] `applyRulePreset`의 `fill`은 기존 행을 건드리지 않고, `overwrite`는 전부 프리셋 값으로. 단일 트랜잭션(RPC). 결과 건수(추가/갱신/유지) 반환. 과제 경계 검증

**액션·조회**
- [ ] `listBudgetRules`·`upsertBudgetRule`·`deleteBudgetRule`·`applyRulePreset` — 리포지토리 경유, O-1 `expectedVersion`
- [ ] `setBudgetRateLimits`가 **삭제**됐고 참조가 없다
- [ ] `getBudgetPlanData`가 `RuleEvaluation`을 싣는다. 판정을 저장하지 않는다(DB에 findings 컬럼 없음)

**화면**
- [ ] §7.9 규칙 검증 패널: 비율 표(규칙 꺼져도 표시) · findings(severity 순, 클릭 시 셀/행 이동) · skipped 접힌 목록 · "근사" 표식. 규칙 0건이면 안내 + [연구비 규칙]
- [ ] §7.9.5 편집 패널: 프리셋 [채우기]/[덮어쓰기](2단계 확인 + 결과 건수), 규칙 표 인라인 편집(O-3), `gov_share_max` 셀렉트+자유 입력, 안내 목록(D.3) 읽기 전용, 행 삭제 확인 문구
- [ ] 수행 모드에 두 패널이 없다. Phase 9 `RateLimitBadges`의 한도 입력이 제거됐다
- [ ] Phase 11 내보내기 전 확인의 경고에 규칙 findings가 포함되고 **막지 않는다**

**회귀·위생**
- [ ] `npm test`·`tsc`·`build` 통과. Phase 9~11 기존 테스트(B.7 0.9622%·B.8·왕복) 전부 통과
- [ ] 절대 규칙 2·3. 파생 값(findings) 미저장

## Phase 14 — 도움말 + 따라하기 (SOT v4.6)

> 스키마 변경 없음. 도움말은 SOT의 번역(HP-3)이고 예제 과제는 기존 경로로만 만든다(TU-3). 이 둘을 어기면 **FAIL**.

**도움말 (§7.16)**
- [ ] `content/help/` 17편(화면 15 + `calculations` + `faq`), 각 파일 첫 줄 `# 제목`·둘째 줄 `> 언제 쓰나:` (HP-6). 빠진 slug가 있으면 FAIL
- [ ] 렌더가 `lib/notes.ts` `parseMarkdown` → `MarkdownViewer`다. `dangerouslySetInnerHTML`·외부 마크다운 라이브러리 0건 (grep)
- [ ] 도움말 수치가 SOT와 일치한다 — 샘플 대조: 연구수당 20%(제26조①)·간접비 영리 10%·진척률 4단계 가중·집행률 B-1~B-3·마감 판정 Asia/Seoul. 출처가 붙어 있다
- [ ] `next.config.ts` `outputFileTracingIncludes`에 `./content/**`. standalone 빌드 산출물에 `content/help`가 있는지 확인(`.next/standalone` 검사 또는 테스트)
- [ ] `HelpLink`가 대시보드·과제 목록·과제 헤더(탭별 slug)·To-Do·설정에 있고 `/help#<slug>`로 간다. `print:hidden`
- [ ] `/help` 좌측 목차·해시 이동·강조. 인증 뒤에만
- [ ] 도움말 파일 존재·첫 줄 규칙·slug 목록 일치를 **단위 테스트**로 고정

**따라하기 (§7.17)**
- [ ] `LocalConfig.tutorial`이 Zod `.catch` 기본값으로 읽힌다 — 구 설정 파일(키 없음)로 단위 테스트
- [ ] `getTutorialStatus`가 TU-4 7단계를 **데이터로** 판정한다 — 통합 테스트: 빈 과제 → 전부 false, 데이터를 하나씩 넣을 때마다 그 단계만 true, ⑦은 산출근거와 규칙 둘 다 있어야 true, 과제 삭제 → 과제 없음
- [ ] `createSampleProject`가 TU-3 내용을 **기존 액션·리포지토리 경로**로 만든다(새 RPC·supabase 직접 호출 0건). 만든 과제로 `getTutorialStatus` ①~⑦ 전부 true. 이름 `[예제] ` 접두·설명 첫 줄. 통합 테스트 + 정리
- [ ] 부분 실패 시 만든 과제 id와 함께 실패 반환(조용히 성공 처리 금지) — 중간 단계를 실패시키는 테스트
- [ ] `sampleProjectId`가 살아 있으면 다시 만들지 않는다
- [ ] 삭제는 기존 `deleteProject` 경로만. 드로어에 별도 삭제 액션 없음
- [ ] 드로어: 9단계·할 일·버튼 위치·`[이 화면으로]`·완료 표시·현재 화면 단계 자동 펼침·과제 선택·"다시 보지 않기"(설정에서 복귀). 수동 체크는 ⑧⑨만
- [ ] 튜토리얼 상태를 DB에 쓰지 않는다 (마이그레이션 없음, `app_settings` 변경 없음)
- [ ] 과제 목록 카드에 `예제` 배지

**회귀·위생**
- [ ] `npm test`·`tsc`·`build` 통과. 디자인 토큰 테스트 통과(옛 팔레트 0건)
- [ ] 절대 규칙 3(리포지토리 경유), 5(실패를 삼키지 않음)

## Phase 15 — 성능 (SOT v4.7 §12)

- [ ] `requireSession`이 React `cache()`로 요청 범위 메모된다. 한 페이지 렌더에서 Auth 검증(`auth.getUser`)이 **1회** — 통합 테스트로 호출 횟수 고정(요청 컨텍스트 밖에서는 메모하지 않는 것도 확인)
- [ ] `loading.tsx`가 `/`·`/projects`·`/projects/[id]`(탭 공통)·`/todos`·`/settings`·`/help`에 있고 스켈레톤이 숫자를 지어내지 않는다(회색 블록만)
- [ ] 과제 탭 전환 시 헤더·탭이 유지된 채 본문만 스켈레톤이다
- [ ] `npm test`·`tsc`·`build` 통과

## Phase 16 — 조직원 · 인건비 · 참여율 (SOT v4.7)

> 급여 변경은 **자동 반영되지 않는다**(SL-5). 자동으로 과제 인건비를 다시 계산하는 경로가 있으면 **FAIL**. 산식은 PL-1 그대로다 — 새 산식을 만들면 FAIL.

**스키마 (schema_version 4)**
- [ ] `staff`(email 유일·소문자 정규화 ST-1), `staff_salaries`((staff_id, effective_from) 유일, `basis` enum, `amount` 정수 ≥ 0, 플래그 2종), `members` 4컬럼(`staff_id` FK set null, 스냅샷 3종). RLS 같은 마이그레이션. `restore_backup`·`BACKUP_TABLES` 갱신, `EXPECTED_SCHEMA_VERSION` 4
- [ ] 조직원 삭제 → 급여 이력 cascade, Member `staff_id` null·연봉·스냅샷 유지(ST-2) — 통합 테스트

**순수 함수**
- [ ] `lib/salary.ts`: SL-1(`monthly` × 12, `annual` 그대로), 월급 표시만 반올림, SL-2 기준일 이하 최신 이력(경계일 포함·없으면 null). 단위 테스트
- [ ] `lib/participation.ts`: PS-1(연결 안 된 행 별도 집계·student 제외) · PS-2(참여율 × 개월 / 12, 같은 Member 합산) · PS-3(연차 시작 연도 배정·startDate 없으면 "연도 미정") · PS-4(100 초과 error·90 초과 warn·원값 비교). 두 과제 60%·12개월 + 50%·12개월 → 110 error 테스트

**액션·화면**
- [ ] `/staff` 목록(현재 급여 SL-2·기준 배지·연결 과제 수)·상세(급여 이력 CRUD, O-1)·참여율 탭(연도별 매트릭스, 상단 안내 3종)·`[사내 명부에서 추가]`(§6.13 함수 재사용, 이름·직위·이메일만)·삭제 2단계
- [ ] §7.10 인력 행 `조직원` 열·`[연결]`(이메일 자동 제안)·`[급여 반영]` → `previewSalaryChange` 확인 → `annualSalary` + 스냅샷 3필드. 이력 없으면 안내. 연봉 칸 기준 배지
- [ ] §7.9.6 [인건비] 탭: 조직원·월급·연봉·참여율·개월·축·금액(서버 값)·기준·적용 이력, 인라인 편집(참여율·개월·축·조정액 — `updateBudgetDetail`), [급여 반영], E1, 다른 과제 합계 참고(PS-6)
- [ ] `applyStaffSalary`가 기존 PL-10b 경로(`applySalaryChange` RPC)를 탄다 — 통합 테스트: 월급 3,000,000 퇴직금 포함 → 반영 후 `annualSalary` 36,000,000·`salaryIncludesRetirement` true·산출근거 재계산
- [ ] 이메일 유일 위반·이력 없음·연결 안 된 인력 [급여 반영] → 명시적 실패(절대 규칙 5)
- [ ] 부록 E 팔레트만. `npm test`·`tsc`·`build` 통과

## Phase 17 — 사업비 입력 양식 (SOT v4.7 §6.16, §7.9.7)

> 우리 양식이다 — 헤더 추측 없이 **고정 좌표**(IN-1). 미리보기와 반영이 다른 파싱 경로를 타면 FAIL(IN-6). 반영을 막는 경고가 있으면 FAIL(PL-15·RL-1).

**순수 함수 `lib/input-form/`**
- [ ] `layout.ts` 좌표 맵이 데이터다 — 시트 이름·헤더 행·열 순서·시작 행. 생성기와 파서가 **같은 맵**을 import(grep). SheetJS import 0건(어댑터만, IN-8)
- [ ] `_meta`(IN-2): formVersion·projectId·yearId·세목 코드 목록·memberId 목록·생성 시각. 없음/과제 불일치/버전 불일치 → 명시적 거부(테스트 3종)
- [ ] 인건비 시트(IN-3): memberId(숨김 열)로 잇고 이름 매칭 없음(grep: D-11류 함수 미사용). 참여율 0~100·개월 0~12(연차 개월 초과 경고)·축 현금/현물. **금액 열은 읽지 않는다** — 값을 바꿔 올려도 서버 계산값(PL-1)이 쓰인다는 테스트
- [ ] 사업비 시트(IN-4): 세목 코드로 잇고 빈 행 무시, 단가·조정액 정수, 인자 소수 허용, 모르는 세목은 "알 수 없는 세목"으로 남김(조용히 버리지 않음)
- [ ] 생성기 인건비 금액 열이 **엑셀 수식** `=ROUND(연봉×참여율/100×개월/12,0)`(IN-7 — 월액 먼저 반올림 금지). 연봉 없는 인력은 빈 칸 + 비고
- [ ] 부록 B.7 1차년도로 생성 → 파싱하면 같은 산출근거(왕복 등가 — B.7↔B.8 방식). 수식 검산: 74,000,000×28%×9/12 = 15,540,000

**액션·화면**
- [ ] `buildInputForm(projectId, yearId)` xlsx(어댑터, server-only). 기존 산출근거·인력·연봉·기준 배지가 채워져 있다
- [ ] `previewInputForm`·`commitInputForm`이 **같은 파싱 함수**, `fileHash` 대조(IN-6). 반영은 연차 단위 교체 + `import_snapshots` 스냅샷(IN-5). 미리보기가 추가/변경/삭제 건수·합계·규칙 findings를 보여 준다
- [ ] 제안 모드 툴바 `[입력 양식 내려받기]`(연차 선택)·`[입력 양식 올리기]`(파일 → 미리보기 → 반영). 수행 모드에 없음
- [ ] 경고(규칙 findings·연차 개월 초과·연봉 없음)는 막지 않는다
- [ ] `npm test`·`tsc`·`build`, 부록 E 팔레트, 절대 규칙 3·5

## Phase 18 — 다크 모드 (SOT v4.7 §7.19, 부록 E.5)

- [ ] `app/globals.css`에 `[data-theme="dark"]`(및 `prefers-color-scheme: dark`에서 `:root:not([data-theme="light"])`)가 부록 E.5의 8스케일 × 10단계 + 시맨틱(screen·surface·surface-grey·hairline·dimmed)을 재정의한다. `white`·`black`은 바뀌지 않는다. 값이 E.5 표와 1:1 — `design-tokens.test.ts` 확장으로 고정
- [ ] `@media print`는 항상 밝은 팔레트(다크 변수 무효화)
- [ ] 카드·패널 배경 `bg-white`가 `bg-surface`로 치환됐다 — `components/app/lib`에 `bg-white` 0건(정적 검사). `text-white`(버튼 글자)·`border-white`는 그대로
- [ ] `LocalConfig.theme: 'system'|'light'|'dark'`(Zod `.catch('system')`), 설정 §7.14 "개인 설정 — 화면 모드" 라디오 → 즉시 적용
- [ ] `<html data-theme>`를 마운트 전에 세팅하는 인라인 스크립트(브라우저 localStorage의 LocalConfig 키를 읽는다; Tauri는 AppBootstrap이 config 파일을 읽은 뒤 세팅 — 깜빡임 허용 범위를 주석으로). system이면 속성 없음
- [ ] 다크에서 대비가 깨지는 곳 없음 — 배지(연한 배경 + 진한 글자 쌍)·ErrorBanner·모달 dimmed·인쇄 토큰. 수동 확인 목록에 화면별 항목
- [ ] `npm test`·`tsc`·`build` 통과. §13 9번(다크 모드) 해소 표기


## Phase 19 — 우리 양식 서식 (SOT v4.8 부록 F, §6.16 IN-8, §7.9.7 서식)

- [ ] `exceljs`가 dependencies에 있고 **`lib/input-form-adapter.ts`(server-only)에서만** import된다. SheetJS는 읽기(`readUploadedWorkbook`)에 그대로 남는다. `lib/input-form/`은 `exceljs`·`xlsx`를 import하지 않는다(정적 검사 grep 0건)
- [ ] `lib/xlsx-style.ts`: 부록 F 팔레트·글꼴·테두리·헤더/키 열/합계 행 스타일·작성안내 시트 헬퍼가 상수로 있고, 어댑터만 import한다. `samples/exel style.xlsx`의 규칙(F-1~F-5)과 값이 일치한다
- [ ] 내려받은 양식: 첫 시트 `작성안내`(F-8: 제목 20pt·부제·2열 안내 표, 모드별 "금액 열은 읽지 않는다" 문장), 데이터 시트 헤더 검정 채움·흰 굵은 글자·아래 medium 테두리, 표시 전용(`read: false`) 보이는 열 베이지 채움, 모든 데이터 셀 thin 테두리, 틀 고정 + 자동 필터, 열 너비(F-7), 숨김 열·숨김 `_meta` 시트 유지
- [ ] 숫자 서식: 금액 `#,##0`, 참여율·인자는 일반 숫자(백분율 서식 0건 — 통합 테스트로 고정), 수식 셀은 캐시값 없이 `f`만(IN-7 유지)
- [ ] 사업비 시트에 세목 소계·비목 소계·총액 **수식 행**(F-4 스타일). 파서는 이 행을 IN-4 빈 행 규칙으로 건너뛴다 — 왕복 테스트(내려받기 → 파싱)에서 소계 행이 데이터로 잡히지 않는다
- [ ] **Phase 17 왕복 테스트가 그대로 통과한다** — 좌표 맵·파서 불변. 새 어댑터로 만든 파일을 `readUploadedWorkbook`으로 읽어 `parseInputForm`이 같은 결과를 낸다(통합 테스트)
- [ ] 생성된 xlsx를 openpyxl 또는 exceljs로 다시 열어 스타일을 검증하는 테스트(헤더 채움 색·글꼴 이름·틀 고정·자동 필터·숨김 시트)
- [ ] `npm test`·`tsc`·`build` 통과. 클라이언트 번들에 `exceljs`가 들어가지 않는다(`server-only`)

## Phase 20 — 수행 양식 (SOT v4.8 §5.12, §6.16 IN-9~IN-14, §7.9.7 수행 모드, §9 Budget Input Form, §13 12-a)

> **v4.9 폐기** — 수행 양식은 Phase 23에서 삭제된다(SOT D-1). 이 체크리스트는 Phase 20 합격 기록으로만 남긴다 — 이후 Phase의 채점에 쓰지 않는다.

> 수행 양식은 제안 양식과 **같은 시트·열 + `집행일`**이다(IN-9). 대상은 산출근거가 아니라 `BudgetExecution`이고 반영은 **id 기반**(IN-10). 금액 열을 **읽는다**(IN-11). 미리보기와 반영이 다른 파싱 경로면 FAIL(IN-6·IN-13).

**스키마·RPC**
- [ ] 마이그레이션 1개: `budget_executions`에 `subcategory_code text null`, `spec text not null default ''`, `unit_price bigint null`, `factors jsonb null`, `axis text null check (axis in ('cash','in_kind'))`, `member_id uuid null references members on delete set null`, `detail_id uuid null references budget_details on delete set null`. 스냅샷 종류는 jsonb `snapshot.kind = 'execution_form'`(`import_snapshots`에 kind 컬럼 없음), check 제약은 `import_profiles.kind`에만 `'execution_form'`·`'goal_form'` 추가(§5.12.1). **`schema_version`은 4 유지**(§8.8 — 컬럼 추가뿐). RLS 정책 변경 불필요함을 마이그레이션 머리말에 근거로
- [ ] `commit_execution_form` RPC(security invoker, 단일 트랜잭션): 입력 = projectId·yearId·adds[]·updates[](id·expectedVersion 포함)·deleteIds[]. 과제·연차 경계 검증(executionId의 budget_item이 그 과제·연차인지, memberId·detailId가 그 과제인지 — IN-13), `version` 불일치 행은 **건너뛰고 conflict 목록으로 반환**(전체 롤백 아님, IN-10), 삭제도 version 비교(바뀐 행은 지우지 않고 conflict), 스냅샷 jsonb `kind='execution_form'` + `executions: { added, before }`(I-17 창 공유, 과제별 20개) 기록, 건수(added/updated/deleted/conflicts) 반환. 리포지토리 `lib/db/`에 래퍼, `mapper.ts` snake↔camel
- [ ] 타입·Zod: `BudgetExecution`에 §5.12 7필드(전부 nullable/기본값), `DetailFactor[] | null`, `axis: DetailAxis | null`. 기존 집행 CRUD(`createExecution`/`updateExecution`)가 새 필드를 선택적으로 받는다. 백업/복원(§8.7)이 새 컬럼을 그대로 실어 나른다(스모크: 내보내기 JSON에 필드 존재). **옛 백업 복원**: `restore_backup` 재정의가 `budget_executions` 행에만 `spec` 기본값 `''`을 채운다(§8.8, 이 한 컬럼) — 7컬럼이 없는 옛 형식 행으로 복원해 not null 위반 없이 `spec=''`·나머지 null이 되는 통합 테스트

**순수 함수 `lib/input-form/`**
- [ ] `layout.ts`: 좌표 맵 하나 + `mode` 분기(`sheetsFor(mode)` 류) — 수행 모드는 인건비·사업비 시트에 `집행일`(read, format 'date') 열과 숨김 `executionId` 열이 있고, 금액 열이 `read: true`·format 'int'(수식 아님). 제안 모드 맵은 Phase 17·19와 **바이트 단위로 동일**(기존 layout 테스트 그대로 통과)
- [ ] `build.ts`: `mode='execution'`이면 기존 집행 내역(연차 × 비목)을 행으로 채운다 — 인건비 시트는 `memberId` 있는 집행(없으면 인력당 빈 1행, IN-12: 참여율·개월은 `factors` 라벨 `참여율(%)`·`참여기간(월)`에서), 사업비 시트는 세목 코드 순(세목 없는 집행은 그 비목의 `default` 슬롯). 금액 열은 값(수식 없음), 집행일 채움, `_meta.mode='execution'`. 소계·총액 수식 행은 두 모드 공통. 작성안내 '주의'에 "금액 열을 읽는다", '읽지 않는 열'이 mode별 맵에서 생성(`unreadColumnsText(mode)`)
- [ ] `parse.ts`: `mode` 인자. `_meta.mode`가 요청 mode와 다르면 거부(IN-9 메시지). 수행 모드 행: `executionId`(숨김, 없으면 신규) · 집행일 필수(비면 오류 행 `no-date`) · 금액 0 이상 정수(음수·소수 오류) · 단가·인자 있고 금액 비면 PL-1 산식으로 채움, 둘 다 있고 다르면 경고 `amount-mismatch`(입력 금액 우선) · 축 빈 값 허용(null) · 세목 코드 검사는 제안 모드와 같음(IN-4) · 참여율·개월 → factors. 경계: `executionId`·`memberId`·`detailId`가 `_meta` 목록 밖이면 오류 행(IN-13) · 기존 집행 행(`executionId` 있음)의 세목이 **다른 비목**의 세목으로 바뀌면 blocking 오류 `category-moved`(IN-10 — 같은 비목 안 세목 변경은 update. 원래 비목은 `_meta`에 없어 파서가 아니라 수행 미리보기(`execution-preview.ts`)가 기존 집행과 대조해 판정하고, RPC가 한 번 더 막는다)
- [ ] `preview.ts`: 수행 모드 diff — 기존 집행(id) 대비 `add`/`update`(필드 비교)/`unchanged`/`delete 후보`(`_meta` id − 시트 id)/`conflict`(현재 DB version ≠ 내려받은 시점 `_meta` version, IN-10). 요약: 연차별 **집행률 전후**(`lib/budget.ts` 재사용, 정의 1곳), 예산 초과가 되는 셀 목록(B-2), 오류·경고 건수. `includeDeletes` 기본 false
- [ ] 단위 테스트: 수행 모드 생성→쓰기→읽기→파싱 왕복(집행 5건 이상, 인건비 2건: factors 왕복), 집행일 누락·음수 금액·`amount-mismatch`·mode 불일치 거부·경계 위반, 집행률 전후 수치(부록 B.4 값으로 검산), 제안 모드 결과 불변(Phase 19 테스트 전부 그대로)

**액션·화면**
- [ ] `buildInputForm(projectId, yearId, mode)`·`previewInputForm(projectId, file, mode)`·`commitExecutionForm(projectId, file, fileHash, includeDeletes)`. commit은 preview와 **같은 파싱 함수** + `fileHash` 대조(IN-6·IN-13), RPC 결과의 conflicts를 ActionResult로 그대로 전달(삼키지 않음). `commitInputForm`(제안)은 무변경
- [ ] §7.9.7: 수행 모드 툴바에 같은 두 버튼. 업로드 모달 미리보기가 추가·변경·삭제 후보·충돌 건수, 연차별 집행률 전후, 예산 초과 셀 경고를 보여 주고 `[삭제 포함]` 토글(기본 꺼짐)이 delete를 켠다. 집행 내역 패널(§7.9)에 새 필드가 접힌 "내역" 줄로 표시·편집(필수 아님)
- [ ] F-9: 수행·제안 양식의 `축` 열(`"현금,현물"`)과 인건비 시트 `세목` 열(인건비 세목 라벨)에 **인라인 목록** 드롭다운. `_lists` 시트 없음 — 제안 양식 시트 목록(`작성안내`·`인건비`·`사업비`·`_meta`) 불변. 파서는 여전히 값을 검사
- [ ] `npm test`·`tsc`·`build` 통과. `db push` 후 통합 테스트(commit_execution_form 경계·conflict·스냅샷). **복원(IN-14)**: 추가·변경·삭제가 섞인 반영 → `restoreImportSnapshot` → 추가 행 삭제·변경 행 원복·삭제 행 id 보존 부활, 새 스냅샷 없음. 반영 뒤 대상 행을 다시 고치면 복원 **전체 거부**(부분 복원 없음). `executions` 키 없는 기존 스냅샷 복원 불변. §13 12-a 해소 표기 확인. 절대 규칙 3·5

## Phase 21 — 목표 양식 (SOT v4.8 §5.8·§5.9, §6.17 GF-1~GF-11, §7.7 툴바, §9 Goal Form, 부록 F F-9, §13 13)

> 목표 양식은 입력 양식(§6.16)과 **같은 구조**(좌표 맵이 데이터·`_meta` 검증·미리보기와 반영이 같은 파싱·`fileHash`)이고 반영은 **id 기반**(GF-5)이다. `lib/goal-form/`은 xlsx·exceljs를 모른다. 미리보기와 반영이 다른 파싱 경로면 FAIL.

**스키마·RPC**
- [ ] 마이그레이션 1개: `deliverables`에 `weight numeric not null default 0 check (weight >= 0)`·`evidence_method text not null default ''`, `tech_targets`에 **`group_name`**(예약어 회피 — 매퍼가 앱 `group`으로, §5.1 N-9 특례)·`standard_basis`·`basis_rationale`·`evaluation_environment`·`note`(전부 `text not null default ''`). **`schema_version`은 4 유지**(§8.8 — 컬럼 추가뿐), RLS 변경 불필요 근거를 머리말에. **옛 백업 복원**: `restore_backup` 재정의가 §8.8 목록(`deliverables.weight` 0·`evidence_method` '', `tech_targets` 5종 '')만 채운다 — 새 컬럼이 없는 옛 형식 행으로 복원해 not null 위반 없이 기본값이 들어가는 통합 테스트. Phase 20의 `spec`·`detail_id` 처리 불변
- [ ] `commit_goal_form` RPC(security invoker, 단일 트랜잭션): 성과목표·성과실적·기술목표·측정이력 4종의 adds/updates(id·expectedVersion)/deletes. **과제 경계 검증(N-13)**: 모든 id·`targetByYear` 키·yearId·orgId·memberIds가 그 과제 것인지. version 불일치 행은 **건너뛰고 conflict 목록으로 반환**(IN-10과 같은 태도), 삭제도 version 비교. 기존 실적·측정의 부모 변경은 raise(`parent-moved`, GF-5). 새 지표에 딸린 새 실적·측정은 임시 키(`row:<n>`)로 받아 같은 트랜잭션에서 새 부모 id로 해석(GF-10). 부모 삭제 전 현재 자식 ⊆ `_meta` 자식·version 일치 확인, 아니면 그 부모 삭제를 conflict로 건너뜀(GF-5). `targetByYear`는 `_meta.yearIds` 키만 교체·그 밖 키 보존, `_meta` 연차가 삭제됐으면 전체 거부(GF-5). 추가 행은 기존 순서 뒤에 시트 순서대로. 스냅샷 jsonb `kind='goal_form'` + `goals: { added, before, deleted }`(삭제 지표의 연계 행 포함, I-17 창 공유, 과제별 20개 — GF-11), 건수·conflicts 반환. `lib/db/` 래퍼, `mapper.ts` snake↔camel(`group_name` ↔ `group` 매퍼 테스트). **복원 거부(GF-11)**: `restore_import_snapshot`이 `goals` 키 스냅샷에 raise — `restoreImportSnapshot`이 실패 ActionResult를 돌려주고 데이터 불변(0건 성공으로 떨어지면 FAIL). `goals` 키 없는 기존 스냅샷(`items`·`details`·`executions`) 복원 경로 한 글자도 불변. 통합 테스트. `importSnapshotPayloadSchema.kind`에 `'goal_form'` 추가 — goal_form 스냅샷이 있어도 `listImportSnapshots` 정상
- [ ] 타입·Zod: `Deliverable.weight`·`evidenceMethod`, `TechTarget.group`·`standardBasis`·`basisRationale`·`evaluationEnvironment`·`note`. 기존 목표 CRUD(`actions/goals.ts`)가 새 필드를 **선택 인자**로 받는다(생략 시 DB 기본값, 기존 호출 동작 동일). 백업 내보내기 JSON에 새 컬럼 존재(`group_name`)

**순수 함수 `lib/goal-form/`**
- [ ] `value.ts`(GF-6): `≥`·`이상`·`↑`·`초과` → higher 힌트, `≤`·`이하`·`미만`·`이내`·`↓` → lower, `a~b` → 뒤 숫자, 쉼표·공백·`%`·단위 접미 제거, `-`·`—`·`없음`·빈칸 → null(**셀 전체가 그 문자일 때만** — `-5`는 음수). 남는 문자가 있으면 첫 숫자 + `[원문] {열}: {원문}` 비고 줄 + 경고(같은 줄이 이미 있으면 안 붙임 — 멱등), 숫자 없으면 null + 원문 + 경고. 숫자 셀은 그대로. 방향 힌트는 기술목표 연차·최종 셀에서만, 힌트 우선 + 방향 열과 다르면 `direction-overridden` 경고. 연차별 힌트 불일치 경고. 성과 건수 비정수 blocking, 가중치·비중 **음수는 blocking**(DB check와 같음). **중간 반올림 없음**. 부록 C.3.4와 같은 키워드 표. 분기마다 단위 테스트(§11 완료 기준: `≤10` → 10·lower, `LOD 2.5` → 2.5 + 원문 비고)
- [ ] `layout.ts`(GF-1): 시트 `작성안내`·`성과목표`·`성과실적`·`기술목표`·`측정이력`·`_lists`(숨김)·`_meta`(숨김) 좌표 맵이 데이터. **성과목표 시트에 `구분` 열 없음**(기술목표 시트에만). 연차 열은 N개(연차 순, 헤더 = 연차 라벨 `year.name` 또는 `${order+1}차년도`, 중복 `이름 (2)` — GF-3), 숨김 id 열(`deliverableId`·`achievementId`·`techTargetId`·`recordId`), 표시 전용 열(`read: false` — 연차 합계 수식) 구분. 실적·측정 시트의 `지표명`/`평가항목` 열은 **읽는 열**(GF-10). `GOAL_FORM_VERSION = 1`. `_lists` 숨김 시트(F-9 — 유형·방향·측정방법·연차·기관·관여자 범위, 파서는 읽지 않음, `축` 없음)
- [ ] `build.ts`: 기존 지표·실적·기술목표·측정 이력을 행으로 채운다. 유형·방향·측정방법·연차는 부록 A.2·A.4 **한글 라벨**(GF-3). 동명 기관·인력은 `이름 (2)`로 구분해 `_meta`와 `_lists`에 싣는다(GF-4). 연차 합계·가중치 합계·비중 합계 **수식 행**(GF-8, 캐시값 없이 `f`만) — 합계 행은 데이터 아래, 숨김 id 열 마커 `#total`, 그 위 빈 입력 행 20개. 관여자 드롭다운은 `_lists` 범위 + **`errorStyle: 'warning'`**(`;` 다중 입력 허용 — GF-4·F-9). 실적·측정 시트 `지표명`/`평가항목` 드롭다운은 **같은 파일 성과목표/기술목표 시트 이름 열 범위(빈 입력 행 포함) 직접 참조** + `warning`(GF-10·F-9 — 새로 적은 지표도 목록에 뜬다). 나머지 목록은 stop. `_meta`: `form = goal`·`formVersion`·`projectId`·`generatedAt`·`year:`/`org:`/`member:<id>` 라벨(`year:` 행 순서 = 연차 열 순서 `yearIds`, GF-1) + 행별 **내려받은 시점** version(`deliverable:`·`achievement:`·`techTarget:`·`record:<id>` — 충돌 기준, GF-5)
- [ ] `parse.ts`: 거부 순서 형식 → 과제 → 버전(GF-2) — `_meta` 없음·`form` 없음·`form ≠ goal`(**입력 양식 파일을 올리면 거부**)·`projectId` 불일치·`formVersion` 불일치. **연차 열은 `_meta.yearIds` 순서로 읽는다**(헤더 이름 추측 금지 — 헤더를 바꿔도 결과 불변 테스트). 라벨 → 코드, 모르는 라벨은 오류 행(GF-3). 기관·관여자는 `_meta` 목록 안 **완전 일치**만, `;` 다중, 실패는 오류 행(GF-4 — 퍼지 매칭 0). 숨김 id가 `_meta` 목록 밖이면 오류 행. 숫자 열은 GF-6. GF-7: 기술목표 `targetValue` 비면 값 있는 마지막 연차, 최종 ≠ 마지막 연차면 `final-target-mismatch` 경고, 모두 비면 blocking `no-target`. 성과목표 `targetTotal` 비면 Σ연차, 둘 다 있고 다르면 D-3 경고(막지 않음). 수식 행·`#total` 합계 행·빈 행은 읽지 않는다. 읽기는 첫 합계 행에서 멈추고, 합계 아래에 값이 있는 행은 blocking `below-total`(GF-8). 방법이 비고 부모 측정방법도 정할 수 없는 측정 행은 blocking(미리보기가 throw하지 않고 `blocked`). 필수값·기본값은 GF-9 표대로. **부모 연결(GF-10)**: 기존 실적·측정 행은 숨김 부모 id(이름 열을 고쳐도 부모 불변 — 이름이 같은 파일의 **다른** 부모 이름과 일치할 때만 blocking `parent-moved`, 부모 이름만 고친 경우는 통과), 새 행은 같은 파일 성과목표/기술목표 시트 이름 **완전 일치** — 겹치면 `ambiguous-parent`, 없으면 `unknown-parent`(blocking). 관여자는 드롭다운이 경고형이므로 파서가 이름마다 재검사
- [ ] `preview.ts`: 시트별 `add`/`update`(투영 비교 — 양식이 표현 못 하는 값은 왕복으로 안 바뀐다)/`unchanged`/`delete 후보`(`_meta` id − 시트 id)/`conflict`(현재 version ≠ `_meta` 내려받은 시점 version)/`error`. 지표 삭제 후보는 **"실적 N · 측정 M · 연계 작업 K"**를 함께 보인다(GF-5). 삭제 후보 지표를 가리키는 실적·측정 행이 남으면 blocking `orphan-child`. 같은 숨김 id 여러 행은 IN-10 규칙(투영과 같은 행 하나면 원본, 아니면 blocking `duplicate-row`). 기존 자식의 부모 변경은 blocking `parent-moved`. 경고: 가중치 합 ≠ 100, 비중 합 ≠ 100, Σ연차 ≠ 총량, GF-6 원문. blocking 1건이라도 있으면 `blocked` — 반영 불가(부분 반영 없음, GF-5). 달성률 전후는 `lib/goals.ts` 재사용(재구현 금지). `includeDeletes` 기본 false, 새 부모는 임시 키(`row:<n>`)로 페이로드
- [ ] 단위 테스트: 생성 → exceljs 쓰기 → SheetJS 읽기 → 파싱 **왕복**(지표 2개 이상·실적·기술목표 3방향·측정 이력, 연차 3개 — 그대로 올리면 전 행 unchanged), 이름 수정 → update, 행 추가 → add, 행 삭제 → delete 후보, `_meta` 거부(없음·form 불일치(입력 양식 파일)·과제·버전), 모르는 라벨·기관 불일치·경계 밖 id 오류 행, 새 지표 + 그 지표 이름을 가리키는 새 실적(부모 이름 연결)·`ambiguous-parent`·`unknown-parent`·`orphan-child`·`parent-moved`·`duplicate-row`, 가중치·비중 음수 blocking, GF-6·GF-7·GF-9 전 분기

**액션·화면**
- [ ] `actions/goal-form.ts`: `buildGoalForm(projectId)`·`previewGoalForm(projectId, file)`·`commitGoalForm(projectId, file, fileHash, includeDeletes)`. commit은 preview와 **같은 파싱 함수** + `fileHash` 대조(IN-6), RPC conflicts를 ActionResult로 그대로 전달. exceljs·SheetJS는 `server-only` 어댑터에서만 import(boundary 테스트 허용 목록 갱신)
- [ ] §7.7 툴바: `[양식 내려받기]`·`[양식 올리기]`(미리보기: 시트별 추가·변경·삭제 후보·충돌·오류·경고 건수, 삭제 후보의 딸린 건수, `[삭제 포함]` 토글 기본 꺼짐, blocking 오류가 있으면 반영 버튼 비활성, 반영 후 충돌 목록. "반영 제외 행"은 Phase 22 전용이라 목표 양식 미리보기에 없음). 탭 1 테이블에 가중치·평가방법 열 + **가중치 합 ≠ 100 경고 배지**, 탭 2 테이블에 `구분` 열(같은 구분끼리 묶어 표시)과 행 확장에 표준·인증기준 / 기준설정 근거 / 평가환경, **인쇄 레이아웃에 `구분` 열**. 성과목표·기술목표 **모달에서 새 필드 편집**(선택 입력). 설정 화면 스냅샷 목록에 "목표 양식"으로 표시하고 **복원 버튼 비활성**(GF-11)
- [ ] 통합 테스트(`db push` 후): §11 완료 기준 — 내려받은 양식에 지표 1개·기술목표 1개(연차별 목표 포함)를 추가해 올리면 조회에 나타나고 달성률(§6.2·§6.3)이 맞는다. 다시 내려받아 이름을 고쳐 올리면 **같은 id**가 바뀐다. 같은 파일에서 새 지표 + 그 지표에 붙인 새 실적이 한 번에 반영(임시 키 해석, GF-10). 경계 위반·version 충돌·`parent-moved` raise·삭제 포함 시 실적·측정 연쇄 삭제·내려받은 뒤 자식이 추가된 부모 삭제는 conflict로 건너뜀·`targetByYear` 범위 밖 키 보존·스냅샷 20개 창·**goal_form 스냅샷 복원 거부**(데이터 불변)·입력 양식 파일 거부·옛 백업 기본값. 새 필드를 생략한 기존 목표 CRUD 동작 동일
- [ ] `npm test`·`tsc`·`build` 통과. §13 13 해소 표기 확인. 절대 규칙 3(UI·액션이 supabase 직접 호출 없음)·5(빈 배열 폴백 없음)

## Phase 22 — hwpx 계획서 가져오기 (SOT v4.8 §6.18 HX-1~HX-8, 부록 C.3, §7.7 툴바, §9 Plan Document)

> hwpx는 목표 양식(§6.17)의 **앞단**이다 — 격자 → `GoalFormRows`(Phase 21 행 모델)를 만들어 `previewGoalForm`·`commit_goal_form`을 **그대로** 탄다(HX-8). 별도 반영 경로·별도 RPC가 생기면 FAIL. 파일은 서버로 올라가지 않는다(HX-1).

**의존성·경계**
- [ ] `fflate`·`fast-xml-parser`가 dependencies에 있다. `lib/hwpx/`는 이 둘만 외부 의존하고 **DOM API·Node 전용 API(fs·Buffer·path 등) 0건**(클라이언트·Node 공용, 정적 검사 테스트). xlsx·exceljs·@supabase·`lib/db`·`actions`·어댑터 import 0
- [ ] `Contents/section*.xml`만 푼다(`unzipSync` filter) — `BinData/`는 해제하지 않는다(HX-1, 실측 108MB 파일이 브라우저에서 돈다). 입력 판정은 `.hwpx` + `PK` + mimetype `application/hwp+zip` — `.hwp`(OLE)·PDF·다른 파일은 "hwpx로 저장해 다시 올려 주세요"로 거부
- [ ] 클라이언트/서버 분리(S-33): 클라이언트는 `lib/hwpx/{types,zip,extract,tables,serialize,limits}`만 import, `rows.ts`는 서버 전용 — 경계 테스트가 전이 import까지 검사

**순수 함수 `lib/hwpx/`**
- [ ] 격자 추출(HX-2): `hp:tbl` `rowCnt`·`colCnt`로 격자, `hp:cellAddr`·`hp:cellSpan`으로 병합 **확장**(좌상단 값을 범위 전체에 복사, S-11 방식). 셀 텍스트 = 문단 `\n` 이음 + `hp:t` 조각 이음, lineBreak → `\n`, tab → 공백, **수식(`hp:equation`)·그림은 제외**(빈 문자열 — `[수식: …]`·`[그림]` 같은 자리표시 문자열이 격자에 나오면 FAIL, U-9), 셀 전체가 `-`·`—`·`없음`이면 ''. 한 줄 필드는 개행→공백·trim, 여러 줄 필드는 개행 유지(S-16). 섹션 `section{N}` 숫자 순, index 통산. 중첩 표는 별도 표. `rowCnt` ≠ 실제 `hp:tr` 수면 "구조 불일치"로 표시하고 건너뛴다(조용히 자르지 않음)
- [ ] 표 식별(HX-3): 캡션이 아니라 **헤더 서명** — 첫 2행(병합 확장 후) I-1 정규화 집합이 부록 C.3.1 키워드(별칭 포함)를 **모두** 포함. 헤더 행 수는 첫 2행 중 서명 키워드·별칭·C.3.5 열 역할 라벨과 완전 일치 셀이 2개 이상인 행이 앞에서 연속된 수(실측 2/2/1, S-2). 열 역할은 부록 C.3.5, 못 정한 열은 "읽지 않은 열"로 표시. 떨어진 같은 종류가 여럿이면 첫 묶음만 쓰고 "같은 표가 N개 더 있습니다" 알림. 일부만 찾으면 찾은 것만 진행, 기술목표·성과목표 둘 다 없으면 거부(S-28). 서명 키워드·별칭·열 역할·시간 단위는 `lib/constants.ts`(부록 C.3이 원본)
- [ ] 쪽 나뉨(HX-4): 같은 서명 표가 **연달아** 나오면 두 번째부터 헤더 행을 떼고 잇는다. 순번이 1씩 늘지 않으면 경고. 실측 계획서는 종류별 1개로 **쪽 나뉨이 없다** — 잇기는 합성 픽스처로 검증(S-1)
- [ ] 기술목표 행(HX-5, U-1~U-4): **읽는 열 6개 + 연차뿐** — 평가항목·단위·비중·연차별 개발목표치·평가방법·담당연구개발기관. **세계최고(보유국·성능수준)·국내수준·표준·인증기준·기준설정근거는 읽지 않는다** — 기존 행은 기존 값 보존, 새 행 `worldBest`·`baselineDomestic` null, `worldBestHolder`·`standardBasis`·`basisRationale` ''(이 열 값이 반영되면 FAIL). 평가항목은 번호 붙은 평가항목명 열 **하나만**(`^\d+\.\s*` 접두 제거 + 순번 보관), 앞 병합 셀 무시 — `group`을 채우지 않음(기존 보존, 새 행 ''). 연차 열 ↔ 과제 연차 순서(K = min, 수 다르면 경고·남는 열 무시·표에 없는 연차 목표 보존), 비중·연차 목표 GF-6(`lib/goal-form/value.ts` 재사용 — 재구현 금지). **방향**: 셀 힌트(C.3.4, `<`→lower·`>`→higher 포함)가 있으면 그것, 없으면 단위가 시간 단위(C.3.6: 초·s·sec·ms·분·min·시간·hr)면 `lower_better`, 그 외 `higher_better`, 기존 행은 힌트·시간 단위가 없으면 기존 direction 유지(`direction-default` 경고 없음). 담당기관 → orgId는 HX-8 이름 키 완전 일치만(실패는 비고 `[담당기관] …` + `org-unmatched`), 평가방법 → 부록 C.3.3(비면 `self`, `other`면 비고 `[원문] 평가방법: …` + `method-other`), 비고 줄 멱등
- [ ] 성과목표 행(HX-6, U-5~U-7): **지표명** — 특허는 `특허 {국내|국외}{출원|등록} 건수` 4종, 그 외는 항목 라벨을 공백으로 잇고 연속 중복 1회(`SCI급 게재논문 게재`·`고용창출 효과` 등), 구분 값(`사업별 성과지표`·`학술`·`상용화`)은 이름에 넣지 않음(특허만 예외). 유형은 부록 C.3.2(양쪽 I-1 정규화, **비SCI 규칙이 SCI보다 위** — `비SCI급 게재논문`이 `paper_domestic`, 첫 매칭, 없으면 `other`). 단위는 단위 열 그대로(`명` 보존), 가중치 → weight, `계` → targetTotal(비면 Σ연차, GF-7), 평가방법 → evidenceMethod. **반영 제외는 SMART 평균·Impact Factor 평균(이름 키워드 또는 단위 `점수`)뿐** — 사유와 함께 미리보기에 남김(조용히 빼지 않음). 목표가 전부 `-`인 행(`특허 국외등록 건수`)은 **제외하지 않고 목표 0으로 반영**(제외되면 FAIL)
- [ ] 평가방법 표(HX-7, U-8): 순번으로 기술목표 행에 잇고(없으면 평가항목 이름 키 완전 일치 재시도, 실패는 `unlinked-method-row` 경고, 순번 중복은 경고 + 미연결), 평가방법 → measureDescription, 평가환경 → evaluationEnvironment. 평가환경 안의 **`[기준설정 근거]` 표식 문단부터 끝까지는 버린다** — basisRationale에 넣지 않음(기존 보존, 새 행 ''; basisRationale이 채워지면 FAIL). 표식이 없으면 전부 evaluationEnvironment. 미연결 기술목표는 이 필드들 보존
- [ ] 행 모델(HX-8): 결과가 `GoalFormRows`(Phase 21 `lib/goal-form/parse.ts`)와 **같은 타입**. 기존 지표 대응은 이름 키(NFC + 공백 제거, 괄호·대소문자 유지, 순번 접두 제거) 완전 일치로 id를 채워 update, 없으면 add. DB 중복 `ambiguous-match`·계획서 중복 `duplicate-plan-name`은 blocking. 대응된 기존 행은 표가 주지 않거나 읽지 않는 필드를 기존 투영값으로 채움 — **같은 격자 재미리보기 전 행 `unchanged`**(멱등, S-18). 합성 `_meta`(S-11), `sheetRow` = 표 데이터 행 순번(S-10), 반영 제외 행은 `GoalFormRows` 밖 `excluded`(blocking·건수 무영향, S-9). **삭제 후보 0**(`allowDeletes: false`), 실적·측정 행 0. 해시 대상은 격자 JSON 정규 직렬화(`lib/hwpx/serialize.ts`)
- [ ] 단위 테스트: 격자 병합 확장·수식·그림 제외·구조 불일치, 서명 식별(별칭·키워드 누락 시 불일치)·헤더 행 수, 쪽 나뉨 잇기·순번 경고(합성 픽스처), HX-5·HX-6·HX-7 분기(읽지 않는 열 무반영, 시간 단위 방향, 지표명 규칙, 반영 제외, `[기준설정 근거]` 버림), 이름 대응 update/add, 투영 멱등. **`samples/*.hwpx` 실측 테스트**(파일이 없으면 skip하고 사유 출력 — gitignore): 표 276개, §11 완료 기준 — 기술목표 28행·평가방법 28행(각 표 1개, 쪽 나뉨 없음), 성과목표 14행 중 **반영 11행 + 반영 제외 3행(SMART 평균 2·Impact Factor 평균 1)**. 건수·구조·유형 분포만 단언하고 실데이터 문자열 0(S-34). 테스트 픽스처는 익명화된 작은 hwpx(또는 XML 조각)만 `tests/fixtures/`에 커밋

**액션·화면**
- [ ] `actions/plan-document.ts`: `previewPlanTables(projectId, payload)`·`commitPlanTables(projectId, payload, tablesHash)` — 파일을 받지 않는다(HX-1). **`tablesHash`는 서버가 preview에서 계산해 돌려주고** commit이 격자를 다시 해시해 대조(불일치 거부). **미리보기 다이제스트 없음** — commit은 그 시점 DB로 다시 해석해 덮어쓴다(나중 쓰기 승, U-10). `commit_goal_form`(삭제 없음) + 스냅샷 kind `goal_form`·`sheetName: '계획서(hwpx)'`. 격자 JSON Zod 검증 — 상한(`lib/hwpx/limits.ts`: 직렬화 800,000B·표 ≤20·행 ≤300·열 ≤40·셀 ≤20,000자)을 클라이언트·서버 모두 검사, 넘으면 명시적 오류. 절대 규칙 3·5
- [ ] §7.7 `[계획서(hwpx) 가져오기]`: 파일을 **브라우저에서** 풀고(진행 표시), 찾은 표(기술목표·성과목표·평가방법)의 행 수, 못 찾은 표는 "표를 찾지 못했습니다 — 헤더 서명" 안내, 같은 미리보기(`components/goals/GoalPreviewPanel.tsx` 추출 — `GoalFormUpload` 동작 불변), 반영 제외 행 사유 표시, 삭제 토글 없음, 행 위치 "기술목표 표 N행 (순번 k)". 격자가 너무 크면 "표만 추출해도 너무 큽니다". 컴포넌트는 `components/goals/PlanDocumentUpload.tsx`. 클라이언트가 `lib/hwpx/`를 import해도 경계 테스트 통과(서버 전용 모듈 끌려오지 않음)
- [ ] 설정 화면 스냅샷 목록에 hwpx 반영이 **"계획서(hwpx)"**로 따로 표시되고(목표 양식은 "목표 양식" 그대로) 복원 버튼 비활성(U-11, GF-11)
- [ ] 긴 텍스트 표시(§7.7, U-12): 탭 2 행 확장 텍스트(평가방법 상세·평가환경·표준·인증기준·기준설정 근거·비고)와 탭 1 평가방법(증빙) 열이 **한 줄 + `…` + [더보기]**. 마우스 오버 시 전체 오버레이, [더보기] 클릭 시 아래로 펼침·다시 누르면 접기. 공용 컴포넌트 하나, `dangerouslySetInnerHTML` 0, 다크 모드 토큰, **인쇄 레이아웃은 전부 펼친 상태**
- [ ] 통합 테스트(DB): 실측(또는 픽스처) 격자로 preview → commit → 기술목표에 measureDescription·evaluationEnvironment 채워지고 **basisRationale·standardBasis·worldBest·baselineDomestic은 기존 값 그대로**, 기존 동명 기술목표는 같은 id update, 실적·측정 무변경, 해시 불일치 거부, 미리보기 뒤 DB 변경은 덮어씀(충돌로 건너뛰지 않음), 스냅샷 kind `goal_form`·`sheetName` '계획서(hwpx)'
- [ ] `npm test`·`tsc`·`build` 통과. §13 13 해소 표기 확인. 절대 규칙 3·5, 민감 파일(`samples/`) 커밋 0

## Phase 23 — 집행 관리 삭제 (SOT v4.9 §5.12·§5.12.1, §6.4, §6.16 IN-9~IN-14, §7.2·§7.3·§7.9·§7.9.7·§7.14, §8.7 K-9, §8.8, §9, 부록 B.4)

> 집행 관리는 RCMS·경영관리팀·정산 시스템 몫이다(D-1). 이 Phase는 **지우기만** 한다 — 협약 예산(Phase 24~26)의 테이블·화면을 미리 만들면 FAIL. **제안 모드 데이터(`budget_items`·`budget_details`)와 제안 양식은 한 글자도 바뀌지 않아야 한다**(D-3). 계획액 규칙 B-3·B-4는 유지(§6.4). Phase 23 T0에서 정하기로 한 항목(ImportKind `'execution_form'`·기존 수행 양식 스냅샷 처리, 옛 수행 양식 파일 거부 문구, `lib/budget.ts` 존폐, `getBudgetMatrix` 존폐, Phase 24 전 수행 모드 화면과 기본 모드, 입력 양식 액션의 `mode` 인자)은 **계획서(`docs/plans/phase-23-plan.md`)에 결정으로 적혀 있고 구현이 그대로여야** 한다.

**마이그레이션·DB**
- [ ] 마이그레이션 1개: `drop table budget_executions`(인덱스·정책·Realtime publication 항목이 함께 사라짐), `drop function commit_execution_form`, `restore_import_snapshot` 재정의 — `executions` 분기만 제거하고 `items`·`details`(D-17a) 경로와 `goals` 키 거부(GF-11)는 **한 글자도 불변**, `restore_backup` 재정의 — `budget_executions` 처리(Phase 20의 `spec` 기본값·`detail_id` 처리)만 빼고 Phase 21의 `deliverables`·`tech_targets` 기본값 채움은 그대로. `app_settings.schema_version` **5**(§8.8)와 `lib/constants.ts` `EXPECTED_SCHEMA_VERSION = 5`가 **같은 커밋**. `npx supabase db push` 성공
- [ ] 마이그레이션 머리말에 **RLS 영향 없음 근거**: 새 테이블 없음, 삭제 테이블의 정책은 테이블과 함께 사라짐, 다른 테이블 정책은 `budget_executions`를 참조하지 않음. `import_profiles.kind` check·기존 `kind='execution_form'` 스냅샷 처리가 T0 결정과 일치
- [ ] DB에 `budget_executions`를 참조하는 함수·뷰·트리거·정책 0건(`pg_proc.prosrc`·`pg_views`·`pg_policies` 조회 — 통합 테스트 또는 검증 스크립트로 근거 제시). `delete_project`·`delete_year` 등 연쇄 삭제 RPC가 그대로 동작
- [ ] dev DB에 집행 실데이터가 없음을 적용 전에 확인한 기록(SOT §8.8 — 2026-09-29 확인)이 계획서 또는 PROGRESS.md에 있다

**백업·복원 (§8.7 K-5·K-9, §8.8)**
- [ ] `BACKUP_TABLES`에서 `budget_executions` 제거. 내보내기 JSON에 `budget_executions` 키 없음, `schemaVersion: 5`
- [ ] **v5 왕복 테스트**: 내보내기 → 전체 복원 → 전 테이블 행 수·대표 행 동일(`budget_items`·`budget_details`·`budget_rules`·목표 4종·`staff` 포함)
- [ ] **옛 v4 백업 거부 테스트**: `schemaVersion: 4` 파일(`budget_executions` 키 포함)을 복원하면 K-5 버전 게이트가 **버전 불일치 메시지**로 거부하고 데이터 불변 — "테이블 데이터가 없습니다" 같은 엉뚱한 메시지나 집행 행을 조용히 버리는 복원이면 FAIL
- [ ] 파괴적 테스트(`tests/destructive/` — `guard.ts` 대상 테이블 목록·`backup-roundtrip.test.ts`)가 새 테이블 목록으로 갱신되고 통과

**코드 제거**
- [ ] 타입·Zod·매퍼: `BudgetExecution`·`BudgetItem.executions`·집행 Zod 스키마·매퍼 변환 제거. `BudgetItem`의 계획액 필드·`detailCount`는 그대로
- [ ] 리포지토리·액션: 집행 CRUD(`addExecution`·`updateExecution`·`deleteExecution`)와 `lib/db/`의 집행 조회·페이징 제거. `updateBudgetPlan`은 그대로
- [ ] 화면: 집행 패널(`ExecutionPanel`·`ExecutionDetailRow` 등), 매트릭스 셀의 집행·집행률 표시, 수행 모드 하단 집행률·잔액 요약 제거. Phase 24 전 수행 모드 화면·기본 모드는 T0 결정대로(빈 화면에 조용히 0이 보이면 FAIL — 절대 규칙 5)
- [ ] 수행 양식: `lib/input-form/`의 execution mode(`parse-execution.ts`·`execution-preview.ts`·layout `mode` 분기·`_meta` `mode`/`execution:`/`detail:` 생성), `lib/input-form-adapter.ts`의 수행 부분, `actions/input-form.ts` `commitExecutionForm`, `ExecutionFormUpload`, §7.9.7 수행 모드 툴바 제거. 옛 수행 양식 파일(`_meta.mode = execution`)을 제안 모드에 올리면 **명시적으로 거부**(T0 문구) — 제안 양식으로 오인해 반영되면 FAIL
- [ ] 집행률: `lib/budget.ts`의 집행률·예산 외 집행·초과 판정(B-1·B-2) 제거, B-3(연차 예산 불일치) 판정과 그 테스트는 유지. 대시보드(`lib/dashboard.ts`·`lib/db/dashboard.ts`·`ProjectSummaryCards`·`app/page.tsx`)·과제 개요·과제 카드의 집행률·집행액 제거. 대시보드 지표 카드 5개(§7.2)는 불변
- [ ] 설정 화면(`ImportSnapshotPanel`)의 "수행 양식" 스냅샷 표시·복원 경로가 T0 결정대로 정리(§7.14)
- [ ] 도움말·안내 문구: `content/help/`(`budget`·`calculations`·`dashboard` 등)의 집행·집행률 설명 제거·정정, `lib/rules-presets.ts` 부록 D.3 "집행일 비교는 수행 모드" 문구가 SOT 부록 D.3 정정과 일치. 튜토리얼 단계가 집행 기능을 가리키지 않음
- [ ] 관련 테스트 제거·갱신: `input-form-execution-*`·`execution-form-actions`·`budget-executions-paging` 등 집행 전용 테스트 삭제, 집행을 섞어 쓰던 테스트(`budget.test.ts`·`dashboard.test.ts`·`mapper.test.ts`·`repos-*`·`budget-actions`·`input-form-*`·`goal-form-*` 경계 테스트 등)는 집행 부분만 걷어내고 나머지 단언 유지 — 테스트를 통째로 지워 커버리지를 잃으면 FAIL
- [ ] **남은 참조 grep 0**: `app/`·`components/`·`actions/`·`lib/`·`types/`·`content/`·`tests/`와 새 마이그레이션에서 `execution`(대소문자 무시)·`집행률`·`BudgetExecution`·`budget_executions` 0건. 예외는 ① 이전 Phase의 기존 마이그레이션 파일(이력) ② `docs/`(SOT 폐기 표기·계획서) ③ T0 계획서가 명시해 남긴 위치(예: ImportKind 타입을 남기기로 정한 경우)뿐이며, 예외 목록을 보고서에 적는다

**회귀 없음**
- [ ] 제안 모드: 매트릭스·잠금(PL-9)·산출근거 패널·규칙 검증 패널·[연구비 규칙]·[인건비] 탭·[급여 반영]·총괄표/산출근거 임포트·제출 서식 내보내기 테스트 전부 그대로 통과. 부록 B.7·B.8·B.9 수치 불변
- [ ] 입력 양식(제안): 내려받은 양식 **바이트 불변**(Phase 19 layout·build·style 테스트 그대로), 왕복·`commitInputForm`·스냅샷 복원(D-17a) 통과
- [ ] 목표·목표 양식(§6.17)·hwpx(§6.18)·WBS·간트·칸반·마일스톤·리스크·노트·To-Do·조직원·참여율 테스트 전부 통과. `restore_import_snapshot`의 `items`·`details` 복원과 `goals` 거부가 통합 테스트로 불변
- [ ] `npm test`·`npx tsc --noEmit`·`npm run build` 통과. 절대 규칙 3(UI·액션이 supabase 직접 호출 없음)·5(빈 배열 폴백 없음). 협약 예산(§5.21~§5.24) 테이블·코드가 이 Phase에 들어오지 않음

## Phase 24 — 협약 예산 버전 + 비목별 보기 (SOT v4.9 §5.21~§5.24, §6.6 H-5a·H-7·H-9b, §6.14.8 RL-23, §6.19 AG-1·AG-2·AG-7~AG-9, §7.9·§7.9.8·§7.10, §8.5, §8.6, §8.7 K-9, §8.8, §9 Agreement Budget, §10, §11 24, 부록 A.4)

> 수행 모드 = **협약 예산 버전**이다(D-3·D-4). 제안 모드 데이터(`budget_items`·`budget_details`)와는 **별개 구조**이고, [협약 기준선으로 보내기]로 버전을 만든 뒤 **두 모드는 독립**이다(AV-6, D-6). 이 Phase의 보기는 **비목별(AG-2)과 변경 이력(AG-7) 두 개뿐**이다. 세목 총액 보존(**RL-23**)은 이 Phase에 들어온다(사용자 결정 2026-09-30) — 단 `lib/agreement/` 순수 함수이고 `RuleCode`·`budget_rules` 행이 **아니다**(§6.14.8). **Phase 25 범위(붙임4형·조정회의형·참여인원 보기, 붙임4 가져오기·파서, 과제 유형 `projectType` 컬럼·입력)나 Phase 26 범위(수행 모드 규칙 판정·RL-20~RL-22 판정·새 `RuleCode`·RL-23 규칙 행, 편성 항목·증빙 화면·체크리스트 목록)를 미리 만들면 FAIL.** 참여인원(§5.23)·편성 항목(§5.24) 테이블은 이 Phase에 만들지만 **편집 화면은 만들지 않는다** — 보내기·복제·삭제·백업·증감 계산이 두 테이블을 빠뜨리지 않는지만 본다.
>
> 이름·코드값·제약·매핑·화면 배치 등 세부 결정은 **계획서(`docs/plans/phase-24-plan.md`) S-1~S-22대로**이고 SOT 본문에 반영되어 있다(`grep -n "Phase 24 T0" docs/SOT.md` 0건). 숫자 기대값은 계획서 **S-20 합성 픽스처**다(부록 B에 협약 예산 예시가 없다 — 숫자가 안 맞으면 구현이 틀린 것이다).

**마이그레이션·DB (§5.21~§5.24, §6.6, §8.3, §8.8, §14.3)**
- [ ] 마이그레이션 1개(`supabase/migrations/20261001000000_agreement_budget.sql`)가 테이블 **4종** `agreement_versions`·`agreement_lines`·`agreement_participants`·`agreement_items`를 만든다 — 컬럼이 §5.21~§5.24 필드와 1:1(`BaseEntity`의 `version`·`created_by`·`updated_by`·`updated_at` 포함, `set_updated_meta` 트리거 — N-4·N-5). 버전에 `official_doc_no`·`iris_approved_at` 컬럼이 **없고** `confirmed_at timestamptz null`·`sort_order int`가 있다. 참여인원에 `annual_salary bigint null`. 금액 컬럼(`amount`·`personnel_cash`·`personnel_in_kind`·`annual_salary`)은 **`bigint`**(절대 규칙 4 — `numeric`·`float` 금지)이고 금액은 `>= 0` check. `participation_rate`·`months`는 `numeric` check 0~100 / 0~12. `axis` `('cash','in_kind')`, `kind`·`status`·`notice_type`·편성 항목 `kind` check가 §5.21·§5.24 코드값과 일치(N-12). `evidence jsonb not null default '[]'` + 배열 check
- [ ] 제약: `unique(project_id, sort_order)`, check `(status = 'confirmed') = (confirmed_at is not null)`, **작성 중 1개 부분 유일 인덱스** `(project_id) where status = 'draft'`, 금액 줄 `unique(version_id, year_id, category, subcategory_code, axis)`. 통합 테스트: 작성 중 버전 2개 INSERT가 DB에서 거부된다
- [ ] **같은 마이그레이션에** 4종 모두 `enable row level security` + `to authenticated` `using (is_approved()) with check (is_approved())` 정책(절대 규칙 2, §14.3 RLS-1). 정책 없는 테이블·`anon` 허용이 하나라도 있으면 FAIL. `pg_policies`/`pg_class.relrowsecurity` 조회로 4종 확인하는 통합 테스트
- [ ] FK 연쇄: 버전 삭제 시 금액 줄·참여인원·편성 항목 **cascade**(AV-4 — 확정 버전 삭제도 통과). 과제 삭제(`delete_project`)가 버전을 먼저 지워 4종을 남기지 않는다(H-7). `year_id`·`member_id` FK는 `no action`
- [ ] **연차·인력 삭제 차단 통합 테스트**(H-5a·H-9b): 협약 버전(금액 줄·참여인원·편성 항목 어느 것이든)이 쓰는 연차를 `delete_year`로 지우면 "협약 예산 버전 N개가 이 연차를 씁니다 — 해당 버전을 먼저 삭제하세요"로 거부되고 데이터 불변, `delete_stage`도 같은 이유로 거부. 참여인원이 참조하는 인력은 `delete_member`가 거부하고 `count_member_references`가 `agreement_participants` 키를 산출근거 키와 **따로** 센다. 버전을 지운 뒤에는 연차·인력 삭제가 된다. 기존 H-9a(산출근거) 동작 불변. 조용히 실패하거나 고아 행을 남기면 FAIL
- [ ] **확정 잠금 DB 강제**(§9): 하위 3종 `agreement_child_guard` 트리거 — 확정 버전 아래 INSERT/UPDATE 거부, `version_id` 변경 거부, 다른 과제의 `year_id`(참여인원은 `member_id`도) 거부. DELETE는 막지 않는다. 버전 트리거 — `project_id`·`sort_order` 변경 거부, 마지막 버전이 아닌 confirmed → draft 거부. 직접 INSERT/UPDATE로 확인하는 통합 테스트
- [ ] RPC 3종 `create_agreement_version`·`clone_agreement_version`·`delete_agreement_versions`가 **`security invoker`**(새 RPC 중 `security definer` 0 — `pg_proc.prosecdef` 조회), 단일 트랜잭션, 과제 경계 검증(다른 과제의 연차·인력 id를 넣으면 거부 — 통합 테스트)
- [ ] `app_settings.schema_version` **6**(§8.8)과 `lib/constants.ts` `EXPECTED_SCHEMA_VERSION = 6`이 **같은 커밋**. `phase23-migration` 등 기존 통합 테스트의 버전 단언이 `≥`로 깨지지 않음. `npx supabase db push` 성공
- [ ] Realtime(§8.5): 같은 마이그레이션에 `alter publication supabase_realtime add table agreement_versions, agreement_lines`(R-7), 참여인원·편성 항목은 publication에 넣지 않음. 연구비 화면이 두 테이블을 추가 구독(R-1~R-6 — 합계 4테이블)

**백업·복원 (§8.7 K-5·K-7·K-9, §8.8)**
- [ ] `BACKUP_TABLES`(`lib/db/backup.ts` `RESTORE_TABLES`)의 `budget_rules` 뒤에 4종 — FK 정순(버전 → 금액 줄·참여인원·편성 항목). `restore_backup` 재정의의 이전 정의 대비 diff가 **`c_tables` 4종 추가와 가드 트리거 disable/enable뿐**(Phase 21 `deliverables`·`tech_targets` 기본값 채움 등 나머지 한 글자도 불변)
- [ ] **v6 왕복 테스트**: 버전 2개(확정 1·작성 중 1) + 금액 줄 + 참여인원(인력 미지정 행 포함) + 편성 항목(증빙 포함)이 있는 상태로 내보내기 → 전체 복원 → 4종 행 수·대표 행(id·`status`·`confirmed_at`·`order`·금액·증빙) 동일. 확정 버전 아래 줄이 가드 트리거에 막히지 않고 복원된 뒤 가드가 다시 켜져 있음. 기존 테이블 왕복도 그대로
- [ ] **옛 v5 백업 거부 테스트**: `schemaVersion: 5` 파일은 K-5 버전 게이트가 **버전 불일치 메시지**로 거부하고 데이터 불변("테이블 데이터가 없습니다" 같은 엉뚱한 메시지면 FAIL — §8.8)
- [ ] 파괴적 테스트(`tests/destructive/guard.ts` 대상 테이블·`backup-roundtrip.test.ts`)가 4종을 포함하도록 갱신되고 통과

**순수 함수 `lib/agreement/` — 단위 테스트 필수 (§6.19 AG-9, §11 필수 1)**
- [ ] 모듈 `versions`·`category-view`·`cell-edit`·`from-plan`·`diff`·`preservation`·`changes-table`·`table`(AG-9). 부수효과 없음. `xlsx`·`exceljs`·`@supabase`·`lib/db`·`actions`·어댑터 import **0건**(정적 검사 테스트 — `lib/input-form/` 경계와 같다). 합계·증감·판정은 저장하지 않고 읽을 때 계산(AG-1, 파생 값 원칙). `lib/budget-plan.ts`·`lib/rules.ts` 무수정
- [ ] 비목별 보기 모델(AG-2): S-20 버전 A → 연차 × 비목(부록 A.1 순서) × 현금/현물 매트릭스, 비목·연차·총계 합계가 계획서 값(Y1 52,500,000 / Y2 52,700,000 / 총계 105,200,000, 현금 85,200,000·현물 20,000,000). **원 단위 정수 덧셈만**(부동소수점·중간 반올림 없음). 줄이 없는 칸은 `null`로 금액 0과 구별(절대 규칙 5)
- [ ] 셀 편집 해석 `resolveCellEdit`(AG-2): S-20 5분기 — 줄 2개 셀 → `default` 신설 500,000 / 같은 셀 → `default` 200,000 / → 1,400,000 reject / 줄 1개 셀 → 그 줄 갱신 / 줄 0개 셀 → `promotion/default` 신설. 다른 세목 줄을 깎으면 FAIL
- [ ] 현재·기준 버전(AV-3·AV-5·AV-8) — S-20 버전 판정 전부: 4버전 목록에서 현재 v3·작성 중 v4·base(v4) = v2·base(v1) = 기준 없음, **v2(최종협약본) 삭제 후 base(v4) = v3**(앞선 확정 final 없음 → 직전 확정), 작성 중만 있으면 현재 = 그 작성 중 버전, final 둘이면 최근 final, `order` 1·3·4 빈자리 유지, 종류를 final로 바꾸면 기준이 즉시 바뀜. 기준은 항상 V보다 앞선 버전. `canUnconfirm`은 마지막 버전이 확정일 때 그 버전만 true. `suggestNextVersionMeta` 4분기(없음·selection·adjustment·final/amendment → `협약변경 N차`)
- [ ] 보내기 매핑 `buildBaselineFromPlan`(AV-6): S-20 보내기 → 금액 줄 6개(재료비 `material/default` 현금, 연구수당 `allowance/default` 현금), 참여인원 2행(연봉 스냅샷·참여율·개월·축), 현금 40,000,000·현물 10,000,000, **미분리 1건·3,000,000 보고**(현금·현물 둘 다 null이고 계획액 > 0인 셀은 현금으로). 한쪽만 null이고 현금 + 현물 ≠ 계획액인 셀·음수 그룹은 위치를 적어 거부. 합계 0 그룹은 줄 없음. 편성 항목 0건
- [ ] 버전 간 증감(AG-7): S-20 A→B 줄 changed 3 · removed 1 · added 1 · unchanged 9, 순증감 −100,000, B 총계 105,100,000(Y1 49,700,000 / Y2 55,400,000). 참여인원 changed 1 · added 1 · unchanged 3 — `memberId` null 행은 연차별 "인력 미지정" 한 그룹. 같은 버전끼리 비교하면 전부 unchanged. 빈 버전과의 비교·연차 간 이동(한 연차 감소 + 다른 연차 증가) 분기 포함
- [ ] **RL-23 세목 총액 보존**(§6.14.8): 키 (비목, 세목, 축) 전 연차 합을 base(V)와 비교 — S-20 B 대 A에서 material_purchase 현금 보존, 경고 **3건**(travel_dom −800,000 · travel_intl +500,000 · indirect_hr +200,000). 기준 버전이 없으면 **"기준 버전 없음"** 값을 돌려주고 경고 0건(빈 배열)과 **구별**된다. 경고만 — 확정·저장을 막지 않는다. `RuleCode`·`budget_rules`·`evaluateRules`에 RL-23이 들어가면 FAIL
- [ ] 표 모델(AG-8, `table.ts`): 보기 → **하나의 표 모델**(제목·헤더 1행·data/subtotal/total 행·text/amount/sum/empty 셀) → ① TSV ② 엑셀 셀. TSV는 값(수식 아님), 금액은 구분 기호 없는 원 단위 정수, 빈 칸 `''`, 탭·개행·따옴표 셀은 `"…"`(`"`→`""`), 행 구분 `\r\n`. 엑셀 `sum` 칸은 `SUM` 수식 + 결과값. **같은 표 모델에서 나온 TSV와 엑셀 셀 값이 칸마다 일치**(exceljs 재로드로 확인). 변경 이력 표 3종(금액 증감·참여인원 증감·세목 총액 보존)

**리포지토리·액션 (§8.6, §9 Agreement Budget)**
- [ ] 리포지토리 `lib/db/agreements.ts`가 4종 CRUD·RPC 래퍼를 갖고, `lib/db/mapper.ts`가 snake ↔ camel을 전담(`sort_order` ↔ `order`, evidence 왕복 — 매퍼 테스트), **DB 응답을 Zod로 검증**(§8.6). 부분 유일 인덱스 23505·가드 트리거 오류 → `RuleViolationError`, `version` 불일치 → `StaleDataError`. 액션·UI가 supabase 클라이언트를 직접 호출하면 FAIL(절대 규칙 3)
- [ ] 액션(§9의 Phase 24 시그니처 전부 — `actions/agreement.ts`·`actions/agreement-export.ts`): 전부 `ActionResult<T>`, Zod 입력 검증, SA-1 세션 확인, 성공 시 `revalidatePath`, 예외를 그대로 던지지 않음, DB 내부 정보(테이블명·제약명) 노출 없음(SA-4)
- [ ] **과제 경계 검증**: 금액 줄·참여인원의 `yearId`가 버전의 과제 연차, `memberId`가 같은 과제 인력, `subcategoryCode`가 그 `category`의 부록 A.5 세목 또는 `'default'`(§5.22 — A.5 밖 세목 거부). 다른 과제 id를 넣으면 거부하는 통합 테스트(액션·RPC·직접 INSERT 셋 다)
- [ ] **확정 = 내용 잠금**(AV-2): 확정 버전의 셀 편집은 `RULE`, 확정 버전을 대상으로 한 어떤 내용 쓰기도 데이터를 바꾸지 않음을 통합 테스트로. 보기에서 편집 UI를 숨기는 것만으로는 FAIL(액션도 막아야 한다). **메타 7개(종류·이름·기준일·변경 사유·통보/승인·IRIS 신청일·비고)는 확정 후에도 편집이 성공**한다 — 종류를 바꾸면 다음 조회의 `baseVersionId`가 바뀜
- [ ] **확정 취소**(AV-8): 과제의 마지막 버전이 확정일 때만 성공(`confirmedAt` null, 상태 작성 중). 뒤에 버전이 있는 확정 버전은 `RULE` — 액션과 버전 트리거 둘 다. `expectedVersion` 불일치는 `STALE`
- [ ] **작성 중 버전은 과제당 하나**(AV-2): 작성 중 버전이 있으면 새 버전·빈 버전·보내기 **세 경로 모두** `RULE`로 거부. 어떤 경로로도 작성 중 2개가 되지 않는 통합 테스트(동시 호출 시 23505도 `RULE`)
- [ ] 새 버전 = **마지막 버전 통째 복제**(AV-1): 금액 줄·참여인원(연봉 스냅샷 포함)·편성 항목(증빙 포함)이 새 id로 모두 복사되고 원본 불변, 새 버전 상태는 작성 중, `order` = 최댓값 + 1. 참여인원·편성 항목 복사를 빠뜨리면 FAIL(화면이 없어도 데이터는 있다)
- [ ] 제안에서 보내기(AV-6): 금액 합계가 제안 모드 합계(현금/현물 각각 — 미분리 셀은 현금 쪽)와 일치하고 결과에 미분리 건수가 있다. **독립성 통합 테스트**: 보낸 뒤 제안 데이터(`budget_items`·`budget_details`)를 고쳐도 버전 불변, 버전을 고쳐도 제안 데이터 불변. **버전이 이미 있고 작성 중 버전이 없으면 보내기가 성공**해 새 작성 중 버전(마지막 `order` + 1)이 생기고 기존 버전 불변. 작성 중 버전이 있으면 `RULE`
- [ ] 삭제(AV-4): 확정 여부와 무관하게 어떤 버전이든 삭제, 전체 버전 삭제는 그 과제 버전만(다른 과제 불변). 두 경로 모두 하위 3종 cascade 확인. 남은 버전 `order` 재매김 없음
- [ ] 낙관적 잠금(§8.4): 메타·확정·확정 취소는 `expectedVersion` 필수(O-1) — 불일치 시 `STALE`, 화면은 O-3 비교. 셀 편집은 O-2(클라이언트가 version을 보내지 않음) + 서버가 읽은 줄 version으로 갱신해 경합은 `STALE`
- [ ] 엑셀 내려받기(`buildAgreementWorkbook`): 비목별·변경 이력 두 보기. 쓰기는 기존 `lib/input-form-adapter.ts`(**exceljs import 파일 2개 유지** — `input-form-boundary` 테스트), `FormCell.result?`는 선택 필드라 기존 입력·목표 양식 출력 **바이트 불변**. 첫 시트 `작성안내`, 부록 F(F-1~F-8·F-10 — 헤더 채움·키 열·테두리·`#,##0`·틀 고정·탭 색), `sum`·증감 칸 수식 + 결과값, 원 단위, 파일명 `{과제명}_협약예산_{버전 이름 또는 A→B}_{YYYYMMDD}.xlsx`. 생성된 xlsx를 다시 열어 서식·수식·값(= TSV)을 검증하는 테스트. 클라이언트 번들에 `exceljs` 없음

**화면 (§7.9, §7.9.8, §7.10)**
- [ ] Phase 23 안내("수행 모드(협약 예산 버전·보기)는 준비 중입니다…")가 **실제 수행 모드 화면으로 교체**되고 문구·`hint`의 "준비 중"이 남지 않음. 모드 값 `'plan' | 'agreement'`, 기본 모드 `제안`. 제안 모드 전용 툴바 버튼([엑셀 가져오기]·[입력 양식 내려받기]·[입력 양식 올리기]·[협약 기준선으로 보내기])은 수행 모드에 나오지 않음. 협약 조회 실패는 **수행 모드에만** 오류 배너(제안 모드는 정상)
- [ ] **버전이 없는 과제**: 매트릭스·숫자 없이 첫 버전 만들기 안내 + `[빈 버전]` + 제안 모드 [협약 기준선으로 보내기] 안내. 빈 매트릭스에 0을 보이면 FAIL(절대 규칙 5)
- [ ] 버전 바: 버전 선택 목록(종류·이름·기준일·상태 배지 — 라벨은 부록 A.4, 원시 코드 노출 금지), **현재 버전**(AV-3)과 보고 있는 버전의 **기준 버전**(AV-5) 표식. **확정 버전이 없으면 작성 중 버전이 현재 버전으로 "작성 중" 표시**(AV-3). 기준 버전(최종협약본)을 지우면 표식이 AV-5 규칙(앞선 확정 최종협약본 → 직전 확정 → "기준 버전 없음")대로 옮겨 가고 순번은 그대로
- [ ] 버튼 `[새 버전]`·`[빈 버전]`·`[확정]`·`[확정 취소]`·`[버전 정보]`·`[삭제]`·`[전체 버전 삭제]`. 작성 중 버전이 있으면 `[새 버전]`·`[빈 버전]` **비활성 + 이유 표시**. `[확정 취소]`는 마지막 확정 버전(그 뒤 버전 없음)일 때만 활성. 확정·확정 취소·삭제·전체 삭제는 확인 대화(전체 삭제는 버전 수 표시). `[버전 정보]`는 **메타 7종 편집**(종류·이름·기준일·변경 사유·통보/승인·IRIS 신청일·비고 — 공문 번호·IRIS 승인일 칸이 있으면 FAIL)이고 **확정 버전에서도 열린다**. 새 버전·빈 버전 대화가 종류·이름 초깃값을 제안(AV-1)
- [ ] 제안 모드 툴바 **`[협약 기준선으로 보내기]`**(D-6): 확인 대화에 만들 줄 수·참여인원 행 수·**미분리 셀 건수와 합계("현금으로 보냅니다")**, 버전이 이미 있으면 **"직전 버전을 복제하지 않고 제안 편성으로 새로 만듭니다"**. 작성 중 버전이 있으면 비활성 + 이유. 결과(만든 버전·줄 수·미분리 건수 또는 실패 사유)를 명시적으로 알림. `[붙임4 가져오기]` 버튼은 **없음**(Phase 25)
- [ ] 보기 탭: **`[비목별]`·`[변경 이력]` 두 개만 보인다**. 붙임4형·조정회의형·참여인원·편성 항목 탭은 **숨김**(자리표시 탭·"준비 중" 탭이 있으면 FAIL)
- [ ] 비목별 보기(AG-2): 연차 × 비목 매트릭스(현금/현물), 줄이 없는 칸 "—". 작성 중 버전에서 셀 편집 → 금액 줄 저장 → 합계 즉시 반영, `default` 흡수 결과가 맞음. **확정 버전을 보고 있으면 읽기 전용**(AG-1). 저장 실패·`RULE`(세목 줄 합계 초과 포함)·`STALE`은 사용자에게 명시적으로 표시
- [ ] 변경 이력 보기(AG-7): 버전 목록(메타 포함)과 **두 버전 선택(초깃값 A = 직전 버전, B = 보고 있는 버전) → 증감**(금액 줄·참여인원). 추가/삭제/변경/불변이 구별되어 보임. **세목 총액 보존** 절: B 대 base(B)의 RL-23 경고(키·기준 합·B 합·차액) 또는 "기준 버전 없음" — 경고 0건과 다르게 보임
- [ ] 각 보기 툴바 `[엑셀 내려받기]`·`[복사]`(AG-8): 비목별·변경 이력 모두. [복사]는 TSV를 `navigator.clipboard.writeText`로 넣고, 엑셀에 붙이면 같은 표(행·열·숫자 인식). Tauri 데스크톱에서 클립보드 쓰기가 되는지 실검증, 실패 시 오류 배너(조용히 무시하면 FAIL)
- [ ] 인력 화면(§7.10, H-9b): 협약 참여인원이 참조하는 인력은 삭제 대화상자에 "협약 예산 참여인원 N건이 이 인력을 참조합니다"가 산출근거와 **다른 줄**로 나오고 삭제 비활성 + 이유. 우회 호출도 `RULE`
- [ ] 인쇄: 보고 있는 보기 하나, 가로, 머리말 과제명·버전 이름·상태·출력일, 버전 바·탭·버튼 `print:hidden`. 다크 모드 토큰(§7.19·부록 E.5 — `bg-surface` 등, 하드코딩 색 0). `dangerouslySetInnerHTML` 0

**도움말 (§7.16)**
- [ ] `content/help/budget.md` "수행 모드 — 협약 예산" 절이 "준비 중"에서 버전·확정 잠금(메타는 편집 가능)·확정 취소(마지막 버전만)·작성 중 1개·보내기 후 독립·미분리 셀 현금·버전이 있을 때 보내기·삭제·연차·인력 삭제 차단·비목별/변경 이력·세목 미지정·세목 총액 보존(RL-23, 기준 버전 규칙)·엑셀/복사(원 단위)로 갱신되고 SOT와 모순 없음. 계산 설명은 `calculations.md`. 수행 모드 화면에 `HelpLink`. 튜토리얼 단계가 "준비 중" 화면을 가리키지 않음. Phase 25·26 기능을 이미 있는 것처럼 설명하면 FAIL

**회귀 없음**
- [ ] 제안 모드: 매트릭스·잠금(PL-9)·산출근거 패널·규칙 검증 패널·[연구비 규칙]·[인건비] 탭·[급여 반영]·총괄표/산출근거 임포트·제출 서식 내보내기 테스트 전부 통과, 부록 B.7·B.8·B.9 수치 불변. `lib/rules.ts`·`lib/budget-plan.ts`에 수행 모드 판정 코드가 들어오지 않음(Phase 26)
- [ ] 입력 양식(제안): 내려받은 양식 **바이트 불변**(Phase 19 layout·build·style 테스트 그대로), 왕복·`commitInputForm`·스냅샷 복원(D-17a) 통과. 기존 exceljs 어댑터의 출력이 공통 부품 도입으로 바뀌지 않음(목표 양식 포함)
- [ ] `projects`에 `project_type` 컬럼 없음, **`budget_rules`·`RuleCode`에 RL-20~RL-22 없음, RL-23은 `lib/agreement/` 순수 함수(`RuleCode`·`budget_rules` 아님)**, 붙임4 파서·SheetJS 읽기 경로 신설 없음(Phase 25·26 선행 구현 금지)
- [ ] 연차·단계·인력 삭제: 협약 버전이 없는 과제에서 기존 `delete_year`·`delete_stage`·`delete_member`·H-9a 테스트가 그대로 통과
- [ ] 목표·목표 양식·hwpx·WBS·간트·칸반·마일스톤·리스크·노트·To-Do·조직원·참여율·백업 테스트 전부 통과
- [ ] `npm test`(실행 후 `seed.sql` 복원)·`npm run test:destructive`·`npx tsc --noEmit`·`npm run build`(dev 서버가 꺼진 것 확인 후) 통과. 절대 규칙 1(service_role 없음)·3(UI·액션이 supabase 직접 호출 없음 — Realtime 읽기 구독만 예외)·5(빈 배열 폴백 없음). `samples/` 커밋 0

## Phase 25 — 붙임4형·조정회의형·참여인원 보기 + 붙임4 가져오기 + 연차별 정부지원 현금 (SOT v4.9 §5.5, §5.21 AV-1·AV-2·AV-6·AV-7, §5.23, §5.25, §6.6 H-5a, §6.19 AG-1·AG-3~AG-5·AG-8·AG-9, §7.9, §7.9.8, §7.16, §8.5, §8.7 K-9, §8.8, §9 Agreement Budget, §10, §11 25, 부록 A.4·C.4)

> Phase 24가 만든 협약 예산 버전(§5.21~§5.24)에 **보기 3종**(붙임4형 AG-3 · 조정회의형 AG-4 · 참여인원 AG-5)과 **붙임4 가져오기**(AV-7), **연차별 정부지원 현금**(제안 `years.gov_support_cash` §5.5 · 협약 새 테이블 `agreement_gov_support` §5.25)을 더한다. 원칙은 **소스 일원화**다(사용자 2026-10-03) — 양식 보기는 전부 원 소스(제안 `budget_items`·`budget_details`·`years`, 협약 금액 줄·참여인원·정부지원 현금)에서 파생하고, 양식 전용 저장 칸이 없으며, 보기에서 고친 값은 소스를 고친다(AG-1). 붙임4 기호는 우리 기호와 다르다(양식 `E1` = 총 인건비, `E2` = 수정인건비 = 우리 PL-11의 `E1`). 산식은 PL-11·PL-1을 **`lib/budget-plan.ts`에서 받아 쓰고 다시 구현하지 않는다** — 단 간접비 비율은 **양식 식 그대로의 "양식 분모"**이고 RL-3 `modifiedDirectCost`가 아니다(AG-3).
>
> **과제 유형은 하지 않는다**(D-9·RL-20 폐기, 사용자 2026-10-03): `projects.project_type` 컬럼·`ProjectType` 타입·과제 개요의 과제 유형 칸·기업 유형 칸이 **있으면 FAIL**. 정부출연금·민간현금 비율 한도는 과제별 RL-8 `gov_share_max`·RL-9 `own_cash_min` 행의 값이다.
>
> **Phase 26 범위를 미리 만들면 FAIL**: 수행 모드 현재 버전에 `evaluateRules`를 적용하는 규칙 검증 패널(§6.14 RL-1·§6.14.8), RL-21·RL-22의 판정식·새 `RuleCode`·`budget_rules` 행·프리셋, 연구실 안전관리비 세목 신설(부록 A.5), 8-2 비율(연구수당·간접비·인건비)의 **판정**(Phase 25는 표시만), RL-23의 규칙 행화, 편성 항목·증빙 보기·탭·편집 액션·증빙 기본 항목 목록(§5.24·AG-6), RL-17 "부가세 포함" 입력 안내 정정. **Phase 24 기능은 회귀 없이 그대로여야 한다**(아래 "회귀 없음").
>
> **결정은 계획서 `docs/plans/phase-25-plan.md` S-1~S-24대로다** — T0에서 SOT 본문에 반영됐다(`grep -n "Phase 25 T0" docs/SOT.md` 0건, `grep -n "우리 회사 이름" docs/SOT.md` 0건, `ProjectType`·`projectType`·과제 유형은 폐기 표기 문맥에만). 구현이 계획서와 SOT 사이에서 갈리면 SOT가 옳다.
>
> 숫자 기대값: 부록 B에 붙임4형·조정회의형·참여인원 예시가 **없다** → 계획서의 **합성 픽스처**(Phase 24 S-20 버전 A 확장)가 기준이다. 붙임4 파서는 `samples/`의 실측 파일 구조를 본떠 **익명화한 픽스처**(`tests/fixtures/attachment4/` — 금액·성명·기관명이 실데이터가 아님을 확인한 것만)로 시험한다. 숫자가 안 맞으면 구현이 틀린 것이다.

**마이그레이션·DB (§5.5, §5.25, §6.6 H-5a, §8.5, §8.7 K-9, §8.8, §9, §14.3)**
- [ ] 마이그레이션 **1개** `supabase/migrations/20261003000000_agreement_forms.sql`. `years.gov_support_cash bigint null` + check(null 또는 `>= 0`). **`projects.project_type`·기업 유형 컬럼은 없다**(있으면 FAIL)
- [ ] 새 테이블 `agreement_gov_support`: `version_id` FK `agreement_versions` **on delete cascade** · `year_id` FK `years` **no action** · `gov_cash bigint not null check (gov_cash >= 0)` · N-4 공통 컬럼(`id`·`created_at`·`updated_at`·`version`·`created_by`·`updated_by`) + `set_updated_meta` · **`unique(version_id, year_id)`** · `year_id` 인덱스
- [ ] **같은 마이그레이션에** RLS 활성 + `"approved users full access"` `for all to authenticated using (is_approved()) with check (is_approved())`(절대 규칙 2·RLS-1). 미승인 사용자는 읽기·쓰기 0행(통합 테스트). 머리말에 RLS 근거와 "`years` 새 컬럼은 기존 `years` 정책이 덮는다"
- [ ] **확정 잠금 DB 강제**: 새 테이블에 `agreement_child_guard` BEFORE INSERT/UPDATE 트리거(**함수 본문 불변** — 재사용). 확정 버전 아래 insert·update 거부, `version_id` 변경 거부, 다른 과제 연차 거부, 음수 거부(check) — 통합 테스트로 각각 확인. 같은 버전·연차 두 번째 행은 23505
- [ ] `delete_year` 재정의: 정부지원 현금 행**만** 그 연차를 쓰는 버전이 있어도 H-5a로 거부(메시지 "협약 예산 버전 N개가 이 연차를 씁니다…"). `delete_stage`도 같다. `delete_project`는 재정의하지 않고도 통과(버전 cascade). 협약 버전이 없는 과제의 기존 연차·단계 삭제 테스트 그대로 통과
- [ ] RPC: `create_agreement_version(p_project_id, p_kind, p_name, p_lines, p_participants, p_gov_cash jsonb default '{}')` — `p_gov_cash` = `{연차 id: 원}` → 새 테이블 행. 객체가 아니거나 값이 0 이상 정수가 아니면 사람이 읽는 메시지로 거부. **옛 5인자 시그니처가 `pg_proc`에 남아 있지 않다**(오버로드 0). `clone_agreement_version`이 정부지원 현금 행을 새 id로 복사하고 원본 불변. 새·재정의 함수 전부 `security invoker`(`pg_proc.prosecdef` 0건)(restore_backup은 기존 K-7 설계상 security definer — 제외)
- [ ] `app_settings.schema_version = 7`, `EXPECTED_SCHEMA_VERSION = 7` — **같은 커밋**(§8.8 — 테이블 추가). `npx supabase db push` 성공
- [ ] 백업(§8.7 K-9): `agreement_gov_support`가 `BACKUP_TABLES`·`RESTORE_TABLES`·`restore_backup` `c_tables`에 **`agreement_items` 뒤**로 들어가고(`c_tables` = `RESTORE_TABLES` 순서까지 — 기존 테스트), 삽입 동안 그 가드도 disable → enable. `restore_backup`의 이전 정의 대비 diff가 이 둘뿐(계획서 결과 절). 파괴적 테스트: **v7 왕복**(확정 버전 아래 정부지원 현금 행·`years.gov_support_cash` 값이 그대로 돌아옴) + **v6 백업 파일은 K-5로 거부** + v5 이하 거부 유지
- [ ] Realtime(§8.5): **publication 추가 없음**. 연구비 화면 구독은 `budget_items`·`budget_details`·`agreement_versions`·`agreement_lines` 4테이블 그대로(`agreement_participants`·`agreement_gov_support`·`years`를 구독하면 FAIL — 화면당 4 상한)
- [ ] 붙임4 가져오기는 새 RPC 없이 `create_agreement_version`(`p_participants: []`, `p_gov_cash`)으로 한 트랜잭션. 작성 중 버전이 있으면 `RULE`(AV-2 — 부분 유일 인덱스가 최후 방어선)

**순수 함수 `lib/agreement/` — 단위 테스트 필수 (§6.19 AG-3~AG-5·AG-9, §11 필수 1)**
- [ ] 새 모듈(계획서 S-1: `form-rows`·`rates`·`attachment4-view`·`adjustment-view`·`form-edit`·`participants`·`attachment4-parse`, `from-plan` 확장)이 `lib/agreement/`에 있고 부수효과 없음. `xlsx`·`exceljs`·`@supabase`·`lib/db`·`actions`·어댑터 import **0건** — 기존 `agreement-boundary` 정적 검사가 새 파일까지 덮는다. 합계·비율·판정을 저장하지 않는다(AG-1)
- [ ] **산식 재구현 금지**: 양식 `E2` = `modifiedPersonnel`(PL-11), 참여인원 계산값 = `computeDetailAmount`(PL-1·PL-2·PL-4)를 `lib/budget-plan.ts`에서 받아 쓴다. 같은 식을 새로 쓴 코드가 있으면 FAIL. `lib/budget-plan.ts`·`lib/rules.ts` diff 0(부록 B.7~B.9 그대로)
- [ ] **양식 분모**(AG-3): 간접비 비율 = L ÷ (A현금 + B현금 + C + D일반 + D통합관리 + F현금 + G현금 + H현금 + I) — **양식 시트 식 그대로**이고 RL-3 `modifiedDirectCost`(`base`)가 아니다. 테스트 ① "양식 분모 ≠ RL-3"(Y1 `student_general` 현물 1,000,000 → 분모 41,000,000, 6.0976% — 6.25%면 FAIL, 이때 `modifiedDirectCost` 40,000,000) ② 교차 — C·D·I 현물 0·양식에 없는 비목 0·H에 `promotion`이면 `modifiedDirectCost(DEFAULT_INDIRECT_BASE)`와 같음(promotion 픽스처 40,400,000 → 6.6832%)
- [ ] **붙임4형 8-2**(AG-3·부록 C.4): 행 순서·행 대응이 C.4와 같고 픽스처 값(Y1·Y2·합계의 E1·E2·I/E2·K·L·분모·간접비 비율·M·E1/M)과 일치. **기호 혼동 테스트**(Y1 `personnel_support` 현금 4,000,000): E1 44,000,000 ≠ E2 40,000,000, I/E2 7.5%(6.8182%면 FAIL). **H = `activity` + `promotion`**(U-1). 열 = 연차 + 단계 소계(단계 2개 이상) + 합계, 줄 없는 칸 "—"
- [ ] **양식에 없는 비목**(U-2): consignment·international·burden·other 합이 0이 아니면 "양식에 없는 비목" 행 + K·M에 포함(픽스처 Y1 consignment 1,000,000 → K 51,000,000·M 53,500,000) + 검토사항 경고. 0이면 행이 없다. 12비목이 전부 C.4 data 행 또는 이 행 중 **한 곳에만** 들어간다(테스트)
- [ ] **내역 행**(U-3): "(간접비 중 연구실 안전관리비)" 행은 전 칸 **"—"**(0이 아님 — 소스 없음). **"(연구시설·장비비 중 통합관리비(현금))" 행은 보기·엑셀·TSV에 없다**(있으면 FAIL)
- [ ] **붙임4형 8-1**(AG-3): 연차별 행 + 합계 행. A = 그 연차 정부지원 현금(§5.25), B = 그 연차 현금 합 − A, C = 현물 합, D = B+C, H = 현금+현물, A/H, B/D — 픽스처(Y1 66.6667%·42.8571%, Y2 66.4137%·43.5028%, 합계 66.5399%·43.1818%)와 일치, 국제공동 0이면 합계 = `evaluateRules` 비율(교차). **미입력(행 없음)**이면 그 연차 A·B·두 비율 "—" + 사유, 합계 행도 "—". **A = 0(입력)**은 "—"가 아니라 계산된다. A > 현금 합이면 "—" + 경고. 기업유형 "중소기업" 고정 표시, 그 외 기관 지원금 0
- [ ] **8-1 판정**(G-1): RL-8 `gov_share_max`·RL-9 `own_cash_min` 행이 켜져 있고 값이 있을 때만 연차별·합계 판정(경계 `lib/rules.ts`와 같음 — 75/40 전부 통과, `own_cash_min` 43이면 Y1만 미달). 행이 없거나 꺼졌으면 **"판정하지 않음" + 사유**(통과·위반으로 둔갑하면 FAIL). 과제 유형별 값 표로 한도를 정하는 코드가 있으면 FAIL
- [ ] **조정회의형**(AG-4): **변경전 = 제안 모드**(`buildBaselineFromPlan` 변환 → 같은 양식 행 집계), **변경후 = 보고 있는 협약 버전**. A = 양식 E2 · B = I · C = L · D = A+B+C · E = M · F = K, 비율 D/E · B/A · A/F, 머리 간접비 비율(양식 분모). 픽스처(변경전 Y1 86%·7.5%·80%·0%, Y2 "—" / 변경후 Y1 86.6667%·7.5%·80%·6.25%, Y2 90.5123%·7.1429%·84%·6.75%, 합계 88.5932%·7.3171%·82%·6.5%)와 일치. `personnel_support` > 0 케이스에서 A가 C를 빼고 계산된다. 제안 변환 실패(한쪽만 null 불일치)면 변경전에 **사유**(0으로 채우면 FAIL)
- [ ] 비율은 **중간 반올림 없이** 계산하고 표시 단계에서만 자른다. 분모 0이면 "—"(0%·`NaN`·`Infinity` 아님 — 절대 규칙 5). 금액은 원 단위 정수 덧셈만(절대 규칙 4)
- [ ] **참여인원 모델**(AG-5): 정렬(인력 순서, 미지정 뒤 → 연차 순서), 연차 소계·총계, 계산값 = `computeDetailAmount` — 부록 B.7(74,000,000·28%·9개월) → 15,540,000 "자동", 15,540,001이면 "수동". 구분은 **읽을 때 판정**: 연봉 null → "연봉 모름"(계산값 없음 — 0으로 계산하면 FAIL), (현금 = 계산값 & 현물 0) 또는 (현물 = 계산값 & 현금 0) → "자동", 그 밖 "수동". 인력 미지정 행 표시
- [ ] **참여인원 ↔ 금액 줄 대조**(표시만): 연차·축별 Σ참여인원 − Σ(`personnel` + `student_personnel` 줄). 기본 픽스처 0, 미지정 Y2 현금 5,000,000 추가 시 Y2 현금 +5,000,000. 어느 쪽도 자동으로 고치지 않는다
- [ ] **G-3 편집 해석**(`resolveParticipantEdit`): 6케이스(M1 Y1 참여율 60% → 36,000,000 / M1 Y2 개월 10 → 32,000,000 유지 / M2 Y1 25% → 현물 12,500,000 / 새 행 금액 없음 → 현금 6,000,000 / 금액 7,000,000 명시 → 수동 / 연봉 모름·금액 0 행에 연봉 40M → 6,000,000)
- [ ] **8-2 칸 편집 해석**(`form-edit`, S-12): A·B 현금/현물 = (세목, 축) 줄 정확 update/insert/noop · C·D 일반·D 통합 = 입력 − 그 세목 현물을 현금 줄 목표로(음수 `RULE`) · F·G = `resolveCellEdit`(default 흡수) · I·L = 입력 − 그 비목 현물을 현금 셀 목표로 `resolveCellEdit` · H = 입력 − 그 연차·축 `promotion` 합을 `activity` 셀 목표로(음수 `RULE`). 집계·비율·내역·단계·합계 칸·양식 밖 행은 거부. 분기마다 테스트
- [ ] **보내기 확장**(`from-plan`): `buildBaselineFromPlan`이 정부지원 현금을 돌려준다 — 제안 Y1 35,000,000·Y2 null → `{Y1: 35,000,000}`(null 연차 키 없음). Phase 24 `agreement-core` 테스트 무수정 통과
- [ ] **붙임4 파서**(AV-7·부록 C.4): 입력은 셀 격자(`RawSheet[]` — SheetJS 객체가 아님), 출력은 금액 줄 + 연차별 정부지원 현금 + 정합 경고 + blocking. ① "총합 (전체)" 블록 제외 ② 기관 블록 1개면 그것, **여럿이면 `blockIndex` 없이는 `choose-block`**(B열 텍스트 목록) — 회사명·별칭으로 골라 주거나 추측하면 FAIL, 범위 밖 인덱스 blocking ③ 행 종류 data·aggregate(대조, 어긋나면 경고·차액)·ratio(인식만)·memo(연구실 안전관리비 — 값 ≠ 0이면 경고, 줄 0)·**ignored(통합관리비(현금) — 경고 0·줄 0)** ④ **모르는 라벨은 blocking** — 조용히 빠지거나 `default`로 흡수되어 금액이 사라지면 FAIL ⑤ 인건비 A~D는 세목 줄, 나머지는 `default` ⑥ 단위 없음 blocking, 음수·문자·비정수 blocking, 0·빈 칸은 줄 없음, 같은 키 합산 + 경고 ⑦ `N차년도` 열 수 ≠ 과제 연차 수면 경고 + 남는 열 합
- [ ] **8-1 읽기·정합**: 기관마다 금액 행만 읽고 비율 행은 건너뛴다. 고른 8-2 블록의 B열 텍스트와 **같은 파일 안 텍스트가 같은** 행(NFC·공백 정규화)을 쓰고, 0개·2개 이상이면 `plan81Row` 선택 또는 "8-1 쓰지 않음"(정부지원 현금 없음 + 경고). **8-1 A → 버전 정부지원 현금.** 정합(연차별 8-2 현금 합 = A+B, 현물 = C, 합계 = H)이 어긋나거나 E·F ≠ 0이면 경고(위치·차액) — 반영은 막지 않는다
- [ ] 파서 테스트 픽스처: 블록 1개 / 블록 2개 + blockIndex 없음 / 범위 밖 / 8-1 행 텍스트 불일치(행 선택) / "8-1 쓰지 않음" / 8-1 현금 −1,000천원 / 그 외 기관 지원금 ≠ 0 / 모르는 라벨 / 빈 칸·0·음수 / 연차 3열 대 2연차 / 단위 없음 / 집계 행 불일치 / 통합관리비 값 있음 / 연구실 안전관리비 값 ≠ 0. 기대: 줄 합계 105,200,000, 정부지원 현금 {Y1·Y2: 35,000,000}. 실측 구조 익명화 픽스처에서 반영 뒤 붙임4형 E1·E2·K·L·M·비율 = 파일 집계 셀

**붙임4 가져오기 — 파일·경로·미리보기 (§5.21 AV-7, §6.8 I-13, §6.16 IN-8, §9)**
- [ ] 받는 파일은 `.xlsx`·`.xlsm`·`.xls` — 읽기는 **SheetJS, `server-only` 어댑터에서만**(`lib/import-adapter.ts` `readAttachment4Upload`). `xlsx`를 import하는 파일 목록이 늘지 않고 클라이언트 번들(`.next/static`)에 SheetJS 문자열 0. hwpx 경로와 섞지 않는다
- [ ] 파일 크기 10MB(`MAX_UPLOAD_BYTES`) + `next.config.ts` `experimental.serverActions.bodySizeLimit: '11mb'` + 업로드 전 클라이언트 검사. 초과·빈 파일·깨진 파일·암호 파일은 각각 사용자 문구
- [ ] 파일은 `FormData`로, **미리보기와 반영은 같은 파싱 함수** + `fileHash` 대조 — 해시가 다르면 반영 `RULE`. 미리보기에서 보인 금액 줄·정부지원 현금과 반영 결과가 같다(통합 테스트)
- [ ] 미리보기 표시: 고른 블록(B열 텍스트), 단위, 연차 × 비목 합계(현금/현물), 만들 줄 수, 연차별 정부지원 현금, 8-1 정합 결과, 경고·blocking 목록. blocking이 있으면 [반영] 비활성 + 이유
- [ ] 반영 = **작성 중 버전 하나 생성**(G-4 — 보내기와 같은 규칙, 종류·이름 초깃값 `suggestNextVersionMeta`). 참여인원·편성 항목 0, 스냅샷 없음. 작성 중 버전이 있으면 `RULE`(버튼 비활성 + 이유, 우회 호출도 `RULE`). 버전이 있어도 작성 중이 없으면 허용
- [ ] 오류는 전부 명시적(절대 규칙 5): 엑셀 아님·암호·깨진 파일·8-2를 못 찾음·블록 미선택·모르는 라벨·단위 없음 → 사용자 문구. 빈 버전이나 0 금액 버전이 조용히 만들어지면 FAIL. DB 내부 정보 노출 없음(SA-4)

**리포지토리·액션 (§8.6, §9 Agreement Budget)**
- [ ] Phase 25 액션(§9): `setAgreementFormCellAmount`·`setAgreementGovCash`(`actions/agreement.ts`), `addAgreementParticipant`·`updateAgreementParticipant`·`deleteAgreementParticipant`(`actions/agreement-participants.ts`), `previewAttachment4Import`·`commitAttachment4Import`(`actions/agreement-import.ts`), `buildAgreementWorkbook` view 3종 추가, `updateYear` patch `govSupportCash`. 전부 `ActionResult<T>`, Zod, SA-1, 성공 시 `revalidatePath`, 예외를 그대로 던지지 않음, supabase 직접 호출 0. 리포지토리는 `lib/db/agreements.ts`에서 Zod 응답 검증·매퍼 경유(`gov_cash` ↔ `govCash`, `gov_support_cash` ↔ `govSupportCash` 매퍼 테스트), 가드 트리거 → `RuleViolationError`, version 불일치 → `StaleDataError`
- [ ] **정부지원 현금 편집**(`setAgreementGovCash(versionId, yearId, amount | null)`, O-2): 행 없음 + 값 → 삽입 · 행 + 값 → 갱신(0도 저장, 행 유지) · 행 + null → 삭제(미입력) · 없음 + null → 변화 없음. 경합(0행 갱신·삭제, unique 위반) → `STALE`. 확정 버전 → `RULE`(삭제 포함 — 트리거가 DELETE를 막지 않으므로 액션이 막는다). 다른 과제 연차 → `RULE`
- [ ] **제안 연차 정부지원 현금**(`updateYear`): 0 이상 정수 또는 null만 받고(음수·소수 거부), 연구비 경로 revalidate. 제안 규칙 판정·입력 양식 출력 바이트 불변
- [ ] **보내기**(AV-6 ④): 제안 정부지원 현금이 null 아닌 연차만 버전 행으로(픽스처 Y1만), 복제 = 같은 값 새 행, 빈 버전 = 0행 — 통합 테스트
- [ ] **참여인원 편집**(AG-5): 추가·수정·삭제. 인력·연차는 **같은 과제에서만**(액션·트리거 둘 다 거부 — 통합 테스트). 참여율 0~100·개월 0~12·금액 0 이상 정수·역할 100자 이하. 추가 시 연봉 스냅샷·자동 계산, 수정은 G-3대로, 수정 O-1. 확정 버전 추가·수정·**삭제**는 `RULE`, 데이터 불변
- [ ] **8-2 칸 편집**(`setAgreementFormCellAmount`): 작성 중 버전만, **같은 금액 줄**을 바꾸고 비목별 보기에 즉시 같은 값(통합 테스트, AG-1). 집계·비율·내역·단계·합계 칸·양식 밖 행은 `RULE`. O-2 + 경합 `STALE`. 조정회의형은 편집 액션이 없다

**화면 (§7.9, §7.9.8, §12)**
- [ ] 보기 탭: **`[비목별]`·`[붙임4형]`·`[조정회의형]`·`[참여인원]`·`[변경 이력]`**. `[편성 항목·증빙]` 탭은 여전히 숨김(자리표시·"준비 중" 탭이 있으면 FAIL)
- [ ] **제안 모드 매트릭스 아래** "정부지원 현금"(연차별 입력, 비우면 미입력 "—")·"기관부담 현금"(현금 합 − 정부지원, 읽기 전용, 미입력이면 "—") 행. 정부지원 > 현금 합이면 그 연차 경고(저장은 됨), 연차 합 ≠ `govBudget`이면 정보 문구. 저장 실패·`STALE` 명시
- [ ] 붙임4형 보기: 위 8-1(연차별 + 합계, 작성 중 버전에서 정부지원 현금 칸 편집, 판정 "통과/위반/판정하지 않음 + 사유") · 아래 8-2(데이터 칸만 편집, 라벨 **"양식 E1(총 인건비)"·"양식 E2(수정인건비)"** — PL-11 `E1`과 혼동되지 않게, 양식에 없는 비목 행, 연구실 안전관리비 "—", 통합관리비 행 없음, 검토사항). 확정 버전은 편집 칸 없음
- [ ] 조정회의형 보기: **변경전(제안)·변경후(보고 있는 버전) 두 표 나란히**, 읽기 전용, 변경전 변환 실패는 사유, 현재 버전이 아니면 "현재 버전 아님" 표식. 비율 분모 0은 "—"
- [ ] 참여인원 보기: 인력(미지정 "인력 미지정") × 연차 목록, 연봉 스냅샷·계산값·현금·현물·계, **자동/수동/연봉 모름 구별**, 연차 소계·총계, 금액 줄 대조 행. 작성 중 버전에서만 추가·수정(`ParticipantDialog`)·삭제(확인 대화). `RULE`·`STALE`은 배너 또는 ConflictDialog(O-3)
- [ ] `[붙임4 가져오기]` **두 곳**: 제안 모드 툴바 [협약 기준선으로 보내기] 옆 + 수행 모드 버전 0개 안내의 [빈 버전] 옆. 작성 중 버전이 있으면 비활성 + 이유(`draftExistsReason`과 같은 문구). 버전 0개 안내 문구 = "협약 예산 버전이 없습니다 — 제안 모드에서 [협약 기준선으로 보내기]로 만들거나, [붙임4 가져오기]로 가져오거나, [빈 버전]으로 시작하세요". 대화 흐름: 업로드(크기 사전 검사) → 블록 선택(여럿일 때) → 8-1 행 선택/"8-1 쓰지 않음"(필요할 때) → 미리보기 → 반영 → 결과(만든 버전·줄 수 또는 실패 사유)
- [ ] 각 새 보기 툴바 `[엑셀 내려받기]`·`[복사]`(AG-8): Phase 24 공통 부품(`lib/agreement/table.ts`·`TableActions`)을 **수정 없이 재사용**. 엑셀 쓰기는 기존 `lib/input-form-adapter.ts` — **exceljs import 파일 2개 유지**. 시트: 붙임4형 = 작성안내 + "8-1 지원·부담계획" + "8-2 사용계획", 조정회의형 = 한 시트(항목 · 변경전 연차… · 합계 · 변경후 연차… · 합계, `D`·합계 sum 칸), 참여인원 = 한 시트. **비율 칸은 text**(소수 둘째 자리 + `%`, 값 없음 "—"), `sum` 칸 수식 + 결과값, 원 단위, 파일명 라벨 `{버전 이름} 붙임4형` 등. 보기 3종 각각 **exceljs 재로드 값 = TSV** 테스트. [복사] 실패는 배너
- [ ] 인쇄: 보고 있는 보기 하나, 가로, 머리말 과제명·버전 이름·상태·출력일, 버튼·탭 `print:hidden`. 다크 모드 토큰(하드코딩 색 0). `dangerouslySetInnerHTML` 0
- [ ] 과제 개요(§7.3)는 바뀌지 않는다 — 과제 유형·기업 유형 칸 0

**도움말 (§7.16)**
- [ ] 새 slug **`agreement`**: `content/help/agreement.md`(HP-6 형식, 3,500자 이내) + `lib/help.ts` 등록(`HELP_RELATED` budget ↔ agreement). 내용: 8-2 양식 행(양식 `E1`/`E2`와 PL-11 차이)·**양식 분모**(RL-3과 다름)·8-1 연차별 정부지원 현금(미입력 "—", RL-8·RL-9 행으로 판정)·조정회의 **변경전(제안)/변경후(버전)**·참여인원 구분·대응표 요지(**통합관리비(현금) 제외·연구실 안전관리비 "—"**·양식에 없는 비목)·붙임4 가져오기(블록 선택·8-1 행·오류 의미). `content/help/budget.md`는 제안 연차 정부지원 현금 + agreement 연결 한 줄(3,500자 이내). **`calculations.md` 불변**. `HelpLink` 앵커가 실제 절과 일치(`help-content` 테스트). 과제 유형 설명이 있거나 Phase 26 기능(RL-21·RL-22·8-2 비율 판정·편성 항목·증빙·수행 모드 규칙 검증)을 이미 있는 것처럼 설명하면 FAIL

**회귀 없음**
- [ ] **Phase 24 기능 그대로**: 버전 생성(보내기·복제·빈 버전)·확정·확정 취소·메타·삭제·전체 삭제, 비목별 보기 셀 편집(`resolveCellEdit` 5분기), 변경 이력 증감·RL-23(S-20 수치 그대로), 기준·현재 버전, 연차·인력 삭제 차단(H-5a·H-9b) 테스트가 통과. Phase 24 테스트 파일 수정은 **schema_version 단언(6 → `≥ 6` 또는 7), 파괴적 백업 테스트(테이블 수·v7), `agreement-migration.test.ts` (h)의 가드 트리거 목록 단언을 Phase 24 3종으로 거르는 한 줄(새 테이블에도 같은 가드 — 메인 승인), `agreement-export.test.ts`의 "모르는 보기" 예시 리터럴 `'participants'` → `'unknown'`(Phase 25에서 유효한 보기가 됨 — 메인 승인)뿐**이고 계획서 소유권 표와 일치(그 밖 수정 FAIL). 비목별·변경 이력 엑셀 출력 불변
- [ ] **바이트 불변**: 제안 입력 양식(Phase 19 layout·build·style)·목표 양식 출력. `TableActions.tsx`·`lib/agreement/table.ts`·`cell-edit.ts`·`lib/input-form*` diff 0
- [ ] 제안 모드: 매트릭스·잠금(PL-9)·산출근거·규칙 검증 패널·[연구비 규칙]·[인건비] 탭·[급여 반영]·[협약 기준선으로 보내기]·총괄표/산출근거 임포트·제출 서식 내보내기 테스트 통과, 부록 B.7·B.8·B.9 수치 불변
- [ ] **Phase 26 선행 0·과제 유형 0**(grep 근거를 보고서에): `project_type`·`ProjectType`·`projectType` 코드 0, `RuleCode`·`budget_rules` check·`lib/rules-presets.ts`에 RL-20~RL-22 없음, `lib/rules.ts`에 수행 모드 판정 없음, `AgreementItem` 편집 액션·보기 컴포넌트 없음, 편성 항목 탭 없음, 회사명 매칭 코드 0, 양식 전용 저장 칸(테이블·컬럼) 0
- [ ] 목표·목표 양식·hwpx·WBS·간트·칸반·마일스톤·리스크·노트·To-Do·조직원·참여율·백업(v7 왕복·v6 거부) 테스트 전부 통과
- [ ] `npm test`(실행 후 `seed.sql` 복원)·`npm run test:destructive`·`npx tsc --noEmit`·`npm run build`(dev 서버가 꺼진 것 확인 후) 통과. 절대 규칙 1(`service_role` 없음)·2(새 테이블 RLS)·3(UI·액션이 supabase 직접 호출 없음 — Realtime 읽기 구독만 예외)·4(금액 정수)·5(빈 배열 폴백·조용한 0 없음). `samples/` 커밋 0 — 익명화 픽스처만 `tests/fixtures/`
