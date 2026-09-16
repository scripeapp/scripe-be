import swaggerJsdoc from 'swagger-jsdoc';
import swaggerUi from 'swagger-ui-express';
import { Express } from 'express';

/**
 * OpenAPI 3.0 Specification options for surge-be API
 * 
 * Documentation is now split into separate YAML files in src/docs/openapi/
 * This keeps route files clean and documentation maintainable.
 */
const swaggerOptions: swaggerJsdoc.Options = {
  definition: {
    openapi: '3.0.0',
    info: {
      title: 'Hilaq API',
      version: '1.0.0',
      description: `
## Overview

The Hilaq API provides endpoints for managing Islamic educational content, events, stores, sessions, and more.

## Authentication

Most endpoints require authentication via Bearer token. Include your JWT token in the Authorization header:

\`\`\`
Authorization: Bearer <your-token>
\`\`\`

## Rate Limiting

API requests are rate-limited. Current limits:
- 100 requests per minute for authenticated users
- 20 requests per minute for unauthenticated users

## Response Format

All responses follow a consistent format:

**Success:**
\`\`\`json
{
  "success": true,
  "message": "Operation completed",
  "data": { ... }
}
\`\`\`

**Error:**
\`\`\`json
{
  "success": false,
  "error": "Error description"
}
\`\`\`
      `,
      contact: {
        name: 'Hilaq Support',
        email: 'support@hilaq.com',
      },
      license: {
        name: 'Proprietary',
      },
    },
    servers: [
      {
        url: 'http://localhost:3000',
        description: 'Development server',
      },
      {
        url: 'https://api.hilaq.com',
        description: 'Production server',
      },
    ],
    components: {
      securitySchemes: {
        bearerAuth: {
          type: 'http',
          scheme: 'bearer',
          bearerFormat: 'JWT',
          description: 'Supabase JWT authentication token',
        },
      },
    },
    tags: [
      {
        name: 'Store',
        description: 'Store management and e-commerce operations',
      },
      {
        name: 'Webhook',
        description: 'Payment webhook handlers (Paystack)',
      },
      {
        name: 'User',
        description: 'User profile and account management',
      },
      {
        name: 'Business',
        description: 'Business/organization management',
      },
      {
        name: 'Session',
        description: 'Learning sessions and scheduling',
      },
      {
        name: 'Events',
        description: 'Event creation and management',
      },
    ],
  },
  // Read from YAML files instead of inline JSDoc comments
  apis: [
    './src/docs/openapi/*.yaml',  // External YAML specs (preferred)
    './src/routes/*.ts',           // For any remaining JSDoc annotations
  ],
};

/**
 * Generate OpenAPI specification from YAML files and JSDoc comments
 */
export const swaggerSpec = swaggerJsdoc(swaggerOptions);

/**
 * Setup Swagger UI middleware for Express app
 * Only enabled in development environment
 */
export function setupSwagger(app: Express): void {
  const isDevelopment = process.env.NODE_ENV !== 'production';

  if (isDevelopment) {
    // Serve Swagger UI at /api/docs
    app.use(
      '/api/docs',
      swaggerUi.serve,
      swaggerUi.setup(swaggerSpec, {
        explorer: true,
        customCss: '.swagger-ui .topbar { display: none }',
        customSiteTitle: 'Hilaq API Documentation',
        swaggerOptions: {
          persistAuthorization: true,
          docExpansion: 'list',
          filter: true,
          showRequestDuration: true,
        },
      })
    );

    // Serve raw OpenAPI spec at /api/docs.json
    app.get('/api/docs.json', (req, res) => {
      res.setHeader('Content-Type', 'application/json');
      res.send(swaggerSpec);
    });

    console.log('📚 Swagger UI available at /api/docs');
    console.log('📄 OpenAPI spec available at /api/docs.json');
  }
}

export default { swaggerSpec, setupSwagger };
