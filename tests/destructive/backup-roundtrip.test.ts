// 백업 왕복 통합 테스트 — §8.7 K-1·K-5·K-7·K-8
//
// ⚠️ 파괴적 테스트다. `npm test`에 포함되지 않고 `npm run test:destructive`로만 돌린다.
//    K-7 복원이 대상 25종 테이블의 전 행을 지우고 백업 시점 행으로 되돌리기 때문에,
//    실데이터가 있는 dev DB에서 돌리면 export 이후 다른 PC에서 추가된 변경분이 사라진다.
//    시작 전 assertNoForeignData가 테스트 소유가 아닌 데이터를 발견하면 실행을 거부한다.
//
// 서버 액션(actions/backup.ts)은 쿠키 세션(requireApprovedUser) 위에 있어 vitest에서
// 직접 호출할 수 없다. 왕복·K-5·K-8 검증은 리포지토리 레벨(lib/db/backup, 실제 세션
// 클라이언트 주입 = RLS·RPC 경로 실검증)로 수행하고, 액션이 쓰는 순수 부분
// (parseBackupFile의 Zod 거부)을 별도로 커버한다.
//
// 왕복 자체가 dev DB 원복 장치다: 원본 export → 변형 → 원본 restore → DB가 원본과 일치.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
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

// 실데이터 감지 가드는 어떤 준비 작업보다 먼저 돈다. beforeAll이 아니라 모듈 최상위인 이유:
// 여기서 멈추면 afterAll도 등록되지 않아 "정리하다 난 2차 에러"가 진짜 원인을 가리지 않는다.
const sql: Sql = connectDirectDb();
await assertNoForeignData(sql);

let user: TestUser;
const tempProjectIds: string[] = []; // afterAll 안전망 — 복원 실패로 남으면 직결 SQL로 지운다

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
});

afterAll(async () => {
  for (const id of tempProjectIds) {
    await sql`delete from public.projects where id = ${id}::uuid`;
  }
  await removeSeed(sql);
  await destroyTestUser(sql, user);
  await sql.end();
});

describe('K-1: exportAll — BackupFile 인터페이스 정확 일치', () => {
  it('최상위 키 4개, tables는 25종 전부, JSON 직렬화 왕복 후에도 parseBackupFile을 통과한다', async () => {
    const file = await backup.exportAll(user.client, exportedBy(user));

    expect(Object.keys(file).sort()).toEqual(
      ['exportedAt', 'exportedBy', 'schemaVersion', 'tables'].sort()
    );
    expect(typeof file.schemaVersion).toBe('number');
    expect(Number.isNaN(Date.parse(file.exportedAt))).toBe(false);
    expect(file.exportedBy).toEqual({ id: user.id, email: user.email });
    expect(Object.keys(file.tables).sort()).toEqual([...backup.BACKUP_TABLES].sort());
    expect(backup.BACKUP_TABLES).toHaveLength(25);

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

describe('K-7: 복원 왕복 — 전체 대체', () => {
  it('export → 수정·삭제·추가 → restore → 재export가 원본과 테이블별로 일치한다', async () => {
    const original = await backup.exportAll(user.client, exportedBy(user));

    // 수정: 시드 과제 이름 변경 (version·updated_by도 함께 변한다)
    await projects.updateProject(user.client, SEED.projectId, {
      name: '변조된 과제 이름',
      updatedBy: user.id,
    });
    // 삭제: 시드 Task 하나 제거
    await tasks.deleteTask(user.client, SEED.taskIds.literature);
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

  it('tables 값이 배열이 아니거나 25종 중 하나라도 빠지면 ValidationError', async () => {
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
