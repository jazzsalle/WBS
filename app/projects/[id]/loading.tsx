// 과제 레이아웃(헤더·탭)은 그대로 두고 탭 본문 자리만 스켈레톤 — 탭 전환이 즉시 반응한다
import { TableSkeleton } from '@/components/ui/Skeleton';

export default function Loading() {
  return <TableSkeleton rows={10} />;
}
