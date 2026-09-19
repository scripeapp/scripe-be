import type { Server } from "node:http";
import { request as httpRequest } from "node:http";
import type { AddressInfo } from "node:net";
import { createApp } from "../app.js";
import {
  closeDatabase,
  configureDatabaseGateway,
  createDatabaseGateway,
} from "../db/database.js";
import { configurePoolErrorHandling, createDatabasePool } from "../db/pool.js";

export interface HttpResponse {
  readonly status: number;
  readonly cookies: string;
  readonly body: unknown;
}

export interface TestServer {
  readonly baseUrl: string;
  close(): Promise<void>;
}

interface RequestOptions {
  readonly method?: string;
  readonly body?: string;
  readonly cookie?: string;
  readonly origin?: string | null;
}

export async function startTestServer(): Promise<TestServer> {
  // The server binds an ephemeral port; trust loopback so the automatic Origin
  // header is accepted while untrusted origins still fail.
  process.env.AUTH_TRUSTED_ORIGINS = "http://127.0.0.1:*,http://localhost:*";

  const pool = createDatabasePool();
  configurePoolErrorHandling(pool);
  configureDatabaseGateway(createDatabaseGateway(pool));

  const server = createApp().listen(0);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address() as AddressInfo;

  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    async close() {
      await closeServer(server);
      await closeDatabase();
    },
  };
}

function closeServer(server: Server): Promise<void> {
  return new Promise<void>((resolve) => server.close(() => resolve()));
}

export async function request(
  baseUrl: string,
  path: string,
  options: RequestOptions = {},
): Promise<HttpResponse> {
  const target = new URL(baseUrl);
  const headers: Record<string, string> = {};
  if (options.body) {
    headers["content-type"] = "application/json";
    headers["content-length"] = String(Buffer.byteLength(options.body));
  }
  if (options.cookie) {
    headers.cookie = options.cookie;
  }
  const origin = options.origin === undefined ? baseUrl : options.origin;
  if (origin) {
    headers.origin = origin;
  }

  return new Promise<HttpResponse>((resolve, reject) => {
    const clientRequest = httpRequest(
      {
        hostname: target.hostname,
        port: target.port,
        path,
        method: options.method ?? "GET",
        headers,
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          let body: unknown = text;
          try {
            body = text.length > 0 ? JSON.parse(text) : null;
          } catch {
            body = text;
          }
          const cookies = (response.headers["set-cookie"] ?? [])
            .map((value) => value.split(";")[0])
            .join("; ");
          resolve({ status: response.statusCode ?? 0, cookies, body });
        });
      },
    );
    clientRequest.on("error", reject);
    if (options.body) {
      clientRequest.write(options.body);
    }
    clientRequest.end();
  });
}
