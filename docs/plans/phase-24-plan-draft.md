# Phase 24 계획 초안 — 협약 예산 버전 + 비목별 보기

> **상태: 초안 (2026-09-30).** planner 산출물을 보존한 것이다. Q1~Q5 사용자 답을 받은 뒤 T0에서 `phase-24-plan.md`로 확정하고 SOT·`evaluation_criteria.md`에 먼저 반영한다. 이 파일은 T0이 끝나면 지운다.

## 사용자 결정 (2026-09-30 확정)
- **U-1**: 변경 이력(AG-7)에 세목 총액 보존 검증(RL-23)을 **Phase 24에 넣는다** — SOT에서 Phase 26 몫인 부분을 24로 당긴다
- **U-2**: 버전 부가정보 중 **IRIS 승인일·공문 번호 필드 삭제**(필요 없는 기능). 나머지 메타는 확정 후에도 편집 가능, 내용(금액·줄·참여인원·편성 항목)은 확정 잠금
- **U-3**: 확정 버전 0개면 현재 버전 = 작성 중 버전("작성 중" 표시)
- **U-4**: [확정 취소]는 가장 마지막 버전이고 그 뒤 버전이 없을 때만
- **U-5**: 최종협약본 삭제 시 기준 = 남은 최종협약 중 가장 최근, 없으면 "기준 버전 없음"·비교 비움. 순번 재매김 없음
- **U-6**: 미구현 보기 탭(붙임4형·조정회의형·참여인원·편성 항목)은 해당 Phase까지 숨김
- 메인 결정(기술): 작성 중 1개는 DB 부분 유일 인덱스, 확정도 expectedVersion 대조, [빈 버전]은 버전이 있어도 허용, 부록 A.4 라벨 추가, 부록 B 예시 없음 → 합성 픽스처(S-20), `schema_version` 6(v5 백업 복원 불가 — 사용자 고지함)

## 사용자 확인 대기 (다음 세션 시작 시 답 받기)
- **Q1 기준 버전 폴백** — U-5 vs AV-5/D-14 충돌. 권고: 앞선 확정 final → 없으면 V 직전 확정 버전 → 없으면 "기준 없음". 기준은 V보다 **앞선** 것으로 제한
- **Q2 보내기의 현금/현물 미분리 셀** — 권고: 현금으로 보내고 대화·결과에 건수 명시(거부하면 Phase 23 이후 인라인 편집 셀마다 막힘)
- **Q3 U-2 해석** — 삭제는 IRIS 승인일·공문 번호 두 필드, **IRIS 신청일은 유지**. 확정 후 편집 가능 메타에 **종류(kind)** 포함(바꾸면 기준 버전이 즉시 재계산)
- **Q4 버전이 있을 때 보내기** — 권고: 작성 중 버전이 없으면 허용 + 확인 대화("직전 버전을 복제하지 않고 제안 편성으로 만든다")
- **Q5 CLAUDE.md 수정 승인** — 순수 모듈 표 `lib/agreement/` 행을 확정 이름으로
- (고지) 협약 버전이 쓰는 **연차·인력은 삭제 차단**(H-9a 선례, S-7·S-8)

## 사전 사실 (코드 확인)
1. exceljs import 파일은 정확히 2개로 테스트가 고정(`lib/input-form-adapter.ts`·`lib/xlsx-style.ts`, `tests/unit/input-form-boundary.test.ts:210`) → 협약 엑셀도 `writeInputFormWorkbook` 재사용, 새 어댑터 없음. 공통 부품 `lib/agreement/table.ts`
2. 어댑터는 수식 셀에 결과값을 안 쓰고 병합 셀 미지원 → 헤더 1행
3. 확정 잠금 DB 트리거는 `restore_backup` 정순 INSERT·연차/인력 FK 연쇄를 막는다 → `restore_backup`(현재 `20260930000000_drop_budget_executions.sql` 207행)에서 `set_updated_meta`처럼 잠시 끈다
4. Phase 23 이후 제안 인라인 총액 편집은 현금/현물을 `null, null`로 저장(`BudgetScreen.tsx:158`) → 미분리 셀 흔함(Q2)
5. 버전 등호 고정 테스트: `tests/integration/phase23-migration.test.ts:160`(`= 5`), `tests/destructive/backup-roundtrip.test.ts:180·206`(`toBe(5)`) → T1에서 `≥ 5`·6
6. 인력 삭제 대화상자는 참조 건수 키에 묶임: `lib/db/members.ts:204`, `components/team/MemberSection.tsx:219` → T8

## T0 결정 목록 (권고안)
| # | 대상 | 권고 결정 |
|---|---|---|
| S-1 | 이름 | 테이블 `agreement_versions`·`agreement_lines`·`agreement_participants`·`agreement_items`. 순수 모듈 `lib/agreement/`(`versions`·`category-view`·`cell-edit`·`from-plan`·`diff`·`preservation`·`changes-table`·`table`). 리포지토리 `lib/db/agreements.ts`. 액션 `actions/agreement.ts` + `actions/agreement-export.ts`. 컴포넌트 `components/budget/agreement/` |
| S-2 | 수행 모드 조회 | `getAgreementData(projectId)` 하나(버전 메타·버전별 비목별 모델·`currentVersionId`·`draftVersionId`·버전별 `baseVersionId`·RL-23 결과·연차·표시 단위). 증감은 `getAgreementChanges(projectId, fromId, toId)`. page.tsx가 `getBudgetPlanData`와 `Promise.all`. 협약 조회 실패는 수행 모드에만 오류 배너 |
| S-3 | §5.21 | kind `selection`·`adjustment`·`final`·`amendment`, noticeType `notice`·`approval`, status `draft`·`confirmed`. `officialDocNo`·`irisApprovedAt` 삭제 → 메타 7개(종류·이름·기준일·변경 사유·통보/승인·IRIS 신청일·비고), 확정 후 편집 가능. `sort_order int`(앱 `order`) `unique(project_id, sort_order)`, 새 버전 max+1. `confirmed_at timestamptz null`, check `(status='confirmed') = (confirmed_at is not null)`, 확정 취소 시 null. 작성 중 1개 = 부분 유일 인덱스 `(project_id) where status='draft'`. 협약변경 차수는 `name`으로 |
| S-4 | 작성 중 1개 / 확정 취소 | 생성 RPC가 먼저 검사해 `RULE`, 23505도 리포지토리가 `RULE`로. [확정 취소]는 `sort_order` = 과제 최댓값일 때만, 버전 트리거가 DB에서도 막음. `expectedVersion` 필수 |
| S-5 | 현재·기준 버전 | 현재 = 확정 중 `sort_order` 최대, 확정 0개면 작성 중(U-3). 기준(V) = V보다 앞선 확정 `final` 중 최근, 없으면 Q1. 순번 재매김 없음 |
| S-6 | 보내기 매핑 | ① 금액 줄: 산출근거 있는 셀은 `budget_details.amount`를 (연차, 비목, 세목, 축)으로 합산, 없는 셀은 `cash_amount`→(…, `default`, 현금)·`in_kind_amount`→(…, 현물), 미분리 셀은 Q2, 합계 0 그룹 생략, 음수 그룹은 위치 적어 `RULE`. ② 참여인원: `formula='personnel'` 산출근거 1행 = 1행, 참여율 `personnelParticipation`, 개월 = 첫 비백분율 인자(없으면 12), 축에 따라 `personnelCash`/`personnelInKind`, `annualSalary` = 보낼 때 Member 연봉 스냅샷, `role` ''. ③ 편성 항목 0건. 순수 함수 `buildBaselineFromPlan` + 단일 트랜잭션 RPC, 상태 작성 중. 버전 있을 때는 Q4 |
| S-7 | §5.22 금액 줄 | `unique(version_id, year_id, category, subcategory_code, axis)`, `amount bigint not null check >= 0`. `year_id` no action — `delete_year`가 선검사 거부("협약 예산 버전 N개가 이 연차를 씁니다 — 해당 버전을 먼저 삭제하세요", `delete_stage`도 경유). 세목 = 부록 A.5 코드 + 모든 비목에 `'default'`(여러 세목 비목에선 라벨 "세목 미지정"), 검증은 액션 Zod(`SUBCATEGORY_PRESETS`) — DB는 목록 모름 |
| S-8 | §5.23 참여인원 | 월급 = 버전 스냅샷 `annual_salary bigint null`. 계산/수동 구분 저장 안 함(읽을 때 판정). 현금/현물 두 금액 컬럼. 금액 줄과 독립(대조는 Phase 25). `member_id` no action — `delete_member`가 H-9a처럼 거부, `count_member_references`에 `agreement_participants` 키 별도. `participation_rate`·`months` numeric check 0~100 / 0~12, 금액 `bigint >= 0` |
| S-9 | §5.24 편성 항목(테이블만) | `evidence jsonb not null default '[]'` check array, `quantity numeric null`, `amount bigint >= 0`, kind check 3종, `year_id` no action. 금액 줄과 합계 대조 없음(Phase 26) |
| S-10 | AG-2 셀 편집 | 셀 = (연차, 비목, 축). 줄 정확히 1개면 그 줄 변경. 0개·2개 이상이면 차액을 `default` 줄이 흡수(없으면 생성), 새 default = 목표 − Σ나머지, 음수면 `RULE`("세목 줄 합계가 이미 목표보다 큽니다"). 0이 된 줄은 금액 0으로 남김. `resolveCellEdit` → update / insert / reject |
| S-11 | AG-8 표 모델 | `TableModel` = 제목 + 헤더 1행 + 행(data/subtotal/total) + 셀(text/amount/sum/empty). 엑셀: sum 칸 `SUM` 수식 + **결과값**(`FormCell.result?` 선택 필드 추가, 있을 때만 씀 → 기존 양식 바이트 불변), 첫 시트 `작성안내`, F-1~F-8·F-10, 파일명 `{과제명}_협약예산_{버전이름 또는 A→B}_{YYYYMMDD}.xlsx`. TSV: 값, 원 단위 정수, 빈 칸 '', 탭·개행·따옴표 셀은 `"…"`(`"`→`""`), 행 구분 `\r\n`. 엑셀·TSV 모두 원 단위. 변경 이력 엑셀: 작성안내 + 금액 증감 + 참여인원 증감 + 세목 총액 보존, 증감 칸 `=B−A` + 결과 |
| S-12 | AG-7 + RL-23 | 줄 증감 키 (연차, 비목, 세목, 축), added/removed/changed/unchanged. 참여인원 키 (memberKey, 연차), null은 연차별 "인력 미지정" 그룹, 비교 Σ현금·Σ현물·(참여율, 개월) 다중집합. RL-23: `lib/agreement/preservation.ts` 순수 함수(`RuleCode`·`budget_rules` 아님 — 켜고 끄기는 Phase 26), 키 (비목, 세목, 축) 전 연차 합, 기준 버전과 비교, 경고만, 기준 없으면 "기준 버전 없음". SOT 수정: §6.14.8 RL-23, §7.9.8 규칙 검증 줄, §11 26행, 상단 Phase 26 요약 |
| S-13 | Realtime | 연구비 화면이 `agreement_versions`·`agreement_lines` 구독, 같은 마이그레이션에서 publication 추가(R-7), 합계 4테이블(R-1 한도 안) |
| S-14 | 확정 잠금 DB 강제 | 하위 3종 BEFORE INSERT/UPDATE 트리거 `agreement_child_guard`: 부모 confirmed면 raise, `version_id` 변경 금지, `year_id`(참여인원은 `member_id`도) 과제 = 버전 과제. DELETE는 막지 않음. 버전 트리거: `project_id`·`sort_order` 변경 금지, confirmed→draft는 마지막 버전만. 액션이 먼저 `RULE`, 트리거는 최후 방어선 |
| S-15 | 액션 | `getAgreementData`, `createAgreementVersionFromPlan(projectId,{kind,name})`, `createEmptyAgreementVersion`, `cloneLatestAgreementVersion`, `updateAgreementVersionMeta(versionId, patch, expectedVersion)`, `confirmAgreementVersion(versionId, expectedVersion)`, `unconfirmAgreementVersion`, `deleteAgreementVersion`, `deleteAllAgreementVersions(projectId)`, `setAgreementCellAmount(versionId, yearId, category, axis, amount)`, `getAgreementChanges`, `buildAgreementWorkbook(projectId, {view:'category',versionId} \| {view:'changes',fromVersionId,toVersionId})` → `{fileName, contentBase64}`. RPC(security invoker): `create_agreement_version(p_project_id,p_kind,p_name,p_lines jsonb,p_participants jsonb)`, `clone_agreement_version(p_source_id,p_kind,p_name)`, `delete_agreement_versions(p_project_id)`. 단일 행 쓰기는 리포지토리 직접 |
| S-16 | 낙관적 잠금 | 메타·확정·확정 취소 `expectedVersion` 필수(O-1). 셀 편집은 O-2 — 클라이언트는 version을 안 보내고 서버가 방금 읽은 줄 version으로 갱신해 경합만 `STALE` |
| S-17 | 화면 | 버전 바: [버전 선택(종류·이름·기준일·상태 배지, 현재·기준 표시)] [새 버전] [빈 버전] [확정] [확정 취소] [버전 정보] [삭제] [전체 버전 삭제]. 작성 중 버전이 있으면 [새 버전]·[빈 버전] 비활성 + 이유. [확정 취소]는 마지막 확정 버전일 때만. 확정·삭제·전체 삭제·확정 취소는 확인 대화(전체 삭제는 버전 수 표시). 탭: 비목별·변경 이력만(U-6). 버전 없을 때: 안내 + [빈 버전] + 제안 모드 [협약 기준선으로 보내기] 안내, 0 매트릭스 금지. 각 보기 [엑셀 내려받기]·[복사](`navigator.clipboard.writeText`, 실패는 배너). 인쇄: 현재 보기, 머리말 과제명·버전 이름·상태·출력일, 버튼 `print:hidden`. 도움말 `content/help/budget.md` "수행 모드 — 협약 예산" 절 + `HelpLink`. 제안 모드 툴바에 [협약 기준선으로 보내기](미분리 건수·줄 수 예고, 결과 토스트) |
| S-18 | 마이그레이션 | `supabase/migrations/20261001000000_agreement_budget.sql`: ① 테이블 4종 + 제약·인덱스 + `set_updated_meta` + RLS(approved users, `is_approved()`, `to authenticated`) ② 가드 트리거 2종 ③ publication 2종 ④ RPC 3종 ⑤ 재정의(최신 정의 전문 복사): `delete_project`(버전 선삭제), `delete_year`(선검사 거부), `count_member_references`·`delete_member`(참여인원 키·거부) ⑥ `restore_backup`: `c_tables`에 `budget_rules` 뒤 4종, 삽입 동안 가드 트리거 disable→enable, 나머지 한 글자도 불변 ⑦ `schema_version = 6` |
| S-19 | 완료 기준 | `evaluation_criteria.md` Phase 24를 T0 결정으로 갱신 |
| S-20 | 합성 픽스처 | 아래 |
| S-21 | 부록 A.4 라벨 | kind: 선정평가본·조정회의본·최종협약본·협약변경. status: 작성 중·확정. noticeType: 통보·승인. item kind: 장비·재료·외주용역. `default` 세목 라벨 "세목 미지정" |
| S-22 | 새 버전 이름 제안 | `suggestNextVersionMeta(versions)`: 없음 → 선정평가본, selection → 조정회의본, adjustment → 최종협약본, final/amendment → `협약변경 {amendment 수+1}차`. 사용자가 고칠 수 있음 |

## S-20 픽스처 (원 단위)
**버전 A** — final, 확정, order 1, 연차 Y1·Y2

| 연차 | 비목/세목 | 축 | 금액 |
|---|---|---|---|
| Y1 | personnel/personnel_internal | 현금 | 30,000,000 |
| Y1 | personnel/personnel_internal | 현물 | 10,000,000 |
| Y1 | material/material_purchase | 현금 | 5,000,000 |
| Y1 | activity/activity_meeting | 현금 | 1,200,000 |
| Y1 | activity/activity_travel_dom | 현금 | 800,000 |
| Y1 | allowance/default | 현금 | 3,000,000 |
| Y1 | indirect/indirect_hr | 현금 | 2,500,000 |
| Y2 | personnel/personnel_internal | 현금 | 32,000,000 |
| Y2 | personnel/personnel_internal | 현물 | 10,000,000 |
| Y2 | material/material_purchase | 현금 | 4,000,000 |
| Y2 | activity/activity_meeting | 현금 | 1,000,000 |
| Y2 | allowance/default | 현금 | 3,000,000 |
| Y2 | indirect/indirect_hr | 현금 | 2,700,000 |

A 합계: Y1 현금 42,500,000·현물 10,000,000·계 52,500,000 / Y2 42,700,000·10,000,000·52,700,000 / 총계 85,200,000·20,000,000·105,200,000. 비목: 인건비 82,000,000 · 재료 9,000,000 · 활동 3,000,000 · 수당 6,000,000 · 간접 5,200,000.

**버전 B** — amendment "협약변경 1차", 작성 중, order 2. A 복제 후: Y1 material_purchase 5,000,000→3,000,000 / Y2 material_purchase 4,000,000→6,000,000 / Y1 activity_travel_dom 삭제 / Y2 activity_travel_intl 500,000 추가 / Y2 indirect_hr 2,700,000→2,900,000.
기대: changed 3 · removed 1 · added 1 · unchanged 9, 순증감 −100,000, B 총계 105,100,000(Y1 49,700,000 / Y2 55,400,000). RL-23: material_purchase 현금 보존, travel_dom −800,000 경고, travel_intl +500,000 경고, indirect_hr +200,000 경고 → 경고 3건.

**참여인원**(A): M1 Y1 50%·12·현금 30,000,000 / Y2 50%·12·현금 32,000,000. M2 Y1 20%·12·현물 10,000,000 / Y2 20%·12·현물 10,000,000. B에서 M2 Y2 → 25%·현물 12,500,000, 인력 미지정 Y2 30%·6개월·현금 5,000,000 추가 → changed 1 · added 1 · unchanged 3.

**셀 편집**(B): Y2 활동비 현금(줄 2개, 1,500,000) → 2,000,000 = default 500,000 신설 / 같은 셀 → 1,700,000 = default 200,000 / → 1,400,000 = reject / Y1 재료비 현금(줄 1개) → 3,500,000 = 그 줄 갱신 / Y1 과제추진비 현금(줄 0개) → 400,000 = promotion/default 신설.

**버전 판정**: [v1 selection 확정, v2 final 확정, v3 amendment 확정, v4 amendment 작성 중] → 현재 v3, 작성 중 v4, base(v4) = v2 / v2 삭제 → Q1 / [v1 작성 중]만 → 현재 v1(작성 중), 기준 없음 / final 둘 → 최근 final / order 1·3·4 → 빈자리 그대로.

**보내기**: Y1 M1 내부인건비 현금 60,000,000×50%×12 = 30,000,000 / M2 현물 50,000,000×20%×12 = 10,000,000 / 재료비 산출근거 없음 현금 5,000,000·현물 0 / 연구수당 3,000,000 미분리 / 회의비 100,000×12 = 1,200,000 / 국내출장비 200,000×4 = 800,000 → 금액 줄 6개(재료비는 `material/default`), 참여인원 2행, 현금 40,000,000(= 37,000,000 + 미분리 3,000,000, Q2 권고 기준)·현물 10,000,000.

## 태스크
웨이브: {T0} → {T1, T2, T3} → {T4, T5, T6, T8} → {T7a, T7b} → {T9a, T9b} → {T10, T11} → {T12}. 각 웨이브 끝에 `tsc` 초록.

| 태스크 | 의존 | 대상 파일 | 완료 기준 요지 |
|---|---|---|---|
| T0 결정 확정 | — | `docs/SOT.md`, `evaluation_criteria.md`, `docs/plans/phase-24-plan.md`(이 초안 대체) | `grep "Phase 24 T0" docs/SOT.md` 0. §5.21(U-2 필드 삭제, `confirmedAt`, U-4)·AV-3·AV-5·§5.22~§5.24·AG-2·AG-7·AG-8·AG-9·§6.14.8 RL-23(Phase 24)·§7.9·§7.9.8·§8.5~§8.8·§9·§10·§11 24/26행·부록 A.4·§6.6 연차/인력 삭제 차단 반영. 평가 기준: 메타 9→7종, [확정 취소], RL-23 항목, "RL-20~RL-23 없음" → "RL-20~RL-22 없음, RL-23은 lib/agreement 순수 함수", 탭 숨김, 작성 중 표시, 기준 삭제 동작, 연차·인력 삭제 차단 |
| T1 마이그레이션·백업 | T0 | 새 마이그레이션, `lib/db/backup.ts`, `tests/destructive/*`, `tests/integration/phase23-migration.test.ts`(`≥ 5`), `tests/integration/agreement-migration.test.ts`(신규) | `db push --db-url` 성공. RLS 4종·bigint·작성 중 2개 거부·확정 하위 쓰기 거부·확정 버전 삭제 cascade 통과·과제 경계(RPC·직접 INSERT)·`delete_project`·`delete_year`/`delete_member` 거부·참여인원 참조 키·확정 취소 마지막만·publication·새 RPC security definer 0. 파괴적: v6 왕복, v5 거부. `restore_backup` diff는 `c_tables`·트리거 on/off만 |
| T2 타입·상수·Zod·매퍼 | T0 | `types/index.ts`, `lib/constants.ts`(`EXPECTED_SCHEMA_VERSION = 6`, 라벨 4종), `lib/db/schema.ts`, `lib/db/mapper.ts`, `tests/unit/mapper.test.ts` | 필드 1:1, 라벨이 enum 전부를 덮는 테스트, `sort_order`↔`order`·evidence 왕복 |
| T3 표 모델 + 어댑터 `result` | T0 | `lib/agreement/table.ts`, `lib/input-form/types.ts`(`FormCell.result?`), `lib/input-form-adapter.ts`, `tests/unit/agreement-table.test.ts`, `tests/unit/agreement-boundary.test.ts` | TSV 이스케이프·정수·sum은 값, FormSheet sum = SUM + result, exceljs 재로드 값 = TSV. `lib/agreement/**`가 xlsx·exceljs·supabase·db·actions import 0, exceljs 파일 2개 유지. 기존 input-form·goal-form·xlsx-style 테스트 무수정 통과 |
| T4 lib/agreement A | T2, T3 | `versions.ts`, `category-view.ts`, `cell-edit.ts`, `from-plan.ts`, `tests/unit/agreement-core.test.ts` | S-20 픽스처로 매트릭스(부록 A.1 순서, 줄 없는 셀 null)·셀 편집 5분기·버전 판정·`canUnconfirm`·`suggestNextVersionMeta`·보내기 매핑. 정수 덧셈만. `lib/budget-plan.ts` 무수정 |
| T5 lib/agreement B | T2, T3 | `diff.ts`, `preservation.ts`, `changes-table.ts`, `tests/unit/agreement-diff.test.ts` | 줄·참여인원 증감 전 분기, RL-23 3건, 기준 없음 ≠ 빈 배열, 변경 이력 표 3종 |
| T6 리포지토리 | T1, T2 | `lib/db/agreements.ts`, `tests/integration/repos-agreements.test.ts` | Zod·매퍼, 23505·트리거 → `RuleViolationError`, version 불일치 → `StaleDataError`, 복제가 하위 3종 새 id로 복사·원본 불변, 전체 삭제는 다른 과제 불변 |
| T8 인력 삭제 차단 표시 | T1, T2 | `lib/db/members.ts`, `components/team/MemberSection.tsx`, 팀 통합 테스트 | 새 키 Zod, 참조 있으면 삭제 비활성 + 이유, 우회 호출도 `RULE`, 기존 H-9a 불변 |
| T7a 액션 | T4, T5, T6 | `actions/agreement.ts`, `tests/integration/agreement-actions.test.ts` | ActionResult·Zod(세목 A.5 + default)·SA-1·revalidatePath. 과제 경계, 확정 쓰기 거부, 작성 중 1개(3경로), 보내기 합계, 제안↔협약 독립, 메타 STALE, 확정 후 메타 편집, 확정 취소 조건, 삭제 cascade, 셀 편집 반영. supabase 직접 호출 0 |
| T7b 내보내기 액션 | T4, T5, T6 | `actions/agreement-export.ts`, `tests/integration/agreement-export.test.ts` | exceljs 재로드로 시트·F-2·F-4·`#,##0`·틀 고정·탭 색·수식+result 확인, 값 = TSV, exceljs 서버 전용 |
| T9b 보기 컴포넌트 | T7a, T7b | `components/budget/agreement/CategoryView.tsx`·`ChangesView.tsx`·`TableActions.tsx` | 작성 중만 편집, 실패는 배너/ConflictDialog, 줄 없는 셀 "—", 증감 4종 구별, 라벨은 A.4, 복사 실패 표시, 다크 토큰, `dangerouslySetInnerHTML` 0 |
| T9a 수행 모드 셸 | T7a, T7b | `AgreementScreen.tsx`·`VersionBar.tsx`·`VersionMetaDialog.tsx`·`NewVersionDialog.tsx` | U-3·U-4·U-6, 작성 중 있으면 새/빈 비활성 + 이유, 버전 없을 때 0 금지·"준비 중" 없음, 인쇄 |
| T10 연구비 화면 통합 | T9a, T9b | `BudgetScreen.tsx`, `app/projects/[id]/budget/page.tsx`, `SendBaselineDialog.tsx` | "준비 중" 0, 모드 `'plan' \| 'agreement'`·기본 제안, [붙임4 가져오기] 없음, 보내기 결과 명시, 협약 조회 실패는 수행 모드만, 제안 테스트 그대로 |
| T11 도움말 | T9a, T9b | `content/help/budget.md`·`calculations.md`, 튜토리얼 해당 시 | 버전·잠금·확정 취소·작성 중 1개·보내기 후 독립·삭제·보기 2종·세목 미지정·RL-23·엑셀/복사(원). "준비 중" 0, Phase 25·26 기능 언급 없음 |
| T12 통합 검증 | T8, T10, T11 | `docs/plans/phase-24-plan.md`(결과 절), `PROGRESS.md` | tsc 0, `npm test`(후 seed 재적용), `test:destructive`, build(:3000 비었는지 먼저). grep: `project_type`·RL-20~22·붙임4 파서·새 SheetJS 읽기 0, `service_role` 0, UI·액션 supabase 직접 0, exceljs 파일 2개. 수동(Tauri): [복사]→엑셀 붙여넣기, 다크·인쇄 — 시드 과제 id 박힌 URL 표 |

**파일 소유권**: `types/index.ts`·`lib/constants.ts`·`lib/db/schema.ts`·`lib/db/mapper.ts` = T2 / `lib/db/backup.ts`·마이그레이션·`tests/destructive/*` = T1 / `lib/input-form/types.ts`·`lib/input-form-adapter.ts` = T3 / `lib/db/members.ts`·`MemberSection.tsx` = T8 / `BudgetScreen.tsx`·`page.tsx` = T10 / `components/budget/agreement/` = T9a(셸 4) · T9b(보기 3) · T10(`SendBaselineDialog`) / `lib/agreement/` = T3(`table.ts`) · T4(4) · T5(3).
