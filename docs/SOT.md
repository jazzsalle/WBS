# R&D 과제 관리 도구 — SOT (Source of Truth)

| 항목 | 내용 |
|---|---|
| 문서 버전 | **v4.1** |
| 최종 수정 | 2026-08-09 |
| 상태 | 확정 (Phase 0 착수 가능) |
| 목적 | 이 문서는 구현의 유일한 기준점이다. 코드와 문서가 다르면 **문서가 옳다**. |

### v4.0 → v4.1 변경 요약 — Phase 10(산출근거 시트 임포트) 착수 전 스펙 신설

Phase 9가 산출근거를 **앱에서 손으로 쌓는** 길을 열었다. Phase 10은 그것을 **엑셀에서 통째로 들여오는** 길을 연다. 연차 하나에 인건비만 19행이라 손 입력만으로는 실사용이 불가능하다. 실측 워크북 2종의 연차별 산출근거 시트를 구조 분석해 아래를 확정했다.

- **§6.11 신설 — 산출근거 시트 파싱 (D-1~D-20)**: 섹션 → 비목 → 세목 → 컬럼 헤더 → 데이터 → 소계의 계층을 읽는다. 실측 2종의 구조가 **거의 동일**했고 컬럼 형태는 7가지로 수렴한다. `lib/import/`의 정규화(I-1)·금액 파싱(I-8~I-12)·병합 확장(S-11)을 그대로 재사용하며 **새 파서를 만들지 않는다.**
- **D-8 — 파일의 `합계` 열이 진실이다**: 우리 산식(PL-1/PL-3)으로 계산한 값과 다르면 **차액을 `adjustment`에 넣는다.** 부록 B.7에서 확립한 `조정액 = 최종 − 산식결과` 정의를 그대로 쓴다 — 그래야 임포트 후 화면 금액이 원본 서식과 **원 단위까지** 일치한다.
- **D-15 — 기존 산출근거가 있는 셀은 기본 건너뜀** (사용자 결정). 셀별로 `[기존 삭제 후 교체]`를 명시적으로 고를 수 있다. §6.8 대원칙("자동 인식은 제안이지 확정이 아니다")·S-14와 같은 태도다.
- **D-11~D-14 — 성명 → Member 매칭**: 미매칭 성명은 마법사에서 **새 인력으로 만들 수 있다**(사용자 결정). 연봉·직위는 파일에서 가져온다. 동명이인은 자동 매칭하지 않고, **기존 Member의 연봉을 임포트가 고치지 않는다**(PL-10b가 확인을 요구하는 값이다).
- **D-3 — 세목은 번호와 라벨을 둘 다 본다**: 번호만 믿으면 서식이 순서를 바꿨을 때 조용히 틀리고, 라벨만 믿으면 실측 변형(`⑪ 그 밖의 비용` vs `⑪ 기타`, `⑦ 연구실 운영비(삭감)`)에서 놓친다.
- **D-10 — 통화 기호 감지**: 실측 행안부에 `합계($)` 열이 있다. 원화가 아닌 기호가 보이면 경고하고 사용자 확인을 요구한다 — I-10(1000배 오류)과 같은 계열의 치명적 오류다.
- **§7.9.3 신설 — 산출근거 임포트 마법사**: §7.9.1(총괄표)과 **별개 흐름**이다. 대상 계층이 다르고(셀 총액 vs 행 내역) 성명 매핑 단계가 추가된다.
- **§5.12.1 `ImportKind`에 `'budget_detail'` 추가**, **부록 C.2 세목 별칭 사전 신설**, **부록 B.8 신설**(실측 기준값).
- **§13 16번 해소**, §2.2에서 "산출근거 시트 엑셀 임포트" 제외 항목 제거.

### v3.7 → v4.0 변경 요약 — Phase 9(예산 제안 모드) 착수 전 스펙 신설

v1(Phase 0~8)은 예산을 **수행** 관점 한쪽으로만 다뤘다: 확정된 계획액을 기록하고, 집행을 누적하고, 집행률을 본다. 엑셀은 **들여오는** 방향뿐이었다(§6.8). Phase 9는 그 반대 방향 — **예산을 만들어내는(제안)** 쪽을 연다. 실측 워크북 2종(`samples/`)의 **연차별 산출근거 시트**를 재대조해 아래를 확정했다. 마이너 버전이 아니라 v4.0인 이유는 **`budget_items.plannedAmount`의 소유권이 바뀌기 때문**이다(사람 입력 → 산출근거 합계).

- **§5.17 BudgetDetail 신설 — 산출근거(내역) 계층**: `budget_items`는 `unique(year_id, category)`라 연차×비목당 **총액 한 줄**만 담는다. 제안은 그 총액이 *어떻게 나왔는지*가 본체이므로 계층이 하나 더 필요하다. 비목 → **세목** → 산출 행. 산출 행의 금액은 `단가 × 인자들 + 조정액`이라는 **한 가지 산식**으로 실측 서식 전부를 표현한다(§6.10.1).
- **§6.10 신설 — 산출근거 계산·집계·검증 (PL-1~PL-16)**: 인건비 산식(`연봉 × 참여율/100 × 개월/12`)의 **중간 반올림을 금지**한다. 실측 검증에서 월액(`연봉/12`)을 먼저 반올림하면 표시값과 어긋나는 행이 나온다(부록 B.7). 이미 §6.1 P-8·§6.2 D-5·§6.4 B-1에서 같은 함정을 겪었다.
- **§5.12 개정 — 계획액의 소유권**: `(연차, 비목)`에 산출근거가 1건이라도 있으면 그 셀의 `plannedAmount`·`cashAmount`·`inKindAmount`는 **내역 합계로 확정되고 직접 편집이 잠긴다**(PL-9). 저장 값과 합계의 일치는 **같은 트랜잭션 안에서 보장**한다(PL-10) — CLAUDE.md의 "파생 값을 저장하지 않는다"에서 의도적으로 벗어난 유일한 지점이며, 그 이유와 대안 기각 근거를 PL-10에 적었다.
- **§6.8 개정 — 임포트는 잠긴 셀을 덮어쓰지 않는다 (S-14)**: 총괄표 임포트가 산출근거가 있는 셀을 덮으면 **근거와 총액이 소리 없이 어긋난다.** 미리보기에 `잠김` 상태로 남기고 반영에서 제외한다.
- **§5.11 Member 확장 — `annualSalary`·`hireType`**: 인건비 산출근거가 인력 명부를 참조한다. **§13 미결정 1번(참여연구원 참여율)이 여기서 해소된다** — 참여율은 Member의 속성이 아니라 **(연차 × 인력)의 속성**이므로 `BudgetDetail`이 갖는다. 한 사람이 같은 연차에서 참여율을 바꿔 두 구간으로 나뉘는 실측 사례(행안부 한봄희: 4개월 10% + 8개월 53%)가 Member 단일 필드로는 표현되지 않는다.
- **§5.3 Project 확장 — `indirectRateLimit`·`allowanceRateLimit`**: 지침 한도는 **부처·기관 유형별 고시율**이라 이 문서가 지어낼 수 없다. 혁신법 공통인 연구수당 20%만 기본값으로 두고 간접비율은 **과제별 사용자 입력**으로 받는다(PL-14). 부처별 고시율 표를 코드에 박지 않는 이유는 PL-16에 적었다.
- **§7.9 개정 — 연구비 화면에 [제안 | 수행] 모드 토글**: 같은 매트릭스를 두 관점으로 본다. 셀 클릭 시 제안 모드는 산출근거 패널, 수행 모드는 기존 집행 내역 패널이 열린다. 탭을 늘리지 않는 이유는 §7.9의 설계 원칙에 적었다.
- **부록 A.5 신설 — 세목 프리셋**: 실측 2종에서 세목 구성이 **거의 동일**했다(①~⑪ 연구활동비 세목까지 일치). 혁신법 표준으로 고정하고 부처 차이는 §6.8 부록 C와 같은 방식으로 흡수한다.
- **부록 B.7 신설 — 산출근거 계산 검증 예시**: 실측 산자부 1차년도 인건비 18행의 실제 값을 그대로 테스트 기준으로 옮긴다.

**착수 직전 추가 확정 3건** (계획 분해 중 SOT 공백이 드러나 사람이 판단했다):

- **PL-10a — 금액 산식은 `lib/budget-plan.ts` 한 곳에만 둔다**: `BudgetDetail.amount`를 저장하고 RPC는 **더하기만** 한다. PL/pgSQL에 산식을 다시 구현하면 JS `Math.round`와 SQL `round()`가 **음수 .5·부동소수점 경계에서 갈려** 1원씩 어긋난다. `amount` 저장(PL-D7)이 산식 이중화보다 훨씬 작은 위험이다.
- **PL-10b — 연봉 변경은 파급되되 조용하지 않다**: `Member.annualSalary`가 바뀌면 그 인력의 인건비 행과 비목 총액을 같은 트랜잭션에서 재계산한다. 단 저장 전에 **영향 건수와 전후 금액을 보여주고 확인을 받는다**(§7.10). 이 규칙이 없으면 인사 정보 수정이 협의 끝난 예산을 말없이 흔든다.
- **H-9a — 인건비 산출근거가 걸린 Member는 삭제 차단**: H-9의 기존 참조 8곳은 담당·배정 같은 메타데이터라 지워도 숫자가 변하지 않지만, 산출근거를 함께 지우면 **사람을 지운 조작만으로 비목 총액이 줄어든다.** `on delete restrict` + 참조 건수 안내로 두 단계를 요구한다(§6.6 H-8과 같은 판단). `active=false`는 그대로 허용한다.
- **§8.8 — `schema_version` 1 → 2 + 올리는 기준 명문화**: `budget_details`는 Phase 0 이후 **처음 추가되는 테이블**이라 백업 파일 형식(`BACKUP_TABLES`)이 바뀐다. 버전을 올리지 않으면 K-5의 버전 게이트가 "호환"이라 판정한 구 백업을 테이블 목록 검사가 거부해 **사용자가 엉뚱한 메시지를 본다.** "백업 파일 형식이 바뀌는가"를 기준으로 삼는다고 §8.8에 적었다 — 컬럼 추가나 RPC 변경만으로는 올리지 않는다.
- **§2.2·§13 갱신**: "참여연구원 참여율(%) 관리" 제외 항목을 **해소**로 옮긴다. 제출 서식 **엑셀 내보내기는 Phase 9 범위 밖**으로 명시(사용자 결정) — 서식 재현(병합·수식) 비용이 커서 별도 Phase로 남긴다.

### v3.6 → v3.7 변경 요약 — Phase 8(To-Do + 설정 + 마감) 착수 전 규칙 공백 메우기
Phase 8 계획 중 **§7.13이 두 줄뿐이라 구현이 임의로 정해야 하는 지점 4곳**이 드러났다. 사람이 판단해 아래로 확정했다.
- **§7.13 전면 보강 — T-D1~T-D9 신설**: `오늘` 필터의 정의(`done=false AND dueDate ≤ today`, **지난 마감 포함**), overdue/dueSoon 판정, 정렬 3종의 tie-break와 "마감일 없는 항목은 뒤로", 완료 항목 표시, 드래그 활성 조건. 정의 없이 구현하면 대시보드 "오늘의 To-Do"와 `/todos`의 건수가 **조용히 어긋난다**.
- **T-D3 — 정의를 한 곳에 둔다**: 판정·정렬을 `lib/todos.ts` 순수 함수로 두고 대시보드가 그것을 쓴다. 대시보드에 이미 있는 정의(`lib/dashboard.ts`)를 그쪽으로 옮기고 재사용한다.
- **T-D6 — 아카이브 과제 To-Do는 `/todos`에서 감추지 않는다**: 대시보드는 집계 화면이라 아카이브를 제외하지만 `/todos`는 To-Do의 유일한 접근 경로다. 여기서도 감추면 되살릴 방법이 사라진다. 두 화면의 차이는 의도된 것임을 명시.
- **부록 A.3에 Todo 우선순위 색 3종 추가**: Task의 우선순위 **점수(1~25)** 색과 다른 축이다(To-Do는 점수를 계산하지 않는다). 토큰이 없어 구현이 임의로 고를 수 있었다.
- **§7.5 접힘 상태 동기화 — 보류를 결정으로 마감**: 저장 위치 3안(localStorage / URL 쿼리 / 설정 테이블)을 놓고 **v1에서는 하지 않기로 확정**. 현행(화면별 로컬 상태) 유지, v2 재검토.
- **§12에 검증 방법 표 추가**: 목표치만 있고 "어떻게 확인하나"가 없었다. 계산 성능은 Vitest로 5,000 작업 합성 측정, 인쇄·반응형·접근성은 사람이 확인 — **자동 검증을 흉내 내지 않는다**고 못 박았다.
- **§10 갱신**: `lib/todos.ts` 신설, `components/todos/`·`components/settings/` 실제 파일 목록(`MyProfileForm`, `ImportSnapshotPanel` 추가). **§11 필수 1 순수 함수 목록에 `lib/todos.ts` 편입**.
- **§7.13 To-Do 소유권 = 팀 공유로 명문화**: "개인 할 일 목록"이라는 표현과 실제 구현(RLS 전원 접근 + 조회에 `created_by` 필터 없음)이 어긋나 있었다. 문서를 실제에 맞추고 **"개인"은 *과제 계층에 안 매인다*는 뜻**임을 밝혔다. 소유자 분리가 필요해지면 조회 레벨에서 하고 **RLS는 건드리지 않는다** — 좁히면 §8.7 K-7 전체 대체 복원이 깨진다.
- **T-D10 신설**: 필터가 걸린 채 드래그하면 **숨겨진 항목까지 포함한 전체 순서**를 보낸다. 보이는 것만 보내면 필터를 풀 때 순서가 섞이고, RPC가 "배열 길이 = 갱신 행 수" 검사를 못 해 존재하지 않는 id를 조용히 넘기게 된다. T-D9에 **기본 정렬 = `수동`** 추가.
- **§14.1 배포 산출물을 MSI → NSIS로 정정**: Phase 8에서 처음으로 실제 번들을 만들어 보고 나서 드러난 모순이다. §14.1은 배포 형태를 `.msi`라 적었는데, Tauri v2는 MSI에 `installMode`를 지원하지 않아 WiX 산출물이 `InstallScope="perMachine"`이 되고 **관리자 권한을 요구한다** — §12의 "관리자 권한 없이 사용자 폴더에 설치"와 정면으로 어긋난다. NSIS만 `currentUser` + `$LOCALAPPDATA`로 §12를 만족하므로 **배포 산출물은 setup.exe 하나로 못박았다.** 빌드는 여전히 둘 다 내지만 MSI는 공유 폴더에 올리지 않는다.
- **§12에 인쇄 레이아웃 규칙 P-R1~P-R5 신설**: "A4 인쇄 레이아웃 제공" 한 줄로는 구현이 용지 방향·머리말·흑백 대비를 임의로 정해야 했다. 방향은 **표마다 다르게**(예산 매트릭스·리스크 대장 가로, 기술목표표 세로), 머리말에 과제명·출력일, 색으로만 구분되는 정보는 흑백에서도 읽히게.

### v3.5 → v3.6 변경 요약 — Phase 7(간트 + 칸반) 구현 반영
- **§7.5 접힘 상태 동기화 보류 명시**: "접힘 상태를 WBS 화면과 동기화"에 **저장 위치가 없어**(localStorage / URL 쿼리 / 사용자 설정 테이블) 지어내지 않고 보류한다. 셋 다 장단이 뚜렷해 사람이 정할 문제다. 결정 전까지 **화면별 로컬 상태**.
- **§7.6에 "전체 연차 보기" 기록**: WBS·간트와 같은 UX. 전체 보기에서도 PR-9·X-3은 그대로 적용된다.
- **§10 갱신**: `lib/gantt.ts`·`lib/board.ts` 신설, `components/ui/Matrix5x5.tsx`(§7.6·§7.11 공유 히트맵), `components/gantt/`·`components/board/` 실제 파일 목록.

### v3.4 → v3.5 변경 요약 — Phase 6(리스크 + 노트) 구현 반영
- **§9 `reorderRisks` 시그니처 정정**: `reorderRisks(orderedIds)` → **`reorderRisks(projectId, orderedIds)`**. 과제 소속 reorder는 전부 컨테이너를 받는데 리스크만 빠져 있었다 — 컨테이너가 없으면 RPC가 "이 id들이 전부 이 과제 것인가"를 검증할 수 없다. (전역인 `reorderProjects`/`reorderTodos`만 정당하게 생략)
- **§7.12 마크다운 렌더링 방식 명문화**: 외부 라이브러리를 쓰지 않고 `lib/notes.ts`가 **데이터 AST**로 파싱, 뷰어가 **React 엘리먼트**로 옮긴다. AST에 원시 HTML 노드가 없어 저장형 XSS가 **표현 자체로 불가능**하다. 안전하지 않은 링크는 조용히 버리지 않고 원문 그대로 표시.
- **§10 디렉터리 구조 갱신**: `lib/notes.ts` 신설, `components/risks/`·`components/notes/` 실제 파일 목록 반영.
- **§9 조회 블록에 드리프트 경고 추가**: Phase 1~6에 걸쳐 조회 함수 이름이 설계 목록과 갈렸다(`getProjectOverview` 미구현, `getNotes`→`getNotesData`, 목록에 없는 `getMilestonesData`·`getTeamScreenData`·`getProjectsSummary`). 지금 전면 개명하면 6개 Phase의 코드를 건드려야 하므로, **사실을 문서에 드러내고** 다음 정리 항목으로 넘긴다 — 문서가 조용히 틀린 채로 남는 것이 가장 나쁘다.

### v3.3 → v3.4 변경 요약 — Phase 5.5 착수 전 실측 서식 재대조(산자부·행안부 `유엔이_총괄표`) 반영
- **S-10 신설** (§6.8.2): 정규화 후 빈 문자열이 되는 라벨 행의 분기. 축 라벨이 있으면 직전 비목을 승계(현금/현물 쌍), 없으면 메모 행으로 건너뛴다. 행안부 서식의 `연구재료비` / `(G)` 2행 분절에서 **현물 금액이 유실되던 공백**을 메운다.
- **S-11 신설** (§6.8.2): S-2 carry-forward **전에** 병합 범위를 먼저 확장한다. 가로 병합 메모 행(`C16:E16`)이 있으면 확장하지 않은 오른쪽 라벨 열이 위 행의 축 라벨(`현물`)을 잘못 승계한다.
- **S-12 신설** (§6.8.2): 라벨 판정은 라벨 열을 **우→좌로 훑어 첫 판정을 채택**한다(S-3의 "가장 구체적인 라벨"을 알고리즘으로 명문화). 축 라벨은 별도로 수집하고, 라벨이 하나도 없는 행은 `건너뜀(라벨 없음)`으로 미리보기에 남긴다(조용히 버리지 않는다).
- **`CASH_INKIND_AXIS` 신설** (부록 C): 축 라벨 → `cash`/`inKind`/`unassigned` 매핑을 상수로 명시. `일반`·`통합관리`(학생인건비 세부 축)가 `plannedAmount`로만 합산된다는 규칙이 주석이 아니라 코드에서 강제된다.
- **S-2' 신설** (§6.8.2): carry-forward는 **판정에 성공한 라벨만** 승계한다. 세로쓰기 조각(`직`/`접`/`비`)이 아래 행으로 번져 미매핑을 대량 생산하던 공백을 메운다.
- **S-13 신설** (§6.8.2, §6.8.1 ②): 시트 추천을 비목 매칭 **행 수 → 행 비율**로 교체. 실측 워크북에는 연차별 산출근거 시트(240~250행)가 함께 들어 있어 행 수로 매기면 **두 파일 모두 총괄표가 아닌 시트를 추천**한다.
- **I-1 정규화 순서 확정** (§6.8.3): 각주 마커 `숫자)` 제거를 **괄호 제거보다 먼저**. 순서가 뒤집히면 `총 인건비1) (E=…)`이 `총인건비1`이 되어 집계 행이 비목으로 잘못 반영된다. 중첩 괄호·전각 괄호 처리 명시.
- **§7.9.1 Step 5 보강**: `신규`/`덮어씀`의 판정 기준은 "행의 존재"가 아니라 **"값의 존재"**(연차 생성 시 12비목이 0으로 자동 생성되므로 행 존재로 판정하면 전부 `덮어씀`이 된다).
- **구현 중 드러난 계약 공백 4건 명문화**: ① `ImportDraft.yearMapping`의 키는 **엑셀 열 문자**(헤더 텍스트가 아니다) ② `commitImport`의 `profileId`는 draft가 아니라 **별도 인자**(파싱 결정론에 속하지 않는다) ③ `orientation === 'column'`은 v1에서 **명시적 거부**(조용한 오반영 방지) ④ `ImportProfile`에 데이터 끝 행을 저장하지 않는 이유.
- **부록 B.5 표 정정**: 라벨 토큰이 4개인데 헤더가 3열(B·C·D)로 적혀 있어 열 문자가 데이터와 어긋났다. 라벨 B·C·D·E / 연차 F·G / 합계 H로 바로잡았다(행별 판정·금액은 원문 그대로). **§10 디렉터리 구조**의 `lib/import/` 파일 목록도 실제 구현에 맞춰 갱신.
- **I-17 보강** (§6.8.5): 20개 창은 **과제별**이고, **복원은 새 스냅샷을 만들지 않으며 행을 삭제하지도 않는다**(집행 내역 cascade 유실 방지). 구현 중 판단이 필요했던 지점을 문서에 고정.
- 부록 B.6 추가: 실측 서식 2종의 1차년도 기대 파싱 결과(직접비 소계·총액 교차검증 포함).

> 위 규칙들은 실측 샘플 2종(`samples/`의 `유엔이_총괄표`)을 프로토타입으로 실제 파싱해 검증했다. 최종 상태에서 **두 파일 모두 미매핑 0건**이고, 파싱 결과의 직접비 합·총액이 원본의 `직접비 소계`·`연구개발비 총액` 행과 **원 단위까지 일치**한다.

### v3.2 → v3.3 변경 요약 — 설계 최종 리뷰(정합성·구현 관점 2중 검토) 반영
- **계산 예시 정정**: 부록 B.2 가중 달성률 57.4→**57.3%**(중간 반올림 위반), B.0 점수 4 등급 낮음→**보통**, §6.2 공식 `min()` 잔재 제거, §6.3 의사코드에 T-1(클램프)·T-2(lower_better+baseline null→N/A) 반영.
- **임포트 규칙 공백 보강**: 현금/현물을 스킵 목록에서 분리(`CASH_INKIND_LABELS`), S-2 carry-forward 리셋 조건, S-8(동일 비목 다중 행 합산 + 파일에 없는 비목 유지), Step 5 `건너뜀` 상태, `ImportDraft` 타입(연차 매핑·행 제외·fileHash), ImportProfile에 매트릭스 구조 필드, I-17 스냅샷을 DB 테이블(`import_snapshots`)로.
- **스키마 확정 규칙**: 인증 부트스트랩(security definer 트리거+advisory lock, `approve_user` RPC), 낙관적 잠금을 `updated_at` 비교 → **`version bigint`** 비교로 교체, 전 테이블 `created_by/updated_by`, FK 삭제 정책표(실적·회의록은 set null), `unique(year_id, category)`, Member 참조 조인 테이블 통일, DB 컬럼 `sort_order`, NOT NULL·enum 규칙, app_settings 단일행 패턴, schemaVersion=마이그레이션 일련번호(최초 1), Realtime publication·구독표, 백업 JSON 스키마, 트리 시맨틱(깊이·moveTask·moveTaskToYear·Year.order), 날짜 롤업 §6.1.1, 진척률 엣지 규칙.
- **화면 보강**: §7.0 인증·온보딩, §7.14 설정, §7.15 과제 목록 신설.
- 규칙 ID 정리: §14.3 P-x → **RLS-x**. 부록 A.2에 `other` 라벨 추가. 기타 참조·수치 정정.

### v3.1 → v3.2 변경 요약 — 실제 예산 샘플(산자부·행안부) 분석 반영
- **비목별 보조 축을 정부/기관부담 → 현금/현물로 교체.** `BudgetItem.govAmount/ownAmount` → `cashAmount/inKindAmount` (§5.12). 실제 서식이 비목별 금액을 현금/현물 행 쌍으로 관리하며, 정부/민간 축은 비목 수준에 존재하지 않는다. 과제 수준의 `Project.govBudget/ownBudget`(협약정보)은 유지.
- **집행내역(execution) 엑셀 임포트 제외.** 임포트는 `budget_plan` 단일 종류 (§6.8, §5.12.1). 수동 집행 입력과 집행률 계산(§6.4)은 유지. `BudgetExecution.sourceHash/importBatchId` 필드 삭제, 구 §6.8.5(중복 방지) 삭제 — 안전 규칙이 §6.8.5로 이동. 집행내역 임포트는 v2 후보로 이동 (§13).
- **구조 감지·파싱 고도화** (§6.8): 병합 셀 carry-forward, 다중 라벨 열(비목|세목|현금·현물) 계층 규칙, 연차 열 매핑(`N차년도`·단계 그룹·합계 열 제외), 에러 셀(`#REF!` 등) 처리, 정규화 확장(가운뎃점 변형·내부 공백·괄호 코드·각주 제거).
- **부처별 별칭 템플릿 도입** (§6.8.3, 부록 C): 비목 12종은 혁신법 표준으로 고정하고, 부처별 표기 차이는 `MINISTRY_ALIAS_PRESETS`로 흡수. `ImportProfile.ministry` 필드 추가 (§5.12.1). 새 부처는 별칭만 추가하면 되며 스키마 변경이 없다.
- 부록 B.5 예산계획 임포트 검증 예시 추가 (익명화 수치).

### v3.0 → v3.1 변경 요약
- **작업 우선순위 관리 추가** (§6.9): 중요도(수동) × 긴급도(마감일 자동) = 우선순위 점수 1~25
- `Task`에 `importance`, `urgencyMode`, `urgencyManual` 추가
- 우선순위 매트릭스 뷰 (칸반 화면 내 전환), 대시보드 "오늘 집중할 작업"
- WBS 트리에 우선순위 컬럼

### v2.2 → v3.0 변경 요약
- **저장소를 파일 DB → Supabase(PostgreSQL)로 전환.** §8 전면 재작성
- **동시 편집 지원.** 편집권(lock) 방식 폐기 → 낙관적 잠금 + Realtime (§8.4, §8.5)
- 임베드 배열·ID 배열을 별도 테이블/조인 테이블로 정규화 (§5.1)
- **인증 추가**: Supabase Auth + 구글 회사계정 OAuth + RLS (§14.2, §14.3)
- **§8.7 자체 백업 필수** — 무료 플랜에는 백업이 없다
- §14 재작성: 배포·인증·NAS 이전 전략. `StorageAdapter`는 리포지토리 레이어로 대체
- 오프라인 편집 미지원 명시

### v2.1 → v2.2 변경 요약 (이력)
- 데스크톱 앱(Tauri) 배포 형태 확정 — v3.0에서도 유지
- 편집권(lock) 방식 도입 — **v3.0에서 폐기됨**

### v2.0 → v2.1 변경 요약
- **엑셀 예산 임포트 추가** (§6.8, §7.9.1): 예산계획·집행내역 xlsx 업로드 → 자동 매핑 → 미리보기 확인 → 반영
- `ImportProfile` 엔티티 신설 (서식별 매핑 규칙 재사용)
- **비목 체계 보정**: 위탁연구개발비, 국제공동연구개발비, 연구개발부담비 추가 (국가연구개발혁신법 기준)
- `BudgetExecution`에 임포트 추적 필드 추가 (`sourceHash`, `importBatchId`)

### v1.0 → v2.0 변경 요약
- 계층 구조 변경: `과제 > 단계 > 연차 > WBS 트리` (기존: `프로젝트 > WBS 트리`)
- 신규 엔티티 8종: `Stage`, `Year`, `Organization`, `Member`, `Deliverable`, `TechTarget`, `Risk`, `Note`, `BudgetItem`
- `Milestone`을 Task 플래그에서 **독립 엔티티**로 승격 (평가·보고서 제출 등 과제 이벤트)
- 진척률 롤업 계층 확장, 목표 달성률 계산 로직 신설
- 비목별 예산 vs 집행 관리 추가
- 화면 6개 추가 (개요, 목표, 예산, 리스크, 노트, 인력)

---

## 1. 개요

### 1.1 배경
동시에 수행 중인 국가 R&D 과제가 여러 개다. 각 과제의 단계·연차별 작업 진척, 정량적 성과목표(논문·특허·SW등록), 정량적 기술목표(성능지표) 달성 현황, 평가·보고서 마감, 연구비 집행, 컨소시엄 인력, 회의록을 한 곳에서 관리한다.

### 1.2 핵심 가치
1. **과제 전체를 한 화면에** — 여러 과제의 진척·목표달성·마감을 대시보드에서 훑는다.
2. **연차 단위 계획과 실적** — 국가R&D의 연차별 실적계획서 구조에 맞춘다.
3. **목표는 숫자로 추적** — 성과목표 건수, 기술목표 수치를 목표 대비 실적으로 관리한다.
4. **평가·제출 마감을 놓치지 않는다** — 연차평가, 단계평가, 보고서 제출이 먼저 보인다.
5. **회의록이 흩어지지 않는다** — 마크다운 노트를 과제·작업에 붙여둔다.

### 1.3 사용자
소규모 팀(2~6명). 각자 자기 PC에 데스크톱 앱을 설치하고, **하나의 Supabase 데이터베이스를 공유**한다.

- 회사 구글 계정으로 로그인한다 (§14.2). 승인된 사용자는 모두 동일 권한이며 역할 구분은 없다.
- **동시 편집을 지원한다.** 남의 변경은 Realtime으로 반영되고, 같은 항목을 동시에 고치면 낙관적 잠금이 잡아낸다 (§8.4).
- **오프라인 편집은 지원하지 않는다.** 네트워크가 끊기면 읽기만 가능하다.
- 컨소시엄 참여자 데이터(Organization, Member)는 관리 대상이며, 로그인 계정(AppUser)과는 별개다. 선택적으로 연결할 수 있다.

---

## 2. 범위 (Scope)

### 2.1 In Scope
| 영역 | 내용 |
|---|---|
| 과제 | 과제 CRUD, 협약정보(과제번호·부처·전문기관·사업명·협약기간), 아카이브 |
| 계층 | 단계(Stage) → 연차(Year) → 무제한 깊이 WBS 트리 |
| 작업 | Task CRUD, 트리 조작, 진척률 수동/자동 롤업, 담당자 배정 |
| 우선순위 | 중요도 × 긴급도 매트릭스, 우선순위 점수 정렬 |
| 성과목표 | 논문·특허·SW등록·기술이전·사업화·표준화·인력양성 목표 대비 실적 |
| 기술목표 | 성능지표별 목표치·실적치·가중치·측정방법, 가중 달성률 |
| 마일스톤 | 연차평가/단계평가/최종평가/보고서제출/진도점검/협약변경 등 |
| 인력 | 컨소시엄 기관(주관/공동/위탁) + 참여인력(PM/PL/연구원) |
| 예산 | 연차별 × 비목별 예산 vs 집행, 집행률 |
| 예산 임포트 | 예산계획 엑셀(xlsx/xlsm/xls/csv) 업로드 → 비목 자동 매핑 → 미리보기 확인 → 반영. 매핑 프로파일(부처 템플릿) 저장 |
| 리스크 | 리스크 관리대장 (발생가능성 × 영향도 매트릭스) |
| 노트 | 마크다운 회의록/기술메모/이슈 |
| 시각화 | 대시보드, 간트, 칸반 |
| To-Do | 과제 연결 선택적인 가벼운 할 일 |
| 저장소 | Supabase (PostgreSQL) |
| 인증 | 구글 회사계정 로그인, 사용자 승인 흐름 |

### 2.2 Out of Scope (v1 제외)
| 제외 항목 | 사유 |
|---|---|
| **집행내역 엑셀 임포트** | 사용자 선택으로 제외. 정산·집행 리스트는 관리하지 않으며 집행은 앱에서 수동 입력 (v2 후보) |
| 역할 기반 권한 (RBAC) | 승인된 사용자는 전원 동일 권한. 소규모 팀이라 불필요 |
| **오프라인 편집** | 로컬 캐시·동기화 큐는 복잡도 대비 효용 낮음 |
| 웹 배포 | 기술적으로 가능하나 v1은 데스크톱 앱만 (§14.1) |
| 변경 이력 / 감사 로그 | v2 후보 |
| ~~참여연구원 참여율(%) 관리~~ | **Phase 9에서 해소.** `BudgetDetail`의 인건비 산출근거가 (연차 × 인력)별 참여율·참여기간을 갖는다 (§5.11 주석, §5.17) |
| **증빙 파일 첨부 / 업로드** | 사용자 선택으로 제외. 증빙은 외부 링크(URL)로만 (v2 후보) |
| 기관별 연구비 분배 | 비목별까지만 관리. Phase 9에서도 유지 — 실측 `검토_*` 시트가 이 구조지만 범위를 넓히지 않는다 |
| **제출 서식 엑셀 내보내기** | Phase 9 범위 밖 (사용자 결정). 병합·수식 재현 비용이 커서 별도 Phase |
| ~~산출근거 시트 엑셀 임포트~~ | **Phase 10에서 해소** (§6.11·§7.9.3). 총괄표 임포트(§6.8)와 별개 흐름이다 |
| 작업 간 선후행 의존관계(FS/SS) | 간트 복잡도 급증 (v2) |
| 전자결재 / 외부 시스템 연동 (IRIS 등) | |
| 반복 작업, 타임 트래킹 | |
| 외부 알림 (이메일/슬랙) | 앱 내 배지로 갈음 |

---

## 3. 기술 스택

| 레이어 | 선택 | 비고 |
|---|---|---|
| 배포 형태 | **Tauri v2** 데스크톱 앱 | Windows 우선. 설치 용량·메모리가 Electron보다 훨씬 작음 |
| 사이드카 | Next.js standalone (Node) | Tauri가 로컬 포트로 띄우고 WebView가 접속 |
| **데이터베이스** | **Supabase (PostgreSQL)** | 무료 플랜으로 시작. NAS 확보 시 셀프호스팅으로 이전 (§14.5) |
| **인증** | **Supabase Auth + Google OAuth** | 회사 도메인 제한 |
| DB 클라이언트 | `@supabase/supabase-js` | anon 키 + RLS. service_role 금지 |
| 실시간 | Supabase Realtime | 테이블 변경 구독 |
| 마이그레이션 | Supabase CLI | `supabase/migrations/*.sql`, Git 관리 |
| 프레임워크 | Next.js 15 (App Router) | Server Components + Server Actions |
| 언어 | TypeScript (strict) | |
| UI | React 19 | |
| 스타일 | Tailwind CSS v4 | |
| 상태 | React 내장 (useState / useOptimistic) | 전역 상태 라이브러리 없음 |
| 검증 | Zod | DB 응답도 검증한다 (마이그레이션 누락 조기 발견) |
| 테스트 | **Vitest** | 순수 함수 단위 테스트(§11 필수 1) + 리포지토리 통합 테스트 |
| 드래그앤드롭 | `@dnd-kit/core` + `@dnd-kit/sortable` | |
| 날짜 | `date-fns` | |
| 아이콘 | `lucide-react` | |
| 차트 | 없음 (간트는 직접 구현) | 단순 막대/도넛은 SVG 직접 |
| 마크다운 | `react-markdown` + `remark-gfm` | 노트 렌더링 |
| MD 에디터 | `textarea` + 라이브 프리뷰 (직접 구현) | 무거운 에디터 도입 안 함 |
| 엑셀 파싱 | `xlsx` (SheetJS) | **서버 액션에서만** 파싱. 클라이언트 번들에 넣지 않음 |
| 문자열 유사도 | `fastest-levenshtein` | 비목명 퍼지 매칭 |
| ID 생성 | `crypto.randomUUID()` | |

---

## 4. 용어 정의

| 용어 | 정의 |
|---|---|
| **Project (과제)** | 관리 단위 최상위. 국가R&D 과제 1건. |
| **Stage (단계)** | 과제의 단계. 1단계/2단계. 단일 단계 과제도 Stage 1개로 표현한다. |
| **Year (연차)** | 단계 내 연차. 1차년도, 2차년도… 계획과 실적의 기본 단위. |
| **Task** | WBS 노드. 특정 연차에 소속되며 깊이 제한 없음. |
| **WBS Code** | `1.2.3` 형태 계층 번호. 저장하지 않고 계산한다. |
| **Deliverable (정량적 성과목표)** | 논문·특허·SW등록 등 건수로 세는 목표. |
| **TechTarget (정량적 기술목표)** | 정확도 90% 같은 수치 성능지표. |
| **Milestone** | 평가·보고서 제출 등 날짜가 못 박힌 과제 이벤트. |
| **Organization** | 컨소시엄 참여기관. 주관/공동/위탁. |
| **Member** | 참여인력. 역할은 PM/PL/연구원/실무. |
| **BudgetItem** | 연차 × 비목 단위의 예산·집행 레코드. |
| **Risk** | 리스크 관리대장 항목. |
| **Note** | 마크다운 메모(회의록/기술메모/이슈). |
| **중요도 (Importance)** | 과제 목표 기여도. 1~5. 사람이 정한다. |
| **긴급도 (Urgency)** | 착수 시급성. 1~5. 마감일에서 자동 계산하되 고정 가능. |
| **우선순위 점수** | 중요도 × 긴급도. 1~25. 저장하지 않고 계산한다. |

---

## 5. 데이터 모델

### 5.1 테이블 구성

저장소는 **Supabase (PostgreSQL)** 이다. 아래 TypeScript 인터페이스는 **앱 레이어의 형태**이고, DB에는 `snake_case` 컬럼으로 매핑된다. 리포지토리 레이어가 변환을 전담한다.

| 테이블 | 대응 타입 | 비고 |
|---|---|---|
| `projects` | Project | |
| `stages` | Stage | |
| `years` | Year | |
| `tasks` | Task | 자기참조 `parent_id` |
| `milestones` | Milestone | |
| `deliverables` | Deliverable | |
| `deliverable_achievements` | DeliverableAchievement | **별도 테이블로 정규화** |
| `tech_targets` | TechTarget | |
| `tech_target_records` | TechTargetRecord | **별도 테이블로 정규화** |
| `organizations` | Organization | |
| `members` | Member | |
| `budget_items` | BudgetItem | |
| `budget_executions` | BudgetExecution | **별도 테이블로 정규화** |
| `budget_details` | BudgetDetail | 산출근거 = 예산 제안의 내역 (§5.17, Phase 9) |
| `risks` | Risk | |
| `notes` | Note | |
| `todos` | Todo | |
| `app_users` | AppUser | 인증 사용자 프로필 (§14.2) |
| `app_settings` | Settings | 팀 공유 설정. 단일 행 (N-10) |
| `import_profiles` | ImportProfile | |
| `import_snapshots` | (내부) | 임포트 반영 전 계획액 스냅샷 (I-17) |
| `task_members` | (조인) | Task ↔ Member 다대다 |
| `task_deliverables` | (조인) | Task ↔ Deliverable 다대다 |
| `task_tech_targets` | (조인) | Task ↔ TechTarget 다대다 |
| `achievement_members` | (조인) | DeliverableAchievement ↔ Member 다대다 (N-2) |
| `note_attendees` | (조인) | Note ↔ Member 다대다 (N-2) |

**정규화 규칙**

| # | 규칙 |
|---|---|
| N-1 | v2에서 임베드 배열이었던 `achievements`, `records`, `executions`는 **별도 테이블**로 분리한다. SQL 집계와 부분 갱신이 가능해진다. 이 자식 테이블들도 N-4의 공통 컬럼과 부모 FK(`deliverable_id`/`tech_target_id`/`budget_item_id`, cascade)를 갖는다. |
| N-2 | **Member를 가리키는 배열은 전부 조인 테이블**로 분리한다: `task_members`, `task_deliverables`, `task_tech_targets`에 더해 `achievement_members`, `note_attendees`. Member 삭제 시 FK cascade가 H-9의 참조 제거를 보장한다. |
| N-3 | 순수 값 배열(`tags`)과 맵(`targetByYear`, `categoryAliases`)은 `jsonb` 컬럼으로 둔다. 조인할 일이 없다. (Member FK 배열은 N-2에 따라 jsonb 금지) |
| N-4 | 모든 테이블에 `id uuid primary key default gen_random_uuid()`, `created_at`, `updated_at timestamptz`, **`version bigint not null default 1`**, **`created_by`/`updated_by uuid`**(app_users 참조, set null)를 둔다. 예외: `app_settings`(N-10), 조인 테이블(id·타임스탬프만). |
| N-5 | `updated_at`은 트리거로 자동 갱신(`clock_timestamp()`), **`version`은 BEFORE UPDATE 트리거로 +1** 한다. 낙관적 동시성 검사는 `version`으로 한다 (§8.4). `updated_by`는 서버 액션이 세션 사용자로 채운다. |
| N-6 | 부모-자식 관계는 `on delete cascade`로 DB가 강제한다. §6.6의 연쇄 삭제 규칙이 애플리케이션 코드가 아니라 스키마 제약으로 보장된다. **단, N-8의 set null 목록은 예외다.** |
| N-7 | 필수 인덱스: `tasks(year_id, parent_id, sort_order)`, `tasks(project_id)`, `budget_executions(budget_item_id, date)`, `notes(project_id, date desc)`, `milestones(project_id, date)`, `notes using gin(tags)`. |
| N-8 | **FK 삭제 정책표 — cascade가 아니라 `set null`인 참조** (지우면 안 되는 데이터가 딸려 지워지는 것을 막는다): `deliverable_achievements.year_id`, `tech_target_records.year_id`, `milestones.year_id`, `risks.year_id`, `notes.year_id`, `notes.task_id`, `notes.milestone_id`, `risks.task_id`, `projects.pm_member_id`, `projects.lead_org_id`, `members.org_id`, `milestones.owner_member_id`, `tasks.owner_member_id`, `tasks.org_id`, `risks.owner_member_id`, `todos.project_id`, `app_users.member_id`. 연차·작업을 지워도 **논문·특허 실적과 회의록은 남는다.** |
| N-9 | **DB 컬럼명은 `sort_order`를 쓴다** (`order`는 SQL 예약어). 매퍼가 앱의 `order` 필드로 변환한다. |
| N-10 | `app_settings`는 `id boolean primary key default true check (id)` 패턴으로 **단일 행을 DB가 강제**한다. 최초 마이그레이션에서 기본값 1행을 삽입한다. INSERT/DELETE 정책을 만들지 않아 행 추가·삭제가 불가능하다. `schema_version` 컬럼은 트리거로 앱에서의 변경을 거부한다(마이그레이션만 갱신). |
| N-11 | **NOT NULL 규칙**: TS 인터페이스에서 `\| null`이 없는 `string`은 `not null default ''`, `number`는 `not null default 0`, `boolean`은 `not null default false`. `\| null`이 있으면 nullable. |
| N-12 | **enum은 Postgres enum 타입 대신 `text` + `check` 제약**으로 구현한다. 값 추가가 마이그레이션 한 줄로 끝난다 (v2의 `ImportKind 'execution'` 부활 등 대비). |
| N-13 | `jsonb` 맵의 키가 다른 테이블의 id를 가리키는 경우(`targetByYear`의 yearId 키) FK가 걸리지 않는다. **정합성은 연쇄 삭제 RPC만이 보장한다** — `delete_year`가 `target_by_year - yearId` 키 제거를 수행한다 (§8.3). |

> 아래 인터페이스에 나오는 `xxxIds: string[]` 과 임베드 배열은 **앱에서 조회된 형태**다. DB 스키마는 위 규칙대로 분리되어 있다.

### 5.2 공통 필드

```ts
interface BaseEntity {
  id: string;             // crypto.randomUUID()
  createdAt: string;      // ISO 8601
  updatedAt: string;      // ISO 8601
  version: number;        // 낙관적 잠금 (§8.4). BEFORE UPDATE 트리거로 +1
  createdBy: string | null;  // app_users.id
  updatedBy: string | null;  // "OO님이 먼저 수정했습니다" 표시(O-3)와 Realtime self-echo 필터에 사용
}
```

### 5.3 Project (과제)

```ts
type ProjectStatus = 'planning' | 'active' | 'on_hold' | 'done' | 'dropped';

interface Project extends BaseEntity {
  name: string;                  // 과제명. 필수 1~200자
  projectNo: string;             // 과제고유번호 (예: '2026-0-01234')
  ministry: string;              // 부처 (예: '과학기술정보통신부')
  agency: string;                // 전문기관 (예: 'IITP', 'KEIT', 'NRF', 'KIAT')
  programName: string;           // 사업명
  description: string;

  status: ProjectStatus;
  color: string;                 // hex

  contractStartDate: string | null;  // 총 협약 시작일 'YYYY-MM-DD'
  contractEndDate: string | null;    // 총 협약 종료일

  totalBudget: number | null;        // 총 연구개발비 (원)
  govBudget: number | null;          // 정부지원연구개발비
  ownBudget: number | null;          // 기관부담연구개발비

  pmMemberId: string | null;         // 총괄책임자(PM)
  leadOrgId: string | null;          // 주관연구개발기관

  // ─ Phase 9(예산 제안) 추가 — 지침 한도 (§6.10.3 PL-14) ─
  allowanceRateLimit: number | null; // 연구수당 한도율 (%). 기본 20 (혁신법 공통)
  indirectRateLimit: number | null;  // 간접비 한도율 (%). 부처·기관 유형별 고시율이라 기본값 없음

  archived: boolean;
  order: number;
}
```

> 한도 2종은 **경고를 띄우기 위한 값이지 저장을 막는 값이 아니다** (PL-15). null이면 그 검사를 수행하지 않는다 — 모르는 값을 0으로 취급해 전 과제에 빨간 경고를 띄우는 것이 더 나쁘다.

### 5.4 Stage (단계)

```ts
interface Stage extends BaseEntity {
  projectId: string;
  order: number;            // 0-based. 표시는 order+1 '단계'
  name: string;             // 기본 '1단계'
  goal: string;             // 단계 목표 요약
  startDate: string | null;
  endDate: string | null;
  budget: number | null;    // 단계 연구개발비
}
```

> 단일 단계 과제도 Stage 1개를 반드시 만든다. UI에서는 Stage가 1개면 단계 선택 UI를 숨겨서 사용자가 계층을 의식하지 않게 한다.

### 5.5 Year (연차)

```ts
type YearStatus = 'planned' | 'active' | 'evaluating' | 'closed';

interface Year extends BaseEntity {
  projectId: string;
  stageId: string;
  order: number;              // 과제 전체 기준 0-based. 표시는 order+1 '차년도'
  name: string;               // 기본 '1차년도'
  goal: string;               // 연차 목표
  startDate: string | null;
  endDate: string | null;
  budget: number | null;      // 연차 연구개발비 (진척률 가중치로도 사용)
  status: YearStatus;
}
```

> **order 부여 규칙**: `order`는 과제 전체 기준이므로 `unique(project_id, sort_order)`를 건다. 중간 Stage에 연차를 추가하면 **해당 stage의 마지막 연차 다음 위치에 삽입하고 이후 전체 연차를 +1 시프트**한다 (`createYear` RPC). Stage 간 순서 정합(앞 단계의 마지막 order < 뒷 단계의 첫 order)은 RPC가 보장한다.
>
> `status='active'`는 **과제당 1개**만 허용한다. "현재 연차"(대시보드 뱃지, 보드 기본 필터)는 이 값으로 판정한다. 표시 이름은 `name`이 있으면 name, 없으면 `order+1 + '차년도'` — Stage도 동일.

### 5.6 Task (WBS 노드)

```ts
type TaskStatus = 'todo' | 'in_progress' | 'done' | 'blocked';
type ProgressMode = 'manual' | 'auto';

interface Task extends BaseEntity {
  projectId: string;
  yearId: string;               // 필수. Task는 반드시 하나의 연차에 속한다
  parentId: string | null;      // null이면 연차의 루트
  order: number;

  title: string;                // 필수 1~200자
  description: string;
  status: TaskStatus;

  progressMode: ProgressMode;
  manualProgress: number;       // 0~100

  estimatedHours: number | null;// 롤업 가중치
  actualHours: number | null;

  startDate: string | null;
  dueDate: string | null;

  // 우선순위 (§6.9)
  importance: 1 | 2 | 3 | 4 | 5;        // 중요도. 기본 3
  urgencyMode: 'auto' | 'manual';       // 기본 'auto' (마감일 기반)
  urgencyManual: 1 | 2 | 3 | 4 | 5;     // urgencyMode='manual'일 때만 사용. 기본 3

  ownerMemberId: string | null; // 책임자 1명 (PL 성격)
  memberIds: string[];          // 참여 담당자 다중
  orgId: string | null;         // 수행 기관

  deliverableIds: string[];     // 이 작업이 기여하는 성과목표
  techTargetIds: string[];      // 이 작업이 기여하는 기술목표

  tags: string[];
}
```

**저장하지 않는 파생 값**: `wbsCode`, `depth`, `children`, `computedProgress`, `isLeaf`, `rolledUpStartDate`, `rolledUpDueDate`, `computedUrgency`, `priorityScore`

> v1의 `isMilestone` 플래그는 제거되었다. 마일스톤은 §5.7 독립 엔티티로 관리한다.

### 5.7 Milestone

```ts
type MilestoneType =
  | 'annual_eval'      // 연차평가
  | 'stage_eval'       // 단계평가
  | 'final_eval'       // 최종평가
  | 'progress_check'   // 진도점검
  | 'report'           // 보고서 제출 (연차실적계획서, 단계보고서, 최종보고서)
  | 'contract'         // 협약체결 / 협약변경
  | 'demo'             // 시연 / 공인시험
  | 'custom';

type MilestoneStatus = 'planned' | 'preparing' | 'done' | 'delayed' | 'cancelled';

interface Milestone extends BaseEntity {
  projectId: string;
  yearId: string | null;       // 연차 귀속 (없으면 과제 전체 이벤트)
  type: MilestoneType;
  title: string;               // 예: '1차년도 연차평가'
  date: string;                // 'YYYY-MM-DD' 필수
  status: MilestoneStatus;
  ownerMemberId: string | null;
  description: string;
  resultNote: string;          // 평가 결과 / 제출 결과 메모
}
```

> 노트 연결은 `Note.milestoneId`(§5.14) **단방향**만 쓴다. 양쪽에 참조를 두면 동기화 주체가 모호해진다. 마일스톤 화면은 역참조로 관련 노트를 보여준다.

### 5.8 Deliverable (정량적 성과목표)

```ts
type DeliverableType =
  | 'paper_sci' | 'paper_domestic' | 'conference'   // 논문·학회
  | 'patent_dom_apply' | 'patent_dom_reg'           // 국내 특허 출원/등록
  | 'patent_intl_apply' | 'patent_intl_reg'         // 해외 특허 출원/등록
  | 'sw_registration'                               // SW(프로그램) 등록
  | 'tech_transfer'                                 // 기술이전
  | 'commercialization'                             // 사업화
  | 'standard'                                      // 표준화
  | 'hr_training'                                   // 인력양성
  | 'other';

interface DeliverableAchievement {
  id: string;
  version: number;          // 낙관적 잠금용 — 실적 편집 폼이 여러 필드를 한 번에 바꾸므로 O-1 대상이다
  title: string;            // 실제 산출물명 (논문 제목, 특허명 등)
  date: string;             // 달성일
  yearId: string | null;    // 어느 연차에 달성했는지
  orgId: string | null;     // 달성 기관
  memberIds: string[];      // 관여자
  evidenceUrl: string;      // 증빙 링크 (DOI, 특허번호 조회 URL 등)
  note: string;
}

interface Deliverable extends BaseEntity {
  projectId: string;
  type: DeliverableType;
  name: string;                              // 지표명 (예: 'SCI급 논문 게재')
  unit: string;                              // 기본 '건'
  targetTotal: number;                       // 과제 전체 목표 건수
  targetByYear: Record<string, number>;      // { yearId: 목표건수 }
  achievements: DeliverableAchievement[];    // 실적 목록
  orgId: string | null;                      // 주 책임 기관
  note: string;
  order: number;
}
```

> `achievements` 배열은 **앱에서 조회된 형태**다. DB에는 N-1에 따라 `deliverable_achievements` 별도 테이블로 저장되고, 관여자(`memberIds`)는 N-2에 따라 `achievement_members` 조인 테이블이다.

### 5.9 TechTarget (정량적 기술목표)

```ts
type Direction = 'higher_better' | 'lower_better' | 'target_exact';
type MeasureMethod = 'self' | 'certified_lab' | 'expert_review' | 'customer' | 'other';

interface TechTargetRecord {
  id: string;
  version: number;          // 낙관적 잠금용 — 측정 이력 편집 폼이 여러 필드를 한 번에 바꾸므로 O-1 대상이다
  value: number;            // 측정 실적치
  date: string;             // 측정일
  yearId: string | null;
  method: MeasureMethod;
  evaluator: string;        // 측정/평가 기관명
  evidenceUrl: string;
  note: string;
}

interface TechTarget extends BaseEntity {
  projectId: string;
  name: string;                    // 평가항목명 (예: '객체 인식 정확도')
  unit: string;                    // 단위 (예: '%', 'ms', 'fps')
  direction: Direction;            // 기본 'higher_better'

  weight: number;                  // 전체 항목에서 차지하는 비중(%). 과제 내 합계 100 권장
  targetValue: number;             // 최종 개발 목표치
  targetByYear: Record<string, number>;  // { yearId: 연차 목표치 }

  baselineDomestic: number | null; // 연구개발 전 국내수준
  worldBest: number | null;        // 세계최고수준 수치
  worldBestHolder: string;         // 세계최고수준 보유국/보유기관

  measureMethod: MeasureMethod;
  measureDescription: string;      // 측정방법 상세

  records: TechTargetRecord[];     // 측정 이력 (최신값이 현재 실적치)
  orgId: string | null;
  order: number;
}
```

### 5.10 Organization (컨소시엄 기관)

```ts
type OrgRole = 'lead' | 'joint' | 'consign';  // 주관 / 공동 / 위탁

interface Organization extends BaseEntity {
  projectId: string;
  name: string;                 // 기관명
  role: OrgRole;
  type: string;                 // 기업 / 대학 / 출연연 / 기타
  representative: string;       // 기관 책임자명
  contact: string;              // 연락처 or 이메일
  responsibility: string;       // 담당 연구개발 내용
  budget: number | null;        // 기관 배분 연구개발비 (참고용 단일 값)
  order: number;
}
```

### 5.11 Member (참여인력)

```ts
type MemberRole = 'pm' | 'pl' | 'researcher' | 'staff';
// pm: 총괄책임자, pl: 세부/기관 책임자, researcher: 참여연구원, staff: 행정/지원

type HireType = 'existing' | 'new';   // 기존인력 / 신규채용 (예정자 포함)

interface Member extends BaseEntity {
  projectId: string;
  orgId: string | null;         // 소속 기관
  name: string;                 // 필수
  role: MemberRole;
  position: string;             // 직급/직위
  field: string;                // 전공/담당 분야
  email: string;
  phone: string;
  active: boolean;              // 참여 종료자는 false
  order: number;

  // ─ Phase 9(예산 제안) 추가 — 인건비 산출근거의 단가 원본 (§6.10.1) ─
  annualSalary: number | null;  // 실지급액(연봉), 원 단위 정수. 미입력이면 null
  hireType: HireType;           // 기본 'existing'
}
```

> **참여율(%)은 Member의 필드가 아니다.** §13 미결정 1번은 Phase 9에서 **`BudgetDetail`에 두는 것으로 해소**했다. 참여율은 사람의 속성이 아니라 **(연차 × 인력)의 속성**이고, 한 사람이 한 연차 안에서 참여율을 바꿔 두 구간으로 나뉘는 서식이 실존한다(행안부 실측: 한봄희 4개월 10% + 8개월 53%). Member에 단일 필드로 두면 이 사례가 표현되지 않고, 연차가 늘어날 때마다 값이 덮어써진다.

> **`hireType = 'new'`는 아직 사람이 정해지지 않은 자리를 담기 위한 것이다.** 실측 두 서식 모두 `신규채용1(청년의무)`·`박지원(청년의무)`처럼 채용 예정 자리를 인건비에 계상한다. 이런 자리도 **Member로 등록**한다 — 인건비 산출근거는 언제나 `memberId`를 통해 이름·연봉·직위를 얻으며, 내역 행이 이름 문자열을 따로 갖지 않는다(정의가 두 곳에 생기는 것을 막는다). 인력 화면은 `hireType = 'new'`를 **채용예정** 배지로 구분해 보여 준다.

> `annualSalary`는 **보안 제한 대상이 아니다** — 이 도구를 쓰는 팀이 원래 인건비를 다루는 팀이고, 승인된 사용자는 전원 동일 권한이다(§2.2 RBAC 제외). 별도 마스킹·열람 제어를 두지 않는다.

### 5.12 BudgetItem (비목별 예산·집행)

```ts
// 국가연구개발혁신법 기준 비목 체계
type BudgetCategory =
  | 'personnel'          // 인건비
  | 'student_personnel'  // 학생인건비
  | 'facility_equipment' // 연구시설·장비비
  | 'material'           // 연구재료비
  | 'consignment'        // 위탁연구개발비
  | 'international'      // 국제공동연구개발비
  | 'burden'             // 연구개발부담비
  | 'activity'           // 연구활동비
  | 'promotion'          // 연구과제추진비
  | 'allowance'          // 연구수당
  | 'indirect'           // 간접비
  | 'other';             // 기타 (사용자가 명시적으로 선택한 경우만 — 자동 매핑은 넣지 않는다, I-4)

interface BudgetExecution {
  id: string;
  version: number;           // 낙관적 잠금용 — 집행 내역 편집이 일자·금액·적요를 한 번에 바꾸므로 O-1 대상이다 (§5.8·§5.9와 같은 이유)
  date: string;              // 집행일
  amount: number;            // 집행액 (원). **0 이상 정수만** — 실무에서 집행액을 음수로 잡는 경우가 없다(사용자 확인).
                             // 환불·감액은 별도 행이 아니라 원래 집행 행을 수정한다.
  description: string;       // 적요
  note: string;
}

interface BudgetItem extends BaseEntity {
  projectId: string;
  yearId: string;                    // 연차 × 비목이 유일 키
  category: BudgetCategory;
  plannedAmount: number;             // 계획(예산)액 = 현금 + 현물
  cashAmount: number | null;         // 그중 현금
  inKindAmount: number | null;       // 그중 현물
  executions: BudgetExecution[];     // 집행 내역 (수동 입력)
  note: string;

  // ─ Phase 9 추가 — 이 셀에 산출근거가 있는가 (§5.17, PL-9) ─
  detailCount: number;               // 조회 시 계산해 실어 보내는 값. 저장 컬럼이 아니다
}
```

> 비목별 보조 축은 **현금/현물**이다. 실제 예산 서식(연구개발계획서 사업비 총괄표)이 비목별 금액을 현금/현물로 분리하며, 정부출연금/민간부담금 구분은 비목 수준에 존재하지 않는다. 정부/기관부담 축은 과제 수준(`Project.govBudget/ownBudget`)에서만 관리한다.

**제약**: `(projectId, yearId, category)` 조합은 유일해야 한다. 연차 생성 시 12개 비목 레코드를 `plannedAmount: 0`으로 자동 생성한다.

**계획액의 소유권 (Phase 9 개정)**: `detailCount > 0`인 셀의 `plannedAmount`·`cashAmount`·`inKindAmount`는 **사람이 입력하는 값이 아니라 산출근거(§5.17)의 합계다.** 이 셀은 매트릭스에서 직접 편집이 잠기고, 총괄표 엑셀 임포트의 덮어쓰기 대상에서도 빠진다(S-14). `detailCount = 0`인 셀은 v1과 완전히 동일하게 동작한다 — 직접 입력하고, 임포트가 덮어쓴다. 저장 값과 합계의 일치를 보장하는 방법은 PL-10에 있다.

#### 5.12.1 ImportProfile (엑셀 매핑 프로파일 = 부처 템플릿)

```ts
// 'budget_plan' = 총괄표(셀 총액, §6.8) / 'budget_detail' = 산출근거 시트(행 내역, §6.11)
// 집행내역 임포트는 여전히 제외 (§13 12-a)
type ImportKind = 'budget_plan' | 'budget_detail';

interface ImportProfile extends BaseEntity {
  name: string;                   // 예: '산자부 사업비 총괄표'
  kind: ImportKind;
  ministry: string | null;        // 부처명 (예: '산업통상자원부'). 부처별 별칭 프리셋 적용 키 (부록 C)
  projectId: string | null;       // null이면 전역 프로파일 (모든 과제에서 재사용)

  sheetName: string | null;       // null이면 첫 시트
  headerRow: number;              // 0-based 헤더 행 인덱스
  dataStartRow: number;           // 0-based 데이터 시작 행
                                  // 데이터 **끝** 행은 저장하지 않는다 — 프로파일 재사용 시 시트 끝까지 읽고,
                                  // 표 아래 잔여 행은 S-12에 따라 `건너뜀(라벨 없음)`으로 미리보기에 남는다.
                                  // (끝 행을 굳혀 두면 서식이 한 줄 늘었을 때 조용히 잘린다)
  orientation: 'row' | 'column';  // 비목이 행에 있는지 열에 있는지 (§6.8.2)

  // 매트릭스 구조 (S-3, S-5의 감지 결과를 저장해 재사용)
  labelColumns: string[];         // 행 라벨 열 목록, 좌→우 순 (예: ['B','C','D'])
  yearColumnMappings: { column: string; yearOrder: number }[];
                                  // 연차 열 대응 (예: E열 → order 0). yearId가 아니라 order를 저장해
                                  // 다른 과제에서도 재사용 가능하게 한다

  categoryAliases: Record<string, BudgetCategory>;  // 이 서식에서 학습한 비목명 → 코드
  amountUnit: 1 | 1000 | 1000000; // 원본 금액 단위 배수 (원/천원/백만원)
  skipRowPatterns: string[];      // 무시할 행 패턴 (예: '소계', '합계', '계')

  lastUsedAt: string | null;
  useCount: number;
}
```

#### 5.12.2 ImportDraft (마법사 진행 상태 — 저장하지 않는 일회성 타입)

미리보기와 반영이 **결정론적으로 동일**하려면(§9), 사용자의 모든 수동 결정이 하나의 값에 담겨 두 액션에 같이 전달되어야 한다. `ImportProfile`은 이 중 **재사용 가능한 부분집합**만 저장한다.

```ts
interface ImportDraft {
  profile: Omit<ImportProfile, keyof BaseEntity | 'lastUsedAt' | 'useCount'>;

  // 이번 실행에서만 유효한 결정들 (프로파일에 저장하지 않는다)
  yearMapping: Record<string, string>;        // **엑셀 열 문자**(대문자, 예: 'F') → yearId.
                                              // 헤더 텍스트가 아니라 열 문자를 키로 쓴다 — 헤더는 비거나
                                              // 중복될 수 있고, ImportProfile.yearColumnMappings도 열 문자를
                                              // 키로 쓰므로 이것만이 두 구조를 어긋남 없이 잇는다.
                                              // 미대응 열이 있으면 반영 불가 (S-5)
  skippedRowIndexes: number[];                // 사용자가 "이 행 건너뛰기"로 지정한 행 (0-based)
  manualCategoryByRow: Record<number, BudgetCategory>; // 행별 수동 지정 (I-4). I-6 모호 별칭의 선택 포함
  fileHash: string;                           // 업로드 파일 sha256. previewImport가 계산·반환하고
                                              // commitImport가 대조한다 — 다른 파일이 반영되는 것을 차단
}
```

### 5.13 Risk (리스크 관리대장)

```ts
type RiskCategory = 'technical' | 'schedule' | 'budget' | 'resource' | 'external' | 'other';
type RiskLevel = 1 | 2 | 3 | 4 | 5;
type RiskStrategy = 'mitigate' | 'avoid' | 'transfer' | 'accept';
type RiskStatus = 'identified' | 'monitoring' | 'occurred' | 'resolved' | 'closed';

interface Risk extends BaseEntity {
  projectId: string;
  yearId: string | null;
  taskId: string | null;          // 관련 작업 연결

  title: string;                  // 리스크명
  category: RiskCategory;
  description: string;            // 리스크 내용

  probability: RiskLevel;         // 발생가능성 1~5
  impact: RiskLevel;              // 영향도 1~5
  // score = probability * impact (1~25), 저장하지 않고 계산

  strategy: RiskStrategy;
  response: string;               // 대응 방안
  contingency: string;            // 비상 계획

  ownerMemberId: string | null;
  dueDate: string | null;         // 대응 완료 목표일
  status: RiskStatus;
  order: number;
}
```

### 5.14 Note (마크다운 메모)

```ts
type NoteType = 'meeting' | 'tech' | 'issue' | 'idea' | 'report_draft' | 'other';

interface Note extends BaseEntity {
  projectId: string | null;      // null이면 과제 무관 개인 노트
  yearId: string | null;
  taskId: string | null;         // 특정 작업에 붙는 노트
  milestoneId: string | null;    // 평가/보고 관련 노트

  type: NoteType;
  title: string;                 // 필수
  body: string;                  // 마크다운 원문
  date: string;                  // 'YYYY-MM-DD' (회의일 등). 기본 오늘
  attendeeMemberIds: string[];   // 회의 참석자
  tags: string[];
  pinned: boolean;
}
```

> 회의록에서 나온 액션 아이템은 노트 본문의 마크다운 체크박스(`- [ ]`)로 적되, 실제 관리가 필요하면 Task나 To-Do로 별도 생성한다. 자동 파싱/동기화는 하지 않는다(v2 후보).

### 5.15 Todo

```ts
type Priority = 'low' | 'normal' | 'high';

interface Todo extends BaseEntity {
  title: string;
  done: boolean;
  projectId: string | null;
  dueDate: string | null;
  priority: Priority;
  order: number;
  completedAt: string | null;
}
```

To-Do는 진척률·달성률 계산에 절대 포함되지 않는다.

### 5.16 Settings

```ts
// 팀 공유 설정 — app_settings 테이블 (단일 행)
interface Settings {
  dueSoonDays: number;              // 기본 7
  milestoneAlertDays: number;       // 기본 30
  weekStartsOn: 0 | 1;              // 기본 1
  defaultGanttScale: 'day' | 'week' | 'month';  // 기본 'week'
  currencyUnit: '원' | '천원' | '백만원';        // 기본 '천원'
  progressWeightBasis: 'budget' | 'equal';      // 기본 'budget'
  schemaVersion: number;   // DB 마이그레이션 일련번호. 문서 버전과 무관하다.
                           // Phase 0 최초 스키마 = 1. 마이그레이션만 갱신 가능 (N-10)
}

// 각 PC 로컬 설정 — Tauri app config dir. DB에 저장하지 않는다.
// Tauri 없이 브라우저로 개발하는 동안(Phase 0~1)은 localStorage에 둔다 —
// C-3의 localStorage 금지는 "세션 토큰" 한정이며, 비밀이 아닌 화면 취향은 무관하다
interface LocalConfig {
  backupFolder: string | null;      // §8.7 자동 내보내기 대상 폴더
  lastBackupAt: string | null;
  lastOpenedProjectId: string | null;
  ganttScale: 'day' | 'week' | 'month';   // 개인 화면 취향
}
```

> 표시 이름·이메일은 `app_users` 테이블(§14.2)에 있다. `Settings`는 팀 전체가 공유하는 업무 규칙만 담는다.

### 5.17 BudgetDetail (산출근거 = 예산 제안의 내역)

`BudgetItem`(§5.12)이 "연차 × 비목에 얼마"라면, `BudgetDetail`은 **그 금액이 어떻게 나왔는가**다. 실측 워크북의 연차별 산출근거 시트(`1차년도_250520`, `1단계_2차년도_250604`)가 원본이며, 두 부처 서식의 구조가 거의 동일해 아래 한 벌로 표현된다.

```
BudgetItem (연차 × 비목)          ← 총액. 잠김 (합계로 확정)
  └ BudgetDetail[]                ← 산출 행. 사람이 편집하는 곳
        subcategory: 세목          ← 부록 A.5 프리셋 (예: activity_meeting '④ 회의비')
        axis: 현금 | 현물
        금액 = 단가 × 인자들 + 조정액
```

```ts
// 이름 충돌 주의: `lib/constants.ts`에 이미 `BudgetAxis = 'cash' | 'inKind' | 'unassigned'`가
// 있다(임포트 파이프라인 전용, S-4). 그쪽은 총괄표의 축 라벨이 판정되지 않는 경우까지 담아야 해서
// 'unassigned'가 있지만, 산출근거 행은 축 없이 존재할 수 없으므로 **별개 타입**으로 둔다.
type DetailAxis = 'cash' | 'in_kind';

// 금액 산식 (§6.10.1). 실측 서식 전부가 이 둘로 표현된다
type DetailFormula =
  | 'personnel'   // 인건비류: member.annualSalary × 참여율/100 × 개월/12
  | 'quantity';   // 나머지 전부: unitPrice × (인자들의 곱)

/** 수량 인자. 세목마다 의미가 다르므로 라벨을 값과 함께 저장한다 (PL-3) */
interface DetailFactor {
  label: string;      // '수량' | '회' | '월' | '인원' | '횟수' | '참여율(%)' | '참여기간(월)' …
  value: number;      // 소수 허용 (참여율 10.0, 참여기간 8)
  isPercent: boolean; // true면 계산 시 100으로 나눈다
}

interface BudgetDetail extends BaseEntity {
  projectId: string;
  yearId: string;
  category: BudgetCategory;    // 어느 매트릭스 셀에 속하는가
  subcategory: string;         // 세목 코드 (부록 A.5). 세목이 없는 비목은 'default'
  axis: DetailAxis;            // 현금/현물. **null이 없다** — 축이 없으면 합계를 나눌 수 없다

  formula: DetailFormula;

  // formula = 'personnel' 전용
  memberId: string | null;     // 필수. 단가(연봉)·이름·직위의 유일한 출처 (§5.11)

  // formula = 'quantity' 전용
  name: string;                // 품명/내역명. personnel이면 빈 문자열
  unitPrice: number;           // 단가 (원 단위 정수, 0 이상)

  spec: string;                // 규격 / 산출내역 메모 (자유 텍스트)
  factors: DetailFactor[];     // 0~3개. 빈 배열이면 금액 = unitPrice + adjustment
  adjustment: number;          // 조정액 (원). **음수 허용** — 서식의 절사·미세조정용
  note: string;                // 비고
  order: number;               // 세목 안에서의 표시 순서

  amount: number;              // 계산된 금액 (원 단위 정수). **사람이 입력하지 않는다** (PL-10a)
}
```

**제약**

| # | 규칙 |
|---|---|
| PL-D1 | `formula = 'personnel'`이면 `memberId`가 필수이고 `name`·`unitPrice`는 무시한다. 반대면 `memberId`는 null이어야 한다. |
| PL-D2 | `memberId`가 가리키는 Member는 **같은 과제 소속**이어야 한다 (§9 N-13과 같은 경계 검증. FK가 막지 못한다). `yearId` 역시 같은 과제여야 한다. |
| PL-D3 | `category`가 `personnel`·`student_personnel`이면 `formula`는 `'personnel'`만 허용한다. 나머지 비목은 `'quantity'`만 허용한다. 이 제약이 없으면 인건비 셀에 단가 행이 섞여 §6.10.3 검증의 기준액이 흔들린다. |
| PL-D4 | `subcategory`는 그 `category`의 프리셋(부록 A.5)에 있는 코드여야 한다. 프리셋에 없는 세목이 실무에서 나타나면 **부록 A.5를 먼저 고친다** — 자유 문자열을 허용하면 세목이 오타로 갈라져 소계가 어긋난다. |
| PL-D5 | `unitPrice`·`factors[].value`는 0 이상. `adjustment`만 음수를 허용한다. |
| PL-D6 | 삭제는 물리 삭제다. 산출근거는 이력이 아니라 현재 계획이며, 되돌리기는 §8.7 백업과 `import_snapshots`가 담당한다. |
| PL-D7 | `amount`는 **서버 액션이 `lib/budget-plan.ts`로 계산해 넣는 값**이다. 클라이언트가 보낸 `amount`는 무시하고 다시 계산한다 — 화면이 금액을 지어낼 수 있으면 산출근거가 근거가 아니게 된다. 근거 필드(`unitPrice`·`factors`·`adjustment`·`memberId`)가 바뀌면 `amount`도 반드시 같은 쓰기에서 다시 계산된다. |
| PL-D8 | **`member_id`는 `on delete restrict`다** (H-9a). 인건비 산출근거가 걸린 Member는 삭제할 수 없다. `year_id`·`project_id`는 `on delete cascade`다 — 연차·과제가 사라지면 그 계획도 사라지는 것이 맞다. |

> **`version`을 갖는다** (BaseEntity). 산출 행 편집이 단가·인자·조정액을 한 번에 바꾸므로 §8.4 O-1 낙관적 잠금 대상이다 — §5.8·§5.9·§5.12 `BudgetExecution`과 같은 이유다.

---

## 6. 핵심 비즈니스 규칙

### 6.1 진척률 롤업 (4단계)

```
Project ← Stage ← Year ← Task 트리
```

**① Task 진척률** (v1과 동일, post-order 순회)

```
computeTaskProgress(task):
  if task.children is empty:                  # 리프
      if task.status == 'done': return 100
      return task.manualProgress

  if task.progressMode == 'manual':           # 부모, 수동
      return task.manualProgress

  totalWeight = 0; weightedSum = 0            # 부모, 자동
  for child in task.children:
      w = child.estimatedHours ?? 1
      totalWeight += w
      weightedSum += computeTaskProgress(child) * w
  return totalWeight == 0 ? 0 : weightedSum / totalWeight
```

**② Year 진척률** = 해당 연차 루트 Task들의 가중 평균 (가중치: `estimatedHours ?? 1`). Task가 없으면 0.

**③ Stage 진척률** = 소속 Year들의 가중 평균
- `settings.progressWeightBasis === 'budget'` → 가중치 = `year.budget ?? 1`
- `'equal'` → 균등

**④ Project 진척률** = 소속 Stage들의 가중 평균 (가중치는 ③과 동일 기준, `stage.budget` 사용)

**규칙 상세**

| # | 규칙 |
|---|---|
| P-1 | 리프에서 `status='done'`이면 진척률 100 강제. |
| P-2 | 리프의 `manualProgress`를 100으로 입력하면 `status='done'`으로 자동 전환. |
| P-3 | 리프의 `manualProgress`를 1~99로 입력하면 `status='todo'`인 경우 `'in_progress'`로 전환. |
| P-4 | 부모 Task는 기본 `progressMode='auto'`. UI 토글로 `'manual'` 전환 가능. |
| P-5 | `'manual'` → `'auto'` 복귀 시 즉시 롤업 값 반영. |
| P-6 | 리프에 자식이 처음 생기면 `progressMode`를 `'auto'`로 자동 전환. |
| P-7 | `estimatedHours`가 0/null인 자식은 가중치 1. 음수 입력 불가. |
| P-8 | 반올림은 표시 단계에서만. 중간 계산은 소수점 유지. **표시 형식은 소수 1자리 고정**(`75 → 75.0%`, `66.666… → 66.7%`, 계산 불가 → `N/A`). 표에서 소수점 자리가 들쭉날쭉하지 않게 한다 — 부록 B.3이 `75%`로 적힌 것은 표기 축약이며 화면 표시 규칙이 아니다. |
| P-9 | `year.budget`에 **양수가 하나도 없으면**(전부 null이거나 전부 0) `progressWeightBasis` 설정과 무관하게 균등 가중으로 폴백한다. 가중치 합이 0이면 진척률이 0으로 계산되어 거짓 값이 되기 때문이다. 양수가 하나라도 있으면 `budget ?? 1`을 그대로 쓴다(0인 연차는 가중치 0). |
| P-10 | 신규 Task의 `progressMode` 기본값은 `'manual'`이다. (부모가 되는 순간 P-6이 `'auto'`로 전환) |
| P-11 | `status`를 `done`에서 다른 상태로 되돌려도 `manualProgress`는 유지한다. P-1의 100 강제가 풀릴 뿐, 값을 임의로 리셋하지 않는다. |
| P-12 | 마지막 자식이 삭제되어 부모가 다시 리프가 되면 `progressMode='manual'`, `manualProgress=직전 롤업값(반올림)`으로 고정한다. 삭제로 진척률이 널뛰지 않게 한다. |
| P-13 | Task가 하나도 없는 연차는 진척률 0으로 **Stage 가중 평균의 분모에 포함**한다. 계획만 있는 미래 연차가 전체 진척률을 낮추는 것은 의도된 동작이며, UI 툴팁에 "작업 없음"을 표시한다. |

#### 6.1.1 날짜 롤업

부모 Task의 표시 기간(§7.4 "기간" 컬럼)과 간트 요약 막대(§7.5)는 저장하지 않고 계산한다. `lib/tree.ts`에서 post-order 1회 순회로 진척률과 함께 계산하며 **단위 테스트 대상**이다.

| # | 규칙 |
|---|---|
| P-14 | `rolledUpStartDate = min(자기 startDate, 자식들의 rolledUpStartDate)`. null은 비교에서 제외. |
| P-15 | `rolledUpDueDate = max(자기 dueDate, 자식들의 rolledUpDueDate)`. null은 비교에서 제외. |
| P-16 | 자기 값과 자식 값이 전부 null이면 결과도 null — 간트에 표시하지 않고 목록에만 나온다(§7.5). |

### 6.2 성과목표(Deliverable) 달성률

```
지표 달성률 = achievements.length / targetTotal * 100               # 상한 없음, 100 초과 허용
연차 달성률 = 해당 yearId 실적 건수 / targetByYear[yearId] * 100
과제 전체 성과목표 달성률 = Σ(달성건수) / Σ(목표건수) * 100          # 단순 합산, 지표별 가중 없음
```

| # | 규칙 |
|---|---|
| D-1 | `targetTotal`이 0이면 달성률은 `N/A`로 표시한다 (0으로 나누지 않는다). |
| D-2 | 달성률 100% 초과를 허용한다(초과 달성). UI 진행바는 100%에서 시각적으로 잘리되 숫자는 실제 값을 표기한다. |
| D-3 | `Σ targetByYear` 와 `targetTotal`이 불일치하면 저장은 허용하되 UI에 경고 배지를 띄운다. |
| D-4 | 실적의 `yearId`가 null이면 연차별 집계에서는 제외되고 전체 집계에만 포함된다. |
| D-5 | 연차 달성률에서 `targetByYear[yearId]`가 없거나 0이면 해당 연차 달성률은 `N/A`. 단 실적 건수가 0보다 크면 "목표 외 달성"을 표시한다. |

### 6.3 기술목표(TechTarget) 달성률

현재 실적치 = `records` 중 `date`가 가장 최신인 레코드의 `value`. 레코드가 없으면 `null`.

```
achievementRate(target):
  current = latest(records)?.value
  if current is null: return null                       # 미측정

  if direction == 'lower_better' and target.baselineDomestic is null:
      return null                                       # T-2: 기준 없이 감소율 계산 불가 → N/A

  base = target.baselineDomestic ?? 0                   # 시작점

  if direction == 'higher_better':
      if targetValue == base: rate = current >= targetValue ? 100 : 0
      else: rate = (current - base) / (targetValue - base) * 100

  if direction == 'lower_better':
      if base == targetValue: rate = current <= targetValue ? 100 : 0
      else: rate = (base - current) / (base - targetValue) * 100

  if direction == 'target_exact':
      if current == targetValue: rate = 100
      else:
          tolerance = abs(targetValue) * 0.05           # ±5% 허용
          rate = abs(current - targetValue) <= tolerance ? 100 : 0

  return clamp(rate, 0, 100)                            # T-1
```

**과제 전체 기술목표 달성률** = `Σ(달성률 × weight) / Σ(weight)`. 미측정 항목은 달성률 0으로 간주하고 분모에는 포함한다.

| # | 규칙 |
|---|---|
| T-1 | 달성률은 0~100으로 클램프한다(성과목표와 달리 초과 표시하지 않음). |
| T-2 | `baselineDomestic`이 null이면 0을 시작점으로 쓴다. 단 `lower_better`에서 baseline이 null이면 달성률 계산 불가로 `N/A` 처리한다. |
| T-3 | 과제 내 `weight` 합계가 100이 아니면 저장은 허용하되 경고 배지를 띄운다. 계산은 실제 합계로 정규화한다. |
| T-4 | `measureMethod`가 `'certified_lab'`인데 최신 레코드의 `evaluator`가 비어 있으면 경고를 표시한다. |

### 6.4 예산 집행률

```
비목 집행액 = Σ executions[].amount
비목 집행률 = 집행액 / plannedAmount * 100
연차 집행률 = Σ(연차 내 모든 비목 집행액) / Σ(plannedAmount) * 100
과제 집행률 = 전 연차 합산
```

| # | 규칙 |
|---|---|
| B-1 | `plannedAmount`가 0이면 집행률은 `N/A`. 단 집행액이 0보다 크면 "예산 외 집행" 경고를 띄운다. |
| B-2 | 집행률 100% 초과 시 빨강 경고. 저장은 막지 않는다. |
| B-3 | 연차 예산 합계와 `year.budget`이 불일치하면 경고 배지. |
| B-4 | 금액은 정수(원 단위)로 저장하고, 표시만 `settings.currencyUnit`에 따라 환산한다. 부동소수점 연산 금지. |

### 6.5 마감·알림 판정

기준일은 **Asia/Seoul 달력 오늘**(`lib/dates.ts`의 `todayISO(now)`)이다. 로컬 타임존이 아니다 — 이 앱은 Next 서버(Tauri standalone 사이드카, OS 타임존이 UTC일 수 있다)와 사용자 PC가 각자 시계를 갖는다. 서버가 자기 타임존으로 "오늘"을 만들면 한국시간 09:00 이전에 하루가 밀려 **같은 마일스톤이 화면마다 지연/정상으로 다르게 보인다.** 기준일은 서버 컴포넌트가 한 번 계산해 prop으로 내려주고, 클라이언트 컴포넌트는 오늘을 스스로 만들지 않는다.

| 대상 | 상태 | 조건 | 색상 |
|---|---|---|---|
| Task | `overdue` | `dueDate < today` AND `status != 'done'` | 빨강 |
| Task | `dueSoon` | `0 ≤ dueDate - today ≤ dueSoonDays` AND `status != 'done'` | 주황 |
| Milestone | `overdue` | `date < today` AND `status ∉ {done, cancelled}` | 빨강 |
| Milestone | `upcoming` | `0 ≤ date - today ≤ milestoneAlertDays` AND `status ∉ {done, cancelled}` | 주황 |
| Risk | `high` | `probability × impact ≥ 15` AND `status ∉ {resolved, closed}` | 빨강 |
| Risk | `medium` | `8 ≤ score < 15` AND 미해결 | 주황 |

`status='blocked'`인 Task와 `status='occurred'`인 Risk는 마감과 무관하게 대시보드 "주의 필요"에 항상 포함한다.

### 6.6 트리·계층 무결성

| # | 규칙 |
|---|---|
| H-1 | Task의 `parentId`는 **같은 `yearId`** 내에서만 유효하다. 연차 간 부모-자식 관계 금지. |
| H-2 | 자기 자신 또는 자손을 부모로 지정 불가 (순환 검사 필수). |
| H-3 | Task 최대 깊이 **10단계** — 기준: **루트 = 깊이 1**, 최대 깊이 10 (루트 아래 9단계). 상수 `MAX_TASK_DEPTH = 10`을 `lib/constants.ts`와 SQL `move_task` 함수 양쪽에 **동일 정의**한다. |
| H-4 | 부모 Task 삭제 시 자손 전체 삭제. 삭제 전 개수 확인. 해당 Task(및 자손)를 참조하던 Note·Risk의 `taskId`는 `null`로 남긴다 (N-8). |
| H-5 | Year 삭제 시 소속 Task·BudgetItem 전체 삭제. Milestone·Risk·Note와 실적(`deliverable_achievements`·`tech_target_records`)은 `yearId=null`로 남긴다. `targetByYear`의 해당 키는 `delete_year` RPC가 제거한다 (N-13). 삭제 확인 대화상자에 "관련 마일스톤·실적은 연차 없음 상태로 남습니다"를 표시한다. |
| H-6 | Stage 삭제 시 소속 Year를 연쇄 삭제한다(H-5 적용). Stage가 1개뿐이면 삭제 불가. |
| H-7 | Project 삭제 시 소속 전 엔티티 삭제. To-Do는 `projectId=null`로 남긴다. RPC는 순환 FK 해소를 위해 `pm_member_id`·`lead_org_id`를 먼저 null로 만든 뒤 삭제한다. |
| H-8 | Organization 삭제 시 참조하던 Member는 `orgId=null`. 주관기관은 다른 기관을 주관으로 지정하기 전까지 삭제 불가. **주관 재지정(`setLeadOrganization`)은 한 트랜잭션에서 ① 기존 `role='lead'` 기관을 `'joint'`로 강등 ② 대상 기관을 `'lead'`로 ③ `projects.lead_org_id` 갱신을 함께 수행한다** — 과제당 주관기관은 항상 정확히 1개여야 하고, 중간 상태(0개·2개)가 남으면 H-8의 삭제 차단 판정이 무너진다. |
| H-9 | Member 삭제 대신 `active=false` 권장. 삭제 시 제거해야 할 참조는 **8곳**: `tasks.owner_member_id`, `task_members`, `milestones.owner_member_id`, `risks.owner_member_id`, `projects.pm_member_id`, `achievement_members`, `note_attendees`, `app_users.member_id`. 조인 테이블은 FK cascade, 나머지는 set null(N-8)로 스키마가 보장한다. |
| H-9a | **인건비 산출근거(`budget_details.member_id`)가 참조하는 Member는 삭제를 차단한다** (Phase 9). H-9의 8곳과 **다르게 취급하는 이유**: 나머지 참조는 담당·배정 같은 메타데이터라 지워도 숫자가 변하지 않지만, 산출근거를 함께 지우면 **비목 총액이 사람을 지운 조작만으로 줄어든다**(PL-10 재계산). 금액이 조용히 바뀌는 것보다 두 단계를 요구하는 편이 낫다 — §6.6 H-8(주관기관 재지정 전 삭제 차단)과 같은 판단이다. FK는 `on delete restrict`로 두고, `count_member_references`가 산출근거 건수를 **별도 항목**으로 세어 화면이 "인건비 산출근거 N건이 이 인력을 참조합니다 → [연구비로 이동]"을 띄운다. `active=false`(참여 종료)는 그대로 허용한다 — 비활성 인력의 과거 연차 인건비는 남아 있어야 정상이다. |
| H-10 | `order`(DB `sort_order`)는 같은 부모/컨테이너 내에서 0부터 연속 정수로 재정렬(normalize)한다. 컨테이너 단위: Task는 (yearId, parentId), Year는 **project 단위**(§5.5), Stage는 project, 나머지는 project. |
| H-11 | `moveTaskToYear`: 자손 전체가 함께 이동한다(자손의 `yearId` 일괄 갱신, 부모-자식 관계는 보존). 이동 대상 노드는 새 연차의 **루트가 된다**(`parentId=null`, `order=말단+1`) — H-1을 만족하는 유일한 안전한 방법이다. **같은 과제 내 연차로만 이동 가능**하다(다른 과제로 옮기면 담당자·기관·목표 연계가 전부 남의 과제를 가리키게 된다). |
| H-12 | `moveTask(id, newParentId, newIndex)`의 `newIndex`는 **대상 노드를 제거한 뒤의** 새 부모 자식 배열에서의 0-based 삽입 위치다 (dnd-kit `arrayMove`와 동일 시맨틱). RPC가 삽입 후 H-10 normalize를 수행한다. |

### 6.7 Task 연차 이동 시 WBS 코드
WBS 코드는 항상 **연차 단위**로 다시 계산한다. 즉 각 연차의 루트가 `1`, `2`, `3`…으로 시작한다. 연차를 넘나드는 통합 번호는 부여하지 않는다.

"전체 연차 보기"(§7.4)와 `getProjectFullTree`처럼 여러 연차가 한 화면에 섞이는 곳에서는 연차 접두를 붙여 `1차-1.2` 형태로 표기한다(중복 코드 구분).

### 6.8 엑셀 예산 임포트 (예산계획 전용)

> **대원칙**: 자동 인식은 **제안(suggestion)** 이지 **확정(commit)** 이 아니다. 사용자가 미리보기에서 확인하기 전에는 어떤 데이터도 저장하지 않는다. 파싱 실패를 조용히 넘기지 않고 반드시 화면에 드러낸다.

> **범위**: v1 임포트는 **예산계획(`budget_plan`)만** 지원한다. 집행내역(정산·집행 리스트) 임포트는 설계에서 제외되었다 — 집행은 앱에서 수동 입력한다 (§7.9).

#### 6.8.1 처리 파이프라인

```
① 업로드      xlsx / xlsm / xls / csv, 최대 10MB
② 시트 선택    시트가 1개면 자동 선택. 여러 개면 S-13의 추천 점수가 가장 높은
              시트를 추천(하이라이트)하되 사용자가 확정
③ 구조 감지    헤더 행 위치, 데이터 방향(행/열), 라벨 열 범위, 금액 단위 추정
④ 열 매핑      라벨 열·연차 열 지정 (자동 추정 + 사용자 수정. 연차 열 → 연차 대응 포함)
⑤ 비목 매핑    별칭 사전(프로파일 → 부처 프리셋 → 공통) + 퍼지 매칭 + 사용자 수정
⑥ 미리보기     반영 예정 내역 + 경고 + 덮어쓸 기존 값 표시
⑦ 반영         사용자 확인 후 저장 (단일 트랜잭션)
⑧ 프로파일 저장  매핑 규칙을 ImportProfile(부처 템플릿)로 저장 (선택)
```

기존 프로파일이 있으면 ③~④를 건너뛰고 **⑤(비목 매핑)로 간다** — 자동 인식은 제안일 뿐이라는 대원칙에 따라, 프로파일을 쓰더라도 비목 매핑 확인과 미리보기는 건너뛰지 않는다. (연차 열 → 연차 대응은 프로파일의 `yearOrder` 기반 자동 제안을 ⑥에서 확인한다)

#### 6.8.2 예산계획 매트릭스 파싱

실제 서식(연구개발계획서 "사업비 총괄표"류)은 **행=비목(+세목+현금/현물), 열=연차**인 매트릭스다. 컨소시엄 과제 워크북에는 기관별 시트·검토 시트가 함께 들어 있으나, **임포트 표준 대상은 자기 기관의 총괄표 시트**(비목 × 연차 매트릭스)다. 기관별 예산 분배는 v1 범위 밖이다 (§2.2).

| 항목 | 내용 |
|---|---|
| 원본 형태 | 매트릭스 (행=비목, 열=연차) 또는 그 전치 |
| 대상 필드 | `BudgetItem.plannedAmount`, `cashAmount`, `inKindAmount` |
| 반영 방식 | **덮어쓰기** (해당 연차×비목의 계획액 교체) |
| 필수 매핑 | 비목, 금액, 연차 |
| 선택 매핑 | 현금, 현물 (행 쌍 분리 서식이면 자동 귀속) |

**구조 감지 규칙**

| # | 규칙 |
|---|---|
| S-1 | `orientation` 감지: 헤더 행에서 비목 별칭이 2개 이상 매칭되면 `'column'`(비목이 열), 라벨 열에서 매칭되면 `'row'`(비목이 행). 실측 서식은 전부 `'row'`다. **v1의 매트릭스 파서는 `'row'`만 처리하고, `'column'`으로 감지되면 조용히 진행하지 않고 명시적으로 거부한다** — 전치 서식을 행 파서에 넣으면 어긋난 결과가 "성공"으로 반영된다. 전치 서식이 실제로 나타나면 그때 파서를 확장한다. |
| S-2 | **병합 셀 carry-forward**: 병합 셀은 해제 시 좌상단 셀만 값을 가진다. 라벨 열의 빈 셀은 **바로 위 행의 값을 이어받은 것**으로 해석한다. **리셋 조건**: 어떤 라벨 열에 새 값이 나타나면 **그보다 오른쪽 라벨 열들의 carry-forward는 초기화**한다 — 상위 분류가 바뀌면 하위 라벨은 승계되지 않는다. (이 조건이 없으면 `간접비` 행이 직전 비목의 `현금` 라벨을 이어받아 오분류된다) |
| S-3 | **다중 라벨 열**: 행 라벨이 여러 열에 계층으로 분산될 수 있다 (예: 직접비 \| 인건비 \| 내부인건비 \| 현금). 라벨 열 후보들을 좌→우로 훑어 **별칭 사전에 매칭되는 가장 구체적인(오른쪽) 라벨**로 비목을 확정한다. 세목(내부인건비 등)은 별칭 사전을 통해 상위 비목으로 귀속된다. |
| S-4 | **현금/현물 행 쌍**: 같은 비목 아래 `현금`/`현물` 라벨 행이 쌍으로 나오면 각각 `cashAmount`/`inKindAmount`로 적재하고, `plannedAmount`는 둘의 합으로 계산한다. 분리 행이 없으면 전액을 `plannedAmount`에 넣고 현금/현물은 null로 둔다. **축 라벨(`CASH_INKIND_LABELS`, 부록 C)은 비목 매칭·스킵 판정 대상이 아니다** — 금액의 귀속 축만 결정한다. (스킵 목록에 넣으면 현물 금액이 통째로 유실된다) |
| S-5 | **연차 열 매핑**: 헤더에서 `N차년도` 패턴을 찾아 연차(Year)에 대응시킨다. 그 아래 연도(`YYYY`) 행은 보조 확인용으로만 쓴다. `N단계` 그룹 헤더는 무시하고 차년도 번호만 사용한다. `합계` 열은 자동 제외한다. 대응되지 않는 연차 라벨은 사용자가 지정해야 반영 가능하다. |
| S-6 | **세로 분절 라벨 결합**: 라벨이 위·아래 행에 수동으로 쪼개진 서식이 실존한다 (행안부: `연구시설‧` + `장비비(F)`, `연구재료비` + `(G)`). 라벨이 별칭에 매칭되지 않으면 **바로 아래 행의 같은 열 라벨과 결합해 재시도**한다. 결합 매칭에 성공하면 두 행을 같은 비목의 현금/현물 쌍으로 처리한다. |
| S-7 | 좌측 대분류 열의 세로쓰기 조각(`직`/`접`/`비`가 행마다 한 글자씩)은 S-3의 우측 우선 매칭 덕에 자연히 무시된다. 단독으로 `계` 같은 한 글자가 남는 행도 우측 라벨이 먼저 평가되므로 오분류되지 않는다. |
| S-8 | **동일 비목 다중 행 합산**: 같은 (연차, 비목)에 매핑되는 원본 행이 여러 개면(내부인건비·외부인건비·연구지원인력인건비가 전부 `personnel`) 축(현금/현물/미지정)별로 **합산**해 하나의 BudgetItem으로 반영한다. 행 단위 덮어쓰기가 아니다. |
| S-9 | **파일에 등장하지 않은 비목의 기존 계획액은 유지한다.** 덮어쓰기의 범위는 "파일에 등장한 (연차, 비목) 조합"뿐이다. Step 5 상단에 "이 파일에 없는 비목 N건은 유지됩니다"를 표시한다. |
| S-2' | **미매핑 라벨은 승계하지 않는다**: S-2의 carry-forward 대상은 그 라벨 열에서 **마지막으로 판정에 성공한(비목·스킵·축) 값**이다. 어느 판정에도 걸리지 못한 라벨은 다음 행으로 넘기지 않는다. 이 단서가 없으면 S-7의 세로쓰기 조각(행안부 B열 `직`/`접`/`비`)이 아래 행들로 번져, 우측 라벨이 비어 있는 행마다 `비`가 채택되어 **미매핑이 대량으로 발생**한다(실측 행안부 22·24·27행). S-7이 "우측 우선 매칭 덕에 자연히 무시된다"고 한 것은 우측에 매칭되는 라벨이 있을 때만 성립한다. |
| S-10 | **정규화 후 빈 라벨 행의 분기**: 라벨 열에 값이 있으나 정규화(I-1) 후 **전부** 빈 문자열이 되는 행은 원칙적으로 메모 행으로 건너뛴다(I-5). **단 그 행에 축 라벨(`CASH_INKIND_LABELS`)이 있고 직전에 비목이 확정된 행이 있으면 그 비목을 승계**해 축 쌍으로 처리한다(S-4). 실측(행안부)의 `연구재료비` / `(G)` 2행 분절이 이 경우다 — 승계하지 않으면 `(G)` 행의 현물 금액이 통째로 유실된다. 축 라벨이 없는 `(간접비 중 연구실 안전관리비)`·`(K=E1+F+G+H+I)`류는 승계하지 않고 건너뛴다. **"전부 빈 문자열" 판정에서 축 라벨 열은 제외한다** — 축은 S-12상 채택 대상이 아니라 별도 수집이므로, 축 라벨이 있다고 해서 이 분기를 벗어나면 안 된다. |
| S-11 | **병합 범위를 먼저 확장한다**: 파싱 전에 워크북의 병합 범위를 펼쳐 **범위 내 모든 셀에 좌상단 값을 채운 뒤** S-2 carry-forward를 적용한다. 실측(산자부) `C16:E16`처럼 라벨 열들을 가로지르는 메모 행이 있을 때, 확장하지 않으면 D·E열이 빈 셀로 남아 위 행의 축 라벨(`현물`)을 잘못 승계하고 메모 행이 금액 행으로 둔갑한다. 확장 후 S-2의 리셋 판정은 "값이 **직전 행과 달라지면**"으로 읽는다(병합으로 같은 값이 반복되는 것은 새 값이 아니다). |
| S-12 | **라벨 판정 순서(알고리즘)**: 라벨 열을 **우→좌**로 훑으며 각 셀을 부록 C 주의 1의 4단계(① 완전일치 비목 → ② 별칭 → ③ 축 라벨 → ④ 스킵 패턴)로 판정하고, **비목/스킵 중 가장 오른쪽 판정 하나를 채택**한다(S-3의 "가장 구체적인 라벨"의 구현). 축 라벨은 채택 대상이 아니라 **별도로 수집**한다(가장 오른쪽 축 라벨이 그 행의 축). 어느 열도 판정되지 않으면 S-6(아래 행 결합) → I-3(퍼지) → 미매핑(I-4) 순으로 내려간다. 라벨이 하나도 없는데 금액만 있는 행은 `건너뜀(라벨 없음)`으로 미리보기에 **남긴다** — 조용히 버리지 않는다. |
| S-13 | **시트 추천 점수**: 추천은 비목 매칭 **행 수**가 아니라 **행 비율**로 매긴다. `점수 = 비목으로 판정된 행 수 / 비어 있지 않은 행 수`, 단 **`N차년도` 헤더가 2개 이상 있는 시트만 후보**로 삼는다(총괄표는 비목 × 연차 매트릭스이므로 연차 열이 여러 개다). 행 수로 매기면 **틀린 시트를 고른다** — 실측 워크북에는 연차별 산출근거 시트(240~250행)가 함께 들어 있어 비목을 훨씬 많이 언급하기 때문이다(산자부 `2차년도_250520` 33행 vs 총괄표 19행, 행안부 `1단계_2차년도_*` 34행 vs 총괄표 11행). 비율로 매기면 두 워크북 모두 총괄표가 1위가 된다(산자부 0.655 vs 0.139, 행안부 0.379 vs 0.135). **추천은 하이라이트일 뿐이고 확정은 언제나 사용자가 한다.** |
| S-14 | **산출근거가 있는 셀은 덮어쓰지 않는다** (Phase 9). `detailCount > 0`인 (연차, 비목)은 계획액이 내역 합계로 확정된 셀이다(PL-9). 총괄표의 총액으로 덮으면 **근거와 총액이 소리 없이 어긋난다** — 화면은 여전히 산출 행을 보여주는데 합계만 남의 숫자가 된다. 미리보기에서 이 행은 `잠김`(회색, 자물쇠) 상태로 남기고 반영 대상에서 제외하며, 상단 요약에 **`잠김 N건`**을 별도로 센다. `건너뜀`과 섞지 않는다 — 건너뜀은 사용자가 고를 수 있지만 잠김은 고를 수 없다. 오류가 아니므로 반영 버튼을 막지도 않는다. 풀려면 산출근거를 먼저 지워야 한다는 안내를 붙인다. |

#### 6.8.3 비목 매핑 규칙

| # | 규칙 |
|---|---|
| I-1 | 1순위 — 정규화 후 **완전 일치**. 정규화는 **아래 순서를 지킨다**: ① 가운뎃점 전 변형 제거 (`·` U+00B7, `‧` U+2027, `ㆍ` U+318D, `•` U+2022) → ② **각주 마커 `숫자)` 제거** → ③ 괄호와 괄호 안 내용 제거(**중첩 괄호 포함**, 전각 `（）` 포함) — 세목 코드·수식 포함 (`내부인건비 (A)`→`내부인건비`, `현금 (N)`→`현금`) → ④ **라벨 내부 공백 전부 제거** (`소 계`→`소계`, `학생 인건비`→`학생인건비`) → ⑤ 별표·하이픈 제거 → ⑥ 소문자화. **②를 ③보다 먼저 하는 것이 핵심이다** — `총 인건비1) (E=A+B+C+D)`의 `1)`은 짝 없는 닫는 괄호라, 괄호 제거를 먼저 하면 `총인건비1`이 남아 스킵 패턴에 걸리지 않는다(실측 산자부 12·13행, 행안부 17행에서 확인). 중첩 괄호는 `* 간접비 비율4) (L/(N+O+P+D+R+S+T+U))` → `간접비비율`이 되어야 한다. |
| I-2 | 2순위 — **별칭 사전** 조회 (부록 C). 우선순위: ① 프로파일에 저장된 `categoryAliases`(학습분) → ② 프로파일 `ministry`의 부처 프리셋(`MINISTRY_ALIAS_PRESETS`) → ③ 공통 사전(`CATEGORY_ALIASES`). |
| I-3 | 3순위 — **퍼지 매칭**. 유사도 = `1 - levenshtein(a, b) / max(len(a), len(b))` (정규화 후 비교). 유사도 ≥ 0.8이면 후보로 제시하되 **자동 확정하지 않고** 사용자 확인을 요구한다. |
| I-4 | 매칭 실패 항목은 `'other'`로 넣지 않고 **미매핑 상태로 미리보기에 빨강 표시**한다. 사용자가 지정하거나 "이 행 건너뛰기"를 선택해야 반영 가능. |
| I-5 | `소계`, `합계`, `계`, `총계`, `직접비`, `간접비계` 등 집계 행은 자동 제외한다 (`skipRowPatterns`, 부록 C). 단 `간접비`는 실제 비목이므로 제외하지 않는다 — 정확히 일치하는 경우만 비목으로 인정. **원래 값이 있었는데 정규화(I-1) 후 빈 문자열이 되는 라벨**(예: 전체가 괄호 메모인 `(간접비 중 연구실 안전관리비)`)도 메모 행으로 간주해 건너뛴다 — S-2의 carry-forward(원래부터 빈 셀)와 구분한다. |
| I-6 | 구 비목 체계 매핑: `연구장비·재료비` → 사용자에게 `facility_equipment` / `material` 중 선택을 요구한다(자동 분할 금지). |
| I-7 | 사용자가 수동으로 지정한 매핑은 프로파일 저장 시 `categoryAliases`에 학습된다. |

#### 6.8.4 금액 파싱

| # | 규칙 |
|---|---|
| I-8 | 금액 문자열 정리: 천단위 콤마 제거, `원`/`천원`/`백만원` 접미사 제거, 공백 제거. |
| I-9 | 괄호 표기 `(1,234)`는 **음수**로 해석한다 (회계 관행). |
| I-10 | 단위 자동 추정: 헤더나 시트 어딘가에 `(단위: 천원)` 패턴이 있으면 `amountUnit` 후보로 제시한다. **자동 확정하지 않는다** — 1000배 오류는 치명적이므로 사용자가 반드시 확인한다. 실측 서식은 `(단위 : 원)`처럼 콜론 주변 공백 변형이 있다. |
| I-11 | 저장은 항상 **원 단위 정수**로 환산한다. 소수점이 나오면 반올림하고 미리보기에 표시한다. |
| I-12 | 빈 셀·`-`·`0`은 0으로 처리한다. **수식 에러 문자열(`#REF!`, `#DIV/0!`, `#VALUE!`, `#N/A`, `#NAME?` 등)과** 텍스트가 섞여 파싱 불가한 셀은 미리보기에 빨강 표시하고 반영을 막는다. 실제 서식에 `#REF!` 셀이 존재함을 확인했다. |

#### 6.8.5 안전 규칙

| # | 규칙 |
|---|---|
| I-13 | 파싱은 **서버 액션에서만** 수행한다. SheetJS를 클라이언트 번들에 포함하지 않는다. |
| I-14 | 업로드 파일은 파싱 후 즉시 폐기한다. 디스크에 저장하지 않는다(증빙 파일 관리는 v1 범위 밖). |
| I-15 | 파일 크기 10MB, 행 수 20,000행 상한. 초과 시 거부한다. |
| I-16 | 수식 셀은 **계산된 값**을 읽는다(`cellFormula: false`). 계산값이 없거나 에러 값이면 해당 셀을 파싱 실패로 처리한다 (I-12). |
| I-17 | 반영은 덮어쓰기이므로, 반영 전 해당 연차들의 기존 계획액을 **`import_snapshots` 테이블**에 jsonb로 저장한다 — `commit_import` RPC와 **같은 트랜잭션** 안에서. (각 PC의 로컬 백업 폴더는 서버 액션이 접근할 수 없다) 스냅샷은 설정 화면(§7.14)에서 확인·복원할 수 있고 **과제별** 최근 20개를 유지한다. **복원은 새 스냅샷을 만들지 않는다** — 복원분이 끼어들면 20개 창이 복원 조작으로 밀려 정작 되돌릴 임포트 이력이 사라진다. **복원이 행을 삭제하지도 않는다**: 임포트 시점에 없던 행(`existed=false`)은 `0/null/null`로 되돌릴 뿐이다. 행을 지우면 임포트 **이후**에 그 비목에 붙은 `BudgetExecution`이 cascade로 함께 사라진다(§5.12의 "연차당 12행" 불변식과도 맞다). |
| I-18 | 반영은 단일 Postgres RPC 트랜잭션으로 수행한다. 한 행이라도 실패하면 전체를 롤백한다. |

### 6.9 작업 우선순위

> **설계 원칙**: 중요도와 우선순위를 둘 다 손으로 받으면 실무에서 같은 값이 된다. **중요도만 사람이 정하고, 긴급도는 마감일에서 계산한다.** 둘을 곱해 우선순위 점수를 낸다. §7.11 리스크 매트릭스와 동일한 패턴이므로 UI를 재사용한다.

#### 6.9.1 긴급도 자동 계산

```
computeUrgency(task, today):
  if task.urgencyMode == 'manual': return task.urgencyManual
  if task.status == 'done':        return 1
  if task.dueDate is null:         return 2      # 마감이 없으면 서두를 근거가 없다

  d = daysBetween(today, task.dueDate)
  if d <  0:  return 5      # 지연
  if d <= 3:  return 5      # 임박
  if d <= 7:  return 4
  if d <= 14: return 3
  if d <= 30: return 2
  return 1
```

#### 6.9.2 우선순위 점수와 등급

```
priorityScore = importance × urgency        # 1 ~ 25
```

| 점수 | 등급 | 색상 | 의미 |
|---|---|---|---|
| 15 ~ 25 | 최우선 | `red-600` | 지금 한다 |
| 8 ~ 14 | 높음 | `amber-500` | 이번 주에 한다 |
| 4 ~ 7 | 보통 | `slate-500` | 계획대로 |
| 1 ~ 3 | 낮음 | `slate-400` | 여유 있을 때 |

#### 6.9.3 규칙

| # | 규칙 |
|---|---|
| PR-1 | 기본값은 `importance=3`, `urgencyMode='auto'`. 아무것도 입력하지 않아도 마감일만 있으면 우선순위가 나온다. |
| PR-2 | **중요도는 롤업하지 않는다.** 부모 Task의 중요도는 자식과 무관하게 독립적으로 관리한다. 진척률과 다른 점이다. |
| PR-3 | 성과목표(`deliverableIds`) 또는 기술목표(`techTargetIds`)에 연계된 작업은 생성 시 `importance` 기본값을 **4로 제안**한다. 강제하지 않고 사용자가 바꿀 수 있다. |
| PR-4 | `urgencyMode='manual'`로 고정하면 마감일이 바뀌어도 긴급도가 변하지 않는다. UI에 핀 아이콘을 표시해 고정 상태임을 명확히 한다. |
| PR-5 | `status='blocked'`인 작업은 점수와 무관하게 대시보드 "주의 필요"에 항상 포함한다. 막혀 있으면 우선순위가 높아도 진행할 수 없다. |
| PR-6 | `status='done'`인 작업은 우선순위 표시를 흐리게 하고 정렬에서 최후순위로 보낸다. |
| PR-7 | `priorityScore`와 `computedUrgency`는 **저장하지 않는다.** 마감일이 바뀌면 자동으로 따라 변해야 하기 때문이다. |
| PR-8 | **WBS 트리의 기본 정렬은 `order`(계층 순서)를 유지한다.** 계층 구조가 우선순위 때문에 흐트러지면 안 된다. 우선순위 정렬은 매트릭스 뷰와 대시보드에서만 적용한다. |
| PR-9 | 매트릭스 뷰와 "오늘 집중할 작업"에는 **리프 Task만** 포함한다. 부모는 묶음일 뿐 실행 단위가 아니다. |
| PR-10 | To-Do는 기존 3단계 `priority`를 유지하며 우선순위 매트릭스에 포함하지 않는다. 가벼운 할 일에 매트릭스는 과하다. |


---

### 6.10 예산 제안 — 산출근거 계산·집계·검증

> **§6.4가 "쓴 돈"이라면 §6.10은 "쓸 돈의 근거"다.** 방향이 반대다: §6.4는 집행을 더해 올라가고, §6.10은 산출 행을 더해 비목 총액을 **만들어낸다**.

#### 6.10.1 산출 행 금액 (PL-1~PL-5)

| # | 규칙 |
|---|---|
| PL-1 | **`formula = 'personnel'`**: `금액 = member.annualSalary × (참여율 / 100) × (참여개월 / 12) + adjustment`. 참여율·참여개월은 `factors`에서 `isPercent` 여부로 구분해 읽는다. |
| PL-2 | **중간 반올림을 하지 않는다.** 특히 월액(`annualSalary / 12`)을 먼저 반올림해서는 안 된다. 실측 검증: 박선욱 `74,000,000 / 12 = 6,166,666.67`을 반올림해 `6,166,667 × 0.28 × 9`로 계산하면 `15,540,000.84`가 되지만, 연봉 기준 `74,000,000 × 0.28 × 0.75`는 정확히 `15,540,000`이다. 서식의 월액 열은 **표시용 반올림**이지 계산 입력이 아니다. (§6.1 P-8·§6.2 D-5·§6.4 B-1과 같은 함정) |
| PL-3 | **`formula = 'quantity'`**: `금액 = unitPrice × Π(정규화된 인자) + adjustment`. 인자 정규화는 `isPercent ? value / 100 : value`. `factors`가 빈 배열이면 곱이 1이므로 `금액 = unitPrice + adjustment`가 된다 — 산식 없이 금액만 적는 간접비 세목이 이 경우다. |
| PL-4 | **최종 결과만 정수로 반올림한다** (`Math.round`). 조정액을 더한 **뒤에** 반올림한다. 금액은 언제나 원 단위 정수다(CLAUDE.md 절대규칙 4). |
| PL-5 | 계산 결과가 음수면 **0으로 자르지 않고 그대로 둔다.** 대신 그 행을 오류로 표시한다 — 조정액을 잘못 넣은 것이지 0원짜리 행이 아니다. 저장은 허용하고 화면에서 드러낸다(§6.8의 대원칙과 같은 태도: 조용히 고치지 않는다). |

#### 6.10.2 집계 (PL-6~PL-10)

| # | 규칙 |
|---|---|
| PL-6 | **세목 소계** = 그 세목에 속한 행 금액의 합. 축(현금/현물)별로도 따로 낸다. |
| PL-7 | **비목 셀 합계** = 그 (연차, 비목)의 모든 행 금액의 합. `cashAmount` = `axis='cash'` 행의 합, `inKindAmount` = `axis='in_kind'` 행의 합, `plannedAmount` = 둘의 합. |
| PL-8 | **합계는 행 금액을 더한다 — 반올림된 행 금액을 더한다.** PL-4에서 각 행이 이미 정수이므로 합계에 추가 반올림이 없다. 합계를 먼저 실수로 구한 뒤 반올림하면 화면의 행 금액을 손으로 더한 값과 어긋난다. (§6.4 B-1의 "합계 집행률은 개별 평균이 아니다"와 같은 계열의 실수다) |
| PL-9 | **잠금**: `detailCount > 0`인 셀은 매트릭스에서 `plannedAmount`·`cashAmount`·`inKindAmount`를 직접 편집할 수 없다. 잠긴 셀을 클릭하면 편집 필드 대신 **산출근거 패널**이 열린다. 마지막 행을 지워 `detailCount`가 0이 되면 잠금이 풀리고 **직전 합계가 그대로 남는다** — 0으로 되돌리지 않는다. 근거를 지웠다고 예산이 사라져야 할 이유가 없고, 사용자가 이어서 손으로 고칠 수 있어야 한다. |
| PL-10 | **저장 값과 합계의 일치는 트랜잭션 불변식이다.** `BudgetDetail`을 추가·수정·삭제하는 모든 RPC는 **같은 트랜잭션 안에서** 해당 `budget_items` 행의 세 금액을 다시 계산해 갱신한다. <br>이것은 CLAUDE.md의 "파생 값은 저장하지 않는다"에서 **의도적으로 벗어난 지점**이다(PL-10a와 함께 둘뿐이다). 근거: `plannedAmount`는 이미 §6.4 집행률·§7.2 대시보드·§6.8 임포트 스냅샷·§8.7 백업이 **읽고 있는 1급 필드**다. 조회 시점 계산으로 바꾸면 그 소비자를 전부 고쳐야 하고, 하나라도 빠뜨리면 화면마다 다른 예산이 보인다. 트랜잭션 안에서만 갱신되므로 드리프트가 구조적으로 불가능하며, **불변식을 통합 테스트로 고정한다**(행 추가·수정·삭제 후 `budget_items` 재조회 대조). |
| PL-10a | **금액 산식은 `lib/budget-plan.ts` 한 곳에만 있다.** 서버 액션이 PL-1~PL-5로 `amount`를 계산해 RPC에 넘기고, **RPC는 더하기만 한다**(`sum(amount)`를 축별로). PL/pgSQL에 산식을 다시 구현하지 않는다. <br>근거: 같은 규칙이 두 곳에 생기면 반드시 어긋난다(§7.9.1 Step 4의 O-4와 같은 판단). 특히 반올림은 JS `Math.round`와 SQL `round()`가 **음수 .5와 부동소수점 경계에서 갈린다** — 금액에서 1원 차이는 합계 검증을 통과하지 못한다. 대가로 `amount`가 저장되지만(PL-D7), 이는 산식 이중화보다 훨씬 작은 위험이다. |
| PL-10b | **`Member.annualSalary`가 바뀌면 그 인력을 참조하는 인건비 행의 `amount`와 관련 `budget_items`를 같은 트랜잭션에서 다시 계산한다.** 연봉은 산출의 **근거**이므로 근거가 바뀌면 결과도 바뀌는 것이 맞다. <br>단 **조용히 바꾸지 않는다**: `updateMember`가 연봉을 바꾸려 할 때 영향받는 산출근거 건수와 변경 전후 금액을 먼저 돌려주고, 사용자가 확인해야 저장한다(§7.10). 이 규칙이 없으면 인사 정보 수정이 협의 끝난 예산을 말없이 흔든다. <br>참여율·참여기간은 `BudgetDetail`에 있으므로 이 경로와 무관하다(§5.11). |

#### 6.10.3 지침 검증 (PL-11~PL-16)

계산이 아니라 **경고**다. 저장을 막지 않는다.

| # | 규칙 |
|---|---|
| PL-11 | **수정인건비(E1)** = `personnel` 비목에서 **`personnel_support`(연구지원인력인건비) 세목을 뺀 금액** + `student_personnel` 비목 전체. 둘 다 현금 + 현물. 실측 서식의 `수정인건비2) (E1=A+B+D)`를 그대로 옮긴 것이다 — A(내부인건비)·B(외부인건비)·D(학생인건비)는 들어가고 **C(연구지원인력인건비)만 빠진다.** 이 값이 PL-12의 기준액이다. <br>**세목 단위로 빼야 한다는 점이 핵심이다.** 우리 12비목 체계에서 연구지원인력인건비는 `personnel` 비목의 세목(`personnel_support`)이므로, 비목 단위로 더하면 C가 섞여 들어가 E1이 커지고 **연구수당 비율이 실제보다 작게 나와 한도 초과를 놓친다.** 실측 서식은 C가 0이라 부록 B.7로는 이 오류가 드러나지 않는다 — **C > 0인 케이스를 단위 테스트로 따로 만든다.** <br>**PL-13의 간접비 기준액과 혼동하지 마라**: 서식의 `L/(N+O+P+D+R+S+T+U)`에서 P(연구지원인력인건비 현금)는 **포함된다.** E1은 C를 빼고 간접비 기준액은 C를 넣는다 — 규정이 그렇게 다르다. |
| PL-12 | **연구수당 비율** = `allowance 비목 합계 / E1 × 100`. `Project.allowanceRateLimit`(기본 20)를 넘으면 경고. E1이 0이면 비율을 내지 않는다(0으로 나누지 않는다) — 배지를 띄우지 않고 `—`로 표시한다. |
| PL-13 | **간접비 비율** = `indirect 비목 합계 / 직접비 현금 기준액 × 100`. 기준액 = 해당 연차의 `personnel`·`student_personnel`·`facility_equipment`·`material`·`activity`·`allowance` 비목의 **현금(cash)** 합계. 실측 산자부 총괄표의 `* 간접비 비율4) (L/(N+O+P+D+R+S+T+U))`을 그대로 옮긴 것이며 부록 B.7에서 `0.9622%`로 검증한다. **국제공동연구개발비·위탁연구개발비·연구개발부담비는 기준액에서 빠진다.** `Project.indirectRateLimit`가 null이면 비율은 표시하되 경고는 띄우지 않는다. |
| PL-14 | 한도값(`allowanceRateLimit`·`indirectRateLimit`)은 **과제별 사용자 입력**이다. 연구수당 20%만 혁신법 공통이라 기본값으로 넣고, 간접비 고시율은 부처·기관 유형(영리/비영리/대학)마다 달라 기본값을 두지 않는다. 입력 범위는 **0 이상 100 이하**다 — 둘 다 백분율 한도이고, 기준액의 100%를 넘는 한도는 한도가 아니다. `null`(미입력)은 "이 검사를 하지 않는다"는 뜻이며 0과 다르다. |
| PL-15 | 위반은 **경고 배지**로만 표시하고 저장·반영을 막지 않는다. 협의 중인 계획이 일시적으로 한도를 넘는 것은 정상이며, 막으면 사용자가 도구 밖(엑셀)으로 나간다. |
| PL-16 | **부처별 고시율 표를 코드에 넣지 않는다.** 부록 C(비목 별칭)는 서식 *표기*의 사전이라 틀려도 사용자가 마법사에서 고칠 수 있지만, 고시율은 **금액을 직접 좌우하는 규제 값**이고 개정된다. 이 문서가 출처 없이 숫자를 지어내면 그것이 조용히 틀린 예산이 된다. 값은 사용자가 넣고, 도구는 계산과 비교만 한다. |

#### 6.10.4 순수 함수 배치

`lib/budget-plan.ts`에 둔다. 부수효과 없이 아래를 전부 다루고 **단위 테스트를 반드시 작성한다** (§11 필수 1에 편입).

```
computeDetailAmount(detail, member?)        → PL-1~PL-5
aggregateDetails(details, members)          → PL-6~PL-8 (세목 소계 · 셀 합계 · 축별 분리)
evaluateBudgetRules(yearTotals, project)    → PL-11~PL-14 (비율 · 위반 여부)
```

`yearTotals`는 비목별 금액에 더해 **`personnelSupportTotal`**(그 연차 `personnel_support` 세목의 현금+현물 소계)을 함께 싣는다. PL-11이 E1에서 그것만 빼야 하는데 비목 단위 합계만으로는 뺄 수 없기 때문이다. 간접비 기준액(PL-13)은 이 값을 빼지 **않는다**.

`lib/budget.ts`(§6.4 집행률)와 **합치지 않는다** — 방향이 반대인 두 규칙이 한 파일에 있으면 기준액 정의가 섞인다.

---

### 6.11 산출근거 시트 임포트 (Phase 10)

> **§6.8이 총괄표(셀 총액)를 들여온다면 §6.11은 산출근거(행 내역)를 들여온다.** 대상 계층이 다르고, 반영 결과도 다르다 — §6.8은 `budget_items`를 직접 쓰지만 §6.11은 `budget_details`를 만들고 총액은 PL-10이 알아서 따라온다.

> **§6.8의 대원칙이 그대로 적용된다**: 자동 인식은 **제안**이지 **확정**이 아니다. 사용자가 미리보기에서 확인하기 전에는 어떤 데이터도 저장하지 않는다.

**재사용**: `lib/import/`의 I-1 정규화·I-3 퍼지·I-8~I-12 금액 파싱·S-11 병합 확장·부록 C 비목 별칭을 **그대로 쓴다.** 새 파서를 만들지 않는다. 새로 필요한 것은 **행 구조 해석**(섹션·비목·세목·컬럼 헤더의 계층)뿐이다.

#### 6.11.1 시트 구조 — 실측에서 확인된 형태

```
1. 직접비 소요명세                      ← 섹션 (D-1)
   - 인건비                             ← 비목 (D-2)
     [컬럼 헤더: 성명·직위·연봉·참여율·참여기간·현금·현물·계]
     … 데이터 행 …
     합계 / 합계 / 소 계                ← 소계 3단 (D-5)
   다. 연구시설·장비비                  ← 비목
     ① 연구시설·장비 구입·설치비        ← 세목 (D-3)
       [컬럼 헤더: 구분·품명·규격·단위·수량·단가·현금·현물·합계·비고]
       … 데이터 행 …
       소계
     ② 연구시설 장비 임차비
     …
2. 간접비 소요명세                      ← 섹션
   가. 인력지원비                       ← **비목이 아니라 indirect의 세목** (D-2 주의)
   나. 연구지원비
   다. 성과활용지원비
```

**컬럼 형태는 7가지로 수렴한다** (실측 2종 공통). 위치가 아니라 **헤더 텍스트로** 매핑한다(D-7).

| # | 쓰이는 곳 | 컬럼 |
|---|---|---|
| 1 | 시설·장비비 ①~④ | 구분·품명·규격·단위·수량·단가·총액_현금·총액_현물·총액_합계·비고 |
| 2 | 재료비 ①~③, 외주용역, 국제공동 | 품명·산출내역·규격·단위·수량·단가·총액_현금·총액_현물·총액_합계·비고 |
| 3 | 활동비 대부분, 연구수당, 간접비 세목 | 내역·산출내역(단가·회·월)·합계·비고 |
| 4 | 회의비 | 내역·산출내역(단가·회)·산출 비용·합계·비고 |
| 5 | 출장비 | 내역·직급·산출내역(인원·횟수·산출비용)·합계·비고 |
| 6 | 연구실 운영비 | 내역·단가·횟수·산출내역·산출비용·합계·비고 |
| 7 | 연구인력 지원비 | 내역·내역·인원·횟수·산출비용·합계·비고 |

인건비는 **부처마다 열 위치가 다르다**(산자부 `인력구분|성명|…`, 행안부 `구 분|번호|인력 구분|성명|…`). 위치를 고정하면 반드시 깨진다.

#### 6.11.2 구조 감지 (D-1~D-7)

| # | 규칙 |
|---|---|
| D-1 | **섹션 경계**: 정규화(I-1) 후 `1직접비소요명세` / `2간접비소요명세`에 매칭되는 행. **섹션 밖의 행은 전부 무시**한다 — 시트 상단에 총괄표·요약 블록이 있고(실측 1~58행) 그것은 §6.8의 대상이지 여기의 대상이 아니다. 섹션이 하나도 없으면 산출근거 시트가 아니므로 **명시적으로 거부**한다. |
| D-2 | **비목 헤더**: 한글 순서 접두어(`가.`~`차.`) 또는 `- ` 접두어를 떼고 부록 C 비목 별칭으로 판정한다. **섹션 문맥이 우선한다** — `2. 간접비 소요명세` 아래의 `가./나./다.`는 비목이 아니라 `indirect` 비목의 **세목**이다(부록 A.5의 `indirect_hr`·`indirect_support`·`indirect_outcome`). 이 문맥을 무시하면 인력지원비가 인건비로 둔갑한다. |
| D-3 | **세목 헤더**: 원문자 번호(`①`~`⑫`) + 라벨. **번호와 라벨을 둘 다 본다.** 번호만 믿으면 서식이 순서를 바꿨을 때 조용히 틀리고, 라벨만 믿으면 실측 변형(`⑪ 그 밖의 비용` vs `⑪ 기타`, `⑦ 연구실 운영비(삭감)`)을 놓친다. 둘이 어긋나면 자동 확정하지 않고 **사용자에게 확인**을 요구한다. 라벨 매칭은 부록 C.2 세목 별칭 사전을 쓴다. |
| D-3a | **세목 헤더가 없는 비목의 세목**: 실측에서 인건비·연구수당·국제공동연구개발비는 `①`~`⑪` 없이 비목 아래 바로 표가 온다. 파서는 이때 세목을 **`null`로 둔다** — 시트에 없는 값을 지어내지 않는다. 세목을 정하는 것은 그 다음 층(§6.11.6의 `detail-preview.ts`)의 몫이며 규칙은 이렇다: <br>① 부록 A.5 프리셋에 세목이 **`default` 하나뿐인 비목**(연구수당·국제공동·위탁·부담비)은 `'default'`로 확정한다. 고를 것이 없으므로 확인을 묻지 않는다. <br>② **인건비는 프리셋 세목이 3종**(`personnel_internal`·`personnel_external`·`personnel_support`)이라 자동 확정하지 않는다. **행에 `내부인건비`/`외부인건비`/`연구지원인력인건비` 라벨 열이 있으면 그것으로 정하고**(실측 행안부는 `C`열에 있다), 없으면 **`personnel_internal`을 제안**하되 마법사에서 바꿀 수 있게 한다(실측 산자부가 이 경우이고, 그 총괄표도 내부인건비만 쓴다). 조용히 확정하지 않는다 — §6.8 대원칙. <br>③ 학생인건비도 세목이 2종(`student_general`·`student_managed`)이라 같은 방식으로 다룬다. |
| D-4 | **컬럼 헤더 행**: 세목(세목이 없는 비목이면 비목) 헤더 다음에 나오는 행 중, 헤더 힌트 어휘(`품명`·`규격`·`단위`·`수량`·`단가`·`총액`·`합계`·`비고`·`성명`·`직위`·`참여율`·`참여기간`·`내역`·`인원`·`횟수`·`구분`)가 **3개 이상**인 첫 행. 헤더가 **2행에 걸쳐 병합**될 수 있으므로(`산출내역` 아래 `단가|회|월`) S-11의 병합 확장을 먼저 적용하고 두 행을 합쳐 읽는다. |
| D-5 | **데이터 행의 끝**: `소계`·`합계`·`계`(정규화 후, `SKIP_ROW_PATTERNS` 재사용)는 데이터가 아니라 **건너뛴다.** 단 **소계에서 읽기를 멈추지 않는다** — 인건비는 `합계`(기존인력) → `합계`(신규채용) → `소 계`의 3단 구조이고 실측 행안부에는 `합 계`가 하나 더 있다. 다음 **비목·세목 헤더 또는 섹션 경계**를 만날 때까지 계속 읽는다. |
| D-6 | **오른쪽 메모 열은 무시한다**: 컬럼 헤더가 있는 열 범위를 벗어난 값은 데이터가 아니다. 실측에 `N`~`P`열 메모(`서울역↔실증지`, `KTX 금액`, `스마플`)가 있으며 이것을 읽으면 금액 열로 오인된다. |
| D-7 | **컬럼은 위치가 아니라 헤더 텍스트로 매핑한다.** 인건비 열 위치가 부처마다 다르다. 매핑 결과는 미리보기에 드러내 사용자가 고칠 수 있어야 한다. <br>**"고칠 수 있다"는 통로가 실제로 있어야 한다**: `DetailImportDraft.columnRoleOverrides`(블록 키 → 열 인덱스 → role 또는 `null`)가 그 통로이고, 서버가 블록 키·열 인덱스를 **검증해 모르는 것은 거부**한다. 화면에 드롭다운만 두고 draft에 담지 않으면 **조용한 무동작**이 된다 — 사용자는 고쳤다고 믿고 결과는 그대로다. <br>이 통로가 없으면 role 사전이 모르는 헤더가 나온 순간 **우회 수단 없이 임포트가 막힌다.** 실측에서도 `실지급액\n(연봉)` 하나 때문에 인건비 전체가 0원이 될 뻔했다 — 사전을 넓히는 것과 별개로 사람이 뚫을 구멍이 있어야 한다(I-4와 같은 태도). <br>**헤더 텍스트는 I-1 정규화가 괄호를 지운 뒤에도 살아남아야 한다**: 실측 인건비 연봉 열은 `실지급액\n(연봉)`이라 정규화하면 **`실지급액`**만 남는다. `연봉`만 찾으면 두 부처 모두 매핑에 실패해 `formulaAmount = 0`이 되고 **조정액이 금액 전액을 떠안아** D-8의 의미가 사라진다(지동민 −270,000이 아니라 40,050,000). role 사전은 정규화 **후**의 형태를 기준으로 만든다. <br>**헤더가 3행에 걸칠 수 있다**: 실측 행안부 인건비는 64행(`참여율`/`참여기간(월)`) + 65행(`(%)`/`©`) + 66행(`(A)`/`현금`/`현물`/`계`)의 3단이다. 2행까지만 묶으면 행안부에서 `rate`·`period`가 통째로 빠져 **두 부처의 role 맵이 갈린다.** |
| D-7a | **컬럼 헤더를 *찾는* 단계에서 메모 열을 보지 마라.** D-6은 헤더 열 범위 밖을 무시하라고 정하지만, 헤더를 찾기 전에는 그 범위를 모른다. 시트 **전체 폭**에서 "숫자 셀이 있으면 헤더가 아니다"를 판정하면 실측 행안부 `⑥ 소프트웨어 활용비`의 메모(`O206=1`·`O207=1`) 때문에 헤더 후보 두 줄이 모두 탈락하고, 그 블록이 통째로 `no-column-header`가 되어 **행 0건 · 소계 미수집 · `합계($)`의 D-10 통화 경고 미발화**가 된다. <br>헤더 판정은 **연속된 라벨 구간**(왼쪽부터 힌트 어휘가 이어지는 열 범위)에서만 숫자 셀을 본다. 그 오른쪽의 떨어진 메모 열은 판정에 넣지 않는다. |

#### 6.11.3 행 → BudgetDetail 변환 (D-8~D-10, D-21)

| # | 규칙 |
|---|---|
| D-8 | **파일의 `합계` 열이 진실이다.** 읽어 온 근거 필드로 PL-1/PL-3을 계산한 값이 파일의 합계와 다르면, **차액을 `adjustment`에 넣어** 최종 금액이 파일과 일치하게 만든다. 부록 B.7에서 확립한 `조정액 = 최종 금액 − 산식 결과` 정의 그대로다. <br>이 규칙이 없으면 임포트한 예산이 원본 서식과 몇 원씩 어긋나고, 사용자는 어느 쪽이 맞는지 알 수 없다. 차액이 0이 아니면 미리보기에 **조정액으로 흡수했음을 표시**한다 — 조용히 넣지 않는다. |
| D-8a | **인건비의 산식 기준 연봉은 `Member.annualSalary`(명부)다 — 파일의 연봉이 아니다.** 파일 연봉으로 역산하면 저장된 `amount`가 **재계산 결과와 어긋난다**: 저장 이후 그 행을 건드릴 때마다 PL-D7이 명부 연봉으로 다시 계산하므로, 임포트 직후 값과 첫 편집 후 값이 말없이 달라진다. <br>명부 기준으로 역산하면 `amount = 명부산식 + adjustment = 파일 합계`이고, 나중에 재계산해도 같은 값이 나온다 — **저장값과 재계산값이 항상 일치한다.** <br>파일 연봉 ≠ 명부 연봉이면 D-14대로 **미리보기에서 경고**하고, 연봉 자체는 고치지 않는다(PL-10b가 확인을 요구하는 별도 조작이다). **명부 연봉이 비어 있으면(`null`) 금액을 0원으로 반영하고 `adjustment`도 0으로 둔다.** PL-1이 단가를 모를 때 조정액을 더하지 않고 `missingSalary`로 끝내기 때문이며, 파일 값을 맞추려고 조정액에 금액 전부를 넣으면 **나중에 명부 연봉을 채우는 순간 `산식 + 파일금액`이 되어 금액이 두 배가 된다** — 조용히 터지는 지뢰다. 산식을 우회해 파일 값을 맞추는 것도 PL-10a 위반이다. <br>대신 미리보기에 **`파일 X원 → 반영 0원 (연봉 미입력)`**을 명시하고 인력 화면 링크를 준다. 사용자가 명부 연봉을 채운 뒤 다시 임포트하면 제대로 들어간다. <br>부록 B.7.1·B.8.4의 실측 케이스는 두 연봉이 같아 이 분기가 드러나지 않는다 — **파일 연봉 ≠ 명부 연봉인 단위 테스트를 따로 만든다.** |
| D-9 | **현금/현물 축**: `총액_현금`·`총액_현물` 열이 있으면 그 값으로 축을 정하고, 둘 다 값이 있으면 **행을 둘로 나눈다**(§5.17은 행마다 축이 하나다). 합계 열만 있는 세목(활동비 대부분·연구수당·간접비)은 **현금으로 제안**한다 — 실측 서식이 전부 현금이다. **자동 확정하지 않는다**: 미리보기에 축을 표시하고 사용자가 바꿀 수 있다. |
| D-10 | **통화 기호 감지**: 헤더나 셀에 원화가 아닌 통화 기호(`$`, `¥`, `€` 등)가 보이면 — 실측 행안부 `⑥ 소프트웨어 활용비`의 `합계($)` — **경고하고 사용자 확인을 요구한다.** 환율을 앱이 지어내지 않는다. 확인 없이는 그 세목을 반영하지 않는다. I-10(단위 1000배 오류)과 같은 계열의 치명적 오류다. |
| D-22 | **엑셀 백분율 서식 셀은 값이 100배 작다.** 실측 산자부 참여율 `H65`는 화면에 `10.0%`로 보이지만 저장된 값은 **`0.1`**이다. 그대로 `isPercent` 인자에 넣으면 PL-1이 다시 100으로 나눠 **금액이 1/100이 된다**(지동민 40,320,000 → 403,200). <br>`RawCell`(§5.12.2 경계 타입)에 **`percentFormat?: boolean`**을 추가한다. 어댑터가 SheetJS의 표시 서식을 보고 채우고, **값 자체는 원본 그대로 넘긴다** — 어댑터가 값을 바꾸면 `RawCell.value`가 원본과 달라져 다른 규칙이 전부 흔들린다. 파서는 `percentFormat === true`인 셀을 읽을 때만 **100을 곱해** 사람이 보는 숫자로 되돌린다. <br>휴리스틱("1 이하면 ×100")을 쓰지 않는다 — 참여율 1%가 정수 `1`로 저장된 서식에서 100%로 둔갑한다. 서식 정보가 답을 알고 있으므로 추측할 이유가 없다. |
| D-23 | **비목 합계 줄의 위치는 서식 안에서 흔들린다.** 실측에서 세 가지가 다 나온다: 비목 헤더와 **같은 행**(`C96="다. 연구시설·장비비" K96="합계" L96=0`), **바로 다음 행**(`C149="마. 연구활동비"` → `K150="합계" L150=27,020,000`), **바로 앞 행**(`K246="합계"` → `C247="자. 연구수당"`). <br>라벨이 `합계`뿐이고 금액이 있는 줄은 **가장 가까운 비목 헤더에 귀속**시킨다. 앞 행에 있으면 **직전 세목 블록의 소계로 편입하지 않는다** — 편입하면 그 세목의 소계 대조(D-18)가 엉뚱한 값과 비교된다. <br>이 줄은 컬럼 헤더가 없어도 읽어야 한다(D-4의 헤더 3개 기준에 걸리지 않는다). 비목 합계는 D-18의 대조 대상이지 데이터가 아니므로, **`subtotals`에만 담고 데이터 행으로 만들지 않는다.** |
| D-24 | **비목 헤더 행에 금액이 있어도 비목 헤더다.** D-23의 첫 경우(`C96="다. 연구시설·장비비" K96="합계" L96=0`)가 그렇다. "숫자 셀이 있으면 구조 행이 아니다"라는 판정을 비목 헤더에 적용하면 **비목이 통째로 사라지고**, 그 아래 세목들이 직전 비목(인건비)의 세목으로 붙어 **시설·장비비가 인건비로 계상된다.** 실측은 그 금액이 0원이라 총액이 안 흔들렸지만 0이 아닌 서식에서는 조용히 틀린다. <br>구조 행 판정에서 숫자 셀을 보는 것은 **컬럼 헤더 행**(D-4)에만 적용한다 — 그쪽은 데이터 행이 힌트 낱말을 품어 표가 쪼개지는 것을 막으려는 조건이다. |
| D-25 | **세로 병합된 데이터 행을 두 번 읽지 않는다.** 실측 `⑤ 국내출장비`는 `C186:C187`…`K186:K187`로 병합된 **한 줄**이고 원본 값은 186행에만 있다. S-11의 병합 확장이 187행에도 값을 펼치므로, 그대로 읽으면 **같은 행을 두 번 세어 금액이 두 배**가 된다(1,200,000 → 2,400,000, 총액 298,510,000 → 299,710,000). <br>데이터 행을 읽을 때 **세로 병합 범위의 시작 행에서만** 행을 만든다. 병합 범위 안쪽 행은 건너뛴다. S-11의 확장은 라벨 승계를 위한 것이지 행 복제를 위한 것이 아니다. |
| D-21 | **금액 0인 행의 처리**: <br>① 근거 필드(품명·내역·단가·수량 등)가 **전부 비어 있고** 금액도 0이면 서식의 빈 줄이므로 **조용히 버린다**. 실측 서식은 세목마다 빈 줄을 3~5개씩 깔아 둔다. <br>② 이름이나 단가는 있는데 **금액이 0**인 행은 사람이 적어 둔 자리다(실측 `⑪ 그 밖의 비용`의 `문헌구입비`·`논문게재료`·`학회, 세미나 참가비`, 단가 10,000,000만 있는 `공인인증시험`). **기본은 건너뜀으로 제안하되 미리보기에 남기고**, 사용자가 포함시킬 수 있다. 조용히 버리지 않는다(S-12와 같은 태도) — 0원 계상 자리를 앱에도 남기고 싶은 사용자가 있다. |

#### 6.11.4 성명 → Member 매칭 (D-11~D-14)

| # | 규칙 |
|---|---|
| D-11 | 성명을 정규화(I-1) 후 그 과제의 Member와 **완전일치**로 대조해 자동 제안한다. 미매칭 성명은 마법사에서 ① 기존 인력 선택 ② **새 인력으로 생성** ③ 행 건너뛰기 중 하나를 고른다 (I-4와 같은 형태). |
| D-12 | **새 인력은 반영 시점에 같은 트랜잭션에서 만든다.** 미리보기 단계에서 Member를 만들지 않는다 — 반영을 취소했는데 인력 명부만 더러워지면 안 된다. 연봉·직위는 파일에서 가져오고, `hireType`은 파일의 인력구분(`기존인력`/`신규채용`)에서 정한다. |
| D-13 | **동명이인은 자동 매칭하지 않는다.** 같은 이름이 명부에 둘 이상이면 소속 기관·직위를 함께 보여 주고 사용자가 고른다. |
| D-14 | **임포트가 기존 Member의 `annualSalary`를 고치지 않는다.** 파일의 연봉이 명부와 다르면 미리보기에 **양쪽 값을 나란히 보여 주고 경고**하되, 저장은 파일 값을 `BudgetDetail` 계산에만 쓴다. 연봉 변경은 PL-10b가 확인을 요구하는 별도 조작이며, 임포트가 그것을 우회하면 다른 연차의 금액까지 말없이 흔든다. |

#### 6.11.5 반영 (D-15~D-20)

| # | 규칙 |
|---|---|
| D-15 | **기존 산출근거가 있는 셀은 기본 건너뜀이다.** 미리보기에 `기존 N행 있음`으로 드러내고, 사용자가 셀별로 **`[기존 삭제 후 교체]`**를 명시적으로 고를 수 있다. 조용히 덮지 않는다(S-14와 같은 태도). 교체를 고르면 그 셀의 기존 행을 전부 지우고 파일 내용으로 바꾼다 — 부분 병합은 없다. |
| D-15b | **교체로 지정했는데 그 비목에 넣을 행이 하나도 없으면 거부한다.** 내용 없는 삭제는 "기존 행을 전부 지우고 아무것도 넣지 않는" 조작이 되고, 그 셀은 PL-9로 **총액만 직전 값에 얼어붙는다** — 근거는 사라졌는데 금액은 남는 무음 파괴다. 셀을 비우고 싶으면 산출근거 패널에서 행을 지운다(그러면 PL-9가 의도대로 동작한다). |
| D-15a | **미리보기 이후 커밋 전에 셀 상태가 바뀐 경우**(다른 사람이 그 사이 산출근거를 추가): 교체로 지정되지 않은 셀은 **건너뛰고 건수를 반환**한다. 전체를 롤백하지 않는다 — 한 셀 때문에 나머지 수십 행을 버리는 것이 더 나쁘고, 건너뜀은 데이터를 잃지 않는다(S-14와 같은 판단). <br>다만 **결과에 반드시 드러낸다**: 미리보기가 `신규 19행`이라 했는데 실제로는 건너뛰었다면 사용자가 알아야 한다. 반영 결과에 `건너뜀(반영 중 추가됨) N셀`을 별도로 센다. <br>교체로 지정된 셀은 지정대로 교체한다 — 그 사이 늘어난 행도 함께 지워지지만, D-17 스냅샷이 전부 담고 있다. |
| D-16 | 반영은 **단일 트랜잭션**이다. 한 행이라도 실패하면 전체를 롤백한다(I-18과 같다). `budget_items` 총액은 PL-10 불변식이 같은 트랜잭션에서 재계산한다 — 임포트가 총액을 직접 쓰지 않는다. |
| D-17 | 반영 전 **`import_snapshots`에 스냅샷**을 남긴다(I-17과 같은 트랜잭션). 산출근거 임포트는 행을 지울 수 있으므로(D-15 교체) 되돌릴 길이 반드시 있어야 한다. 스냅샷은 `budget_items` 계획액뿐 아니라 **삭제되는 `budget_details` 행 전체**(DB `snake_case` 원본)를 담는다. `details` 키는 비어 있어도 **항상 존재**한다 — 키 유무로 스냅샷 종류를 판별하기 때문이다. |
| D-17a | **복원은 산출근거 행을 지운다 — I-17의 명시적 예외다.** I-17은 "복원이 행을 삭제하지 않는다"고 정했는데, 그 근거는 `budget_items` 행을 지우면 임포트 **이후**에 붙은 `BudgetExecution`이 cascade로 함께 사라지기 때문이었다. 산출근거는 사정이 다르다 — **지우지 않으면 되돌릴 수 없다.** 교체로 늘어난 행을 남긴 채 스냅샷 행을 넣으면 금액이 두 배가 된다. <br>따라서 `details` 키가 있는 스냅샷의 복원은 **그 (연차, 비목)의 현재 `budget_details`를 전부 지우고** 스냅샷 행을 `id` 보존으로 되살린 뒤 PL-10으로 총액을 재계산한다. `budget_items` 행 자체는 여전히 지우지 않는다(I-17 원칙 유지 — 집행 내역은 보존된다). <br>`details` 키가 **없는 기존 스냅샷의 복원 동작은 한 글자도 바뀌지 않는다.** 복원이 새 스냅샷을 만들지 않는 것도 그대로다(I-17). |
| D-17b | **복원은 임포트가 만든 Member를 지우지 않는다.** 스냅샷은 인력을 담지 않는다(D-17의 범위는 `budget_items`와 `budget_details`다). 인력은 산출근거보다 오래 사는 독립적인 존재이고 — 다른 연차·다른 비목의 행이 이미 그 사람을 참조할 수 있으며 H-9a가 그 삭제를 막는다 — 복원이 명부까지 되돌리면 되살릴 수 없는 참조를 끊는다. <br>따라서 **복원 후 인력 명부에 임포트가 만든 사람이 남는다.** 필요 없으면 인력 화면에서 지운다(산출근거가 사라졌으므로 H-9a에 걸리지 않는다). 이 사실을 복원 결과 안내에 밝힌다 — 사용자가 "되돌렸는데 왜 남아 있지"로 헤매지 않게. |
| D-18 | **검증**: 파싱한 행의 세목 소계·비목 합계를 파일의 `소계`·`합계` 값과 대조한다. 어긋나면 미리보기에 **양쪽 값을 보여 주고 경고**하되 반영은 막지 않는다 — 파일의 소계가 수식 오류이거나 사람이 손으로 덮어쓴 값일 수 있고, 어느 쪽이 맞는지는 사람이 안다. |
| D-19 | **시트 하나 = 연차 하나.** 산출근거 시트는 한 연차만 담는다(실측 `1차년도_250520`, `1단계_2차년도_250604`). 대상 연차는 사용자가 지정하고, 시트명에서 `N차년도` 패턴을 찾아 **제안만** 한다. |
| D-20 | **프로파일(§5.12.1)을 저장하지 않는다.** 총괄표는 열 위치가 서식마다 달라 프로파일이 필요했지만(§6.8), 산출근거는 **컬럼 헤더 텍스트로 매핑**하므로(D-7) 매번 감지해도 안정적이다. 저장할 재사용 가능한 결정이 사실상 없다. 실무에서 반복 설정이 부담이 되면 그때 도입한다. |

#### 6.11.6 순수 함수 배치

`lib/import/detail-sheet.ts`에 둔다. `lib/import/`의 다른 모듈과 같이 **SheetJS를 import하지 않는다** — 어댑터가 만든 `RawSheet`(§5.12.2 경계 타입)를 받는다. 단위 테스트 필수(§11 필수 1).

```
detectSections(sheet)              → D-1 섹션 경계
detectBlocks(sheet, sections)      → D-2·D-3 비목·세목 블록 + D-4 컬럼 헤더
parseDetailRows(sheet, block)      → D-5·D-8~D-10·D-21 행 → 산출근거 초안
compareSubtotals(rows, subtotals)  → D-18 파일 소계 대조
```

**성명 매칭·미리보기 조립(D-11~D-15·D-18)은 `lib/import/detail-preview.ts`에 둔다** — 총괄표의 `lib/import/preview.ts`와 같은 층이고 형제 파일이다. 파서(`detail-sheet.ts`)는 시트만 알고 DB를 모른다는 경계를 지킨다. 둘 다 순수 함수이며 단위 테스트 필수다.

**금액 산식을 여기에 다시 구현하지 않는다.** D-8의 산식 결과는 `lib/budget-plan.ts`의 `computeDetailAmount`를 호출해 얻는다 — PL-10a가 "산식은 한 곳"이라 정한 그 함수다.

---

## 7. 화면 정의

### 7.1 라우팅

| 경로 | 화면 | 설명 |
|---|---|---|
| `/` | 대시보드 | 전 과제 요약 |
| `/projects` | 과제 목록 | |
| `/projects/[id]` | **과제 개요** | 협약정보, 진척 요약, 목표 달성 현황, 임박 마일스톤 |
| `/projects/[id]/wbs` | WBS 트리 | 연차 선택 + 계층 테이블 |
| `/projects/[id]/gantt` | 간트 차트 | 마일스톤 포함 |
| `/projects/[id]/board` | 칸반 보드 | |
| `/projects/[id]/goals` | 목표 관리 | 성과목표 + 기술목표 (탭 2개) |
| `/projects/[id]/milestones` | 마일스톤 | 타임라인 + 목록 |
| `/projects/[id]/budget` | 연구비 | 연차 × 비목 매트릭스, 집행 내역 |
| `/projects/[id]/team` | 인력·기관 | 컨소시엄 기관 + 참여인력 |
| `/projects/[id]/risks` | 리스크 관리대장 | 매트릭스 + 목록 |
| `/projects/[id]/notes` | 노트 | 회의록/기술메모 |
| `/todos` | To-Do | |
| `/settings` | 설정 | §7.14. 팀 설정 + 사용자 승인 + 백업/복원 |
| `/login` | 로그인 | §7.0. 비인증 시 전 경로가 여기로 리다이렉트 |
| `/pending` | 승인 대기 | §7.0. `active=false` 사용자 전용 |

과제 하위 화면은 공통 레이아웃 + 탭 네비게이션을 공유한다. 탭이 10개이므로 **1차 탭(개요·WBS·간트·보드·목표) / 2차 탭(마일스톤·연구비·인력·리스크·노트)** 로 시각적 그룹을 나눈다.

### 7.0 인증·온보딩 (`/login`, `/pending`)

§14.4 온보딩 흐름의 화면 대응이다.

- **`/login`**: 앱 로고 + "회사 구글 계정으로 로그인" 버튼 1개. 클릭 시 시스템 브라우저로 OAuth(A-1). 네트워크 오류·도메인 불일치(A-2)는 이 화면에서 명시적 에러로 표시.
- **`/pending`**: "관리자 승인을 기다리고 있습니다" + 내 이메일 표시 + 새로고침 버튼. `active=true`가 되면 자동으로 대시보드로 이동(Realtime 구독 또는 30초 폴링).
- 로그인 후 최초 1회: 표시 이름 확인 모달(구글 프로필 이름 기본값) + 백업 폴더 지정(Tauri 환경에서만, §14.4 ④).
- 미들웨어 규칙: 비인증 → `/login`, 인증했으나 미승인 → `/pending`, 승인 → 요청 경로.

### 7.2 대시보드 (`/`)

- **지표 카드 5개**: 진행 중 과제 수 / 평균 진척률 / 30일 내 마일스톤 수 / 최우선 작업 수(점수 15+) / 고위험 리스크 수
- **과제 요약 카드 리스트**: 과제명, 전문기관, 현재 연차 뱃지, 진척률 바, 성과목표 달성률, 기술목표 달성률, 예산 집행률, 다음 마일스톤 D-day
- **임박 마일스톤 타임라인**: 향후 `milestoneAlertDays`일 내 전 과제 마일스톤을 날짜순으로. 평가/보고서는 아이콘 구분.
- **오늘 집중할 작업**: 전 과제 리프 Task 중 우선순위 점수 상위 5건. 과제명·마감일·점수 뱃지 병기. 완료·blocked 제외
- **주의 필요**: 지연 작업 + blocked 작업 + 고위험 리스크 통합 리스트
- **오늘의 To-Do**
- 아카이브 과제는 모든 집계에서 제외.

### 7.3 과제 개요 (`/projects/[id]`)

- **협약 정보 패널**: 과제번호, 부처, 전문기관, 사업명, 협약기간, 총 연구개발비(정부/기관부담), PM, 주관기관
- **단계·연차 타임라인**: 가로 막대. 각 연차의 기간·진척률·예산·상태. 현재 연차 하이라이트. 클릭 시 해당 연차 WBS로 이동.
- **목표 달성 현황 요약**: 성과목표 도넛(달성/목표 건수), 기술목표 가중 달성률 게이지
- **임박 마일스톤 5건**
- **고위험 리스크 5건**
- **최근 노트 5건**

### 7.4 WBS 트리 (`/projects/[id]/wbs`)

상단에 **연차 선택 탭** (단계가 2개 이상이면 단계 > 연차 2단 셀렉터). "전체 연차 보기" 옵션 제공.

계층형 테이블 컬럼:

| 컬럼 | 내용 |
|---|---|
| WBS | 계산된 계층 번호 |
| 작업명 | 깊이 들여쓰기 + 접기/펼치기 |
| 담당 | `ownerMemberId` 이름 + 추가 인원 수 뱃지 |
| 기관 | 수행 기관 약칭 |
| 상태 | 배지 (인라인 드롭다운) |
| 우선순위 | 점수 뱃지(1~25) + 등급 색. 툴팁에 `중요도 4 × 긴급도 5` 표시. 고정 시 핀 아이콘 |
| 진척률 | 진행 바 + 숫자. 리프는 인라인 편집, 부모는 auto/manual 토글 |
| 기간 | `startDate ~ dueDate` (지연 시 빨강) |
| 공수 | 예상 / 실적 |
| 연계 | 기여하는 성과목표·기술목표 아이콘 뱃지 |

**인터랙션**
- 행 클릭 → 우측 상세 패널 (설명, 담당자 다중 선택, 기관, 목표 연계, 태그, 관련 노트)
- 드래그 → 순서·부모 변경
- `Tab` / `Shift+Tab` → 들여쓰기 / 내어쓰기
- `Enter` → 같은 레벨에 새 작업
- 툴바: 전체 펼치기/접기, 완료 숨기기, 담당자·기관·상태·태그·우선순위 등급 필터
- 상세 패널에서 중요도(1~5 슬라이더)와 긴급도 고정 여부를 편집한다

### 7.5 간트 (`/projects/[id]/gantt`)

- 좌측 고정 패널: 연차 > 작업 트리
  - ✅ **결정(2026-08-07, Phase 8 착수 시): 접힘 상태 동기화는 v1에서 하지 않는다.** 저장 위치 선택지 ① `localStorage` ② URL 쿼리 ③ 사용자 설정 테이블을 놓고 사람이 판단한 결과, 셋 다 v1이 감당할 값어치가 없다고 보고 **현행(화면별 로컬 상태)을 유지**한다. 간트와 WBS는 각자 접힘을 관리하고 새로고침하면 초기화된다. v2에서 다시 볼 항목이다.
- 우측 시간축: 일/주/월 스케일 전환
- 막대 안에 진척률 채움
- 부모 Task는 얇은 요약 막대(양끝 캡)
- **연차 구간을 배경 밴드로 표시**하고 연차 경계에 세로 구분선
- **마일스톤은 상단 별도 레인에 마름모 마커**로 표시. 유형별 색상 구분.
- 오늘 세로 기준선
- 막대 드래그 이동 / 양끝 리사이즈
- 날짜 없는 작업은 목록에만 표시
- 의존관계 화살표는 v1 제외

구현: CSS Grid. 1일 = 스케일별 고정 px, `날짜차이 × px`로 위치·너비 계산.

### 7.6 칸반 / 우선순위 매트릭스 (`/projects/[id]/board`)

상단에 **뷰 전환 토글**을 둔다: `보드` / `매트릭스`. 연차 필터는 두 뷰가 공유한다.
연차 필터에는 WBS·간트와 같은 **"전체 연차 보기"** 옵션을 둔다(§7.4와 동일 UX). 전체 보기에서도 PR-9(리프만)와 X-3(재정렬은 같은 컨테이너 안에서만)은 그대로 적용된다.

**보드 뷰**

- 컬럼 4개 고정: `todo` / `in_progress` / `done` / `blocked`
- 상단에 연차 필터 (기본: 현재 진행 연차)
- 카드: 작업명, WBS 코드, 진척률, 마감일, 담당자 아바타, 기관, 태그
- 컬럼 간 드래그 → `status` 변경 (P-1 적용)
- 컬럼 내 드래그 → `order` 변경
- 기본은 **리프 Task만** 카드로 표시. 토글로 전체 표시.
- 담당자별 그룹핑(스윔레인) 토글 제공
- 카드 좌측에 우선순위 등급 색 띠

**매트릭스 뷰**

- **5×5 히트맵**: 가로 긴급도, 세로 중요도. 셀에 작업 개수. 클릭 시 해당 셀 작업만 필터링.
- 우측에 **우선순위 정렬 목록**: 점수 내림차순. 작업명, WBS 코드, 담당, 마감일, 점수 뱃지
- 리프 Task만 포함 (PR-9). 완료 항목은 기본 숨김
- 셀 안에서 카드를 다른 셀로 드래그하면 **중요도가 바뀐다.** 긴급도는 마감일 기반이므로 드래그로 바꾸지 않는다(고정 모드일 때만 가능)
- §7.11 리스크 매트릭스와 같은 컴포넌트를 공유한다

### 7.7 목표 관리 (`/projects/[id]/goals`)

**탭 1 — 정량적 성과목표**

테이블: 지표명 / 유형 / 단위 / 목표(총) / 달성 / 달성률 바 / 연차별 목표·실적 / 책임기관

- 행 확장 시 실적 목록: 산출물명, 달성일, 연차, 기관, 참여자, 증빙 링크
- "실적 추가" 인라인 폼
- 연차별 목표는 매트릭스 셀에서 직접 편집 (`Σ targetByYear ≠ targetTotal`이면 경고 배지)
- 상단 요약: 전체 목표 건수 vs 달성 건수, 유형별 도넛

**탭 2 — 정량적 기술목표**

테이블: 평가항목 / 단위 / 비중(%) / 국내수준 / 세계최고 / 목표치 / 현재 실적 / 달성률 바 / 측정방법

- 행 확장 시 측정 이력 목록 + 추이 스파크라인
- "측정값 추가" 인라인 폼 (값, 측정일, 방법, 평가기관, 증빙)
- 상단 요약: 가중 달성률 게이지, 비중 합계(100이 아니면 경고)
- 국가R&D 계획서 표 형식에 맞춘 **인쇄용 레이아웃** 제공

### 7.8 마일스톤 (`/projects/[id]/milestones`)

- 상단 수평 타임라인 (연차 밴드 위에 유형별 마커)
- 하단 목록 테이블: 날짜 / 유형 / 제목 / 연차 / 담당 / 상태 / D-day
- 상태 인라인 변경, 결과 메모 입력
- 연차 생성 시 **기본 마일스톤 자동 생성 옵션**: 연차평가, 연차실적계획서 제출 (날짜는 연차 종료일 기준 자동 제안, 수정 가능)

### 7.9 연구비 (`/projects/[id]/budget`)

**모드 토글 `[제안 | 수행]`** (Phase 9). 같은 매트릭스를 두 관점으로 본다. 기본은 `수행`.

> **왜 탭을 늘리지 않는가**: 제안과 수행은 **같은 숫자**(연차 × 비목의 계획액)를 다룬다. 화면을 나누면 같은 값이 두 곳에 나타나 어느 쪽이 최신인지 사용자가 판단해야 하고, 비목 12행 × 연차 열이라는 표 구조도 그대로 중복된다. 모드는 **셀을 클릭했을 때 무엇이 열리는가**만 바꾼다.

| | 수행 모드 (v1 동작) | 제안 모드 (Phase 9) |
|---|---|---|
| 셀 표시 | `예산 / 집행 / 집행률` | `예산 / 현금 / 현물` |
| 셀 클릭 | 집행 내역 패널 | **산출근거 패널** (§7.9.2) |
| 셀 편집 | 예산액 인라인 편집 | 잠긴 셀(`detailCount > 0`)은 편집 불가·자물쇠 |
| 하단 요약 | 연차별 합계·집행률·잔액 | 연차별 합계·현금/현물 비중·**지침 검증 배지** |

- **매트릭스 테이블**: 행 = 12개 비목, 열 = 연차 + 합계. 두 모드가 공유한다
- 예산액은 셀에서 직접 인라인 편집. 셀 상세에서 현금/현물 분리 입력 (`cashAmount`/`inKindAmount`, 합계가 `plannedAmount`). **단 잠긴 셀은 제외**(PL-9)
- 표시 단위는 `settings.currencyUnit` 적용 (기본 천원)
- 집행률 100% 초과 셀은 빨강, 예산 외 집행은 경고 아이콘
- 툴바에 **[엑셀 가져오기]** 버튼 → §7.9.1 마법사 (예산계획 전용). 잠긴 셀은 S-14로 반영에서 빠진다
- 제안 모드 하단에 **지침 검증 줄**: 연구수당 비율(PL-12)·간접비 비율(PL-13)을 연차별로 표시하고 한도 초과 시 경고 배지. 한도가 null이면 비율만 표시하고 배지는 없다(PL-13·PL-15)

#### 7.9.2 산출근거 패널 (제안 모드, 셀 클릭)

선택한 (연차 × 비목)의 내역을 세목별로 편집한다. 실측 서식의 표 구조를 그대로 옮긴다.

- **세목 섹션**: 부록 A.5 프리셋 순서대로 나열. 행이 하나도 없는 세목은 접어 두고 `+ 행 추가`만 노출한다 — 실측 서식은 세목 11개 중 절반이 비어 있다
- **행 편집 표**: 세목의 `formula`에 따라 컬럼이 달라진다
  - `personnel` (인건비·학생인건비): `인력(드롭다운) | 직위 | 연봉 | 참여율(%) | 참여기간(월) | 축 | 조정액 | 금액`
    - 인력 드롭다운은 그 과제의 Member 목록. **직위·연봉은 Member에서 읽어 회색으로 표시**하며 여기서 고치지 않는다(정의는 인력 화면 한 곳). 연봉이 비어 있는 Member를 고르면 금액이 0이 되므로 **"연봉 미입력" 경고 + 인력 화면 링크**를 붙인다
    - 같은 인력을 **여러 행**으로 넣을 수 있다(참여율이 기간별로 바뀌는 실측 사례). 중복을 막지 않는다
  - `quantity` (나머지): `품명 | 규격·산출내역 | 단가 | 인자들 | 축 | 조정액 | 금액`
  - 두 형태 모두 마지막에 **`비고`** 열을 둔다 (`BudgetDetail.note`). 이 필드를 편집할 화면이 여기뿐이라 칸이 없으면 저장된 값에 손이 닿지 않는다
    - 인자 컬럼의 라벨과 개수는 **세목 프리셋의 기본값으로 채우되 행마다 바꿀 수 있다**(PL-3). 서식 변형이 왔을 때 스키마를 고치지 않고 넘길 수 있어야 한다
- **금액 열은 읽기 전용**이다 — 계산 결과(PL-1/PL-3)이지 입력이 아니다. 손으로 맞추고 싶으면 `조정액`을 쓴다
- 하단: 세목 소계 → **셀 합계(현금 / 현물 / 계)**. 이 값이 매트릭스 셀에 그대로 올라간다
- PL-5 음수 행은 빨강 + 사유. 저장은 되지만 눈에 띈다
- 행 순서는 드래그로 바꾼다(`order`). 세목 사이를 넘는 이동은 없다 — 세목이 바뀌면 컬럼 구조가 바뀐다
- **O-1 낙관적 잠금**: 행 편집은 `expectedVersion`을 보내고 STALE이면 §8.4 O-3 비교 다이얼로그(입력값 보존)

#### 7.9.3 산출근거 임포트 마법사 (제안 모드 툴바, Phase 10)

**§7.9.1(총괄표)과 별개 흐름이다.** 대상 계층이 다르고(셀 총액 vs 행 내역) 성명 매핑 단계가 추가된다. 제안 모드 툴바에 **[산출근거 가져오기]** 버튼을 둔다 — 수행 모드에는 노출하지 않는다.

**Step 1 — 파일 · 연차**
- 파일 선택(xlsx/xlsm/xls). 크기·행 수 상한은 I-15와 같다
- **대상 연차 지정.** 시트명의 `N차년도` 패턴으로 제안하되 확정은 사용자가 한다 (D-19)

**Step 2 — 시트 · 구조**
- 시트 탭 + 원본 그리드. **`1. 직접비 소요명세` 섹션이 있는 시트를 추천**한다 (D-1)
- 감지 결과를 트리로 보여 준다: 섹션 → 비목 → 세목 → 데이터 행 수. 각 세목의 컬럼 매핑(D-4·D-7)도 함께 표시하고 사용자가 고칠 수 있다
- 섹션이 없으면 **명시적으로 거부**한다 — 총괄표를 여기 넣으면 §7.9.1로 안내한다

**Step 3 — 성명 매핑** (인건비 행이 있을 때만)
- 원본 성명 → Member 대응표. 상태 아이콘은 §7.9.1 Step 4의 관례를 따른다
- 미매칭은 ① 기존 인력 선택 ② **새 인력으로 생성**(연봉·직위·채용구분을 파일에서 미리 채움) ③ 행 건너뛰기 (D-11)
- 동명이인은 소속 기관·직위를 함께 보여 준다 (D-13)
- 파일 연봉 ≠ 명부 연봉이면 **양쪽을 나란히 보여 주고 경고**. 명부는 고치지 않는다 (D-14)

**Step 4 — 미리보기 & 반영**
- 비목 → 세목 → 행 트리. 행마다 `품명/성명 · 근거 필드 · 축 · 조정액 · 금액`
- 행 상태: `신규`(초록) / `건너뜀`(회색) / `오류`(빨강)
- **셀 상태**: 기존 산출근거가 있으면 `기존 N행 있음`(주황) + **`[기존 삭제 후 교체]` 체크박스** (D-15)
- **D-8 조정액 흡수를 드러낸다**: 산식 결과와 파일 합계가 다른 행은 `계산 15,540,001 → 파일 15,540,000 (조정 −1)`처럼 보여 준다. 조용히 넣지 않는다
- **D-18 소계 대조**: 파일의 소계와 우리 합계가 어긋나는 세목을 경고로 표시. 반영은 막지 않는다
- **D-10 통화 경고**: 원화가 아닌 기호가 감지된 세목은 사용자가 확인해야 반영 대상에 들어간다
- 상단 요약: 신규 N행 · 건너뜀 N행 · 오류 N행 · 새로 만들 인력 N명 · 교체할 셀 N개 · 합계 금액
- 오류가 1건이라도 있으면 반영 버튼 비활성 (§7.9.1과 같다)

**설계 원칙** — §7.9.1과 같다: 어느 단계에서든 뒤로 갈 수 있고, 마지막 반영 전까지 저장되는 것은 없다(**새 인력도 이때 만든다** — D-12). 모달을 닫으면 진행 상태를 폐기한다.

**모드 상태와 인쇄**

- 모드는 **화면 로컬 상태**다. URL을 바꾸지 않고 저장하지도 않는다 — §7.5 접힘 상태와 같은 결정이며, 새로고침하면 기본값 `수행`으로 돌아간다
- **인쇄(§12 P-R1, 연구비 가로)는 현재 모드를 따른다.** 제안 모드에서 인쇄하면 산출근거가 아니라 **매트릭스 + 지침 검증 줄**이 나간다. 산출근거 자체의 인쇄는 Phase 9 범위 밖이다(제출 서식 내보내기와 함께 다룰 문제다)

#### 7.9.1 엑셀 가져오기 마법사 (모달, 5단계)

마법사의 진행 상태는 `ImportDraft`(§5.12.2) 하나에 담겨 `previewImport`/`commitImport`에 그대로 전달된다.

**Step 1 — 파일**
- 드래그앤드롭 또는 파일 선택 (xlsx/xlsm/xls/csv)
- 저장된 프로파일(부처 템플릿)이 있으면 목록에서 선택 → Step 4로 점프 (§6.8.1 — 비목 매핑·미리보기는 건너뛰지 않는다)

**Step 2 — 시트 & 범위**
- 시트 탭 + 원본 미리보기 그리드 (상위 30행). 비목 매칭 밀도가 가장 높은 시트를 추천 하이라이트 (§6.8.1 ②)
- 헤더 행을 **클릭으로 지정** (자동 추정값을 하이라이트해서 제시)
- 데이터 시작 행 지정
- 감지 결과 표시: 방향(행/열), 라벨 열 범위, 추정 금액 단위 — 모두 사용자가 확인·수정

**Step 3 — 열 매핑**
- 좌: 엑셀 열 목록 (열 문자 + 헤더 텍스트 + 샘플값 3개)
- **라벨 열 지정**: S-3의 다중 라벨 열 범위 (자동 추정 하이라이트)
- **연차 열 매핑**: 연차로 감지된 열마다 "이 열 = N차년도" 드롭다운 (`yearMapping`). 자동 추정: `N차년도` 라벨 → `order = N-1`인 Year. **미대응 연차 열이 남아 있으면 다음 단계 진행 불가** (S-5)
- 자동 추정된 매핑은 회색, 사용자가 바꾼 것은 파랑

**Step 4 — 비목 매핑**
- 원본 비목명 → 시스템 비목 대응표
- 상태별 아이콘: ✅ 완전일치 / 🔵 별칭사전(부처 프리셋 포함) / ⚠️ 유사매칭(확인필요) / ❌ 미매핑
  - **이 아이콘의 근거와 "원본 비목명"은 서버가 `PreviewRow`에 실어 보낸 값을 그대로 쓴다** (`label`, `categorySource`, 원본 행별 상세는 `sourceRows`). 화면이 `classifyLabel`을 다시 돌려 판정하지 않는다 — 같은 규칙이 두 곳에 생기면 반드시 어긋나고(O-4), 라벨을 미리보기 그리드에서 되찾으면 **상위 30행 아래 행이 라벨을 잃는다.**
  - S-8로 여러 원본 행이 한 셀에 합쳐지면 `categorySource`는 **가장 확인이 필요한 근거**가 대표로 온다. 완전일치 하나가 섞였다고 ✅로 보여 주면 같은 셀에 합산된 별칭·승계 행을 사용자가 확인 없이 지나친다.
- 미매핑·유사매칭 항목은 드롭다운으로 지정(`manualCategoryByRow`)하거나 "이 행 건너뛰기" 체크(`skippedRowIndexes`)
- 하단: "이 매핑을 프로파일로 저장" 체크 + 프로파일명·부처 입력 (수동 지정분은 I-7 학습, 단 I-6 모호 별칭의 선택은 학습하지 않는다)

**Step 5 — 미리보기 & 반영**
- 반영 예정 내역 테이블 (연차 / 비목 / 계획액 / 현금 / 현물 / 상태)
- 행 상태: `신규` (초록) / `덮어씀` (주황) / `건너뜀` (회색 — 스킵 패턴·사용자 지정 포함) / `오류` (빨강)
  - **`신규`/`덮어씀`의 판정 기준은 "행의 존재"가 아니라 "값의 존재"다.** 연차 생성 시 12비목이 `plannedAmount 0`으로 자동 생성되므로(§5.12) 행 존재로 판정하면 **모든 행이 항상 `덮어씀`이 되어 구분이 무의미해진다.** 기존 레코드가 `plannedAmount = 0`이고 `cashAmount`·`inKindAmount`가 둘 다 null이면 `신규`로 본다. 그 결과 값이 0인 비목은 같은 파일을 재반영해도 계속 `신규`로 표시된다 — 실제로 덮어쓸 값이 없으므로 맞는 표시다.
- 상단 요약: 신규 N건 · 덮어씀 N건 · **건너뜀 N건(합계 X원)** · 오류 N건 · 합계 금액 · "이 파일에 없는 비목 N건은 유지됩니다"(S-9)
- **오류가 1건이라도 있으면 반영 버튼 비활성화.** 해당 행을 "건너뛰기"로 제외해야 진행 가능하다 — 셀 값의 인라인 수정은 지원하지 않는다(원본 파일에서 고쳐 다시 업로드).
- 덮어쓸 기존 값을 나란히 보여준다 (`기존 → 신규`)
- 반영 후 결과 토스트. 반영 전 기존 계획액은 `import_snapshots`에 저장된다 (I-17)

**설계 원칙**
- 어느 단계에서든 뒤로 갈 수 있고, 마지막 반영 전까지 저장되는 것은 없다.
- 모달을 닫으면 진행 상태는 폐기한다(중간 저장 없음).
- 큰 파일은 Step 2 파싱 시 로딩 인디케이터를 띄운다.

### 7.10 인력·기관 (`/projects/[id]/team`)

- **기관 섹션**: 카드 목록. 역할 뱃지(주관/공동/위탁), 기관명, 유형, 책임자, 담당 연구개발 내용, 배분 연구개발비. 주관기관은 최상단 고정.
- **인력 섹션**: 기관별로 그룹핑된 테이블. 이름 / 역할(PM/PL/연구원/지원) / 직급 / 분야 / 연락처 / 활성여부 / **연봉 / 채용구분**(Phase 9)
- PM은 과제당 1명. 지정 시 기존 PM은 자동으로 `pl`로 강등되지 않고 경고만 띄운다.
- 인력 행 클릭 → 배정된 작업 목록 사이드 패널
- **`hireType='new'`는 `채용예정` 배지**로 구분한다 (§5.11 — 아직 사람이 정해지지 않은 자리도 Member로 등록한다)
- **참여율(%) 입력 필드를 여기에 두지 않는다.** 참여율은 (연차 × 인력)의 속성이라 연구비 화면의 산출근거가 갖는다 (§5.11, §5.17)
- **연봉 변경은 확인을 거친다 (PL-10b)**: 저장을 누르면 먼저 `previewSalaryChange`로 영향받는 산출근거 건수와 **연차별 전후 금액**을 보여주고, 사용자가 확인해야 저장·재계산한다. 영향 건수가 0이면 확인 없이 바로 저장한다
- **삭제 차단 (H-9a)**: 인건비 산출근거가 걸린 인력은 삭제할 수 없다. 삭제 대화상자가 참조 건수를 항목별로 보여줄 때 산출근거를 **별도 줄**로 세고 `[연구비로 이동]` 링크를 준다. `active=false`는 그대로 가능하다

### 7.11 리스크 (`/projects/[id]/risks`)

- **5×5 매트릭스 히트맵**: 가로 발생가능성, 세로 영향도. 셀에 리스크 개수. 클릭 시 필터링.
- **목록 테이블**: 등급(점수) / 리스크명 / 유형 / 발생가능성 / 영향도 / 대응전략 / 담당 / 목표일 / 상태
- 점수 내림차순 기본 정렬
- 행 확장 → 리스크 내용, 대응 방안, 비상 계획, 관련 작업 링크
- 해결/종료 항목은 기본 숨김 (토글로 표시)

### 7.12 노트 (`/projects/[id]/notes`)

- 좌측 목록 / 우측 뷰어-에디터 2단 레이아웃
- 목록: 고정(pinned) 상단 → 날짜 내림차순. 유형 아이콘, 제목, 날짜, 태그
- 필터: 유형, 연차, 태그, 전문 검색
- 에디터: 마크다운 `textarea` + 프리뷰 토글 (분할 뷰 옵션)
- **렌더링은 외부 마크다운 라이브러리를 쓰지 않는다.** 노트 본문은 사용자 입력이고, HTML 문자열을 만들어 주입하면 저장형 XSS가 된다. `lib/notes.ts`가 제한된 부분집합(제목·강조·목록·체크박스·코드·인용·구분선·링크)을 **데이터 AST**로 파싱하고, 뷰어가 AST를 **React 엘리먼트**로 옮긴다 — AST에 "원시 HTML" 노드가 없으므로 주입이 걸러지는 게 아니라 **표현 자체가 불가능**하다. 링크는 `http`/`https`/`mailto`만 `<a>`가 되고(제어문자·공백을 제거한 뒤 스킴을 본다), 그 외(`javascript:`·`data:`·`vbscript:`·`//host`)는 **조용히 버리지 않고 원문 그대로** 표시한다.
- 회의록 템플릿 버튼: 일시/장소/참석자/안건/논의/결정사항/액션아이템 골격 삽입
- 참석자는 Member에서 다중 선택 (자동으로 본문 상단에 삽입)
- 노트를 특정 Task·Milestone에 연결 가능. 연결되면 해당 화면에서 역참조로 보인다.
- 저장은 명시적 저장 버튼 + 3초 디바운스 자동 저장 병행

### 7.13 To-Do (`/todos`)

과제 계층에 매이지 않는 할 일 목록이다. **진척률·달성률 계산에 절대 포함되지 않는다**(§5.15).

> **소유권: 팀 공유다.** "개인 할 일"이라는 표현은 *과제 계층에 매이지 않는다*는 뜻이지 *나만 본다*는 뜻이 아니다. `todos`의 RLS는 다른 테이블과 같은 `approved users full access`이고(§8.2 RLS-1) 조회에 `created_by` 필터가 없다 — **승인된 사용자 전원이 서로의 To-Do를 보고 고칠 수 있다.** 6명짜리 팀에서는 서로의 할 일이 보이는 편이 유용하다고 판단했다(2026-08-07 결정). 소유자별 분리가 필요해지면 조회 레벨 필터로 하고 **RLS는 건드리지 않는다** — RLS를 좁히면 §8.7 백업·복원(K-7 전 행 대체)이 깨진다.

- 단일 리스트. 상단에 **한 줄 빠른 추가**(제목만 입력 → Enter). 추가한 뒤 행에서 마감일·우선순위·과제를 붙인다
- 행 구성: 체크박스, 제목(인라인 편집), 과제 링크, 마감일, D-day 뱃지, 우선순위 뱃지, 삭제
- 필터: **전체 / 미완료 / 오늘 / 과제별**
- 정렬: **수동(드래그) · 마감일 · 우선순위**

**필터·판정 규칙 (T-D)** — 기준일은 §6.5와 같은 **Asia/Seoul 달력 오늘**(`lib/dates.ts`의 `todayISO(now)`)이다. 서버 컴포넌트가 한 번 계산해 prop으로 내리고, 클라이언트 컴포넌트는 오늘을 스스로 만들지 않는다.

| ID | 규칙 |
|---|---|
| T-D1 | `전체` = 모든 To-Do. `미완료` = `done=false`. 화면 진입 시 **기본 필터는 `미완료`** |
| T-D2 | `오늘` = `done=false AND dueDate != null AND dueDate ≤ today`. **지난 마감을 포함한다** — 대시보드 "오늘의 To-Do"(§7.2 6)와 같은 정의다 |
| T-D3 | 판정·정렬은 **`lib/todos.ts` 순수 함수 한 곳**에 두고 `/todos` 화면과 대시보드가 **같은 함수**를 쓴다. 정의가 두 벌이 되면 두 화면의 건수가 조용히 어긋난다 |
| T-D4 | `overdue` = `done=false AND dueDate < today` → 빨강. `dueSoon` = `done=false AND 0 ≤ dueDate - today ≤ dueSoonDays` → 주황. §6.5 Task 판정과 같은 형태이나 `status`가 아니라 `done`을 본다 |
| T-D5 | `과제별` 필터는 `projectId` 하나를 고른다. **`(과제 없음)`**(`projectId=null`)도 고를 수 있는 값이다 |
| T-D6 | **`/todos`는 아카이브 과제의 To-Do도 감추지 않는다.** 대시보드는 집계 화면이라 아카이브를 제외하지만(§7.2), `/todos`는 To-Do의 유일한 접근 경로다 — 여기서 감추면 되살릴 방법이 없어진다. 이 차이는 의도된 것이다 |
| T-D7 | 정렬 `마감일` = 마감일 오름차순 → 우선순위 → `order` → id. **마감일 없는 항목은 목록 뒤로** 보낸다(빼지 않는다). 정렬 `우선순위` = high → normal → low → 마감일 → `order` → id |
| T-D8 | 완료 항목은 `미완료`·`오늘`에서 사라지고 `전체`에서는 취소선 + 흐린 스타일로 남는다. `completedAt`은 `toggleTodo`가 채우고 해제 시 `null`로 되돌린다 |
| T-D9 | 수동 정렬 드래그는 **정렬이 `수동`일 때만** 활성이다. 마감일·우선순위 정렬 중에는 드래그해도 결과가 보이지 않으므로 비활성 + 안내 문구. 화면 진입 시 **기본 정렬은 `수동`** |
| T-D10 | 필터가 걸린 채로 드래그하면, 화면은 **숨겨진 항목까지 포함한 전체 순서를 재계산해** `reorderTodos`에 보낸다. 보이는 것만 보내면 필터를 풀었을 때 순서가 섞인다. 이 덕분에 `reorder_todos` RPC는 **배열 길이 = 갱신 행 수**를 엄격히 검사할 수 있고, 존재하지 않는 id·중복을 조용히 넘기지 않는다 |

- 우선순위 색: `high` 빨강 · `normal` 파랑 · `low` 회색 (부록 A.3). Task의 우선순위 **점수(1~25)** 색과는 다른 축이다 — To-Do는 점수를 계산하지 않는다
- 체크박스 토글은 §8.4 **O-2**(사용자가 만진 필드가 1개인 갱신)로 낙관적 잠금을 생략한다. 제목·마감일·우선순위·과제 편집은 **O-1 대상**
- 순서 변경은 `reorderTodos(orderedIds)` RPC 한 번(X-3). To-Do는 컨테이너가 없는 **전역** 목록이라 다른 reorder와 달리 `projectId`를 받지 않는다
- 과제 삭제 시 To-Do는 남는다(`todos.project_id`는 cascade가 아니라 `set null`, N-8)
- 실시간: `todos` 구독(§8.5)

### 7.14 설정 (`/settings`)

섹션 3개로 구성한다.

- **팀 설정**: `Settings`(§5.16) 필드 편집 폼 — 마감 임박 기준일, 마일스톤 알림 기준일, 주 시작 요일, 간트 기본 스케일, 표시 통화 단위, 진척률 가중 기준. 저장 시 `updateSettings`.
- **사용자 관리**: `app_users` 목록 (이름, 이메일, 상태, 마지막 접속). 승인 대기자(`active=false`)는 상단에 뱃지와 [승인] 버튼(§14.2 A-3). 활성 사용자는 [비활성화] 가능(본인 제외). 내 프로필(표시 이름, Member 연결)도 여기서 편집.
- **백업·복원**: [지금 내보내기](K-1), 마지막 백업 시각·자동 백업 상태(K-2), 백업 폴더 변경(Tauri 환경만), [복원] — 파일 선택 + 2단계 확인(K-4). 임포트 스냅샷(I-17) 목록·복원도 이 섹션에 둔다.

### 7.15 과제 목록 (`/projects`)

- 과제 카드 그리드: 색상 띠, 과제명, 부처·전문기관, 진척률 바, 현재 연차 뱃지, 상태 뱃지
- 정렬: `order` 수동(드래그), 필터: 상태·아카이브 표시 토글
- "새 과제" 버튼 → 생성 모달 (이름·협약정보 최소 입력. Stage 1개 + Year 1개 자동 생성, §9 `createProject`)
- 아카이브 과제는 기본 숨김, 토글로 표시 (흐린 스타일)

---

## 8. 데이터 레이어 설계

### 8.1 요구사항
1. 여러 사람이 **동시에** 편집해도 서로의 변경을 잃지 않을 것
2. 연쇄 삭제 같은 다중 테이블 작업이 중간에 끊기지 않을 것 (트랜잭션)
3. 남의 변경이 합리적인 시간 안에 화면에 반영될 것
4. 인증되지 않은 접근이 데이터에 닿지 않을 것
5. 무료 플랜에는 백업이 없으므로 **자체 백업 수단**을 가질 것

### 8.2 접속 구조

```
Tauri 셸
  └─ Next.js 사이드카 (127.0.0.1:랜덤포트)
       ├─ 서버 컴포넌트 / 서버 액션
       │    └─ supabase-js (사용자 세션 토큰)  ──▶ Supabase Postgres
       └─ 클라이언트 컴포넌트
            └─ supabase-js Realtime 구독      ──▶ Supabase Realtime
```

| # | 규칙 |
|---|---|
| C-1 | **service_role 키는 앱 코드·빌드 산출물에 절대 포함하지 않는다.** 데스크톱 앱은 사용자 손에 있는 코드이므로 키가 노출된다. 앱은 anon 키 + 사용자 세션 + RLS만 쓴다. **단, 커밋되지 않는 로컬 개발 스크립트(시드 주입, 통합 테스트)는 service_role을 써도 된다** — `.env.test.local`(gitignore)에만 둔다. |
| C-2 | 모든 DB 접근은 서버 액션을 거친다. 클라이언트가 직접 쓰기를 하지 않는다. 단 Realtime 구독은 클라이언트에서 한다(읽기 전용). |
| C-3 | 세션 토큰은 Tauri의 보안 저장소(OS 키체인)에 보관한다. localStorage 금지. |
| C-4 | 네트워크 장애 시 명확한 오프라인 배너를 띄우고 쓰기를 차단한다. **오프라인 편집은 지원하지 않는다.** |

### 8.3 트랜잭션

연쇄 삭제(§6.6 H-4~H-8)와 다중 테이블 갱신은 **Postgres 함수(RPC)** 로 구현한다. 애플리케이션에서 여러 번 호출하는 방식은 중간 실패 시 데이터가 깨진다.

```sql
-- 예: 연차 삭제 (H-5, N-8, N-13 반영)
create or replace function delete_year(p_year_id uuid)
returns void language plpgsql security invoker as $$
begin
  -- set null 대상 (N-8): FK on delete set null로도 처리되지만 RPC에서 명시해 의도를 남긴다
  update milestones set year_id = null where year_id = p_year_id;
  update risks      set year_id = null where year_id = p_year_id;
  update notes      set year_id = null where year_id = p_year_id;
  update deliverable_achievements set year_id = null where year_id = p_year_id;
  update tech_target_records      set year_id = null where year_id = p_year_id;
  -- jsonb 맵의 고아 키 제거 (N-13)
  update deliverables set target_by_year = target_by_year - p_year_id::text
   where target_by_year ? p_year_id::text;
  update tech_targets set target_by_year = target_by_year - p_year_id::text
   where target_by_year ? p_year_id::text;
  delete from years where id = p_year_id;   -- tasks, budget_items는 cascade
end; $$;
```

| # | 규칙 |
|---|---|
| X-1 | 단순 CRUD는 PostgREST(supabase-js)를 직접 쓴다. RPC는 다중 테이블 작업에만 쓴다. |
| X-2 | RPC는 `security invoker`로 만들어 RLS를 우회하지 않게 한다. **예외**: 인증 부트스트랩(`handle_new_user` 트리거 함수), 사용자 승인 관리(`approve_user`, `deactivate_user`), 승인 판정 헬퍼(`is_approved`), 전체 복원(`restore_backup` — 호출자 `active=true` 자기검증 + K-5 스키마 버전 검증을 함수 안에서 수행, §8.7 K-7)은 RLS가 닿기 전/위 단계의 작업이므로 `security definer`로 만든다 (§14.2, §14.3). 그 외 definer 함수는 금지. |
| X-3 | 순서 재정렬(`reorderTasks` 등)은 한 번의 RPC에서 일괄 갱신한다. 행마다 호출하지 않는다. |
| X-4 | Task 이동(`moveTask`)의 순환 검사(H-2)와 깊이 검사(H-3), `moveTaskToYear`의 같은 과제 검증(H-11)은 **DB 함수 안에서** 수행한다. 클라이언트 검증만 믿지 않는다. |

### 8.4 동시성 — 낙관적 잠금

락은 없다. 대신 **마지막에 읽은 `version`을 조건으로 거는 방식**을 쓴다. `version bigint`는 BEFORE UPDATE 트리거가 +1 한다 (N-4, N-5).

> `updated_at` 비교 방식을 쓰지 않는 이유: Postgres `timestamptz`는 마이크로초(6자리), JS의 ISO 문자열은 밀리초(3자리)라서 왕복 과정에서 정밀도가 잘리면 `eq`가 영원히 0행을 갱신한다. 정수 비교는 이 함정이 없다.

```ts
const { data, error } = await supabase
  .from('tasks')
  .update(patch)                     // 서버 액션이 patch에 updated_by를 채운다
  .eq('id', id)
  .eq('version', expectedVersion)    // 그새 바뀌었으면 0행 갱신
  .select()
  .single();

if (!data) throw new StaleDataError();   // "다른 사람이 먼저 수정했습니다"
```

| # | 규칙 |
|---|---|
| O-1 | 상세 편집 패널의 저장처럼 **여러 필드를 한 번에 바꾸는 작업**은 반드시 낙관적 잠금을 건다. |
| O-2 | **사용자가 UI에서 직접 조작한 필드가 1개**인 갱신(체크박스 토글, 상태 드롭다운)은 낙관적 잠금을 생략한다. 마지막 것이 이기는 게 자연스럽다. 파생 갱신(P-1~P-3처럼 규칙이 함께 바꾸는 필드)이 딸려 있어도 "단일 조작"으로 본다. |
| O-3 | `StaleDataError` 발생 시 최신 행의 `updated_by`로 "OO님이 먼저 수정했습니다. 최신 내용을 확인하세요"를 띄우고 해당 행만 갱신한다. **작업 내용을 날리지 않는다** — 입력값을 유지한 채 비교 UI를 보여준다. |
| O-4 | 진척률 롤업(§6.1)은 읽기 시 계산한다. DB에 저장하지 않으므로 롤업 값 충돌은 발생하지 않는다. |

### 8.5 실시간 반영

Supabase Realtime으로 테이블 변경을 구독한다.

| # | 규칙 |
|---|---|
| R-1 | 현재 열려 있는 화면에 관련된 테이블만 구독한다(아래 구독표). 전체 구독 금지(무료 플랜 200 동시 연결). |
| R-2 | 변경 이벤트를 받으면 데이터를 직접 패치하지 않고 `router.refresh()`로 서버 컴포넌트를 다시 가져온다. 계산 로직 중복을 피한다. |
| R-3 | 이벤트 폭주 방지를 위해 500ms 디바운스를 건다. |
| R-4 | 내가 편집 중인 폼이 열려 있으면 자동 새로고침을 보류하고 "새 변경 있음 · 새로고침" 배너만 띄운다. 입력 중인 내용을 지우지 않는다. |
| R-5 | Realtime 연결이 끊기면 30초 폴링으로 폴백한다. |
| R-6 | 이벤트의 `updated_by`가 나 자신이면 무시한다(self-echo 필터) — 내 저장은 이미 화면에 반영되어 있다. |
| R-7 | **구독 대상 테이블은 마이그레이션에서 `alter publication supabase_realtime add table ...`로 명시**해야 이벤트가 발생한다. Phase 0 마이그레이션에 아래 구독표의 테이블 전부를 추가한다. 이 규칙이 누락되면 아무 이벤트도 오지 않는데 에러도 없다. |

**화면별 구독표**

| 화면 | 구독 테이블 |
|---|---|
| 대시보드 | `projects`, `milestones`, `tasks` |
| 과제 개요 | `projects`, `years`, `milestones` |
| WBS / 간트 / 보드 | `tasks`, `years` |
| 목표 관리 | `deliverables`, `deliverable_achievements`, `tech_targets`, `tech_target_records` |
| 마일스톤 | `milestones` |
| 연구비 | `budget_items`, `budget_executions`, `budget_details` |
| 인력·기관 | `organizations`, `members` |
| 리스크 | `risks` |
| 노트 | `notes` |
| To-Do | `todos` |
| 설정 | `app_users`, `app_settings` |

최대 동시 구독 = 6명 × 화면당 최대 4테이블 = 24 연결 (무료 한도 200의 12%).

### 8.6 리포지토리 레이어

```
/lib/db
  ├── client.ts           supabase 클라이언트 (서버/클라이언트 분리)
  ├── mapper.ts           snake_case ↔ camelCase 변환
  ├── schema.ts           Zod 스키마 + 타입 (DB 응답 검증)
  ├── errors.ts           StaleDataError, NotFoundError 등
  ├── projects.ts  stages.ts  years.ts  tasks.ts
  ├── milestones.ts  deliverables.ts  tech-targets.ts
  ├── organizations.ts  members.ts  budget-items.ts
  ├── risks.ts  notes.ts  todos.ts  settings.ts  import-profiles.ts
  ├── app-users.ts        §14.2 인증 사용자 조회·승인
  └── backup.ts           §8.7 내보내기/복원 (리포지토리 16종 + 백업 모듈)
```

UI 코드는 supabase 클라이언트를 직접 호출하지 않는다. 반드시 리포지토리를 거친다. **이 규칙이 §14.5의 NAS 이전을 가능하게 한다.**

DB 응답도 Zod로 검증한다. 스키마 마이그레이션 누락을 조용히 넘기지 않기 위해서다.

### 8.7 백업 (무료 플랜에 백업이 없으므로 필수)

| # | 규칙 |
|---|---|
| K-1 | 앱에 **전체 내보내기** 기능을 둔다. 전 테이블을 JSON 하나로 덤프해 사용자가 지정한 폴더에 저장한다. |
| K-2 | 주 1회 자동 내보내기. 앱 실행 시 마지막 백업이 7일 이상 지났으면 자동 실행하고 알린다. |
| K-3 | 백업 파일은 최근 12개를 유지한다. 백업 폴더는 온보딩에서 지정한다(구글 드라이브 동기화 폴더 권장). |
| K-4 | **전체 복원** 기능을 둔다. 복원 전 현재 상태를 자동 백업하고, 2단계 확인을 요구한다. |
| K-5 | 내보내기 JSON 형식(아래)을 지킨다. `schemaVersion` 불일치 파일의 복원은 거부한다. |
| K-6 | 스키마 마이그레이션 직전에는 반드시 자동 백업을 강제한다. |
| K-7 | 복원은 단일 RPC 트랜잭션으로 수행한다: FK 의존 **역순으로 전 행 DELETE → 정순으로 INSERT** (id 보존). 부분 복원·병합은 없다 — 전체 대체만. |
| K-8 | `app_users`와 `app_settings.schema_version`은 백업에 **포함하되 복원하지 않는다** — auth.users와 어긋난 사용자 행이나 구 스키마 버전이 덮어써지는 것을 막는다. |

**내보내기 JSON 형식** — 행은 **DB snake_case 원본 그대로** 담는다 (매퍼 버그로부터 독립).

```ts
interface BackupFile {
  schemaVersion: number;              // app_settings.schema_version
  exportedAt: string;                 // ISO 8601
  exportedBy: { id: string; email: string };
  tables: Record<string, unknown[]>;  // 테이블명(snake_case) → 행 배열
}
```

### 8.8 스키마 마이그레이션

- Supabase CLI 마이그레이션(`supabase/migrations/*.sql`)으로 관리한다. 대시보드에서 직접 테이블을 고치지 않는다.
- 마이그레이션 파일은 Git에 커밋한다. 이게 스키마의 진실 공급원이다.
- 앱은 시작 시 `app_settings.schema_version`을 확인한다. 코드 기대값(`lib/constants.ts`의 `EXPECTED_SCHEMA_VERSION`)보다 **낮으면** 마이그레이션 안내를, **높으면** 앱 업데이트 안내를 띄우고 진입을 막는다.
- **`schema_version`을 올리는 기준은 "백업 파일 형식이 바뀌는가"다.** 테이블 추가·삭제가 여기 해당한다(§8.7 `BACKUP_TABLES`가 바뀐다). 컬럼 추가나 RPC 변경만으로는 올리지 않는다 — 기존 백업 파일이 그대로 복원되기 때문이다. <br>이 기준이 없으면 K-5의 버전 게이트가 "호환"이라 판정한 파일을 `parseBackupFile`의 테이블 목록 검사가 거부해, 사용자가 **"테이블 데이터가 없습니다"라는 엉뚱한 메시지**를 본다. 올릴 때는 마이그레이션의 `update app_settings set schema_version`과 `EXPECTED_SCHEMA_VERSION`을 **같은 커밋에서** 함께 고친다.
- 이력: `1` = Phase 0 최초 스키마. **`2` = Phase 9 (`budget_details` 신설 — Phase 0 이후 첫 테이블 추가).**

---

## 9. 서버 액션 목록

모든 액션은 Zod로 입력 검증, 성공 시 `revalidatePath()` 호출.
반환 타입: `ActionResult<T> = { ok: true; data: T } | { ok: false; error: string; code?: 'STALE' | 'AUTH' | 'OFFLINE' | 'VALIDATION' | 'CONFLICT' | 'RULE' }`
- `VALIDATION` = Zod 검증 실패, `CONFLICT` = 유니크 제약 충돌, `RULE` = 비즈니스 규칙 위반(H-6 마지막 Stage 삭제, H-8 주관기관 삭제 등). UI가 코드별로 다른 안내를 보여준다.

| # | 규칙 |
|---|---|
| SA-1 | 모든 액션은 시작 시 세션과 `app_users.active`를 확인한다. RLS만 믿지 않는다. `lastSeenAt`은 이 확인 시 **하루 1회** 갱신한다. |
| SA-2 | `update*` 계열은 `expectedVersion`을 선택 인자로 받는다. 넘어오면 낙관적 잠금을 건다 (§8.4 O-1). 모든 쓰기 액션은 `updated_by`(생성은 `created_by`)를 세션 사용자로 채운다. |
| SA-3 | 연쇄 삭제·순서 재정렬·임포트 반영은 Postgres RPC를 호출한다 (§8.3). |
| SA-4 | 에러 메시지에 DB 내부 정보(테이블명, 제약명)를 노출하지 않는다. |

**Project / Stage / Year**
```
createProject(input)                 // Stage 1개 + Year 1개 자동 생성. Year 기본값:
                                     //   startDate=협약시작일, endDate=+1년-1일, status='planned', name=''
updateProject(id, patch)
deleteProject(id)                    // RPC: delete_project
archiveProject(id, archived)
reorderProjects(orderedIds)

createStage(projectId, input)
updateStage(id, patch)
deleteStage(id)                      // RPC: delete_stage (H-6)
reorderStages(projectId, orderedIds)

createYear(stageId, input)           // RPC: stage 내 마지막 뒤 삽입 + 이후 전체 시프트 (§5.5),
                                     //      비목 12종 자동 생성(on conflict do nothing) + 기본 마일스톤 옵션
updateYear(id, patch)
deleteYear(id)                       // RPC: delete_year (H-5)
setYearStatus(id, status)            // 'active' 지정 시 같은 과제의 기존 active를 'planned'로 해제 — 과제당 active 1개
reorderYears(projectId, orderedIds)  // project 단위 normalize (H-10). 단계 경계를 넘는 순서는 거부
```

**Task**
```
createTask(yearId, input)
updateTask(id, patch)
deleteTask(id)                       // cascade (자손 포함)
moveTask(id, newParentId, newIndex)  // RPC: 순환·깊이 검사를 DB에서 (X-4)
moveTaskToYear(id, newYearId)        // H-11, 자손 동반 이동
reorderTasks(parentId, orderedIds)
setTaskStatus(id, status)            // P-1
setTaskProgress(id, progress)        // P-2, P-3
setProgressMode(id, mode)            // P-4, P-5
setTaskPriority(id, importance)       // 중요도 변경 (PR-1)
setTaskUrgency(id, mode, manualValue) // 긴급도 고정/해제 (PR-4)
assignTaskMembers(id, ownerMemberId, memberIds)
linkTaskGoals(id, deliverableIds, techTargetIds)
bulkUpdateTasks(ids, patch)
```

**Milestone**
```
createMilestone(projectId, input)
updateMilestone(id, patch)
deleteMilestone(id)
setMilestoneStatus(id, status, resultNote)
generateDefaultMilestones(yearId)    // 연차평가 + 실적계획서 제출 자동 생성
```

**Deliverable**
```
createDeliverable(projectId, input)
updateDeliverable(id, patch)
deleteDeliverable(id)
reorderDeliverables(projectId, orderedIds)
setDeliverableYearTargets(id, targetByYear)
addAchievement(deliverableId, input)
updateAchievement(deliverableId, achievementId, patch)
deleteAchievement(deliverableId, achievementId)
```

**TechTarget**
```
createTechTarget(projectId, input)
updateTechTarget(id, patch)
deleteTechTarget(id)
reorderTechTargets(projectId, orderedIds)
setTechTargetYearTargets(id, targetByYear)
addTechRecord(techTargetId, input)
updateTechRecord(techTargetId, recordId, patch)
deleteTechRecord(techTargetId, recordId)
```

**Organization / Member**
```
createOrganization(projectId, input)
updateOrganization(id, patch)
deleteOrganization(id)               // H-8
setLeadOrganization(projectId, orgId)
reorderOrganizations(projectId, orderedIds)

createMember(projectId, input)
updateMember(id, patch)              // annualSalary 변경 시 PL-10b 파급 (confirm 필요)
previewSalaryChange(id, annualSalary) // PL-10b: 영향받는 산출근거 건수·전후 금액. 저장하지 않는다
deleteMember(id)                     // RPC: delete_member (H-9). 산출근거가 있으면 H-9a로 거부
setMemberActive(id, active)
setProjectPM(projectId, memberId)
reorderMembers(projectId, orderedIds)
```

**Budget**
```
updateBudgetPlan(yearId, category, plannedAmount, cashAmount, inKindAmount, expectedVersion?)
                                     // PL-9: 잠긴 셀(detailCount > 0)이면 RULE 거부
addExecution(budgetItemId, input)
updateExecution(budgetItemId, executionId, patch, expectedVersion?)   // §5.12 version 추가로 O-1 잠금 대상
deleteExecution(budgetItemId, executionId)
```

**Budget Plan** (Phase 9 — 산출근거. §5.17, §6.10)
```
createBudgetDetail(yearId, category, subcategory, input)   \
updateBudgetDetail(id, patch, expectedVersion?)             > RPC: upsert_budget_detail / delete_budget_detail
deleteBudgetDetail(id)                                     /   PL-10: 같은 트랜잭션에서 budget_items 재계산
reorderBudgetDetails(yearId, category, subcategory, orderedIds)
setBudgetRateLimits(projectId, { allowanceRateLimit, indirectRateLimit }, expectedVersion?)
```
- 세 쓰기 액션 모두 **PL-10 불변식**을 지킨다: 행을 건드린 뒤 같은 트랜잭션에서 해당 `budget_items`의 `planned/cash/in_kind`를 다시 계산해 쓴다. 액션이 두 번 호출하는 방식은 금지 — 사이에서 실패하면 총액이 근거와 어긋난 채 남는다.
- **과제 경계 검증** (§9 N-13과 같은 계열, FK가 막지 못하는 부분): `yearId`·`memberId`가 모두 그 과제 소속이어야 한다. `subcategory`는 부록 A.5에서 그 `category`에 정의된 코드여야 하고(PL-D4), `formula`는 PL-D3을 만족해야 한다.
- `reorderBudgetDetails`는 §7.13 T-D10과 같은 이유로 **그 세목의 전체 id 배열**을 받는다. 화면이 접혀 일부만 보이더라도 보이는 것만 보내지 않는다.

**Budget Detail Import** (Phase 10 — 산출근거 시트. §6.11, §7.9.3. 모두 서버 전용, 파일은 `FormData`)
```
inspectDetailSheet(formData)                  // 시트 목록 + 원본 그리드 + 섹션·비목·세목 트리 + 컬럼 매핑 (D-1~D-7)
previewDetailImport(formData, draft)          // 행 초안 + 성명 매칭 + 조정액 흡수 + 소계 대조 + 셀 충돌
commitDetailImport(formData, draft)           // RPC: commit_detail_import — 새 Member 생성·삭제·삽입·스냅샷을 한 트랜잭션
```
- **파싱은 서버에서만** 한다(I-13). SheetJS를 클라이언트 번들에 넣지 않는다
- `previewDetailImport`와 `commitDetailImport`는 **결정론적으로 같은 결과**를 내야 한다 — 같은 파이프라인 하나만 쓴다. `fileHash` 대조도 §5.12.2와 같다
- `commit_detail_import` RPC가 D-12(새 Member)·D-15(셀 교체)·D-16(단일 트랜잭션)·D-17(스냅샷)을 **같은 트랜잭션**에서 수행한다. `budget_details.amount`는 **서버 액션이 `lib/budget-plan.ts`로 계산**해 넘긴다(PL-10a — RPC에 산식을 넣지 않는다)

**조회**
```
getBudgetPlanData(projectId)   // 매트릭스 + 연차별 세목 소계 + 지침 검증 결과(PL-11~PL-13)
getBudgetDetails(yearId, category)   // 산출근거 패널. Member(이름·직위·연봉)를 함께 실어 보낸다
```
> 금액은 **서버에서 계산해 내린다**(`lib/budget-plan.ts`). 화면이 산식을 다시 구현하지 않는다 — §7.9.1 Step 4에서 겪은 O-4(같은 규칙이 두 곳에 생기면 반드시 어긋난다)와 같은 이유다.

**Budget Import** (모두 서버 전용, 파일은 `FormData`로 전달. 예산계획 전용)
```
inspectWorkbook(formData)                      // 시트 목록 + 상위 30행 원본 그리드 + 추천 시트 + 구조 추정
analyzeSheet(formData, sheetName, hints)       // 헤더행·방향·라벨열·연차열·금액단위 추정
previewImport(formData, draft: ImportDraft, projectId)
   → { rows: PreviewRow[], summary: { new, overwrite, skipped, skippedAmount, error, totalAmount,
       untouchedCategories }, fileHash }
commitImport(formData, draft: ImportDraft, projectId, profileId?)
   // RPC 단일 트랜잭션. draft.fileHash와 업로드 파일의 해시가 다르면 거부 (미리보기와 다른 파일 차단).
   // 반영 전 기존 계획액을 import_snapshots에 저장 (I-17)
   // profileId는 ImportDraft에 넣지 않고 별도 인자로 받는다 — 어떤 프로파일을 썼는지는
   // 사용 통계(markImportProfileUsed)와 스냅샷 출처 기록용이고 **파싱 결과에 영향이 없어서**
   // §5.12.2의 "모든 수동 결정을 한 값에" 불변식(파싱 결정론)에 속하지 않는다.
   // 파싱에 영향을 주는 프로파일 내용(ministry·categoryAliases 등)은 draft.profile에 이미 들어 있다.

createImportProfile(input)
updateImportProfile(id, patch)
deleteImportProfile(id)
listImportProfiles(kind, projectId)            // kind는 v2의 'execution' 부활 대비 인자. v1은 항상 'budget_plan'

listImportSnapshots(projectId)                 // §7.14 설정 화면 목록. 최신순. 과제별 최근 20개만 존재한다 (I-17)
restoreImportSnapshot(snapshotId)              // 스냅샷 시점의 계획액으로 되돌린다. 단일 RPC 트랜잭션.
   // I-17: 복원은 **새 스냅샷을 만들지 않고 행을 삭제하지도 않는다**
   // (임포트 시점에 없던 행은 0/null/null로 되돌릴 뿐이다)
```

> `previewImport`와 `commitImport`는 **같은 파싱 함수와 같은 `ImportDraft`를 공유**한다. 미리보기에서 본 것과 반영되는 것이 다르면 안 된다. 파일은 두 번 업로드되지만(스테이트리스 유지), `fileHash` 대조로 동일 파일임이 보장되고 결과는 결정론적으로 동일하다.

**Risk**
```
createRisk(projectId, input)
updateRisk(id, patch)
deleteRisk(id)
setRiskStatus(id, status)
reorderRisks(projectId, orderedIds)   // 다른 과제 소속 reorder와 같은 형태다 — 컨테이너가 없으면
                                      // RPC가 "이 id들이 전부 이 과제 것인가"를 검증할 수 없다.
                                      // (전역인 reorderProjects/reorderTodos만 projectId를 받지 않는다)
```

**Note**
```
createNote(input)
updateNote(id, patch)
deleteNote(id)
togglePinNote(id)
```

**Todo / Settings**
```
createTodo(input); updateTodo(id, patch); toggleTodo(id); deleteTodo(id); reorderTodos(orderedIds)
updateSettings(patch)
```

**Auth / Backup**
```
getCurrentUser()                     // 세션 + app_users 조회
listPendingUsers()                   // active=false 대기자
approveUser(userId)                  // A-3
deactivateUser(userId)
updateMyProfile(patch)               // 표시 이름, memberId 연결

exportAll()                          // §8.7 전체 JSON 덤프
importAll(json)                      // 전체 복원 (2단계 확인)
listBackups()
runHealthPing()                      // §14.6 F-2 자동 일시정지 방지
```

**조회 (서버 컴포넌트에서 직접 호출, 집계 완료 형태로 반환)**

> ⚠️ **이 블록은 설계 시점의 목록이고 구현과 이름이 어긋난 곳이 있다** (Phase 1~6에 걸쳐 누적).
> 실제로는 화면마다 필요한 조회를 병렬로 던지는 형태로 갈렸다 — 예: `getProjectOverview`는
> 구현되지 않았고 과제 개요가 `getProjectFullTree`+`getTeam`+`getGoalsData`+`getMilestonesData`
> +`getRiskMatrix`+`getNotesData` 6개를 `Promise.all`로 부른다. `getNotes(projectId, filter)`는
> `getNotesData(projectId)`이고 필터는 화면이 `lib/notes.ts`의 `filterNotes`로 건다.
> `getMilestonesData`·`getTeamScreenData`·`getProjectsSummary`는 이 목록에 아예 없다.
> **다음 정리 때 이 블록을 실제 이름으로 맞춘다.** 그때까지는 코드가 사실이다.

```
getDashboardData()
getProjectOverview(projectId)        // 미구현 — 위 주의 참조
getYearTree(yearId)                  // 진척률·WBS코드·날짜롤업 계산 완료 트리
getProjectFullTree(projectId)        // 전체 연차 통합 뷰
getGanttData(projectId, scale)       // 마일스톤 포함
getBoardData(projectId, yearId?)
getPriorityMatrix(projectId, yearId?) // 5×5 집계 + 점수 정렬 목록
getGoalsData(projectId)              // 성과목표 + 기술목표 + 달성률
getBudgetMatrix(projectId)
getRiskMatrix(projectId)
getNotes(projectId, filter)          // 실제: getNotesData(projectId), 필터는 화면 몫
```

---

## 10. 디렉터리 구조

```
/
├── app/
│   ├── layout.tsx
│   ├── page.tsx                        대시보드
│   ├── projects/
│   │   ├── page.tsx
│   │   └── [id]/
│   │       ├── layout.tsx              탭 네비게이션
│   │       ├── page.tsx                과제 개요
│   │       ├── wbs/page.tsx
│   │       ├── gantt/page.tsx
│   │       ├── board/page.tsx
│   │       ├── goals/page.tsx
│   │       ├── milestones/page.tsx
│   │       ├── budget/page.tsx
│   │       ├── team/page.tsx
│   │       ├── risks/page.tsx
│   │       └── notes/page.tsx
│   ├── todos/page.tsx
│   └── settings/page.tsx
├── actions/
│   ├── projects.ts   stages.ts   years.ts   tasks.ts
│   ├── milestones.ts deliverables.ts        tech-targets.ts
│   ├── organizations.ts  members.ts  budget.ts  budget-plan.ts
│   ├── risks.ts      notes.ts    todos.ts   settings.ts
│   ├── auth.ts       getCurrentUser, approveUser 등 (§9 Auth)
│   ├── backup.ts     exportAll, importAll (§8.7)
│   └── import.ts     inspectWorkbook ~ commitImport (§9 Budget Import)
├── components/
│   ├── ui/            Button, Badge, Modal, ProgressBar, ConflictDialog(O-3), ErrorBanner,
│   │                  Matrix5x5(§7.6 우선순위 · §7.11 리스크가 공유하는 5×5 히트맵),
│   │                  priorityTone.ts(부록 A.3 Todo 우선순위 색 — /todos와 대시보드 공용)
│   ├── print/         PrintHeader(§12 P-R1 @page 방향 주입 + P-R3 머리말), tokens.ts(표 인쇄 클래스)
│   ├── auth/          LoginScreen, PendingScreen, OnboardingModal (§7.0)
│   ├── settings/      SettingsForm(팀 설정), UserManagement, MyProfileForm,
│   │                  BackupPanel, ImportSnapshotPanel(I-17 목록·복원) (§7.14)
│   ├── dashboard/
│   ├── project/       OverviewPanel, StageYearTimeline, TabNav
│   ├── wbs/           TreeTable, TreeRow, TaskDetailPanel, YearSelector
│   ├── gantt/         GanttChart, GanttBar, MilestoneLane, TimeAxis
│   ├── board/         BoardScreen, KanbanBoard, Column, Card, PriorityMatrix,
│   │                  ViewToggle, priority-colors.ts(§6.9 등급 토큰 → 클래스)
│   ├── goals/         DeliverableTable, TechTargetTable, AchievementForm
│   ├── milestones/    MilestoneTimeline, MilestoneTable
│   ├── budget/        BudgetMatrix, ExecutionPanel, ModeToggle(§7.9 [제안|수행])
│   │   ├── plan/      DetailPanel(§7.9.2), SubcategorySection, PersonnelRow,
│   │   │              QuantityRow, FactorInputs, RateLimitBadges(PL-12·PL-13)
│   │   ├── import/    ImportWizard(모달+단계 상태기계), wizard-state.ts(공용 타입·헬퍼),
│   │   │              Step1File ~ Step5Preview, SheetGrid(원본 그리드·병합 렌더),
│   │   │              CategoryMapper, ImportPreviewTable
│   │   └── detail-import/  §7.9.3 산출근거 마법사 4단계 — 총괄표 마법사와 흐름을 공유하지 않는다
│   │                  (대상 계층이 다르다). StructureTree, MemberMapper, DetailPreviewTable
│   ├── team/          OrgCards, MemberTable
│   ├── risks/         RiskScreen, RiskMatrix, RiskTable, RiskFormModal,
│   │                  severity.ts(부록 A.3 색상 토큰 → Tailwind 클래스 매핑)
│   ├── notes/         NoteScreen, NoteList, MarkdownEditor, MarkdownViewer,
│   │                  LinkedNoteList(§7.12 역참조 — Task·Milestone 화면이 쓴다)
│   └── todos/         TodoScreen, TodoQuickAdd, TodoList, TodoRow, TodoFilters
├── lib/
│   ├── db/                             §8.6 리포지토리 레이어
│   ├── tree.ts                         buildTree, flatten, 순환검사, WBS코드
│   ├── progress.ts                     §6.1 4단계 롤업
│   ├── goals.ts                        §6.2 §6.3 달성률 계산
│   ├── budget.ts                       §6.4 집행률 계산
│   ├── budget-plan.ts                  §6.10 산출근거 금액·집계·지침 검증 (PL-1~PL-14)
│   ├── import/                         ★ 전부 순수 함수 — SheetJS를 import하지 않는다.
│   │   │                                 워크북 → RawSheet 변환은 어댑터(actions 쪽)의 몫이다.
│   │   ├── types.ts                    어댑터 경계(RawCell·MergeRange·RawSheet), 판정·금액 타입
│   │   ├── detail-sheet.ts             §6.11 산출근거 시트 구조 해석 (D-1~D-21)
│   │   ├── normalize.ts                I-1 정규화(순서 고정), I-3 유사도, 열 문자↔인덱스
│   │   ├── categorize.ts               §6.8.3 비목 매칭 (완전일치→별칭→축→스킵, 퍼지·모호)
│   │   ├── amount.ts                   §6.8.4 금액 파싱 + I-10 단위 힌트
│   │   ├── grid.ts                     S-11 병합 확장, S-2/S-2' carry-forward
│   │   ├── structure.ts                헤더행·데이터범위·라벨열·연차열(S-5)·S-13 시트추천·I-15
│   │   ├── matrix.ts                   S-1~S-13 통합 → ParsedRow[]
│   │   ├── preview.ts                  S-4·S-8·S-9 → PreviewRow[] + §9 summary
│   │   └── index.ts                    재수출 (preview/commit 공용 파싱 엔트리)
│   ├── priority.ts                     §6.9 긴급도·우선순위 점수
│   ├── gantt.ts                        §7.5 좌표 — 차트 범위·x좌표·눈금·오늘선·
│   │                                   연차 밴드·막대 기하·드래그 결과 날짜
│   ├── board.ts                        §7.6 컬럼 정의·5×5 셀 집계·재정렬 헬퍼
│   ├── risk.ts                         §6.5 등급 판정
│   ├── notes.ts                        §7.12 마크다운 파싱(→AST)·URL 안전 판정·
│   │                                   정렬/필터/검색·회의록 템플릿. ★ HTML 문자열을
│   │                                   만들지 않는다 — 뷰어가 AST를 React 엘리먼트로 옮긴다
│   ├── todos.ts                        §7.13 T-D 필터·정렬·지연 판정.
│   │                                   ★ /todos 화면과 대시보드가 같은 함수를 쓴다(T-D3)
│   ├── dates.ts                        마감 판정, 간트 좌표
│   ├── format.ts                       금액·퍼센트 표시 포맷
│   └── constants.ts                    비목 라벨, 유형 라벨, 색상 맵
├── types/index.ts
├── supabase/
│   ├── migrations/                     SQL 스키마 + RLS + publication (진실 공급원)
│   ├── functions/                      RPC 정의
│   └── seed.sql                        개발용 시드 — 부록 B.1 구조 그대로
│                                       (과제 1 + 단계 1 + 연차 2 + Task 5). 검증 예시가 곧 테스트 데이터
├── src-tauri/                          Tauri 셸, 딥링크 핸들러
└── .env.local                          SUPABASE_URL, SUPABASE_ANON_KEY
```

---

## 11. 구현 순서

| Phase | 범위 | 완료 기준 |
|---|---|---|
| **0. 기반** | Supabase 프로젝트 생성, 전체 SQL 스키마 + RLS 마이그레이션, 타입·Zod 스키마, 리포지토리 16종, 매퍼 | 시드 데이터 CRUD 테스트 통과 |
| **0.5 셸 + 인증** | Tauri 껍데기, 구글 OAuth 딥링크 로그인, `app_users` 승인 흐름, 백업/복원(§8.7) | 두 PC에서 각자 로그인해 같은 데이터가 보임 |
| **1. 계층 + WBS** | 과제 CRUD, 단계·연차 CRUD, WBS 트리 화면, Task CRUD·트리조작, 4단계 진척률 롤업 | 연차별 작업을 쪼개고 진척률이 과제까지 전파됨 |
| **2. 인력 + 기관** | 기관·인력 CRUD, Task 담당자 배정 | WBS에 담당자·기관이 표시됨 |
| **3. 목표 관리** | 성과목표·기술목표 CRUD, 실적/측정 기록, 달성률 계산 | 목표 대비 실적이 숫자로 보임 |
| **4. 마일스톤 + 대시보드** | 마일스톤 CRUD·자동생성, 마감 판정, 대시보드 집계 | 평가·제출 마감이 먼저 보임 |
| **5. 연구비** | 비목 매트릭스, 예산 편집, 집행 등록, 집행률 | 연차별 집행 현황이 보임 |
| **5.5 엑셀 임포트** | 파싱 파이프라인, 5단계 마법사, 프로파일 저장, 반영 전 스냅샷(I-17) | 실제 보유 엑셀 파일이 오류 없이 반영됨 |
| **6. 리스크 + 노트** | 리스크 매트릭스·대장, 마크다운 노트·회의록 템플릿 | 회의록이 과제에 붙음 |
| **7. 간트 + 칸반** | 간트(연차 밴드·마일스톤 레인), 칸반 드래그 | 일정이 시각화됨 |
| **8. To-Do + 설정 + 마감** | To-Do, 설정, 인쇄 레이아웃, 정리 | 전체 기능 동작 |
| **9. 예산 제안 모드** | `budget_details` 스키마+RLS, `lib/budget-plan.ts`, 산출근거 패널, 연구비 화면 [제안\|수행] 토글, 지침 검증, Member 연봉·채용구분 | 실측 산자부 1차년도 인건비 18행을 앱에 넣으면 부록 B.7의 합계(현금 180,840,000 / 현물 88,650,000)와 간접비 비율 0.9622%가 그대로 나온다 |

| **10. 산출근거 시트 임포트** | `lib/import/detail-sheet.ts`(D-1~D-10·D-21), 성명 매칭(D-11~D-14), `commit_detail_import` RPC, 4단계 마법사(§7.9.3) | 실측 산자부 `1차년도_250520` 시트를 넣으면 부록 B.8의 행 수·금액이 그대로 들어가고, 인건비 셀 합계가 부록 B.7의 현금 180,840,000 / 현물 88,650,000과 일치한다 |

> **Phase 10 범위 밖**: ① 제출 서식 **엑셀 내보내기**(§13 14번 — 별도 Phase) ② 프로파일 저장(D-20 — 헤더 텍스트 매핑이라 재사용할 결정이 없다) ③ 총괄표와 산출근거를 한 마법사로 합치기(§7.9.1과 §7.9.3은 대상 계층이 달라 흐름을 공유하지 않는다)

> Phase 9는 v1(Phase 0~8) 완료 후에 착수한다. **스키마 변경(`budget_details` 신설, `members`·`projects` 컬럼 추가)이 동반되므로 Phase 8에 끼워 넣지 않는다.** `budget_items.plannedAmount`의 소유권이 바뀌는 변경(PL-9·PL-10)이라 §6.4 집행률·§7.2 대시보드·§6.8 임포트가 전부 영향권이다 — 이 셋의 회귀 테스트를 먼저 확인하고 들어간다.

> **Phase 9 범위 밖 (사용자 결정)**: ① 산출근거 시트의 **엑셀 임포트** — 앱에서 직접 입력한다. ② 제출 서식 **엑셀 내보내기** — 병합·수식 재현 비용이 커서 별도 Phase로 남긴다. ③ 기관별 예산 분배(§2.2 유지) — 실측 `검토_*` 시트가 이 구조지만 v1 제외 결정을 뒤집지 않는다.

> **Phase 9에서 함께 손대야 하는 기존 코드** (빠뜨리면 조용히 깨진다): ① **§8.7 백업/복원의 대상 테이블 목록에 `budget_details`를 추가**한다 — 누락되면 백업에 산출근거가 빠지고 K-7 전체 대체 복원이 근거만 지운다. ② `tests/destructive/guard.ts`의 대상 테이블도 같이 늘린다. ③ **§6.8 `commit_import` RPC에 S-14 잠금 검사**를 넣는다. ④ `create_project_with_defaults`는 그대로 둔다 — 산출근거는 자동 생성 대상이 아니다.

> Phase 5.5는 **실제 엑셀 파일 샘플이 확보된 뒤에** 착수한다. 서식을 모르는 상태로 파서를 만들면 헛수고가 된다. `lib/import/` 전체를 순수 함수로 만들고 샘플 파일 기반 단위 테스트를 작성한다.

> **필수 1**: `lib/tree.ts`, `lib/progress.ts`, `lib/goals.ts`, `lib/budget.ts`, `lib/budget-plan.ts`, `lib/priority.ts`, `lib/risk.ts`, `lib/dates.ts`, `lib/todos.ts`, `lib/import/`(**`detail-sheet.ts` 포함**)는 순수 함수로 만들고 **단위 테스트를 반드시 작성**한다(Vitest). 특히 §6.3 기술목표 달성률은 방향성·baseline 조합에서 실수가 나기 쉽다.
>
> **필수 2**: Phase 0에서 RLS를 켜지 않고 시작하면 나중에 켤 때 전부 깨진다. **처음부터 켜고** 개발한다.
>
> **필수 3**: §8.7 백업은 Phase 0.5에 넣는다. 무료 플랜에 백업이 없으므로 데이터가 쌓이기 전에 안전망을 만든다.

---

## 12. 비기능 요구사항

| 항목 | 기준 |
|---|---|
| 데이터 규모 | 과제 30개, 연차 150개, 작업 5,000개, 노트 1,000건까지 정상 동작 |
| 응답 속도 | 페이지 초기 렌더 1s 이내 (네트워크 왕복 포함) |
| 계산 성능 | 5,000 노드 4단계 롤업 100ms 이내 |
| 브라우저 | 최신 Chrome / Safari |
| 반응형 | 1440px 이상 최적화(테이블 컬럼이 많음). 1024px 이상 사용 가능 |
| 접근성 | 키보드 조작 가능(WBS 트리·인라인 편집 필수), 포커스 표시 유지 |
| 인쇄 | 기술목표표, 리스크 대장, 예산 매트릭스는 A4 인쇄 레이아웃 제공 |
| 금액 | 정수(원) 저장. 표시만 환산. 부동소수점 연산 금지 |
| 백업 | 주 1회 자동 JSON 내보내기 (§8.7). 무료 플랜에 DB 백업 없음 |
| 실시간 반영 | 다른 사람의 변경이 보이기까지 5초 이내 (Realtime), 폴백 시 30초 |
| DB 용량 | 최대 규모에서 100MB 이내 유지. **200MB 도달 시 경고·원인 점검** (무료 한도 500MB, 이전 검토 400MB — §14.5) |
| 월 송신량 | 2GB 이내 유지. **3GB 도달 시 경고** (무료 한도 5GB, 이전 검토 4GB) |
| 동시 접속 | Realtime 구독 6명 × 화면당 최대 4테이블 = 24 연결 이내 (무료 한도 200, §8.5 구독표) |
| 설치 | 관리자 권한 없이 사용자 폴더에 설치 가능할 것 |
| 네트워크 단절 | 읽기 전용 배너로 명확히 알리고 쓰기 차단. 무음 실패 금지 |
| 에러 | 데이터 손상 시 조용히 넘어가지 않고 명시적으로 알림 |

**검증 방법** (Phase 8 마감 시 확인한다):

| 항목 | 어떻게 확인하나 |
|---|---|
| 계산 성능 | Vitest 단위 테스트로 **작업 5,000개를 합성해 `computeProgressMap` 왕복 시간을 측정**하고 100ms를 넘으면 실패시킨다. 실행 PC마다 편차가 있으므로 임계값은 **여유를 두되 실패는 실패로 다룬다** — 통과 로그를 남겨 회귀를 눈으로 볼 수 있게 한다 |
| 인쇄 | 대상 3화면에서 `window.print()` 미리보기를 A4로 띄워 표가 잘리지 않고 헤더가 읽히는지 사람이 확인한다. 자동 검증 대상이 아니다 |

**인쇄 레이아웃 규칙 (P-R)**

| ID | 규칙 |
|---|---|
| P-R1 | 용지는 A4, 여백 12mm. **방향은 표마다 다르다** — 예산 매트릭스(12행 × 연차 N열)와 리스크 대장(9컬럼)은 **가로(landscape)**, 기술목표표는 **세로(portrait)**. `@page` 규칙을 화면별로 건다 |
| P-R2 | 표 헤더(`thead`)는 페이지마다 반복하고, 행(`tr`)은 페이지 경계에서 쪼개지 않는다(`break-inside: avoid`) |
| P-R3 | 머리말에 **과제명 · 출력일**을 넣는다. 인쇄물만 보고 무엇을 언제 뽑았는지 알 수 없으면 종이로서 쓸모가 없다 |
| P-R4 | 내비게이션·탭·버튼·실시간 배너·편집 컨트롤은 `print:hidden`. 인쇄물에 UI 잔재를 남기지 않는다 |
| P-R5 | 색으로만 구분되는 정보(집행률 초과 빨강, 리스크 등급)는 **흑백 출력에서도 읽히게** 글자나 기호를 함께 둔다 |
| 데이터 규모 | 성능 테스트의 합성 데이터가 이 규모(작업 5,000)를 쓴다. DB 규모 검증은 실사용 축적 후 §14.6 F-5로 감시한다 |
| 나머지(응답 속도·브라우저·반응형·접근성) | 사람이 실제 화면에서 확인한다. 자동 검증을 흉내 내지 않는다 |

---

## 13. 미결정 / v2 후보

| # | 항목 | 메모 |
|---|---|---|
| ~~1~~ | ~~참여연구원 참여율(%) 관리~~ | **해소 (v4.0 / Phase 9).** Member가 아니라 `BudgetDetail`(연차 × 인력)이 갖는다 — 한 사람이 한 연차 안에서 참여율을 바꾸는 실측 사례가 Member 단일 필드로는 표현되지 않는다 (§5.11) |
| 1-a | 역할 기반 권한 (RBAC) | 현재는 승인된 사용자 전원 동일 권한 |
| 1-b | 오프라인 편집 | 로컬 캐시 + 동기화 큐. 복잡도 큼 |
| 1-c | 웹 병행 배포 | 백엔드가 있으므로 Vercel 배포는 언제든 가능 |
| 2 | 증빙 파일 업로드 | Supabase Storage 사용 가능해짐 (무료 1GB). 우선순위 상향 검토 |
| 3 | 기관별 연구비 분배 | 현재는 Organization에 단일 참고값만 |
| 4 | 작업 간 선후행 의존관계 | 간트 화살표 |
| 5 | 노트 액션아이템 → Task 자동 동기화 | |
| 6 | 보고서 자동 생성 (연차실적계획서 초안) | docx 출력. 데이터가 모이면 실효성 큼 |
| 7 | CSV / Excel 내보내기 | |
| 8 | 전역 검색 | 노트·작업·성과 통합 |
| 9 | 다크 모드 | |
| 10 | 변경 이력 / 감사 로그 | Postgres 트리거로 구현 가능해짐 |
| 11 | 과제 템플릿 (WBS·목표 구조 재사용) | |
| 12 | ~~SQLite 전환~~ | v3.0에서 PostgreSQL 채택으로 해소 |
| 12-a | 집행내역 엑셀 임포트 | v3.2에서 설계 제외. 집행은 수동 입력. 필요해지면 `ImportKind`에 `'execution'`을 되살리고 중복 방지(sourceHash)·배치 되돌리기를 재설계 |
| 13 | 성과목표·기술목표 엑셀 임포트 | 예산 파이프라인(`lib/import/`)을 재사용하면 확장 가능 |
| 14 | 임포트 결과 → 엑셀 역방향 내보내기 | 제출용 서식으로 되돌리기. **Phase 9에서 범위 밖으로 확정** — 산출근거가 앱에 쌓이면 실효성이 커지므로 Phase 10 후보 |
| ~~16~~ | ~~산출근거 시트 엑셀 임포트~~ | **해소 (v4.1 / Phase 10).** §6.11·§7.9.3. `lib/import/` 파이프라인을 그대로 재사용하고 행 구조 해석만 얹었다 |
| 17 | 부처별 지침 고시율 프리셋 | PL-16에 따라 코드에 넣지 않았다. 출처가 확실한 표를 확보하면 **사용자 입력의 기본값 제안**으로만 도입 |
| 15 | 집행내역 자동 이상 탐지 | 예산 초과, 비목 편중, 이례적 금액 경고 |

---

## 14. 배포·인증·이전 전략

### 14.1 배포 형태

**Tauri v2 데스크톱 앱.** Next.js standalone 빌드를 사이드카로 띄우고 WebView가 `http://127.0.0.1:{랜덤포트}`에 접속한다.

| 항목 | 내용 |
|---|---|
| 대상 OS | Windows 우선. macOS는 여력 되면 |
| 배포 | **NSIS 설치 파일(`*_x64-setup.exe`)을 배포한다.** 사내 공유 폴더에 두고 각자 설치 |
| ⚠️ MSI를 쓰지 않는 이유 | `bundle.targets`가 `["msi","nsis"]`라 빌드하면 **둘 다 나오지만, MSI는 배포하지 않는다.** Tauri v2는 MSI에 `installMode`를 지원하지 않아 WiX 산출물이 구조적으로 `InstallScope="perMachine"`이 되고 **관리자 권한을 요구한다** — §12의 "관리자 권한 없이 사용자 폴더에 설치 가능할 것"을 만족하지 못한다. NSIS만 `installMode: "currentUser"` → `RequestExecutionLevel user` + `$LOCALAPPDATA` 설치로 §12를 만족한다. **두 파일을 함께 공유 폴더에 두면 사용자가 admin이 필요한 쪽을 집는다** — setup.exe만 올린다 |
| 포트 | 랜덤 할당 후 사이드카에 전달. 고정 포트 금지 |
| 코드 서명 | v1에서는 하지 않는다. Windows SmartScreen 경고는 감수 |
| 자동 업데이트 | v1 제외. 공유 폴더의 새 설치 파일로 수동 갱신 |
| 환경변수 | Supabase URL·anon 키는 빌드에 포함한다. **service_role 키는 절대 포함하지 않는다** |

> **웹 배포도 가능하다는 점을 기록해 둔다.** 백엔드가 생겼으므로 같은 코드를 Vercel에 올리면 설치·업데이트 부담이 사라진다. 데스크톱 앱을 선택한 것은 사내 정책과 선호에 따른 것이며, 기술적 제약이 아니다. 필요해지면 언제든 병행할 수 있다.

### 14.2 인증

**Supabase Auth + Google OAuth.** 회사 구글 계정으로 로그인한다.

```ts
supabase.auth.signInWithOAuth({
  provider: 'google',
  options: {
    queryParams: { hd: 'company.co.kr' },   // 회사 도메인만 노출
    redirectTo: 'wbs://auth-callback',       // Tauri 딥링크
  },
});
```

**AppUser 테이블**

```ts
interface AppUser {
  id: string;          // auth.users.id 와 동일 (FK)
  email: string;
  name: string;        // 표시 이름
  memberId: string | null;  // 과제 참여인력(Member)과 연결. 선택
  active: boolean;     // false면 로그인은 되지만 데이터 접근 차단
  createdAt: string;
  updatedAt: string;
  lastSeenAt: string;  // SA-1에서 하루 1회 갱신
}
```

| # | 규칙 |
|---|---|
| A-1 | 데스크톱 앱은 **시스템 브라우저**로 OAuth를 연다. WebView 안에서 구글 로그인을 처리하지 않는다(구글이 차단한다). 콜백은 `wbs://` 딥링크로 받는다. |
| A-2 | `hd` 파라미터는 편의 기능일 뿐 보안 수단이 아니다. **서버 측에서 이메일 도메인을 반드시 재검증**한다. 허용 도메인은 env 변수 `ALLOWED_EMAIL_DOMAIN`에 둔다(하드코딩 금지). |
| A-3 | **`app_users` 행 생성은 `auth.users` AFTER INSERT 트리거**(`security definer` 함수 `handle_new_user`, X-2 예외)가 수행한다 — 클라이언트·서버 액션의 INSERT가 아니다(INSERT 정책 자체가 없다). 기본 `active=false`. **첫 사용자 자동 승인**은 이 트리거 안에서 `pg_advisory_xact_lock` + `count(*)=0` 판정으로 처리한다(동시 첫 로그인 경합 차단). |
| A-4 | 세션 토큰은 OS 키체인에 저장한다. 토큰 갱신 실패 시 재로그인을 요구한다. |
| A-5 | 역할 구분은 없다. 승인된 사용자는 모두 동일한 읽기·쓰기 권한을 가지며, **누구나 대기자를 승인할 수 있다**(`approve_user` RPC — 호출자가 active일 때만 통과). |

### 14.3 RLS 정책

모든 테이블에 RLS를 켠다. 정책은 단순하다 — **승인된 사용자면 전부 허용, 아니면 전부 차단.**

```sql
-- 헬퍼: 행마다 서브쿼리를 반복하지 않기 위한 함수 (stable + security definer)
create or replace function is_approved() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from app_users where id = auth.uid() and active = true);
$$;

alter table tasks enable row level security;

create policy "approved users full access" on tasks
  for all to authenticated
  using (is_approved())
  with check (is_approved());
```

| # | 규칙 |
|---|---|
| RLS-1 | **모든 테이블에 예외 없이 RLS를 켠다.** 새 테이블 추가 시 정책 작성이 누락되지 않도록 마이그레이션 체크리스트에 넣는다. 정책은 `to authenticated`를 명시한다(anon 평가 배제). |
| RLS-2 | `app_users`는 별도 정책을 쓴다 — SELECT: 승인 사용자는 전체, 미승인은 본인 행만. UPDATE: **본인 행만** (`using/with check (id = auth.uid())`) + `active`·`email`·`id` 컬럼 변경은 BEFORE UPDATE **트리거로 거부** (RLS는 컬럼 단위를 표현하지 못한다). INSERT/DELETE 정책 없음 — 생성은 A-3 트리거, 승인·비활성화는 `approve_user`/`deactivate_user` RPC(`security definer`)만 가능. 자기 자신은 승인 불가. |
| RLS-3 | RLS 정책은 애플리케이션 검증의 **대체재가 아니라 최후 방어선**이다. 서버 액션의 Zod 검증은 그대로 유지한다. |

### 14.4 온보딩

```
① 로그인          회사 구글 계정 (시스템 브라우저)
② 승인 대기       app_users.active = false 이면 대기 화면
③ 표시 이름 확인   구글 프로필 이름 기본값, 수정 가능
④ 백업 폴더 지정   §8.7 자동 내보내기 대상 (드라이브 동기화 폴더 권장)
⑤ 진입
```

기존 파일 DB 기반 온보딩(저장소 루트 지정)은 사라진다. 대신 **백업 폴더 지정**이 남는다.

### 14.5 NAS 이전 (예정)

사내 NAS가 확보되면 **Supabase를 셀프호스팅**한다. 파일 공유 방식으로 되돌아가지 않는다 — 그것은 동시 편집 기능을 잃는 후퇴다.

```
현재:  Tauri 앱 ──▶ Supabase Cloud (무료 플랜)
이후:  Tauri 앱 ──▶ NAS의 Supabase (Docker, 사내망)
```

| # | 규칙 |
|---|---|
| M-1 | Supabase 공식 `docker-compose`를 NAS(Synology/QNAP Docker)에 올린다. Postgres·Auth·PostgREST·Realtime이 한 묶음이다. |
| M-2 | **앱 코드는 바뀌지 않는다.** `SUPABASE_URL`과 `SUPABASE_ANON_KEY`만 교체한다. 이것이 §8.6 리포지토리 레이어를 강제한 이유다. |
| M-3 | 데이터 이전은 `pg_dump` → `pg_restore`. 마이그레이션 파일이 Git에 있으므로 스키마는 재현 가능하다. |
| M-4 | 이전 전에 §8.7 전체 내보내기를 실행해 JSON 백업을 확보한다. |
| M-5 | 셀프호스팅 후에는 **NAS 백업이 곧 DB 백업**이 된다. NAS 자체 스냅샷 기능을 켠다. |
| M-6 | 사내망 전용이 되므로 재택·외부 접속은 VPN이 필요해진다. 이전 전에 확인한다. |

**전환 시점 판단 기준**

| 신호 | 대응 |
|---|---|
| DB 용량이 400MB 근접 | 이전 검토 (현재 예상 40MB. 여유 충분) |
| 월 송신량 4GB 근접 | 이전 검토 (현재 예상 1GB 미만) |
| 자동 일시정지를 반복해서 겪음 | 우선 주간 헬스체크 핑으로 대응 |
| 데이터를 사외에 두는 것이 문제가 됨 | 즉시 이전 |

### 14.6 무료 플랜 운용 수칙

| # | 내용 |
|---|---|
| F-1 | **7일 무활동 시 프로젝트가 자동 일시정지된다.** 데이터는 보존되지만 수동 재개가 필요하다. 장기 휴가 전에 대비한다. |
| F-2 | 방지책: 앱이 주 1회 가벼운 헬스체크 쿼리를 날리도록 한다. 다만 아무도 앱을 켜지 않으면 소용없으므로, 외부 모니터링(UptimeRobot 등)이나 스케줄러 핑을 병행한다. |
| F-3 | **무료 플랜에는 백업이 없다.** §8.7 자동 내보내기가 유일한 안전망이다. 반드시 구현한다. |
| F-4 | 활성 프로젝트 2개 제한. 개발용·운영용으로 정확히 나눠 쓴다. |
| F-5 | 무료 플랜 한도를 넘기면 서비스가 402를 반환하며 전면 중단된다. 사용량 알림을 대시보드에서 켜둔다. |
| F-6 | 한도 초과 시 즉시 대응책은 Pro 플랜($25/월) 전환이다. NAS 이전보다 빠른 임시 조치로 기억해 둔다. |

---

## 부록 A. 상수 정의

### A.1 비목 라벨
| 값 | 표시 | 구분 |
|---|---|---|
| `personnel` | 인건비 | 직접비 |
| `student_personnel` | 학생인건비 | 직접비 |
| `facility_equipment` | 연구시설·장비비 | 직접비 |
| `material` | 연구재료비 | 직접비 |
| `consignment` | 위탁연구개발비 | 직접비 |
| `international` | 국제공동연구개발비 | 직접비 |
| `burden` | 연구개발부담비 | 직접비 |
| `activity` | 연구활동비 | 직접비 |
| `promotion` | 연구과제추진비 | 직접비 |
| `allowance` | 연구수당 | 직접비 |
| `indirect` | 간접비 | 간접비 |
| `other` | 기타 | — |

### A.2 성과목표 유형 라벨
| 값 | 표시 | 기본 단위 |
|---|---|---|
| `paper_sci` | SCI(E) 논문 | 건 |
| `paper_domestic` | 국내 학술지 논문 | 건 |
| `conference` | 학술대회 발표 | 건 |
| `patent_dom_apply` | 국내 특허 출원 | 건 |
| `patent_dom_reg` | 국내 특허 등록 | 건 |
| `patent_intl_apply` | 해외 특허 출원 | 건 |
| `patent_intl_reg` | 해외 특허 등록 | 건 |
| `sw_registration` | SW 프로그램 등록 | 건 |
| `tech_transfer` | 기술이전 | 건 |
| `commercialization` | 사업화 | 건 |
| `standard` | 표준화 | 건 |
| `hr_training` | 인력양성 | 명 |
| `other` | 기타 | 건 |

### A.3 색상 규약
| 대상 | 값 | Tailwind |
|---|---|---|
| Task | `todo` | `slate-400` |
| Task | `in_progress` | `blue-500` |
| Task | `done` | `emerald-500` |
| Task | `blocked` | `rose-500` |
| 마감 | `overdue` | `red-600` |
| 마감 | `dueSoon` | `amber-500` |
| Milestone | `annual_eval` / `stage_eval` / `final_eval` | `violet-600` |
| Milestone | `report` | `sky-600` |
| Milestone | `progress_check` | `teal-600` |
| Milestone | `contract` / `demo` / `custom` | `slate-600` |
| 우선순위 | score 15~25 (최우선) | `red-600` |
| 우선순위 | score 8~14 (높음) | `amber-500` |
| 우선순위 | score 4~7 (보통) | `slate-500` |
| 우선순위 | score 1~3 (낮음) | `slate-400` |
| Todo 우선순위 | `high` | `red` 뱃지 톤 |
| Todo 우선순위 | `normal` | `blue` 뱃지 톤 |
| Todo 우선순위 | `low` | `neutral` 뱃지 톤 |
| Risk | score ≥ 15 | `red-600` |
| Risk | 8 ≤ score < 15 | `amber-500` |
| Risk | score < 8 | `emerald-600` |
| Org | `lead` | `indigo-600` |
| Org | `joint` | `sky-600` |
| Org | `consign` | `slate-500` |
| Project 상태 | `planning` | `slate-400` |
| Project 상태 | `active` | `blue-500` |
| Project 상태 | `on_hold` | `amber-500` |
| Project 상태 | `done` | `emerald-500` |
| Project 상태 | `dropped` | `rose-500` |
| Year 상태 | `planned` | `slate-400` |
| Year 상태 | `active` | `blue-500` |
| Year 상태 | `evaluating` | `amber-500` |
| Year 상태 | `closed` | `emerald-500` |
| Project 색상 미지정 폴백 | `''` | `slate-500` |

### A.4 기타 enum 한글 라벨

`lib/constants.ts`의 라벨 맵은 **모든 enum 값을 빠짐없이 덮는다** (누락 시 화면에 원시 코드가 노출된다).

| enum | 값 → 표시 |
|---|---|
| ProjectStatus | planning 기획 · active 수행중 · on_hold 중단 · done 종료 · dropped 탈락 |
| TaskStatus | todo 예정 · in_progress 진행중 · done 완료 · blocked 막힘 |
| YearStatus | planned 계획 · active 수행중 · evaluating 평가중 · closed 종료 |
| MilestoneType | annual_eval 연차평가 · stage_eval 단계평가 · final_eval 최종평가 · progress_check 진도점검 · report 보고서 제출 · contract 협약 · demo 시연/시험 · custom 기타 |
| MilestoneStatus | planned 예정 · preparing 준비중 · done 완료 · delayed 지연 · cancelled 취소 |
| OrgRole | lead 주관 · joint 공동 · consign 위탁 |
| MemberRole | pm 총괄책임자 · pl 책임자 · researcher 연구원 · staff 지원 |
| MeasureMethod | self 자체측정 · certified_lab 공인시험 · expert_review 전문가평가 · customer 수요처평가 · other 기타 |
| Direction | higher_better 높을수록 우수 · lower_better 낮을수록 우수 · target_exact 목표값 일치 |
| RiskCategory | technical 기술 · schedule 일정 · budget 예산 · resource 인력 · external 외부 · other 기타 |
| RiskStrategy | mitigate 완화 · avoid 회피 · transfer 전가 · accept 수용 |
| RiskStatus | identified 식별 · monitoring 관찰중 · occurred 발생 · resolved 해결 · closed 종결 |
| NoteType | meeting 회의록 · tech 기술메모 · issue 이슈 · idea 아이디어 · report_draft 보고서 초안 · other 기타 |
| Priority (Todo) | low 낮음 · normal 보통 · high 높음 |
| HireType | existing 기존인력 · new 채용예정 |
| DetailAxis | cash 현금 · in_kind 현물 |
| DetailFormula | personnel 인건비산식 · quantity 단가×수량 |

### A.5 세목 프리셋 (예산 제안 §5.17)

`lib/constants.ts`에 `SUBCATEGORY_PRESETS: Record<BudgetCategory, SubcategoryDef[]>`로 정의한다. 실측 워크북 2종(산자부·행안부)의 산출근거 시트에서 **세목 구성이 거의 동일**했고, 국가연구개발혁신법 시행규칙 별표의 세목 체계로 수렴한다. 부처 차이는 부록 C(비목 별칭)와 같은 방식으로 흡수하며 **스키마는 바뀌지 않는다.**

```ts
interface SubcategoryDef {
  code: string;              // BudgetDetail.subcategory에 저장되는 값
  label: string;             // 화면 표시. 서식의 번호(①②…)를 포함한다
  formula: DetailFormula;
  defaultFactors: { label: string; isPercent: boolean }[];  // 행 추가 시 채워지는 인자 (PL-3)
}
```

| 비목 | 세목 코드 | 표시 | formula | 기본 인자 |
|---|---|---|---|---|
| `personnel` | `personnel_internal` | 내부인건비 | personnel | 참여율(%) · 참여기간(월) |
| `personnel` | `personnel_external` | 외부인건비 | personnel | 참여율(%) · 참여기간(월) |
| `personnel` | `personnel_support` | 연구지원인력인건비 | personnel | 참여율(%) · 참여기간(월) |
| `student_personnel` | `student_general` | 일반 | personnel | 참여율(%) · 참여기간(월) |
| `student_personnel` | `student_managed` | 통합관리 | personnel | 참여율(%) · 참여기간(월) |
| `facility_equipment` | `facility_purchase` | ① 연구시설·장비 구입·설치비 | quantity | 수량 |
| `facility_equipment` | `facility_lease` | ② 연구시설·장비 임차비 | quantity | 수량 |
| `facility_equipment` | `facility_maintain` | ③ 연구시설·장비 운영·유지비 | quantity | 수량 |
| `facility_equipment` | `facility_infra` | ④ 연구인프라 조성비 | quantity | 수량 |
| `material` | `material_purchase` | ① 연구재료 구입비 | quantity | 수량 |
| `material` | `material_manage` | ② 연구개발과제 관리비 | quantity | 수량 |
| `material` | `material_make` | ③ 연구재료 제작비 | quantity | 수량 |
| `activity` | `activity_outsourcing` | ① 외주용역비 | quantity | 수량 |
| `activity` | `activity_ip` | ② 지식재산 창출 활동비 | quantity | 회 · 월 |
| `activity` | `activity_expert` | ③ 외부 전문기술 활용비 | quantity | 회 · 월 |
| `activity` | `activity_meeting` | ④ 회의비 | quantity | 회 |
| `activity` | `activity_travel_dom` | ⑤ 국내출장비 | quantity | 인원 · 횟수 |
| `activity` | `activity_travel_intl` | ⑤ 국외출장비 | quantity | 인원 · 횟수 |
| `activity` | `activity_software` | ⑥ 소프트웨어 활용비 | quantity | 수량 · 월 |
| `activity` | `activity_lab_ops` | ⑦ 연구실 운영비 | quantity | 횟수 |
| `activity` | `activity_hr_support` | ⑧ 연구인력 지원비 | quantity | 인원 · 횟수 |
| `activity` | `activity_pmo` | ⑨ 종합사업관리비 | quantity | 회 · 월 |
| `activity` | `activity_cloud` | ⑩ 클라우드컴퓨팅서비스 이용료 | quantity | 회 · 월 |
| `activity` | `activity_etc` | ⑪ 그 밖의 비용 | quantity | 회 |
| `allowance` | `default` | 연구수당 | quantity | — |
| `international` | `default` | 국제공동연구개발비 | quantity | 수량 |
| `consignment` | `default` | 위탁연구개발비 | quantity | 수량 |
| `burden` | `default` | 연구개발부담비 | quantity | — |
| `promotion` | `default` | 연구과제추진비 | quantity | 회 |
| `indirect` | `indirect_hr` | 가. 인력지원비 | quantity | — |
| `indirect` | `indirect_support` | 나. 연구지원비 | quantity | — |
| `indirect` | `indirect_outcome` | 다. 성과활용지원비 | quantity | — |
| `other` | `default` | 기타 | quantity | — |

> **주의 1 — `단가`는 인자가 아니다.** 표의 "기본 인자"는 `unitPrice`에 **곱해지는** 값들이다. 실측 서식의 `단가 | 회 | 월` 3열은 여기서 `unitPrice` + 인자 `회`·`월`로 나뉜다.
>
> **주의 2 — 인자 라벨은 행마다 바꿀 수 있다** (PL-3). 프리셋은 행 추가 시의 **초기값**일 뿐이다. 실측에서도 ⑥ 소프트웨어 활용비의 수량 라벨이 `시트(수량)`였다. 라벨을 고정하면 이런 변형마다 스키마를 고쳐야 한다.
>
> **주의 3 — `default`는 "세목 없음"의 코드다.** 서식에 세목 구분이 없는 비목이 실제로 존재한다(연구수당·연구개발부담비). null 대신 문자열 상수를 쓰는 이유는 `(year, category, subcategory)` 기준 집계에서 null 비교를 피하기 위해서다.

---

## 부록 B. 계산 검증 예시

### B.0 우선순위 점수

| 작업 | 중요도 | 마감일 | 오늘 기준 | 긴급도 | 점수 | 등급 |
|---|---|---|---|---|---|---|
| 학습·튜닝 (기술목표 연계) | 5 | 2일 후 | 마감 2일 전 | 5 | **25** | 최우선 |
| 중간보고서 초안 | 4 | 5일 후 | 마감 5일 전 | 4 | **16** | 최우선 |
| 데이터 정제 | 3 | 지난주 | 지연 | 5 | **15** | 최우선 |
| 문헌 추가조사 | 2 | 20일 후 | 마감 20일 전 | 2 | **4** | 보통 |
| 코드 리팩터링 | 3 | 없음 | — | 2 | **6** | 보통 |
| 요구사항 정의 (완료) | 4 | 지난달 | 완료 | 1 | **4** | 보통(흐림 — PR-6은 표시·정렬만 바꾸고 등급은 그대로다) |

`데이터 정제`는 중요도가 3에 불과하지만 지연되어 긴급도 5를 받아 최우선으로 올라온다. **이것이 자동 긴급도를 쓰는 이유다** — 손으로 관리하면 이 전환을 놓친다.

### B.1 진척률 4단계 롤업

```
과제 A
└─ 1단계 (budget 600,000,000)
   ├─ 1차년도 (budget 200,000,000)
   │  └─ [루트] 요구사항 분석  (est 40h)  → 100%
   │     ├─ 문헌조사       (est 16h) done      → 100
   │     └─ 요구사항 정의   (est 24h) done      → 100
   └─ 2차년도 (budget 400,000,000)
      ├─ [루트] 모델 개발    (est 100h)         → ?
      │  ├─ 데이터 구축     (est 40h)  100%     → 100
      │  └─ 학습·튜닝       (est 60h)  30%      → 30
      └─ [루트] 시스템 통합  (est 50h)  0%       → 0
```

- `모델 개발` = (100×40 + 30×60) / 100 = (4000 + 1800) / 100 = **58**
- `1차년도` = 100
- `2차년도` = (58×100 + 0×50) / 150 = 5800/150 = **38.7**
- `1단계` (budget 가중) = (100×200,000,000 + 38.7×400,000,000) / 600,000,000 = **59.1**
- `과제 A` = 단계가 1개이므로 **59.1 → 표시 59%**

### B.2 기술목표 달성률

| 항목 | 방향 | 비중 | 국내수준 | 목표치 | 현재 실적 | 달성률 |
|---|---|---|---|---|---|---|
| 객체 인식 정확도 | higher | 50% | 75 | 90 | 85 | (85−75)/(90−75) = **66.666…** (표시 66.7) |
| 추론 지연시간 (ms) | lower | 30% | 200 | 50 | 80 | (200−80)/(200−50) = **80.0** |
| 동시 처리 채널 수 | higher | 20% | 4 | 16 | 미측정 | **0** (분모 포함) |

가중 달성률 = (66.666…×50 + 80.0×30 + 0×20) / 100 = (3333.33… + 2400 + 0) / 100 = **57.333… → 표시 57.3%**

> **P-8 주의**: 중간값(66.666…)을 66.7로 반올림해 계산하면 57.4가 나온다 — 이는 틀린 값이다. 반올림은 최종 표시 단계에서만 한다. 테스트 기대값은 `57.33…`(소수 유지) 기준으로 작성한다.

### B.3 성과목표 달성률

| 지표 | 목표(총) | 1차 목표 | 2차 목표 | 달성 | 달성률 |
|---|---|---|---|---|---|
| SCI 논문 | 4 | 1 | 3 | 3 | 75% |
| 국내 특허 출원 | 6 | 2 | 4 | 7 | 116.7% (초과) |
| SW 등록 | 2 | 0 | 2 | 0 | 0% |
| **합계** | **12** | | | **10** | **83.3%** |

### B.4 예산 집행률 (1차년도, 단위 천원)

| 비목 | 예산 | 집행 | 집행률 |
|---|---|---|---|
| 인건비 | 120,000 | 118,400 | 98.7% |
| 연구재료비 | 40,000 | 43,200 | **108.0%** ⚠ |
| 연구활동비 | 25,000 | 12,000 | 48.0% |
| 연구수당 | 8,000 | 8,000 | 100.0% |
| 간접비 | 7,000 | 7,000 | 100.0% |
| **합계** | **200,000** | **188,600** | **94.3%** |

### B.5 예산계획 임포트 (매트릭스 파싱)

실측 서식(사업비 총괄표)을 축약한 예시. 금액은 익명화한 가상 수치다. 라벨이 3개 열(비목|세목|현금·현물)에 분산되고, 병합 셀 해제로 빈 셀이 생긴 상태를 가정한다.

```
행  B열(비목)  C열(세목)         D열(세세목)      E열(축)   F열(1차년도)  G열(2차년도)  H열(합계)
 1  직접비     인건비            내부인건비 (A)   현금 (N)   50,000,000   80,000,000   130,000,000
 2  (빈칸)     (빈칸)            (빈칸)           현물       20,000,000   30,000,000    50,000,000
 3  (빈칸)     (빈칸)            외부인건비 (B)   현금 (O)            0            0             0
 4  (빈칸)     학생 인건비       (빈칸)           일반        5,000,000    5,000,000    10,000,000
 5  (빈칸)     총 인건비1) (E=A+B+C+D)                       75,000,000  115,000,000   190,000,000
 6  (빈칸)     연구시설‧장비비 (F)                현금 (R)            0   10,000,000    10,000,000
 7  (빈칸)     연구활동비 (H)                     현금 (T)    8,000,000       #REF!        #REF!
 8  (빈칸)     직접비 소계 (K)                               83,000,000       #REF!        #REF!
 9  간접비 (L)                                                1,000,000    2,000,000     3,000,000
10  연구개발비 총액 (M=K+L)                                  84,000,000       #REF!        #REF!
```

> 라벨 열은 **물리적으로 4열(B·C·D·E)** 이고 의미는 3그룹(비목 | 세목 계층 | 현금·현물 축)이다 — §6.8.2 본문의 "3개 열"은 의미 그룹을 가리킨다. 실측 서식(부록 B.6)도 라벨 열이 B~E 4열이다.
>
> H열(합계)은 S-5에 의해 **파싱 대상에서 제외**되므로 값이 무엇이든 결과에 영향이 없다. 7행의 `#REF!`가 합계·소계 수식으로 전파된 상태를 그대로 반영했다(실측 서식과 동일한 양상). 8·10행은 스킵 행이므로 `#REF!`가 있어도 오류로 집계하지 않는다 — 오류 판정(I-12)은 **반영 대상 셀**에만 적용한다.

**기대 파싱 결과**

| 행 | 판정 | 근거 |
|---|---|---|
| 1 | `personnel` 1차 `cashAmount` 50,000,000 / 2차 80,000,000 | `내부인건비` 별칭 → personnel (S-3). `합계`(H열)는 제외 (S-5) |
| 2 | `personnel` 1차 `inKindAmount` 20,000,000 / 2차 30,000,000 | 빈 라벨은 위 행 carry-forward (S-2), `현물` 행 쌍 (S-4) |
| 3 | `personnel` 현금에 0 합산 | `외부인건비` → personnel |
| 4 | `student_personnel` 1차 5,000,000 / 2차 5,000,000 | `학생 인건비` → 공백 정규화 → `학생인건비` |
| 5 | **건너뜀** | `총 인건비1) (E=A+B+C+D)` → 정규화 → `총인건비` → SKIP |
| 6 | `facility_equipment` 2차 `cashAmount` 10,000,000 | `연구시설‧장비비 (F)` → 정규화 → `연구시설장비비` |
| 7 | **오류 (반영 차단)** | 2차년도 셀 `#REF!` → 파싱 실패 (I-12). 빨강 표시 |
| 8 | **건너뜀** | `직접비 소계` → `직접비소계` → SKIP. `-`는 0이지만 스킵 행이므로 무관 |
| 9 | `indirect` 1차 1,000,000 / 2차 2,000,000 | `간접비 (L)` → `간접비` → 완전일치 비목 (스킵 아님, 부록 C 주의 1) |
| 10 | **건너뜀** | `연구개발비 총액` → `연구개발비총액` → SKIP |

최종 BudgetItem (1차년도): `personnel` planned 70,000,000 (cash 50,000,000 + inKind 20,000,000 + 외부 0. 학생인건비는 별도 비목이므로 5행 `총 인건비` 75,000,000과 다르다), `student_personnel` 5,000,000, `activity` 8,000,000, `indirect` 1,000,000. 7행 오류가 해결되기 전에는 **전체 반영이 차단**된다 (§7.9.1 Step 5).

### B.6 실측 서식 2종 — 1차년도 기대 파싱 결과 (`samples/`, 통합 테스트 기준값)

보유 샘플의 **`유엔이_총괄표` 시트**(자기 기관 총괄표, §6.8.2)를 파싱한 기대값이다. 두 서식 모두 `(단위 : 원)` 또는 무표기이므로 `amountUnit = 1`이다. 파일 자체는 `.gitignore` 대상이므로 커밋하지 않는다 — 테스트는 파일이 없으면 **skip이 아니라 명시적 안내와 함께 skip 처리**하고, 있으면 아래 값을 그대로 검증한다.

**공통 구조**

| | 산자부 | 행안부 |
|---|---|---|
| 헤더 행 (0-based) | 1 (`비목`/`세목`/`1차년도`…) | 8 (`1차년도`…행. 위의 `1단계`/`2단계`는 S-5로 무시) |
| 데이터 시작 행 (0-based) | 3 | 10 |
| 데이터 끝 행 (0-based) | 29 | 30 |
| 라벨 열 | B, C, D, E | B, C, D, E |
| 연차 열 | F·G·H·I → order 0·1·2·3 | F·G·H·I → order 0·1·2·3 |
| 합계 열 | J (S-5로 제외) | J (S-5로 제외) |
| 단위 표기 | 없음 → `amountUnit=1` 기본 제시 | `B7 = (단위 : 원)` → `amountUnit=1` 제시 (I-10) |
| 미매핑 | **0건** | **0건** |

> **구조 자동 감지 기대 동작** (위 값이 힌트 없이 나와야 한다): 헤더 행 = `N차년도` 매칭이 가장 많은 행(동률이면 가장 위 — 병합으로 같은 값이 두 행에 걸린다). 데이터 시작 행 = 헤더 아래 **첫 비목 판정 행**. 데이터 끝 행 = **마지막 비목 또는 스킵 판정 행**(그 아래 라벨 없이 금액만 있는 잔여 행은 범위 밖으로 두고, 사용자가 Step 2에서 넓힐 수 있게 한다 — 행안부 33행에 그런 셀이 실제로 있다). 라벨 열 = 첫 연차 열 왼쪽에서 데이터 구간에 값이 있는 열 전부.

**1차년도(order 0) BudgetItem 기대값 (원)**

| 비목 | 산자부 cash / inKind / planned | 행안부 cash / inKind / planned |
|---|---|---|
| `personnel` | 180,840,000 / 88,650,000 / **269,490,000** | 74,240,000 / 30,000,000 / **104,240,000** |
| `student_personnel` | — / — / 0 (`일반`+`통합관리`, unassigned) | — / — / 0 |
| `facility_equipment` | 0 / 0 / 0 | 0 / 0 / 0 |
| `material` | 0 / 0 / 0 | 0 / 0 / 0 |
| `activity` | 27,020,000 / 0 / **27,020,000** | 29,100,000 / 0 / **29,100,000** |
| `allowance` | 0 / 0 / 0 | — / — / 0 |
| `consignment` | 0 / 0 / 0 | (행 없음 → S-9로 기존값 유지) |
| `indirect` | — / — / **2,000,000** (축 없음) | — / — / 0 |

> **교차검증**: 위 값의 직접비 합(간접비 제외)은 원본의 `직접비 소계` 행과 일치해야 한다 — 산자부 296,510,000, 행안부 133,340,000. 여기에 `indirect`를 더한 값이 `연구개발비 총액` 행과 일치한다 — 산자부 298,510,000, 행안부 133,340,000. **이 두 등식을 통합 테스트의 단언으로 넣는다.** 소계·총액 행 자체는 스킵 행이라 반영 대상이 아니지만, 파싱 결과의 정합성을 증명하는 가장 강한 근거다.

**규칙별로 이 샘플이 증명하는 것**

| 규칙 | 산자부 근거 행(1-based) | 행안부 근거 행(1-based) |
|---|---|---|
| S-2 리셋 | 27행 `간접비 (L)`가 B열에 등장 → C·D·E의 `현물` 승계 차단 | 28행 동일 |
| S-4 현금/현물 쌍 | 4·5행, 6·7행, 8·9행 | 11·12행, 13·14행 |
| S-6 세로 분절 결합 | (해당 없음) | 19·20행 `연구시설‧` + `장비비(F)` |
| S-8 다중 행 합산 | 4·6·8행이 전부 `personnel` | 11·13·15행이 전부 `personnel` |
| S-10 빈 라벨 승계 | 16·29행은 **승계 안 함**(축 없음 → 메모) | 22행 `(G)`는 **승계함**(축 `현물`) / 27·30행은 승계 안 함 |
| S-11 병합 확장 | 16행 `C16:E16` 메모가 E열 `현물`을 승계하지 않음 | 15행 `D15:E15` 병합 라벨이 축이 아니라 비목으로 판정됨 |
| S-12 우→좌 채택 | 4행 B열 `직접비`(스킵)보다 D열 `내부인건비`가 우선 | 12~14행 세로쓰기 `직`/`접`/`비`가 무시됨 (S-7) |
| I-1 정규화 | 12·13·23·28행(각주·수식·별표·중첩 괄호) | 17·18·29행 |
| I-5 빈 문자열 메모 | 16·29행 | 30행 |

### B.7 예산 제안 — 산출근거 계산 (§6.10)

출처는 실측 워크북 `산자부_…_v1.2_kdh_250520.xlsx`의 `1차년도_250520` 시트다. **아래 숫자는 서식이 실제로 담고 있는 값이며, 구현이 다른 값을 내면 구현이 틀린 것이다.**

#### B.7.1 인건비 행 (PL-1·PL-2·PL-4) — `1차년도_250520` 65~82행, 참여기간 9개월

`금액 = 연봉 × 참여율/100 × 개월/12 + 조정액`

| 성명 | 연봉 | 참여율 | 축 | 산식 결과 | 조정액 | **최종** |
|---|---:|---:|---|---:|---:|---:|
| 여욱현 | 180,000,000 | 10.0% | 현금 | 13,500,000 | 0 | **13,500,000** |
| 김영 | 90,000,000 | 30.0% | 현금 | 20,250,000 | 0 | **20,250,000** |
| 김지웅 | 90,000,000 | 30.0% | 현물 | 20,250,000 | 0 | **20,250,000** |
| 박선욱 | 74,000,000 | 28.0% | 현금 | 15,540,000 | 0 | **15,540,000** |
| 지동민 | 84,000,000 | 64.0% | 현물 | 40,320,000 | −270,000 | **40,050,000** |
| 도상래 | 64,000,000 | 10.0% | 현금 | 4,800,000 | 0 | **4,800,000** |
| 이경아 | 54,000,000 | 70.0% | 현물 | 28,350,000 | 0 | **28,350,000** |
| 김다래 | 54,000,000 | 26.0% | 현금 | 10,530,000 | −30,000 | **10,500,000** |
| 김도현 | 52,000,000 | 10.0% | 현금 | 3,900,000 | 0 | **3,900,000** |
| 유태일 | 46,200,000 | 15.0% | 현금 | 5,197,500 | **−7,500** | **5,190,000** |
| 정우진 | 51,000,000 | 40.0% | 현금 | 15,300,000 | 0 | **15,300,000** |
| 김형식 | 43,500,000 | 41.0% | 현금 | 13,376,250 | **−6,250** | **13,370,000** |
| 신나리 | 38,000,000 | 40.0% | 현금 | 11,400,000 | 0 | **11,400,000** |
| 양소희 | 39,000,000 | 30.0% | 현금 | 8,775,000 | −5,000 | **8,770,000** |
| 이다정 | 41,100,000 | 20.0% | 현금 | 6,165,000 | −5,000 | **6,160,000** |
| 안승현 | 36,000,000 | 14.0% | 현금 | 3,780,000 | 0 | **3,780,000** |
| 진호령 | 33,000,000 | 30.0% | 현금 | 7,425,000 | −5,000 | **7,420,000** |
| 장선우 | 32,000,000 | 29.0% | 현금 | 6,960,000 | 0 | **6,960,000** |
| | | | **기존인력 소계** | | | **현금 146,840,000 / 현물 88,650,000** |
| 신규채용1(청년의무) | 51,000,000 | 100.0% | 현금 | 34,000,000 (8개월) | 0 | **34,000,000** |
| | | | **인건비 셀 합계** | | | **현금 180,840,000 / 현물 88,650,000 / 계 269,490,000** |

> **PL-2 회귀 테스트로 고정할 행 — 박선욱.** 월액을 먼저 반올림하면(`74,000,000 / 12 = 6,166,666.67 → 6,166,667`) `6,166,667 × 0.28 × 9 = 15,540,000.84`가 되어 **반올림 후 15,540,001**이 나온다. 연봉 기준으로 계산하면 정확히 `15,540,000`이다. 서식의 월액 열(`실지급액-월 (연봉/12)`)은 표시용이며 계산 입력이 아니다.
>
> **조정액이 음수인 행(지동민·김다래·유태일·김형식·양소희·이다정·진호령)은 PL-5의 "음수 금액"과 무관하다.** 조정액만 음수이고 최종 금액은 양수다. PL-5가 잡는 것은 **최종 금액**이 음수가 되는 경우다.
>
> **위 표의 `조정액`은 원본 워크북의 조정액 열을 그대로 옮긴 값이 아니다.** 서식의 그 열은 **참고 표시**라 두 행에서 천원 단위로 절사되어 있다 — 유태일 `−7,000`, 김형식 `−6,000`. 그대로 쓰면 최종 금액이 각각 500원·250원 어긋난다(`5,190,500`, `13,370,250`). 이 문서는 **`조정액 = 최종 금액 − 산식 결과`로 정의**하며(그래야 PL-1의 등식이 성립한다), 위 표에는 그렇게 역산한 값(`−7,500`, `−6,250`)을 실었다. **최종 금액 열이 원본의 실제 셀 값**이고 그것이 기준이다.
>
> 조정액은 **사람이 총액을 맞추려고 넣는 수동 값**이지 반올림 규칙이 아니다. 지동민 `−270,000`·김다래 `−30,000`은 어떤 절사 규칙으로도 설명되지 않는다. 구현이 조정액을 자동 계산하려 들면 안 된다.

#### B.7.2 `quantity` 행 (PL-3) — 연구활동비 1차년도

| 세목 | 품명 | 단가 | 인자 | **금액** |
|---|---|---:|---|---:|
| ④ 회의비 | 회의비 | 500,000 | 회 6 | **3,000,000** |
| ⑥ 소프트웨어 활용비 | AEC Collection | 540,000 | 수량 4 · 월 9 | **19,440,000** |
| ⑤ 국내출장비 | 국내출장비 | 150,000 | 인원 2 · 횟수 4 | **1,200,000** |
| ⑪ 그 밖의 비용 | 인쇄/복사/인화/슬라이드 제작 | 450,000 | 회 2 | **900,000** |
| ⑪ 그 밖의 비용 | 위탁정산 수수료 | 2,480,000 | 회 1 | **2,480,000** |
| | | | **연구활동비 셀 합계** | **27,020,000** |

#### B.7.3 집계와 지침 검증 (PL-7·PL-11~PL-13) — 1차년도

| 항목 | 값 | 근거 |
|---|---:|---|
| 인건비 (현금/현물) | 180,840,000 / 88,650,000 | B.7.1 |
| 연구활동비 (현금) | 27,020,000 | B.7.2 |
| 간접비 (현금) | 2,000,000 | 연구실 안전관리비 `2,000,000 × 1` |
| 직접비 소계 | 296,510,000 | |
| **연구개발비 총액** | **298,510,000** | 직접비 + 간접비 |
| **수정인건비 E1** (PL-11) | 269,490,000 | 인건비 + 학생인건비(0) |
| **연구수당 비율** (PL-12) | 0.00% | `0 / 269,490,000` |
| 간접비 기준액 (PL-13) | 207,860,000 | 인건비현금 180,840,000 + 활동비현금 27,020,000 |
| **간접비 비율** (PL-13) | **0.9622%** | `2,000,000 / 207,860,000` |

> 간접비 비율은 서식의 `* 간접비 비율4) (L/(N+O+P+D+R+S+T+U))` 셀 값과 소수 4자리까지 일치한다. **국제공동연구개발비는 기준액에 없다** — 서식의 문자 코드에 `J`(국제공동 현금)가 빠져 있는 것으로 확인했다.
>
> **총액 298,510,000은 부록 B.6(임포트 기대값)과 같은 숫자다.** 같은 연차를 총괄표 임포트로 넣든 산출근거로 쌓든 결과가 일치해야 한다 — 두 경로가 어긋나면 어느 한쪽이 틀린 것이다. 통합 테스트에서 이 등가를 확인한다.

### B.8 산출근거 시트 임포트 (§6.11)

출처는 실측 `산자부_…_v1.2_kdh_250520.xlsx`의 **`1차년도_250520` 시트**다. **아래 수치는 그 시트가 실제로 담고 있는 값이며, 임포트 결과가 다르면 구현이 틀린 것이다.**

#### B.8.1 블록 감지 (D-1~D-5)

| 항목 | 기대 |
|---|---|
| 섹션 | `1. 직접비 소요명세`(60행) · `2. 간접비 소요명세`(263행) 2개 |
| 섹션 밖 | 1~59행(총괄표·요약 블록)은 **전부 무시** — 여기서 금액을 읽으면 이중 계상이다 |
| 비목 블록 | `- 인건비` · `다. 연구시설·장비비` · `라. 연구재료비` · `마. 연구활동비` · `자. 연구수당` · `바. 국제공동연구개발비` |
| 간접비 세목 | `가. 인력지원비` · `나. 연구지원비` · `다. 성과활용지원비` — **비목이 아니라 `indirect`의 세목**(D-2). `다.`가 직접비 섹션에서는 `연구시설·장비비`인데 간접비 섹션에서는 `성과활용지원비`다. 섹션 문맥 없이 접두어만 보면 반드시 틀린다 |
| 세목 | 시설·장비비 ①~④, 재료비 ①~③, 활동비 ①~⑪ |
| 인건비 소계 | `합계`(88행) → `합계`(91행) → `소 계`(92행) **3단**. 첫 소계에서 멈추면 신규채용 34,000,000을 통째로 놓친다(D-5) |

#### B.8.2 행 파싱 결과

| 블록 | 읽는 행 | 금액 |
|---|---:|---|
| 인건비 (기존인력) | **18** | 현금 146,840,000 / 현물 88,650,000 |
| 인건비 (신규채용) | **1** | 현금 34,000,000 |
| ④ 회의비 | 1 | 3,000,000 (`단가 500,000 × 회 6`) |
| ⑤ 국내출장비 | 1 | 1,200,000 (`산출비용 150,000 × 인원 2 × 횟수 4`) |
| ⑥ 소프트웨어 활용비 | 1 | 19,440,000 (`단가 540,000 × 시트(수량) 4 × 월 9`) |
| ⑪ 그 밖의 비용 | 2 (+ 0원 4행은 D-21 ②로 **건너뜀 제안**) | 3,380,000 (`900,000 + 2,480,000`) |
| 간접비 나. 연구지원비 | 1 (+ 0원 5행) | 2,000,000 (`연구실 안전관리비 2,000,000 × 1`) |

> `⑥ 소프트웨어 활용비`의 인자 라벨이 **`시트(수량)`**다 — 부록 A.5 프리셋의 `수량`과 다르다. D-7이 헤더 텍스트로 매핑하고 PL-3이 라벨을 자유롭게 두는 이유가 이것이다.

#### B.8.3 소계 대조 (D-18) — 파일 값과 우리 합계가 일치해야 한다

| 파일 셀 | 값 |
|---|---:|
| 기존인력 합계 (J88 / K88) | 146,840,000 / 88,650,000 |
| 신규채용 합계 (J91) | 34,000,000 |
| **인건비 소계 (J92 / K92 / L92)** | **180,840,000 / 88,650,000 / 269,490,000** |
| 회의비 소계 (K181) | 3,000,000 |
| 출장비 소계 (K188) | 1,200,000 |
| SW 소계 (K201) | 19,440,000 |
| 그 밖의 비용 소계 (K243) | 3,380,000 |
| **연구활동비 합계 (L150)** | **27,020,000** |
| 간접비 나. 소계 (K279) | 2,000,000 |

> **B.7과 같은 숫자다.** 부록 B.7은 같은 값을 **손으로 입력**했을 때의 기대치이고, B.8은 **엑셀에서 임포트**했을 때의 기대치다. 두 경로가 같은 `budget_items`(현금 180,840,000 / 현물 88,650,000 / 계 269,490,000)에 도달해야 한다 — 어긋나면 어느 한쪽이 틀렸다. **통합 테스트에서 이 등가를 확인한다.**

#### B.8.4 조정액 흡수 (D-8)

임포트는 파일의 `합계` 열을 최종 금액으로 삼고, PL-1/PL-3 산식 결과와의 차액을 `adjustment`에 넣는다. 부록 B.7.1의 인건비 19행이 그대로 재현되어야 한다 — 예: 지동민 `84,000,000 × 64% × 9/12 = 40,320,000`, 파일 값 `40,050,000` → `adjustment = −270,000`. **B.7.1 표의 조정액 열이 곧 임포트의 기대 산출물이다.**

---

## 부록 C. 비목 별칭 사전 (초기값) — 공통 + 부처별 프리셋

`lib/constants.ts`에 정의한다. 모든 키는 정규화(I-1: 가운뎃점 변형·내부 공백·괄호 내용·각주·별표·하이픈 제거 + 소문자화)된 형태로 비교한다.

**설계 원칙 — 비목 12종은 국가연구개발혁신법 표준으로 고정한다.** 부처(국토부·기후부·과기부·중기부·행안부·산자부 등)마다 서식 표기와 세목 구성이 조금씩 다르지만, 최상위 비목은 혁신법 체계로 수렴한다. 부처별 차이는 스키마가 아니라 **별칭 프리셋 층**에서 흡수한다 — 새 부처 서식이 나타나면 `MINISTRY_ALIAS_PRESETS`에 별칭만 추가하면 되고, 스키마 변경은 없다.

조회 우선순위 (I-2): **① `ImportProfile.categoryAliases`(임포트 중 학습분) → ② 프로파일 `ministry`의 부처 프리셋 → ③ 공통 사전.**

```ts
export const CATEGORY_ALIASES: Record<string, BudgetCategory> = {
  // 인건비 — 세목(내부/외부/연구지원인력)은 상위 비목으로 귀속 (S-3)
  '인건비': 'personnel',
  '내부인건비': 'personnel',
  '외부인건비': 'personnel',
  '연구지원인력인건비': 'personnel',
  '현금인건비': 'personnel',
  '현물인건비': 'personnel',
  '인건비현금': 'personnel',
  '인건비현물': 'personnel',

  // 학생인건비 — '학생 인건비'는 공백 정규화로 커버
  '학생인건비': 'student_personnel',
  '학생연구원인건비': 'student_personnel',

  // 연구시설·장비비 — '연구시설‧장비비'(U+2027)는 가운뎃점 정규화로 커버
  '연구시설장비비': 'facility_equipment',
  '시설장비비': 'facility_equipment',
  '연구장비비': 'facility_equipment',
  '장비비': 'facility_equipment',

  // 연구재료비 — '연구 재료비'는 공백 정규화로 커버
  '연구재료비': 'material',
  '재료비': 'material',
  '연구재료및전산처리비': 'material',

  // 위탁연구개발비
  '위탁연구개발비': 'consignment',
  '위탁연구비': 'consignment',
  '위탁연구': 'consignment',

  // 국제공동연구개발비
  '국제공동연구개발비': 'international',
  '국제공동연구비': 'international',

  // 연구개발부담비
  '연구개발부담비': 'burden',

  // 연구활동비
  '연구활동비': 'activity',
  '연구개발활동비': 'activity',

  // 연구과제추진비
  '연구과제추진비': 'promotion',
  '과제추진비': 'promotion',
  '연구개발과제추진비': 'promotion',

  // 연구수당
  '연구수당': 'allowance',

  // 간접비
  '간접비': 'indirect',
  '간접경비': 'indirect',
};

// 부처별 별칭 프리셋 — 공통 사전과 다른 표기가 확인될 때만 추가한다.
// 현재 확보한 산자부·행안부 서식은 표기가 혁신법 표준과 일치해 공통 사전으로 전부 커버된다.
// 프리셋 키는 ImportProfile.ministry 값과 일치시킨다.
export const MINISTRY_ALIAS_PRESETS: Record<string, Record<string, BudgetCategory>> = {
  '산업통상자원부': {},
  '행정안전부': {},
  // '국토교통부': {}, '과학기술정보통신부': {}, '중소벤처기업부': {}, ... 서식 확보 시 추가
};

// 현금/현물 축 라벨 — 스킵도 비목도 아니다. 금액의 귀속 축만 결정한다 (S-4)
// 스킵 목록에 넣으면 현물 행의 금액이 통째로 유실되므로 반드시 분리해 둔다
export type BudgetAxis = 'cash' | 'inKind' | 'unassigned';

// 축 라벨 → 귀속 축. '일반'/'통합관리'는 학생인건비의 세부 축이라 현금/현물 어느 쪽도 아니다
// — 'unassigned'로 모아 plannedAmount에만 합산한다 (cashAmount/inKindAmount는 null 유지).
// 규칙을 주석이 아니라 상수로 둬야 구현이 임의로 현금에 몰아넣는 것을 막는다.
export const CASH_INKIND_AXIS: Record<string, BudgetAxis> = {
  '현금': 'cash',
  '현금액': 'cash',
  '현물': 'inKind',
  '현물액': 'inKind',
  '일반': 'unassigned',
  '통합관리': 'unassigned',
};

export const CASH_INKIND_LABELS = Object.keys(CASH_INKIND_AXIS);

// 집계·메모 행 — 비목으로 인식하지 않고 건너뛴다 (정규화 후 비교)
export const SKIP_ROW_PATTERNS = [
  '소계', '합계', '계', '총계', '총합계',
  '직접비', '직접비계', '직접비소계',
  '간접비계', '간접비소계',
  '정부지원연구개발비', '기관부담연구개발비',
  // 실측 서식(산자부·행안부)에서 확인된 집계·비율·메모 행
  '총인건비', '수정인건비', '연구개발비총액', '사업비합계', '전체예산',
  '연구수당비율', '간접비비율', '인건비비율',
  '통합관리비', '안전관리비', '보안수당',
  '정부출연금', '민간부담금', '기관부담금',
  '조정안', '부족분', '잔액',
  '비목', '세목', '구분',   // 헤더 행 자체가 데이터 범위에 섞여 들어온 경우
];

// 구 비목 체계 — 자동 매핑하지 않고 사용자 선택을 요구 (I-6)
export const AMBIGUOUS_ALIASES: Record<string, BudgetCategory[]> = {
  '연구장비재료비': ['facility_equipment', 'material'],
  '연구활동및과제추진비': ['activity', 'promotion'],
};
```

> **주의 1**: 라벨 판정 순서는 **① 완전일치 비목 → ② 별칭 사전 → ③ 축 라벨(`CASH_INKIND_LABELS`) → ④ 건너뛰기 패턴** 이다. `간접비`는 ①에서 비목으로 확정되므로 건너뛰기 대상이 되지 않는다. `직접비`는 비목 목록에 없으므로 ④에서 걸러진다. `현금`/`현물`은 ③에서 축으로 판정되어 해당 행의 금액이 cashAmount/inKindAmount로 귀속된다(행 자체를 버리지 않는다).
>
> **주의 2**: 정규화가 괄호 내용·각주까지 지우므로 `총 인건비1) (E=A+B+C+D)` → `총인건비`, `* 연구수당 비율3) (I/E1)` → `연구수당비율`로 스킵 패턴에 걸린다. 전체가 괄호 메모인 라벨은 정규화 후 빈 문자열이 되어 I-5 규칙으로 건너뛴다.

### C.2 세목 별칭 사전 (산출근거 임포트 §6.11 D-3)

`lib/constants.ts`에 `SUBCATEGORY_ALIASES: Record<BudgetCategory, Record<string, string>>`(비목 → 정규화 라벨 → 세목 코드)로 정의한다. 부록 A.5의 **표시 라벨은 정규화하면 자동으로 키가 되므로 여기 다시 적지 않는다** — 아래는 **실측에서 확인된 변형만** 담는다.

```ts
export const SUBCATEGORY_ALIASES: Record<BudgetCategory, Record<string, string>> = {
  activity: {
    '기타': 'activity_etc',              // 행안부 ⑪ (산자부는 '그 밖의 비용')
    '그밖의비용': 'activity_etc',
    '국내출장비': 'activity_travel_dom',
    '국외출장비': 'activity_travel_intl',
    '출장비': 'activity_travel_dom',      // 번호 ⑤가 국내/국외 두 표를 덮는다 — D-3 참조
    '소프트웨어활용비': 'activity_software',
    '클라우드컴퓨팅서비스이용료': 'activity_cloud',
  },
  // 나머지 11개 비목은 부록 A.5 라벨의 정규화형으로 충분하다 (실측 2종 기준).
  // 다만 타입이 `Record<BudgetCategory, …>`이므로 **빈 객체 `{}`로 전부 채운다** —
  // `MINISTRY_ALIAS_PRESETS`와 같은 관례이고, 비목이 늘면 컴파일 에러로 드러난다.
};
```

> **주의 1 — 번호(`①`~`⑫`)는 라벨과 함께 본다** (D-3). 실측에서 라벨이 `⑪ 그 밖의 비용` / `⑪ 기타`로 갈렸고 `⑦ 연구실 운영비(삭감)`처럼 접미어가 붙기도 한다. 정규화(I-1)가 괄호를 지우므로 `(삭감)`은 자동으로 흡수되지만, `기타`처럼 아예 다른 낱말은 이 사전이 필요하다.
>
> **주의 2 — `⑤ 출장비`는 번호 하나에 표가 둘이다.** 실측 산자부는 `⑤ 출장비` 아래 `국내출장비` 표와 `국외출장비` 표가 컬럼 헤더를 각각 갖고 연달아 온다(184행·190행). 세목 헤더가 아니라 **표의 첫 데이터 행 라벨**로 국내/국외를 가른다. 가르지 못하면 둘 다 `activity_travel_dom`으로 제안하고 사용자가 고친다 — 조용히 합치지 않는다.
>
> **주의 3 — 여기서 학습한 매핑을 저장하지 않는다** (D-20). 산출근거 임포트는 프로파일이 없다. 새 변형이 실무에서 나타나면 **이 사전을 고친다** — 부록 A.5 세목 코드가 원본이고 여기는 그 별칭층이다(부록 C의 비목 별칭과 같은 구조).
