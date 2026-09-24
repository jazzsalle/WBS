-- =============================================================================
-- Phase 13 연구비 사용 규칙 — budget_rules 신설 + projects 한도 컬럼 2종 이관·삭제
-- SOT §5.18(RL-D1~RL-D7), §8.7 K-6·K-7·K-8, §8.8, §9 Budget Rules, §14.3 RLS-1
--
-- 규칙 요약 (20260813000000_budget_plan_schema.sql과 같은 관례)
--  - N-4  : 공통 컬럼 id/created_at/updated_at/version/created_by/updated_by
--  - N-5  : updated_at·version은 set_updated_meta 트리거
--  - N-11 : not null 기본값 — string ''
--  - N-12 : enum은 text + check 제약
--  - RLS-1: RLS 활성 + to authenticated + is_approved()
--  - §8.5 구독표에 budget_rules가 없으므로 Realtime publication에는 넣지 않는다
--
-- **규칙은 데이터다** — 규칙의 의미(무엇을 무엇으로 나누는가)는 code에 고정되어
-- lib/rules.ts가 알고, 값(비율·금액·켜짐·출처)만 행이 갖는다. 그래서 이 파일에는
-- 한도값이 하나도 없다 — 프리셋(부록 D)은 TS 상수이고 RPC는 행 배열을 받아 적용만 한다.
-- 유일한 예외는 아래 이관 블록의 source 문자열이며, 값 자체는 projects의 기존 입력값이다.
--
-- schema_version 2 → 3 (§8.8): 테이블이 추가되어 백업 파일 형식이 바뀐다.
-- 이 마이그레이션을 적용한 뒤에는 lib/constants.ts의 EXPECTED_SCHEMA_VERSION도 3이어야 한다.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. budget_rules (§5.18)
-- -----------------------------------------------------------------------------
create table public.budget_rules (
  id          uuid primary key default gen_random_uuid(),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  version     bigint not null default 1,   -- RL-D6 (O-1)
  created_by  uuid references public.app_users (id) on delete set null,
  updated_by  uuid references public.app_users (id) on delete set null,

  -- RL-D7: 과제가 사라지면 규칙도 사라진다
  project_id  uuid not null references public.projects (id) on delete cascade,

  code        text not null
                check (code in (
                  -- 비율 상한·하한 (§6.14.2)
                  'allowance_max', 'allowance_min', 'indirect_max', 'consignment_max',
                  'external_tech_max', 'gov_share_max', 'own_cash_min',
                  -- 계상 금지 · 현금/현물 (§6.14.3)
                  'indirect_cash_only', 'no_personnel_support', 'no_student_personnel',
                  'no_burden', 'existing_personnel_cash', 'existing_cash_le_new',
                  -- 인력 (§6.14.4)
                  'min_participation',
                  -- 건별 금액 알림 (§6.14.5)
                  'equipment_review_threshold', 'material_notice_threshold',
                  'outsourcing_notice_threshold'
                )),
  -- false면 판정하지 않는다 (Phase 9의 null 한도와 같은 뜻)
  enabled     boolean not null default true,
  -- 비율(%) 또는 원 단위 정수. numeric인 이유: 비율은 69.2308처럼 소수를 가질 수 있고,
  -- 비교는 원값으로 해야 한다(중간 반올림 금지). 금액 코드는 아래 check가 정수를 강제한다
  value       numeric,
  -- 간접비 분모. 고시마다 정의가 달라 규칙 행이 고른다 (§6.14 RL-3). indirect_max 전용
  base        text
                check (base in ('direct_cash_excl_intl_consign_burden', 'direct_cash_excl_intl')),
  severity    text not null check (severity in ('error', 'warn', 'info')),
  -- RL-D5: 출처 없는 한도는 PL-16이 금지한 "지어낸 숫자"다. 공백만인 문자열도 거부한다
  source      text not null check (length(trim(source)) > 0),
  note        text not null default '',

  -- RL-D1: 같은 규칙이 두 줄이면 어느 쪽이 이기는지 정할 수 없다
  constraint budget_rules_project_code_key unique (project_id, code),

  -- RL-D2 ①: 코드 종류별 값의 범위.
  --   비율 코드 → null 또는 0~100 / 금액 코드 → null 또는 정수 ≥ 0 / 값 없는 코드 → 반드시 null
  constraint budget_rules_value_range_check check (
    case
      when code in ('allowance_max', 'allowance_min', 'indirect_max', 'consignment_max',
                    'external_tech_max', 'gov_share_max', 'own_cash_min', 'min_participation')
        then value is null or (value >= 0 and value <= 100)
      when code in ('equipment_review_threshold', 'material_notice_threshold',
                    'outsourcing_notice_threshold')
        then value is null or (value >= 0 and value = trunc(value))
      else value is null
    end
  ),
  -- RL-D2 ②: "켜져 있는데 기준이 없는" 규칙은 판정할 수 없다
  constraint budget_rules_enabled_value_check check (
    not enabled
    or code in ('indirect_cash_only', 'no_personnel_support', 'no_student_personnel',
                'no_burden', 'existing_personnel_cash', 'existing_cash_le_new')
    or value is not null
  ),
  -- RL-D3: base는 indirect_max에서만, 그리고 반드시. code·base 모두 null이 아닐 때만
  -- 동치 비교가 의미를 가지므로 `is not null`로 감싸 boolean 3치 논리를 피한다
  constraint budget_rules_base_code_check check (
    (base is not null) = (code = 'indirect_max')
  )
);

-- -----------------------------------------------------------------------------
-- 2. 트리거 (N-5)
-- -----------------------------------------------------------------------------
create trigger set_updated_meta before update on public.budget_rules
  for each row execute function public.set_updated_meta();

-- -----------------------------------------------------------------------------
-- 3. RLS (RLS-1, §14.3)
-- -----------------------------------------------------------------------------
alter table public.budget_rules enable row level security;

create policy "approved users full access" on public.budget_rules
  for all to authenticated
  using (is_approved()) with check (is_approved());

-- -----------------------------------------------------------------------------
-- 4. Phase 9 한도 컬럼 이관 (§5.18 말미)
--    값이 있던 과제만 행을 만든다 — null은 "검사 안 함"이었고, 행 없음도 같은 뜻이다.
--    마커 주석은 tests/integration/budget-rules-migration.test.ts가 블록을 잘라 내
--    임시 컬럼 위에서 재실행하기 위한 것이다 — 지우거나 이름을 바꾸지 않는다.
-- -----------------------------------------------------------------------------
-- MIGRATE-RATE-LIMITS:BEGIN
insert into public.budget_rules
  (project_id, code, enabled, value, base, severity, source, note, created_by, updated_by)
select id, 'allowance_max', true, allowance_rate_limit, null, 'error',
       '과기부고시 제2026-38호 제26조①', '', created_by, updated_by
  from public.projects
 where allowance_rate_limit is not null;

insert into public.budget_rules
  (project_id, code, enabled, value, base, severity, source, note, created_by, updated_by)
select id, 'indirect_max', true, indirect_rate_limit, 'direct_cash_excl_intl_consign_burden', 'error',
       '(Phase 9 입력값 이관)', '', created_by, updated_by
  from public.projects
 where indirect_rate_limit is not null;
-- MIGRATE-RATE-LIMITS:END

alter table public.projects
  drop column allowance_rate_limit,
  drop column indirect_rate_limit;

-- -----------------------------------------------------------------------------
-- 5. apply_rule_preset — 프리셋 행 배열을 한 트랜잭션에서 적용 (§9 Budget Rules, RL-D4)
--    p_rows: [{code, enabled, value, base, severity, source, note}, …] — 값은 TS 상수(부록 D)
--    p_mode: 'fill'      = 없는 code만 insert, 있는 행은 kept
--            'overwrite' = 프리셋에 있는 code 전부 upsert. 일곱 값이 전부 같으면 kept,
--                          하나라도 다르면 updated(트리거가 version +1)
--    프리셋에 없는 기존 행은 건드리지 않고 kept에도 세지 않는다 — 사용자가 직접 넣은 규칙이다.
--    note가 null인 행은 "메모는 건드리지 않는다"로 읽는다(insert면 '').
--
--    security invoker(X-2): budget_rules·projects의 is_approved() 정책이 호출자에게 그대로
--    적용된다. 승인되지 않았거나 남의 과제면 "과제를 찾을 수 없습니다"로 끝난다.
--    check 제약 위반(23514)은 그대로 올라간다 — 리포지토리가 RuleViolationError로 매핑한다.
-- -----------------------------------------------------------------------------
create or replace function public.apply_rule_preset(
  p_project_id uuid,
  p_mode       text,
  p_rows       jsonb
) returns jsonb language plpgsql security invoker as $$
declare
  v_rows     jsonb := coalesce(p_rows, '[]'::jsonb);
  v_added    integer := 0;
  v_updated  integer := 0;
  v_kept     integer := 0;
  v_given    integer;
  v_distinct integer;
  v_existing public.budget_rules%rowtype;
  r          record;
begin
  if p_project_id is null then
    raise exception '규칙을 적용할 과제를 지정해야 합니다';
  end if;
  if p_mode is null or p_mode not in ('fill', 'overwrite') then
    raise exception '프리셋 적용 방식은 fill 또는 overwrite여야 합니다 (%)', coalesce(p_mode, '없음');
  end if;
  if jsonb_typeof(v_rows) <> 'array' then
    raise exception '프리셋 행 목록이 배열이 아닙니다';
  end if;
  if not exists (select 1 from projects where id = p_project_id) then
    raise exception '과제를 찾을 수 없습니다';
  end if;

  -- 같은 code가 두 번 오면 어느 값이 이기는지 정할 수 없다 (RL-D1과 같은 이유)
  select count(*), count(distinct x.code)
    into v_given, v_distinct
    from jsonb_to_recordset(v_rows) as x(code text);
  if v_given <> v_distinct then
    raise exception '프리셋 행 목록에 중복된 code가 있습니다';
  end if;

  for r in
    select x.code, x.enabled, x.value, x.base, x.severity, x.source, x.note
      from jsonb_to_recordset(v_rows)
        as x(code text, enabled boolean, value numeric, base text,
             severity text, source text, note text)
  loop
    if r.code is null then
      raise exception '프리셋 행에 code가 없습니다';
    end if;

    select * into v_existing
      from budget_rules
     where project_id = p_project_id and code = r.code;

    if not found then
      insert into budget_rules
        (project_id, code, enabled, value, base, severity, source, note, created_by, updated_by)
      values
        (p_project_id, r.code, coalesce(r.enabled, true), r.value, r.base, r.severity, r.source,
         coalesce(r.note, ''), auth.uid(), auth.uid());
      v_added := v_added + 1;
    elsif p_mode = 'fill' then
      v_kept := v_kept + 1;
    elsif v_existing.enabled = coalesce(r.enabled, true)
      and v_existing.value    is not distinct from r.value
      and v_existing.base     is not distinct from r.base
      and v_existing.severity is not distinct from r.severity
      and v_existing.source   is not distinct from r.source
      and v_existing.note     = coalesce(r.note, v_existing.note)
    then
      v_kept := v_kept + 1;
    else
      update budget_rules
         set enabled    = coalesce(r.enabled, true),
             value      = r.value,
             base       = r.base,
             severity   = r.severity,
             source     = r.source,
             note       = coalesce(r.note, note),
             updated_by = auth.uid()
       where id = v_existing.id;
      v_updated := v_updated + 1;
    end if;
  end loop;

  return jsonb_build_object('added', v_added, 'updated', v_updated, 'kept', v_kept);
end; $$;

revoke execute on function public.apply_rule_preset(uuid, text, jsonb) from public, anon;
grant execute on function public.apply_rule_preset(uuid, text, jsonb) to authenticated;

-- -----------------------------------------------------------------------------
-- 6. restore_backup 갱신 (§8.7 K-7, RL-D7)
--    c_tables에 budget_rules를 추가하는 것이 유일한 변경 —
--    나머지 로직·순서·검증은 20260813000000_budget_plan_schema.sql과 동일하다.
--
--    위치: budget_details 뒤·risks 앞. FK는 projects뿐이라 projects 뒤면 어디든 되지만,
--    lib/db/backup.ts의 RESTORE_TABLES와 순서까지 일치해야 한다 (어긋나면 복원이 거부된다).
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
  -- not null 제약이 즉시 실패시킨다 (조용히 기본값으로 메꾸지 않는다).
  foreach t in array c_tables loop
    v_rows := payload #> array['tables', t];
    if t = 'projects' then
      -- 순환 FK: pm_member_id/lead_org_id는 members/organizations 삽입 뒤 2차로 복원한다
      select coalesce(jsonb_agg(r - 'pm_member_id' - 'lead_org_id'), '[]'::jsonb)
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
-- schema_version 2 → 3 (§8.8, K-5) — 파일 머리말의 근거 참조.
-- app_settings_guard 트리거는 current_user = 'authenticated'일 때만 막으므로
-- 마이그레이션(postgres 역할)은 갱신할 수 있다 (N-10).
-- -----------------------------------------------------------------------------
update public.app_settings set schema_version = 3 where id = true;
