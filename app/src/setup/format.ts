/** Small formatting helpers for the setup screens. */

const GB = 1e9;
const MB = 1e6;

export function formatBytes(bytes: number): string {
  if (bytes >= GB) return `${(bytes / GB).toFixed(1)} GB`;
  if (bytes >= MB) return `${Math.round(bytes / MB)} MB`;
  return `${Math.max(0, Math.round(bytes / 1e3))} KB`;
}

export function formatSpeed(bytesPerSecond: number): string {
  return `${(bytesPerSecond / MB).toFixed(1)} MB/s`;
}

/** 0 to 100, or null when the total is not known yet. */
export function percent(received: number, total: number | null): number | null {
  if (!total || total <= 0) return null;
  return Math.min(100, Math.max(0, Math.round((received / total) * 100)));
}

/**
 * Smoothed download speed. Feed it (time in ms, bytes received so far) samples; it reports bytes
 * per second over roughly the last few seconds, or null until it has two samples.
 */
export class SpeedMeter {
  private samples: { t: number; bytes: number }[] = [];
  constructor(private readonly windowMs = 4000) {}

  add(t: number, bytes: number): number | null {
    this.samples.push({ t, bytes });
    this.samples = this.samples.filter((s) => t - s.t <= this.windowMs);
    const first = this.samples[0];
    const last = this.samples[this.samples.length - 1];
    if (!first || !last || last.t - first.t < 250) return null;
    const rate = ((last.bytes - first.bytes) / (last.t - first.t)) * 1000;
    return rate >= 0 ? rate : null;
  }

  reset(): void {
    this.samples = [];
  }
}

/**
 * Removes anything that identifies the person from error text before it is copied: home folders
 * (`/Users/name`, `C:\\Users\\name`, `/home/name`) become `~`.
 */
export function redactPersonalPaths(text: string): string {
  return (
    text
      .replace(/\/Users\/[^/\s'"]+/g, "~")
      .replace(/\/home\/[^/\s'"]+/g, "~")
      // Windows user names may contain spaces, so match up to the next backslash.
      .replace(/[A-Za-z]:\\Users\\[^\\'"]+/g, "~")
  );
}
