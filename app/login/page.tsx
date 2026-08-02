// 로그인 페이지 (SOT §7.0). 에러 코드는 미들웨어(?error=domain)와 콜백 흐름이
// 쿼리로 넘긴다 — 서버에서 읽어 props로 전달하고, 화면 자체는 클라이언트 컴포넌트다.

import LoginScreen from '@/components/auth/LoginScreen';

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; detail?: string }>;
}) {
  const params = await searchParams;
  return (
    <LoginScreen errorCode={params.error ?? null} errorDetail={params.detail ?? null} />
  );
}
