# PROGRESS — 회사↔집 인계 문서

## Last updated
2026-08-05 (Phase 5.5 완료 — 집 PC 세션)

## Current goal
Phase 6 (리스크 + 노트: 리스크 대장·매트릭스, 마크다운 노트) — SOT §5.13~5.14, §7.11~7.12

## Done this session
- **Phase 0 완료** (evaluator PASS 12/12, 커밋 07fa94a) — 스키마 25종+RLS+RPC, 리포지토리 16종, 테스트 48건
- **Phase 0.5 완료** (커밋 85df882→5154e67) — Tauri 셸+딥링크, 구글 OAuth 인증+승인 UI, 백업/복원. **실로그인 왕복 검증 완료** (브라우저·Tauri 양쪽)
- **Phase 1 완료** (evaluator 조건부 PASS, 테스트 232건) — 계층 + WBS:
  - 순수 함수: `lib/tree.ts`(WBS 코드·순환/깊이·날짜 롤업), `lib/progress.ts`(4단계 롤업), `lib/priority.ts`(긴급도·우선순위), `lib/dates.ts` — 부록 B.1(58 / 38.6667 / 59.1111)·B.0 수치 그대로 통과, P-8 중간 반올림 금지 회귀 테스트 포함
  - RPC 8종: `move_task`·`move_task_to_year`·`reorder_tasks`(순환 H-2·깊이 H-3·연차 H-1을 DB에서 차단), `create_project_with_defaults`(단계·연차·비목 12종 자동 생성)·`reorder_projects/stages/years`·`set_year_status`
  - 서버 액션 4종 + WBS 조회 모델(`getYearTree`/`getProjectFullTree`)
  - UI: 공통 프리미티브·`RealtimeRefresher`(R-1~R-7)·과제 목록/생성 → 과제 탭 10개·개요·단계연차 패널 → **WBS 트리 화면**(드래그·Tab/Shift+Tab·깊이 10 UI 차단·상세 패널)
  - O-3 충돌 처리: 상세 패널·인라인 이름 편집 모두 입력값 보존 + 항목별 비교/선택. 저장 payload 키 불변식은 **매핑 타입으로 컴파일 타임 강제**
- **Phase 2 완료** (evaluator PASS, 테스트 281건) — 인력 + 기관:
  - RPC 5종: `delete_member`(H-9 참조 8곳 정리 + 건수 반환), `count_member_references`, `set_lead_organization`(H-8 재지정 트랜잭션), `reorder_organizations`/`reorder_members`
  - `actions/team.ts` 액션 13종 + 조회 2종(getTeam, getTeamScreenData). H-8 삭제 차단·역할 강등 차단을 액션에서 수행
  - **소속 무결성**: createTask/updateTask/assignTaskMembers/bulkUpdateTasks가 남의 과제 인력·기관을 거부. 일괄 수정은 여러 과제 혼합 시 쓰기 전에 거부(부분 반영 방지)
  - UI: `/projects/[id]/team`(기관 카드·인력 기관별 그룹 테이블·PM 지정 경고·삭제 시 참조 8곳 건수·배정 작업 패널), WBS 트리 담당/기관 컬럼 + 필터, 상세 패널 담당자(단일+다중)·기관 편집(O-3 비교 대상 포함), 과제 개요 PM·주관기관 표시, 인력·기관 탭 활성화
- SOT 보강 4건: §8.3 X-2 definer 예외 목록, §6.1 P-9(예산 전부 0인 경우), 부록 A.3(과제·연차 상태 색상 + 색상 폴백), §6.6 H-8(주관 재지정 트랜잭션 규칙)
- **후속 정리 3건** (Phase 3 착수 전):
  - 파괴적 테스트 격리 — `tests/destructive/`로 분리(`npm run test:destructive`), 기본 `npm test`는 안전한 테스트만. 시작 전 실데이터 감지 가드가 테스트 소유가 아닌 행을 찾으면 시드조차 넣지 않고 거부한다
  - `createOrganization`: lead를 joint로 만든 뒤 `set_lead_organization`으로 승격 — 승격 RPC가 실패해도 lead가 2개로 남지 않는다 (H-8)
  - `updateProject`: `pmMemberId`·`leadOrgId`를 patch에서 제외(+`strict()`) — `setProjectPM`/`setLeadOrganization`의 가드를 우회할 수 없다

- **Phase 3 완료** (evaluator 조건부 PASS + 후속 조치 반영, 테스트 374건) — 목표 관리:
  - `lib/goals.ts` — §6.2 성과목표(D-1~D-5)·§6.3 기술목표(T-1~T-4) 계산. 부록 B.2 57.333…·B.3 수치 그대로 통과, **중간 반올림 시 57.4가 됨을 명시적으로 배제**하는 회귀 테스트 포함. direction 3종 × baseline 유무 6조합 + 경계값 전부 테스트(단위 47건)
  - RPC 2종: `reorder_deliverables`, `reorder_tech_targets`
  - `actions/goals.ts` 액션 16종 + `getGoalsData`(달성률은 저장하지 않고 `lib/goals.ts`로 계산). **N-13 과제 경계 검증**: targetByYear 키·achievement.yearId·record.yearId·orgId·memberIds가 남의 과제면 RULE 거부(FK가 못 막는 부분)
  - UI: `/projects/[id]/goals` 2탭(성과목표 테이블·연차 매트릭스 인라인 편집·실적 목록·유형별 도넛 / 기술목표 테이블·측정 이력·스파크라인·가중 달성률 게이지·인쇄 레이아웃), 개요 목표 요약 카드, 목표 탭 활성화
  - WBS 목표 연계: `linkTaskGoals` + createTask/updateTask/bulkUpdateTasks 목표 참조 경계 검증, 상세 패널 연계 편집(O-3 비교 대상 포함), 트리 연계 뱃지
- SOT 보강 7건 (누적): §8.3 X-2, §6.1 P-9, 부록 A.3 상태 색상, §6.6 H-8 재지정 트랜잭션, **§6.1 P-8 표시 형식(소수 1자리 고정)**, **§5.8·§5.9 자식 타입에 `version` 추가**(실적·측정 이력 편집이 O-1 대상인데 잠금을 걸 방법이 없던 모순 해소)

- **Phase 4 완료** (evaluator 조건부 PASS, 테스트 507건) — 마일스톤 + 대시보드:
  - `lib/dates.ts` 확장 — **기준일을 Asia/Seoul 달력 날짜로 고정**(`todayISO(now)`). 서버(사이드카, UTC일 수 있음)와 사용자 PC 시계가 달라도 같은 판정이 나온다. 테스트를 뉴욕 시간대로 돌려도 통과. `formatDday`, 마일스톤 overdue/upcoming 판정
  - `lib/risk.ts` — 리스크 등급(§6.5 Risk 행 + occurred 규칙), 테스트 67건
  - `generate_default_milestones` RPC — 연차평가·실적계획서 2건, **멱등**(재실행 시 추가 0건), 연차 종료일 없으면 조용히 오늘로 때우지 않고 명시적 거부
  - `actions/milestones.ts` 5종 + 조회, 과제 경계 검증(yearId·ownerMemberId)
  - 마일스톤 화면(연차 밴드 타임라인·목록·상태 인라인 변경·결과 메모), 개요 임박 마일스톤 카드, 연차 생성 시 기본 마일스톤 옵션(기본 해제)
  - **대시보드**(`/`) — §7.2 6종 전부: 지표 5개·과제 요약 카드·임박 마일스톤 타임라인·오늘 집중할 작업·주의 필요·오늘의 To-Do. 아카이브 과제는 전 집계에서 제외(단위 테스트로 고정). 벌크 조회(N+1 없음) + **Supabase 1000행 페이징 처리**(§12 5,000 작업이 조용히 잘리는 것 방지)
- SOT 보강 8건 (누적): …(이전 7건) + **§6.5 기준일을 Asia/Seoul 달력 오늘로 명문화**(로컬 타임존이면 화면마다 지연/정상이 달라짐)

- **Phase 5 완료** (evaluator 조건부 PASS·결함 없음, 테스트 580건) — 연구비:
  - `lib/budget.ts` — §6.4 집행률·B-1~B-3 판정·매트릭스 집계(항상 12행). 부록 B.4 수치 그대로 통과. **합계 집행률(94.3)이 개별 평균(90.93)이 아님**을 회귀 테스트로 배제, 중간 반올림 금지도 고정. Phase 4의 임시 `computeExecutionRate`를 이쪽으로 이전(정의 1곳)
  - `lib/currency.ts` — B-4 표시 환산(원 단위 저장, 표시만 천원/백만원). 대시보드의 로컬 사본 제거
  - **집행 내역 임베드 절단 대응** — PostgREST가 임베드 자식 1000행 초과를 **에러 없이 잘라서** 집행률이 조용히 틀리던 문제. 실측으로 확인(1,200건 중 1,000건만 반환) 후 부모 조회 + 자식 페이징 병합으로 교체. 1,200건 통합 테스트로 고정
  - `actions/budget.ts` 4종 + `getBudgetMatrix`. 현금/현물 합계 검증(차액을 서버가 임의 배분하지 않음 — DB 재조회로 확인)
  - 연구비 화면 — 12행 매트릭스(직접비/간접비 구분), 총액 인라인 편집, 집행 내역 패널(추가/수정/삭제), 하단 요약행(합계·집행률·잔액), B-1 경고 아이콘·B-2 빨강·B-3 배지, [엑셀 가져오기] 비활성(Phase 5.5 안내)
- SOT 보강 11건 (누적): …(이전 8건) + **§5.12 `BudgetExecution.version` 추가**(집행 편집도 O-1 대상), **§5.12 `amount` 0 이상 정수 명시**(실무에서 음수 없음 — 사용자 확인, 환불·감액은 원래 행 수정), **§9 `updateExecution`에 `expectedVersion?` 명기**

- **Phase 5.5 완료** (evaluator **PASS** — 비차단 지적 2건(문서 드리프트)은 즉시 반영, 테스트 843건) — 엑셀 예산계획 임포트. **SOT를 v3.3 → v3.4로 먼저 고치고 구현했다.**
  - **착수 전에 실측 샘플 2종을 프로토타입으로 직접 파싱해 SOT 규칙 공백 7건을 찾았다.** 머리로 검토했으면 전부 놓쳤을 것들이다:
    - **S-2'** carry-forward는 **판정에 성공한 라벨만** 승계 — 행안부 B열 세로쓰기 `직`/`접`/`비`가 아래 행으로 번져 **미매핑 3건**을 만들어냈다. S-7의 "우측 우선 매칭으로 자연히 무시된다"는 우측에 매칭될 라벨이 있을 때만 성립한다
    - **I-1 정규화 순서** 확정 — 각주 마커 `숫자)` 제거를 **괄호 제거보다 먼저**. `총 인건비1) (E=A+B+C+D)`의 `1)`은 짝 없는 닫는 괄호라, 순서가 뒤면 `총인건비1`이 남아 스킵되지 않고 **집계 행이 비목으로 반영**된다
    - **S-10** 정규화 후 빈 라벨 행의 분기(축 라벨이 있으면 직전 비목 승계) — 행안부 `연구재료비`/`(G)` 2행 분절에서 **현물 금액이 통째로 유실**되던 공백
    - **S-11** 병합 범위를 carry-forward보다 **먼저** 확장 — 산자부 `C16:E16` 가로 병합 메모가 위 행의 `현물` 축을 물려받아 **메모 행이 금액 행으로 둔갑**하던 문제
    - **S-12** 라벨 판정을 우→좌 스캔 + 첫 판정 채택으로 알고리즘화. 라벨 없이 금액만 있는 행은 `건너뜀(라벨 없음)`으로 미리보기에 남긴다
    - **S-13** 시트 추천을 비목 매칭 **행 수 → 행 비율**로 교체 — 워크북에 연차별 산출근거 시트(240~250행)가 같이 들어 있어 **행 수로 매기면 두 파일 모두 총괄표가 아닌 시트를 추천**했다 (산자부 0.655 vs 0.139, 행안부 0.379 vs 0.135)
    - **`CASH_INKIND_AXIS`**(부록 C) — `일반`/`통합관리`가 `unassigned`(plannedAmount에만 합산)라는 규칙이 주석에만 있어 구현이 임의로 현금에 몰아넣을 수 있었다. 상수로 승격
  - **부록 B.6 신설** — 실측 2종의 1차년도 기대 파싱값 + 구조 자동 감지 기대 동작. 통합 테스트 기준값
  - `lib/import/` 순수 함수 9모듈(xlsx 무의존) — normalize·categorize·amount·grid·structure·matrix·preview. 부록 B.5 10행 시나리오를 픽스처로 그대로 통과
  - `lib/import-adapter.ts` — SheetJS → `RawSheet` 어댑터. `import 'server-only'`로 I-13을 컴파일 타임에 못 박음
  - `commit_import`/`restore_import_snapshot` RPC(security invoker) + `lib/db/import-snapshots.ts`. 단일 트랜잭션·과제 경계 검증·I-17 스냅샷(과제별 20개 창)
  - `actions/import.ts` — `runImportPipeline`이 preview·commit의 **유일한** 파싱 경로다(§9: 미리보기와 반영이 달라선 안 된다). `fileHash` 대조, `blocked` 재계산 금지
  - `components/budget/import/` 5단계 마법사 + 툴바 [엑셀 가져오기] 활성화
  - **결과: 실측 2종 모두 미매핑 0건.** 파싱 결과의 직접비 합·총액이 원본 `직접비 소계`·`연구개발비 총액` 행과 **원 단위까지 일치**(산자부 296,510,000 / 298,510,000, 행안부 133,340,000 / 133,340,000)
  - SOT 보강 (누적 11 → **20건**): 위 7건 + I-17 보강(20개 창은 과제별·복원은 스냅샷을 만들지 않고 행을 지우지 않음) + §7.9.1 Step 5 `신규`/`덮어씀` 판정 기준(행 존재가 아니라 **값의 존재**) + Step 4 아이콘 근거를 서버가 싣는다 + 계약 공백 4건(`yearMapping` 키 = 엑셀 열 문자 / `commitImport`의 `profileId`는 별도 인자 / `orientation='column'` 명시적 거부 / `ImportProfile`에 데이터 끝 행을 저장하지 않는 이유) + 부록 B.5 표 열 문자 정정 + §10 디렉터리 구조 갱신

- **후속 정리 2건** (PROGRESS 대기 목록에서 처리):
  - `TechRecordForm.tsx` 측정일 기본값을 로컬 `new Date()` → **Asia/Seoul**(`todayISO`). 타임존이 다른 PC에서 하루 어긋난 측정일이 저장되던 문제
  - **테스트 중단 시 dev DB 잔여물 자동 청소** — `tests/global-setup.ts`(실행 1회). `wbs-test+%` 중 2시간 이상 경과분만. **삭제 순서가 핵심**: 사용자를 지우기 전에 소유 행을 먼저 지운다(auth.users를 먼저 지우면 `created_by`가 set null이 되어 그때부터 실데이터와 구분 불가). 3시간 전으로 백데이트한 가짜 잔여물을 심어 감지·삭제·로그를 실제로 확인

## In progress
없음

## Next steps
1. `/phase-run 6` — 리스크 + 노트: 리스크 대장·5×5 매트릭스(`lib/risk.ts`는 Phase 4에서 이미 만들어 테스트 67건 통과), 마크다운 노트 + 회의록 템플릿 + Task/Milestone 연결 역참조
2. **Phase 5.5 후속 (블로킹 아님)**:
   - **`restore_import_snapshot`을 감싸는 서버 액션이 없다.** RPC와 리포지토리는 있고 통합 테스트도 리포지토리를 직접 부른다. §7.14 설정 화면(Phase 8)에서 액션을 만들 때 `tests/integration/import-actions.test.ts`의 복원 부분도 액션 경유로 바꿀 것
   - CSV는 SheetJS가 UTF-8로 가정한다 — **CP949 CSV는 깨진다.** 실측 서식이 전부 xlsx라 v1에서는 두었다
   - `orientation === 'column'`(전치 서식)은 명시적 거부 상태다. 실제로 그런 서식이 오면 `parseMatrix` 확장 필요
3. **후속 정리 (블로킹 아님)**:
   - `getBudgetMatrix`가 집계만 반환해 화면이 `listBudgetItemsByProject`로 원본 행(itemId·version·cash/inKind null 여부·executions)을 한 번 더 조회한다. `BudgetMatrixData`에 `items` 추가로 흡수 권장 (`app/projects/[id]/budget/page.tsx` 주석에 명시)
   - `listBudgetItemsByProject`의 **부모** 조회는 무페이징 — 연차 84개 초과 과제에서 같은 절단이 발생한다(현실 규모에선 도달 안 함)
4. 미뤄둔 것: HR API 연동(hr.unes.kr 직원 명부 — SOT 추가 후 별도 진행), 단일 과제 조회 액션(`getProject(id)`)
3. Phase 1 후속 개선(블로킹 아님): ① 인라인 이름 편집 중 Enter 연타 시 in-flight 재입력이 제출값으로 되돌아감 ② 자기 저장에 대한 가짜 STALE 배너(`disabled={saving}` 가드) ③ `bulkUpdateTasks` 부분 반영(트랜잭션 RPC화 검토)
4. 남은 관찰 항목(블로킹 아님): `tests/integration/wbs-queries.test.ts`는 팀 공유 설정 `app_settings.progress_weight_basis`를 잠시 바꿨다 되돌린다. 데이터를 지우지 않아 기본 실행에 두었지만, **두 PC에서 `npm test`를 동시에 돌리면** 서로의 임시값을 원본으로 착각해 설정이 어긋날 수 있다. 테스트는 한 번에 한 PC에서만 돌린다

## 수동 검증 (누적)
### 완료
- 구글 OAuth 콘솔 + Supabase provider, 브라우저 실로그인(첫 사용자 자동 승인), Tauri 실로그인 전체 왕복(시스템 브라우저→딥링크→키체인→홈), cargo check, 백업 내보내기 실동작
- 검증 중 수정한 결함 2건: opener URL 허용 목록 부재, Windows 자격 증명 관리자 2560바이트 제한(키체인 청크 분할)

### 대기
- Phase 1: ① 두 세션 동시 수정 시 STALE 비교 UI·입력 보존 ② 드래그 이동·Tab/Shift+Tab·깊이 10 초과 거절 문구 ③ 편집 중 R-4 배너 동작
- Phase 4: ① `/projects/[id]/milestones` 실화면 CRUD·상태 인라인 변경·결과 메모 ② 연차 생성 시 기본 마일스톤 체크박스(종료일 없으면 비활성) ③ `/` 대시보드 6개 영역 실렌더
- Phase 5: ① 셀 인라인 편집(Enter/Esc/blur)·잠금 셀 안내 ② 셀 클릭 → 집행 패널 → 추가/수정/삭제 후 매트릭스 갱신 ③ B-2 빨강·B-3 배지 실렌더 ④ STALE 시 ConflictDialog 입력값 보존
- **Phase 5.5 (마법사는 자동 검증이 안 되는 부분이 많다 — 실제 브라우저로 확인할 것)**:
  ① 툴바 [엑셀 가져오기] → 모달. Esc/×/취소로 닫으면 상태 폐기(다시 열면 Step 1부터)
  ② 10MB 초과 파일·`.pdf`를 올리면 **업로드 전에** 이유와 함께 거부
  ③ 실측 총괄표 업로드 → Step 2에서 `유엔이_총괄표`가 ★와 S-13 점수로 하이라이트. 헤더 행 클릭 지정 시 연차·라벨 열 재감지
  ④ 병합 셀이 그리드에 실제로 병합되어 보인다(행안부 `연구재료비`/`(G)`, 산자부 `C16:E16`)
  ⑤ Step 2→3 진행이 **금액 단위 확인 체크박스**로 막힌다 (I-10: 1000배 오류는 치명적이라 자동 확정 금지)
  ⑥ Step 3: 자동 추정 연차 드롭다운은 회색, 사용자가 바꾸면 파랑. 하나라도 `미지정`이면 다음 버튼 비활성 + S-5 사유 표시
  ⑦ Step 4 아이콘(✅/🔵/⚠️/❌)이 실제 파일에서 기대대로. 미매핑에 비목 지정 시 ❌ 해제, 건너뛰기로 행 제외
  ⑧ Step 5: `#REF!` 셀이 빨강 오류 행이 되고 반영 버튼 비활성 → 그 행을 건너뛰면 활성화. 덮어씀 행에 `기존 → 신규` 표시
  ⑨ 반영 → 토스트 + 매트릭스 갱신. 프로파일 저장 후 다시 열어 프로파일 선택 시 Step 4로 직행
  ⑩ 마법사를 연 채 다른 브라우저에서 예산 셀 수정 → 자동 새로고침 대신 "새 변경 있음" 배너 (R-4)
- 공통: 두 PC 동일 데이터 조회, 동료 첫 로그인 시 /pending→승인 흐름(두 번째 회사 계정 필요), Tauri 자동 백업 7일 경과 실동작

## Blockers
없음

## How to run
- 테스트: `npm test` — 단위(`tests/unit`) + 통합(`tests/integration`). 통합은 실제 dev DB를 쓰고(네트워크 필요) **자기가 만든 데이터만** 지운다. 안전하게 아무 때나 돌려도 된다
  - 실행 1회 `tests/global-setup.ts`가 **중단된 이전 실행의 잔여물을 먼저 청소**한다(`wbs-test+%` 중 2시간 이상 경과분 + 그 소유 행). 무엇을 몇 건 지웠는지 콘솔에 남긴다
  - `samples/`가 없으면 실측 검증(`tests/unit/import-samples.test.ts`, `tests/integration/import-actions.test.ts`)이 **안내를 출력하고** 건너뛴다. 조용히 통과하지 않는다
  - ⚠️ vitest 기본 리포터는 **통과한** 테스트의 `console.log/warn`을 감춘다(`--reporter=verbose`에서만 보인다). 테스트에서 사람이 꼭 봐야 할 안내는 `process.stderr.write`로 쓴다
- ⚠️ 파괴적 테스트: `npm run test:destructive` — `tests/destructive/`(§8.7 K-7 전체 대체 복원 검증)만 돌린다. **대상 25종 테이블의 전 행을 지웠다 백업 시점으로 되돌린다.** 사람이 명시적으로 부를 때만 실행되며, 시작 전 가드(`tests/destructive/guard.ts`)가 테스트 소유가 아닌 데이터(시드 고정 UUID·`wbs-test+%` 사용자 소유가 아닌 projects/todos/notes/import_profiles 행)를 발견하면 아무것도 건드리지 않고 거부한다
  - **실데이터를 입력하기 시작하면 이 명령을 dev DB에서 돌리지 않는다.** 백업 복원 로직을 고칠 때만 빈 전용 DB에서 실행한다
  - 중단된 테스트의 잔여물도 "남의 데이터"로 보고 거부한다 — 아래 잔여물 정리 후 다시 실행
- 타입: `npx tsc --noEmit` / 빌드: `npm run build`
- 개발 서버: `npm run dev` → http://localhost:3000 (로그인 후 /projects)
- Tauri: `npm run tauri:dev` (Rust 필요) / 빌드: `npm run tauri:build`
- DB 마이그레이션: supabase link 불가(CLI 로그인 없음) — 직결:
  `npx supabase db push --db-url "postgresql://postgres.oqdcvdmodnpxmosnuitz:<암호URL인코딩>@aws-1-ap-northeast-2.pooler.supabase.com:5432/postgres"`
  (암호는 루트 `데이터베이스 비밀번호(gitignore).txt`, 리전 aws-1-ap-northeast-2 서울. 다른 마이그레이션이 먼저 적용돼 있으면 `--include-all` 필요)
- 테스트 직결 SQL: `.env.test.local`의 TEST_DATABASE_URL / 앱 키: `.env.local` (+`ALLOWED_EMAIL_DOMAIN=unes.co.kr`)
- 테스트 중단 시 잔여물: `wbs-test+%` 패턴 사용자를 auth.users에서 직결 삭제 + 남은 테스트 과제(`created_by is null`) 삭제
- 집 PC 첫 세팅: git pull → npm install → `winget install Rustlang.Rustup` + VS BuildTools → **`.env.local`·`.env.test.local`은 gitignore라 저장소에 없다 — 회사 PC에서 복사해 올 것**
  - **`samples/`(실제 예산 엑셀)도 gitignore라 저장소에 없다.** 없으면 Phase 5.5 실측 검증이 건너뛰어진다 — 임포트를 건드릴 때는 회사 PC에서 복사해 올 것
  - `xlsx`(SheetJS)는 npm 레지스트리가 아니라 **공식 CDN 타르볼**에서 받는다(`package.json`에 URL). 레지스트리판은 0.18.5에서 멈춰 있고 취약점 권고가 붙어 있다. **사내망에서 `cdn.sheetjs.com`이 막히면 `npm install`이 실패한다** — 그 경우 사내 미러나 vendoring을 검토할 것
