import { createServer } from "node:http";
import { registry } from "@/src/metrics/registry";

/**
 * The worker is a separate OS process from the Next.js app, so it has its
 * own prom-client registry in memory -- the app's GET /api/metrics can't see
 * worker-only metrics like worker_lag_seconds. Instead the worker exposes
 * its own tiny /metrics endpoint and Prometheus scrapes both processes as
 * separate targets (see prometheus.yml). No framework: this is the entire
 * surface area a metrics endpoint needs.
 */
export function startMetricsServer(port: number): void {
  const server = createServer(async (req, res) => {
    if (req.url === "/metrics") {
      res.setHeader("Content-Type", registry.contentType);
      res.end(await registry.metrics());
      return;
    }
    res.statusCode = 404;
    res.end("not found");
  });
  server.listen(port);
}
