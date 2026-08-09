-- =============================================================================
-- Phase 10 산출근거 시트 임포트 반영 — commit_detail_import
--                                    + restore_import_snapshot 확장(D-17a)
-- SOT §6.11.5(D-15·D-15a·D-16·D-17·D-17a), §6.11.4 D-12, §5.17(PL-D1~PL-D8),
--     §6.10.2(PL-10·PL-10a), §6.8.5(I-17·I-18), §8.3(X-1·X-2), §9 Budget Detail Import
--
-- ⚠ PL-10a — **이 파일에는 금액 산식이 없다.**
--   `p_rows[].amount`는 서버 액션이 `lib/budget-plan.ts`(PL-1~PL-5)로 계산해 넘긴 값이고,
--   RPC는 **그대로 저장**한다. 총액은 sync_budget_item_from_details가 축별 sum(amount)만
--   한다(20260814000000_budget_plan_rpcs.sql과 같은 규약). PL/pgSQL에 산식을 다시 구현하면
--   JS `Math.round`와 SQL `round()`가 음수 .5·부동소수점 경계에서 갈려 1원씩 어긋난다.
--
--  - X-2 : 둘 다 security invoker. §8.3 X-2의 definer 예외 목록(handle_new_user,
--          approve_user, deactivate_user, is_approved, restore_backup)에 없다.
--          members·budget_details·budget_items·import_snapshots의
--          "approved users full access"(is_approved()) 정책이 호출자에게 그대로 적용된다.
--  - X-1 : members·budget_details·budget_items·import_snapshots를 한 트랜잭션으로
--          묶어야 하므로 RPC다.
--  - D-16: 함수 본문 전체가 한 트랜잭션이다. 한 행이라도 실패하면 raise exception으로
--          전체를 롤백한다 — 새로 만든 인력도 함께 사라진다(D-12).
--  - D-16: budget_items를 직접 UPDATE하지 않는다. 총액 갱신 경로는
--          sync_budget_item_from_details 호출 하나뿐이다(PL-10 불변식의 단일 구현).
--  - N-5 : version +1과 updated_at은 set_updated_meta 트리거가 올린다.
--          여기서는 updated_by(auth.uid())만 채운다.
--  - N-13: FK는 "이 연차·이 인력·이 기관이 이 과제 것인가"를 막지 못한다. RPC가 거부한다.
--
-- ─ 예외 규약 (lib/db/import-snapshots.ts·budget-details.ts의 판정 규칙과 짝이다) ──
--   PostgREST는 raise exception을 전부 SQLSTATE P0001로 내려보내므로 리포지토리는
--   **메시지 문자열로** 종류를 가른다:
--     · /먼저 수정|stale/i          → StaleDataError   (이 파일에는 없다 — 임포트는 신규 삽입뿐)
--     · /찾을 수 없습니다|not found/i → NotFoundError   (과제·스냅샷이 없는 경우)
--     · 그 외 전부                   → RuleViolationError
--   문구를 바꾸면 리포지토리의 정규식도 함께 바꾼다.
--
-- 산출근거 스냅샷 jsonb 형식 (D-17. 총괄표 스냅샷은 schemaVersion 1이고 details 키가 없다):
--   {
--     "schemaVersion": 2, "projectId": uuid, "capturedAt": timestamptz,
--     "kind": "budget_detail",
--     "source": { "fileName", "sheetName", "profileId": null, "fileHash" },
--     "items":   [ budget_items 이전 값 — commit_import와 같은 형태 ],
--     "details": [ 삭제되는 budget_details 행 전체 (DB snake_case 원본) ]
--   }
-- **details 키는 비어 있어도 항상 존재한다** — 복원이 키 유무로 스냅샷 종류를 가른다(D-17).
-- profileId는 항상 null이다: 산출근거 임포트는 프로파일을 쓰지 않는다(D-20).
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. commit_detail_import (D-12·D-15·D-15a·D-16·D-17, I-17)
--    p_new_members : [{ "tempKey", "name", "position", "annual_salary",
--                       "hire_type", "org_id", "role"(선택) }]
--    p_rows        : budget_details 행 (DB snake_case). 인건비 행은 "member_id" 또는
--                    새 인력의 "memberTempKey" 중 하나를 갖는다
--    p_replace_categories : 기존 행을 전부 지우고 교체할 비목 (D-15)
--    p_source      : { "fileName", "sheetName", "fileHash" } — 스냅샷 메타
--    반환 : { snapshotId, inserted, deleted, membersCreated, cells, skippedLocked }
-- -----------------------------------------------------------------------------
create or replace function public.commit_detail_import(
  p_project_id         uuid,
  p_year_id            uuid,
  p_new_members        jsonb  default '[]'::jsonb,
  p_rows               jsonb  default '[]'::jsonb,
  p_replace_categories text[] default '{}'::text[],
  p_source             jsonb  default '{}'::jsonb
) returns jsonb language plpgsql security invoker as $$
declare
  c_categories constant text[] := array[
    'personnel', 'student_personnel', 'facility_equipment', 'material',
    'consignment', 'international', 'burden', 'activity',
    'promotion', 'allowance', 'indirect', 'other'];

  v_members     jsonb  := coalesce(p_new_members, '[]'::jsonb);
  v_rows        jsonb  := coalesce(p_rows, '[]'::jsonb);
  v_replace     text[] := coalesce(p_replace_categories, '{}'::text[]);
  v_source      jsonb  := coalesce(p_source, '{}'::jsonb);

  v_key_map     jsonb  := '{}'::jsonb;   -- tempKey → members.id (D-12)
  v_skipped     text[];                  -- D-15a: 교체 지정이 없는데 기존 행이 있는 비목
  v_targets     text[];                  -- 실제로 삽입할 비목
  v_cells       text[];                  -- 총액을 다시 계산할 비목 (삽입 + 교체)
  v_items       jsonb;
  v_details     jsonb;
  v_snapshot_id uuid;

  v_total       integer;
  v_distinct    integer;
  v_deleted     integer := 0;
  v_inserted    integer := 0;
  v_created     integer := 0;
  v_member_id   uuid;
  v_temp_key    text;
  v_detail      jsonb;
  r             jsonb;
  c             text;
begin
  -- ── 입력 검증 (D-16: 한 건이라도 어긋나면 아무것도 반영하지 않는다) ──

  if p_project_id is null or p_year_id is null then
    raise exception '반영할 과제와 연차를 지정해야 합니다';
  end if;
  if not exists (select 1 from projects where id = p_project_id) then
    raise exception '과제를 찾을 수 없습니다';
  end if;
  -- N-13: FK(budget_details.year_id)는 "존재하는 연차"만 보장할 뿐 과제 경계를 못 막는다
  if not exists (select 1 from years where id = p_year_id and project_id = p_project_id) then
    raise exception '이 과제에 속하지 않은 연차입니다';
  end if;

  if jsonb_typeof(v_rows) <> 'array' then
    raise exception '반영할 행 목록이 배열이 아닙니다';
  end if;
  if jsonb_array_length(v_rows) = 0 then
    -- 빈 반영은 아무것도 바꾸지 않는 스냅샷만 남긴다 — 이력을 오염시키므로 거부한다
    -- (commit_import와 같은 판단)
    raise exception '반영할 행이 없습니다';
  end if;
  if jsonb_typeof(v_members) <> 'array' then
    raise exception '새 인력 목록이 배열이 아닙니다';
  end if;

  if exists (
    select 1 from unnest(v_replace) as t(category)
     where t.category is null or not (t.category = any(c_categories))
  ) then
    raise exception '교체 대상에 알 수 없는 비목이 있습니다';
  end if;

  -- 비목은 아래에서 건너뜀·교체 판정의 키로 쓰이므로 upsert_budget_detail에 넘기기 전에 본다
  if exists (
    select 1 from jsonb_array_elements(v_rows) as t(row)
     where (t.row ->> 'category') is null
        or not ((t.row ->> 'category') = any(c_categories))
  ) then
    raise exception '알 수 없는 비목이 포함되어 있습니다';
  end if;

  -- D-19: 시트 하나 = 연차 하나. 행이 연차를 실어 보냈다면 인자와 같아야 한다.
  -- 조용히 덮어쓰면 다른 연차의 예산이 이 연차로 빨려 들어간다
  if exists (
    select 1 from jsonb_array_elements(v_rows) as t(row)
     where nullif(t.row ->> 'year_id', '') is not null
       and (t.row ->> 'year_id')::uuid <> p_year_id
  ) then
    raise exception '반영 대상 연차와 다른 연차의 행이 섞여 있습니다';
  end if;
  if exists (
    select 1 from jsonb_array_elements(v_rows) as t(row)
     where nullif(t.row ->> 'project_id', '') is not null
       and (t.row ->> 'project_id')::uuid <> p_project_id
  ) then
    raise exception '반영 대상 과제와 다른 과제의 행이 섞여 있습니다';
  end if;

  -- 임포트는 **신규 삽입만** 한다. id가 실려 오면 기존 행을 조용히 고치게 되므로 거부한다
  if exists (
    select 1 from jsonb_array_elements(v_rows) as t(row)
     where nullif(t.row ->> 'id', '') is not null
  ) then
    raise exception '임포트는 새 산출근거만 만듭니다. 기존 산출근거 id가 포함되어 있습니다';
  end if;

  -- ── D-15a: 커밋 시점에 기존 행이 있는데 교체 지정이 없는 셀은 건너뛴다 ──
  -- 미리보기 이후 다른 사람이 산출근거를 추가한 경우다. 예외를 던지지 않는다 —
  -- 한 셀 때문에 나머지 수십 행을 버리는 것이 더 나쁘고, 건너뜀은 데이터를 잃지 않는다
  -- (S-14와 같은 태도). 대신 skippedLocked로 반드시 결과에 드러낸다.
  select coalesce(array_agg(s.category), '{}'::text[])
    into v_skipped
    from (
      select distinct e.row ->> 'category' as category
        from jsonb_array_elements(v_rows) as e(row)
    ) s
   where not (s.category = any(v_replace))
     and exists (
       select 1 from budget_details d
        where d.year_id = p_year_id and d.category = s.category
     );

  select coalesce(array_agg(distinct e.row ->> 'category'), '{}'::text[])
    into v_targets
    from jsonb_array_elements(v_rows) as e(row)
   where not ((e.row ->> 'category') = any(v_skipped));

  -- D-15: 교체는 "그 셀의 기존 행을 전부 지우고 파일 내용으로 바꾼다"이다.
  -- 파일 행이 없는 비목의 교체 지정은 내용 없는 삭제가 되므로(PL-9로 총액만 얼어붙는다)
  -- 조용히 수행하지 않고 거부한다
  if exists (
    select 1 from unnest(v_replace) as t(category)
     where not exists (
       select 1 from jsonb_array_elements(v_rows) as e(row)
        where e.row ->> 'category' = t.category
     )
  ) then
    raise exception '교체 대상 비목에 반영할 행이 없습니다';
  end if;

  select coalesce(array_agg(distinct t.category), '{}'::text[])
    into v_cells
    from unnest(v_targets || v_replace) as t(category);

  -- 새 인력: tempKey는 행이 가리키는 유일한 키다. 비었거나 중복이면 치환이 어긋난다
  select count(*), count(distinct m."tempKey")
    into v_total, v_distinct
    from jsonb_to_recordset(v_members) as m("tempKey" text);
  if exists (
    select 1 from jsonb_to_recordset(v_members) as m("tempKey" text)
     where coalesce(m."tempKey", '') = ''
  ) then
    raise exception '새 인력의 임시 키가 비어 있습니다';
  end if;
  if v_total <> v_distinct then
    raise exception '새 인력의 임시 키가 중복되었습니다';
  end if;
  -- 어떤 행도 참조하지 않는 새 인력은 요청 자체가 어긋난 것이다 — 조용히 버리지 않는다
  if exists (
    select 1 from jsonb_to_recordset(v_members) as m("tempKey" text)
     where not exists (
       select 1 from jsonb_array_elements(v_rows) as e(row)
        where e.row ->> 'memberTempKey' = m."tempKey"
     )
  ) then
    raise exception '어떤 행도 참조하지 않는 새 인력이 있습니다';
  end if;

  -- ── D-17: 삽입·삭제 **전에** 같은 트랜잭션에서 스냅샷을 남긴다 ──
  -- 산출근거 임포트는 행을 지울 수 있으므로(D-15 교체) 되돌릴 길이 반드시 있어야 한다.
  -- 건너뛴 셀(D-15a)은 아무것도 바뀌지 않으므로 담지 않는다 (commit_import의 S-14와 같다).

  select coalesce(
           jsonb_agg(
             jsonb_build_object(
               'yearId',        p_year_id,
               'category',      s.category,
               'plannedAmount', coalesce(b.planned_amount, 0),
               'cashAmount',    b.cash_amount,
               'inKindAmount',  b.in_kind_amount,
               'existed',       (b.id is not null)
             ) order by s.category
           ), '[]'::jsonb)
    into v_items
    from unnest(v_cells) as s(category)
    left join budget_items b on b.year_id = p_year_id and b.category = s.category;

  -- 삭제되는 행 **전체**를 DB 표기 원본 그대로 담는다 — 복원이 id까지 되살린다(D-17a)
  select coalesce(jsonb_agg(to_jsonb(d) order by d.id), '[]'::jsonb)
    into v_details
    from budget_details d
   where d.year_id = p_year_id and d.category = any(v_replace);

  insert into import_snapshots (project_id, snapshot, created_by, updated_by)
  values (
    p_project_id,
    jsonb_build_object(
      'schemaVersion', 2,
      'projectId',     p_project_id,
      'capturedAt',    now(),
      'kind',          'budget_detail',
      'source', jsonb_build_object(
        -- 키가 없으면 빈 문자열로 채운다 — 스냅샷 형식을 항상 같게 유지해야
        -- 설정 화면(§7.14)의 파싱이 옵션 분기 없이 단순해진다
        'fileName',  coalesce(v_source ->> 'fileName', ''),
        'sheetName', coalesce(v_source ->> 'sheetName', ''),
        'profileId', null,   -- D-20: 산출근거 임포트는 프로파일을 쓰지 않는다
        'fileHash',  coalesce(v_source ->> 'fileHash', '')
      ),
      'items',   v_items,
      'details', v_details   -- 비어 있어도 항상 존재한다 (D-17)
    ),
    auth.uid(), auth.uid()
  )
  returning id into v_snapshot_id;

  -- ── D-15: 교체 대상 셀의 기존 행을 **전부** 지운다 (부분 병합은 없다) ──
  if array_length(v_replace, 1) is not null then
    delete from budget_details
     where year_id = p_year_id and category = any(v_replace);
    get diagnostics v_deleted = row_count;
  end if;

  -- ── D-12: 새 인력을 같은 트랜잭션에서 만든다 ──
  -- 뒤에서 한 행이라도 실패하면 인력도 함께 롤백된다(미리보기 단계에서 만들지 않는 이유와 같다).
  -- 건너뛴 셀(D-15a)의 행만 참조하는 인력은 만들지 않는다 — 반영되지 않는데 명부만
  -- 더러워지면 안 되고, 사용자가 다시 시도할 때 동명이인이 생긴다(D-13).
  for r in select elem from jsonb_array_elements(v_members) as t(elem) loop
    v_temp_key := r ->> 'tempKey';

    if not exists (
      select 1 from jsonb_array_elements(v_rows) as e(row)
       where e.row ->> 'memberTempKey' = v_temp_key
         and not ((e.row ->> 'category') = any(v_skipped))
    ) then
      continue;
    end if;

    if coalesce(btrim(r ->> 'name'), '') = '' then
      raise exception '새 인력의 성명이 비어 있습니다';
    end if;
    -- §5.11 annualSalary는 원 단위 정수이고 미입력은 null이다 (D-8a: 명부가 산식의 기준)
    if nullif(r ->> 'annual_salary', '') is not null
       and (r ->> 'annual_salary')::bigint < 0 then
      raise exception '연봉은 0 이상이어야 합니다';
    end if;
    if coalesce(r ->> 'hire_type', 'existing') not in ('existing', 'new') then
      raise exception '알 수 없는 인력구분입니다';
    end if;
    if coalesce(r ->> 'role', 'researcher') not in ('pm', 'pl', 'researcher', 'staff') then
      raise exception '알 수 없는 역할입니다';
    end if;
    -- N-13: 기관도 과제 경계 밖일 수 있다 (organizations는 과제 소속이다)
    if nullif(r ->> 'org_id', '') is not null
       and not exists (
         select 1 from organizations o
          where o.id = (r ->> 'org_id')::uuid and o.project_id = p_project_id
       ) then
      raise exception '이 과제에 속하지 않은 기관입니다';
    end if;

    insert into members (project_id, org_id, name, role, position, field, email, phone,
                         active, sort_order, annual_salary, hire_type,
                         created_by, updated_by)
    values (
      p_project_id,
      nullif(r ->> 'org_id', '')::uuid,
      btrim(r ->> 'name'),
      -- 파일에는 역할 구분이 없다. 인건비에 계상된 사람은 참여연구원이 기본이고,
      -- 총괄·책임 지정은 인력 화면(§7.10)에서 사람이 바꾼다
      coalesce(r ->> 'role', 'researcher'),
      coalesce(r ->> 'position', ''),
      '', '', '',
      true,   -- 지금 이 연차의 인건비에 계상되는 사람이다 (N-11 기본값 false는 생성 액션이 채운다)
      coalesce((select max(sort_order) + 1 from members where project_id = p_project_id), 0),
      nullif(r ->> 'annual_salary', '')::bigint,
      coalesce(r ->> 'hire_type', 'existing'),
      auth.uid(), auth.uid()
    )
    returning id into v_member_id;

    v_key_map := v_key_map || jsonb_build_object(v_temp_key, v_member_id);
    v_created := v_created + 1;
  end loop;

  -- ── 행 삽입 ──
  -- 행 검증(PL-D1~PL-D5·N-13)을 여기에 다시 쓰지 않고 **upsert_budget_detail을 호출**한다:
  -- 같은 규칙이 두 곳에 생기면 반드시 어긋나고(PL-10a와 같은 판단), 임포트만 통과하는
  -- 산출근거가 생기면 §6.10.3 검증의 기준액이 흔들린다. 대가로 sync_budget_item_from_details가
  -- 행마다 한 번씩 더 불리지만(같은 트랜잭션 안이라 중간값이 새어 나가지 않는다),
  -- 아래에서 셀별로 한 번 더 부르는 것이 총액을 확정한다.
  for r in select elem from jsonb_array_elements(v_rows) as t(elem) loop
    if (r ->> 'category') = any(v_skipped) then
      continue;   -- D-15a
    end if;

    v_temp_key  := nullif(r ->> 'memberTempKey', '');
    v_member_id := nullif(r ->> 'member_id', '')::uuid;
    if v_temp_key is not null then
      if v_member_id is not null then
        raise exception '한 행에 참여인력과 새 인력 임시 키가 함께 지정되었습니다';
      end if;
      if not (v_key_map ? v_temp_key) then
        raise exception '행이 가리키는 새 인력 임시 키가 목록에 없습니다';
      end if;
      v_member_id := (v_key_map ->> v_temp_key)::uuid;
    end if;

    -- PL-10a: amount는 손대지 않고 그대로 넘긴다. project_id·year_id는 인자로 확정한다
    -- (위에서 값이 어긋나는 행을 이미 거부했다)
    v_detail := (r - 'id' - 'memberTempKey')
                || jsonb_build_object(
                     'project_id', p_project_id,
                     'year_id',    p_year_id,
                     'member_id',  v_member_id
                   );

    perform upsert_budget_detail(v_detail);
    v_inserted := v_inserted + 1;
  end loop;

  -- ── D-16: 총액은 PL-10 불변식의 단일 구현으로만 갱신한다 ──
  -- budget_items를 직접 UPDATE하지 않는다. 교체로 행이 0이 된 셀도 여기서 다뤄야 하므로
  -- 삽입이 없던 비목(v_replace)까지 포함한 v_cells 전부를 돈다
  foreach c in array v_cells loop
    perform sync_budget_item_from_details(p_project_id, p_year_id, c);
  end loop;

  -- I-17: 과제별 최근 20개만 유지 (commit_import와 같은 창)
  delete from import_snapshots
   where project_id = p_project_id
     and id not in (
       select id from import_snapshots
        where project_id = p_project_id
        order by created_at desc, id desc
        limit 20
     );

  return jsonb_build_object(
    'snapshotId',     v_snapshot_id,
    'inserted',       v_inserted,
    'deleted',        v_deleted,
    'membersCreated', v_created,
    'cells',          coalesce(array_length(v_cells, 1), 0),
    'skippedLocked',  coalesce(array_length(v_skipped, 1), 0)
  );
end; $$;

-- -----------------------------------------------------------------------------
-- 2. restore_import_snapshot 확장 (D-17a)
--    20260810000000_import_rpcs.sql(+ 20260814 S-14 갱신)의 본문에서 바뀐 곳은 셋뿐이다:
--      ① snapshot -> 'details'를 함께 읽는다 (키가 없으면 null)
--      ② details가 있으면 그 (연차, 비목)의 현재 행을 지우고 스냅샷 행을 id 보존으로
--         되살린 뒤 sync_budget_item_from_details로 총액을 재계산한다
--      ③ 반환 jsonb에 detailsDeleted·detailsRestored·cells를 **details가 있을 때만** 얹는다
--
--    ⚠ **details 키가 없는 기존 스냅샷의 동작은 한 글자도 바뀌지 않는다** — 검증 순서·
--    upsert·건수 검사·반환 형태 전부 그대로다. 바뀌면 총괄표 임포트 복원의 회귀다.
--
--    ⚠ 산출근거 행 삭제는 **I-17("복원이 행을 삭제하지 않는다")의 명시적 예외**다(D-17a).
--    안 지우면 교체로 늘어난 행이 남아 금액이 두 배가 된다. `budget_items` 행 자체는
--    여전히 지우지 않는다 — 임포트 이후 그 비목에 붙은 집행 내역이 cascade로 사라진다.
--
--    복원은 여전히 새 스냅샷을 만들지 않는다 (I-17).
-- -----------------------------------------------------------------------------
create or replace function public.restore_import_snapshot(p_snapshot_id uuid)
returns jsonb language plpgsql security invoker as $$
declare
  v_project_id uuid;
  v_snapshot   jsonb;
  v_items      jsonb;
  v_details    jsonb;   -- D-17a: 키가 없으면 null → 기존 경로 그대로
  v_cell_list  jsonb;
  v_total      integer;
  v_orphans    integer;
  v_restored   integer;
  v_deleted    integer := 0;
  v_inserted   integer := 0;
  v_cells      integer := 0;
  v_n          integer;
  cell         record;
begin
  if p_snapshot_id is null then
    raise exception '복원할 스냅샷을 지정해야 합니다';
  end if;

  select project_id, snapshot
    into v_project_id, v_snapshot
    from import_snapshots where id = p_snapshot_id;
  if v_project_id is null then
    raise exception '스냅샷을 찾을 수 없습니다';
  end if;
  v_items   := v_snapshot -> 'items';
  v_details := v_snapshot -> 'details';
  if v_items is null or jsonb_typeof(v_items) <> 'array' then
    raise exception '스냅샷 형식이 올바르지 않아 복원할 수 없습니다';
  end if;

  v_total := jsonb_array_length(v_items);
  if v_total = 0 and v_details is null then
    return jsonb_build_object('snapshotId', p_snapshot_id, 'restored', 0);
  end if;

  -- N-13: 스냅샷 이후 연차가 삭제·이동됐을 수 있다. 남은 것만 되돌리는 부분 복원은
  -- "되돌렸다"는 오해를 남기므로 전부 거부한다 (I-18과 같은 기준)
  select count(*) into v_orphans
    from (
      select distinct i."yearId" as year_id
        from jsonb_to_recordset(v_items) as i("yearId" uuid)
    ) s
    left join years y on y.id = s.year_id and y.project_id = v_project_id
   where y.id is null;
  if v_orphans > 0 then
    raise exception '스냅샷의 연차가 삭제되었거나 다른 과제로 옮겨져 복원할 수 없습니다';
  end if;

  -- ── D-17a: 산출근거 스냅샷만 이 블록을 탄다 ──
  if v_details is not null then
    if jsonb_typeof(v_details) <> 'array' then
      raise exception '스냅샷 형식이 올바르지 않아 복원할 수 없습니다';
    end if;

    if exists (
      select 1 from jsonb_to_recordset(v_details) as d("project_id" uuid)
       where d."project_id" is distinct from v_project_id
    ) then
      raise exception '스냅샷의 산출근거가 다른 과제에 속해 있어 복원할 수 없습니다';
    end if;

    select count(*) into v_orphans
      from (
        select distinct d."year_id" as year_id
          from jsonb_to_recordset(v_details) as d("year_id" uuid)
      ) s
      left join years y on y.id = s.year_id and y.project_id = v_project_id
     where y.id is null;
    if v_orphans > 0 then
      raise exception '스냅샷의 연차가 삭제되었거나 다른 과제로 옮겨져 복원할 수 없습니다';
    end if;

    -- H-9a: member_id는 on delete restrict라 인력이 남아 있어야 되살릴 수 있다.
    -- FK 위반 메시지는 사람이 읽을 수 없으므로 원인을 먼저 밝힌다 (SA-4)
    if exists (
      select 1 from jsonb_to_recordset(v_details) as d("member_id" uuid)
       where d."member_id" is not null
         and not exists (select 1 from members m where m.id = d."member_id")
    ) then
      raise exception '스냅샷의 참여인력이 삭제되어 복원할 수 없습니다';
    end if;

    -- 되돌릴 셀 = 스냅샷이 담은 (연차, 비목) 전부. items에는 삽입으로 늘어난 셀이,
    -- details에는 교체로 지워진 셀이 들어 있다 — 둘의 합집합이라야 임포트 직전 상태가 된다
    select coalesce(
             jsonb_agg(distinct jsonb_build_object('yearId', s.year_id, 'category', s.category)),
             '[]'::jsonb)
      into v_cell_list
      from (
        select i."yearId" as year_id, i."category" as category
          from jsonb_to_recordset(v_items) as i("yearId" uuid, "category" text)
        union
        select d."year_id", d."category"
          from jsonb_to_recordset(v_details) as d("year_id" uuid, "category" text)
      ) s;

    for cell in
      select c."yearId" as year_id, c."category" as category
        from jsonb_to_recordset(v_cell_list) as c("yearId" uuid, "category" text)
    loop
      delete from budget_details
       where year_id = cell.year_id and category = cell.category;
      get diagnostics v_n = row_count;
      v_deleted := v_deleted + v_n;
      v_cells   := v_cells + 1;
    end loop;

    -- id·created_at·version까지 원본 그대로 되살린다 (restore_backup과 같은 방식).
    -- set_updated_meta는 before update 트리거라 insert에는 걸리지 않는다
    insert into budget_details
    select * from jsonb_populate_recordset(null::public.budget_details, v_details);
    get diagnostics v_inserted = row_count;
    if v_inserted <> jsonb_array_length(v_details) then
      raise exception '산출근거 복원 건수가 스냅샷과 다릅니다. 복원을 취소했습니다';
    end if;

    -- PL-10: 총액 갱신 경로는 sync 하나뿐이다. 아래 items 복원이 그 위에 스냅샷 값을
    -- 덮으므로(산출근거가 없던 셀은 sync가 아무것도 쓰지 않는다) 순서를 바꾸면 안 된다
    for cell in
      select c."yearId" as year_id, c."category" as category
        from jsonb_to_recordset(v_cell_list) as c("yearId" uuid, "category" text)
    loop
      perform sync_budget_item_from_details(v_project_id, cell.year_id, cell.category);
    end loop;
  end if;

  insert into budget_items (project_id, year_id, category,
                            planned_amount, cash_amount, in_kind_amount,
                            created_by, updated_by)
  select v_project_id, i."yearId", i."category",
         coalesce(i."plannedAmount", 0), i."cashAmount", i."inKindAmount",
         auth.uid(), auth.uid()
    from jsonb_to_recordset(v_items) as i("yearId" uuid, "category" text,
                                          "plannedAmount" bigint,
                                          "cashAmount" bigint, "inKindAmount" bigint)
  on conflict (year_id, category) do update
    set planned_amount = excluded.planned_amount,
        cash_amount    = excluded.cash_amount,
        in_kind_amount = excluded.in_kind_amount,
        updated_by     = excluded.updated_by;
  get diagnostics v_restored = row_count;

  if v_restored <> v_total then
    raise exception '복원 건수가 스냅샷과 다릅니다. 복원을 취소했습니다';
  end if;

  -- details가 없는 스냅샷의 반환 형태는 종전과 완전히 같아야 한다 (회귀 금지)
  if v_details is null then
    return jsonb_build_object('snapshotId', p_snapshot_id, 'restored', v_restored);
  end if;
  return jsonb_build_object(
    'snapshotId',      p_snapshot_id,
    'restored',        v_restored,
    'detailsDeleted',  v_deleted,
    'detailsRestored', v_inserted,
    'cells',           v_cells
  );
end; $$;
