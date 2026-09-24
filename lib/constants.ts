// SOT 부록 A(A.1~A.5)·부록 C, §6.6 H-3, §8.8의 상수 정의.
// 라벨 맵은 Record<EnumType, string>으로 선언해 enum 값 누락이 컴파일 에러가 되게 한다 (A.4).

// 부록 C.2 조회 키는 I-1 정규화형이라 normalize에 의존한다.
// normalize.ts는 아무것도 import하지 않으므로 순환이 생기지 않는다
import { normalizeLabel } from '@/lib/import/normalize';
import type {
  BudgetCategory,
  DeliverableType,
  DetailAxis,
  DetailFormula,
  Direction,
  HireType,
  IndirectBase,
  MeasureMethod,
  MemberRole,
  MilestoneStatus,
  MilestoneType,
  NoteType,
  OrgRole,
  Priority,
  ProjectStatus,
  RiskCategory,
  RiskStatus,
  RiskStrategy,
  TaskStatus,
  YearStatus,
} from '@/types';

// ─── §6.6 H-3 / §8.8 ─────────────────────────────────────────

// 루트 = 깊이 1 기준 최대 깊이. SQL move_task 함수와 동일 정의를 유지해야 한다 (H-3)
export const MAX_TASK_DEPTH = 10;

// 코드가 기대하는 app_settings.schema_version. 불일치 시 앱 진입을 막는다 (§8.8)
// 2 = Phase 9(budget_details 신설). 백업 파일 형식이 바뀌므로 올렸다 —
// 구 백업(v1)은 budget_details 키가 없어 복원할 수 없고, K-5가 그 사실을 정확히 알린다
// 3 = Phase 13(budget_rules 신설 + projects 한도 컬럼 2종 삭제, §5.18 RL-D7) — 같은 이유
// 4 = Phase 16(staff·staff_salaries 신설 + members 컬럼 4종, §5.19·§5.20) — 같은 이유
export const EXPECTED_SCHEMA_VERSION = 4;

// ─── 부록 A.1 비목 라벨 ──────────────────────────────────────

// 부록 A.1 표 순서 그대로. 연구비 매트릭스(§7.9)의 행 순서 원본이며, 화면마다
// 비목 순서가 달라지지 않게 여기 하나만 참조한다.
export const BUDGET_CATEGORY_ORDER = [
  'personnel',
  'student_personnel',
  'facility_equipment',
  'material',
  'consignment',
  'international',
  'burden',
  'activity',
  'promotion',
  'allowance',
  'indirect',
  'other',
] as const satisfies readonly BudgetCategory[];

// 비목이 늘거나 줄면 여기서 컴파일 에러가 난다 — 순서 배열이 라벨 맵과 어긋난 채 남는 것을 막는다
export const BUDGET_CATEGORY_COUNT: 12 = BUDGET_CATEGORY_ORDER.length;

export const BUDGET_CATEGORY_LABELS: Record<BudgetCategory, string> = {
  personnel: '인건비',
  student_personnel: '학생인건비',
  facility_equipment: '연구시설·장비비',
  material: '연구재료비',
  consignment: '위탁연구개발비',
  international: '국제공동연구개발비',
  burden: '연구개발부담비',
  activity: '연구활동비',
  promotion: '연구과제추진비',
  allowance: '연구수당',
  indirect: '간접비',
  other: '기타',
};

// 직접비/간접비 구분. 'other'는 A.1에서 '—' — 어느 쪽도 아니므로 null
/**
 * §5.18 IndirectBase(RL-3 수정직접비 분모)의 한국어 이름. 정의 자체는 lib/budget-plan.ts modifiedDirectCost
 * 한 곳이고 여기는 이름뿐이다 — 검증 패널·규칙 편집·내보내기가 같은 문구를 써야 사용자가 같은 분모로 읽는다
 */
export const INDIRECT_BASE_LABELS: Record<IndirectBase, string> = {
  direct_cash_excl_intl_consign_burden: '직접비 현금 − 위탁·국제공동·부담비 (과기부고시 제2조 9호)',
  direct_cash_excl_intl: '직접비 현금 − 국제공동 (기후부고시 별표 5)',
};

export const BUDGET_CATEGORY_GROUPS: Record<BudgetCategory, '직접비' | '간접비' | null> = {
  personnel: '직접비',
  student_personnel: '직접비',
  facility_equipment: '직접비',
  material: '직접비',
  consignment: '직접비',
  international: '직접비',
  burden: '직접비',
  activity: '직접비',
  promotion: '직접비',
  allowance: '직접비',
  indirect: '간접비',
  other: null,
};

// ─── 부록 A.2 성과목표 유형 라벨 ─────────────────────────────

export const DELIVERABLE_TYPE_LABELS: Record<DeliverableType, string> = {
  paper_sci: 'SCI(E) 논문',
  paper_domestic: '국내 학술지 논문',
  conference: '학술대회 발표',
  patent_dom_apply: '국내 특허 출원',
  patent_dom_reg: '국내 특허 등록',
  patent_intl_apply: '해외 특허 출원',
  patent_intl_reg: '해외 특허 등록',
  sw_registration: 'SW 프로그램 등록',
  tech_transfer: '기술이전',
  commercialization: '사업화',
  standard: '표준화',
  hr_training: '인력양성',
  other: '기타',
};

export const DELIVERABLE_TYPE_DEFAULT_UNITS: Record<DeliverableType, string> = {
  paper_sci: '건',
  paper_domestic: '건',
  conference: '건',
  patent_dom_apply: '건',
  patent_dom_reg: '건',
  patent_intl_apply: '건',
  patent_intl_reg: '건',
  sw_registration: '건',
  tech_transfer: '건',
  commercialization: '건',
  standard: '건',
  hr_training: '명',
  other: '건',
};

// ─── 부록 A.3 색상 규약 (Tailwind 팔레트 토큰) ───────────────

export const TASK_STATUS_COLORS: Record<TaskStatus, string> = {
  todo: 'grey-400',
  in_progress: 'blue-500',
  done: 'green-500',
  blocked: 'red-500',
};

// 마감 판정 색상 (§6.5)
export const DUE_COLORS = {
  overdue: 'red-600',
  dueSoon: 'orange-500',
} as const;

export const MILESTONE_TYPE_COLORS: Record<MilestoneType, string> = {
  annual_eval: 'purple-600',
  stage_eval: 'purple-600',
  final_eval: 'purple-600',
  report: 'blue-600',
  progress_check: 'teal-600',
  contract: 'grey-600',
  demo: 'grey-600',
  custom: 'grey-600',
};

// 우선순위 점수(§6.9.2 importance × urgency, 1~25) 구간별 등급·색상. min ≤ score ≤ max
export const PRIORITY_SCORE_COLORS = [
  { min: 15, max: 25, grade: '최우선', color: 'red-600' },
  { min: 8, max: 14, grade: '높음', color: 'orange-500' },
  { min: 4, max: 7, grade: '보통', color: 'grey-500' },
  { min: 1, max: 3, grade: '낮음', color: 'grey-400' },
] as const;

// 리스크 점수(probability × impact, 1~25) 구간별 색상. min ≤ score ≤ max
export const RISK_SCORE_COLORS = [
  { min: 15, max: 25, color: 'red-600' },
  { min: 8, max: 14, color: 'orange-500' },
  { min: 1, max: 7, color: 'green-600' },
] as const;

export const ORG_ROLE_COLORS: Record<OrgRole, string> = {
  lead: 'purple-600',
  joint: 'blue-600',
  consign: 'grey-500',
};

// ─── 부록 A.4 기타 enum 한글 라벨 (17종) ─────────────────────

export const PROJECT_STATUS_LABELS: Record<ProjectStatus, string> = {
  planning: '기획',
  active: '수행중',
  on_hold: '중단',
  done: '종료',
  dropped: '탈락',
};

export const TASK_STATUS_LABELS: Record<TaskStatus, string> = {
  todo: '예정',
  in_progress: '진행중',
  done: '완료',
  blocked: '막힘',
};

export const YEAR_STATUS_LABELS: Record<YearStatus, string> = {
  planned: '계획',
  active: '수행중',
  evaluating: '평가중',
  closed: '종료',
};

export const MILESTONE_TYPE_LABELS: Record<MilestoneType, string> = {
  annual_eval: '연차평가',
  stage_eval: '단계평가',
  final_eval: '최종평가',
  progress_check: '진도점검',
  report: '보고서 제출',
  contract: '협약',
  demo: '시연/시험',
  custom: '기타',
};

export const MILESTONE_STATUS_LABELS: Record<MilestoneStatus, string> = {
  planned: '예정',
  preparing: '준비중',
  done: '완료',
  delayed: '지연',
  cancelled: '취소',
};

export const ORG_ROLE_LABELS: Record<OrgRole, string> = {
  lead: '주관',
  joint: '공동',
  consign: '위탁',
};

export const MEMBER_ROLE_LABELS: Record<MemberRole, string> = {
  pm: '총괄책임자',
  pl: '책임자',
  researcher: '연구원',
  staff: '지원',
};

export const MEASURE_METHOD_LABELS: Record<MeasureMethod, string> = {
  self: '자체측정',
  certified_lab: '공인시험',
  expert_review: '전문가평가',
  customer: '수요처평가',
  other: '기타',
};

export const DIRECTION_LABELS: Record<Direction, string> = {
  higher_better: '높을수록 우수',
  lower_better: '낮을수록 우수',
  target_exact: '목표값 일치',
};

export const RISK_CATEGORY_LABELS: Record<RiskCategory, string> = {
  technical: '기술',
  schedule: '일정',
  budget: '예산',
  resource: '인력',
  external: '외부',
  other: '기타',
};

export const RISK_STRATEGY_LABELS: Record<RiskStrategy, string> = {
  mitigate: '완화',
  avoid: '회피',
  transfer: '전가',
  accept: '수용',
};

export const RISK_STATUS_LABELS: Record<RiskStatus, string> = {
  identified: '식별',
  monitoring: '관찰중',
  occurred: '발생',
  resolved: '해결',
  closed: '종결',
};

export const NOTE_TYPE_LABELS: Record<NoteType, string> = {
  meeting: '회의록',
  tech: '기술메모',
  issue: '이슈',
  idea: '아이디어',
  report_draft: '보고서 초안',
  other: '기타',
};

export const PRIORITY_LABELS: Record<Priority, string> = {
  low: '낮음',
  normal: '보통',
  high: '높음',
};

export const HIRE_TYPE_LABELS: Record<HireType, string> = {
  existing: '기존인력',
  new: '채용예정',
};

// ─── §5.20 급여 이력 (Phase 16) ──────────────────────────────

// SalaryBasis 타입은 T2(types/index.ts)가 정의한다. 여기서는 리터럴 유니온으로 키를 고정해
// 타입 파일과의 동시 편집에서 순환·과도기 의존을 만들지 않는다
export const SALARY_BASIS_LABELS: Record<'annual' | 'monthly', string> = {
  annual: '연봉',
  monthly: '월급',
};

// 급여 기준 배지 문구 (§5.11 스냅샷 3필드, §7.10 연봉 칸·§7.9.6 [기준] 열).
// none = 스냅샷 3필드가 전부 null — 수동 입력이거나 [급여 반영] 전
export const SALARY_FLAG_LABELS = {
  retirement: '퇴직금 포함',
  insurance: '4대보험 포함',
  none: '기록 없음',
} as const;

export const DETAIL_AXIS_LABELS: Record<DetailAxis, string> = {
  cash: '현금',
  in_kind: '현물',
};

export const DETAIL_FORMULA_LABELS: Record<DetailFormula, string> = {
  personnel: '인건비산식',
  quantity: '단가×수량',
};

// ─── 부록 A.5 세목 프리셋 (예산 제안 §5.17) ──────────────────

/**
 * 세목 정의. `defaultFactors`는 행 추가 시 채워지는 **초기값**일 뿐이며 라벨은 행마다
 * 바꿀 수 있다 (PL-3) — 실측에서도 ⑥ 소프트웨어 활용비의 수량 라벨이 `시트(수량)`였다.
 * 단가(`unitPrice`)는 인자가 아니다. 인자는 단가에 **곱해지는** 값들이다 (부록 A.5 주의 1).
 */
export interface SubcategoryDef {
  code: string;              // BudgetDetail.subcategory에 저장되는 값
  label: string;             // 화면 표시. 서식의 번호(①②…)를 포함한다
  formula: DetailFormula;
  defaultFactors: { label: string; isPercent: boolean }[];
}

// 참여율은 % 인자, 참여기간(월)은 12로 나뉘는 개월 수다 (PL-1). 인건비 세목 5종이 같은 구성이다
const PERSONNEL_FACTORS: SubcategoryDef['defaultFactors'] = [
  { label: '참여율(%)', isPercent: true },
  { label: '참여기간(월)', isPercent: false },
];

/**
 * 비목 → 세목 목록. 비목 키 순서는 BUDGET_CATEGORY_ORDER(부록 A.1)를 따르고,
 * 비목 안의 세목 순서는 부록 A.5 표 그대로다 — §7.9의 세목 섹션 나열 순서가 이 배열이다.
 * `default`는 "세목 없음"의 코드다. null 대신 문자열 상수를 쓰는 이유는
 * (year, category, subcategory) 집계에서 null 비교를 피하기 위해서다 (주의 3).
 * 프리셋에 없는 세목이 실무에서 나타나면 **부록 A.5를 먼저 고친다** (PL-D4).
 */
export const SUBCATEGORY_PRESETS: Record<BudgetCategory, SubcategoryDef[]> = {
  personnel: [
    { code: 'personnel_internal', label: '내부인건비', formula: 'personnel', defaultFactors: PERSONNEL_FACTORS },
    { code: 'personnel_external', label: '외부인건비', formula: 'personnel', defaultFactors: PERSONNEL_FACTORS },
    { code: 'personnel_support', label: '연구지원인력인건비', formula: 'personnel', defaultFactors: PERSONNEL_FACTORS },
  ],
  student_personnel: [
    { code: 'student_general', label: '일반', formula: 'personnel', defaultFactors: PERSONNEL_FACTORS },
    { code: 'student_managed', label: '통합관리', formula: 'personnel', defaultFactors: PERSONNEL_FACTORS },
  ],
  facility_equipment: [
    { code: 'facility_purchase', label: '① 연구시설·장비 구입·설치비', formula: 'quantity', defaultFactors: [{ label: '수량', isPercent: false }] },
    { code: 'facility_lease', label: '② 연구시설·장비 임차비', formula: 'quantity', defaultFactors: [{ label: '수량', isPercent: false }] },
    { code: 'facility_maintain', label: '③ 연구시설·장비 운영·유지비', formula: 'quantity', defaultFactors: [{ label: '수량', isPercent: false }] },
    { code: 'facility_infra', label: '④ 연구인프라 조성비', formula: 'quantity', defaultFactors: [{ label: '수량', isPercent: false }] },
  ],
  material: [
    { code: 'material_purchase', label: '① 연구재료 구입비', formula: 'quantity', defaultFactors: [{ label: '수량', isPercent: false }] },
    { code: 'material_manage', label: '② 연구개발과제 관리비', formula: 'quantity', defaultFactors: [{ label: '수량', isPercent: false }] },
    { code: 'material_make', label: '③ 연구재료 제작비', formula: 'quantity', defaultFactors: [{ label: '수량', isPercent: false }] },
  ],
  consignment: [
    { code: 'default', label: '위탁연구개발비', formula: 'quantity', defaultFactors: [{ label: '수량', isPercent: false }] },
  ],
  international: [
    { code: 'default', label: '국제공동연구개발비', formula: 'quantity', defaultFactors: [{ label: '수량', isPercent: false }] },
  ],
  burden: [
    { code: 'default', label: '연구개발부담비', formula: 'quantity', defaultFactors: [] },
  ],
  activity: [
    { code: 'activity_outsourcing', label: '① 외주용역비', formula: 'quantity', defaultFactors: [{ label: '수량', isPercent: false }] },
    { code: 'activity_ip', label: '② 지식재산 창출 활동비', formula: 'quantity', defaultFactors: [{ label: '회', isPercent: false }, { label: '월', isPercent: false }] },
    { code: 'activity_expert', label: '③ 외부 전문기술 활용비', formula: 'quantity', defaultFactors: [{ label: '회', isPercent: false }, { label: '월', isPercent: false }] },
    { code: 'activity_meeting', label: '④ 회의비', formula: 'quantity', defaultFactors: [{ label: '회', isPercent: false }] },
    { code: 'activity_travel_dom', label: '⑤ 국내출장비', formula: 'quantity', defaultFactors: [{ label: '인원', isPercent: false }, { label: '횟수', isPercent: false }] },
    { code: 'activity_travel_intl', label: '⑤ 국외출장비', formula: 'quantity', defaultFactors: [{ label: '인원', isPercent: false }, { label: '횟수', isPercent: false }] },
    { code: 'activity_software', label: '⑥ 소프트웨어 활용비', formula: 'quantity', defaultFactors: [{ label: '수량', isPercent: false }, { label: '월', isPercent: false }] },
    { code: 'activity_lab_ops', label: '⑦ 연구실 운영비', formula: 'quantity', defaultFactors: [{ label: '횟수', isPercent: false }] },
    { code: 'activity_hr_support', label: '⑧ 연구인력 지원비', formula: 'quantity', defaultFactors: [{ label: '인원', isPercent: false }, { label: '횟수', isPercent: false }] },
    { code: 'activity_pmo', label: '⑨ 종합사업관리비', formula: 'quantity', defaultFactors: [{ label: '회', isPercent: false }, { label: '월', isPercent: false }] },
    { code: 'activity_cloud', label: '⑩ 클라우드컴퓨팅서비스 이용료', formula: 'quantity', defaultFactors: [{ label: '회', isPercent: false }, { label: '월', isPercent: false }] },
    { code: 'activity_etc', label: '⑪ 그 밖의 비용', formula: 'quantity', defaultFactors: [{ label: '회', isPercent: false }] },
  ],
  promotion: [
    { code: 'default', label: '연구과제추진비', formula: 'quantity', defaultFactors: [{ label: '회', isPercent: false }] },
  ],
  allowance: [
    { code: 'default', label: '연구수당', formula: 'quantity', defaultFactors: [] },
  ],
  indirect: [
    { code: 'indirect_hr', label: '가. 인력지원비', formula: 'quantity', defaultFactors: [] },
    { code: 'indirect_support', label: '나. 연구지원비', formula: 'quantity', defaultFactors: [] },
    { code: 'indirect_outcome', label: '다. 성과활용지원비', formula: 'quantity', defaultFactors: [] },
  ],
  other: [
    { code: 'default', label: '기타', formula: 'quantity', defaultFactors: [] },
  ],
};

// 세목이 없는 비목의 세목 코드 (부록 A.5 주의 3)
export const DEFAULT_SUBCATEGORY_CODE = 'default';

// ─── 부록 C.2 세목 별칭 사전 (산출근거 임포트 §6.11 D-3) ──────
// 키는 I-1 정규화형 + 선행 번호 제거형(subcategoryLookupKey)이다.
// 부록 A.5의 표시 라벨은 정규화하면 자동으로 키가 되므로 여기 다시 적지 않는다 —
// 아래는 **실측에서 확인된 변형만** 담는다.

/**
 * 비목 → (정규화 라벨 → 세목 코드).
 *
 * `activity` 외 11종이 빈 객체인 것은 누락이 아니다 — "나머지 비목은 부록 A.5 라벨의
 * 정규화형으로 충분하다"(C.2, 실측 2종 기준). 비목 12종을 모두 적어 두는 이유는
 * `Record<BudgetCategory, ...>`가 비목이 늘 때 컴파일 에러로 알려 주기 때문이다.
 *
 * 여기서 학습한 매핑을 저장하지 않는다 (C.2 주의 3 / D-20) — 산출근거 임포트에는
 * 프로파일이 없다. 새 변형이 나타나면 부록 A.5·C.2를 고치고 이 사전을 고친다.
 */
export const SUBCATEGORY_ALIASES: Record<BudgetCategory, Record<string, string>> = {
  personnel: {},
  student_personnel: {},
  facility_equipment: {},
  material: {},
  consignment: {},
  international: {},
  burden: {},
  activity: {
    '기타': 'activity_etc',              // 행안부 ⑪ (산자부는 '그 밖의 비용')
    '그밖의비용': 'activity_etc',
    '국내출장비': 'activity_travel_dom',
    '국외출장비': 'activity_travel_intl',
    '출장비': 'activity_travel_dom',      // 번호 ⑤가 국내/국외 두 표를 덮는다 — D-3 참조
    '소프트웨어활용비': 'activity_software',
    '클라우드컴퓨팅서비스이용료': 'activity_cloud',
  },
  promotion: {},
  allowance: {},
  indirect: {},
  other: {},
};

/**
 * 세목 헤더의 선행 번호. 원문자(`①`~`⑳`, D-3)와 한글 순서 접두어(`가.`~`차.`)를 뗀다.
 *
 * **normalizeLabel(I-1)은 원문자도 마침표도 지우지 않는다** — 번호를 떼는 것은 이 함수의 몫이다.
 * 한글 접두어까지 떼는 근거는 D-2다: 파서가 비목 헤더에서 `가.`~`차.`를 떼고 판정하는데,
 * 간접비 섹션 아래의 `가. 인력지원비`는 같은 접두어를 단 **세목**이다. 접두어를 남기면
 * 서식이 접두어를 빼거나 순서를 바꾼 순간(`나. 인력지원비`) 조회가 조용히 빗나간다.
 * 번호는 버리지 않고 D-3이 라벨과 **함께** 검증한다 — 여기서는 조회 키만 만든다.
 */
const SUBCATEGORY_ORDINAL_PREFIX = /^\s*(?:[①-⑳]|[가나다라마바사아자차][.．])\s*/;

export function stripSubcategoryOrdinal(label: string): string {
  return label.replace(SUBCATEGORY_ORDINAL_PREFIX, '');
}

/** 세목 라벨 → 조회 키. 선행 번호를 뗀 뒤 I-1 정규화한다 */
export function subcategoryLookupKey(label: string | null | undefined): string {
  if (label === null || label === undefined) return '';
  return normalizeLabel(stripSubcategoryOrdinal(String(label).normalize('NFC')));
}

/**
 * 비목의 세목 조회표 = 부록 A.5 프리셋 라벨 파생 키 ∪ 부록 C.2 별칭.
 * 별칭을 나중에 넣어 실측 변형이 이기게 한다 (현재 두 층의 값은 어긋나지 않으며,
 * 어긋나면 tests/unit/import-detail-constants.test.ts가 잡는다).
 */
export function subcategoryLookupTable(category: BudgetCategory): Record<string, string> {
  const table: Record<string, string> = {};
  for (const def of SUBCATEGORY_PRESETS[category]) {
    const key = subcategoryLookupKey(def.label);
    if (key.length > 0) table[key] = def.code;
  }
  for (const [key, code] of Object.entries(SUBCATEGORY_ALIASES[category])) {
    table[key] = code;
  }
  return table;
}

// ─── 부록 C. 비목 별칭 사전 (초기값) — 공통 + 부처별 프리셋 ──
// 모든 키는 정규화(I-1: 가운뎃점 변형·내부 공백·괄호 내용·각주·별표·하이픈 제거 + 소문자화)된 형태로 비교한다.
// 조회 우선순위 (I-2): ① ImportProfile.categoryAliases(학습분) → ② ministry 부처 프리셋 → ③ 공통 사전.

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
