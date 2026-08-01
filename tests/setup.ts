// vitest 공용 셋업 — 환경 변수 로드만 담당한다.
//  - .env.local      : NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY (publishable — C-1 준수)
//  - .env.test.local : TEST_DATABASE_URL (postgres 직결 — 시드 적용·검증 SQL·teardown 전용, C-1 단서)
// 단위 테스트는 환경 변수 없이도 돌아야 하므로 여기서 존재를 강제하지 않는다 —
// 누락 검증은 통합 테스트 헬퍼(tests/integration/helpers.ts)가 명시적 에러로 한다.

import { config } from 'dotenv';
import path from 'node:path';

config({ path: path.resolve(__dirname, '../.env.local'), quiet: true });
config({ path: path.resolve(__dirname, '../.env.test.local'), quiet: true });
