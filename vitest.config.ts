import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  resolve: {
    alias: { "@": path.resolve(__dirname) },
  },
  test: {
    include: ["tests/**/*.test.ts"],
    // .env.local + .env.test.local 로드. 통합 테스트의 직결 SQL 통로는 C-1 단서 참조
    setupFiles: ["tests/setup.ts"],
    // 통합 테스트(tests/integration)는 실제 dev DB 하나를 공유한다 —
    // 파일 병렬 실행 시 데이터·시드 경합이 나므로 순차 실행한다
    fileParallelism: false,
    // 네트워크(Supabase API + postgres 직결)를 타므로 여유 있게
    testTimeout: 30_000,
    hookTimeout: 120_000,
  },
});
