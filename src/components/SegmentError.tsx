"use client";

import { useEffect } from "react";

/**
 * Shared App Router error UI. Next's default overlay only says "a client-side exception has
 * occurred" and hides the real message. This prints it so the next crash is diagnosable without
 * opening the console.
 */
export function SegmentError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <div className="flex min-h-0 flex-1 flex-col items-start justify-center gap-3 p-8">
      <h1 className="text-lg font-semibold text-foreground">Cette page a planté</h1>
      <p className="max-w-xl text-sm text-muted-foreground">
        {error.message || "Erreur inconnue."}
      </p>
      {error.digest ? (
        <p className="font-mono text-xs text-muted-foreground">ref {error.digest}</p>
      ) : null}
      <button
        type="button"
        onClick={() => reset()}
        className="rounded-md border border-border bg-surface px-3 py-1.5 text-sm text-foreground"
      >
        Réessayer
      </button>
    </div>
  );
}
