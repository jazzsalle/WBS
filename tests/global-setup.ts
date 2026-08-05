// vitest globalSetup — 실행 1회. 중단된 테스트가 dev DB에 남긴 잔여물을 먼저 청소한다.
//
// 왜 필요한가: 통합 테스트는 `wbs-test+…@unes.co.kr` 사용자를 만들고 그 사용자 소유로만
// 데이터를 쓴 뒤 afterAll에서 지운다. 실행이 중단되면(Ctrl+C, 타임아웃, 프로세스 강제 종료)
// afterAll이 돌지 않아 사용자와 과제가 그대로 남는다. 그 잔여물은 다음 실행에서
// "테스트 소유가 아닌 데이터"로 보여 파괴적 테스트 가드(tests/destructive/guard.ts)를
// 막고, 실데이터와 구분도 어려워진다.
//
// 삭제 순서가 중요하다: **사용자를 지우기 전에 그 사용자 소유 행을 먼저 지운다.**
// auth.users를 먼저 지우면 각 행의 created_by가 set null이 되어(N-8) 소유자를 잃고,
// 그때부터는 실데이터와 구분할 방법이 없어진다.
//
// 판정 대상은 루트 테이블 4종뿐이다 — 나머지는 projects의 하위라 cascade로 함께 사라진다
// (guard.ts와 같은 근거).

import { config } from 'dotenv';
import path from 'node:path';
import postgres from 'postgres';

/** helpers.createTestUser가 만드는 이메일 형식 */
const TEST_USER_EMAIL_PATTERN = 'wbs-test+%@unes.co.kr';

// 정상 실행에서 테스트 사용자의 수명은 수 초다. 2시간은 어떤 실행보다도 길어서
// "지금 돌고 있는 다른 실행의 사용자"를 지울 위험이 없다.
const STALE_AFTER = '2 hours';

export default async function setup(): Promise<void> {
  config({ path: path.resolve(__dirname, '../.env.local'), quiet: true });
  config({ path: path.resolve(__dirname, '../.env.test.local'), quiet: true });

  const url = process.env.TEST_DATABASE_URL;
  // 단위 테스트만 돌릴 때는 직결 URL이 없어도 되어야 한다 (tests/setup.ts와 같은 방침)
  if (!url) return;

  const sql = postgres(url, { max: 1, prepare: false });
  try {
    const stale = await sql<{ id: string; email: string }[]>`
      select u.id::text as id, u.email
        from public.app_users u
       where u.email like ${TEST_USER_EMAIL_PATTERN}
         and u.created_at < now() - ${STALE_AFTER}::interval`;
    if (stale.length === 0) return;

    const ids = stale.map((u) => u.id);

    // 소유 행 먼저 (created_by가 아직 살아 있을 때). projects는 cascade로 하위 전부를 끌고 간다
    const projects = await sql`delete from public.projects        where created_by = any(${ids}::uuid[]) returning id`;
    const todos = await sql`delete from public.todos           where created_by = any(${ids}::uuid[]) returning id`;
    const notes = await sql`delete from public.notes           where created_by = any(${ids}::uuid[]) returning id`;
    const profiles = await sql`delete from public.import_profiles where created_by = any(${ids}::uuid[]) returning id`;
    // 그 다음 사용자 (app_users는 FK cascade)
    await sql`delete from auth.users where id = any(${ids}::uuid[])`;

    // 조용히 지우지 않는다 — 무엇이 남아 있었는지 사람이 알아야 한다 (절대 규칙 5)
    console.warn(
      `[global-setup] 중단된 테스트 잔여물을 정리했습니다: 사용자 ${stale.length}명, ` +
        `과제 ${projects.length}건, todo ${todos.length}건, 노트 ${notes.length}건, 프로파일 ${profiles.length}건 ` +
        `(${STALE_AFTER} 이상 경과한 ${TEST_USER_EMAIL_PATTERN} 계정)`
    );
  } finally {
    await sql.end({ timeout: 5 });
  }
}
