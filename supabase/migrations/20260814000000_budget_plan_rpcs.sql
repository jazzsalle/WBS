-- =============================================================================
-- Phase 9 예산 제안 RPC — 산출근거 쓰기(PL-10 불변식) · 연봉 파급(PL-10b)
--                        · Member 삭제 차단(H-9a) · 임포트 잠금(S-14)
-- SOT §5.17(PL-D1~PL-D8), §6.10.2(PL-9·PL-10·PL-10a·PL-10b), §6.6 H-9a,
--     §6.8.2 S-14, §6.8.5 I-17·I-18, §8.3(X-1~X-3), §8.4 O-1, §9 Budget Plan
--
-- ⚠ PL-10a — **이 파일에는 금액 산식이 없다.**
--   `amount`는 서버 액션이 `lib/budget-plan.ts`(PL-1~PL-5)로 계산해 넘긴 값이고,
--   RPC는 축별로 `sum(amount)`만 한다. PL/pgSQL에 산식을 다시 구현하면 JS `Math.round`와
--   SQL `round()`가 음수 .5·부동소수점 경계에서 갈려 1원씩 어긋난다.
--   연봉 변경 파급(PL-10b)도 예외가 아니다 — `(id, amount)` 목록을 받아 **적용만** 한다.
--
--  - X-2 : 전부 security invoker. §8.3 X-2의 definer 예외 목록(handle_new_user,
--          approve_user, deactivate_user, is_approved, restore_backup)에 없다.
--          budget_details·budget_items·members의 "approved users full access"
--          (is_approved()) 정책이 호출자에게 그대로 적용된다.
--  - X-1 : budget_details와 budget_items를 한 트랜잭션으로 묶어야 하므로 RPC다.
--          단순 조회는 PostgREST를 직접 쓴다.
--  - N-5 : version +1과 updated_at은 set_updated_meta 트리거가 올린다.
--          여기서는 updated_by(auth.uid())만 채운다.
--  - N-13: FK는 "이 연차·이 인력이 이 과제 것인가"를 막지 못한다 (PL-D2). RPC가 거부한다.
--
-- ─ 예외 규약 (lib/db/budget-details.ts의 판정 규칙과 짝이다) ─────────────────
--  PostgREST는 PL/pgSQL의 `raise exception`을 전부 SQLSTATE `P0001` 하나로 내려보낸다.
--  그래서 리포지토리는 **메시지 문자열로** 종류를 가른다. 아래 문구를 바꾸면
--  lib/db/budget-details.ts의 정규식도 같이 바꿔야 한다 — 어긋나면 STALE이 일반 규칙
--  위반으로 둔갑해 §8.4 O-3 비교 다이얼로그가 뜨지 않는다.
--    · 낙관적 잠금 실패(O-1) → 반드시 '다른 사람이 먼저 수정했습니다…' (/먼저 수정/)
--    · 대상 없음             → '…를 찾을 수 없습니다'                 (/찾을 수 없습니다/)
--    · 그 외 전부            → RuleViolationError로 매핑된다
--  O-3 표시용 `updated_by`는 예외에 실을 수 없으므로 리포지토리가 대상 행을 한 번 더 읽는다.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 0. sync_budget_item_from_details — PL-10 불변식의 단 하나의 구현 (내부 헬퍼)
--
--    산출근거를 건드린 모든 RPC가 **같은 트랜잭션 안에서** 이 함수를 부른다.
--    액션이 두 번 호출하는 방식은 금지 — 사이에서 실패하면 총액이 근거와 어긋난 채 남는다.
--
--    PL-10a: 여기서 하는 일은 축별 `sum(amount)`뿐이다. 산식은 없다.
--    PL-9  : 남은 행이 0이면 **아무것도 쓰지 않는다.** 잠금만 풀리고 직전 합계가 그대로
--            남아야 한다 — 근거를 지웠다고 예산이 사라져야 할 이유가 없고, 사용자가
--            이어서 손으로 고칠 수 있어야 한다.
--    값이 이미 합계와 같으면 UPDATE 자체를 건너뛴다 — 불필요한 version 증가는
--    남의 낙관적 잠금을 깨뜨리는 일이다(재정렬처럼 금액이 안 바뀌는 경로가 있다).
-- -----------------------------------------------------------------------------
create or replace function public.sync_budget_item_from_details(
  p_project_id uuid,
  p_year_id    uuid,
  p_category   text
) returns void language plpgsql security invoker as $$
declare
  v_count   integer;
  v_cash    bigint;
  v_in_kind bigint;
begin
  -- PL-7: cash = axis 'cash'의 합, in_kind = axis 'in_kind'의 합, planned = 둘의 합.
  -- PL-8: 이미 정수인 행 금액을 더할 뿐이라 추가 반올림이 없다.
  select count(*),
         coalesce(sum(amount) filter (where axis = 'cash'), 0)::bigint,
         coalesce(sum(amount) filter (where axis = 'in_kind'), 0)::bigint
    into v_count, v_cash, v_in_kind
    from budget_details
   where year_id = p_year_id and category = p_category;

  if v_count = 0 then
    return;  -- PL-9: 잠금 해제. 직전 합계를 0으로 되돌리지 않는다
  end if;

  update budget_items
     set planned_amount = v_cash + v_in_kind,
         cash_amount    = v_cash,
         in_kind_amount = v_in_kind,
         updated_by     = auth.uid()
   where year_id = p_year_id
     and category = p_category
     and (planned_amount, cash_amount, in_kind_amount)
         is distinct from (v_cash + v_in_kind, v_cash, v_in_kind);

  -- create_year가 12종을 만들어 두므로 대개 위 UPDATE로 끝나지만, 과거 데이터나 수동
  -- 삭제로 행이 없을 수 있다. 없으면 만든다 — 근거만 있고 총액이 없는 상태를 남기지 않는다
  if not exists (
    select 1 from budget_items where year_id = p_year_id and category = p_category
  ) then
    insert into budget_items (project_id, year_id, category,
                              planned_amount, cash_amount, in_kind_amount,
                              created_by, updated_by)
    values (p_project_id, p_year_id, p_category,
            v_cash + v_in_kind, v_cash, v_in_kind, auth.uid(), auth.uid());
  end if;
end; $$;

-- 내부 헬퍼다. 앱은 세 쓰기 RPC를 거치고 이 함수를 직접 부르지 않는다.
-- security invoker라 호출자(authenticated)에게 EXECUTE가 있어야 다른 RPC가 부를 수 있다.
revoke execute on function public.sync_budget_item_from_details(uuid, uuid, text) from public, anon;
grant execute on function public.sync_budget_item_from_details(uuid, uuid, text) to authenticated;

-- -----------------------------------------------------------------------------
-- 1. upsert_budget_detail (§5.17, PL-10, O-1)
--    p_detail은 **DB 표기(snake_case) 행 전체**다. `id`가 없거나 null이면 insert,
--    있으면 update. 반환도 저장된 행 전체(jsonb)라 리포지토리가 매퍼로 그대로 옮긴다.
--    (`factors` 내부 키는 camelCase 그대로다 — jsonb passthrough라 변환하지 않는다)
--
--    **부분 패치를 받지 않는다.** 서버 액션이 현재 행과 패치를 합쳐 `lib/budget-plan.ts`로
--    amount까지 계산한 뒤 행 전체를 넘긴다 (PL-D7: 근거 필드가 바뀌면 amount도 반드시
--    같은 쓰기에서 다시 계산된다). 빠진 키는 "그대로 두기"가 아니라 기본값이다.
--
--    sort_order만 예외로 null(또는 키 없음)을 허용한다: insert면 그 세목 맨 끝, update면
--    현재 순서 유지. 순서는 근거 값이 아니라 배치라 reorder_budget_details가 따로 소유한다.
-- -----------------------------------------------------------------------------
create or replace function public.upsert_budget_detail(
  p_detail           jsonb,
  p_expected_version bigint default null
) returns jsonb language plpgsql security invoker as $$
declare
  v_row          public.budget_details;
  v_id           uuid;
  v_project_id   uuid;
  v_year_id      uuid;
  v_category     text;
  v_subcategory  text;
  v_axis         text;
  v_formula      text;
  v_member_id    uuid;
  v_amount       bigint;
  v_unit_price   bigint;
  v_adjustment   bigint;
  v_factors      jsonb;
  v_sort_given   integer;
  v_old_year     uuid;
  v_old_category text;
  v_sort         integer;
begin
  if p_detail is null or jsonb_typeof(p_detail) <> 'object' then
    raise exception '산출근거 데이터가 올바르지 않습니다';
  end if;

  -- jsonb → 지역 변수. 캐스팅이 형식을 강제한다(형식 오류면 여기서 실패한다)
  v_id          := nullif(p_detail ->> 'id', '')::uuid;
  v_project_id  := (p_detail ->> 'project_id')::uuid;
  v_year_id     := (p_detail ->> 'year_id')::uuid;
  v_category    := p_detail ->> 'category';
  v_subcategory := p_detail ->> 'subcategory';
  v_axis        := p_detail ->> 'axis';
  v_formula     := p_detail ->> 'formula';
  v_member_id   := nullif(p_detail ->> 'member_id', '')::uuid;
  v_amount      := (p_detail ->> 'amount')::bigint;
  v_unit_price  := coalesce((p_detail ->> 'unit_price')::bigint, 0);
  v_adjustment  := coalesce((p_detail ->> 'adjustment')::bigint, 0);
  v_factors     := coalesce(p_detail -> 'factors', '[]'::jsonb);
  v_sort_given  := (p_detail ->> 'sort_order')::integer;

  if v_project_id is null or v_year_id is null or v_category is null
     or v_subcategory is null or v_axis is null or v_formula is null then
    raise exception '산출근거의 과제·연차·비목·세목·축·산식은 비울 수 없습니다';
  end if;

  -- PL-10a: 금액은 서버 액션이 계산해 넘긴다. RPC가 대신 계산하지 않으므로 null을 메꿀 수 없다
  if v_amount is null then
    raise exception '금액이 비어 있습니다 — 서버 액션이 계산해 넘겨야 합니다';
  end if;

  -- 아래 셋은 DB check 제약이 이미 막는다. 제약 이름 대신 사람이 읽을 수 있는 메시지를
  -- 주기 위해 먼저 본다 (SA-4: 제약명을 사용자에게 노출하지 않는다)
  if v_category not in ('personnel', 'student_personnel', 'facility_equipment',
                        'material', 'consignment', 'international', 'burden',
                        'activity', 'promotion', 'allowance', 'indirect', 'other') then
    raise exception '알 수 없는 비목입니다';
  end if;
  if v_axis not in ('cash', 'in_kind') then
    raise exception '축은 현금(cash) 또는 현물(in_kind)만 허용합니다';
  end if;
  if v_formula not in ('personnel', 'quantity') then
    raise exception '알 수 없는 산식입니다';
  end if;

  -- PL-D3: 인건비 셀에 단가 행이 섞이면 §6.10.3 검증의 기준액이 흔들린다
  if (v_category in ('personnel', 'student_personnel')) <> (v_formula = 'personnel') then
    raise exception '인건비·학생인건비는 인건비 산식만, 나머지 비목은 수량 산식만 허용합니다';
  end if;

  -- PL-D1
  if v_formula = 'personnel' and v_member_id is null then
    raise exception '인건비 산출근거에는 참여인력이 필요합니다';
  end if;
  if v_formula = 'quantity' and v_member_id is not null then
    raise exception '수량 산식 산출근거에는 참여인력을 지정할 수 없습니다';
  end if;

  -- PL-D5: 조정액만 음수를 허용한다
  if v_unit_price < 0 then
    raise exception '단가는 0 이상이어야 합니다';
  end if;
  if jsonb_typeof(v_factors) <> 'array' then
    raise exception '인자 목록이 배열이 아닙니다';
  end if;
  if exists (
    select 1 from jsonb_array_elements(v_factors) f where (f ->> 'value')::numeric < 0
  ) then
    raise exception '인자 값은 0 이상이어야 합니다';
  end if;

  -- N-13·PL-D2: FK는 "존재하는 연차/인력"만 보장할 뿐 과제 경계를 못 막는다
  if not exists (select 1 from years where id = v_year_id and project_id = v_project_id) then
    raise exception '이 과제에 속하지 않은 연차입니다';
  end if;
  if v_member_id is not null
     and not exists (select 1 from members where id = v_member_id and project_id = v_project_id) then
    raise exception '이 과제에 속하지 않은 참여인력입니다';
  end if;

  if v_id is null then
    if v_sort_given is null then
      select coalesce(max(sort_order) + 1, 0) into v_sort
        from budget_details
       where year_id = v_year_id and category = v_category and subcategory = v_subcategory;
    else
      v_sort := v_sort_given;
    end if;

    insert into budget_details (project_id, year_id, category, subcategory, axis, formula,
                                member_id, name, spec, note, unit_price, factors,
                                adjustment, amount, sort_order, created_by, updated_by)
    values (v_project_id, v_year_id, v_category, v_subcategory, v_axis, v_formula,
            v_member_id,
            coalesce(p_detail ->> 'name', ''),
            coalesce(p_detail ->> 'spec', ''),
            coalesce(p_detail ->> 'note', ''),
            v_unit_price, v_factors, v_adjustment,
            v_amount, v_sort, auth.uid(), auth.uid())
    returning * into v_row;
  else
    select * into v_row from budget_details where id = v_id;
    if not found then
      raise exception '산출근거를 찾을 수 없습니다';
    end if;

    -- O-1: 그새 남이 고쳤으면 STALE로 판별되는 문구로 던진다 (위 예외 규약 참조)
    if p_expected_version is not null and v_row.version <> p_expected_version then
      raise exception '다른 사람이 먼저 수정했습니다. 최신 내용을 확인하세요.';
    end if;

    if v_row.project_id <> v_project_id then
      raise exception '다른 과제의 산출근거는 수정할 수 없습니다';
    end if;

    -- 셀(연차·비목)을 옮기는 수정이면 떠난 셀의 총액도 다시 계산해야 한다
    v_old_year     := v_row.year_id;
    v_old_category := v_row.category;

    update budget_details
       set year_id     = v_year_id,
           category    = v_category,
           subcategory = v_subcategory,
           axis        = v_axis,
           formula     = v_formula,
           member_id   = v_member_id,
           name        = coalesce(p_detail ->> 'name', ''),
           spec        = coalesce(p_detail ->> 'spec', ''),
           note        = coalesce(p_detail ->> 'note', ''),
           unit_price  = v_unit_price,
           factors     = v_factors,
           adjustment  = v_adjustment,
           amount      = v_amount,
           sort_order  = coalesce(v_sort_given, sort_order),
           updated_by  = auth.uid()
     where id = v_id
    returning * into v_row;
  end if;

  -- PL-10: 행을 건드린 직후, 같은 트랜잭션 안에서 비목 총액을 다시 계산한다
  perform sync_budget_item_from_details(v_project_id, v_year_id, v_category);
  if v_old_year is not null
     and (v_old_year, v_old_category) is distinct from (v_year_id, v_category) then
    perform sync_budget_item_from_details(v_project_id, v_old_year, v_old_category);
  end if;

  -- 행 전체를 돌려준다 — 리포지토리가 budgetDetailRowSchema로 검증하고 매퍼로 옮긴다
  return to_jsonb(v_row);
end; $$;

-- -----------------------------------------------------------------------------
-- 2. delete_budget_detail (PL-D6 물리 삭제, PL-9, PL-10)
-- -----------------------------------------------------------------------------
create or replace function public.delete_budget_detail(p_detail_id uuid)
returns void language plpgsql security invoker as $$
declare
  v_project_id uuid;
  v_year_id    uuid;
  v_category   text;
  v_deleted    integer;
begin
  if p_detail_id is null then
    raise exception '삭제할 산출근거를 지정해야 합니다';
  end if;

  select project_id, year_id, category
    into v_project_id, v_year_id, v_category
    from budget_details where id = p_detail_id;
  if not found then
    raise exception '산출근거를 찾을 수 없습니다';
  end if;

  delete from budget_details where id = p_detail_id;
  get diagnostics v_deleted = row_count;
  if v_deleted <> 1 then
    raise exception '산출근거 삭제에 실패했습니다';
  end if;

  -- PL-10 + PL-9: 마지막 행이었다면 헬퍼가 아무것도 쓰지 않아 직전 합계가 남는다
  perform sync_budget_item_from_details(v_project_id, v_year_id, v_category);
end; $$;

-- -----------------------------------------------------------------------------
-- 3. reorder_budget_details (X-3, §9 "그 세목의 전체 id 배열")
--    화면이 접혀 일부만 보이더라도 전체 순서를 보낸다(§7.13 T-D10과 같은 이유).
--    그래서 reorder_tasks처럼 "집합 일치"를 엄격히 검사할 수 있다.
-- -----------------------------------------------------------------------------
create or replace function public.reorder_budget_details(
  p_year_id     uuid,
  p_category    text,
  p_subcategory text,
  p_ordered_ids uuid[]
) returns void language plpgsql security invoker as $$
declare
  v_given      integer := coalesce(cardinality(p_ordered_ids), 0);
  v_actual     integer;
  v_updated    integer;
  v_project_id uuid;
begin
  if p_year_id is null or p_category is null or p_subcategory is null then
    raise exception '재정렬할 연차·비목·세목을 지정해야 합니다';
  end if;

  if exists (
    select 1 from unnest(coalesce(p_ordered_ids, '{}'::uuid[])) as u(id)
     group by u.id having count(*) > 1
  ) then
    raise exception '재정렬 목록에 중복된 산출근거가 있습니다';
  end if;

  select count(*) into v_actual
    from budget_details
   where year_id = p_year_id and category = p_category and subcategory = p_subcategory;

  -- 개수 일치 + 전원 소속 확인 = 집합 일치 (중복은 위에서 이미 걸렀다).
  -- 부분 배열을 받아들이면 목록에 없는 행의 순서가 조용히 어긋난다
  if v_given <> v_actual then
    raise exception '재정렬 목록이 이 세목의 산출근거 %건과 다릅니다 (%건 전달)', v_actual, v_given;
  end if;
  if v_given = 0 then
    return;
  end if;
  if exists (
    select 1 from unnest(p_ordered_ids) as u(id)
     where not exists (
       select 1 from budget_details d
        where d.id = u.id
          and d.year_id = p_year_id
          and d.category = p_category
          and d.subcategory = p_subcategory
     )
  ) then
    raise exception '재정렬 목록에 이 세목의 산출근거가 아닌 항목이 있습니다';
  end if;

  update budget_details d
     set sort_order = (o.ord - 1)::integer,
         updated_by = auth.uid()
    from unnest(p_ordered_ids) with ordinality as o(id, ord)
   where d.id = o.id;
  get diagnostics v_updated = row_count;
  if v_updated <> v_given then
    raise exception '재정렬 대상 산출근거를 갱신하지 못했습니다';
  end if;

  -- PL-10: 순서는 금액을 바꾸지 않지만 불변식 재확인 경로를 세 RPC 모두 같게 둔다.
  -- 헬퍼가 "값이 이미 같으면 쓰지 않는다"라서 여기서 version이 헛되이 오르지 않는다
  select project_id into v_project_id from budget_details where id = p_ordered_ids[1];
  perform sync_budget_item_from_details(v_project_id, p_year_id, p_category);
end; $$;

-- -----------------------------------------------------------------------------
-- 4. apply_salary_change (PL-10b)
--    p_amounts = [{ "id": uuid, "amount": bigint }] — **서버 액션이 lib/budget-plan.ts로
--    계산해 넘긴 값**이다. 이 함수는 계산하지 않고 적용만 한다 (PL-10a의 유일한 예외 경로도
--    산식을 DB에 두지 않는다는 뜻이다).
--
--    확인 절차(영향 건수·전후 금액 미리보기)는 §7.10 previewSalaryChange가 담당한다.
--    여기까지 왔다는 것은 사용자가 이미 확인했다는 뜻이다.
-- -----------------------------------------------------------------------------
create or replace function public.apply_salary_change(
  p_member_id        uuid,
  p_annual_salary    bigint,
  p_amounts          jsonb,
  p_expected_version bigint default null
) returns jsonb language plpgsql security invoker as $$
declare
  v_amounts    jsonb := coalesce(p_amounts, '[]'::jsonb);
  v_project_id uuid;
  v_version    bigint;
  v_given      integer;
  v_distinct   integer;
  v_actual     integer;
  v_updated    integer;
  v_cells      integer := 0;
  r            record;
begin
  if p_member_id is null then
    raise exception '연봉을 변경할 참여인력을 지정해야 합니다';
  end if;
  if jsonb_typeof(v_amounts) <> 'array' then
    raise exception '재계산 금액 목록이 배열이 아닙니다';
  end if;
  if exists (
    select 1 from jsonb_to_recordset(v_amounts) as a("id" uuid, "amount" bigint)
     where a."id" is null or a."amount" is null
  ) then
    raise exception '재계산 금액 목록에 id나 금액이 비어 있는 항목이 있습니다';
  end if;

  select project_id, version
    into v_project_id, v_version
    from members where id = p_member_id;
  if not found then
    raise exception '참여인력을 찾을 수 없습니다';
  end if;

  -- O-1: 연봉 편집 폼은 여러 필드를 한 번에 바꾸는 상세 저장 경로다.
  -- 문구는 STALE 판별 규약(/먼저 수정/)을 따른다
  if p_expected_version is not null and v_version <> p_expected_version then
    raise exception '다른 사람이 먼저 수정했습니다. 최신 내용을 확인하세요.';
  end if;

  -- 집합 일치 검사: 일부만 갱신되면 비목 총액이 근거와 어긋난 채 남는다 (PL-10b)
  select count(*), count(distinct a."id")
    into v_given, v_distinct
    from jsonb_to_recordset(v_amounts) as a("id" uuid);
  if v_given <> v_distinct then
    raise exception '재계산 금액 목록에 중복된 산출근거가 있습니다';
  end if;

  select count(*) into v_actual from budget_details where member_id = p_member_id;
  if v_given <> v_actual then
    raise exception '재계산 금액 목록이 이 인력의 인건비 산출근거 %건과 다릅니다 (%건 전달)',
      v_actual, v_given;
  end if;
  if exists (
    select 1 from jsonb_to_recordset(v_amounts) as a("id" uuid)
     where not exists (
       select 1 from budget_details d where d.id = a."id" and d.member_id = p_member_id
     )
  ) then
    raise exception '재계산 금액 목록에 이 인력의 것이 아닌 산출근거가 있습니다';
  end if;

  update members
     set annual_salary = p_annual_salary,
         updated_by    = auth.uid()
   where id = p_member_id;
  get diagnostics v_updated = row_count;
  if v_updated <> 1 then
    raise exception '연봉을 갱신하지 못했습니다';
  end if;

  if v_given > 0 then
    update budget_details d
       set amount     = a."amount",
           updated_by = auth.uid()
      from jsonb_to_recordset(v_amounts) as a("id" uuid, "amount" bigint)
     where d.id = a."id" and d.member_id = p_member_id;
    get diagnostics v_updated = row_count;
    if v_updated <> v_given then
      raise exception '산출근거 금액 갱신 건수가 요청과 다릅니다. 변경을 취소했습니다';
    end if;
  end if;

  -- PL-10: 영향받은 (연차, 비목) 전부를 같은 트랜잭션에서 다시 계산한다.
  -- 한 인력이 여러 연차·비목(인건비/학생인건비)에 걸쳐 있을 수 있다
  for r in
    select distinct d.project_id, d.year_id, d.category
      from budget_details d
     where d.member_id = p_member_id
  loop
    perform sync_budget_item_from_details(r.project_id, r.year_id, r.category);
    v_cells := v_cells + 1;
  end loop;

  return jsonb_build_object(
    'memberId',  p_member_id,
    'projectId', v_project_id,
    'updated',   v_given,
    'cells',     v_cells
  );
end; $$;

-- -----------------------------------------------------------------------------
-- 5. count_member_references 갱신 (H-9a)
--    기존 8곳은 담당·배정 같은 메타데이터라 지워도 숫자가 변하지 않는다. 산출근거는
--    다르다 — 함께 지우면 사람을 지운 조작만으로 비목 총액이 줄어든다(PL-10 재계산).
--    그래서 **별도 항목**으로 센다. 화면이 "인건비 산출근거 N건이 이 인력을 참조합니다
--    → [연구비로 이동]"을 별도 줄로 띄운다(§7.10).
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
    'app_users',           (select count(*) from app_users           where member_id       = p_member_id),
    -- H-9a: 정리 대상이 아니라 **삭제 차단 사유**다. 위 8곳과 섞지 않는다
    'budget_details',      (select count(*) from budget_details      where member_id       = p_member_id)
  );
end; $$;

-- -----------------------------------------------------------------------------
-- 6. delete_member 갱신 (H-9, H-9a)
--    기존 8곳 정리 로직은 그대로다. 산출근거가 1건이라도 있으면 그 앞에서 거부한다.
--    FK가 on delete restrict(PL-D8)라 DB도 막지만, 제약 위반 메시지는 사람이 읽을 수
--    없다 — 무엇을 먼저 정리해야 하는지 알려주고 거부한다 (§6.6 H-8과 같은 판단).
--    active=false(참여 종료)는 그대로 허용한다 — 비활성 인력의 과거 연차 인건비는
--    남아 있어야 정상이고, 그 경로는 이 RPC를 거치지 않는 단순 UPDATE다.
-- -----------------------------------------------------------------------------
create or replace function public.delete_member(p_member_id uuid)
returns jsonb language plpgsql security invoker as $$
declare
  v_counts  jsonb;
  v_details integer;
  v_deleted integer;
begin
  v_counts := count_member_references(p_member_id);  -- 대상이 없으면 여기서 실패한다

  -- H-9a: 사람을 지운 조작만으로 비목 총액이 줄어드는 것을 막는다
  v_details := (v_counts ->> 'budget_details')::integer;
  if v_details > 0 then
    raise exception '인건비 산출근거 %건이 이 인력을 참조합니다. 연구비 화면에서 먼저 정리하세요', v_details;
  end if;

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
-- 7. commit_import 갱신 (S-14)
--    20260810000000_import_rpcs.sql의 본문에서 바뀐 곳은 셋뿐이다:
--      ① 잠긴 셀(산출근거가 1건 이상인 (연차, 비목)) 건수를 센다
--      ② 스냅샷 대상과 upsert 대상 **모두**에서 잠긴 셀을 뺀다
--      ③ 건수 검증을 잠김만큼 보정하고, 반환 jsonb에 locked를 추가한다
--    나머지 검증·스냅샷·20개 창 로직은 그대로다.
--
--    S-14: 잠긴 셀의 계획액은 내역 합계로 확정된 값이다(PL-9). 총괄표 총액으로 덮으면
--    화면은 여전히 산출 행을 보여주는데 합계만 남의 숫자가 된다. **오류가 아니므로
--    예외를 던지지 않는다** — 반영을 막지 않고 건너뛴 건수를 돌려줄 뿐이다.
--    (잠긴 셀은 스냅샷에도 담기지 않는다. 되돌릴 변경이 애초에 없다.)
--
--    security invoker라 잠금 판정도 호출자의 RLS를 탄다 — budget_details의 정책은
--    다른 테이블과 같은 is_approved() 전체 접근이므로 승인된 사용자에게는 항상 보인다.
-- -----------------------------------------------------------------------------
create or replace function public.commit_import(
  p_project_id uuid,
  p_rows       jsonb,
  p_source     jsonb default '{}'::jsonb
) returns jsonb language plpgsql security invoker as $$
declare
  v_source      jsonb := coalesce(p_source, '{}'::jsonb);
  v_total       integer;
  v_distinct    integer;
  v_orphans     integer;
  v_locked      integer;
  v_items       jsonb;
  v_snapshot_id uuid;
  v_updated     integer;
begin
  if p_project_id is null then
    raise exception '반영할 과제를 지정해야 합니다';
  end if;
  if not exists (select 1 from projects where id = p_project_id) then
    raise exception '과제를 찾을 수 없습니다';
  end if;
  if p_rows is null or jsonb_typeof(p_rows) <> 'array' then
    raise exception '반영할 행 목록이 배열이 아닙니다';
  end if;
  if jsonb_array_length(p_rows) = 0 then
    -- 빈 반영은 아무것도 바꾸지 않는 스냅샷만 남긴다 — 이력을 오염시키므로 거부한다
    raise exception '반영할 행이 없습니다';
  end if;

  -- ── 입력 검증 (I-18: 한 건이라도 어긋나면 아무것도 반영하지 않는다) ──

  if exists (
    select 1 from jsonb_to_recordset(p_rows)
      as r("yearId" uuid, "category" text, "plannedAmount" bigint)
     where r."yearId" is null or r."category" is null or r."plannedAmount" is null
  ) then
    raise exception '연차·비목·계획액이 비어 있는 행이 있습니다';
  end if;

  -- S-8은 같은 (연차, 비목)을 파싱 단계에서 합산해 넘긴다. 중복이 남아 있으면
  -- on conflict do update가 "같은 행을 두 번 갱신"으로 실패하므로 원인을 먼저 밝힌다
  select count(*), count(distinct (r."yearId", r."category"))
    into v_total, v_distinct
    from jsonb_to_recordset(p_rows) as r("yearId" uuid, "category" text);
  if v_total <> v_distinct then
    raise exception '같은 연차·비목 조합이 중복으로 들어왔습니다';
  end if;

  if exists (
    select 1 from jsonb_to_recordset(p_rows) as r("category" text)
     where r."category" not in ('personnel', 'student_personnel', 'facility_equipment',
                                'material', 'consignment', 'international', 'burden',
                                'activity', 'promotion', 'allowance', 'indirect', 'other')
  ) then
    raise exception '알 수 없는 비목이 포함되어 있습니다';
  end if;

  -- §5.12: 금액은 원 단위 0 이상 정수. bigint 캐스팅이 정수성을 보장하므로 부호만 본다
  if exists (
    select 1 from jsonb_to_recordset(p_rows)
      as r("plannedAmount" bigint, "cashAmount" bigint, "inKindAmount" bigint)
     where r."plannedAmount" < 0
        or coalesce(r."cashAmount", 0) < 0
        or coalesce(r."inKindAmount", 0) < 0
  ) then
    raise exception '금액은 0 이상이어야 합니다';
  end if;

  -- §5.12 plannedAmount = cashAmount + inKindAmount (S-4). 하나라도 들어오면
  -- 나머지를 0으로 보고 합계를 강제한다 — 차액을 서버가 임의 배분하지 않는다
  if exists (
    select 1 from jsonb_to_recordset(p_rows)
      as r("plannedAmount" bigint, "cashAmount" bigint, "inKindAmount" bigint)
     where (r."cashAmount" is not null or r."inKindAmount" is not null)
       and coalesce(r."cashAmount", 0) + coalesce(r."inKindAmount", 0) <> r."plannedAmount"
  ) then
    raise exception '현금과 현물의 합이 계획액과 같아야 합니다';
  end if;

  -- N-13: 남의 과제 연차가 하나라도 섞이면 전부 거부한다. FK(budget_items.year_id)는
  -- "존재하는 연차"만 보장할 뿐 과제 경계를 못 막는다
  select count(*) into v_orphans
    from (
      select distinct r."yearId" as year_id
        from jsonb_to_recordset(p_rows) as r("yearId" uuid)
    ) s
    left join years y on y.id = s.year_id and y.project_id = p_project_id
   where y.id is null;
  if v_orphans > 0 then
    raise exception '이 과제에 속하지 않은 연차가 포함되어 있어 반영을 취소했습니다';
  end if;

  -- 기존 행의 project_id가 어긋나 있으면(정합성 사고) 덮어쓰지 않고 멈춘다 —
  -- on conflict는 project_id를 갱신하지 않으므로 조용히 남의 과제 행을 고칠 수 있다
  if exists (
    select 1
      from jsonb_to_recordset(p_rows) as r("yearId" uuid, "category" text)
      join budget_items b on b.year_id = r."yearId" and b.category = r."category"
     where b.project_id <> p_project_id
  ) then
    raise exception '기존 예산 행이 다른 과제에 속해 있어 반영을 취소했습니다';
  end if;

  -- ── S-14: 잠긴 셀 집계 (오류가 아니다 — 세고 빼기만 한다) ──
  select count(*) into v_locked
    from (
      select distinct r."yearId" as year_id, r."category" as category
        from jsonb_to_recordset(p_rows) as r("yearId" uuid, "category" text)
    ) s
   where exists (
     select 1 from budget_details d
      where d.year_id = s.year_id and d.category = s.category
   );

  -- ── I-17: 반영 전 값을 같은 트랜잭션에서 스냅샷으로 남긴다 ──
  --    잠긴 셀은 반영되지 않으므로 스냅샷에도 담지 않는다 (S-14)

  select coalesce(
           jsonb_agg(
             jsonb_build_object(
               'yearId',        s."yearId",
               'category',      s."category",
               'plannedAmount', coalesce(b.planned_amount, 0),
               'cashAmount',    b.cash_amount,
               'inKindAmount',  b.in_kind_amount,
               'existed',       (b.id is not null)
             ) order by s."yearId", s."category"
           ), '[]'::jsonb)
    into v_items
    from jsonb_to_recordset(p_rows) as s("yearId" uuid, "category" text)
    left join budget_items b on b.year_id = s."yearId" and b.category = s."category"
   where not exists (
     select 1 from budget_details d
      where d.year_id = s."yearId" and d.category = s."category"
   );

  insert into import_snapshots (project_id, snapshot, created_by, updated_by)
  values (
    p_project_id,
    jsonb_build_object(
      'schemaVersion', 1,
      'projectId',     p_project_id,
      'capturedAt',    now(),
      'source', jsonb_build_object(
        -- 키가 없으면 빈 문자열로 채운다 — 스냅샷 형식을 항상 같게 유지해야
        -- 설정 화면(§7.14)의 파싱이 옵션 분기 없이 단순해진다.
        -- profileId는 uuid 캐스팅으로 형식을 강제한다(형식 오류면 여기서 실패)
        'fileName',  coalesce(v_source ->> 'fileName', ''),
        'sheetName', coalesce(v_source ->> 'sheetName', ''),
        'profileId', nullif(v_source ->> 'profileId', '')::uuid,
        'fileHash',  coalesce(v_source ->> 'fileHash', '')
      ),
      'items', v_items
    ),
    auth.uid(), auth.uid()
  )
  returning id into v_snapshot_id;

  -- ── 반영 (S-9: p_rows에 등장한 조합만, S-14: 잠기지 않은 셀만 건드린다) ──
  --
  -- create_year가 12종을 0으로 만들어 두므로 대개 update가 되지만, 과거 데이터나
  -- 수동 삭제로 행이 없을 수 있어 upsert로 처리한다. version·updated_at은
  -- set_updated_meta 트리거가 올린다 (N-5)
  insert into budget_items (project_id, year_id, category,
                            planned_amount, cash_amount, in_kind_amount,
                            created_by, updated_by)
  select p_project_id, r."yearId", r."category",
         r."plannedAmount", r."cashAmount", r."inKindAmount",
         auth.uid(), auth.uid()
    from jsonb_to_recordset(p_rows) as r("yearId" uuid, "category" text,
                                         "plannedAmount" bigint,
                                         "cashAmount" bigint, "inKindAmount" bigint)
   where not exists (
     select 1 from budget_details d
      where d.year_id = r."yearId" and d.category = r."category"
   )
  on conflict (year_id, category) do update
    set planned_amount = excluded.planned_amount,
        cash_amount    = excluded.cash_amount,
        in_kind_amount = excluded.in_kind_amount,
        updated_by     = excluded.updated_by;
  get diagnostics v_updated = row_count;

  -- 검증을 다 통과했는데 반영 건수가 다르면 RLS가 일부 행을 잘라냈다는 뜻이다.
  -- 조용히 부분 반영으로 끝내지 않는다 (I-18). 잠긴 셀은 애초에 대상이 아니므로 뺀다
  if v_updated <> v_total - v_locked then
    raise exception '반영 건수가 요청과 다릅니다. 반영을 취소했습니다';
  end if;

  -- I-17: 과제별 최근 20개만 유지
  delete from import_snapshots
   where project_id = p_project_id
     and id not in (
       select id from import_snapshots
        where project_id = p_project_id
        order by created_at desc, id desc
        limit 20
     );

  return jsonb_build_object('snapshotId', v_snapshot_id, 'updated', v_updated, 'locked', v_locked);
end; $$;
