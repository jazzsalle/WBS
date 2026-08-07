-- =============================================================================
-- Phase 9 예산 제안 모드 — budget_details 신설 + members/projects 확장
-- SOT §5.17(PL-D1~PL-D8), §5.11, §5.3, §6.6 H-9a, §6.10.2 PL-10·PL-10a,
--     §8.5 R-7(구독표 "연구비" 행), §8.7 K-7, §14.3 RLS-1
--
-- 규칙 요약 (20260802000000_initial_schema.sql과 동일한 관례를 따른다)
--  - N-4  : 공통 컬럼 id/created_at/updated_at/version/created_by/updated_by
--  - N-5  : updated_at·version은 set_updated_meta 트리거
--  - N-9  : 순서 컬럼은 sort_order
--  - N-11 : not null 기본값 — string '', number 0
--  - N-12 : enum은 text + check 제약
--  - RLS-1: RLS 활성 + to authenticated + is_approved()
--
-- schema_version 1 → 2. **budget_details는 Phase 0 이후 처음 추가되는 테이블이라
-- 백업 파일 형식이 바뀐다** — 이 마이그레이션 이전에 내보낸 파일에는 budget_details 키가 없다.
-- 버전을 올리지 않으면 K-5의 버전 게이트가 "호환"이라 판정한 파일을
-- parseBackupFile의 테이블 목록 검사가 거부해, 사용자가 "테이블 데이터가 없습니다"라는
-- 엉뚱한 메시지를 본다. 버전을 올려야 §8.7 K-5의 의도대로
-- "스키마 버전이 달라 복원할 수 없습니다"가 나온다.
--
-- 이 마이그레이션을 적용한 뒤에는 lib/constants.ts의 EXPECTED_SCHEMA_VERSION도 2여야 한다
-- (§8.8). 둘 중 하나만 바뀌면 앱이 진입을 막는다 — 그게 의도된 안전장치다.
-- 다른 PC는 git pull 후 db push를 해야 진입할 수 있다 (K-6: 마이그레이션 직전 자동 백업).
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. budget_details (§5.17) — 산출근거 = 예산 제안의 내역
--    amount는 파생 값이지만 저장한다 (PL-D7·PL-10a). 산식은 lib/budget-plan.ts
--    한 곳에만 두고 RPC는 더하기만 하므로, DB에는 산식을 재현하지 않는다.
-- -----------------------------------------------------------------------------
create table public.budget_details (
  id          uuid primary key default gen_random_uuid(),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  version     bigint not null default 1,
  created_by  uuid references public.app_users (id) on delete set null,
  updated_by  uuid references public.app_users (id) on delete set null,

  -- PL-D8: 연차·과제가 사라지면 그 계획도 사라지는 것이 맞다
  project_id  uuid not null references public.projects (id) on delete cascade,
  year_id     uuid not null references public.years (id) on delete cascade,

  -- budget_items와 같은 비목 12종 (§5.12). 매트릭스 셀을 가리킨다
  category    text not null
                check (category in ('personnel', 'student_personnel', 'facility_equipment',
                                    'material', 'consignment', 'international', 'burden',
                                    'activity', 'promotion', 'allowance', 'indirect', 'other')),
  -- 세목 코드 (부록 A.5). 세목이 없는 비목은 'default'.
  -- PL-D4(프리셋 소속 검증)는 프리셋이 코드에 있으므로 앱에서 검증한다
  subcategory text not null,
  -- PL-D1 주석: 축은 null이 없다 — 축이 없으면 합계를 현금/현물로 나눌 수 없다
  axis        text not null check (axis in ('cash', 'in_kind')),
  formula     text not null check (formula in ('personnel', 'quantity')),

  -- H-9a: 인건비 산출근거가 걸린 Member는 삭제할 수 없다.
  -- 사람을 지운 조작만으로 비목 총액이 줄어드는 것을 막는다 (PL-D8)
  member_id   uuid references public.members (id) on delete restrict,

  name        text not null default '',   -- formula='quantity' 전용 (인건비는 member가 이름의 출처)
  spec        text not null default '',
  note        text not null default '',
  unit_price  bigint not null default 0 check (unit_price >= 0),   -- PL-D5
  -- DetailFactor[] — 세목마다 인자의 의미가 달라 라벨을 값과 함께 저장한다 (PL-3)
  factors     jsonb not null default '[]'::jsonb,
  adjustment  bigint not null default 0,  -- PL-D5: 조정액만 음수를 허용한다
  amount      bigint not null default 0,  -- PL-D7: 서버 액션이 계산해 넣는다
  sort_order  integer not null default 0,

  -- PL-D1: personnel이면 memberId 필수, quantity면 null이어야 한다
  constraint budget_details_formula_member_check check (
    (formula = 'personnel' and member_id is not null)
    or (formula = 'quantity' and member_id is null)
  ),
  -- PL-D3: 인건비 셀에 단가 행이 섞이면 §6.10.3 검증의 기준액이 흔들린다.
  -- category·formula 모두 not null이라 boolean 동치 비교가 null이 되지 않는다
  constraint budget_details_category_formula_check check (
    (category in ('personnel', 'student_personnel')) = (formula = 'personnel')
  )
);

-- 패널 조회(세목별 정렬)·PL-6~PL-8 집계 경로
create index budget_details_year_cat_sub_sort_idx
  on public.budget_details (year_id, category, subcategory, sort_order);
-- H-9a 참조 건수 검사(count_member_references)와 PL-10b 연봉 변경 파급 조회
create index budget_details_member_idx on public.budget_details (member_id);

-- -----------------------------------------------------------------------------
-- 2. 트리거 (N-5) — 초기 스키마의 set_updated_meta를 그대로 쓴다
-- -----------------------------------------------------------------------------
create trigger set_updated_meta before update on public.budget_details
  for each row execute function public.set_updated_meta();

-- -----------------------------------------------------------------------------
-- 3. RLS (RLS-1, §14.3) — 기존 테이블과 완전히 같은 형태
-- -----------------------------------------------------------------------------
alter table public.budget_details enable row level security;

create policy "approved users full access" on public.budget_details
  for all to authenticated
  using (is_approved()) with check (is_approved());

-- -----------------------------------------------------------------------------
-- 4. Realtime publication (R-7) — §8.5 구독표 "연구비" 행에 추가됐다
-- -----------------------------------------------------------------------------
alter publication supabase_realtime add table public.budget_details;

-- -----------------------------------------------------------------------------
-- 5. members 확장 (§5.11) — 인건비 산출근거의 단가 원본
--    참여율·참여기간은 (연차 × 인력)의 속성이라 budget_details가 갖는다. 여기에 두지 않는다.
-- -----------------------------------------------------------------------------
alter table public.members
  add column annual_salary bigint,                    -- 실지급액(연봉), 원 단위 정수. 미입력은 null
  add column hire_type     text not null default 'existing'
               check (hire_type in ('existing', 'new'));   -- 기존인력 / 신규채용(예정자 포함)

-- -----------------------------------------------------------------------------
-- 6. projects 확장 (§5.3, PL-14) — 지침 한도율
--    연구수당 20%만 혁신법 공통이라 기본값을 두고, 간접비 고시율은 부처·기관 유형마다
--    달라 기본값을 두지 않는다. 부처별 고시율 표를 코드·스키마에 넣지 않는다 (PL-16).
-- -----------------------------------------------------------------------------
alter table public.projects
  add column allowance_rate_limit numeric default 20,
  add column indirect_rate_limit  numeric;

-- -----------------------------------------------------------------------------
-- 7. restore_backup 갱신 (§8.7 K-7, §11 Phase 9 주석 ①)
--    c_tables에 budget_details를 추가하는 것이 유일한 변경 —
--    나머지 로직·순서·검증은 20260804000000_restore_backup_safeupdate_fix.sql과 동일하다.
--
--    위치: members·years·budget_items 뒤(budget_executions 다음).
--      · 정순 INSERT — project_id/year_id/member_id FK가 이미 채워져 있어야 한다
--      · 역순 DELETE — budget_details가 members보다 먼저 지워져야
--        member_id의 on delete restrict가 members 삭제를 막지 않는다 (H-9a)
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
    'budget_items', 'budget_executions', 'budget_details', 'risks', 'notes', 'todos',
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
-- schema_version 1 → 2 (§8.8, K-5) — 파일 머리말의 근거 참조.
-- app_settings_guard 트리거는 current_user = 'authenticated'일 때만 막으므로
-- 마이그레이션(postgres 역할)은 갱신할 수 있다 (N-10).
-- -----------------------------------------------------------------------------
update public.app_settings set schema_version = 2 where id = true;
