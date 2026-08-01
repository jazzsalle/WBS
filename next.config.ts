import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Tauri 사이드카 배포용 (SOT §14.1)
  output: "standalone",
};

export default nextConfig;
