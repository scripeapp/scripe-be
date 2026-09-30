/**
 * Local-disk object storage (LOCAL_OBJECT_STORAGE) runs fully offline: a
 * throwaway Express server serves the signed URLs it issues.
 */
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { rm } from "node:fs/promises";
import path from "node:path";
import type { ObjectStorage } from "./r2.js";

const MINIMAL_ENV = {
  DATABASE_URL: "postgres://scripe_app@localhost:5432/scripe_test",
  BETTER_AUTH_SECRET: "0123456789abcdef0123456789abcdef",
  BETTER_AUTH_URL: "http://localhost:4000",
  LOCAL_OBJECT_STORAGE: "true",
};
const KEY = `uploads/test-${Date.now()}/doc.pdf`;

describe("local object storage", () => {
  const originalEnv = process.env;
  let server: Server;
  let origin: string;
  let storage: ObjectStorage;

  beforeAll(async () => {
    process.env = { ...MINIMAL_ENV };
    const express = (await import("express")).default;
    const { createLocalStorageRouter } = await import("./local-object-storage.js");
    ({ objectStorage: storage } = await import("./r2.js"));
    const app = express();
    app.use(createLocalStorageRouter());
    server = await new Promise((resolve) => {
      const started = app.listen(0, () => resolve(started));
    });
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    process.env = originalEnv;
    await new Promise((resolve) => server.close(resolve));
    await rm(path.resolve(process.cwd(), ".local-storage", path.dirname(KEY)), { recursive: true, force: true });
  });

  // Signed URLs point at BETTER_AUTH_URL; the test server takes the same path.
  const local = (url: string) => `${origin}${new URL(url).pathname}`;

  it("stores an upload through its signed URL and reads it back", async () => {
    const bytes = Buffer.from("%PDF-1.4 test");
    const { uploadUrl } = await storage.createPresignedUploadUrl(KEY, "application/pdf", bytes.length);
    expect(uploadUrl.startsWith("http://localhost:4000/api/dev-storage/")).toBe(true);
    expect((await fetch(local(uploadUrl), { method: "PUT", headers: { "content-type": "application/pdf" }, body: bytes })).status).toBe(200);

    expect(await storage.headObject(KEY)).toMatchObject({ exists: true, sizeBytes: bytes.length, contentType: "application/pdf" });
    expect(Buffer.from(await storage.getObjectBytes(KEY)).toString()).toBe("%PDF-1.4 test");

    const download = await fetch(local(await storage.createPresignedDownloadUrl(KEY)));
    expect(download.status).toBe(200);
    expect(download.headers.get("content-type")).toBe("application/pdf");
  });

  it("refuses tampered or wrong-purpose tokens and keys outside the store", async () => {
    const { uploadUrl } = await storage.createPresignedUploadUrl(KEY, "application/pdf", 3);
    expect((await fetch(local(`${uploadUrl}x`), { method: "PUT", body: "abc" })).status).toBe(403);
    // An upload grant can't be used to download.
    expect((await fetch(local(uploadUrl))).status).toBe(403);
    await expect(storage.createPresignedUploadUrl("../escape.txt", "text/plain", 1)).rejects.toThrow("Invalid object key");
  });
});
