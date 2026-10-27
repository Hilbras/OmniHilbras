import { NextResponse } from "next/server";
import { updateSettings } from "@/lib/localDb";
import { getObservabilityConfig, invalidateObservabilityConfig, isObservabilityForcedOff } from "@/lib/requestDetailsDb";

export const dynamic = "force-dynamic";

// settings key → [min, max]. maxJsonSize is in KB, like the stored setting.
const NUMERIC_FIELDS = {
  maxRecords: ["observabilityMaxRecords", 10, 100000],
  batchSize: ["observabilityBatchSize", 1, 500],
  flushIntervalMs: ["observabilityFlushIntervalMs", 100, 60000],
  maxJsonSize: ["observabilityMaxJsonSize", 1, 1024],
};

async function readConfig() {
  const config = await getObservabilityConfig();
  return {
    enabled: config.enabled,
    maxRecords: config.maxRecords,
    batchSize: config.batchSize,
    flushIntervalMs: config.flushIntervalMs,
    maxJsonSize: Math.round(config.maxJsonSize / 1024),
    // OBSERVABILITY_ENABLED=false forces recording off; the dashboard says so
    // instead of showing a toggle that silently does nothing.
    envOverride: isObservabilityForcedOff(),
  };
}

export async function GET() {
  try {
    return NextResponse.json(await readConfig());
  } catch (error) {
    console.error("[API] Failed to get observability settings:", error);
    return NextResponse.json({ error: "Failed to get observability settings" }, { status: 500 });
  }
}

export async function PATCH(request) {
  let body;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const updates = {};
  if (body.enabled !== undefined) {
    if (typeof body.enabled !== "boolean") {
      return NextResponse.json({ error: "enabled must be a boolean" }, { status: 400 });
    }
    updates.enableObservability = body.enabled;
  }
  for (const [field, [settingKey, min, max]] of Object.entries(NUMERIC_FIELDS)) {
    if (body[field] === undefined) continue;
    const value = Number(body[field]);
    if (!Number.isInteger(value) || value < min || value > max) {
      return NextResponse.json({ error: `${field} must be an integer between ${min} and ${max}` }, { status: 400 });
    }
    updates[settingKey] = value;
  }
  if (Object.keys(updates).length === 0) {
    return NextResponse.json({ error: "No valid fields to update" }, { status: 400 });
  }

  try {
    await updateSettings(updates);
    invalidateObservabilityConfig();
    return NextResponse.json(await readConfig());
  } catch (error) {
    console.error("[API] Failed to update observability settings:", error);
    return NextResponse.json({ error: "Failed to update observability settings" }, { status: 500 });
  }
}
