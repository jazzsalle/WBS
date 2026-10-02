import type { NextConfig } from "next";

// A-2: 허용 도메인은 빌드 시점에 인라인한다 (SOT §14.2 A-2).
// Next standalone은 .env*를 싣지 않고 Tauri 사이드카는 별도 env 없이 뜨므로,
// 런타임 process.env 읽기로 두면 번들에서만 미들웨어가 500을 낸다.
// 미설정을 조용히 넘기지 않는다 — 빌드 머신의 .env.local에 없으면 여기서 멈춘다.
const allowedEmailDomain = process.env.ALLOWED_EMAIL_DOMAIN?.trim();
if (!allowedEmailDomain) {
  throw new Error(
    "ALLOWED_EMAIL_DOMAIN 환경 변수가 없습니다. .env.local에 회사 이메일 도메인을 설정하세요 (SOT §14.2 A-2).",
  );
}

const nextConfig: NextConfig = {
  // Tauri 사이드카 배포용 (SOT §14.1)
  output: "standalone",
  env: {
    ALLOWED_EMAIL_DOMAIN: allowedEmailDomain,
  },
  // 제출 서식 템플릿(SOT §6.12 X-1)은 런타임에 fs로 읽는다 — 정적 분석으로는 보이지 않아
  // standalone 산출물에서 통째로 빠진다. 빠지면 내보내기가 실행 시점에야 실패한다.
  // 도움말·따라하기 본문(content/, §7.16 HP-1)도 같은 이유다 — 빠지면 /help가 통째로 사라진다
  outputFileTracingIncludes: {
    "/**": ["./templates/**", "./content/**"],
  },
  experimental: {
    serverActions: {
      // 업로드 상한은 파일 10MB(MAX_UPLOAD_BYTES, SOT §6.8 I-15·§5.21 AV-7)다. 기본 1MB로 두면
      // 그보다 작은 파일도 어댑터에 닿기 전에 잘려, 사용자가 상한 안내 대신 알 수 없는 실패를 본다.
      // multipart 경계·다른 필드 몫으로 1MB 여유를 둔다
      bodySizeLimit: "11mb",
    },
  },
};

export default nextConfig;
