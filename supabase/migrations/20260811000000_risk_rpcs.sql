-- =============================================================================
-- 리스크 RPC — 리스크 관리대장 재정렬
-- SOT §5.13, §7.11, §8.3(X-1, X-3), §9 Risk
--
-- security invoker (X-2) — RLS를 우회하지 않는다.
-- 재정렬은 여러 행을 한 트랜잭션으로 갱신해야 하므로 RPC로 만든다 (X-3).
-- 형태는 20260807000000_team_rpcs.sql의 reorder_organizations/reorder_members와 같다 —
-- 컨테이너(과제) 소속 검증을 포함해 남의 과제 리스크가 섞이면 실패시킨다.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- reorder_risks (X-3) — 컨테이너는 project
--   risks에는 연차·작업 계층이 없다(§5.13: year_id·task_id는 선택 참조). 순서는
--   과제 단위 하나뿐이므로 컨테이너도 project다.
-- -----------------------------------------------------------------------------
create or replace function public.reorder_risks(p_project_id uuid, p_ordered_ids uuid[])
returns void language plpgsql security invoker as $$
declare
  v_expected integer := coalesce(array_length(p_ordered_ids, 1), 0);
  v_updated  integer;
begin
  if v_expected = 0 then
    return;
  end if;

  update risks r
     set sort_order = t.ord - 1,
         updated_by = auth.uid()
    from unnest(p_ordered_ids) with ordinality as t(id, ord)
   where r.id = t.id and r.project_id = p_project_id;
  get diagnostics v_updated = row_count;

  -- 다른 과제의 리스크 id가 섞이면 나머지 리스크의 order가 깨진다 — 명시적으로 실패시킨다
  if v_updated <> v_expected then
    raise exception '재정렬 대상 리스크가 이 과제에 속하지 않거나 중복된 항목이 있습니다';
  end if;
end; $$;
