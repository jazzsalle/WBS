// 백업 왕복 통합 테스트 — §8.7 K-1·K-5·K-7·K-8
//
// ⚠️ 파괴적 테스트다. `npm test`에 포함되지 않고 `npm run test:destructive`로만 돌린다.
//    K-7 복원이 대상 26종 테이블(백업 28종 중 app_users·app_settings 제외)의 전 행을 지우고 백업 시점 행으로 되돌리기 때문에,
//    실데이터가 있는 dev DB에서 돌리면 export 이후 다른 PC에서 추가된 변경분이 사라진다.
//    시작 전 assertNoForeignData가 테스트 소유가 아닌 데이터를 발견하면 실행을 거부한다.
//
// 왕복·K-5·K-8 검증은 리포지토리 레벨(lib/db/backup, 실제 세션 클라이언트 주입 = RLS·RPC
// 경로 실검증)로 수행하고, 액션이 쓰는 순수 부분(parseBackupFile의 Zod 거부)을 별도로 커버한다.
// 옛 v4 파일 거부(§8.8, Phase 23 S-12)만은 액션(actions/backup.ts importAll)을 부른다 —
// 사용자가 보는 버전 불일치 메시지를 내는 곳이 액션의 K-5 비교이기 때문이다.
// 쿠키 세션은 next/headers를 모킹해 실제 세션 토큰을 넣는다(통합 테스트의 액션 호출 방식과 같다).
//
// 왕복 자체가 dev DB 원복 장치다: 원본 export → 변형 → 원본 restore → DB가 원본과 일치.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Sql } from 'postgres';
import {
  SEED,
  applySeed,
  connectDirectDb,
  createTestUser,
  destroyTestUser,
  removeSeed,
  type TestUser,
} from '../integration/helpers';
import { assertNoForeignData } from './guard';
import * as backup from '@/lib/db/backup';
import * as projects from '@/lib/db/projects';
import * as stages from '@/lib/db/stages';
import * as years from '@/lib/db/years';
import * as tasks from '@/lib/db/tasks';
import { RuleViolationError, ValidationError } from '@/lib/db/errors';
import type { BackupFile } from '@/types';

// Phase 23에서 삭제된 집행 테이블 — v5 파일에 없어야 하고, 옛 v4 파일 재현에는 있어야 한다(S-11 예외 ②)
const DROPPED_TABLE = 'budget_executions';

const session = vi.hoisted(() => ({ accessToken: '' }));

vi.mock('next/headers', () => ({
  cookies: async () => ({ get: () => ({ value: session.accessToken }) }),
}));
vi.mock('next/cache', () => ({ revalidatePath: () => undefined }));

const { importAll } = await import('@/actions/backup');

// 실데이터 감지 가드는 어떤 준비 작업보다 먼저 돈다. beforeAll이 아니라 모듈 최상위인 이유:
// 여기서 멈추면 afterAll도 등록되지 않아 "정리하다 난 2차 에러"가 진짜 원인을 가리지 않는다.
const sql: Sql = connectDirectDb();
await assertNoForeignData(sql);

let user: TestUser;
const tempProjectIds: string[] = []; // afterAll 안전망 — 복원 실패로 남으면 직결 SQL로 지운다

// 산출근거 1행(§5.17, Phase 9). 시드에는 없으므로 여기서 만든다 — budget_details가
// 백업 대상에서 빠지면 K-7 전체 대체 복원이 근거만 지운다(§11 Phase 9 주석 ①).
// 리포지토리가 아니라 직결 SQL로 넣는 이유: 이 파일은 백업 경로만 검증하고,
// budget_details 리포지토리·서버 액션(PL-10 재계산)은 별도 테스트가 다룬다.
const SEED_DETAIL_ID = 'aaaa0000-0000-4000-8000-0000000000d1';

// v5 왕복(Phase 23)이 행 수만이 아니라 대표 행으로도 확인할 테이블들. 시드에는 없으므로 만든다 —
// 빈 테이블의 왕복은 "[] = []"로 통과해 목록 누락을 드러내지 못한다.
// staff는 과제 하위가 아니라 removeSeed의 cascade로 지워지지 않는다 — afterAll이 따로 지운다.
const FIXTURE = {
  ruleId: 'aaaa0000-0000-4000-8000-0000000000b1',
  staffId: 'aaaa0000-0000-4000-8000-0000000000b2',
  salaryId: 'aaaa0000-0000-4000-8000-0000000000b3',
  deliverableId: 'aaaa0000-0000-4000-8000-0000000000b4',
  achievementId: 'aaaa0000-0000-4000-8000-0000000000b5',
  techTargetId: 'aaaa0000-0000-4000-8000-0000000000b6',
  recordId: 'aaaa0000-0000-4000-8000-0000000000b7',
} as const;
const STAFF_EMAIL = `wbs-backup-${Date.now()}-${randomUUID().slice(0, 8)}@unes.co.kr`;

// 테이블 → 대표 행 id. 왕복 뒤 이 행들이 원본과 같아야 한다
const REPRESENTATIVE_ROWS: Record<string, string> = {
  budget_details: SEED_DETAIL_ID,
  budget_rules: FIXTURE.ruleId,
  staff: FIXTURE.staffId,
  staff_salaries: FIXTURE.salaryId,
  deliverables: FIXTURE.deliverableId,
  deliverable_achievements: FIXTURE.achievementId,
  tech_targets: FIXTURE.techTargetId,
  tech_target_records: FIXTURE.recordId,
};

async function insertFixtures(u: TestUser): Promise<void> {
  await sql`
    insert into public.budget_rules
      (id, project_id, code, enabled, value, base, severity, source, created_by, updated_by)
    values
      (${FIXTURE.ruleId}::uuid, ${SEED.projectId}::uuid, 'indirect_max', true, 17.5,
       'direct_cash_excl_intl', 'error', '왕복 테스트 출처', ${u.id}::uuid, ${u.id}::uuid)`;
  await sql`
    insert into public.staff (id, name, email, position, created_by, updated_by)
    values (${FIXTURE.staffId}::uuid, '백업 테스트 조직원', ${STAFF_EMAIL}, '선임',
            ${u.id}::uuid, ${u.id}::uuid)`;
  await sql`
    insert into public.staff_salaries
      (id, staff_id, effective_from, basis, amount, includes_retirement, includes_insurance)
    values (${FIXTURE.salaryId}::uuid, ${FIXTURE.staffId}::uuid, '2026-01-01', 'annual',
            48000000, true, false)`;
  await sql`
    insert into public.deliverables
      (id, project_id, type, name, target_total, created_by, updated_by)
    values (${FIXTURE.deliverableId}::uuid, ${SEED.projectId}::uuid, 'sw_registration',
            '왕복 테스트 지표', 3, ${u.id}::uuid, ${u.id}::uuid)`;
  await sql`
    insert into public.deliverable_achievements
      (id, deliverable_id, title, date, year_id, created_by, updated_by)
    values (${FIXTURE.achievementId}::uuid, ${FIXTURE.deliverableId}::uuid, '왕복 테스트 실적',
            '2026-06-01', ${SEED.year1Id}::uuid, ${u.id}::uuid, ${u.id}::uuid)`;
  await sql`
    insert into public.tech_targets
      (id, project_id, name, target_value, created_by, updated_by)
    values (${FIXTURE.techTargetId}::uuid, ${SEED.projectId}::uuid, '왕복 테스트 기술목표', 90,
            ${u.id}::uuid, ${u.id}::uuid)`;
  await sql`
    insert into public.tech_target_records
      (id, tech_target_id, value, date, year_id, created_by, updated_by)
    values (${FIXTURE.recordId}::uuid, ${FIXTURE.techTargetId}::uuid, 87.5, '2026-06-15',
            ${SEED.year1Id}::uuid, ${u.id}::uuid, ${u.id}::uuid)`;
}

function exportedBy(u: TestUser): BackupFile['exportedBy'] {
  return { id: u.id, email: u.email };
}

// JSON 파일로 저장했다 다시 읽는 실제 경로를 그대로 재현한다
function jsonRoundtrip(file: BackupFile): BackupFile {
  return JSON.parse(JSON.stringify(file)) as BackupFile;
}

beforeAll(async () => {
  await applySeed(sql);
  user = await createTestUser(sql);

  // formula='quantity' 행이라 member_id는 null이어야 한다 (PL-D1)
  await sql`
    insert into public.budget_details
      (id, project_id, year_id, category, subcategory, axis, formula,
       name, spec, unit_price, factors, adjustment, amount, note, sort_order,
       created_by, updated_by)
    values
      (${SEED_DETAIL_ID}::uuid, ${SEED.projectId}::uuid, ${SEED.year1Id}::uuid,
       'activity', 'activity_meeting', 'cash', 'quantity',
       '착수 회의', '20인 × 4회', 300000,
       -- sql.json()으로 넘긴다. **문자열을 넘기고 ::jsonb로 캐스트하면 안 된다** —
       -- postgres 드라이버가 jsonb 파라미터로 가는 JS 문자열을 한 번 더 JSON 인코딩해
       -- 배열이 아니라 jsonb **문자열 스칼라**가 저장된다(실측 확인). 그러면
       -- budgetDetailRowSchema가 거부하고 PL-1/PL-3 계산도 인자를 읽지 못한다.
       ${sql.json([{ label: '회', value: 4, isPercent: false }])}::jsonb,
       -500, 1199500, '왕복 테스트용', 0,
       ${user.id}::uuid, ${user.id}::uuid)`;

  await insertFixtures(user);
  session.accessToken = user.accessToken;
});

afterAll(async () => {
  for (const id of tempProjectIds) {
    await sql`delete from public.projects where id = ${id}::uuid`;
  }
  await sql`delete from public.staff where id = ${FIXTURE.staffId}::uuid`; // 이력은 cascade (ST-2)
  await removeSeed(sql);
  await destroyTestUser(sql, user);
  await sql.end();
});

describe('K-1: exportAll — BackupFile 인터페이스 정확 일치', () => {
  it('최상위 키 4개, tables는 28종 전부, JSON 직렬화 왕복 후에도 parseBackupFile을 통과한다', async () => {
    const file = await backup.exportAll(user.client, exportedBy(user));

    expect(Object.keys(file).sort()).toEqual(
      ['exportedAt', 'exportedBy', 'schemaVersion', 'tables'].sort()
    );
    // §8.8 Phase 23: 집행 테이블이 빠져 파일 형식이 바뀌었으므로 5다
    expect(file.schemaVersion).toBe(5);
    expect(file.tables).not.toHaveProperty(DROPPED_TABLE);
    expect(backup.BACKUP_TABLES).not.toContain(DROPPED_TABLE);
    expect(backup.RESTORE_TABLES).toHaveLength(26);
    expect(Number.isNaN(Date.parse(file.exportedAt))).toBe(false);
    expect(file.exportedBy).toEqual({ id: user.id, email: user.email });
    expect(Object.keys(file.tables).sort()).toEqual([...backup.BACKUP_TABLES].sort());
    expect(backup.BACKUP_TABLES).toHaveLength(28);

    // 행은 DB snake_case 원본 그대로 (매퍼 미경유) — 시드 과제 행으로 확인
    const seedProject = file.tables['projects']!.find(
      (r) => (r as { id: string }).id === SEED.projectId
    ) as Record<string, unknown>;
    expect(seedProject).toBeDefined();
    expect(seedProject).toHaveProperty('contract_start_date');
    expect(seedProject).toHaveProperty('sort_order');
    expect(seedProject).not.toHaveProperty('contractStartDate');

    // 파일 저장·재로드(JSON 왕복) 후에도 형식 검증을 통과하고 내용이 보존된다
    expect(backup.parseBackupFile(jsonRoundtrip(file))).toEqual(jsonRoundtrip(file));
  });
});

describe('K-7: v5 복원 왕복 — 전체 대체', () => {
  it('export → 수정·삭제·추가 → restore → 재export가 원본과 테이블별로 일치한다', async () => {
    const original = await backup.exportAll(user.client, exportedBy(user));
    expect(original.schemaVersion).toBe(5);
    // 대표 행이 원본에 실제로 실려 있어야 아래 비교가 의미를 가진다 (빈 테이블끼리의 일치 방지)
    for (const [table, id] of Object.entries(REPRESENTATIVE_ROWS)) {
      const ids = original.tables[table]!.map((r) => (r as { id: string }).id);
      expect(ids, table).toContain(id);
    }
    expect(original.tables['budget_items']!.length).toBeGreaterThan(0);

    // 수정: 시드 과제 이름 변경 (version·updated_by도 함께 변한다)
    await projects.updateProject(user.client, SEED.projectId, {
      name: '변조된 과제 이름',
      updatedBy: user.id,
    });
    // 삭제: 시드 Task 하나 제거
    await tasks.deleteTask(user.client, SEED.taskIds.literature);
    // 삭제: 산출근거 1행 제거 (§5.17) — 복원이 되살리지 못하면 백업에서 근거만 사라진다
    await sql`delete from public.budget_details where id = ${SEED_DETAIL_ID}::uuid`;
    // 삭제: 규칙·목표 4종·조직원(이력 cascade) — 복원이 되살리지 못하면 그 테이블이 목록에서 빠진 것이다
    await sql`delete from public.budget_rules where id = ${FIXTURE.ruleId}::uuid`;
    await sql`delete from public.deliverables where id = ${FIXTURE.deliverableId}::uuid`;
    await sql`delete from public.tech_targets where id = ${FIXTURE.techTargetId}::uuid`;
    await sql`delete from public.staff where id = ${FIXTURE.staffId}::uuid`;
    // 수정: 계획액 한 셀 — budget_items도 원본 값으로 돌아와야 한다
    await sql`
      update public.budget_items set planned_amount = planned_amount + 1234567
       where year_id = ${SEED.year1Id}::uuid and category = 'material'`;
    // 추가: 새 과제 + 단계 + 연차 (연차 생성이 budget_items 12종까지 만든다)
    const temp = await projects.createProject(user.client, {
      name: '왕복 테스트 임시 과제',
      createdBy: user.id,
      updatedBy: user.id,
    });
    tempProjectIds.push(temp.id);
    const tempStage = await stages.createStage(user.client, {
      projectId: temp.id,
      name: '1단계',
    });
    await years.createYear(user.client, { stageId: tempStage.id, name: '1차년도' });

    // JSON 왕복을 거친 원본으로 복원 — 실제 파일 복원 경로와 동일
    await backup.restoreBackup(user.client, jsonRoundtrip(original));

    const after = await backup.exportAll(user.client, exportedBy(user));
    expect(after.schemaVersion).toBe(original.schemaVersion);
    for (const table of backup.BACKUP_TABLES) {
      // id·audit(created_by/updated_by/version/타임스탬프)까지 원본 보존이므로 행 전체 비교
      expect(after.tables[table], table).toEqual(original.tables[table]);
    }
    // 루프가 BACKUP_TABLES 기준이라, 목록에서 빠진 테이블은 비교되지 않고 조용히 통과한다 —
    // 대표 행이 DB에 되살아났는지 직결 SQL로 따로 본다
    for (const [table, id] of Object.entries(REPRESENTATIVE_ROWS)) {
      const rows = await sql`select 1 from ${sql('public.' + table)} where id = ${id}::uuid`;
      expect(rows, table).toHaveLength(1);
    }

    // 산출근거는 위 루프에도 포함되지만, 목록 누락이 곧 무음 데이터 손실이므로 명시 검증한다
    const restoredDetail = (await sql`
      select category, subcategory, axis, formula, member_id, name, spec, factors,
             unit_price::text as unit_price,   -- bigint 표현 차이를 피해 문자열로 비교한다
             adjustment::text as adjustment,
             amount::text     as amount,
             sort_order
        from public.budget_details where id = ${SEED_DETAIL_ID}::uuid`)[0];
    expect(restoredDetail).toBeDefined();
    expect(restoredDetail).toMatchObject({
      category: 'activity',
      subcategory: 'activity_meeting',
      axis: 'cash',
      formula: 'quantity',
      member_id: null,
      name: '착수 회의',
      spec: '20인 × 4회',
      unit_price: '300000',
      adjustment: '-500',
      amount: '1199500',
      sort_order: 0,
    });
    expect(restoredDetail!.factors).toEqual([{ label: '회', value: 4, isPercent: false }]);
  });
});

describe('K-8: app_users·app_settings.schema_version은 복원되지 않는다', () => {
  it('payload의 app_users·schema_version을 변조해도 DB에는 반영되지 않는다', async () => {
    const current = await backup.exportAll(user.client, exportedBy(user));
    const tampered = jsonRoundtrip(current);

    tampered.tables['app_users'] = current.tables['app_users']!.map((r) => ({
      ...(r as Record<string, unknown>),
      name: '변조된 사용자',
      active: false,
    }));
    const settingsRow = current.tables['app_settings']![0] as Record<string, unknown>;
    tampered.tables['app_settings'] = [{ ...settingsRow, schema_version: 999 }];

    await backup.restoreBackup(user.client, tampered);

    const userRow = await sql`
      select name, active from public.app_users where id = ${user.id}::uuid`;
    expect(userRow[0]!.name).not.toBe('변조된 사용자');
    expect(userRow[0]!.active).toBe(true);

    const settings = await sql`select schema_version::int as v from public.app_settings`;
    expect(settings[0]!.v).toBe(current.schemaVersion);
  });
});

describe('K-5: schemaVersion 불일치·형식 위반 파일의 복원 거부', () => {
  it('schemaVersion이 다르면 RPC가 거부하고 데이터는 그대로다', async () => {
    const current = await backup.exportAll(user.client, exportedBy(user));
    const bad = jsonRoundtrip(current);
    bad.schemaVersion = current.schemaVersion + 1;

    await expect(backup.restoreBackup(user.client, bad)).rejects.toBeInstanceOf(
      RuleViolationError
    );

    // 거부 = DELETE도 시작 전 — 시드 과제가 그대로 남아 있다
    const left = await sql`
      select count(*)::int as n from public.projects where id = ${SEED.projectId}::uuid`;
    expect(left[0]!.n).toBe(1);
  });

  it('대상 테이블 키가 빠진 payload는 RPC가 시작 전에 거부한다 (무음 데이터 파괴 방지)', async () => {
    const current = await backup.exportAll(user.client, exportedBy(user));
    const broken = jsonRoundtrip(current);
    delete broken.tables['todos'];

    await expect(backup.restoreBackup(user.client, broken)).rejects.toBeInstanceOf(
      RuleViolationError
    );
  });
});

// §8.8 Phase 23: 집행 테이블이 빠져 schema_version이 5로 올랐다. 옛 v4 백업(집행 테이블 키 포함)은
// 액션의 K-5 버전 비교가 버전 불일치 메시지로 거부해야 한다 — "테이블 데이터가 없습니다" 같은 엉뚱한
// 메시지나, 집행 행을 조용히 버리고 나머지만 복원하는 것이면 실패다(S-12: 복원 RPC에 새 가드를 두지 않는다).
describe('§8.8 Phase 23: 옛 v4 백업 거부', () => {
  it('schemaVersion 4 + 집행 테이블 키가 든 파일은 importAll이 버전 불일치로 거부하고 데이터는 그대로다', async () => {
    const current = jsonRoundtrip(await backup.exportAll(user.client, exportedBy(user)));
    const legacy = jsonRoundtrip(current) as BackupFile;
    legacy.schemaVersion = 4;
    // v4 파일은 app_settings 행의 schema_version도 4였다
    legacy.tables['app_settings'] = current.tables['app_settings']!.map((r) => ({
      ...(r as Record<string, unknown>),
      schema_version: 4,
    }));
    const item = current.tables['budget_items']!.find(
      (r) => (r as { year_id: string }).year_id === SEED.year1Id
    ) as { id: string };
    legacy.tables[DROPPED_TABLE] = [
      {
        id: 'aaaa0000-0000-4000-8000-0000000000e1',
        created_at: '2026-05-10T00:00:00+00:00',
        updated_at: '2026-05-10T00:00:00+00:00',
        version: 1,
        created_by: user.id,
        updated_by: user.id,
        budget_item_id: item.id,
        date: '2026-05-10',
        amount: 1200000,
        description: '옛 집행',
        note: '',
        subcategory_code: null,
        spec: '',
        unit_price: null,
        factors: null,
        axis: null,
        member_id: null,
        detail_id: null,
      },
    ];
    // 거부가 복원 전에 일어났는지 보려고 DB를 파일과 다르게 만들어 둔다 — 복원됐다면 이름이 되돌아간다
    await projects.updateProject(user.client, SEED.projectId, {
      name: 'v4 거부 확인용 이름',
      updatedBy: user.id,
    });
    const before = await backup.exportAll(user.client, exportedBy(user));

    const result = await importAll(legacy);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('RULE');
    expect(result.error).toBe(
      '백업 파일의 스키마 버전(4)이 현재 스키마 버전(5)과 달라 복원할 수 없습니다.'
    );
    expect(result.error).not.toMatch(/데이터가 없습니다/);

    const after = await backup.exportAll(user.client, exportedBy(user));
    for (const table of backup.BACKUP_TABLES) {
      expect(after.tables[table], table).toEqual(before.tables[table]);
    }
    const name = await sql`select name from public.projects where id = ${SEED.projectId}::uuid`;
    expect(name[0]!.name).toBe('v4 거부 확인용 이름');

    // 다음 테스트를 위해 원래 상태로 되돌린다
    await backup.restoreBackup(user.client, current);
  });

  it('같은 파일을 RPC에 직접 넘겨도 K-5 게이트가 버전 불일치로 거부한다 (최종 방어선)', async () => {
    const current = jsonRoundtrip(await backup.exportAll(user.client, exportedBy(user)));
    const legacy = jsonRoundtrip(current);
    legacy.schemaVersion = 4;
    legacy.tables[DROPPED_TABLE] = [];

    await expect(backup.restoreBackup(user.client, legacy)).rejects.toThrow(
      /스키마 버전\(4\)이 현재 스키마 버전\(5\)과 다릅니다/
    );
    const left = await sql`
      select count(*)::int as n from public.projects where id = ${SEED.projectId}::uuid`;
    expect(left[0]!.n).toBe(1);
  });
});

// §5.8·§5.9 Phase 21 목표 새 7컬럼 — 백업이 새 컬럼을 실어 나르고, 7컬럼이 없는 옛(Phase 21 이전)
// 백업도 not null 위반 없이 복원돼야 한다(§8.8, S-2). restore_backup이 이 7컬럼만 기본값으로 채운다.
describe('§8.8 S-2: deliverables·tech_targets 새 7컬럼 백업·옛 형식 복원', () => {
  const DELIVERABLE_ID = 'aaaa0000-0000-4000-8000-0000000000a1';
  const TECH_TARGET_ID = 'aaaa0000-0000-4000-8000-0000000000a2';
  const DELIVERABLE_COLS = ['weight', 'evidence_method'] as const;
  const TECH_TARGET_COLS = [
    'group_name', 'standard_basis', 'basis_rationale', 'evaluation_environment', 'note',
  ] as const;

  beforeAll(async () => {
    // 7컬럼 전부 기본값이 아닌 값을 넣는다 — 기본값이면 "보존"과 "기본값으로 채움"을 가를 수 없다
    await sql`
      insert into public.deliverables
        (id, project_id, type, name, target_total, weight, evidence_method, created_by, updated_by)
      values
        (${DELIVERABLE_ID}::uuid, ${SEED.projectId}::uuid, 'sw_registration', '백업 테스트 지표', 2,
         12.5, 'SW 등록증', ${user.id}::uuid, ${user.id}::uuid)`;
    await sql`
      insert into public.tech_targets
        (id, project_id, name, target_value, group_name, standard_basis, basis_rationale,
         evaluation_environment, note, created_by, updated_by)
      values
        (${TECH_TARGET_ID}::uuid, ${SEED.projectId}::uuid, '백업 테스트 기술목표', 95,
         '플랫폼', 'ISO/IEC 25023', '국내 최고 수준 대비', '실증 현장', '[원문] 최종 목표: LOD 2.5',
         ${user.id}::uuid, ${user.id}::uuid)`;
  });

  it('내보내기 JSON의 deliverables·tech_targets 행에 새 7컬럼이 값 그대로 있다', async () => {
    const file = jsonRoundtrip(await backup.exportAll(user.client, exportedBy(user)));
    const deliverable = file.tables['deliverables']!.find(
      (r) => (r as { id: string }).id === DELIVERABLE_ID
    ) as Record<string, unknown>;
    expect(deliverable).toBeDefined();
    for (const col of DELIVERABLE_COLS) expect(deliverable, col).toHaveProperty(col);
    expect(Number(deliverable['weight'])).toBe(12.5);
    expect(deliverable['evidence_method']).toBe('SW 등록증');

    const techTarget = file.tables['tech_targets']!.find(
      (r) => (r as { id: string }).id === TECH_TARGET_ID
    ) as Record<string, unknown>;
    expect(techTarget).toBeDefined();
    for (const col of TECH_TARGET_COLS) expect(techTarget, col).toHaveProperty(col);
    expect(techTarget).toMatchObject({
      group_name: '플랫폼',
      standard_basis: 'ISO/IEC 25023',
      basis_rationale: '국내 최고 수준 대비',
      evaluation_environment: '실증 현장',
      note: '[원문] 최종 목표: LOD 2.5',
    });
    // 앱 필드명(group)이 아니라 DB 원본 컬럼명(group_name)이다 — 백업은 매퍼를 거치지 않는다
    expect(techTarget).not.toHaveProperty('group');
  });

  it('7컬럼을 뺀 옛 형식 행으로 복원하면 weight 0 · 문자열 6컬럼 \'\'이 된다', async () => {
    const current = jsonRoundtrip(await backup.exportAll(user.client, exportedBy(user)));
    const legacy = jsonRoundtrip(current);
    legacy.tables['deliverables'] = current.tables['deliverables']!.map((r) => {
      const row = { ...(r as Record<string, unknown>) };
      for (const col of DELIVERABLE_COLS) delete row[col];
      return row;
    });
    legacy.tables['tech_targets'] = current.tables['tech_targets']!.map((r) => {
      const row = { ...(r as Record<string, unknown>) };
      for (const col of TECH_TARGET_COLS) delete row[col];
      return row;
    });

    try {
      await backup.restoreBackup(user.client, legacy);

      const deliverable = (await sql`
        select weight::text as weight, evidence_method, name, target_total
          from public.deliverables where id = ${DELIVERABLE_ID}::uuid`)[0];
      expect(deliverable).toEqual({
        weight: '0',
        evidence_method: '',
        name: '백업 테스트 지표',
        target_total: 2,
      });
      const techTarget = (await sql`
        select group_name, standard_basis, basis_rationale, evaluation_environment, note,
               name, target_value::text as target_value
          from public.tech_targets where id = ${TECH_TARGET_ID}::uuid`)[0];
      expect(techTarget).toEqual({
        group_name: '',
        standard_basis: '',
        basis_rationale: '',
        evaluation_environment: '',
        note: '',
        name: '백업 테스트 기술목표',
        target_value: '95',
      });
    } finally {
      // 원복(현재 형식)으로 되돌린다 — 이후 테스트·dev DB가 새 컬럼 값을 기대한다
      await backup.restoreBackup(user.client, current);
    }

    const back = (await sql`
      select d.weight::text as weight, d.evidence_method, t.group_name, t.note
        from public.deliverables d, public.tech_targets t
       where d.id = ${DELIVERABLE_ID}::uuid and t.id = ${TECH_TARGET_ID}::uuid`)[0];
    expect(back).toEqual({
      weight: '12.5',
      evidence_method: 'SW 등록증',
      group_name: '플랫폼',
      note: '[원문] 최종 목표: LOD 2.5',
    });
  });
});

describe('parseBackupFile — importAll 액션의 구조 검증 (Zod)', () => {
  it('BackupFile 형태가 아니면 ValidationError', () => {
    for (const junk of [null, undefined, 42, 'json', [], {}]) {
      expect(() => backup.parseBackupFile(junk)).toThrow(ValidationError);
    }
    expect(() =>
      backup.parseBackupFile({
        schemaVersion: '1', // 숫자가 아님
        exportedAt: '2026-08-02T00:00:00Z',
        exportedBy: { id: 'x', email: 'y' },
        tables: {},
      })
    ).toThrow(ValidationError);
  });

  it('tables 값이 배열이 아니거나 28종 중 하나라도 빠지면 ValidationError', async () => {
    const current = await backup.exportAll(user.client, exportedBy(user));

    const notArray = jsonRoundtrip(current) as unknown as {
      tables: Record<string, unknown>;
    };
    notArray.tables['tasks'] = 'oops';
    expect(() => backup.parseBackupFile(notArray)).toThrow(ValidationError);

    const missing = jsonRoundtrip(current);
    delete missing.tables['app_users'];
    expect(() => backup.parseBackupFile(missing)).toThrow(/app_users/);

    // 정상 파일은 그대로 통과한다
    expect(backup.parseBackupFile(jsonRoundtrip(current)).schemaVersion).toBe(
      current.schemaVersion
    );
  });
});
