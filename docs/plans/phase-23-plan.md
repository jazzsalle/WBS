# Phase 23 구현 계획 — 집행 관리 삭제 (planner 산출, 2026-09-29)

범위: SOT v4.9 §5.12·§5.12.1, §6.4, §6.10.4, §6.16 IN-2·IN-9~IN-14, §7.2·§7.3·§7.9·§7.9.7·§7.14, §8.7 K-9, §8.8(schema_version 5), §9, §10, §14, 부록 B.4·D.3. 합격 기준 = `evaluation_criteria.md` "## Phase 23".

집행 관리는 RCMS·경영관리팀·정산 시스템 몫이다(D-1). 이 Phase는 **지우기만** 한다 — 협약 예산(Phase 24~26)의 테이블·화면을 미리 만들지 않고, 제안 모드 데이터(`budget_items`·`budget_details`)와 제안 양식은 바꾸지 않는다(D-3).

## 사전 사실

### 코드
- 과제 개요(`app/projects/[id]/page.tsx`)에는 집행률 표시가 **없다** — §7.3 "개요 화면에 남은 집행률 걷어내기"는 걷어낼 것이 없음을 확인만 한다(S-9).
- 옛 v4 백업은 이미 `actions/backup.ts:38`의 스키마 버전 비교(K-5)로 거부된다 — `EXPECTED_SCHEMA_VERSION`을 5로 올리면 별도 가드 없이 v4 파일이 버전 불일치 메시지로 막힌다. 복원 RPC에 새 가드를 넣지 않는 근거(S-12).
- `tests/integration/staff-migration.test.ts:74`가 `schema_version = 4`를 단언한다 — T1에서 `≥ 4`로 바꾼다(그 테스트의 관심은 Phase 16 마이그레이션이 적용됐는가이지 현재 버전이 아니다).
- `lib/db/budget-items.ts` `attachExecutions`가 집행뿐 아니라 **`detailCount`도 붙인다**(PL-9 잠금이 의존). 집행을 떼어낼 때 `detailCount` 부착은 보존해야 한다 → `attachDetailCounts`로 이름을 바꾸고 집행 조회만 뺀다(T8b).
- 셀 상세의 현금/현물 분리 입력칸은 `components/budget/BudgetDetailPanel.tsx`(집행 내역 패널) 안에 있다 — 패널을 지우면 함께 사라진다(S-8).
- `lib/goal-form/parse.ts`가 `readExecutionDate`를, `goal-form-roundtrip` 테스트가 `excelSerialToISO`를 `lib/input-form/parse-execution.ts`에서 import한다 — 그 파일을 지우기 전에 날짜 헬퍼를 옮겨야 한다(T6c).
- `restore_import_snapshot` 최신 정의: `supabase/migrations/20260929000000_goal_form.sql` 1184행~, `executions` 분기 1201·1233~1367행. `restore_backup` 최신 정의: 같은 파일 1510행~ — `c_tables`의 `budget_executions` 1523행, `spec` 기본값 1576행 부근, `detail_id` 2차 복원 1616~1624행.

### DB
- dev DB에 집행 실데이터 없음 — **2026-09-29 확인**(SOT §8.8 — 5). T1이 마이그레이션 적용 직전에 `budget_executions`·`kind='execution_form'` 스냅샷·프로파일 건수를 다시 세어 PROGRESS.md에 기록한다.

## 결정 (S-1~S-12)

사용자 확인이 필요했던 항목(S-2·S-3·S-6·S-8·S-10·S-11)은 **2026-09-29 사용자 확인 — 권고안대로 승인**. 나머지도 같은 날 함께 확정.

| # | 대상 | 결정 | 근거 |
|---|---|---|---|
| S-1 | ImportKind `'execution_form'` | TS 타입·`importKindSchema`·스냅샷 `kind` enum·`import_profiles.kind` check에서 **모두 제거**. 새 check = `('budget_plan','budget_detail','goal_form')`. 마이그레이션은 check 교체 전 `kind='execution_form'` 프로파일 0건을 확인하고, 있으면 `raise` | §5.12.1 "스냅샷 종류로만 쓴다(프로파일은 만들지 않는다)" — 0건이어야 정상이고, 아니면 모르는 데이터이므로 조용히 지우지 않는다 |
| S-2 | 기존 `kind='execution_form'` 스냅샷 | 같은 마이그레이션에서 `delete from import_snapshots where snapshot->>'kind' = 'execution_form'`. 적용 전 건수 기록. **2026-09-29 사용자 확인 — 권고안대로 승인** | 복원 경로(IN-14)가 사라진다. 남겨 두면 kind enum에 없는 값이라 목록 파싱이 깨지거나, 되돌릴 수 없는 행이 목록에 남는다 |
| S-3 | 옛 수행 양식 파일 거부 | `_meta`에 `mode` 행이 있으면 **값과 무관하게** 거부. 검사 순서 IN-2(과제 → 버전 → `mode` 행). 문구: "수행 양식(집행 내역) 파일입니다 — 집행 관리 기능이 삭제되어 올릴 수 없습니다. 제안 모드에서 [입력 양식 내려받기]로 받은 양식을 쓰세요." `INPUT_FORM_VERSION`은 올리지 않는다. **2026-09-29 사용자 확인 — 권고안대로 승인** | IN-2상 제안 양식에는 `mode` 행이 없다 — 행 존재만 보면 코드에 `'execution'` 리터럴이 필요 없다(S-11 grep). 제안 양식 바이트 불변(Phase 19) |
| S-4 | `lib/budget.ts` | **파일 유지**. 삭제: `sumExecutions`·`computeExecutionRate`·`isOffBudgetExecution`·`isOverExecuted`·`computeItemSummary`·`computeYearSummary`·`computeProjectSummary`·`BudgetExecutionInput`. `BudgetSummary`는 `{ planned, cash, inKind }`. `checkYearBudgetMismatch`(B-3)·`buildBudgetMatrix`·매트릭스 타입 유지 | §6.4 B-3·B-4는 계획액 규칙이라 유지. §6.10.4가 `budget-plan.ts`와 합치지 않는다고 정함(기준액 정의가 섞인다) |
| S-5 | `getBudgetMatrix` | **삭제**(`BudgetMatrixData`, `getExecutionDetailOptions`/`ExecutionDetailOptions` 포함). 연구비 페이지는 `getBudgetPlanData`만 쓴다. Phase 24 협약 예산 조회는 Phase 24 T0 | 집행 합계를 싣는 것이 존재 이유였다. 이름만 남기면 Phase 24가 무엇을 채울지 미리 정하는 셈 |
| S-6 | Phase 24 전 수행 모드 | 기본 모드 `제안`. 토글 유지. `[수행]` 선택 시 매트릭스·숫자 없이 안내만: "수행 모드(협약 예산 버전·보기)는 준비 중입니다. 집행 관리는 v4.9에서 삭제되었습니다 — 집행은 RCMS·경영관리팀·정산 시스템에서 관리합니다." 툴바 버튼([엑셀 가져오기]·[입력 양식 내려받기]·[입력 양식 올리기])은 제안 모드 전용. 화면 로컬 모드 값 이름은 `'plan' \| 'agreement'`. **2026-09-29 사용자 확인 — 권고안대로 승인** | 빈 매트릭스에 0을 보이면 데이터 없음과 금액 0을 구별할 수 없다(절대 규칙 5). 값 이름을 지금 `agreement`로 두면 Phase 24가 이름을 다시 바꾸지 않는다 |
| S-7 | 입력 양식 액션 `mode` 인자 | 제거: `buildInputForm(projectId, yearId)`, `previewInputForm(projectId, formData)`. `InputFormMode`·`sheetsFor(mode)`·`MODE_MISMATCH_MESSAGES`·`InputFormPreviewResultOf` 삭제 | 값이 하나뿐인 인자는 호출부에 거짓 선택지를 남긴다. 옛 파일 거부는 S-3이 맡는다 |
| S-8 | `detailCount = 0` 셀의 현금/현물 분리 편집 | `BudgetDetailPanel`과 함께 **삭제**. SOT §7.9 해당 줄을 "분리값은 산출근거 축 또는 총괄표 임포트로만"으로 정정. 제안 모드 총액 인라인 편집(`updateBudgetPlan`)은 유지. 제안 모드에 편집 UI 신설 안 함. **2026-09-29 사용자 확인 — 권고안대로 승인** | 이 Phase는 "지우기만"·"제안 모드 불변"이다. 입력칸을 제안 모드로 옮기면 새 UI를 만드는 것이 된다 |
| S-9 | 대시보드·개요 | 과제 카드의 **예산 줄 통째로 제거**(계획액도 표시 안 함), `ProjectBudgetSummary` 삭제, `lib/db/dashboard.ts`가 `budget_items`를 읽지 않음. 지표 카드 5개(§7.2) 불변. 개요엔 걷어낼 것 없음(사전 사실) | 계획액만 남기면 카드가 무엇을 비교하는지 모호해지고, 읽을 이유가 없는 테이블 조회가 남는다 |
| S-10 | 부록 D.3 문구 | SOT와 `lib/rules-presets.ts:77`을 같은 문자열로: "장비·SW 구입은 종료일 2개월 전까지 (제23조⑥·제25조⑨) — 구입일 데이터 없음(앱은 집행을 관리하지 않는다, D-1)". 68·99행의 "집행 단계"(규정상의 단계)는 유지. **2026-09-29 사용자 확인 — 권고안대로 승인** | 프리셋 문구는 "부록 D.3 문장 그대로"가 규칙이다. "집행 단계"는 앱 기능이 아니라 규정의 시점을 가리킨다 |
| S-11 | "남은 참조 grep 0" 예외 목록 | 아래 **S-11 예외 목록**. **2026-09-29 사용자 확인 — 권고안대로 승인** | 평가 기준의 "새 마이그레이션 0건"은 drop문 때문에 문자 그대로 불가능하다 |
| S-12 | 마이그레이션 방식 | 아래 **S-12 순서**. 복원 함수에 새 가드 추가 안 함 | 옛 v4 백업은 K-5 버전 게이트가 이미 거부한다(사전 사실). `cascade` 없이 drop해야 숨은 의존이 실패로 드러난다 |

### S-11 예외 목록

`evaluation_criteria.md` Phase 23 "남은 참조 grep 0" 항목(`execution` 대소문자 무시·`집행률`·`BudgetExecution`·`budget_executions`)의 예외는 **이 목록을 따른다**(평가 기준 파일의 ①②③ 중 ③ "T0 계획서가 명시해 남긴 위치"가 이 목록이다). T9는 grep 결과가 이 목록과 정확히 일치함을 보고한다.

1. 새 마이그레이션(`supabase/migrations/20260930000000_*.sql`)의 DDL — `drop table`·`drop function commit_execution_form`·스냅샷 `delete`(`'execution_form'`)·kind check 교체 — 와 머리말 주석. **평가 기준의 "새 마이그레이션 0건"은 drop문 때문에 문자 그대로는 불가능**하다 — 이 DDL·주석만 허용한다.
2. 옛 v4 백업 거부 테스트 fixture의 `budget_executions` 키(거부되는 입력 자체가 그 키를 가져야 한다). **T9 보강**: 같은 파일(`tests/destructive/backup-roundtrip.test.ts`) K-1의 부정 단언(v5 내보내기·`BACKUP_TABLES`에 그 키가 **없음**)도 이 범주다 — 평가 기준 "내보내기 JSON에 `budget_executions` 키 없음"을 단언하려면 이름이 있어야 한다. 리터럴은 파일 머리 상수 `DROPPED_TABLE` 한 줄로 모았다.
3. 옛 수행 양식 거부 테스트의 `_meta` `mode` 값 `execution`(실제 옛 파일 모양 재현). **T9 보강**: `tests/unit/input-form-layout.test.ts`의 옛 `_meta` 집행 목록 행 키 `execution:<id>`도 같은 옛 파일 모양 재현이라 이 범주다 — 값·키 모두 상수 `LEGACY_MODE` 한 줄에서 만든다. `tests/integration/input-form-actions.test.ts`는 값 리터럴 한 줄만 남기고 헬퍼·상수 이름에서 `Execution`을 뺐다.
4. DB 잔존 참조 검사 통합 테스트(`tests/integration/phase23-migration.test.ts`)의 `pg_proc`/`pg_policies` 검색 문자열. **T9 보강**: 같은 파일의 삭제 RPC 이름(부재 확인)과 `'execution_form'`(스냅샷·프로파일 0건 확인, `import_profiles.kind` check가 그 값을 23514로 거부하는지 확인)도 검색·거부 대상 문자열이라 이 범주다. 세 리터럴은 머리 상수 `DROPPED_TABLE`·`DROPPED_RPC`·`DROPPED_KIND` 세 줄로 모았고, 머리말·테스트 제목·주석에서는 뺐다.
5. 기존(이전 Phase) 마이그레이션 파일 — 이력.
6. `docs/` — SOT 폐기 표기·계획서.

`input-form-style`·`input-form-adapter` 테스트의 헤더 `'집행일'`은 grep 패턴(`execution`·`집행률`·`BudgetExecution`·`budget_executions`)에 걸리지 않으므로 유지한다.

### S-12 마이그레이션 순서

1. dev DB 집행 건수 확인(`budget_executions`·`kind='execution_form'` 스냅샷·프로파일) → PROGRESS.md 기록
2. `restore_import_snapshot` 재정의 — `executions` 분기와 **그 분기만 쓰는 declare 변수만** 제거. `items`·`details`(D-17a) 경로와 `goals` 키 거부(GF-11)는 한 글자도 불변
3. `restore_backup` 재정의 — `c_tables`의 `budget_executions`, `spec` 기본값, `detail_id` 2차 복원만 제거. Phase 21의 `deliverables`·`tech_targets` 기본값 채움은 그대로
4. `drop function commit_execution_form(<정확한 시그니처>)`
5. 스냅샷 delete(S-2) → `import_profiles.kind` check 교체(S-1, 0건 확인 후 raise)
6. `drop table public.budget_executions` — **`cascade` 없음**(숨은 의존은 실패로 드러나게). 정책·인덱스·Realtime publication 항목은 테이블과 함께 사라진다
7. `app_settings.schema_version = 5` — `lib/constants.ts` `EXPECTED_SCHEMA_VERSION = 5`와 같은 커밋

머리말에 RLS 영향 없음 근거: 새 테이블 없음, 삭제 테이블의 정책은 테이블과 함께 사라짐, 다른 테이블 정책은 `budget_executions`를 참조하지 않음.

## 태스크

- **T0** 결정 확정 — 이 계획서 + SOT 선반영(§5.12.1 주석·§6.16 IN-2 거부 문구·§7.9 기본 모드/Phase 24 전 수행 화면/현금·현물 분리 입력·§7.14 스냅샷·§9 입력 양식 시그니처·§10 `getBudgetMatrix`·§6.10.4 및 §14 `lib/budget.ts`·부록 D.3·v4.9 변경 요약). `grep -n "Phase 23 T0" docs/SOT.md` 0건
- **[AFTER T0][PARALLEL]**
  - **T1** 마이그레이션 + `schema_version` 5 + 백업 — `supabase/migrations/20260930000000_*.sql`, `lib/constants.ts`, `lib/db/backup.ts`, `tests/destructive/*`, `tests/integration/staff-migration.test.ts`(`= 4` → `≥ 4`), `tests/integration/phase23-migration.test.ts`(신규), PROGRESS.md 실데이터 0건 기록
  - **T2** 연구비 화면 수행 모드·집행 UI 제거 — `app/projects/[id]/budget/page.tsx`, `components/budget/BudgetScreen.tsx`·`BudgetMatrix.tsx`, `BudgetDetailPanel.tsx`·`ExecutionDetailRow.tsx`·`input-form/ExecutionFormUpload.tsx` 삭제, `InputFormDownload.tsx`
  - **T3** 대시보드 집행률 제거 — `lib/dashboard.ts`, `lib/db/dashboard.ts`, `components/dashboard/ProjectSummaryCards.tsx`, `app/page.tsx`, `tests/unit/dashboard.test.ts`
  - **T4** `ImportSnapshotPanel` 정리
  - **T5** 도움말·문구 — `content/help/budget.md`·`calculations.md`·`dashboard.md`, `lib/rules-presets.ts`(S-10), 주석들
  - **T6c** 날짜 헬퍼 이관 — `lib/input-form/sheet-date.ts` 신규(`readExecutionDate`·`excelSerialToISO`를 옮김; `lib/goal-form/parse.ts`와 `goal-form-roundtrip` 테스트의 import를 바꿈)
- **[AFTER T2]**
  - **T6b** `actions/input-form.ts` 수행 경로 제거(S-7) + 옛 수행 양식 파일 거부 테스트(S-3)
  - **T7** `actions/budget.ts` 집행 CRUD·`getBudgetMatrix` 제거(S-5). 비집행 단언은 `getBudgetPlanData` 테스트로 이관
- **[AFTER T6b, T6c]** **T6a** `lib/input-form` 수행 모드 제거 + `checkMeta` `mode` 행 거부(S-3)
- **[AFTER T2, T3, T7]** **T8a** `lib/budget.ts` 정리(S-4)
- **[AFTER T3, T4, T6b, T7]** **T8b** 타입·Zod·리포지토리 — `attachExecutions` → `attachDetailCounts`(`detailCount` 부착 보존), `BudgetExecution`·`BudgetItem.executions`·집행 Zod·매퍼 제거, S-1 kind 제거
- **[AFTER 전부]** **T9** 통합 검증 — grep 결과가 S-11 예외 목록과 일치, `npx tsc --noEmit`, `npm test` 후 `seed.sql` 복원, 파괴적 테스트, dev 서버가 꺼진 것 확인 후 `npm run build`

### 의존 그래프

```
T0 ──┬── T1 ───────────────────────────────────────────────┐
     ├── T2 ──┬── T6b ──┐                                   │
     │        └── T7 ───┼──────────┬── T8a (T2,T3,T7) ──────┤
     ├── T3 ────────────┼──────────┤                        │
     ├── T4 ────────────┼──────────┴── T8b (T3,T4,T6b,T7) ──┤
     ├── T5 ────────────┼───────────────────────────────────┤
     └── T6c ───────────┴── T6a (T6b,T6c) ──────────────────┴── T9
```

## T9 검증 결과 (2026-09-29)

### 최종 grep

`grep -rniE "execution|집행률|BudgetExecution|budget_executions" app components actions lib types content tests supabase/migrations/20260930000000_drop_budget_executions.sql` — 22줄. `app/`·`components/`·`actions/`·`lib/`·`types/`·`content/` **0줄**.

| 위치 | 내용 | S-11 |
|---|---|---|
| `tests/destructive/backup-roundtrip.test.ts:38` | `const DROPPED_TABLE = 'budget_executions';` (K-1 부정 단언 2곳 + v4 fixture 2곳이 참조) | ② |
| `tests/integration/input-form-actions.test.ts:204` | `setText(ws, META_DEF, 'value', r0, 'execution');` | ③ |
| `tests/unit/input-form-layout.test.ts:242` | `const LEGACY_MODE = 'execution';` (`mode` 값·`execution:e-1` 키) | ③ |
| `tests/integration/phase23-migration.test.ts:26` | `const DROPPED_TABLE = 'budget_executions';` | ④ |
| `tests/integration/phase23-migration.test.ts:27` | `const DROPPED_RPC = 'commit_execution_form';` | ④ |
| `tests/integration/phase23-migration.test.ts:28` | `const DROPPED_KIND = 'execution_form';` | ④ |
| `supabase/migrations/20260930000000_drop_budget_executions.sql` 2·11·13·16·21·29·31·201·202·335행 | 머리말·단계 주석 | ① |
| 같은 파일 337·346·351·353·365·367행 | `drop function commit_execution_form(...)`·스냅샷 `delete`·프로파일 0건 확인·`raise` 문구·`drop table` 주석·`drop table` | ① |

예외 밖 잔여 0건. `docs/`(⑥)·이전 마이그레이션(⑤)은 grep 대상 밖.

### T9에서 고친 것 (동작 변경 없음)

- grep 패턴 밖 잔여 주석: `actions/budget-plan.ts`의 `getBudgetMatrix`·`BudgetMatrixData` 언급 2곳, `actions/notes.ts`·`actions/risks.ts`의 "`BudgetMatrixData` 선례" → `BudgetPlanData`, `tests/integration/budget-plan-actions.test.ts`의 `getBudgetMatrix` 비교 주석 2곳.
- `tests/destructive/guard.ts` 머리 주석: "나머지 22종은 전부 projects의 하위"가 Phase 16 이후 틀림 → 20종이 하위이고 `staff`·`staff_salaries`는 하위가 아니며 가드 판정에 들어 있지 않다고 사실대로 정정.
- 예외 축소: 위 표의 리터럴을 상수로 모으고, 테스트 제목·머리말·주석에서 `budget_executions`·`execution` 단어를 뺐다.

### DB 잔존 참조

`phase23-migration.test.ts` (a)가 `pg_proc.prosrc ilike '%budget_executions%'`(주석 포함) 0건을 단언한다 — 통과. `commit_execution_form` 문자열은 `commit_goal_form` 본문 **주석** 2줄(156·1028행, "같은 판단"·"같은 창")에만 남는다 — 테이블명이 아니고 호출도 아니다(주석 제거 후 검사 테스트 통과). 재정의하지 않았다.

### 명령 결과

- `npx tsc --noEmit` — 0 오류
- `npm test` — 125 파일 / 3180 테스트 통과
- `npm run test:destructive` — 1 파일 / 11 테스트 통과
- `npm run build` — 성공(:3000 리스너 없음 확인 후)
- 시드: 테스트 전후 모두 dev DB에 시드 과제가 없었다 → `supabase/seed.sql` 재적용, `과제 A`(stages 1·budget_items 24) 복원 확인
