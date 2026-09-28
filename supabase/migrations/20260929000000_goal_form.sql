-- =============================================================================
-- Phase 21 목표 양식 — deliverables 2컬럼·tech_targets 5컬럼 + commit_goal_form
--                      + restore_import_snapshot 목표 스냅샷 거부(GF-11) + restore_backup 갱신(§8.8)
-- SOT §5.1 N-9, §5.8·§5.9(Phase 21 필드), §6.17 GF-5·GF-10·GF-11, §6.8.5 I-17,
--     §8.3 X-1·X-2, §8.4 O-1, §8.7 K-7, §8.8
--
-- schema_version은 **4를 유지한다**(§8.8). 올리는 기준은 "백업 파일 형식이 바뀌는가"이고
-- 이 마이그레이션은 컬럼 추가·RPC뿐이라 BACKUP_TABLES가 그대로다. 옛(Phase 21 이전) 백업은
-- 아래 restore_backup이 새 not null 컬럼 7종의 기본값을 채워 그대로 복원된다.
-- EXPECTED_SCHEMA_VERSION도 4다.
--
-- RLS 정책 변경 불필요 — 기존 테이블의 is_approved() 전체 접근 정책("approved users full access")이
-- 새 컬럼에 그대로 적용된다. 새 테이블 없음. deliverables·tech_targets·deliverable_achievements·
-- tech_target_records는 이미 Realtime publication에 있다(20260802000000 §34).
--
--  - N-9 : tech_targets의 `group`은 SQL 예약어라 컬럼명은 group_name이다. 매퍼가 앱의 group으로 바꾼다.
--  - X-2 : commit_goal_form·restore_import_snapshot은 security invoker다. definer 예외
--          (§8.3 X-2 목록)는 restore_backup 하나뿐이고, 그 정의는 20260928000000과 같은 방식이다.
--  - X-1 : 목표 4테이블·achievement_members·import_snapshots를 한 트랜잭션으로 묶어야 하므로 RPC다.
--  - N-5 : version +1과 updated_at은 set_updated_meta 트리거가 올린다. 여기서는 updated_by만 채운다.
--  - N-13: FK는 "이 기관·인력·연차·목표가 이 과제 것인가"를 막지 못한다. RPC가 거부한다.
--          targetByYear 키는 FK조차 없다(N-3) — 여기서만 막힌다.
--
-- ─ 예외 규약 (lib/db/import-snapshots.ts의 판정 규칙과 짝이다) ──
--   PostgREST는 raise exception을 전부 SQLSTATE P0001로 내려보내므로 리포지토리는 메시지로 가른다:
--     · /먼저 수정|stale/i          → StaleDataError   (이 파일에는 없다 — O-1 불일치는 충돌 목록으로 돌려준다)
--     · /찾을 수 없습니다|not found/i → NotFoundError   (과제·스냅샷이 없는 경우만)
--     · 그 외 전부                   → RuleViolationError
--   양식을 받은 뒤 부모·연차·기관이 사라진 경우처럼 "없음"이지만 사용자가 찾는 대상이 아닌
--   경우는 일부러 "찾을 수 없습니다"를 쓰지 않는다. 문구를 바꾸면 리포지토리의 정규식도 함께 바꾼다.
--
-- 목표 양식 스냅샷 jsonb 형식 (GF-11. 총괄표 = schemaVersion 1, 산출근거 = 2, 수행 = 3):
--   {
--     "schemaVersion": 4, "projectId": uuid, "capturedAt": timestamptz,
--     "kind": "goal_form",
--     "source": { "fileName", "sheetName", "profileId": null, "fileHash" },
--     "items": [],                       -- 계획액은 건드리지 않는다
--     "goals": {
--       "added":   { "deliverables": [id], "deliverable_achievements": [id],
--                    "tech_targets": [id], "tech_target_records": [id] },
--       "before":  { 위 네 테이블 + "achievement_members", "task_deliverables", "task_tech_targets":
--                    [ 변경·삭제 **전** 행 전체 (DB snake_case 원본) ] },
--       "deleted": { 위 네 테이블: [ 삭제된 id — 지표·기술목표 삭제로 cascade된 실적·측정 포함 ] }
--     }
--   }
--   before의 연계 행: 삭제한 실적·변경한 실적(관여자 교체)의 achievement_members, 삭제한
--   지표·기술목표의 task_deliverables·task_tech_targets와 cascade된 실적의 achievement_members.
--   deleted가 따로 있는 이유는 IN-14와 같다(반영이 지운 행과 남이 지운 행을 가르려고).
--   **goals 키와 그 안의 테이블 키는 비어 있어도 항상 존재한다** — 복원이 키 유무로 스냅샷 종류를 가른다.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. 컬럼 7종 (§5.8·§5.9 Phase 21 추가, S-1·S-20)
--    전부 not null + 기본값이라 기존 행과 새 필드 없는 기존 CRUD 호출은 동작이 같다.
-- -----------------------------------------------------------------------------
alter table public.deliverables
  -- S-20: 가중치는 소수 허용. 음수는 합계 100 경고와 가중 해석을 뒤집으므로 DB에서도 막는다
  add column weight          numeric not null default 0 check (weight >= 0),
  add column evidence_method text    not null default '';

alter table public.tech_targets
  add column group_name             text not null default '',
  add column standard_basis         text not null default '',
  add column basis_rationale        text not null default '',
  add column evaluation_environment text not null default '',
  add column note                   text not null default '';

-- -----------------------------------------------------------------------------
-- 2. commit_goal_form (GF-5·GF-10·GF-11, I-17)
--
--    p_deliverables · p_achievements · p_tech_targets · p_records 는 모두
--      { "adds": [행], "updates": [행], "deleteIds": [id] }   -- 키 생략 = 빈 배열
--    이고 행의 필드는 DB 표기(snake_case)다. **추가·변경 행은 아래 필드 키가 전부 있어야 한다**
--    (값은 nullable 컬럼만 null 가능) — 기본값이 조용히 들어가면 측정값 0처럼 달성률이 왜곡된다.
--
--    deliverables
--      adds    : "row_key"(선택, "row:<n>" — 같은 호출의 새 실적이 부모로 가리키는 임시 키) +
--                "type", "name", "unit", "weight", "target_total", "target_by_year",
--                "org_id", "evidence_method", "note"
--      updates : "id" + adds와 같은 필드(row_key 제외)
--    achievements (deliverable_achievements)
--      adds    : "deliverable_id"(기존 지표) 또는 "deliverable_ref"("row:<n>") 중 정확히 하나 +
--                "title", "date", "year_id", "org_id", "member_ids", "evidence_url", "note"
--      updates : "id", "deliverable_id"(현재 부모 — 다르면 parent-moved로 거부) + adds와 같은 필드
--    tech_targets
--      adds    : "row_key"(선택) + "name", "group_name", "unit", "direction", "weight",
--                "target_value", "target_by_year", "baseline_domestic", "world_best",
--                "world_best_holder", "measure_method", "measure_description",
--                "standard_basis", "basis_rationale", "evaluation_environment", "org_id", "note"
--      updates : "id" + adds와 같은 필드(row_key 제외)
--    records (tech_target_records)
--      adds    : "tech_target_id" 또는 "tech_target_ref" 중 정확히 하나 +
--                "value", "date", "year_id", "method", "evaluator", "evidence_url", "note"
--      updates : "id", "tech_target_id"(현재 부모) + adds와 같은 필드
--
--    target_by_year : { "<yearId>": 숫자 | null } — 키는 `_meta.yearIds` 전부. null은 "그 키 삭제"다.
--                     여기 없는 기존 키는 보존한다(S-13). 추가 행에서는 null 키를 버린다
--    member_ids     : 관여자 id 배열. 변경은 교체다(빈 배열 = 관여자 없음)
--    p_expected     : { "<id>": 내려받을 때의 version } — `_meta` deliverable:/achievement:/
--                     techTarget:/record:<id>(S-5). 변경·삭제 대상은 전부 있어야 하고, 부모 삭제는
--                     현재 자식도 전부 여기 있어야 한다(S-6②)
--    p_source       : { "fileName", "sheetName", "fileHash" } — 스냅샷 메타
--
--    반환 : { snapshotId,
--             deliverables: {added, updated, deleted}, achievements: {…},
--             techTargets: {…}, records: {…},
--             conflicts: [{ kind, id, reason }] }
--           kind   = 'deliverable' | 'achievement' | 'techTarget' | 'record' (`_meta` 접두어와 같다)
--           reason = 'changed'(내려받은 뒤 version이 바뀜, 또는 삭제할 부모의 자식이 바뀌거나 늘어남)
--                  | 'deleted'(이미 없음)
--           deleted 건수는 deleteIds로 지운 행만 센다(cascade된 자식은 스냅샷에만 남는다).
--           conflicts는 비어 있어도 항상 있다
--
--    처리 순서: 삭제(자식 → 부모) → 변경(부모 → 자식) → 추가(부모 → 자식).
--    자식 삭제가 먼저라야 부모 삭제의 S-6② 검사가 "이 반영이 지운 자식"을 남은 자식으로 보지 않는다.
-- -----------------------------------------------------------------------------
create or replace function public.commit_goal_form(
  p_project_id   uuid,
  p_deliverables jsonb default '{}'::jsonb,
  p_achievements jsonb default '{}'::jsonb,
  p_tech_targets jsonb default '{}'::jsonb,
  p_records      jsonb default '{}'::jsonb,
  p_expected     jsonb default '{}'::jsonb,
  p_source       jsonb default '{}'::jsonb
) returns jsonb language plpgsql security invoker as $$
declare
  c_uuid constant text := '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$';
  c_types constant text[] := array[
    'paper_sci', 'paper_domestic', 'conference',
    'patent_dom_apply', 'patent_dom_reg', 'patent_intl_apply', 'patent_intl_reg',
    'sw_registration', 'tech_transfer', 'commercialization', 'standard', 'hr_training', 'other'];
  c_directions constant text[] := array['higher_better', 'lower_better', 'target_exact'];
  c_methods    constant text[] := array['self', 'certified_lab', 'expert_review', 'customer', 'other'];
  c_d_keys constant text[] := array[
    'type', 'name', 'unit', 'weight', 'target_total', 'target_by_year',
    'org_id', 'evidence_method', 'note'];
  c_a_keys constant text[] := array[
    'title', 'date', 'year_id', 'org_id', 'member_ids', 'evidence_url', 'note'];
  c_t_keys constant text[] := array[
    'name', 'group_name', 'unit', 'direction', 'weight', 'target_value', 'target_by_year',
    'baseline_domestic', 'world_best', 'world_best_holder', 'measure_method',
    'measure_description', 'standard_basis', 'basis_rationale', 'evaluation_environment',
    'org_id', 'note'];
  c_r_keys constant text[] := array[
    'value', 'date', 'year_id', 'method', 'evaluator', 'evidence_url', 'note'];
  c_int_max constant numeric := 2147483647;   -- deliverables.target_total은 integer다

  v_expected jsonb := coalesce(p_expected, '{}'::jsonb);
  v_source   jsonb := coalesce(p_source, '{}'::jsonb);

  v_d_adds jsonb; v_d_updates jsonb; v_d_del uuid[]; v_d_upd_ids uuid[];
  v_a_adds jsonb; v_a_updates jsonb; v_a_del uuid[]; v_a_upd_ids uuid[];
  v_t_adds jsonb; v_t_updates jsonb; v_t_del uuid[]; v_t_upd_ids uuid[];
  v_r_adds jsonb; v_r_updates jsonb; v_r_del uuid[]; v_r_upd_ids uuid[];

  -- 스냅샷(GF-11)
  v_added_d uuid[] := '{}'; v_added_a uuid[] := '{}'; v_added_t uuid[] := '{}'; v_added_r uuid[] := '{}';
  v_gone_d  uuid[] := '{}'; v_gone_a  uuid[] := '{}'; v_gone_t  uuid[] := '{}'; v_gone_r  uuid[] := '{}';
  v_before_d  jsonb := '[]'; v_before_a  jsonb := '[]';
  v_before_t  jsonb := '[]'; v_before_r  jsonb := '[]';
  v_before_am jsonb := '[]'; v_before_td jsonb := '[]'; v_before_tt jsonb := '[]';

  -- 반환 건수
  v_upd_d integer := 0; v_upd_a integer := 0; v_upd_t integer := 0; v_upd_r integer := 0;
  v_del_d integer := 0; v_del_a integer := 0; v_del_t integer := 0; v_del_r integer := 0;
  v_conflicts jsonb := '[]';

  v_d_keys  jsonb := '{}';   -- row_key → 새 지표 id (GF-10)
  v_t_keys  jsonb := '{}';   -- row_key → 새 기술목표 id
  v_year_ids   uuid[];
  v_org_ids    uuid[];
  v_member_ids uuid[];
  v_parent_ids uuid[];
  v_d_order integer;
  v_t_order integer;
  v_total   integer;
  v_distinct integer;
  v_n       integer;
  v_id      uuid;
  v_new_id  uuid;
  v_parent  uuid;
  v_exp     bigint;
  v_date    date;
  v_tmp     jsonb;
  v_tmp2    jsonb;
  v_links   jsonb;
  v_snapshot_id uuid;
  v_old_d public.deliverables%rowtype;
  v_old_a public.deliverable_achievements%rowtype;
  v_old_t public.tech_targets%rowtype;
  v_old_r public.tech_target_records%rowtype;
  kind  text;
  blk   jsonb;
  r     jsonb;
  k     text;
  x     jsonb;
begin
  -- ── 입력 형식 (한 건이라도 어긋나면 아무것도 반영하지 않는다) ──

  if p_project_id is null then
    raise exception '반영할 과제를 지정해야 합니다';
  end if;
  if not exists (select 1 from projects where id = p_project_id) then
    raise exception '과제를 찾을 수 없습니다';
  end if;
  if jsonb_typeof(v_expected) <> 'object' then
    raise exception '충돌 판정 기준 version 목록이 객체가 아닙니다';
  end if;

  foreach kind in array array['deliverables', 'achievements', 'tech_targets', 'records'] loop
    blk := case kind when 'deliverables' then p_deliverables
                     when 'achievements' then p_achievements
                     when 'tech_targets' then p_tech_targets
                     else p_records end;
    blk := coalesce(blk, '{}'::jsonb);
    if jsonb_typeof(blk) <> 'object'
       or jsonb_typeof(coalesce(blk -> 'adds', '[]'::jsonb)) <> 'array'
       or jsonb_typeof(coalesce(blk -> 'updates', '[]'::jsonb)) <> 'array'
       or jsonb_typeof(coalesce(blk -> 'deleteIds', '[]'::jsonb)) <> 'array' then
      raise exception '목표 양식 반영 목록 형식이 올바르지 않습니다';
    end if;
    if exists (
      select 1 from jsonb_array_elements(coalesce(blk -> 'adds', '[]'::jsonb)
                                         || coalesce(blk -> 'updates', '[]'::jsonb)) as t(row)
       where jsonb_typeof(t.row) <> 'object'
    ) then
      raise exception '목표 양식 반영 행 형식이 올바르지 않습니다';
    end if;
    -- 추가는 새 행만 만든다. id가 실려 오면 기존 행을 O-1 비교 없이 고치게 된다
    if exists (
      select 1 from jsonb_array_elements(coalesce(blk -> 'adds', '[]'::jsonb)) as t(row)
       where t.row ? 'id' and jsonb_typeof(t.row -> 'id') <> 'null'
    ) then
      raise exception '목표 양식의 새 행에 기존 id가 포함되어 있습니다';
    end if;
    if exists (
      select 1 from jsonb_array_elements(coalesce(blk -> 'updates', '[]'::jsonb)) as t(row)
       where jsonb_typeof(t.row -> 'id') is distinct from 'string' or (t.row ->> 'id') !~ c_uuid
    ) then
      raise exception '변경할 목표 행의 id가 비어 있거나 올바르지 않습니다';
    end if;
    if exists (
      select 1 from jsonb_array_elements(coalesce(blk -> 'deleteIds', '[]'::jsonb)) as t(v)
       where jsonb_typeof(t.v) is distinct from 'string' or (t.v #>> '{}') !~ c_uuid
    ) then
      raise exception '삭제할 목표 id가 비어 있거나 올바르지 않습니다';
    end if;
  end loop;

  v_d_adds    := coalesce(p_deliverables -> 'adds', '[]');
  v_d_updates := coalesce(p_deliverables -> 'updates', '[]');
  v_a_adds    := coalesce(p_achievements -> 'adds', '[]');
  v_a_updates := coalesce(p_achievements -> 'updates', '[]');
  v_t_adds    := coalesce(p_tech_targets -> 'adds', '[]');
  v_t_updates := coalesce(p_tech_targets -> 'updates', '[]');
  v_r_adds    := coalesce(p_records -> 'adds', '[]');
  v_r_updates := coalesce(p_records -> 'updates', '[]');

  select coalesce(array_agg(t.v::uuid), '{}') into v_d_del
    from jsonb_array_elements_text(coalesce(p_deliverables -> 'deleteIds', '[]')) as t(v);
  select coalesce(array_agg(t.v::uuid), '{}') into v_a_del
    from jsonb_array_elements_text(coalesce(p_achievements -> 'deleteIds', '[]')) as t(v);
  select coalesce(array_agg(t.v::uuid), '{}') into v_t_del
    from jsonb_array_elements_text(coalesce(p_tech_targets -> 'deleteIds', '[]')) as t(v);
  select coalesce(array_agg(t.v::uuid), '{}') into v_r_del
    from jsonb_array_elements_text(coalesce(p_records -> 'deleteIds', '[]')) as t(v);

  select coalesce(array_agg((t.row ->> 'id')::uuid), '{}') into v_d_upd_ids
    from jsonb_array_elements(v_d_updates) as t(row);
  select coalesce(array_agg((t.row ->> 'id')::uuid), '{}') into v_a_upd_ids
    from jsonb_array_elements(v_a_updates) as t(row);
  select coalesce(array_agg((t.row ->> 'id')::uuid), '{}') into v_t_upd_ids
    from jsonb_array_elements(v_t_updates) as t(row);
  select coalesce(array_agg((t.row ->> 'id')::uuid), '{}') into v_r_upd_ids
    from jsonb_array_elements(v_r_updates) as t(row);

  if jsonb_array_length(v_d_adds) + jsonb_array_length(v_d_updates) + cardinality(v_d_del)
     + jsonb_array_length(v_a_adds) + jsonb_array_length(v_a_updates) + cardinality(v_a_del)
     + jsonb_array_length(v_t_adds) + jsonb_array_length(v_t_updates) + cardinality(v_t_del)
     + jsonb_array_length(v_r_adds) + jsonb_array_length(v_r_updates) + cardinality(v_r_del) = 0 then
    -- 빈 반영은 아무것도 바꾸지 않는다 (commit_execution_form과 같은 판단)
    raise exception '반영할 목표 행이 없습니다';
  end if;

  -- 한 행이 변경·삭제에 두 번 들어오면 먼저 처리된 쪽이 version을 바꿔 뒤쪽이 가짜 충돌이 된다
  select count(*), count(distinct t.id) into v_total, v_distinct
    from unnest(v_d_upd_ids || v_d_del || v_a_upd_ids || v_a_del
                || v_t_upd_ids || v_t_del || v_r_upd_ids || v_r_del) as t(id);
  if v_total <> v_distinct then
    raise exception '변경·삭제 목록에 같은 행이 두 번 들어 있습니다';
  end if;

  -- GF-5: 충돌 기준은 내려받은 시점의 version이다. 기준이 없으면 비교 없이 덮어쓰게 된다
  if exists (
    select 1 from unnest(v_d_upd_ids || v_d_del || v_a_upd_ids || v_a_del
                         || v_t_upd_ids || v_t_del || v_r_upd_ids || v_r_del) as t(id)
     where jsonb_typeof(v_expected -> t.id::text) is distinct from 'number'
  ) then
    raise exception '충돌 판정 기준 version이 없는 목표 행이 있습니다';
  end if;

  -- ── 행 필드 검증 (파서가 이미 막지만 RPC가 최후 방어선이다 — 길이 상한은 actions/goals.ts와 같다) ──

  -- 성과목표
  for r in select elem from jsonb_array_elements(v_d_adds || v_d_updates) as t(elem) loop
    if not (r ?& c_d_keys) then
      raise exception '성과목표 행에 필요한 필드가 없습니다';
    end if;
    if jsonb_typeof(r -> 'type') is distinct from 'string' or not ((r ->> 'type') = any(c_types)) then
      raise exception '알 수 없는 성과목표 유형이 포함되어 있습니다';
    end if;
    if jsonb_typeof(r -> 'name') is distinct from 'string' or btrim(r ->> 'name') = '' then
      raise exception '성과목표 지표명이 비어 있습니다';
    end if;
    if char_length(r ->> 'name') > 200 then
      raise exception '지표명은 200자 이내여야 합니다';
    end if;
    if jsonb_typeof(r -> 'unit') is distinct from 'string' or char_length(r ->> 'unit') > 20 then
      raise exception '단위는 20자 이내 문자열이어야 합니다';
    end if;
    if jsonb_typeof(r -> 'weight') is distinct from 'number' or (r ->> 'weight')::numeric < 0 then
      raise exception '가중치는 0 이상 숫자여야 합니다';
    end if;
    -- §5.8 성과목표는 건수다 — 0 이상 정수(DB integer)
    if jsonb_typeof(r -> 'target_total') is distinct from 'number'
       or (r ->> 'target_total')::numeric <> trunc((r ->> 'target_total')::numeric)
       or (r ->> 'target_total')::numeric < 0
       or (r ->> 'target_total')::numeric > c_int_max then
      raise exception '성과목표 전체 목표는 0 이상 정수여야 합니다';
    end if;
    if jsonb_typeof(r -> 'target_by_year') is distinct from 'object' then
      raise exception '연차별 목표 형식이 올바르지 않습니다';
    end if;
    for k, x in select e.key, e.value from jsonb_each(r -> 'target_by_year') as e loop
      if k !~ c_uuid then
        raise exception '연차별 목표의 연차 id가 올바르지 않습니다';
      end if;
      if jsonb_typeof(x) <> 'null'
         and (jsonb_typeof(x) <> 'number'
              or (x #>> '{}')::numeric <> trunc((x #>> '{}')::numeric)
              or (x #>> '{}')::numeric < 0) then
        raise exception '성과목표 연차별 목표는 0 이상 정수여야 합니다';
      end if;
    end loop;
    if jsonb_typeof(r -> 'org_id') not in ('string', 'null')
       or (jsonb_typeof(r -> 'org_id') = 'string' and (r ->> 'org_id') !~ c_uuid) then
      raise exception '책임기관 id가 올바르지 않습니다';
    end if;
    if jsonb_typeof(r -> 'evidence_method') is distinct from 'string' then
      raise exception '평가방법이 문자열이 아닙니다';
    end if;
    if jsonb_typeof(r -> 'note') is distinct from 'string' or char_length(r ->> 'note') > 10000 then
      raise exception '비고는 10000자 이내 문자열이어야 합니다';
    end if;
    if r ? 'row_key' and jsonb_typeof(r -> 'row_key') not in ('string', 'null') then
      raise exception '새 행 임시 키 형식이 올바르지 않습니다';
    end if;
  end loop;

  -- 기술목표
  for r in select elem from jsonb_array_elements(v_t_adds || v_t_updates) as t(elem) loop
    if not (r ?& c_t_keys) then
      raise exception '기술목표 행에 필요한 필드가 없습니다';
    end if;
    if jsonb_typeof(r -> 'name') is distinct from 'string' or btrim(r ->> 'name') = '' then
      raise exception '기술목표 평가항목이 비어 있습니다';
    end if;
    if char_length(r ->> 'name') > 200 then
      raise exception '평가항목은 200자 이내여야 합니다';
    end if;
    if jsonb_typeof(r -> 'unit') is distinct from 'string' or char_length(r ->> 'unit') > 20 then
      raise exception '단위는 20자 이내 문자열이어야 합니다';
    end if;
    if jsonb_typeof(r -> 'direction') is distinct from 'string'
       or not ((r ->> 'direction') = any(c_directions)) then
      raise exception '알 수 없는 목표 방향이 포함되어 있습니다';
    end if;
    -- T-3: 비중은 가중 평균의 분모다. 음수가 섞이면 전체 달성률이 뒤집힌다
    if jsonb_typeof(r -> 'weight') is distinct from 'number' or (r ->> 'weight')::numeric < 0 then
      raise exception '비중은 0 이상 숫자여야 합니다';
    end if;
    if jsonb_typeof(r -> 'target_value') is distinct from 'number' then
      raise exception '기술목표 최종 목표가 비어 있거나 숫자가 아닙니다';
    end if;
    if jsonb_typeof(r -> 'target_by_year') is distinct from 'object' then
      raise exception '연차별 목표 형식이 올바르지 않습니다';
    end if;
    for k, x in select e.key, e.value from jsonb_each(r -> 'target_by_year') as e loop
      if k !~ c_uuid then
        raise exception '연차별 목표의 연차 id가 올바르지 않습니다';
      end if;
      if jsonb_typeof(x) not in ('number', 'null') then
        raise exception '기술목표 연차별 목표가 숫자가 아닙니다';
      end if;
    end loop;
    if jsonb_typeof(r -> 'baseline_domestic') not in ('number', 'null')
       or jsonb_typeof(r -> 'world_best') not in ('number', 'null') then
      raise exception '국내수준·세계최고 수준은 숫자이거나 비어 있어야 합니다';
    end if;
    if jsonb_typeof(r -> 'world_best_holder') is distinct from 'string'
       or char_length(r ->> 'world_best_holder') > 200 then
      raise exception '보유국/보유기관은 200자 이내 문자열이어야 합니다';
    end if;
    if jsonb_typeof(r -> 'measure_method') is distinct from 'string'
       or not ((r ->> 'measure_method') = any(c_methods)) then
      raise exception '알 수 없는 측정방법이 포함되어 있습니다';
    end if;
    if jsonb_typeof(r -> 'measure_description') is distinct from 'string'
       or char_length(r ->> 'measure_description') > 10000 then
      raise exception '측정방법 상세는 10000자 이내 문자열이어야 합니다';
    end if;
    if jsonb_typeof(r -> 'group_name') is distinct from 'string'
       or jsonb_typeof(r -> 'standard_basis') is distinct from 'string'
       or jsonb_typeof(r -> 'basis_rationale') is distinct from 'string'
       or jsonb_typeof(r -> 'evaluation_environment') is distinct from 'string' then
      raise exception '구분·표준·기준설정 근거·평가환경은 문자열이어야 합니다';
    end if;
    if jsonb_typeof(r -> 'org_id') not in ('string', 'null')
       or (jsonb_typeof(r -> 'org_id') = 'string' and (r ->> 'org_id') !~ c_uuid) then
      raise exception '책임기관 id가 올바르지 않습니다';
    end if;
    if jsonb_typeof(r -> 'note') is distinct from 'string' or char_length(r ->> 'note') > 10000 then
      raise exception '비고는 10000자 이내 문자열이어야 합니다';
    end if;
    if r ? 'row_key' and jsonb_typeof(r -> 'row_key') not in ('string', 'null') then
      raise exception '새 행 임시 키 형식이 올바르지 않습니다';
    end if;
  end loop;

  -- 성과실적
  for r in select elem from jsonb_array_elements(v_a_adds || v_a_updates) as t(elem) loop
    if not (r ?& c_a_keys) then
      raise exception '성과실적 행에 필요한 필드가 없습니다';
    end if;
    if jsonb_typeof(r -> 'title') is distinct from 'string' or btrim(r ->> 'title') = '' then
      raise exception '산출물명이 비어 있습니다';
    end if;
    if char_length(r ->> 'title') > 300 then
      raise exception '산출물명은 300자 이내여야 합니다';
    end if;
    if jsonb_typeof(r -> 'member_ids') is distinct from 'array' then
      raise exception '관여자 목록이 배열이 아닙니다';
    end if;
    if exists (
      select 1 from jsonb_array_elements(r -> 'member_ids') as m(v)
       where jsonb_typeof(m.v) is distinct from 'string' or (m.v #>> '{}') !~ c_uuid
    ) then
      raise exception '관여자 id가 올바르지 않습니다';
    end if;
    if jsonb_typeof(r -> 'evidence_url') is distinct from 'string'
       or char_length(r ->> 'evidence_url') > 2000 then
      raise exception '증빙 링크는 2000자 이내 문자열이어야 합니다';
    end if;
  end loop;

  -- 측정이력
  for r in select elem from jsonb_array_elements(v_r_adds || v_r_updates) as t(elem) loop
    if not (r ?& c_r_keys) then
      raise exception '측정이력 행에 필요한 필드가 없습니다';
    end if;
    -- 기본값 0이 "측정 실적치 0"으로 굳으면 달성률(§6.3)이 조용히 왜곡된다
    if jsonb_typeof(r -> 'value') is distinct from 'number' then
      raise exception '측정값이 비어 있거나 숫자가 아닙니다';
    end if;
    if jsonb_typeof(r -> 'method') is distinct from 'string'
       or not ((r ->> 'method') = any(c_methods)) then
      raise exception '알 수 없는 측정방법이 포함되어 있습니다';
    end if;
    if jsonb_typeof(r -> 'evaluator') is distinct from 'string'
       or char_length(r ->> 'evaluator') > 200 then
      raise exception '평가기관은 200자 이내 문자열이어야 합니다';
    end if;
    if jsonb_typeof(r -> 'evidence_url') is distinct from 'string'
       or char_length(r ->> 'evidence_url') > 2000 then
      raise exception '증빙 링크는 2000자 이내 문자열이어야 합니다';
    end if;
  end loop;

  -- 실적·측정 공통: 날짜·연차·기관·비고
  for r in select elem from jsonb_array_elements(v_a_adds || v_a_updates || v_r_adds || v_r_updates) as t(elem) loop
    if jsonb_typeof(r -> 'date') is distinct from 'string' or (r ->> 'date') !~ '^\d{4}-\d{2}-\d{2}$' then
      raise exception '날짜 형식이 올바르지 않습니다: %', coalesce(r ->> 'date', '(비어 있음)');
    end if;
    begin
      v_date := (r ->> 'date')::date;
    exception when others then
      raise exception '날짜 형식이 올바르지 않습니다: %', r ->> 'date';
    end;
    if jsonb_typeof(r -> 'year_id') not in ('string', 'null')
       or (jsonb_typeof(r -> 'year_id') = 'string' and (r ->> 'year_id') !~ c_uuid) then
      raise exception '연차 id가 올바르지 않습니다';
    end if;
    if jsonb_typeof(r -> 'org_id') not in ('string', 'null')
       or (jsonb_typeof(r -> 'org_id') = 'string' and (r ->> 'org_id') !~ c_uuid) then
      raise exception '기관 id가 올바르지 않습니다';
    end if;
    if jsonb_typeof(r -> 'note') is distinct from 'string' or char_length(r ->> 'note') > 10000 then
      raise exception '비고는 10000자 이내 문자열이어야 합니다';
    end if;
  end loop;

  -- ── GF-10 부모 지정: 새 자식은 기존 부모 id 또는 같은 호출의 임시 키 중 정확히 하나 ──

  if exists (
    select 1 from jsonb_array_elements(v_a_adds) as t(row)
     where (nullif(t.row ->> 'deliverable_id', '') is null) = (nullif(t.row ->> 'deliverable_ref', '') is null)
  ) then
    raise exception '새 성과실적 행의 성과목표 지정이 올바르지 않습니다';
  end if;
  if exists (
    select 1 from jsonb_array_elements(v_r_adds) as t(row)
     where (nullif(t.row ->> 'tech_target_id', '') is null) = (nullif(t.row ->> 'tech_target_ref', '') is null)
  ) then
    raise exception '새 측정이력 행의 기술목표 지정이 올바르지 않습니다';
  end if;
  if exists (
    select 1 from jsonb_array_elements(v_a_adds) as t(row)
     where nullif(t.row ->> 'deliverable_id', '') !~ c_uuid
  ) or exists (
    select 1 from jsonb_array_elements(v_r_adds) as t(row)
     where nullif(t.row ->> 'tech_target_id', '') !~ c_uuid
  ) then
    raise exception '새 행의 부모 id가 올바르지 않습니다';
  end if;
  -- 기존 자식은 숨김 부모 id로만 잇는다. 임시 키가 오면 새 부모로 옮기려는 것이다(S-18)
  if exists (
    select 1 from jsonb_array_elements(v_a_updates) as t(row)
     where nullif(t.row ->> 'deliverable_ref', '') is not null
  ) then
    raise exception '기존 성과실적을 다른 성과목표로 옮길 수 없습니다. 그 행을 지우고 새 행으로 적으세요';
  end if;
  if exists (
    select 1 from jsonb_array_elements(v_r_updates) as t(row)
     where nullif(t.row ->> 'tech_target_ref', '') is not null
  ) then
    raise exception '기존 측정이력을 다른 기술목표로 옮길 수 없습니다. 그 행을 지우고 새 행으로 적으세요';
  end if;
  if exists (
    select 1 from jsonb_array_elements(v_a_updates) as t(row)
     where jsonb_typeof(t.row -> 'deliverable_id') is distinct from 'string'
        or (t.row ->> 'deliverable_id') !~ c_uuid
  ) then
    raise exception '변경할 성과실적 행의 성과목표 id가 없습니다';
  end if;
  if exists (
    select 1 from jsonb_array_elements(v_r_updates) as t(row)
     where jsonb_typeof(t.row -> 'tech_target_id') is distinct from 'string'
        or (t.row ->> 'tech_target_id') !~ c_uuid
  ) then
    raise exception '변경할 측정이력 행의 기술목표 id가 없습니다';
  end if;

  -- 임시 키는 그 종류 안에서 유일해야 하고, 가리키는 새 부모가 이 호출에 있어야 한다
  select count(*), count(distinct t.row ->> 'row_key') into v_total, v_distinct
    from jsonb_array_elements(v_d_adds) as t(row) where nullif(t.row ->> 'row_key', '') is not null;
  if v_total <> v_distinct then
    raise exception '새 성과목표 행의 임시 키가 겹칩니다';
  end if;
  select count(*), count(distinct t.row ->> 'row_key') into v_total, v_distinct
    from jsonb_array_elements(v_t_adds) as t(row) where nullif(t.row ->> 'row_key', '') is not null;
  if v_total <> v_distinct then
    raise exception '새 기술목표 행의 임시 키가 겹칩니다';
  end if;
  for r in select elem from jsonb_array_elements(v_a_adds) as t(elem) loop
    if nullif(r ->> 'deliverable_ref', '') is not null and not exists (
      select 1 from jsonb_array_elements(v_d_adds) as d(row) where d.row ->> 'row_key' = r ->> 'deliverable_ref'
    ) then
      raise exception '성과실적이 가리키는 새 성과목표(%)가 이 반영에 없습니다', r ->> 'deliverable_ref';
    end if;
  end loop;
  for r in select elem from jsonb_array_elements(v_r_adds) as t(elem) loop
    if nullif(r ->> 'tech_target_ref', '') is not null and not exists (
      select 1 from jsonb_array_elements(v_t_adds) as d(row) where d.row ->> 'row_key' = r ->> 'tech_target_ref'
    ) then
      raise exception '측정이력이 가리키는 새 기술목표(%)가 이 반영에 없습니다', r ->> 'tech_target_ref';
    end if;
  end loop;

  -- ── N-13 과제 경계: 참조하는 연차·기관·인력 ──

  select coalesce(array_agg(distinct s.id::uuid), '{}') into v_year_ids
    from (
      select e.key as id
        from jsonb_array_elements(v_d_adds || v_d_updates || v_t_adds || v_t_updates) as t(row),
             jsonb_each(t.row -> 'target_by_year') as e
      union all
      select t.row ->> 'year_id'
        from jsonb_array_elements(v_a_adds || v_a_updates || v_r_adds || v_r_updates) as t(row)
       where jsonb_typeof(t.row -> 'year_id') = 'string'
    ) s;
  -- S-13: `_meta`의 연차가 그사이 삭제됐으면 연차 열 해석이 어긋난다 — 전체를 거부한다
  if exists (
    select 1 from unnest(v_year_ids) as y(id) where not exists (select 1 from years where id = y.id)
  ) then
    raise exception '양식을 받은 뒤 연차가 바뀌었습니다 — 다시 내려받으세요';
  end if;
  if exists (
    select 1 from years where id = any(v_year_ids) and project_id <> p_project_id
  ) then
    raise exception '이 과제에 속하지 않은 연차가 포함되어 있습니다';
  end if;

  select coalesce(array_agg(distinct (t.row ->> 'org_id')::uuid), '{}') into v_org_ids
    from jsonb_array_elements(v_d_adds || v_d_updates || v_t_adds || v_t_updates
                              || v_a_adds || v_a_updates) as t(row)
   where jsonb_typeof(t.row -> 'org_id') = 'string';
  if exists (
    select 1 from unnest(v_org_ids) as o(id) where not exists (select 1 from organizations where id = o.id)
  ) then
    raise exception '양식을 받은 뒤 기관이 바뀌었습니다 — 다시 내려받으세요';
  end if;
  if exists (
    select 1 from organizations where id = any(v_org_ids) and project_id <> p_project_id
  ) then
    raise exception '이 과제에 속하지 않은 기관이 포함되어 있습니다';
  end if;

  select coalesce(array_agg(distinct (m.v #>> '{}')::uuid), '{}') into v_member_ids
    from jsonb_array_elements(v_a_adds || v_a_updates) as t(row),
         jsonb_array_elements(t.row -> 'member_ids') as m(v);
  if exists (
    select 1 from unnest(v_member_ids) as m(id) where not exists (select 1 from members where id = m.id)
  ) then
    raise exception '양식을 받은 뒤 참여인력이 바뀌었습니다 — 다시 내려받으세요';
  end if;
  if exists (
    select 1 from members where id = any(v_member_ids) and project_id <> p_project_id
  ) then
    raise exception '이 과제에 속하지 않은 참여인력이 포함되어 있습니다';
  end if;

  -- ── N-13 과제 경계: 변경·삭제 대상 중 **지금 존재하는** 행 ──
  -- 없는 행은 경계 위반이 아니라 충돌(이미 삭제됨)이다 — 아래 반영 루프가 다룬다
  if exists (
    select 1 from deliverables where id = any(v_d_upd_ids || v_d_del) and project_id <> p_project_id
  ) then
    raise exception '이 과제에 속하지 않은 성과목표가 포함되어 있습니다';
  end if;
  if exists (
    select 1 from tech_targets where id = any(v_t_upd_ids || v_t_del) and project_id <> p_project_id
  ) then
    raise exception '이 과제에 속하지 않은 기술목표가 포함되어 있습니다';
  end if;
  if exists (
    select 1 from deliverable_achievements a join deliverables d on d.id = a.deliverable_id
     where a.id = any(v_a_upd_ids || v_a_del) and d.project_id <> p_project_id
  ) then
    raise exception '이 과제에 속하지 않은 성과실적이 포함되어 있습니다';
  end if;
  if exists (
    select 1 from tech_target_records rc join tech_targets tt on tt.id = rc.tech_target_id
     where rc.id = any(v_r_upd_ids || v_r_del) and tt.project_id <> p_project_id
  ) then
    raise exception '이 과제에 속하지 않은 측정이력이 포함되어 있습니다';
  end if;

  -- S-18 parent-moved: 변경은 부모 id를 쓰지 않는다. 파일에서 다른 부모로 옮겨진 기존 행을
  -- 원래 부모에 조용히 두면 사용자가 본 것과 저장이 어긋나고, 옮기면 달성률이 조용히 이동한다
  if exists (
    select 1 from jsonb_array_elements(v_a_updates) as t(row)
      join deliverable_achievements a on a.id = (t.row ->> 'id')::uuid
     where a.deliverable_id <> (t.row ->> 'deliverable_id')::uuid
  ) then
    raise exception '기존 성과실적을 다른 성과목표로 옮길 수 없습니다. 그 행을 지우고 새 행으로 적으세요';
  end if;
  if exists (
    select 1 from jsonb_array_elements(v_r_updates) as t(row)
      join tech_target_records rc on rc.id = (t.row ->> 'id')::uuid
     where rc.tech_target_id <> (t.row ->> 'tech_target_id')::uuid
  ) then
    raise exception '기존 측정이력을 다른 기술목표로 옮길 수 없습니다. 그 행을 지우고 새 행으로 적으세요';
  end if;

  -- S-6① orphan-child: 지울 부모를 가리키는 자식이 남아 있으면 그 자식은 cascade로 사라지거나
  -- 부모 없이 추가된다. 미리보기가 막지만 반영에서도 거부한다
  if exists (
    select 1 from jsonb_array_elements(v_a_adds || v_a_updates) as t(row)
     where nullif(t.row ->> 'deliverable_id', '') is not null
       and (t.row ->> 'deliverable_id')::uuid = any(v_d_del)
  ) then
    raise exception '삭제할 성과목표를 가리키는 성과실적 행이 남아 있습니다';
  end if;
  if exists (
    select 1 from jsonb_array_elements(v_r_adds || v_r_updates) as t(row)
     where nullif(t.row ->> 'tech_target_id', '') is not null
       and (t.row ->> 'tech_target_id')::uuid = any(v_t_del)
  ) then
    raise exception '삭제할 기술목표를 가리키는 측정이력 행이 남아 있습니다';
  end if;

  -- 새 자식이 붙을 기존 부모는 지금 이 과제에 있어야 한다. 받은 뒤 지워졌으면 붙일 곳이 없다
  select coalesce(array_agg(distinct (t.row ->> 'deliverable_id')::uuid), '{}') into v_parent_ids
    from jsonb_array_elements(v_a_adds) as t(row)
   where nullif(t.row ->> 'deliverable_id', '') is not null;
  if exists (
    select 1 from unnest(v_parent_ids) as p(id) where not exists (select 1 from deliverables where id = p.id)
  ) then
    raise exception '성과실적을 붙일 성과목표가 양식을 받은 뒤 삭제되었습니다 — 다시 내려받으세요';
  end if;
  if exists (
    select 1 from deliverables where id = any(v_parent_ids) and project_id <> p_project_id
  ) then
    raise exception '이 과제에 속하지 않은 성과목표가 포함되어 있습니다';
  end if;
  select coalesce(array_agg(distinct (t.row ->> 'tech_target_id')::uuid), '{}') into v_parent_ids
    from jsonb_array_elements(v_r_adds) as t(row)
   where nullif(t.row ->> 'tech_target_id', '') is not null;
  if exists (
    select 1 from unnest(v_parent_ids) as p(id) where not exists (select 1 from tech_targets where id = p.id)
  ) then
    raise exception '측정이력을 붙일 기술목표가 양식을 받은 뒤 삭제되었습니다 — 다시 내려받으세요';
  end if;
  if exists (
    select 1 from tech_targets where id = any(v_parent_ids) and project_id <> p_project_id
  ) then
    raise exception '이 과제에 속하지 않은 기술목표가 포함되어 있습니다';
  end if;

  -- 새 자식이 붙을 기존 부모를 잠근다: 그사이 지워지면 FK 위반이 사람이 읽을 수 없는 메시지로 난다
  perform 1 from deliverables d
   where d.id in (select (t.row ->> 'deliverable_id')::uuid
                    from jsonb_array_elements(v_a_adds) as t(row)
                   where nullif(t.row ->> 'deliverable_id', '') is not null)
     for share;
  perform 1 from tech_targets tt
   where tt.id in (select (t.row ->> 'tech_target_id')::uuid
                     from jsonb_array_elements(v_r_adds) as t(row)
                    where nullif(t.row ->> 'tech_target_id', '') is not null)
     for share;

  -- ── 삭제 ① 자식 (GF-5: 삭제도 같은 version 비교 — 내려받은 뒤 바뀐 행은 지우지 않는다) ──

  foreach v_id in array v_a_del loop
    v_exp := (v_expected ->> v_id::text)::numeric::bigint;
    select * into v_old_a from deliverable_achievements where id = v_id for update;
    if not found then
      v_conflicts := v_conflicts || jsonb_build_array(jsonb_build_object('kind', 'achievement', 'id', v_id, 'reason', 'deleted'));
      continue;
    end if;
    -- cascade로 함께 사라지는 관여자 연계를 지우기 전에 담는다(GF-11)
    select coalesce(jsonb_agg(to_jsonb(am)), '[]') into v_tmp
      from achievement_members am where am.achievement_id = v_id;

    delete from deliverable_achievements where id = v_id and version = v_exp;
    get diagnostics v_n = row_count;
    if v_n = 0 then
      v_conflicts := v_conflicts || jsonb_build_array(jsonb_build_object('kind', 'achievement', 'id', v_id, 'reason', 'changed'));
      continue;
    end if;
    v_before_a  := v_before_a || jsonb_build_array(to_jsonb(v_old_a));
    v_before_am := v_before_am || v_tmp;
    v_gone_a    := v_gone_a || v_id;
    v_del_a     := v_del_a + 1;
  end loop;

  foreach v_id in array v_r_del loop
    v_exp := (v_expected ->> v_id::text)::numeric::bigint;
    select * into v_old_r from tech_target_records where id = v_id for update;
    if not found then
      v_conflicts := v_conflicts || jsonb_build_array(jsonb_build_object('kind', 'record', 'id', v_id, 'reason', 'deleted'));
      continue;
    end if;
    delete from tech_target_records where id = v_id and version = v_exp;
    get diagnostics v_n = row_count;
    if v_n = 0 then
      v_conflicts := v_conflicts || jsonb_build_array(jsonb_build_object('kind', 'record', 'id', v_id, 'reason', 'changed'));
      continue;
    end if;
    v_before_r := v_before_r || jsonb_build_array(to_jsonb(v_old_r));
    v_gone_r   := v_gone_r || v_id;
    v_del_r    := v_del_r + 1;
  end loop;

  -- ── 삭제 ② 부모 (S-6②: 남은 자식이 전부 내려받은 그대로일 때만 지운다) ──
  -- 부모 행을 FOR UPDATE로 잠그면 새 자식 삽입(FK의 KEY SHARE)도 막혀 검사와 삭제 사이에 끼지 못한다

  foreach v_id in array v_d_del loop
    v_exp := (v_expected ->> v_id::text)::numeric::bigint;
    select * into v_old_d from deliverables where id = v_id for update;
    if not found then
      v_conflicts := v_conflicts || jsonb_build_array(jsonb_build_object('kind', 'deliverable', 'id', v_id, 'reason', 'deleted'));
      continue;
    end if;
    perform 1 from deliverable_achievements where deliverable_id = v_id for update;
    -- 사용자가 본 적 없는 자식(내려받은 뒤 추가·변경)이 cascade로 사라지지 않게 한다
    if v_old_d.version <> v_exp or exists (
      select 1 from deliverable_achievements a
       where a.deliverable_id = v_id
         and (jsonb_typeof(v_expected -> a.id::text) is distinct from 'number'
              or a.version <> (v_expected ->> a.id::text)::numeric::bigint)
    ) then
      v_conflicts := v_conflicts || jsonb_build_array(jsonb_build_object('kind', 'deliverable', 'id', v_id, 'reason', 'changed'));
      continue;
    end if;

    select coalesce(jsonb_agg(to_jsonb(a)), '[]'), coalesce(array_agg(a.id), '{}')
      into v_tmp, v_parent_ids
      from deliverable_achievements a where a.deliverable_id = v_id;
    select coalesce(jsonb_agg(to_jsonb(am)), '[]') into v_tmp2
      from achievement_members am where am.achievement_id = any(v_parent_ids);
    -- WBS 작업 연계도 cascade로 끊긴다 — 지우기 전에 담아야 되돌릴 수 있다(GF-11)
    select coalesce(jsonb_agg(to_jsonb(td)), '[]') into v_links
      from task_deliverables td where td.deliverable_id = v_id;

    delete from deliverables where id = v_id and version = v_exp;
    get diagnostics v_n = row_count;
    if v_n = 0 then
      v_conflicts := v_conflicts || jsonb_build_array(jsonb_build_object('kind', 'deliverable', 'id', v_id, 'reason', 'changed'));
      continue;
    end if;
    v_before_d  := v_before_d || jsonb_build_array(to_jsonb(v_old_d));
    v_before_a  := v_before_a || v_tmp;
    v_before_am := v_before_am || v_tmp2;
    v_before_td := v_before_td || v_links;
    v_gone_a    := v_gone_a || v_parent_ids;
    v_gone_d    := v_gone_d || v_id;
    v_del_d     := v_del_d + 1;
  end loop;

  foreach v_id in array v_t_del loop
    v_exp := (v_expected ->> v_id::text)::numeric::bigint;
    select * into v_old_t from tech_targets where id = v_id for update;
    if not found then
      v_conflicts := v_conflicts || jsonb_build_array(jsonb_build_object('kind', 'techTarget', 'id', v_id, 'reason', 'deleted'));
      continue;
    end if;
    perform 1 from tech_target_records where tech_target_id = v_id for update;
    if v_old_t.version <> v_exp or exists (
      select 1 from tech_target_records rc
       where rc.tech_target_id = v_id
         and (jsonb_typeof(v_expected -> rc.id::text) is distinct from 'number'
              or rc.version <> (v_expected ->> rc.id::text)::numeric::bigint)
    ) then
      v_conflicts := v_conflicts || jsonb_build_array(jsonb_build_object('kind', 'techTarget', 'id', v_id, 'reason', 'changed'));
      continue;
    end if;

    select coalesce(jsonb_agg(to_jsonb(rc)), '[]'), coalesce(array_agg(rc.id), '{}')
      into v_tmp, v_parent_ids
      from tech_target_records rc where rc.tech_target_id = v_id;
    select coalesce(jsonb_agg(to_jsonb(tt)), '[]') into v_links
      from task_tech_targets tt where tt.tech_target_id = v_id;

    delete from tech_targets where id = v_id and version = v_exp;
    get diagnostics v_n = row_count;
    if v_n = 0 then
      v_conflicts := v_conflicts || jsonb_build_array(jsonb_build_object('kind', 'techTarget', 'id', v_id, 'reason', 'changed'));
      continue;
    end if;
    v_before_t := v_before_t || jsonb_build_array(to_jsonb(v_old_t));
    v_before_r  := v_before_r || v_tmp;
    v_before_tt := v_before_tt || v_links;
    v_gone_r   := v_gone_r || v_parent_ids;
    v_gone_t   := v_gone_t || v_id;
    v_del_t    := v_del_t + 1;
  end loop;

  -- ── 변경 ① 부모 (GF-5: O-1 불일치는 그 행만 건너뛴다 — 전체 롤백이 아니다) ──
  -- target_by_year: `old || 전달값`으로 전달된 키만 덮고, null 값(빈 칸)은 strip_nulls가 키째 지운다.
  -- 전달되지 않은 기존 키(양식을 받은 뒤 생긴 연차 등)는 그대로 남는다(S-13)

  for r in select elem from jsonb_array_elements(v_d_updates) as t(elem) loop
    v_id  := (r ->> 'id')::uuid;
    v_exp := (v_expected ->> v_id::text)::numeric::bigint;
    select * into v_old_d from deliverables where id = v_id for update;
    if not found then
      v_conflicts := v_conflicts || jsonb_build_array(jsonb_build_object('kind', 'deliverable', 'id', v_id, 'reason', 'deleted'));
      continue;
    end if;

    update deliverables
       set type            = r ->> 'type',
           name            = r ->> 'name',
           unit            = r ->> 'unit',
           weight          = (r ->> 'weight')::numeric,
           target_total    = (r ->> 'target_total')::numeric::integer,
           target_by_year  = jsonb_strip_nulls(target_by_year || (r -> 'target_by_year')),
           org_id          = (r ->> 'org_id')::uuid,
           evidence_method = r ->> 'evidence_method',
           note            = r ->> 'note',
           updated_by      = auth.uid()
     where id = v_id and version = v_exp;
    get diagnostics v_n = row_count;
    if v_n = 0 then
      v_conflicts := v_conflicts || jsonb_build_array(jsonb_build_object('kind', 'deliverable', 'id', v_id, 'reason', 'changed'));
      continue;
    end if;
    v_before_d := v_before_d || jsonb_build_array(to_jsonb(v_old_d));
    v_upd_d    := v_upd_d + 1;
  end loop;

  for r in select elem from jsonb_array_elements(v_t_updates) as t(elem) loop
    v_id  := (r ->> 'id')::uuid;
    v_exp := (v_expected ->> v_id::text)::numeric::bigint;
    select * into v_old_t from tech_targets where id = v_id for update;
    if not found then
      v_conflicts := v_conflicts || jsonb_build_array(jsonb_build_object('kind', 'techTarget', 'id', v_id, 'reason', 'deleted'));
      continue;
    end if;

    update tech_targets
       set name                   = r ->> 'name',
           group_name             = r ->> 'group_name',
           unit                   = r ->> 'unit',
           direction              = r ->> 'direction',
           weight                 = (r ->> 'weight')::numeric,
           target_value           = (r ->> 'target_value')::numeric,
           target_by_year         = jsonb_strip_nulls(target_by_year || (r -> 'target_by_year')),
           baseline_domestic      = (r ->> 'baseline_domestic')::numeric,
           world_best             = (r ->> 'world_best')::numeric,
           world_best_holder      = r ->> 'world_best_holder',
           measure_method         = r ->> 'measure_method',
           measure_description    = r ->> 'measure_description',
           standard_basis         = r ->> 'standard_basis',
           basis_rationale        = r ->> 'basis_rationale',
           evaluation_environment = r ->> 'evaluation_environment',
           org_id                 = (r ->> 'org_id')::uuid,
           note                   = r ->> 'note',
           updated_by             = auth.uid()
     where id = v_id and version = v_exp;
    get diagnostics v_n = row_count;
    if v_n = 0 then
      v_conflicts := v_conflicts || jsonb_build_array(jsonb_build_object('kind', 'techTarget', 'id', v_id, 'reason', 'changed'));
      continue;
    end if;
    v_before_t := v_before_t || jsonb_build_array(to_jsonb(v_old_t));
    v_upd_t    := v_upd_t + 1;
  end loop;

  -- ── 변경 ② 자식 ──

  for r in select elem from jsonb_array_elements(v_a_updates) as t(elem) loop
    v_id  := (r ->> 'id')::uuid;
    v_exp := (v_expected ->> v_id::text)::numeric::bigint;
    select * into v_old_a from deliverable_achievements where id = v_id for update;
    if not found then
      v_conflicts := v_conflicts || jsonb_build_array(jsonb_build_object('kind', 'achievement', 'id', v_id, 'reason', 'deleted'));
      continue;
    end if;

    -- deliverable_id는 쓰지 않는다(위에서 현재 부모와 같음을 확인했다)
    update deliverable_achievements
       set title        = r ->> 'title',
           date         = (r ->> 'date')::date,
           year_id      = (r ->> 'year_id')::uuid,
           org_id       = (r ->> 'org_id')::uuid,
           evidence_url = r ->> 'evidence_url',
           note         = r ->> 'note',
           updated_by   = auth.uid()
     where id = v_id and version = v_exp;
    get diagnostics v_n = row_count;
    if v_n = 0 then
      v_conflicts := v_conflicts || jsonb_build_array(jsonb_build_object('kind', 'achievement', 'id', v_id, 'reason', 'changed'));
      continue;
    end if;

    -- 관여자는 교체다. 교체 전 연계 행을 스냅샷에 담는다(GF-11)
    select coalesce(jsonb_agg(to_jsonb(am)), '[]') into v_tmp
      from achievement_members am where am.achievement_id = v_id;
    delete from achievement_members where achievement_id = v_id;
    insert into achievement_members (achievement_id, member_id)
    select distinct v_id, (m.v #>> '{}')::uuid
      from jsonb_array_elements(r -> 'member_ids') as m(v);

    v_before_a  := v_before_a || jsonb_build_array(to_jsonb(v_old_a));
    v_before_am := v_before_am || v_tmp;
    v_upd_a     := v_upd_a + 1;
  end loop;

  for r in select elem from jsonb_array_elements(v_r_updates) as t(elem) loop
    v_id  := (r ->> 'id')::uuid;
    v_exp := (v_expected ->> v_id::text)::numeric::bigint;
    select * into v_old_r from tech_target_records where id = v_id for update;
    if not found then
      v_conflicts := v_conflicts || jsonb_build_array(jsonb_build_object('kind', 'record', 'id', v_id, 'reason', 'deleted'));
      continue;
    end if;

    update tech_target_records
       set value        = (r ->> 'value')::numeric,
           date         = (r ->> 'date')::date,
           year_id      = (r ->> 'year_id')::uuid,
           method       = r ->> 'method',
           evaluator    = r ->> 'evaluator',
           evidence_url = r ->> 'evidence_url',
           note         = r ->> 'note',
           updated_by   = auth.uid()
     where id = v_id and version = v_exp;
    get diagnostics v_n = row_count;
    if v_n = 0 then
      v_conflicts := v_conflicts || jsonb_build_array(jsonb_build_object('kind', 'record', 'id', v_id, 'reason', 'changed'));
      continue;
    end if;
    v_before_r := v_before_r || jsonb_build_array(to_jsonb(v_old_r));
    v_upd_r    := v_upd_r + 1;
  end loop;

  -- ── 추가 ① 부모 (S-14: 기존 순서 불변, 현재 최대 + 1부터 전달 순서대로) ──
  -- version은 넣지 않는다 — 기본값 1이 나중의 완전 되돌리기(IN-14와 같은 방식)의 "삽입 시 값" 기준이다

  select coalesce(max(sort_order) + 1, 0) into v_d_order from deliverables where project_id = p_project_id;
  for r in select elem from jsonb_array_elements(v_d_adds) as t(elem) loop
    insert into deliverables (project_id, type, name, unit, weight, target_total, target_by_year,
                              org_id, evidence_method, note, sort_order, created_by, updated_by)
    values (
      p_project_id,
      r ->> 'type',
      r ->> 'name',
      r ->> 'unit',
      (r ->> 'weight')::numeric,
      (r ->> 'target_total')::numeric::integer,
      jsonb_strip_nulls(r -> 'target_by_year'),
      (r ->> 'org_id')::uuid,
      r ->> 'evidence_method',
      r ->> 'note',
      v_d_order,
      auth.uid(), auth.uid()
    )
    returning id into v_new_id;
    v_d_order := v_d_order + 1;
    v_added_d := v_added_d || v_new_id;
    if nullif(r ->> 'row_key', '') is not null then
      v_d_keys := v_d_keys || jsonb_build_object(r ->> 'row_key', v_new_id);
    end if;
  end loop;

  select coalesce(max(sort_order) + 1, 0) into v_t_order from tech_targets where project_id = p_project_id;
  for r in select elem from jsonb_array_elements(v_t_adds) as t(elem) loop
    insert into tech_targets (project_id, name, group_name, unit, direction, weight, target_value,
                              target_by_year, baseline_domestic, world_best, world_best_holder,
                              measure_method, measure_description, standard_basis, basis_rationale,
                              evaluation_environment, org_id, note, sort_order, created_by, updated_by)
    values (
      p_project_id,
      r ->> 'name',
      r ->> 'group_name',
      r ->> 'unit',
      r ->> 'direction',
      (r ->> 'weight')::numeric,
      (r ->> 'target_value')::numeric,
      jsonb_strip_nulls(r -> 'target_by_year'),
      (r ->> 'baseline_domestic')::numeric,
      (r ->> 'world_best')::numeric,
      r ->> 'world_best_holder',
      r ->> 'measure_method',
      r ->> 'measure_description',
      r ->> 'standard_basis',
      r ->> 'basis_rationale',
      r ->> 'evaluation_environment',
      (r ->> 'org_id')::uuid,
      r ->> 'note',
      v_t_order,
      auth.uid(), auth.uid()
    )
    returning id into v_new_id;
    v_t_order := v_t_order + 1;
    v_added_t := v_added_t || v_new_id;
    if nullif(r ->> 'row_key', '') is not null then
      v_t_keys := v_t_keys || jsonb_build_object(r ->> 'row_key', v_new_id);
    end if;
  end loop;

  -- ── 추가 ② 자식 (GF-10: 임시 키는 방금 만든 부모 id로 해석한다) ──

  for r in select elem from jsonb_array_elements(v_a_adds) as t(elem) loop
    v_parent := coalesce(nullif(r ->> 'deliverable_id', '')::uuid,
                         (v_d_keys ->> (r ->> 'deliverable_ref'))::uuid);
    insert into deliverable_achievements (deliverable_id, title, date, year_id, org_id,
                                          evidence_url, note, created_by, updated_by)
    values (
      v_parent,
      r ->> 'title',
      (r ->> 'date')::date,
      (r ->> 'year_id')::uuid,
      (r ->> 'org_id')::uuid,
      r ->> 'evidence_url',
      r ->> 'note',
      auth.uid(), auth.uid()
    )
    returning id into v_new_id;
    insert into achievement_members (achievement_id, member_id)
    select distinct v_new_id, (m.v #>> '{}')::uuid
      from jsonb_array_elements(r -> 'member_ids') as m(v);
    v_added_a := v_added_a || v_new_id;
  end loop;

  for r in select elem from jsonb_array_elements(v_r_adds) as t(elem) loop
    v_parent := coalesce(nullif(r ->> 'tech_target_id', '')::uuid,
                         (v_t_keys ->> (r ->> 'tech_target_ref'))::uuid);
    insert into tech_target_records (tech_target_id, value, date, year_id, method, evaluator,
                                     evidence_url, note, created_by, updated_by)
    values (
      v_parent,
      (r ->> 'value')::numeric,
      (r ->> 'date')::date,
      (r ->> 'year_id')::uuid,
      r ->> 'method',
      r ->> 'evaluator',
      r ->> 'evidence_url',
      r ->> 'note',
      auth.uid(), auth.uid()
    )
    returning id into v_new_id;
    v_added_r := v_added_r || v_new_id;
  end loop;

  -- ── I-17 / GF-11: 같은 트랜잭션에서 스냅샷을 남긴다 ──
  -- 전부 충돌이라 바뀐 행이 없어도 남긴다 — 반환의 snapshotId는 항상 있다
  insert into import_snapshots (project_id, snapshot, created_by, updated_by)
  values (
    p_project_id,
    jsonb_build_object(
      'schemaVersion', 4,
      'projectId',     p_project_id,
      'capturedAt',    now(),
      'kind',          'goal_form',
      'source', jsonb_build_object(
        -- 형식을 항상 같게 유지해 설정 화면(§7.14)의 파싱에 옵션 분기가 없게 한다
        'fileName',  coalesce(v_source ->> 'fileName', ''),
        'sheetName', coalesce(v_source ->> 'sheetName', ''),
        'profileId', null,   -- 우리 양식은 프로파일을 쓰지 않는다
        'fileHash',  coalesce(v_source ->> 'fileHash', '')
      ),
      'items', '[]'::jsonb,   -- 계획액은 바꾸지 않는다
      'goals', jsonb_build_object(
        'added', jsonb_build_object(
          'deliverables',             to_jsonb(v_added_d),
          'deliverable_achievements', to_jsonb(v_added_a),
          'tech_targets',             to_jsonb(v_added_t),
          'tech_target_records',      to_jsonb(v_added_r)
        ),
        'before', jsonb_build_object(
          'deliverables',             v_before_d,
          'deliverable_achievements', v_before_a,
          'tech_targets',             v_before_t,
          'tech_target_records',      v_before_r,
          'achievement_members',      v_before_am,
          'task_deliverables',        v_before_td,
          'task_tech_targets',        v_before_tt
        ),
        'deleted', jsonb_build_object(
          'deliverables',             to_jsonb(v_gone_d),
          'deliverable_achievements', to_jsonb(v_gone_a),
          'tech_targets',             to_jsonb(v_gone_t),
          'tech_target_records',      to_jsonb(v_gone_r)
        )
      )
    ),
    auth.uid(), auth.uid()
  )
  returning id into v_snapshot_id;

  -- I-17: 과제별 최근 20개만 유지 (commit_import·commit_detail_import·commit_execution_form과 같은 창)
  delete from import_snapshots
   where project_id = p_project_id
     and id not in (
       select id from import_snapshots
        where project_id = p_project_id
        order by created_at desc, id desc
        limit 20
     );

  return jsonb_build_object(
    'snapshotId',   v_snapshot_id,
    'deliverables', jsonb_build_object('added', cardinality(v_added_d), 'updated', v_upd_d, 'deleted', v_del_d),
    'achievements', jsonb_build_object('added', cardinality(v_added_a), 'updated', v_upd_a, 'deleted', v_del_a),
    'techTargets',  jsonb_build_object('added', cardinality(v_added_t), 'updated', v_upd_t, 'deleted', v_del_t),
    'records',      jsonb_build_object('added', cardinality(v_added_r), 'updated', v_upd_r, 'deleted', v_del_r),
    'conflicts',    v_conflicts
  );
end; $$;

revoke execute on function public.commit_goal_form(uuid, jsonb, jsonb, jsonb, jsonb, jsonb, jsonb) from public, anon;
grant execute on function public.commit_goal_form(uuid, jsonb, jsonb, jsonb, jsonb, jsonb, jsonb) to authenticated;

-- -----------------------------------------------------------------------------
-- 3. restore_import_snapshot — 목표 양식 스냅샷 거부 (GF-11, S-3)
--    20260928000000_execution_form.sql의 정의 전문에서 바뀐 곳은 하나뿐이다:
--      스냅샷을 읽은 **직후** `goals` 키가 있으면 raise한다.
--
--    ⚠ **goals 키가 없는 스냅샷(총괄표·산출근거·수행)의 동작은 한 글자도 바뀌지 않는다** —
--    거부 블록 뒤의 본문은 20260928000000과 같다.
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
-- 4. restore_backup 갱신 (§8.7 K-7, §8.8, S-2)
--    20260928000000_execution_form.sql의 정의 전문에서 바뀐 곳은 deliverables·tech_targets
--    두 분기(와 그 사실을 적은 주석)뿐이다. c_tables·grant/revoke·budget_executions의 spec 기본값·
--    detail_id 2차 복원은 그대로다.
--      옛(Phase 21 이전) 백업 행에는 새 not null 컬럼 키가 없어 jsonb_populate_recordset이 null을
--      넣고 실패한다. §8.8 목록의 컬럼만 명시해 채운다 — deliverables.weight(0)·evidence_method(''),
--      tech_targets.group_name·standard_basis·basis_rationale·evaluation_environment·note('').
--      `기본값 || 행`이라 키가 있으면(null이어도) 행 값이 이긴다 — 새 백업의 null은 not null로 실패한다.
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
  -- budget_executions.spec과 deliverables·tech_targets의 Phase 21 컬럼 7종이고 §8.8이 근거다).
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
