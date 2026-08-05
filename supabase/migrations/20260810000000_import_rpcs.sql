-- =============================================================================
-- 임포트 RPC — 예산계획 반영(commit_import)과 스냅샷 복원(restore_import_snapshot)
-- SOT §6.8.5(I-17, I-18), §6.8.2(S-9), §5.12, §5.12.1, §7.9.1, §7.14,
--     §8.3(X-1, X-2), §8.4(N-5 version 트리거), §9 Budget Import
--
--  - X-2 : 둘 다 security invoker. §8.3 X-2의 definer 예외 목록(handle_new_user,
--          approve_user, deactivate_user, is_approved, restore_backup)에 없으므로
--          RLS를 그대로 태운다. years·budget_items·import_snapshots의
--          "approved users full access"(is_approved()) 정책이 호출자에게 적용된다.
--  - I-18: 함수 본문 전체가 한 트랜잭션이다. 검증 실패는 raise exception으로 올려
--          전체를 롤백한다 — 예외를 잡아 삼키지 않는다. 부분 반영은 없다.
--  - I-17: 반영 전 계획액을 같은 트랜잭션에서 import_snapshots에 남기고,
--          과제별 최근 20개만 유지한다.
--  - S-9 : 덮어쓰기 범위는 "파일에 등장한 (연차, 비목)"뿐이다. p_rows에 없는
--          비목은 건드리지 않으므로 기존 계획액이 그대로 남는다.
--  - N-13: FK는 "이 연차가 이 과제 것인가"를 막지 못한다. 다른 과제의 연차가
--          섞이면 RPC가 명시적으로 거부한다 (delete/reorder RPC들과 같은 패턴).
--  - N-5 : version +1과 updated_at은 set_updated_meta 트리거가 처리한다.
--          여기서는 updated_by(auth.uid())만 채운다 — 중복 갱신하지 않는다.
--
-- 스냅샷 jsonb 형식 (mapper의 JSONB_PASSTHROUGH_KEYS 대상이라 내부 키는 camelCase다):
--   {
--     "schemaVersion": 1,
--     "projectId": uuid,
--     "capturedAt": timestamptz,
--     "source": { "fileName": text, "sheetName": text, "profileId": uuid|null, "fileHash": text },
--     "items": [ { "yearId": uuid, "category": text, "plannedAmount": bigint,
--                  "cashAmount": bigint|null, "inKindAmount": bigint|null, "existed": bool } ]
--   }
-- items는 **반영 직전** 값이다. 행이 없던 조합은 existed=false + 0/null/null로 남겨
-- 복원이 "임포트 이전 상태"를 그대로 재현하게 한다.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. commit_import (I-17, I-18, S-9)
--    p_rows  : [{ "yearId", "category", "plannedAmount", "cashAmount", "inKindAmount" }]
--    p_source: { "fileName", "sheetName", "profileId", "fileHash" } — 스냅샷 메타
--    반환    : { "snapshotId": uuid, "updated": int }
--              updated = 실제로 쓴 (연차, 비목) 셀 수 (신규 삽입 + 덮어쓰기 합)
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

  -- ── I-17: 반영 전 값을 같은 트랜잭션에서 스냅샷으로 남긴다 ──

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
    left join budget_items b on b.year_id = s."yearId" and b.category = s."category";

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

  -- ── 반영 (S-9: p_rows에 등장한 조합만 건드린다) ──
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
  on conflict (year_id, category) do update
    set planned_amount = excluded.planned_amount,
        cash_amount    = excluded.cash_amount,
        in_kind_amount = excluded.in_kind_amount,
        updated_by     = excluded.updated_by;
  get diagnostics v_updated = row_count;

  -- 검증을 다 통과했는데 반영 건수가 다르면 RLS가 일부 행을 잘라냈다는 뜻이다.
  -- 조용히 부분 반영으로 끝내지 않는다 (I-18)
  if v_updated <> v_total then
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

  return jsonb_build_object('snapshotId', v_snapshot_id, 'updated', v_updated);
end; $$;

-- -----------------------------------------------------------------------------
-- 2. restore_import_snapshot (I-17 "확인·복원할 수 있고", §7.14)
--    반환: { "snapshotId": uuid, "restored": int }
--
--    존재하지 않던 행(existed=false)은 스냅샷에 0/null/null로 기록돼 있으므로
--    같은 upsert로 되돌아간다. **행을 지우지는 않는다** — 임포트 이후에 그 비목에
--    집행 내역이 붙었을 수 있고, 삭제하면 cascade로 집행이 함께 사라진다.
--
--    복원은 새 스냅샷을 만들지 않는다. import_snapshots는 I-17이 정의한
--    "임포트 반영 전 스냅샷" 이력이고, 복원분을 끼워 넣으면 최근 20개 창이
--    복원 조작으로 밀려 정작 되돌릴 임포트 이력이 사라진다.
-- -----------------------------------------------------------------------------
create or replace function public.restore_import_snapshot(p_snapshot_id uuid)
returns jsonb language plpgsql security invoker as $$
declare
  v_project_id uuid;
  v_items      jsonb;
  v_total      integer;
  v_orphans    integer;
  v_restored   integer;
begin
  if p_snapshot_id is null then
    raise exception '복원할 스냅샷을 지정해야 합니다';
  end if;

  select project_id, snapshot -> 'items'
    into v_project_id, v_items
    from import_snapshots where id = p_snapshot_id;
  if v_project_id is null then
    raise exception '스냅샷을 찾을 수 없습니다';
  end if;
  if v_items is null or jsonb_typeof(v_items) <> 'array' then
    raise exception '스냅샷 형식이 올바르지 않아 복원할 수 없습니다';
  end if;

  v_total := jsonb_array_length(v_items);
  if v_total = 0 then
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

  return jsonb_build_object('snapshotId', p_snapshot_id, 'restored', v_restored);
end; $$;
