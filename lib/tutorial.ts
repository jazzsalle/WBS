// 따라하기 레지스트리 (SOT §7.17 TU-2·TU-4·TU-7, §5.16)
// 순수 모듈 — fetch·supabase·next 무의존. 단계 정의·화면 경로·완료 판정 합성만 담당한다.
//
// 본문(`content/tutorial/<step>.md`)에는 링크를 쓰지 않는다(TU-7 — `lib/notes.ts`가 상대 URL을
// 링크로 만들지 않는 노트 보안 경계를 완화하지 않기 위해). `[이 화면으로]`·"자세히 → 도움말"은
// 여기의 `screenPath`·`helpSlug`로 UI가 그린다.

import type { LocalConfig, TutorialStepId } from '@/types';
import { TUTORIAL_STEP_IDS } from './local-config';

/** 자동 감지 단계(TU-4 ①~⑦). export·backup은 DB에 흔적이 없어 수동 체크다 */
export type AutoStepId = Exclude<TutorialStepId, 'export' | 'backup'>;

export interface TutorialStep {
  id: TutorialStepId;
  order: number;
  title: string;
  /** "자세히 → 도움말" 대상 slug (§7.16). UI가 `/help#<slug>`로 그린다 */
  helpSlug: string;
  /** `[이 화면으로]` 경로. 과제가 필요한 단계는 projectId 없이는 null */
  screenPath: (projectId: string | null) => string | null;
  detection: 'auto' | 'manual';
}

const withProject = (suffix: string) => (projectId: string | null) =>
  projectId === null ? null : `/projects/${projectId}${suffix}`;

// 순서·id는 §5.16 `TUTORIAL_STEP_IDS`가 원본이다. 여기서는 단계별 속성만 정의하고
// 배열은 그 순서로 조립한다 — 두 목록이 따로 살면 언젠가 어긋난다
const STEP_DEFS: Record<TutorialStepId, Omit<TutorialStep, 'id' | 'order'>> = {
  project: { title: '과제 만들기', helpSlug: 'projects', screenPath: () => '/projects', detection: 'auto' },
  years: { title: '단계·연차 확인', helpSlug: 'project', screenPath: withProject(''), detection: 'auto' },
  team: { title: '인력·기관 등록', helpSlug: 'team', screenPath: withProject('/team'), detection: 'auto' },
  wbs: { title: 'WBS 작업 쌓기', helpSlug: 'wbs', screenPath: withProject('/wbs'), detection: 'auto' },
  goals: { title: '성과·기술목표', helpSlug: 'goals', screenPath: withProject('/goals'), detection: 'auto' },
  milestones: { title: '마일스톤 자동 생성', helpSlug: 'milestones', screenPath: withProject('/milestones'), detection: 'auto' },
  budget: { title: '연구비 제안 모드 — 산출근거 + 규칙', helpSlug: 'budget', screenPath: withProject('/budget'), detection: 'auto' },
  export: { title: '제출 서식 내보내기', helpSlug: 'budget', screenPath: withProject('/budget'), detection: 'manual' },
  // 백업은 설정 화면이라 과제가 없어도 갈 수 있다
  backup: { title: '백업 폴더 지정·지금 내보내기', helpSlug: 'settings', screenPath: () => '/settings', detection: 'manual' },
};

/** TU-2 9단계, §5.16 순서 */
export const TUTORIAL_STEPS: readonly TutorialStep[] = TUTORIAL_STEP_IDS.map((id, i) => ({
  id,
  order: i + 1,
  ...STEP_DEFS[id],
}));

export const AUTO_STEP_IDS: readonly AutoStepId[] = TUTORIAL_STEPS.filter(
  (s): s is TutorialStep & { id: AutoStepId } => s.detection === 'auto'
).map((s) => s.id);

// ─── 현재 화면 → 단계 (TU-2 "현재 화면에 해당하는 단계를 자동으로 펼친다") ───

const PROJECT_SUB_STEPS: Readonly<Record<string, TutorialStepId>> = {
  team: 'team',
  wbs: 'wbs',
  goals: 'goals',
  milestones: 'milestones',
  budget: 'budget',
};

/**
 * 경로가 어느 단계의 화면인지. 대응하는 단계가 없는 화면(대시보드·간트·보드 등)은 null —
 * 그 경우 UI는 아무 단계도 자동으로 펼치지 않는다.
 */
export function stepForPath(pathname: string): TutorialStepId | null {
  const trimmed = pathname.replace(/\/+$/, '') || '/';
  if (trimmed === '/settings') return 'backup';
  if (trimmed === '/projects') return 'project';

  const segments = trimmed.split('/').filter((s) => s !== '');
  if (segments[0] !== 'projects' || segments.length < 2) return null;
  if (segments.length === 2) return 'years';
  if (segments.length === 3) return PROJECT_SUB_STEPS[segments[2] as string] ?? null;
  return null;
}

// ─── 완료 판정 합성 (TU-4) ──────────────────────────────────────

export interface TutorialServerStatus {
  projectExists: boolean;
  steps: Record<AutoStepId, boolean>;
}

/**
 * 서버 판정(auto 7) + 로컬 수동 체크(export·backup) + 백업 시각을 한 벌로 합친다.
 * - auto 단계는 서버 값만 본다. `manualDone`에 auto id가 섞여 있어도 무시한다 — 데이터가 근거다
 * - export는 `manualDone`뿐이다. 내보내기는 DB를 바꾸지 않아(X-11) 감지할 길이 없다
 * - backup은 `manualDone` 또는 `lastBackupAt`(이 PC의 마지막 백업 시각, §5.16) 중 하나면 완료
 */
export function mergeStepStatus(
  server: TutorialServerStatus | null,
  tutorial: LocalConfig['tutorial'],
  lastBackupAt: string | null
): Record<TutorialStepId, boolean> {
  const manual = new Set<TutorialStepId>(tutorial.manualDone);
  const result = {} as Record<TutorialStepId, boolean>;
  for (const step of TUTORIAL_STEPS) {
    if (step.detection === 'auto') {
      result[step.id] = server !== null && server.steps[step.id as AutoStepId] === true;
    } else if (step.id === 'backup') {
      result[step.id] = manual.has('backup') || lastBackupAt !== null;
    } else {
      result[step.id] = manual.has(step.id);
    }
  }
  return result;
}

// ─── 예제 과제 표식 (TU-3) ──────────────────────────────────────

export const SAMPLE_PROJECT_PREFIX = '[예제] ';
export const SAMPLE_DESCRIPTION_FIRST_LINE = '따라하기 예제 — 지워도 됩니다';

/** 과제 목록 카드의 `예제` 배지·[과제 삭제]의 "지워도 됩니다" 안내가 이 판정을 쓴다 */
export function isSampleProject(p: { name: string }): boolean {
  return p.name.startsWith(SAMPLE_PROJECT_PREFIX);
}
