// `npm run seed` -- wipes the app database and fills it with a synthetic
// but structurally realistic dataset so `npm run dev` has something to look
// at. This is explicitly synthetic data for local development/demo, never
// presented as real usage; see scripts/lib/dataset.ts for how it's built
// and BENCHMARKS.md for how the same generator is used to measure the
// correlation engine.
import "dotenv/config";
import { db, pool } from "@/src/db/client";
import { seedSyntheticDataset } from "./lib/dataset";

async function main() {
  const result = await seedSyntheticDataset(db);

  console.log(`Seeded synthetic dataset in ${result.elapsedMs}ms:`);
  for (const [table, count] of Object.entries(result.counts)) {
    console.log(`  ${table.padEnd(16)} ${count}`);
  }
  console.log(`Total core events (commits+PRs+CI runs+deployments+health events): ${result.totalCoreEvents}`);
  console.log(`Seeded ${result.groundTruth.length} incident scenarios with known causative commits.`);
  console.log(`Open http://localhost:${process.env.PORT ?? 3000} (run \`npm run dev\` if it isn't already running).`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
