-- =============================================================================
-- 개발용 시드 — SOT §10, 부록 B.1 구조 그대로 (검증 예시가 곧 테스트 데이터다)
--
--   과제 A
--   └─ 1단계 (budget 600,000,000)
--      ├─ 1차년도 (budget 200,000,000)
--      │  └─ [루트] 요구사항 분석  (est 40h)
--      │     ├─ 문헌조사        (est 16h) done
--      │     └─ 요구사항 정의    (est 24h) done
--      └─ 2차년도 (budget 400,000,000)
--         ├─ [루트] 모델 개발    (est 100h)
--         │  ├─ 데이터 구축     (est 40h)  100%
--         │  └─ 학습·튜닝       (est 60h)  30%
--         └─ [루트] 시스템 통합  (est 50h)  0%
--
-- 고정 UUID를 써서 멱등으로 만든다: 재실행 시 기존 시드를 지우고 다시 넣는다.
-- 적용 경로는 postgres 직결(supabase db reset / tests/integration 헬퍼)이다 — RLS와 무관.
-- 연차별 비목 12종은 create_year RPC(§5.12)와 동일하게 함께 삽입한다.
-- =============================================================================

-- 재실행 멱등: 시드 과제만 제거 (FK cascade가 하위 전부를 지운다. 시드에는 todos가 없다)
delete from public.projects where id = 'aaaa0000-0000-4000-8000-000000000001';

-- ── 과제 A ───────────────────────────────────────────────────────────────────
insert into public.projects
  (id, name, project_no, ministry, agency, program_name, description,
   status, color, contract_start_date, contract_end_date,
   total_budget, gov_budget, own_budget, archived, sort_order)
values
  ('aaaa0000-0000-4000-8000-000000000001', '과제 A', '2026-0-01234',
   '과학기술정보통신부', 'IITP', '시드 검증용 사업', '부록 B.1 검증 예시 시드',
   'active', '#2563eb', '2026-01-01', '2027-12-31',
   600000000, 480000000, 120000000, false, 0);

-- ── 1단계 (budget 600,000,000) ───────────────────────────────────────────────
insert into public.stages
  (id, project_id, sort_order, name, goal, start_date, end_date, budget)
values
  ('aaaa0000-0000-4000-8000-000000000011', 'aaaa0000-0000-4000-8000-000000000001',
   0, '1단계', '핵심 기술 개발', '2026-01-01', '2027-12-31', 600000000);

-- ── 연차 2개 (200M / 400M) — sort_order는 과제 전체 기준 (§5.5) ──────────────
insert into public.years
  (id, project_id, stage_id, sort_order, name, goal, start_date, end_date, budget, status)
values
  ('aaaa0000-0000-4000-8000-000000000021', 'aaaa0000-0000-4000-8000-000000000001',
   'aaaa0000-0000-4000-8000-000000000011', 0, '1차년도', '요구사항 분석·설계',
   '2026-01-01', '2026-12-31', 200000000, 'closed'),
  ('aaaa0000-0000-4000-8000-000000000022', 'aaaa0000-0000-4000-8000-000000000001',
   'aaaa0000-0000-4000-8000-000000000011', 1, '2차년도', '모델 개발·통합',
   '2027-01-01', '2027-12-31', 400000000, 'active');

-- ── Task 7행 = 루트 3 + 자식 4 (B.1 트리 그대로) ────────────────────────────
-- 진척 표기: done 리프는 status='done'(리프 진척 100), % 리프는 manual_progress.
-- 부모(요구사항 분석·모델 개발)는 progress_mode='auto' — 파생 값은 저장하지 않는다 (§5.6).
insert into public.tasks
  (id, project_id, year_id, parent_id, sort_order, title, status,
   progress_mode, manual_progress, estimated_hours)
values
  -- 1차년도
  ('aaaa0000-0000-4000-8000-000000000031', 'aaaa0000-0000-4000-8000-000000000001',
   'aaaa0000-0000-4000-8000-000000000021', null, 0, '요구사항 분석', 'done', 'auto', 0, 40),
  ('aaaa0000-0000-4000-8000-000000000032', 'aaaa0000-0000-4000-8000-000000000001',
   'aaaa0000-0000-4000-8000-000000000021', 'aaaa0000-0000-4000-8000-000000000031',
   0, '문헌조사', 'done', 'manual', 100, 16),
  ('aaaa0000-0000-4000-8000-000000000033', 'aaaa0000-0000-4000-8000-000000000001',
   'aaaa0000-0000-4000-8000-000000000021', 'aaaa0000-0000-4000-8000-000000000031',
   1, '요구사항 정의', 'done', 'manual', 100, 24),
  -- 2차년도
  ('aaaa0000-0000-4000-8000-000000000034', 'aaaa0000-0000-4000-8000-000000000001',
   'aaaa0000-0000-4000-8000-000000000022', null, 0, '모델 개발', 'in_progress', 'auto', 0, 100),
  ('aaaa0000-0000-4000-8000-000000000035', 'aaaa0000-0000-4000-8000-000000000001',
   'aaaa0000-0000-4000-8000-000000000022', 'aaaa0000-0000-4000-8000-000000000034',
   0, '데이터 구축', 'in_progress', 'manual', 100, 40),
  ('aaaa0000-0000-4000-8000-000000000036', 'aaaa0000-0000-4000-8000-000000000001',
   'aaaa0000-0000-4000-8000-000000000022', 'aaaa0000-0000-4000-8000-000000000034',
   1, '학습·튜닝', 'in_progress', 'manual', 30, 60),
  ('aaaa0000-0000-4000-8000-000000000037', 'aaaa0000-0000-4000-8000-000000000001',
   'aaaa0000-0000-4000-8000-000000000022', null, 1, '시스템 통합', 'todo', 'manual', 0, 50);

-- ── 연차별 비목 12종 (create_year RPC와 동일 — §5.12) ────────────────────────
insert into public.budget_items (project_id, year_id, category)
select 'aaaa0000-0000-4000-8000-000000000001', y.id, c
  from (values ('aaaa0000-0000-4000-8000-000000000021'::uuid),
               ('aaaa0000-0000-4000-8000-000000000022'::uuid)) as y (id),
       unnest(array[
         'personnel', 'student_personnel', 'facility_equipment', 'material',
         'consignment', 'international', 'burden', 'activity',
         'promotion', 'allowance', 'indirect', 'other'
       ]) as c
on conflict (year_id, category) do nothing;
