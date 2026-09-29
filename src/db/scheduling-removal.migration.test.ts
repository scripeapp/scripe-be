import { request, startTestServer, type TestServer } from "@/test-support/http.js";
import { configurePoolErrorHandling, createDatabasePool } from "./pool.js";

let server: TestServer;
jest.setTimeout(30_000);

beforeAll(async () => {
  server = await startTestServer();
});
afterAll(async () => server.close());

describe("scheduling prototype removal (migration 0064)", () => {
  it("no longer routes the prototype scheduling endpoints", async () => {
    const eventTypes = await request(server.baseUrl, "/api/scheduling/event-types");
    const availability = await request(server.baseUrl, "/api/availability");
    expect(eventTypes.status).toBe(404);
    expect(availability.status).toBe(404);
  });

  it("drops the prototype tables but keeps the replacement schedule table", async () => {
    const pool = createDatabasePool();
    configurePoolErrorHandling(pool);
    try {
      const { rows } = await pool.query(`
        select
          to_regclass('app.event_types') as event_types,
          to_regclass('app.availability_profiles') as availability_profiles,
          to_regclass('app.staff_schedules') as staff_schedules;
      `);
      expect(rows[0]?.event_types).toBeNull();
      expect(rows[0]?.availability_profiles).toBeNull();
      expect(rows[0]?.staff_schedules).not.toBeNull();
    } finally {
      await pool.end();
    }
  });
});