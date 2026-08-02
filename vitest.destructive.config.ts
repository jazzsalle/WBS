// 파괴적 실행(`npm run test:destructive`) — dev DB의 전 행을 지웠다 되돌리는 테스트 전용.
// 사람이 명시적으로 부를 때만 돌아야 한다. 시작 전 실데이터 감지 가드(tests/destructive/guard.ts)가
// 테스트 소유가 아닌 데이터를 발견하면 실행을 거부한다.

import { defineConfig } from 'vitest/config';
import { sharedConfig } from './vitest.shared';

export default defineConfig({
  ...sharedConfig,
  test: {
    ...sharedConfig.test,
    include: ['tests/destructive/**/*.test.ts'],
  },
});
