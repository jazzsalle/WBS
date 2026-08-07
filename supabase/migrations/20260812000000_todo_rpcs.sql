-- =============================================================================
-- To-Do RPC — 전역 To-Do 목록 재정렬
-- SOT §5.15, §7.13(T-D9, T-D10), §8.3(X-2, X-3)
--
-- security invoker (X-2) — RLS를 우회하지 않는다. definer 예외 목록에 없다.
-- 재정렬은 여러 행을 한 트랜잭션으로 갱신해야 하므로 RPC로 만든다 (X-3).
-- todos 테이블의 RLS·realtime publication은 20260802000000_initial_schema.sql에
-- 이미 등록돼 있다 — 여기서 다시 손대지 않는다.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- reorder_todos (X-3) — 컨테이너가 없다
--   To-Do는 과제 계층에 매이지 않는 전역 단일 리스트다(§5.15, §7.13). 다른
--   reorder RPC와 달리 소속을 검증할 p_project_id가 없다.
--
--   T-D10: 화면은 필터가 걸린 채로 드래그해도 숨겨진 항목까지 포함한 "전체 순서"를
--   보낸다. 부분 배열이 올 일이 없으므로 "배열 길이 = 갱신 행 수"를 엄격히 검사할 수
--   있고, 존재하지 않는 id나 중복된 id를 조용히 넘기지 않는다.
-- -----------------------------------------------------------------------------
create or replace function public.reorder_todos(p_ordered_ids uuid[])
returns void language plpgsql security invoker as $$
declare
  v_expected integer := coalesce(array_length(p_ordered_ids, 1), 0);
  v_updated  integer;
begin
  if v_expected = 0 then
    return;
  end if;

  update todos t
     set sort_order = o.ord - 1,
         updated_by = auth.uid()
    from unnest(p_ordered_ids) with ordinality as o(id, ord)
   where t.id = o.id;
  get diagnostics v_updated = row_count;

  -- T-D10 덕분에 가능한 엄격 검사 — 화면은 항상 전체 순서를 보낸다
  if v_updated <> v_expected then
    raise exception '재정렬 대상 To-Do를 찾을 수 없거나 중복된 항목이 있습니다';
  end if;
end; $$;
