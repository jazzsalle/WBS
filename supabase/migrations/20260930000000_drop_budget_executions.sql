-- =============================================================================
-- Phase 23 집행 관리 삭제 — budget_executions·commit_execution_form 제거
--                           + restore_import_snapshot·restore_backup 재정의 + schema_version 5
-- SOT §5.12·§5.12.1, §6.16 IN-14, §7.14, §8.7 K-5·K-9, §8.8, 계획서 docs/plans/phase-23-plan.md S-1·S-2·S-12
--
-- 집행은 RCMS·경영관리팀·정산 시스템 몫이다(D-1). 이 마이그레이션은 지우기만 한다 —
-- 제안 모드 데이터(budget_items·budget_details)와 그 복원 경로는 한 글자도 바꾸지 않는다(D-3).
--
-- RLS 영향 없음:
--   · 새 테이블 없음.
--   · 삭제하는 budget_executions의 정책("approved users full access")·인덱스·set_updated_meta 트리거·
--     Realtime publication 항목은 drop table과 함께 사라진다.
--   · 다른 테이블의 정책은 budget_executions를 참조하지 않는다 — 전부 is_approved()·auth.uid()만 본다
--     (마이그레이션 grep과 적용 전 pg_policies 조회로 확인, 2026-09-29).
--
-- schema_version 4 → 5 (§8.8): BACKUP_TABLES에서 budget_executions가 빠져 백업 파일 형식이 바뀐다.
-- 옛 v4 백업은 restore_backup의 K-5 버전 게이트가 버전 불일치로 거부한다 — 집행 행을 조용히
-- 버리는 복원이 되지 않도록 별도 가드를 두지 않고 그 게이트에 맡긴다(S-12).
-- lib/constants.ts EXPECTED_SCHEMA_VERSION = 5와 같은 커밋이다.
--
-- 적용 전 dev DB 건수(2026-09-29): budget_executions 0, kind='execution_form' 스냅샷 0, 프로파일 0.
--
-- drop table에 cascade를 쓰지 않는다 — 숨은 의존(뷰·FK)이 있으면 조용히 함께 지우지 않고 실패로 드러낸다.
-- plpgsql 본문의 참조는 의존으로 잡히지 않으므로 두 복원 함수를 먼저 재정의한다(S-12 순서).
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. restore_import_snapshot — 수행 양식 스냅샷(IN-14) 분기 제거
--    20260929000000_goal_form.sql의 정의 전문에서 뺀 것은 executions 분기와 그 분기만 쓰던
--    declare 변수뿐이다. goals 거부(GF-11)·items·details(D-17a) 경로는 한 글자도 바뀌지 않는다.
--    executions 키가 있는 스냅샷은 아래 4.가 모두 지우므로 남지 않는다.
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
  -- GF-11: 목표 양식 스냅샷은 items가 비어 아래 "0건 성공" 경로에 떨어진다 — 아무것도 되돌리지
  -- 않고 성공을 알리면 절대 규칙 5 위반이다. Phase 21은 복원을 명시적으로 거부한다
  if v_snapshot ? 'goals' then
    raise exception '목표 양식 스냅샷은 되돌릴 수 없습니다 — 반영 기록용입니다';
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

-- -----------------------------------------------------------------------------
-- 2. restore_backup — budget_executions 처리 제거 (§8.7 K-7, §8.8)
--    20260929000000_goal_form.sql의 정의 전문에서 뺀 것은 c_tables의 budget_executions,
--    그 spec 기본값 분기, detail_id 2차 복원(과 그것을 적은 주석)뿐이다. deliverables·tech_targets
--    기본값 채움·projects 순환 FK 2차 복원·app_settings 처리·grant/revoke는 그대로다.
--    c_tables는 lib/db/backup.ts RESTORE_TABLES와 순서까지 일치해야 한다.
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
    'budget_items', 'budget_details', 'budget_rules', 'risks', 'notes', 'todos',
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
  -- deliverables·tech_targets의 Phase 21 컬럼 7종이고 §8.8이 근거다).
  foreach t in array c_tables loop
    v_rows := payload #> array['tables', t];
    if t = 'projects' then
      -- 순환 FK: pm_member_id/lead_org_id는 members/organizations 삽입 뒤 2차로 복원한다
      select coalesce(jsonb_agg(r - 'pm_member_id' - 'lead_org_id'), '[]'::jsonb)
        into v_rows
        from jsonb_array_elements(v_rows) r;
    end if;
    if t = 'deliverables' then
      -- §8.8 Phase 21: 옛 백업에 없는 두 컬럼만 채운다. 키가 있으면(null이어도) 행 값이 이긴다
      select coalesce(jsonb_agg('{"weight": 0, "evidence_method": ""}'::jsonb || r), '[]'::jsonb)
        into v_rows
        from jsonb_array_elements(v_rows) r;
    end if;
    if t = 'tech_targets' then
      -- §8.8 Phase 21: 옛 백업에 없는 다섯 컬럼만 채운다
      select coalesce(jsonb_agg(
               '{"group_name": "", "standard_basis": "", "basis_rationale": "",
                 "evaluation_environment": "", "note": ""}'::jsonb || r), '[]'::jsonb)
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

-- -----------------------------------------------------------------------------
-- 3. commit_execution_form 삭제 (20260928000000의 시그니처 그대로)
-- -----------------------------------------------------------------------------
drop function public.commit_execution_form(uuid, uuid, jsonb, jsonb, uuid[], jsonb, jsonb);

-- -----------------------------------------------------------------------------
-- 4. 수행 양식 스냅샷 삭제 (S-2) + import_profiles.kind check 교체 (S-1)
--    스냅샷의 복원 경로(IN-14)가 사라진다. 남기면 kind enum에 없는 값이라 목록 파싱이 깨지거나
--    되돌릴 수 없는 행이 목록에 남는다. 스냅샷 종류는 컬럼이 아니라 jsonb snapshot.kind다.
--    수행 양식은 프로파일을 만들지 않는다(§5.12.1) — 0건이어야 정상이고, 있으면 모르는 데이터이므로
--    조용히 지우지 않고 마이그레이션을 멈춘다.
-- -----------------------------------------------------------------------------
delete from public.import_snapshots where snapshot ->> 'kind' = 'execution_form';

do $$
declare v_n integer;
begin
  select count(*) into v_n from public.import_profiles where kind = 'execution_form';
  if v_n > 0 then
    raise exception 'kind = execution_form 임포트 프로파일이 %건 있습니다 — 확인 없이 지울 수 없어 마이그레이션을 멈춥니다', v_n;
  end if;
end $$;

alter table public.import_profiles
  drop constraint import_profiles_kind_check;

alter table public.import_profiles
  add constraint import_profiles_kind_check
  check (kind in ('budget_plan', 'budget_detail', 'goal_form'));

-- -----------------------------------------------------------------------------
-- 5. budget_executions 삭제 — cascade 없음 (머리말 참조)
-- -----------------------------------------------------------------------------
drop table public.budget_executions;

-- -----------------------------------------------------------------------------
-- 6. schema_version 5 (§8.8) — lib/constants.ts EXPECTED_SCHEMA_VERSION과 같은 커밋
-- -----------------------------------------------------------------------------
update public.app_settings set schema_version = 5 where id = true;
