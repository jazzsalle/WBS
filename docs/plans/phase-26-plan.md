# Phase 26 계획 — 규칙 검증 공통 + 증빙

> **상태: 확정 (T0, 2026-10-05).** 초안(`phase-26-plan-draft.md`, 삭제)을 U-1~U-4 사용자 답(2026-10-05 — 전부 권고안대로, 기본값 2개도 그대로)으로 확정했다. 이 결정표(S-1~S-22)는 `docs/SOT.md`(v4.9 — 상단 "Phase 26 결정" 줄)와 `evaluation_criteria.md` "## Phase 26"에 **먼저** 반영됐다. 구현이 이 표와 SOT 사이에서 갈리면 SOT가 옳다. **마지막 Phase**다 — 끝나면 Phase 23~26 수동 검증을 일괄로 한다.

## 사용자 결정 (2026-10-05 확정)
- 연구실 안전관리비: indirect 아래 **세목 신설** `indirect_lab_safety`(라벨 "연구실 안전관리비", 번호 없음). RL-22 = 안전관리비 ÷ (인건비 + 학생인건비) 1~2%, 하한·상한 코드 2개 둘 다 warn, 세목 금액 있을 때만. 기존 간접비 품명 기록 **자동 이관 안 함**(A.5·B.9.5 명시). 출처 = **간사 지침**(RuleSource 타입 확장).
- **RL-21(외주 3천만 근접 다건) 폐기** — 결번(RL-20처럼). D-8 해당 문구 폐기 표기.
- **RL-17 개정**: 금액은 **부가세 별도** 입력(사용자 확인). 장비 구입 amount × 1.1 ≥ 기준(기본 30,000,000, 부가세 포함 기준) — 정수 비교 `amount*11 >= value*10`. 경고 문구: "장비 N원(부가세 별도, 부가세 포함 M원) — 부가세 포함 3천만 원 이상 연구시설·장비: 「연구시설·장비 구입 및 활용계획서」 작성 및 전담기관 사전 승인 대상, IRIS/ZEUS 등록". SOT의 "부가세 포함 입력" 안내 → "부가세 별도 입력, 기준 비교만 ×1.1". **AG-7 변경 이력에도** 새로 기준 이상 장비(재료→장비 이관 포함)·미만→이상이면 "사전 승인 대상" 경고.
- 취소(넣지 않음): 수의계약 2천만 원 규칙, 재료비 2천만 원 변경 승인 규칙. (참고: 취소 직전 조사 에이전트가 표준매뉴얼 쪽에 "2천만 원" 관련 조항이 있다는 단서를 남김 — 나중에 다시 볼 때 출발점)
- 증빙 체크리스트: 편성 항목마다 서류 목록 "받음" 체크 + 메모, 파일 첨부 없음. **확정 버전에서도 증빙 체크·메모만 허용**(라벨 고정).
- 보내기(AV-6 ③): 제안 산출근거 facility_purchase→equipment, material_purchase→material, activity_outsourcing→outsourcing 행 1개 = 편성 항목 1건 자동 생성(기본 증빙 포함).
- RL-8·RL-9 수행 모드 = 그 버전 연차별 정부지원 현금(§5.25)·금액 줄(붙임4 8-1과 같은 수), 미입력 연차 있으면 판정하지 않음.
- 편성 항목 equipment = 구입만.

## 확정 결정 (U-1~U-4 + 기본값, 사용자 답 2026-10-05 — 전부 권고안대로)
- **U-1 증빙 기본 목록**(`AGREEMENT_EVIDENCE_DEFAULTS`):
  - 장비 = 견적서 · 비교견적서 · 구매요청서 · 계약서 · 거래명세서 · 검수조서 · 세금계산서 · ZEUS 등록 확인
  - 재료 = 견적서 · 비교견적서 · 구매요청서 · 거래명세서 · 검수조서 · 세금계산서
  - 외주 = 과업지시서 · 견적서 · 비교견적서 · 계약서 · 중간산출물 · 최종 결과물 · 검수조서 · 세금계산서
  - 3천만 원 이상 장비의 활용계획서·사전 승인은 기본 목록에 넣지 않고 **RL-17 경고로 안내**한다.
- **U-2 RL-22 기본값**: 하한 1%·상한 2%, 분모 = 인건비 + 학생인건비 **현금+현물**, 연구지원인력(`personnel_support`) 포함(= 붙임4 양식 E1). 경계 1%·2% 정확히는 **통과**.
- **U-3 편성 항목 편집 범위**: 작성 중 = 추가 · 수정(연차·종류·품명·수량·금액) · 삭제 · 증빙 항목 추가/삭제/이름 변경 · 체크 · 메모. 확정 = **체크·메모만**.
- **U-4 제출 서식 내보내기**: 안전관리비 산출 행을 서식 `나. 연구지원비` 표에 적고 **경고** + 총괄표 29행 "(간접비 중 연구실 안전관리비)"를 세목 소계로 채운다(권고안).
- **기본값**: RL-23 규칙 행이 **없으면 켜짐** / AG-7 장비 비교쌍 = **변경 이력에서 고른 A↔B**.

## 문서 충돌 (T0에서 고침 — 완료)
- `evaluation_criteria.md` Phase 26이 RL-21을 만드는 것으로 쓰여 있던 곳(머리말·마이그레이션·행 단위 규칙·동등성·RL-21 항목·보기 모델·편성 항목 보기·도움말) → RL-21 결번·코드 없음으로.
- "×1.1 부가세 환산 코드가 있으면 FAIL" → 반대로(정수 비교 `amount*11 >= value*10`, 중간 반올림 없음). "부가세 포함 안내" → "부가세 별도 입력" 안내.
- "`rules.test.ts` 무수정" 불가 — RL-17 두 케이스(경계 29,999,999 → 이제 warn · message '심의')만 수정 허용.
- `create_agreement_version`에 `p_items` 추가 → `tests/integration/agreement-forms-migration.test.ts`의 시그니처 단언(472~476행) 수정 허용(⑦). 보내기 items 단언(⑥), C.4 lab memo → breakdown 단언(⑧).
- CLAUDE.md `lib/rules.ts` 행·26행 표현 정리(메인 — 완료).

## 코드 사실 (T0 실측, 2026-10-05)
- 도움말 글자 수(JS `length`, 상한 3,500 — `tests/unit/help-content.test.ts` `MAX_HELP_CHARS`): `budget.md` **3,210**(여유 290) · `agreement.md` **2,993**(여유 507) · `calculations.md` **3,483**(여유 17 — diff 0 유지) · `budget-rules.md` 2,338(여유 1,162 — S-10 대상 아님). **agreement.md 여유 507자에 두 절("수행 모드 규칙 검증"·"편성 항목·증빙")을 넣어야 한다** — 넘치면 T15는 멈추고 보고한다(다른 파일로 옮길지는 메인이 정한다).
- `lib/rules.ts` RL-17 현재: `row.amount < equipmentRule.value` 비교, 메시지 "장비 …은 전문기관 도입 심의 대상입니다 (… 이상)", `RULE_SPECS` 라벨 "장비 도입 심의 대상 금액". `tests/unit/rules.test.ts` 423행 `toContain('심의')`, 472~477행 29,999,999 → `[]` 단언.
- `RuleSource` = `` `과기부고시 ${string}` | `기후부고시 ${string}` ``(`lib/rules-presets.ts:24`).
- `RATIO_CODES` 7종(RL-3~RL-9), `RuleFindingScope` 3종(`project`·`year`·`detail`), `RuleProjectInput`은 총액 3종만.
- `SKIP_ROW_PATTERNS`는 **정규화 후 완전 일치 집합**(`lib/import/categorize.ts` `skipPatternSet`) — `'안전관리비'`는 `연구실 안전관리비`(정규화 `연구실안전관리비`)를 걸러내지 못한다. 그래서 `'연구실안전관리비'`를 더한다(S-18).
- `SUBCATEGORY_PRESETS` 33행(indirect 3: `indirect_hr`·`indirect_support`·`indirect_outcome`).
- `ATTACHMENT4_FORM_ROWS` `lab_safety` = kind `memo`, `sources: []`(`lib/constants.ts:664`). `attachment4-view.ts` 검토사항 `lab_safety_no_source`.
- `buildBaselineFromPlan` 이슈(`negative_participant` 등)는 `ok:false` → 액션 `RULE`.
- `create_agreement_version` 현재 시그니처 6인자(`…, p_participants jsonb, p_gov_cash jsonb`).

## 결정표
| # | 항목 | 결정 |
|---|---|---|
| S-1 | 증빙 잠금 예외 | `agreement_child_guard` 재정의 — `agreement_items` UPDATE에서 부모 버전이 확정이면 **`evidence`·`updated_at`·`updated_by`·`version` 외 컬럼이 전부 같고 + 증빙 라벨 배열(순서 포함)이 같을 때만** 통과. 확정 버전 INSERT·다른 컬럼 변경·라벨 변경(추가·삭제·이름·순서)은 거부. DELETE는 트리거가 막지 않고 액션이 `RULE`. 다른 3테이블(`agreement_lines`·`agreement_participants`·`agreement_gov_support`) 동작 불변 |
| S-2 | §5.24 | 금액 줄 **대조는 표시만**(대응: equipment↔`facility_purchase`, material↔`material_purchase`, outsourcing↔`activity_outsourcing`, 연차 × 종류, 줄은 현금+현물). 편성 항목은 비목별·붙임4형 합계에 **더하지 않는다**. 증빙 기본 목록 상수 `AGREEMENT_EVIDENCE_DEFAULTS`(U-1) — 추가 시 **복사**(상수가 바뀌어도 저장값 불변) |
| S-3 | RL-17~19 수행 대상 | **편성 항목 건**(RL-17 equipment, RL-18 material 같은 품명 연차 합산, RL-19 outsourcing). 금액 줄(세목 합계)은 건이 아니다 |
| S-4 | 코드 | `lab_safety_min`(ratio_min %, 기본 1, warn) · `lab_safety_max`(ratio_max %, 기본 2, warn) · `preserve_subcategory_totals`(RL-23, 값 없음, warn, **수행 전용**). `RuleSource`에 `` `간사 지침 ${string}` `` 추가. 프리셋 D.1 10→13행, D.2 17→20행, D.3 불변. 출처 문자열(T0 보충): `간사 지침 연구실 안전관리비 (인건비 + 학생인건비의 1% 이상)` · `간사 지침 연구실 안전관리비 (인건비 + 학생인건비의 2% 이하)` · `간사 지침 세목 총액 보존 (연차 간 이동 시 세목별 총액 유지)` |
| S-5 | RL-21 | **결번**(RL-20처럼). `RuleCode`·check·`RULE_SPECS`·프리셋·도움말 어디에도 없다 |
| S-6 | 세목·RL-22 | 부록 A.5 indirect 끝에 `{code:'indirect_lab_safety', label:'연구실 안전관리비', formula:'quantity', defaultFactors: []}`. 분모 = 그 연차 `personnel` + `student_personnel` `plannedAmount`(현금+현물, `personnel_support` 포함) — `lib/budget-plan.ts`에 `totalPersonnelCost(yearTotals)`만 추가. 분자 = 그 연차 `indirect_lab_safety` 세목 소계(제안 = 산출 행 합, 수행 = 어댑터의 `subcategoryTotals`). 1%·2% 정확히는 통과. 세목 소계가 0이거나 없으면 **대상 아님**(findings·skipped 둘 다 없음). 분모 0·분자 > 0 → 켜진 코드마다 `skipped`("인건비 + 학생인건비가 0"). `ratios`에는 싣지 않는다(`RatioCode` 7종 유지) |
| S-7 | RL-23 | 규칙 행으로 켜고 끈다(**행 없으면 켜짐**). 판정은 `lib/agreement/preservation.ts` 그대로, `evaluateRules` 결과에 **합치지 않는다**. 행이 있고 꺼짐 = 세 번째 상태 **"규칙이 꺼져 있어 판정하지 않음"**("기준 버전 없음"·경고 0건과 구별). 변경 이력·수행 규칙 패널에 표시, 제안 모드에는 없다 |
| S-8 | 공통 적용 | **판정 대상** = 보고 있는 버전(작성 중·확정 모두), 고른 것이 없으면 현재 버전(AV-3), 버전 0개면 `null`("판정할 버전 없음" ≠ 빈 findings) — 순수 함수 `ruleTargetVersionId`. **어댑터** `lib/agreement/rule-input.ts` `buildAgreementRuleInput({lines, participants, items, govSupport, members, years})` → `RuleEvaluationInput`: ① 줄 → `YearTotalSource`(`personnelSupportTotal` = `personnel_support` 줄) → `buildYearTotals` ② 연차별 `subcategoryTotals`(비목·세목 → 현금+현물) ③ 참여인원 1행 → 축별 행(현금·현물, `origin` participant, category `personnel`, formula `personnel`) — RL-16 참여율은 참여인원 행당 **한 번만** 세고, 학생 구분이 없으므로 **전원** RL-16 대상 ④ 편성 항목 1건 → 행(`origin` item, equipment → `facility_equipment`/`facility_purchase`, material → `material`/`material_purchase`, outsourcing → `activity`/`activity_outsourcing`) ⑤ RL-8/9 총액: gov = ΣA(§5.25), own = Σ(그 연차 현금 − A) + Σ현물, total = gov + own. 미입력(행 없음) 연차·A > 현금 합 연차가 하나라도 있으면 총액 3종 `null` + `unavailableReason`(연차 이름 포함) → RL-8·RL-9 `skipped` ⑥ `default` 줄(activity·personnel·indirect) > 0이면 그 금액은 세목을 몰라 판정에서 빠지고, 어댑터가 그 연차의 대응 규칙(activity → RL-7, personnel → RL-11, indirect → RL-22 두 코드 — 켜진 것만)에 `skipped` "세목 미지정 {비목} N원 — 세목을 알 수 없어 판정에서 뺐습니다"를 남긴다(어댑터 출력 = `RuleEvaluationInput` + `skipped`, 판정 결과의 `skipped` 뒤에 붙인다). `lib/rules.ts` 변경은 **선택 필드만**(`RULE_SPECS` 3개 + `modes`, `subcategoryTotals?`, 행 `origin?`, 과제 `unavailableReason?`, scope `participant`·`item`, `meetsEquipmentThreshold`, RL-22) — 선택 필드가 없는 제안 경로 결과 불변 |
| S-9 | 화면 규칙 패널 | 수행 모드 **보기 탭 아래 공통 영역**, `RuleFindingsPanel` 재사용(선택 prop 추가). 머리에 판정 대상 버전 이름·RL-8/9 총액 출처(버전 정부지원 현금)·세목 미지정 메모·RL-23 상태(켜짐/꺼짐). `[연구비 규칙]`은 **버전 바 오른쪽** — `BudgetScreen`과 같은 `RulesEditor` 모달(같은 규칙 행). 클릭 이동 3종: 연차 → [비목별] 그 연차, 참여인원 → [참여인원] 그 행, 건 → [편성 항목·증빙] 그 행. 규칙 0건 → 안내 + [연구비 규칙], 버전 0개 → 숫자 없음 |
| S-10 | 탭 6개 | `[비목별]`·`[붙임4형]`·`[조정회의형]`·`[참여인원]`·`[편성 항목·증빙]`·`[변경 이력]`. 편성 항목 보기: 연차 그룹 → 종류 → 품명. 열 = 연차 · 종류(라벨) · 품명 · 수량 · 금액 · 증빙 n/m · 경고 배지 · [증빙] · [수정] · [삭제]. 연차·종류별 **대조 행**(표시만). 증빙은 행 아래 펼쳐 편집. 툴바 `[편성 항목 추가]`(작성 중만) · `[엑셀 내려받기]` · `[복사]`. 인쇄 = 다른 보기와 같다. 엑셀·TSV는 한 시트 "편성 항목·증빙"(증빙 칸 = "받음 n/m" + 항목별 "라벨: 받음/안 받음 · 메모" 글자). 도움말: `agreement.md` "수행 모드 규칙 검증"·"편성 항목·증빙" 절 + `budget.md` 한 줄, `calculations.md` diff 0 |
| S-11 | Realtime | `agreement_items` **구독하지 않는다**(화면당 4테이블 상한 R-1). publication 추가 없음 |
| S-12 | 액션 | `actions/agreement-items.ts`: `addAgreementItem(versionId, {yearId, kind, name, amount, quantity \| null, evidence?})` · `updateAgreementItem(id, patch, expectedVersion)`(`evidence` 키 금지) · `updateAgreementItemEvidence(id, evidence, expectedVersion)`(확정이면 라벨 배열 동일일 때만) · `deleteAgreementItem(id)`(확정 `RULE`). `actions/agreement.ts` 확장: `getAgreementData`가 버전별 `itemsView`·`ruleResult`·`preservationStatus`와 `rules`를 싣고, `getAgreementChanges`에 `equipmentApproval`, 보내기 미리보기·결과에 편성 항목 건수. `buildAgreementWorkbook` view `'items'`. 검증: name 1~200자, amount 안전 정수 ≥ 0, quantity null \| ≥ 0, evidence ≤ 30개, label 1~100자·한 항목 안 중복 금지, memo ≤ 500자. DB check `agreement_evidence_is_valid(jsonb)` |
| S-13 | §11 26 완료 기준 | 같은 편성이면 제안·수행 판정이 같다(scope 행 식별자만 다름) · RL-8/9 버전 기반 · RL-22·RL-17 경계 · AG-7 장비 사전 승인 · 증빙 확정 예외 · 보내기 편성 항목 · 세목 추가 전파(입력 양식·임포트·내보내기·붙임4) 기존 수치 불변 · `schema_version` 7 유지 |
| S-14 | 보내기 편성 항목 | `facility_purchase`·`material_purchase`·`activity_outsourcing` 산출 행 1개 = 1건. name = trim(품명)(비면 세목 라벨), amount = 산출 행 `amount`(PL-D7), quantity = 첫 `수량` 인자(없거나 음수면 null), evidence = 그 종류 기본 목록. 음수 금액 행은 이슈 `negative_item`(보내기 `RULE`, 위치 적음). RPC `create_agreement_version`에 `p_items jsonb default '[]'`(6인자 drop → 7인자). 붙임4 가져오기·빈 버전은 0건 |
| S-15 | 8-2 규칙 판정 줄 | `lib/agreement/rule-view.ts`: 8-2 아래에 RL-4(= 양식 I/E2)·RL-3(분모 `base` 라벨 명시) 판정 줄 + "표의 간접비 비율은 양식 분모라 RL-3과 다를 수 있습니다". 판정은 같은 `evaluateRules` 결과. 8-1(RL-8·RL-9) 표시는 Phase 25 그대로 |
| S-16 | C.4 lab_safety | 종류 memo → **`breakdown`**(내역 행 — 값은 보이지만 K·L·M·양식 분모에 다시 더하지 않는다). 소스 = `indirect_lab_safety` 현금+현물, 줄이 없으면 "—". 검토사항 `lab_safety_no_source` 삭제. 가져오기: 값 → `indirect_lab_safety` 현금 줄, L의 `default` 현금 = 파일 L − 그 값(음수면 blocking `lab_safety_exceeds_indirect`, 0이면 L 줄 없음) |
| S-17 | 입력 양식 | 사업비 시트에 새 세목 블록(성과활용지원비 뒤, 빈 줄 3 + 소계 1 = 4행, 그 아래 좌표 +4 — T8 실측). `INPUT_FORM_VERSION` **1 유지**. 옛 파일(`_meta.subcategoryCodes`에 `indirect:indirect_lab_safety` 없음)은 거부하지 않는다 — 그 세목 0행으로 읽고, DB에 그 세목 행이 있으면 미리보기 경고(막지 않음). 인건비 시트·작성안내·`_meta` 기존 키·목표 양식 바이트 불변 |
| S-18 | 임포트 | 산출근거(§6.11): 간접비 섹션 세목 헤더를 **A.5 라벨로 먼저 매칭**, `SKIP_ROW_PATTERNS`는 비목 판정 단계에서만 적용, 컬럼 헤더 아래 데이터 행의 품명은 헤더가 아니다(B.7 `나. 연구지원비` 품명 "연구실 안전관리비" 행 오인 금지 — B.8 불변). 총괄표(§6.8): 괄호 행은 memo 그대로, `SKIP_ROW_PATTERNS`에 `'연구실안전관리비'` 추가. 부록 C에 명시. B.7·B.8 수치 불변 |
| S-19 | 제출 서식(U-4) | 산출근거 서식에 연구실 안전관리비 표가 없다 → 그 산출 행을 `나. 연구지원비` 표에 적고 경고("…다시 가져오면 연구지원비로 읽힙니다"). 총괄표 29행 "(간접비 중 연구실 안전관리비)" = 그 연차 세목 소계(행이 없으면 비우고 알림 — X-10d 그대로). 통합관리비 행은 그대로 비우고 알린다. Phase 11 왕복: 안전관리비 행이 없는 기존 픽스처는 그대로 통과, 안전관리비 행은 다시 가져오면 `indirect_support`로 돌아온다(간접비 합계 불변 — 경고 문구가 알린다) |
| S-20 | AG-7 장비 사전 승인 | `lib/agreement/equipment-approval.ts` `diffEquipmentApproval(itemsA, itemsB, rule)` — 키 (연차, trim 품명). B의 장비 건이 기준 이상(`meetsEquipmentThreshold`)인데 A에 같은 키 **장비** 건이 없음(재료 → 장비 이관 포함) 또는 A의 같은 키 장비가 전부 기준 미만 → 경고 "사전 승인 대상". (T0 보충: A에 같은 키 장비가 여럿이면 **하나라도 기준 이상이면 이미 대상**으로 본다.) RL-17 행이 꺼졌거나 없으면 판정하지 않음(그 사실 표시). 화면 목록만 — 변경 이력 엑셀 불변 |
| S-21 | 마이그레이션 | `supabase/migrations/20261005000000_rules_common_evidence.sql` 하나: `budget_rules` code check(이름은 `pg_constraint`로 확인 후 drop/add)·`value_range`·`enabled_value` check 갱신, `agreement_evidence_is_valid(jsonb)` + `agreement_items` check, `agreement_child_guard` 재정의(S-1), `create_agreement_version` `p_items`(6인자 drop → 7인자). publication·`restore_backup`·`BACKUP_TABLES` 불변, **`schema_version` 7 유지**, 전부 `security invoker` |
| S-22 | 리포지토리 | `lib/db/agreements.ts`: `getItemById` · `insertItem` · `updateItem` · `updateItemEvidence` · `removeItem`, `createVersion`에 `items`. 가드 거부 → `RuleViolationError`, version 0행 → `StaleDataError` |

**T0 보충 결정**(초안에 없던 세부 — SOT에 같이 반영, 메인 확인 대상): S-4 출처 문자열 · S-6 분자의 제안/수행 출처 · S-8 ⑥ 비목 → 규칙 대응과 "금액만 빠지고 skipped를 붙인다"는 해석 · S-8 scope 새 종류 `participant`·`item`(초안 "scope id만 다름"·T2 "소비처 exhaustive 분기"에서 읽음) · S-10 엑셀 증빙 칸 글자 형식·인쇄는 n/m만 · S-19 왕복 결과 · S-20 A쪽 여러 건 처리 · B.9.7 과제 총액 3종(초안 비율에서 역산 — gov/total·(own−현물)/own이 초안 % 와 일치) · RL-17 `RULE_SPECS` 라벨 = "장비 사전 승인 대상 금액 (부가세 포함 기준)" · RL-17 메시지의 "3천만 원"은 규칙 `value`로 적는다(`부가세 포함 {value}원 이상`).

## 픽스처 (원 단위 — SOT 부록 B.9.5~B.9.8로 먼저 올림)
- **B.9.5 RL-22**(1개 연차): `personnel_internal` 현금 80,000,000 + 현물 16,000,000 + `personnel_support` 현금 4,000,000 → 분모 100,000,000. 안전관리비 1,000,000 → 통과 / 999,999 → min warn / 2,000,000 → 통과 / 2,000,001 → max warn / 없음·0 → 0건 / 인건비 0 + 500,000 → skipped 2건 / `student_general` 현금 10,000,000 추가 → 분모 110,000,000 → 1,000,000 = 0.9091% min warn / 수행 `indirect`/`default` 300,000 + 세목 줄 없음 → skipped 미지정 / B.7 `indirect_support` 품명 "연구실 안전관리비" 2,000,000 → 판정 안 함.
- **B.9.6 RL-17**(value 30,000,000): 27,272,727 → 없음 / 27,272,728 → warn(actual 27,272,728, limit 30,000,000, 메시지 "부가세 포함 30,000,000원" — 표시 버림) / 29,999,999 → warn(Phase 13 경계 개정) / 30,000,000 → warn / 35,000,000 → warn(B.9.3 불변) / `facility_lease` 35,000,000 → 없음.
- **B.9.7 제안·수행 동등성**(`moe_energy_sme` + 새 코드, 산출근거로 모든 셀, 제안 `govSupportCash` = `govBudget`): EQ-1(B.9.1 금액, 총액 gov 200,000,000·own 98,510,000·total 298,510,000 — RL-3 0.9622%·RL-5 info·RL-8 66.9994%·RL-9 10.0091%), EQ-2(B.9.2, 총액 gov 30,000,000·own 14,500,000·total 44,500,000 — RL-16 C error·RL-14 A warn·RL-5 info·RL-8 67.4157%·RL-9 82.7586%), EQ-3(B.9.3 전부 현금, 총액 gov 60,000,000·own 25,990,000·total 85,990,000 — RL-17 warn 35,000,000·RL-18 warn 21,000,000·RL-19 없음·RL-7 34.8761%·RL-4/5 skipped "수정인건비가 0"·RL-8 ≈69.7756%·RL-9 100%, 보낸 버전 편성 항목 4건·대조 0). 다를 수 있는 것 = scope 행 식별자뿐.
- **수행 RL-8/9**: Phase 25 8-1 픽스처 → RL-8 66.5399%·RL-9 43.1818%(= 8-1 합계), Y2 미입력 → skipped, 기호 혼동 RL-4 분모 40,000,000 → 7.5%, `activity`/`default` 1,000,000 → RL-7 skipped.
- **판정 대상**: [] → null / [v1 확정, v2 작성 중] 보고 있는 v2 → v2 / 고른 것 없음 → v1.
- **증빙 잠금**: 확정 버전 장비 33,000,000, 증빙 [견적서 true "2개사"] — 체크 해제·메모 성공, 라벨 변경·추가 RULE + DB 거부, 금액 등 거부, INSERT 거부, DELETE 액션 RULE, 작성 중은 전부 허용.
- **B.9.8 AG-7**: A(확정 final) → B(작성 중): 재료 "분광기" 28,000,000 → 장비 "분광기" 28,000,000 → 경고 / 장비 "오실로스코프" 27,000,000 → 27,272,728 → 경고 / 장비 "레이저" 40,000,000 → 41,000,000 → 없음 / 신규 장비 "현미경" 20,000,000 → 없음. 결과 2건, B의 RL-17은 3건.
- **C.4 안전관리비**: 버전 A Y1 `indirect_hr` 2,500,000 → hr 2,000,000 + lab 500,000 → 8-2 lab 행 Y1 500,000·Y2 "—", L·M·양식 분모 6.25% 불변. 가져오기 L 2,500천원 + lab 500천원 → default 2,000,000 + lab 500,000, lab 3,000 > L 2,500 → blocking. Phase 25 파서 합계 105,200,000 불변.

## 태스크 (웨이브마다 tsc 초록)
T0 문서(완료) → W1 {T1 마이그레이션, T2 타입·상수·스키마 기반, T15 도움말} → W2 {T3 판정기, T4 편성 항목·증빙 모델, T5a 보내기 편성 항목, T5b C.4 안전관리비, T7 리포지토리(←T1), T8 입력 양식 세목, T9 임포트·내보내기 세목} → W3 {T6 수행 어댑터·rule-view·equipment-approval(←T3·T5a), T10 편성 항목 액션(←T4·T7), T12 편성 항목 엑셀(←T4), T13 규칙 UI 공통화(←T3)} → T11 조회·보내기 액션(←T6·T7·T4·T5a) → T14 편성 항목 화면(←T4·T10·T12) → T16 셸 통합(←T11·T13·T14) → T17 통합 검증(Phase 23~26 일괄 수동 검증 표 포함).

| 태스크 | 대상 파일 | 핵심 완료 기준 |
|---|---|---|
| T0 결정 확정 (완료) | `docs/SOT.md`, `evaluation_criteria.md`, 이 파일(초안 대체·초안 삭제), brief(D-8·D-10·D-12 주석, §3.4·§5 표 26행 취소선) | `grep "Phase 26 T0" docs/SOT.md` 0, RL-21은 폐기 문맥만, "부가세 포함 금액을 입력" 류 0, 결정표 ↔ SOT 대조 |
| T1 | 새 마이그레이션, `tests/integration/rules-evidence-migration.test.ts`; 허용: agreement-forms-migration 472~476 시그니처, budget-rules-migration 코드 목록 | db push, 새 코드 3종·check 20, 가드 S-1 직접 UPDATE/INSERT, 다른 3테이블 가드 통과, evidence 모양 거부, p_items 검증, definer 0, schema_version 7 |
| T2 | `types/index.ts`, `lib/constants.ts`(`SUBCATEGORY_PRESETS`·`AGREEMENT_EVIDENCE_DEFAULTS`·`AGREEMENT_ITEM_SUBCATEGORY`·lab breakdown·SKIP), `lib/db/schema.ts`, `lib/rules.ts`(`RULE_SPECS`·scope 타입만), `lib/rules-presets.ts`(타입만), 소비처 exhaustive 분기, tests(새 상수 테스트·세목 개수 33→34·mapper evidence) | tsc 0, DB check = `RuleCode` = Zod = `RULE_SPECS`, 기존 세목 불변 |
| T15 | `content/help/agreement.md`·`budget.md`, `lib/help.ts`, `tests/unit/help-content.test.ts`(231~238: 편성 항목·증빙·RL-22만 해제 — 과제 유형·RL-20·RL-21 금지 유지) | 3,500자(agreement.md 여유 507 — 넘치면 멈추고 보고), calculations.md 0, 앵커 |
| T3 | `lib/rules.ts`, `lib/rules-presets.ts`(행), `lib/budget-plan.ts`(`totalPersonnelCost`만), `tests/unit/rules-common.test.ts`, `rules.test.ts`(RL-17 두 케이스만), `rules-presets.test.ts`(개수만) | B.9.5·B.9.6, 새 코드 없는 집합 결과 = 기존, B.9.1~4 무수정, 재구현 0, 정수 비교. 프리셋 행 수로 tutorial/budget-rules 테스트 "추가 N" 바뀌면 그것만 허용 |
| T4 | `lib/agreement/evidence.ts`, `items-view.ts`, `tests/unit/agreement-items.test.ts` | 대조 표시만, finding만 부착, 저장값 불변, 라벨 |
| T5a | `lib/agreement/from-plan.ts`, `tests/unit/agreement-from-plan-items.test.ts`; 허용: agreement-core `items: []` | 매핑·빈 품명·quantity·음수, 줄·참여인원·정부지원 불변 |
| T5b | `form-rows.ts`, `attachment4-view.ts`, `attachment4-parse.ts`, `tests/unit/agreement-lab-safety.test.ts`, 픽스처 변형; 허용: views·parse 테스트의 lab 단언 | C.4 픽스처, L·K·M 불변, `table.ts`·`cell-edit.ts` diff 0 |
| T7 | `lib/db/agreements.ts`, `tests/integration/repos-agreement-items.test.ts`; 허용: repos-agreements 85행 헬퍼 | 가드 → RULE, 0행 → STALE, createVersion items |
| T8 | `lib/input-form/{layout,build,parse,preview}.ts`, `actions/input-form.ts`, 입력 양식 테스트(새 행·좌표만), `tests/unit/input-form-old-file.test.ts` | 옛 파일 0행+경고, `_meta`·인건비 시트·작성안내·목표 양식 바이트 불변, exceljs 2파일 |
| T9 | `lib/import/detail-sheet.ts`, `lib/export/{layouts,summary-sheet,detail-sheet}.ts`, `templates/산출근거_표준.map.json`, `actions/export.ts`, 새 테스트 2개, export-layout 29행 단언 | B.7·B.8 불변, Phase 11 왕복(S-19), 경고, skip |
| T6 | `lib/agreement/rule-input.ts`, `rule-view.ts`, `equipment-approval.ts`, `tests/unit/agreement-rules.test.ts` | B.9.7 동등성, 8-1 교차, B.9.8, null ≠ 빈 findings, 재사용 |
| T10 | `actions/agreement-items.ts`, `tests/integration/agreement-items-actions.test.ts` | Zod strict·SA-1·SA-4, 경계, 확정 RULE(증빙은 S-1), STALE |
| T11 | `actions/agreement.ts`, `tests/integration/agreement-rules-actions.test.ts`; 허용: agreement-actions 보내기 items 단언·532행 주석 | ruleResult·itemsView·preservationStatus, 조회 실패 명시, 보내기 편성 항목, equipmentApproval |
| T12 | `actions/agreement-export.ts`, `tests/integration/agreement-export-items.test.ts` | exceljs 재로드 = TSV, Phase 24·25 export 무수정 |
| T13 | `components/budget/rules/*`, `BudgetPlanPanel.tsx`(부가세 별도 안내), `actions/budget-rules.ts`(필요 시), `tests/integration/budget-rules-phase26.test.ts` | 제안 모드 표시 불변, 새 코드 입력, RL-23 수행 전용 |
| T14 | `components/budget/agreement/ItemsView.tsx`·`ItemDialog.tsx`·`EvidenceEditor.tsx` | 열·대조·배지, 작성 중 편집/확정 체크·메모만, 부가세 별도 안내, `TableActions` 재사용 |
| T16 | `AgreementScreen.tsx`, `BudgetScreen.tsx`, `Attachment4View.tsx`, `ChangesView.tsx`, `CategoryView.tsx`·`ParticipantsView.tsx`(강조 prop), `SendBaselineDialog.tsx`, `page.tsx`(필요 시) | 탭 6개, 클릭 이동, 구독 4테이블 불변, Phase 24·25 동작 불변 |
| T17 | 이 파일 결과 절, PROGRESS.md | tsc·npm test(seed 재적용)·destructive·build(:3000 확인), grep, 가드 diff, Phase 23~26 일괄 수동 검증 표 |

**소유권**: types·constants·schema·mapper = T2 / `lib/rules.ts`·`rules-presets.ts` = T2(타입) → T3 / `budget-plan.ts` = T3(새 함수만) / 마이그레이션 = T1 / `lib/db/agreements.ts` = T7 / `lib/agreement`: evidence·items-view = T4, from-plan = T5a, form-rows·attachment4-view·attachment4-parse = T5b, rule-input·rule-view·equipment-approval = T6 / input-form = T8 / import·export·templates·actions/export = T9 / actions/agreement-items = T10, agreement = T11, agreement-export = T12, budget-rules·rules 컴포넌트·BudgetPlanPanel = T13 / 편성 항목 컴포넌트 = T14 / AgreementScreen·BudgetScreen·나머지 agreement 컴포넌트 = T16 / help = T15. **아무도 고치지 않음**: `lib/agreement/table.ts`·`cell-edit.ts`·`preservation.ts`·`diff.ts`·`changes-table.ts`, `TableActions.tsx`, `lib/db/backup.ts`, `lib/goal-form/`·`lib/hwpx/`, `calculations.md`, 허용 목록 밖 Phase 24·25 테스트. 새 액션 파일은 `toFailure`·`computeOrCorrupt` 자체 사본.

**Phase 24·25 테스트 수정 허용 사유**(평가 기준과 같다): ① 탭 5 → 6 ② 편성 항목 쓰기가 리포지토리로 들어와 헬퍼의 직접 INSERT 정리 ③ 세목 추가에 따른 개수·행 순서·바이트 단언 ④ RL-23 규칙 행화에 따른 단언 ⑤ (해당 없음 — `schema_version` 7 유지) ⑥ 보내기 결과의 `items` 단언 ⑦ `create_agreement_version` 시그니처 단언(agreement-forms-migration 472~476) ⑧ C.4 lab memo → breakdown 단언. 수치 단언(S-20·Phase 25 픽스처) 수정은 FAIL.

**주의**: npm test는 시드 삭제(seed.sql 재적용) / dev 서버 떠 있으면 build 금지 / db push는 `--db-url` TEST_DATABASE_URL / 협약 버전 테스트 afterAll에서 `agreement_versions` 먼저 삭제 / exceljs 2파일·SheetJS server-only / schema_version 7 유지(올리면 FAIL) / 판정 결과·대조 차액 저장 안 함.

## T0 결과 (2026-10-05)

**SOT 반영 위치**: 상단 요약(D-8 주석·D-10·Phase 26 줄·"Phase 26 결정" 줄) · §5.1 표 · §5.18(`RuleCode` 3종·RL-D2·`RuleSource` 간사 지침) · §5.21 AV-2(증빙 잠금 예외)·AV-6 ③(보내기 편성 항목)·AV-7 ⑤ · §5.24(대조 표시만·증빙 기본 목록 표·잠금 예외·금액 부가세 별도·검증) · §6.8 I-5(SKIP) · §6.11 D-2a(헤더 매칭 순서) · §6.12 X-10d(U-4) · §6.14 머리·RL-1·RL-8·RL-9·RL-17·§6.14.5·§6.14.6 scope·§6.14.7 입력(어댑터)·§6.14.8(RL-21 결번·RL-22 확정·RL-23 규칙 행·공통 적용 S-8) · §6.16 IN-4a(새 세목 행·`INPUT_FORM_VERSION` 1·옛 파일) · §6.19 AG-1·AG-3(S-15 판정 줄·내역 행)·AG-6·AG-7(S-20)·AG-9 · §7.9(규칙 검증 패널·보내기 대화)·§7.9.2(부가세 별도 안내·새 세목)·§7.9.5(수행 모드 개정)·§7.9.8(탭 6개·편성 항목 보기·규칙 패널·인쇄·도움말) · §7.16 HP-1 · §8.5 · §8.6(리포지토리 편성 항목 쓰기) · §8.7 K-9 · §8.8 · §9(Phase 26 액션 시그니처 확정·RPC·가드) · §10(디렉터리·`getAgreementData`) · §11 26행 · 부록 A.5 · 부록 B.9.5~B.9.8 · 부록 C(SKIP·주의 3·C.4 내역 행) · 부록 D.1·D.2(+3행)·머리말.

**brief**(`v4.9-agreement-budget-brief.md`): D-8(RL-21 폐기·부가세 별도)·D-10(판정 대상·RL-22 하나)·D-12(RL-23 규칙 행) 주석, §3.2 편성 항목 금액 주석, §3.4 과제 유형별 비율 자동·근접 다건 취소선·장비 부가세 주석, §5 표 26행 "새 규칙 3종" 취소선.

**evaluation_criteria.md Phase 26**: 머리말의 "T0에서 정할 항목 ①~⑭" → "계획서 S-1~S-22대로" + U-1~U-4·기본값 요약. RL-21을 만드는 서술 전부 → 결번·코드 있으면 FAIL. "×1.1 환산 코드가 있으면 FAIL" → 정수 비교 `amount * 11 >= value * 10`·중간 반올림 없음, 부동소수점 `* 1.1` 0. "부가세 포함 안내" → "부가세 별도 금액 — 장비 기준은 ×1.1로 비교". `rules.test.ts` 무수정 → RL-17 두 케이스만 수정 허용. Phase 24·25 테스트 수정 사유 ⑥ 보내기 items · ⑦ create RPC 시그니처(agreement-forms-migration 472~476) · ⑧ C.4 lab memo → breakdown 추가(⑤는 schema_version 유지로 해당 없음). 증빙 잠금 예외·RL-23 꺼짐 세 번째 상태·AG-7 장비 사전 승인(B.9.8)·RL-22(B.9.5)·RL-17(B.9.6)·동등성(B.9.7)·schema_version 7 유지·agreement_items 미구독 항목 확정. help 테스트 금지어는 과제 유형·RL-20·RL-21 유지(편성 항목·증빙·RL-22만 해제).

## T8 입력 양식 차이

- **기존 단언 수정 0건.** 입력 양식 테스트(layout·build·parse·preview·style·adapter·boundary·roundtrip)는 좌표를 `INPUT_FORM_SHEETS`·`columnOf`·행 탐색으로 구하고 사업비 시트 행 수·간접비 좌표를 숫자로 박은 단언이 없어, 새 세목 슬롯이 생겨도 그대로 통과한다. 목표 양식 테스트도 무수정 통과. 기대 바이트 픽스처(저장된 xlsx)는 저장소에 없다.
- **새 행 = 슬롯 4행**: 생성기는 세목마다 빈 줄 3 + 세목 소계 1(§7.9.7)을 깔므로 안전관리비 슬롯은 `다. 성과활용지원비 소계` 바로 뒤 4행이고 그 아래 행(간접비 소계·기타 비목·총액)은 **+4행** 밀린다(기존 행이 있으면 +그 행 수). IN-4a·S-17의 "새 세목 행 하나 / 좌표 +1"은 "세목 슬롯 하나"로 읽었다 — 문구 정정 여부는 메인 확인.
- **코드 변경**: `lib/input-form/preview.ts`만 — `_meta.subcategoryCodes`에 `indirect:indirect_lab_safety`가 없고 그 연차 기존 산출근거에 그 세목 행이 N > 0이면 `warnings`에 `lab-safety-missing` "이 양식에는 연구실 안전관리비 행이 없습니다 — 간접비가 교체 대상이면 기존 N행이 지워집니다"(SOT IN-4a 문구, 막지 않음). layout·build·parse는 프리셋에서 슬롯을 파생하므로 무수정, `actions/input-form.ts`는 미리보기가 이미 연차 산출근거 전체를 받아 무수정.
- **새 테스트** `tests/unit/input-form-old-file.test.ts`: 옛 생성기를 `vi.doMock('@/lib/constants')`(간접비 프리셋에서 안전관리비만 뺀 모듈 그래프)로 실제로 돌려 새 양식과 격자째 대조 — 슬롯 앞 행 동일, 슬롯 뒤 행은 수식 좌표 +4만 다르고 간접비 소계 SUM에 안전관리비 소계 하나 추가, 작성안내·인건비 시트·파일명 동일, `_meta`는 키 한 행 삽입 외 동일, `INPUT_FORM_VERSION` 1. 옛 파일 xlsx 왕복: 거부 없음·0행·경고(N=2)·교체 시 삭제 목록, 간접비 미교체 시 경고 + 유지, 기존 행 없거나 `indirect_support` 품명 "연구실 안전관리비"만 있으면 경고 없음, 새 파일 왕복 전 행 unchanged.

## T17 검증 결과 (2026-10-05)

### 명령
| 명령 | 결과 |
|---|---|
| `npx tsc --noEmit` | 0 오류 (T17 수정 전·후 모두) |
| `npm test` 1회차 | 163 파일 · 4187 테스트 중 **1 실패**: `tests/unit/agreement-view-labels.test.ts` "협약 보기 고정 문구가 부록 A.4와 같다" — 아래 "T17에서 고친 것" ① |
| `npm test` 2회차(수정 후) | **163 파일 · 4187 테스트 전부 통과**(282s) |
| 시드 재적용 | `npm test` 뒤 과제 A 사라짐(기존 동작) → `supabase/seed.sql`을 `.env.test.local` `TEST_DATABASE_URL`로 재적용, `aaaa0000-0000-4000-8000-000000000001` '과제 A'(단계 1 · 연차 2 · Task 7 · 비목 행 24 · 협약 버전 0 · 규칙 0) 확인 |
| `npm run test:destructive` | **1 파일 · 15 테스트 통과**(v7 왕복에 확정 버전 아래 편성 항목·증빙 + 새 코드 규칙 행 2종, v4·v5·v6 거부 그대로). afterAll로 시드 다시 사라짐 → 재적용·확인(위와 같은 수) |
| `npm run build` | 직전 `netstat` :3000 LISTEN 없음 확인 후 성공(`/projects/[id]/budget` 106 kB / First Load 308 kB) |
| `.next/static` 문자열 | `SheetJS`·`sheetjs`·`xlsx.full`·`sheet_to_json`·`book_new`·`xl/workbook`·`ExcelJS`·`exceljs`·`service_role`·`SERVICE_ROLE` 전부 0 파일 |

### T17에서 고친 것
- ① T2가 RL-23 꺼짐 문구 `preservationRuleOff`를 `AGREEMENT_VIEW_TEXT`(부록 A.4 "협약 보기 고정 문구" 표 — Phase 25 테스트가 표와 정확히 같음을 단언)에 넣어 Phase 25 테스트가 깨졌다. 이 문구는 A.4 표가 아니라 §6.14.8·AG-7의 RL-23 세 번째 상태라 **Phase 25 테스트·SOT A.4를 고치지 않고** `lib/constants.ts`에 독립 상수 `PRESERVATION_RULE_OFF_TEXT`로 옮겼다. 소비처 4곳(`actions/agreement.ts`·`actions/agreement-export.ts`(지역 사본 제거)·`ChangesView.tsx`·`RuleFindingsPanel.tsx`(하드코딩 문자열 → 상수))과 Phase 26 테스트 `agreement-rules-actions.test.ts`의 참조 이름만 바뀌고 글자·동작은 같다.
- ② `tests/destructive/backup-roundtrip.test.ts`: 평가 기준 "새 코드 규칙 행이 v7 왕복으로 그대로 돌아온다"를 덮는 단언이 없었다(편성 항목·증빙은 Phase 24부터 있음). 픽스처에 `lab_safety_min`(켜짐 1.5)·`preserve_subcategory_totals`(꺼짐 null) 2행을 **추가**하고, 변조 단계에서 앞 행 삭제·뒤 행 켜기 → 복원 뒤 원값 단언을 더했다. 기존 단언 수정 0.

### 가드 재정의 diff (S-1 — 직전 정의 `20261001000000_agreement_budget.sql:196` 대비. `20261003000000`은 트리거만 추가하고 함수를 재정의하지 않았다)
```diff
   if v_status = 'confirmed' then
-    raise exception '확정된 협약 예산 버전의 내용은 고칠 수 없습니다 — 확정을 취소하거나 새 버전을 만드세요';
+    if not (
+      tg_op = 'UPDATE'
+      and tg_table_name = 'agreement_items'
+      and (to_jsonb(new) - array['evidence', 'updated_at', 'updated_by', 'version'])
+          = (to_jsonb(old) - array['evidence', 'updated_at', 'updated_by', 'version'])
+      and jsonb_path_query_array(to_jsonb(new) -> 'evidence', '$[*].label')
+          = jsonb_path_query_array(to_jsonb(old) -> 'evidence', '$[*].label')
+    ) then
+      raise exception '확정된 협약 예산 버전의 내용은 고칠 수 없습니다 — 확정을 취소하거나 새 버전을 만드세요';
+    end if;
   end if;
```
그 밖(버전 이동 거부·버전 없음·연차 경계·참여인원 인력 경계·`returns trigger language plpgsql`) diff 0. 다른 3테이블 동작 불변은 `rules-evidence-migration.test.ts` "(c) 다른 3테이블은 값이 같은 UPDATE도 이전처럼 거부한다"와 Phase 24·25 가드 테스트 무수정 통과로 확인.

### grep·경계
| 검사 | 결과 |
|---|---|
| `project_type`·`projectType`·`ProjectType`(app·components·lib·actions·types·content·tests·마이그레이션) | 코드 0. 남은 것은 `agreement-forms-migration.test.ts:7·138·142`(컬럼이 **없음**을 단언)뿐 |
| RL-20·RL-21 | 코드 0. 언급은 `types/index.ts:935`·마이그레이션 `:33` 주석("결번")과 부정 단언 테스트(`rules-evidence-migration.test.ts:168`·`agreement-item-constants.test.ts:221`·`help-content.test.ts:231-234`)뿐. 근접 다건 판정(`근접`·`near`·`proximity`·유사 품명) 0 — `lib/dashboard.ts:112` "최근접" 주석은 무관 |
| 판정 재구현 | `lib/agreement/rule-input.ts:17·25·374·414`가 `buildYearTotals`·`evaluateRules`, `equipment-approval.ts:12·71·74`가 `meetsEquipmentThreshold`를 쓴다. `rule-view.ts`·`items-view.ts`는 결과의 `ratios`·`findings`·`skipped`를 읽기만 한다(비율·한도 비교 산식 grep 0). 소스 검사 테스트: `agreement-rules.test.ts` "판정기는 하나 — 새 모듈에 판정 로직·분모 산식이 없다", `rules-common.test.ts` "lib/rules.ts 소스 경계" |
| 부동소수 `* 1.1`·`1.1 *` | app·components·lib·actions·types 0. RL-17 = `lib/rules.ts:327-328` `amount * 11 >= value * 10` |
| UI·액션 supabase 직접 호출 | `app/`·`components/`·`actions/`의 `.from(`·`.rpc(`·`createBrowserClient`·`createServerClient` 0, 값 import `@supabase/` 0. `.channel(`은 `components/RealtimeRefresher.tsx:123`(Realtime 예외)뿐 |
| `service_role` | 코드 사용 0 — `lib/db/*.ts` C-1 예외 주석·`lib/hr-key.ts:5` 주석·`src-tauri/scripts/prepare-sidecar.mjs` 차단 가드뿐. `.next/static` 0 |
| exceljs import 파일(테스트 제외) | 정확히 2개: `lib/input-form-adapter.ts`·`lib/xlsx-style.ts` |
| xlsx import 파일(테스트 제외) | 2개: `lib/import-adapter.ts`·`lib/export-adapter.ts` |
| 양식 전용 저장 칸·파일 첨부 | 마이그레이션에 `create table`·`add column`·`storage.`·`bucket` 0. 편성 항목 컴포넌트·액션·`evidence.ts`에 파일 입력·경로 필드 0. 증빙 저장소는 `agreement_items.evidence` 하나 |
| `dangerouslySetInnerHTML` | `app/`·`components/`·`lib/`에서 쓰지 않는다는 주석 2건(`MarkdownViewer.tsx:4`·`lib/notes.ts:5`)뿐 |
| `schema_version`·`BACKUP_TABLES` | `EXPECTED_SCHEMA_VERSION = 7`(`lib/constants.ts:51`), 마이그레이션은 schema_version을 건드리지 않음(`:7` 주석), `lib/db/backup.ts` git diff 0, `rules-evidence-migration.test.ts` "app_settings.schema_version = 7 유지" |
| Realtime | `app/projects/[id]/budget/page.tsx:28` 4테이블 불변(`app/` diff 0), `agreement_items` 구독 0, publication 불변(테스트 "(e) Realtime publication은 바뀌지 않았다") |
| `samples/` 추적 | `git ls-files samples` 0, `.gitignore:9` |
| 새 `?? []`·catch 폴백 | 검토 결과 문제 없음: `lib/db/agreements.ts` `(data ?? [])[0]`·`.length === 0`은 0행을 `NotFoundError`로 바꾸는 경로, `createVersion`의 `(input.items ?? [])`는 선택 인자(빈 버전·가져오기 = 0건이 명세), `RuleFindingsPanel` `notices ?? []`는 선택 prop, `Attachment4View` `rules.lines[0]?.years ?? []`는 판정 줄 0개일 때 머리 열, `equipment-approval.ts:72`는 Map 조회(A에 같은 키 없음 = 명세의 "없음" 분기). catch는 전부 배너·`ValidationError`("데이터가 손상되었습니다")·`toActionFailure`로 드러난다(`actions/agreement-items.ts:75`는 수정자 이름 조회 실패만 로그 후 일반 STALE 문구) |
| 바이트 불변 파일 | `lib/agreement/table.ts`·`cell-edit.ts`·`preservation.ts`·`diff.ts`·`changes-table.ts`·`TableActions.tsx`·`lib/db/backup.ts`·`content/help/calculations.md`·`lib/goal-form`·`lib/hwpx`·`lib/xlsx-style.ts` git diff 0. `lib/budget-plan.ts` diff = `totalPersonnelCost` 추가(10줄)뿐 |
| 도움말 글자 수(JS length, 상한 3,500) | `agreement.md` 3,484 · `budget.md` 3,288 · `calculations.md` 3,483(diff 0) · `budget-rules.md` 3,210 |

### 평가 기준 → 근거
**마이그레이션·DB**
| 기준 | 근거 |
|---|---|
| 마이그레이션 1개, 코드 20종, DB check = `RuleCode` = Zod = `RULE_SPECS`, RL-20·21 없음 | `supabase/migrations/20261005000000_rules_common_evidence.sql:20-34`; `rules-evidence-migration.test.ts` "code check는 정확히 20종이다 — 새 3종 포함, RL-20·RL-21 코드 없음"·"기존 코드의 제약 결과는 그대로다"; `agreement-item-constants.test.ts` "RuleCode 집합" 묶음 |
| value_range·enabled_value 새 코드, RL-22는 코드 2행 | 마이그레이션 `:37-58`; 테스트 "lab_safety_* 범위 밖(101·음수)은 value_range가 거부"·"preserve_subcategory_totals에 값이 오면 거부"·"켜진 lab_safety_*에 값이 없으면 거부"; `lib/rules.ts:95-96` |
| evidence 모양 check + Zod | 마이그레이션 `:69-93`; 테스트 "(b)" 4개; `agreement-item-constants.test.ts` "증빙: …"; `repos-agreement-items.test.ts` "앱 형태로 왕복" |
| 확정 잠금 + 증빙 예외(직접 UPDATE/INSERT 각각), DELETE는 액션 | 위 diff; `rules-evidence-migration.test.ts` "(c)" 7개(체크·메모 통과 / 라벨 이름·추가·삭제·순서 거부 / 다른 컬럼 거부 / version_id / INSERT / 다른 3테이블 / 작성 중 전부 / DELETE 트리거 통과) |
| `create_agreement_version` 7인자 1개, p_items 검증 | 마이그레이션 `:159-161`; 테스트 "(d)" 5개; `agreement-forms-migration.test.ts:472`(⑦) |
| security invoker, 다른 과제 연차 거부 | 테스트 "(e) 새·재정의 함수 중 security definer가 없다"; `repos-agreement-items.test.ts` "다른 과제의 연차는 RuleViolationError"; `agreement-items-actions.test.ts` "과제 경계" 3개 |
| schema_version 7·BACKUP_TABLES 불변·v7 왕복(편성 항목·증빙·새 코드 규칙) | 위 grep; `tests/destructive/backup-roundtrip.test.ts` "K-7: v7 복원 왕복"(확정 버전 아래 편성 항목 `EVIDENCE` + T17 추가 새 코드 규칙 2행)·"§8.8: 옛 v4·v5·v6 백업 거부" |
| Realtime 4테이블·publication·db push | 위 grep; dev DB push 완료(메인), 통합 테스트가 그 DB에서 통과 |

**순수 함수 — `lib/rules.ts` 확장 + 어댑터**
| 기준 | 근거 |
|---|---|
| 판정기 하나·어댑터만·경계 검사 | `lib/agreement/rule-input.ts`; `agreement-boundary.test.ts`(`readdirSync`로 `lib/agreement` 전 파일 — 새 5종 포함); 소스 검사 테스트 2종(위 grep) |
| `lib/rules.ts` 선택 필드만, 제안 경로 결과 불변 | `rules-common.test.ts` "새 코드 3행 유무와 무관하게 기존 판정이 같다"(B.9.1~B.9.4 각 deepEqual)·"origin이 없으면 제안 경로 그대로"; `rules-boundary.test.ts` 무수정 통과 |
| 분모 한 곳, `totalPersonnelCost`만 추가, 기호 혼동 7.5% | `lib/budget-plan.ts:373-381`; `agreement-rules.test.ts` "기호 혼동 … RL-4 분모 40,000,000 = modifiedPersonnel → 7.5%"; `rules-common.test.ts` "E1·수정직접비·총 인건비를 다시 정의하지 않는다" |
| 행 단위 규칙의 행, RL-16 한 번만, 금액 줄은 건이 아님, 인력 미지정 skipped | `agreement-rules.test.ts` "참여인원 → 인력 행, 편성 항목 → 건 행" 7개; `rules-common.test.ts` "origin" 묶음 |
| 세목 미지정 skipped | `agreement-rules.test.ts` "activity/default 1,000,000 + RL-7 켜짐 → … skipped"·"B.9.5 (수행) indirect/default 300,000 … 어댑터 skipped 2건"·"personnel/default → RL-11" |
| RL-8·RL-9 버전 정부지원 현금, 미입력·초과 skipped, 8-1 교차 | `agreement-rules.test.ts` "Phase 25 8-1 픽스처 → RL-8 66.5399% · RL-9 43.1818% = 붙임4형 8-1 합계 행"·"Y2 … 미입력 → … skipped(연차 이름 포함)"·"정부지원 현금 > 그 연차 현금 합 → skipped"; `agreement-rules-actions.test.ts` 같은 수치(액션 경로) |
| `ruleTargetVersionId`, null ≠ 빈 findings | `agreement-rules.test.ts` "ruleTargetVersionId" 4개; `agreement-rules-actions.test.ts` "버전 0개면 판정 대상 없음(null)" |
| B.9.7 동등성 EQ-1~3, 편성 항목 4건·대조 0 | `agreement-rules.test.ts` "B.9.7 제안·수행 동등성" 3개; `agreement-from-plan-items.test.ts` "B.9.3/EQ-3 4건"·"편성 항목 합 = 대응 세목 줄(대조 0)" |
| RL-22 B.9.5 | `rules-common.test.ts` "부록 B.9.5 — RL-22" 10개 + "RL-22 수행 — 분자는 subcategoryTotals" 4개 |
| RL-17 B.9.6, 정수 비교, 라벨·메시지, RL-18/19 ×1.1 없음 | `rules-common.test.ts` "meetsEquipmentThreshold" 2개·"부록 B.9.6" 7개·"RL-17 비교에 부동소수점 1.1이 없다"; `lib/rules.ts:91·656` |
| 중간 반올림 없음·정수 | `rules-common.test.ts` "999,999 → … actual 0.999999"·"2,000,001 → actual 2.000001" |
| RL-23 규칙 행·세 상태·evaluateRules에 안 합침·제안 모드 없음 | `lib/rules.ts:98`(`AGREEMENT_ONLY`); `rules-common.test.ts` "preserve_subcategory_totals 행은 evaluateRules가 판정하지 않는다"; `agreement-rules-actions.test.ts` "RL-23 행 없음 = 켜짐"·"RL-23 행이 있고 꺼짐 = 세 번째 상태"; `preservation.ts` diff 0 |
| B.9.1~B.9.4 그대로, `rules.test.ts` 허용 수정만 | `rules-boundary.test.ts` diff 0; `rules.test.ts` diff = RL-17 두 케이스(`'심의'` → `'사전 승인 대상'`, 29,999,999 → 1건) + 코드 집합 3단언(17 → 20, project scope에 `preserve_subcategory_totals`, `presetToRows('msit_profit')` 10 → 13)뿐 |
| RL-1 판정이 막지 않음 | 판정 호출은 `actions/agreement.ts:630`·`actions/budget-plan.ts:741`(둘 다 조회)뿐 — 쓰기 액션이 판정 결과로 `RULE`을 내는 경로 0. `agreement-rules-actions.test.ts` "RL-8 … 한도 60%·50%를 넘어 경고"(경고 상태로 보내기·조회 성공) |

**프리셋·부록 D**
| 기준 | 근거 |
|---|---|
| D.1 13행·D.2 20행, 간사 지침 출처, `RuleSource` 확장 | `lib/rules-presets.ts`; `rules-presets.test.ts`(행 수·마지막 3행·출처 접두에 `간사 지침` 추가); `rules-common.test.ts` "부록 D 새 3행 — 간사 지침"; `agreement-item-constants.test.ts` "RuleSource가 간사 지침 출처를 받는다"; `tutorial-actions.test.ts` 17 → 20 한 줄 |
| `gov_share_max` 75/67·과제 유형 선택 0·D.3 불변 | `rules-presets.test.ts` 해당 케이스 무수정 통과; project_type grep 0 |

**세목 추가 — 연구실 안전관리비**
| 기준 | 근거 |
|---|---|
| 부록 A.5·34개·자동 이관 없음 | `agreement-item-constants.test.ts` "간접비 끝에 연구실 안전관리비 …"; `subcategory-presets.test.ts` 33 → 34·indirect 3 → 4; `rules-common.test.ts` "B.7 실측 indirect_support 품명 … 판정 안 함 (자동 이관 없음)"; `cell-edit.ts` diff 0 |
| 붙임4형 8-2 내역 행(이중 계산 0) | `agreement-lab-safety.test.ts` "8-2 보기 — C.4 안전관리비 픽스처" 7개; `agreement-views.test.ts`·`attachment4-form-rows.test.ts` ⑧ 단언; `table.ts` diff 0 |
| 붙임4 가져오기 | `agreement-lab-safety.test.ts` "가져오기 — C.4" 7개(105,200,000·blocking `lab_safety_exceeds_indirect`); `agreement-attachment4-parse.test.ts` ⑧ 한 케이스(합계 105,200,000 유지) |
| 산출근거·총괄표 임포트, B.7·B.8 불변 | `import-lab-safety.test.ts` 7개; `import-detail-constants.test.ts`(`'연구실안전관리비'` 키 1줄); `budget-plan-b7` 등 무수정 통과 |
| 제출 서식 내보내기 U-4·Phase 11 왕복 | `export-lab-safety.test.ts` 14개("X-10d ② … 나. 연구지원비 표"·"① 총괄표 29행"·"④ 왕복 … indirect_support로 돌아온다"·"간접비 합계는 그대로다"); `export-writes.test.ts` 29행 단언(③) |
| 입력 양식(IN-4a)·`INPUT_FORM_VERSION` 1·옛 파일 | 위 "T8 입력 양식 차이" 절; `input-form-old-file.test.ts` 13개; 기존 입력·목표 양식 테스트 무수정 통과; exceljs 2파일 |

**편성 항목·증빙**
| 기준 | 근거 |
|---|---|
| 보기 모델·배지 = finding 부착 | `agreement-items.test.ts` "buildItemsView — finding 부착(비교 코드 없음)"·"순서·대조" |
| 기본 목록 상수·복사·저장값 불변 | `agreement-item-constants.test.ts` "AGREEMENT_EVIDENCE_DEFAULTS"; `agreement-items.test.ts` "상수가 바뀌어도 이미 만든(저장된) 목록은 그대로"; `agreement-items-actions.test.ts` "evidence 생략 = 그 종류 기본 목록 복사" |
| 입력 검증·부가세 별도 안내 | `agreement-item-constants.test.ts` "편성 항목 입력 검증" 9개; `ItemDialog.tsx:26` `ITEM_AMOUNT_VAT_NOTE`; `BudgetPlanPanel.tsx:481` |
| 금액 줄 대조 표시만·합계에 안 더함 | `agreement-items.test.ts` "연차 × 종류 대조 — … 표시만"; `agreement-lab-safety`·`agreement-views` 수치 불변 |
| 복제·cascade·보내기 ③ | `repos-agreement-items.test.ts` "복제는 편성 항목을 증빙째 새 id로"; `rules-evidence-migration.test.ts` "clone_agreement_version은 편성 항목을 증빙째 복사"; `agreement-from-plan-items.test.ts` 15개; `agreement-rules-actions.test.ts` "미리보기 건수 = 만든 건수: 3건"; `agreement-actions.test.ts` ⑥ |

**리포지토리·액션**
| 기준 | 근거 |
|---|---|
| 리포지토리 5종·createVersion items·RULE/STALE | `repos-agreement-items.test.ts` 13개; `repos-agreements.test.ts` 헬퍼 직접 INSERT → `agreements.insertItem`(②) |
| 액션 시그니처·Zod strict·SA-1·SA-4·O-1 | `actions/agreement-items.ts`; `agreement-items-actions.test.ts` 24개("patch에 evidence 키가 오면 VALIDATION"·"SA-1"·"SA-4"·"O-1") |
| 확정: 추가·수정·삭제 RULE, 증빙은 라벨 같으면 성공 | `agreement-items-actions.test.ts` "증빙 잠금 — 확정 버전은 체크·메모만" 5개 |
| 서버 계산·조회 실패 명시·equipmentApproval | `actions/agreement.ts:123·233·326·630-692`; `agreement-rules-actions.test.ts` "규칙·인력·편성 항목 조회 실패는 빈 값이 아니라 실패" 2개·"A → B 경고 2건 … B의 RL-17은 3건"·"RL-17이 꺼지면 … 판정하지 않음" |
| 규칙 편집 액션 새 코드·두 모드 revalidate | `budget-rules-phase26.test.ts` 7개; `agreement-rules-actions.test.ts` "규칙 편집은 연구비 경로를 revalidate" |

**화면**
| 기준 | 근거 |
|---|---|
| 수행 규칙 패널(재사용·머리·클릭 이동 3종·0건 안내·버전 0개) | `AgreementScreen.tsx:22·99-141·173·360-362`(`RuleFindingsPanel` 재사용, `highlightYearId`·`highlightParticipantId`·`highlightItemId`); 화면 동작은 수동 표 |
| [연구비 규칙] 버전 바 오른쪽·같은 RulesEditor·새 코드 3종·수행 전용 | `AgreementScreen.tsx:66·240`, `BudgetScreen.tsx:39`; `RuleRow.tsx:173·246`(수행 전용·간사 지침 배지), `RulesEditor.tsx:537`; `rule-form.test.ts` "Phase 26 새 코드 표시" |
| 탭 6개·자리표시 0 | `AgreementScreen.tsx:40-47`; `components/budget`에 "준비 중" 0 |
| 편성 항목 보기·편집·확정 체크만 | `ItemsView.tsx`·`ItemDialog.tsx`·`EvidenceEditor.tsx`; 순수 해석은 `agreement-items.test.ts` "resolveEvidenceUpdate — 증빙 잠금"; 화면은 수동 표 |
| 엑셀·복사·인쇄 | `agreement-export-items.test.ts` "작성안내 + \"편성 항목·증빙\", 칸 값 = TSV"; `TableActions.tsx`·`table.ts` diff 0 |
| 부가세 별도 안내 2곳, "부가세 포함 금액을 입력" 0 | `BudgetPlanPanel.tsx:481`, `ItemDialog.tsx:26`; grep 0 |
| 붙임4형 8-2 판정 줄 | `Attachment4View.tsx:282-805`; `agreement-rules.test.ts` "rule-view — 8-2 아래 RL-4·RL-3 판정 줄" 3개; `agreement-rules-actions.test.ts` "8-2 판정 줄(S-15)" |
| 변경 이력 RL-23 꺼짐·장비 사전 승인·엑셀 불변 | `ChangesView.tsx:267·311-327`; `agreement-rules.test.ts` "B.9.8" 5개; Phase 24 `agreement-export.test.ts` diff 0; `agreement-export-items.test.ts` "변경 이력 내려받기 — RL-23 규칙 행" |
| 제안 모드 패널 불변·RL-23 안 나옴 | `rules-common.test.ts` 제안 경로 deepEqual; `RULE_SPECS.modes`; 기존 규칙 패널·`budget-plan-actions` 테스트 통과 |
| 다크 토큰·dangerouslySetInnerHTML 0 | 새 컴포넌트 3개 하드코딩 색 grep 0(`print:` 제외); 위 grep |

**도움말**
| 기준 | 근거 |
|---|---|
| 두 절·한 줄·calculations diff 0·3,500자·앵커 | `content/help/agreement.md:36·42`(3,484자), `budget.md`(3,288자), `calculations.md` diff 0; `help-content.test.ts`(앵커 실재·글자 상한) |
| 금지어 유지(과제 유형·RL-20·RL-21) | `help-content.test.ts:231-234` |

**회귀 없음**
| 기준 | 근거 |
|---|---|
| Phase 24·25 테스트 수정 = 허용 사유뿐 | `git diff --stat HEAD -- tests/`: `agreement-actions`(⑥ items 단언 + 532행 주석), `agreement-forms-migration`(⑦ 472~476), `repos-agreements`(② 헬퍼), `tutorial-actions`(프리셋 17 → 20), `agreement-attachment4-parse`·`agreement-views`·`attachment4-form-rows`(⑧), `export-writes`(③ 29행), `rules`·`rules-presets`·`subcategory-presets`·`import-detail-constants`(허용 목록), `help-content`(T15 허용 231~238), `rule-form`(새 describe 추가만), `tests/destructive`(T17 추가만). S-20·Phase 25 수치 단언 수정 0. `agreement-view-labels.test.ts`는 T17이 코드를 옮겨 **무수정** 유지 |
| 제안 모드 결과 불변·바이트 불변 파일·과제 유형 0 | 위 grep·`rules-common` deepEqual·전체 스위트 |
| 전체 스위트 | `npm test` 4187·`test:destructive` 15·`tsc` 0·build 성공 |

**충족 못 한 기준**
- 없음(자동 검증 기준). 단, 평가 기준 "입력 양식 바이트" 항목의 문구 "새 세목 행(…, 아래 좌표 +1)"은 SOT IN-4a·계획서 S-17(블록 4행 → 아래 좌표 +4, T8 실측)과 어긋난다 — 구현은 SOT를 따랐고, 평가 기준 문구 정정은 메인 결정으로 남긴다.
- `rules-presets.test.ts`의 출처 접두 정규식에 `간사 지침`을 더한 3곳은 "행 수 단언 갱신" 허용 문구 밖이지만 `RuleSource` 확장(S-4)의 직접 결과다(고시 행의 접두 검사는 그대로) — 메인 확인 대상으로 적어 둔다.
- 화면 동작(규칙 패널 클릭 이동·편성 항목 편집 대화·증빙 펼침·인쇄·다크·클립보드)은 자동 테스트가 없어 아래 수동 표로 남긴다.

### Phase 23~26 일괄 수동 검증 (dev 서버 `npm run dev` 또는 Tauri — 과제 A `aaaa0000-0000-4000-8000-000000000001`)

**시드 상태**: T17 마지막에 `seed.sql`을 재적용했다 — 과제 A·단계 1·연차 2(1차년도 `aaaa0000-0000-4000-8000-000000000021`, 2차년도 `aaaa0000-0000-4000-8000-000000000022`)·Task 7·비목 행 24(금액 0)만 있다. 인력·산출근거·규칙·협약 버전은 **없다** — 아래 순서로 만든다.

**데이터 준비**
1. 인력: http://localhost:3000/projects/aaaa0000-0000-4000-8000-000000000001/team 에서 인력 2명(연봉 60,000,000 · 50,000,000).
2. 규칙: 연구비 주소 → 제안 모드 툴바 [연구비 규칙] → 프리셋 "기후부 에너지기술개발사업 · 중소기업" [채우기] → 20행.
3. 산출근거(제안 모드, 1차년도 셀 클릭): 인건비 `personnel_internal` 인력1 50%·12개월(= 30,000,000) / 장비비 `facility_purchase` "분광기" 단가 27,272,728 × 1, "현미경" 27,272,727 × 1 / 재료비 `material_purchase` "시약" 500,000 × 10 / 연구활동비 `activity_outsourcing` "시험 분석 외주" 10,000,000 / 간접비 `indirect_lab_safety` "연구실 안전관리비" 200,000(→ 30,000,000의 0.667%).
4. 정부지원 현금: 매트릭스 아래 "정부지원 현금" 행에 1차년도만 50,000,000(2차년도 비움). 2차년도에도 아무 셀 금액 하나(예: 재료비 1,000,000).

| 주소 | 확인할 동작 · 기대값 | Phase |
|---|---|---|
| http://localhost:3000/projects/aaaa0000-0000-4000-8000-000000000001/budget | **제안 모드 규칙 패널**: RL-17 경고 1건 "장비 27,272,728원(부가세 별도, 부가세 포함 30,000,000원) — 부가세 포함 30,000,000원 이상 연구시설·장비: … 사전 승인 대상, IRIS/ZEUS 등록"(현미경 27,272,727은 없음). RL-22 `lab_safety_min` warn(0.67% < 1%) → 안전관리비를 400,000으로 바꾸면 통과(1.33%), 700,000이면 `lab_safety_max` warn. RL-23은 패널에 **없음**. 셀 클릭 이동 그대로 | 26 |
| 같은 주소 → 제안 툴바 [연구비 규칙] | 새 코드 3행 라벨 "연구실 안전관리비 하한/상한 (÷ 인건비 + 학생인건비)"(값 %)·"세목 총액 보존 (연차 간 이동)"(값 칸 없음, "수행 전용"), 세 행 출처 옆 **간사 지침** 배지, RL-17 라벨 "장비 사전 승인 대상 금액 (부가세 포함 기준)" | 26 |
| 같은 주소 → 1차년도 장비비 셀 → 산출근거 패널 | `facility_purchase` 섹션 머리 "금액은 부가세 별도로 입력합니다 — 장비 기준(부가세 포함 3천만 원, RL-17)은 ×1.1로 비교합니다". 간접비 아래 **연구실 안전관리비** 세목 섹션(성과활용지원비 뒤) | 26 |
| 같은 주소 (제안) | 매트릭스 아래 "정부지원 현금" 입력(비우면 "—")·"기관부담 현금" 파생, 현금 합 초과 시 그 연차 경고(저장은 됨). 집행·집행률 표시·집행 패널 **없음** | 25 · 23 |
| 같은 주소 → 제안 툴바 [양식 내려받기] | 사업비 시트 간접비 `다. 성과활용지원비` 소계 뒤 "연구실 안전관리비" 블록(빈 줄 3 + 소계), 간접비 소계 수식이 그 소계를 포함. 수행 양식 선택 **없음** | 26 · 23 |
| 같은 주소 → [협약 기준선으로 보내기] | 확인 대화에 줄 수·참여인원 행 수·미분리 건수 + **편성 항목 4건**(분광기·현미경·시약·시험 분석 외주) → 결과 문구에도 4건. 이후 [보내기]·[붙임4 가져오기] 비활성 + 이유 | 24 · 26 |
| 같은 주소 → [수행] | **탭 6개** [비목별]·[붙임4형]·[조정회의형]·[참여인원]·[편성 항목·증빙]·[변경 이력]. 버전 바 오른쪽 **[연구비 규칙]** → 제안 모드와 같은 규칙 표(같은 행 — 여기서 값을 바꾸면 제안 모드 패널도 바뀜) | 26 |
| 같은 주소 → [수행] 규칙 패널(탭 아래) | 머리: 판정 대상 버전 이름 · "버전 정부지원 현금 기준" + 2차년도 미입력 사유(RL-8·RL-9 skipped, 연차 이름 포함) · RL-23 상태(켜짐/기준 버전 없음). findings: RL-17 분광기 1건·RL-22 warn. **클릭 이동 3종**: 연차 finding → [비목별] 그 연차 강조, 참여인원 finding(규칙에서 참여율 한도 등을 낮춰 유도) → [참여인원] 그 행, 건 finding(RL-17) → [편성 항목·증빙] 분광기 행 | 26 |
| 같은 주소 → [수행] → [비목별] 셀 편집 | 간접비처럼 세목이 여럿인 칸에 금액을 넣어 "세목 미지정" 줄이 생기면 규칙 패널 skipped에 "세목 미지정 간접비 N원 — 세목을 알 수 없어 판정에서 뺐습니다". 줄 없는 칸 "—", 세목 줄 합계 초과는 오류 | 26 · 24 |
| 같은 주소 → [수행] → [편성 항목·증빙] | 연차 → 장비·재료·외주 → 품명, 열(연차·종류·품명·수량·금액·증빙 0/8·경고 배지·[증빙]·[수정]·[삭제]), 연차·종류별 대조 행(차액 0). [편성 항목 추가] 대화 금액 칸 "부가세 별도 금액 — 장비 기준(부가세 포함 3천만 원)은 ×1.1로 비교합니다" → 장비 "레이저" 41,000,000 추가 → 장비 대조 행 차액 +41,000,000(금액 줄은 그대로 — 표시만), RL-17 배지. [증빙] 펼침: 항목 추가·이름 변경·삭제·체크·메모 | 26 |
| 같은 주소 → 버전 바 [확정] → [편성 항목·증빙] | [편성 항목 추가]·[수정]·[삭제] 사라짐. [증빙] 펼침에서 **받음 체크·메모만** 저장되고 항목 추가·이름 변경·삭제 칸 없음 | 26 · 24 |
| 같은 주소 → [수행] → [붙임4형] | 8-1: 연차 + 합계, 기업유형 "중소기업", 2차년도 정부지원 현금 "—", 판정. 8-2: **"(간접비 중 연구실 안전관리비)" 행 1차년도 = 안전관리비 세목 금액**(줄 없는 2차년도 "—"), L(간접비)에 다시 더해지지 않음. 8-2 아래 **RL-4·RL-3 판정 줄**(RL-3에 분모 base 라벨) + "표의 간접비 비율은 양식 분모라 RL-3과 다를 수 있습니다". 작성 중 버전에서 칸 클릭 편집 → [비목별] 같은 값 | 26 · 25 |
| 같은 주소 → [수행] → [조정회의형] | 변경전(제안)·변경후(이 버전) 두 표, 읽기 전용. 이전 버전을 보면 "현재 버전 아님" | 25 |
| 같은 주소 → [수행] → [참여인원] | 보내기로 들어온 행 구분 자동/수동/연봉 모름, 연차 소계·금액 줄 대조. 작성 중일 때 [추가](인력 미지정 포함)·수정·삭제, 확정이면 버튼 없음 | 25 |
| 같은 주소 → 확정 버전에서 [새 버전](복제) → 새 버전 [편성 항목·증빙] | 편성 항목·증빙이 복사됨(받음 체크 포함). 현미경 금액 27,272,727 → 27,272,728로 수정, 장비 "시약" 30,000,000 추가(같은 키 재료 → 장비 이관) | 26 · 24 |
| 같은 주소 → [수행] → [변경 이력] (A = 확정 버전, B = 새 버전) | 금액 줄·참여인원 증감(추가/삭제/변경/불변). **장비 사전 승인** 2건(현미경 기준 미만 → 이상, 시약 재료 → 장비), 분광기·레이저는 없음. [비목별]에서 1차년도 → 2차년도로 금액을 옮기면 세목 총액 보존 경고. [연구비 규칙]에서 "세목 총액 보존" **끄기** → "규칙이 꺼져 있어 판정하지 않음"(기준 버전 없음·경고 0건과 다른 문구), RL-17 끄기 → 장비 사전 승인 "판정하지 않음" + 사유 | 26 · 24 |
| 같은 주소 → 각 보기 툴바 [엑셀 내려받기]·[복사] | 편성 항목: 파일명 `{버전 이름} 편성 항목`, 시트 "편성 항목·증빙", 증빙 칸 "받음 n/m" + "라벨: 받음/안 받음 · 메모". 붙임4형: 작성안내 + 8-1 + 8-2, 비율 글자 `xx.xx%`. 변경 이력 엑셀에 장비 사전 승인 **없음**. [복사] → 엑셀 붙여넣기 같은 행·열·숫자. Tauri 앱 클립보드 쓰기 성공 여부(실패 시 배너) | 26 · 25 · 24 |
| 같은 주소 → 제안 툴바 [서식 내보내기] | 안전관리비 행이 있으면 "서식에 연구실 안전관리비 표가 없어 연구지원비 표에 적었습니다 — 이 파일을 다시 가져오면 …로 읽힙니다" 경고, 총괄표 29행 "(간접비 중 연구실 안전관리비)" = 그 연차 세목 소계, 행 없는 연차는 비우고 알림 | 26 |
| 같은 주소 → 제안 툴바 [붙임4 가져오기] (작성 중 버전이 없을 때) | `samples/` 붙임4 파일 업로드 → 블록 선택 → 8-1 행 대응 → 미리보기(연구실 안전관리비 값이 있으면 `indirect_lab_safety` 줄 + 간접비 default 차감, 넘으면 blocking) → [반영]. 버전 0개일 때 수행 화면의 두 번째 진입점도 같은 대화 | 26 · 25 |
| 같은 주소, Ctrl+P | 보고 있는 보기 하나, 가로, 머리말 과제명·버전 이름·상태·출력일, 버튼·탭 없음. 편성 항목 인쇄는 증빙 n/m만 | 26 · 24 |
| http://localhost:3000/settings | 다크 모드로 바꾼 뒤 연구비 주소로 돌아가 규칙 패널 머리·편성 항목 표·증빙 펼침·편성 항목 대화·간사 지침 배지·장비 사전 승인 목록·붙임4형·참여인원 색 확인. 설정의 가져오기 스냅샷에 "수행 양식" 표시·복원 경로 **없음** | 26 · 25 · 23 |
| http://localhost:3000/ | 대시보드 지표 카드 5개, 집행률·집행액 **없음** | 23 |
| http://localhost:3000/projects/aaaa0000-0000-4000-8000-000000000001 | 과제 개요에 집행률 없음. 단계·연차 패널에서 1차년도 삭제 → "협약 예산 버전 N개가 이 연차를 씁니다" 거부 | 23 · 24 · 25 |
| http://localhost:3000/projects/aaaa0000-0000-4000-8000-000000000001/team | 참여인원에 쓰인 인력 삭제 → "협약 예산 참여인원 N건" 별도 줄, 삭제 비활성 + 이유. 버전 삭제 후 다시 삭제 가능 | 24 |
| http://localhost:3000/help#agreement--%EC%88%98%ED%96%89-%EB%AA%A8%EB%93%9C-%EA%B7%9C%EC%B9%99-%EA%B2%80%EC%A6%9D | 수행 규칙 패널 [?]와 같은 절 "수행 모드 규칙 검증". 같은 편 `#agreement--%ED%8E%B8%EC%84%B1-%ED%95%AD%EB%AA%A9-%EC%A6%9D%EB%B9%99`("편성 항목·증빙" — 파일 첨부 없음·확정 후 체크·메모만·금액 부가세 별도) | 26 |
| http://localhost:3000/help#budget--%EC%88%98%ED%96%89-%EB%AA%A8%EB%93%9C-%ED%98%91%EC%95%BD-%EC%98%88%EC%82%B0 | 수행 모드 절 — "준비 중" 없음, 규칙 검증 연결 한 줄 | 26 · 24 |

**주의**: 검증 중 `npm test`·`npm run test:destructive`를 돌리면 시드 과제와 위 준비 데이터가 전부 지워진다 — 다시 `seed.sql` 재적용 + 준비 1~4.


### T17 후속 — 도움말 배치 결정 (2026-10-05, evaluator 1차 FAIL 거절 노트 1 해소)
- T15 작업 중 `agreement.md`가 3,500자 상한에 닿았다(2,993 → 3,484). 메인이 T15 지시에서 미리 승인한 대로 규칙별 설명(RL-22·연구실 안전관리비 세목과 자동 이관 없음·RL-23 켜고 끄기·RL-17 장비 사전 승인·×1.1 비교)을 `content/help/budget-rules.md`의 "연구실 안전관리비"·"장비 사전 승인"·"세목 총액 보존 끄기" 절에 두었다(2,338 → 3,210자). `agreement.md` "수행 모드 규칙 검증" 절은 판정 대상·총액 출처·세목 미지정과 연결 한 줄만 둔다.
- 이 결정을 SOT §7.9.8 도움말 줄과 `evaluation_criteria.md` Phase 26 도움말 항목에 반영했다. 내용 자체는 SOT와 모순 없음(evaluator 확인).
