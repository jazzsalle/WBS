# Phase 20 구현 계획: 수행 양식 (planner 산출, 2026-09-28)

범위: SOT v4.8 §5.12(BudgetExecution 7필드), §6.16 IN-9~IN-13, §7.9·§7.9.7 수행 모드, §9 Budget Input Form, §8.7·§8.8, §13 12-a, 부록 F-6·F-9. 합격 기준은 `evaluation_criteria.md` "## Phase 20"(403행~)이다.

## 사전 확인 (코드 실측)

- `lib/input-form/`는 좌표 맵 `INPUT_FORM_SHEETS` 하나만 있고 mode 분기가 없다. `guide.ts`의 작성안내 문장만 mode를 받는다. `unreadColumnsText()`는 인자가 없다(PROGRESS Next steps에 적힌 그대로).
- `FormCellFormat`에 `'date'`가 없다. `lib/xlsx-style.ts`의 `XlsxCellFormat`·`numFmtFor`는 `'date'`(`yyyy-mm-dd`)를 이미 지원한다.
- `lib/import-adapter.readWorkbook`은 `cellDates: false`다. 날짜 셀은 엑셀 직렬값(숫자)으로 들어온다. 이 어댑터는 총괄표·산출근거 경로와 같이 쓴다.
- `_meta`에는 formVersion·projectId·yearId·generatedAt·`subcategory:`·`member:` 행만 있다. mode·executionId·detailId 목록이 없다.
- 기존 집행 데이터는 전부 `subcategoryCode = null`, `memberId = null`이다. 그런데 부록 A.5에서 `facility_equipment`·`material`·`activity`·`indirect`에는 `default` 세목이 없다.
- `import_snapshots`에는 **`kind` 컬럼이 없다.** 종류는 `snapshot` jsonb 안에 있고, 복원은 키가 있는지로 종류를 가른다(`details` 키 = 산출근거). `importSnapshotPayloadSchema.kind`는 `z.literal('budget_detail').optional()`이다. **이대로 두면 `execution_form` 스냅샷이 하나만 생겨도 그 과제의 `listImportSnapshots`가 Zod 검증에서 실패해 설정 화면 스냅샷 패널이 깨진다.**
- `restore_import_snapshot`은 `items`가 빈 배열이고 `details`가 없으면 `{restored: 0}`을 돌려준다. 수행 스냅샷을 이 함수가 그냥 받으면 **아무것도 되돌리지 않고 성공**한다. 절대 규칙 5 위반이다.
- `restore_backup`은 `jsonb_populate_recordset`을 쓴다. 옛 백업에 없는 컬럼은 **null**이 된다. `spec text not null default ''`를 추가하면 옛 백업 복원이 not null 위반으로 실패한다. 평가 기준의 "옛 백업 파일 복원 시 기본값"과 충돌한다.
- `budgetExecutionRowSchema`와 `EXECUTION_COLUMNS`가 새 컬럼을 요구하게 바뀌면, **`db push` 전까지 집행을 읽는 기존 통합 테스트가 전부** "DB 응답이 스키마와 일치하지 않습니다"로 실패한다. `npm test`는 통합 테스트까지 돈다. T13(사람)이 끝나기 전에는 `npm test` 전체 통과를 완료 기준으로 쓸 수 없다. T13 전에는 단위 테스트만 본다.
- 기존 테스트가 시트 목록을 정확히 단언한다. `input-form-build.test.ts:555`, `input-form-adapter.test.ts:101·182·254`, `input-form-roundtrip.test.ts:590`, `input-form-style.test.ts:215`, `input-form-layout.test.ts:47`(숨김 시트는 `['_meta']`뿐). 제안 양식에 `_lists` 시트를 더하면 이 단언들이 깨진다(아래 결정 S-2).
- 통합 테스트는 `buildInputForm(projectId, yearId)`처럼 인자 2개로 부른다. 새로 붙는 `mode` 인자는 기본값 `'plan'`이어야 기존 호출이 그대로 동작한다.
- 어느 태스크도 수정하지 않는 파일: `lib/import-adapter.ts`, `lib/input-form/preview.ts`(제안 미리보기), `components/budget/input-form/InputFormUpload.tsx`(제안 업로드), `actions/detail-import.ts`, `lib/export-adapter.ts`.

## 제안 모드 불변 제약 (모든 태스크에 적용)

제안 모드(Phase 17·19)의 결과는 다음 범위에서 **바이트 단위로 같아야 한다**.
- `sheetsFor('plan')`의 JSON 직렬화가 현재 `INPUT_FORM_SHEETS`와 같다. `INPUT_FORM_SHEETS`는 `sheetsFor('plan')`의 별칭으로 남는다.
- `parseInputForm(sheets, expected)`(mode 생략 또는 `'plan'`), `buildInputFormPreview`, `commitInputForm`의 입력과 출력이 변하지 않는다.
- `buildInputForm(data, today)`(mode 생략)의 FormCell 격자와 작성안내 문장(`unreadColumnsText('plan')` 포함)이 같다. 예외는 S-1·S-2 결정에 따라 허용되는 차이뿐이고, 그 차이는 테스트 수정 목록에 명시한다.
- 기존 Phase 17·19 단위·통합 테스트 파일은 **수정 없이** 통과한다. S-2 결정으로 시트 목록 단언을 고쳐야 한다면 그 행만 고치고, 커밋 메시지에 이유를 적는다.

## SOT 결정 필요 (임의로 정하지 않았다. 권고안만 붙였다)

| # | 공백·모순 | 권고안 |
|---|---|---|
| S-1 | §9 "`_meta`에 mode"를 제안 양식에도 적으면 제안 양식의 결과 바이트가 바뀐다. 이미 내려받은 Phase 19 파일에는 mode 행이 없다. | mode 행은 **수행 양식에만** 적고, mode 행이 없으면 `plan`으로 본다. `INPUT_FORM_VERSION`은 1을 유지한다. IN-2·IN-9 문구를 "없으면 제안"으로 보강한다. |
| S-2 | F-9는 `_lists` 숨김 시트를 참조하는 드롭다운을 제안·수행 양식 모두에 요구한다. 그러면 제안 양식 시트 목록이 바뀌어 Phase 19 테스트 6곳의 단언이 깨진다. | (a) 제안 양식에도 `_lists`를 넣고 시트 목록 단언만 고치거나, (b) `_lists` 없이 인라인 목록 유효성(`"현금,현물"`)을 쓴다. (b)는 시트 목록이 그대로이지만 F-9 문구를 고쳐야 한다. 사용자 선택이 필요하다. |
| S-3 | F-9는 입력 양식에 "축·세목 드롭다운"을 요구하는데, 평가 기준에는 `축`만 있다. 사업비 시트의 세목 라벨은 `read: false`라 드롭다운이 의미 없다. | 인건비 시트의 `세목`(인건비 세목 라벨 5종)에도 드롭다운을 건다. 평가 기준에 이 항목을 더한다. |
| S-4 | IN-10은 "미리보기 시점 version으로 O-1 비교"라고 하지만, §9 `commitExecutionForm(projectId, file, fileHash, includeDeletes)`에는 version을 받을 인자가 없다. 반영 시점에 DB로 삭제 후보를 다시 판정하면, 미리보기 뒤 다른 경로로 추가된 집행이 사용자가 본 적 없는 삭제 후보가 된다(IN-6에서 Phase 17이 겪은 결함과 같다). | 내려받을 때 `_meta`에 `execution:<id>` = version을 싣는다. 충돌은 "현재 DB version ≠ 내려받을 때 version"으로 판정한다. 삭제 후보는 "`_meta` id − 시트 id"다. 둘 다 파일만으로 정해지므로 미리보기와 반영이 결정론적으로 같다. IN-10 문구를 "내려받은 시점"으로 고친다. |
| S-5 | IN-2의 `_meta` 목록에 executionId·detailId가 없다. 그런데 평가 기준은 "`executionId`·`memberId`·`detailId`가 `_meta` 목록 밖이면 오류 행"을 요구한다. | 수행 양식 `_meta`에 `mode`, `execution:<id>`(값은 version), `detail:<id>`(그 연차의 산출근거 id)를 더한다. IN-2에 명시한다. |
| S-6 | 기존 집행 중 ① `personnel`·`student_personnel` 비목인데 `memberId`가 없는 것, ② `default` 세목이 없는 비목(`facility_equipment`·`material`·`activity`·`indirect`)에서 세목이 없는 것은 양식에 놓을 자리가 없다. 자리가 없으면 "양식에서 사라진 id", 곧 삭제 후보가 된다. | 사업비 시트에서 비목마다 `세목 미지정` 슬롯(키 `비목:`)을 두고, 인건비 비목 집행 중 인력이 없는 것도 그 비목 슬롯에 둔다. 파서는 이 슬롯을 `subcategoryCode = null`로 읽는다. IN-4·IN-12에 명시한다. |
| S-7 | 수행 모드의 `조정액` 열은 `BudgetExecution`에 저장할 필드가 없다. 인건비 `산식 금액` 열은 IN-11에 따라 수식을 넣지 않는데, 이 열을 둘지 비울지 정해져 있지 않다. | 두 열 모두 남기되(IN-9 "같은 열") 수행 모드에서는 `read: false`로 비워 둔다. 금액 보완식(IN-11)은 "단가 × 인자"만 쓰고 조정액은 넣지 않는다. |
| S-8 | 변경 행의 세목을 다른 비목으로 바꾸는 경우의 규칙이 없다. 인건비↔학생인건비 라벨을 바꾸거나 슬롯 사이로 행을 복사하면 이렇게 된다. 결과는 `budget_item_id`가 바뀌는 것이다. | 같은 연차 안의 비목 이동은 허용한다(RPC가 새 비목 행을 연차·비목으로 찾는다). 미리보기에 "비목 이동"으로 표시한다. 막아야 한다면 IN-5처럼 `category-moved` 오류로 둔다. |
| S-9 | 삭제에도 version 비교를 할지 정해져 있지 않다. | 삭제도 S-4의 version으로 비교하고, 바뀐 행은 삭제하지 않고 충돌로 돌려준다. |
| S-10 | `execution_form` 스냅샷의 **복원 의미**가 정해져 있지 않다. I-17은 "복원은 행을 삭제하지 않는다"고 한다. | D-17a처럼 명시적 예외로 둔다. 스냅샷에 `executions: { added: [id], before: [변경·삭제 전 행 원본] }`을 담는다. 복원은 추가된 행을 지우고, 변경된 행을 되돌리고, 삭제된 행을 id를 보존해 되살린다. 스냅샷 이후 다시 바뀐 행이 있으면 복원 전체를 거부한다. 이 결정 전까지는 수행 스냅샷 복원을 **명시적으로 거부**한다(조용히 0건 성공은 금지). |
| S-11 | 평가 기준은 "`import_snapshots.kind` check 제약"을 말하지만 그런 컬럼은 없다. | 스냅샷 종류는 jsonb `snapshot.kind = 'execution_form'`으로 둔다. check 제약은 `import_profiles.kind`에만 추가한다(`ImportKind` 타입과 맞추기 위해서). 평가 기준 문구를 고친다. |
| S-12 | 옛 백업을 복원하면 `spec`이 null이 되어 not null 위반이 난다. 기존 원칙("조용히 기본값으로 메꾸지 않는다", restore_backup 주석)과 §8.8 "옛 백업은 새 컬럼이 기본값으로 복원된다"가 충돌한다. | 이 마이그레이션에서 `restore_backup`을 재정의한다. `budget_executions` 행에만 `'{"spec":""}'::jsonb \|\| r`로 **이 한 컬럼의** 기본값을 채우고 주석에 근거를 남긴다. 다른 방법은 `spec`을 nullable로 두는 것인데, §5.12 `spec: string`과 어긋난다. |
| S-13 | F-6은 "읽을 때 SheetJS `cellDates`로 ISO 문자열 복원"이라고 하지만, 공용 `readWorkbook`은 `cellDates: false`다(I-16). | 어댑터는 고치지 않는다. 수행 파서가 엑셀 직렬값을 ISO로 바꾸는 순수 함수(1900 날짜 체계)를 쓰고, `yyyy-mm-dd` 문자열도 받는다. F-6 문구를 고친다. |
| S-14 | 집행일이 연차 기간 밖일 때의 처리, 품명 200자 상한(`descriptionSchema`)을 양식에 적용할지가 정해져 있지 않다. | 연차 기간 밖이면 경고(막지 않음), 200자 초과면 blocking 오류로 둔다. 화면 CRUD와 같은 제약이다. |

T0이 이 결정들을 SOT에 반영해야 해당 태스크를 시작할 수 있다(CLAUDE.md: SOT를 먼저 고친다).

## 태스크

```
T0. SOT 결정 반영 (사람 승인 필요 — 멈춤 지점)
  목표: 위 S-1~S-14를 사용자에게 묻고, 확정된 내용을 SOT(§5.12·§6.16·§7.9.7·§9·부록 F·I-17)와 evaluation_criteria.md Phase 20에 반영한다
  대상 파일: docs/SOT.md, evaluation_criteria.md
  완료 기준: 결정마다 SOT 해당 행에 문구가 있고, v4.8 변경 요약에 "Phase 20 착수 전 보강" 항목이 있다. 평가 기준의 import_snapshots.kind 문구가 정정돼 있다
  SOT 근거: CLAUDE.md "SOT에 없는 결정이 필요하면 먼저 물어본다"
```

```
[AFTER: T0] T1. 마이그레이션 — 컬럼 7종 + commit_execution_form + 복원 경로
  목표: SQL 한 파일로 스키마·RPC를 추가한다. 실행(db push)은 T13에서 한다
  대상 파일: supabase/migrations/20260928000000_execution_form.sql (생성)
  완료 기준:
    - budget_executions에 다음 7컬럼 추가: subcategory_code text null, spec text not null default '', unit_price bigint null (check >= 0), factors jsonb null, axis text null check (axis in ('cash','in_kind')), member_id uuid null references members on delete set null, detail_id uuid null references budget_details on delete set null. member_id·detail_id 인덱스 추가(FK set null 성능)
    - import_profiles_kind_check를 ('budget_plan','budget_detail','execution_form','goal_form')으로 교체(S-11)
    - schema_version을 갱신하지 않는다(4 유지, §8.8). 머리말에 "RLS 정책 변경 불필요 — 기존 테이블의 is_approved() 전체 접근 정책이 새 컬럼에 그대로 적용된다. 새 테이블 없음" 근거를 적는다
    - commit_execution_form(p_project_id, p_year_id, p_adds jsonb, p_updates jsonb, p_delete_ids uuid[], p_expected jsonb, p_source jsonb) returns jsonb, security invoker, 단일 트랜잭션:
      · 과제·연차 경계(N-13). updates·deletes의 budget_item이 (그 과제, 그 연차)인지. member_id가 그 과제의 인력인지, detail_id가 그 과제·연차의 산출근거인지(IN-13). 위반이면 raise(RULE, 전체 롤백)
      · adds는 (p_year_id, category)로 budget_item을 찾는다. 없으면 raise(연차당 12행 불변식)
      · updates·deletes는 `where id = … and version = expected`. 0행이면 conflict 목록에 넣고 **그 행만 건너뛴다**(IN-10, 전체 롤백 아님, S-9)
      · amount < 0이면 raise(§5.12)
      · 스냅샷을 insert한다: jsonb {schemaVersion, projectId, capturedAt, kind:'execution_form', source, items: [], executions: {added, before}}(S-10). 과제별 최근 20개 창 유지(I-17)
      · 반환 {snapshotId, added, updated, deleted, conflicts:[{id, reason}]}
      · 예외 문구는 lib/db/import-snapshots.ts의 정규식 규약(찾을 수 없습니다 / 그 외 RULE)을 따른다
    - restore_import_snapshot 재정의: executions 키가 있으면 S-10 결정대로 복원한다. 결정 전이면 '수행 양식 스냅샷은 아직 복원할 수 없습니다'로 raise. **executions 키가 없는 스냅샷의 동작은 한 글자도 바꾸지 않는다**(D-17a 주석과 같은 태도)
    - restore_backup 재정의(S-12): c_tables는 20260925000000과 같다. budget_executions 행에만 spec 기본값을 채운다
    - grep: 'security definer'는 restore_backup에만 있다(X-2)
  SOT 근거: §5.12, §6.16 IN-10·IN-13, §8.3 X-1·X-2, §8.7 K-7, §8.8, I-17, D-17a
```

```
[AFTER: T0] [PARALLEL] T2. 타입·Zod·리포지토리 — 집행 7필드와 스냅샷 종류
  목표: 앱 계층이 새 컬럼과 수행 스냅샷을 읽고 쓴다
  대상 파일: types/index.ts, lib/db/schema.ts, lib/db/budget-items.ts, lib/db/import-snapshots.ts, tests/unit/mapper.test.ts (+ BudgetExecution 리터럴을 만드는 테스트 픽스처)
  완료 기준:
    - BudgetExecution에 §5.12 7필드: subcategoryCode: string|null, spec: string, unitPrice: number|null, factors: DetailFactor[]|null, axis: DetailAxis|null, memberId: string|null, detailId: string|null
    - ImportKind에 'execution_form'|'goal_form'. ImportSnapshotPayload.kind는 'budget_detail'|'execution_form'(optional)이고 executions 필드는 선택
    - budgetExecutionRowSchema에 7컬럼. factors는 detailFactorSchema 배열이거나 null. importKindSchema·importSnapshotPayloadSchema 확장. **수행 스냅샷 행이 Zod를 통과한다**(단위 테스트)
    - EXECUTION_COLUMNS·executionEmbedSchema에 7컬럼. addExecution·updateExecution이 새 필드를 선택적으로 받는다(생략 시 DB 기본값)
    - mapper: factors는 JSONB_PASSTHROUGH_KEYS에 이미 있다. isPercent 보존을 mapper 테스트로 고정한다. member_id↔memberId 등 변환 테스트
    - import-snapshots.ts에 commitExecutionForm(client, projectId, yearId, adds, updates, deleteIds, expected, source) 래퍼를 추가한다. 반환 Zod 검증. 예외는 기존 규약으로 매핑한다. ImportRestoreResult에 수행 복원 필드(선택)를 둔다
    - tsc 0. 단위 테스트 통과(통합 테스트는 T13 뒤)
  SOT 근거: §5.12, §5.12.1, §8.6, 절대 규칙 3·5, CLAUDE.md 코드 컨벤션(snake↔camel은 mapper 전담)
```

```
[AFTER: T0] [PARALLEL] T3. 좌표 맵 mode 분기 · 입력 양식 타입 · _meta
  목표: 좌표 맵 하나에서 mode별 열을 파생한다(IN-1·IN-9). _meta가 mode와 수행 목록을 싣고 거부 규칙을 갖는다
  대상 파일: lib/input-form/layout.ts, lib/input-form/types.ts, lib/input-form/meta.ts, tests/unit/input-form-layout.test.ts(추가만), tests/unit/input-form-execution-layout.test.ts (생성)
  완료 기준:
    - FormCellFormat에 'date'. 역할 추가: executionId(숨김, read), executionDate(라벨 '집행일', read, format 'date')
    - sheetsFor(mode). 수행 모드는 인건비·사업비 시트에 집행일·executionId 열을 더한다. amount는 read: true, format 'int'. formulaAmount·adjustment는 S-7 결정대로
    - INPUT_FORM_SHEETS === sheetsFor('plan')과 같은 값(JSON 비교 테스트). 기존 layout 테스트는 수정 없이 통과
    - columnOf·columnAddress·hiddenColumnIndexes가 InputFormSheetDef를 받는 기존 시그니처를 유지한다(mode별 def를 넘긴다)
    - types.ts: InputFormMeta에 mode·executions(id→version)·detailIds(선택). InputFormData에 executions(연차 집행 + category)(선택). ParsedExecutionRow·ParsedExecutionForm 타입. InputFormRejection.kind에 'mode-mismatch'. FormSheet에 선택 필드 validations(열 → 목록 이름, F-9)
    - meta.ts: 수행 모드에서만 mode·execution:·detail: 행을 쓴다(S-1). parseMeta는 mode 행이 없으면 'plan'. checkMeta(meta, {projectId, formVersion, mode})의 순서는 과제 → 버전 → mode이고, 불일치 문구는 IN-9("제안 양식입니다 — 제안 모드에서 올리세요" / 반대 방향 문구)
    - 제안 모드 buildMetaRows 출력이 현재와 같다(기존 왕복 테스트 그대로)
    - lib/input-form/은 exceljs·xlsx를 import하지 않는다(grep 0)
  SOT 근거: §6.16 IN-1·IN-2·IN-9·IN-13, 부록 F-6·F-9
```

```
[AFTER: T3] T4. 생성기·작성안내 — 수행 모드와 드롭다운 목록
  목표: mode='execution'이면 기존 집행 내역으로 행을 채운 양식을 만든다
  대상 파일: lib/input-form/build.ts, lib/input-form/guide.ts, tests/unit/input-form-build.test.ts(추가만. S-2 결정 시 시트 목록 단언만 수정), tests/unit/input-form-execution-build.test.ts (생성)
  완료 기준:
    - 인건비 시트: 행은 인력 × 그 인력의 인건비 비목 집행(memberId 일치)이고, 없으면 빈 1행(IN-12). 참여율·개월은 factors 라벨 '참여율(%)'·'참여기간(월)'에서 읽는다. 세목 라벨은 subcategoryCode로, 없으면 기본 라벨. 금액은 **값**(수식 없음, IN-11). 집행일을 채운다
    - 사업비 시트: 세목 코드 순서. 세목 없는 집행은 그 비목의 default 슬롯에, default가 없는 비목은 S-6 슬롯에 둔다. **그 연차의 모든 집행이 어느 한 행에 실린다**(누락 시 throw — 조용히 빠지면 삭제 후보가 된다). 빈 줄 3개와 소계·총액 수식 행은 두 모드 공통
    - 수행 모드 _meta: mode='execution', execution:<id>=version, detail:<id>
    - guide: unreadColumnsText(mode)가 sheetsFor(mode)에서 생성된다. 'plan' 출력은 현재 문자열과 같다(테스트로 고정). 수행 모드 '주의'에 "금액 열을 읽는다"
    - F-9: 축 목록(과 S-3 결정 시 인건비 세목 목록)을 FormSheet.validations로 싣는다. S-2 결정에 따라 _lists FormSheet를 만들거나 인라인 목록을 쓴다
    - buildInputForm(data, today)(mode 생략)의 결과가 기존과 같다(S-1·S-2에서 허용한 차이 제외). 기존 build 테스트 통과
  SOT 근거: §6.16 IN-3·IN-4·IN-9·IN-11·IN-12, §7.9.7 서식·수행 모드, 부록 F-8·F-9
```

```
[AFTER: T3] [PARALLEL] T5. 파서 — 수행 모드
  목표: 같은 좌표 맵으로 수행 양식을 읽는다. 미리보기와 반영이 이 함수 하나를 탄다(IN-6·IN-13)
  대상 파일: lib/input-form/parse.ts(진입점에 mode 인자만), lib/input-form/parse-execution.ts (생성), tests/unit/input-form-execution-parse.test.ts (생성)
  완료 기준:
    - parseInputForm(sheets, expected, mode = 'plan'). 제안 경로는 코드 경로와 결과가 불변이다(기존 parse 테스트 수정 없이 통과). _meta.mode ≠ 요청 mode면 거부(IN-9)
    - 수행 행: executionId(숨김. 비면 신규. _meta 목록 밖이면 blocking 'unknown-execution'), 집행일 필수(비면 blocking 'no-date'. 직렬값·'yyyy-mm-dd' 모두 ISO로 — S-13. 잘못된 날짜는 blocking), 금액 0 이상 정수(음수·소수 blocking), 축은 빈 값이면 null(경고 없음, IN-11), 세목 키 검사는 제안 모드와 같음(IN-4) + S-6 빈 세목 슬롯은 null, 참여율·개월 → factors(IN-12), memberId·detailId가 _meta 목록 밖이면 blocking(IN-13), 품명 200자 초과 blocking(S-14)
    - 사업비 행: 단가·인자가 있고 금액이 비면 PL-1과 같은 산식으로 채운다(lib/budget-plan의 산식을 재사용하고 새로 구현하지 않는다). 둘 다 있고 다르면 경고 'amount-mismatch'(입력 금액이 이긴다). 금액을 채울 수 없으면 blocking 'no-amount'
    - 인건비 행의 금액 보완·mismatch는 인력 연봉이 필요하므로 T6의 몫이다. 파서는 원 금액(nullable)만 넘긴다(아래 T6)
    - 빈 행 판정: 수행 모드는 사용자 열에 집행일·금액을 포함한다. 소계·총액 행은 계속 건너뛴다
    - 이름 매칭 함수 import 0(IN-3)
  SOT 근거: §6.16 IN-4·IN-6·IN-9·IN-11·IN-12·IN-13, §5.12 amount, 부록 F-6
```

```
[AFTER: T3, T5] T6. 수행 미리보기·커밋 페이로드
  목표: 파싱 결과 + 기존 집행 + 명부 + 예산 → id 기반 diff, 집행률 전후, RPC 페이로드
  대상 파일: lib/input-form/execution-preview.ts (생성), lib/input-form/index.ts, tests/unit/input-form-execution-preview.test.ts (생성)
  완료 기준:
    - 행 상태: add / update(달라진 필드 목록) / unchanged / conflict(현재 version ≠ _meta version, S-4) / error / unknown. 삭제 후보는 `_meta` executionId 목록 − 시트 id(오류 행이 가리키는 id도 참조로 친다). 삭제 후보 중 version이 바뀐 것은 conflict
    - 인건비 행: 금액이 비면 computeDetailAmount(연봉 × 참여율 × 개월, PL-10a 단일 산식)로 채운다. 입력 금액과 다르면 'amount-mismatch' 경고
    - 비목 이동(S-8)은 결정대로 처리한다
    - includeDeletes 기본 false. 페이로드: adds / updates(id, expectedVersion, 필드) / deleteIds(includeDeletes일 때만) / expected. DB snake_case. amount 정수 검사
    - 요약: 연차 집행률 전후는 lib/budget.ts의 computeYearSummary·computeItemSummary를 재사용한다(식은 한 곳). 예산 초과가 되는 셀 목록(isOverExecuted, B-2)과 예산 외 집행(B-1). 오류·경고·충돌 건수
    - **부록 B.4 검산**: 예산 200,000천원 / 집행 188,600천원 → 94.3%, 연구재료비 108.0%가 B-2 초과 목록에 오른다. 반영 전후 비교 케이스 포함
    - 순수 함수다(DB·시각을 쓰지 않는다). lib/input-form/preview.ts는 수정하지 않는다
  SOT 근거: §6.16 IN-10·IN-11·IN-12, §6.4 B-1·B-2, §8.4 O-1, 부록 B.4
```

```
[AFTER: T3] [PARALLEL] T7. 쓰기 어댑터 — 날짜 셀과 드롭다운
  목표: FormSheet의 date 열과 validations 힌트를 exceljs로 옮긴다
  대상 파일: lib/input-form-adapter.ts, lib/xlsx-style.ts, tests/unit/input-form-style.test.ts(추가만), tests/unit/input-form-adapter.test.ts(추가만. S-2 결정 시 시트 목록 단언만 수정)
  완료 기준:
    - format 'date' 열의 ISO 문자열을 날짜 셀로 쓴다(UTC 자정. 시간대 때문에 하루가 밀리지 않는다 — 테스트로 고정). 서식 'yyyy-mm-dd'(F-6). 잘못된 ISO면 throw
    - validations → exceljs 데이터 유효성(list). F-9의 _lists 참조 또는 인라인(S-2). _lists 시트는 hidden. 헬퍼는 xlsx-style.ts에 둔다
    - exceljs로 다시 열어 확인하는 테스트: 날짜 numFmt, 축 열 dataValidation 존재, 백분율 서식 0건 유지
    - 힌트가 없는 FormSheet 경로는 불변. 제안 양식 스타일 테스트 통과
    - server-only 유지. 클라이언트 번들에 exceljs가 들어가지 않는다
  SOT 근거: §6.16 IN-8, 부록 F-6·F-9
```

```
[AFTER: T4, T5, T6, T7] T8. 수행 모드 왕복 단위 테스트
  목표: 생성 → 쓰기(exceljs) → 읽기(readWorkbook) → 파싱 → 미리보기를 한 번에 고정한다
  대상 파일: tests/unit/input-form-execution-roundtrip.test.ts (생성)
  완료 기준:
    - 집행 5건 이상(인건비 2건은 factors 왕복, 사업비 세목 있음·없음, S-6 슬롯 포함). 그대로 다시 올리면 전부 unchanged, 삭제 후보 0
    - 행 수정 → update, 새 행 → add(executionId 없음), 행 삭제 → 삭제 후보(includeDeletes=false면 페이로드에 없음)
    - 집행일 누락(no-date), 음수 금액, amount-mismatch, mode 불일치 거부(제안 양식을 수행 모드로, 그 반대도), 경계 위반(다른 과제 memberId·목록 밖 executionId)
    - 날짜가 직렬값으로 읽혀도 ISO로 돌아온다. 백분율 서식 0건
    - 제안 모드 왕복 테스트(input-form-roundtrip)는 수정 없이 통과
  SOT 근거: §6.16 IN-9~IN-13, 평가 기준 Phase 20 "단위 테스트" 항목
```

```
[AFTER: T2, T4, T5, T6, T7] T9. 서버 액션 — mode 인자 + commitExecutionForm
  목표: §9 Budget Input Form 계약을 수행 모드까지 넓힌다
  대상 파일: actions/input-form.ts
  완료 기준:
    - buildInputForm(projectId, yearId, mode = 'plan'). 수행 모드는 그 연차 budget_items의 집행(+ category) · 산출근거 id · 인력을 싣는다
    - previewInputForm(projectId, formData, mode = 'plan'). 제안 모드의 반환 타입과 값이 불변이다(오버로드 또는 판별 유니언의 plan 분기). 수행 모드는 add/update/unchanged/삭제 후보/conflict 건수·목록, 연차 집행률 전후, B-2 초과 셀, 경고, blocked, fileHash를 돌려준다
    - commitExecutionForm(projectId, formData, fileHash, includeDeletes): 미리보기와 **같은 파이프라인 함수**(runExecutionFormPipeline 하나를 preview·commit이 공유). fileHash 대조. blocked면 RULE로 막는다. RPC 결과의 conflicts를 ActionResult data에 **그대로** 싣는다(삼키지 않음). revalidatePath('/', 과제, 연구비, 설정)
    - commitInputForm·runInputFormPipeline은 변경하지 않는다(diff 0행)
    - 입력 검증은 Zod(uuid·fileHash·includeDeletes boolean). supabase 직접 호출 0(리포지토리만, 절대 규칙 3)
  SOT 근거: §9 Budget Input Form, §6.16 IN-6·IN-10·IN-13, 절대 규칙 3·5
```

```
[AFTER: T2] [PARALLEL] T10. 집행 CRUD 액션 — 새 필드
  목표: 집행 내역 패널에서 손으로 넣는 경로도 7필드를 받는다(필수 아님)
  대상 파일: actions/budget.ts, tests/integration/budget-actions.test.ts(추가만. 실행은 T13 뒤)
  완료 기준:
    - executionFieldsSchema에 7필드(전부 optional/nullable). unitPrice는 0 이상 정수, factors는 0~3개, axis enum, subcategoryCode는 그 비목 프리셋 코드 또는 null
    - memberId는 그 과제의 인력, detailId는 그 과제·같은 연차의 산출근거인지 리포지토리 조회로 검사한다. 위반이면 RULE(N-13·IN-13과 같은 경계)
    - 기존 호출(4필드만)의 동작이 불변이다
  SOT 근거: §5.12, §9 add/updateExecution, §8.4 O-1
```

```
[AFTER: T10] T11a. 집행 내역 패널 "내역" 줄
  목표: §7.9 패널에 새 필드를 접힌 "내역" 줄로 보이고 편집한다
  대상 파일: components/budget/BudgetDetailPanel.tsx
  완료 기준: 행마다 접힘 토글. 세목(그 비목 프리셋 드롭다운 + 미지정), 규격, 단가, 인자(라벨·값·%), 축(미지정·현금·현물), 인력(인건비 비목일 때), 산출근거(선택)를 편집한다. 저장은 기존 updateExecution(expectedVersion, O-3 경로 유지). 새 props(members·details)는 선택이다(T11b가 연결). 금액·날짜 편집 동작은 불변
  SOT 근거: §7.9.7 수행 모드 마지막 문장, §7.9
```

```
[AFTER: T9, T11a] T11b. 연구비 화면 — 수행 모드 툴바·업로드 모달
  목표: 수행 모드에서 [입력 양식 내려받기]·[입력 양식 올리기]를 쓴다
  대상 파일: components/budget/BudgetScreen.tsx, components/budget/input-form/InputFormDownload.tsx, components/budget/input-form/ExecutionFormUpload.tsx (생성), app/projects/[id]/budget/page.tsx(패널에 넘길 members·details가 없으면)
  완료 기준:
    - 두 버튼을 수행 모드에도 노출한다. 다운로드는 mode를 넘긴다. 업로드는 새 ExecutionFormUpload를 쓴다(InputFormUpload.tsx 무수정)
    - 미리보기: 추가·변경·삭제 후보·충돌 건수, 연차 집행률 전후, B-2 초과 셀 경고, 오류 행(사유), 삭제 후보 목록, **[삭제 포함] 토글(기본 꺼짐)**. blocked면 반영 버튼 비활성. 반영 결과에 충돌 행 목록을 표시한다(삼키지 않음)
    - BudgetDetailPanel에 members·details를 연결한다
    - 제안 모드 툴바·동작 불변. 클라이언트 컴포넌트는 supabase를 직접 부르지 않는다
  SOT 근거: §7.9.7, §6.16 IN-10
```

```
[AFTER: T2, T1] [PARALLEL] T12. 설정 스냅샷 패널 — 수행 스냅샷
  목표: 수행 스냅샷을 목록에 종류로 구분해 보이고, 복원 결과(또는 명시적 거부)를 보인다
  대상 파일: components/settings/ImportSnapshotPanel.tsx, actions/import.ts(restoreImportSnapshot 결과 타입만 해당 시)
  완료 기준: kind 'execution_form' 라벨("수행 양식"), 추가·변경·삭제 건수 요약. 복원은 S-10 결정대로 결과를 보이거나 RPC 거부 문구를 그대로 보인다. 총괄표·산출근거 스냅샷 표시 불변
  SOT 근거: I-17, §7.14
```

```
T13. db push — 사람 개입 지점 (멈춤)
  목표: T1 마이그레이션을 원격 Supabase에 적용한다
  대상 파일: 없음 (명령 실행)
  완료 기준:
    - K-6: push 직전에 앱의 [지금 내보내기]로 백업한다(schema_version 4 파일)
    - 이 PC에서 `supabase link`가 안 돼 있으면 사람이 link한다. 그다음 `npm run db:push`
    - 확인: budget_executions 7컬럼 존재, app_settings.schema_version = 4, commit_execution_form 함수 존재
    - 이 시점 이후에만 `npm test` 전체(통합 포함)를 완료 기준으로 쓴다. 메모리 "npm test가 시드를 지운다" — 수동 검증 데이터가 있으면 먼저 백업한다
  SOT 근거: §8.7 K-6, §8.8
```

```
[AFTER: T13, T9, T10, T12] T14. 통합 테스트
  목표: RPC·액션이 DB에 남기는 것을 고정한다
  대상 파일: tests/integration/execution-form-actions.test.ts (생성), tests/integration/backup-execution-columns.test.ts (생성. 기존 백업 테스트 파일이 있으면 거기에 추가)
  완료 기준:
    - 내려받기 → 수정 → 미리보기 → 반영: budget_executions 추가·변경, 집행률(§6.4) 일치, 다시 내려받으면 executionId가 채워져 있다(§11 Phase 20 완료 기준)
    - 삭제: includeDeletes=false면 행이 남고, true면 삭제된다
    - conflict: 미리보기 뒤(또는 내려받은 뒤) 다른 경로로 updateExecution → 그 행만 건너뛰고 conflicts로 돌아온다. 나머지 행은 반영된다
    - 경계: 다른 과제 memberId·detailId·executionId → RULE, DB 무변경
    - 스냅샷: kind 'execution_form', 20개 창, listImportSnapshots가 Zod를 통과한다, 복원(S-10)
    - fileHash 불일치 거부, mode 불일치 거부
    - 백업: 내보내기 JSON에 7컬럼이 있다. 7컬럼을 뺀 옛 형식 budget_executions로 restore_backup → spec '' 등 기본값(S-12)
    - 기존 input-form-actions·input-form-smoke·budget-actions 통합 테스트가 수정 없이 통과한다
    - npm test·tsc·build 통과. dev 서버 위에서 build 금지(메모리)
  SOT 근거: §6.16 IN-10·IN-13, §8.7, I-17, §11 Phase 20
```

```
[AFTER: T14] T15. 마감 — 문서
  목표: 인계 문서와 SOT 표기를 확인한다
  대상 파일: PROGRESS.md, docs/SOT.md(필요 시)
  완료 기준: §13 12-a "해소 (v4.8 / Phase 20)" 표기 확인(이미 있음). PROGRESS에 Phase 20 결과·함정·수동 검증 URL 표(메모리: id가 박힌 실제 주소). 절대 규칙 grep: service_role 0, 수행 경로의 dangerouslySetInnerHTML·supabase 직접 호출 0
  SOT 근거: §13, CLAUDE.md 작업 방식
```

## 의존 그래프

T0 → {T1, T2, T3} 병렬 → T3 → {T4, T5, T7} 병렬 → T6(T5 뒤) → T8(T4·T5·T6·T7 뒤) ∥ T9(T2·T4·T5·T6·T7 뒤); T2 → T10 → T11a → T11b(T9 뒤); {T1, T2} → T12; T1 → **T13(사람)** → T14(T9·T10·T12 뒤) → T15.

같은 파일을 두 태스크가 동시에 건드리지 않는다. `actions/input-form.ts`는 T9, `BudgetScreen.tsx`는 T11b, `BudgetDetailPanel.tsx`는 T11a, `layout/types/meta`는 T3, `build/guide`는 T4, `parse`는 T5, 어댑터·`xlsx-style`는 T7만 수정한다.
