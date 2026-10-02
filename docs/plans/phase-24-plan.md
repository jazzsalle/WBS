# Phase 24 구현 계획 — 협약 예산 버전 + 비목별 보기 (planner 산출 2026-09-30, T0 확정 2026-10-02)

범위: SOT v4.9 §5.1·§5.21~§5.24, §6.6(H-5a·H-9b), §6.14.8 RL-23, §6.19 AG-1·AG-2·AG-7~AG-9, §7.9·§7.9.8, §8.5, §8.6, §8.7 K-9, §8.8(`schema_version` 6), §9 Agreement Budget, §10, §11 24, 부록 A.4. 합격 기준 = `evaluation_criteria.md` "## Phase 24".

수행 모드 = **협약 예산 버전**이다(D-3·D-4). 이 Phase의 보기는 **비목별(AG-2)과 변경 이력(AG-7) 두 개**다. 참여인원(§5.23)·편성 항목(§5.24)은 테이블만 만들고 편집 화면은 만들지 않는다 — 보내기·복제·삭제·백업·증감 계산이 두 테이블을 빠뜨리지 않는지만 본다. Phase 25(붙임4형·조정회의형·참여인원 보기, 붙임4 가져오기, 과제 유형)와 Phase 26(수행 모드 규칙 판정·RL-20~RL-22·`RuleCode`, 편성 항목·증빙 화면)은 만들지 않는다. **단 RL-23(세목 총액 보존)은 이 Phase에 넣는다**(U-1) — `lib/agreement/` 순수 함수로, `RuleCode`·`budget_rules`가 아니다.

## 사용자 결정 (2026-09-30)
- **U-1**: 변경 이력(AG-7)에 세목 총액 보존 검증(RL-23)을 **Phase 24에 넣는다** — SOT에서 Phase 26 몫이던 부분을 24로 당긴다. 규칙 행으로 켜고 끄기는 Phase 26
- **U-2**: 버전 부가정보 중 **IRIS 승인일·공문 번호 필드 삭제**. 나머지 메타는 확정 후에도 편집 가능, 내용(금액 줄·참여인원·편성 항목)은 확정 잠금
- **U-3**: 확정 버전이 0개면 현재 버전 = 작성 중 버전("작성 중" 표시)
- **U-4**: [확정 취소]는 가장 마지막 버전이고 그 뒤 버전이 없을 때만
- **U-5**: 최종협약본을 지우면 기준 = 남은 최종협약본 중 가장 최근. 순번 재매김 없음(Q1로 정밀화 — 아래)
- **U-6**: 미구현 보기 탭(붙임4형·조정회의형·참여인원·편성 항목)은 해당 Phase까지 숨김
- 메인 결정(기술): 작성 중 1개는 DB 부분 유일 인덱스, 확정도 `expectedVersion` 대조, [빈 버전]은 버전이 있어도 허용(작성 중이 없을 때), 부록 A.4 라벨 추가, 부록 B 예시 없음 → 합성 픽스처(S-20), `schema_version` 6(v5 백업 복원 불가 — 사용자 고지함)

## 확정 결정 (2026-10-02 사용자 답 — 모두 권고안대로)
- **Q1 기준 버전**: 버전 V의 기준 버전 base(V) = ① V보다 앞선(`order`가 작은) 확정 `final` 중 가장 최근 → ② 없으면 V 직전 확정 버전(V보다 앞선 확정 버전 중 가장 최근) → ③ 없으면 **"기준 버전 없음"**(비교 비움). 기준은 항상 V보다 **앞선** 버전만이다. U-5는 ①(final 사이 선택 규칙)으로 읽고 D-14의 폴백 ②를 유지한다
- **Q2 미분리 셀**: 보내기에서 산출근거 없는 셀 중 현금·현물이 **둘 다 null이고 계획액 > 0**인 셀은 계획액 전부를 **현금**으로 보낸다. 보내기 확인 대화와 결과에 그 건수(와 합계)를 명시한다
- **Q3 메타**: 삭제 필드는 **IRIS 승인일·공문 번호 두 개**. IRIS 신청일은 유지. 확정 후에도 편집 가능한 메타 **7개** = 종류·이름·기준일·변경 사유·통보/승인·IRIS 신청일·비고. **종류(kind)를 포함**한다 — 바꾸면 기준 버전이 즉시 재계산된다(파생 값)
- **Q4 버전이 있을 때 보내기**: 작성 중 버전이 없으면 허용한다. 확인 대화 "직전 버전을 복제하지 않고 제안 편성으로 새로 만듭니다". 작성 중 버전이 있으면 `RULE`(AV-2)
- **Q5**: CLAUDE.md 순수 모듈 표 `lib/agreement/` 행 갱신 — 메인이 완료
- (고지 완료) 협약 버전이 쓰는 **연차·인력은 삭제 차단**(H-9a 선례 — S-7·S-8, SOT §6.6 H-5a·H-9b)

## 사전 사실 (코드 확인)
1. exceljs import 파일은 정확히 2개로 테스트가 고정(`lib/input-form-adapter.ts`·`lib/xlsx-style.ts`, `tests/unit/input-form-boundary.test.ts:210`) → 협약 엑셀도 `writeInputFormWorkbook` 재사용, 새 어댑터 없음. 공통 부품 `lib/agreement/table.ts`
2. 어댑터는 수식 셀에 결과값을 안 쓰고 병합 셀 미지원 → 헤더 1행
3. 확정 잠금 DB 트리거는 `restore_backup` 정순 INSERT·연차/인력 FK 연쇄를 막는다 → `restore_backup`(현재 `20260930000000_drop_budget_executions.sql` 207행)에서 `set_updated_meta`처럼 잠시 끈다
4. Phase 23 이후 제안 인라인 총액 편집은 현금/현물을 `null, null`로 저장(`BudgetScreen.tsx:158`) → 미분리 셀 흔함(Q2)
5. 버전 등호 고정 테스트: `tests/integration/phase23-migration.test.ts:160`(`= 5`), `tests/destructive/backup-roundtrip.test.ts:180·206`(`toBe(5)`) → T1에서 `≥ 5`·6
6. 인력 삭제 대화상자는 참조 건수 키에 묶임: `lib/db/members.ts:204`, `components/team/MemberSection.tsx:219` → T8

## 결정 (S-1~S-22)
| # | 대상 | 결정 |
|---|---|---|
| S-1 | 이름 | 테이블 `agreement_versions`·`agreement_lines`·`agreement_participants`·`agreement_items`. 순수 모듈 `lib/agreement/`(`versions`·`category-view`·`cell-edit`·`from-plan`·`diff`·`preservation`·`changes-table`·`table`). 리포지토리 `lib/db/agreements.ts`. 액션 `actions/agreement.ts` + `actions/agreement-export.ts`. 컴포넌트 `components/budget/agreement/` |
| S-2 | 수행 모드 조회 | `getAgreementData(projectId)` 하나(버전 메타·버전별 비목별 모델·`currentVersionId`·`draftVersionId`·버전별 `baseVersionId`·버전별 RL-23 결과·연차·표시 단위). 증감은 `getAgreementChanges(projectId, fromId, toId)`. page.tsx가 `getBudgetPlanData`와 `Promise.all`. 협약 조회 실패는 수행 모드에만 오류 배너(제안 모드는 그대로 보인다) |
| S-3 | §5.21 | kind `selection`·`adjustment`·`final`·`amendment`, noticeType `notice`·`approval`, status `draft`·`confirmed`. `officialDocNo`·`irisApprovedAt` 삭제(U-2·Q3) → 메타 7개(종류·이름·기준일·변경 사유·통보/승인·IRIS 신청일·비고), **확정 후에도 편집 가능**(종류 포함 — 바꾸면 기준 버전 즉시 재계산). `sort_order int`(앱 `order`) `unique(project_id, sort_order)`, 새 버전 = 과제 최댓값 + 1(첫 버전 1). `confirmed_at timestamptz null`, check `(status='confirmed') = (confirmed_at is not null)`, 확정 취소 시 null. 작성 중 1개 = 부분 유일 인덱스 `(project_id) where status='draft'`. 협약변경 차수는 `name`으로(별도 번호 없음) |
| S-4 | 작성 중 1개 / 확정 취소 | 생성 RPC가 먼저 검사해 `RULE`, 23505(부분 유일 인덱스)도 리포지토리가 `RULE`로. [확정 취소]는 그 버전이 **과제의 마지막 버전**(`sort_order` = 과제 최댓값)일 때만(U-4) — 버전 트리거가 DB에서도 막는다. 확정·확정 취소 모두 `expectedVersion` 필수 |
| S-5 | 현재·기준 버전 | 현재 = 확정 중 `sort_order` 최대, 확정 0개면 작성 중 버전(U-3, "작성 중" 표시), 버전 0개면 없음. 기준(V) = Q1 규칙: ① V보다 앞선 확정 `final` 중 최근 → ② V 직전 확정 버전 → ③ "기준 버전 없음". 버전을 지워도 순번 재매김 없음(빈자리 그대로) |
| S-6 | 보내기 매핑 | ① 금액 줄: 산출근거 있는 셀은 `budget_details.amount`를 (연차, 비목, 세목, 축)으로 합산. 산출근거 없는 셀은 `cash_amount`→(…, `default`, 현금)·`in_kind_amount`→(…, `default`, 현물). **미분리 셀(현금·현물 둘 다 null, 계획액 > 0)은 계획액 전부를 (…, `default`, 현금)으로**(Q2) — 확인 대화와 결과에 건수·합계 명시. 한쪽만 null인 셀은 null을 0으로 보되, 현금 + 현물 ≠ 계획액이면 위치(연차·비목)를 적어 `RULE`(조용히 금액을 잃지 않는다). 합계 0 그룹 생략, 음수 그룹은 위치 적어 `RULE`. ② 참여인원: `formula='personnel'` 산출근거 1행 = 1행, 참여율 `personnelParticipation`, 개월 = 첫 비백분율 인자(없으면 12), 축에 따라 `personnelCash`/`personnelInKind`, `annualSalary` = 보낼 때 Member 연봉 스냅샷, `role` ''. ③ 편성 항목 0건. 순수 함수 `buildBaselineFromPlan` + 단일 트랜잭션 RPC, 상태 **작성 중**. 버전이 이미 있어도 작성 중 버전이 없으면 허용(Q4) — 확인 대화 "직전 버전을 복제하지 않고 제안 편성으로 새로 만듭니다". 작성 중 버전이 있으면 `RULE` |
| S-7 | §5.22 금액 줄 | `unique(version_id, year_id, category, subcategory_code, axis)`, `amount bigint not null check >= 0`. `year_id` FK no action — `delete_year`가 선검사 거부("협약 예산 버전 N개가 이 연차를 씁니다 — 해당 버전을 먼저 삭제하세요", `delete_stage`도 이를 거친다). 세목 = 부록 A.5 코드 + 모든 비목에 `'default'`(여러 세목 비목에선 라벨 "세목 미지정"), 검증은 액션 Zod(`SUBCATEGORY_PRESETS`) — DB는 목록을 모른다 |
| S-8 | §5.23 참여인원 | 월급 출처 = 버전 스냅샷 `annual_salary bigint null`. 계산/수동 구분은 저장하지 않는다(읽을 때 판정). 현금/현물 두 금액 컬럼. 금액 줄과 독립(대조는 Phase 25). `member_id` FK no action — `delete_member`가 H-9a처럼 거부, `count_member_references`에 `agreement_participants` 키 별도. `participation_rate`·`months` numeric check 0~100 / 0~12, 금액 `bigint >= 0` |
| S-9 | §5.24 편성 항목(테이블만) | `evidence jsonb not null default '[]'` check `jsonb_typeof = 'array'`, `quantity numeric null`, `amount bigint >= 0`, kind check 3종, `year_id` FK no action(S-7과 같은 선검사). 금액 줄과 합계 대조 없음(Phase 26 T0에서 다시 본다) |
| S-10 | AG-2 셀 편집 | 셀 = (연차, 비목, 축). 그 셀의 줄이 정확히 1개면 그 줄을 바꾼다. 0개·2개 이상이면 차액을 `default` 줄이 흡수(없으면 생성): 새 default = 목표 − Σ나머지 줄, 음수면 `RULE`("세목 줄 합계가 이미 목표보다 큽니다"). 0이 된 줄은 지우지 않고 금액 0으로 남긴다. 순수 함수 `resolveCellEdit` → update / insert / reject |
| S-11 | AG-8 표 모델 | `TableModel` = 제목 + 헤더 1행 + 행(data/subtotal/total) + 셀(text/amount/sum/empty). 엑셀: sum 칸 = `SUM` 수식 + **결과값**(`FormCell.result?` 선택 필드 추가, 있을 때만 씀 → 기존 양식 바이트 불변), 첫 시트 `작성안내`, 부록 F F-1~F-8·F-10, 파일명 `{과제명}_협약예산_{버전이름 또는 A→B}_{YYYYMMDD}.xlsx`. TSV: 값(수식 없음), 원 단위 정수(구분 기호 없음), 빈 칸 '', 탭·개행·따옴표가 든 셀은 `"…"`(`"`→`""`), 행 구분 `\r\n`. 엑셀·TSV 모두 원 단위(표시 단위 환산 없음). 변경 이력 엑셀: 작성안내 + 금액 증감 + 참여인원 증감 + 세목 총액 보존, 증감 칸 `=B−A` 수식 + 결과 |
| S-12 | AG-7 + RL-23 | 줄 증감 키 (연차, 비목, 세목, 축), added/removed/changed/unchanged. 참여인원 키 (memberKey, 연차) — `memberId` null은 연차별 "인력 미지정" 한 그룹, 비교 = Σ현금·Σ현물·(참여율, 개월) 다중집합. RL-23: `lib/agreement/preservation.ts` 순수 함수(`RuleCode`·`budget_rules` 아님 — 켜고 끄기는 Phase 26), 키 (비목, 세목, 축)의 전 연차 합을 기준 버전(S-5)과 비교 — 한쪽에 없는 키는 0, 다르면 경고(차액 표시), 저장·확정을 막지 않는다. 기준이 없으면 "기준 버전 없음"(빈 결과와 구별되는 값). 변경 이력 보기의 세목 총액 보존 절은 비교의 **이후 버전 B와 base(B)**를 비교한다(비교 기준 A와 별개). 두 버전 선택 초깃값 = A: 보고 있는 버전의 직전 버전, B: 보고 있는 버전. SOT 수정: §6.14.8 RL-23, §7.9.8 규칙 검증 줄, §11 24·26행, 상단 Phase 24·26 요약 |
| S-13 | Realtime | 연구비 화면이 `agreement_versions`·`agreement_lines`를 추가 구독, 같은 마이그레이션에서 publication 추가(R-7). 연구비 화면 합계 4테이블(R-1 한도 안). `agreement_participants`·`agreement_items`는 이 Phase에 화면이 없어 구독하지 않는다 |
| S-14 | 확정 잠금 DB 강제 | 하위 3종 BEFORE INSERT/UPDATE 트리거 `agreement_child_guard`: 부모가 confirmed면 raise, `version_id` 변경 금지, `year_id`(참여인원은 `member_id`도)의 과제 = 버전의 과제. DELETE는 막지 않는다(버전 삭제 cascade — AV-4). 버전 트리거: `project_id`·`sort_order` 변경 금지, confirmed→draft는 마지막 버전만. 액션이 먼저 `RULE`로 거부하고 트리거는 최후 방어선 |
| S-15 | 액션 | `getAgreementData`, `previewAgreementBaseline(projectId)`(보내기 확인 대화 미리보기, 쓰기 없음, 같은 조회·계산 경로 — T7a 추가, SOT §9 반영), `createAgreementVersionFromPlan(projectId,{kind,name})`, `createEmptyAgreementVersion(projectId,{kind,name})`, `cloneLatestAgreementVersion(projectId,{kind,name})`, `updateAgreementVersionMeta(versionId, patch, expectedVersion)`, `confirmAgreementVersion(versionId, expectedVersion)`, `unconfirmAgreementVersion(versionId, expectedVersion)`, `deleteAgreementVersion(versionId)`, `deleteAllAgreementVersions(projectId)`, `setAgreementCellAmount(versionId, yearId, category, axis, amount)`, `getAgreementChanges(projectId, fromVersionId, toVersionId)`, `buildAgreementWorkbook(projectId, {view:'category',versionId} \| {view:'changes',fromVersionId,toVersionId})` → `{fileName, contentBase64}`(`actions/agreement-export.ts`). RPC(security invoker, 과제 경계 검증): `create_agreement_version(p_project_id,p_kind,p_name,p_lines jsonb,p_participants jsonb)`, `clone_agreement_version(p_source_id,p_kind,p_name)`, `delete_agreement_versions(p_project_id)`. 단일 행 쓰기(메타·확정·확정 취소·버전 삭제·셀 편집)는 리포지토리가 직접 |
| S-16 | 낙관적 잠금 | 메타·확정·확정 취소는 `expectedVersion` 필수(O-1). 셀 편집은 O-2 — 클라이언트는 version을 보내지 않고 서버가 방금 읽은 줄의 version으로 갱신해 그사이 경합만 `STALE` |
| S-17 | 화면 | 버전 바: [버전 선택(종류·이름·기준일·상태 배지, 현재·기준 표시)] [새 버전] [빈 버전] [확정] [확정 취소] [버전 정보] [삭제] [전체 버전 삭제]. 작성 중 버전이 있으면 [새 버전]·[빈 버전] 비활성 + 이유("작성 중 버전 ○○이 있습니다 — 확정하거나 삭제한 뒤 만드세요"). [확정 취소]는 마지막 확정 버전일 때만(그 뒤 버전이 없을 때). 확정·확정 취소·삭제·전체 삭제는 확인 대화(전체 삭제는 버전 수 표시). [버전 정보]는 메타 7개 편집 — 확정 버전에서도 열린다. 탭: **비목별·변경 이력만**(U-6 — 나머지 4종은 해당 Phase까지 숨김, 자리표시 탭 없음). 버전이 없을 때: 숫자 없이 안내("협약 예산 버전이 없습니다 — 제안 모드에서 [협약 기준선으로 보내기]로 만들거나 [빈 버전]으로 시작하세요") + [빈 버전], 0 매트릭스 금지. 각 보기 [엑셀 내려받기]·[복사](`navigator.clipboard.writeText`, 실패는 배너). 인쇄: 보고 있는 보기 하나, 가로(P-R1 예산 매트릭스와 같다), 머리말 = 과제명·버전 이름·상태·출력일, 버전 바·탭·버튼은 `print:hidden`. 도움말 `content/help/budget.md` "수행 모드 — 협약 예산" 절 + `HelpLink`. 제안 모드 툴바에 [협약 기준선으로 보내기](확인 대화에 미분리 건수·만들 줄 수 예고, 버전이 있으면 Q4 문구, 결과 토스트) |
| S-18 | 마이그레이션 | `supabase/migrations/20261001000000_agreement_budget.sql`: ① 테이블 4종 + 제약·인덱스 + `set_updated_meta` + RLS(approved users, `is_approved()`, `to authenticated`) ② 가드 트리거 2종 ③ publication 2종 ④ RPC 3종 ⑤ 재정의(최신 정의 전문 복사): `delete_project`(버전 선삭제), `delete_year`(선검사 거부), `count_member_references`·`delete_member`(참여인원 키·거부) ⑥ `restore_backup`: `c_tables`에 `budget_rules` 뒤 4종, 삽입 동안 가드 트리거 disable→enable, 나머지는 한 글자도 불변 ⑦ `schema_version = 6` |
| S-19 | 완료 기준 | `evaluation_criteria.md` Phase 24를 이 결정으로 갱신(T0) |
| S-20 | 합성 픽스처 | 아래 |
| S-21 | 부록 A.4 라벨 | AgreementVersionKind: selection 선정평가본 · adjustment 조정회의본 · final 최종협약본 · amendment 협약변경. AgreementVersionStatus: draft 작성 중 · confirmed 확정. AgreementNoticeType: notice 통보 · approval 승인. AgreementItemKind: equipment 장비 · material 재료 · outsourcing 외주용역. 세목 `default` 라벨 "세목 미지정"(여러 세목 비목에서 — 세목이 `default`뿐인 비목은 부록 A.5 표시 그대로) |
| S-22 | 새 버전 이름 제안 | `suggestNextVersionMeta(versions)`: 없음 → selection·"선정평가본", 마지막이 selection → adjustment·"조정회의본", adjustment → final·"최종협약본", final/amendment → amendment·`협약변경 {amendment 수+1}차`. 사용자가 고칠 수 있다(새 버전·빈 버전·보내기 대화 공통) |

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
기대: changed 3 · removed 1 · added 1 · unchanged 9, 순증감 −100,000, B 총계 105,100,000(Y1 49,700,000 / Y2 55,400,000). RL-23(base(B) = A): material_purchase 현금 보존(9,000,000 = 9,000,000), travel_dom −800,000 경고, travel_intl +500,000 경고, indirect_hr +200,000 경고 → 경고 3건.

**참여인원**(A): M1 Y1 50%·12·현금 30,000,000 / Y2 50%·12·현금 32,000,000. M2 Y1 20%·12·현물 10,000,000 / Y2 20%·12·현물 10,000,000. B에서 M2 Y2 → 25%·현물 12,500,000, 인력 미지정 Y2 30%·6개월·현금 5,000,000 추가 → changed 1 · added 1 · unchanged 3.

**셀 편집**(B, 순서대로): Y2 활동비 현금(줄 2개 — meeting 1,000,000 + travel_intl 500,000 = 1,500,000) → 2,000,000 = default 500,000 신설 / 같은 셀 → 1,700,000 = default 200,000 / → 1,400,000 = reject(default −100,000) / Y1 재료비 현금(줄 1개) → 3,500,000 = 그 줄 갱신 / Y1 과제추진비 현금(줄 0개) → 400,000 = promotion/default 신설.

**버전 판정**:
- [v1 selection 확정, v2 final 확정, v3 amendment 확정, v4 amendment 작성 중] → 현재 v3, 작성 중 v4, base(v4) = v2, base(v3) = v2, base(v2) = v1, base(v1) = 기준 없음. `canUnconfirm`: 모두 false(마지막 버전 v4는 작성 중)
- 위에서 v2 삭제 → [v1 selection 확정, v3 amendment 확정, v4 amendment 작성 중]: **base(v4) = v3**(앞선 확정 final 없음 → 직전 확정 버전), base(v3) = v1, base(v1) = 기준 없음. 현재 v3. order 1·3·4 그대로(재매김 없음)
- 다시 v4 삭제 → `canUnconfirm(v3)` = true, 그 외 false
- [v1 작성 중]만 → 현재 v1(작성 중), base(v1) = 기준 없음
- final 둘 [v1 final 확정, v2 final 확정, v3 amendment 작성 중] → base(v3) = v2(최근 final), base(v2) = v1
- 종류 변경(확정 후 메타 편집): v2를 지운 목록에서 v1을 final로 바꾸면 base(v4) = v1(앞선 확정 final), base(v3) = v1 — 저장하지 않으므로 즉시 바뀐다

**보내기**: Y1 M1 내부인건비 현금 60,000,000×50%×12 = 30,000,000 / M2 현물 50,000,000×20%×12 = 10,000,000 / 재료비 산출근거 없음 현금 5,000,000·현물 0 / 연구수당 3,000,000 미분리(현금·현물 null) / 회의비 100,000×12 = 1,200,000 / 국내출장비 200,000×4 = 800,000 → 금액 줄 6개(재료비는 `material/default` 현금, 연구수당은 `allowance/default` 현금), 참여인원 2행(연봉 스냅샷 60,000,000·50,000,000), 현금 40,000,000(= 37,000,000 + 미분리 3,000,000, Q2)·현물 10,000,000, 미분리 1건·3,000,000 보고.

## 태스크
웨이브: {T0} → {T1, T2, T3} → {T4, T5, T6, T8} → {T7a, T7b} → {T9a, T9b} → {T10, T11} → {T12}. 각 웨이브 끝에 `tsc` 초록.

| 태스크 | 의존 | 대상 파일 | 완료 기준 요지 |
|---|---|---|---|
| T0 결정 확정 | — | `docs/SOT.md`, `evaluation_criteria.md`, `docs/plans/phase-24-plan.md`(초안 대체) | `grep "Phase 24 T0" docs/SOT.md` 0. §5.1·§5.21(U-2 필드 삭제, `confirmedAt`, U-4, 부분 유일 인덱스, 메타 확정 후 편집)·AV-3·AV-5·AV-6·§5.22~§5.24·§6.6 H-5a·H-9b·§6.14.8 RL-23(Phase 24)·AG-2·AG-7·AG-8·AG-9·§7.9·§7.9.8·§8.5~§8.8·§9·§10·§11 24/26행·부록 A.4 반영. 평가 기준 갱신 |
| T1 마이그레이션·백업 | T0 | 새 마이그레이션, `lib/db/backup.ts`, `tests/destructive/*`, `tests/integration/phase23-migration.test.ts`(`≥ 5`), `tests/integration/agreement-migration.test.ts`(신규) | `db push --db-url` 성공. RLS 4종·bigint·작성 중 2개 거부·확정 하위 쓰기 거부·확정 버전 삭제 cascade 통과·과제 경계(RPC·직접 INSERT)·`delete_project`·`delete_year`/`delete_stage`/`delete_member` 거부·참여인원 참조 키·확정 취소 마지막만·publication·새 RPC security definer 0. 파괴적: v6 왕복, v5 거부. `restore_backup` diff는 `c_tables`·트리거 on/off만 |
| T2 타입·상수·Zod·매퍼 | T0 | `types/index.ts`, `lib/constants.ts`(`EXPECTED_SCHEMA_VERSION = 6`, 라벨 4종), `lib/db/schema.ts`, `lib/db/mapper.ts`, `tests/unit/mapper.test.ts` | 필드 1:1, 라벨이 enum 전부를 덮는 테스트, `sort_order`↔`order`·evidence 왕복 |
| T3 표 모델 + 어댑터 `result` | T0 | `lib/agreement/table.ts`, `lib/input-form/types.ts`(`FormCell.result?`), `lib/input-form-adapter.ts`, `tests/unit/agreement-table.test.ts`, `tests/unit/agreement-boundary.test.ts` | TSV 이스케이프·정수·sum은 값, FormSheet sum = SUM + result, exceljs 재로드 값 = TSV. `lib/agreement/**`가 xlsx·exceljs·supabase·db·actions import 0, exceljs 파일 2개 유지. 기존 input-form·goal-form·xlsx-style 테스트 무수정 통과 |
| T4 lib/agreement A | T2, T3 | `versions.ts`, `category-view.ts`, `cell-edit.ts`, `from-plan.ts`, `tests/unit/agreement-core.test.ts` | S-20 픽스처로 매트릭스(부록 A.1 순서, 줄 없는 셀 null)·셀 편집 5분기·버전 판정(Q1 포함)·`canUnconfirm`·`suggestNextVersionMeta`·보내기 매핑(미분리 Q2·한쪽 null 불일치 거부). 정수 덧셈만. `lib/budget-plan.ts` 무수정 |
| T5 lib/agreement B | T2, T3 | `diff.ts`, `preservation.ts`, `changes-table.ts`, `tests/unit/agreement-diff.test.ts` | 줄·참여인원 증감 전 분기, RL-23 3건, 기준 없음 ≠ 빈 배열, 변경 이력 표 3종 |
| T6 리포지토리 | T1, T2 | `lib/db/agreements.ts`, `tests/integration/repos-agreements.test.ts` | Zod·매퍼, 23505·트리거 → `RuleViolationError`, version 불일치 → `StaleDataError`, 복제가 하위 3종 새 id로 복사·원본 불변, 전체 삭제는 다른 과제 불변 |
| T8 인력 삭제 차단 표시 | T1, T2 | `lib/db/members.ts`, `components/team/MemberSection.tsx`, 팀 통합 테스트 | 새 키 Zod, 참조 있으면 삭제 비활성 + 이유, 우회 호출도 `RULE`, 기존 H-9a 불변 |
| T7a 액션 | T4, T5, T6 | `actions/agreement.ts`, `tests/integration/agreement-actions.test.ts` | ActionResult·Zod(세목 A.5 + default)·SA-1·revalidatePath. 과제 경계, 확정 쓰기 거부, 작성 중 1개(3경로), 보내기 합계·미분리 건수, 버전 있을 때 보내기(Q4), 제안↔협약 독립, 메타 STALE, 확정 후 메타 편집(종류 포함), 확정 취소 조건, 삭제 cascade, 셀 편집 반영. supabase 직접 호출 0 |
| T7b 내보내기 액션 | T4, T5, T6 | `actions/agreement-export.ts`, `tests/integration/agreement-export.test.ts` | exceljs 재로드로 시트·F-2·F-4·`#,##0`·틀 고정·탭 색·수식+result 확인, 값 = TSV, exceljs 서버 전용 |
| T9b 보기 컴포넌트 | T7a, T7b | `components/budget/agreement/CategoryView.tsx`·`ChangesView.tsx`·`TableActions.tsx` | 작성 중만 편집, 실패는 배너/ConflictDialog, 줄 없는 셀 "—", 증감 4종 구별, RL-23 경고·"기준 버전 없음" 구별, 라벨은 A.4, 복사 실패 표시, 다크 토큰, `dangerouslySetInnerHTML` 0 |
| T9a 수행 모드 셸 | T7a, T7b | `AgreementScreen.tsx`·`VersionBar.tsx`·`VersionMetaDialog.tsx`·`NewVersionDialog.tsx` | U-3·U-4·U-6, 작성 중 있으면 새/빈 비활성 + 이유, 버전 없을 때 0 금지·"준비 중" 없음, 인쇄 |
| T10 연구비 화면 통합 | T9a, T9b | `BudgetScreen.tsx`, `app/projects/[id]/budget/page.tsx`, `SendBaselineDialog.tsx` | "준비 중" 0, 모드 `'plan' \| 'agreement'`·기본 제안, [붙임4 가져오기] 없음, 보내기 확인·결과 명시(미분리 건수, Q4 문구), 협약 조회 실패는 수행 모드만, Realtime 2테이블 구독, 제안 테스트 그대로 |
| T11 도움말 | T9a, T9b | `content/help/budget.md`·`calculations.md`, 튜토리얼 해당 시 | 버전·잠금·확정 취소·작성 중 1개·보내기 후 독립·미분리 셀 현금·삭제(연차·인력 삭제 차단 포함)·보기 2종·세목 미지정·RL-23(기준 버전 규칙)·엑셀/복사(원). "준비 중" 0, Phase 25·26 기능 언급 없음 |
| T12 통합 검증 | T8, T10, T11 | `docs/plans/phase-24-plan.md`(결과 절), `PROGRESS.md` | tsc 0, `npm test`(후 seed 재적용), `test:destructive`, build(:3000 비었는지 먼저). grep: `project_type`·RL-20~22·붙임4 파서·새 SheetJS 읽기 0, `service_role` 0, UI·액션 supabase 직접 0, exceljs 파일 2개. 수동(Tauri): [복사]→엑셀 붙여넣기, 다크·인쇄 — 시드 과제 id 박힌 URL 표 |

**파일 소유권**: `types/index.ts`·`lib/constants.ts`·`lib/db/schema.ts`·`lib/db/mapper.ts` = T2 / `lib/db/backup.ts`·마이그레이션·`tests/destructive/*` = T1 / `lib/input-form/types.ts`·`lib/input-form-adapter.ts` = T3 / `lib/db/members.ts`·`MemberSection.tsx` = T8 / `BudgetScreen.tsx`·`page.tsx` = T10 / `components/budget/agreement/` = T9a(셸 4) · T9b(보기 3) · T10(`SendBaselineDialog`) / `lib/agreement/` = T3(`table.ts`) · T4(4) · T5(3).

## T12 검증 결과 (2026-10-03)

### 명령
| 명령 | 결과 |
|---|---|
| `npx tsc --noEmit` | 0 오류 (T12 수정 후 재확인 0) |
| `npm test` | **134 파일 · 3442 테스트 통과**(251.7s). 실패 0 — 재실행·수정 불필요 |
| 시드 재적용 | `npm test` 뒤 과제 A 사라짐 → `supabase/seed.sql`을 `TEST_DATABASE_URL`로 재적용, `aaaa0000-0000-4000-8000-000000000001` '과제 A' 확인 |
| `npm run test:destructive` | **1 파일 · 13 테스트 통과**(16.5s). afterAll `removeSeed`로 시드 다시 사라짐(기존 동작) → 재적용·확인 |
| `npm run build` | :3000 LISTEN 없음 확인 후 성공(`/projects/[id]/budget` 77.8 kB). T12 수정 후 재빌드도 성공. `.next/static`에 `exceljs`·SheetJS 문자열 0 |
| `npx vitest run tests/unit` (T12 수정 후) | 85 파일 · 2719 테스트 통과 |

### T12에서 고친 것
- `components/budget/BudgetScreen.tsx:113·345·349` — 제안 툴바 [협약 기준선으로 보내기]가 작성 중 버전이 있어도 켜져 있었다(대화 안에서만 비활성). 평가 기준 "작성 중 버전이 있으면 비활성 + 이유"에 맞춰 버튼 자체를 비활성하고 `title`에 `draftExistsReason`(VersionBar와 같은 문구)을 보인다. 대화의 서버 미리보기 재검사는 그대로.

### grep·경계
| 검사 | 결과 |
|---|---|
| `project_type`/`projectType` (app·actions·components·lib·types·migrations·content) | 0 |
| `RL-20~RL-22` | 0. `lib/rules.ts`·`lib/rules-presets.ts`·`lib/budget-plan.ts` git diff 없음, `types/index.ts` diff에 `RuleCode` 변경 없음 |
| RL-23이 `RuleCode`·`budget_rules`·마이그레이션 check에 | 0 (`lib/agreement/preservation.ts`에만) |
| 붙임4 파서·조정회의형·참여인원/편성 항목 보기 | 0 — `AgreementScreen.tsx:27` 주석과 확인 대화 문구(복제·삭제 대상 설명)만 |
| 새 SheetJS 읽기 경로 | 0 — `xlsx` import는 기존 `lib/import-adapter.ts`·`lib/export-adapter.ts`뿐(둘 다 git 미수정) |
| `service_role` | 코드 0 — `lib/db/*.ts`·`lib/hr-key.ts` 주석만(기존) |
| UI·액션 supabase 직접 호출 | 0 — `actions/*`는 `import type { SupabaseClient }`만, `.from(`·`.rpc(` 없음. `.channel(`은 `components/RealtimeRefresher.tsx:123`(Realtime 예외) |
| exceljs import 파일 | 정확히 2개: `lib/input-form-adapter.ts`, `lib/xlsx-style.ts` |
| `dangerouslySetInnerHTML` | 노트·도움말 경로 0 — `MarkdownViewer.tsx:4`·`lib/notes.ts:5` 주석만 |
| "준비 중" (components/budget·app/projects·content·lib/help.ts) | 0 |
| 새 빈 배열 폴백 | `catch → []` 0. `?? []` 4곳(`lib/db/agreements.ts:140·303·357·405`)은 모두 `if (error) raiseDbError` 다음의 PostgREST `data` null 정규화이고 결과가 빈 페이지·`StaleDataError`·`NotFoundError`로 이어진다 — 기존 `budget-details.ts:105`·`budget-items.ts:143`과 같은 패턴, 오류를 삼키지 않음 |
| `officialDocNo`·`irisApprovedAt`·`official_doc_no`·`iris_approved_at` | 0 — 테스트의 "없음" 단언(`agreement-migration.test.ts:222-223`, `mapper.test.ts:560` 주석)만 |
| `samples/` 추적 파일 | 0 |

### 평가 기준 매핑 (`evaluation_criteria.md` Phase 24)
| 기준 | 근거 | 판정 |
|---|---|---|
| 테이블 4종·컬럼·bigint·check | `20261001000000_agreement_budget.sql`; `agreement-migration.test.ts:190` '금액 컬럼은 bigint…', `:222-223` 삭제 컬럼 없음, `:234` set_updated_meta | 충족 |
| 제약·작성 중 부분 유일 인덱스 | 마이그레이션 `:63-64`; `agreement-migration.test.ts:273·286·303` | 충족 |
| RLS 4종 | 마이그레이션 `:165-183`; `agreement-migration.test.ts` (a) describe `:167` | 충족 |
| FK 연쇄·delete_project | `agreement-migration.test.ts:319`(cascade)·`:490` delete_project | 충족 |
| 연차·인력 삭제 차단 | `agreement-migration.test.ts:569·584·615`(H-9a 불변); `team-actions.test.ts:657` H-9b | 충족 |
| 확정 잠금 DB 강제 | `agreement-migration.test.ts:319·378·410·446·470` | 충족 |
| RPC 3종 invoker·경계 | `agreement-migration.test.ts:249`(security definer 0)·`:394·435` | 충족 |
| schema_version 6 | `lib/constants.ts:46`; `agreement-migration.test.ts:262`; `agreement-labels.test.ts:113`; phase23 `≥` 단언 통과 | 충족(`db push`는 메인이 완료) |
| Realtime | 마이그레이션 `:261`; `agreement-migration.test.ts:242`; `page.tsx:22` 4테이블 | 충족 |
| BACKUP 4종·restore_backup diff | `lib/db/backup.ts:39`; `agreement-migration.test.ts:725` (c_tables 순서·가드 on/off) | 충족 |
| v6 왕복 | `backup-roundtrip.test.ts:276`(협약 픽스처 `:154-186`, 가드 재활성 `:395`) | 충족 |
| v5 거부 | `backup-roundtrip.test.ts:501` describe '옛 v4·v5 백업 거부'(메시지 일치·"데이터가 없습니다" 아님·데이터 불변) | 충족 |
| 파괴적 테스트 갱신 | `guard.ts` 30종 주석, destructive 13/13 | 충족 |
| lib/agreement 모듈·경계 | `agreement-boundary.test.ts:140`; rules·budget-plan diff 0 | 충족 |
| 비목별 모델 | `agreement-core.test.ts:60-134` | 충족 |
| resolveCellEdit 5분기 | `agreement-core.test.ts:153-190` | 충족 |
| 현재·기준 버전·canUnconfirm·suggest | `agreement-core.test.ts:235-332` | 충족 |
| buildBaselineFromPlan | `agreement-core.test.ts:376-523` | 충족 |
| 증감 | `agreement-diff.test.ts:95-255` | 충족 |
| RL-23 | `agreement-diff.test.ts:264·282·293·308` | 충족 |
| 표 모델·TSV·엑셀 일치 | `agreement-table.test.ts:160-438`, `agreement-diff.test.ts:320-414` | 충족 |
| 리포지토리·매퍼·오류 변환 | `repos-agreements.test.ts` 전체, `mapper.test.ts:539-628` | 충족 |
| 액션 ActionResult·Zod·경계 | `agreement-actions.test.ts:310·453·639`, `agreement-export.test.ts:531·546` | 충족 |
| 과제 경계 3경로 | 액션 `agreement-actions.test.ts:453`, RPC `agreement-migration.test.ts:394`, 직접 INSERT `:410`, 리포 `repos-agreements.test.ts:541` | 충족 |
| 확정 = 내용 잠금, 메타 편집 | `agreement-actions.test.ts:548·564·698`, `repos-agreements.test.ts:327·439` | 충족 |
| 확정 취소 | `agreement-actions.test.ts:711·721`, `repos-agreements.test.ts:376`, 트리거 `agreement-migration.test.ts:446` | 충족 |
| 작성 중 1개 3경로·동시 | `agreement-actions.test.ts:399`, `repos-agreements.test.ts:465·481` | 충족 |
| 복제 | `agreement-actions.test.ts:578`, `repos-agreements.test.ts:221`, `agreement-migration.test.ts:633` | 충족 |
| 보내기·독립성·Q4 | `agreement-actions.test.ts:321·369·470·652·679` | 충족 |
| 삭제 | `agreement-actions.test.ts:738·755`, `repos-agreements.test.ts:499·517`, `agreement-migration.test.ts:707` | 충족 |
| 낙관적 잠금 | `agreement-actions.test.ts:487·531`, `repos-agreements.test.ts:286·363·414·431` | 충족 |
| 엑셀 내려받기 | `agreement-export.test.ts:371·429·446·501·516`; exceljs 2파일; 번들 exceljs 0 | 충족 |
| "준비 중" 교체·모드·툴바·오류 배너 | `BudgetScreen.tsx:50·95·388`, `page.tsx:38·70-71`; grep "준비 중" 0 | 충족 |
| 버전 없는 과제 | `AgreementScreen.tsx:35` 안내 + [빈 버전] | 충족(수동 확인 대상) |
| 버전 바 | `VersionBar.tsx:4·42·240·252·257`, `VersionMetaDialog.tsx` 메타 7개 | 충족(수동 확인 대상) |
| 보내기 버튼·대화 | `SendBaselineDialog.tsx:37·130·215-227`; `BudgetScreen.tsx:345`(T12 수정) | 충족(T12에서 버튼 비활성 보강) |
| 보기 탭 2개 | `AgreementScreen.tsx:28-30` | 충족 |
| 비목별 보기 | `CategoryView.tsx`, `agreement-actions.test.ts:412·548` | 충족(수동 확인 대상) |
| 변경 이력 보기 | `ChangesView.tsx`, `AgreementScreen.tsx:75` 초깃값 | 충족(수동 확인 대상) |
| [엑셀]·[복사] | `TableActions.tsx` | **Tauri 클립보드 실검증은 사람 몫 — 아래 표** |
| 인력 화면 H-9b | `MemberSection.tsx:223·838-870`, `team-actions.test.ts:657` | 충족 |
| 인쇄·다크 | `AgreementScreen.tsx:87·92·123` `print:hidden`, `:189` landscape; agreement 컴포넌트 하드코딩 색 grep 0 | 충족(수동 확인 대상) |
| 도움말 | `content/help/budget.md` "수행 모드 — 협약 예산" 절, `calculations.md:56-60`; `help-content.test.ts:224`; `HelpLink` `AgreementScreen.tsx:88·143` | 충족 |
| 회귀 | `npm test` 3442 전부 통과(제안·입력 양식 바이트·목표·hwpx·백업 등) | 충족 |
| Phase 25·26 선행 0 | grep 표 | 충족 |
| 명령 4종·절대 규칙 1·3·5 | 위 표 | 충족 |

충족 못 한 기준: 없음(자동 검증 기준). Tauri 데스크톱 클립보드 쓰기·엑셀 붙여넣기·다크·인쇄는 아래 수동 확인으로 남는다.

### 수동 확인 주소 (dev 서버 `npm run dev` 또는 Tauri, 시드 과제 A)
시드에는 인력·산출근거·금액이 없다 — 보내기 확인 전에 제안 모드에서 셀 금액 몇 칸(현금/현물 미분리 포함)과 인력(연봉)·인건비 산출근거 1행을 넣는다.

| 주소 | 확인할 동작 |
|---|---|
| http://localhost:3000/projects/aaaa0000-0000-4000-8000-000000000001/budget | [수행] 전환 → 버전 없음 안내(숫자·0 매트릭스 없음) + [빈 버전]. [빈 버전]으로 첫 버전 만들기(종류·이름 초깃값 "선정평가본") |
| 같은 주소, [제안] | [협약 기준선으로 보내기]: 확인 대화의 줄 수·참여인원 행 수·미분리 건수·합계("현금으로 보냅니다"), 버전이 있으면 "직전 버전을 복제하지 않고 제안 편성으로 새로 만듭니다", 결과 토스트. 작성 중 버전이 있으면 버튼 비활성 + 마우스 올림 이유 |
| 같은 주소, [수행] → [비목별] | 작성 중 버전 셀 편집 → 합계 즉시 반영, 여러 세목 칸은 "세목 미지정" 흡수, 세목 줄 합계 초과는 오류 표시. 줄 없는 칸 "—" |
| 같은 주소, 버전 바 | [확정] 확인 대화 → 셀 읽기 전용, [버전 정보] 7개 편집(확정 후에도, 공문 번호·IRIS 승인일 칸 없음), 종류를 최종협약본으로 바꾸면 기준 표식 이동. [새 버전](복제) 후 앞 버전 [확정 취소] 숨김, 마지막 확정 버전만 [확정 취소]. [삭제]·[전체 버전 삭제(N개)] 확인 대화 |
| 같은 주소, [변경 이력] | A = 직전, B = 보고 있는 버전 초깃값, 추가/삭제/변경/불변 구별, 세목 총액 보존 경고 또는 "기준 버전 없음"(경고 0건과 다르게 보임) |
| 같은 주소, 각 보기 [엑셀 내려받기]·[복사] | xlsx 첫 시트 `작성안내`, 합계 칸 수식, 원 단위. [복사] 후 엑셀에 붙여넣기 → 같은 행·열, 숫자로 인식. **Tauri 앱에서 클립보드 쓰기 성공 여부**(실패 시 배너) |
| 같은 주소, Ctrl+P | 보고 있는 보기 하나, 가로, 머리말 과제명·버전 이름·상태·출력일, 버전 바·탭·버튼 없음 |
| http://localhost:3000/settings | 다크 모드로 바꾼 뒤 위 연구비 주소로 돌아가 수행 모드 버전 바·표·대화 색 확인 |
| http://localhost:3000/projects/aaaa0000-0000-4000-8000-000000000001/team | 보내기로 참여인원에 들어간 인력 삭제 → 대화에 "협약 예산 참여인원 N건" 별도 줄, 삭제 비활성 + 이유. 버전 삭제 후 다시 삭제 가능 |
| http://localhost:3000/projects/aaaa0000-0000-4000-8000-000000000001 | 단계·연차 패널에서 협약 버전이 쓰는 연차(1차년도 `aaaa0000-0000-4000-8000-000000000021`) 삭제 → "협약 예산 버전 N개가 이 연차를 씁니다" 거부 |
| http://localhost:3000/help#budget--%EC%88%98%ED%96%89-%EB%AA%A8%EB%93%9C-%ED%98%91%EC%95%BD-%EC%98%88%EC%82%B0 | 수행 모드 [?] 링크와 같은 절 — "준비 중" 없음 |
