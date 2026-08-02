# R&D 과제 관리 도구 — SOT (Source of Truth)

| 항목 | 내용 |
|---|---|
| 문서 버전 | **v3.3** |
| 최종 수정 | 2026-08-02 |
| 상태 | 확정 (Phase 0 착수 가능) |
| 목적 | 이 문서는 구현의 유일한 기준점이다. 코드와 문서가 다르면 **문서가 옳다**. |

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
| **참여연구원 참여율(%) 관리** | 사용자 선택으로 제외 (v2 후보) |
| **증빙 파일 첨부 / 업로드** | 사용자 선택으로 제외. 증빙은 외부 링크(URL)로만 (v2 후보) |
| 기관별 연구비 분배 | 비목별까지만 관리 |
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

  archived: boolean;
  order: number;
}
```

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
}
```

> 참여율(%) 필드는 v1 범위에서 제외한다. 필요해지면 `participationRate: number`를 추가하는 것만으로 확장 가능하도록 스키마를 열어둔다.

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
  date: string;              // 집행일
  amount: number;            // 집행액 (원)
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
}
```

> 비목별 보조 축은 **현금/현물**이다. 실제 예산 서식(연구개발계획서 사업비 총괄표)이 비목별 금액을 현금/현물로 분리하며, 정부출연금/민간부담금 구분은 비목 수준에 존재하지 않는다. 정부/기관부담 축은 과제 수준(`Project.govBudget/ownBudget`)에서만 관리한다.

**제약**: `(projectId, yearId, category)` 조합은 유일해야 한다. 연차 생성 시 12개 비목 레코드를 `plannedAmount: 0`으로 자동 생성한다.

#### 5.12.1 ImportProfile (엑셀 매핑 프로파일 = 부처 템플릿)

```ts
type ImportKind = 'budget_plan';   // v1은 예산계획만. 집행내역 임포트는 v2 후보 (§13)

interface ImportProfile extends BaseEntity {
  name: string;                   // 예: '산자부 사업비 총괄표'
  kind: ImportKind;
  ministry: string | null;        // 부처명 (예: '산업통상자원부'). 부처별 별칭 프리셋 적용 키 (부록 C)
  projectId: string | null;       // null이면 전역 프로파일 (모든 과제에서 재사용)

  sheetName: string | null;       // null이면 첫 시트
  headerRow: number;              // 0-based 헤더 행 인덱스
  dataStartRow: number;           // 0-based 데이터 시작 행
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
  yearMapping: Record<string, string>;        // 연차 열 라벨 → yearId. 미대응 열이 있으면 반영 불가 (S-5)
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

기준일은 로컬 타임존 오늘(00:00).

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
② 시트 선택    시트가 1개면 자동 선택. 여러 개면 비목 별칭 매칭 밀도가 가장 높은
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
| S-1 | `orientation` 감지: 헤더 행에서 비목 별칭이 2개 이상 매칭되면 `'column'`(비목이 열), 라벨 열에서 매칭되면 `'row'`(비목이 행). 실측 서식은 전부 `'row'`다. |
| S-2 | **병합 셀 carry-forward**: 병합 셀은 해제 시 좌상단 셀만 값을 가진다. 라벨 열의 빈 셀은 **바로 위 행의 값을 이어받은 것**으로 해석한다. **리셋 조건**: 어떤 라벨 열에 새 값이 나타나면 **그보다 오른쪽 라벨 열들의 carry-forward는 초기화**한다 — 상위 분류가 바뀌면 하위 라벨은 승계되지 않는다. (이 조건이 없으면 `간접비` 행이 직전 비목의 `현금` 라벨을 이어받아 오분류된다) |
| S-3 | **다중 라벨 열**: 행 라벨이 여러 열에 계층으로 분산될 수 있다 (예: 직접비 \| 인건비 \| 내부인건비 \| 현금). 라벨 열 후보들을 좌→우로 훑어 **별칭 사전에 매칭되는 가장 구체적인(오른쪽) 라벨**로 비목을 확정한다. 세목(내부인건비 등)은 별칭 사전을 통해 상위 비목으로 귀속된다. |
| S-4 | **현금/현물 행 쌍**: 같은 비목 아래 `현금`/`현물` 라벨 행이 쌍으로 나오면 각각 `cashAmount`/`inKindAmount`로 적재하고, `plannedAmount`는 둘의 합으로 계산한다. 분리 행이 없으면 전액을 `plannedAmount`에 넣고 현금/현물은 null로 둔다. **축 라벨(`CASH_INKIND_LABELS`, 부록 C)은 비목 매칭·스킵 판정 대상이 아니다** — 금액의 귀속 축만 결정한다. (스킵 목록에 넣으면 현물 금액이 통째로 유실된다) |
| S-5 | **연차 열 매핑**: 헤더에서 `N차년도` 패턴을 찾아 연차(Year)에 대응시킨다. 그 아래 연도(`YYYY`) 행은 보조 확인용으로만 쓴다. `N단계` 그룹 헤더는 무시하고 차년도 번호만 사용한다. `합계` 열은 자동 제외한다. 대응되지 않는 연차 라벨은 사용자가 지정해야 반영 가능하다. |
| S-6 | **세로 분절 라벨 결합**: 라벨이 위·아래 행에 수동으로 쪼개진 서식이 실존한다 (행안부: `연구시설‧` + `장비비(F)`, `연구재료비` + `(G)`). 라벨이 별칭에 매칭되지 않으면 **바로 아래 행의 같은 열 라벨과 결합해 재시도**한다. 결합 매칭에 성공하면 두 행을 같은 비목의 현금/현물 쌍으로 처리한다. |
| S-7 | 좌측 대분류 열의 세로쓰기 조각(`직`/`접`/`비`가 행마다 한 글자씩)은 S-3의 우측 우선 매칭 덕에 자연히 무시된다. 단독으로 `계` 같은 한 글자가 남는 행도 우측 라벨이 먼저 평가되므로 오분류되지 않는다. |
| S-8 | **동일 비목 다중 행 합산**: 같은 (연차, 비목)에 매핑되는 원본 행이 여러 개면(내부인건비·외부인건비·연구지원인력인건비가 전부 `personnel`) 축(현금/현물/미지정)별로 **합산**해 하나의 BudgetItem으로 반영한다. 행 단위 덮어쓰기가 아니다. |
| S-9 | **파일에 등장하지 않은 비목의 기존 계획액은 유지한다.** 덮어쓰기의 범위는 "파일에 등장한 (연차, 비목) 조합"뿐이다. Step 5 상단에 "이 파일에 없는 비목 N건은 유지됩니다"를 표시한다. |

#### 6.8.3 비목 매핑 규칙

| # | 규칙 |
|---|---|
| I-1 | 1순위 — 정규화 후 **완전 일치**. 정규화 = ① 가운뎃점 전 변형 제거 (`·` U+00B7, `‧` U+2027, `ㆍ` U+318D, `•` U+2022) ② **라벨 내부 공백 전부 제거** (`소 계`→`소계`, `학생 인건비`→`학생인건비`) ③ 괄호와 괄호 안 내용 제거 — 세목 코드·수식 포함 (`내부인건비 (A)`→`내부인건비`, `현금 (N)`→`현금`) ④ 각주 번호·별표·하이픈 제거 (`* 연구수당 비율3)`→`연구수당비율`) ⑤ 소문자화. |
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
| I-17 | 반영은 덮어쓰기이므로, 반영 전 해당 연차들의 기존 계획액을 **`import_snapshots` 테이블**에 jsonb로 저장한다 — `commit_import` RPC와 **같은 트랜잭션** 안에서. (각 PC의 로컬 백업 폴더는 서버 액션이 접근할 수 없다) 스냅샷은 설정 화면(§7.14)에서 확인·복원할 수 있고 최근 20개를 유지한다. |
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

- 좌측 고정 패널: 연차 > 작업 트리 (접힘 상태를 WBS 화면과 동기화)
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

- **매트릭스 테이블**: 행 = 12개 비목, 열 = 연차 + 합계. 셀에 `예산 / 집행 / 집행률`
- 셀 클릭 → 해당 연차·비목의 집행 내역 패널 (일자, 금액, 적요) + 추가/삭제
- 예산액은 셀에서 직접 인라인 편집. 셀 상세에서 현금/현물 분리 입력 (`cashAmount`/`inKindAmount`, 합계가 `plannedAmount`)
- 하단 요약 행: 연차별 합계, 집행률, 잔액
- 표시 단위는 `settings.currencyUnit` 적용 (기본 천원)
- 집행률 100% 초과 셀은 빨강, 예산 외 집행은 경고 아이콘
- 툴바에 **[엑셀 가져오기]** 버튼 → §7.9.1 마법사 (예산계획 전용)

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
- 미매핑·유사매칭 항목은 드롭다운으로 지정(`manualCategoryByRow`)하거나 "이 행 건너뛰기" 체크(`skippedRowIndexes`)
- 하단: "이 매핑을 프로파일로 저장" 체크 + 프로파일명·부처 입력 (수동 지정분은 I-7 학습, 단 I-6 모호 별칭의 선택은 학습하지 않는다)

**Step 5 — 미리보기 & 반영**
- 반영 예정 내역 테이블 (연차 / 비목 / 계획액 / 현금 / 현물 / 상태)
- 행 상태: `신규` (초록) / `덮어씀` (주황) / `건너뜀` (회색 — 스킵 패턴·사용자 지정 포함) / `오류` (빨강)
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
- **인력 섹션**: 기관별로 그룹핑된 테이블. 이름 / 역할(PM/PL/연구원/지원) / 직급 / 분야 / 연락처 / 활성여부
- PM은 과제당 1명. 지정 시 기존 PM은 자동으로 `pl`로 강등되지 않고 경고만 띄운다.
- 인력 행 클릭 → 배정된 작업 목록 사이드 패널

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
- 회의록 템플릿 버튼: 일시/장소/참석자/안건/논의/결정사항/액션아이템 골격 삽입
- 참석자는 Member에서 다중 선택 (자동으로 본문 상단에 삽입)
- 노트를 특정 Task·Milestone에 연결 가능. 연결되면 해당 화면에서 역참조로 보인다.
- 저장은 명시적 저장 버튼 + 3초 디바운스 자동 저장 병행

### 7.13 To-Do (`/todos`)
v1과 동일. 단일 리스트, 체크박스, 필터(전체/미완료/오늘/과제별), 정렬(수동·마감일·우선순위), 한 줄 빠른 추가.

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
| 연구비 | `budget_items`, `budget_executions` |
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
updateMember(id, patch)
deleteMember(id)                     // RPC: delete_member (H-9)
setMemberActive(id, active)
setProjectPM(projectId, memberId)
reorderMembers(projectId, orderedIds)
```

**Budget**
```
updateBudgetPlan(yearId, category, plannedAmount, cashAmount, inKindAmount, expectedVersion?)
addExecution(budgetItemId, input)
updateExecution(budgetItemId, executionId, patch)
deleteExecution(budgetItemId, executionId)
```

**Budget Import** (모두 서버 전용, 파일은 `FormData`로 전달. 예산계획 전용)
```
inspectWorkbook(formData)                      // 시트 목록 + 상위 30행 원본 그리드 + 추천 시트 + 구조 추정
analyzeSheet(formData, sheetName, hints)       // 헤더행·방향·라벨열·연차열·금액단위 추정
previewImport(formData, draft: ImportDraft, projectId)
   → { rows: PreviewRow[], summary: { new, overwrite, skipped, skippedAmount, error, totalAmount,
       untouchedCategories }, fileHash }
commitImport(formData, draft: ImportDraft, projectId)
   // RPC 단일 트랜잭션. draft.fileHash와 업로드 파일의 해시가 다르면 거부 (미리보기와 다른 파일 차단).
   // 반영 전 기존 계획액을 import_snapshots에 저장 (I-17)

createImportProfile(input)
updateImportProfile(id, patch)
deleteImportProfile(id)
listImportProfiles(kind, projectId)            // kind는 v2의 'execution' 부활 대비 인자. v1은 항상 'budget_plan'
```

> `previewImport`와 `commitImport`는 **같은 파싱 함수와 같은 `ImportDraft`를 공유**한다. 미리보기에서 본 것과 반영되는 것이 다르면 안 된다. 파일은 두 번 업로드되지만(스테이트리스 유지), `fileHash` 대조로 동일 파일임이 보장되고 결과는 결정론적으로 동일하다.

**Risk**
```
createRisk(projectId, input)
updateRisk(id, patch)
deleteRisk(id)
setRiskStatus(id, status)
reorderRisks(orderedIds)
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
```
getDashboardData()
getProjectOverview(projectId)        // 협약정보 + 계층 요약 + 목표/예산 집계
getYearTree(yearId)                  // 진척률·WBS코드·날짜롤업 계산 완료 트리
getProjectFullTree(projectId)        // 전체 연차 통합 뷰
getGanttData(projectId, scale)       // 마일스톤 포함
getBoardData(projectId, yearId?)
getPriorityMatrix(projectId, yearId?) // 5×5 집계 + 점수 정렬 목록
getGoalsData(projectId)              // 성과목표 + 기술목표 + 달성률
getBudgetMatrix(projectId)
getRiskMatrix(projectId)
getNotes(projectId, filter)
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
│   ├── organizations.ts  members.ts  budget.ts
│   ├── risks.ts      notes.ts    todos.ts   settings.ts
│   ├── auth.ts       getCurrentUser, approveUser 등 (§9 Auth)
│   ├── backup.ts     exportAll, importAll (§8.7)
│   └── import.ts     inspectWorkbook ~ commitImport (§9 Budget Import)
├── components/
│   ├── ui/            버튼, 배지, 모달, 진행바, 게이지, 인라인편집 셀
│   ├── auth/          LoginScreen, PendingScreen, OnboardingModal (§7.0)
│   ├── settings/      SettingsForm, UserManagement, BackupPanel (§7.14)
│   ├── dashboard/
│   ├── project/       OverviewPanel, StageYearTimeline, TabNav
│   ├── wbs/           TreeTable, TreeRow, TaskDetailPanel, YearSelector
│   ├── gantt/         GanttChart, GanttBar, MilestoneLane, TimeAxis
│   ├── board/         KanbanBoard, Column, Card, PriorityMatrix, ViewToggle
│   ├── goals/         DeliverableTable, TechTargetTable, AchievementForm
│   ├── milestones/    MilestoneTimeline, MilestoneTable
│   ├── budget/        BudgetMatrix, ExecutionPanel
│   │   └── import/    ImportWizard, SheetPreviewGrid, ColumnMapper,
│   │                  CategoryMapper, ImportPreviewTable
│   ├── team/          OrgCards, MemberTable
│   ├── risks/         RiskMatrix, RiskTable
│   ├── notes/         NoteList, MarkdownEditor, MarkdownViewer
│   └── todos/
├── lib/
│   ├── db/                             §8.6 리포지토리 레이어
│   ├── tree.ts                         buildTree, flatten, 순환검사, WBS코드
│   ├── progress.ts                     §6.1 4단계 롤업
│   ├── goals.ts                        §6.2 §6.3 달성률 계산
│   ├── budget.ts                       §6.4 집행률 계산
│   ├── import/
│   │   ├── workbook.ts                 SheetJS 래퍼, 시트·범위 추출
│   │   ├── detect.ts                   헤더행·방향·라벨열·금액단위·추천시트 추정
│   │   ├── category-match.ts           §6.8.3 비목 매칭 (별칭+퍼지)
│   │   ├── parse-value.ts              §6.8.4 금액 파싱
│   │   └── pipeline.ts                 preview/commit 공용 파싱 엔트리
│   ├── priority.ts                     §6.9 긴급도·우선순위 점수
│   ├── risk.ts                         §6.5 등급 판정
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

> Phase 5.5는 **실제 엑셀 파일 샘플이 확보된 뒤에** 착수한다. 서식을 모르는 상태로 파서를 만들면 헛수고가 된다. `lib/import/` 전체를 순수 함수로 만들고 샘플 파일 기반 단위 테스트를 작성한다.

> **필수 1**: `lib/tree.ts`, `lib/progress.ts`, `lib/goals.ts`, `lib/budget.ts`, `lib/priority.ts`, `lib/risk.ts`, `lib/dates.ts`는 순수 함수로 만들고 **단위 테스트를 반드시 작성**한다(Vitest). 특히 §6.3 기술목표 달성률은 방향성·baseline 조합에서 실수가 나기 쉽다.
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

---

## 13. 미결정 / v2 후보

| # | 항목 | 메모 |
|---|---|---|
| 1 | 참여연구원 참여율(%) 관리 | 스키마만 열어둠. 인건비 산정 연동 시 필요 |
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
| 14 | 임포트 결과 → 엑셀 역방향 내보내기 | 제출용 서식으로 되돌리기 |
| 15 | 집행내역 자동 이상 탐지 | 예산 초과, 비목 편중, 이례적 금액 경고 |

---

## 14. 배포·인증·이전 전략

### 14.1 배포 형태

**Tauri v2 데스크톱 앱.** Next.js standalone 빌드를 사이드카로 띄우고 WebView가 `http://127.0.0.1:{랜덤포트}`에 접속한다.

| 항목 | 내용 |
|---|---|
| 대상 OS | Windows 우선. macOS는 여력 되면 |
| 배포 | 설치 파일(.msi) 또는 포터블 실행 파일. 사내 공유 폴더에 두고 각자 설치 |
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
행  B열(비목)  C열(세목)              D열       E열(1차년도)  F열(2차년도)  G열(합계)
 1  직접비     인건비   내부인건비 (A)  현금 (N)   50,000,000   80,000,000   130,000,000
 2  (빈칸)     (빈칸)   (빈칸)          현물       20,000,000   30,000,000    50,000,000
 3  (빈칸)     (빈칸)   외부인건비 (B)  현금 (O)            0            0             0
 4  (빈칸)     학생 인건비              일반        5,000,000    5,000,000    10,000,000
 5  (빈칸)     총 인건비1) (E=A+B+C+D)             75,000,000  115,000,000   190,000,000
 6  (빈칸)     연구시설‧장비비 (F)      현금 (R)            0   10,000,000    10,000,000
 7  (빈칸)     연구활동비 (H)           현금 (T)    8,000,000       #REF!        #REF!
 8  (빈칸)     직접비 소계 (K)                     83,000,000       #REF!        #REF!
 9  간접비 (L)                                      1,000,000    2,000,000     3,000,000
10  연구개발비 총액 (M=K+L)                        84,000,000       #REF!        #REF!
```

> G열(합계)은 S-5에 의해 **파싱 대상에서 제외**되므로 값이 무엇이든 결과에 영향이 없다. 7행의 `#REF!`가 합계·소계 수식으로 전파된 상태를 그대로 반영했다(실측 서식과 동일한 양상). 8·10행은 스킵 행이므로 `#REF!`가 있어도 오류로 집계하지 않는다 — 오류 판정(I-12)은 **반영 대상 셀**에만 적용한다.

**기대 파싱 결과**

| 행 | 판정 | 근거 |
|---|---|---|
| 1 | `personnel` 1차 `cashAmount` 50,000,000 / 2차 80,000,000 | `내부인건비` 별칭 → personnel (S-3). `합계` 열은 제외 (S-5) |
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
export const CASH_INKIND_LABELS = ['현금', '현물', '현금액', '현물액', '일반', '통합관리'];
// '일반'/'통합관리'는 학생인건비의 세부 축 — 금액은 합산해 plannedAmount로

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
