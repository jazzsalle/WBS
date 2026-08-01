-- =============================================================================
-- Phase 0 최초 스키마 (schema_version = 1)
-- SOT §5.1~5.16, §6.6, §8.3, §8.5 R-7, §14.2, §14.3
--
-- 규칙 요약
--  - N-4  : 공통 컬럼 id/created_at/updated_at/version/created_by/updated_by
--           (예외: app_users, app_settings(N-10), 조인 테이블)
--  - N-6  : 부모-자식 FK는 cascade, N-8 목록 17건만 set null
--  - N-9  : 순서 컬럼은 sort_order (order는 SQL 예약어)
--  - N-11 : not null 기본값 — string '', number 0, boolean false
--  - N-12 : enum은 text + check 제약
--  - RLS-1: 전 테이블 RLS. 정책은 to authenticated + is_approved()
--  - X-2  : RPC는 security invoker. 예외는 handle_new_user/approve_user/deactivate_user
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. app_users (§14.2) — created_by FK의 참조 대상이므로 가장 먼저 만든다.
--    member_id FK는 members 생성 뒤 alter로 건다 (순환 참조).
-- -----------------------------------------------------------------------------
create table public.app_users (
  id           uuid primary key references auth.users (id) on delete cascade,
  email        text not null default '',
  name         text not null default '',
  member_id    uuid,                      -- FK는 members 생성 후 추가
  active       boolean not null default false,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  last_seen_at timestamptz not null default now()
);

-- -----------------------------------------------------------------------------
-- 2. projects (§5.3) — pm_member_id/lead_org_id FK는 순환 참조라 뒤에 건다.
-- -----------------------------------------------------------------------------
create table public.projects (
  id            uuid primary key default gen_random_uuid(),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  version       bigint not null default 1,
  created_by    uuid references public.app_users (id) on delete set null,
  updated_by    uuid references public.app_users (id) on delete set null,

  name          text not null default '',
  project_no    text not null default '',
  ministry      text not null default '',
  agency        text not null default '',
  program_name  text not null default '',
  description   text not null default '',
  status        text not null default 'planning'
                  check (status in ('planning', 'active', 'on_hold', 'done', 'dropped')),
  color         text not null default '',
  contract_start_date date,
  contract_end_date   date,
  total_budget  bigint,                   -- 금액은 전부 원 단위 정수
  gov_budget    bigint,
  own_budget    bigint,
  pm_member_id  uuid,                     -- FK는 members 생성 후 추가 (N-8 set null)
  lead_org_id   uuid,                     -- FK는 organizations 생성 후 추가 (N-8 set null)
  archived      boolean not null default false,
  sort_order    integer not null default 0
);

-- -----------------------------------------------------------------------------
-- 3. organizations (§5.10)
-- -----------------------------------------------------------------------------
create table public.organizations (
  id             uuid primary key default gen_random_uuid(),
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  version        bigint not null default 1,
  created_by     uuid references public.app_users (id) on delete set null,
  updated_by     uuid references public.app_users (id) on delete set null,

  project_id     uuid not null references public.projects (id) on delete cascade,
  name           text not null default '',
  role           text not null check (role in ('lead', 'joint', 'consign')),
  type           text not null default '',
  representative text not null default '',
  contact        text not null default '',
  responsibility text not null default '',
  budget         bigint,
  sort_order     integer not null default 0
);

-- -----------------------------------------------------------------------------
-- 4. members (§5.11)
-- -----------------------------------------------------------------------------
create table public.members (
  id         uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  version    bigint not null default 1,
  created_by uuid references public.app_users (id) on delete set null,
  updated_by uuid references public.app_users (id) on delete set null,

  project_id uuid not null references public.projects (id) on delete cascade,
  org_id     uuid references public.organizations (id) on delete set null,  -- N-8
  name       text not null default '',
  role       text not null check (role in ('pm', 'pl', 'researcher', 'staff')),
  position   text not null default '',
  field      text not null default '',
  email      text not null default '',
  phone      text not null default '',
  active     boolean not null default false,   -- N-11. 생성 액션이 true로 채운다
  sort_order integer not null default 0
);

-- 순환 FK 해소: projects ↔ members/organizations, app_users → members
alter table public.projects
  add constraint projects_pm_member_id_fkey
    foreign key (pm_member_id) references public.members (id) on delete set null,      -- N-8
  add constraint projects_lead_org_id_fkey
    foreign key (lead_org_id) references public.organizations (id) on delete set null; -- N-8
alter table public.app_users
  add constraint app_users_member_id_fkey
    foreign key (member_id) references public.members (id) on delete set null;         -- N-8

-- -----------------------------------------------------------------------------
-- 5. stages (§5.4)
-- -----------------------------------------------------------------------------
create table public.stages (
  id         uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  version    bigint not null default 1,
  created_by uuid references public.app_users (id) on delete set null,
  updated_by uuid references public.app_users (id) on delete set null,

  project_id uuid not null references public.projects (id) on delete cascade,
  sort_order integer not null default 0,
  name       text not null default '',
  goal       text not null default '',
  start_date date,
  end_date   date,
  budget     bigint
);

-- -----------------------------------------------------------------------------
-- 6. years (§5.5) — sort_order는 과제 전체 기준 유일.
--    create_year의 +1 시프트가 일시 충돌을 내므로 deferrable로 만든다.
-- -----------------------------------------------------------------------------
create table public.years (
  id         uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  version    bigint not null default 1,
  created_by uuid references public.app_users (id) on delete set null,
  updated_by uuid references public.app_users (id) on delete set null,

  project_id uuid not null references public.projects (id) on delete cascade,
  stage_id   uuid not null references public.stages (id) on delete cascade,
  sort_order integer not null default 0,
  name       text not null default '',
  goal       text not null default '',
  start_date date,
  end_date   date,
  budget     bigint,
  status     text not null default 'planned'
               check (status in ('planned', 'active', 'evaluating', 'closed')),

  constraint years_project_order_key unique (project_id, sort_order)
    deferrable initially deferred
);

-- -----------------------------------------------------------------------------
-- 7. tasks (§5.6)
-- -----------------------------------------------------------------------------
create table public.tasks (
  id              uuid primary key default gen_random_uuid(),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  version         bigint not null default 1,
  created_by      uuid references public.app_users (id) on delete set null,
  updated_by      uuid references public.app_users (id) on delete set null,

  project_id      uuid not null references public.projects (id) on delete cascade,
  year_id         uuid not null references public.years (id) on delete cascade,
  parent_id       uuid references public.tasks (id) on delete cascade,   -- H-4 자손 연쇄 삭제
  sort_order      integer not null default 0,
  title           text not null default '',
  description     text not null default '',
  status          text not null default 'todo'
                    check (status in ('todo', 'in_progress', 'done', 'blocked')),
  progress_mode   text not null default 'manual'
                    check (progress_mode in ('manual', 'auto')),
  manual_progress integer not null default 0
                    check (manual_progress between 0 and 100),
  estimated_hours numeric,
  actual_hours    numeric,
  start_date      date,
  due_date        date,
  importance      smallint not null default 3 check (importance between 1 and 5),
  urgency_mode    text not null default 'auto' check (urgency_mode in ('auto', 'manual')),
  urgency_manual  smallint not null default 3 check (urgency_manual between 1 and 5),
  owner_member_id uuid references public.members (id) on delete set null,       -- N-8
  org_id          uuid references public.organizations (id) on delete set null, -- N-8
  tags            jsonb not null default '[]'
);

-- -----------------------------------------------------------------------------
-- 8. milestones (§5.7)
-- -----------------------------------------------------------------------------
create table public.milestones (
  id              uuid primary key default gen_random_uuid(),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  version         bigint not null default 1,
  created_by      uuid references public.app_users (id) on delete set null,
  updated_by      uuid references public.app_users (id) on delete set null,

  project_id      uuid not null references public.projects (id) on delete cascade,
  year_id         uuid references public.years (id) on delete set null,   -- N-8
  type            text not null
                    check (type in ('annual_eval', 'stage_eval', 'final_eval',
                                    'progress_check', 'report', 'contract', 'demo', 'custom')),
  title           text not null default '',
  date            date not null,
  status          text not null default 'planned'
                    check (status in ('planned', 'preparing', 'done', 'delayed', 'cancelled')),
  owner_member_id uuid references public.members (id) on delete set null, -- N-8
  description     text not null default '',
  result_note     text not null default ''
);

-- -----------------------------------------------------------------------------
-- 9. deliverables (§5.8)
-- -----------------------------------------------------------------------------
create table public.deliverables (
  id             uuid primary key default gen_random_uuid(),
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  version        bigint not null default 1,
  created_by     uuid references public.app_users (id) on delete set null,
  updated_by     uuid references public.app_users (id) on delete set null,

  project_id     uuid not null references public.projects (id) on delete cascade,
  type           text not null
                   check (type in ('paper_sci', 'paper_domestic', 'conference',
                                   'patent_dom_apply', 'patent_dom_reg',
                                   'patent_intl_apply', 'patent_intl_reg',
                                   'sw_registration', 'tech_transfer', 'commercialization',
                                   'standard', 'hr_training', 'other')),
  name           text not null default '',
  unit           text not null default '건',
  target_total   integer not null default 0,
  target_by_year jsonb not null default '{}',   -- { yearId: 목표건수 } (N-3, N-13)
  org_id         uuid references public.organizations (id) on delete set null,
  note           text not null default '',
  sort_order     integer not null default 0
);

-- -----------------------------------------------------------------------------
-- 10. deliverable_achievements (§5.8, N-1)
-- -----------------------------------------------------------------------------
create table public.deliverable_achievements (
  id             uuid primary key default gen_random_uuid(),
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  version        bigint not null default 1,
  created_by     uuid references public.app_users (id) on delete set null,
  updated_by     uuid references public.app_users (id) on delete set null,

  deliverable_id uuid not null references public.deliverables (id) on delete cascade,
  title          text not null default '',
  date           date not null,
  year_id        uuid references public.years (id) on delete set null,   -- N-8: 실적은 남긴다
  org_id         uuid references public.organizations (id) on delete set null,
  evidence_url   text not null default '',
  note           text not null default ''
);

-- -----------------------------------------------------------------------------
-- 11. tech_targets (§5.9)
-- -----------------------------------------------------------------------------
create table public.tech_targets (
  id                  uuid primary key default gen_random_uuid(),
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  version             bigint not null default 1,
  created_by          uuid references public.app_users (id) on delete set null,
  updated_by          uuid references public.app_users (id) on delete set null,

  project_id          uuid not null references public.projects (id) on delete cascade,
  name                text not null default '',
  unit                text not null default '',
  direction           text not null default 'higher_better'
                        check (direction in ('higher_better', 'lower_better', 'target_exact')),
  weight              numeric not null default 0,
  target_value        numeric not null default 0,
  target_by_year      jsonb not null default '{}',   -- { yearId: 연차 목표치 }
  baseline_domestic   numeric,
  world_best          numeric,
  world_best_holder   text not null default '',
  measure_method      text not null default 'self'
                        check (measure_method in ('self', 'certified_lab', 'expert_review',
                                                  'customer', 'other')),
  measure_description text not null default '',
  org_id              uuid references public.organizations (id) on delete set null,
  sort_order          integer not null default 0
);

-- -----------------------------------------------------------------------------
-- 12. tech_target_records (§5.9, N-1)
-- -----------------------------------------------------------------------------
create table public.tech_target_records (
  id             uuid primary key default gen_random_uuid(),
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  version        bigint not null default 1,
  created_by     uuid references public.app_users (id) on delete set null,
  updated_by     uuid references public.app_users (id) on delete set null,

  tech_target_id uuid not null references public.tech_targets (id) on delete cascade,
  value          numeric not null default 0,
  date           date not null,
  year_id        uuid references public.years (id) on delete set null,   -- N-8: 측정 이력은 남긴다
  method         text not null default 'self'
                   check (method in ('self', 'certified_lab', 'expert_review',
                                     'customer', 'other')),
  evaluator      text not null default '',
  evidence_url   text not null default '',
  note           text not null default ''
);

-- -----------------------------------------------------------------------------
-- 13. budget_items (§5.12)
-- -----------------------------------------------------------------------------
create table public.budget_items (
  id             uuid primary key default gen_random_uuid(),
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  version        bigint not null default 1,
  created_by     uuid references public.app_users (id) on delete set null,
  updated_by     uuid references public.app_users (id) on delete set null,

  project_id     uuid not null references public.projects (id) on delete cascade,
  year_id        uuid not null references public.years (id) on delete cascade,  -- H-5
  category       text not null
                   check (category in ('personnel', 'student_personnel', 'facility_equipment',
                                       'material', 'consignment', 'international', 'burden',
                                       'activity', 'promotion', 'allowance', 'indirect', 'other')),
  planned_amount bigint not null default 0,
  cash_amount    bigint,
  in_kind_amount bigint,
  note           text not null default '',

  constraint budget_items_year_category_key unique (year_id, category)
);

-- -----------------------------------------------------------------------------
-- 14. budget_executions (§5.12, N-1)
-- -----------------------------------------------------------------------------
create table public.budget_executions (
  id             uuid primary key default gen_random_uuid(),
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  version        bigint not null default 1,
  created_by     uuid references public.app_users (id) on delete set null,
  updated_by     uuid references public.app_users (id) on delete set null,

  budget_item_id uuid not null references public.budget_items (id) on delete cascade,
  date           date not null,
  amount         bigint not null default 0,
  description    text not null default '',
  note           text not null default ''
);

-- -----------------------------------------------------------------------------
-- 15. risks (§5.13)
-- -----------------------------------------------------------------------------
create table public.risks (
  id              uuid primary key default gen_random_uuid(),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  version         bigint not null default 1,
  created_by      uuid references public.app_users (id) on delete set null,
  updated_by      uuid references public.app_users (id) on delete set null,

  project_id      uuid not null references public.projects (id) on delete cascade,
  year_id         uuid references public.years (id) on delete set null,   -- N-8
  task_id         uuid references public.tasks (id) on delete set null,   -- N-8
  title           text not null default '',
  category        text not null
                    check (category in ('technical', 'schedule', 'budget', 'resource',
                                        'external', 'other')),
  description     text not null default '',
  probability     smallint not null default 3 check (probability between 1 and 5),
  impact          smallint not null default 3 check (impact between 1 and 5),
  strategy        text not null
                    check (strategy in ('mitigate', 'avoid', 'transfer', 'accept')),
  response        text not null default '',
  contingency     text not null default '',
  owner_member_id uuid references public.members (id) on delete set null, -- N-8
  due_date        date,
  status          text not null default 'identified'
                    check (status in ('identified', 'monitoring', 'occurred',
                                      'resolved', 'closed')),
  sort_order      integer not null default 0
);

-- -----------------------------------------------------------------------------
-- 16. notes (§5.14)
-- -----------------------------------------------------------------------------
create table public.notes (
  id           uuid primary key default gen_random_uuid(),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  version      bigint not null default 1,
  created_by   uuid references public.app_users (id) on delete set null,
  updated_by   uuid references public.app_users (id) on delete set null,

  project_id   uuid references public.projects (id) on delete cascade,     -- null = 개인 노트
  year_id      uuid references public.years (id) on delete set null,       -- N-8: 회의록은 남긴다
  task_id      uuid references public.tasks (id) on delete set null,       -- N-8
  milestone_id uuid references public.milestones (id) on delete set null,  -- N-8
  type         text not null
                 check (type in ('meeting', 'tech', 'issue', 'idea', 'report_draft', 'other')),
  title        text not null default '',
  body         text not null default '',
  date         date not null default current_date,   -- §5.14 기본 오늘
  tags         jsonb not null default '[]',
  pinned       boolean not null default false
);

-- -----------------------------------------------------------------------------
-- 17. todos (§5.15)
-- -----------------------------------------------------------------------------
create table public.todos (
  id           uuid primary key default gen_random_uuid(),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  version      bigint not null default 1,
  created_by   uuid references public.app_users (id) on delete set null,
  updated_by   uuid references public.app_users (id) on delete set null,

  title        text not null default '',
  done         boolean not null default false,
  project_id   uuid references public.projects (id) on delete set null,   -- N-8: H-7
  due_date     date,
  priority     text not null default 'normal' check (priority in ('low', 'normal', 'high')),
  sort_order   integer not null default 0,
  completed_at timestamptz
);

-- -----------------------------------------------------------------------------
-- 18. app_settings (§5.16, N-10) — 단일 행을 DB가 강제한다.
--     N-4 예외지만 updateSettings의 낙관적 잠금(O-1)과 self-echo 필터(R-6)를 위해
--     version/updated_at/updated_by는 둔다.
-- -----------------------------------------------------------------------------
create table public.app_settings (
  id                    boolean primary key default true check (id),
  due_soon_days         integer not null default 7,
  milestone_alert_days  integer not null default 30,
  week_starts_on        smallint not null default 1 check (week_starts_on in (0, 1)),
  default_gantt_scale   text not null default 'week'
                          check (default_gantt_scale in ('day', 'week', 'month')),
  currency_unit         text not null default '천원'
                          check (currency_unit in ('원', '천원', '백만원')),
  progress_weight_basis text not null default 'budget'
                          check (progress_weight_basis in ('budget', 'equal')),
  schema_version        bigint not null default 1,   -- 마이그레이션만 갱신 (트리거 강제)
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  version               bigint not null default 1,
  updated_by            uuid references public.app_users (id) on delete set null
);

-- -----------------------------------------------------------------------------
-- 19. import_profiles (§5.12.1)
-- -----------------------------------------------------------------------------
create table public.import_profiles (
  id                   uuid primary key default gen_random_uuid(),
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  version              bigint not null default 1,
  created_by           uuid references public.app_users (id) on delete set null,
  updated_by           uuid references public.app_users (id) on delete set null,

  name                 text not null default '',
  kind                 text not null default 'budget_plan' check (kind in ('budget_plan')),
  ministry             text,
  project_id           uuid references public.projects (id) on delete cascade,  -- null = 전역
  sheet_name           text,
  header_row           integer not null default 0,
  data_start_row       integer not null default 0,
  orientation          text not null default 'row' check (orientation in ('row', 'column')),
  label_columns        jsonb not null default '[]',
  year_column_mappings jsonb not null default '[]',
  category_aliases     jsonb not null default '{}',
  amount_unit          integer not null default 1 check (amount_unit in (1, 1000, 1000000)),
  skip_row_patterns    jsonb not null default '[]',
  last_used_at         timestamptz,
  use_count            integer not null default 0
);

-- -----------------------------------------------------------------------------
-- 20. import_snapshots (I-17) — 임포트 반영 전 계획액 스냅샷
-- -----------------------------------------------------------------------------
create table public.import_snapshots (
  id         uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  version    bigint not null default 1,
  created_by uuid references public.app_users (id) on delete set null,
  updated_by uuid references public.app_users (id) on delete set null,

  project_id uuid not null references public.projects (id) on delete cascade,
  snapshot   jsonb not null default '{}'   -- 반영 직전 연차×비목 계획액 (commit_import RPC가 기록)
);

-- -----------------------------------------------------------------------------
-- 21. 조인 테이블 5종 (N-2) — id·타임스탬프만 (N-4 예외)
-- -----------------------------------------------------------------------------
create table public.task_members (
  id         uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  task_id    uuid not null references public.tasks (id) on delete cascade,
  member_id  uuid not null references public.members (id) on delete cascade,  -- H-9
  constraint task_members_key unique (task_id, member_id)
);

create table public.task_deliverables (
  id             uuid primary key default gen_random_uuid(),
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  task_id        uuid not null references public.tasks (id) on delete cascade,
  deliverable_id uuid not null references public.deliverables (id) on delete cascade,
  constraint task_deliverables_key unique (task_id, deliverable_id)
);

create table public.task_tech_targets (
  id             uuid primary key default gen_random_uuid(),
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  task_id        uuid not null references public.tasks (id) on delete cascade,
  tech_target_id uuid not null references public.tech_targets (id) on delete cascade,
  constraint task_tech_targets_key unique (task_id, tech_target_id)
);

create table public.achievement_members (
  id             uuid primary key default gen_random_uuid(),
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  achievement_id uuid not null references public.deliverable_achievements (id) on delete cascade,
  member_id      uuid not null references public.members (id) on delete cascade,  -- H-9
  constraint achievement_members_key unique (achievement_id, member_id)
);

create table public.note_attendees (
  id         uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  note_id    uuid not null references public.notes (id) on delete cascade,
  member_id  uuid not null references public.members (id) on delete cascade,  -- H-9
  constraint note_attendees_key unique (note_id, member_id)
);

-- -----------------------------------------------------------------------------
-- 22. 인덱스 (N-7)
-- -----------------------------------------------------------------------------
create index tasks_year_parent_sort_idx on public.tasks (year_id, parent_id, sort_order);
create index tasks_project_idx on public.tasks (project_id);
create index budget_executions_item_date_idx on public.budget_executions (budget_item_id, date);
create index notes_project_date_idx on public.notes (project_id, date desc);
create index milestones_project_date_idx on public.milestones (project_id, date);
create index notes_tags_idx on public.notes using gin (tags);

-- -----------------------------------------------------------------------------
-- 23. 트리거 — updated_at·version (N-5)
-- -----------------------------------------------------------------------------
create or replace function public.set_updated_meta()
returns trigger language plpgsql as $$
begin
  new.updated_at := clock_timestamp();
  new.version := old.version + 1;
  return new;
end; $$;

-- 조인 테이블·app_users에는 version이 없다 (N-4 예외)
create or replace function public.touch_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at := clock_timestamp();
  return new;
end; $$;

do $$
declare t text;
begin
  foreach t in array array[
    'projects', 'stages', 'years', 'tasks', 'milestones',
    'deliverables', 'deliverable_achievements', 'tech_targets', 'tech_target_records',
    'organizations', 'members', 'budget_items', 'budget_executions',
    'risks', 'notes', 'todos', 'import_profiles', 'import_snapshots', 'app_settings'
  ] loop
    execute format(
      'create trigger set_updated_meta before update on public.%I
         for each row execute function public.set_updated_meta()', t);
  end loop;

  foreach t in array array[
    'app_users', 'task_members', 'task_deliverables', 'task_tech_targets',
    'achievement_members', 'note_attendees'
  ] loop
    execute format(
      'create trigger touch_updated_at before update on public.%I
         for each row execute function public.touch_updated_at()', t);
  end loop;
end $$;

-- -----------------------------------------------------------------------------
-- 24. 트리거 — app_users 보호 컬럼 (RLS-2)
--     RLS는 컬럼 단위를 표현하지 못하므로 트리거로 거부한다.
--     PostgREST 요청은 current_user='authenticated'로 실행되고,
--     approve_user/deactivate_user(definer, 소유자 postgres)와 마이그레이션은 통과한다.
-- -----------------------------------------------------------------------------
create or replace function public.app_users_guard()
returns trigger language plpgsql as $$
begin
  if current_user = 'authenticated'
     and (new.id is distinct from old.id
          or new.email is distinct from old.email
          or new.active is distinct from old.active) then
    raise exception 'id, email, active는 직접 변경할 수 없습니다';
  end if;
  return new;
end; $$;

create trigger app_users_guard before update on public.app_users
  for each row execute function public.app_users_guard();

-- -----------------------------------------------------------------------------
-- 25. 트리거 — app_settings.schema_version 앱 변경 거부 (N-10)
-- -----------------------------------------------------------------------------
create or replace function public.app_settings_guard()
returns trigger language plpgsql as $$
begin
  if current_user = 'authenticated'
     and new.schema_version is distinct from old.schema_version then
    raise exception 'schema_version은 마이그레이션만 갱신할 수 있습니다';
  end if;
  return new;
end; $$;

create trigger app_settings_guard before update on public.app_settings
  for each row execute function public.app_settings_guard();

-- -----------------------------------------------------------------------------
-- 26. 인증 부트스트랩 (§14.2 A-3) — auth.users AFTER INSERT
--     첫 사용자 자동 승인: advisory lock으로 동시 첫 로그인 경합을 차단한다.
-- -----------------------------------------------------------------------------
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_count bigint;
begin
  perform pg_advisory_xact_lock(hashtext('app_users_bootstrap'));
  select count(*) into v_count from app_users;
  insert into app_users (id, email, name, active)
  values (
    new.id,
    coalesce(new.email, ''),
    coalesce(new.raw_user_meta_data ->> 'full_name',
             new.raw_user_meta_data ->> 'name',
             split_part(coalesce(new.email, ''), '@', 1)),
    v_count = 0
  );
  return new;
end; $$;

create trigger on_auth_user_created after insert on auth.users
  for each row execute function public.handle_new_user();

-- -----------------------------------------------------------------------------
-- 27. RLS 헬퍼 (§14.3 원문 그대로)
-- -----------------------------------------------------------------------------
create or replace function public.is_approved() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from app_users where id = auth.uid() and active = true);
$$;

-- -----------------------------------------------------------------------------
-- 28. 사용자 승인·비활성화 RPC (A-5, RLS-2 — X-2 예외 definer)
-- -----------------------------------------------------------------------------
create or replace function public.approve_user(p_user_id uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not exists (select 1 from app_users where id = auth.uid() and active = true) then
    raise exception '승인 권한이 없습니다';
  end if;
  if p_user_id = auth.uid() then
    raise exception '자기 자신은 승인할 수 없습니다';
  end if;
  update app_users set active = true where id = p_user_id;
end; $$;

create or replace function public.deactivate_user(p_user_id uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not exists (select 1 from app_users where id = auth.uid() and active = true) then
    raise exception '권한이 없습니다';
  end if;
  if p_user_id = auth.uid() then
    -- 마지막 사용자가 스스로를 잠그는 사고 방지
    raise exception '자기 자신은 비활성화할 수 없습니다';
  end if;
  update app_users set active = false where id = p_user_id;
end; $$;

-- -----------------------------------------------------------------------------
-- 29. create_year (§5.5, §9) — stage 마지막 뒤 삽입 + 이후 전체 +1 시프트,
--     비목 12종 자동 생성 (§5.12). security invoker (X-2).
-- -----------------------------------------------------------------------------
create or replace function public.create_year(
  p_stage_id   uuid,
  p_name       text default '',
  p_goal       text default '',
  p_start_date date default null,
  p_end_date   date default null,
  p_budget     bigint default null,
  p_status     text default 'planned'
) returns uuid language plpgsql security invoker as $$
declare
  v_project_id uuid;
  v_stage_order integer;
  v_order integer;
  v_year_id uuid;
begin
  select project_id, sort_order into v_project_id, v_stage_order
    from stages where id = p_stage_id;
  if v_project_id is null then
    raise exception 'stage를 찾을 수 없습니다';
  end if;

  -- 삽입 위치: 이 stage 이전(포함)의 마지막 연차 다음.
  -- stage 간 순서 정합(앞 단계 마지막 < 뒷 단계 첫)은 여기서 보장된다 (§5.5)
  select coalesce(max(y.sort_order), -1) + 1 into v_order
    from years y
    join stages s on s.id = y.stage_id
   where y.project_id = v_project_id
     and s.sort_order <= v_stage_order;

  -- years_project_order_key는 deferrable이라 일괄 시프트가 안전하다
  update years set sort_order = sort_order + 1
   where project_id = v_project_id and sort_order >= v_order;

  insert into years (project_id, stage_id, sort_order, name, goal,
                     start_date, end_date, budget, status, created_by, updated_by)
  values (v_project_id, p_stage_id, v_order, coalesce(p_name, ''), coalesce(p_goal, ''),
          p_start_date, p_end_date, p_budget, coalesce(p_status, 'planned'),
          auth.uid(), auth.uid())
  returning id into v_year_id;

  insert into budget_items (project_id, year_id, category, created_by, updated_by)
  select v_project_id, v_year_id, c, auth.uid(), auth.uid()
    from unnest(array[
      'personnel', 'student_personnel', 'facility_equipment', 'material',
      'consignment', 'international', 'burden', 'activity',
      'promotion', 'allowance', 'indirect', 'other'
    ]) as c
  on conflict (year_id, category) do nothing;

  return v_year_id;
end; $$;

-- -----------------------------------------------------------------------------
-- 30. delete_year (§8.3 원문 — H-5, N-8, N-13)
-- -----------------------------------------------------------------------------
create or replace function public.delete_year(p_year_id uuid)
returns void language plpgsql security invoker as $$
begin
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
-- 31. delete_stage (H-6) — 마지막 Stage 삭제 거부, 소속 Year는 delete_year 로직 적용
-- -----------------------------------------------------------------------------
create or replace function public.delete_stage(p_stage_id uuid)
returns void language plpgsql security invoker as $$
declare
  v_project_id uuid;
  r record;
begin
  select project_id into v_project_id from stages where id = p_stage_id;
  if v_project_id is null then
    raise exception 'stage를 찾을 수 없습니다';
  end if;
  if (select count(*) from stages where project_id = v_project_id) <= 1 then
    raise exception '마지막 단계는 삭제할 수 없습니다';
  end if;

  -- cascade에 맡기지 않고 delete_year를 태워 N-8 set null·N-13 키 제거를 보장한다
  for r in select id from years where stage_id = p_stage_id order by sort_order loop
    perform delete_year(r.id);
  end loop;

  delete from stages where id = p_stage_id;
end; $$;

-- -----------------------------------------------------------------------------
-- 32. delete_project (H-7) — 순환 FK 해소 후 삭제. To-Do는 project_id=null로 남긴다
-- -----------------------------------------------------------------------------
create or replace function public.delete_project(p_project_id uuid)
returns void language plpgsql security invoker as $$
begin
  if not exists (select 1 from projects where id = p_project_id) then
    raise exception '과제를 찾을 수 없습니다';
  end if;
  update projects set pm_member_id = null, lead_org_id = null where id = p_project_id;
  update todos set project_id = null where project_id = p_project_id;  -- N-8 명시
  delete from projects where id = p_project_id;  -- 나머지는 cascade
end; $$;

-- -----------------------------------------------------------------------------
-- 33. RLS (§14.3) — 승인된 사용자면 전부 허용, 아니면 전부 차단
-- -----------------------------------------------------------------------------
do $$
declare t text;
begin
  foreach t in array array[
    'projects', 'stages', 'years', 'tasks', 'milestones',
    'deliverables', 'deliverable_achievements', 'tech_targets', 'tech_target_records',
    'organizations', 'members', 'budget_items', 'budget_executions',
    'risks', 'notes', 'todos', 'import_profiles', 'import_snapshots',
    'task_members', 'task_deliverables', 'task_tech_targets',
    'achievement_members', 'note_attendees'
  ] loop
    execute format('alter table public.%I enable row level security', t);
    execute format(
      'create policy "approved users full access" on public.%I
         for all to authenticated
         using (is_approved()) with check (is_approved())', t);
  end loop;
end $$;

-- app_users (RLS-2): SELECT 승인자 전체/미승인자 본인, UPDATE 본인 행만.
-- INSERT/DELETE 정책 없음 — 생성은 handle_new_user, 승인은 approve_user만
alter table public.app_users enable row level security;

create policy "select own row or all when approved" on public.app_users
  for select to authenticated
  using (id = auth.uid() or is_approved());

create policy "update own row" on public.app_users
  for update to authenticated
  using (id = auth.uid()) with check (id = auth.uid());

-- app_settings (N-10): INSERT/DELETE 정책을 만들지 않아 행 추가·삭제가 불가능하다
alter table public.app_settings enable row level security;

create policy "approved users read" on public.app_settings
  for select to authenticated using (is_approved());

create policy "approved users update" on public.app_settings
  for update to authenticated
  using (is_approved()) with check (is_approved());

-- -----------------------------------------------------------------------------
-- 34. Realtime publication (R-7) — §8.5 구독표 17종
-- -----------------------------------------------------------------------------
alter publication supabase_realtime add table
  public.projects, public.milestones, public.tasks, public.years,
  public.deliverables, public.deliverable_achievements,
  public.tech_targets, public.tech_target_records,
  public.budget_items, public.budget_executions,
  public.organizations, public.members,
  public.risks, public.notes, public.todos,
  public.app_users, public.app_settings;

-- -----------------------------------------------------------------------------
-- 35. app_settings 기본 행 (§5.16, N-10) — schema_version = 1
-- -----------------------------------------------------------------------------
insert into public.app_settings
  (id, due_soon_days, milestone_alert_days, week_starts_on,
   default_gantt_scale, currency_unit, progress_weight_basis, schema_version)
values
  (true, 7, 30, 1, 'week', '천원', 'budget', 1);
