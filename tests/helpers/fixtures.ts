import { db } from "@/src/db/client";
import { repositories, services } from "@/src/db/schema";

export async function createRepo(overrides: Partial<typeof repositories.$inferInsert> = {}) {
  const [repo] = await db
    .insert(repositories)
    .values({ owner: "octo", name: "widgets", ...overrides })
    .returning();
  return repo!;
}

export async function createService(repoId: number, overrides: Partial<typeof services.$inferInsert> = {}) {
  const [service] = await db
    .insert(services)
    .values({ repoId, name: "web", pathPatterns: ["src/**"], ...overrides })
    .returning();
  return service!;
}
