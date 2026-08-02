// 리스크 점수·등급 판정 테스트 (SOT §6.5 Risk 행, §5.13, 부록 A.3)

import { describe, expect, it } from 'vitest';
import { RISK_SCORE_COLORS } from '@/lib/constants';
import {
  isActiveRisk,
  needsAttention,
  riskColor,
  riskScore,
  riskSeverity,
  type RiskJudgeInput,
  type RiskSeverity,
} from '@/lib/risk';
import type { RiskLevel, RiskStatus } from '@/types';

const ALL_STATUSES: RiskStatus[] = [
  'identified',
  'monitoring',
  'occurred',
  'resolved',
  'closed',
];

// 경계 6종. 14·7은 1~5 곱으로 만들 수 없는 값이라 등급 경계 자체를 확인하려면
// 입력을 캐스팅할 수밖에 없다 — 경계가 15/8에서 정확히 갈리는지 보는 게 목적이다.
const BOUNDARIES: { score: number; p: RiskLevel; i: RiskLevel; severity: RiskSeverity }[] = [
  { score: 25, p: 5, i: 5, severity: 'high' },
  { score: 15, p: 5, i: 3, severity: 'high' },
  { score: 14, p: 7 as RiskLevel, i: 2, severity: 'medium' },
  { score: 8, p: 4, i: 2, severity: 'medium' },
  { score: 7, p: 7 as RiskLevel, i: 1, severity: 'low' },
  { score: 1, p: 1, i: 1, severity: 'low' },
];

function r(p: RiskLevel, i: RiskLevel, status: RiskStatus): RiskJudgeInput {
  return { probability: p, impact: i, status };
}

describe('riskScore (§5.13)', () => {
  it('probability × impact', () => {
    expect(riskScore({ probability: 5, impact: 5 })).toBe(25);
    expect(riskScore({ probability: 3, impact: 4 })).toBe(12);
    expect(riskScore({ probability: 1, impact: 1 })).toBe(1);
  });
});

describe('isActiveRisk (§6.5 미해결)', () => {
  it('resolved·closed만 비활성', () => {
    expect(isActiveRisk('identified')).toBe(true);
    expect(isActiveRisk('monitoring')).toBe(true);
    expect(isActiveRisk('occurred')).toBe(true);
    expect(isActiveRisk('resolved')).toBe(false);
    expect(isActiveRisk('closed')).toBe(false);
  });
});

describe('riskSeverity: 경계 6종 × 상태 5종 (§6.5)', () => {
  for (const b of BOUNDARIES) {
    for (const status of ALL_STATUSES) {
      const active = status !== 'resolved' && status !== 'closed';
      const expected = active ? b.severity : null;

      it(`score ${b.score} / ${status} → ${expected ?? 'null'}`, () => {
        expect(riskScore({ probability: b.p, impact: b.i })).toBe(b.score);
        expect(riskSeverity(r(b.p, b.i, status))).toBe(expected);
      });
    }
  }
});

describe('needsAttention: 경계 6종 × 상태 5종 (§6.5 마지막 문장)', () => {
  for (const b of BOUNDARIES) {
    for (const status of ALL_STATUSES) {
      const active = status !== 'resolved' && status !== 'closed';
      // occurred는 점수와 무관하게 항상 주의 필요, 그 외에는 high만
      const expected = active && (status === 'occurred' || b.severity === 'high');

      it(`score ${b.score} / ${status} → ${expected}`, () => {
        expect(needsAttention(r(b.p, b.i, status))).toBe(expected);
      });
    }
  }
});

describe('needsAttention 추가 규칙', () => {
  it('낮은 점수라도 occurred면 주의 필요', () => {
    expect(needsAttention(r(1, 1, 'occurred'))).toBe(true);
  });

  it('해결·종결된 리스크는 점수가 25여도 주의 대상이 아니다', () => {
    expect(needsAttention(r(5, 5, 'resolved'))).toBe(false);
    expect(needsAttention(r(5, 5, 'closed'))).toBe(false);
  });
});

describe('riskColor (부록 A.3)', () => {
  it('constants의 RISK_SCORE_COLORS 값을 그대로 쓴다', () => {
    for (const band of RISK_SCORE_COLORS) {
      expect(riskColor(band.min)).toBe(band.color);
      expect(riskColor(band.max)).toBe(band.color);
    }
  });

  it('경계 6종의 색상', () => {
    expect(riskColor(25)).toBe('red-600');
    expect(riskColor(15)).toBe('red-600');
    expect(riskColor(14)).toBe('amber-500');
    expect(riskColor(8)).toBe('amber-500');
    expect(riskColor(7)).toBe('emerald-600');
    expect(riskColor(1)).toBe('emerald-600');
  });

  it('1~25 밖의 점수는 조용히 넘기지 않고 던진다', () => {
    expect(() => riskColor(0)).toThrow(RangeError);
    expect(() => riskColor(26)).toThrow(RangeError);
  });
});
