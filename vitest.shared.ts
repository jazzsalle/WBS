// 기본 실행(vitest.config.ts)과 파괴적 실행(vitest.destructive.config.ts)이 공유하는 설정.
// include만 두 파일이 각자 정하고 나머지는 여기 한 곳에서 관리한다 —
// 두 설정이 갈라지면 "기본에서는 통과, 파괴적에서는 실패" 같은 재현 불가 상황이 생긴다.

import path from 'node:path';
import type { ViteUserConfig } from 'vitest/config';

export const sharedConfig: ViteUserConfig = {
  resolve: {
    alias: {
      '@': path.resolve(__dirname),
      // I-13: lib/import-adapter.ts는 `import 'server-only'`로 클라이언트 번들 유입을 막는다.
      // 그 모듈은 Next 번들러만 해석하므로 노드에서 도는 단위 테스트용 빈 모듈로 바꿔 준다
      'server-only': path.resolve(__dirname, 'tests/stubs/server-only.ts'),
    },
  },
  test: {
    // .env.local + .env.test.local 로드. 통합 테스트의 직결 SQL 통로는 C-1 단서 참조
    setupFiles: ['tests/setup.ts'],
    // 실행 1회. 중단된 이전 실행이 dev DB에 남긴 테스트 사용자·과제를 먼저 치운다 —
    // 그대로 두면 다음 실행에서 "테스트 소유가 아닌 데이터"로 보여 파괴적 테스트 가드를 막는다
    globalSetup: ['tests/global-setup.ts'],
    // 통합 테스트(tests/integration)는 실제 dev DB 하나를 공유한다 —
    // 파일 병렬 실행 시 데이터·시드 경합이 나므로 순차 실행한다
    fileParallelism: false,
    // 네트워크(Supabase API + postgres 직결)를 타므로 여유 있게
    testTimeout: 30_000,
    hookTimeout: 120_000,
  },
};
