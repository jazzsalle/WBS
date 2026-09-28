# Phase 21 구현 계획 — 목표 양식 (planner 산출, 2026-09-28)

범위: SOT v4.8 §5.8·§5.9(새 필드), §5.12.1 `goal_form`, §6.17 GF-1~GF-8, §6.2·§6.3, §7.7 툴바, §9 Goal Form, 부록 A.2·A.4·C.3.4·F(F-8·F-9), §8.7·§8.8, §13 13. 합격 기준 = `evaluation_criteria.md` "## Phase 21".

## 사전 확인 (코드 실측)

- **`tech_targets`에 `note` 컬럼이 지금 없다**(`20260802000000_initial_schema.sql` 274~299행), `TechTarget` 타입에도 없다. 추가 컬럼은 `tech_targets` 5종(`group`·`standard_basis`·`basis_rationale`·`evaluation_environment`·`note`), `deliverables` 2종(`weight`·`evidence_method`, `note`는 이미 있음).
- `deliverables.target_total`은 `integer`, `target_by_year` 값은 `actions/goals.ts` `countSchema`가 정수 강제 — GF-6이 소수를 내면 성과목표에는 저장 불가. `tech_targets.weight`는 `numeric`. `deliverable_achievements.date`·`tech_target_records.date` not null. `tech_target_records.value`는 `numeric not null default 0`(기본값 0이 실적치로 굳으면 달성률 왜곡 — `actions/goals.ts` 주석).
- `lib/db/mapper.ts` 특례는 `sort_order ↔ order`(N-9)뿐. `group` 키를 쓰는 앱 타입 0건.
- `restore_import_snapshot`(현재 `20260928000000_execution_form.sql` §4)은 `items` 빈 배열 + `details`·`executions` 키 없음이면 `{restored: 0}` **성공** — `goal_form` 스냅샷이 여기로 떨어지면 아무것도 안 하고 성공(절대 규칙 5 위반).
- `importSnapshotPayloadSchema.kind`는 `z.enum(['budget_detail','execution_form']).optional()`(`lib/db/schema.ts` 523행) — `goal_form` 추가 안 하면 스냅샷 1개로 `listImportSnapshots`와 설정 패널이 깨진다.
- `restore_backup` 현재 정의는 Phase 20(spec 기본값·detail_id 2차 복원). 옛 백업은 `jsonb_populate_recordset`이 누락 키를 null로 넣어 새 not null 컬럼에서 실패. §8.8 "이후 not null 컬럼을 추가하는 Phase도 컬럼을 명시해 채운다".
- `FormSheet.validations`는 인라인 목록만(`FormColumnValidation.values`). `applyListValidation`은 `errorStyle: 'stop'` 고정. 셀 병합 힌트 없음(F-2 2단 헤더 표현 불가). F-9 `_lists` 범위 참조는 어댑터 확장 필요.
- exceljs import 허용 목록은 `tests/unit/input-form-boundary.test.ts`가 `['lib/input-form-adapter.ts','lib/xlsx-style.ts']` 정확히 둘로 고정.
- `excelSerialToISO`·`readExecutionDate`(`lib/input-form/parse-execution.ts` 88·107행) 재사용 가능.
- `Year.name`은 빈 문자열일 수 있다 — 입력 양식은 `${order+1}차년도`로 대체.
- `readUploadedWorkbook`은 `cellDates: false`·`cellFormula: false` — 수식 셀 값은 null(PROGRESS 함정 ①).
- repo 입력 타입이 `Omit<Deliverable|TechTarget, …>` — 새 필드 필수화 시 리터럴 생성처 tsc 깨짐: `actions/goals.ts` create 2곳, 통합 `cascade-delete`·`goal-rpcs`·`repos-goals-team`·`repos-hierarchy`·`team-rpc`, 단위 `dashboard`·`goals`·`mapper`.
- Row 스키마가 새 컬럼을 요구하면 `db push` 전에는 목표를 읽는 통합 테스트가 전부 실패 — T15 전에는 단위·tsc만 완료 기준.
- 수정하지 않는 파일: `lib/input-form/{layout,build,parse,parse-execution,preview,execution-preview,meta,guide}.ts`, `actions/input-form.ts`, `lib/import-adapter.ts`, `lib/export-adapter.ts`, 입력 양식 UI.

## 불변 제약

- 입력 양식(Phase 17·19·20) 산출물 **바이트 동일**. `lib/input-form/types.ts`·어댑터는 **추가만**, 새 필드는 전부 선택. 기존 `input-form-*` 테스트 무수정 통과.
- 기존 목표 CRUD 호출(새 필드 없이)은 동작 동일 — 생략 시 DB 기본값.
- Phase 22(HX-8) 대비: 미리보기·페이로드 생성기는 xlsx를 모르는 **행 모델**(`GoalFormRows`)을 입력으로 받는다. `allowDeletes: false` 옵션. hwpx 코드는 만들지 않는다.

## SOT 결정 필요 (S-1~S-22)

| # | 공백·모순 | 권고안 |
|---|---|---|
| S-1 | `group`은 PostgreSQL 예약어. (a) `"group"` 인용 (b) `group_name` + 매퍼 특례(N-9 선례) | (b), §5.1 N-9에 추가, 매퍼 테스트 |
| S-2 | 옛 백업 복원 시 채울 새 not null 컬럼 목록 | `restore_backup` 재정의로 `deliverables.weight`(0)·`evidence_method`(''), `tech_targets` 5종('') 채움. Phase 20 spec·detail_id 보존, `c_tables` 불변. §8.8에 목록 |
| S-3 | `goal_form` 스냅샷 복원 의미가 SOT에 없다(현재 코드로는 0건 성공). (a) IN-14식 완전 되돌리기(4테이블+achievement_members+cascade된 task 연계 — 범위 큼) (b) Phase 21은 복원 **명시 거부**, 버튼 비활성 (c) 변경값만 되돌리기 | (b) + 스냅샷에 (a)용 원본(`goals: {added, before, deleted}` + 연계 행)을 지금부터 담는다 |
| S-4 | 같은 파일에서 새 지표에 새 실적을 붙이는 부모 참조. (A) 실적·측정 시트 `지표명`/`평가항목` 열을 읽는 열로, 새 행은 이 파일 성과/기술목표 시트 이름 완전 일치(`ambiguous-parent`·`unknown-parent` blocking) (B) 보이는 `번호` 열 (C) 새 실적은 기존 지표에만 | (A). RPC 페이로드는 `deliverable_ref: "row:<n>"` 임시 키 → 같은 트랜잭션에서 해석. GF-1 "표시 전용" 수정 |
| S-5 | `_meta` 행별 version과 충돌 기준 시점. GF-5 "미리보기 시점"은 Phase 20 S-4에서 결함 확인된 문구 | `_meta`에 `deliverable:/achievement:/techTarget:/record:<id>` = **내려받은 시점** version, `year:/org:/member:<id>` = 라벨, `formVersion`·`projectId`·`generatedAt`. GF-5 문구 수정, §9에 version 인자 없는 이유 |
| S-6 | 삭제 연쇄 안전성 ① 지운 지표를 가리키는 실적 행이 남음 ② 내려받은 뒤 추가된 자식이 cascade로 사라짐 ③ WBS 연계 끊김 | ① blocking `orphan-child` ② RPC가 현재 자식 ⊆ `_meta` 자식·version 일치 확인, 아니면 부모 삭제 conflict ③ 삭제 후보에 "실적 N · 측정 M · 연계 작업 K" |
| S-7 | 작성안내 시트·시트 목록 | `작성안내`·`성과목표`·`성과실적`·`기술목표`·`측정이력`·`_lists`(숨김)·`_meta`(숨김). 안내 문장은 GF 규칙을 사용자 말로 |
| S-8 | ① F-9 목표 양식 목록의 `축`은 오기 ② 관여자 `;` 다중은 `errorStyle: 'stop'`이 막는다 | ① 삭제 ② 관여자는 `_lists` 드롭다운 + `errorStyle: 'warning'`, 파서가 재검사 |
| S-9 | 필수값 누락·빈 enum 처리 | 성과목표: 전부 비면 빈 행, 지표명·유형 없음 blocking, 단위 없음 A.2 기본, 가중치 없음 0. 실적: 산출물명·달성일 없음 blocking, 연차·기관 없음 null. 기술목표: 평가항목 없음 blocking, 방향 없음 higher, 측정방법 없음 self, 비중 없음 0. 측정: 값·일 없음 blocking, 방법 없음 → 그 기술목표 measureMethod. 길이 상한 `actions/goals.ts`와 같게 |
| S-10 | ① 연차는 enum 아님 ② 측정방법 C.3.3 별칭 수용 여부 | ① 연차 라벨 = `year.name`/`${order+1}차년도`, 중복 `이름 (2)` ② 양식은 A.4 라벨 완전 일치만, 별칭은 hwpx 전용 |
| S-11 | GF-6 세부 (a) `초과`·`—`·`없음` 누락 (b) `-` null vs 음수 (c) 적용 열 (d) 힌트 vs 방향 열 (e) `[원문]` 형식·멱등 (f) 숫자 셀 | (a) C.3.4에 맞춤 (b) 셀 전체가 그 문자일 때만 null (c) 성과목표 가중치·총량·연차, 기술목표 비중·연차·최종·국내·세계최고, 측정값. 성과 건수 비정수 blocking, 가중치·비중 ≥ 0 (d) 힌트는 기술목표 연차·최종 셀에서만, 힌트 우선 + 다르면 `direction-overridden` 경고 (e) `[원문] {열}: {원문}` 줄, 이미 있으면 안 붙임 (f) 숫자 셀은 그대로 |
| S-12 | GF-7 기술목표 ① 최종≠마지막 연차 경고 적용? ② 모두 빔 | ① 적용(`final-target-mismatch`) ② blocking `no-target` |
| S-13 | `targetByYear` 병합 | `_meta.yearIds` 키만 교체(빈 칸 = 키 삭제), 그 밖 키 보존. `_meta` 연차가 삭제됐으면 RPC 전체 거부 |
| S-14 | 행 순서 | 기존 순서 불변, 추가는 시트 순서대로 끝에 |
| S-15 | 합계 행 식별·빈 입력 행 | 데이터 아래 합계 행, 숨김 id 열 마커 `#total`, 파서 건너뜀. 범위는 헤더 다음~합계 직전. 빈 입력 행 20개. 연차 합계 열은 `read: false` 수식 |
| S-16 | 성과목표 시트 `구분` 열에 대응 필드 없음 | GF-1에서 열 삭제 |
| S-17 | 입력 양식 파일을 목표 양식으로 올리면 GF-2 통과 | `_meta` `form = goal`, 없거나 다르면 거부. 순서 형식 → 과제 → 버전. `GOAL_FORM_VERSION = 1` |
| S-18 | 행 복사로 숨김 id 중복 | IN-10 규칙 그대로(투영 같은 행 하나면 원본, 아니면 `duplicate-row`). 부모 변경은 `parent-moved` blocking(미리보기 + RPC) |
| S-19 | 기존 CRUD·화면 노출 범위 | 액션 새 필드 선택 인자. 모달에 새 필드. 탭 1 가중치 합 ≠ 100 경고 배지. 인쇄 레이아웃에 `구분`. **사용자 확인 필요** |
| S-20 | `deliverables.weight` 타입 | `numeric not null default 0 check (weight >= 0)` |
| S-21 | 오류 행 있을 때 전체 차단? | blocking 1건이라도 있으면 반영 비활성(부분 반영 없음). "반영 제외 행"은 Phase 22 전용 |
| S-22 | 공유 코드 자리 | `lib/goal-form/`은 `FormSheet`·`FormCell`을 타입으로만 import. `FormColumnValidation`에 `listRange`·`errorStyle` 추가만. 어댑터는 `writeInputFormWorkbook` 재사용(exceljs 허용 목록 불변). F-2 2단 헤더 미사용 |

T0이 결정을 SOT에 반영해야 해당 태스크를 시작한다.

## 태스크

**T0. SOT 결정 반영 (사람 승인 — 멈춤)** — S-1~S-22 확정 내용을 SOT(§5.1 N-9, §5.8, §5.9, §6.17, §7.7, §8.8, §9, I-17, C.3.4, F-9)와 evaluation_criteria.md Phase 21에 반영. v4.8 변경 요약에 "Phase 21 착수 전 보강".

**[AFTER: T0] T1. 마이그레이션** `supabase/migrations/20260929000000_goal_form.sql`
- 컬럼 7종(S-1·S-20), schema_version 4 유지, 머리말에 RLS·Realtime 근거
- `commit_goal_form(p_project_id, p_deliverables, p_achievements, p_tech_targets, p_records, p_expected, p_source)` security invoker, 단일 트랜잭션: 종류별 {adds, updates, deleteIds}, 경계 검증(N-13, raise), parent-moved raise, 새 부모 임시 키 해석, `version = expected` 0행이면 conflict로 건너뜀(삭제도), 부모 삭제 전 자식 확인(S-6②), targetByYear 병합(S-13), achievement_members 교체, sort_order(S-14), 순서 삭제(자식→부모)→변경→추가(부모→자식), 스냅샷 `kind:'goal_form'` + `goals:{added,before,deleted}`, 20개 창, 반환 건수·conflicts
- `restore_import_snapshot` 재정의: goals 키 분기만 추가(S-3), 기존 경로 한 글자도 불변
- `restore_backup` 재정의(S-2), `security definer`는 restore_backup에만

**[AFTER: T0] [PARALLEL] T2a. 타입·Zod·매퍼** — `types/index.ts`, `lib/db/schema.ts`, `lib/db/mapper.ts`, `actions/goals.ts`(create 기본값만), `tests/unit/mapper.test.ts` + 리터럴 픽스처. `goal_form` Zod enum, goal_form 스냅샷 행이 스키마 통과 단위 테스트. tsc 0

**[AFTER: T2a] [PARALLEL] T2b. 리포지토리** — `lib/db/import-snapshots.ts`에 `commitGoalForm` 래퍼, 반환 Zod, 예외 규약 매핑

**[AFTER: T2a] [PARALLEL] T3. 목표 CRUD 액션** — `actions/goals.ts` Zod에 새 필드 optional, `getGoalsData` 가중치 합(S-19), `tests/integration/goal-actions.test.ts` 추가(실행은 T15 뒤)

**[AFTER: T0] [PARALLEL] T4. GF-6** — `lib/constants.ts`(C.3.4 표), `lib/goal-form/value.ts`, `tests/unit/goal-form-value.test.ts`. `parseGoalValue`·`combineHints`·`appendOriginalNote`(멱등), 전 분기 테스트, 중간 반올림 없음

**[AFTER: T2a] T5. 좌표 맵·타입·_meta** — `lib/goal-form/{layout,types,meta}.ts`, `lib/input-form/types.ts`(추가만), `tests/unit/goal-form-layout.test.ts`. `goalSheetsFor(yearCount)`, A.2·A.4 라벨 양방향 맵, `GOAL_FORM_VERSION = 1`, `#total`, meta 행(S-5·S-17), 거부 순서

**[AFTER: T5] [PARALLEL] T6. 생성기 + 작성안내** — `lib/goal-form/{build,guide}.ts`, 테스트. 라벨, 동명 구분, 연차 열 순서(빈 칸 vs 0), 수식 행, 빈 입력 행 20, `_lists`·listRange·관여자 warning, 백분율 서식 0

**[AFTER: T5, T4] [PARALLEL] T7. 파서** — `lib/goal-form/parse.ts`, 테스트. 거부 5종, `_meta.yearIds` 순서(헤더 무관 테스트), 라벨·기관·관여자 완전 일치, `#total`·빈 행 건너뜀, GF-6·GF-7, 날짜 함수 재사용, S-9, S-4 부모 해석, 사유 표 `GOAL_FORM_ISSUES` 한 곳

**[AFTER: T5] [PARALLEL] T8. 쓰기 어댑터** — `lib/input-form-adapter.ts`, `lib/xlsx-style.ts`, `tests/unit/input-form-style.test.ts`(추가만), `tests/unit/goal-form-boundary.test.ts`. listRange 유효성, errorStyle warning, values+listRange 동시면 throw, 기존 산출물 불변

**[AFTER: T7] T9. 미리보기·페이로드** — `lib/goal-form/preview.ts`, 테스트. 투영 비교 diff, duplicate-row·parent-moved, 삭제 후보 딸린 건수, 경고, 달성률 전후는 `lib/goals.ts` 재사용, includeDeletes·allowDeletes, snake_case 페이로드·임시 키·expected, blocked(S-21)

**[AFTER: T6, T7, T8, T9] T10. 왕복 단위 테스트** — `tests/unit/goal-form-roundtrip.test.ts`

**[AFTER: T2b, T6, T7, T8, T9] T11. 서버 액션** — `actions/goal-form.ts` 3종, 공용 `runGoalFormPipeline`, fileHash, conflicts 그대로, 절대 규칙 3·5, revalidatePath

**[AFTER: T11] T12. 목표 화면 툴바** — `components/goals/GoalFormDownload.tsx`·`GoalFormUpload.tsx`(생성), `GoalsScreen.tsx`

**[AFTER: T3] [PARALLEL] T13. 테이블·모달 새 필드** — `components/goals/{DeliverableSection,TechTargetSection,DeliverableFormModal,TechTargetFormModal}.tsx`

**[AFTER: T1, T2b] [PARALLEL] T14. 설정 스냅샷 패널** — `components/settings/ImportSnapshotPanel.tsx` "목표 양식", goals 키 없으면 손상 표시, 복원은 S-3대로

**T15. db push (사람 — 멈춤)** — `--db-url` 직결, 7컬럼·schema_version 4·`commit_goal_form`·`restore_backup` 확인, 이후 전체 npm test, 화면 검증 전 seed 재적용

**[AFTER: T15, T11, T3, T14] T16. 통합 테스트** — `tests/integration/goal-form-actions.test.ts`(생성), `tests/destructive/backup-roundtrip.test.ts`(추가), goal-actions. §11 완료 기준, 새 지표+새 실적, 경계, 충돌, 삭제 연쇄·S-6, 스냅샷, fileHash, 입력 양식 파일 거부, 옛 백업 기본값

**[AFTER: T16, T12, T13] T17. 마감** — PROGRESS, §13 13 표기, 절대 규칙 grep

## 의존 그래프

T0 → {T1, T2a, T4} → T2a → {T2b, T3, T5} → T5 → {T6, T8}, {T5, T4} → T7 → T9 → T10 ∥ T11 → T12; T3 → T13; {T1, T2b} → T14; T1 → **T15** → T16 → T17.

같은 파일 동시 수정 없음: `actions/goals.ts`는 T2a → T3 순차, `schema.ts`·`types/index.ts`는 T2a만, `import-snapshots.ts`는 T2b만, `constants.ts`는 T4만, `lib/input-form/types.ts`는 T5만, 어댑터·`xlsx-style.ts`는 T8만, `GoalsScreen.tsx`는 T12만, 섹션·모달은 T13만. `lib/goal-form/`에 barrel 없음.

## T1 산출 — commit_goal_form 계약 (T2b·T9·T11이 따른다)

`commit_goal_form(p_project_id uuid, p_deliverables jsonb, p_achievements jsonb, p_tech_targets jsonb, p_records jsonb, p_expected jsonb, p_source jsonb) returns jsonb` (각 기본값 `'{}'`)

- 종류별 `{ "adds": [...], "updates": [...], "deleteIds": [uuid] }` — 키 없으면 빈 배열. add·update 행은 아래 키를 **전부** 가진다(nullable 컬럼만 null, 키 누락은 raise). add에는 `id` 없음.
- **deliverables** adds: `row_key`(선택, `"row:<n>"`), `type`, `name`, `unit`, `weight`, `target_total`, `target_by_year`, `org_id`, `evidence_method`, `note` / updates: `id` + 같은 필드(`row_key` 없음)
- **achievements** adds: `deliverable_id` 또는 `deliverable_ref`(`"row:<n>"`) 중 정확히 하나 + `title`, `date`, `year_id`, `org_id`, `member_ids`, `evidence_url`, `note` / updates: `id`, `deliverable_id`(현재 부모와 같아야 함) + 같은 필드. update에 `deliverable_ref`면 parent-moved raise
- **tech_targets** adds: `row_key`(선택), `name`, `group_name`, `unit`, `direction`, `weight`, `target_value`, `target_by_year`, `baseline_domestic`, `world_best`, `world_best_holder`, `measure_method`, `measure_description`, `standard_basis`, `basis_rationale`, `evaluation_environment`, `org_id`, `note` / updates: `id` + 같은 필드
- **records** adds: `tech_target_id` 또는 `tech_target_ref` 중 하나 + `value`, `date`, `year_id`, `method`, `evaluator`, `evidence_url`, `note` / updates: `id`, `tech_target_id`(현재 부모) + 같은 필드
- `target_by_year` = `{ "<yearId>": number | null }` — `_meta.yearIds` 키 전부 보낸다. null = 키 삭제, 안 보낸 키 보존(S-13), add에서는 null 키 제거. 성과목표 건수는 정수 ≥ 0. `weight` ≥ 0. `target_value`·record `value`는 null 불가. `member_ids` uuid 배열(update는 전체 교체). `date` `YYYY-MM-DD`. enum은 코드.
- `p_expected` = `{ "<id>": version }`(내려받은 시점). 모든 update·delete id 포함, 부모 삭제면 그 부모의 현재 자식 전부도 포함해야 한다(아니면 부모 삭제 conflict `changed`).
- `p_source` = `{ fileName, sheetName, fileHash }`
- 반환: `{ snapshotId, deliverables:{added,updated,deleted}, achievements:{…}, techTargets:{…}, records:{…}, conflicts:[{ kind:'deliverable'|'achievement'|'techTarget'|'record', id, reason:'changed'|'deleted' }] }` — `conflicts` 항상 존재, `deleted`는 deleteIds로 지운 수만.
- 스냅샷 `goals`: `added`·`deleted` = `{deliverables, deliverable_achievements, tech_targets, tech_target_records}` 각 uuid 배열, `before` = 같은 4종 + `achievement_members`·`task_deliverables`·`task_tech_targets` 원본 행. 키는 비어도 항상 존재.
- 예외 문구: 과제 없음만 "찾을 수 없습니다", 나머지 RULE — "양식을 받은 뒤 연차가 바뀌었습니다 — 다시 내려받으세요"(기관·인력도 같은 꼴), "…양식을 받은 뒤 삭제되었습니다", "이 과제에 속하지 않은 …", "기존 성과실적을 다른 성과목표로 옮길 수 없습니다…", "삭제할 성과목표를 가리키는 성과실적 행이 남아 있습니다", "…새 성과목표(row:n)가 이 반영에 없습니다".
- 참고: `tech_targets.weight` 음수는 DB check가 아니라 RPC·액션이 막는다(기존 컬럼, S-20은 deliverables만).
