# Phase별 합격 기준 (evaluator 채점표)

evaluator는 이 체크리스트로 PASS/FAIL을 판정한다. 모든 항목은 실행·확인 가능해야 하며, 근거 명세는 `docs/SOT.md`다. 공통 전제: **모든 Phase에서 `npx tsc --noEmit` 에러 0, `npm test` 전체 통과, service_role 키가 앱 코드·클라이언트 번들에 없음.**

## Phase 0 — 기반 (스키마 + 리포지토리)

- [ ] `supabase/migrations/`에 전체 스키마 마이그레이션 존재, `npx supabase db push` 성공
- [ ] SOT §5.1 테이블 전부 생성 (본 테이블 + 조인 5종 + `import_snapshots`), 컬럼은 `sort_order`·`version`·`created_by`/`updated_by` 포함 (N-4, N-9)
- [ ] **모든 테이블 RLS 활성** — `pg_class.relrowsecurity` 전수 true, 정책은 `is_approved()` + `to authenticated` (RLS-1)
- [ ] `app_users` 부트스트랩 트리거(`handle_new_user`, security definer + advisory lock) + `approve_user` RPC 존재 (A-3, RLS-2)
- [ ] FK 삭제 정책이 N-8 표와 일치 (실적·회의록 set null), `delete_year`가 `target_by_year` 키 제거 수행 (N-13)
- [ ] `budget_items unique(year_id, category)`, 연차 생성 시 비목 12종 자동 생성 on conflict do nothing (§5.12)
- [ ] `app_settings` 단일 행 강제 + 기본 행 삽입(schema_version=1) + INSERT/DELETE 불가 (N-10)
- [ ] Realtime publication에 §8.5 구독표 테이블 추가됨 (R-7)
- [ ] `types/index.ts` — SOT §5 인터페이스 전부, `lib/constants.ts` — 부록 A 라벨 전부(A.4 포함)·부록 C 사전·`MAX_TASK_DEPTH`
- [ ] `lib/db/` — client/mapper/schema(Zod)/errors + 리포지토리 16종(app-users 포함)
- [ ] mapper 왕복(스네이크↔카멜) 단위 테스트, 시드(부록 B.1 구조) 기반 리포지토리 CRUD 통합 테스트 통과 — 연쇄 삭제(H-4~H-8)·`version` 낙관적 잠금 충돌 케이스 포함

## Phase 0.5 — 셸 + 인증 + 백업

- [ ] Tauri 셸에서 Next standalone 사이드카 기동 (랜덤 포트)
- [ ] 구글 OAuth 시스템 브라우저 + `wbs://` 딥링크 로그인 성공 (A-1), 서버 측 도메인 재검증 (A-2, `ALLOWED_EMAIL_DOMAIN`)
- [ ] 첫 사용자 자동 승인, 두 번째 사용자 승인 대기 → `/pending` → 승인 후 진입 (§7.0)
- [ ] 미승인 세션은 anon 키로 데이터 0행 (RLS 검증)
- [ ] 전체 내보내기 JSON이 §8.7 형식과 일치, 복원 왕복 테스트 통과 (K-7, K-8)
- [ ] 두 PC(또는 두 브라우저 세션)에서 같은 데이터 조회 확인

## Phase 1 — 계층 + WBS

- [ ] 과제/단계/연차 CRUD + `createProject` 자동 Stage·Year 생성 (§9)
- [ ] WBS 트리 화면: 생성·이동(드래그, Tab/Shift+Tab)·삭제, 깊이 10 초과 거부 (H-3, DB·UI 양쪽)
- [ ] `lib/tree.ts`·`lib/progress.ts` 단위 테스트 — **부록 B.1 수치 그대로 통과** (모델개발 58, 2차년도 38.67, 1단계 59.11)
- [ ] 날짜 롤업 (P-14~16) 테스트 통과
- [ ] `lib/priority.ts` — 부록 B.0 수치 그대로 통과 (긴급도 자동 계산 포함)
- [ ] 순환 부모 지정 시도 시 DB가 거부 (X-4)
- [ ] 낙관적 잠금: 두 세션 동시 수정 시 StaleDataError UI 표시 (O-3)

## Phase 2 — 인력 + 기관

- [ ] 기관·인력 CRUD, 주관기관 삭제 차단 (H-8), Member 삭제 시 참조 8곳 정리 (H-9)
- [ ] Task 담당자 배정(owner + 다중) → WBS 트리에 표시

## Phase 3 — 목표 관리

- [ ] 성과목표·기술목표 CRUD + 실적/측정 기록 (조인 테이블 포함)
- [ ] `lib/goals.ts` 단위 테스트 — **부록 B.2 57.333…(중간 반올림 금지), B.3 수치 그대로 통과**
- [ ] §6.3 전 분기 테스트: direction 3종 × baseline null/유무 (T-1 클램프, T-2 N/A 포함)
- [ ] D-1~D-5, T-3 경고 배지 동작

## Phase 4 — 마일스톤 + 대시보드

- [ ] 마일스톤 CRUD + 연차 기본 마일스톤 자동 생성 옵션 (§7.8)
- [ ] 마감 판정(`lib/dates.ts`) 테스트 — §6.5 표 전 케이스, 기준 타임존 Asia/Seoul
- [ ] 대시보드 §7.2 구성 요소 전부 렌더 + 아카이브 제외

## Phase 5 — 연구비

- [ ] 비목 매트릭스 (12행 × 연차), 예산 인라인 편집 (현금/현물 분리, §7.9)
- [ ] 집행 수동 등록/삭제, `lib/budget.ts` 테스트 — **부록 B.4 수치 그대로 통과**
- [ ] B-1~B-4 규칙 (예산 외 집행 경고, 100% 초과 빨강, 원 단위 정수)

## Phase 5.5 — 엑셀 임포트

- [ ] `lib/import/` 순수 함수 + 단위 테스트 — **부록 B.5 시나리오 그대로 통과** (S-2 리셋, S-6 결합, S-8 합산, 축 라벨, #REF! 오류 차단)
- [ ] 5단계 마법사: 실제 보유 샘플 2종(`samples/`)의 총괄표 시트가 **미매핑 0건**으로 미리보기까지 도달
- [ ] `commitImport` fileHash 대조, `import_snapshots` 기록, 단일 트랜잭션 롤백 (I-17, I-18)
- [ ] 프로파일 저장·재사용 (ministry 프리셋 적용)

## Phase 6 — 리스크 + 노트

- [ ] 리스크 매트릭스·대장 (`lib/risk.ts` 등급 테스트: 경계값 8, 15)
- [ ] 마크다운 노트 + 회의록 템플릿 + Task/Milestone 연결 역참조

## Phase 7 — 간트 + 칸반

- [ ] 간트: 연차 밴드, 마일스톤 레인, 오늘선, 막대 드래그/리사이즈 (§7.5)
- [ ] 칸반 ↔ 매트릭스 뷰 전환, 드래그로 status·중요도 변경 (PR-8, PR-9 준수)

## Phase 8 — To-Do + 설정 + 마감

- [ ] To-Do, 설정 화면(§7.14: 팀 설정 + 사용자 관리 + 백업), 인쇄 레이아웃 3종 (§12)
- [ ] §12 비기능 기준 샘플 검증: 5,000 노드 롤업 100ms 이내
- [ ] `npm run build` 성공 + Tauri 번들 생성
