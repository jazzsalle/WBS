'use client';

// 조직원 참여율 탭 (SOT §7.18 참여율 탭, §6.15 PS-1·PS-3·PS-4·PS-6, §12 P-R1~P-R5)
// 행 = 조직원, 열 = 그 해 값이 있는 과제 + 합계. 값·tone은 전부 서버(actions/staff.ts →
// lib/participation.ts)가 끝낸 것이다 — 여기서 100·90 경계를 다시 판정하지 않는다(PS-4).
// 합산에서 빠진 행(연결 안 됨·연도 미정)은 0건이어도 문구를 지우지 않는다 — "빠진 게 없다"도
// 사용자가 확인해야 하는 사실이다(PS-1).
//
// 연도별 데이터는 이 컴포넌트가 직접 불러온다. 부모(StaffScreen)는 initialYear만 준다 —
// 탭을 여는 사람만 전 과제 인건비 행을 읽게 하려는 것이다(PS-5 벌크 조회).

import { useCallback, useEffect, useRef, useState } from 'react';
import type { ActionErrorCode } from '@/lib/db/errors';
import { getStaffParticipation, type StaffParticipation } from '@/actions/staff';
import { todayISO } from '@/lib/dates';
import Badge from '@/components/ui/Badge';
import Button from '@/components/ui/Button';
import ErrorBanner from '@/components/ui/ErrorBanner';
import { SkeletonBlock } from '@/components/ui/Skeleton';
import PrintHeader from '@/components/print/PrintHeader';
import { PRINT_TABLE, PRINT_TABLE_WRAP, PRINT_TD, PRINT_TH } from '@/components/print/tokens';

export interface ParticipationMatrixProps {
  /** 처음 보여줄 달력 연도. 셀렉트는 이 값 ± YEAR_SPAN */
  initialYear: number;
  /** 행 이름 클릭 — 부모가 상세 패널을 연다. 없으면 이름은 글자로만 그린다 */
  onSelectStaff?: (staffId: string) => void;
}

const YEAR_SPAN = 3;

type LoadState =
  | { phase: 'loading' }
  | { phase: 'error'; message: string; code?: ActionErrorCode }
  | { phase: 'ready'; data: StaffParticipation; printedOn: string };

// PS-4 tone → 글자색. 인쇄는 색을 버리고(P-R5) 옆의 라벨("초과"·"여유 없음")만 남긴다
const TONE_CLASSES = {
  ok: 'text-grey-900',
  warn: 'text-orange-700 print:text-black',
  error: 'text-red-600 font-bold print:text-black',
} as const;

const TONE_LABELS = {
  ok: null,
  warn: '여유 없음',
  error: '초과',
} as const;

const TH_CLASS = `px-3 py-2 font-medium ${PRINT_TH}`;
const TD_CLASS = `px-3 py-2 ${PRINT_TD}`;
// 합계 열 고정. 스크롤 상자 안에서 오른쪽에 붙고, 인쇄에서는 고정이 의미 없다
const STICKY_TOTAL = 'sticky right-0 bg-white print:static';

/** 소수 1자리 표시(PS-4). 판정은 서버가 원값으로 이미 끝냈다 */
function formatRate(value: number): string {
  return value.toFixed(1);
}

export default function ParticipationMatrix({ initialYear, onSelectStaff }: ParticipationMatrixProps) {
  const [year, setYear] = useState(initialYear);
  const [hideRetired, setHideRetired] = useState(true);
  const [state, setState] = useState<LoadState>({ phase: 'loading' });
  // 연도를 빠르게 바꾸면 앞선 요청이 늦게 도착할 수 있다 — 마지막 요청의 응답만 받는다
  const requestSeq = useRef(0);

  const load = useCallback(async (target: number): Promise<void> => {
    const seq = ++requestSeq.current;
    setState({ phase: 'loading' });
    const res = await getStaffParticipation(target);
    if (seq !== requestSeq.current) return;
    if (!res.ok) {
      setState({ phase: 'error', message: res.error, code: res.code });
      return;
    }
    // 출력일은 응답 시점에 Asia/Seoul 달력으로 찍는다(§6.5). 렌더 중에 new Date()를 부르면
    // SSR과 하이드레이션이 자정 부근에서 어긋난다
    setState({ phase: 'ready', data: res.data, printedOn: todayISO(new Date()) });
  }, []);

  useEffect(() => {
    void load(year);
  }, [load, year]);

  const yearOptions = Array.from({ length: YEAR_SPAN * 2 + 1 }, (_, i) => initialYear - YEAR_SPAN + i);

  return (
    <section aria-label="조직원 참여율">
      {/* P-R1 가로 + P-R3 머리말. 과제 수만큼 열이 늘어나므로 세로에 넣으면 글자가 무너진다.
          과제 하나의 표가 아니라 전 과제 합산이므로 과제명 자리에 그 사실을 적는다 */}
      {state.phase === 'ready' && (
        <PrintHeader
          title={`조직원 참여율 ${state.data.year}`}
          projectName="전 과제"
          todayISO={state.printedOn}
          orientation="landscape"
          subtitle="단위 % · 연차 시작 연도 기준 · 연단위 평균"
        />
      )}

      <div className="mb-3 flex flex-wrap items-center gap-3 print:hidden">
        <label className="flex items-center gap-2 text-t7 text-grey-700">
          연도
          <select
            value={year}
            onChange={(e) => setYear(Number(e.target.value))}
            className="rounded-md border border-grey-300 bg-white px-2 py-1 text-t7 font-medium text-grey-900 focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-100"
          >
            {yearOptions.map((y) => (
              <option key={y} value={y}>
                {y}
              </option>
            ))}
          </select>
        </label>
        <label className="flex items-center gap-1.5 text-t7 text-grey-700">
          <input
            type="checkbox"
            checked={hideRetired}
            onChange={(e) => setHideRetired(e.target.checked)}
            className="rounded border-grey-300"
          />
          퇴사자 숨김
        </label>
        <Button size="sm" className="ml-auto" onClick={() => window.print()} disabled={state.phase !== 'ready'}>
          인쇄
        </Button>
      </div>

      {state.phase === 'loading' && <MatrixSkeleton />}

      {state.phase === 'error' && (
        <ErrorBanner message={state.message} code={state.code} onRetry={() => void load(year)} />
      )}

      {state.phase === 'ready' && (
        <MatrixBody data={state.data} hideRetired={hideRetired} onSelectStaff={onSelectStaff} />
      )}
    </section>
  );
}

function MatrixSkeleton() {
  return (
    <div role="status" aria-label="불러오는 중" className="rounded-xl border border-hairline bg-white p-4">
      <SkeletonBlock className="h-4 w-2/3" />
      <SkeletonBlock className="mt-2 h-4 w-1/3" />
      <SkeletonBlock className="mt-2 h-4 w-1/4" />
      <SkeletonBlock className="mt-5 h-4 w-full" />
      {Array.from({ length: 6 }, (_, i) => (
        <SkeletonBlock key={i} className="mt-3 h-4" />
      ))}
      <span className="sr-only">불러오는 중</span>
    </div>
  );
}

interface MatrixBodyProps {
  data: StaffParticipation;
  hideRetired: boolean;
  onSelectStaff: ((staffId: string) => void) | undefined;
}

function MatrixBody({ data, hideRetired, onSelectStaff }: MatrixBodyProps) {
  const rows = hideRetired ? data.rows.filter((row) => row.employed) : data.rows;
  // 이름 + 과제 N + 합계
  const columnCount = data.projects.length + 2;

  return (
    <div>
      {/* 상단 안내 3종(§7.18). 건수가 0이어도 문구를 지우지 않는다 */}
      <ul className="mb-3 space-y-1 text-t7 text-grey-700 print:mb-2 print:text-black">
        <li>
          <span className="font-semibold">연차 시작 연도 기준 · 연단위 평균(참여율 × 참여개월 ÷ 12)</span>
          <span className="ml-2 text-grey-500 print:text-black">
            연차가 해를 걸쳐도(예: 4월~다음 해 3월) 시작 연도에 전부 넣습니다. 월별로 나누지 않습니다.
          </span>
        </li>
        <li>
          <span className="font-semibold">연결 안 된 인건비 행 {data.unlinkedRowCount}건</span>
          <span className="ml-2 text-grey-500 print:text-black">
            인력이 조직원에 연결되지 않아 합산에서 빠진 행입니다. 과제의 인력 화면에서 조직원을 연결하세요.
          </span>
        </li>
        <li>
          <span className="font-semibold">연도 미정 {data.undatedRowCount}건</span>
          <span className="ml-2 text-grey-500 print:text-black">
            연차 시작일이 없어 어느 해에도 넣지 못한 행입니다. 연차에 기간을 입력하면 집계됩니다.
          </span>
        </li>
      </ul>

      <div className={`overflow-x-auto rounded-xl border border-grey-200 bg-white ${PRINT_TABLE_WRAP}`}>
        <table className={`w-full text-left text-t7 ${PRINT_TABLE}`}>
          <caption className="hidden px-3 py-2 text-left text-t6 font-bold text-grey-900 print:table-caption">
            조직원 참여율 {data.year} (단위 %)
          </caption>
          <thead className="text-grey-500 print:text-black">
            <tr className="border-b border-grey-100">
              <th className={`${TH_CLASS} min-w-32`}>조직원</th>
              {data.projects.map((project) => (
                <th key={project.id} className={`${TH_CLASS} min-w-24 text-right`}>
                  {project.name.trim() === '' ? '(이름 없는 과제)' : project.name}
                </th>
              ))}
              <th className={`${TH_CLASS} min-w-28 text-right ${STICKY_TOTAL} border-l border-grey-200`}>합계</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-grey-100">
            {rows.length === 0 && (
              <tr>
                <td colSpan={columnCount} className={`${TD_CLASS} py-8 text-center text-grey-400`}>
                  {data.rows.length === 0
                    ? '등록된 조직원이 없습니다.'
                    : '재직 중인 조직원이 없습니다. 퇴사자 숨김을 끄면 전체가 보입니다.'}
                </td>
              </tr>
            )}

            {rows.map((row) => {
              const label = TONE_LABELS[row.tone];
              return (
                <tr key={row.staffId}>
                  <td className={`${TD_CLASS} text-grey-900 print:text-black`}>
                    <span className="inline-flex items-center gap-1.5">
                      {onSelectStaff ? (
                        <button
                          type="button"
                          onClick={() => onSelectStaff(row.staffId)}
                          className="rounded-md font-medium hover:text-blue-600 hover:underline focus:outline-none focus:ring-2 focus:ring-blue-100"
                        >
                          {row.name}
                        </button>
                      ) : (
                        <span className="font-medium">{row.name}</span>
                      )}
                      {!row.employed && <Badge tone="neutral">퇴사</Badge>}
                    </span>
                  </td>
                  {data.projects.map((project) => {
                    const value = row.byProject[project.id];
                    return (
                      <td
                        key={project.id}
                        className={`${TD_CLASS} text-right tabular-nums ${
                          value === undefined ? 'text-grey-400' : 'text-grey-700'
                        } print:text-black`}
                      >
                        {value === undefined ? '—' : formatRate(value)}
                      </td>
                    );
                  })}
                  <td
                    className={`${TD_CLASS} text-right tabular-nums ${STICKY_TOTAL} border-l border-grey-200 ${TONE_CLASSES[row.tone]}`}
                  >
                    {formatRate(row.total)}
                    {/* P-R5: 색을 못 보는 출력에서도 판정이 읽히게 글자를 함께 둔다 */}
                    {label !== null && <span className="ml-1.5 text-[11px] font-semibold">{label}</span>}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
