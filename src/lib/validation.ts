import { z } from "zod";

// These are the payload shapes POST /api/deployments and POST /api/health-events
// accept. A real deploy tool or APM would resolve service-by-name itself and
// send serviceId; this project doesn't build that resolution step since it's
// not part of the correlation logic the interview needs to focus on.

export const deploymentStepSchema = z.object({
  name: z.string().min(1),
  status: z.string().min(1),
  startedAt: z.string().datetime().nullable().optional(),
  completedAt: z.string().datetime().nullable().optional(),
});

export const deploymentEventSchema = z.object({
  serviceId: z.number().int().positive(),
  externalId: z.string().min(1),
  fromSha: z.string().min(1).nullable().optional(),
  toSha: z.string().min(1),
  status: z.enum(["in_progress", "succeeded", "failed", "rolled_back"]),
  startedAt: z.string().datetime(),
  completedAt: z.string().datetime().nullable().optional(),
  steps: z.array(deploymentStepSchema).optional(),
});

export type DeploymentEventInput = z.infer<typeof deploymentEventSchema>;

export const healthEventSchema = z.object({
  serviceId: z.number().int().positive(),
  externalId: z.string().min(1),
  status: z.enum(["healthy", "degraded", "down"]),
  metricName: z.string().nullable().optional(),
  metricValue: z.number().nullable().optional(),
  observedAt: z.string().datetime(),
  source: z.string().default("manual"),
});

export type HealthEventInput = z.infer<typeof healthEventSchema>;
