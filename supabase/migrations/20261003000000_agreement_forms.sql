-- =============================================================================
-- Phase 25 연차별 정부지원 현금 — years.gov_support_cash 컬럼 + agreement_gov_support 신설
--                              + create_agreement_version·clone_agreement_version·delete_year·
--                                restore_backup 재정의 + schema_version 7
-- SOT §5.5, §5.25, §6.6 H-5a·H-7, §8.5, §8.7 K-9, §8.8, §9 Agreement Budget, §14.3 RLS-1
-- 계획서 docs/plans/phase-25-plan.md U-4·S-3·S-4·S-15·S-18·S-20
--
-- 규칙 요약 (20261001000000_agreement_budget.sql과 같은 관례)
--  - N-4  : 공통 컬럼 id/created_at/updated_at/version/created_by/updated_by
--  - N-5  : updated_at·version은 set_updated_meta 트리거
--  - RLS-1: 새 테이블 agreement_gov_support는 이 파일에서 RLS 활성 + to authenticated + is_approved().
--           years의 새 컬럼 gov_support_cash는 기존 years 정책("approved users full access")이 덮는다 —
--           RLS는 행 단위라 컬럼 추가로 새 정책이 필요하지 않다
--  - 금액은 bigint(원 단위 정수, 절대 규칙 4)
--
-- 정부지원 현금만 저장한다. 기관부담 현금 = 그 연차 현금 합 − 정부지원 현금은 파생 값이다(S-3).
-- 미입력은 제안 쪽 null, 협약 쪽 "행 없음" — 0은 입력값이다.
--
-- Realtime publication에는 추가하지 않는다(S-18 — 연구비 화면 구독 4테이블 상한, §8.5).
-- delete_project는 재정의하지 않는다 — 버전을 먼저 지우므로(H-7) 새 테이블이 version_id cascade로 함께
-- 지워져 year_id no action FK가 과제 삭제를 막지 않는다.
--
-- schema_version 6 → 7 (§8.8): 테이블이 추가되어 백업 파일 형식이 바뀐다.
-- lib/constants.ts EXPECTED_SCHEMA_VERSION = 7과 같은 커밋이다. 옛 v6 백업은 K-5로 거부한다(K-9).
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. years.gov_support_cash (§5.5) — 제안 모드 연차별 정부지원 현금. null = 미입력
-- -----------------------------------------------------------------------------
alter table public.years
  add column gov_support_cash bigint
    constraint years_gov_support_cash_check check (gov_support_cash >= 0);

-- -----------------------------------------------------------------------------
-- 2. agreement_gov_support (§5.25) — 협약 버전 × 연차 → 정부지원 현금. 버전·연차당 0~1행
-- -----------------------------------------------------------------------------
create table public.agreement_gov_support (
  id          uuid primary key default gen_random_uuid(),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  version     bigint not null default 1,
  created_by  uuid references public.app_users (id) on delete set null,
  updated_by  uuid references public.app_users (id) on delete set null,

  version_id  uuid not null references public.agreement_versions (id) on delete cascade,
  -- H-5a: no action — cascade면 연차를 지운 조작만으로 확정 버전의 정부지원 현금이 사라진다.
  -- delete_year가 먼저 세어 사람이 읽을 수 있는 메시지로 거부한다
  year_id     uuid not null references public.years (id),
  gov_cash    bigint not null check (gov_cash >= 0),

  constraint agreement_gov_support_version_year_key unique (version_id, year_id)
);

create index agreement_gov_support_year_idx on public.agreement_gov_support (year_id);   -- H-5a 선검사

create trigger set_updated_meta before update on public.agreement_gov_support
  for each row execute function public.set_updated_meta();

alter table public.agreement_gov_support enable row level security;
create policy "approved users full access" on public.agreement_gov_support
  for all to authenticated
  using (is_approved()) with check (is_approved());

-- 확정 잠금·version_id 변경 금지·과제 경계(연차) — 함수 본문은 Phase 24 그대로다(S-4).
-- agreement_child_guard는 new.version_id·new.year_id만 읽고 member_id는 참여인원 분기 안에서만 읽는다.
-- DELETE는 막지 않는다(버전 삭제 cascade) — 확정 버전 행 삭제는 액션이 RULE로 거부한다
create trigger agreement_child_guard before insert or update on public.agreement_gov_support
  for each row execute function public.agreement_child_guard();

-- -----------------------------------------------------------------------------
-- 3. create_agreement_version 재정의 — p_gov_cash 추가 (§9 Agreement Budget, S-4)
--    20261001000000_agreement_budget.sql의 정의 전문에 p_gov_cash 검증·삽입만 더했다.
--    옛 5인자 시그니처를 먼저 drop한다 — 남겨 두면 기본값 인자 때문에 5인자 호출이 두 함수에
--    모두 맞아 오버로드가 모호해진다.
--    p_lines        : [{ "year_id", "category", "subcategory_code", "axis", "amount" }] (DB snake_case)
--    p_participants : [{ "member_id", "year_id", "participation_rate", "months", "annual_salary",
--                        "personnel_cash", "personnel_in_kind", "role" }]
--    p_gov_cash     : { "<연차 id>": 원 } — 0 이상 정수. 키가 없는 연차는 행 없음(미입력)
--    빈 버전은 배열 둘을 비우고 p_gov_cash를 생략해 부른다.
--    반환 : { versionId, order, lines, participants, govSupport }
-- -----------------------------------------------------------------------------
drop function public.create_agreement_version(uuid, text, text, jsonb, jsonb);

create or replace function public.create_agreement_version(
  p_project_id   uuid,
  p_kind         text,
  p_name         text,
  p_lines        jsonb default '[]'::jsonb,
  p_participants jsonb default '[]'::jsonb,
  p_gov_cash     jsonb default '{}'::jsonb
) returns jsonb language plpgsql security invoker as $$
declare
  v_lines        jsonb := coalesce(p_lines, '[]'::jsonb);
  v_participants jsonb := coalesce(p_participants, '[]'::jsonb);
  v_gov_cash     jsonb := coalesce(p_gov_cash, '{}'::jsonb);
  v_draft_name   text;
  v_order        integer;
  v_version_id   uuid;
  v_n_lines      integer;
  v_n_parts      integer;
  v_n_gov        integer;
begin
  if p_project_id is null then
    raise exception '버전을 만들 과제를 지정해야 합니다';
  end if;
  if not exists (select 1 from projects where id = p_project_id) then
    raise exception '과제를 찾을 수 없습니다';
  end if;
  if jsonb_typeof(v_lines) <> 'array' then
    raise exception '금액 줄 목록이 배열이 아닙니다';
  end if;
  if jsonb_typeof(v_participants) <> 'array' then
    raise exception '참여인원 목록이 배열이 아닙니다';
  end if;
  if jsonb_typeof(v_gov_cash) <> 'object' then
    raise exception '정부지원 현금이 "연차 → 금액" 객체가 아닙니다';
  end if;
  -- 0 이상 정수만. 문자열·소수·음수를 bigint 캐스트에 맡기면 반올림되거나 알아보기 힘든 오류가 된다
  if exists (
    select 1 from jsonb_each(v_gov_cash) g
     where jsonb_typeof(g.value) <> 'number'
        or g.value::text !~ '^[0-9]+$'
  ) then
    raise exception '정부지원 현금은 0 이상의 원 단위 정수여야 합니다';
  end if;
  if exists (
    select 1 from jsonb_object_keys(v_gov_cash) k
     where k !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  ) then
    raise exception '이 과제에 속하지 않은 연차입니다';
  end if;

  -- AV-2: 작성 중 버전은 과제당 하나
  select name into v_draft_name
    from agreement_versions where project_id = p_project_id and status = 'draft';
  if found then
    raise exception '작성 중 버전 "%"이 있습니다 — 확정하거나 삭제한 뒤 만드세요', v_draft_name;
  end if;

  -- 과제 경계 (N-13): 가드 트리거도 막지만, 행마다 같은 메시지를 내기 전에 한 번에 거부한다
  if exists (
    select 1 from jsonb_to_recordset(v_lines) as l("year_id" uuid)
     where l."year_id" is null
        or not exists (select 1 from years y where y.id = l."year_id" and y.project_id = p_project_id)
  ) or exists (
    select 1 from jsonb_to_recordset(v_participants) as p("year_id" uuid)
     where p."year_id" is null
        or not exists (select 1 from years y where y.id = p."year_id" and y.project_id = p_project_id)
  ) then
    raise exception '이 과제에 속하지 않은 연차입니다';
  end if;
  if exists (
    select 1 from jsonb_to_recordset(v_participants) as p("member_id" uuid)
     where p."member_id" is not null
       and not exists (select 1 from members m where m.id = p."member_id" and m.project_id = p_project_id)
  ) then
    raise exception '이 과제에 속하지 않은 참여인력입니다';
  end if;

  -- 같은 칸이 두 번 오면 unique 위반(23505)이 "작성 중 버전 경합"과 구별되지 않는다 — 먼저 밝힌다
  if exists (
    select 1 from jsonb_to_recordset(v_lines)
                    as l("year_id" uuid, "category" text, "subcategory_code" text, "axis" text)
     group by l."year_id", l."category", l."subcategory_code", l."axis"
    having count(*) > 1
  ) then
    raise exception '같은 칸(연차·비목·세목·축)의 금액 줄이 두 번 있습니다';
  end if;

  select coalesce(max(sort_order), 0) + 1 into v_order
    from agreement_versions where project_id = p_project_id;

  insert into agreement_versions (project_id, kind, name, status, sort_order, created_by, updated_by)
  values (p_project_id, p_kind, coalesce(p_name, ''), 'draft', v_order, auth.uid(), auth.uid())
  returning id into v_version_id;

  insert into agreement_lines (version_id, year_id, category, subcategory_code, axis, amount,
                               created_by, updated_by)
  select v_version_id, l."year_id", l."category", l."subcategory_code", l."axis", l."amount",
         auth.uid(), auth.uid()
    from jsonb_to_recordset(v_lines)
           as l("year_id" uuid, "category" text, "subcategory_code" text, "axis" text, "amount" bigint);
  get diagnostics v_n_lines = row_count;

  insert into agreement_participants (version_id, member_id, year_id, participation_rate, months,
                                      annual_salary, personnel_cash, personnel_in_kind, role,
                                      created_by, updated_by)
  select v_version_id, p."member_id", p."year_id", p."participation_rate", p."months",
         p."annual_salary", coalesce(p."personnel_cash", 0), coalesce(p."personnel_in_kind", 0),
         coalesce(p."role", ''), auth.uid(), auth.uid()
    from jsonb_to_recordset(v_participants)
           as p("member_id" uuid, "year_id" uuid, "participation_rate" numeric, "months" numeric,
                "annual_salary" bigint, "personnel_cash" bigint, "personnel_in_kind" bigint,
                "role" text);
  get diagnostics v_n_parts = row_count;

  -- 연차 경계는 agreement_child_guard가 막는다(S-4)
  insert into agreement_gov_support (version_id, year_id, gov_cash, created_by, updated_by)
  select v_version_id, g.key::uuid, (g.value::text)::bigint, auth.uid(), auth.uid()
    from jsonb_each(v_gov_cash) g;
  get diagnostics v_n_gov = row_count;

  return jsonb_build_object(
    'versionId',    v_version_id,
    'order',        v_order,
    'lines',        v_n_lines,
    'participants', v_n_parts,
    'govSupport',   v_n_gov
  );
end; $$;

-- drop으로 옛 grant가 사라졌으므로 다시 준다 — 20260925000000_staff_salary.sql의 apply_salary_change와
-- 같은 규약(authenticated만)
revoke execute on function public.create_agreement_version(uuid, text, text, jsonb, jsonb, jsonb) from public, anon;
grant execute on function public.create_agreement_version(uuid, text, text, jsonb, jsonb, jsonb) to authenticated;

-- -----------------------------------------------------------------------------
-- 4. clone_agreement_version 재정의 — 정부지원 현금도 복사 (AV-1, S-4)
--    20261001000000_agreement_budget.sql의 정의 전문에 agreement_gov_support 복사만 더했다.
--    반환 : { versionId, order, lines, participants, items, govSupport }
-- -----------------------------------------------------------------------------
create or replace function public.clone_agreement_version(
  p_source_id uuid,
  p_kind      text,
  p_name      text
) returns jsonb language plpgsql security invoker as $$
declare
  v_project_id uuid;
  v_draft_name text;
  v_order      integer;
  v_version_id uuid;
  v_n_lines    integer;
  v_n_parts    integer;
  v_n_items    integer;
  v_n_gov      integer;
begin
  select project_id into v_project_id from agreement_versions where id = p_source_id;
  if v_project_id is null then
    raise exception '복제할 협약 예산 버전을 찾을 수 없습니다';
  end if;

  select name into v_draft_name
    from agreement_versions where project_id = v_project_id and status = 'draft';
  if found then
    raise exception '작성 중 버전 "%"이 있습니다 — 확정하거나 삭제한 뒤 만드세요', v_draft_name;
  end if;

  select coalesce(max(sort_order), 0) + 1 into v_order
    from agreement_versions where project_id = v_project_id;

  insert into agreement_versions (project_id, kind, name, status, sort_order, created_by, updated_by)
  values (v_project_id, p_kind, coalesce(p_name, ''), 'draft', v_order, auth.uid(), auth.uid())
  returning id into v_version_id;

  insert into agreement_lines (version_id, year_id, category, subcategory_code, axis, amount,
                               created_by, updated_by)
  select v_version_id, year_id, category, subcategory_code, axis, amount, auth.uid(), auth.uid()
    from agreement_lines where version_id = p_source_id;
  get diagnostics v_n_lines = row_count;

  insert into agreement_participants (version_id, member_id, year_id, participation_rate, months,
                                      annual_salary, personnel_cash, personnel_in_kind, role,
                                      created_by, updated_by)
  select v_version_id, member_id, year_id, participation_rate, months,
         annual_salary, personnel_cash, personnel_in_kind, role, auth.uid(), auth.uid()
    from agreement_participants where version_id = p_source_id;
  get diagnostics v_n_parts = row_count;

  insert into agreement_items (version_id, year_id, kind, name, amount, quantity, evidence,
                               created_by, updated_by)
  select v_version_id, year_id, kind, name, amount, quantity, evidence, auth.uid(), auth.uid()
    from agreement_items where version_id = p_source_id;
  get diagnostics v_n_items = row_count;

  insert into agreement_gov_support (version_id, year_id, gov_cash, created_by, updated_by)
  select v_version_id, year_id, gov_cash, auth.uid(), auth.uid()
    from agreement_gov_support where version_id = p_source_id;
  get diagnostics v_n_gov = row_count;

  return jsonb_build_object(
    'versionId',    v_version_id,
    'order',        v_order,
    'lines',        v_n_lines,
    'participants', v_n_parts,
    'items',        v_n_items,
    'govSupport',   v_n_gov
  );
end; $$;

-- -----------------------------------------------------------------------------
-- 5. delete_year 재정의 (H-5a) — 20261001000000_agreement_budget.sql의 정의 전문에
--    선검사 union에 agreement_gov_support만 더했다. delete_stage(H-6)는 연차마다 이 함수를 부른다.
-- -----------------------------------------------------------------------------
create or replace function public.delete_year(p_year_id uuid)
returns void language plpgsql security invoker as $$
declare
  v_versions integer;
begin
  -- H-5a: no action FK가 막기 전에, 무엇을 먼저 지워야 하는지 알려 주고 거부한다 (SA-4)
  select count(distinct s.version_id) into v_versions
    from (
      select version_id from agreement_lines        where year_id = p_year_id
      union all
      select version_id from agreement_participants where year_id = p_year_id
      union all
      select version_id from agreement_items        where year_id = p_year_id
      union all
      select version_id from agreement_gov_support  where year_id = p_year_id
    ) s;
  if v_versions > 0 then
    raise exception '협약 예산 버전 %개가 이 연차를 씁니다 — 해당 버전을 먼저 삭제하세요', v_versions;
  end if;

  -- set null 대상 (N-8): FK on delete set null로도 처리되지만 RPC에서 명시해 의도를 남긴다
  update milestones set year_id = null where year_id = p_year_id;
  update risks      set year_id = null where year_id = p_year_id;
  update notes      set year_id = null where year_id = p_year_id;
  update deliverable_achievements set year_id = null where year_id = p_year_id;
  update tech_target_records      set year_id = null where year_id = p_year_id;
  -- jsonb 맵의 고아 키 제거 (N-13)
  update deliverables set target_by_year = target_by_year - p_year_id::text
   where target_by_year ? p_year_id::text;
  update tech_targets set target_by_year = target_by_year - p_year_id::text
   where target_by_year ? p_year_id::text;
  delete from years where id = p_year_id;   -- tasks, budget_items는 cascade
end; $$;

-- -----------------------------------------------------------------------------
-- 6. restore_backup — agreement_gov_support 추가 (§8.7 K-7·K-9, §8.8)
--    20261001000000_agreement_budget.sql의 정의 전문에서 바꾼 것은 c_tables의 agreement_items 뒤
--    agreement_gov_support 추가와, 삽입 동안 그 테이블의 agreement_child_guard도 끄고 켜는 것뿐이다.
--    deliverables·tech_targets 기본값 채움·projects 순환 FK 2차 복원·app_settings 처리·grant/revoke는 그대로다.
--    years.gov_support_cash는 nullable 컬럼이라 행 jsonb 그대로 실린다.
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
    'budget_items', 'budget_details', 'budget_rules',
    'agreement_versions', 'agreement_lines', 'agreement_participants', 'agreement_items',
    'agreement_gov_support',
    'risks', 'notes', 'todos',
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

  -- K-9: 확정 버전 아래 줄을 정순으로 넣는 것이 복원의 정상 동작이다 — 잠금 가드를 잠시 끈다.
  -- (ALTER TABLE은 트랜잭션에 묶이므로 실패 시 함께 롤백된다.)
  alter table public.agreement_lines        disable trigger agreement_child_guard;
  alter table public.agreement_participants disable trigger agreement_child_guard;
  alter table public.agreement_items        disable trigger agreement_child_guard;
  alter table public.agreement_gov_support  disable trigger agreement_child_guard;

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

  alter table public.agreement_lines        enable trigger agreement_child_guard;
  alter table public.agreement_participants enable trigger agreement_child_guard;
  alter table public.agreement_items        enable trigger agreement_child_guard;
  alter table public.agreement_gov_support  enable trigger agreement_child_guard;

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
-- 7. schema_version 7 (§8.8) — lib/constants.ts EXPECTED_SCHEMA_VERSION과 같은 커밋
-- -----------------------------------------------------------------------------
update public.app_settings set schema_version = 7 where id = true;
