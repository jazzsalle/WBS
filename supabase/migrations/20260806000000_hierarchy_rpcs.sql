-- =============================================================================
-- 계층 RPC — 과제 생성 기본값, 순서 재정렬, 연차 상태
-- SOT §5.4, §5.5, §6.6(H-10), §8.3(X-1, X-3), §9 Project/Stage/Year 액션 목록
--
-- 전부 security invoker (X-2) — RLS를 우회하지 않는다.
-- 다중 테이블·다중 행을 한 트랜잭션으로 묶어야 하는 작업만 RPC로 만든다 (X-1).
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. create_project_with_defaults (§9 createProject)
--    Project + Stage 1개 + Year 1개를 한 트랜잭션으로 만든다.
--    Year 삽입·비목 12종 생성은 기존 create_year RPC(§5.5)에 위임한다 — 규칙이 두 곳에
--    복제되면 반드시 어긋나므로 여기서 재구현하지 않는다.
-- -----------------------------------------------------------------------------
create or replace function public.create_project_with_defaults(
  p_name                text default '',
  p_project_no          text default '',
  p_ministry            text default '',
  p_agency              text default '',
  p_program_name        text default '',
  p_description         text default '',
  p_status              text default 'planning',
  p_color               text default '',
  p_contract_start_date date default null,
  p_contract_end_date   date default null,
  p_total_budget        bigint default null,
  p_gov_budget          bigint default null,
  p_own_budget          bigint default null
) returns uuid language plpgsql security invoker as $$
declare
  v_project_id uuid;
  v_stage_id   uuid;
  v_order      integer;
  v_year_end   date;
begin
  -- 새 과제는 목록 맨 뒤에 붙는다 (§7.15 order 수동 정렬)
  select coalesce(max(sort_order), -1) + 1 into v_order from projects;

  insert into projects (name, project_no, ministry, agency, program_name, description,
                        status, color, contract_start_date, contract_end_date,
                        total_budget, gov_budget, own_budget, sort_order,
                        created_by, updated_by)
  values (coalesce(p_name, ''), coalesce(p_project_no, ''), coalesce(p_ministry, ''),
          coalesce(p_agency, ''), coalesce(p_program_name, ''), coalesce(p_description, ''),
          coalesce(p_status, 'planning'), coalesce(p_color, ''),
          p_contract_start_date, p_contract_end_date,
          p_total_budget, p_gov_budget, p_own_budget, v_order,
          auth.uid(), auth.uid())
  returning id into v_project_id;

  -- 단일 단계 과제도 Stage 1개를 반드시 갖는다 (§5.4)
  insert into stages (project_id, sort_order, name, created_by, updated_by)
  values (v_project_id, 0, '1단계', auth.uid(), auth.uid())
  returning id into v_stage_id;

  -- Year 기본값 (§9): 협약시작일 ~ +1년-1일. 협약시작일이 없으면 기간 미정.
  -- name은 ''로 두고 표시할 때 §5.5 폴백('1차년도')을 쓴다.
  v_year_end := case
    when p_contract_start_date is null then null
    else (p_contract_start_date + interval '1 year' - interval '1 day')::date
  end;

  perform create_year(
    p_stage_id   => v_stage_id,
    p_name       => '',
    p_goal       => '',
    p_start_date => p_contract_start_date,
    p_end_date   => v_year_end,
    p_budget     => null,
    p_status     => 'planned'
  );

  return v_project_id;
end; $$;

-- -----------------------------------------------------------------------------
-- 2. reorder_projects (X-3, H-10)
--    넘어온 순서대로 0..n-1을 부여한다. 행마다 호출하지 않는다.
--    아카이브 과제는 목록에서 기본 숨김(§7.15)이라 부분 배열이 올 수 있으므로
--    "과제 전체" 완전성은 요구하지 않는다. 다만 존재하지 않는 id는 조용히 넘기지 않는다.
-- -----------------------------------------------------------------------------
create or replace function public.reorder_projects(p_ordered_ids uuid[])
returns void language plpgsql security invoker as $$
declare
  v_expected integer := coalesce(array_length(p_ordered_ids, 1), 0);
  v_updated  integer;
begin
  if v_expected = 0 then
    return;
  end if;

  update projects p
     set sort_order = t.ord - 1,
         updated_by = auth.uid()
    from unnest(p_ordered_ids) with ordinality as t(id, ord)
   where p.id = t.id;
  get diagnostics v_updated = row_count;

  if v_updated <> v_expected then
    raise exception '재정렬 대상 과제를 찾을 수 없거나 중복된 항목이 있습니다';
  end if;
end; $$;

-- -----------------------------------------------------------------------------
-- 3. reorder_stages (X-3, H-10) — 컨테이너는 project
-- -----------------------------------------------------------------------------
create or replace function public.reorder_stages(p_project_id uuid, p_ordered_ids uuid[])
returns void language plpgsql security invoker as $$
declare
  v_expected integer := coalesce(array_length(p_ordered_ids, 1), 0);
  v_updated  integer;
begin
  if v_expected = 0 then
    return;
  end if;

  update stages s
     set sort_order = t.ord - 1,
         updated_by = auth.uid()
    from unnest(p_ordered_ids) with ordinality as t(id, ord)
   where s.id = t.id and s.project_id = p_project_id;
  get diagnostics v_updated = row_count;

  -- 다른 과제의 단계 id가 섞이면 나머지 단계의 order가 깨진다 — 명시적으로 실패시킨다
  if v_updated <> v_expected then
    raise exception '재정렬 대상 단계가 이 과제에 속하지 않거나 중복된 항목이 있습니다';
  end if;
end; $$;

-- -----------------------------------------------------------------------------
-- 4. reorder_years (X-3, H-10, §5.5) — 컨테이너는 project 전체.
--    unique(project_id, sort_order)가 걸려 있어 부분 배열은 곧 중복 order를 만든다.
--    그래서 과제의 모든 연차를 요구하고 0..n-1로 normalize한다.
--    또한 order는 "앞 단계의 마지막 < 뒷 단계의 첫"을 유지해야 하므로(§5.5)
--    단계 경계를 넘나드는 순서는 거부한다.
-- -----------------------------------------------------------------------------
create or replace function public.reorder_years(p_project_id uuid, p_ordered_ids uuid[])
returns void language plpgsql security invoker as $$
declare
  v_expected integer := coalesce(array_length(p_ordered_ids, 1), 0);
  v_total    integer;
  v_matched  integer;
  v_updated  integer;
  v_monotonic boolean;
begin
  select count(*) into v_total from years where project_id = p_project_id;

  if v_expected <> v_total then
    raise exception '연차 순서는 과제의 모든 연차를 포함해야 합니다';
  end if;
  if v_expected = 0 then
    return;
  end if;

  select count(distinct y.id) into v_matched
    from unnest(p_ordered_ids) as t(id)
    join years y on y.id = t.id and y.project_id = p_project_id;
  if v_matched <> v_expected then
    raise exception '재정렬 대상 연차가 이 과제에 속하지 않거나 중복된 항목이 있습니다';
  end if;

  -- 단계 sort_order 수열이 비내림차순이면 같은 단계가 연속 블록을 이루고
  -- 블록 순서도 단계 순서와 일치한다 — 두 조건을 한 번에 검사한다
  select bool_and(prev_order is null or prev_order <= cur_order) into v_monotonic
    from (
      select s.sort_order as cur_order,
             lag(s.sort_order) over (order by t.ord) as prev_order
        from unnest(p_ordered_ids) with ordinality as t(id, ord)
        join years y on y.id = t.id
        join stages s on s.id = y.stage_id
    ) q;

  if not coalesce(v_monotonic, true) then
    raise exception '연차 순서가 단계 경계를 넘을 수 없습니다';
  end if;

  -- years_project_order_key는 deferrable initially deferred라 일괄 갱신이 안전하다
  update years y
     set sort_order = t.ord - 1,
         updated_by = auth.uid()
    from unnest(p_ordered_ids) with ordinality as t(id, ord)
   where y.id = t.id and y.project_id = p_project_id;
  get diagnostics v_updated = row_count;

  if v_updated <> v_expected then
    raise exception '연차 순서 갱신에 실패했습니다';
  end if;
end; $$;

-- -----------------------------------------------------------------------------
-- 5. set_year_status (§5.5, §9)
--    status='active'는 과제당 1개 — 기존 active 연차를 'planned'로 되돌린 뒤 지정한다.
--    두 update가 한 트랜잭션이어야 "active 0개" 또는 "active 2개" 상태가 생기지 않는다.
-- -----------------------------------------------------------------------------
create or replace function public.set_year_status(p_year_id uuid, p_status text)
returns void language plpgsql security invoker as $$
declare
  v_project_id uuid;
begin
  if p_status not in ('planned', 'active', 'evaluating', 'closed') then
    raise exception '알 수 없는 연차 상태입니다';
  end if;

  select project_id into v_project_id from years where id = p_year_id;
  if v_project_id is null then
    raise exception '연차를 찾을 수 없습니다';
  end if;

  if p_status = 'active' then
    update years
       set status = 'planned', updated_by = auth.uid()
     where project_id = v_project_id and id <> p_year_id and status = 'active';
  end if;

  update years set status = p_status, updated_by = auth.uid() where id = p_year_id;
end; $$;
