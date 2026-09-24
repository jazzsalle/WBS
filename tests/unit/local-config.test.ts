// LocalConfig 저장 형식 파싱 테스트 (SOT §5.16, §7.17 TU-6)
// 구 설정 파일·손상된 tutorial 필드를 만나도 앱이 죽지 않고, 살릴 수 있는 값은 살리는지 증명한다.

import { describe, expect, it } from 'vitest';
import {
  DEFAULT_TUTORIAL_CONFIG,
  TUTORIAL_STEP_IDS,
  parseStoredLocalConfig,
} from '@/lib/local-config';

const LEGACY_STORED = {
  backupFolder: 'D:/backup',
  lastBackupAt: '2026-09-01T00:00:00.000Z',
  lastOpenedProjectId: '11111111-1111-4111-8111-111111111111',
  ganttScale: 'month',
  onboardingCompleted: true,
};

const SAMPLE_ID = '22222222-2222-4222-8222-222222222222';

describe('parseStoredLocalConfig — tutorial (§5.16)', () => {
  it('구 설정 파일(tutorial 키 없음) → tutorial 기본값, 기존 4필드·onboardingCompleted 보존', () => {
    const parsed = parseStoredLocalConfig(LEGACY_STORED);
    expect(parsed.tutorial).toEqual(DEFAULT_TUTORIAL_CONFIG);
    expect(parsed.backupFolder).toBe('D:/backup');
    expect(parsed.lastBackupAt).toBe('2026-09-01T00:00:00.000Z');
    expect(parsed.lastOpenedProjectId).toBe(LEGACY_STORED.lastOpenedProjectId);
    expect(parsed.ganttScale).toBe('month');
    expect(parsed.onboardingCompleted).toBe(true);
  });

  it('tutorial이 객체가 아니면(타입 오류) 기본값', () => {
    const parsed = parseStoredLocalConfig({ ...LEGACY_STORED, tutorial: 'x' });
    expect(parsed.tutorial).toEqual(DEFAULT_TUTORIAL_CONFIG);
    expect(parsed.onboardingCompleted).toBe(true);
  });

  it('manualDone의 모르는 id만 걸러내고 아는 id는 남긴다', () => {
    const parsed = parseStoredLocalConfig({
      ...LEGACY_STORED,
      tutorial: { sampleProjectId: SAMPLE_ID, manualDone: ['export', 'bogus'], dismissed: true },
    });
    expect(parsed.tutorial.manualDone).toEqual(['export']);
    expect(parsed.tutorial.sampleProjectId).toBe(SAMPLE_ID);
    expect(parsed.tutorial.dismissed).toBe(true);
  });

  it('manualDone이 배열이 아니면 빈 배열', () => {
    const parsed = parseStoredLocalConfig({
      ...LEGACY_STORED,
      tutorial: { sampleProjectId: null, manualDone: 'export', dismissed: false },
    });
    expect(parsed.tutorial.manualDone).toEqual([]);
  });

  it('sampleProjectId가 UUID가 아니면 null, 나머지 필드는 유지', () => {
    const parsed = parseStoredLocalConfig({
      ...LEGACY_STORED,
      tutorial: { sampleProjectId: 'not-uuid', manualDone: ['backup'], dismissed: true },
    });
    expect(parsed.tutorial.sampleProjectId).toBeNull();
    expect(parsed.tutorial.manualDone).toEqual(['backup']);
    expect(parsed.tutorial.dismissed).toBe(true);
  });

  it('dismissed가 boolean이 아니면 false, 나머지 필드는 유지', () => {
    const parsed = parseStoredLocalConfig({
      ...LEGACY_STORED,
      tutorial: { sampleProjectId: SAMPLE_ID, manualDone: ['export'], dismissed: 'yes' },
    });
    expect(parsed.tutorial.dismissed).toBe(false);
    expect(parsed.tutorial.sampleProjectId).toBe(SAMPLE_ID);
    expect(parsed.tutorial.manualDone).toEqual(['export']);
  });

  it('정상 값은 JSON 왕복 후에도 그대로다', () => {
    const stored = {
      ...LEGACY_STORED,
      tutorial: { sampleProjectId: SAMPLE_ID, manualDone: ['export', 'backup'], dismissed: true },
    };
    const parsed = parseStoredLocalConfig(JSON.parse(JSON.stringify(stored)));
    expect(parsed).toEqual(stored);
    expect(parseStoredLocalConfig(JSON.parse(JSON.stringify(parsed)))).toEqual(parsed);
  });

  it('9단계 id 전부가 manualDone에 남는다', () => {
    const parsed = parseStoredLocalConfig({
      ...LEGACY_STORED,
      tutorial: { sampleProjectId: null, manualDone: [...TUTORIAL_STEP_IDS], dismissed: false },
    });
    expect(parsed.tutorial.manualDone).toEqual([...TUTORIAL_STEP_IDS]);
    expect(TUTORIAL_STEP_IDS).toHaveLength(9);
  });

  it('객체가 아닌 값(전체 손상) → 저장 형식 전체 기본값', () => {
    const parsed = parseStoredLocalConfig(42);
    expect(parsed.tutorial).toEqual(DEFAULT_TUTORIAL_CONFIG);
    expect(parsed.ganttScale).toBe('week');
    expect(parsed.onboardingCompleted).toBe(false);
  });
});
