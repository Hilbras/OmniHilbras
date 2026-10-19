"use client";

import { Button } from "@/shared/components";

export default function DashboardSegmentError({ error, reset }) {
  return (
    <div className="flex min-h-[60vh] items-center justify-center px-4 py-10">
      <div className="flex w-full max-w-md flex-col items-center gap-3 rounded-xl border border-border bg-surface p-6 text-center">
        <span className="material-symbols-outlined text-[28px] text-red-500">error</span>
        <div>
          <h2 className="text-lg font-semibold mb-1">Something went wrong</h2>
          <p className="text-sm text-text-muted break-words">
            {error?.message || "An unexpected error occurred."}
          </p>
        </div>
        <Button onClick={reset}>Try again</Button>
      </div>
    </div>
  );
}
