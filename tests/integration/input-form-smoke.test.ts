// 사업비 입력 양식 **액션 계층** 스모크 — 내려받기 → 같은 파일 올리기 (SOT §9 Budget Input Form, §6.16 IN-2·IN-6, §7.9.7)
//
// 왕복 전체(수정 → 반영 → budget_details·스냅샷 → 재내려받기)는 tests/integration/input-form-actions.test.ts(T9)의
// 몫이다. 여기서는 액션 셋이 실제 세션·RLS 경로에서 **이어지는지**만 본다:
//   ① buildInputForm — 빈 연차라도 xlsx가 나온다 (사업비 시트는 부록 A.5 세목 전부를 깔기 때문)
//   ② previewInputForm — 방금 내려받은 파일을 그대로 올리면 변경 0·차단 없음 (IN-2 `_meta`가 같은 과제·버전으로 읽힌다)
//
// 자기가 만든 과제·사용자만 지운다 — 파괴적 테스트가 아니다.

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Sql } from 'postgres';
import { connectDirectDb, createTestUser, destroyTestUser, type TestUser } from './helpers';
import type { ActionResult } from '@/types';
import * as projectsRepo from '@/lib/db/projects';
import * as yearsRepo from '@/lib/db/years';

const session = vi.hoisted(() => ({ accessToken: '' }));

vi.mock('next/headers', () => ({
  cookies: async () => ({ get: () => ({ value: session.accessToken }) }),
}));
vi.mock('next/cache', () => ({ revalidatePath: () => undefined }));

const { buildInputForm, previewInputForm } = await import('@/actions/input-form');

let sql: Sql;
let user: TestUser;
let projectId: string;
let yearId: string;

// 실패를 조용히 넘기지 않는다 — 실패 코드까지 메시지에 담아 원인을 드러낸다
function unwrap<T>(result: ActionResult<T>): T {
  if (!result.ok) throw new Error(`액션 실패: ${result.error} (code=${result.code ?? '-'})`);
  return result.data;
}

/** §9: 파일은 FormData로 전달된다. 액션이 파일을 읽어 소비하므로 호출마다 새로 만든다 */
function formOf(bytes: Buffer, fileName: string): FormData {
  const form = new FormData();
  form.set('file', new Blob([new Uint8Array(bytes) as BlobPart]), fileName);
  return form;
}

beforeAll(async () => {
  sql = connectDirectDb();
  user = await createTestUser(sql);
  session.accessToken = user.accessToken;

  const project = await projectsRepo.createProjectWithDefaults(user.client, {
    name: '입력양식 스모크',
    contractStartDate: '2026-01-01',
  });
  projectId = project.id;
  const firstYear = (await yearsRepo.listYears(user.client, projectId))[0];
  if (!firstYear) throw new Error('createProjectWithDefaults가 연차를 만들지 않았습니다.');
  yearId = firstYear.id;
});

afterAll(async () => {
  if (projectId) await sql`delete from public.projects where id = ${projectId}::uuid`;
  await destroyTestUser(sql, user);
  await sql.end();
});

describe('입력 양식 액션 스모크 — 빈 연차 내려받기 → 그대로 올리기', () => {
  let file: Buffer;
  let fileName: string;

  it('buildInputForm: 빈 연차라도 xlsx(base64)가 나온다', async () => {
    const data = unwrap(await buildInputForm(projectId, yearId));
    expect(data.fileName).toMatch(/^입력양식_/);
    expect(data.fileName).toMatch(/\.xlsx$/);
    expect(data.contentBase64.length).toBeGreaterThan(0);

    file = Buffer.from(data.contentBase64, 'base64');
    fileName = data.fileName;
    // xlsx는 zip이다 — 'PK' 시그니처가 없으면 base64가 깨진 것이다
    expect(file.subarray(0, 2).toString('latin1')).toBe('PK');
  });

  it('previewInputForm: 같은 파일은 변경 0·차단 없음·해시 존재', async () => {
    const preview = unwrap(await previewInputForm(projectId, formOf(file, fileName)));
    expect(preview.yearId).toBe(yearId);
    expect(preview.fileHash).toMatch(/^[0-9a-f]{64}$/);
    expect(preview.blocked).toBe(false);
    expect(preview.summary).toEqual({ added: 0, changed: 0, deleted: 0, unchanged: 0, errors: 0, unknown: 0 });
    expect(preview.rows).toEqual([]);
    expect(preview.untouchedCategories).toEqual([]);
    expect(preview.totals.total.plannedAmount).toBe(0);
  });

  it('N-13: 다른 과제 id로 올리면 `_meta` 과제 불일치로 거부한다', async () => {
    const other = await projectsRepo.createProjectWithDefaults(user.client, { name: '입력양식 스모크(타과제)' });
    try {
      const result = await previewInputForm(other.id, formOf(file, fileName));
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe('RULE');
    } finally {
      await sql`delete from public.projects where id = ${other.id}::uuid`;
    }
  });
});
