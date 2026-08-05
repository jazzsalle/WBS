'use server';

// 간트 조회 모델 (SOT §9 getGanttData, §7.5)
// 쓰기 액션은 두지 않는다 — 막대 드래그 저장은 기존 updateTask(actions/tasks.ts)를 그대로 쓴다.
// 여기서 진척률·WBS 코드·날짜 롤업을 다시 계산하지 않는다: getProjectFullTree가 이미
// 계산해 내려주는 값을 그대로 실어 보낸다 (§6.1 O-4, §6.1.1 P-14~P-16).
// supabase 직접 호출 없음 — 조회는 기존 액션 조합으로만 한다 (§8.6).

import { z } from 'zod';
import type { ActionResult, Milestone, Project, Stage, Year } from '@/types';
import { getProjectFullTree, type WbsNode } from '@/actions/tasks';
import { getMilestonesData } from '@/actions/milestones';
import { GANTT_SCALES, type GanttScale } from '@/lib/gantt';
import { todayISO } from '@/lib/dates';
import { ValidationError, toActionFailure } from '@/lib/db/errors';

// ─── 조회 모델 ────────────────────────────────────────────────

export interface GanttYearGroup {
  year: Year;
  /** 진척률·WBS코드·날짜롤업이 계산된 트리 (getProjectFullTree의 결과 그대로) */
  nodes: WbsNode[];
  yearProgress: number;
}

export interface GanttData {
  project: Project;
  stages: Stage[];
  /** 좌측 패널의 "연차 > 작업 트리"와 배경 밴드의 원본 (§7.5) */
  years: GanttYearGroup[];
  /** 상단 마일스톤 레인 (§7.5). 날짜 오름차순 */
  milestones: Milestone[];
  /** 요청 스케일을 검증해 되돌려준다 — 화면의 초깃값이 된다 */
  scale: GanttScale;
  /** §6.5 기준일. 오늘 세로 기준선과 지연 판정은 반드시 이 값을 쓴다 (클라이언트가 만들지 않는다) */
  todayISO: string;
  /** 트리에 편입되지 못한 작업 (절대 규칙 5: 조용히 버리지 않는다) */
  invalidTaskIds: string[];
  /** §6.5 마일스톤 임박 판정 일수 */
  milestoneAlertDays: number;
}

const uuidSchema = z.uuid();
const scaleSchema = z.enum(GANTT_SCALES);

/**
 * §9 getGanttData(projectId, scale).
 *
 * scale은 서버 데이터에 영향을 주지 않는다(1일 px는 화면 상수다). 그래도 인자로 받는 이유는
 * URL 쿼리(?scale=)를 화면이 직접 신뢰하지 않게 하려는 것이다 — 여기서 검증한 값만 초깃값이 된다.
 * 잘못된 값은 조용히 기본값으로 덮지 않고 VALIDATION 실패로 알린다 (절대 규칙 5).
 */
export async function getGanttData(
  projectId: string,
  scale: unknown = 'week'
): Promise<ActionResult<GanttData>> {
  try {
    const pid = uuidSchema.safeParse(projectId);
    if (!pid.success) throw new ValidationError('과제 ID 형식이 올바르지 않습니다.');

    const parsedScale = scaleSchema.safeParse(scale);
    if (!parsedScale.success) {
      throw new ValidationError("시간축 스케일은 'day' · 'week' · 'month' 중 하나여야 합니다.");
    }

    // 트리(진척률·날짜 롤업)와 마일스톤은 서로 기다릴 이유가 없어 함께 던진다.
    // 하나라도 실패하면 실패를 그대로 올린다 — 빈 배열 폴백은 데이터 손상을 감춘다 (절대 규칙 5).
    const [full, milestones] = await Promise.all([
      getProjectFullTree(pid.data),
      getMilestonesData(pid.data),
    ]);
    if (!full.ok) return full;
    if (!milestones.ok) return milestones;

    return {
      ok: true,
      data: {
        project: full.data.project,
        stages: full.data.stages,
        years: full.data.years,
        // 레인은 시간순으로 읽는다. 같은 날이면 제목순으로 고정해 렌더 순서가 흔들리지 않게 한다
        milestones: [...milestones.data.milestones].sort((a, b) =>
          a.date === b.date ? a.title.localeCompare(b.title, 'ko') : a.date < b.date ? -1 : 1
        ),
        scale: parsedScale.data,
        // §6.5: 기준일은 서버가 Asia/Seoul 달력으로 한 번만 만든다
        todayISO: todayISO(new Date()),
        invalidTaskIds: full.data.invalidTaskIds,
        milestoneAlertDays: milestones.data.milestoneAlertDays,
      },
    };
  } catch (e) {
    return toActionFailure(e);
  }
}
