import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Tauri 사이드카 배포용 (SOT §14.1)
  output: "standalone",
  // 제출 서식 템플릿(SOT §6.12 X-1)은 런타임에 fs로 읽는다 — 정적 분석으로는 보이지 않아
  // standalone 산출물에서 통째로 빠진다. 빠지면 내보내기가 실행 시점에야 실패한다.
  // 도움말·따라하기 본문(content/, §7.16 HP-1)도 같은 이유다 — 빠지면 /help가 통째로 사라진다
  outputFileTracingIncludes: {
    "/**": ["./templates/**", "./content/**"],
  },
};

export default nextConfig;
