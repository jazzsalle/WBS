-- =============================================================================
-- Phase 24 협약 예산 버전 — agreement_versions·agreement_lines·agreement_participants·agreement_items 신설
--                          + 확정 잠금 가드 트리거 + RPC 3종 + 연쇄 삭제·복원 재정의 + schema_version 6
-- SOT §5.21~§5.24, §6.6 H-5a·H-7·H-9b, §8.3, §8.5 R-7, §8.7 K-9, §8.8, §9 Agreement Budget, §14.3 RLS-1
-- 계획서 docs/plans/phase-24-plan.md S-3·S-4·S-7·S-8·S-9·S-13·S-14·S-15·S-18
--
-- 규칙 요약 (20260925000000_staff_salary.sql과 같은 관례)
--  - N-4  : 공통 컬럼 id/created_at/updated_at/version/created_by/updated_by
--  - N-5  : updated_at·version은 set_updated_meta 트리거
--  - N-11 : not null 기본값 — string ''
--  - N-12 : enum은 text + check 제약
--  - RLS-1: RLS 활성 + to authenticated + is_approved() — 새 테이블 4종 모두 이 파일에서
--  - 금액은 전부 bigint(원 단위 정수, 절대 규칙 4). numeric은 참여율·개월·수량뿐이다
--
-- 제안 모드 데이터(budget_items·budget_details)와는 별개 구조다(D-3) — 이 파일은 그 테이블과
-- 그 RPC를 건드리지 않는다.
--
-- ─ 예외 규약 (commit_detail_import와 같다) ────────────────────────────────────
--   PostgREST는 raise exception을 전부 SQLSTATE P0001로 내려보내므로 리포지토리는 메시지로 가른다:
--     · /찾을 수 없습니다/ → NotFoundError   · 그 외 → RuleViolationError
--   그래서 "찾을 수 없습니다"는 대상이 없을 때만 쓴다.
--
-- schema_version 5 → 6 (§8.8): 테이블이 추가되어 백업 파일 형식이 바뀐다.
-- lib/constants.ts EXPECTED_SCHEMA_VERSION = 6과 같은 커밋이다. 옛 v5 백업은 K-5로 거부한다(K-9).
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. agreement_versions (§5.21)
-- -----------------------------------------------------------------------------
create table public.agreement_versions (
  id                uuid primary key default gen_random_uuid(),
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  version           bigint not null default 1,
  created_by        uuid references public.app_users (id) on delete set null,
  updated_by        uuid references public.app_users (id) on delete set null,

  project_id        uuid not null references public.projects (id) on delete cascade,

  -- 메타 7개 — 확정 후에도 고칠 수 있다(AV-2). 공문 번호·IRIS 승인일은 두지 않는다(U-2)
  kind              text not null
                      check (kind in ('selection', 'adjustment', 'final', 'amendment')),
  name              text not null default '',
  base_date         date,
  change_reason     text not null default '',
  notice_type       text check (notice_type in ('notice', 'approval')),
  iris_requested_at date,
  note              text not null default '',

  status            text not null default 'draft' check (status in ('draft', 'confirmed')),
  confirmed_at      timestamptz,
  -- 쌓인 순서. 지워도 다시 매기지 않는다(AV-4 — H-10 normalize 대상이 아니다)
  sort_order        integer not null,

  constraint agreement_versions_project_order_key unique (project_id, sort_order),
  -- status·confirmed_at 모두 비교 전에 null 판정으로 바꿔 boolean 3치 논리를 피한다
  constraint agreement_versions_confirmed_at_check check (
    (status = 'confirmed') = (confirmed_at is not null)
  )
);

-- AV-2: 작성 중 버전은 과제당 하나. RPC가 먼저 거부하고, 경합은 이 인덱스(23505)가 막는다
create unique index agreement_versions_one_draft_idx
  on public.agreement_versions (project_id) where status = 'draft';

-- -----------------------------------------------------------------------------
-- 2. agreement_lines (§5.22) — 연차 × 비목·세목 × 축 → 금액
-- -----------------------------------------------------------------------------
create table public.agreement_lines (
  id               uuid primary key default gen_random_uuid(),
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  version          bigint not null default 1,
  created_by       uuid references public.app_users (id) on delete set null,
  updated_by       uuid references public.app_users (id) on delete set null,

  version_id       uuid not null references public.agreement_versions (id) on delete cascade,
  -- H-5a: no action — cascade면 연차를 지운 조작만으로 확정 버전의 금액이 사라진다.
  -- delete_year가 먼저 세어 사람이 읽을 수 있는 메시지로 거부한다
  year_id          uuid not null references public.years (id),

  category         text not null
                     check (category in ('personnel', 'student_personnel', 'facility_equipment',
                                         'material', 'consignment', 'international', 'burden',
                                         'activity', 'promotion', 'allowance', 'indirect', 'other')),
  -- 부록 A.5 세목 코드 또는 'default'. 목록 검증은 액션 Zod가 한다 — DB가 목록을 알면
  -- 부록 A.5가 바뀔 때마다 마이그레이션이 필요해진다
  subcategory_code text not null,
  axis             text not null check (axis in ('cash', 'in_kind')),
  amount           bigint not null check (amount >= 0),

  constraint agreement_lines_cell_key unique (version_id, year_id, category, subcategory_code, axis)
);

create index agreement_lines_year_idx on public.agreement_lines (year_id);   -- H-5a 선검사

-- -----------------------------------------------------------------------------
-- 3. agreement_participants (§5.23)
-- -----------------------------------------------------------------------------
create table public.agreement_participants (
  id                 uuid primary key default gen_random_uuid(),
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  version            bigint not null default 1,
  created_by         uuid references public.app_users (id) on delete set null,
  updated_by         uuid references public.app_users (id) on delete set null,

  version_id         uuid not null references public.agreement_versions (id) on delete cascade,
  -- H-9b: no action — 사람을 지운 조작만으로 확정 버전의 참여인원 기록이 바뀌면 안 된다.
  -- null = 인력 미지정
  member_id          uuid references public.members (id),
  year_id            uuid not null references public.years (id),   -- H-5a
  participation_rate numeric not null check (participation_rate >= 0 and participation_rate <= 100),
  months             numeric not null check (months >= 0 and months <= 12),
  -- 버전 스냅샷 연봉. Member 연봉을 매번 읽으면 연봉을 고칠 때 확정 버전의 계산값이 바뀐다(AV-2)
  annual_salary      bigint check (annual_salary >= 0),
  personnel_cash     bigint not null default 0 check (personnel_cash >= 0),
  personnel_in_kind  bigint not null default 0 check (personnel_in_kind >= 0),
  role               text not null default ''
);

create index agreement_participants_version_idx on public.agreement_participants (version_id);
create index agreement_participants_member_idx on public.agreement_participants (member_id);  -- H-9b
create index agreement_participants_year_idx on public.agreement_participants (year_id);      -- H-5a

-- -----------------------------------------------------------------------------
-- 4. agreement_items (§5.24) — 테이블만. 화면은 Phase 26
-- -----------------------------------------------------------------------------
create table public.agreement_items (
  id          uuid primary key default gen_random_uuid(),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  version     bigint not null default 1,
  created_by  uuid references public.app_users (id) on delete set null,
  updated_by  uuid references public.app_users (id) on delete set null,

  version_id  uuid not null references public.agreement_versions (id) on delete cascade,
  year_id     uuid not null references public.years (id),   -- H-5a
  kind        text not null check (kind in ('equipment', 'material', 'outsourcing')),
  name        text not null default '',
  amount      bigint not null check (amount >= 0),   -- 장비는 부가세 포함 금액(D-8)
  quantity    numeric,
  -- AgreementEvidenceCheck[] (N-3 — 조인할 일이 없는 값 배열)
  evidence    jsonb not null default '[]'::jsonb check (jsonb_typeof(evidence) = 'array')
);

create index agreement_items_version_idx on public.agreement_items (version_id);
create index agreement_items_year_idx on public.agreement_items (year_id);   -- H-5a

-- -----------------------------------------------------------------------------
-- 5. 트리거 (N-5)
-- -----------------------------------------------------------------------------
create trigger set_updated_meta before update on public.agreement_versions
  for each row execute function public.set_updated_meta();
create trigger set_updated_meta before update on public.agreement_lines
  for each row execute function public.set_updated_meta();
create trigger set_updated_meta before update on public.agreement_participants
  for each row execute function public.set_updated_meta();
create trigger set_updated_meta before update on public.agreement_items
  for each row execute function public.set_updated_meta();

-- -----------------------------------------------------------------------------
-- 6. RLS (RLS-1, §14.3) — 기존 테이블과 완전히 같은 형태
-- -----------------------------------------------------------------------------
alter table public.agreement_versions enable row level security;
create policy "approved users full access" on public.agreement_versions
  for all to authenticated
  using (is_approved()) with check (is_approved());

alter table public.agreement_lines enable row level security;
create policy "approved users full access" on public.agreement_lines
  for all to authenticated
  using (is_approved()) with check (is_approved());

alter table public.agreement_participants enable row level security;
create policy "approved users full access" on public.agreement_participants
  for all to authenticated
  using (is_approved()) with check (is_approved());

alter table public.agreement_items enable row level security;
create policy "approved users full access" on public.agreement_items
  for all to authenticated
  using (is_approved()) with check (is_approved());

-- -----------------------------------------------------------------------------
-- 7. 확정 잠금 가드 (§9 Agreement Budget — 액션이 먼저 거부하고 이것은 최후 방어선이다)
--
--    ① 하위 3종 BEFORE INSERT/UPDATE agreement_child_guard
--       확정 버전 아래 쓰기 거부, version_id 변경 거부, year_id(참여인원은 member_id도)의 과제 =
--       버전의 과제. FK는 "존재하는 연차"만 보장할 뿐 과제 경계를 못 막는다(N-13).
--       DELETE는 막지 않는다 — 확정 버전 삭제의 cascade가 통과해야 한다(AV-4).
--       restore_backup은 삽입 동안 이 트리거를 끈다(K-9).
--    ② 버전 BEFORE UPDATE agreement_version_guard
--       project_id·sort_order 변경 거부, confirmed → draft는 과제의 마지막 버전만(AV-8).
-- -----------------------------------------------------------------------------
create or replace function public.agreement_child_guard()
returns trigger language plpgsql as $$
declare
  v_project_id uuid;
  v_status     text;
begin
  if tg_op = 'UPDATE' and new.version_id is distinct from old.version_id then
    raise exception '협약 예산 내용을 다른 버전으로 옮길 수 없습니다';
  end if;

  select project_id, status into v_project_id, v_status
    from agreement_versions where id = new.version_id;
  if v_project_id is null then
    raise exception '협약 예산 버전을 찾을 수 없습니다';
  end if;
  if v_status = 'confirmed' then
    raise exception '확정된 협약 예산 버전의 내용은 고칠 수 없습니다 — 확정을 취소하거나 새 버전을 만드세요';
  end if;

  if not exists (select 1 from years where id = new.year_id and project_id = v_project_id) then
    raise exception '이 과제에 속하지 않은 연차입니다';
  end if;
  -- plpgsql은 문장을 실행할 때 계획하므로, member_id가 없는 테이블에서는 이 블록에 들어가지 않는 한
  -- new.member_id 참조가 오류를 내지 않는다
  if tg_table_name = 'agreement_participants' then
    if new.member_id is not null
       and not exists (select 1 from members where id = new.member_id and project_id = v_project_id) then
      raise exception '이 과제에 속하지 않은 참여인력입니다';
    end if;
  end if;

  return new;
end; $$;

create trigger agreement_child_guard before insert or update on public.agreement_lines
  for each row execute function public.agreement_child_guard();
create trigger agreement_child_guard before insert or update on public.agreement_participants
  for each row execute function public.agreement_child_guard();
create trigger agreement_child_guard before insert or update on public.agreement_items
  for each row execute function public.agreement_child_guard();

create or replace function public.agreement_version_guard()
returns trigger language plpgsql as $$
begin
  if new.project_id is distinct from old.project_id then
    raise exception '협약 예산 버전의 과제는 바꿀 수 없습니다';
  end if;
  if new.sort_order is distinct from old.sort_order then
    raise exception '협약 예산 버전의 순서는 바꿀 수 없습니다';
  end if;
  -- AV-8: 뒤에 쌓인 버전이 있으면 그 버전의 복제 원본·기준 버전이 바뀐 셈이 되어 이력이 어긋난다
  if old.status = 'confirmed' and new.status = 'draft'
     and exists (select 1 from agreement_versions
                  where project_id = old.project_id and sort_order > old.sort_order) then
    raise exception '확정 취소는 과제의 마지막 버전만 할 수 있습니다 — 뒤에 쌓인 버전이 있습니다';
  end if;
  return new;
end; $$;

create trigger agreement_version_guard before update on public.agreement_versions
  for each row execute function public.agreement_version_guard();

-- -----------------------------------------------------------------------------
-- 8. Realtime publication (R-7) — §8.5 구독표 "연구비" 행. 참여인원·편성 항목은 화면이 없어 넣지 않는다
-- -----------------------------------------------------------------------------
alter publication supabase_realtime add table public.agreement_versions, public.agreement_lines;

-- -----------------------------------------------------------------------------
-- 9. create_agreement_version — 보내기(AV-6)·빈 버전 공용 (§9 Agreement Budget)
--    p_lines        : [{ "year_id", "category", "subcategory_code", "axis", "amount" }] (DB snake_case)
--    p_participants : [{ "member_id", "year_id", "participation_rate", "months", "annual_salary",
--                        "personnel_cash", "personnel_in_kind", "role" }]
--    빈 버전은 두 배열을 비워 부른다. 새 버전은 작성 중, sort_order = 과제 최댓값 + 1(첫 버전 1).
--    반환 : { versionId, order, lines, participants }
-- -----------------------------------------------------------------------------
create or replace function public.create_agreement_version(
  p_project_id   uuid,
  p_kind         text,
  p_name         text,
  p_lines        jsonb default '[]'::jsonb,
  p_participants jsonb default '[]'::jsonb
) returns jsonb language plpgsql security invoker as $$
declare
  v_lines        jsonb := coalesce(p_lines, '[]'::jsonb);
  v_participants jsonb := coalesce(p_participants, '[]'::jsonb);
  v_draft_name   text;
  v_order        integer;
  v_version_id   uuid;
  v_n_lines      integer;
  v_n_parts      integer;
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

  return jsonb_build_object(
    'versionId',    v_version_id,
    'order',        v_order,
    'lines',        v_n_lines,
    'participants', v_n_parts
  );
end; $$;

-- -----------------------------------------------------------------------------
-- 10. clone_agreement_version — 새 버전 = 원본 내용 통째 복제(AV-1)
--     금액 줄·참여인원(연봉 스냅샷 포함)·편성 항목(증빙 포함)을 새 id로 복사하고 원본은 바꾸지 않는다.
--     메타는 종류·이름만 받는다 — 기준일·변경 사유 등은 새 버전의 사건이라 원본 값을 옮기지 않는다.
--     반환 : { versionId, order, lines, participants, items }
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

  return jsonb_build_object(
    'versionId',    v_version_id,
    'order',        v_order,
    'lines',        v_n_lines,
    'participants', v_n_parts,
    'items',        v_n_items
  );
end; $$;

-- -----------------------------------------------------------------------------
-- 11. delete_agreement_versions — 전체 버전 삭제(AV-4). 그 과제의 버전만, 하위 3종은 cascade.
--     반환 : { deleted }
-- -----------------------------------------------------------------------------
create or replace function public.delete_agreement_versions(p_project_id uuid)
returns jsonb language plpgsql security invoker as $$
declare
  v_deleted integer;
begin
  if not exists (select 1 from projects where id = p_project_id) then
    raise exception '과제를 찾을 수 없습니다';
  end if;
  delete from agreement_versions where project_id = p_project_id;
  get diagnostics v_deleted = row_count;
  return jsonb_build_object('deleted', v_deleted);
end; $$;

-- -----------------------------------------------------------------------------
-- 12. delete_year 재정의 (H-5a) — 20260802000000_initial_schema.sql의 정의 전문에
--     협약 버전 선검사만 더했다. delete_stage(H-6)는 연차마다 이 함수를 부르므로 같은 이유로 거부된다.
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
-- 13. delete_project 재정의 (H-7) — 20260802000000_initial_schema.sql의 정의 전문에
--     협약 버전 선삭제만 더했다. 연차·인력의 no action FK(H-5a·H-9b)가 과제 삭제를 막지 않게 한다.
-- -----------------------------------------------------------------------------
create or replace function public.delete_project(p_project_id uuid)
returns void language plpgsql security invoker as $$
begin
  if not exists (select 1 from projects where id = p_project_id) then
    raise exception '과제를 찾을 수 없습니다';
  end if;
  delete from agreement_versions where project_id = p_project_id;  -- 하위 3종은 cascade
  update projects set pm_member_id = null, lead_org_id = null where id = p_project_id;
  update todos set project_id = null where project_id = p_project_id;  -- N-8 명시
  delete from projects where id = p_project_id;  -- 나머지는 cascade
end; $$;

-- -----------------------------------------------------------------------------
-- 14. count_member_references 재정의 (H-9b) — 20260814000000_budget_plan_rpcs.sql의 정의 전문에
--     agreement_participants 키만 더했다. 산출근거(H-9a)와 섞지 않고 따로 센다 — 화면이 별도 줄로 띄운다
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
    'budget_details',      (select count(*) from budget_details      where member_id       = p_member_id),
    -- H-9b: 이것도 삭제 차단 사유다. 산출근거와 다른 화면(수행 모드)에서 정리하므로 키를 나눈다
    'agreement_participants', (select count(*) from agreement_participants where member_id = p_member_id)
  );
end; $$;

-- -----------------------------------------------------------------------------
-- 15. delete_member 재정의 (H-9b) — 20260814000000_budget_plan_rpcs.sql의 정의 전문에
--     참여인원 거부만 더했다. 기존 8곳 정리·H-9a 거부는 그대로다.
-- -----------------------------------------------------------------------------
create or replace function public.delete_member(p_member_id uuid)
returns jsonb language plpgsql security invoker as $$
declare
  v_counts       jsonb;
  v_details      integer;
  v_participants integer;
  v_deleted      integer;
begin
  v_counts := count_member_references(p_member_id);  -- 대상이 없으면 여기서 실패한다

  -- H-9a: 사람을 지운 조작만으로 비목 총액이 줄어드는 것을 막는다
  v_details := (v_counts ->> 'budget_details')::integer;
  if v_details > 0 then
    raise exception '인건비 산출근거 %건이 이 인력을 참조합니다. 연구비 화면에서 먼저 정리하세요', v_details;
  end if;

  -- H-9b: 사람을 지운 조작만으로 확정 버전의 참여인원 기록이 바뀌는 것을 막는다
  v_participants := (v_counts ->> 'agreement_participants')::integer;
  if v_participants > 0 then
    raise exception '협약 예산 참여인원 %건이 이 인력을 참조합니다. 해당 협약 예산 버전을 먼저 삭제하세요', v_participants;
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
-- 16. restore_backup — 협약 예산 4종 추가 (§8.7 K-7·K-9, §8.8)
--     20260930000000_drop_budget_executions.sql의 정의 전문에서 바꾼 것은 c_tables의 4종 추가와
--     삽입 동안 agreement_child_guard 3개를 끄고 켜는 것뿐이다. deliverables·tech_targets 기본값 채움·
--     projects 순환 FK 2차 복원·app_settings 처리·grant/revoke는 그대로다.
--     위치: budget_rules 뒤 — 버전은 projects 뒤, 하위 3종은 버전·years·members 뒤라야 정순 INSERT가
--     FK를 만족하고, 역순 DELETE에서 하위 3종이 years·members보다 먼저 지워져 no action FK에 걸리지 않는다.
--     c_tables는 lib/db/backup.ts RESTORE_TABLES와 순서까지 일치해야 한다.
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
-- 17. schema_version 6 (§8.8) — lib/constants.ts EXPECTED_SCHEMA_VERSION과 같은 커밋
-- -----------------------------------------------------------------------------
update public.app_settings set schema_version = 6 where id = true;
