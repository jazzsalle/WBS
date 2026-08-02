'use server';

// 대시보드 조회 액션 (SOT §9 조회 getDashboardData, §7.2, SA-1, SA-4)
// 서버 컴포넌트가 직접 호출하고 집계 완료 형태를 받는다.
//
// supabase 직접 호출 금지 — 조회는 lib/db/dashboard.ts(벌크 리포지토리)만 거친다 (§8.6).
// 계산은 전부 lib/dashboard.ts(순수)가 하고 여기서는 공식을 다시 쓰지 않는다.

import type { ActionResult } from '@/types';
import { requireApprovedUser } from '@/lib/auth/guard';
import { fetchDashboardSource } from '@/lib/db/dashboard';
import { toActionFailure } from '@/lib/db/errors';
import { computeDashboard, type DashboardData } from '@/lib/dashboard';
import { todayISO } from '@/lib/dates';

export type {
  AttentionItem,
  AttentionKind,
  DashboardData,
  DashboardMetrics,
  FocusTaskItem,
  ProjectSummaryCard,
  TodayTodoItem,
  UpcomingMilestoneItem,
} from '@/lib/dashboard';

export async function getDashboardData(): Promise<ActionResult<DashboardData>> {
  try {
    const { client } = await requireApprovedUser();
    const source = await fetchDashboardSource(client);

    // §6.5: 기준일은 서버가 Asia/Seoul 달력으로 한 번 만들어 내려보낸다.
    // 순수 집계는 오늘을 스스로 만들지 않는다.
    return {
      ok: true,
      data: computeDashboard({
        projects: source.projects,
        stages: source.stages,
        years: source.years,
        tasks: source.tasks,
        milestones: source.milestones,
        risks: source.risks,
        budgetItems: source.budgetItems,
        deliverables: source.deliverables,
        techTargets: source.techTargets,
        todos: source.todos,
        todayISO: todayISO(new Date()),
        settings: {
          progressWeightBasis: source.settings.progressWeightBasis,
          milestoneAlertDays: source.settings.milestoneAlertDays,
          dueSoonDays: source.settings.dueSoonDays,
          currencyUnit: source.settings.currencyUnit,
        },
      }),
    };
  } catch (e) {
    // 조회 실패를 빈 대시보드로 감추지 않는다 (절대 규칙 5). SA-4: 내부 정보는 노출하지 않는다
    return toActionFailure(e);
  }
}
