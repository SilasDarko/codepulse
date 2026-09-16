import { test, expect } from "@playwright/test";

test("dashboard renders", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("link", { name: "CodePulse" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Open incidents" })).toBeVisible();
});

test("golden path: ingest a deployment + health event, then view the incident's evidence page", async ({ page, request }) => {
  const suffix = Date.now();

  const repoRes = await request.post("/api/repos", { data: { owner: "e2e", name: `widgets-${suffix}` } });
  expect(repoRes.status()).toBe(201);
  const repo = await repoRes.json();

  const serviceRes = await request.post("/api/services", {
    data: { repoId: repo.id, name: "web", pathPatterns: ["src/**"] },
  });
  expect(serviceRes.status()).toBe(201);
  const service = await serviceRes.json();

  const deployRes = await request.post("/api/deployments", {
    data: {
      serviceId: service.id,
      externalId: `deploy-${suffix}`,
      toSha: "e2e0000000000000000000000000000000000e2",
      status: "succeeded",
      startedAt: new Date(Date.now() - 5 * 60_000).toISOString(),
      completedAt: new Date(Date.now() - 4 * 60_000).toISOString(),
    },
  });
  expect(deployRes.status()).toBe(201);

  const healthRes = await request.post("/api/health-events", {
    data: { serviceId: service.id, externalId: `health-${suffix}`, status: "down", observedAt: new Date().toISOString() },
  });
  expect(healthRes.status()).toBe(201);
  const { incidentId } = await healthRes.json();
  expect(incidentId).not.toBeNull();

  // Dashboard should now list this open incident.
  await page.goto("/");
  await expect(page.getByRole("link", { name: "view evidence →" }).first()).toBeVisible();

  // Trigger correlation, then view the incident's evidence page.
  const correlateRes = await request.post(`/api/incidents/${incidentId}/correlate`);
  expect(correlateRes.status()).toBe(200);

  await page.goto(`/incidents/${incidentId}`);
  await expect(page.getByRole("heading", { name: `Incident #${incidentId} — web` })).toBeVisible();
  await expect(page.getByText("first unhealthy at")).toBeVisible();

  // Repo timeline should show both the deployment and the health event.
  await page.goto(`/repos/${repo.id}`);
  await expect(page.getByText(/deploy web ->/)).toBeVisible();
  await expect(page.getByText("web is down")).toBeVisible();
});

test("an incident that does not exist renders Next's not-found page instead of crashing", async ({ page }) => {
  const res = await page.goto("/incidents/999999999");
  expect(res?.status()).toBe(404);
});
