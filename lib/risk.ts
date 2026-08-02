// 리스크 점수·등급 판정 (SOT §6.5 Risk 행, §5.13)
// score는 저장하지 않는다 — probability·impact가 바뀌면 따라 변해야 하므로
// 읽을 때마다 계산한다 (§5.13 주석).

import { RISK_SCORE_COLORS } from './constants';
import type { Risk, RiskStatus } from '@/types';

export type RiskSeverity = 'high' | 'medium' | 'low';

// 경계값·색상은 부록 A.3(RISK_SCORE_COLORS)이 원본이다. 여기서 숫자를 다시 쓰면
// 색상과 등급이 따로 놀 수 있으므로 등급 이름만 얹는다 (내림차순).
const RISK_BANDS = [
  { severity: 'high', ...RISK_SCORE_COLORS[0] },
  { severity: 'medium', ...RISK_SCORE_COLORS[1] },
  { severity: 'low', ...RISK_SCORE_COLORS[2] },
] as const satisfies readonly { severity: RiskSeverity; min: number; max: number; color: string }[];

export type RiskScoreInput = Pick<Risk, 'probability' | 'impact'>;
export type RiskJudgeInput = RiskScoreInput & Pick<Risk, 'status'>;

// §5.13: score = probability × impact (1~25)
export function riskScore(r: RiskScoreInput): number {
  return r.probability * r.impact;
}

// §6.5: resolved·closed는 등급 판정 대상이 아니다
export function isActiveRisk(status: RiskStatus): boolean {
  return status !== 'resolved' && status !== 'closed';
}

// 미해결이 아니면 null. "등급 없음"을 low로 뭉뚱그리면 대시보드 집계가 틀어진다.
export function riskSeverity(r: RiskJudgeInput): RiskSeverity | null {
  if (!isActiveRisk(r.status)) return null;
  return severityOf(riskScore(r));
}

// §6.5 마지막 문장: status='occurred'는 점수와 무관하게 "주의 필요"에 포함한다.
export function needsAttention(r: RiskJudgeInput): boolean {
  if (!isActiveRisk(r.status)) return false;
  return r.status === 'occurred' || riskSeverity(r) === 'high';
}

export function riskColor(score: number): string {
  return band(score).color;
}

function severityOf(score: number): RiskSeverity {
  return band(score).severity;
}

function band(score: number): (typeof RISK_BANDS)[number] {
  const found = RISK_BANDS.find((b) => score >= b.min && score <= b.max);
  // 1~25 밖의 점수는 계산이 깨졌다는 뜻이다 — 조용히 기본 등급을 주지 않는다
  if (!found) {
    throw new RangeError(`리스크 점수가 1~25 범위를 벗어났습니다: ${score}`);
  }
  return found;
}
