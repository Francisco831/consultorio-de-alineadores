import { Skeleton } from "@/components/ui/skeleton";

export default function DashboardLoading() {
  return (
    <div className="space-y-6 p-6">
      <div className="space-y-2">
        <Skeleton className="h-6 w-32" />
        <Skeleton className="h-4 w-28" />
      </div>
      <div className="grid grid-cols-2 gap-px overflow-hidden rounded-lg border bg-border sm:grid-cols-3 lg:grid-cols-6">
        {Array.from({ length: 6 }).map((_, i) => (
          <div key={i} className="space-y-2 bg-background p-4">
            <Skeleton className="h-3 w-20" />
            <Skeleton className="h-7 w-14" />
          </div>
        ))}
      </div>
      <div className="rounded-lg border">
        <div className="space-y-2 border-b px-4 py-3">
          <Skeleton className="h-4 w-40" />
          <Skeleton className="h-3 w-24" />
        </div>
        <div className="p-4">
          <Skeleton className="h-64 w-full" />
        </div>
      </div>
      <div className="grid gap-6 lg:grid-cols-2">
        {Array.from({ length: 2 }).map((_, i) => (
          <div key={i} className="rounded-lg border">
            <div className="space-y-2 border-b px-4 py-3">
              <Skeleton className="h-4 w-44" />
              <Skeleton className="h-3 w-16" />
            </div>
            <div className="space-y-3 p-4">
              {Array.from({ length: 5 }).map((_, row) => (
                <Skeleton key={row} className="h-5 w-full" />
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
