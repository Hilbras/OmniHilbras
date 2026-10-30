// Shim → re-export from new SQLite-based DB layer (src/lib/db/)
export {
  statsEmitter, trackPendingRequest, getActiveRequests, getPendingRequests,
  trackClientRequest, getClientRequestCounts, pruneUsageHistory,
  saveRequestUsage, flushUsage, flushUsageRollup, getUsageHistory, getUsageStats, getChartData, getTokenSaverStats,
  appendRequestLog, getRecentLogs,
  saveRequestDetail, getRequestDetails, getRequestDetailById,
} from "@/lib/db/index.js";
