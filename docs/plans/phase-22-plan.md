# Phase 22 구현 계획 — hwpx 계획서 가져오기 (planner 산출, 2026-09-29)

범위: SOT v4.8 §6.18 HX-1~HX-8, 부록 C.3, §7.7 [계획서(hwpx) 가져오기], §9 Plan Document, §11 Phase 22, §6.17 GF-5~GF-11. 합격 기준 = `evaluation_criteria.md` "## Phase 22".

## 사전 확인

### 코드
- **마이그레이션 불필요** — `commit_goal_form`(Phase 21, 적용됨) 그대로. `p_source.sheetName`은 자유 텍스트.
- `GoalFormRows` 행 사유 `kind`는 `GOAL_FORM_ISSUES` 키 유니온 — hwpx 행 사유도 이 표에 키가 있어야 한다.
- `previewGoalForm`은 `GoalFormMeta` 필수(hwpx는 합성), `allowDeletes:false` 있음, 투영 람다는 export 안 됨, key = `${시트명}:${sheetRow}`. `buildGoalFormCommit`은 blocked면 throw, add에 `row_key: row:<sheetRow>`.
- `runGoalFormPipeline`은 FormData 입력, version 기준은 파일 `_meta` — hwpx는 기준이 없어 commit 시점 DB로 합성하면 미리보기 뒤 변경을 덮는다(S-12).
- `GoalFormUpload.tsx` 미리보기 본문이 xlsx·삭제 토글·commit과 한 파일.
- `next.config.ts`에 `serverActions.bodySizeLimit` 없음 → 기본 1MB. (별건: xlsx 업로드 상한 10MB와 불일치 — 이번 범위 밖, S-14)
- `normalizeLabel`(I-1)은 괄호 내용까지 지운다 — 서명엔 맞고 이름 대응엔 충돌(S-17).
- `GOAL_VALUE_HINT_KEYWORDS`에 `<`·`>` 없음(S-19).
- `lib/goal-form/parse.ts` → `lib/input-form/parse-execution.ts` → `lib/budget-plan`·`lib/constants` 의존 — 클라이언트가 행 해석을 import하면 번들로 끌려온다(S-33).
- §10 경로 `components/goals/form/PlanDocumentUpload`는 Phase 21 배치와 다름(S-30). `ImportSnapshotPanel`은 goal_form이면 무조건 "목표 양식"(S-31).

### 파일 실측 (메인 세션 python, 병합 확장 후 — 원본 격자는 scratchpad에만)
- zip 191 엔트리(BinData 180), `Contents/section0.xml` 18,576,039B(압축 962KB), header.xml 1.67MB, 표 276개. `hp:tbl` rowCnt·colCnt·repeatHeader, `hp:tc>hp:cellAddr(colAddr,rowAddr)·hp:cellSpan(colSpan,rowSpan)`, 텍스트 `hp:p … hp:t`. 모든 표 rowCnt = tr 수.
- 서명 일치 표 종류별 **1개, 쪽 나뉨 없음**: 기술목표 30×14(헤더 2 + 28), 성과목표 16×12(헤더 2 + 14), 평가방법 29×4(**헤더 1** + 28).
- 기술목표 헤더: col0·col1 모두 "평가 항목(주요성능 Spec"(가로 병합, `구분` 글자 없음 — col0 데이터가 구분, col1이 `N. 이름`). col4 0행 "세계최고 수준 보유국/보유기업 (  /  )", 1행 "성능수준" — **보유국 전용 열 없음**, 값 안에 괄호로. col5 국내수준. col6~9 `1차년도`~`4차년도`, **최종 목표 열 없음**. col10 표준·인증, col11 기준설정근거(헤더에 긴 안내), col12 평가방법, col13 담당기관. 값 예(형태만, 합성): `수초이내`, `4(가국/가 서비스)(A→B)`, `10% 이내(나국,C사)`, `5~10(다 기관/…`(닫는 괄호 없음), `LOD 2.5`, `≤10`, `< 5`, `≥90`, `20 이상`, `1,000`, `60%`, `-`. 기관명에 개행.
- 성과목표: `구분|항목|항목|항목|단위|가중치|개발 목표치×5(1~4차년도, 계)|평가방법`. 행 예: `사업별 성과지표|고용창출 효과×3`, `특허|국내|등록|건수`, `특허|국내|등록|SMART 평균`(점수), `특허|국외|등록|건수`(전부 `-`), `학술|SCI급 게재논문×2|게재`, `학술|…|Impact Factor 평균`(점수), `학술|비SCI급 게재논문×3`, `상용화|시제품×3`. 반영 대상 가중치 합 100.
- 평가방법 표: `순번|평가항목(성능지표)|평가방법|평가환경`, 순번 `1`~`28` 숫자만, 기술목표와 1:1. 평가환경은 `[기준설정 근거] :` 문단 머리 표식 있는 행/없는 행 혼재. 수식 누락 흔적(`hp:equation` 미처리).

## 불변 제약
- 별도 반영 경로·RPC 없음(HX-8): 격자 → `GoalFormRows` + 합성 `GoalFormMeta` → `previewGoalForm({allowDeletes:false})` → `buildGoalFormCommit` → `commitGoalForm`.
- `lib/goal-form/`은 **추가만**(사유 키, 투영 헬퍼 export). 기존 `goal-form-*` 테스트 무수정 통과.
- hwpx 파일은 서버로 안 간다. 서버는 격자 JSON을 Zod로 재검증.
- `samples/` 실데이터(평가항목명·기관명·수치)를 저장소에 넣지 않는다. 픽스처는 합성 값, 실측 테스트는 건수·구조만 단언.

## SOT 결정 (S-1~S-34)

| # | 공백·모순 | 권고안 |
|---|---|---|
| S-1 | 쪽 나뉨 실측이 SOT와 다름(각 1개) | HX-4 유지, 실측 문구·§11 "쪽 나뉨 표가 이어져서" 정정, 합성 픽스처로 검증 |
| S-2 | 헤더 행 수(평가방법은 1행) | 첫 2행 중 서명 키워드·별칭·열 역할 라벨과 **완전 일치 셀이 2개 이상**인 행이 앞에서 연속된 수(실측 2/2/1) |
| S-3 | 열 역할 사전 없음 | 부록 **C.3.5 열 역할** 신설(기술목표·성과목표·평가방법), 못 정한 열은 "읽지 않은 열"로 표시 |
| S-4 | 기술목표 `구분` 헤더 없음 | 평가항목 헤더가 가로 2열이면 앞 = group, 뒤 = name. `구분` 열 있으면 그 열, 없으면 ''. 빈 값은 직전 행 승계 |
| S-5 | 세계최고 보유국 열 없음(값 안 괄호) | (a) 괄호 내용 → worldBestHolder(첫 괄호), 나머지 → GF-6, 원문은 비고. 국내수준도 괄호 떼고 GF-6. **사용자 결정: 아래** |
| S-6 | 성과목표 지표명에 `특허` 빠짐 | 지표명 = 구분(`성과지표` 포함 값 제외) + 항목 열, 연속 같은 라벨 1회, trim·개행→공백 |
| S-7 | C.3.2 순서 버그(비SCI → paper_sci) | 비SCI 규칙을 SCI 위로, 비교는 양쪽 I-1 정규화 |
| S-8 | 반영 제외 조건 분산 | 합집합: 단위 `점수` · 이름에 SMART/ImpactFactor/평균 · 연차와 `계` 모두 빈 값. 실측 10 반영 / 4 제외. §11 수치 구체화 |
| S-9 | 반영 제외 행 자리 | `GoalFormRows` 밖 `excluded: {table, tableRow, name, unit, reason}[]`, blocked·건수 무영향 |
| S-10 | `sheetRow` 의미 | 이어 붙인 표의 데이터 행 순번(1-based, 종류별 유일). 사용자 문구 "기술목표 표 N행 (순번 k)" |
| S-11 | `_meta` 합성 | formVersion·projectId·generatedAt=''·years=과제 연차 앞 K개·orgs=과제 기관·members=[]·version=파이프라인 시점 DB |
| S-12 | 동시성(O-1) | (a) 미리보기 다이제스트 — commit이 다시 계산해 다르면 전체 거부. **사용자 결정: 아래** |
| S-13 | 해시 계산 위치 | 서버가 preview에서 계산해 반환, commit에 되보냄. 대상 = 정규 직렬화(`lib/hwpx/serialize.ts`) |
| S-14 | 페이로드 크기(본문 1MB) | 서명 일치 표만 전송, 상한 `lib/hwpx/limits.ts`(직렬화 800,000B·표 ≤20·행 ≤300·열 ≤40·셀 ≤20,000자), 클라이언트·서버 모두 검사. xlsx 10MB/1MB는 별건 보고 |
| S-15 | `HwpxTable` 형태 | `{index, section, rowCnt, colCnt, cells: string[][]}` + `{tables, skipped}` |
| S-16 | 텍스트 규칙 | 문단 `\n`, `hp:t` 이음, lineBreak→`\n`, tab→공백. 한 줄 필드는 개행→공백·trim, 여러 줄 필드는 개행 유지. 텍스트 셀 전체가 `-`·`—`·`없음`이면 '' |
| S-17 | 이름 대응 정규화 | 키 = NFC + 공백 제거(괄호·대소문자 유지), 순번 접두 제거. DB 중복 → blocking `ambiguous-match`, 계획서 중복 → `duplicate-plan-name`. 기관도 같은 키 |
| S-18 | 투영 원칙 | 대응된 기존 행은 표가 주지 않은 필드를 기존 투영값으로 채움(direction·orgId·note·평가방법 표 3필드·표 밖 연차·type=other면 기존). 투영 헬퍼는 preview.ts export 하나만. 재미리보기 멱등 테스트 |
| S-19 | 방향 기본값(줄어드는 목표) | ① C.3.4에 `<`→lower, `>`→higher ② 새 행 힌트 없고 연차 목표가 줄면 경고 `direction-default`(값은 higher) ③ 기존 행은 기존 direction 유지. **사용자 결정: 아래** |
| S-20 | 비고 줄 형식 | `[원문] 평가방법: …`, `[담당기관] …`, 멱등, 경고 `method-other`·`org-unmatched` |
| S-21 | `[기준설정 근거]` 분할 | 문단 머리 표식부터 뒤 → basisRationale(표식·`:` 제거), 없으면 전부 evaluationEnvironment. 요약 열 `-`면 요약 없음 |
| S-22 | 평가방법 ↔ 기술목표 연결 | 순번 → 이름 재시도 → `unlinked-method-row` 경고. 순번 중복은 경고 + 미연결. 미연결 기술목표는 3필드 보존 |
| S-23 | 수식·그림 요소 | T0에서 이름 확인, `[수식: script]`·`[그림]` |
| S-24 | 브라우저 메모리 | fflate `unzipSync` filter(section만), `hp:tbl` 깊이 인식 스캔 + 표 단위 `preserveOrder` 파싱, `strFromU8`. Worker는 T8 실측 1.5초 초과 시에만 |
| S-25 | 입력 판정 | `.hwpx` + `PK` + mimetype `application/hwp+zip`. OLE·PDF·기타 → "hwpx로 저장해 다시 올려 주세요" |
| S-26 | 섹션 순서 | `section{N}` 숫자 순, index 통산 |
| S-27 | 사유 코드 자리 | 행 사유 5종은 `GOAL_FORM_ISSUES`에 추가만, 표 사유는 `lib/hwpx` `PLAN_ISSUES` |
| S-28 | 표 일부만 찾음 | 찾은 것만 진행, 기술·성과 둘 다 없으면 거부 |
| S-29 | 연차 수 불일치 | K = min, 경고, 남는 열 무시, 모자라면 보존 |
| S-30 | 경로·모달 재사용 | `components/goals/PlanDocumentUpload.tsx`, `GoalPreviewPanel.tsx` 추출(GoalFormUpload 동작 불변), §10 정정 |
| S-31 | 스냅샷 표시 | `sheetName: '계획서(hwpx)'`, 설정 패널 라벨 "계획서(hwpx)" |
| S-32 | 새 행 초기값 | measureMethod C.3.3(없으면 self, 매칭 실패 other), orgId null, type C.3.2(없으면 other) |
| S-33 | 클라이언트/서버 분리 | 클라이언트는 `lib/hwpx/{types,zip,extract,tables,serialize,limits}`만, `rows.ts`는 서버 전용. 경계 테스트가 전이 import 검사 |
| S-34 | 실측 테스트 데이터 노출 | 건수·구조·유형 분포만 단언, 실데이터 문자열 0 |

## 태스크 (의존: T0 → T1(멈춤) → {T2, T3, T10, T12} → T4(T0·T2), T5(T2·T3) → T6 → {T7, T8, T9} → T13, T11(T4·T5·T9·T10) → T14)

- **T0** 합성 픽스처 `tests/fixtures/hwpx/*.xml`(기술·쪽 나뉨·성과·평가방법·기타) + README, 실측 확인 8항목 보고(수식·그림 요소, 인라인 요소, mimetype, 섹션 수·중첩 표, 표식 위치, 격자 JSON 바이트, 연차 수)
- **T1** SOT·criteria 반영(v4.8 "Phase 22 착수 전 보강", HX-2~8, C.3.1·C.3.2 순서·C.3.4 `<`/`>`·C.3.5 신설, §9·§10·§11)
- **T2** 의존성 + `lib/hwpx/{types,serialize,limits}.ts` + 테스트
- **T3** `lib/constants.ts` C.3 상수, `GOAL_FORM_ISSUES` 행 사유 5종 추가만, 테스트(실측 지표명 11개 유형 고정)
- **T4** `lib/hwpx/{zip,extract}.ts` + 테스트(BinData 미해제 단언, 형식 거부, 병합·수식·그림·중첩·구조 불일치)
- **T5** `lib/hwpx/{tables,issues}.ts` + 테스트(서명·별칭, 헤더 행 수, 잇기, 순번 경고, 열 역할)
- **T6** `lib/hwpx/rows.ts`(서버 전용) + preview.ts 투영 헬퍼 export만 + 테스트(HX-5~8, 멱등, 투영 보존)
- **T7** `tests/unit/hwpx-boundary.test.ts`(외부 패키지 2개만, DOM·Node 식별자 0, 클라이언트 전이 import)
- **T8** `tests/unit/hwpx-sample.test.ts`(samples 없으면 skip, 276/28/14/28, 반영 11 + 제외 3(U-7), 시간·힙 stderr, 실데이터 문자열 0)
- **T9** `actions/plan-document.ts`(`runPlanPipeline`, 해시·다이제스트, Zod 상한)
- **T10** `components/goals/GoalPreviewPanel.tsx` 추출, `GoalFormUpload` 동작 불변
- **T11** `components/goals/PlanDocumentUpload.tsx` + `GoalsScreen.tsx` 툴바
- **T12** `ImportSnapshotPanel.tsx` "계획서(hwpx)" 라벨
- **T13** `tests/integration/plan-document-actions.test.ts`
- **T14** 마감(npm test·tsc·build, 경계 재실행, PROGRESS, Worker 판단·xlsx 본문 한도 별건 기록)

## 계약 요약

```ts
// lib/hwpx/types.ts (공용)
interface HwpxTable { index: number; section: number; rowCnt: number; colCnt: number; cells: string[][] }
interface HwpxExtractResult { tables: HwpxTable[]; skipped: { index: number; section: number; reason: 'structure-mismatch' }[] }
interface PlanDocumentPayload { fileName: string; tables: HwpxTable[] }
// lib/hwpx/zip.ts · extract.ts
readHwpxSections(bytes: Uint8Array): { ok: true; sections: { section: number; xml: string }[] } | { ok: false; message: string }
extractHwpxTables(sections): HwpxExtractResult
// lib/hwpx/tables.ts
identifyPlanTables(tables): { tech: PlanTable | null; deliverable: PlanTable | null; method: PlanTable | null; issues: PlanIssue[] }
selectPayloadTables(result): HwpxTable[]
// lib/hwpx/rows.ts (서버 전용)
buildPlanRows({ projectId, tables, years, orgs, current }): { meta: GoalFormMeta; rows: GoalFormRows; excluded; issues; locations }
// actions/plan-document.ts
previewPlanTables(projectId, payload): ActionResult<PlanPreviewResult>   // tablesHash·previewDigest
commitPlanTables(projectId, payload, tablesHash, previewDigest): ActionResult<GoalFormCommitOutcome>
```

## 사용자 결정 (2026-09-29) — 위 S-표보다 우선한다

**기술목표 표 (정량적 기술목표)**
- U-1 평가항목은 **번호가 붙은 평가항목명 열 하나만** 읽는다(`N.` 접두 제거·순번 보관). 앞의 병합 셀(구분 성격)은 무시한다 — 이 과제 계획서가 특이한 경우이고 보통은 평가항목명 열 하나다. → S-4 대체: hwpx는 `group`을 채우지 않는다(기존 값 보존, 새 행 '').
- U-2 반영 열은 **평가항목·단위·비중(%)·연도별 개발목표치·평가방법·담당연구개발기관**뿐. 세계최고(보유국·성능수준)·국내수준·표준(시험)·인증기준·기준설정근거 열은 **읽지 않는다**(기존 값 보존, 새 행은 null/''). → S-5 폐기.
- U-3 방향: 셀 힌트(≤·<·이하 … / ≥·>·이상 …)가 있으면 그것. 없으면 **단위가 시간(초·s·sec·ms·분·min·시간·hr)이면 `lower_better`**("속도와 시간은 대부분 낮을수록 좋다"), 그 외 `higher_better`. 기존 행은 힌트·시간 단위가 없으면 기존 direction 유지. → S-19 대체(`direction-default` 경고 없음, `<`·`>`는 C.3.4에 추가).
- U-4 평가방법 열 → measureMethod(C.3.3), 담당연구개발기관 → orgId(S-17 키 완전 일치, 실패는 비고 줄).

**성과목표 표 (정량적 성과목표)**
- U-5 반영: 구분·항목(지표명·유형 결정에만 — 성과목표에 구분 필드 없음), **단위**(`고용창출 효과`의 `명` 보존 — 메인 세션 판단), 가중치, 연차별 개발목표치, 계, 평가방법 → evidenceMethod.
- U-6 지표명: 특허는 `특허 {국내|국외}{출원|등록} 건수` 4종(`특허 국내출원 건수`·`특허 국내등록 건수`·`특허 국외출원 건수`·`특허 국외등록 건수`). SCI 논문은 `SCI급 게재논문 게재`. 그 외는 항목 라벨(연속 중복 1회, 공백으로 이음 — `고용창출 효과`·`소프트웨어 등록`·`비상교육 프로그램`·`비SCI급 게재논문`·`학술대회`·`시제품`). `사업별 성과지표`·`학술`·`상용화` 같은 구분 값은 이름에 넣지 않는다(특허만 예외). → S-6 대체.
- U-7 반영 제외: **SMART 평균·Impact Factor 평균**(이름 키워드 또는 단위 `점수`) — 미리보기에 사유와 함께 남긴다. `특허 국외등록 건수`처럼 목표가 전부 `-`인 행은 **제외하지 않고** 목표 0으로 반영(사용자가 4종을 명시). → S-8 대체(연차·계 전부 빈 조건 삭제).

**평가방법 및 평가환경 표**
- U-8 순번·평가항목·평가방법·평가환경 모두 반영: 평가방법 → measureDescription, 평가환경 → evaluationEnvironment. 평가환경 안의 **`[기준설정 근거]` 부분(표식 문단부터 끝까지)은 버린다** — basisRationale에 넣지 않는다. → S-21 대체.
- U-9 수식은 반영이 어려우면 **제외**(`[수식: …]` 인라인 대신 빈 문자열), 그림도 제외. 나머지 텍스트는 그대로. → S-23 대체.

**동시성·표시**
- U-10 미리보기 뒤 다른 사람이 고쳐도 **그대로 덮어쓴다**(나중 쓰기 승 — commit 시점 DB 기준으로 다시 계산). → S-12 (c), 다이제스트 없음. §9 시그니처는 `commitPlanTables(projectId, payload, tablesHash)`.
- U-11 설정 스냅샷은 **"계획서(hwpx)"로 따로** 표시(S-31 채택).
- U-12 **긴 텍스트 표시**: 목표 화면에서 여러 줄 텍스트(평가방법 상세·평가환경·표준·기준설정 근거·평가방법(증빙)·비고)는 **한 줄만 + `…` + [더보기]**. 마우스 오버 시 전체 내용 오버레이, [더보기] 클릭 시 아래로 펼침(다시 누르면 접기). 공용 컴포넌트 하나(`components/ui/` 또는 goals 내), dangerouslySetInnerHTML 금지, 다크 모드 토큰, 인쇄 레이아웃은 전부 펼친 상태.

나머지 S 항목(S-1~S-3·S-7·S-9~S-11·S-13~S-18·S-20·S-22·S-24~S-30·S-32~S-34)은 권고안대로(위 결정과 충돌하는 부분은 위가 우선). S-18 투영 원칙은 U-2로 읽지 않는 필드에도 적용된다.
