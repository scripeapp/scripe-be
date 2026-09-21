import { createApp } from "./app.js";
import { createDatabasePool, configurePoolErrorHandling } from "./db/pool.js";
import {
  closeDatabase,
  configureDatabaseGateway,
  createDatabaseGateway,
  getDatabase,
} from "./db/database.js";
import { registerBuiltinJobHandlers, seedBuiltinJobs } from "./domains/jobs/jobs.handlers.js";
import { JobScheduler } from "./domains/jobs/jobs.service.js";
import { loadEnvironment } from "./shared/environment.js";

async function startServer(): Promise<void> {
  const environment = loadEnvironment();

  const pool = createDatabasePool();
  configurePoolErrorHandling(pool);
  configureDatabaseGateway(createDatabaseGateway(pool));

  const database = getDatabase();
  const jobScheduler = new JobScheduler(database);
  registerBuiltinJobHandlers(jobScheduler, database);
  await seedBuiltinJobs(database);
  jobScheduler.start();

  const app = createApp();

  const server = app.listen(environment.PORT, () => {
    console.log(`[server] listening on http://localhost:${environment.PORT}`);
  });

  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error): void => reject(error);
    server.once("error", onError);
    server.once("listening", () => {
      server.off("error", onError);
      resolve();
    });
  });

  let shuttingDown = false;
  const shutdown = async (signal: NodeJS.Signals): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[server] ${signal} received; shutting down`);
    jobScheduler.stop();

    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
    await closeDatabase();
  };

  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    process.once(signal, () => {
      void shutdown(signal)
        .then(() => {
          process.exitCode = 0;
        })
        .catch((error) => {
          console.error("[server] graceful shutdown failed", error);
          process.exitCode = 1;
        });
    });
  }
}

void startServer().catch((error) => {
  console.error("[server] failed to start", error);
  process.exitCode = 1;
});
