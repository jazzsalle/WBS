// 협약 보기 라벨 (SOT 부록 A.4 v4.9, Phase 25 §6.19 AG-3~AG-5)
// Phase 24 라벨 테스트(agreement-labels.test.ts)와 분리한다 — Phase 24 테스트 파일은 schema_version 단언 외 수정하지 않는다.
import { describe, expect, it } from 'vitest';
import { AGREEMENT_VIEW_TEXT, PARTICIPANT_AMOUNT_KIND_LABELS, adjustmentAfterLabel } from '@/lib/constants';
import type { ParticipantAmountKind } from '@/types';

const sorted = (values: readonly string[]) => [...values].sort();

describe('부록 A.4 협약 보기 라벨 (Phase 25)', () => {
  it('ParticipantAmountKind 3종을 덮는다', () => {
    // 타입에 값이 늘면 satisfies가 컴파일 에러로 알린다 — 런타임 enum 스키마가 없는 판정 값이라
    const kinds = { auto: true, manual: true, salary_unknown: true } satisfies Record<ParticipantAmountKind, true>;
    expect(sorted(Object.keys(PARTICIPANT_AMOUNT_KIND_LABELS))).toEqual(sorted(Object.keys(kinds)));
    expect(PARTICIPANT_AMOUNT_KIND_LABELS).toEqual({ auto: '자동', manual: '수동', salary_unknown: '연봉 모름' });
  });

  it('협약 보기 고정 문구가 부록 A.4와 같다', () => {
    expect(AGREEMENT_VIEW_TEXT).toEqual({
      unassignedMember: '인력 미지정',
      outsideCategoriesRow: '양식에 없는 비목',
      companyType: '중소기업',
      judgementPass: '통과',
      judgementFail: '위반',
      judgementSkipped: '판정하지 않음',
      adjustmentBefore: '변경전 (제안)',
      notCurrentVersion: '현재 버전 아님',
      formE1: '양식 E1(총 인건비)',
      formE2: '양식 E2(수정인건비)',
    });
    expect(adjustmentAfterLabel('협약변경 1차')).toBe('변경후 (협약변경 1차)');
  });
});
