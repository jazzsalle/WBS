-- =============================================================================
-- restore_backup safeupdate 대응 (schema_version = 1 유지 — 앱 계약 불변)
--
-- Supabase 호스티드 DB는 API 경유 역할에 pg-safeupdate를 켜두므로
-- WHERE 없는 DELETE("DELETE requires a WHERE clause")가 거부된다.
-- K-7 ①의 전 행 DELETE에 `where true`를 붙이는 것이 유일한 변경 —
-- 로직·순서·검증은 20260803000000_restore_backup.sql과 동일하다.
-- =============================================================================

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
    'budget_items', 'budget_executions', 'risks', 'notes', 'todos',
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
