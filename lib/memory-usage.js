'use strict';

const v8 = require('v8');

// What the app process holds, in MB, read without /proc.
//
// process.memoryUsage() derives the resident set size from /proc/self, which Homey's app
// container does not provide: there it throws "ENOENT: no such file or directory,
// uv_resident_set_memory" — uncaught in a timer, that took 1.2.331 down (2026-10-11), and the
// EMS diagnostics, which caught it, never once showed their memory card on a Homey. The heap
// figures come from V8 itself and the peak RSS from getrusage(), neither of which needs /proc.
// The current RSS and PSS are in Homey's developer tools.
//
// Every figure is null when it cannot be read; this never throws.
function readMemory() {
  const mb = (bytes) => (Number.isFinite(bytes) ? Math.round((bytes / 1048576) * 10) / 10 : null);
  const out = { peakRss: null, heapUsed: null, heapTotal: null, external: null };
  try {
    const h = v8.getHeapStatistics();
    out.heapUsed  = mb(h.used_heap_size);
    out.heapTotal = mb(h.total_heap_size);
    out.external  = mb(h.external_memory);
  } catch (_) { /* left null */ }
  try {
    // maxRSS is in kilobytes.
    out.peakRss = mb(process.resourceUsage().maxRSS * 1024);
  } catch (_) { /* left null */ }
  return out;
}

module.exports = { readMemory };
