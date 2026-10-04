-- =============================================================================
-- Phase 26 규칙 검증 공통 + 증빙 — budget_rules 새 코드 3종 + agreement_items 증빙 check
--                              + agreement_child_guard 재정의(증빙 예외) + create_agreement_version p_items
-- SOT §5.18 RL-D2, §5.21 AV-2·AV-6 ③, §5.24, §8.5, §8.7 K-9, §8.8, §9 Agreement Budget
-- 계획서 docs/plans/phase-26-plan.md S-1·S-4·S-12·S-14·S-21
--
-- 테이블·컬럼 추가·삭제가 없다 — schema_version 7 유지(§8.8). publication·restore_backup·
-- clone_agreement_version(이미 evidence까지 복사)·delete_year는 건드리지 않는다.
-- 새·재정의 함수는 전부 security invoker(기본값)다.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. budget_rules — 새 코드 3종 (§5.18, S-4)
--    lab_safety_min·lab_safety_max = RL-22 비율(%) → 0~100, 켜지면 값 필수
--    preserve_subcategory_totals   = RL-23 켜고 끄기만 → 값 없음(null만)
--    code check는 20260817000000_budget_rules.sql의 컬럼 인라인 check다. 이름은 pg_constraint로
--    확인했다(budget_rules_code_check) — 이름이 다르면 drop이 실패해 마이그레이션이 멈춘다.
--    세 check 모두 직전 정의(20260817000000) 전문에 새 코드만 더했다.
-- -----------------------------------------------------------------------------
alter table public.budget_rules drop constraint budget_rules_code_check;
alter table public.budget_rules add constraint budget_rules_code_check check (code in (
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
  'outsourcing_notice_threshold',
  -- v4.9 (§6.14.8) — RL-20·RL-21은 결번
  'lab_safety_min', 'lab_safety_max', 'preserve_subcategory_totals'
));

alter table public.budget_rules drop constraint budget_rules_value_range_check;
alter table public.budget_rules add constraint budget_rules_value_range_check check (
  case
    when code in ('allowance_max', 'allowance_min', 'indirect_max', 'consignment_max',
                  'external_tech_max', 'gov_share_max', 'own_cash_min', 'min_participation',
                  'lab_safety_min', 'lab_safety_max')
      then value is null or (value >= 0 and value <= 100)
    when code in ('equipment_review_threshold', 'material_notice_threshold',
                  'outsourcing_notice_threshold')
      then value is null or (value >= 0 and value = trunc(value))
    -- preserve_subcategory_totals도 여기로 온다 — 값 없는 코드
    else value is null
  end
);

alter table public.budget_rules drop constraint budget_rules_enabled_value_check;
alter table public.budget_rules add constraint budget_rules_enabled_value_check check (
  not enabled
  or code in ('indirect_cash_only', 'no_personnel_support', 'no_student_personnel',
              'no_burden', 'existing_personnel_cash', 'existing_cash_le_new',
              'preserve_subcategory_totals')
  or value is not null
);

-- -----------------------------------------------------------------------------
-- 2. agreement_items.evidence 모양 check (§5.24, S-12)
--    원소 = { label: 1~100자 공백만이 아닌 문자열, obtained: boolean, memo: 0~500자 문자열 },
--    30개 이하, 한 항목 안 라벨 중복 금지 — 액션 Zod와 같은 한도. DB는 최후 방어선이다.
--    CASE로 감싼 이유: 배열이 아닌 값에 jsonb_array_elements를 부르면 check가 false가 아니라
--    오류가 된다. 원소가 객체가 아니면 ->가 null을 주므로 coalesce로 false를 만든다.
--    기존 jsonb_typeof(evidence) = 'array' check는 그대로 둔다(겹쳐도 해가 없다).
-- -----------------------------------------------------------------------------
create or replace function public.agreement_evidence_is_valid(p_evidence jsonb)
returns boolean language sql immutable security invoker as $$
  select case
    when p_evidence is null or jsonb_typeof(p_evidence) <> 'array' then false
    when jsonb_array_length(p_evidence) > 30 then false
    else
      not exists (
        select 1 from jsonb_array_elements(p_evidence) e
         where not coalesce(
           jsonb_typeof(e) = 'object'
           and jsonb_typeof(e -> 'label') = 'string'
           and char_length(btrim(e ->> 'label')) > 0
           and char_length(e ->> 'label') <= 100
           and jsonb_typeof(e -> 'obtained') = 'boolean'
           and jsonb_typeof(e -> 'memo') = 'string'
           and char_length(e ->> 'memo') <= 500,
           false)
      )
      and (select count(distinct e ->> 'label') = count(*) from jsonb_array_elements(p_evidence) e)
  end
$$;

alter table public.agreement_items
  add constraint agreement_items_evidence_valid_check
  check (public.agreement_evidence_is_valid(evidence));

-- -----------------------------------------------------------------------------
-- 3. agreement_child_guard 재정의 — 확정 버전 편성 항목의 증빙 예외 (AV-2, S-1)
--    20261001000000_agreement_budget.sql의 정의 전문에서 바꾼 것은 확정 분기 하나뿐이다:
--    agreement_items UPDATE이고, evidence·updated_at·updated_by·version 외 컬럼이 전부 같고,
--    새·옛 evidence의 라벨 배열(순서 포함)이 같으면 통과한다 — 받음 체크·메모만 바뀐 갱신이다.
--    확정 버전 아래 INSERT, 다른 테이블 3종, 다른 컬럼·라벨 변경은 이전과 같은 메시지로 거부한다.
--    BEFORE 트리거는 이름순으로 돈다(agreement_child_guard < set_updated_meta) — version·updated_at은
--    아직 안 바뀌었을 수도 클라이언트가 보냈을 수도 있어 비교에서 뺀다.
--    lax 경로 '$[*].label'은 label 없는 원소를 건너뛰지만 그런 원소는 2.의 check가 거부한다.
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
    if not (
      tg_op = 'UPDATE'
      and tg_table_name = 'agreement_items'
      and (to_jsonb(new) - array['evidence', 'updated_at', 'updated_by', 'version'])
          = (to_jsonb(old) - array['evidence', 'updated_at', 'updated_by', 'version'])
      and jsonb_path_query_array(to_jsonb(new) -> 'evidence', '$[*].label')
          = jsonb_path_query_array(to_jsonb(old) -> 'evidence', '$[*].label')
    ) then
      raise exception '확정된 협약 예산 버전의 내용은 고칠 수 없습니다 — 확정을 취소하거나 새 버전을 만드세요';
    end if;
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

-- -----------------------------------------------------------------------------
-- 4. create_agreement_version 재정의 — p_items 추가 (§9 Agreement Budget, AV-6 ③, S-14)
--    20261003000000_agreement_forms.sql의 정의 전문에 p_items 검증·삽입과 반환 items만 더했다.
--    옛 6인자 시그니처를 먼저 drop한다 — 남겨 두면 기본값 인자 때문에 6인자 호출이 두 함수에
--    모두 맞아 오버로드가 모호해진다.
--    p_items : [{ "year_id", "kind", "name", "amount", "quantity", "evidence" }] (DB snake_case)
--              kind = equipment|material|outsourcing, amount = 0 이상 원 단위 정수,
--              quantity = null 또는 0 이상 수, name·evidence 생략 시 ''·[] (evidence 모양은 2.의 check)
--    보내기만 채우고 빈 버전·붙임4 가져오기는 생략한다.
--    반환 : { versionId, order, lines, participants, govSupport, items }
-- -----------------------------------------------------------------------------
drop function public.create_agreement_version(uuid, text, text, jsonb, jsonb, jsonb);

create or replace function public.create_agreement_version(
  p_project_id   uuid,
  p_kind         text,
  p_name         text,
  p_lines        jsonb default '[]'::jsonb,
  p_participants jsonb default '[]'::jsonb,
  p_gov_cash     jsonb default '{}'::jsonb,
  p_items        jsonb default '[]'::jsonb
) returns jsonb language plpgsql security invoker as $$
declare
  v_lines        jsonb := coalesce(p_lines, '[]'::jsonb);
  v_participants jsonb := coalesce(p_participants, '[]'::jsonb);
  v_gov_cash     jsonb := coalesce(p_gov_cash, '{}'::jsonb);
  v_items        jsonb := coalesce(p_items, '[]'::jsonb);
  v_draft_name   text;
  v_order        integer;
  v_version_id   uuid;
  v_n_lines      integer;
  v_n_parts      integer;
  v_n_gov        integer;
  v_n_items      integer;
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

  -- 편성 항목 (S-14): 아래 jsonb_to_recordset 캐스트가 반올림하거나 알아보기 힘든 오류를 내기 전에 거부한다
  if jsonb_typeof(v_items) <> 'array' then
    raise exception '편성 항목 목록이 배열이 아닙니다';
  end if;
  if exists (select 1 from jsonb_array_elements(v_items) i where jsonb_typeof(i) <> 'object') then
    raise exception '편성 항목이 객체가 아닙니다';
  end if;
  if exists (
    select 1 from jsonb_array_elements(v_items) i
     where coalesce(i ->> 'kind', '') not in ('equipment', 'material', 'outsourcing')
  ) then
    raise exception '편성 항목 종류는 장비·재료·외주 중 하나여야 합니다';
  end if;
  if exists (
    select 1 from jsonb_array_elements(v_items) i
     where jsonb_typeof(i -> 'amount') is distinct from 'number'
        or (i -> 'amount')::text !~ '^[0-9]+$'
  ) then
    raise exception '편성 항목 금액은 0 이상의 원 단위 정수여야 합니다';
  end if;
  if exists (
    select 1 from jsonb_array_elements(v_items) i
     -- CASE: or는 평가 순서를 보장하지 않아 문자열 수량을 numeric으로 캐스트하다 오류가 날 수 있다
     where case coalesce(jsonb_typeof(i -> 'quantity'), 'null')
             when 'null'   then false
             when 'number' then (i ->> 'quantity')::numeric < 0
             else true
           end
  ) then
    raise exception '편성 항목 수량은 비우거나 0 이상의 수여야 합니다';
  end if;
  if exists (
    select 1 from jsonb_array_elements(v_items) i
     where coalesce(jsonb_typeof(i -> 'name'), 'string') <> 'string'
        or coalesce(jsonb_typeof(i -> 'evidence'), 'array') <> 'array'
  ) then
    raise exception '편성 항목의 품명은 문자열, 증빙은 배열이어야 합니다';
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
  ) or exists (
    select 1 from jsonb_to_recordset(v_items) as i("year_id" uuid)
     where i."year_id" is null
        or not exists (select 1 from years y where y.id = i."year_id" and y.project_id = p_project_id)
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

  -- 증빙 모양은 agreement_items_evidence_valid_check가 막는다
  insert into agreement_items (version_id, year_id, kind, name, amount, quantity, evidence,
                               created_by, updated_by)
  select v_version_id, i."year_id", i."kind", coalesce(i."name", ''), i."amount", i."quantity",
         coalesce(i."evidence", '[]'::jsonb), auth.uid(), auth.uid()
    from jsonb_to_recordset(v_items)
           as i("year_id" uuid, "kind" text, "name" text, "amount" bigint, "quantity" numeric,
                "evidence" jsonb);
  get diagnostics v_n_items = row_count;

  return jsonb_build_object(
    'versionId',    v_version_id,
    'order',        v_order,
    'lines',        v_n_lines,
    'participants', v_n_parts,
    'govSupport',   v_n_gov,
    'items',        v_n_items
  );
end; $$;

-- drop으로 옛 grant가 사라졌으므로 다시 준다 — 20261003000000_agreement_forms.sql과 같은 규약(authenticated만)
revoke execute on function public.create_agreement_version(uuid, text, text, jsonb, jsonb, jsonb, jsonb) from public, anon;
grant execute on function public.create_agreement_version(uuid, text, text, jsonb, jsonb, jsonb, jsonb) to authenticated;
