/**
 * Development-only object storage on local disk (LOCAL_OBJECT_STORAGE=true),
 * so flows that need uploads — banking KYB documents forwarded to Anchor,
 * profile images — work without R2 credentials. It keeps the same contract
 * as R2: the browser PUTs to a short-lived signed URL and reads through
 * one, served by createLocalStorageRouter. Never enabled in production
 * (the environment schema refuses it).
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import express, { Router, type Request, type Response } from "express";
import { loadEnvironment } from "../shared/environment.js";
import type { ObjectMetadata, ObjectStorage, PresignedUpload } from "./r2.js";

const ROOT = path.resolve(process.cwd(), ".local-storage");
const ROUTE = "/api/dev-storage";
const UPLOAD_URL_TTL_SECONDS = 600;
const DEFAULT_DOWNLOAD_URL_TTL_SECONDS = 300;
const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;

interface Grant {
  readonly key: string;
  readonly method: "put" | "get";
  readonly contentType?: string;
  readonly contentLength?: number;
  readonly expiresAt: number;
}

function sign(payload: string): string {
  return createHmac("sha256", loadEnvironment().BETTER_AUTH_SECRET).update(`local-storage:${payload}`).digest("base64url");
}

function issue(grant: Grant): string {
  const payload = Buffer.from(JSON.stringify(grant)).toString("base64url");
  return `${loadEnvironment().BETTER_AUTH_URL}${ROUTE}/${payload}.${sign(payload)}`;
}

function verify(token: string, method: Grant["method"]): Grant | undefined {
  const [payload, signature] = token.split(".");
  if (!payload || !signature) return undefined;
  const expected = Buffer.from(sign(payload));
  const given = Buffer.from(signature);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return undefined;
  const grant = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as Grant;
  if (grant.method !== method || grant.expiresAt < Date.now()) return undefined;
  return grant;
}

/** Maps an object key to a file under ROOT, refusing anything that would escape it. */
function filePath(key: string): string {
  const resolved = path.resolve(ROOT, key);
  if (!resolved.startsWith(`${ROOT}${path.sep}`)) throw new Error(`Invalid object key: ${key}`);
  return resolved;
}

async function readContentType(key: string): Promise<string | undefined> {
  try {
    return (JSON.parse(await readFile(`${filePath(key)}.meta.json`, "utf8")) as { contentType?: string }).contentType;
  } catch {
    return undefined;
  }
}

export class LocalObjectStorage implements ObjectStorage {
  createPresignedUploadUrl(key: string, contentType: string, contentLength: number): Promise<PresignedUpload> {
    return new Promise((resolve) => {
      filePath(key);
      const expiresAt = Date.now() + UPLOAD_URL_TTL_SECONDS * 1000;
      resolve({ uploadUrl: issue({ key, method: "put", contentType, contentLength, expiresAt }), expiresAt: new Date(expiresAt) });
    });
  }

  createPresignedDownloadUrl(key: string, expiresInSeconds = DEFAULT_DOWNLOAD_URL_TTL_SECONDS): Promise<string> {
    return new Promise((resolve) => {
      filePath(key);
      resolve(issue({ key, method: "get", expiresAt: Date.now() + expiresInSeconds * 1000 }));
    });
  }

  async headObject(key: string): Promise<ObjectMetadata> {
    try {
      const info = await stat(filePath(key));
      return { exists: true, sizeBytes: info.size, contentType: await readContentType(key), etag: `"${info.mtimeMs}"` };
    } catch {
      return { exists: false };
    }
  }

  async deleteObject(key: string): Promise<void> {
    await rm(filePath(key), { force: true });
    await rm(`${filePath(key)}.meta.json`, { force: true });
  }

  async getObjectBytes(key: string): Promise<Uint8Array> {
    return new Uint8Array(await readFile(filePath(key)));
  }
}

/** Serves the signed upload/download URLs LocalObjectStorage hands out. */
export function createLocalStorageRouter(): Router {
  const router = Router();

  router.put(`${ROUTE}/:token`, express.raw({ type: () => true, limit: MAX_UPLOAD_BYTES }), async (request: Request, response: Response) => {
    const grant = verify(String(request.params.token), "put");
    const body = Buffer.isBuffer(request.body) ? request.body : Buffer.alloc(0);
    if (!grant) return void response.status(403).end();
    if (grant.contentLength !== undefined && body.length !== grant.contentLength) return void response.status(400).end();
    const target = filePath(grant.key);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, body);
    await writeFile(`${target}.meta.json`, JSON.stringify({ contentType: grant.contentType ?? request.header("content-type") ?? null }));
    response.status(200).end();
  });

  router.get(`${ROUTE}/:token`, async (request: Request, response: Response) => {
    const grant = verify(String(request.params.token), "get");
    if (!grant) return void response.status(403).end();
    try {
      const bytes = await readFile(filePath(grant.key));
      response.setHeader("content-type", (await readContentType(grant.key)) ?? "application/octet-stream");
      response.status(200).send(bytes);
    } catch {
      response.status(404).end();
    }
  });

  return router;
}
