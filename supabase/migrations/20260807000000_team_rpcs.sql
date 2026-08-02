-- =============================================================================
-- 팀 RPC — 참여인력 삭제(H-9), 주관기관 재지정(H-8), 기관·인력 재정렬(H-10)
-- SOT §5.10, §5.11, §6.6(H-8, H-9, H-10), §8.3(X-1, X-3), §9 Organization/Member
--
-- 전부 security invoker (X-2) — RLS를 우회하지 않는다.
-- 여러 테이블을 한 트랜잭션으로 묶어야 하는 작업만 RPC로 만든다 (X-1).
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. count_member_references (H-9)
--    삭제 확인 대화상자가 "정리될 참조"를 미리 보여주기 위한 읽기 전용 집계.
--    H-9가 규정한 참조 위치는 정확히 이 8곳이다 — 여기와 delete_member가 같은
--    함수를 쓰게 해서 목록이 두 곳에서 어긋나지 않게 한다.
--    대상이 없으면 0 8개를 돌려주지 않고 실패시킨다 — 없는 대상에 대한 집계는
--    "참조 없음"과 구분되지 않아 조용한 오답이 된다.
-- -----------------------------------------------------------------------------
create or replace function public.count_member_references(p_member_id uuid)
returns jsonb language plpgsql stable security invoker as $$
begin
  if not exists (select 1 from members where id = p_member_id) then
    raise exception '참여인력을 찾을 수 없습니다';
  end if;

  return jsonb_build_object(
    'tasks',               (select count(*) from tasks               where owner_member_id = p_member_id),
    'task_members',        (select count(*) from task_members        where member_id       = p_member_id),
    'milestones',          (select count(*) from milestones          where owner_member_id = p_member_id),
    'risks',               (select count(*) from risks               where owner_member_id = p_member_id),
    'projects',            (select count(*) from projects            where pm_member_id    = p_member_id),
    'achievement_members', (select count(*) from achievement_members where member_id       = p_member_id),
    'note_attendees',      (select count(*) from note_attendees      where member_id       = p_member_id),
    'app_users',           (select count(*) from app_users           where member_id       = p_member_id)
  );
end; $$;

-- -----------------------------------------------------------------------------
-- 2. delete_member (H-9)
--    삭제 전에 8곳의 참조 건수를 세어 돌려준다 — UI가 "정리된 참조"를 안내한다.
--    단일 참조(tasks/milestones/risks/projects)는 FK on delete set null(N-8)로도
--    처리되지만 delete_year 선례대로 명시적 update로 의도를 남긴다.
--    조인 테이블(task_members/achievement_members/note_attendees)은 cascade(N-2)에 맡긴다.
-- -----------------------------------------------------------------------------
create or replace function public.delete_member(p_member_id uuid)
returns jsonb language plpgsql security invoker as $$
declare
  v_counts  jsonb;
  v_deleted integer;
begin
  v_counts := count_member_references(p_member_id);  -- 대상이 없으면 여기서 실패한다

  update tasks      set owner_member_id = null where owner_member_id = p_member_id;
  update milestones set owner_member_id = null where owner_member_id = p_member_id;
  update risks      set owner_member_id = null where owner_member_id = p_member_id;
  update projects   set pm_member_id    = null where pm_member_id    = p_member_id;

  -- app_users.member_id는 명시적 update를 쓰지 않는다: app_users의 RLS UPDATE 정책은
  -- id = auth.uid()(본인 행)뿐이라 남의 행 갱신이 에러 없이 0행이 되어 조용히 누락된다.
  -- FK on delete set null(N-8)은 RI 트리거가 테이블 소유자 권한으로 수행하므로
  -- RLS와 무관하게 반드시 적용된다. 여기서는 건수만 센다.

  delete from members where id = p_member_id;
  get diagnostics v_deleted = row_count;
  if v_deleted <> 1 then
    raise exception '참여인력 삭제에 실패했습니다';
  end if;

  return v_counts;
end; $$;

-- -----------------------------------------------------------------------------
-- 3. set_lead_organization (H-8)
--    과제당 주관기관은 항상 정확히 1개다. 세 갱신이 한 트랜잭션이어야
--    "lead 0개/2개" 중간 상태가 남지 않고 H-8의 주관기관 삭제 차단 판정이 유지된다.
-- -----------------------------------------------------------------------------
create or replace function public.set_lead_organization(p_project_id uuid, p_org_id uuid)
returns void language plpgsql security invoker as $$
begin
  if not exists (
    select 1 from organizations where id = p_org_id and project_id = p_project_id
  ) then
    raise exception '대상 기관이 이 과제에 속하지 않습니다';
  end if;

  -- ① 기존 주관을 공동으로 강등
  update organizations
     set role = 'joint', updated_by = auth.uid()
   where project_id = p_project_id and id <> p_org_id and role = 'lead';

  -- ② 대상을 주관으로
  update organizations
     set role = 'lead', updated_by = auth.uid()
   where id = p_org_id;

  -- ③ 과제의 주관기관 포인터 갱신
  update projects
     set lead_org_id = p_org_id, updated_by = auth.uid()
   where id = p_project_id;
end; $$;

-- -----------------------------------------------------------------------------
-- 4. reorder_organizations (X-3, H-10) — 컨테이너는 project
-- -----------------------------------------------------------------------------
create or replace function public.reorder_organizations(p_project_id uuid, p_ordered_ids uuid[])
returns void language plpgsql security invoker as $$
declare
  v_expected integer := coalesce(array_length(p_ordered_ids, 1), 0);
  v_updated  integer;
begin
  if v_expected = 0 then
    return;
  end if;

  update organizations o
     set sort_order = t.ord - 1,
         updated_by = auth.uid()
    from unnest(p_ordered_ids) with ordinality as t(id, ord)
   where o.id = t.id and o.project_id = p_project_id;
  get diagnostics v_updated = row_count;

  -- 다른 과제의 기관 id가 섞이면 나머지 기관의 order가 깨진다 — 명시적으로 실패시킨다
  if v_updated <> v_expected then
    raise exception '재정렬 대상 기관이 이 과제에 속하지 않거나 중복된 항목이 있습니다';
  end if;
end; $$;

-- -----------------------------------------------------------------------------
-- 5. reorder_members (X-3, H-10) — 컨테이너는 project
-- -----------------------------------------------------------------------------
create or replace function public.reorder_members(p_project_id uuid, p_ordered_ids uuid[])
returns void language plpgsql security invoker as $$
declare
  v_expected integer := coalesce(array_length(p_ordered_ids, 1), 0);
  v_updated  integer;
begin
  if v_expected = 0 then
    return;
  end if;

  update members m
     set sort_order = t.ord - 1,
         updated_by = auth.uid()
    from unnest(p_ordered_ids) with ordinality as t(id, ord)
   where m.id = t.id and m.project_id = p_project_id;
  get diagnostics v_updated = row_count;

  if v_updated <> v_expected then
    raise exception '재정렬 대상 인력이 이 과제에 속하지 않거나 중복된 항목이 있습니다';
  end if;
end; $$;
