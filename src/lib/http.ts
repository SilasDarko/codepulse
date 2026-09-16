import { NextResponse } from "next/server";
import { apiRequestDurationSeconds } from "@/src/metrics/registry";

/**
 * Wraps a route handler so every request's latency lands in the
 * apiRequestDurationSeconds histogram, labeled by route/method/status --
 * this is what scripts/benchmark.ts's "API p50/p95" numbers and Prometheus
 * both read. One wrapper, applied at each route's export, instead of timing
 * code duplicated into every handler.
 */
/**
 * Generic over any extra arguments so it works for both static routes
 * (handler(req)) and Next's dynamic routes (handler(req, { params })).
 */
export function withMetrics<Args extends unknown[]>(
  route: string,
  handler: (req: Request, ...args: Args) => Promise<Response>,
) {
  return async (req: Request, ...args: Args): Promise<Response> => {
    const stopTimer = apiRequestDurationSeconds.startTimer({ route, method: req.method });
    let status = 500;
    try {
      const res = await handler(req, ...args);
      status = res.status;
      return res;
    } finally {
      stopTimer({ status: String(status) });
    }
  };
}

export function jsonError(message: string, status: number, details?: unknown): NextResponse {
  return NextResponse.json({ error: message, details }, { status });
}
