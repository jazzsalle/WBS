// SOT 부록 A(A.1~A.4)·부록 C, §6.6 H-3, §8.8의 상수 정의.
// 라벨 맵은 Record<EnumType, string>으로 선언해 enum 값 누락이 컴파일 에러가 되게 한다 (A.4).

import type {
  BudgetCategory,
  DeliverableType,
  Direction,
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
export const EXPECTED_SCHEMA_VERSION = 1;

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
  todo: 'slate-400',
  in_progress: 'blue-500',
  done: 'emerald-500',
  blocked: 'rose-500',
};

// 마감 판정 색상 (§6.5)
export const DUE_COLORS = {
  overdue: 'red-600',
  dueSoon: 'amber-500',
} as const;

export const MILESTONE_TYPE_COLORS: Record<MilestoneType, string> = {
  annual_eval: 'violet-600',
  stage_eval: 'violet-600',
  final_eval: 'violet-600',
  report: 'sky-600',
  progress_check: 'teal-600',
  contract: 'slate-600',
  demo: 'slate-600',
  custom: 'slate-600',
};

// 우선순위 점수(§6.9.2 importance × urgency, 1~25) 구간별 등급·색상. min ≤ score ≤ max
export const PRIORITY_SCORE_COLORS = [
  { min: 15, max: 25, grade: '최우선', color: 'red-600' },
  { min: 8, max: 14, grade: '높음', color: 'amber-500' },
  { min: 4, max: 7, grade: '보통', color: 'slate-500' },
  { min: 1, max: 3, grade: '낮음', color: 'slate-400' },
] as const;

// 리스크 점수(probability × impact, 1~25) 구간별 색상. min ≤ score ≤ max
export const RISK_SCORE_COLORS = [
  { min: 15, max: 25, color: 'red-600' },
  { min: 8, max: 14, color: 'amber-500' },
  { min: 1, max: 7, color: 'emerald-600' },
] as const;

export const ORG_ROLE_COLORS: Record<OrgRole, string> = {
  lead: 'indigo-600',
  joint: 'sky-600',
  consign: 'slate-500',
};

// ─── 부록 A.4 기타 enum 한글 라벨 (14종) ─────────────────────

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
