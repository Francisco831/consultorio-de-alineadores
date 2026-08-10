import { Skeleton } from "@/components/ui/skeleton";

export default function PipelineLoading() {
  return (
    <div className="space-y-4 p-6">
      <div className="flex items-center justify-between">
        <div className="space-y-2">
          <Skeleton className="h-6 w-28" />
          <Skeleton className="h-4 w-56" />
        </div>
        <Skeleton className="h-8 w-48" />
      </div>
      <div className="grid grid-cols-2 gap-px overflow-hidden rounded-lg border bg-border sm:grid-cols-4 lg:grid-cols-7">
        {Array.from({ length: 7 }).map((_, i) => (
          <div key={i} className="space-y-2 bg-background p-3">
            <Skeleton className="h-3 w-16" />
            <Skeleton className="h-6 w-10" />
          </div>
        ))}
      </div>
      <div className="flex gap-3 overflow-hidden pb-4">
        {Array.from({ length: 5 }).map((_, col) => (
          <div key={col} className="w-72 shrink-0 space-y-2">
            <Skeleton className="h-4 w-32" />
            <div className="space-y-2 rounded-lg bg-muted/40 p-2">
              {Array.from({ length: 3 }).map((_, card) => (
                <Skeleton key={card} className="h-24 w-full" />
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
