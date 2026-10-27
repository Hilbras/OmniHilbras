// Shim → re-export from observability-aware DB layer (src/lib/db/)
export {
  saveRequestDetail, saveRequestDetails,
  getRequestDetails, getRequestLogEntries,
  getRequestDetailById, getRequestLogDetailById,
  deleteRequestLogById, deleteRequestLogBatch, deleteRequestLogsBefore, clearAllRequestLogs,
  getDistinctProviders, getDistinctModels, getDistinctConnections,
  getObservabilityConfig, invalidateObservabilityConfig, getObservabilityStats,
} from "@/lib/db/index.js";
