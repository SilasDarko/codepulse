import { registry } from "@/src/metrics/registry";

// Deliberately not wrapped in withMetrics: instrumenting the metrics
// endpoint's own latency with the histogram it's about to render is a
// needless wrinkle, not a useful signal.
export async function GET(): Promise<Response> {
  const body = await registry.metrics();
  return new Response(body, { headers: { "Content-Type": registry.contentType } });
}
