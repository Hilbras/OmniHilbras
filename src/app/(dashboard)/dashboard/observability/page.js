"use client";

import { Suspense } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import { CardSkeleton, SegmentedControl } from "@/shared/components";
import LogsTab from "./components/LogsTab";
import MetricsTab from "./components/MetricsTab";
import SettingsTab from "./components/SettingsTab";

const TABS = [
  { value: "logs", label: "Logs" },
  { value: "metrics", label: "Metrics" },
  { value: "settings", label: "Settings" },
];

export default function ObservabilityPage() {
  return (
    <Suspense fallback={<CardSkeleton />}>
      <ObservabilityContent />
    </Suspense>
  );
}

function ObservabilityContent() {
  const searchParams = useSearchParams();
  const router = useRouter();

  const tabFromUrl = searchParams.get("tab");
  const activeTab = TABS.some((t) => t.value === tabFromUrl) ? tabFromUrl : "logs";

  const handleTabChange = (value) => {
    if (value === activeTab) return;
    const params = new URLSearchParams(searchParams);
    params.set("tab", value);
    router.push(`/dashboard/observability?${params.toString()}`, { scroll: false });
  };

  return (
    <div className="flex min-w-0 flex-col gap-6 px-1 sm:px-0">
      <SegmentedControl
        options={TABS}
        value={activeTab}
        onChange={handleTabChange}
        className="w-full sm:w-auto self-start"
      />
      {activeTab === "logs" && <LogsTab />}
      {activeTab === "metrics" && <MetricsTab />}
      {activeTab === "settings" && <SettingsTab />}
    </div>
  );
}
