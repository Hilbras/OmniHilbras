import { cpus, freemem, loadavg, totalmem, uptime } from 'node:os';

/**
 * CPU and memory of the machine the gateway runs on.
 *
 * A percentage is a measurement over an interval, not a value a single `os.cpus()` read can produce:
 * its counters start at boot. So two reads 120 ms apart are what turn those counters into "how busy
 * is this machine now". The same read is shared by concurrent callers, because two dashboard polls
 * arriving together should not double the work or disagree about the same instant.
 */
export type HostSystemStats = {
  sampledAt: string;
  cpu: {
    /** Busy share over the sample interval, 0–100, rounded to one decimal. */
    percent: number;
    cores: number;
    /** 1/5/15-minute run-queue averages. Always `[0, 0, 0]` on Windows. */
    loadAverage: [number, number, number];
  };
  memory: {
    totalBytes: number;
    usedBytes: number;
    freeBytes: number;
    /** Used share of total, 0–100, rounded to one decimal. */
    percent: number;
  };
  /** Host uptime, not the gateway process's uptime. */
  uptimeSeconds: number;
};

type CpuCounters = { idle: number; total: number };

/** One machine-wide sample; `idle` is what a busy percentage is the complement of. */
function cpuCounters(): CpuCounters {
  let idle = 0;
  let total = 0;
  for (const cpu of cpus()) {
    const times = cpu.times;
    idle += times.idle;
    total += times.user + times.nice + times.sys + times.idle + times.irq;
  }
  return { idle, total };
}

const round = (value: number) => Math.round(value * 10) / 10;
const clampPercent = (value: number) => Math.min(100, Math.max(0, round(value)));

let inFlight: Promise<HostSystemStats> | undefined;

export function readHostSystemStats(): Promise<HostSystemStats> {
  if (!inFlight) {
    inFlight = sampleHostSystem().finally(() => {
      inFlight = undefined;
    });
  }
  return inFlight;
}

async function sampleHostSystem(): Promise<HostSystemStats> {
  const start = cpuCounters();
  // Long enough to cover a scheduling slice, short enough that a two-second dashboard poll does not
  // visibly wait on it. The counters are cumulative, so the delta is the machine's activity now.
  await new Promise((resolve) => setTimeout(resolve, 120));
  const end = cpuCounters();

  const totalDelta = end.total - start.total;
  const idleDelta = end.idle - start.idle;
  const cpuPercent = totalDelta > 0 ? clampPercent(((totalDelta - idleDelta) / totalDelta) * 100) : 0;

  const totalBytes = totalmem();
  const freeBytes = freemem();
  const usedBytes = Math.max(0, totalBytes - freeBytes);
  const memoryPercent = totalBytes > 0 ? clampPercent((usedBytes / totalBytes) * 100) : 0;
  const averages = loadavg();

  return {
    sampledAt: new Date().toISOString(),
    cpu: {
      percent: cpuPercent,
      cores: cpus().length,
      loadAverage: [averages[0] ?? 0, averages[1] ?? 0, averages[2] ?? 0],
    },
    memory: {
      totalBytes,
      usedBytes,
      freeBytes,
      percent: memoryPercent,
    },
    uptimeSeconds: Math.floor(uptime()),
  };
}
