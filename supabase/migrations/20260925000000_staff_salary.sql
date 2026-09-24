-- =============================================================================
-- Phase 16 조직원·급여 이력 — staff·staff_salaries 신설 + members 4컬럼 + apply_salary_change 스냅샷
-- SOT §5.11(Phase 16 추가 4필드), §5.19(ST-1·ST-2), §5.20, §6.10 PL-10b(v4.7),
--     §8.7 K-6·K-7·K-8, §8.8, §14.3 RLS-1
--
-- 규칙 요약 (20260817000000_budget_rules.sql과 같은 관례)
--  - N-4  : 공통 컬럼 id/created_at/updated_at/version/created_by/updated_by
--  - N-5  : updated_at·version은 set_updated_meta 트리거
--  - N-11 : not null 기본값 — string ''
--  - N-12 : enum은 text + check 제약
--  - RLS-1: RLS 활성 + to authenticated + is_approved()
--  - §8.5 구독표에 staff·staff_salaries가 없으므로 Realtime publication에는 넣지 않는다
--
-- schema_version 3 → 4 (§8.8): 테이블이 추가되어 백업 파일 형식이 바뀐다.
-- 이 마이그레이션을 적용한 뒤에는 lib/constants.ts의 EXPECTED_SCHEMA_VERSION도 4여야 한다.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. staff (§5.19) — 회사 직원 마스터. 과제 Member와 다른 개념이다
-- -----------------------------------------------------------------------------
create table public.staff (
  id          uuid primary key default gen_random_uuid(),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  version     bigint not null default 1,
  created_by  uuid references public.app_users (id) on delete set null,
  updated_by  uuid references public.app_users (id) on delete set null,

  name        text not null,
  -- ST-1: 사내 명부(§6.13)·과제 Member를 잇는 키. 유일성은 아래 함수 인덱스가 정규화해 건다
  email       text not null,
  position    text not null default '',
  -- 재직 여부. 과제 Member.active와 다르다 (HR-5)
  employed    boolean not null default true,
  note        text not null default '',
  sort_order  integer not null default 0
);

-- ST-1: 대소문자·앞뒤 공백이 다른 같은 이메일로 둘을 만들 수 없다.
-- 앱이 소문자로 정규화해 저장하더라도 DB가 최후 방어선으로 같은 규칙을 강제한다 (RLS-3과 같은 판단)
create unique index staff_email_normalized_key
  on public.staff (lower(trim(email)));

-- -----------------------------------------------------------------------------
-- 2. staff_salaries (§5.20) — 급여 이력. 덮어쓰지 않고 쌓는다 (SL-3)
-- -----------------------------------------------------------------------------
create table public.staff_salaries (
  id                  uuid primary key default gen_random_uuid(),
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  version             bigint not null default 1,   -- O-1
  created_by          uuid references public.app_users (id) on delete set null,
  updated_by          uuid references public.app_users (id) on delete set null,

  -- ST-2: 조직원이 사라지면 이력도 사라진다
  staff_id            uuid not null references public.staff (id) on delete cascade,
  -- SL-2: 이 날부터 적용. 기준일 이하 중 가장 늦은 것을 고른다
  effective_from      date not null,
  -- SL-1: 연봉 환산 단위. 산식은 lib/salary.ts에만 있다 (PL-10a와 같은 이유로 DB에 두지 않는다)
  basis               text not null check (basis in ('annual', 'monthly')),
  -- basis 단위의 금액, 원 단위 정수 (절대 규칙 4)
  amount              bigint not null check (amount >= 0),
  -- SL-4: 포함 여부는 이력의 속성이다 — 계약이 바뀌면 달라질 수 있다
  includes_retirement boolean not null,
  includes_insurance  boolean not null,
  note                text not null default '',

  -- 같은 날짜에 두 급여가 있으면 SL-2가 어느 쪽을 고를지 정할 수 없다
  constraint staff_salaries_staff_effective_key unique (staff_id, effective_from)
);

-- -----------------------------------------------------------------------------
-- 3. members 4컬럼 (§5.11 Phase 16 추가)
--    staff_id: ST-2 — 조직원 삭제 시 set null. annual_salary·스냅샷은 남는다.
--    스냅샷 3컬럼: [급여 반영]이 이력에서 복사한 값. null = 기록 없음(수동 입력).
--    컬럼 추가만이라 기존 백업(v3) 행은 jsonb_populate_recordset이 null로 채운다 — 뜻이 맞다.
-- -----------------------------------------------------------------------------
alter table public.members
  add column staff_id                   uuid references public.staff (id) on delete set null,
  add column salary_includes_retirement boolean,
  add column salary_includes_insurance  boolean,
  add column salary_applied_from        date;

-- §6.15 참여율 합산·조직원 상세의 "연결 Member" 조회 경로 (staff_id로 members를 모은다)
create index members_staff_idx on public.members (staff_id);

-- -----------------------------------------------------------------------------
-- 4. 트리거 (N-5) — 초기 스키마의 set_updated_meta를 그대로 쓴다
-- -----------------------------------------------------------------------------
create trigger set_updated_meta before update on public.staff
  for each row execute function public.set_updated_meta();

create trigger set_updated_meta before update on public.staff_salaries
  for each row execute function public.set_updated_meta();

-- -----------------------------------------------------------------------------
-- 5. RLS (RLS-1, §14.3)
-- -----------------------------------------------------------------------------
alter table public.staff enable row level security;
alter table public.staff_salaries enable row level security;

create policy "approved users full access" on public.staff
  for all to authenticated
  using (is_approved()) with check (is_approved());

create policy "approved users full access" on public.staff_salaries
  for all to authenticated
  using (is_approved()) with check (is_approved());

-- -----------------------------------------------------------------------------
-- 6. apply_salary_change 재정의 (PL-10b v4.7)
--    20260814000000_budget_plan_rpcs.sql의 정의에 선택 인자 p_snapshot을 더한 것 —
--    검증·재계산 로직은 그대로다.
--
--    p_snapshot = null                → 기존 동작. 스냅샷 3컬럼은 건드리지 않는다
--    p_snapshot = {"salaryIncludesRetirement": bool|null,
--                  "salaryIncludesInsurance":  bool|null,
--                  "salaryAppliedFrom":        "YYYY-MM-DD"|null}
--                                     → 연봉을 갱신하는 **같은 UPDATE**에서 3컬럼을 세팅한다.
--      따로 쓰면 RPC 실패 시 "적용 이력은 새 값, 연봉은 옛 값"인 행이 남는다.
--      세 값이 전부 null인 객체는 "기록 없음"으로 되돌리는 뜻이다 — 수동 연봉 수정 경로(§5.11).
--
--    인자 개수가 바뀌므로 create or replace로는 교체되지 않는다 — 옛 시그니처를 drop한다.
--    default가 있어 기존 4인자 호출은 그대로 통한다.
-- -----------------------------------------------------------------------------
drop function if exists public.apply_salary_change(uuid, bigint, jsonb, bigint);

create function public.apply_salary_change(
  p_member_id        uuid,
  p_annual_salary    bigint,
  p_amounts          jsonb,
  p_expected_version bigint default null,
  p_snapshot         jsonb  default null
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
  v_retirement boolean;
  v_insurance  boolean;
  v_applied    date;
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
  if p_snapshot is not null then
    if jsonb_typeof(p_snapshot) <> 'object' then
      raise exception '급여 기준 스냅샷이 객체가 아닙니다';
    end if;
    -- 키 이름 오타는 "전부 null"과 구분되지 않으므로 여기서 잡는다
    if not (p_snapshot ?& array['salaryIncludesRetirement', 'salaryIncludesInsurance', 'salaryAppliedFrom']) then
      raise exception '급여 기준 스냅샷에 필요한 키가 없습니다';
    end if;
    v_retirement := (p_snapshot ->> 'salaryIncludesRetirement')::boolean;
    v_insurance  := (p_snapshot ->> 'salaryIncludesInsurance')::boolean;
    v_applied    := (p_snapshot ->> 'salaryAppliedFrom')::date;
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

  -- PL-10b(v4.7): 연봉과 스냅샷은 한 UPDATE다. p_snapshot이 없으면 기존 값을 그대로 둔다
  update members
     set annual_salary              = p_annual_salary,
         salary_includes_retirement = case when p_snapshot is null then salary_includes_retirement else v_retirement end,
         salary_includes_insurance  = case when p_snapshot is null then salary_includes_insurance  else v_insurance  end,
         salary_applied_from        = case when p_snapshot is null then salary_applied_from        else v_applied    end,
         updated_by                 = auth.uid()
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

-- drop으로 옛 grant가 사라졌으므로 다시 준다. 기존 정의는 명시 grant 없이 기본(public)이었다 —
-- 다른 RPC와 같은 규약(authenticated만)으로 맞춘다
revoke execute on function public.apply_salary_change(uuid, bigint, jsonb, bigint, jsonb) from public, anon;
grant execute on function public.apply_salary_change(uuid, bigint, jsonb, bigint, jsonb) to authenticated;

-- -----------------------------------------------------------------------------
-- 7. restore_backup 갱신 (§8.7 K-7, ST-2)
--    c_tables에 staff·staff_salaries를 추가하는 것이 유일한 변경 —
--    나머지 로직·순서·검증은 20260817000000_budget_rules.sql과 동일하다.
--
--    위치: projects **앞**. members.staff_id가 staff를 참조하므로 정순 INSERT에서 staff가
--    members보다 먼저 있어야 하고, 역순 DELETE에서는 members가 먼저 지워져 set null이 걸리지
--    않는다. staff는 다른 어떤 테이블도 참조하지 않으므로 맨 앞이 안전하다.
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
-- schema_version 3 → 4 (§8.8, K-5) — 파일 머리말의 근거 참조.
-- app_settings_guard 트리거는 current_user = 'authenticated'일 때만 막으므로
-- 마이그레이션(postgres 역할)은 갱신할 수 있다 (N-10).
-- -----------------------------------------------------------------------------
update public.app_settings set schema_version = 4 where id = true;
