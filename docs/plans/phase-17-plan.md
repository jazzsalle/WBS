# Phase 17 구현 계획 (planner 산출, 2026-09-25) — 재개용

확정 결정 3건(SOT 반영): ① 반영은 양식에 행이 있는 비목 단위 교체(기존 `commit_detail_import` RPC 재사용, 행 없는 비목은 유지 + "양식에 없는 비목 N행 유지" 표시 — IN-5) ② 인건비 시트에 보이는 `세목` 열 + 두 시트 숨김 `detailId` 열(IN-3·IN-5) ③ 사업비 인자 라벨은 프리셋 고정, isPercent는 /100 값 — 금액만 보존(IN-4).

사전 확인: `commit_detail_import` RPC(p_rows snake_case DetailImportRow[], p_replace_categories, p_new_members=[], p_source) 재사용 → `snapshotsRepo.commitDetailImport(client, projectId, yearId, [], rows, replaceCategories, source)`. 읽기는 `lib/import-adapter.readUploadedWorkbook`(숨김 시트 포함) 무수정 재사용, 쓰기는 새 `lib/input-form-adapter.ts`. `actions/detail-import.ts`·`lib/export-adapter.ts`·`lib/import-adapter.ts`·`components/budget/import/**`는 어느 태스크도 수정하지 않는다.

## 태스크
- **[P] T1 좌표 맵·타입·_meta** — `lib/input-form/{layout,types,meta,index}.ts`, `tests/unit/input-form-layout.test.ts`. INPUT_FORM_VERSION=1, 시트 3장(인건비·사업비·_meta) 열 역할(hidden·read 플래그), `columnOf`, `buildMetaRows`↔`parseMeta`↔`checkMeta`(거부 3종)
- **[AFTER T1] T2 생성기** — `lib/input-form/build.ts`: 인건비(인력별 기존 행 수만큼, 참여율/개월/월급 표시/기준 배지/조직원, 수식 `ROUND(연봉*참여율/100*개월/12,0)` + 금액=산식+조정액, 연봉 null은 빈 칸+비고), 사업비(A.5 전 세목 순 + 빈 줄 3, 인자 defaultFactors 순, 금액 수식), `_meta`, 파일명. 테스트 B.7 픽스처
- **[AFTER T1] T3 파서** — `lib/input-form/parse.ts`: 거부 3종+시트 누락, memberId/세목 코드로만 연결(unknown-* 남김), 범위 검사(참여율 0~100·개월 0~12 blocking), 금액·연봉·월급 열 안 읽음, 빈 행 무시, D-22 percentFormat ×100, 이름 매칭 함수 import 0
- **[AFTER T1,T3] T4 미리보기·커밋 페이로드** — `lib/input-form/preview.ts`(diff by detailId, replaceCategories, untouchedCategories, commitRows DetailImportRow snake_case, blocked), `lib/dates.ts` `monthSpan`. B.7 24행 금액 일치·총액 298,510,000
- **[AFTER T1] T5 쓰기 어댑터** — `lib/input-form-adapter.ts`(server-only, 수식 셀 f, 숨김 시트·열, 참여율 일반 숫자 서식), `tests/unit/input-form-adapter.test.ts`·`input-form-boundary.test.ts`
- **[AFTER T2,T3,T4,T5] T6 액션** — `actions/input-form.ts`: `buildInputForm`·`previewInputForm`·`commitInputForm`(같은 `runInputFormPipeline`, fileHash 대조, blocked만 막음, 규칙 findings notice, `snapshotsRepo.commitDetailImport` 재사용, revalidatePath 4경로)
- **[AFTER T6] T7 화면** — `components/budget/input-form/{InputFormDownload,InputFormUpload}.tsx`, `BudgetScreen.tsx` 툴바 버튼 2개(제안 모드만)
- **[AFTER T2~T5] T8 왕복 단위 테스트** — `tests/unit/input-form-roundtrip.test.ts`: B.7 → 생성 → 쓰기 → 읽기 → 파싱 → 미리보기 unchanged·총액 298,510,000, 수식 검산 19행, 금액 999 덮어써도 PL-1 값, 빈 행에 30·12 → add, projectId 바꾸면 거부
- **[AFTER T6] T9 통합 테스트** — `tests/integration/input-form-actions.test.ts`: 내려받기→미리보기(변경 0)→수정 커밋→budget_details·budget_items·스냅샷→재내려받기 값 유지, fileHash·과제·버전 거부, 경고만은 커밋 성공, skippedLocked

의존: T1 → {T2,T3,T5} → T4(T3) → T6 → {T7, T9}; T8(T2~T5 뒤, T6과 병렬).
