# PROGRESS — 회사↔집 인계 문서

## Last updated
2026-08-05 (Phase 5.5 + 6 + 7 완료 — 집 PC 세션)

## Current goal
Phase 8 (To-Do + 설정 + 마감: To-Do 화면, 설정 3섹션, 인쇄 레이아웃, §12 비기능 검증) — SOT §7.13~7.15, §12

> ⚠️ **Phase 8은 마지막 Phase다.** 착수 전에 **사람이 실제 브라우저로 훑는 시간을 먼저 갖는 것을 권한다** — 아래 "수동 검증 > 대기"에 Phase 1·4·5·5.5·6·7치가 쌓여 있고, 그중엔 자동 테스트로 못 잡는 것들(드래그, 충돌 다이얼로그 입력 보존, R-4 배너, 마법사 5단계, 마크다운 XSS 실렌더)이 많다. evaluator PASS는 계속 받았지만 **사람이 화면을 본 건 Phase 0.5까지**다.

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

- **Phase 6 완료** (evaluator **PASS**, 테스트 898건) — 리스크 + 노트. SOT v3.4 → **v3.5**:
  - **리스크** (`actions/risks.ts`, `components/risks/`, `reorder_risks` RPC): 5×5 히트맵(셀 클릭 필터)·목록 9컬럼·행 확장(내용/대응/비상/WBS 링크)·해결·종료 기본 숨김 토글. 점수·등급·색상은 전부 `lib/risk.ts`(Phase 4, 67건)에서만 나온다 — 경계값 8·15가 다른 곳에 복제되지 않은 것을 evaluator가 grep으로 확인
    - 히트맵 셀이 **미해결/해결 id를 나눠 담아** "해결·종료 표시" 토글이 셀 개수와 목록 건수를 구조적으로 함께 움직인다(두 필터가 따로 놀 여지가 없다)
    - §6.5 `occurred`: 해결·종료는 등급 판정 대상이 아니라 `severity=null`("판정 제외"), 미해결 `occurred`는 점수와 무관하게 "주의"
  - **노트** (`actions/notes.ts`, `lib/notes.ts`, `components/notes/`): 2단 레이아웃·고정 상단→날짜 내림차순·필터 4종(유형/연차/태그/전문검색)·편집/분할/미리보기 토글·회의록 템플릿·참석자 다중 선택·Task/Milestone 연결 + **역참조**(WBS 상세 패널·마일스톤 펼친 행)·명시적 저장 + 3초 디바운스 자동 저장
    - **마크다운 렌더링에 외부 라이브러리를 쓰지 않는다.** 노트 본문은 사용자 입력이라 HTML 문자열을 만들어 주입하면 저장형 XSS다. `lib/notes.ts`가 제한된 부분집합을 **데이터 AST**로 파싱하고 뷰어가 **React 엘리먼트**로 옮긴다 — AST에 "원시 HTML" 노드가 없어 주입이 걸러지는 게 아니라 **표현 자체가 불가능**하다. `dangerouslySetInnerHTML` 사용 0건(evaluator grep 확인), 새 npm 의존성 0개. 안전하지 않은 링크(`javascript:`·`data:`·`vbscript:`·`//host`)는 조용히 버리지 않고 원문 그대로 표시. **이 규칙은 SOT §7.12와 CLAUDE.md에 못 박아 뒀다**
    - 자동 저장 × O-1: 저장 성공 시 baseline version을 갱신해 **자기 저장에 대한 가짜 STALE**을 막는다(Phase 1 후속 개선 ②에서 겪은 문제를 반복하지 않음). 삭제 중에는 자동 저장을 멈추고, `updateNote`는 upsert가 아니라 update 전용이라 **뒤늦은 자동 저장이 삭제된 노트를 되살리지 못한다** — 둘 다 통합 테스트로 고정
  - **과제 개요(§7.3) 자리표시 제거** — 고위험 리스크 5건·최근 노트 5건 카드를 실제 데이터로 채웠다. 정렬·등급은 각각 `getRiskMatrix`/`sortNotes`가 계산한 값을 그대로 쓴다(개요와 전용 화면이 다른 순서를 보이지 않게)
  - 탭 활성화: `TabNav.IMPLEMENTED_THROUGH = 6`
  - SOT 보강: **§9 `reorderRisks(projectId, orderedIds)` 정정**(과제 소속 reorder는 전부 컨테이너를 받는데 리스크만 빠져 있었다 — 없으면 RPC가 과제 경계를 검증할 수 없다), §7.12 마크다운 렌더링 방식 명문화, §10 갱신, **§9 조회 블록 드리프트 경고**(아래 참조)

- **Phase 7 완료** (evaluator **PASS**, 테스트 944건) — 간트 + 칸반. SOT v3.5 → **v3.6**:
  - **간트** (`lib/gantt.ts` 30건, `actions/gantt.ts`, `components/gantt/`): 좌측 연차>트리 패널, 일/주/월 스케일(1일 = 24/8/3px), 막대 내 진척률 채움, 부모 얇은 요약 막대(양끝 캡), 연차 배경 밴드 + 경계 세로선, 마일스톤 상단 마름모 레인(유형별 색), 오늘 세로선, 막대 드래그 이동·양끝 리사이즈
    - 좌표는 전부 `lib/gantt.ts` 순수 함수다. `날짜차이 × px`가 컴포넌트에 복제되지 않았다
    - **롤업된 부모 막대는 끌 수 없다**(P-14~P-16: 자식에서 계산된 값이라 저장할 곳이 없다). 커서·툴팁으로 알린다
    - 드래그 저장은 O-1. 실패 시 **원위치 + ErrorBanner**(조용히 되돌리지 않음), STALE이면 위치를 유지한 채 비교 배너
    - **잘라내거나 숨기지 않는다**: 연차 밴드가 겹치거나 기간이 없으면 `overlappingIds`/`unplottableIds`로 돌려 화면 하단에 사실을 적는다. 월 스케일에서 최소 폭(8px)이 적용된 막대는 점선 아웃라인 + "최소 폭으로 넓게 그린 막대 N건" 안내
  - **칸반 + 매트릭스** (`lib/board.ts` 16건, `actions/board.ts`, `components/board/`): 뷰 전환 토글, 연차 필터 공유, 4컬럼 칸반(컬럼 간 드래그 → status, 컬럼 내 → order), 리프 기본 + 전체 토글, 담당자 스윔레인, 좌측 등급 색 띠 / 5×5 매트릭스(가로 긴급도·세로 중요도), 셀 클릭 필터, 우측 점수 내림차순 목록
    - **§7.6의 "§7.11과 같은 컴포넌트를 공유한다"를 실제로 이행** — `components/ui/Matrix5x5.tsx`로 추출하고 리스크 히트맵이 그것을 쓰게 했다. 리스크 쪽 공개 API가 그대로라 `RiskScreen.tsx`는 한 줄도 안 고쳤고, 통합 테스트 16건 회귀 통과
    - **PR-4 준수**: 셀 드롭은 **중요도만** 저장한다. 긴급도는 마감일 기반이라 `urgencyMode='manual'`로 고정된 작업에서만 바뀌고, `auto`인 작업은 **조용히 무시하지 않고** 그 사실을 안내한다
    - **X-3 준수**: `reorderTasks`는 컨테이너 자식 전체를 요구하므로 서버가 컨테이너 목록을 함께 내려준다(화면 필터로 형제가 빠져 order가 깨지는 것 방지). 다른 상위 작업 사이로 끌면 계층 변경이라 저장하지 않고 "WBS 트리에서 옮기세요"로 거절
  - 탭 활성화: `TabNav.IMPLEMENTED_THROUGH = 7` — 10개 탭 중 **9개가 열렸다**(설정 화면만 Phase 8)
  - **SOT §7.5 결정 보류 명시**: "접힘 상태를 WBS 화면과 동기화"에 **저장 위치가 없다**(localStorage / URL 쿼리 / 사용자 설정 테이블). 셋 다 장단이 뚜렷해 사람이 정할 문제라 지어내지 않았다 — 결정 전까지 **화면별 로컬 상태**
  - 미구현 1건: 카드의 "담당자 아바타"는 Member에 사진 필드가 없어(§5.11) **이름 + `+N` 뱃지**로 치환

- **후속 정리 2건** (PROGRESS 대기 목록에서 처리):
  - `TechRecordForm.tsx` 측정일 기본값을 로컬 `new Date()` → **Asia/Seoul**(`todayISO`). 타임존이 다른 PC에서 하루 어긋난 측정일이 저장되던 문제
  - **테스트 중단 시 dev DB 잔여물 자동 청소** — `tests/global-setup.ts`(실행 1회). `wbs-test+%` 중 2시간 이상 경과분만. **삭제 순서가 핵심**: 사용자를 지우기 전에 소유 행을 먼저 지운다(auth.users를 먼저 지우면 `created_by`가 set null이 되어 그때부터 실데이터와 구분 불가). 3시간 전으로 백데이트한 가짜 잔여물을 심어 감지·삭제·로그를 실제로 확인

## In progress
없음

## Next steps
1. **사람이 브라우저로 훑기 (권장, Phase 8 착수 전)** — 아래 "수동 검증 > 대기"가 6개 Phase치다. 특히 자동 테스트로 못 잡는 것: 드래그(간트 막대·칸반 카드·매트릭스 셀), 충돌 다이얼로그 입력 보존, R-4 배너, 임포트 마법사 5단계, 마크다운 XSS 실렌더
2. **결정 필요**: 간트/WBS 트리 **접힘 상태 저장 위치** (localStorage / URL 쿼리 / 사용자 설정 테이블). SOT §7.5에 선택지와 장단을 적어 뒀다
3. `/phase-run 8` — To-Do + 설정(§7.14 3섹션: 팀 설정·사용자 관리·백업/복원 + **임포트 스냅샷 목록·복원**) + 인쇄 레이아웃 3종 + **§12 비기능 검증(5,000 노드 롤업 100ms)** + Tauri 번들
4. **SOT §9 조회 블록 이름 정리 (문서 부채, 블로킹 아님)**:
   - Phase 1~6에 걸쳐 조회 함수 이름이 §9 설계 목록과 갈렸다. `getProjectOverview`는 아예 구현되지 않았고(과제 개요가 6개 조회를 `Promise.all`), `getNotes(projectId, filter)`는 `getNotesData(projectId)`이며 필터는 화면 몫이다. `getMilestonesData`·`getTeamScreenData`·`getProjectsSummary`는 목록에 없다
   - 지금 개명하면 6개 Phase의 코드를 건드려야 해서 **SOT §9에 드리프트 경고를 달아 두고** 넘겼다. 한가할 때 §9를 실제 이름으로 맞출 것
3. **Phase 6 후속 (블로킹 아님)**:
   - 노트 편집이 WBS·마일스톤 화면에 **실시간으로 전파되지 않는다** — 그 화면들은 §8.5 구독표대로 `tasks`/`years`/`milestones`만 구독한다. 역참조는 다음 이동·`revalidatePath` 때 갱신된다. 즉시 전파가 필요하면 §8.5 구독표를 먼저 고쳐야 한다
   - 과제 개요의 고위험 리스크·최근 노트 카드도 같은 이유로 실시간이 아니다(§8.5 "화면당 최대 4테이블" 예산). 요약 카드라 현재는 충분하다고 판단
4. **Phase 5.5 후속 (블로킹 아님)**:
   - **`restore_import_snapshot`을 감싸는 서버 액션이 없다.** RPC와 리포지토리는 있고 통합 테스트도 리포지토리를 직접 부른다. §7.14 설정 화면(Phase 8)에서 액션을 만들 때 `tests/integration/import-actions.test.ts`의 복원 부분도 액션 경유로 바꿀 것
   - CSV는 SheetJS가 UTF-8로 가정한다 — **CP949 CSV는 깨진다.** 실측 서식이 전부 xlsx라 v1에서는 두었다
   - `orientation === 'column'`(전치 서식)은 명시적 거부 상태다. 실제로 그런 서식이 오면 `parseMatrix` 확장 필요
5. **연구비 후속 정리 (블로킹 아님)**:
   - `getBudgetMatrix`가 집계만 반환해 화면이 `listBudgetItemsByProject`로 원본 행(itemId·version·cash/inKind null 여부·executions)을 한 번 더 조회한다. `BudgetMatrixData`에 `items` 추가로 흡수 권장 (`app/projects/[id]/budget/page.tsx` 주석에 명시)
   - `listBudgetItemsByProject`의 **부모** 조회는 무페이징 — 연차 84개 초과 과제에서 같은 절단이 발생한다(현실 규모에선 도달 안 함)
6. Phase 1 후속 개선(블로킹 아님): ① 인라인 이름 편집 중 Enter 연타 시 in-flight 재입력이 제출값으로 되돌아감 ② 자기 저장에 대한 가짜 STALE 배너(`disabled={saving}` 가드) — **노트 에디터에서는 이미 해결했으니 그 방식을 옮기면 된다** ③ `bulkUpdateTasks` 부분 반영(트랜잭션 RPC화 검토)
7. 미뤄둔 것: HR API 연동(hr.unes.kr 직원 명부 — SOT 추가 후 별도 진행), 단일 과제 조회 액션(`getProject(id)`)
8. 남은 관찰 항목(블로킹 아님): `tests/integration/wbs-queries.test.ts`는 팀 공유 설정 `app_settings.progress_weight_basis`를 잠시 바꿨다 되돌린다. 데이터를 지우지 않아 기본 실행에 두었지만, **두 PC에서 `npm test`를 동시에 돌리면** 서로의 임시값을 원본으로 착각해 설정이 어긋날 수 있다. 테스트는 한 번에 한 PC에서만 돌린다

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
- **Phase 6 리스크**: ① 히트맵 셀 클릭 → 목록이 그 조합만 남고, 재클릭·필터 칩 ×로 해제 ② "해결·종료 항목 표시" 토글 시 **셀 개수와 목록 건수가 함께** 늘어남(어긋나면 안 됨) ③ 두 창 동시 편집 → ConflictDialog가 입력값을 보존한 채 항목별 비교(O-3) ④ 폼 열어 둔 채 다른 창에서 수정 시 입력이 안 날아감(R-4) ⑤ 상태를 `발생`으로 → "주의" 뱃지, `해결`로 → 등급 "판정 제외" 회색 + 기본 화면에서 사라짐 ⑥ 대시보드 "고위험 리스크"·"주의 필요" 숫자가 리스크 화면 요약과 일치 ⑦ 정렬 "수동 순서"에서 ↑↓ 후 새로고침해도 순서 유지 ⑧ 행 확장의 "WBS에서 보기"가 해당 연차 트리로 이동
- **Phase 6 노트**: ① 타자 후 3초 정지 → "저장됨 HH:MM:SS", 목록 제목·날짜·태그가 **커서 위치를 잃지 않고** 갱신 ② 두 세션 동일 노트 → 앰버 배너 + 입력 보존 + `최신 내용 사용`/`내 입력 유지` 양쪽 동작 ③ 본문에 `<script>alert(1)</script>`, `<img src=x onerror=alert(1)>`, `[클릭](javascript:alert(1))`을 붙여넣어 **아무것도 실행되지 않고 글자 그대로 보이는지**(AST 단위로는 테스트됐지만 실제 브라우저에서 한 번 볼 것) ④ 참석자 체크박스 → `- 참석자:` 줄이 제자리에서 갱신되고 **중복 생성되지 않음** ⑤ WBS 상세 패널·마일스톤 펼친 행의 관련 노트 링크가 해당 노트를 선택한 상태로 이동
- **Phase 7 간트**: ① 좌측 패널 행과 우측 막대의 세로 정렬(마일스톤이 여러 줄로 쌓일 때 특히) ② 월 스케일(1일=3px)에서 드래그 체감 — 조금만 움직여도 여러 날이 간다. 실사용에서 견딜 만한지 ③ 두 창에서 같은 막대를 끌어 STALE → "내 위치로 다시 저장"이 최신 version으로 저장되는지 ④ 자식 막대를 끈 뒤 새로고침하면 **부모 요약 막대가 따라 늘어나는지**(P-14~P-16) ⑤ 일 스케일 3년(≈26,000px) 가로 스크롤 성능
- **Phase 7 칸반·매트릭스**: ① 카드를 다른 컬럼으로 → 상태 변경, `done`으로 옮기면 새로고침 후 진척률 100%(P-1) ② 같은 상위 작업 아래 카드끼리 순서 유지 / **다른 상위 작업 사이로 끌면 거절 배너** ③ 담당자 스윔레인 순서와 미지정 레인 위치 ④ 목록 행을 셀로 드래그 → 중요도 변경, 📌 꺼진 작업은 긴급도 안내, 📌 켠 뒤엔 긴급도도 변경 ⑤ 셀 클릭 필터·완료 표시 토글에서 **셀 숫자와 목록 건수 일치** ⑥ **리스크 화면 히트맵이 이전과 똑같이 보이는지**(Matrix5x5 추출 후 — 자동 회귀는 액션 레벨까지만 검증했다)
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
