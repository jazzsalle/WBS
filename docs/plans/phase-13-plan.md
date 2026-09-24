# Phase 13 구현 계획 (planner 산출, 2026-09-24) — `/phase-run 13` 재개용

SOT v4.4(§5.18·§6.14·§7.9.5·부록 B.9·D)와 evaluation_criteria.md Phase 13 기준. 설계 결정 8건은 사용자 승인 완료. **이 계획을 그대로 generator에 넘기면 된다** (planner 재실행 불필요).

## 계획에 영향을 준 사실
- 마지막 마이그레이션 `20260816000000_commit_detail_import.sql` → 새 파일 `20260817000000_budget_rules.sql`. Phase 9 파일(`20260813000000_budget_plan_schema.sql`)이 테이블+RLS+`restore_backup` 재정의+`schema_version` 갱신을 한 파일에 담는 본보기. `restore_backup`의 `c_tables`와 `lib/db/backup.ts`의 `RESTORE_TABLES`는 순서까지 일치해야 한다
- dev DB 적용: PROGRESS.md "How to run"의 `npx supabase db push --db-url …pooler…` (암호는 로컬 파일, 커밋 금지)
- `allowanceRateLimit`·`indirectRateLimit` 참조처: `types/index.ts`, `lib/db/schema.ts`, `lib/db/projects.ts`(주석), `lib/budget-plan.ts`(`BudgetRuleProject`·`evaluateBudgetRules`), `actions/budget-plan.ts`(`rateLimitsSchema`·`setBudgetRateLimits`·`BudgetPlanData`), `actions/export.ts`(313-327), `lib/export/summary-sheet.ts`(202), `components/project/BudgetRateLimitCard.tsx`(+`app/projects/[id]/page.tsx`), `components/budget/BudgetPlanSummary.tsx`, 테스트 3종(`budget-plan.test.ts`, `budget-plan-actions.test.ts` 654-722, `dashboard.test.ts` 79-80)
- SOT의 `RateLimitBadges`는 실제로 `BudgetRateLimitCard`(과제 개요) + `BudgetPlanSummary`의 배지
- `evaluateBudgetRules`가 PL-13 분모를 6비목(`INDIRECT_BASE_CATEGORIES`)으로 계산 → 정정 대상. SOT §6.10.4의 시그니처 `evaluateBudgetRules(yearTotals, project)`는 v4.4에서 갱신되지 않았다(아래 확인 3)
- §8.5 구독표에 `budget_rules` 없음 → publication에 추가하지 않는다

## 태스크

### [PARALLEL] T1. 스키마 + 타입 기반 (budget_rules · 한도 컬럼 이관 · schema_version 3)
- 신규 `supabase/migrations/20260817000000_budget_rules.sql`, `tests/integration/budget-rules-migration.test.ts`
- 수정 `lib/constants.ts`(EXPECTED_SCHEMA_VERSION 3 — 이 Phase에서 constants.ts는 T1만), `lib/db/backup.ts`(RESTORE_TABLES에 `budget_rules` — budget_details 뒤·risks 앞), `types/index.ts`(RuleCode·RuleSeverity·IndirectBase·BudgetRule 추가, Project에서 한도 2종 삭제 — types/index.ts는 T1만), `lib/db/schema.ts`(budgetRuleRowSchema 추가, projectRowSchema 두 컬럼 제거), `lib/db/projects.ts` 주석, `tests/unit/dashboard.test.ts` 픽스처
- 마이그레이션: N-4 공통 컬럼(version) + project_id cascade + code/enabled/value numeric/base/severity/source/note, unique(project_id, code), set_updated_meta 트리거, RLS + approved 정책. **check 제약(RL-D2·D3·D5)**: code enum 17 / severity 3 / base 2 / 비율 코드 value null 또는 0~100 / 금액 코드 정수 ≥ 0 / 값 없는 코드 value null / enabled+값 필요 → not null / `(base is not null) = (code='indirect_max')` / `length(trim(source))>0`. 이관 블록을 `-- MIGRATE-RATE-LIMITS:BEGIN/END` 주석으로 감싼다(테스트가 추출): allowance → `allowance_max`(error, source '과기부고시 제2026-38호 제26조①'), indirect → `indirect_max`(base `direct_cash_excl_intl_consign_burden`, source '(Phase 9 입력값 이관)'), null은 행 없음, 이후 컬럼 drop. `restore_backup` c_tables에 `budget_rules` 추가. RPC `apply_rule_preset(p_project_id, p_mode, p_rows jsonb) returns jsonb {added, updated, kept}` — 행 배열을 받아 한 트랜잭션에서 fill/overwrite. `schema_version = 3`
- 절차: 파일 작성 → K-6 백업 1회 → db push → `select schema_version` = 3 → 통합 테스트. **T1 push 뒤에야 T2·T5·T6 통합 테스트가 돈다**
- 완료: 이관 테스트(sql.begin 안에서 컬럼 임시 add → 과제 3개(둘 다/indirect만 null/둘 다 null) → 마커 SQL → 행 2/1/0 → rollback), check 제약 6종 거부 테스트, 백업 테스트·`npm test` 통과. tsc는 budget-plan·actions·Card·summary-sheet·export에서 깨진다 — T3·T5·T6이 고친다(허용된 과도기)

### [AFTER: T1] T2. 리포지토리 `lib/db/budget-rules.ts`
- listByProject / getByCode / insert / update(id, patch, expectedVersion?) — O-1 `.eq('version')` 패턴 / deleteByCode / applyPreset → rpc. 23505 → ConflictError, 23514 → RuleViolationError
- 통합 테스트 `tests/integration/budget-rules-repo.test.ts`: 삽입·조회·STALE·CONFLICT·check 위반·applyPreset fill/overwrite 건수

### [AFTER: T1] T4. 프리셋 `lib/rules-presets.ts` (부록 D)
- source 타입을 템플릿 리터럴로 강제: 접두 `과기부고시` 또는 `기후부고시` + 공백 + 조문. PresetId `msit_profit` | `moe_energy_sme`. gov_share_max는 `{ value: 75, alternatives: [{ value: 67, label: '혁신제품형' }] }`. ADVISORIES 프리셋별 D.3 문장(㉠ 17, ㉡ 8). RULE_SPECS는 T3의 rules.ts
- 단위 테스트: D.1 10행·D.2 17행 1:1 대조, source 접두, 기본 75·후보 67, 두 프리셋 base 상이

### [AFTER: T4] T3. 순수 함수 `lib/rules.ts` + `lib/budget-plan.ts` 분모 정정
- 신규 `lib/rules.ts`, `tests/unit/rules.test.ts`, `tests/unit/rules-boundary.test.ts`. 수정 `lib/budget-plan.ts`(T3만), `tests/unit/budget-plan.test.ts`, `lib/export/summary-sheet.ts` 호출부만, `docs/SOT.md` §6.10.4 시그니처(코드보다 먼저)
- budget-plan.ts: `BudgetRuleProject` 삭제. `evaluateBudgetRules(yearTotals, indirectBase)` → E1·비율·기준액만(한도·over 삭제). `INDIRECT_BASE_CATEGORIES` → `DIRECT_CATEGORIES`(11비목). 수정직접비는 rules.ts `modifiedDirectCost` import(정의 1곳). `modifiedPersonnel`·`personnelParticipation(detail)` export. summary-sheet는 `DEFAULT_INDIRECT_BASE`로 호출(T6이 과제 규칙 base로 교체)
- rules.ts: RULE_SPECS(17), modifiedDirectCost(yearTotals, base), evaluateRules(rules, input) → RuleEvaluation(§6.14.6 + YearRatio {yearId|null, actual, limit, enabled, numerator, denominator}). input = { years:[{yearId, totals, rows:[{detail, amount, member?}]}], project:{govBudget, ownBudget, totalBudget} }
- 완료(전부 테스트): B.9.1 수치(0.9622 / 0 / allowance_min info 1 / 0 / 0 approximate / 69.2308, 67→error / 11.35 approximate, ownBudget 90,000,000→1.5 error / RL-10~13·17~19 없음), B.9.2(RL-14 A 1건, RL-16 C 1건, RL-15 통과→B 30%면 error, E1 44,500,000), B.9.3(35,000,000 warn / 12,000,000+9,000,000 합산 warn 1건 / 29,990,000 없음 / 30,000,000 warn), B.9.4 skipped 사유, PL-13 정정(promotion 현금 1,000,000 케이스 / 위탁 있을 때 두 base 상이), enabled=false → ratios만, RL-16 같은 Member 5%+5% 통과·student 제외, 한도 69.23에 69.2308 error(원값 비교), 경계 테스트(supabase/next/fetch·`annualSalary`·`unitPrice` 곱셈 없음), budget-plan.test B.7 유지, 프리셋↔RULE_SPECS 정합

### [AFTER: T2, T3] T5. 액션 4종 + getBudgetPlanData 개편 + setBudgetRateLimits 삭제
- 신규 `actions/budget-rules.ts`, `tests/integration/budget-rules-actions.test.ts`. 수정 `actions/budget-plan.ts`(T5만), `tests/integration/budget-plan-actions.test.ts`(654-722 교체). 삭제 `components/project/BudgetRateLimitCard.tsx`, `app/projects/[id]/page.tsx` 참조 제거
- 액션: listBudgetRules / upsertBudgetRule(projectId, code, patch, expectedVersion?) / deleteBudgetRule / applyRulePreset(projectId, presetId, mode). Zod가 RULE_SPECS로 RL-D2·D3·D5. BudgetPlanData: 한도·projectVersion 제거, `rules`·`ruleEvaluation` 추가. yearRules base = indirect_max 행 base, 없으면 DEFAULT_INDIRECT_BASE
- 완료: 4액션 정상/VALIDATION 4종/STALE+O-3/applyRulePreset fill 보존·overwrite 덮음·건수/남의 과제 NOT_FOUND; getBudgetPlanData B.7+moe_energy_sme → allowance_min info 1, ratios.indirect_max 0.9622; 행 끄면 findings 사라지고 ratios 유지; 규칙 0건이면 yearRules 비율 그대로; `grep setBudgetRateLimits` 0건

### [AFTER: T5] T6. Phase 11 내보내기 전 확인 — 규칙 findings 경고
- `actions/export.ts` 313-327 대체(listBudgetRules + evaluateRules → notice kind 'rule-finding'), `lib/export/types.ts`, `summary-sheet.ts`(과제 규칙 base), 테스트. blockers에 절대 넣지 않음(error finding 있어도 커밋 성공). B.7 왕복·0.9622% 유지

### [AFTER: T5] T7. 규칙 검증 패널 `components/budget/rules/RuleFindingsPanel.tsx`
- 수정 `BudgetPlanSummary.tsx`(한도 배지·개요 링크 제거)·`BudgetScreen.tsx`(패널 배치·클릭 이동 — T7 시점 소유, 툴바 버튼은 T9)
- ① 비율 표 RL-3~9 × 연차(RL-8·9 과제 열), 꺼져도 표시, 4자리, 서버 값 ② findings severity 순, year 클릭→열 강조, detail 클릭→셀 패널+행 강조 ③ skipped 접힌 목록 ④ "근사" 배지 ⑤ 0건 안내 + onOpenRules ⑥ 수행 모드 없음 ⑦ 인쇄 토큰 유지

### [AFTER: T5] T8. 편집 패널 `RulesEditor`·`PresetPicker`·`AdvisoryList` (BudgetScreen 안 건드림)
- [채우기] 즉시 / [덮어쓰기] 2단계 확인 → "추가 N · 갱신 M · 유지 K". 규칙 표 인라인 편집 → upsert(expectedVersion), STALE 시 ConflictDialog. gov_share_max 75/67 셀렉트+직접 입력. 삭제 확인 "이 검사가 사라집니다". AdvisoryList 읽기 전용, 상단 문구, 미저장. 값 없는 코드는 값 칸 비활성

### [AFTER: T7, T8] T9. 연결 + 회귀·위생 마감
- `BudgetScreen.tsx` 툴바 [연구비 규칙](제안 모드만)·모달·refresh, SOT §10 파일명 정리, PROGRESS. `grep "allowanceRateLimit\|indirectRateLimit\|RateLimit\|setBudgetRateLimits"` 0건, `npm test`·tsc·build 통과, 체크리스트 자체 점검 기록

**의존 그래프**: T1 → {T2, T4}; T4 → T3; {T2, T3} → T5; T5 → {T6, T7, T8}; {T7, T8} → T9. 병렬 구간: T2‖T4, T6‖T7‖T8.

## 확인 4건 — 2026-09-24 제안값으로 확정, SOT에 반영됨 (§6.10.4·§7.9·§9)
1. `indirect_max` 행이 없을 때 비율 표시용 분모 — 제안: `DEFAULT_INDIRECT_BASE = 'direct_cash_excl_intl_consign_burden'`(이관 마이그레이션과 동일), 화면에 어느 분모인지 표기
2. `overwrite`가 프리셋에 없는 코드의 기존 행을 지우는가 — 제안: 프리셋에 있는 코드만 덮고 나머지는 "유지"(삭제 안 함)
3. SOT §6.10.4 시그니처 `evaluateBudgetRules(yearTotals, project)` → `(yearTotals, indirectBase)`로 정정(T3이 코드보다 먼저)
4. Realtime: `budget_rules`를 publication에 넣지 않는다(다른 PC 변경은 새로고침) — 이대로 둘지
