-- =============================================================================
-- 마일스톤 RPC — 연차 기본 마일스톤 자동 생성
-- SOT §5.7, §7.8, §8.3(X-1, X-2), §9 Milestone
--
--  - X-2 : security invoker — RLS를 우회하지 않는다. invoker이므로 PUBLIC 기본
--          실행 권한이 있어도 milestones/years RLS가 그대로 걸린다(승인 사용자만 통과).
--  - X-1 : "중복 검사 + 2건 삽입"을 한 함수(=한 트랜잭션)로 묶는다. 애플리케이션에서
--          나눠 호출하면 중간 실패 시 한 건만 남은 상태가 된다.
--  - §7.8: 자동 생성 대상은 정확히 2건이다 — 연차평가(annual_eval),
--          연차실적계획서 제출(report). 그 외 유형은 만들지 않는다.
--  - 날짜: §7.8은 "연차 종료일 기준 자동 제안"까지만 정한다. 임의의 오프셋을
--          만들지 않고 인자가 없으면 연차 종료일을 그대로 쓴다. 종료일도 인자도
--          없으면 오늘 날짜로 조용히 대체하지 않고 명시적으로 실패시킨다
--          (틀린 마감일은 없는 마감일보다 위험하다).
-- =============================================================================

-- -----------------------------------------------------------------------------
-- generate_default_milestones (§7.8)
--   반환: 실제로 삽입된 행만. 이미 있는 유형은 건너뛰므로 0~2건이다(멱등).
--   중복 판정 기준은 (year_id, type) — 사용자가 제목·날짜를 고쳤어도 다시 만들지 않는다.
-- -----------------------------------------------------------------------------
create or replace function public.generate_default_milestones(
  p_year_id           uuid,
  p_annual_eval_date  date default null,
  p_report_date       date default null
) returns setof public.milestones language plpgsql security invoker as $$
declare
  v_project_id  uuid;
  v_name        text;
  v_end_date    date;
  v_eval_date   date;
  v_report_date date;
  v_prefix      text;
begin
  select project_id, nullif(btrim(name), ''), end_date
    into v_project_id, v_name, v_end_date
    from years where id = p_year_id;
  if v_project_id is null then
    raise exception '연차를 찾을 수 없습니다';
  end if;

  v_eval_date   := coalesce(p_annual_eval_date, v_end_date);
  v_report_date := coalesce(p_report_date, v_end_date);

  -- 두 건 중 하나라도 날짜를 정할 수 없으면 아무것도 넣지 않는다 — 부분 생성은
  -- "나머지도 만들어졌겠지"라는 오해를 남긴다
  if v_eval_date is null or v_report_date is null then
    raise exception '연차 종료일이 없어 기본 마일스톤 날짜를 정할 수 없습니다. 연차 종료일을 먼저 입력하거나 날짜를 직접 지정하세요.';
  end if;

  -- 연차명이 비면 접두어 없이 유형명만 쓴다 (' 연차평가'처럼 앞이 비는 제목을 막는다)
  v_prefix := case when v_name is null then '' else v_name || ' ' end;

  if not exists (
    select 1 from milestones where year_id = p_year_id and type = 'annual_eval'
  ) then
    return query
    with inserted as (
      insert into milestones (project_id, year_id, type, title, date, status,
                              owner_member_id, description, result_note,
                              created_by, updated_by)
      values (v_project_id, p_year_id, 'annual_eval', v_prefix || '연차평가', v_eval_date,
              'planned', null, '', '', auth.uid(), auth.uid())
      returning *
    )
    select * from inserted;
  end if;

  if not exists (
    select 1 from milestones where year_id = p_year_id and type = 'report'
  ) then
    return query
    with inserted as (
      insert into milestones (project_id, year_id, type, title, date, status,
                              owner_member_id, description, result_note,
                              created_by, updated_by)
      values (v_project_id, p_year_id, 'report', v_prefix || '연차실적계획서 제출', v_report_date,
              'planned', null, '', '', auth.uid(), auth.uid())
      returning *
    )
    select * from inserted;
  end if;

  return;
end; $$;
