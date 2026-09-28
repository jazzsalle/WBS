// 성과·기술목표 양식의 `_meta`·거부 타입 (SOT §6.17 GF-1·GF-2).
//
// 좌표 맵 타입은 `layout.ts`에 있다(맵과 같은 곳 — 입력 양식과 같은 배치). 워크북 쓰기 경계는 입력 양식의
// `FormSheet`·`FormCell`을 그대로 쓴다(S-22) — 여기서 새로 정의하지 않는다.

/** `_meta`의 id → 양식에 적은 라벨 한 쌍. 배열 순서가 의미를 가진다(연차는 열 순서) */
export interface GoalMetaLabel {
  id: string;
  label: string;
}

/**
 * `_meta` 본문(GF-1). 파서는 이것만 믿는다 — 연차 열은 `years` 순서로 읽고(GF-2), 기관·관여자·연차
 * 라벨은 이 목록 안에서만 완전 일치로 찾으며(GF-3·GF-4), version은 **내려받은 시점** 값이다(GF-5 충돌·삭제 기준).
 */
export interface GoalFormMeta {
  formVersion: number;
  projectId: string;
  /** ISO 8601 */
  generatedAt: string;
  /** 연차 열 순서 그대로. `yearIds` = `years.map(y => y.id)` (`goalMetaYearIds`) */
  years: GoalMetaLabel[];
  orgs: GoalMetaLabel[];
  members: GoalMetaLabel[];
  /** id → version. 삭제 후보 = 이 키 − 시트의 숨김 id(GF-5) */
  deliverables: Record<string, number>;
  achievements: Record<string, number>;
  techTargets: Record<string, number>;
  records: Record<string, number>;
}

/**
 * `parseGoalMeta` 결과. 형식 → 과제 → 버전 순서로 거부하려면(GF-2) 본문이 깨졌어도 앞의 세 값은
 * 따로 알아야 한다 — 버전이 다른 파일의 본문 형식은 믿을 수 없으므로 본문 판정은 맨 뒤다.
 */
export interface GoalMetaParse {
  /** `form` 행 값. `_meta` 시트나 `form` 행이 없으면 null */
  form: string | null;
  /** 없으면 '' */
  projectId: string;
  /** 없거나 정수가 아니면 null */
  formVersion: number | null;
  /** 본문까지 온전할 때만. 판정은 `checkGoalMeta`가 한다 — 이 값을 직접 믿지 않는다 */
  meta: GoalFormMeta | null;
}

export type GoalFormRejectionKind =
  | 'not-goal-form'
  | 'project-mismatch'
  | 'version-mismatch'
  | 'invalid-meta'
  | 'missing-sheet';

/** 파싱에 들어가기 전에 파일째로 거부하는 이유(GF-2). `missing-sheet`는 파서가 시트를 찾을 때 쓴다 */
export interface GoalFormRejection {
  kind: GoalFormRejectionKind;
  message: string;
}

export type GoalMetaCheck = { ok: true; meta: GoalFormMeta } | { ok: false; rejection: GoalFormRejection };
