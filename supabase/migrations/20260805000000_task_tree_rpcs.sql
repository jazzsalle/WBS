-- =============================================================================
-- Task 트리 조작 RPC (schema_version = 1 유지 — 함수 추가는 앱 계약을 바꾸지 않는다)
-- SOT §6.6 H-1·H-2·H-3·H-10·H-11·H-12, §8.3 X-2·X-3·X-4, §9 Task 액션
--
--  - X-4 : 순환(H-2)·깊이(H-3)·같은 과제(H-11) 검사는 DB 함수 안에서 한다.
--          클라이언트 검증만 믿지 않는다.
--  - X-3 : 재정렬은 한 번의 문장(unnest ... with ordinality)으로 일괄 갱신한다.
--  - X-2 : 셋 다 security invoker — RLS를 우회하지 않는다. invoker이므로 PUBLIC
--          기본 실행 권한이 있어도 tasks RLS가 그대로 걸린다(승인 사용자만 통과).
--          같은 이유로 create_year/delete_year 등 기존 invoker RPC도 revoke하지 않는다.
--  - 위반은 전부 raise exception(P0001) — 리포지토리가 RuleViolationError로 바꾼다.
--    조용한 부분 반영은 없다(전부 성공 아니면 트랜잭션 롤백).
-- =============================================================================

-- -----------------------------------------------------------------------------
-- move_task (H-1, H-2, H-3, H-10, H-12)
--   p_new_index: 대상 노드를 제거한 뒤의 새 형제 배열 기준 0-based 삽입 위치 (H-12).
--                범위를 벗어나면 양 끝으로 clamp한다.
-- -----------------------------------------------------------------------------
create or replace function public.move_task(
  p_task_id       uuid,
  p_new_parent_id uuid,
  p_new_index     integer
) returns void language plpgsql security invoker as $$
declare
  -- MAX_TASK_DEPTH = 10 (lib/constants.ts와 동일 정의, H-3)
  c_max_depth constant integer := 10;
  v_year_id         uuid;
  v_old_parent_id   uuid;
  v_parent_year_id  uuid;
  v_parent_depth    integer := 0;   -- 루트로 이동하면 0 (자식이 깊이 1이 된다)
  v_subtree_height  integer;
  v_is_cycle        boolean := false;
  v_siblings        uuid[];
  v_index           integer;
begin
  select year_id, parent_id into v_year_id, v_old_parent_id
    from tasks where id = p_task_id;
  if not found then
    raise exception '작업을 찾을 수 없습니다';
  end if;

  -- H-2의 자명한 절반. 아래 조상 순회로도 걸리지만 메시지를 구분해 준다
  if p_new_parent_id = p_task_id then
    raise exception '자기 자신을 부모로 지정할 수 없습니다';
  end if;

  if p_new_parent_id is not null then
    select year_id into v_parent_year_id from tasks where id = p_new_parent_id;
    if not found then
      raise exception '부모 작업을 찾을 수 없습니다';
    end if;
    -- H-1: 연차 간 부모-자식 관계 금지
    if v_parent_year_id <> v_year_id then
      raise exception '다른 연차의 작업을 부모로 지정할 수 없습니다';
    end if;

    -- 새 부모의 조상 경로를 거슬러 올라가며 순환(H-2)과 깊이(H-3)를 한 번에 구한다.
    -- 루트 = 깊이 1이므로 시작 노드(새 부모)의 depth는 1이다.
    with recursive ancestors as (
      select id, parent_id, 1 as depth from tasks where id = p_new_parent_id
      union all
      select t.id, t.parent_id, a.depth + 1
        from tasks t join ancestors a on t.id = a.parent_id
    )
    select max(depth), bool_or(id = p_task_id)
      into v_parent_depth, v_is_cycle
      from ancestors;

    if v_is_cycle then
      raise exception '자손을 부모로 지정할 수 없습니다';
    end if;
  end if;

  -- 이동 대상 서브트리의 높이(대상 단독이면 1)
  with recursive subtree as (
    select id, 1 as height from tasks where id = p_task_id
    union all
    select t.id, s.height + 1
      from tasks t join subtree s on t.parent_id = s.id
  )
  select max(height) into v_subtree_height from subtree;

  -- H-3: 새 부모의 깊이 + 서브트리 높이가 최대 깊이를 넘으면 거부
  if v_parent_depth + v_subtree_height > c_max_depth then
    raise exception '작업 깊이는 최대 %단계입니다', c_max_depth;
  end if;

  -- H-12: 대상을 제거한 새 형제 배열을 만들고 p_new_index 위치에 끼워 넣는다
  select coalesce(array_agg(id order by sort_order, created_at, id), '{}'::uuid[])
    into v_siblings
    from tasks
   where year_id = v_year_id
     and parent_id is not distinct from p_new_parent_id
     and id <> p_task_id;

  v_index := least(
    greatest(coalesce(p_new_index, cardinality(v_siblings)), 0),
    cardinality(v_siblings)
  );
  v_siblings := v_siblings[1 : v_index]
             || p_task_id
             || v_siblings[v_index + 1 : cardinality(v_siblings)];

  -- H-10: 새 부모 그룹을 0..n-1로 normalize. 값이 그대로인 행은 건드리지 않는다
  -- (불필요한 version 증가 = 남의 낙관적 잠금을 깨뜨리는 일이다)
  update tasks t
     set parent_id  = p_new_parent_id,
         sort_order = (o.ord - 1)::integer,
         updated_by = auth.uid()
    from unnest(v_siblings) with ordinality as o(id, ord)
   where t.id = o.id
     and (t.parent_id is distinct from p_new_parent_id
          or t.sort_order is distinct from (o.ord - 1)::integer);

  -- H-10: 구 부모 그룹에 생긴 구멍도 메운다 (대상은 위 update로 이미 빠져나갔다)
  if v_old_parent_id is distinct from p_new_parent_id then
    update tasks t
       set sort_order = (o.ord - 1)::integer,
           updated_by = auth.uid()
      from (
        select id, row_number() over (order by sort_order, created_at, id) as ord
          from tasks
         where year_id = v_year_id
           and parent_id is not distinct from v_old_parent_id
      ) o
     where t.id = o.id
       and t.sort_order is distinct from (o.ord - 1)::integer;
  end if;
end; $$;

-- -----------------------------------------------------------------------------
-- move_task_to_year (H-11, H-10)
--   자손 전체가 함께 이동하고(부모-자식 관계 보존), 대상은 새 연차의 루트가 된다.
--   같은 과제 내 연차로만 이동 가능하다 — 다른 과제로 옮기면 담당자·기관·목표
--   연계가 전부 남의 과제를 가리키게 된다.
-- -----------------------------------------------------------------------------
create or replace function public.move_task_to_year(
  p_task_id     uuid,
  p_new_year_id uuid
) returns void language plpgsql security invoker as $$
declare
  v_project_id     uuid;
  v_old_year_id    uuid;
  v_old_parent_id  uuid;
  v_new_project_id uuid;
  v_order          integer;
begin
  select project_id, year_id, parent_id
    into v_project_id, v_old_year_id, v_old_parent_id
    from tasks where id = p_task_id;
  if not found then
    raise exception '작업을 찾을 수 없습니다';
  end if;

  select project_id into v_new_project_id from years where id = p_new_year_id;
  if not found then
    raise exception '연차를 찾을 수 없습니다';
  end if;
  -- H-11: 같은 과제 내 연차로만
  if v_new_project_id <> v_project_id then
    raise exception '같은 과제의 연차로만 이동할 수 있습니다';
  end if;

  -- H-11: 대상 + 전 자손의 year_id 일괄 갱신 (parent_id는 그대로 두어 관계 보존)
  with recursive subtree as (
    select id from tasks where id = p_task_id
    union all
    select t.id from tasks t join subtree s on t.parent_id = s.id
  )
  update tasks t
     set year_id    = p_new_year_id,
         updated_by = auth.uid()
    from subtree s
   where t.id = s.id
     and t.year_id is distinct from p_new_year_id;

  -- 대상은 새 연차의 루트 말단으로 (H-1을 만족하는 유일한 안전한 방법)
  select coalesce(max(sort_order), -1) + 1 into v_order
    from tasks
   where year_id = p_new_year_id and parent_id is null and id <> p_task_id;

  update tasks
     set parent_id  = null,
         sort_order = v_order,
         updated_by = auth.uid()
   where id = p_task_id;

  -- H-10: 대상이 빠져나간 구 부모 그룹 normalize
  update tasks t
     set sort_order = (o.ord - 1)::integer,
         updated_by = auth.uid()
    from (
      select id, row_number() over (order by sort_order, created_at, id) as ord
        from tasks
       where year_id = v_old_year_id
         and parent_id is not distinct from v_old_parent_id
         and id <> p_task_id
    ) o
   where t.id = o.id
     and t.sort_order is distinct from (o.ord - 1)::integer;
end; $$;

-- -----------------------------------------------------------------------------
-- reorder_tasks (H-10, X-3)
--   p_ordered_ids는 (p_year_id, p_parent_id) 컨테이너의 자식 전체여야 한다.
--   누락·초과·중복은 전부 거부한다 — 조용한 부분 반영은 데이터를 망가뜨린다.
-- -----------------------------------------------------------------------------
create or replace function public.reorder_tasks(
  p_year_id     uuid,
  p_parent_id   uuid,
  p_ordered_ids uuid[]
) returns void language plpgsql security invoker as $$
declare
  v_given  integer := coalesce(cardinality(p_ordered_ids), 0);
  v_actual integer;
begin
  if exists (
    select 1 from unnest(coalesce(p_ordered_ids, '{}'::uuid[])) as u(id)
     group by u.id having count(*) > 1
  ) then
    raise exception '재정렬 목록에 중복된 작업이 있습니다';
  end if;

  select count(*) into v_actual
    from tasks
   where year_id = p_year_id and parent_id is not distinct from p_parent_id;

  -- 개수 일치 + 전원 소속 확인 = 집합 일치 (중복은 위에서 이미 걸렀다)
  if v_given <> v_actual then
    raise exception '재정렬 목록이 실제 하위 작업 %개와 다릅니다 (%개 전달)', v_actual, v_given;
  end if;
  if exists (
    select 1 from unnest(coalesce(p_ordered_ids, '{}'::uuid[])) as u(id)
     where not exists (
       select 1 from tasks t
        where t.id = u.id
          and t.year_id = p_year_id
          and t.parent_id is not distinct from p_parent_id
     )
  ) then
    raise exception '재정렬 목록에 이 위치의 작업이 아닌 항목이 있습니다';
  end if;

  update tasks t
     set sort_order = (o.ord - 1)::integer,
         updated_by = auth.uid()
    from unnest(p_ordered_ids) with ordinality as o(id, ord)
   where t.id = o.id
     and t.sort_order is distinct from (o.ord - 1)::integer;
end; $$;
