import { cn } from "@/lib/utils"

function Skeleton({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="skeleton"
      className={cn("animate-pulse rounded-md bg-muted", className)}
      {...props}
    />
  )
}

/**
 * RowSkeleton - a loading placeholder shaped like one DataTable row (ds.tsx): same height
 * (`--row-h`), padding, and border as a real row, with `columns` equal-width bars standing in for
 * cell content (A10). Used wherever a list backed by a table-like grid is loading for the first time
 * - not a DataTable prop itself (DataTable's own rows already render instantly from server-fetched
 * data), but a drop-in for the "Chargement…" text branches call sites used before their data arrives.
 */
function RowSkeleton({ columns = 4, className }: { columns?: number; className?: string }) {
  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: `repeat(${columns}, 1fr)`,
        gap: 12,
        padding: "0 12px",
        height: "var(--row-h)",
        alignItems: "center",
        borderBottom: "1px solid var(--color-border)",
      }}
    >
      {Array.from({ length: columns }).map((_, i) => (
        <Skeleton key={i} className={cn("h-3 w-full max-w-[85%]", className)} />
      ))}
    </div>
  )
}

/**
 * SheetSkeleton - a loading placeholder shaped like PlayerSheet's body (components/PlayerSheet.tsx):
 * status dot + name line, a secondary meta line, a tab strip, and a handful of content lines (A10).
 * Replaces the plain "Chargement…" text while `loadPlayerSheet` is in flight.
 */
function SheetSkeleton() {
  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
      <div style={{ padding: "14px 16px 0", flexShrink: 0 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <Skeleton className="h-2 w-2 shrink-0 rounded-full" />
          <Skeleton className="h-4 w-40" />
        </div>
        <Skeleton className="mt-2 h-3 w-52" />
        <div style={{ display: "flex", gap: 10, marginTop: 12, paddingBottom: 10, borderBottom: "1px solid var(--color-border)" }}>
          {Array.from({ length: 5 }).map((_, i) => (
            <Skeleton key={i} className="h-3 w-14" />
          ))}
        </div>
      </div>
      <div style={{ padding: 16, display: "flex", flexDirection: "column", gap: 10 }}>
        {Array.from({ length: 6 }).map((_, i) => (
          <Skeleton key={i} className="h-4 w-full" />
        ))}
      </div>
    </div>
  )
}

export { Skeleton, RowSkeleton, SheetSkeleton }
