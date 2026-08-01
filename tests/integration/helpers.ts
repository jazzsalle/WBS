// 통합 테스트 공용 헬퍼 (SOT §8.2 C-1 단서)
//
// 두 개의 통로를 쓴다:
//  1. postgres 직결(TEST_DATABASE_URL, .env.test.local) — 시드 적용, 연쇄 삭제 결과 확인,
//     테스트 사용자 생성·정리 같은 "검증용 SQL" 전용. postgres role은 RLS·보호 트리거를
//     우회하므로 앱 동작 검증에는 쓰지 않는다.
//  2. publishable(anon) 키 + 실제 auth 세션 — 리포지토리에 주입해 RLS 경로까지 실제로 검증한다.
//
// 테스트 사용자 생성은 auth.signUp 대신 직결 SQL로 auth.users에 직접 넣는다:
//  - 이 프로젝트는 이메일 확인이 켜져 있어 signUp마다 실제 확인 메일이 발송된다
//    (기본 SMTP는 시간당 2통 제한 — 반복 실행이 곧 깨진다). GoTrue가 example.com류
//    주소를 거부하는 문제도 있다.
//  - SQL insert도 handle_new_user 트리거(AFTER INSERT)를 그대로 태우므로
//    app_users 부트스트랩 경로는 동일하게 검증된다.
//  - 로그인은 signInWithPassword로 실제 세션 토큰을 받는다 — API 경로는 진짜다.

import { randomUUID } from 'node:crypto';
import path from 'node:path';
import postgres, { type Sql } from 'postgres';
import type { SupabaseClient } from '@supabase/supabase-js';
import { createServerClient } from '@/lib/db/client';

// supabase/seed.sql의 고정 UUID (부록 B.1 구조)
export const SEED = {
  projectId: 'aaaa0000-0000-4000-8000-000000000001',
  stageId: 'aaaa0000-0000-4000-8000-000000000011',
  year1Id: 'aaaa0000-0000-4000-8000-000000000021',
  year2Id: 'aaaa0000-0000-4000-8000-000000000022',
  taskIds: {
    requirements: 'aaaa0000-0000-4000-8000-000000000031', // 요구사항 분석 (루트, est 40)
    literature: 'aaaa0000-0000-4000-8000-000000000032',   // 문헌조사 (est 16, done)
    definition: 'aaaa0000-0000-4000-8000-000000000033',   // 요구사항 정의 (est 24, done)
    model: 'aaaa0000-0000-4000-8000-000000000034',        // 모델 개발 (루트, est 100)
    dataset: 'aaaa0000-0000-4000-8000-000000000035',      // 데이터 구축 (est 40, 100%)
    tuning: 'aaaa0000-0000-4000-8000-000000000036',       // 학습·튜닝 (est 60, 30%)
    integration: 'aaaa0000-0000-4000-8000-000000000037',  // 시스템 통합 (루트, est 50, 0%)
  },
} as const;

// §5.12 비목 12종 — create_year 자동 생성 검증용
export const ALL_BUDGET_CATEGORIES = [
  'personnel', 'student_personnel', 'facility_equipment', 'material',
  'consignment', 'international', 'burden', 'activity',
  'promotion', 'allowance', 'indirect', 'other',
] as const;

export function connectDirectDb(): Sql {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) {
    // 에러 무음 처리 금지 — 설정 누락은 즉시 명시적으로 실패시킨다
    throw new Error('TEST_DATABASE_URL 환경 변수가 없습니다. .env.test.local을 확인하세요.');
  }
  // 통합 테스트는 파일 단위 순차 실행이라 연결 1개면 충분하다
  return postgres(url, { ssl: 'require', max: 1, onnotice: () => undefined });
}

export async function applySeed(sql: Sql): Promise<void> {
  await sql.file(path.resolve(__dirname, '../../supabase/seed.sql'));
}

export async function removeSeed(sql: Sql): Promise<void> {
  await sql`delete from public.projects where id = ${SEED.projectId}::uuid`;
}

export interface TestUser {
  id: string;
  email: string;
  accessToken: string;
  /** publishable 키 + 실제 세션 토큰 — 리포지토리에 주입하면 RLS 경로가 실제로 검증된다 */
  client: SupabaseClient;
}

// auth.users에 직접 삽입(위 파일 주석 참조) → handle_new_user 트리거가 app_users 행을 만든다.
// 첫 사용자 자동 승인 시맨틱을 오염시키지 않도록 active는 항상 직결 SQL로 명시 설정한다.
export async function createTestUser(sql: Sql): Promise<TestUser> {
  const email = `wbs-test+${Date.now()}-${randomUUID().slice(0, 8)}@unes.co.kr`;
  const password = `Pw-${randomUUID()}`;

  const inserted = await sql`
    insert into auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
      raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
      confirmation_token, recovery_token, email_change, email_change_token_new, email_change_token_current,
      phone_change, phone_change_token, reauthentication_token, is_sso_user, is_anonymous)
    values ('00000000-0000-0000-0000-000000000000', gen_random_uuid(), 'authenticated', 'authenticated',
      ${email}::text, extensions.crypt(${password}::text, extensions.gen_salt('bf')), now(),
      '{"provider":"email","providers":["email"]}', '{}', now(), now(),
      '', '', '', '', '', '', '', '', false, false)
    returning id`;
  const id = (inserted[0] as { id: string }).id;

  await sql`
    insert into auth.identities (id, user_id, identity_data, provider, provider_id,
      last_sign_in_at, created_at, updated_at)
    values (gen_random_uuid(), ${id}::uuid,
      jsonb_build_object('sub', ${id}::text, 'email', ${email}::text, 'email_verified', true),
      'email', ${id}::text, now(), now(), now())`;

  // 승인(active=true)은 postgres role이라 app_users_guard(authenticated 한정)를 우회한다
  const approved = await sql`
    update public.app_users set active = true where id = ${id}::uuid returning id`;
  if (approved.length !== 1) {
    throw new Error('handle_new_user 트리거가 app_users 행을 만들지 않았습니다.');
  }

  const anon = createServerClient();
  const { data, error } = await anon.auth.signInWithPassword({ email, password });
  if (error || !data.session) {
    throw new Error(`테스트 사용자 로그인 실패: ${error?.message ?? '세션 없음'}`);
  }

  const accessToken = data.session.access_token;
  return { id, email, accessToken, client: createServerClient(accessToken) };
}

// auth.users 삭제 → app_users는 FK cascade, 각 행의 created_by/updated_by는 set null.
export async function destroyTestUser(sql: Sql, user: TestUser): Promise<void> {
  await sql`delete from auth.users where id = ${user.id}::uuid`;
}
