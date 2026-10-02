# Phase 25 계획 — 붙임4형·조정회의형·참여인원 보기 + 붙임4 가져오기 + 연차별 정부지원 현금

> **상태: 확정 (T0, 2026-10-03).** 초안(`phase-25-plan-draft.md`, 삭제)을 U-1~U-4 사용자 답으로 확정했다. 이 결정표(S-1~S-24)는 `docs/SOT.md`(v4.9 — 상단 "Phase 25 결정" 줄)와 `evaluation_criteria.md` "## Phase 25"에 먼저 반영됐다. 구현이 이 표와 SOT 사이에서 갈리면 SOT가 옳다.

## 핵심 원칙 (사용자, 2026-10-03)
"다양한 양식을 주는 취지는 단계별로 이런 양식을 요청받기 때문이다. 제안→수행으로 넘어가는 단계에서 다양한 양식 페이지를 제공하되, **소스는 일원화**되어 거기서 값을 각 양식으로 **자동으로 채우고 동기화**해야 한다. 수동으로 입력할 거면 양식을 만들 필요가 없다(엑셀로 만들지)."
→ 양식 보기는 전부 원 소스(제안 `budget_items`·`budget_details`·`years`, 협약 버전 금액 줄·참여인원·정부지원 현금)에서 파생. 양식 전용 저장 칸 금지. 소스에 없는 값은 소스에 필드를 추가. 보기에서 고친 값도 소스를 고친다(AG-1).

## 사용자 결정 (2026-10-03 확정)
- **과제 유형(ProjectType) 하지 않는다.** 정부출연금 비율 한도 등은 과제마다 수동 입력 = 기존 `budget_rules` RL-8 `gov_share_max`·RL-9 `own_cash_min` 행. SOT의 과제 유형 개념(§5.3, RL-20 "과제 유형 × 중소기업 자동", §7.3, §11 25·26행, §13 22번, 상단 요약, brief D-9)은 폐기 표기. CLAUDE.md Phase 표는 메인이 정리했다.
- G-1: 8-1 비율은 표시, `gov_share_max`·`own_cash_min` 행이 켜져 있고 값이 있을 때만 판정(경계는 `lib/rules.ts`와 같음), 없으면 "판정하지 않음" + 사유.
- G-2: 붙임4형 8-2의 데이터 칸 편집 → 소스 줄. 조정회의형은 읽기 전용.
- G-3/Q4b: 참여인원 추가·수정·삭제. 금액 명시 = 수동. 참여율·개월·연봉·인력만 바뀌면 직전 구분대로 — 자동이면 재계산(축은 기존 0 아닌 쪽, 둘 다 0이면 현금), 수동이면 유지, 연봉 모름이고 금액 둘 다 0이면 재계산.
- G-4: [붙임4 가져오기] 버전 생성 규칙은 [협약 기준선으로 보내기]와 동일.
- **G-11**: 회사명 개념 없음. 파일은 우리 회사 데이터로 본다. 기관 블록이 여럿이면 미리보기에서 사용자가 블록 선택(B열 텍스트 그대로), 하나면 바로.
- **결정 2**: 8-2는 우리 비목을 양식 행으로 묶어 보임. 가져오기는 양식 행 → 대응 비목 default 줄(인건비 A~D는 세목 예외 — S-5).
- **결정 3**: 8-2 간접비 비율은 양식 시트 수식 그대로.
- **결정 4**: 조정회의형 변경전 = 제안 모드 사업비, 변경후 = 수행(협약 버전). 원 소스에서 자동 채움.
- **결정 5**: 연차별 정부지원 현금/기관부담 현금을 나눠 적을 수 있어야 함 — 제안 모드와 협약 버전 둘 다.
- Q3: 8-2 비율은 표시만(판정은 Phase 26). Q4: 참여인원 ↔ 금액 줄 인건비 차이는 표시만.
- 메인 기술 결정: [붙임4 가져오기] 위치 = 제안 툴바 보내기 옆 + 수행 모드 버전 0개 안내 [빈 버전] 옆. 스냅샷 없음(별도 버전 → 삭제가 되돌리기). 파일 10MB(`MAX_UPLOAD_BYTES`) + `next.config.ts` `experimental.serverActions.bodySizeLimit: '11mb'` + 클라이언트 사전 검사. Realtime 새 구독 없음(R-1 4테이블). 도움말 새 slug `agreement`(calculations.md 3,483/3,500자 — 불변). 부록 C.4 신설.

## 확정 결정 (U-1~U-4, 사용자 답 2026-10-03)
- **U-1 연구활동비(H)에 promotion(연구과제추진비) 포함** — 권고대로. 간접비 양식 분모가 RL-3과 일치한다.
- **U-2 양식 밖 비목**(consignment·international·burden·other)이 0이 아니면 8-2에 **"양식에 없는 비목"** 행으로 보이고 K·M에 포함(총액 보존) + 검토사항 경고 — 권고대로. 0이면 행을 보이지 않는다.
- **U-3 내역 행 두 개**
  - "(간접비 중 연구실 안전관리비)": 소스 없음 → 보기에서 **"—"**. 가져오기에서 고른 블록에 이 행이 있고 값이 0이 아니면 경고(금액은 반영하지 않음). 세목 추가는 Phase 26(RL-22)과 함께.
  - "(연구시설·장비비 중 통합관리비(현금))": **필요 없는 항목 — 완전히 제외.** 보기에 행이 없다. 가져오기는 이 라벨을 인식만 하고 무시한다(경고 없음). 부록 C.4 종류 "무시".
- **U-4 정부지원 현금 저장** — 사용자: "정부지원 현금이 구분되면 되고, 실데이터가 없으니 백업 호환은 걱정할 필요 없다" → 메인 결정 **관계형 새 테이블**:
  - 협약: `agreement_gov_support(id, version_id → agreement_versions on delete cascade, year_id → years no action, gov_cash bigint not null check (gov_cash >= 0), N-4 공통 컬럼, unique(version_id, year_id))`. **행 없음 = 미입력**, 0은 입력값. 같은 마이그레이션에 RLS(기존 협약 테이블 정책 그대로)·`set_updated_meta`·`agreement_child_guard` 트리거(함수 재사용 — 아래 S-4)·`delete_year` H-5a 선검사 포함·`restore_backup` c_tables·가드 disable/enable·`BACKUP_TABLES` → **`schema_version` 7**(v6 백업 거부 — 사용자 무관).
  - 제안: `years.gov_support_cash bigint null`(컬럼, check `>= 0`, null = 미입력).

## 실측 구조 (samples/ — 기관명·금액·성명 없음)
- **8-2** 시트 "8-2. 연구개발비 사용계획", 단위 천원. 첫 블록 "총합 (전체)" + 기관별 블록(B열 기관명, 약 23행). 열: 1단계 아래 1~4차년도 + 합계(단계 머리 행 위, `N차년도` 행 아래 숫자 행).
  - 기관 블록 행: 내부인건비(A) 현금(N)/현물 · 외부인건비(B) 현금(O)/현물 · 연구지원인력인건비(C)(단일 행) · **인건비 소계**(A+B+C) · 학생 인건비(D) 일반/통합관리 · 총 인건비(E1=A+B+C+D) · 수정인건비(E2=A+B+D) · 연구시설‧장비비(F) 현금(P)/현물 · "(연구시설‧장비비 중 통합관리비(현금))" · 연구재료비(G) 현금(Q)/현물 · 연구활동비(H) 현금(R)/현물 · 연구수당(I)(단일 행) · 연구수당 비율(I/E2) · 직접비 소계(K=E1+F+G+H+I) · 간접비(L) · 간접비 비율(L/(N+O+C+D+P+Q+R+I)) · 연구개발비 총액(M=K+L).
  - 총합 블록에만: 인건비 비율(E1/M) · "(간접비 중 연구실 안전관리비)". 실측 기관 블록에는 연구실 안전관리비 행이 없다 — 다른 판의 양식에 있으면 U-3대로.
- **8-1** 시트 "8-1. 연구개발비 지원 및 부담계획", 단위 천원. 연차 블록(B열 1~4) × 기관 행. **기관마다 두 행**: 금액 행(연구개발기관·기업유형·금액) + 비율 행(비율 A/H·B/D·C/D·D/H — 읽지 않는다). 열: 연구개발기관 · 기업유형 · 정부지원 현금(A) · 기관부담 현금(B)·현물(C)·소계(D) · 그 외 기관 지원금 현금(E)·현물(F)·소계(G) · 합계 현금(A+B+E)·현물(C+F)·합계(H) · 검토사항(정부출연금비율·민간현금비율 — 문자열 "…적정"/"해당없음". 양식은 과제유형×기업유형으로 한도를 고르지만 앱은 과제별 수동 한도).
- **조정회의** 시트 1개, 기관별 블록, 각 블록 "(변경전) 기관 | (변경후) 기관" 두 표 나란히. 행: 인건비(A) · 연구수당(B) · 간접비(C) · 합계(D=A+B+C) · 연구개발비 총액(E) · 인건비+연구수당+간접비 비율(D/E) · 연구수당/인건비 비율(B/A) · 직접비(F) · 인건비/직접비 비율(A/F). 열 1~4차년도. 머리에 "*간접비 비율:xx.xx%".

## 코드 사실
- `BUDGET_CATEGORY_ORDER` 12종: personnel · student_personnel · facility_equipment · material · consignment · international · burden · activity · promotion · allowance · indirect · other. A.5: personnel(internal/external/support), student_personnel(general/managed), facility_equipment(purchase/lease/maintain/infra), material(purchase/manage/make), activity(12 세목), indirect(hr/support/outcome), 나머지 6종 default만. §5.22는 모든 비목에 default 허용.
- 재사용: `resolveCellEdit`(AG-2), `buildBaselineFromPlan`(AV-6), `computeDetailAmount`(PL-1~4), `modifiedPersonnel`·`modifiedDirectCost`(PL-11/RL-3), `buildYearTotals`·`evaluateBudgetRules`, `lib/import/`(expandMerges·cellText·normalizeLabel·parseAmountCell·detectAmountUnit·parseYearOrderFromLabel), `TableActions`(model 배열 지원).
- `updateYear`(`actions/years.ts:88`) `yearPatchSchema`가 연차 필드 경로(O-1 `expectedVersion` 선택).
- `agreement_child_guard()`(Phase 24 마이그레이션)는 `new.version_id`·`new.year_id`만 읽고 `member_id`는 `tg_table_name = 'agreement_participants'` 분기 안에서만 읽는다 → **함수 본문을 바꾸지 않고** 새 테이블에 트리거만 걸면 확정 잠금·`version_id` 변경 금지·과제 경계(연차)가 그대로 적용된다. DELETE는 막지 않는다(Phase 24와 같음 — 버전 삭제 cascade).
- `delete_project`는 버전을 먼저 지운다(H-7) → 새 테이블은 `version_id` cascade로 함께 지워져 연차 `no action` FK가 과제 삭제를 막지 않는다. **재정의 불필요.**
- 스키마 버전 단언: `tests/integration/agreement-migration.test.ts:262`·`tests/unit/agreement-labels.test.ts:114`(=6), `tests/destructive/backup-roundtrip.test.ts`(=6, 길이 30/32, `budget_rules` 뒤 4종 연속 slice).
- `next.config.ts`에 bodySizeLimit 없음(기본 1MB) vs `MAX_UPLOAD_BYTES` 10MB(`lib/import-adapter.ts:23`) 불일치.
- 도움말 글자 수(2026-10-03): `budget.md` 2,930 / `calculations.md` 3,483 (상한 3,500).

## 결정표
| # | 항목 | 결정 |
|---|---|---|
| S-1 | 이름 | `lib/agreement/`: `form-rows.ts`(줄 → 양식 행 금액, C.4) · `rates.ts` · `attachment4-view.ts`(8-1·8-2 모델·검토사항·표) · `adjustment-view.ts` · `form-edit.ts`(8-2 칸 편집 해석) · `participants.ts` · `attachment4-parse.ts` · `from-plan.ts` 확장(정부지원 현금). 액션: `actions/agreement.ts` 확장 · `actions/agreement-participants.ts` · `actions/agreement-import.ts` · `actions/agreement-export.ts` 확장 · `actions/years.ts`(제안 연차 정부지원 현금). 리포지토리: `lib/db/agreements.ts` 확장. 컴포넌트: `Attachment4View`·`AdjustmentView`·`ParticipantsView`·`ParticipantDialog`·`Attachment4ImportDialog`·`components/budget/YearGovSupportRow.tsx` |
| S-2 | ProjectType | 하지 않음. SOT 폐기 표기(§5.3·§6.14 RL-8·RL-9·RL-20·§7.3·§11·§13 22·상단 요약) |
| S-3 | 정부지원 현금 저장 | 정부지원 현금만 저장, 기관부담 현금 = 그 연차 현금 합 − 정부지원(파생, 저장 안 함). **제안**: `years.gov_support_cash bigint null`(check null 또는 ≥ 0, null = 미입력). **협약**: 새 테이블 `agreement_gov_support`(U-4 — 버전·연차당 0~1행, 행 없음 = 미입력). 앱 타입 `Year.govSupportCash: number \| null`, `AgreementGovSupport { versionId, yearId, govCash }`(§5.25) |
| S-4 | 검증·흐름 | 쓰기는 0 이상 정수만(액션 Zod + DB check). "정부지원 ≤ 그 연차 현금 합"은 **읽을 때 경고**(넘으면 8-1 그 연차 A·B·두 비율 "—" + 사유). **DB 가드**: 새 테이블에 `agreement_child_guard` BEFORE INSERT/UPDATE 트리거(함수 재사용 — 확정 버전 거부·`version_id` 변경 거부·`year_id`가 버전의 과제 연차), `delete_year` 재정의(H-5a union에 새 테이블 추가), `delete_project` 불변(cascade). **확정 버전 행 삭제**는 Phase 24 하위 테이블과 같이 트리거가 막지 않고 액션이 `RULE`로 거부한다. **흐름**: 보내기 = `years.gov_support_cash`가 null 아닌 연차만 행(null 연차는 행 없음) · 복제 = 원본 행 새 id로 복사 · 붙임4 가져오기 = 8-1 A(정합 행을 고른 경우) · 빈 버전 = 0행. **RPC**: `create_agreement_version(p_project_id, p_kind, p_name, p_lines, p_participants, p_gov_cash jsonb default '{}')` — `p_gov_cash` = 객체 `{연차 id: 원}`(객체 아님·값이 0 이상 정수 아님이면 사람이 읽는 메시지로 거부, 연차 경계는 가드 트리거), **옛 5인자 시그니처 drop 후 재생성**. `clone_agreement_version` 재정의(새 테이블 복사 추가). **편집**: `setAgreementGovCash(versionId, yearId, amount: number \| null)` — 값 1개라 **O-2**(AG-2 셀 편집과 같다): 서버가 방금 읽은 행으로 판단 — 행 있음+null → 그 행 `version`으로 삭제, 행 있음+값 → `version`으로 갱신, 행 없음+값 → 삽입, 행 없음+null → 변화 없음. 0행 갱신·삭제와 유일 위반(23505)은 `STALE`, 확정 버전은 `RULE`. 제안 모드 연차 합 ≠ 협약 정보 `govBudget`이면 정보 문구만 |
| S-5 | 부록 C.4 대응표 | A 내부인건비 ← `personnel_internal`(가져오기 같은 세목) · B 외부인건비 ← `personnel_external`(같은 세목) · C 연구지원인력(단일 행) ← `personnel_support` 현금+현물(가져오기 현금) · 인건비 소계 = A+B+C(집계) · D 일반 ← `student_general`(현금+현물, 가져오기 현금) · D 통합관리 ← `student_managed`(같음) · F 장비 ← `facility_equipment` 전 세목(가져오기 `default`) · G 재료 ← `material` 전 세목(`default`) · **H 연구활동비 ← `activity` 전 세목 + `promotion`**(U-1, 가져오기 `activity`/`default`) · I 연구수당(단일 행) ← `allowance` 현금+현물(가져오기 `default` 현금) · L 간접비(단일 행) ← `indirect` 전 세목 현금+현물(가져오기 `default` 현금) · **"양식에 없는 비목" ← consignment·international·burden·other**(U-2, 가져오기 대상 없음) · **연구실 안전관리비 = 소스 없음**(U-3, "—") · **통합관리비(현금) = 무시**(U-3, 보기에 없음). 인건비 A~D를 세목으로 가져오는 이유: E2 = A+B+D(PL-11 C 제외가 세목 단위). **세목 미지정 줄**(T2 중 메인 결정): 보기에서 `personnel`/`default` → A(축 그대로), `student_personnel`/`default` → D 일반 — 검토사항에 "세목 미지정 인건비 N원을 내부인건비(A)에 / 세목 미지정 학생인건비 N원을 학생인건비 일반(D)에 넣었습니다"(T4a). 가져오기 대상은 세목 그대로 |
| S-6 | AG-3 8-2 | 행 = C.4 순서(인건비 비율 E1/M 포함, 통합관리비 행 없음). 열 = 연차 + 단계 소계(단계 2개 이상) + 합계, 줄 없는 칸 "—". E1 = A+B+C+D(현금+현물), E2 = `modifiedPersonnel` 재사용, I/E2, K = E1+F+G+H+I(+양식 밖 행), M = K+L, E1/M. **간접비 비율 = 양식 식** L ÷ (A현금+B현금+C+D일반+D통합+F현금+G현금+H현금+I) — "양식 분모"는 RL-3 `modifiedDirectCost`와 별개(C·D·I 현물 포함, 양식 밖 비목 제외). 교차 테스트: C·D·I 현물 0·양식 밖 0·H에 promotion이면 `modifiedDirectCost(DEFAULT_INDIRECT_BASE)`와 같음. 라벨 "양식 E1/E2". 비율 표시만(판정 Phase 26). 검토사항: 양식 밖 비목 ≠ 0, 정부지원 현금 미입력·초과(8-1), 분모 0 |
| S-7 | AG-3 8-1 | 연차별 행 + 합계 행. 기업유형 "중소기업" 고정, 그 외 기관 지원금 0 고정. A = 그 연차 `agreement_gov_support.gov_cash`, B = 그 연차 현금 합 − A, C = 현물 합, D = B+C, H = 현금+현물, 정부출연금비율 A/H, 민간현금비율 B/D. A 미입력(행 없음) 또는 > 현금 합이면 A·B·두 비율 "—" + 사유, 미입력 연차가 있으면 합계 행도 "—". 판정(G-1) 연차별·합계. 교차: 국제공동 0이면 합계 = `evaluateRules`(gov ΣA, own ΣD, total ΣH) ratios. `lib/rules.ts` 불변. 8-1의 A는 작성 중 버전에서 편집(S-4 `setAgreementGovCash`) |
| S-8 | AG-4 조정회의형 | **변경전 = 제안 모드**(`buildBaselineFromPlan`으로 줄 변환 — 미분리 셀 현금, 같은 `form-rows`), **변경후 = 보고 있는 협약 버전**, 나란히, 읽기 전용. 변환 실패(이슈)면 변경전 열에 사유(0으로 채우지 않음). A = E2 · B = I · C = L · D = A+B+C · E = M · F = K. 비율 D/E · B/A · A/F, 머리 간접비 비율 = S-6 양식 식. 열 1~4차년도 + 합계, 줄 없는 연차 "—", 보고 있는 버전이 현재 버전이 아니면 "현재 버전 아님" 표식. SOT D-7·AG-4 개정 |
| S-9 | AG-5 참여인원 | 목록형, 정렬 인력 order(미지정 뒤) → 연차 order. 열: 인력(미지정 "인력 미지정")·연차·역할·참여율·개월·연봉 스냅샷·계산값·현금·현물·계·구분. 연차 소계·총계. 계산값 = `computeDetailAmount`({formula:'personnel', factors:[참여율(%) isPercent, 개월]}, {annualSalary}). 구분: 연봉 null → "연봉 모름", (현금=계산값 & 현물=0) 또는 (현물=계산값 & 현금=0) → "자동", 그 밖 "수동" |
| S-10 | 참여인원 ↔ 금액 줄 | 연차·축별 Σ참여인원 vs Σ(`personnel` + `student_personnel` 줄) 차이 표시만 |
| S-11 | 참여인원 편집 | 작성 중 버전만. 인력·연차 같은 과제(액션·트리거). 참여율 0~100, 개월 0~12, 금액 0 이상 정수, 역할 ≤100자. 추가 시 연봉 미지정이면 그 시점 Member 연봉 스냅샷, 금액 미지정이면 자동 계산(현금). `resolveParticipantEdit` = G-3/Q4b. 액션 `addAgreementParticipant(versionId, input)`·`updateAgreementParticipant(id, patch, expectedVersion)`(O-1)·`deleteAgreementParticipant(id)`(확인 대화, 확정 버전은 `RULE`) |
| S-12 | 8-2 칸 편집 | 데이터 행 × 연차만(집계·비율·내역·합계·단계 열·양식 밖 행 불가). A·B 현금/현물 = (`personnel_internal`\|`external`, 축) 줄 정확 update/insert/noop · C·D 일반·D 통합 = 현금 줄 목표 = 입력 − 그 세목 현물(음수 RULE) · F·G = `resolveCellEdit`(default 흡수) · I·L = 현금 셀 목표 = 입력 − 그 비목 현물 → `resolveCellEdit` · H = activity 셀 목표 = 입력 − 그 연차·축 promotion 합 → `resolveCellEdit`(음수 RULE). O-2, 경합 STALE. 0도 저장 |
| S-13 | 붙임4 파서 | ① 시트 "8-2. 연구개발비 사용계획"(정규화 이름) ② 블록 분할, "총합 (전체)" 제외 ③ G-11 블록 1개면 사용, 여럿이면 `choose-block`(B열 텍스트 목록), 범위 밖 인덱스 blocking ④ 단위 `detectAmountUnit` — 8-2에 없으면 같은 파일 8-1 표기 + `unit_from_other_sheet` 경고, 둘 다 없을 때만 blocking(T6 메인 결정 — 실측 8-2에는 표기가 없다) ⑤ `N차년도` 열만 과제 연차 순 대응, K = min, 수 다르면 경고 + 남는 열 합 ⑥ 행 종류(C.4): **data**(반영) · **aggregate**(인건비 소계·E1·E2·K·M — 자체 검증, 어긋나면 경고·차액. 인건비 소계 칸이 0·빈 칸이면 대조 안 함 — 실측에서 늘 0인 입력 칸) · 괄호 내역 행은 가운뎃점 변형 무시 · **ratio**(I/E2·간접비 비율·E1/M — 인식만, 비교 안 함) · **memo**(연구실 안전관리비 — 값 ≠ 0이면 경고, 반영 안 함) · **ignored**(통합관리비(현금) — 인식만, 경고 없음) · 빈 행. 모르는 라벨 blocking ⑦ 원 정수, 음수·문자·비정수 blocking, 0·빈 칸은 줄 없음 ⑧ 같은 키 합산 + 경고 ⑨ 고른 블록에서 만들 금액 줄이 0개면 `no_amounts` blocking(8-1 A만 있어도 — evaluator 거절 노트 1, 0원 버전 금지). 입력은 `RawSheet[]`(SheetJS 객체 아님) |
| S-14 | 8-1 읽기·정합 | 시트 "8-1. 연구개발비 지원 및 부담계획". 기관마다 금액 행만 읽고 비율 행은 건너뛴다. 연차 블록마다 고른 8-2 블록의 B열 텍스트와 **같은 파일 안 텍스트가 같은** 금액 행(NFC·공백 전부 제거 — 실측 8-2 `가나
연구원` ↔ 8-1 `가나연구원`) — 회사명 개념 아님, 파일 안 두 표 잇기. 0개·2개 이상이면 미리보기에서 8-1 행 선택(`plan81Row` = 연차 블록 안 기관 금액 행 순서, 0부터) 또는 "8-1 쓰지 않음"(정부지원 현금 행 없음 + 경고). 8-1 시트·머리 없음 = "쓰지 않음" + 경고. 고른 행 A 빈 칸 = 그 연차 미입력 + 경고, 0 = 입력값, 음수·문자·비정수 = blocking(T6 메인 결정). **8-1 A → 버전 정부지원 현금 행**(AV-7 "8-1은 정합 확인용" 개정). 정합: 연차별 8-2 현금 합 = A+B, 현물 = C, 합계 = H, 어긋나면 경고(위치·차액), 반영 가능. E/F ≠ 0이면 경고 |
| S-15 | 가져오기 흐름 | `previewAttachment4Import(projectId, formData{file, blockIndex?, plan81Row?})` → 파일 이름·해시, 블록 목록, 고른 블록 텍스트, 단위, 연차×비목 현금/현물 합, 줄 수, 연차별 정부지원 현금, 8-1 정합, 경고·blocking, 작성 중 버전 이름, `nextVersionMeta`. `commitAttachment4Import(projectId, formData, {fileHash, blockIndex, plan81Row, kind, name})` — 같은 파싱 + 해시 대조(다르면 RULE), blocking RULE, 작성 중 RULE, 기존 RPC `create_agreement_version(p_lines, p_participants: [], p_gov_cash)`. 참여인원·편성 0, 스냅샷 없음. 확장자 .xlsx/.xlsm/.xls |
| S-16 | 파일 크기 | 10MB, bodySizeLimit '11mb', 클라이언트 사전 검사, 암호 파일 전용 문구 |
| S-17 | 화면 | 탭 [비목별]·[붙임4형]·[조정회의형]·[참여인원]·[변경 이력], 편성 항목 숨김. [붙임4 가져오기] 2곳(제안 툴바 보내기 옆 — 작성 중 있으면 비활성 + `draftExistsReason`; 버전 0개 안내 [빈 버전] 옆). 안내 문구 "협약 예산 버전이 없습니다 — 제안 모드에서 [협약 기준선으로 보내기]로 만들거나, [붙임4 가져오기]로 가져오거나, [빈 버전]으로 시작하세요". 8-1 "정부지원 현금"은 작성 중 버전에서 편집. **제안 모드 매트릭스 아래 "정부지원 현금"(연차별 입력, 비우면 미입력)·"기관부담 현금"(파생, 읽기 전용) 행** + 현금 합 초과 경고 + `govBudget` 불일치 정보 문구. 인쇄 가로·보기 하나, 다크 토큰 |
| S-18 | Realtime | **새 구독 없음.** 연구비 화면은 4테이블(`budget_items`·`budget_details`·`agreement_versions`·`agreement_lines`) 그대로 — `agreement_participants`·`agreement_gov_support`·`years`는 구독하지 않는다(R-1 화면당 4). 다른 사용자의 그 변경은 새로고침·재진입 때 보인다. 새 publication 없음 |
| S-19 | 내보내기 | 보기 3종, 비율은 **text 칸**(소수 둘째 자리 + `%`, 값 없음 "—"). 붙임4형: 작성안내 + "8-1 지원·부담계획" + "8-2 사용계획". 조정회의형: 한 시트(항목 · 변경전 연차… · 합계 · 변경후 연차… · 합계, D·합계 sum 칸). 참여인원: 한 시트. 파일 label `{버전 이름} 붙임4형` 등 |
| S-20 | 마이그레이션 | `supabase/migrations/20261003000000_agreement_forms.sql` 하나: ① `years.gov_support_cash` ② `agreement_gov_support` + 제약·인덱스(`year_id` — H-5a) + `set_updated_meta` + RLS(`to authenticated`, `is_approved()`) + `agreement_child_guard` 트리거 ③ `create_agreement_version`(옛 시그니처 drop 후 `p_gov_cash` 추가)·`clone_agreement_version`·`delete_year` 재정의(최신 정의 전문 복사, diff 계획서 결과 절에) ④ `restore_backup` 재정의 — `c_tables`의 `agreement_items` 뒤에 `agreement_gov_support`, 삽입 동안 그 가드도 disable → enable. 그 밖 불변 ⑤ publication 추가 없음 ⑥ `schema_version = 7`(`EXPECTED_SCHEMA_VERSION`도 같은 커밋). v6 백업은 K-5로 거부 |
| S-21 | 도움말 | 새 slug `agreement`(8-2·8-1·정부지원 현금·조정회의·참여인원·가져오기·계산식). `budget.md`(2,930자)는 연결 한 줄 + 제안 연차 정부지원 현금(넘치면 agreement.md로). `calculations.md` 불변. §7.16 slug 목록·`lib/help.ts`(`HELP_RELATED` budget ↔ agreement) |
| S-22 | C.4 상수 | `lib/constants.ts` `ATTACHMENT4_FORM_ROWS`(행 id·라벨 정규형·소스 대상·가져오기 대상·종류 `data`/`aggregate`/`ratio`/`memo`/`ignored`) + `ATTACHMENT4_OUTSIDE_CATEGORIES`(양식 밖 4종) + `ATTACHMENT8_1_COLUMNS`. 부록 C.4 신설 |
| S-23 | 픽스처 | 아래 |
| S-24 | SOT·평가 기준 정리 | SOT: 상단 요약(D-5·D-7·D-9·D-16 주석, Phase 25·26 줄, "Phase 25 결정" 줄) · §5.1 표 · §5.3(projectType 삭제·폐기 표기) · §5.5 `govSupportCash` · §5.21 AV-1·AV-6·AV-7 · §5.23(대조) · §5.25 신설 · §6.6 H-5a·H-7 · §6.14 RL-8·RL-9·RL-20 · §6.19 AG-1·AG-3·AG-4·AG-5·AG-9 · §7.3 · §7.9 · §7.9.8 · §7.16 HP-1 · §8.5 · §8.6 · §8.7 K-9 · §8.8 7 · §9(Year·Agreement Budget) · §10 · §11 25·26행·Phase 13 메모 · §13 22 · 부록 A.4 · 부록 C.4. brief D-7·D-9·D-16 개정 주석. 평가 기준 Phase 25 재작성 |

## 합성 픽스처 (원 단위, 버전 A = Phase 24 S-20, U-1 전제)
- **8-2** Y1: E1 40,000,000 · E2 40,000,000 · I/E2 7.5% · K 50,000,000 · L 2,500,000 · 분모 40,000,000 → 6.25% · M 52,500,000 · E1/M 76.1905% / Y2: 42,000,000 · 42,000,000 · 7.1429% · 50,000,000 · 2,700,000 · 40,000,000 → 6.75% · 52,700,000 · 79.6964% / 합계: 82,000,000 · 82,000,000 · 7.3171% · 100,000,000 · 5,200,000 · 80,000,000 → 6.5% · 105,200,000 · 77.9468%
- **기호 혼동**(Y1 personnel_support 현금 4,000,000): C 4,000,000 · E1 44,000,000 · E2 40,000,000 · I/E2 7.5%(6.8182%면 FAIL) · K 54,000,000 · 분모 44,000,000 → 5.6818% · M 56,500,000 · E1/M 77.8761%
- **양식 분모 ≠ RL-3**(Y1 student_general 현물 1,000,000): 분모 41,000,000 → 6.0976%(6.25%면 FAIL), `modifiedDirectCost` 40,000,000, E1 = E2 = 41,000,000
- **promotion**(U-1, Y2 promotion/default 현금 400,000): H Y2 1,400,000 · K 50,400,000 · 분모 40,400,000 → 6.6832% = `modifiedDirectCost` 40,400,000
- **양식 밖**(U-2, Y1 consignment 현금 1,000,000): "양식에 없는 비목" 1,000,000 · K 51,000,000 · M 53,500,000 · 검토사항 경고. 양식 밖 0이면 행 없음
- **내역 행**(U-3): 연구실 안전관리비 행 전 칸 "—"(0 아님), 통합관리비(현금) 행 없음
- **8-1**(정부지원 현금 행 Y1 35,000,000 · Y2 35,000,000): Y1 A 35,000,000 · B 7,500,000 · C 10,000,000 · D 17,500,000 · H 52,500,000 → 66.6667% · 42.8571% / Y2 35,000,000 · 7,700,000 · 10,000,000 · 17,700,000 · 52,700,000 → 66.4137% · 43.5028% / 합계 70,000,000 · 15,200,000 · 20,000,000 · 35,200,000 · 105,200,000 → 66.5399% · 43.1818% (= `evaluateRules`). 판정: 75/40 전부 통과, own_cash_min 43이면 Y1만 미달, 행 없으면 "판정하지 않음", Y2 행 없음(미입력)이면 Y2·합계 "—", Y1 = 45,000,000(> 42,500,000)이면 Y1 "—" + 경고. Y1 = 0(입력)은 "—"가 아니라 0% 계산
- **보내기·복제**: 제안 Y1 `gov_support_cash` 35,000,000, Y2 null → 버전 정부지원 현금 행 1개(Y1 35,000,000), 복제 = 같은 값 새 id 행, 빈 버전 0행, 원본 버전 행 불변
- **정부지원 현금 편집**: 작성 중 버전 Y2 행 없음 → 30,000,000 입력 = 삽입, 다시 0 = 갱신(행 유지), null = 삭제(미입력), 확정 버전 = `RULE`, 다른 과제 연차 = `RULE`(트리거)
- **조정회의형**: 변경전 = Phase 24 S-20 "보내기" 제안(Y1만) — Y1 A 40,000,000 · B 3,000,000 · C 0 · D 43,000,000 · E 50,000,000 · F 50,000,000 → D/E 86% · B/A 7.5% · A/F 80% · 간접비 0%(분모 40,000,000), Y2 "—". 변경후 = 버전 A — Y1 A 40,000,000 · B 3,000,000 · C 2,500,000 · D 45,500,000 · E 52,500,000 · F 50,000,000 → 86.6667% · 7.5% · 80% · 6.25% / Y2 D 47,700,000 · E 52,700,000 → 90.5123% · 7.1429% · 84% · 6.75% / 합계 88.5932% · 7.3171% · 82% · 6.5%. 제안에 한쪽만 null 불일치면 변경전 사유 표시
- **참여인원**(M1 연봉 60,000,000, M2 50,000,000): M1 Y1 50%·12·현금 30,000,000 자동 / M1 Y2 현금 32,000,000(계산 30,000,000) 수동 / M2 Y1·Y2 20%·12·현물 10,000,000 자동. 부록 B.7 74,000,000·28%·9개월 → 15,540,000 자동(15,540,001이면 수동). 대조 기본 0, 인력 미지정 Y2 30%·6개월·현금 5,000,000·연봉 null(연봉 모름) 추가 시 Y2 현금 차이 +5,000,000. G-3 편집: M1 Y1 참여율 60% → 36,000,000 / M1 Y2 개월 10 → 32,000,000 유지 / M2 Y1 25% → 현물 12,500,000 / 새 행(연봉 60M·10%·12개월·금액 없음) → 현금 6,000,000 / 금액 7,000,000 명시 → 수동 / 연봉 모름·금액 0 행에 연봉 40M → 40M×30%×6/12 = 6,000,000
- **파서**: 총합 블록 + 기관 블록 2개, 천원 단위, 기관 블록 = 버전 A ÷ 1,000, 8-1 연차 블록 2 × 기관 2 × (금액 행 + 비율 행). 기대: 줄 합계 105,200,000, 인건비 A~D 세목 줄·나머지 default, 정부지원 현금 {Y1: 35,000,000, Y2: 35,000,000}. 변형: 블록 1개 / 블록 2개 + blockIndex 없음(choose-block) / 범위 밖 / 8-1 행 텍스트 불일치(행 선택) / "8-1 쓰지 않음"(행 없음 + 경고) / 8-1 현금 −1,000천원(경고·차액) / 그 외 기관 지원금 ≠ 0(경고) / 모르는 라벨(blocking) / 빈 칸·0·음수 / 연차 3열 대 2연차(경고·남는 합) / 단위 없음 / 집계 행 불일치(경고) / 통합관리비 행 값 있음(경고 0·줄 0) / 연구실 안전관리비 행 값 ≠ 0(경고·줄 0). 익명화 실측 구조 픽스처: 반영 뒤 붙임4형 E1·E2·K·L·M·비율 = 파일 집계 셀
- **백업**: v7 왕복 — `agreement_gov_support` 행·`years.gov_support_cash` 값 그대로, 확정 버전 아래 행도 복원(가드 off). v6 파일 거부(K-5)

## 태스크
웨이브: T0 → {T1, T2, T7, T8, T18} → {T4a, T4b, T5, T6 ← T2; T13 ← T1·T2} → {T9 ← T4a·T4b·T5·T7; T10 ← T5·T7; T11 ← T6·T7·T8; T12 ← T4a·T5} → {T14a ← T9·T12; T14b ← T9·T10·T12; T15 ← T11} → T16(← T13·T14a·T14b·T15) → T19(← T1·T16·T18). 웨이브마다 `npx tsc --noEmit` 초록.

| 태스크 | 대상 파일 | 완료 기준 요지 |
|---|---|---|
| T0 결정 확정 (완료) | `docs/SOT.md`, `evaluation_criteria.md`, `docs/plans/phase-25-plan.md`(초안 대체·초안 삭제), brief(D-7·D-9·D-16 주석) | `grep "Phase 25 T0" docs/SOT.md` 0, "우리 회사 이름" 0, ProjectType은 폐기 문맥만, S-24 위치 전부, 평가 기준 과제 유형 삭제·양식 분모·조정회의 전/후·정부지원 현금(새 테이블·v7) 반영, 실측 구조 절, budget.md 글자 수 기록 |
| T1 마이그레이션·백업 | 새 마이그레이션, `lib/db/backup.ts`(`BACKUP_TABLES`·`RESTORE_TABLES`), `tests/integration/agreement-forms-migration.test.ts`, `tests/destructive/backup-roundtrip.test.ts`, `tests/integration/agreement-migration.test.ts`(schema_version 단언만 `≥ 6`으로 — phase23 테스트와 같은 방식; 그리고 (h)의 가드 트리거 목록 단언을 Phase 24 3종으로 거르는 한 줄 — 새 테이블에도 같은 가드를 걸기 때문, 메인 승인 2026-10-03) | db push 성공, 새 테이블 RLS·정책·N-4 컬럼·unique·`year_id` no action, 확정 버전 행 insert/update 거부·다른 과제 연차 거부·`version_id` 변경 거부·음수 거부, delete_year가 정부지원 행만 쓰는 연차도 거부, delete_project 통과, create RPC `p_gov_cash`(객체 아님·음수·비정수 거부)·옛 5인자 시그니처 없음, clone 행 복사, definer 0, publication 불변, schema_version 7, `c_tables` = `RESTORE_TABLES`(agreement_items 뒤), v7 왕복(정부지원 행·`gov_support_cash`), v6 거부. Phase 24 migration 테스트는 schema_version 단언 외 무수정 |
| T2 타입·상수 | `types/index.ts`, `lib/constants.ts`(`EXPECTED_SCHEMA_VERSION = 7` — T1과 같은 커밋, C.4 상수), `lib/db/schema.ts`, `lib/db/mapper.ts`, `tests/unit/mapper.test.ts`, `tests/unit/agreement-labels.test.ts`(schema_version 단언 7) | `Year.govSupportCash`, `AgreementGovSupport`, 매퍼 왕복(`gov_support_cash`·`gov_cash`), C.4 상수가 A.1/A.5 코드만 가리킴, 12비목 전부 양식 행 또는 "양식 밖", 종류 5종 |
| T7 리포지토리 | `lib/db/agreements.ts`, `tests/integration/repos-agreement-forms.test.ts` | 참여인원 get/insert/update(expectedVersion)/remove, 정부지원 현금 list/insert/update(expectedVersion)/delete(expectedVersion), createVersion `govCash`, 트리거 → RULE, version 0행·23505(정부지원 unique) → STALE, Phase 24 repos 테스트 무수정 |
| T8 업로드 어댑터 | `lib/import-adapter.ts`, `next.config.ts`, `tests/unit/import-adapter.test.ts` | `readAttachment4Upload(formData)` → {fileName, fileSize, fileHash, sheets}, 확장자·10MB·빈/깨진/암호 문구, bodySizeLimit, xlsx import 파일 목록 불변 |
| T4a 양식 모델 | `lib/agreement/form-rows.ts`·`rates.ts`·`attachment4-view.ts`·`adjustment-view.ts`, `tests/unit/agreement-views.test.ts` | 픽스처 전부(U-1·U-2·U-3 포함), 교차 테스트 2종, `modifiedPersonnel` 재사용, 분모 0 "—", 중간 반올림 없음, 검토사항, `lib/budget-plan.ts`·`lib/rules.ts` diff 0 |
| T4b 칸 편집·보내기 | `lib/agreement/form-edit.ts`·`from-plan.ts`, `tests/unit/agreement-form-edit.test.ts` | S-12 분기 전부, `buildBaselineFromPlan`이 정부지원 현금(null 연차 제외) 반환, Phase 24 agreement-core 무수정 |
| T5 참여인원 모델 | `lib/agreement/participants.ts`, `tests/unit/agreement-participants.test.ts` | B.7, 구분 3종, G-3 6케이스, 대조, `computeDetailAmount` 재사용 |
| T6 파서 | `lib/agreement/attachment4-parse.ts`, `tests/unit/agreement-attachment4-parse.test.ts`, `tests/fixtures/attachment4/*.json` | 변형 전부, 총합 블록 제외, 8-1 비율 행 건너뜀, 행 종류 5종, 출력 = 줄 + 정부지원 현금 + 정합 경고 + blocking, 회사명 개념 없음, 픽스처 실데이터 아님 |
| T13 제안 정부지원 현금 | `actions/years.ts`, `components/budget/YearGovSupportRow.tsx`, `tests/integration/year-gov-support.test.ts` | `updateYear` patch `govSupportCash`(null 허용), revalidate budget, 화면 입력 + 기관부담 파생 + 초과 경고 + govBudget 정보 문구, 제안 규칙·입력 양식 바이트 불변 ([AFTER: T1, T2]) |
| T9 조회·편집 액션 | `actions/agreement.ts`, `tests/integration/agreement-views-actions.test.ts` | 보기 3종(조정회의 변경전 = 제안 변환), `setAgreementFormCellAmount(versionId, {yearId,rowId,axis,amount})`, `setAgreementGovCash(versionId, yearId, amount\|null)`(S-4 O-2 분기), 보내기 `p_gov_cash`, 확정 RULE, STALE, 비목별 동일값, Phase 24 actions 무수정 |
| T10 참여인원 액션 | `actions/agreement-participants.ts`, `tests/integration/agreement-participants-actions.test.ts` | S-11 액션 3종, ActionResult·Zod·SA-1, 경계, 확정 RULE(삭제 포함), STALE, 수동·재계산, afterAll 버전 먼저 삭제 |
| T11 가져오기 액션 | `actions/agreement-import.ts`, `tests/integration/agreement-import.test.ts` | 미리보기 = 반영, 해시, blocking RULE, 작성 중 RULE, 이름 제안, 참여인원·편성 0, choose-block·8-1 행 선택·"쓰지 않음", 정부지원 현금 행 = 8-1 A, 깨진 파일·크기, SA-4, 반영 뒤 붙임4형 집계 = 파일 집계 셀 |
| T12 엑셀 3종 | `actions/agreement-export.ts`, `tests/integration/agreement-export-views.test.ts` | `buildAgreementWorkbook` view `attachment4`·`adjustment`·`participants`, S-19 시트, exceljs 재로드 = TSV, sum 수식 + result, 비율 text 칸, exceljs 2파일, Phase 24 export 무수정 |
| T14a 붙임4형·조정회의형 화면 | `Attachment4View.tsx`, `AdjustmentView.tsx` | 8-1 연차 + 합계·정부지원 편집(작성 중)·판정, 8-2 편집 칸만, "양식 E1/E2", 양식 밖·연구실 안전관리비 "—"·통합관리비 행 없음, 검토사항, 조정회의 전/후·변경전 실패 사유·"현재 버전 아님", TableActions 재사용 |
| T14b 참여인원 화면 | `ParticipantsView.tsx`, `ParticipantDialog.tsx` | 구분 3종, 인력 미지정, 대조 행, 작성 중만 편집, RULE·STALE |
| T15 가져오기 대화 | `Attachment4ImportDialog.tsx` | 블록 선택 → 8-1 행 선택/"쓰지 않음" → 미리보기(정부지원 현금·정합 경고) → 반영, blocking이면 비활성 + 이유, 업로드 전 크기 검사 |
| T16 셸·툴바 | `AgreementScreen.tsx`, `BudgetScreen.tsx`, `budget/page.tsx`(필요 시) | 탭 5개, 안내 문구, [붙임4 가져오기] 2곳, `YearGovSupportRow` 마운트, 구독 4테이블 불변(S-18), 제안 테스트 통과 |
| T18 도움말 | `content/help/agreement.md`, `lib/help.ts`, `content/help/budget.md`, `tests/unit/help-content.test.ts` | 양식 분모, 연차별 정부지원 현금(제안·협약), 조정회의 전/후, 대응표 요지(통합관리비 제외·연구실 안전관리비 "—"), 가져오기, 과제 유형·Phase 26 서술 0, calculations.md 불변, 3,500자, 앵커 |
| T19 통합 검증 | `docs/plans/phase-25-plan.md` 결과 절, PROGRESS.md | tsc, npm test(seed 재적용), test:destructive, :3000 확인 후 build, `.next/static` SheetJS·exceljs 0, grep(project_type 0·RL-20~22 판정 0·AgreementItem 편집 0·회사명 매칭 0·service_role 0·supabase 직접 0·exceljs 2파일), 양식 전용 저장 칸 0, samples 커밋 0, 수동 확인 URL 표 |

**소유권**: T2 = types·constants·schema·mapper·agreement-labels 테스트 / T1 = 마이그레이션·`lib/db/backup.ts`·tests/destructive·agreement-migration 테스트(schema_version 단언만) / T7 = `lib/db/agreements.ts` / T8 = import-adapter·next.config / `lib/agreement/` = T4a(4)·T4b(form-edit·from-plan)·T5·T6 / T13 = `actions/years.ts`·`YearGovSupportRow.tsx` / T9 = `actions/agreement.ts` / T10·T11·T12 = 각 액션 파일 / T16 = AgreementScreen·BudgetScreen·page / T18 = help. **아무도 고치지 않음**: `TableActions.tsx`, `lib/agreement/table.ts`, `cell-edit.ts`, `lib/budget-plan.ts`, `lib/rules.ts`, `lib/input-form*`, 위에 적은 단언 외의 Phase 24 테스트 파일. 새 액션 파일은 `toFailure`·`computeOrCorrupt` 자체 사본.

**주의**: `npm test`는 dev DB 시드 삭제(seed.sql 재적용), dev 서버 떠 있으면 build 금지, db push는 `npx supabase db push --db-url <.env.test.local TEST_DATABASE_URL>`, 협약 버전 만드는 테스트는 afterAll에서 `agreement_versions` 먼저 삭제, exceljs import 2파일, SheetJS는 server-only 어댑터에서만, samples/ 실데이터 커밋 금지. schema_version 7 이후 dev DB의 v6 백업 파일은 복원되지 않는다(사용자 무관 확인).

## T19 검증 결과 (2026-10-03)

### 명령
| 명령 | 결과 |
|---|---|
| `npx tsc --noEmit` | 0 오류 (T19 수정 후 재확인 0) |
| `npm test` | **147 파일 · 3852 테스트 통과**(287s). 실패 0 — 재실행·수정 불필요. T19 수정(아래)은 테스트 2개를 새 파일로 옮긴 것뿐이라 두 파일만 재실행: 2 파일 · 15 테스트 통과 → 현재 148 파일 · 3852 테스트 |
| 시드 재적용 | `npm test` 뒤 과제 A 사라짐(기존 동작) → `supabase/seed.sql`을 `.env.test.local` `TEST_DATABASE_URL`로 재적용, `aaaa0000-0000-4000-8000-000000000001` '과제 A'(연차 2 · 비목 행 24) 확인 |
| `npm run test:destructive` | **1 파일 · 15 테스트 통과**(18.4s). afterAll로 시드 다시 사라짐 → 재적용·확인 |
| `npm run build` | 직전 `netstat` :3000 LISTEN 없음 확인 후 성공(`/projects/[id]/budget` 96.2 kB / First Load 298 kB) |
| `.next/static` 문자열 | `SheetJS`·`sheetjs`·`xlsx.full`·`sheet_to_json`·`book_new`·`xl/workbook`·`ExcelJS`·`exceljs` 0. `SSF` 1건은 글꼴 바이너리(`PretendardVariable.woff2`) 우연 일치, `Workbook` 1건은 서버 액션 참조 이름(`inspectWorkbook`·`exportSubmissionWorkbook`·`buildAgreementWorkbook`)뿐 |

### T19에서 고친 것
- `tests/unit/agreement-labels.test.ts`(Phase 24 파일)에 T2가 schema_version 단언 외에 Phase 25 라벨 테스트 2개(`ParticipantAmountKind 3종`·`협약 보기 고정 문구`)와 import·머리 주석을 더해 두었다 — 평가 기준 "Phase 24 테스트 파일 수정은 schema_version 단언 … 뿐"에 걸린다. 테스트를 **그대로** 새 파일 `tests/unit/agreement-view-labels.test.ts`로 옮기고(단언 약화·삭제 없음), Phase 24 파일은 HEAD에서 schema_version 단언(6 → 7)만 바꾼 상태로 되돌렸다(diff 2줄).

### 함수 재정의 diff (S-20 — 직전 정의 `20261001000000_agreement_budget.sql` 대비)
- `create_agreement_version`: 인자 `p_gov_cash jsonb default '{}'` 추가(옛 5인자 `drop function` 후 재생성) · 변수 `v_gov_cash`·`v_n_gov` · 객체 아님/0 이상 정수 아님/키가 uuid 아님 거부 3개 · `agreement_gov_support` insert(연차 경계는 가드 트리거) · 반환 jsonb에 `govSupport` 개수. 그 밖 불변
- `clone_agreement_version`: 변수 `v_n_gov` · 원본 정부지원 행 새 id로 복사 insert · 반환에 `govSupport`. 그 밖 불변
- `delete_year`: H-5a union에 `select version_id from agreement_gov_support where year_id = p_year_id` 한 줄. 그 밖 불변
- `restore_backup`: `c_tables`에 `'agreement_gov_support'`(agreement_items 뒤) · `disable trigger agreement_child_guard` 한 줄 · `enable trigger` 한 줄. **이 둘 외 diff 0**
- `delete_project`·`delete_stage`·`agreement_child_guard` 재정의 없음

### grep·경계
| 검사 | 결과 |
|---|---|
| `project_type`·`projectType`·`ProjectType` (docs/·기존 마이그레이션 제외, 코드·content·tests) | 코드 0. 남은 것: `evaluation_criteria.md`(폐기·FAIL 조건 서술), `tests/integration/agreement-forms-migration.test.ts:7·138·142`(컬럼이 **없음**을 단언). 마이그레이션 전체에서 0 |
| RL-20~RL-22 | `RuleCode`(`types/index.ts:913`)·`budget_rules` check·`lib/rules-presets.ts`에 0. `lib/rules.ts`·`lib/rules-presets.ts`·`lib/budget-plan.ts` git diff 0. 언급은 `lib/constants.ts:663` 주석("세목 신설은 Phase 26(RL-22)과 함께")·`help-content.test.ts:233`(도움말에 **없음** 단언)뿐 |
| `AgreementItem` 편집 | 0 — `lib/db/agreements.ts`의 `agreement_items`는 조회(`:297`)뿐, 액션·컴포넌트에서 0. 편성 항목 탭 0(`AgreementScreen.tsx:33` 탭 5개) |
| 회사명 매칭 | 0 — `company`·`회사`·`alias`·`orgName` 검색: `attachment4-parse.ts:7` 주석("회사명 개념 없음")·`attachment4-view.ts` `companyType`(8-1 기업유형 "중소기업" 고정 표시, S-7)뿐 |
| `service_role` | 코드 사용 0 — 기존 주석(`lib/db/*.ts` C-1 예외 설명)·`src-tauri/scripts/prepare-sidecar.mjs` 차단 가드뿐. `SERVICE_ROLE` 환경 변수 참조 0(테스트 제외), `.next/static` 0 |
| UI·액션 supabase 직접 호출 | 0 — `app/`·`components/`·`actions/`의 `.from(`·`.rpc(`·`createBrowserClient`·`createServerClient` 0. `@supabase/` 매치는 전부 `import type`. `.channel(`은 `components/RealtimeRefresher.tsx:123`(Realtime 예외) |
| Realtime | 연구비 화면 `app/projects/[id]/budget/page.tsx:28` `['budget_items','budget_details','agreement_versions','agreement_lines']` 불변. publication 불변(`agreement-forms-migration.test.ts:215`) |
| exceljs import 파일(테스트 제외) | 정확히 2개: `lib/input-form-adapter.ts`·`lib/xlsx-style.ts` |
| xlsx import 파일(테스트 제외) | 2개 불변: `lib/import-adapter.ts`·`lib/export-adapter.ts` |
| 양식 전용 저장 칸 | 0 — 마이그레이션의 새 저장소는 `years.gov_support_cash`(:31)·`agreement_gov_support`(:37) 둘 다 S-3 소스. 편집 액션의 쓰기: `setAgreementFormCellAmount` → `agreement_lines`(`updateLineAmount`·`insertLine`), `setAgreementGovCash` → `agreement_gov_support`, 참여인원 3종 → `agreement_participants`, 가져오기 → `create_agreement_version` RPC, `updateYear` → `years` |
| `dangerouslySetInnerHTML` | `app/`·`components/`·`lib/`에서 주석 2건(`MarkdownViewer.tsx:4`·`lib/notes.ts:5` — 쓰지 않는다는 설명)뿐 |
| 새 빈 배열 폴백(diff·새 파일) | 검토 결과 문제 없음: `lib/db/agreements.ts` `(data ?? [])[0]`·`.length === 0` 4곳은 0행을 `NotFoundError`/`STALE`로 바꾸는 경로, `Attachment4ImportDialog.tsx:220`은 업로드 전 UI 상태, `ParticipantDialog.tsx:318`은 다시 읽기 전 차이 목록, `attachment4-parse.ts:339`(희소 격자 빈 행)·`:480`·`attachment4-view.ts:565`(집계 항 맵 — 대상 5종 전부 정의, 빠지면 대조 경고가 뜬다)·`:571`(Map 누적). catch는 전부 배너·`ValidationError`·`toActionFailure`로 드러냄 |
| 하드코딩 색 | 새 컴포넌트 6개의 색은 전부 `globals.css` 다크 팔레트 토큰(grey·red·green·blue·orange). `text-black`은 `print:` 전용 칸뿐 |
| `samples/` 추적 | `git ls-files samples` 0, `.gitignore:9` |
| 픽스처 실데이터 | 샘플 붙임4 8-1 C열 기관명(금액 행) 6개 추출 → `tests/fixtures/` 일치 0 · `tests/` 0 · `docs/`·평가 기준·CLAUDE.md·PROGRESS.md 0 · 코드 1(`components/team/OrganizationFormModal.tsx:46` 기관명 입력 placeholder "예: …" — Phase 2부터 있던 공공기관 예시, 이번 diff 아님). 샘플 금액과 같은 숫자는 픽스처마다 고유 숫자의 4~25%로 합성 파일(`synthetic*.json`)과 같은 수준이고 전부 100의 배수(천원 단위 둥근 값의 우연 일치) — `real-structure.json`은 오히려 비율이 가장 낮다(15/355) |

### 평가 기준 → 근거
**마이그레이션·DB**
| 기준 | 근거 |
|---|---|
| 마이그레이션 1개, `years.gov_support_cash` + check, project_type 없음 | `supabase/migrations/20261003000000_agreement_forms.sql:31-32`; `agreement-forms-migration.test.ts` "years.gov_support_cash는 bigint null이고 음수는 check가 거부한다"·"과제 유형·기업 유형 컬럼은 없다" |
| `agreement_gov_support` FK·check·N-4·unique·인덱스 | 마이그레이션 `:37-54`; 테스트 "컬럼 — gov_cash bigint not null, N-4 공통 컬럼"·"FK — version_id cascade, year_id no action. unique(version_id, year_id), year_id 인덱스" |
| RLS·정책·미승인 0행 | 마이그레이션 `:59-62`; 테스트 "agreement_gov_support에 RLS가 켜져 있고 승인 사용자 정책 하나만 있다"·"select는 빈 결과, insert는 RLS 위반" |
| 확정 잠금 가드(함수 재사용)·version_id 변경·다른 과제 연차·음수·23505 | 마이그레이션 `:67`(트리거만); 테스트 "작성 중 버전에는 insert·update되고, 두 번째 행은 23505, 음수는 23514"·"확정 버전 아래 insert·update는 거부"·"version_id 변경은 거부된다"·"다른 과제의 연차는 직접 INSERT·UPDATE와 RPC 둘 다 거부된다" |
| `delete_year`·`delete_stage` H-5a, `delete_project` 통과 | 마이그레이션 `:294`(diff 위); 테스트 "정부지원 현금 행만 쓰는 연차도 delete_year·delete_stage가 거부"·"여러 버전이 … 버전 수를 센다"·"delete_project는 재정의 없이 통과" |
| RPC `p_gov_cash`·옛 시그니처 0·clone·invoker | 마이그레이션 `:82-215·:222`; 테스트 "p_gov_cash { 연차 id: 원 }을 행으로 저장"·"0은 입력값으로 저장되고 …"·"객체가 아니거나 …거부"·"옛 5인자 시그니처는 pg_proc에 없다"·"clone_agreement_version이 정부지원 현금 행을 새 id로 복사"·"새·재정의 함수 중 security definer가 없다"(`restore_backup`은 기존 X-2 예외로 definer 유지) |
| schema_version 7 = EXPECTED 7 | 마이그레이션 `:481`, `lib/constants.ts:51`; 테스트 "app_settings.schema_version = 7"·"EXPECTED_SCHEMA_VERSION = 7" |
| 백업 K-9(c_tables 순서·가드 on/off·v7 왕복·v6 거부) | `lib/db/backup.ts:41`; 위 diff; `agreement-forms-migration.test.ts` "(f) c_tables가 RESTORE_TABLES와 순서까지 같고 …"; `tests/destructive/backup-roundtrip.test.ts` "K-7: v7 복원 왕복"·"§8.8: 옛 v4·v5·v6 백업 거부" |
| Realtime publication·구독 4테이블 | `page.tsx:28`; 테스트 "Realtime publication은 바뀌지 않았다" |
| 가져오기 = 기존 RPC 한 트랜잭션, 작성 중 RULE | `actions/agreement-import.ts:367`(`agreementsRepo.createVersion`); `agreement-import.test.ts` "작성 중 버전이 있으면 미리보기가 이름을 알리고 반영은 RULE" |

**순수 함수 `lib/agreement/`**
| 기준 | 근거 |
|---|---|
| 부수효과 없음·금지 import 0 | `tests/unit/agreement-boundary.test.ts` "검사 대상 — lib/agreement N개 파일"(새 파일 포함) |
| 산식 재구현 금지, budget-plan·rules diff 0 | `lib/agreement/form-rows.ts:16`(`modifiedPersonnel`)·`participants.ts:12`(`computeDetailAmount`); git diff 0; `agreement-views.test.ts` "양식 E2 = lib/budget-plan modifiedPersonnel(재사용) 그대로"·`agreement-participants.test.ts` "computeDetailAmount(personnel)와 같은 값" |
| 양식 분모 ≠ RL-3 + 교차 | `agreement-views.test.ts` "분모 41,000,000 → 6.0976%(6.25%면 FAIL) …"·"교차: 양식 분모 ↔ modifiedDirectCost(DEFAULT_INDIRECT_BASE)"·"H Y2 1,400,000 · K 50,400,000 · 분모 40,400,000 → 6.6832%" |
| 8-2 행 순서·픽스처·기호 혼동·H = activity+promotion·열 | `agreement-views.test.ts` "8-2 버전 A (픽스처)" 묶음·"C 4,000,000 · E1 44,000,000 · E2 40,000,000 · I/E2 7.5%"·"8-2 단계 소계 열"; `attachment4-form-rows.test.ts` "행 순서가 부록 C.4.1 표 순서와 같다"·"H 연구활동비 = activity 전 세목 + promotion" |
| 양식에 없는 비목·12비목 한 곳 | `agreement-views.test.ts` "\"양식에 없는 비목\" 1,000,000 · K 51,000,000 · M 53,500,000"·"양식 밖 줄이 있어도 금액이 0이면 행 없음"; `attachment4-form-rows.test.ts` "12비목은 data 행 또는 \"양식에 없는 비목\" 중 한 곳에만" |
| 내역 행(연구실 안전관리비 "—"·통합관리비 없음) | `agreement-views.test.ts` "연구실 안전관리비 행은 전 칸 \"—\""·"행 순서 = C.4.1(통합관리비 행 없음 …)"; `agreement-export-views.test.ts` "작성안내 + 8-1 + 8-2, 칸 값 = TSV" |
| 8-1 픽스처·교차·미입력·0·초과 | `agreement-views.test.ts` "8-1 정부지원 현금 Y1·Y2 35,000,000"·"교차: 합계 행 비율 = evaluateRules"·"Y2 행 없음(미입력)"·"Y1 = 45,000,000(> 현금 합 42,500,000)"·"Y1 = 0(입력)은 \"—\"가 아니라 0% 계산" |
| 8-1 판정 G-1 | 같은 파일 "8-1 판정 (G-1)" 5개(75/40 통과·43 Y1 미달·판정하지 않음·경계·judgeRatio) |
| 조정회의형 전/후·실패 사유 | 같은 파일 "조정회의형 (AG-4)" 7개·"조정회의형 — 변경전 변환 실패" 2개 |
| 중간 반올림 없음·분모 0 "—" | 같은 파일 "rates — 중간 반올림 없음"·"8-2 분모 0 — \"—\" + 사유" |
| 참여인원 모델·B.7·구분·대조·G-3 | `agreement-participants.test.ts` "부록 B.7 74,000,000 · 28% · 9개월 → 15,540,000"·"classifyParticipantAmount"·"G-3 6케이스" ①~⑥·"reconcileParticipants" |
| 8-2 칸 편집 해석 S-12 | `agreement-form-edit.test.ts` A·B / C·D / F·G / I·L / H / 편집 불가 묶음 |
| 보내기 확장 | `agreement-form-edit.test.ts` "제안 Y1 35,000,000 · Y2 null → {Y1: 35,000,000}"; Phase 24 `agreement-core.test.ts` 무수정 통과 |
| 붙임4 파서·8-1 정합·픽스처 변형 | `agreement-attachment4-parse.test.ts` 기본·블록 선택·8-1 행 찾기·행 종류·연차 열·단위·실측 구조 묶음(변형 14종 전부) |

**가져오기·액션·화면·도움말**
| 기준 | 근거 |
|---|---|
| SheetJS는 어댑터에서만, 10MB·bodySizeLimit·사전 검사·문구 | `lib/import-adapter.ts:278`; `next.config.ts:31`; `Attachment4ImportDialog.tsx:69`; `attachment4-upload.test.ts` 9개; `.next/static` 0 |
| 미리보기 = 반영·해시·표시·작성 중 RULE·오류 명시 | `agreement-import.test.ts` "blockIndex 0 → 미리보기 줄 = 반영 줄"·"미리보기 파일과 다른 파일을 반영하면 RULE"·"blocking … 반영은 RULE"·"파일·입력 오류" 묶음·"반영 뒤 붙임4형 보기의 E1·E2·K·L·M = 파일 집계 셀" |
| 액션 목록·ActionResult·SA-4·매퍼 | `actions/agreement.ts:989·1051`, `actions/agreement-participants.ts:200·234·274`, `actions/agreement-import.ts:291·324`, `actions/years.ts:104`; `mapper.test.ts`(gov_cash·gov_support_cash 왕복); `repos-agreement-forms.test.ts` |
| 정부지원 현금 편집 O-2·STALE·RULE | `agreement-views-actions.test.ts` "행 + 값 = 갱신, 0 = 갱신(행 유지), null = 삭제"·경합 2개·"확정 버전: … 정부지원 현금 저장/삭제 모두 RULE" |
| 제안 연차 정부지원 현금 | `year-gov-support.test.ts` 9개(검증·STALE·revalidate·규칙 판정 불변) |
| 보내기·복제·빈 버전 | `agreement-views-actions.test.ts` "보내기 = null 아닌 연차만 행 1개"·"빈 버전은 정부지원 현금 0행"·"복제는 정부지원 현금 행을 새 id로 복사" |
| 참여인원 편집 | `agreement-participants-actions.test.ts` 추가·과제 경계·G-3·확정 RULE(삭제 포함)·삭제·SA-4 |
| 8-2 칸 편집 액션 AG-1 | `agreement-views-actions.test.ts` "G 재료비 현금 … 비목별·8-2 같은 값"·"편집 불가 칸 … RULE"·경합 STALE 2개 |
| 탭 5개·편성 항목 숨김·안내 문구·가져오기 2곳·YearGovSupportRow | `AgreementScreen.tsx:33-44·123·141`; `BudgetScreen.tsx:124-128·384·484·627` |
| 엑셀·복사·exceljs 2파일·비율 text·sum | `agreement-export-views.test.ts` 붙임4형·조정회의형·참여인원 내려받기 |
| 인쇄·다크 | `AgreementScreen.tsx:231` landscape, `print:hidden` 툴바; 색 토큰(위 grep) — 화면 확인은 아래 수동 표 |
| 과제 개요 불변 | `components/project/ProjectFormModal.tsx` diff 0 |
| 도움말 | `content/help/agreement.md` 2,993자 · `budget.md` 3,210자 · `calculations.md` 3,483자(diff 0); `lib/help.ts:25·58·89-90`; `help-content.test.ts` "agreement.md에 보기 3종·가져오기 절"·"Phase 26 기능·폐기된 과제 유형을 있는 것처럼 쓰지 않는다" |

**회귀 없음**
| 기준 | 근거 |
|---|---|
| Phase 24 테스트 파일 수정 범위 | `git diff --stat`: `agreement-migration.test.ts`(schema_version `≥ 6` + (h) 가드 목록 필터 한 줄), `agreement-export.test.ts`(`'participants'` → `'unknown'` 한 줄), `agreement-labels.test.ts`(schema_version 단언 2줄 — T19 정리), `tests/destructive/*`. 그 밖 Phase 24 테스트 파일 diff 0. `dashboard`·`participation`·`mapper`·`help*` 테스트는 Phase 24 이전 파일(`Year.govSupportCash` 픽스처 필드·매퍼·도움말 등록) |
| 바이트 불변 파일 | `TableActions.tsx`·`lib/agreement/table.ts`·`cell-edit.ts`·`lib/input-form*`·`lib/goal-form`·`lib/xlsx-style.ts` git diff 0 |
| 전체 스위트 | `npm test` 3852 통과·`test:destructive` 15 통과·`tsc` 0·build 성공 |

**충족 못 한 기준: 없음.** 화면 동작(인쇄 레이아웃·다크 모드 색·대화 흐름)은 자동 테스트가 없어 아래 수동 확인으로 남긴다.

### 수동 확인 주소 (dev 서버 `npm run dev` — 과제 A `aaaa0000-0000-4000-8000-000000000001`)
**데이터 준비** — 시드에는 비목 행(금액 0)·연차 2개(1차년도 `…0021`·2차년도 `…0022`)·단계 1개만 있고 인력·산출근거·협약 버전이 없다.
1. 인력: `/projects/aaaa0000-0000-4000-8000-000000000001/team`에서 인력 2명 추가(연봉 60,000,000 · 50,000,000).
2. 금액: 연구비 화면 제안 모드 매트릭스에 1·2차년도 인건비·연구활동비·연구수당·간접비 등 현금/현물 입력(또는 산출근거로 인건비 행 — 인력 연결).
3. 정부지원 현금: 매트릭스 아래 "정부지원 현금" 행에 1차년도만 입력(2차년도 비움) → 보내기 뒤 8-1에서 2차년도 "—" 확인용.
4. 단계 소계 열을 보려면 과제 화면에서 단계를 하나 더 만들고 연차를 넣는다(시드는 단계 1개라 소계 열 없음이 정상).

| 주소 | 확인할 것 |
|---|---|
| http://localhost:3000/projects/aaaa0000-0000-4000-8000-000000000001/budget | **제안 모드**: 매트릭스 아래 "정부지원 현금" 입력(비우면 "—")·"기관부담 현금" 읽기 전용 파생, 현금 합 초과 시 그 연차 경고(저장은 됨), 연차 합 ≠ 과제 개요 정부지원이면 정보 문구. 툴바 [협약 기준선으로 보내기] 옆 [붙임4 가져오기] |
| 같은 주소 | **보내기**: [협약 기준선으로 보내기] → 작성 중 버전 생성. 이후 제안 툴바 [보내기]·[붙임4 가져오기] 비활성 + 이유 |
| 같은 주소 → [수행] | **탭 5개** [비목별]·[붙임4형]·[조정회의형]·[참여인원]·[변경 이력], 편성 항목 탭 없음. 버전 0개일 때는 안내 문구 + [빈 버전]·[붙임4 가져오기] |
| 같은 주소 → [수행] → [붙임4형] | 8-1: 연차 + 합계, 기업유형 "중소기업", 정부지원 현금 칸 편집(작성 중), 2차년도 미입력 "—", 판정 "판정하지 않음 + 사유" → [연구비 규칙]에서 `gov_share_max`·`own_cash_min` 켜고 값 넣은 뒤 통과/위반. 8-2: 데이터 칸 클릭 편집 → [비목별]에 같은 값, "양식 E1(총 인건비)"·"양식 E2(수정인건비)", 연구실 안전관리비 "—", 통합관리비 행 없음, 검토사항. 버전 확정 후 편집 칸 사라짐 |
| 같은 주소 → [수행] → [조정회의형] | 변경전(제안)·변경후(이 버전) 두 표 나란히, 읽기 전용. [확정] → [새 버전](마지막 버전 복제) → 버전 선택에서 이전 버전 → "현재 버전 아님" |
| 같은 주소 → [수행] → [참여인원] | 보내기로 들어온 행의 구분 자동/수동/연봉 모름, 연차 소계·총계·금액 줄 대조 행. [추가](인력 미지정 포함)·수정(참여율만 바꾸면 자동 재계산, 금액 명시 → 수동)·삭제(확인 대화). 확정 버전은 버튼 없음 |
| 같은 주소 → 제안 툴바 [붙임4 가져오기] (작성 중 버전이 없을 때 — 버전 삭제 또는 확정 후) | `samples/붙임4. 2025_과제별 사업비검토양식_유엔이_0609.xlsx`(55KB) 업로드 → 기관 블록이 여럿이면 블록 선택(B열 텍스트 그대로) → 8-1 행 자동 대응 또는 행 선택/"8-1 쓰지 않음" → 미리보기(단위·연차×비목·줄 수·정부지원 현금·정합 경고). 과제 A는 2연차라 "연차 열 N개 대 과제 2연차" 경고가 뜨는 것이 정상 → [반영] → 결과(버전·줄 수) |
| 같은 주소 → [수행] (버전 0개) → [붙임4 가져오기] | 두 번째 진입점이 같은 대화를 연다. 10MB 넘는 파일은 업로드 전 거부 |
| 같은 주소 → [수행] → 각 보기 툴바 | [엑셀 내려받기] 파일명 `{버전 이름} 붙임4형`/`조정회의형`/`참여인원`, 붙임4형은 작성안내 + "8-1 지원·부담계획" + "8-2 사용계획" 시트, 비율 칸은 글자 `xx.xx%`. [복사] 후 엑셀에 붙여 넣기 |
| http://localhost:3000/settings | 다크 모드로 바꾼 뒤 연구비 주소로 돌아가 붙임4형·조정회의형·참여인원·정부지원 현금 행·가져오기 대화 색 확인 |
| 연구비 주소에서 Ctrl+P | 보고 있는 보기 하나만, 가로, 버튼·탭 숨김 |
| http://localhost:3000/help#agreement--%EB%B6%99%EC%9E%844%ED%98%95-8-2-%EC%82%AC%EC%9A%A9%EA%B3%84%ED%9A%8D | 협약 예산 양식 도움말 8-2 절. 같은 편 `#agreement--%EC%A1%B0%EC%A0%95%ED%9A%8C%EC%9D%98%ED%98%95`(조정회의형)·`#agreement--%EC%B0%B8%EC%97%AC%EC%9D%B8%EC%9B%90`(참여인원)·`#agreement--%EB%B6%99%EC%9E%844-%EA%B0%80%EC%A0%B8%EC%98%A4%EA%B8%B0`(붙임4 가져오기) |
| http://localhost:3000/projects/aaaa0000-0000-4000-8000-000000000001 | 단계·연차 패널에서 정부지원 현금 행만 쓰는 연차(버전에 정부지원 현금만 넣은 경우) 삭제 → "협약 예산 버전 N개가 이 연차를 씁니다" 거부 |
