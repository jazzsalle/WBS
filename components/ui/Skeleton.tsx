// 화면 전환 즉시 보이는 자리표시 (SOT §12 성능 — loading.tsx). 데이터 모양을 흉내 낼 뿐
// 숫자를 지어내지 않는다 — 회색 블록만 그린다.
export function SkeletonBlock({ className = '' }: { className?: string }) {
  return <div aria-hidden className={`animate-pulse rounded-lg bg-grey-200 ${className}`} />;
}

/** 제목 한 줄 + 카드 몇 개 — 목록·개요형 화면 공통 */
export default function PageSkeleton({ cards = 3, title = true }: { cards?: number; title?: boolean }) {
  return (
    <div role="status" aria-label="불러오는 중" className="mx-auto max-w-7xl px-8 py-8">
      {title && <SkeletonBlock className="mb-6 h-8 w-48" />}
      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
        {Array.from({ length: cards }, (_, i) => (
          <div key={i} className="rounded-xl border border-hairline bg-surface p-5">
            <SkeletonBlock className="h-5 w-2/3" />
            <SkeletonBlock className="mt-3 h-4 w-full" />
            <SkeletonBlock className="mt-2 h-4 w-5/6" />
            <SkeletonBlock className="mt-4 h-2 w-full" />
          </div>
        ))}
      </div>
      <span className="sr-only">불러오는 중</span>
    </div>
  );
}

/** 표형 화면(WBS·연구비·인력 등) — 머리행 + 행 여러 개 */
export function TableSkeleton({ rows = 8 }: { rows?: number }) {
  return (
    <div role="status" aria-label="불러오는 중" className="mx-auto max-w-7xl px-8 py-6">
      <div className="mb-4 flex items-center gap-3">
        <SkeletonBlock className="h-8 w-40" />
        <SkeletonBlock className="h-8 w-24" />
        <SkeletonBlock className="ml-auto h-8 w-32" />
      </div>
      <div className="rounded-xl border border-hairline bg-surface p-4">
        <SkeletonBlock className="h-4 w-full" />
        {Array.from({ length: rows }, (_, i) => (
          <SkeletonBlock key={i} className="mt-3 h-4" />
        ))}
      </div>
      <span className="sr-only">불러오는 중</span>
    </div>
  );
}
