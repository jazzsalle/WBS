'use client';

// 리스크 목록 테이블
// (SOT §7.11 "등급(점수) / 리스크명 / 유형 / 발생가능성 / 영향도 / 대응전략 / 담당 / 목표일 / 상태",
//  "행 확장 → 리스크 내용, 대응 방안, 비상 계획, 관련 작업 링크")
// 표시 규칙:
//  - 점수·등급·주의 필요는 서버가 lib/risk.ts로 판정한 값(RiskView)만 쓴다. 여기서
//    probability × impact를 다시 계산하지 않는다 (§5.13, §6.5).
//  - 해결·종료는 §6.5의 등급 판정 대상이 아니라 등급 칸이 비고 회색으로 낮춘다.
//  - 유형·전략·상태는 부록 A.4 라벨 맵으로만 그린다 — 원시 enum 문자열을 노출하지 않는다.
//  - 상태 변경은 사용자가 만지는 필드가 하나뿐이라 낙관적 잠금 없이 바로 저장한다 (O-2).
// 쓰기는 전부 부모(RiskScreen)가 actions/risks.ts를 거쳐 수행한다.

import { Fragment } from 'react';
import Link from 'next/link';
import type { RiskStatus } from '@/types';
import type { RiskTaskRef, RiskView } from '@/actions/risks';
import {
  RISK_CATEGORY_LABELS,
  RISK_STATUS_LABELS,
  RISK_STRATEGY_LABELS,
} from '@/lib/constants';
import Badge from '@/components/ui/Badge';
import Button from '@/components/ui/Button';
import PrintHeader from '@/components/print/PrintHeader';
import { PRINT_TABLE, PRINT_TABLE_WRAP, PRINT_TD, PRINT_TH } from '@/components/print/tokens';
import { RISK_SEVERITY_LABELS, riskColorClasses } from './severity';

// 등급 / 리스크명 / 유형 / 발생가능성 / 영향도 / 대응전략 / 담당 / 목표일 / 상태 / 동작
const COLUMN_COUNT = 10;

const TH_CLASS = `px-3 py-2 font-medium ${PRINT_TH}`;
const TD_CLASS = `px-3 py-2 align-top ${PRINT_TD}`;

const SELECT_CLASS =
  'w-full rounded-md border border-grey-300 bg-surface px-1.5 py-1 text-xs font-medium focus:border-grey-500 focus:outline-none disabled:opacity-50';

export interface RiskTableProps {
  /** 정렬이 끝난 상태로 받는다 (§7.11 기본은 점수 내림차순) */
  views: RiskView[];
  projectId: string;
  /** 인쇄 머리말 (§12 P-R3) */
  projectName: string;
  /** 인쇄 출력일 (§12 P-R3). 서버가 만든 오늘을 그대로 쓴다 — new Date() 금지 (§6.5) */
  todayISO: string;
  memberNameById: Map<string, string>;
  yearNameById: Map<string, string>;
  taskById: Map<string, RiskTaskRef>;
  busy: boolean;
  expandedId: string | null;
  /** 수동 순서 모드에서만 ↑↓를 보여준다 — 점수순일 때 순서 버튼은 아무 효과가 없다 */
  manualOrder: boolean;
  onToggleExpand: (id: string) => void;
  onStatusChange: (id: string, status: RiskStatus) => void;
  onMove: (id: string, direction: -1 | 1) => void;
  onEdit: (id: string) => void;
  onDelete: (id: string) => void;
}

export default function RiskTable({
  views,
  projectId,
  projectName,
  todayISO,
  memberNameById,
  yearNameById,
  taskById,
  busy,
  expandedId,
  manualOrder,
  onToggleExpand,
  onStatusChange,
  onMove,
  onEdit,
  onDelete,
}: RiskTableProps) {
  // 연차·인력·작업은 지워져도 리스크는 남는다(N-8). 감추지 않고 사실을 드러낸다.
  const memberLabel = (memberId: string | null): string => {
    if (memberId === null) return '미지정';
    return memberNameById.get(memberId) ?? '(삭제된 인력)';
  };

  const yearLabel = (yearId: string | null): string => {
    if (yearId === null) return '연차 없음';
    return yearNameById.get(yearId) ?? '(삭제된 연차)';
  };

  return (
    <div>
      {/* P-R1 가로 + P-R3 머리말. 9컬럼(+동작)이라 A4 세로에 넣으면 글자가 무너진다 */}
      <PrintHeader
        title="리스크 관리대장"
        projectName={projectName}
        todayISO={todayISO}
        orientation="landscape"
      />

      <div className="mb-2 flex justify-end print:hidden">
        <Button size="sm" onClick={() => window.print()}>
          인쇄
        </Button>
      </div>

      <div className={`overflow-x-auto rounded-xl border border-grey-200 bg-surface ${PRINT_TABLE_WRAP}`}>
        <table className={`w-full min-w-[1100px] text-left text-sm ${PRINT_TABLE}`}>
          <caption className="hidden px-3 py-2 text-left text-sm font-bold text-grey-900 print:table-caption">
            리스크 관리대장
          </caption>
          <thead className="text-xs text-grey-500 print:text-black">
            <tr className="border-b border-grey-100">
              <th className={TH_CLASS}>등급(점수)</th>
              <th className={TH_CLASS}>리스크명</th>
              <th className={TH_CLASS}>유형</th>
              <th className={TH_CLASS}>발생가능성</th>
              <th className={TH_CLASS}>영향도</th>
              <th className={TH_CLASS}>대응전략</th>
              <th className={TH_CLASS}>담당</th>
              <th className={TH_CLASS}>목표일</th>
              <th className={TH_CLASS}>상태</th>
              <th className={`${TH_CLASS} text-right print:hidden`}>동작</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-grey-100">
            {views.length === 0 && (
              <tr>
                <td colSpan={COLUMN_COUNT} className="px-3 py-8 text-center text-sm text-grey-400">
                  표시할 리스크가 없습니다.
                </td>
              </tr>
            )}
  
            {views.map((view, index) => {
              const risk = view.risk;
              const expanded = expandedId === risk.id;
              const classes = riskColorClasses(view.colorToken);
              const task = risk.taskId === null ? null : (taskById.get(risk.taskId) ?? null);
  
              return (
                <Fragment key={risk.id}>
                  <tr className={expanded ? 'bg-grey-50' : undefined}>
                    <td className={TD_CLASS}>
                      <div className="flex flex-wrap items-center gap-1.5">
                        {/* §6.5: 해결·종료는 등급 판정 대상이 아니다 — 등급을 매기지 않고 점수만 남긴다 */}
                        {view.severity === null ? (
                          <span
                            title="해결·종료된 리스크는 등급 판정 대상이 아닙니다 (§6.5)."
                            className="inline-flex items-center rounded-full bg-grey-100 px-2 py-0.5 text-xs font-semibold text-grey-400 print:bg-transparent print:text-black"
                          >
                            판정 제외 {view.score}
                          </span>
                        ) : (
                          <span
                            title={`발생가능성 ${risk.probability} × 영향도 ${risk.impact} = ${view.score}`}
                            // P-R5: 화면 뱃지는 색 배경 + 흰 글자다. 인쇄는 배경색을 버리는 것이
                            // 기본이라 그대로 두면 흰 글자만 남아 등급이 사라진다.
                            // 등급 이름('고위험')이 이미 글자로 있으므로 색만 흑백용으로 되돌린다.
                            className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-bold tabular-nums print:border print:border-grey-500 print:bg-transparent print:text-black ${classes.badge}`}
                          >
                            {RISK_SEVERITY_LABELS[view.severity]} {view.score}
                          </span>
                        )}
                        {/* §6.5 마지막 문장: 발생한 리스크는 점수와 무관하게 주의 대상이다 */}
                        {view.attention && risk.status === 'occurred' && (
                          <Badge tone="red" title="발생한 리스크는 점수와 무관하게 주의 대상입니다 (§6.5).">
                            주의
                          </Badge>
                        )}
                      </div>
                    </td>
  
                    <td className={TD_CLASS}>
                      <div className="flex flex-wrap items-center gap-1.5">
                        <button
                          type="button"
                          onClick={() => onToggleExpand(risk.id)}
                          aria-expanded={expanded}
                          aria-label={`${risk.title} 상세 ${expanded ? '접기' : '펼치기'}`}
                          className="shrink-0 rounded-md border border-grey-200 px-1.5 text-xs text-grey-500 hover:bg-grey-100 print:hidden"
                        >
                          {expanded ? '▾' : '▸'}
                        </button>
                        <span
                          className={`font-medium ${view.active ? 'text-grey-900' : 'text-grey-400'}`}
                        >
                          {risk.title}
                        </span>
                        {task && (
                          <Badge tone="blue" title={`관련 작업: ${task.title}`}>
                            작업 연결
                          </Badge>
                        )}
                      </div>
                    </td>
  
                    <td className={`${TD_CLASS} text-grey-600`}>
                      {RISK_CATEGORY_LABELS[risk.category]}
                    </td>
                    <td className={`${TD_CLASS} tabular-nums text-grey-700`}>{risk.probability}</td>
                    <td className={`${TD_CLASS} tabular-nums text-grey-700`}>{risk.impact}</td>
                    <td className={`${TD_CLASS} text-grey-600`}>
                      {RISK_STRATEGY_LABELS[risk.strategy]}
                    </td>
                    <td className={`${TD_CLASS} text-grey-600`}>{memberLabel(risk.ownerMemberId)}</td>
                    <td className={`${TD_CLASS} tabular-nums text-grey-600`}>
                      {risk.dueDate ?? <span className="text-grey-400">미지정</span>}
                    </td>
  
                    <td className={TD_CLASS}>
                      {/* O-2: 단일 조작이므로 낙관적 잠금 없이 바로 저장한다 */}
                      <select
                        value={risk.status}
                        disabled={busy}
                        aria-label={`${risk.title} 상태`}
                        onChange={(e) => onStatusChange(risk.id, e.target.value as RiskStatus)}
                        className={`${SELECT_CLASS} print:hidden`}
                      >
                        {(Object.keys(RISK_STATUS_LABELS) as RiskStatus[]).map((status) => (
                          <option key={status} value={status}>
                            {RISK_STATUS_LABELS[status]}
                          </option>
                        ))}
                      </select>
                      {/* 인쇄에는 드롭다운 대신 값만 남긴다 */}
                      <span className="hidden text-grey-700 print:inline">
                        {RISK_STATUS_LABELS[risk.status]}
                      </span>
                    </td>
  
                    <td className={`${TD_CLASS} text-right print:hidden`}>
                      <div className="flex flex-wrap justify-end gap-1.5">
                        {manualOrder && (
                          <>
                            <Button
                              size="sm"
                              disabled={busy || index === 0}
                              aria-label={`${risk.title} 위로`}
                              onClick={() => onMove(risk.id, -1)}
                            >
                              ↑
                            </Button>
                            <Button
                              size="sm"
                              disabled={busy || index === views.length - 1}
                              aria-label={`${risk.title} 아래로`}
                              onClick={() => onMove(risk.id, 1)}
                            >
                              ↓
                            </Button>
                          </>
                        )}
                        <Button size="sm" disabled={busy} onClick={() => onEdit(risk.id)}>
                          수정
                        </Button>
                        <Button
                          size="sm"
                          variant="danger"
                          disabled={busy}
                          onClick={() => onDelete(risk.id)}
                        >
                          삭제
                        </Button>
                      </div>
                    </td>
                  </tr>
  
                  {expanded && (
                    <tr className="bg-grey-50 print:hidden">
                      <td colSpan={COLUMN_COUNT} className="px-4 py-4">
                        <div className="grid gap-4 lg:grid-cols-3">
                          <div className="min-w-0">
                            <p className="text-xs font-semibold text-grey-600">리스크 내용</p>
                            <p className="mt-1 whitespace-pre-wrap text-sm text-grey-700">
                              {risk.description.trim() === '' ? (
                                <span className="text-grey-400">등록된 내용이 없습니다.</span>
                              ) : (
                                risk.description
                              )}
                            </p>
                          </div>
                          <div className="min-w-0">
                            <p className="text-xs font-semibold text-grey-600">대응 방안</p>
                            <p className="mt-1 whitespace-pre-wrap text-sm text-grey-700">
                              {risk.response.trim() === '' ? (
                                <span className="text-grey-400">등록된 대응 방안이 없습니다.</span>
                              ) : (
                                risk.response
                              )}
                            </p>
                          </div>
                          <div className="min-w-0">
                            <p className="text-xs font-semibold text-grey-600">비상 계획</p>
                            <p className="mt-1 whitespace-pre-wrap text-sm text-grey-700">
                              {risk.contingency.trim() === '' ? (
                                <span className="text-grey-400">등록된 비상 계획이 없습니다.</span>
                              ) : (
                                risk.contingency
                              )}
                            </p>
                          </div>
                        </div>
  
                        <div className="mt-4 flex flex-wrap items-center gap-x-6 gap-y-2 border-t border-grey-200 pt-3 text-xs text-grey-600">
                          <span>연차: {yearLabel(risk.yearId)}</span>
                          <span>
                            관련 작업:{' '}
                            {risk.taskId === null ? (
                              <span className="text-grey-400">연결 없음</span>
                            ) : task ? (
                              // WBS 화면은 연차 단위로 트리를 그린다 — 해당 연차를 열어준다 (§7.4)
                              <Link
                                href={`/projects/${projectId}/wbs?yearId=${task.yearId}`}
                                className="font-semibold text-blue-700 underline hover:text-blue-900"
                              >
                                {task.title} · WBS에서 보기
                              </Link>
                            ) : (
                              <span className="text-orange-700">(삭제된 작업)</span>
                            )}
                          </span>
                        </div>
                      </td>
                    </tr>
                  )}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
