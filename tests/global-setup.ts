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
//
// 그런데 소유자 기반 청소만으로는 못 잡는 부류가 있다: 정상 종료한 테스트가 afterAll에서
// 사용자를 지우면 그 순간 소유 행의 created_by가 null이 되어(N-8) 소유자를 잃는다.
// 그래서 destroyTestUser가 사용자를 지우기 직전에 표식(TEST_ROW_MARK)을 찍고,
// 여기서 그 표식으로 한 번 더 훑는다. 두 통로는 겹치지 않고 보완 관계다.

import { config } from 'dotenv';
import path from 'node:path';
import postgres, { type Sql } from 'postgres';
import { TEST_ROW_MARK_PATTERN } from './test-marker';

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

    if (stale.length > 0) {
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
    }

    await cleanupMarkedOrphans(sql);
  } finally {
    await sql.end({ timeout: 5 });
  }
}

// 소유자가 이미 끊긴(created_by is null) 표식 행을 지운다.
//
// 세 조건을 모두 만족할 때만 지운다 — 하나라도 빼면 오판 여지가 생긴다:
//  ① 라벨 컬럼이 TEST_ROW_MARK로 시작 — 표식은 "테스트 사용자 소유임이 증명된 행"에만 찍힌다
//  ② created_by is null — 소유자가 살아 있으면 위의 소유자 기반 통로가 판단할 몫이다.
//     실사용자가 소유한 행은 표식이 붙어 있어도 여기서 절대 건드리지 않는다
//  ③ 2시간 경과 — 지금 돌고 있는 다른 실행이 방금 표식을 찍었을 가능성을 배제한다
async function cleanupMarkedOrphans(sql: Sql): Promise<void> {
  const projects = await sql`
    delete from public.projects
     where project_no like ${TEST_ROW_MARK_PATTERN}
       and created_by is null
       and created_at < now() - ${STALE_AFTER}::interval returning id`;
  const todos = await sql`
    delete from public.todos
     where title like ${TEST_ROW_MARK_PATTERN}
       and created_by is null
       and created_at < now() - ${STALE_AFTER}::interval returning id`;
  const notes = await sql`
    delete from public.notes
     where title like ${TEST_ROW_MARK_PATTERN}
       and created_by is null
       and created_at < now() - ${STALE_AFTER}::interval returning id`;
  const profiles = await sql`
    delete from public.import_profiles
     where name like ${TEST_ROW_MARK_PATTERN}
       and created_by is null
       and created_at < now() - ${STALE_AFTER}::interval returning id`;

  const total = projects.length + todos.length + notes.length + profiles.length;
  if (total === 0) return;

  console.warn(
    `[global-setup] 소유자가 끊긴 테스트 잔여물을 표식으로 정리했습니다: ` +
      `과제 ${projects.length}건, todo ${todos.length}건, 노트 ${notes.length}건, 프로파일 ${profiles.length}건`
  );
}
