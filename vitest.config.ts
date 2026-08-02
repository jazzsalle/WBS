// 기본 실행(`npm test`) — 단위 + 통합. 자기가 만든 데이터만 지우는 테스트만 들어온다.
//
// tests/destructive/는 여기서 제외한다: 전체 복원(§8.7 K-7)은 dev DB의 전 행을 지우고
// 백업 시점으로 되돌리므로, 다른 PC에서 그 사이 입력한 실데이터가 사라진다.
// 파괴적 테스트는 `npm run test:destructive`로만 명시적으로 돌린다.

import { defineConfig } from 'vitest/config';
import { sharedConfig } from './vitest.shared';

export default defineConfig({
  ...sharedConfig,
  test: {
    ...sharedConfig.test,
    include: ['tests/unit/**/*.test.ts', 'tests/integration/**/*.test.ts'],
  },
});
