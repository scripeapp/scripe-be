import express, { Request, Response, NextFunction } from "express";
import morgan from "morgan";
import "dotenv/config";
import campaignProcessRoutes from "./routes/campaign-process.routes";
import eventsRoutes from "./routes/events.routes";
import dashboardRoutes from "./routes/dashboard.routes";
import publicationsRoutes from "./routes/publications.routes";
import settingsRoutes from "./routes/settings.routes";
import announcementsRoutes from "./routes/announcements.routes";
import websiteRoutes from "./routes/website.routes";
import webhookRoutes from "./routes/webhook.routes";
import notificationRoutes from "./routes/notifications.routes";
import storeRoutes from "./routes/store.routes";
import catalogRoutes from "./routes/catalog.routes";
import crmRoutes from "./routes/crm.routes";
import channelRoutes from "./routes/channel.routes";
import channelProcessRoutes from "./routes/channel-process.routes";
import communicationsRoutes from "./routes/communications.routes";
import marketplaceRoutes from "./routes/marketplace.routes";
import userRoutes from "./routes/user.routes";
import availabilityRoutes from "./routes/availability.routes";
import { teamRoutes } from "./routes/team.routes";
import { businessRoutes } from "./routes/business.routes";
import adminRoutes from "./routes/admin.routes";
import subscriptionRoutes from "./routes/subscription.routes";
import authRoutes from "./routes/auth.routes";
import checkinRoutes from "./routes/checkin.routes";
import postRoutes from "./routes/posts.routes";
import socialRoutes from "./routes/social.routes";
import aiRoutes from "./routes/ai.routes";
import aiAgentRoutes from "./routes/ai-agent.routes";
import partnerRoutes from "./routes/partner.routes";
import bookkeepingRoutes from "./routes/bookkeeping.routes";
import storageRoutes from "./routes/storage.routes";
import financialsRoutes from "./routes/financials.routes";
import bankingRoutes from "./routes/banking.routes";
import approvalWorkflowsRoutes from "./routes/approval-workflows.routes";
import formRoutes from "./routes/form.routes";
import integrationsRoutes from "./routes/integrations.routes";
import schedulingRoutes from "./routes/scheduling.routes";
import paymentRoutes from "./routes/payment.routes";
import coursesRoutes from "./routes/courses.routes";
import certificatesRoutes from "./routes/certificates.routes";
import eventCertificatesRoutes from "./routes/event-certificates.routes";
import uploadRoutes from "./routes/upload.routes";
import tipsRoutes from "./routes/tips.routes";
import utilsRoutes from "./routes/utils.routes";
import corsDebugMiddleware from "./middleware/cors-middleware";
import { schedulerService } from "./services/scheduler.service";
import { setupSwagger } from "./config/swagger";

const app = express();

// DEBUG: Log all incoming requests and their origins
app.use((req, res, next) => {
  console.log(
    `[Request] ${req.method} ${req.url} | Origin: ${req.headers.origin} | IP: ${req.ip}`,
  );
  next();
});

// Start the scheduled post publisher (skip locally with SKIP_CRONS=true)
if (process.env.SKIP_CRONS !== "true") {
  schedulerService.start();
}

// Advanced CORS configuration
app.use((req: Request, res: Response, next: NextFunction) => {
  const additionalAllowedOrigins = (
    process.env.ADDITIONAL_ALLOWED_ORIGINS || ""
  )
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);
  const allowedOrigins = [
    "http://localhost:3000",
    "http://*.localhost:3000",
    "http://localhost:3001",
    "http://localhost:3002",
    "http://127.0.0.1:3000",
    "http://127.0.0.1:3001",
    "http://127.0.0.1:3002",
    "http://localhost:5173",
    "http://127.0.0.1:5173",
    "https://www.hilaq.com",
    "https://hilaq.com",
    "https://*.hilaq.com",
    "https://hilaq.vercel.app",
    "https://development--hilaqapp.netlify.app",
    ...additionalAllowedOrigins,
  ];

  const additionalAllowedOriginRegexes = (
    process.env.ADDITIONAL_ALLOWED_ORIGIN_REGEXES || ""
  )
    .split(",")
    .map((pattern) => pattern.trim())
    .filter(Boolean)
    .map((pattern) => {
      try {
        return new RegExp(pattern);
      } catch (error) {
        console.warn(
          `[CORS] Skipping invalid ADDITIONAL_ALLOWED_ORIGIN_REGEXES pattern: ${pattern}`,
        );
        return null;
      }
    })
    .filter((regex): regex is RegExp => !!regex);

  const origin = req.headers.origin as string | undefined;

  // Helper to check if origin is allowed
  const isOriginAllowed = (origin: string) => {
    if (allowedOrigins.includes(origin)) return true;

    // Check wildcards
    // https://*.hilaq.com
    if (/^https:\/\/[a-zA-Z0-9-]+\.hilaq\.com$/.test(origin)) return true;
    // http://*.localhost:3000
    if (/^http:\/\/[a-zA-Z0-9-]+\.localhost:3000$/.test(origin)) return true;
    // http://*.lvh.me:3000
    if (/^http:\/\/[a-zA-Z0-9-]+\.lvh\.me:3000$/.test(origin)) return true;
    // http://*.localtest.me:3000
    if (/^http:\/\/[a-zA-Z0-9-]+\.localtest\.me:3000$/.test(origin))
      return true;
    // http://*.127.0.0.1.nip.io:3000
    if (/^http:\/\/[a-zA-Z0-9-]+\.127\.0\.0\.1\.nip\.io:3000$/.test(origin))
      return true;
    if (additionalAllowedOriginRegexes.some((regex) => regex.test(origin)))
      return true;

    return false;
  };

  if (origin && isOriginAllowed(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
  }

  res.setHeader(
    "Access-Control-Allow-Methods",
    "GET, POST, PUT, DELETE, OPTIONS, PATCH",
  );
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type, Authorization, X-Register-Device-Token, X-Checkin-Token",
  );
  res.setHeader("Access-Control-Allow-Credentials", "true");

  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  next();
});

// Middleware
app.use(morgan("dev"));
app.use(
  express.json({
    limit: "50mb",
    verify: (req, _res, buffer) => {
      (req as typeof req & { rawBody?: Buffer }).rawBody = Buffer.from(buffer);
    },
  }),
);
app.use(express.urlencoded({ extended: true, limit: "50mb" }));

// app.use(corsDebugMiddleware);

app.use("/api/notifications", notificationRoutes);
app.use("/api/events", eventsRoutes);
app.use("/api/dashboard", dashboardRoutes);
app.use("/api/publications", publicationsRoutes);
app.use("/api/settings", settingsRoutes);
app.use("/api/webhook", webhookRoutes);
app.use("/api/announcements", announcementsRoutes);
app.use("/api/website", websiteRoutes);
app.use("/api/store/catalog", catalogRoutes);
app.use("/api/store", storeRoutes);
app.use("/api/crm/campaigns", campaignProcessRoutes);
app.use("/api/crm", crmRoutes);
app.use("/api/channels", channelProcessRoutes);
app.use("/api/channels/:channel", channelRoutes);
app.use("/api/communications", communicationsRoutes);
app.use("/api/marketplace", marketplaceRoutes);
app.use("/api/user", userRoutes);
app.use("/api/availability", availabilityRoutes);
app.use("/api/teams", teamRoutes);
app.use("/api/businesses", businessRoutes);
app.use("/api/admin", adminRoutes);
app.use("/api/courses", coursesRoutes);
app.use("/api/certificates", certificatesRoutes);
app.use("/api/event-certificates", eventCertificatesRoutes);
app.use("/api/upload", uploadRoutes);
app.use("/api/tips", tipsRoutes);
app.use("/api/utils", utilsRoutes);
app.use("/api/subscriptions", subscriptionRoutes);
app.use("/api/auth", authRoutes);
app.use("/api/checkin", checkinRoutes);
import supportRoutes from "./routes/support.routes";

app.use("/api/posts", postRoutes);
app.use("/api/social", socialRoutes);
app.use("/api/ai/agent", aiAgentRoutes);
app.use("/api/ai", aiRoutes);
app.use("/api/partners", partnerRoutes);
app.use("/api/support", supportRoutes);
import analyticsRoutes from "./routes/analytics.routes";
app.use("/api/analytics", analyticsRoutes);
app.use("/api/bookkeeping", bookkeepingRoutes);
app.use("/api/financials", financialsRoutes);
app.use("/api/banking", bankingRoutes);
app.use("/api/approval-workflows", approvalWorkflowsRoutes);
app.use("/api/storage", storageRoutes);
app.use("/api/forms", formRoutes);
app.use("/api/integrations", integrationsRoutes);
app.use("/api/scheduling", schedulingRoutes);
app.use("/api/payments", paymentRoutes);

// Setup Swagger API documentation (development only)
setupSwagger(app);

// Route Alias for User Subscriptions (requested in specs)
// Maps POST /api/me/subscriptions -> getUserSubscriptions
// Since strict path matching is needed, we add it here before 404
import { getUserSubscriptions } from "./controllers/pubs.controller";
import { authenticateUser } from "./middleware/supabase-auth-middleware";
import { withSupabase } from "./types/http";

app.get(
  "/api/me/subscriptions",
  authenticateUser,
  withSupabase(getUserSubscriptions),
);

// Public Banks route (proxies Paystack)
import { BusinessController } from "./controllers/business.controller";
app.get("/api/banks", BusinessController.getBanks as any);

// Health check route
app.get("/", (req: Request, res: Response) => {
  res.json({
    message: "Welcome to Hilaq API",
    status: "healthy",
    timestamp: new Date().toISOString(),
  });
});

// 404 handler
app.use((req: Request, res: Response) => {
  res.status(404).json({
    error: "Not Found",
    message: `Route ${req.originalUrl} not found`,
  });
});

// Error handling middleware
app.use((err: any, req: Request, res: Response, _next: NextFunction) => {
  console.error(err.stack);

  const statusCode = err.statusCode || 500;
  const message = err.message || "Internal Server Error";

  res.status(statusCode).json({
    error: message,
    stack: process.env.NODE_ENV === "development" ? err.stack : undefined,
  });
});

export default app;
