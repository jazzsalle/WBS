// 도움말 레지스트리·순수 함수 (SOT §7.16 HP-1·HP-4·HP-6)

import { describe, expect, it } from 'vitest';
import {
  HELP_RELATED,
  HELP_SCREEN_SLUGS,
  HELP_SLUGS,
  HELP_TITLES,
  HELP_TOC_GROUPS,
  TUTORIAL_STEP_SLUGS,
  helpSlugForPath,
  isHelpSlug,
  parseHelpHead,
  parseTutorialHead,
} from '@/lib/help';

describe('HELP_SLUGS (HP-1)', () => {
  it('화면 15 + calculations + faq = 17편, §7.1 화면 순', () => {
    expect(HELP_SLUGS).toEqual([
      'dashboard', 'projects', 'project', 'wbs', 'gantt', 'board', 'goals', 'milestones',
      'budget', 'budget-rules', 'team', 'risks', 'notes', 'todos', 'settings',
      'calculations', 'faq',
    ]);
    expect(HELP_SCREEN_SLUGS).toHaveLength(15);
    expect(new Set(HELP_SLUGS).size).toBe(17);
  });

  it('목차 그룹은 17편을 빠짐없이 한 번씩 담는다', () => {
    const inToc = HELP_TOC_GROUPS.flatMap((g) => g.slugs);
    expect([...inToc].sort()).toEqual([...HELP_SLUGS].sort());
    expect(HELP_TOC_GROUPS.map((g) => g.label)).toEqual(['화면', '계산 방식', '자주 묻는 것']);
  });

  it('제목·관련 도움말은 등록된 slug만 가리킨다', () => {
    for (const slug of HELP_SLUGS) expect(HELP_TITLES[slug]).toBeTruthy();
    for (const [from, to] of Object.entries(HELP_RELATED)) {
      expect(isHelpSlug(from)).toBe(true);
      for (const slug of to) {
        expect(isHelpSlug(slug)).toBe(true);
        expect(slug).not.toBe(from);
      }
    }
    // 계산이 있는 화면은 계산 방식으로, 연구비 ↔ 규칙은 서로
    for (const slug of ['wbs', 'goals', 'budget', 'budget-rules', 'milestones', 'dashboard'] as const) {
      expect(HELP_RELATED[slug]).toContain('calculations');
    }
    expect(HELP_RELATED.budget).toContain('budget-rules');
    expect(HELP_RELATED['budget-rules']).toContain('budget');
    expect(HELP_RELATED.team).toContain('budget');
    expect(HELP_RELATED.settings).toContain('faq');
  });

  it('따라하기 단계 파일 9개, TU-2 순서', () => {
    expect(TUTORIAL_STEP_SLUGS).toEqual([
      'project', 'years', 'team', 'wbs', 'goals', 'milestones', 'budget', 'export', 'backup',
    ]);
  });
});

describe('helpSlugForPath (HP-4 탭별 slug)', () => {
  const id = '0b7f1d2e-1111-4222-8333-444455556666';

  it.each([
    ['/', 'dashboard'],
    ['/projects', 'projects'],
    ['/projects/', 'projects'],
    [`/projects/${id}`, 'project'],
    [`/projects/${id}/wbs`, 'wbs'],
    [`/projects/${id}/gantt`, 'gantt'],
    [`/projects/${id}/board`, 'board'],
    [`/projects/${id}/goals`, 'goals'],
    [`/projects/${id}/milestones`, 'milestones'],
    [`/projects/${id}/budget`, 'budget'],
    [`/projects/${id}/team`, 'team'],
    [`/projects/${id}/risks`, 'risks'],
    [`/projects/${id}/notes`, 'notes'],
    ['/todos', 'todos'],
    ['/settings', 'settings'],
  ] as const)('%s → %s', (pathname, slug) => {
    expect(helpSlugForPath(pathname)).toBe(slug);
  });

  it.each([
    '/help',
    '/login',
    '/pending',
    '/unknown',
    `/projects/${id}/unknown`,
    `/projects/${id}/budget-rules`, // 경로가 없는 slug — 연구비 탭 안의 패널이다
    `/projects/${id}/faq`, // slug이긴 하지만 과제 탭이 아니다
    `/projects/${id}/wbs/extra`,
    '/todos/1',
    '/settings/x',
  ])('%s → null', (pathname) => {
    expect(helpSlugForPath(pathname)).toBeNull();
  });

  it('쿼리·해시는 무시한다', () => {
    expect(helpSlugForPath(`/projects/${id}/wbs?year=2`)).toBe('wbs');
    expect(helpSlugForPath('/todos#top')).toBe('todos');
  });
});

describe('parseHelpHead (HP-6)', () => {
  it('1행 `# 제목`, 2행 `> 언제 쓰나:` 를 읽는다 (CRLF·BOM 허용)', () => {
    expect(parseHelpHead('# WBS\n> 언제 쓰나: 작업을 쌓을 때\n\n## 할 수 있는 것')).toEqual({
      title: 'WBS',
      intro: '작업을 쌓을 때',
    });
    expect(parseHelpHead('﻿# WBS\r\n> 언제 쓰나:  작업을 쌓을 때 \r\n')).toEqual({
      title: 'WBS',
      intro: '작업을 쌓을 때',
    });
  });

  it('1행이 제목이 아니면 위반', () => {
    const result = parseHelpHead('WBS\n> 언제 쓰나: 작업');
    expect(result).toHaveProperty('error');
    expect((result as { error: string }).error).toContain('1행');
  });

  it('2행 라벨이 다르면 위반 (할 일: 은 따라하기 형식)', () => {
    const result = parseHelpHead('# WBS\n> 할 일: 작업');
    expect(result).toHaveProperty('error');
    expect((result as { error: string }).error).toContain('2행');
  });

  it('2행이 비어 있거나 제목·intro 본문이 비면 위반', () => {
    expect(parseHelpHead('# WBS\n\n> 언제 쓰나: 작업')).toHaveProperty('error');
    expect(parseHelpHead('# WBS\n> 언제 쓰나:')).toHaveProperty('error');
    expect(parseHelpHead('#\n> 언제 쓰나: 작업')).toHaveProperty('error');
    expect(parseHelpHead('')).toHaveProperty('error');
  });

  it('parseTutorialHead는 `> 할 일:` 라벨을 요구한다 (TU-7)', () => {
    expect(parseTutorialHead('# 과제 만들기\n> 할 일: 과제를 하나 만든다')).toEqual({
      title: '과제 만들기',
      intro: '과제를 하나 만든다',
    });
    expect(parseTutorialHead('# 과제 만들기\n> 언제 쓰나: x')).toHaveProperty('error');
  });
});
