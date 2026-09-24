// DB 응답 row 검증용 Zod 스키마 — snake_case 기준 (SOT §8.6)
// "DB 응답도 Zod로 검증한다. 스키마 마이그레이션 누락을 조용히 넘기지 않기 위해서다."
//
// 컬럼 구성은 supabase/migrations/20260802000000_initial_schema.sql과 1:1이다.
// 여기서 파싱된 row를 mapper.dbToApp으로 넘기면 types/index.ts의 앱 타입이 된다.
// enum 값 목록은 §5의 타입 정의와 동일해야 한다 (Zod는 런타임 값이 필요해 중복이 불가피).

import { z } from 'zod';

// date/timestamptz는 PostgREST가 문자열로 준다. 형식 검증까지는 하지 않는다 —
// 이 스키마의 목적은 스키마 드리프트(컬럼 누락·타입 변경) 감지다.
const isoTimestamp = z.string(); // timestamptz → ISO 8601
const isoDate = z.string();      // date → 'YYYY-MM-DD'

// N-4 공통 컬럼 (예외: app_users, app_settings, 조인 테이블)
const baseRow = {
  id: z.uuid(),
  created_at: isoTimestamp,
  updated_at: isoTimestamp,
  version: z.number(),
  created_by: z.uuid().nullable(),
  updated_by: z.uuid().nullable(),
};

// 1~5 척도 (importance, urgency, probability, impact)
const levelSchema = z.union([
  z.literal(1), z.literal(2), z.literal(3), z.literal(4), z.literal(5),
]);

// ─── §14.2 app_users — N-4 예외: version/created_by/updated_by 없음 ─

export const appUserRowSchema = z.object({
  id: z.uuid(),
  email: z.string(),
  name: z.string(),
  member_id: z.uuid().nullable(),
  active: z.boolean(),
  created_at: isoTimestamp,
  updated_at: isoTimestamp,
  last_seen_at: isoTimestamp,
});

// ─── §5.3 projects ───────────────────────────────────────────

export const projectStatusSchema = z.enum(['planning', 'active', 'on_hold', 'done', 'dropped']);

export const projectRowSchema = z.object({
  ...baseRow,
  name: z.string(),
  project_no: z.string(),
  ministry: z.string(),
  agency: z.string(),
  program_name: z.string(),
  description: z.string(),
  status: projectStatusSchema,
  color: z.string(),
  contract_start_date: isoDate.nullable(),
  contract_end_date: isoDate.nullable(),
  total_budget: z.number().nullable(),   // 금액은 원 단위 정수
  gov_budget: z.number().nullable(),
  own_budget: z.number().nullable(),
  pm_member_id: z.uuid().nullable(),
  lead_org_id: z.uuid().nullable(),
  // allowance_rate_limit·indirect_rate_limit는 Phase 13에서 budget_rules로 이관·삭제됐다 (§5.18)
  archived: z.boolean(),
  sort_order: z.number(),
});

// ─── §5.4 stages ─────────────────────────────────────────────

export const stageRowSchema = z.object({
  ...baseRow,
  project_id: z.uuid(),
  sort_order: z.number(),
  name: z.string(),
  goal: z.string(),
  start_date: isoDate.nullable(),
  end_date: isoDate.nullable(),
  budget: z.number().nullable(),
});

// ─── §5.5 years ──────────────────────────────────────────────

export const yearStatusSchema = z.enum(['planned', 'active', 'evaluating', 'closed']);

export const yearRowSchema = z.object({
  ...baseRow,
  project_id: z.uuid(),
  stage_id: z.uuid(),
  sort_order: z.number(),
  name: z.string(),
  goal: z.string(),
  start_date: isoDate.nullable(),
  end_date: isoDate.nullable(),
  budget: z.number().nullable(),
  status: yearStatusSchema,
});

// ─── §5.6 tasks — memberIds 등 조인 테이블 배열은 row에 없다 (N-2) ─

export const taskStatusSchema = z.enum(['todo', 'in_progress', 'done', 'blocked']);
export const progressModeSchema = z.enum(['manual', 'auto']);

export const taskRowSchema = z.object({
  ...baseRow,
  project_id: z.uuid(),
  year_id: z.uuid(),
  parent_id: z.uuid().nullable(),
  sort_order: z.number(),
  title: z.string(),
  description: z.string(),
  status: taskStatusSchema,
  progress_mode: progressModeSchema,
  manual_progress: z.number(),
  estimated_hours: z.number().nullable(),
  actual_hours: z.number().nullable(),
  start_date: isoDate.nullable(),
  due_date: isoDate.nullable(),
  importance: levelSchema,
  urgency_mode: z.enum(['auto', 'manual']),
  urgency_manual: levelSchema,
  owner_member_id: z.uuid().nullable(),
  org_id: z.uuid().nullable(),
  tags: z.array(z.string()),
});

// ─── §5.7 milestones ─────────────────────────────────────────

export const milestoneTypeSchema = z.enum([
  'annual_eval', 'stage_eval', 'final_eval', 'progress_check',
  'report', 'contract', 'demo', 'custom',
]);
export const milestoneStatusSchema = z.enum(['planned', 'preparing', 'done', 'delayed', 'cancelled']);

export const milestoneRowSchema = z.object({
  ...baseRow,
  project_id: z.uuid(),
  year_id: z.uuid().nullable(),
  type: milestoneTypeSchema,
  title: z.string(),
  date: isoDate,
  status: milestoneStatusSchema,
  owner_member_id: z.uuid().nullable(),
  description: z.string(),
  result_note: z.string(),
});

// ─── §5.8 deliverables / deliverable_achievements ────────────

export const deliverableTypeSchema = z.enum([
  'paper_sci', 'paper_domestic', 'conference',
  'patent_dom_apply', 'patent_dom_reg', 'patent_intl_apply', 'patent_intl_reg',
  'sw_registration', 'tech_transfer', 'commercialization',
  'standard', 'hr_training', 'other',
]);

export const deliverableRowSchema = z.object({
  ...baseRow,
  project_id: z.uuid(),
  type: deliverableTypeSchema,
  name: z.string(),
  unit: z.string(),
  target_total: z.number(),
  target_by_year: z.record(z.string(), z.number()), // { yearId: 목표건수 } — 키는 변환 금지 (N-13)
  org_id: z.uuid().nullable(),
  note: z.string(),
  sort_order: z.number(),
});

export const deliverableAchievementRowSchema = z.object({
  ...baseRow,
  deliverable_id: z.uuid(),
  title: z.string(),
  date: isoDate,
  year_id: z.uuid().nullable(),
  org_id: z.uuid().nullable(),
  evidence_url: z.string(),
  note: z.string(),
});

// ─── §5.9 tech_targets / tech_target_records ─────────────────

export const directionSchema = z.enum(['higher_better', 'lower_better', 'target_exact']);
export const measureMethodSchema = z.enum(['self', 'certified_lab', 'expert_review', 'customer', 'other']);

export const techTargetRowSchema = z.object({
  ...baseRow,
  project_id: z.uuid(),
  name: z.string(),
  unit: z.string(),
  direction: directionSchema,
  weight: z.number(),
  target_value: z.number(),
  target_by_year: z.record(z.string(), z.number()),
  baseline_domestic: z.number().nullable(),
  world_best: z.number().nullable(),
  world_best_holder: z.string(),
  measure_method: measureMethodSchema,
  measure_description: z.string(),
  org_id: z.uuid().nullable(),
  sort_order: z.number(),
});

export const techTargetRecordRowSchema = z.object({
  ...baseRow,
  tech_target_id: z.uuid(),
  value: z.number(),
  date: isoDate,
  year_id: z.uuid().nullable(),
  method: measureMethodSchema,
  evaluator: z.string(),
  evidence_url: z.string(),
  note: z.string(),
});

// ─── §5.10 organizations ─────────────────────────────────────

export const orgRoleSchema = z.enum(['lead', 'joint', 'consign']);

export const organizationRowSchema = z.object({
  ...baseRow,
  project_id: z.uuid(),
  name: z.string(),
  role: orgRoleSchema,
  type: z.string(),
  representative: z.string(),
  contact: z.string(),
  responsibility: z.string(),
  budget: z.number().nullable(),
  sort_order: z.number(),
});

// ─── §5.11 members ───────────────────────────────────────────

export const memberRoleSchema = z.enum(['pm', 'pl', 'researcher', 'staff']);
export const hireTypeSchema = z.enum(['existing', 'new']);

export const memberRowSchema = z.object({
  ...baseRow,
  project_id: z.uuid(),
  org_id: z.uuid().nullable(),
  name: z.string(),
  role: memberRoleSchema,
  position: z.string(),
  field: z.string(),
  email: z.string(),
  phone: z.string(),
  active: z.boolean(),
  sort_order: z.number(),
  annual_salary: z.number().nullable(), // 실지급액(연봉), 원 단위 정수 (§6.10.1 PL-1의 단가)
  hire_type: hireTypeSchema,
  // Phase 16 — 조직원 연결 + 급여 기준 스냅샷 3필드 (§5.11). 스냅샷이라 staff 삭제(set null) 뒤에도 남는다(ST-2)
  staff_id: z.uuid().nullable(),
  salary_includes_retirement: z.boolean().nullable(),
  salary_includes_insurance: z.boolean().nullable(),
  salary_applied_from: isoDate.nullable(),
});

// ─── §5.12 budget_items / budget_executions ──────────────────

export const budgetCategorySchema = z.enum([
  'personnel', 'student_personnel', 'facility_equipment', 'material',
  'consignment', 'international', 'burden', 'activity',
  'promotion', 'allowance', 'indirect', 'other',
]);

export const budgetItemRowSchema = z.object({
  ...baseRow,
  project_id: z.uuid(),
  year_id: z.uuid(),
  category: budgetCategorySchema,
  planned_amount: z.number(),
  cash_amount: z.number().nullable(),
  in_kind_amount: z.number().nullable(),
  note: z.string(),
});

export const budgetExecutionRowSchema = z.object({
  ...baseRow,
  budget_item_id: z.uuid(),
  date: isoDate,
  amount: z.number(),
  description: z.string(),
  note: z.string(),
});

// ─── §5.17 budget_details (산출근거) ─────────────────────────
// budget_items에는 detail_count 컬럼이 없다 — 조회 시 세어 싣는 파생 값이다 (§5.12 주석).

export const detailAxisSchema = z.enum(['cash', 'in_kind']);
export const detailFormulaSchema = z.enum(['personnel', 'quantity']);

// jsonb 내부는 앱 형태 그대로 저장된다 — isPercent는 camelCase (mapper의 JSONB_PASSTHROUGH_KEYS).
// passthrough로 두면 라벨 오타·문자열 숫자가 그대로 통과해 §6.10.1 계산이 NaN을 낳는다.
export const detailFactorSchema = z.object({
  label: z.string(),
  value: z.number(),
  isPercent: z.boolean(),
});

export const budgetDetailRowSchema = z.object({
  ...baseRow,
  project_id: z.uuid(),
  year_id: z.uuid(),
  category: budgetCategorySchema,
  subcategory: z.string(),        // 부록 A.5 세목 코드. 세목이 없는 비목은 'default'
  axis: detailAxisSchema,
  formula: detailFormulaSchema,
  member_id: z.uuid().nullable(),
  name: z.string(),
  unit_price: z.number(),
  spec: z.string(),
  factors: z.array(detailFactorSchema),
  adjustment: z.number(),         // 음수 허용 (PL-D5)
  note: z.string(),
  sort_order: z.number(),
  amount: z.number(),             // 서버가 lib/budget-plan.ts로 계산해 넣은 값 (PL-D7)
});

// ─── §5.18 budget_rules ──────────────────────────────────────
// 코드×값 조합(RL-D2·D3)은 DB check가 최종 방어선이고 액션 Zod가 RULE_SPECS로 먼저 막는다.
// 여기서는 드리프트 감지(컬럼·enum)만 한다.

export const ruleCodeSchema = z.enum([
  'allowance_max', 'allowance_min', 'indirect_max', 'consignment_max',
  'external_tech_max', 'gov_share_max', 'own_cash_min',
  'indirect_cash_only', 'no_personnel_support', 'no_student_personnel',
  'no_burden', 'existing_personnel_cash', 'existing_cash_le_new',
  'min_participation',
  'equipment_review_threshold', 'material_notice_threshold', 'outsourcing_notice_threshold',
]);
export const ruleSeveritySchema = z.enum(['error', 'warn', 'info']);
export const indirectBaseSchema = z.enum(['direct_cash_excl_intl_consign_burden', 'direct_cash_excl_intl']);

export const budgetRuleRowSchema = z.object({
  ...baseRow,
  project_id: z.uuid(),
  code: ruleCodeSchema,
  enabled: z.boolean(),
  value: z.number().nullable(),   // numeric — PostgREST가 JSON 숫자로 준다. 비율(%) 또는 원 단위 정수
  base: indirectBaseSchema.nullable(),
  severity: ruleSeveritySchema,
  source: z.string(),
  note: z.string(),
});

// ─── §5.19 staff / §5.20 staff_salaries (Phase 16) ───────────
// 이메일 유일(ST-1)·(staff_id, effective_from) 유일(SL-2)은 DB unique가 최종 방어선이다. 여기서는 드리프트 감지만 한다.

export const staffRowSchema = z.object({
  ...baseRow,
  name: z.string(),
  email: z.string(),
  position: z.string(),
  employed: z.boolean(),
  note: z.string(),
  sort_order: z.number(),
});

export const salaryBasisSchema = z.enum(['annual', 'monthly']);

export const staffSalaryRowSchema = z.object({
  ...baseRow,
  staff_id: z.uuid(),
  effective_from: isoDate,
  basis: salaryBasisSchema,
  amount: z.number().int().min(0), // basis 단위의 금액. 원 단위 정수 — 절대 규칙 4. DB check(≥0)와 같은 조건
  includes_retirement: z.boolean(),
  includes_insurance: z.boolean(),
  note: z.string(),
});

// ─── §5.13 risks ─────────────────────────────────────────────

export const riskCategorySchema = z.enum(['technical', 'schedule', 'budget', 'resource', 'external', 'other']);
export const riskStrategySchema = z.enum(['mitigate', 'avoid', 'transfer', 'accept']);
export const riskStatusSchema = z.enum(['identified', 'monitoring', 'occurred', 'resolved', 'closed']);

export const riskRowSchema = z.object({
  ...baseRow,
  project_id: z.uuid(),
  year_id: z.uuid().nullable(),
  task_id: z.uuid().nullable(),
  title: z.string(),
  category: riskCategorySchema,
  description: z.string(),
  probability: levelSchema,
  impact: levelSchema,
  strategy: riskStrategySchema,
  response: z.string(),
  contingency: z.string(),
  owner_member_id: z.uuid().nullable(),
  due_date: isoDate.nullable(),
  status: riskStatusSchema,
  sort_order: z.number(),
});

// ─── §5.14 notes ─────────────────────────────────────────────

export const noteTypeSchema = z.enum(['meeting', 'tech', 'issue', 'idea', 'report_draft', 'other']);

export const noteRowSchema = z.object({
  ...baseRow,
  project_id: z.uuid().nullable(),
  year_id: z.uuid().nullable(),
  task_id: z.uuid().nullable(),
  milestone_id: z.uuid().nullable(),
  type: noteTypeSchema,
  title: z.string(),
  body: z.string(),
  date: isoDate,
  tags: z.array(z.string()),
  pinned: z.boolean(),
});

// ─── §5.15 todos ─────────────────────────────────────────────

export const prioritySchema = z.enum(['low', 'normal', 'high']);

export const todoRowSchema = z.object({
  ...baseRow,
  title: z.string(),
  done: z.boolean(),
  project_id: z.uuid().nullable(),
  due_date: isoDate.nullable(),
  priority: prioritySchema,
  sort_order: z.number(),
  completed_at: isoTimestamp.nullable(),
});

// ─── §5.16 app_settings — N-10 단일 행. id는 boolean true ────
// N-4 예외지만 마이그레이션이 낙관적 잠금(O-1)용 version 등을 둔다.

export const appSettingsRowSchema = z.object({
  id: z.literal(true),
  due_soon_days: z.number(),
  milestone_alert_days: z.number(),
  week_starts_on: z.union([z.literal(0), z.literal(1)]),
  default_gantt_scale: z.enum(['day', 'week', 'month']),
  currency_unit: z.enum(['원', '천원', '백만원']),
  progress_weight_basis: z.enum(['budget', 'equal']),
  schema_version: z.number(),
  created_at: isoTimestamp,
  updated_at: isoTimestamp,
  version: z.number(),
  updated_by: z.uuid().nullable(),
});

// ─── §5.12.1 import_profiles ─────────────────────────────────

// §5.12.1 — 'budget_detail'은 산출근거 시트 임포트(§6.11). DB check 제약과 값이 같아야 한다
// (supabase/migrations/20260815000000_import_kind_budget_detail.sql)
export const importKindSchema = z.enum(['budget_plan', 'budget_detail']);

export const importProfileRowSchema = z.object({
  ...baseRow,
  name: z.string(),
  kind: importKindSchema,
  ministry: z.string().nullable(),
  project_id: z.uuid().nullable(),
  sheet_name: z.string().nullable(),
  header_row: z.number(),
  data_start_row: z.number(),
  orientation: z.enum(['row', 'column']),
  label_columns: z.array(z.string()),
  // jsonb 내부는 앱 형태 그대로 저장된다 — yearOrder는 camelCase (mapper 참조)
  year_column_mappings: z.array(z.object({ column: z.string(), yearOrder: z.number() })),
  category_aliases: z.record(z.string(), budgetCategorySchema), // 키 = 엑셀 원문 라벨. 변환 금지
  amount_unit: z.union([z.literal(1), z.literal(1000), z.literal(1000000)]),
  skip_row_patterns: z.array(z.string()),
  last_used_at: isoTimestamp.nullable(),
  use_count: z.number(),
});

// ─── I-17 import_snapshots (내부) ────────────────────────────
// snapshot 구조는 commit_import RPC(20260810000000_import_rpcs.sql)가 정의한다.
// jsonb 내부는 앱 형태 그대로라 키가 camelCase다 (mapper의 JSONB_PASSTHROUGH_KEYS).
// 형식을 느슨하게 두면 복원(restore_import_snapshot)이 잘못된 스냅샷을 먹고
// 예산을 엉뚱한 값으로 되돌린다 — 여기서 구조를 끝까지 검증한다.

export const importSnapshotItemSchema = z.object({
  yearId: z.uuid(),
  category: budgetCategorySchema,
  plannedAmount: z.number(),
  cashAmount: z.number().nullable(),
  inKindAmount: z.number().nullable(),
  existed: z.boolean(),
});

export const importSnapshotPayloadSchema = z.object({
  schemaVersion: z.number(),
  projectId: z.uuid(),
  capturedAt: isoTimestamp,
  // D-17: 산출근거 스냅샷(commit_detail_import)에만 있다. Zod가 모르는 키를 지우므로
  // 여기 적지 않으면 설정 화면이 스냅샷 종류를 영영 알 수 없다 (총괄표 스냅샷은 undefined)
  kind: z.literal('budget_detail').optional(),
  source: z.object({
    fileName: z.string(),
    sheetName: z.string(),
    profileId: z.uuid().nullable(),
    fileHash: z.string(),
  }),
  items: z.array(importSnapshotItemSchema),
});

export const importSnapshotRowSchema = z.object({
  ...baseRow,
  project_id: z.uuid(),
  snapshot: importSnapshotPayloadSchema,
});

// ─── N-2 조인 테이블 5종 — id·타임스탬프만 (N-4 예외) ────────

const joinBase = {
  id: z.uuid(),
  created_at: isoTimestamp,
  updated_at: isoTimestamp,
};

export const taskMemberRowSchema = z.object({
  ...joinBase,
  task_id: z.uuid(),
  member_id: z.uuid(),
});

export const taskDeliverableRowSchema = z.object({
  ...joinBase,
  task_id: z.uuid(),
  deliverable_id: z.uuid(),
});

export const taskTechTargetRowSchema = z.object({
  ...joinBase,
  task_id: z.uuid(),
  tech_target_id: z.uuid(),
});

export const achievementMemberRowSchema = z.object({
  ...joinBase,
  achievement_id: z.uuid(),
  member_id: z.uuid(),
});

export const noteAttendeeRowSchema = z.object({
  ...joinBase,
  note_id: z.uuid(),
  member_id: z.uuid(),
});

// ─── 추론 타입 (리포지토리 내부용 — 앱 타입은 types/index.ts) ─

export type AppUserRow = z.infer<typeof appUserRowSchema>;
export type ProjectRow = z.infer<typeof projectRowSchema>;
export type StageRow = z.infer<typeof stageRowSchema>;
export type YearRow = z.infer<typeof yearRowSchema>;
export type TaskRow = z.infer<typeof taskRowSchema>;
export type MilestoneRow = z.infer<typeof milestoneRowSchema>;
export type DeliverableRow = z.infer<typeof deliverableRowSchema>;
export type DeliverableAchievementRow = z.infer<typeof deliverableAchievementRowSchema>;
export type TechTargetRow = z.infer<typeof techTargetRowSchema>;
export type TechTargetRecordRow = z.infer<typeof techTargetRecordRowSchema>;
export type OrganizationRow = z.infer<typeof organizationRowSchema>;
export type MemberRow = z.infer<typeof memberRowSchema>;
export type BudgetItemRow = z.infer<typeof budgetItemRowSchema>;
export type BudgetExecutionRow = z.infer<typeof budgetExecutionRowSchema>;
export type BudgetDetailRow = z.infer<typeof budgetDetailRowSchema>;
export type BudgetRuleRow = z.infer<typeof budgetRuleRowSchema>;
export type StaffRow = z.infer<typeof staffRowSchema>;
export type StaffSalaryRow = z.infer<typeof staffSalaryRowSchema>;
export type RiskRow = z.infer<typeof riskRowSchema>;
export type NoteRow = z.infer<typeof noteRowSchema>;
export type TodoRow = z.infer<typeof todoRowSchema>;
export type AppSettingsRow = z.infer<typeof appSettingsRowSchema>;
export type ImportProfileRow = z.infer<typeof importProfileRowSchema>;
export type ImportSnapshotRow = z.infer<typeof importSnapshotRowSchema>;
export type TaskMemberRow = z.infer<typeof taskMemberRowSchema>;
export type TaskDeliverableRow = z.infer<typeof taskDeliverableRowSchema>;
export type TaskTechTargetRow = z.infer<typeof taskTechTargetRowSchema>;
export type AchievementMemberRow = z.infer<typeof achievementMemberRowSchema>;
export type NoteAttendeeRow = z.infer<typeof noteAttendeeRowSchema>;
