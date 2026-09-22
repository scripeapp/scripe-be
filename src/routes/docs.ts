/**
 * Serves the OpenAPI document and a Swagger UI at /docs. Mounted only outside
 * production (see app.ts). Swagger UI is loaded from a CDN and configured with
 * credentials so the same-origin Better Auth session cookie is sent on
 * "Try it out" requests.
 */
import { Router } from "express";
import { buildOpenApiDocument } from "../docs/openapi.js";

const SWAGGER_VERSION = "5.17.14";

const PAGE = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Surge API Docs</title>
    <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/swagger-ui/${SWAGGER_VERSION}/swagger-ui.min.css" />
    <style>body { margin: 0; background: #fafafa; }</style>
  </head>
  <body>
    <div id="swagger-ui"></div>
    <script src="https://cdnjs.cloudflare.com/ajax/libs/swagger-ui/${SWAGGER_VERSION}/swagger-ui-bundle.min.js" crossorigin></script>
    <script>
      window.ui = SwaggerUIBundle({
        url: "/openapi.json",
        dom_id: "#swagger-ui",
        deepLinking: true,
        withCredentials: true,
        persistAuthorization: true,
      });
    </script>
  </body>
</html>`;

export function createDocsRouter(): Router {
  const router = Router();
  let cached: ReturnType<typeof buildOpenApiDocument> | undefined;
  router.get("/openapi.json", (request, response) => {
    // Built once from the fully-mounted router on first request (the app isn't
    // finished mounting when this router factory runs).
    cached ??= buildOpenApiDocument(request.app);
    response.json(cached);
  });
  router.get("/docs", (_request, response) => {
    response.type("html").send(PAGE);
  });
  return router;
}
