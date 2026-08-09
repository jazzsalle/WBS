-- =============================================================================
-- Phase 10 산출근거 임포트 — ImportKind에 'budget_detail' 추가
-- SOT §5.12.1(ImportKind), §5.1 N-12(enum은 text + check), §6.11
--
-- N-12대로 enum을 Postgres enum 타입이 아니라 text + check로 둔 덕분에
-- 값 추가가 제약 교체 한 번으로 끝난다. 컬럼도 테이블도 늘지 않는다.
--
-- schema_version은 올리지 않는다. §8.8의 기준은 "백업 파일 형식이 바뀌는가"이고
-- (§8.7 BACKUP_TABLES가 바뀌는가), 이 마이그레이션은 테이블 목록을 그대로 둔다 —
-- 기존 백업 파일이 그대로 복원된다. lib/constants.ts의 EXPECTED_SCHEMA_VERSION도
-- 2로 둔다.
-- =============================================================================

-- 기존 제약은 20260802000000_initial_schema.sql의 인라인 check라 이름이
-- Postgres 기본 규칙(<table>_<column>_check)으로 붙어 있다. 같은 이름으로 다시 만든다.
-- 'budget_plan'만 있던 제약이 넓어지기만 하므로 기존 행(전부 'budget_plan')은
-- 새 제약 검증을 그대로 통과한다. 기본값 'budget_plan'도 그대로 둔다.
alter table public.import_profiles
  drop constraint if exists import_profiles_kind_check;

alter table public.import_profiles
  add constraint import_profiles_kind_check
  check (kind in ('budget_plan', 'budget_detail'));
