// SOT §5, §8.7, §9, §14.2의 타입 정의를 그대로 옮긴 파일.
// 파생 값(wbsCode, depth, computedProgress 등)은 저장하지 않으므로 여기에 필드로 두지 않는다.

// §9 Budget Import 액션 반환 형태가 쓰는 lib/import의 순수 타입.
// type-only import라 런타임 의존은 생기지 않는다 (lib/import는 xlsx를 import하지 않는다).
import type {
  AmountUnit,
  CategorySource,
  DetectedStructure,
  MergeRange,
  SheetScore,
} from '@/lib/import';

// ─── §5.2 공통 필드 ───────────────────────────────────────────

export interface BaseEntity {
  id: string;             // crypto.randomUUID()
  createdAt: string;      // ISO 8601
  updatedAt: string;      // ISO 8601
  version: number;        // 낙관적 잠금 (§8.4). BEFORE UPDATE 트리거로 +1
  createdBy: string | null;  // app_users.id
  updatedBy: string | null;  // "OO님이 먼저 수정했습니다" 표시(O-3)와 Realtime self-echo 필터에 사용
}

// ─── §5.3 Project (과제) ─────────────────────────────────────

export type ProjectStatus = 'planning' | 'active' | 'on_hold' | 'done' | 'dropped';

export interface Project extends BaseEntity {
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

// ─── §5.4 Stage (단계) ───────────────────────────────────────

export interface Stage extends BaseEntity {
  projectId: string;
  order: number;            // 0-based. 표시는 order+1 '단계'
  name: string;             // 기본 '1단계'
  goal: string;             // 단계 목표 요약
  startDate: string | null;
  endDate: string | null;
  budget: number | null;    // 단계 연구개발비
}

// ─── §5.5 Year (연차) ────────────────────────────────────────

export type YearStatus = 'planned' | 'active' | 'evaluating' | 'closed';

export interface Year extends BaseEntity {
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

// ─── §5.6 Task (WBS 노드) ────────────────────────────────────

export type TaskStatus = 'todo' | 'in_progress' | 'done' | 'blocked';
export type ProgressMode = 'manual' | 'auto';

export interface Task extends BaseEntity {
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

// ─── §5.7 Milestone ──────────────────────────────────────────

export type MilestoneType =
  | 'annual_eval'      // 연차평가
  | 'stage_eval'       // 단계평가
  | 'final_eval'       // 최종평가
  | 'progress_check'   // 진도점검
  | 'report'           // 보고서 제출 (연차실적계획서, 단계보고서, 최종보고서)
  | 'contract'         // 협약체결 / 협약변경
  | 'demo'             // 시연 / 공인시험
  | 'custom';

export type MilestoneStatus = 'planned' | 'preparing' | 'done' | 'delayed' | 'cancelled';

export interface Milestone extends BaseEntity {
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

// ─── §5.8 Deliverable (정량적 성과목표) ──────────────────────

export type DeliverableType =
  | 'paper_sci' | 'paper_domestic' | 'conference'   // 논문·학회
  | 'patent_dom_apply' | 'patent_dom_reg'           // 국내 특허 출원/등록
  | 'patent_intl_apply' | 'patent_intl_reg'         // 해외 특허 출원/등록
  | 'sw_registration'                               // SW(프로그램) 등록
  | 'tech_transfer'                                 // 기술이전
  | 'commercialization'                             // 사업화
  | 'standard'                                      // 표준화
  | 'hr_training'                                   // 인력양성
  | 'other';

export interface DeliverableAchievement {
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

export interface Deliverable extends BaseEntity {
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

// ─── §5.9 TechTarget (정량적 기술목표) ───────────────────────

export type Direction = 'higher_better' | 'lower_better' | 'target_exact';
export type MeasureMethod = 'self' | 'certified_lab' | 'expert_review' | 'customer' | 'other';

export interface TechTargetRecord {
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

export interface TechTarget extends BaseEntity {
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

// ─── §5.10 Organization (컨소시엄 기관) ──────────────────────

export type OrgRole = 'lead' | 'joint' | 'consign';  // 주관 / 공동 / 위탁

export interface Organization extends BaseEntity {
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

// ─── §5.11 Member (참여인력) ─────────────────────────────────

export type MemberRole = 'pm' | 'pl' | 'researcher' | 'staff';
// pm: 총괄책임자, pl: 세부/기관 책임자, researcher: 참여연구원, staff: 행정/지원

export interface Member extends BaseEntity {
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

// ─── §5.12 BudgetItem (비목별 예산·집행) ─────────────────────

// 국가연구개발혁신법 기준 비목 체계
export type BudgetCategory =
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

export interface BudgetExecution {
  id: string;
  version: number;           // 낙관적 잠금용 — 집행 내역 편집이 일자·금액·적요를 한 번에 바꾸므로 O-1 대상이다 (§5.8·§5.9와 같은 이유)
  date: string;              // 집행일
  amount: number;            // 집행액 (원). 0 이상 정수만 — 실무에서 집행액을 음수로 잡는 경우가 없다(사용자 확인).
                             // 환불·감액은 별도 행이 아니라 원래 집행 행을 수정한다.
  description: string;       // 적요
  note: string;
}

export interface BudgetItem extends BaseEntity {
  projectId: string;
  yearId: string;                    // 연차 × 비목이 유일 키
  category: BudgetCategory;
  plannedAmount: number;             // 계획(예산)액 = 현금 + 현물
  cashAmount: number | null;         // 그중 현금
  inKindAmount: number | null;       // 그중 현물
  executions: BudgetExecution[];     // 집행 내역 (수동 입력)
  note: string;
}

// ─── §5.12.1 ImportProfile (엑셀 매핑 프로파일 = 부처 템플릿) ─

export type ImportKind = 'budget_plan';   // v1은 예산계획만. 집행내역 임포트는 v2 후보 (§13)

export interface ImportProfile extends BaseEntity {
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

// ─── §5.12.2 ImportDraft (마법사 진행 상태 — 저장하지 않는 일회성 타입) ─

export interface ImportDraft {
  profile: Omit<ImportProfile, keyof BaseEntity | 'lastUsedAt' | 'useCount'>;

  // 이번 실행에서만 유효한 결정들 (프로파일에 저장하지 않는다)
  // **엑셀 열 문자**(대문자, 예: 'F') → yearId. 헤더 텍스트가 아니다 — 헤더는 비거나 중복될 수
  // 있고, ImportProfile.yearColumnMappings도 열 문자를 키로 쓰므로 이것만이 두 구조를
  // 어긋남 없이 잇는다. 미대응 열이 있으면 반영 불가 (S-5)
  yearMapping: Record<string, string>;
  skippedRowIndexes: number[];                // 사용자가 "이 행 건너뛰기"로 지정한 행 (0-based)
  manualCategoryByRow: Record<number, BudgetCategory>; // 행별 수동 지정 (I-4). I-6 모호 별칭의 선택 포함
  fileHash: string;                           // 업로드 파일 sha256. previewImport가 계산·반환하고
                                              // commitImport가 대조한다 — 다른 파일이 반영되는 것을 차단
}

// ─── I-17 ImportSnapshot (임포트 반영 전 계획액 스냅샷) ──────

// commit_import RPC가 반영과 **같은 트랜잭션**에서 기록한다. 설정 화면(§7.14)에서
// 확인·복원하며 과제별 최근 20개만 남는다.
// jsonb 내부 키는 매퍼가 변환하지 않으므로(N-3) DB에도 이 camelCase 그대로 들어간다.
export interface ImportSnapshotItem {
  yearId: string;
  category: BudgetCategory;
  plannedAmount: number;             // 반영 직전 계획액
  cashAmount: number | null;
  inKindAmount: number | null;
  existed: boolean;                  // 반영 전에 이 (연차, 비목) 행이 있었는지.
                                     // false면 복원은 0/null/null로 되돌린다(행을 지우지 않는다)
}

export interface ImportSnapshotSource {
  fileName: string;
  sheetName: string;
  profileId: string | null;          // 사용한 ImportProfile. 프로파일 없이 반영했으면 null
  fileHash: string;                  // ImportDraft.fileHash — 어떤 파일이 반영됐는지 추적용
}

export interface ImportSnapshotPayload {
  schemaVersion: number;             // 스냅샷 jsonb 자체의 형식 버전 (RPC가 채운다)
  projectId: string;
  capturedAt: string;
  source: ImportSnapshotSource;
  items: ImportSnapshotItem[];       // 파일에 등장한 (연차, 비목)만 담긴다 (S-9)
}

export interface ImportSnapshot extends BaseEntity {
  projectId: string;
  snapshot: ImportSnapshotPayload;
}

// ─── §7.9.1 Step 5 / §9 previewImport 반환 형태 ──────────────

/** §7.9.1 Step 5 행 상태. 라벨은 부록 A와 같은 방식으로 lib/import가 붙인다 */
export type PreviewRowStatus = 'new' | 'overwrite' | 'skipped' | 'error';

/** 미리보기 행에 기여한 원본 시트 행 하나 (§7.9.1 Step 4) */
export interface PreviewSourceRow {
  /** 0-based 시트 행 인덱스 */
  rowIndex: number;
  /** 비목을 확정한 원본 라벨 */
  label: string | null;
  categorySource: CategorySource | null;
}

export interface PreviewRow {
  status: PreviewRowStatus;
  /** 화면 표기 (신규 / 덮어씀 / 건너뜀 / 오류) */
  statusLabel: string;
  /** 반영 대상 행이면 채워진다 */
  yearId: string | null;
  yearOrder: number | null;
  category: BudgetCategory | null;
  /** 원 단위 정수. 반영 대상이 아니면 null */
  plannedAmount: number | null;
  cashAmount: number | null;
  inKindAmount: number | null;
  /** 덮어쓸 기존 값 (`기존 → 신규` 표시용). 신규면 null */
  existing: {
    plannedAmount: number;
    cashAmount: number | null;
    inKindAmount: number | null;
  } | null;
  /** 이 행을 만든 원본 시트 행들 (S-8 합산이면 여러 개, 0-based) */
  sourceRowIndexes: number[];
  /** 건너뜀·오류 사유 */
  reason: string | null;
  /**
   * 원본 라벨. 매핑 행도 채운다 — S-8로 합쳐진 행은 기여 라벨을 ` · `로 잇는다.
   * 마법사 Step 4의 "원본 비목명" 열이 이 값을 그대로 쓴다.
   */
  label: string | null;
  /**
   * 비목 판정 근거 (§7.9.1 Step 4의 ✅ 완전일치 / 🔵 별칭사전 아이콘 근거).
   * S-8로 근거가 섞이면 **가장 확인이 필요한 것**이 대표로 온다 — 완전일치 하나가 섞였다고
   * ✅로 보여 주면 같은 셀에 합산된 별칭·승계 행을 사용자가 확인 없이 지나친다.
   * UI가 classifyLabel을 다시 돌려 판정을 복제하지 않게 하려고 서버가 실어 보낸다 (O-4).
   */
  categorySource: CategorySource | null;
  /**
   * 이 행에 기여한 **원본 시트 행별** 라벨·판정 근거 (S-8 합산이면 여러 개, 행 번호 오름차순).
   * 마법사 Step 4가 원본 행 단위로 드롭다운·건너뛰기를 달 때 쓴다.
   */
  sourceRows: PreviewSourceRow[];
  /** I-11 반올림이 섞여 있는가 */
  rounded: boolean;
}

/** S-9: 파일에 등장하지 않아 그대로 유지되는 (연차, 비목) */
export interface UntouchedCategory {
  yearId: string;
  yearOrder: number | null;
  category: BudgetCategory;
  plannedAmount: number;
}

/** §9 previewImport의 summary */
export interface ImportSummary {
  new: number;
  overwrite: number;
  skipped: number;
  /** 건너뛴 행들의 금액 합 (원) */
  skippedAmount: number;
  error: number;
  /** 반영될 계획액 합 (원) */
  totalAmount: number;
  untouchedCategories: UntouchedCategory[];
}

export interface ImportPreview {
  rows: PreviewRow[];
  summary: ImportSummary;
  /** §7.9.1: 오류가 1건이라도 있으면 반영 불가 */
  blocked: boolean;
  /** S-5: yearId에 대응되지 않은 연차 열의 order. 남아 있으면 반영 불가 */
  unmappedYearOrders: number[];
}

// ─── §9 Budget Import 액션의 반환 형태 (마법사 §7.9.1이 쓴다) ─
//
// 'use server' 파일은 export가 전부 async 함수여야 해서 액션 파일에 타입을 둘 수 없다.
// 구조 감지 결과는 lib/import의 순수 함수가 만든 형태를 그대로 내린다 — 여기서 다시 정의하면
// 감지 규칙(S-5·I-10)이 두 곳에 생겨 반드시 어긋난다.

export type { AmountUnit, DetectedStructure, MergeRange, SheetScore };

/** §7.9.1 Step 2: 시트 탭 + 원본 미리보기 그리드 */
export interface SheetGridPreview {
  sheetName: string;
  /** 상위 N행의 **원본**(병합 확장 전) 텍스트. 에러 셀은 원문(`#REF!`)이 그대로 들어온다 */
  rows: { text: string; isError: boolean }[][];
  /** 화면이 실제 서식대로 병합을 그리도록 함께 내린다 (표시 범위에 걸치는 것만) */
  merges: MergeRange[];
  totalRows: number;
  totalColumns: number;
  truncated: boolean;
}

/** §7.9.1 Step 2 시트 탭 — S-13 추천 점수를 함께 내려 하이라이트 근거를 보여준다 */
export interface WorkbookSheetInfo extends SheetScore {
  rowCount: number;
  columnCount: number;
}

/** §9 inspectWorkbook */
export interface InspectWorkbookResult {
  fileName: string;
  fileSize: number;
  fileHash: string;
  sheets: WorkbookSheetInfo[];
  /** S-13 추천. **하이라이트일 뿐이고 확정은 사용자가 한다** */
  recommendedSheet: string | null;
  grids: SheetGridPreview[];
  /** 추천 시트의 구조 추정. 시트가 없으면 null */
  structure: DetectedStructure | null;
}

/** §9 analyzeSheet의 hints — 사용자가 Step 2·3에서 고친 값. 주면 추정보다 우선한다 */
export interface AnalyzeSheetHints {
  headerRow?: number | null;
  dataStartRow?: number | null;
  dataEndRow?: number | null;
  labelColumns?: string[] | null;
  amountUnit?: AmountUnit | null;
  /** I-2 ②: 부처 프리셋 키 */
  ministry?: string | null;
  /** I-2 ①: 프로파일에 학습된 별칭 */
  categoryAliases?: Record<string, BudgetCategory> | null;
  /** I-5: 비우면 공통 SKIP_ROW_PATTERNS를 쓴다 */
  skipRowPatterns?: string[] | null;
}

/** §7.9.1 Step 3 좌측 목록 — 열 문자 + 헤더 텍스트 + 샘플값 3개 */
export interface SheetColumnInfo {
  column: string;
  columnIndex: number;
  headerText: string;
  samples: string[];
}

/** §9 analyzeSheet */
export interface AnalyzeSheetResult {
  fileHash: string;
  structure: DetectedStructure;
  columns: SheetColumnInfo[];
  grid: SheetGridPreview;
}

/** §9 previewImport → { rows, summary, fileHash } + 마법사가 쓰는 부가 정보 */
export interface PreviewImportResult extends ImportPreview {
  fileHash: string;
  fileName: string;
  sheetName: string;
  /**
   * I-7 학습 후보 — 사용자가 수동 지정한 (원본 라벨 → 비목).
   * 프로파일 저장 시 `categoryAliases`에 병합한다. **I-6 모호 별칭의 선택은 담기지 않는다**
   * (§7.9.1 Step 4).
   */
  learnedAliases: Record<string, BudgetCategory>;
}

/** §9 commitImport */
export interface CommitImportResult {
  /** I-17 반영 직전 계획액 스냅샷 */
  snapshotId: string;
  /** 실제로 쓴 (연차, 비목) 셀 수 */
  updated: number;
  summary: ImportSummary;
  /**
   * 프로파일 사용 이력(`lastUsedAt`/`useCount`) 갱신 성공 여부.
   * 반영은 이미 커밋되어 되돌릴 수 없으므로 이 갱신 실패로 전체를 실패시키지 않는다 —
   * 대신 조용히 삼키지 않고 여기에 드러낸다 (절대 규칙 5).
   */
  profileUsageRecorded: boolean;
}

// ─── §5.13 Risk (리스크 관리대장) ────────────────────────────

export type RiskCategory = 'technical' | 'schedule' | 'budget' | 'resource' | 'external' | 'other';
export type RiskLevel = 1 | 2 | 3 | 4 | 5;
export type RiskStrategy = 'mitigate' | 'avoid' | 'transfer' | 'accept';
export type RiskStatus = 'identified' | 'monitoring' | 'occurred' | 'resolved' | 'closed';

export interface Risk extends BaseEntity {
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

// ─── §5.14 Note (마크다운 메모) ──────────────────────────────

export type NoteType = 'meeting' | 'tech' | 'issue' | 'idea' | 'report_draft' | 'other';

export interface Note extends BaseEntity {
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

// ─── §5.15 Todo ──────────────────────────────────────────────

export type Priority = 'low' | 'normal' | 'high';

export interface Todo extends BaseEntity {
  title: string;
  done: boolean;
  projectId: string | null;
  dueDate: string | null;
  priority: Priority;
  order: number;
  completedAt: string | null;
}

// ─── §5.16 Settings ──────────────────────────────────────────

// 팀 공유 설정 — app_settings 테이블 (단일 행)
export interface Settings {
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
export interface LocalConfig {
  backupFolder: string | null;      // §8.7 자동 내보내기 대상 폴더
  lastBackupAt: string | null;
  lastOpenedProjectId: string | null;
  ganttScale: 'day' | 'week' | 'month';   // 개인 화면 취향
}

// ─── §14.2 AppUser ───────────────────────────────────────────

export interface AppUser {
  id: string;          // auth.users.id 와 동일 (FK)
  email: string;
  name: string;        // 표시 이름
  memberId: string | null;  // 과제 참여인력(Member)과 연결. 선택
  active: boolean;     // false면 로그인은 되지만 데이터 접근 차단
  createdAt: string;
  updatedAt: string;
  lastSeenAt: string;  // SA-1에서 하루 1회 갱신
}

// ─── §8.7 BackupFile (K-5 내보내기 JSON 형식) ────────────────

// 행은 DB snake_case 원본 그대로 담는다 (매퍼 버그로부터 독립)
export interface BackupFile {
  schemaVersion: number;              // app_settings.schema_version
  exportedAt: string;                 // ISO 8601
  exportedBy: { id: string; email: string };
  tables: Record<string, unknown[]>;  // 테이블명(snake_case) → 행 배열
}

// ─── §9 서버 액션 반환 타입 ──────────────────────────────────

// VALIDATION = Zod 검증 실패, CONFLICT = 유니크 제약 충돌, RULE = 비즈니스 규칙 위반
export type ActionResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: string; code?: 'STALE' | 'AUTH' | 'OFFLINE' | 'VALIDATION' | 'CONFLICT' | 'RULE' };
