"use client";

import { CardSkeleton } from "@/shared/components";

// Route transition boundary for every dashboard page: while the new page's
// client code loads, the shell (sidebar + header) stays put and only the
// content area shows skeletons. Without this, Next's bottom-center action
// indicator is the only feedback during the transition.
export default function DashboardLoading() {
  return (
    <div className="flex flex-col gap-6">
      <CardSkeleton />
      <CardSkeleton />
      <CardSkeleton />
    </div>
  );
}
