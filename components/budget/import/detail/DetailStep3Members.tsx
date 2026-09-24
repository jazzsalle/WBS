'use client';

// Step 3 — 성명 매핑 (SOT §7.9.3 Step 3, §6.11.4 D-11~D-14, §6.11.3 D-8a)
//
//  - 원본 성명 → Member 대응표. 상태 아이콘은 **§7.9.1 Step 4의 관례**를 그대로 쓴다
//    (아이콘 사전은 총괄표 마법사의 wizard-state 하나뿐이다 — 복사하면 두 화면이 갈린다)
//  - 미매칭은 3선택: ① 기존 인력 선택 ② 새 인력으로 생성 ③ 행 건너뛰기 (D-11)
//  - D-12: 새 인력은 **반영 시점에** 같은 트랜잭션에서 만든다. 여기서는 만들지 않으므로
//    연봉·직위·채용구분을 파일에서 미리 채워 보여 주기만 한다
//  - D-13: 동명이인은 소속 기관·직위를 함께 보여 주고 **자동 선택하지 않는다**
//  - D-14: 파일 연봉 ≠ 명부 연봉이면 양쪽을 나란히 + 경고. **명부를 고치는 UI는 여기 없다** —
//    연봉 변경은 PL-10b가 확인을 요구하는 별도 조작이고, 임포트가 우회하면 다른 연차 금액까지 흔든다
//  - D-8a: 명부 연봉이 비어 있으면 `파일 X원 → 반영 0원 (연봉 미입력)`을 명시하고 인력 화면 링크를 준다
//
// 매칭 판정(matched/ambiguous/unmatched·연봉 불일치)은 서버가 lib/import/detail-preview에서 내린
// 값을 그대로 표시할 뿐이다. 여기서 다시 대조하면 규칙이 두 곳에 생겨 반드시 어긋난다 (O-4).

import type { DetailMemberDecision, Member, Organization } from '@/types';
// types/index.ts가 재수출하지 않는 미리보기 타입. **타입 전용 import라 번들에 남지 않는다** (I-13)
import type { DetailMemberCandidate, DetailMemberMatch } from '@/lib/import';
import { HIRE_TYPE_LABELS } from '@/lib/constants';
import Badge from '@/components/ui/Badge';
import {
  MAPPING_STATUS_CLASS,
  MAPPING_STATUS_ICON,
  type MappingStatus,
} from '../wizard-state';

export interface DetailStep3MembersProps {
  matches: DetailMemberMatch[];
  /** draft.memberDecisions — 사용자가 직접 정한 것만 담긴다 (자동 제안은 match.decision) */
  decisions: Record<string, DetailMemberDecision>;
  /** ① 기존 인력 선택의 후보. 그 과제의 명부 전체다 (동명이인 후보만으로는 다른 표기를 이을 수 없다) */
  roster: Member[];
  /** ② 새 인력의 소속(선택). 지정하지 않으면 소속 없이 만든다 */
  organizations: Organization[];
  /** 명부 조회 실패 문구. 빈 목록으로 눙치지 않는다 (절대 규칙 5) */
  rosterError: string | null;
  /** D-8a 안내 링크 대상 */
  projectId: string;
  /** 성명 칸이 빈 인건비 행. 여기서는 고를 것이 없고 Step 4에서 오류로 드러난다 */
  namelessRows: number;
  busy: boolean;
  /** null이면 자동 제안으로 되돌린다 */
  onDecision: (key: string, decision: DetailMemberDecision | null) => void;
}

type DecisionKind = DetailMemberDecision['kind'];

/** §7.9.1 Step 4 관례에 성명 매칭 상태를 얹는다 — 아이콘·색은 그쪽 사전을 그대로 쓴다 */
function statusOf(
  match: DetailMemberMatch,
  decision: DetailMemberDecision | null,
  userDecided: boolean
): { key: MappingStatus; label: string } {
  if (decision?.kind === 'skip') return { key: 'skipped', label: '행 건너뛰기' };
  if (decision?.kind === 'create') return { key: 'manual', label: '새 인력으로 생성' };
  if (decision?.kind === 'existing') {
    return userDecided
      ? { key: 'manual', label: '사용자 지정' }
      : { key: 'exact', label: '명부와 완전일치' };
  }
  return match.status === 'ambiguous'
    ? { key: 'ambiguous', label: '동명이인 (선택필요)' }
    : { key: 'unmapped', label: '명부에 없음 (선택필요)' };
}

function won(value: number): string {
  return `${value.toLocaleString('ko-KR')}원`;
}

export default function DetailStep3Members({
  matches,
  decisions,
  roster,
  organizations,
  rosterError,
  projectId,
  namelessRows,
  busy,
  onDecision,
}: DetailStep3MembersProps) {
  const orgNameById = new Map(organizations.map((org) => [org.id, org.name]));

  const states = matches.map((match) => {
    const chosen = decisions[match.key];
    const decision = chosen ?? match.decision;
    return { match, decision, userDecided: chosen !== undefined };
  });

  const undecided = states.filter((state) => state.decision === null).length;
  const willCreate = states.filter((state) => state.decision?.kind === 'create').length;
  const willSkip = states.filter((state) => state.decision?.kind === 'skip').length;
  const salaryWarnings = matches.filter((match) =>
    match.issues.includes('salary-mismatch') || match.issues.includes('roster-salary-missing')
  ).length;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 rounded-xl border border-grey-200 bg-grey-50 px-3 py-2 text-xs">
        <span className="text-grey-600">
          성명 <strong>{matches.length}</strong>명
        </span>
        <span className={undecided > 0 ? 'font-semibold text-red-700' : 'text-grey-500'}>
          미결정 <strong>{undecided}</strong>명
        </span>
        <span className="text-blue-700">
          새 인력 <strong>{willCreate}</strong>명
        </span>
        <span className="text-grey-400">
          건너뜀 <strong>{willSkip}</strong>명
        </span>
        <span className={salaryWarnings > 0 ? 'text-orange-700' : 'text-grey-400'}>
          연봉 경고 <strong>{salaryWarnings}</strong>건
        </span>
      </div>

      {undecided > 0 && (
        <p className="rounded-lg border border-orange-300 bg-orange-50 px-3 py-2 text-xs font-semibold text-orange-900">
          ⚠️ 아직 정하지 않은 성명 {undecided}명이 있습니다. 이대로 진행하면 그 행들은 Step 4에서
          오류로 표시되고 반영이 막힙니다 (D-11).
        </p>
      )}

      {/* 성명 칸이 빈 인건비 행은 여기서 고를 대상이 없다 — 조용히 넘기지 않고 어디서 보이는지 말한다 */}
      {namelessRows > 0 && (
        <p className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
          성명 칸이 빈 인건비 행이 {namelessRows}개 있습니다. 고를 대상이 없어 여기 표시되지 않으며,
          Step 4에서 오류로 나옵니다. 원본 파일을 고치거나 Step 4에서 그 행을 건너뛰기로 빼세요.
        </p>
      )}

      {rosterError !== null && (
        <p className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
          인력 명부를 불러오지 못했습니다 — {rosterError}. [기존 인력 선택] 목록이 비어 있는 것은
          명부가 비었다는 뜻이 아닙니다. 새로 고친 뒤 다시 시도하세요.
        </p>
      )}

      <p className="text-[11px] text-grey-500">
        새 인력은 <strong>반영 버튼을 누를 때</strong> 산출근거와 같은 트랜잭션에서 만들어집니다 —
        지금 취소하면 명부에 아무것도 남지 않습니다 (D-12). 연봉은 파일 값으로 채워지고, 기존 인력의
        연봉은 임포트가 고치지 않습니다 (D-14).
      </p>

      {matches.length === 0 ? (
        <p className="rounded-xl border border-dashed border-grey-300 p-6 text-center text-sm text-grey-400">
          인건비 행에서 성명을 찾지 못했습니다.
        </p>
      ) : (
        <div className="space-y-3">
          {states.map((state, index) => (
            <MemberCard
              key={state.match.key}
              index={index}
              match={state.match}
              decision={state.decision}
              userDecided={state.userDecided}
              roster={roster}
              organizations={organizations}
              orgNameById={orgNameById}
              projectId={projectId}
              busy={busy}
              onDecision={onDecision}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function MemberCard({
  index,
  match,
  decision,
  userDecided,
  roster,
  organizations,
  orgNameById,
  projectId,
  busy,
  onDecision,
}: {
  index: number;
  match: DetailMemberMatch;
  decision: DetailMemberDecision | null;
  userDecided: boolean;
  roster: Member[];
  organizations: Organization[];
  orgNameById: Map<string, string>;
  projectId: string;
  busy: boolean;
  onDecision: (key: string, decision: DetailMemberDecision | null) => void;
}) {
  const status = statusOf(match, decision, userDecided);
  const kind: DecisionKind | null = decision?.kind ?? null;
  const undecided = decision === null;
  const groupName = `detail-member-${index}`;

  const select = (next: DecisionKind): void => {
    if (next === 'skip') {
      onDecision(match.key, { kind: 'skip' });
      return;
    }
    if (next === 'create') {
      onDecision(match.key, { kind: 'create', orgId: null });
      return;
    }
    // ①을 고르는 순간 대상이 정해져 있어야 한다 — 동명이인 후보 → 자동 제안 → 명부 첫 사람 순
    const target =
      (decision?.kind === 'existing' ? decision.memberId : null) ??
      match.candidates[0]?.id ??
      roster[0]?.id ??
      null;
    if (target === null) return;
    onDecision(match.key, { kind: 'existing', memberId: target });
  };

  return (
    <section
      className={`rounded-xl border p-3 ${
        undecided ? 'border-orange-300 bg-orange-50/60' : 'border-grey-200 bg-surface'
      }`}
    >
      <header className="flex flex-wrap items-baseline gap-2 text-sm">
        <span className="font-semibold text-grey-800">{match.fileName}</span>
        <span className={`text-xs ${MAPPING_STATUS_CLASS[status.key]}`}>
          <span className="mr-1">{MAPPING_STATUS_ICON[status.key]}</span>
          {status.label}
        </span>
        <span className="ml-auto text-[11px] text-grey-500">
          이 성명의 행 {match.rowKeys.length}개 · 파일 직위 {match.filePosition || '—'} · 파일 연봉{' '}
          {match.fileSalary === null ? '—' : won(match.fileSalary)} ·{' '}
          {HIRE_TYPE_LABELS[match.hireType]}
          {match.hireTypeLabel && ` (원문 "${match.hireTypeLabel}")`}
        </span>
      </header>

      {/* D-14: 양쪽 값을 나란히. 명부는 고치지 않는다 */}
      {match.salaryMismatch !== null && (
        <p className="mt-2 rounded-lg border border-orange-300 bg-orange-100 px-2 py-1.5 text-[11px] text-orange-900">
          ⚠️ 파일 연봉 <strong>{won(match.salaryMismatch.file)}</strong> / 명부 연봉{' '}
          <strong>{won(match.salaryMismatch.roster ?? 0)}</strong> — 금액은{' '}
          <strong>명부 연봉</strong>으로 계산하고 차액은 조정액으로 흡수합니다 (D-8a). 임포트는 명부
          연봉을 고치지 않습니다 (D-14). 연봉을 바꾸려면 인력 화면에서 확인을 거쳐 저장하세요
          (PL-10b).
        </p>
      )}

      {/* D-8a: 명부 연봉이 비면 산식이 성립하지 않아 0원으로 들어간다 — 숫자로 밝히고 갈 곳을 준다 */}
      {match.issues.includes('roster-salary-missing') && (
        <p className="mt-2 rounded-lg border border-orange-300 bg-orange-100 px-2 py-1.5 text-[11px] text-orange-900">
          ⚠️ 명부에 연봉이 없습니다 —{' '}
          <strong>
            파일 {match.fileSalary === null ? '—' : won(match.fileSalary)} → 반영 0원 (연봉 미입력)
          </strong>
          . 인력 화면에서 연봉을 채운 뒤 다시 가져오면 제대로 들어갑니다.{' '}
          <a
            href={`/projects/${projectId}/team`}
            target="_blank"
            rel="noreferrer"
            className="font-semibold underline"
          >
            인력 화면 열기 (새 창)
          </a>
        </p>
      )}

      {/* D-13: 같은 이름이 둘 이상이면 소속 기관·직위를 함께 보여 주고 자동 선택하지 않는다 */}
      {match.status === 'ambiguous' && (
        <div className="mt-2 rounded-lg border border-orange-300 bg-orange-100 px-2 py-1.5 text-[11px] text-orange-900">
          <p className="font-semibold">
            ⚠️ 명부에 같은 이름이 {match.candidates.length}명 있습니다. 자동으로 고르지 않으므로 직접
            지정하세요 (D-13).
          </p>
          <ul className="mt-1 space-y-0.5">
            {match.candidates.map((candidate) => (
              <li key={candidate.id}>· {describeCandidate(candidate)}</li>
            ))}
          </ul>
        </div>
      )}

      {/* D-11 3선택 */}
      <div className="mt-3 space-y-2 text-xs">
        <label className="flex flex-wrap items-center gap-2">
          <input
            type="radio"
            name={groupName}
            checked={kind === 'existing'}
            disabled={busy || roster.length === 0}
            onChange={() => select('existing')}
          />
          <span className="font-medium text-grey-700">① 기존 인력 선택</span>
          <select
            value={decision?.kind === 'existing' ? decision.memberId : ''}
            disabled={busy || kind !== 'existing'}
            aria-label={`${match.fileName}에 대응할 기존 인력`}
            onChange={(e) => onDecision(match.key, { kind: 'existing', memberId: e.target.value })}
            className="min-w-[18rem] rounded-lg border border-grey-300 px-2 py-1 disabled:bg-grey-50 disabled:text-grey-400"
          >
            <option value="" disabled>
              — 인력 선택 —
            </option>
            {roster.map((member) => (
              <option key={member.id} value={member.id}>
                {describeMember(member, orgNameById)}
              </option>
            ))}
          </select>
          {roster.length === 0 && (
            <span className="text-grey-400">명부에 인력이 없어 고를 수 없습니다.</span>
          )}
        </label>

        <div className="rounded-lg border border-grey-200 bg-grey-50 p-2">
          <label className="flex flex-wrap items-center gap-2">
            <input
              type="radio"
              name={groupName}
              checked={kind === 'create'}
              disabled={busy}
              onChange={() => select('create')}
            />
            <span className="font-medium text-grey-700">② 새 인력으로 생성</span>
            <Badge tone="blue">파일에서 미리 채움</Badge>
            <span className="text-grey-500">
              이름 {match.fileName} · 직위 {match.filePosition || '(없음)'} · 연봉{' '}
              {match.fileSalary === null ? '(없음)' : won(match.fileSalary)} · 채용구분{' '}
              {HIRE_TYPE_LABELS[match.hireType]}
            </span>
          </label>
          {kind === 'create' && (
            <label className="mt-2 flex flex-wrap items-center gap-2 pl-6 text-grey-600">
              소속 기관 (선택)
              <select
                value={decision?.kind === 'create' ? (decision.orgId ?? '') : ''}
                disabled={busy}
                aria-label={`${match.fileName}의 소속 기관`}
                onChange={(e) =>
                  onDecision(match.key, {
                    kind: 'create',
                    orgId: e.target.value === '' ? null : e.target.value,
                  })
                }
                className="rounded-lg border border-grey-300 px-2 py-1"
              >
                <option value="">— 지정 안 함 —</option>
                {organizations.map((org) => (
                  <option key={org.id} value={org.id}>
                    {org.name}
                  </option>
                ))}
              </select>
              <span className="text-[11px] text-grey-400">
                반영을 눌러야 만들어집니다. 나머지 항목(역할·분야·연락처)은 인력 화면에서 채우세요.
              </span>
            </label>
          )}
        </div>

        <label className="flex flex-wrap items-center gap-2">
          <input
            type="radio"
            name={groupName}
            checked={kind === 'skip'}
            disabled={busy}
            onChange={() => select('skip')}
          />
          <span className="font-medium text-grey-700">③ 행 건너뛰기</span>
          <span className="text-grey-500">
            이 성명의 행 {match.rowKeys.length}개가 반영에서 빠집니다.
          </span>
        </label>

        {userDecided && (
          <button
            type="button"
            disabled={busy}
            onClick={() => onDecision(match.key, null)}
            className="text-[11px] text-grey-500 underline"
          >
            자동 제안으로 되돌리기
          </button>
        )}
      </div>
    </section>
  );
}

/** D-13 표시 재료 — 이름만으로는 고를 수 없다 */
function describeCandidate(candidate: DetailMemberCandidate): string {
  const parts = [candidate.name];
  if (candidate.position) parts.push(candidate.position);
  parts.push(candidate.orgName ?? '소속 없음');
  parts.push(candidate.annualSalary === null ? '연봉 미입력' : won(candidate.annualSalary));
  return parts.join(' · ');
}

function describeMember(member: Member, orgNameById: Map<string, string>): string {
  const parts = [member.name];
  if (member.position) parts.push(member.position);
  parts.push((member.orgId === null ? null : orgNameById.get(member.orgId)) ?? '소속 없음');
  parts.push(member.annualSalary === null ? '연봉 미입력' : won(member.annualSalary));
  if (!member.active) parts.push('비활성');
  return parts.join(' · ');
}
