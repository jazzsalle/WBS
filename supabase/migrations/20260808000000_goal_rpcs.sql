-- =============================================================================
-- 목표 재정렬 RPC — 성과목표(Deliverable)·기술목표(TechTarget) 순서 일괄 갱신
-- SOT §5.8, §5.9, §6.6(H-10), §8.3(X-2, X-3), §9 SA-3 / Deliverable·TechTarget
--
--  - X-3 : 재정렬은 한 번의 문장(unnest ... with ordinality)으로 일괄 갱신한다.
--          행마다 호출하지 않는다.
--  - X-2 : 둘 다 security invoker — RLS를 우회하지 않는다. invoker이므로 PUBLIC
--          기본 실행 권한이 있어도 각 테이블 RLS가 그대로 걸린다(승인 사용자만 통과).
--  - H-10: 컨테이너는 project. sort_order를 0..n-1 연속 정수로 다시 매긴다.
--  - 위반은 raise exception(P0001) — 리포지토리가 RuleViolationError로 바꾼다.
--    부분 반영은 없다(전부 성공 아니면 트랜잭션 롤백).
--
-- reorder_organizations/reorder_members(20260807000000)와 동일 시맨틱이다.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. reorder_deliverables (X-3, H-10) — 컨테이너는 project
-- -----------------------------------------------------------------------------
create or replace function public.reorder_deliverables(p_project_id uuid, p_ordered_ids uuid[])
returns void language plpgsql security invoker as $$
declare
  v_expected integer := coalesce(array_length(p_ordered_ids, 1), 0);
  v_updated  integer;
begin
  if v_expected = 0 then
    return;
  end if;

  update deliverables d
     set sort_order = t.ord - 1,
         updated_by = auth.uid()
    from unnest(p_ordered_ids) with ordinality as t(id, ord)
   where d.id = t.id and d.project_id = p_project_id;
  get diagnostics v_updated = row_count;

  -- 다른 과제의 목표 id가 섞이거나 같은 id가 중복되면 나머지 목표의 order가 깨진다
  -- (갱신은 대상 행마다 한 번뿐이라 중복은 건수 부족으로 드러난다) — 명시적으로 실패시킨다
  if v_updated <> v_expected then
    raise exception '재정렬 대상 성과목표가 이 과제에 속하지 않거나 중복된 항목이 있습니다';
  end if;
end; $$;

-- -----------------------------------------------------------------------------
-- 2. reorder_tech_targets (X-3, H-10) — 컨테이너는 project
-- -----------------------------------------------------------------------------
create or replace function public.reorder_tech_targets(p_project_id uuid, p_ordered_ids uuid[])
returns void language plpgsql security invoker as $$
declare
  v_expected integer := coalesce(array_length(p_ordered_ids, 1), 0);
  v_updated  integer;
begin
  if v_expected = 0 then
    return;
  end if;

  update tech_targets tt
     set sort_order = t.ord - 1,
         updated_by = auth.uid()
    from unnest(p_ordered_ids) with ordinality as t(id, ord)
   where tt.id = t.id and tt.project_id = p_project_id;
  get diagnostics v_updated = row_count;

  if v_updated <> v_expected then
    raise exception '재정렬 대상 기술목표가 이 과제에 속하지 않거나 중복된 항목이 있습니다';
  end if;
end; $$;
