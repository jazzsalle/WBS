// 승인 대기 페이지 (SOT §7.0). 미들웨어가 active=false 사용자만 여기로 보내지만,
// 직접 접근·상태 변화 직후를 위해 서버에서도 한 번 더 판정한다.

import { redirect } from 'next/navigation';
import { getCurrentUser } from '@/actions/auth';
import PendingScreen from '@/components/auth/PendingScreen';

export default async function PendingPage() {
  const res = await getCurrentUser();
  if (!res.ok) redirect('/login');
  if (res.data.active) redirect('/');
  return <PendingScreen email={res.data.email} />;
}
