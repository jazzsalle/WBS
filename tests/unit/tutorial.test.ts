// 따라하기 레지스트리·본문 형식 테스트 (SOT §7.17 TU-2·TU-4·TU-7, §5.16)
// 9단계 순서가 §5.16과 같은지, 화면 경로·완료 판정 합성이 규칙대로인지,
// 본문 9편이 고정 형식(TU-7)을 지키고 링크·표를 쓰지 않는지 고정한다.

import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { TUTORIAL_STEP_IDS } from '@/lib/local-config';
import {
  AUTO_STEP_IDS,
  SAMPLE_DESCRIPTION_FIRST_LINE,
  SAMPLE_PROJECT_PREFIX,
  TUTORIAL_STEPS,
  isSampleProject,
  mergeStepStatus,
  stepForPath,
  type AutoStepId,
  type TutorialServerStatus,
} from '@/lib/tutorial';
import type { LocalConfig, TutorialStepId } from '@/types';

const PID = '11111111-1111-4111-8111-111111111111';
const CONTENT_DIR = path.resolve(__dirname, '../../content/tutorial');

const emptyTutorial = (): LocalConfig['tutorial'] => ({
  sampleProjectId: null,
  manualDone: [],
  dismissed: false,
});

const serverAll = (value: boolean): TutorialServerStatus => ({
  projectExists: value,
  steps: Object.fromEntries(AUTO_STEP_IDS.map((id) => [id, value])) as Record<AutoStepId, boolean>,
});

describe('TUTORIAL_STEPS (TU-2)', () => {
  it('9단계, id 순서 = TUTORIAL_STEP_IDS(§5.16), order는 1부터 연속', () => {
    expect(TUTORIAL_STEPS).toHaveLength(9);
    expect(TUTORIAL_STEPS.map((s) => s.id)).toEqual([...TUTORIAL_STEP_IDS]);
    expect(TUTORIAL_STEPS.map((s) => s.order)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });

  it('detection: export·backup만 manual, AUTO_STEP_IDS는 앞 7개', () => {
    const manual = TUTORIAL_STEPS.filter((s) => s.detection === 'manual').map((s) => s.id);
    expect(manual).toEqual(['export', 'backup']);
    expect(AUTO_STEP_IDS).toEqual(['project', 'years', 'team', 'wbs', 'goals', 'milestones', 'budget']);
  });

  it('helpSlug 매핑(TU-7)', () => {
    const slugs = Object.fromEntries(TUTORIAL_STEPS.map((s) => [s.id, s.helpSlug]));
    expect(slugs).toEqual({
      project: 'projects',
      years: 'project',
      team: 'team',
      wbs: 'wbs',
      goals: 'goals',
      milestones: 'milestones',
      budget: 'budget',
      export: 'budget',
      backup: 'settings',
    });
  });

  it('screenPath — projectId 있음', () => {
    const paths = Object.fromEntries(TUTORIAL_STEPS.map((s) => [s.id, s.screenPath(PID)]));
    expect(paths).toEqual({
      project: '/projects',
      years: `/projects/${PID}`,
      team: `/projects/${PID}/team`,
      wbs: `/projects/${PID}/wbs`,
      goals: `/projects/${PID}/goals`,
      milestones: `/projects/${PID}/milestones`,
      budget: `/projects/${PID}/budget`,
      export: `/projects/${PID}/budget`,
      backup: '/settings',
    });
  });

  it('screenPath — projectId 없음: 과제가 필요한 단계는 null, project·backup만 경로', () => {
    for (const step of TUTORIAL_STEPS) {
      const p = step.screenPath(null);
      if (step.id === 'project') expect(p).toBe('/projects');
      else if (step.id === 'backup') expect(p).toBe('/settings');
      else expect(p).toBeNull();
    }
  });
});

describe('stepForPath — 현재 화면 단계 (TU-2)', () => {
  it.each<[string, TutorialStepId | null]>([
    ['/projects', 'project'],
    ['/projects/', 'project'],
    [`/projects/${PID}`, 'years'],
    [`/projects/${PID}/`, 'years'],
    [`/projects/${PID}/team`, 'team'],
    [`/projects/${PID}/wbs`, 'wbs'],
    [`/projects/${PID}/goals`, 'goals'],
    [`/projects/${PID}/milestones`, 'milestones'],
    [`/projects/${PID}/budget`, 'budget'],
    ['/settings', 'backup'],
    ['/', null],
    [`/projects/${PID}/gantt`, null],
    [`/projects/${PID}/board`, null],
    [`/projects/${PID}/risks`, null],
    [`/projects/${PID}/notes`, null],
    [`/projects/${PID}/wbs/extra`, null],
    ['/todos', null],
    ['/help', null],
    ['/login', null],
  ])('%s → %s', (pathname, expected) => {
    expect(stepForPath(pathname)).toBe(expected);
  });
});

describe('mergeStepStatus (TU-4)', () => {
  it('server null → auto 7개 전부 false, manual은 로컬만 본다', () => {
    const r = mergeStepStatus(null, emptyTutorial(), null);
    for (const id of AUTO_STEP_IDS) expect(r[id]).toBe(false);
    expect(r.export).toBe(false);
    expect(r.backup).toBe(false);
    expect(Object.keys(r).sort()).toEqual([...TUTORIAL_STEP_IDS].sort());
  });

  it('server 값이 auto 단계에 그대로 실린다', () => {
    const server = serverAll(false);
    server.projectExists = true;
    server.steps.project = true;
    server.steps.budget = true;
    const r = mergeStepStatus(server, emptyTutorial(), null);
    expect(r.project).toBe(true);
    expect(r.budget).toBe(true);
    expect(r.years).toBe(false);
    expect(r.team).toBe(false);
  });

  it('backup: lastBackupAt만으로 true', () => {
    const r = mergeStepStatus(null, emptyTutorial(), '2026-09-01T00:00:00.000Z');
    expect(r.backup).toBe(true);
    expect(r.export).toBe(false);
  });

  it('backup: manualDone만으로 true', () => {
    const r = mergeStepStatus(null, { ...emptyTutorial(), manualDone: ['backup'] }, null);
    expect(r.backup).toBe(true);
  });

  it('export: manualDone으로만 true, lastBackupAt과 무관', () => {
    expect(mergeStepStatus(null, emptyTutorial(), '2026-09-01T00:00:00.000Z').export).toBe(false);
    expect(mergeStepStatus(null, { ...emptyTutorial(), manualDone: ['export'] }, null).export).toBe(true);
  });

  it('auto 단계는 manualDone을 무시한다 — 데이터가 근거다', () => {
    const r = mergeStepStatus(
      serverAll(false),
      { ...emptyTutorial(), manualDone: ['project', 'wbs', 'budget'] },
      null
    );
    expect(r.project).toBe(false);
    expect(r.wbs).toBe(false);
    expect(r.budget).toBe(false);
  });

  it('전부 완료', () => {
    const r = mergeStepStatus(
      serverAll(true),
      { ...emptyTutorial(), manualDone: ['export'] },
      '2026-09-01T00:00:00.000Z'
    );
    expect(Object.values(r).every(Boolean)).toBe(true);
  });
});

describe('isSampleProject (TU-3)', () => {
  it('상수', () => {
    expect(SAMPLE_PROJECT_PREFIX).toBe('[예제] ');
    expect(SAMPLE_DESCRIPTION_FIRST_LINE).toBe('따라하기 예제 — 지워도 됩니다');
  });

  it('접두 판정 — 공백 포함 정확히 일치해야 한다', () => {
    expect(isSampleProject({ name: '[예제] 수소 촉매 개발' })).toBe(true);
    expect(isSampleProject({ name: '[예제]수소 촉매 개발' })).toBe(false);
    expect(isSampleProject({ name: '수소 촉매 개발 [예제] ' })).toBe(false);
    expect(isSampleProject({ name: '예제 과제' })).toBe(false);
    expect(isSampleProject({ name: '' })).toBe(false);
  });
});

describe('content/tutorial/*.md — 본문 형식 (TU-7)', () => {
  const files = TUTORIAL_STEP_IDS.map((id) => ({ id, file: path.join(CONTENT_DIR, `${id}.md`) }));

  it('9편 전부 존재', () => {
    for (const { file } of files) expect(fs.existsSync(file), file).toBe(true);
  });

  it.each(files)('$id.md — 1행 `# `, 2행 `> 할 일:`, 두 헤딩, 표·링크 0건, 800자 이하', ({ id, file }) => {
    const text = fs.readFileSync(file, 'utf8').replace(/\r\n?/g, '\n');
    const lines = text.split('\n');

    expect(lines[0], `${id}: 1행`).toMatch(/^# \S/);
    expect(lines[1], `${id}: 2행`).toMatch(/^> 할 일: \S/);
    expect(lines.filter((l) => l === '## 버튼은 어디에')).toHaveLength(1);
    expect(lines.filter((l) => l === '## 완료되면')).toHaveLength(1);
    expect(lines.indexOf('## 버튼은 어디에')).toBeLessThan(lines.indexOf('## 완료되면'));

    // lib/notes.ts는 표를 지원하지 않는다
    expect(lines.filter((l) => l.trimStart().startsWith('|')), `${id}: 표`).toHaveLength(0);
    // 링크는 본문에 쓰지 않는다 — 상대 링크는 물론 절대 링크도 (UI가 레지스트리로 그린다)
    expect(text.match(/\]\(/g) ?? [], `${id}: 링크`).toHaveLength(0);
    expect(text.includes('[이 화면으로]'), `${id}: [이 화면으로]`).toBe(false);
    expect(text.includes('/help'), `${id}: 도움말 링크`).toBe(false);

    expect(text.length, `${id}: ${text.length}자`).toBeLessThanOrEqual(800);
  });

  it('manual 단계는 "감지하지 못합니다" 문구, auto 단계는 "자동으로 체크"', () => {
    for (const step of TUTORIAL_STEPS) {
      const text = fs.readFileSync(path.join(CONTENT_DIR, `${step.id}.md`), 'utf8');
      const done = text.slice(text.indexOf('## 완료되면'));
      if (step.detection === 'manual') {
        expect(done).toContain('이 단계는 앱이 감지하지 못합니다 — 직접 체크하세요');
      } else {
        expect(done).toContain('자동으로 체크');
      }
    }
  });

  it('budget 단계는 산출근거 + 규칙 둘 다 필요함을 명시 (TU-4 ⑦)', () => {
    const text = fs.readFileSync(path.join(CONTENT_DIR, 'budget.md'), 'utf8');
    const done = text.slice(text.indexOf('## 완료되면'));
    expect(done).toContain('산출근거');
    expect(done).toContain('규칙');
    expect(done).toContain('둘 다');
  });
});
