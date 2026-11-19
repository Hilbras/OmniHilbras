/**
 * Loading shapes.
 *
 * One generic skeleton is why every route looked like the same three grey blocks. A page that knows
 * its own layout should say that shape; this component is the one place the animation and the
 * reduced-motion rule live.
 */
export function Skeleton({ className = '' }: { className?: string }) {
  return <div aria-hidden="true" className={`animate-pulse rounded-md bg-surface ${className}`} />;
}

export function StatSkeleton() {
  return (
    <div className="card p-4" aria-busy="true">
      <Skeleton className="h-2.5 w-24" />
      <Skeleton className="mt-3 h-6 w-20" />
      <Skeleton className="mt-2 h-2 w-16" />
    </div>
  );
}

export function TableSkeleton({ rows = 4 }: { rows?: number }) {
  return (
    <div className="space-y-2 p-4" aria-busy="true">
      {Array.from({ length: rows }, (_, index) => (
        <Skeleton key={index} className="h-8 w-full" />
      ))}
    </div>
  );
}
