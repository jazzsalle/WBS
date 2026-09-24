# Phase 16 구현 계획 (planner 산출, 2026-09-25) — 재개용

확정 결정 3건(SOT 반영): ① 스냅샷 3필드는 `apply_salary_change`의 `p_snapshot jsonb default null` 인자로 같은 UPDATE(PL-10b) ② `createStaffFromHr(drafts)` — 키 안 받음(§9) ③ `updateMember`로 연봉을 수동 수정하면 스냅샷 3필드 null(PL-10b).

파일 소유: types/index.ts→T2, lib/constants.ts→T1, lib/db/schema.ts→T2, lib/db/backup.ts→T1, lib/db/members.ts·budget-details.ts·years.ts→T4, actions/team.ts→T6, components/team/MemberSection.tsx→T11, components/budget/BudgetScreen.tsx·actions/budget-plan.ts→T12, app/page.tsx·components/team/HrDirectoryModal.tsx→T8.

## 태스크
- **[P] T1 마이그레이션 schema 4 + db push** — `supabase/migrations/20260925000000_staff_salary.sql`(staff: 공통 컬럼+name·email·position·employed·note·sort_order, unique lower(trim(email)); staff_salaries: staff_id cascade·effective_from·basis check·amount ≥0·플래그 2·note, unique(staff_id,effective_from); members 4컬럼(staff_id set null·스냅샷 3); `apply_salary_change`에 `p_snapshot jsonb default null`; restore_backup c_tables에 staff·staff_salaries(projects 앞); schema_version 4; publication 미추가), `lib/constants.ts`(EXPECTED_SCHEMA_VERSION 4, 기준 배지 라벨), `lib/db/backup.ts`(RESTORE_TABLES), destructive 테이블 수 29, `tests/integration/staff-migration.test.ts`(이메일 대소문자 중복 23505·이력 중복·amount -1·삭제 시 cascade/set null/스냅샷 유지). K-6 백업 → db push → schema_version 4 확인
- **[P] T2 타입·Zod** — `types/index.ts`(SalaryBasis·Staff·StaffSalary·Member 4필드), `lib/db/schema.ts`(staffRowSchema·staffSalaryRowSchema·memberRowSchema 확장)
- **[AFTER T2] T3 순수 함수** — `lib/salary.ts`(toAnnualSalary·monthlyDisplay·pickSalaryAsOf·salaryBasisBadge), `lib/participation.ts`(computeStaffParticipation PS-1~PS-4), 단위 테스트 + `staff-boundary.test.ts`
- **[AFTER T1,T2] T4 리포지토리** — `lib/db/staff.ts`, members.ts(MemberInput 스냅샷 optional·listMembersByStaffIds·listLinkedMembersAll·applySalaryChange snapshot), budget-details.ts(listPersonnelDetailsAll 페이징), years.ts(listAllYears), `staff-repo.test.ts`
- **[AFTER T3,T4] T6 actions/team.ts** — linkMemberToStaff·previewStaffSalaryApply·applyStaffSalary(PL-10b 경로)·fetchHrDirectoryForStaff·updateMember 스냅샷 null, `staff-salary-apply.test.ts`(월급 3,000,000 퇴직금 포함 → 36,000,000·true·false·'2026-01-01'·detail 18,000,000)
- **[AFTER T3,T4] T7 actions/staff.ts** — listStaff·getStaffDetail·CRUD·createStaffFromHr(drafts)·급여 이력 CRUD·getStaffParticipation(year), `staff-actions.test.ts`(110 error)
- **[AFTER T7] T8 /staff 셸·목록** — app/staff/page.tsx·loading, StaffScreen·StaffList·StaffFormModal, app/page.tsx 링크, HrDirectoryModal submit prop
- **[AFTER T7] T9 StaffDetailPanel + SalaryFormModal** — 이력 CRUD(O-1), 연결 Member(다름 배지, 반영 버튼 없음)
- **[AFTER T7] T10 ParticipationMatrix** — 연도별 매트릭스·tone 서버값·안내 3종·인쇄
- **[AFTER T6,T7] T11 MemberSection** — 조직원 열·StaffLinkPicker·[급여 반영]→SalaryApplyDialog·기준 배지
- **[AFTER T11] T12 [인건비] 탭** — PersonnelTab·PersonnelRow, BudgetScreen 보기 토글, `getPersonnelTabData`
- **[AFTER 전부] T13 마감 검증** — npm test·tsc·build, 자동 반영 경로 부재 정적 검사, 평가표

의존: T1 ∥ T2 → T3(T2) → T4(T1,T2) → {T6,T7} → {T8,T9,T10} ∥ T11 → T12 → T13.
