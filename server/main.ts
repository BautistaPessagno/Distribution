import express from "express";
import next from "next";
import { requireBearerAuth } from "@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js";
import {
  getOAuthProtectedResourceMetadataUrl,
  mcpAuthRouter,
} from "@modelcontextprotocol/sdk/server/auth/router.js";
import { expectedOrigin, isPublicPath, validateSession } from "./auth";
import { authRouter, sessionTokenFrom } from "./auth-routes";
import { WORKSPACE_SCOPE, hostOAuthProvider } from "./host-auth";
import { hostAuthRouter } from "./host-auth-routes";
import { getDb } from "./db";
import { getHealth } from "./health";
import { startJobRunner } from "./jobs";
import { log, newRequestId } from "./log";
import { handleMcpRequest } from "./mcp";
import { accountRouter } from "./account-routes";
import { approvalRouter } from "./approval-routes";
import { workOrderRouter } from "./work-order-routes";
import { deliveryRouter } from "./delivery-routes";
import { assetRouter } from "./asset-routes";
import { brandKitRouter } from "./brand-kit-routes";
import { pieceRouter } from "./piece-routes";
import { projectRouter } from "./project-routes";
import { templateRouter } from "./template-routes";
import { runPlanRouter } from "./run-plan-routes";
import { isActiveProjectTokenHash } from "./projects";
import { createStubProjectRouter, stubVerifyAgainstProjects } from "./stub-project";

const dev = process.env.NODE_ENV !== "production";
const port = Number(process.env.PORT ?? 3000);

async function main(): Promise<void> {
  getDb();
  startJobRunner();

  const app = next({ dev });
  await app.prepare();
  const nextHandler = app.getRequestHandler();

  const server = express();
  server.disable("x-powered-by");

  server.use((req, res, nextFn) => {
    const requestId = newRequestId();
    res.setHeader("x-request-id", requestId);
    res.on("finish", () => {
      log("info", "request", {
        requestId,
        method: req.method,
        path: req.path,
        status: res.statusCode,
      });
    });
    nextFn();
  });

  server.get("/health", async (_req, res) => {
    const report = await getHealth();
    res.status(report.status === "ok" ? 200 : 503).json(report);
  });

  const origin = new URL(expectedOrigin());
  const mcpUrl = new URL("/mcp", origin);
  server.use(
    mcpAuthRouter({
      provider: hostOAuthProvider,
      issuerUrl: origin,
      resourceServerUrl: mcpUrl,
      resourceName: "MarketingOS",
      scopesSupported: [WORKSPACE_SCOPE],
    })
  );

  const bearerAuth = requireBearerAuth({
    verifier: hostOAuthProvider,
    resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(mcpUrl),
  });

  server.post("/mcp", bearerAuth, express.json({ limit: "4mb" }), handleMcpRequest);
  server.get("/mcp", (_req, res) => {
    res.status(405).json({
      jsonrpc: "2.0",
      error: { code: -32000, message: "Method not allowed. POST JSON-RPC to this endpoint." },
      id: null,
    });
  });

  server.use("/api/auth", authRouter());
  server.use("/api/hosts", hostAuthRouter());
  server.use("/api/projects", projectRouter());
  server.use("/api/run-plans", runPlanRouter());
  server.use("/api/pieces", pieceRouter());
  server.use("/api/brand-kits", brandKitRouter());
  server.use("/api/templates", templateRouter());
  server.use("/api/assets", assetRouter());
  server.use("/api/approvals", approvalRouter());
  server.use("/api/slots", accountRouter());
  server.use("/api/work-orders", workOrderRouter());
  server.use("/api/deliveries", deliveryRouter());

  // Dev stub Connected Project: a conformant project domain served by this
  // process so registration is testable before any real project exists.
  if (dev || process.env.ENABLE_STUB_PROJECT === "1") {
    server.use(
      "/stub-project",
      createStubProjectRouter(stubVerifyAgainstProjects(isActiveProjectTokenHash))
    );
  }

  server.use((req, res) => {
    if (!isPublicPath(req.path) && validateSession(sessionTokenFrom(req)) === null) {
      if (req.method === "GET" && (req.headers.accept ?? "").includes("text/html")) {
        res.redirect(302, "/login");
      } else {
        res.status(401).json({ error: "Authentication required" });
      }
      return;
    }
    return nextHandler(req, res);
  });

  server.listen(port, () => {
    log("info", "marketingos listening", { port, dev });
  });
}

main().catch((err) => {
  log("error", "fatal startup error", {
    error: err instanceof Error ? err.stack ?? err.message : String(err),
  });
  process.exit(1);
});
