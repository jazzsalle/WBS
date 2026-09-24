// 도움말 레지스트리 + 순수 함수 (SOT §7.16 HP-1·HP-4·HP-6, §7.17 TU-7)
//
// 본문(content/help/*.md)은 서버가 fs로 읽는다(lib/content.ts). 여기는 fs·DB를 모르는
// 순수 레지스트리다 — 화면 `?`(HelpLink)와 도움말 페이지 목차·관련 링크가 같은 목록을 본다.
// 상대 링크는 본문에 쓰지 않는다(lib/notes.ts가 링크로 만들지 않음, HP-6) — "관련 도움말"은
// HELP_RELATED로 페이지가 그린다.

import type { TutorialStepId } from '@/types';
import { TUTORIAL_STEP_IDS } from './local-config';

// ─── slug 목록 (HP-1) — 순서 = §7.1 화면 순 + 계산 방식 + 자주 묻는 것 ──────────

export const HELP_SLUGS = [
  'dashboard',
  'projects',
  'project',
  'wbs',
  'gantt',
  'board',
  'goals',
  'milestones',
  'budget',
  'budget-rules',
  'team',
  'risks',
  'notes',
  'todos',
  'settings',
  'calculations',
  'faq',
] as const;

export type HelpSlug = (typeof HELP_SLUGS)[number];

/** 화면 키 15개 — `## 할 수 있는 것`·`## 자주 하는 실수`가 필수인 편(HP-6) */
export const HELP_SCREEN_SLUGS: readonly HelpSlug[] = HELP_SLUGS.filter(
  (slug) => slug !== 'calculations' && slug !== 'faq'
);

export function isHelpSlug(value: unknown): value is HelpSlug {
  return typeof value === 'string' && (HELP_SLUGS as readonly string[]).includes(value);
}

/** 목차·`?` 버튼에 보이는 이름. 본문 1행 `# 제목`과 별개로 페이지가 파일을 못 읽어도 목차는 그려야 한다 */
export const HELP_TITLES: Record<HelpSlug, string> = {
  dashboard: '대시보드',
  projects: '과제 목록',
  project: '과제 개요',
  wbs: 'WBS',
  gantt: '간트 차트',
  board: '칸반 보드',
  goals: '목표 관리',
  milestones: '마일스톤',
  budget: '연구비',
  'budget-rules': '연구비 규칙', // content/help/budget-rules.md 1행과 같게
  team: '인력·기관',
  risks: '리스크 관리대장',
  notes: '노트',
  todos: 'To-Do',
  settings: '설정',
  calculations: '계산 방식',
  faq: '자주 묻는 것',
};

// ─── 목차 그룹 (HP-4 좌측 목차) ───────────────────────────────────────────────

export interface HelpTocGroup {
  label: string;
  slugs: readonly HelpSlug[];
}

export const HELP_TOC_GROUPS: readonly HelpTocGroup[] = [
  { label: '화면', slugs: HELP_SCREEN_SLUGS },
  { label: '계산 방식', slugs: ['calculations'] },
  { label: '자주 묻는 것', slugs: ['faq'] },
];

// ─── 관련 도움말 (HP-6 — 본문 대신 페이지가 링크를 그린다) ────────────────────

export const HELP_RELATED: Partial<Record<HelpSlug, HelpSlug[]>> = {
  dashboard: ['calculations'],
  wbs: ['calculations'],
  goals: ['calculations'],
  milestones: ['calculations'],
  budget: ['budget-rules', 'calculations'],
  'budget-rules': ['budget', 'calculations'],
  team: ['budget'],
  settings: ['faq'],
};

// ─── 경로 → slug (HP-4 탭별 slug) ─────────────────────────────────────────────

/** `/projects/[id]/<seg>` 중 도움말이 따로 있는 탭. budget-rules는 연구비 탭 안의 패널이라 경로가 없다 */
const PROJECT_TAB_SLUGS: readonly HelpSlug[] = [
  'wbs',
  'gantt',
  'board',
  'goals',
  'milestones',
  'budget',
  'team',
  'risks',
  'notes',
];

/**
 * 현재 경로에 맞는 도움말 slug. 도움말이 없는 경로(`/help`·`/login`·모르는 경로)는 null —
 * 호출부가 기본값을 정한다(ProjectHelpLink는 `project`).
 */
export function helpSlugForPath(pathname: string): HelpSlug | null {
  const segments = pathname.split('?')[0]?.split('#')[0]?.split('/').filter((s) => s !== '') ?? [];

  if (segments.length === 0) return 'dashboard';
  const [head, , tab] = segments;

  if (head === 'projects') {
    if (segments.length === 1) return 'projects';
    if (segments.length === 2) return 'project';
    if (segments.length === 3 && isHelpSlug(tab) && PROJECT_TAB_SLUGS.includes(tab)) return tab;
    return null;
  }
  if (segments.length === 1) {
    if (head === 'todos') return 'todos';
    if (head === 'settings') return 'settings';
  }
  return null;
}

// ─── 본문 머리 형식 (HP-6 · TU-7) ─────────────────────────────────────────────

export interface DocumentHead {
  title: string;
  intro: string;
}

export type DocumentHeadResult = DocumentHead | { error: string };

/**
 * 1행 `# <제목>`, 2행 `> <라벨>: <한 문장>`을 검사한다. 형식 위반은 사유를 돌려준다 —
 * 서버 로더가 이 사유로 throw하므로 빈 제목이 조용히 화면에 나가지 않는다(절대 규칙 5).
 */
export function parseDocumentHead(source: string, label: string): DocumentHeadResult {
  // Windows 편집기가 붙이는 BOM·CRLF는 형식 위반이 아니다
  const lines = source.replace(/^﻿/, '').replace(/\r\n?/g, '\n').split('\n');
  const first = lines[0] ?? '';
  const second = lines[1] ?? '';

  const title = /^#\s+(.+?)\s*$/.exec(first)?.[1];
  if (title === undefined) {
    return { error: `1행은 '# <제목>'이어야 합니다 (현재: "${first}")` };
  }
  const intro = new RegExp(`^>\\s*${label}\\s*:\\s*(.+?)\\s*$`).exec(second)?.[1];
  if (intro === undefined) {
    return { error: `2행은 '> ${label}: <한 문장>'이어야 합니다 (현재: "${second}")` };
  }
  return { title, intro };
}

/** 도움말: 1행 `# <화면 이름>`, 2행 `> 언제 쓰나: …` (HP-6) */
export function parseHelpHead(source: string): DocumentHeadResult {
  return parseDocumentHead(source, '언제 쓰나');
}

/** 따라하기: 1행 `# <단계명>`, 2행 `> 할 일: …` (TU-7) */
export function parseTutorialHead(source: string): DocumentHeadResult {
  return parseDocumentHead(source, '할 일');
}

// ─── 따라하기 본문 파일 (TU-7) ────────────────────────────────────────────────

/**
 * content/tutorial/<step>.md의 파일 이름 = TutorialStepId(§5.16 `TUTORIAL_STEP_IDS`) 그대로.
 * 정의는 lib/local-config.ts 한 곳뿐이다 — 여기서 따로 나열하면 단계 id를 바꿀 때 파일 이름과
 * 조용히 어긋난다. 단계 레지스트리(screenPath·helpSlug)는 lib/tutorial.ts의 몫이고, 여기는
 * 로더가 파일 이름을 검증하는 데만 쓴다.
 */
export const TUTORIAL_STEP_SLUGS = TUTORIAL_STEP_IDS;

export type TutorialStepSlug = TutorialStepId;

export function isTutorialStepSlug(value: unknown): value is TutorialStepSlug {
  return typeof value === 'string' && (TUTORIAL_STEP_SLUGS as readonly string[]).includes(value);
}
