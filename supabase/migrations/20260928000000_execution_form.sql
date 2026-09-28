-- =============================================================================
-- Phase 20 수행 양식 — budget_executions 내역 7컬럼 + commit_execution_form
--                      + restore_import_snapshot 확장(IN-14) + restore_backup 갱신(§8.8)
-- SOT §5.12(BudgetExecution Phase 20 필드), §5.12.1(ImportKind), §6.16 IN-10·IN-11·IN-13·IN-14,
--     §6.8.5 I-17, §6.11.5 D-17a, §8.3 X-1·X-2, §8.4 O-1, §8.7 K-7, §8.8
--
-- schema_version은 **4를 유지한다**(§8.8). 올리는 기준은 "백업 파일 형식이 바뀌는가"이고
-- 이 마이그레이션은 컬럼 추가·RPC뿐이라 BACKUP_TABLES가 그대로다. 옛(Phase 20 이전) 백업은
-- 아래 restore_backup이 spec 기본값을 채워 그대로 복원된다. EXPECTED_SCHEMA_VERSION도 4다.
--
-- RLS 정책 변경 불필요 — 기존 테이블의 is_approved() 전체 접근 정책("approved users full access")이
-- 새 컬럼에 그대로 적용된다. 새 테이블 없음. budget_executions는 이미 Realtime publication에 있다.
--
--  - X-2 : commit_execution_form·restore_import_snapshot은 security invoker다. definer 예외
--          (§8.3 X-2 목록)는 restore_backup 하나뿐이고, 그 정의는 20260925000000과 같은 방식이다.
--  - X-1 : budget_executions·import_snapshots를 한 트랜잭션으로 묶어야 하므로 RPC다.
--  - N-5 : version +1과 updated_at은 set_updated_meta 트리거가 올린다. 여기서는 updated_by만 채운다.
--  - N-13: FK는 "이 인력·이 산출근거·이 집행이 이 과제·연차 것인가"를 막지 못한다. RPC가 거부한다(IN-13).
--
-- ─ 예외 규약 (lib/db/import-snapshots.ts의 판정 규칙과 짝이다) ──
--   PostgREST는 raise exception을 전부 SQLSTATE P0001로 내려보내므로 리포지토리는 메시지로 가른다:
--     · /먼저 수정|stale/i          → StaleDataError   (이 파일에는 없다 — O-1 불일치는 충돌 목록으로 돌려준다)
--     · /찾을 수 없습니다|not found/i → NotFoundError   (과제·스냅샷이 없는 경우만)
--     · 그 외 전부                   → RuleViolationError
--   연차당 12행 불변식 위반처럼 "없음"이지만 사용자가 찾는 대상이 아닌 경우는 일부러
--   "찾을 수 없습니다"를 쓰지 않는다. 문구를 바꾸면 리포지토리의 정규식도 함께 바꾼다.
--
-- 수행 양식 스냅샷 jsonb 형식 (IN-14. 총괄표 = schemaVersion 1, 산출근거 = 2):
--   {
--     "schemaVersion": 3, "projectId": uuid, "capturedAt": timestamptz,
--     "kind": "execution_form",
--     "source": { "fileName", "sheetName", "profileId": null, "fileHash" },
--     "items": [],                       -- 계획액은 건드리지 않는다
--     "executions": {
--       "added":   [ 추가한 집행 id ],
--       "before":  [ 변경·삭제 **전** budget_executions 행 전체 (DB snake_case 원본) ],
--       "deleted": [ before 중 삭제한 행의 id ]   -- 나머지 before는 변경한 행이다
--     }
--   }
--   deleted 목록이 따로 있는 이유: before 행만으로는 "반영이 지운 행"과 "반영이 고친 뒤 다른
--   경로로 지워진 행"을 가를 수 없다. 뒤의 것을 되살리면 남의 삭제를 조용히 덮는다 — IN-14는
--   그 경우를 "이미 삭제됨"으로 거부하라고 한다.
--   **executions 키는 비어 있어도 항상 존재한다** — 복원이 키 유무로 스냅샷 종류를 가른다.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. budget_executions 내역 7컬럼 (§5.12 Phase 20 추가) — 전부 선택 필드다
--    spec만 not null이다(§5.12 spec: string). 기존 행은 default ''로 채워진다.
--    member_id·detail_id는 가리키는 행이 사라져도 집행 실적은 남아야 하므로 set null이다.
-- -----------------------------------------------------------------------------
alter table public.budget_executions
  add column subcategory_code text,
  add column spec             text not null default '',
  add column unit_price       bigint check (unit_price >= 0),
  add column factors          jsonb,
  -- 집행은 축 null을 허용한다 — §5.17 budget_details.axis(not null)와 다르다
  add column axis             text check (axis in ('cash', 'in_kind')),
  add column member_id        uuid references public.members (id) on delete set null,
  add column detail_id        uuid references public.budget_details (id) on delete set null;

-- FK on delete set null은 참조하는 쪽을 훑는다. 인덱스가 없으면 인력·산출근거 한 건 삭제가
-- budget_executions 전체 순차 탐색이 된다 (D-15 교체는 산출근거를 수십 건씩 지운다)
create index budget_executions_member_idx on public.budget_executions (member_id);
create index budget_executions_detail_idx on public.budget_executions (detail_id);

-- -----------------------------------------------------------------------------
-- 2. ImportKind 확장 (§5.12.1, S-11)
--    스냅샷 종류는 import_snapshots의 컬럼이 아니라 jsonb snapshot.kind다(그런 컬럼이 없다).
--    check 제약은 import_profiles.kind에만 있고, 앱의 ImportKind 타입과 맞추려고 네 값을 허용한다.
--    넓히기만 하므로 기존 행은 새 제약을 그대로 통과한다. 기본값 'budget_plan'도 그대로 둔다.
-- -----------------------------------------------------------------------------
alter table public.import_profiles
  drop constraint if exists import_profiles_kind_check;

alter table public.import_profiles
  add constraint import_profiles_kind_check
  check (kind in ('budget_plan', 'budget_detail', 'execution_form', 'goal_form'));

-- -----------------------------------------------------------------------------
-- 3. commit_execution_form (IN-10·IN-11·IN-13, I-17)
--    p_adds       : [{ "category", "date", "amount",                       -- 필수
--                      "description", "note", "subcategory_code", "spec",
--                      "unit_price", "factors", "axis", "member_id", "detail_id" }]  -- 선택
--                   id를 싣지 않는다. budget_item은 (p_year_id, category)로 찾는다
--    p_updates    : [{ "id", "date", "amount", "description", "subcategory_code",
--                      "spec", "unit_price", "factors", "axis", "member_id", "detail_id" }]
--                   전부 필수(값은 null 가능). "note"는 선택 — 없으면 기존 값을 유지한다.
--                   "category"도 선택이다. 바꾸는 값이 아니라 **category-moved 검사용**이고(S-8),
--                   RPC는 변경에서 budget_item_id를 쓰지 않으므로 없어도 비목은 옮겨지지 않는다
--    p_delete_ids : 삭제할 집행 id. includeDeletes가 꺼져 있으면 빈 배열이다
--    p_expected   : { "<집행 id>": 내려받을 때의 version } — `_meta` execution:<id>(IN-2).
--                   변경·삭제 대상 id는 전부 여기에 있어야 한다
--    p_source     : { "fileName", "sheetName", "fileHash" } — 스냅샷 메타
--    반환 : { snapshotId: uuid, added, updated, deleted, conflicts: [{ id, reason }] }
--           reason = 'changed'(내려받은 뒤 version이 바뀜) | 'deleted'(이미 없음).
--           conflicts는 비어 있어도 항상 있다
-- -----------------------------------------------------------------------------
create or replace function public.commit_execution_form(
  p_project_id uuid,
  p_year_id    uuid,
  p_adds       jsonb  default '[]'::jsonb,
  p_updates    jsonb  default '[]'::jsonb,
  p_delete_ids uuid[] default '{}'::uuid[],
  p_expected   jsonb  default '{}'::jsonb,
  p_source     jsonb  default '{}'::jsonb
) returns jsonb language plpgsql security invoker as $$
declare
  c_categories constant text[] := array[
    'personnel', 'student_personnel', 'facility_equipment', 'material',
    'consignment', 'international', 'burden', 'activity',
    'promotion', 'allowance', 'indirect', 'other'];
  c_update_keys constant text[] := array[
    'id', 'date', 'amount', 'description', 'subcategory_code',
    'spec', 'unit_price', 'factors', 'axis', 'member_id', 'detail_id'];

  v_adds        jsonb  := coalesce(p_adds, '[]'::jsonb);
  v_updates     jsonb  := coalesce(p_updates, '[]'::jsonb);
  v_deletes     uuid[] := coalesce(p_delete_ids, '{}'::uuid[]);
  v_expected    jsonb  := coalesce(p_expected, '{}'::jsonb);
  v_source      jsonb  := coalesce(p_source, '{}'::jsonb);

  v_update_ids  uuid[];
  v_added       uuid[] := '{}'::uuid[];
  v_deleted_ids uuid[] := '{}'::uuid[];
  v_before      jsonb  := '[]'::jsonb;
  v_conflicts   jsonb  := '[]'::jsonb;
  v_updated     integer := 0;
  v_deleted     integer := 0;
  v_total       integer;
  v_distinct    integer;
  v_n           integer;
  v_snapshot_id uuid;
  v_item_id     uuid;
  v_new_id      uuid;
  v_id          uuid;
  v_exp         bigint;
  v_date        date;
  v_old         public.budget_executions%rowtype;
  r             jsonb;
  f             jsonb;
begin
  -- ── 입력 검증 (한 건이라도 어긋나면 아무것도 반영하지 않는다) ──

  if p_project_id is null or p_year_id is null then
    raise exception '반영할 과제와 연차를 지정해야 합니다';
  end if;
  if not exists (select 1 from projects where id = p_project_id) then
    raise exception '과제를 찾을 수 없습니다';
  end if;
  if not exists (select 1 from years where id = p_year_id and project_id = p_project_id) then
    raise exception '이 과제에 속하지 않은 연차입니다';
  end if;

  if jsonb_typeof(v_adds) <> 'array' then
    raise exception '추가할 집행 목록이 배열이 아닙니다';
  end if;
  if jsonb_typeof(v_updates) <> 'array' then
    raise exception '변경할 집행 목록이 배열이 아닙니다';
  end if;
  if jsonb_typeof(v_expected) <> 'object' then
    raise exception '충돌 판정 기준 version 목록이 객체가 아닙니다';
  end if;
  if jsonb_array_length(v_adds) = 0 and jsonb_array_length(v_updates) = 0
     and cardinality(v_deletes) = 0 then
    -- 빈 반영은 아무것도 바꾸지 않는다 (commit_import·commit_detail_import와 같은 판단)
    raise exception '반영할 집행 행이 없습니다';
  end if;

  if array_position(v_deletes, null) is not null then
    raise exception '삭제할 집행 id가 비어 있습니다';
  end if;
  if exists (
    select 1 from jsonb_array_elements(v_updates) as t(row)
     where jsonb_typeof(t.row) <> 'object' or not (t.row ?& c_update_keys)
  ) then
    raise exception '변경할 집행 행에 필요한 필드가 없습니다';
  end if;
  if exists (
    select 1 from jsonb_array_elements(v_updates) as t(row)
     where nullif(t.row ->> 'id', '') is null
  ) then
    raise exception '변경할 집행 행의 id가 비어 있습니다';
  end if;
  -- 추가는 새 행만 만든다. id가 실려 오면 기존 행을 O-1 비교 없이 고치게 되므로 거부한다
  if exists (
    select 1 from jsonb_array_elements(v_adds) as t(row)
     where jsonb_typeof(t.row) <> 'object' or nullif(t.row ->> 'id', '') is not null
  ) then
    raise exception '수행 양식의 새 행에 기존 집행 id가 포함되어 있습니다';
  end if;

  select coalesce(array_agg((t.row ->> 'id')::uuid), '{}'::uuid[])
    into v_update_ids
    from jsonb_array_elements(v_updates) as t(row);

  select count(*), count(distinct t.id)
    into v_total, v_distinct
    from unnest(v_update_ids || v_deletes) as t(id);
  if v_total <> v_distinct then
    raise exception '변경·삭제 목록에 같은 집행이 두 번 들어 있습니다';
  end if;

  -- IN-10: 충돌 기준은 내려받은 시점의 version이다. 기준이 없으면 비교 없이 덮어쓰게 된다
  if exists (
    select 1 from unnest(v_update_ids || v_deletes) as t(id)
     where jsonb_typeof(v_expected -> t.id::text) is distinct from 'number'
  ) then
    raise exception '충돌 판정 기준 version이 없는 집행 행이 있습니다';
  end if;

  -- 추가 행은 비목으로 셀을 찾으므로 필수다. 변경 행은 선택(있으면 category-moved 검사에 쓴다)
  if exists (
    select 1 from jsonb_array_elements(v_adds) as t(row)
     where (t.row ->> 'category') is null
  ) then
    raise exception '추가할 집행 행에 비목이 없습니다';
  end if;

  -- 추가·변경 행 공통 필드 (§5.12, IN-11). 파서가 이미 막지만 RPC가 최후 방어선이다
  for r in select elem from jsonb_array_elements(v_adds || v_updates) as t(elem) loop
    if r ? 'category'
       and ((r ->> 'category') is null or not ((r ->> 'category') = any(c_categories))) then
      raise exception '알 수 없는 비목이 포함되어 있습니다';
    end if;

    if nullif(r ->> 'date', '') is null then
      raise exception '집행일이 비어 있습니다';
    end if;
    if (r ->> 'date') !~ '^\d{4}-\d{2}-\d{2}$' then
      raise exception '집행일 형식이 올바르지 않습니다: %', r ->> 'date';
    end if;
    begin
      v_date := (r ->> 'date')::date;
    exception when others then
      raise exception '집행일 형식이 올바르지 않습니다: %', r ->> 'date';
    end;

    -- §5.12: 집행액은 0 이상 원 단위 정수다(절대 규칙 4)
    if jsonb_typeof(r -> 'amount') is distinct from 'number' then
      raise exception '집행액이 비어 있거나 숫자가 아닙니다';
    end if;
    if (r ->> 'amount')::numeric <> trunc((r ->> 'amount')::numeric) then
      raise exception '집행액은 원 단위 정수여야 합니다';
    end if;
    if (r ->> 'amount')::numeric < 0 then
      raise exception '집행액은 0 이상이어야 합니다';
    end if;

    if jsonb_typeof(r -> 'description') not in ('string', 'null') then
      raise exception '품명이 문자열이 아닙니다';
    end if;
    if char_length(coalesce(r ->> 'description', '')) > 200 then
      raise exception '품명은 200자 이내여야 합니다';
    end if;
    if jsonb_typeof(r -> 'spec') not in ('string', 'null') then
      raise exception '규격이 문자열이 아닙니다';
    end if;

    -- 세목 미지정은 null이다(IN-4 `비목:` 슬롯). 빈 문자열은 둘 중 무엇인지 모호하다
    if jsonb_typeof(r -> 'subcategory_code') not in ('string', 'null') or (r ->> 'subcategory_code') = '' then
      raise exception '세목 코드가 올바르지 않습니다';
    end if;

    if r ? 'unit_price' and jsonb_typeof(r -> 'unit_price') <> 'null' then
      if jsonb_typeof(r -> 'unit_price') <> 'number'
         or (r ->> 'unit_price')::numeric <> trunc((r ->> 'unit_price')::numeric)
         or (r ->> 'unit_price')::numeric < 0 then
        raise exception '단가는 0 이상 원 단위 정수여야 합니다';
      end if;
    end if;

    if r ? 'factors' and jsonb_typeof(r -> 'factors') <> 'null' then
      if jsonb_typeof(r -> 'factors') <> 'array' then
        raise exception '인자 목록이 배열이 아닙니다';
      end if;
      -- §5.12: 0~3개 (§5.17과 같은 형)
      if jsonb_array_length(r -> 'factors') > 3 then
        raise exception '인자는 3개까지입니다';
      end if;
      for f in select elem from jsonb_array_elements(r -> 'factors') as t(elem) loop
        if jsonb_typeof(f) <> 'object'
           or jsonb_typeof(f -> 'label') is distinct from 'string'
           or jsonb_typeof(f -> 'value') is distinct from 'number' then
          raise exception '인자 형식이 올바르지 않습니다';
        end if;
        if (f ->> 'value')::numeric < 0 then
          raise exception '인자 값은 0 이상이어야 합니다';
        end if;
      end loop;
    end if;

    if (r ->> 'axis') is not null and (r ->> 'axis') not in ('cash', 'in_kind') then
      raise exception '축은 현금(cash) 또는 현물(in_kind)만 허용합니다';
    end if;

    -- IN-13 / N-13: 파서는 `_meta` 목록으로 걸렀고, 여기서 DB 기준으로 한 번 더 본다
    if nullif(r ->> 'member_id', '') is not null
       and not exists (
         select 1 from members m
          where m.id = (r ->> 'member_id')::uuid and m.project_id = p_project_id
       ) then
      raise exception '이 과제에 속하지 않은 참여인력입니다';
    end if;
    if nullif(r ->> 'detail_id', '') is not null
       and not exists (
         select 1 from budget_details d
          where d.id = (r ->> 'detail_id')::uuid
            and d.project_id = p_project_id and d.year_id = p_year_id
       ) then
      raise exception '이 과제·연차에 속하지 않은 산출근거입니다';
    end if;
  end loop;

  -- IN-13: 변경·삭제 대상 중 **지금 존재하는** 행은 이 과제·연차의 것이어야 한다.
  -- 없는 행은 경계 위반이 아니라 충돌(이미 삭제됨)이다 — 아래 반영 루프가 다룬다
  if exists (
    select 1 from budget_executions e
      join budget_items b on b.id = e.budget_item_id
     where e.id = any(v_update_ids || v_deletes)
       and (b.project_id <> p_project_id or b.year_id <> p_year_id)
  ) then
    raise exception '이 과제·연차에 속하지 않은 집행 내역이 포함되어 있습니다';
  end if;

  -- S-8 / IN-10 category-moved: 변경은 budget_item_id를 바꾸지 않는다. 파일에서 다른 비목의
  -- 세목으로 옮겨진 기존 행을 조용히 원래 비목에 두면 사용자가 본 것과 저장이 어긋나고,
  -- 옮기면 비목별 집행률이 조용히 이동한다. 파서가 막지만 반영에서도 거부한다
  -- category가 없는 변경 행은 이 검사를 건너뛰지만 비목이 바뀌지도 않는다(budget_item_id를 쓰지 않는다)
  if exists (
    select 1 from jsonb_array_elements(v_updates) as t(row)
      join budget_executions e on e.id = (t.row ->> 'id')::uuid
      join budget_items b on b.id = e.budget_item_id
     where t.row ? 'category' and b.category is distinct from (t.row ->> 'category')
  ) then
    raise exception '기존 집행 행을 다른 비목으로 옮길 수 없습니다. 그 행을 지우고 새 행으로 적으세요';
  end if;

  -- 연차당 12행 불변식(§5.12): 추가 행의 비목 셀이 없으면 데이터가 이미 깨진 것이다
  if exists (
    select 1 from jsonb_array_elements(v_adds) as t(row)
     where not exists (
       select 1 from budget_items b
        where b.year_id = p_year_id and b.category = (t.row ->> 'category')
     )
  ) then
    raise exception '이 연차에 비목 행이 없습니다. 연차당 12개 비목 행이 있어야 합니다';
  end if;

  -- ── 변경 (IN-10: O-1 불일치는 그 행만 건너뛴다 — 전체 롤백이 아니다) ──
  for r in select elem from jsonb_array_elements(v_updates) as t(elem) loop
    v_id  := (r ->> 'id')::uuid;
    v_exp := (v_expected ->> v_id::text)::numeric::bigint;

    -- 스냅샷에 담을 변경 전 원본. 잠가 두어 아래 조건부 UPDATE와 사이에 끼어들 틈을 없앤다
    select * into v_old from budget_executions where id = v_id for update;
    if not found then
      v_conflicts := v_conflicts || jsonb_build_array(jsonb_build_object('id', v_id, 'reason', 'deleted'));
      continue;
    end if;

    update budget_executions
       set date             = (r ->> 'date')::date,
           amount           = (r ->> 'amount')::numeric::bigint,
           description      = coalesce(r ->> 'description', ''),
           note             = case when r ? 'note' then coalesce(r ->> 'note', '') else note end,
           subcategory_code = r ->> 'subcategory_code',
           spec             = coalesce(r ->> 'spec', ''),
           unit_price       = (r ->> 'unit_price')::numeric::bigint,
           factors          = nullif(r -> 'factors', 'null'::jsonb),
           axis             = r ->> 'axis',
           member_id        = nullif(r ->> 'member_id', '')::uuid,
           detail_id        = nullif(r ->> 'detail_id', '')::uuid,
           updated_by       = auth.uid()
     where id = v_id and version = v_exp;
    get diagnostics v_n = row_count;
    if v_n = 0 then
      v_conflicts := v_conflicts || jsonb_build_array(jsonb_build_object('id', v_id, 'reason', 'changed'));
      continue;
    end if;

    v_before  := v_before || jsonb_build_array(to_jsonb(v_old));
    v_updated := v_updated + 1;
  end loop;

  -- ── 삭제 (S-9: 삭제도 같은 version 비교 — 내려받은 뒤 바뀐 행은 지우지 않는다) ──
  foreach v_id in array v_deletes loop
    v_exp := (v_expected ->> v_id::text)::numeric::bigint;

    select * into v_old from budget_executions where id = v_id for update;
    if not found then
      v_conflicts := v_conflicts || jsonb_build_array(jsonb_build_object('id', v_id, 'reason', 'deleted'));
      continue;
    end if;

    delete from budget_executions where id = v_id and version = v_exp;
    get diagnostics v_n = row_count;
    if v_n = 0 then
      v_conflicts := v_conflicts || jsonb_build_array(jsonb_build_object('id', v_id, 'reason', 'changed'));
      continue;
    end if;

    v_before      := v_before || jsonb_build_array(to_jsonb(v_old));
    v_deleted_ids := v_deleted_ids || v_id;
    v_deleted     := v_deleted + 1;
  end loop;

  -- ── 추가 ──
  for r in select elem from jsonb_array_elements(v_adds) as t(elem) loop
    select id into v_item_id
      from budget_items
     where year_id = p_year_id and category = (r ->> 'category');

    -- version은 넣지 않는다 — 기본값 1이 IN-14 복원의 "삽입 시 값" 기준이다
    insert into budget_executions (budget_item_id, date, amount, description, note,
                                   subcategory_code, spec, unit_price, factors, axis,
                                   member_id, detail_id, created_by, updated_by)
    values (
      v_item_id,
      (r ->> 'date')::date,
      (r ->> 'amount')::numeric::bigint,
      coalesce(r ->> 'description', ''),
      coalesce(r ->> 'note', ''),
      r ->> 'subcategory_code',
      coalesce(r ->> 'spec', ''),
      (r ->> 'unit_price')::numeric::bigint,
      nullif(r -> 'factors', 'null'::jsonb),
      r ->> 'axis',
      nullif(r ->> 'member_id', '')::uuid,
      nullif(r ->> 'detail_id', '')::uuid,
      auth.uid(), auth.uid()
    )
    returning id into v_new_id;

    v_added := v_added || v_new_id;
  end loop;

  -- ── I-17 / IN-14: 같은 트랜잭션에서 스냅샷을 남긴다 ──
  -- 전부 충돌이라 바뀐 행이 없어도 남긴다 — 반환의 snapshotId는 항상 있고, 그 스냅샷의
  -- 복원은 되돌릴 것이 없어 0건으로 끝난다(아무것도 바뀌지 않았다는 사실과 같다)
  insert into import_snapshots (project_id, snapshot, created_by, updated_by)
  values (
    p_project_id,
    jsonb_build_object(
      'schemaVersion', 3,
      'projectId',     p_project_id,
      'capturedAt',    now(),
      'kind',          'execution_form',
      'source', jsonb_build_object(
        -- 형식을 항상 같게 유지해 설정 화면(§7.14)의 파싱에 옵션 분기가 없게 한다
        'fileName',  coalesce(v_source ->> 'fileName', ''),
        'sheetName', coalesce(v_source ->> 'sheetName', ''),
        'profileId', null,   -- 우리 양식은 프로파일을 쓰지 않는다
        'fileHash',  coalesce(v_source ->> 'fileHash', '')
      ),
      'items', '[]'::jsonb,   -- 계획액은 바꾸지 않는다
      'executions', jsonb_build_object(
        'added',   to_jsonb(v_added),
        'before',  v_before,
        'deleted', to_jsonb(v_deleted_ids)
      )
    ),
    auth.uid(), auth.uid()
  )
  returning id into v_snapshot_id;

  -- I-17: 과제별 최근 20개만 유지 (commit_import·commit_detail_import와 같은 창)
  delete from import_snapshots
   where project_id = p_project_id
     and id not in (
       select id from import_snapshots
        where project_id = p_project_id
        order by created_at desc, id desc
        limit 20
     );

  return jsonb_build_object(
    'snapshotId', v_snapshot_id,
    'added',      cardinality(v_added),
    'updated',    v_updated,
    'deleted',    v_deleted,
    'conflicts',  v_conflicts
  );
end; $$;

revoke execute on function public.commit_execution_form(uuid, uuid, jsonb, jsonb, uuid[], jsonb, jsonb) from public, anon;
grant execute on function public.commit_execution_form(uuid, uuid, jsonb, jsonb, uuid[], jsonb, jsonb) to authenticated;

-- -----------------------------------------------------------------------------
-- 4. restore_import_snapshot 확장 (IN-14)
--    20260816000000_commit_detail_import.sql의 정의 전문에서 바뀐 곳은 둘뿐이다:
--      ① 선언부에 수행 스냅샷용 변수를 더했다
--      ② items 형식 검사 **직후** `executions` 키가 있으면 수행 블록을 타고 그 안에서 반환한다
--
--    ⚠ **executions 키가 없는 스냅샷(총괄표·산출근거)의 동작은 한 글자도 바뀌지 않는다** —
--    수행 블록 뒤의 본문은 20260816000000과 같다. 바뀌면 총괄표·산출근거 복원의 회귀다.
--
--    ⚠ 집행 행 삭제·부활은 **I-17("복원이 행을 삭제하지 않는다")의 명시적 예외**다(IN-14).
--    반영이 행을 추가·삭제하므로 값만 되돌려서는 원상태가 되지 않는다. budget_items 행은
--    여전히 지우지 않는다. 복원은 새 스냅샷을 만들지 않는다(I-17).
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
  -- IN-14: 수행 스냅샷 전용. 키가 없으면 null → 아래 기존 경로 그대로
  v_executions   jsonb;
  v_exec_added   uuid[];
  v_exec_deleted uuid[];
  v_exec_before  jsonb;
  v_exec_revive  jsonb;
  v_exec_removed integer := 0;
  v_exec_revert  integer := 0;
  v_exec_revived integer := 0;
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

  -- ── IN-14: 수행 양식 스냅샷만 이 블록을 타고, 블록 안에서 반환한다 ──
  -- 아래 "items가 비었으면 0건 성공" 경로에 떨어지면 아무것도 되돌리지 않고 성공한다(절대 규칙 5)
  v_executions := v_snapshot -> 'executions';
  if v_executions is not null then
    if jsonb_typeof(v_executions) <> 'object'
       or jsonb_typeof(v_executions -> 'added')   is distinct from 'array'
       or jsonb_typeof(v_executions -> 'before')  is distinct from 'array'
       or jsonb_typeof(v_executions -> 'deleted') is distinct from 'array'
       or jsonb_array_length(v_items) <> 0
       or v_details is not null then
      raise exception '스냅샷 형식이 올바르지 않아 복원할 수 없습니다';
    end if;

    select coalesce(array_agg(t.id::uuid), '{}'::uuid[])
      into v_exec_added
      from jsonb_array_elements_text(v_executions -> 'added') as t(id);
    select coalesce(array_agg(t.id::uuid), '{}'::uuid[])
      into v_exec_deleted
      from jsonb_array_elements_text(v_executions -> 'deleted') as t(id);
    v_exec_before := v_executions -> 'before';

    if exists (
      select 1 from unnest(v_exec_deleted) as d(id)
       where not exists (
         select 1 from jsonb_to_recordset(v_exec_before) as b("id" uuid) where b."id" = d.id
       )
    ) then
      raise exception '스냅샷 형식이 올바르지 않아 복원할 수 없습니다';
    end if;

    -- N-13: 원본 행의 비목 셀이 이 과제에 남아 있어야 한다. 연차가 지워졌으면 cascade로
    -- 셀이 없고, 부분 복원은 "되돌렸다"는 오해를 남기므로 전부 거부한다 (I-18과 같은 기준)
    if exists (
      select 1 from jsonb_to_recordset(v_exec_before) as b("budget_item_id" uuid)
        left join budget_items bi on bi.id = b."budget_item_id" and bi.project_id = v_project_id
       where bi.id is null
    ) then
      raise exception '스냅샷의 연차가 삭제되었거나 다른 과제로 옮겨져 복원할 수 없습니다';
    end if;

    -- 검사와 되돌리기 사이에 다른 경로의 수정이 끼어들지 못하게 대상 행을 잠근다
    perform 1 from budget_executions e
     where e.id = any(v_exec_added)
        or e.id in (select b."id" from jsonb_to_recordset(v_exec_before) as b("id" uuid))
       for update;

    -- IN-14 "스냅샷 이후 다시 바뀌었으면 전체 거부" — 일부만 되돌리면 사용자가 모르는 혼합 상태가 된다.
    -- 추가 행: 삽입 시 version(기본값 1) 그대로 남아 있어야 한다
    if exists (
      select 1 from unnest(v_exec_added) as a(id)
        left join budget_executions e on e.id = a.id
        left join budget_items bi on bi.id = e.budget_item_id
       where e.id is null or e.version <> 1 or bi.project_id is distinct from v_project_id
    ) then
      raise exception '수행 양식으로 추가한 집행이 반영 뒤 다시 바뀌었거나 삭제되어 복원할 수 없습니다';
    end if;

    -- 변경 행: 반영의 UPDATE 한 번(set_updated_meta +1)만 거친 상태여야 한다
    if exists (
      select 1 from jsonb_to_recordset(v_exec_before) as b("id" uuid, "version" bigint)
        left join budget_executions e on e.id = b."id"
       where not (b."id" = any(v_exec_deleted))
         and (e.id is null or e.version <> b."version" + 1)
    ) then
      raise exception '수행 양식으로 변경한 집행이 반영 뒤 다시 바뀌었거나 삭제되어 복원할 수 없습니다';
    end if;

    -- 삭제 행: id를 보존해 되살리므로 같은 id가 있으면 안 된다
    if exists (select 1 from budget_executions e where e.id = any(v_exec_deleted)) then
      raise exception '되살릴 집행이 이미 존재해 복원할 수 없습니다';
    end if;

    -- 원본이 가리키던 인력·산출근거가 그 뒤 지워졌으면 참조를 null로 되돌린다. 행이 남아 있었다면
    -- FK의 on delete set null이 똑같이 했을 값이다 — 지어낸 값이 아니다. 그대로 넣으면 FK 위반으로
    -- 복원이 영영 불가능해진다(산출근거는 D-15 교체로 id가 자주 바뀐다)
    select coalesce(jsonb_agg(
             b.row
             || case when nullif(b.row ->> 'member_id', '') is not null
                      and not exists (select 1 from members m where m.id = (b.row ->> 'member_id')::uuid)
                     then jsonb_build_object('member_id', null) else '{}'::jsonb end
             || case when nullif(b.row ->> 'detail_id', '') is not null
                      and not exists (select 1 from budget_details d where d.id = (b.row ->> 'detail_id')::uuid)
                     then jsonb_build_object('detail_id', null) else '{}'::jsonb end
           ), '[]'::jsonb)
      into v_exec_before
      from jsonb_array_elements(v_exec_before) as b(row);

    -- ① 추가된 행을 지운다
    delete from budget_executions where id = any(v_exec_added);
    get diagnostics v_exec_removed = row_count;
    if v_exec_removed <> cardinality(v_exec_added) then
      raise exception '집행 복원 건수가 스냅샷과 다릅니다. 복원을 취소했습니다';
    end if;

    -- ② 변경된 행을 원본 값으로 되돌린다. version은 되돌리지 않는다 — 트리거가 올린 값을 그대로
    -- 두어야 원본 version을 들고 있는 편집이 O-1에 걸린다. budget_item_id는 반영이 바꾸지 않는다(S-8)
    update budget_executions e
       set date             = b.date,
           amount           = b.amount,
           description      = b.description,
           note             = b.note,
           subcategory_code = b.subcategory_code,
           spec             = b.spec,
           unit_price       = b.unit_price,
           factors          = b.factors,
           axis             = b.axis,
           member_id        = b.member_id,
           detail_id        = b.detail_id,
           updated_by       = auth.uid()
      from jsonb_populate_recordset(null::public.budget_executions, v_exec_before) as b
     where e.id = b.id and not (b.id = any(v_exec_deleted));
    get diagnostics v_exec_revert = row_count;
    if v_exec_revert <> jsonb_array_length(v_exec_before) - cardinality(v_exec_deleted) then
      raise exception '집행 복원 건수가 스냅샷과 다릅니다. 복원을 취소했습니다';
    end if;

    -- ③ 삭제된 행을 id·created_at·version까지 원본 그대로 되살린다 (D-17a·restore_backup과 같은 방식).
    -- set_updated_meta는 before update 트리거라 insert에는 걸리지 않는다
    select coalesce(jsonb_agg(b.row), '[]'::jsonb)
      into v_exec_revive
      from jsonb_array_elements(v_exec_before) as b(row)
     where (b.row ->> 'id')::uuid = any(v_exec_deleted);

    insert into budget_executions
    select * from jsonb_populate_recordset(null::public.budget_executions, v_exec_revive);
    get diagnostics v_exec_revived = row_count;
    if v_exec_revived <> cardinality(v_exec_deleted) then
      raise exception '집행 복원 건수가 스냅샷과 다릅니다. 복원을 취소했습니다';
    end if;

    -- restored는 되돌린 budget_items 셀 수다 — 수행 스냅샷은 계획액을 건드리지 않았으므로 0
    return jsonb_build_object(
      'snapshotId',         p_snapshot_id,
      'restored',           0,
      'executionsDeleted',  v_exec_removed,
      'executionsReverted', v_exec_revert,
      'executionsRestored', v_exec_revived
    );
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

-- -----------------------------------------------------------------------------
-- 5. restore_backup 갱신 (§8.7 K-7, §8.8, S-12)
--    c_tables는 20260925000000_staff_salary.sql과 같다(lib/db/backup.ts RESTORE_TABLES와 순서까지 일치).
--    바뀐 곳은 budget_executions에 대한 두 가지뿐이다:
--      ① spec 기본값 — 옛(Phase 20 이전) 백업 행에는 spec 키가 없어 jsonb_populate_recordset이
--         null을 넣고 not null이 실패한다. §8.8 "옛 백업은 새 컬럼이 기본값으로 복원된다"를 지키려고
--         **이 한 컬럼만** 명시해 ''을 채운다. 키가 있으면(null이어도) 행의 값이 이긴다 —
--         새 백업의 null은 조용히 메꾸지 않고 not null로 실패한다. 나머지 6컬럼은 nullable이라
--         null이 곧 기본값이다.
--      ② detail_id 2차 복원 — c_tables 정순에서 budget_executions가 budget_details보다 **앞**이라
--         한 번에 넣으면 새 FK(detail_id → budget_details)가 실패한다. 순서를 바꾸면 backup.ts와
--         어긋나 복원이 거부되므로, projects의 순환 FK와 같은 방식으로 빼고 넣은 뒤 2차로 채운다.
-- -----------------------------------------------------------------------------
create or replace function public.restore_backup(payload jsonb)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  -- FK 의존 정순 = 20260802000000_initial_schema.sql의 테이블 생성 순서
  -- (app_users·app_settings 제외 — K-8)
  c_tables constant text[] := array[
    'staff', 'staff_salaries',
    'projects', 'organizations', 'members', 'stages', 'years', 'tasks', 'milestones',
    'deliverables', 'deliverable_achievements', 'tech_targets', 'tech_target_records',
    'budget_items', 'budget_executions', 'budget_details', 'budget_rules', 'risks', 'notes', 'todos',
    'import_profiles', 'import_snapshots',
    'task_members', 'task_deliverables', 'task_tech_targets',
    'achievement_members', 'note_attendees'
  ];
  v_current_version bigint;
  v_payload_version bigint;
  v_settings jsonb;
  v_rows jsonb;
  t text;
  i integer;
begin
  -- 호출자 자기검증 (approve_user 패턴): definer라 RLS가 안 걸리므로 직접 확인한다
  if not exists (select 1 from app_users where id = auth.uid() and active = true) then
    raise exception '복원 권한이 없습니다';
  end if;

  -- K-5: schemaVersion 불일치 파일의 복원 거부
  select schema_version into v_current_version from app_settings;
  v_payload_version := (payload ->> 'schemaVersion')::bigint;
  if v_payload_version is null or v_payload_version <> v_current_version then
    raise exception '백업 파일의 스키마 버전(%)이 현재 스키마 버전(%)과 다릅니다',
      coalesce(v_payload_version::text, '없음'), v_current_version;
  end if;

  -- 형식 검증: 대상 테이블 키가 배열이 아니면 "삭제만 되고 삽입은 0건"인
  -- 무음 데이터 파괴가 되므로 시작 전에 거부한다 (K-5의 "형식을 지킨다")
  foreach t in array c_tables || array['app_settings'] loop
    if jsonb_typeof(payload #> array['tables', t]) is distinct from 'array' then
      raise exception '백업 파일에 % 데이터가 없습니다', t;
    end if;
  end loop;

  -- K-7 ①: FK 의존 역순 전 행 DELETE.
  -- `where true`는 pg-safeupdate 통과용이다 — 의미는 전 행 삭제로 동일하다.
  -- members 삭제 시 app_users.member_id는 FK on delete set null로 끊긴다 —
  -- K-8에 따라 app_users를 복원하지 않으므로 이 링크는 되살리지 않는다.
  for i in reverse array_length(c_tables, 1) .. 1 loop
    execute format('delete from public.%I where true', c_tables[i]);
  end loop;

  -- K-7 ②: 정순 INSERT — id·created_by/updated_by·version·타임스탬프 전부 payload 원본 보존.
  -- jsonb_populate_recordset은 모르는 키를 무시하고, 누락 컬럼은 null이 되어
  -- not null 제약이 즉시 실패시킨다 (조용히 기본값으로 메꾸지 않는다 — 예외는 아래
  -- budget_executions.spec 하나이고 §8.8이 근거다).
  foreach t in array c_tables loop
    v_rows := payload #> array['tables', t];
    if t = 'projects' then
      -- 순환 FK: pm_member_id/lead_org_id는 members/organizations 삽입 뒤 2차로 복원한다
      select coalesce(jsonb_agg(r - 'pm_member_id' - 'lead_org_id'), '[]'::jsonb)
        into v_rows
        from jsonb_array_elements(v_rows) r;
    end if;
    if t = 'budget_executions' then
      -- §8.8: 옛 백업에 없는 spec만 ''로 채운다(`||`는 오른쪽이 이기므로 행에 키가 있으면 행 값이 남는다).
      -- detail_id는 budget_details 삽입 뒤 2차로 복원한다 (정순에서 budget_details가 뒤다)
      select coalesce(jsonb_agg(('{"spec": ""}'::jsonb || r) - 'detail_id'), '[]'::jsonb)
        into v_rows
        from jsonb_array_elements(v_rows) r;
    end if;
    -- tasks.parent_id 자기참조는 정렬이 필요 없다:
    -- not deferrable FK도 검사는 문(statement) 단위라 한 INSERT 안의 상호 참조는 통과한다
    execute format(
      'insert into public.%I select * from jsonb_populate_recordset(null::public.%I, $1)',
      t, t) using v_rows;
  end loop;

  -- 순환 FK 2차 복원 — set_updated_meta가 version/updated_at을 덮지 않도록 잠시 끈다.
  -- (id 보존과 같은 원리로 audit 컬럼도 payload 원본을 유지해야 한다.
  --  ALTER TABLE은 트랜잭션에 묶이므로 실패 시 함께 롤백된다.)
  alter table public.projects disable trigger set_updated_meta;
  update projects p
     set pm_member_id = (r ->> 'pm_member_id')::uuid,
         lead_org_id  = (r ->> 'lead_org_id')::uuid
    from jsonb_array_elements(payload #> '{tables,projects}') r
   where p.id = (r ->> 'id')::uuid
     and ((r ->> 'pm_member_id') is not null or (r ->> 'lead_org_id') is not null);
  alter table public.projects enable trigger set_updated_meta;

  -- budget_executions.detail_id 2차 복원 — projects와 같은 이유로 트리거를 끈다.
  -- 옛 백업에는 detail_id 키가 없어 아무 행도 갱신되지 않는다(null이 곧 기본값)
  alter table public.budget_executions disable trigger set_updated_meta;
  update budget_executions e
     set detail_id = (r ->> 'detail_id')::uuid
    from jsonb_array_elements(payload #> '{tables,budget_executions}') r
   where e.id = (r ->> 'id')::uuid
     and (r ->> 'detail_id') is not null;
  alter table public.budget_executions enable trigger set_updated_meta;

  -- K-8: app_settings는 행을 지우지 않고 schema_version(·상수 id=true) 제외 컬럼만 UPDATE.
  -- 단일 행 제약(INSERT/DELETE 불가)과 충돌하지 않고, audit 컬럼 보존을 위해 트리거를 끈다.
  v_settings := payload #> '{tables,app_settings}' -> 0;
  if v_settings is null then
    raise exception '백업 파일에 app_settings 행이 없습니다';
  end if;
  alter table public.app_settings disable trigger set_updated_meta;
  update app_settings
     set due_soon_days         = (v_settings ->> 'due_soon_days')::integer,
         milestone_alert_days  = (v_settings ->> 'milestone_alert_days')::integer,
         week_starts_on        = (v_settings ->> 'week_starts_on')::smallint,
         default_gantt_scale   = v_settings ->> 'default_gantt_scale',
         currency_unit         = v_settings ->> 'currency_unit',
         progress_weight_basis = v_settings ->> 'progress_weight_basis',
         created_at            = (v_settings ->> 'created_at')::timestamptz,
         updated_at            = (v_settings ->> 'updated_at')::timestamptz,
         version               = (v_settings ->> 'version')::bigint,
         updated_by            = (v_settings ->> 'updated_by')::uuid
   where id = true;
  alter table public.app_settings enable trigger set_updated_meta;
end;
$$;

-- 실행 권한: create or replace가 소유자 함수를 교체해도 grant는 유지되지만,
-- 마이그레이션 단독 적용 시에도 상태가 확정되도록 명시한다
revoke execute on function public.restore_backup(jsonb) from public, anon;
grant execute on function public.restore_backup(jsonb) to authenticated;

-- schema_version은 갱신하지 않는다 (4 유지 — 머리말 참조).
