
import express, { Request, Response } from "express";
import { logger } from "./logger";
import swaggerUi from "swagger-ui-express";
import swaggerJsdoc from "swagger-jsdoc";


const app = express();
app.use(express.json());

// Basic Auth Middleware
const BASIC_AUTH_USER = process.env.BASIC_AUTH_USER || "admin";
const BASIC_AUTH_PASS = process.env.BASIC_AUTH_PASS || "password";

app.use((req, res, next) => {
  const authHeader = req.headers["authorization"];
  if (!authHeader || !authHeader.startsWith("Basic ")) {
    res.setHeader("WWW-Authenticate", "Basic realm=\"API Access\"");
    return res.status(401).send("Authentication required.");
  }
  const base64 = authHeader.split(" ")[1];
  const [user, pass] = Buffer.from(base64, "base64").toString().split(":");
  if (user === BASIC_AUTH_USER && pass === BASIC_AUTH_PASS) {
    return next();
  }
  res.setHeader("WWW-Authenticate", "Basic realm=\"API Access\"");
  return res.status(401).send("Invalid credentials.");
});

const swaggerDefinition = {
  openapi: "3.0.0",
  info: {
    title: "Storage Cleaner & Promotion API",
    version: "1.0.0",
    description: "REST API for storage compliance and promotion commands."
  },
  servers: [
    { url: "http://localhost:3000", description: "Local server" }
  ]
};

const options = {
  swaggerDefinition,
  apis: ["./src/apiServer.ts"],
};

const swaggerSpec = swaggerJsdoc(options);
app.use("/openapi", swaggerUi.serve, swaggerUi.setup(swaggerSpec));

// Extracts the project name from an S3 prefix string
function extractProjectName(prefix: string): string {
  const parts = prefix.replace(/\/$/, "").split("/");
  return parts[parts.length - 1];
}
/**
 * @swagger
 * /scan:report:
 *   post:
 *     summary: Scan storage and report issues
 *     requestBody:
 *       required: false
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               project:
 *                 type: string
 *                 description: Project root directory name
 *               noGchat:
 *                 type: boolean
 *                 description: Disable Google Chat notifications
 *     responses:
 *       200:
 *         description: Scan report result
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 type:
 *                   type: string
 *                 projects:
 *                   type: array
 *                   items:
 *                     type: object
 */
app.post("/scan:report", async (req: Request, res: Response) => {
  try {
    const { project, noGchat } = req.body || {};
    const { scanProjects } = require("./services/lifecycleScanner");
    const states = await (project ? scanProjects({ projectName: project, noGchat }) : scanProjects({ noGchat }));
    
  // Collects all issues found during scan for each project
  const issues: Array<{ prefix: string; issues: any[] }> = [];
    const { validateProjectStructure } = require("./services/structureValidator");
    const { streamAllKeys } = require("./services/s3Client");
    for (const state of states) {
      const projectIssues: any[] = [];
      if (state.hasMetadata && state.metadataLoaded) {
        const loaded = await require("./services/metadata").loadMetadata(state.prefix);
        if (loaded && loaded.issues && loaded.issues.length > 0) {
          projectIssues.push(...loaded.issues);
        }
      } else {
        projectIssues.push({ field: "metadata.json", message: "Missing metadata.json", severity: "warn" });
      }
      
      // Collect all sub-prefixes (directories) for this project
      const allPrefixes: string[] = [];
      await streamAllKeys(state.prefix, async (objs: { key: string }[]) => {
        for (const obj of objs) {
          const lastSlash = obj.key.lastIndexOf("/");
          if (lastSlash < 0) continue; // Skip files not in a directory
          const dir = obj.key.substring(0, lastSlash + 1);
          if (!allPrefixes.includes(dir)) allPrefixes.push(dir);
        }
      });
      
  // Validate the structure of the project using all collected prefixes
  const structureResult = validateProjectStructure(state.prefix, allPrefixes, { noGchat });
      if (structureResult.issues && structureResult.issues.length > 0) {
        for (const si of structureResult.issues) {
          projectIssues.push({ field: "structure", message: si.message, code: si.code, severity: "warn" });
        }
      }
      if (projectIssues.length > 0) {
        issues.push({ prefix: state.prefix, issues: projectIssues });
      }
    }
    // Group issues by project name for easier reporting
    const grouped = issues.map(entry => ({
      project: extractProjectName(entry.prefix),
      issues: entry.issues
    }));
    
    const { sendGoogleChatMessage } = require("./services/notification");
  // Send Google Chat notifications if enabled and webhook is set
  let sentNotification = false;
  if (!noGchat && process.env.GCHAT_WEBHOOK_URL && !sentNotification) {
      const missingMetaOrManagerOwner: Array<{ project: string; issues: any[] }> = [];
      const managerGroups: Record<string, Array<{ project: string; issues: any[] }>> = {};
      const productOwnerGroups: Record<string, Array<{ project: string; issues: any[] }>> = {};
  // Group issues for notification by missing metadata, manager, or owner
  for (const entry of issues) {
        const project = extractProjectName(entry.prefix);
        let meta: any = null;
        let projectManager: string | undefined;
        let productOwner: string | undefined;
        let hasMetadata = false;
        for (const issue of entry.issues) {
          // If metadata.json is missing, add to missingMetaOrManagerOwner
          if (issue.field === "metadata.json" && issue.message === "Missing metadata.json") {
            missingMetaOrManagerOwner.push({ project, issues: entry.issues });
            hasMetadata = false;
            break;
          }
          // Ignore structure issues for notification grouping
          if (issue.field === "structure") continue;
        }
        // If metadata.json exists, load metadata for notification grouping
        if (!entry.issues.some(i => i.field === "metadata.json")) {
          try {
            const loaded = await require("./services/metadata").loadMetadata(entry.prefix);
            if (loaded && loaded.meta) {
              meta = loaded.meta;
              hasMetadata = true;
              projectManager = meta.projectManager;
              productOwner = meta.productOwner;
            }
          } catch {}
        }
        // End of metadata loading block
        if (hasMetadata) {
          if (!meta.projectManager && !meta.productOwner) {
            missingMetaOrManagerOwner.push({ project, issues: entry.issues });
          } else if (projectManager) {
            if (!managerGroups[projectManager]) managerGroups[projectManager] = [];
            managerGroups[projectManager].push({ project, issues: entry.issues });
          } else if (!projectManager && productOwner) {
            if (!productOwnerGroups[productOwner]) productOwnerGroups[productOwner] = [];
            productOwnerGroups[productOwner].push({ project, issues: entry.issues });
          }
        }
      }
      if (missingMetaOrManagerOwner.length) {
        let summary = `🚨 *Storage Compliance Report* 🚨\n\n*Projects missing metadata.json or both projectManager/productOwner:*\n`;
        for (const entry of missingMetaOrManagerOwner) {
          summary += `• *${entry.project}*\n`;
          for (const issue of entry.issues) {
            summary += `   - ${issue.message}`;
            if (issue.field) summary += ` _(field: ${issue.field})_`;
            if (issue.code) summary += ` _(code: ${issue.code})_`;
    
          }
        }
        summary += `\nℹ️ Please add required metadata and contacts.`;
        logger.debug(`[notification] Sending Google Chat summary (missing metadata/manager/owner)...`);
        await sendGoogleChatMessage(summary);
      }
      for (const manager in managerGroups) {
        const group = managerGroups[manager];
        let summary = `✅ *Storage Compliance Report*\n\n*Issues for projects managed by:* _${manager}_\n`;
        for (const entry of group) {
          summary += `• *${entry.project}*\n`;
          for (const issue of entry.issues) {
            summary += `   - ${issue.message}`;
            if (issue.field) summary += ` _(field: ${issue.field})_`;
            if (issue.code) summary += ` _(code: ${issue.code})_`;
            summary += '\n';
          }
        }
        summary += `\n👤 *Project Manager:* _${manager}_`;
        logger.debug(`[notification] Sending Google Chat summary for projectManager=${manager}...`);
        await sendGoogleChatMessage(summary);
      }
      for (const owner in productOwnerGroups) {
        const group = productOwnerGroups[owner];
        let summary = `⚠️ *Storage Compliance Report*\n\n*Issues for projects with productOwner:* _${owner}_ (no projectManager set)\n`;
        for (const entry of group) {
          summary += `• *${entry.project}*\n`;
          for (const issue of entry.issues) {
            summary += `   - ${issue.message}`;
            if (issue.field) summary += ` _(field: ${issue.field})_`;
            if (issue.code) summary += ` _(code: ${issue.code})_`;
            summary += '\n';
          }
        }
        summary += `\n👤 *Product Owner:* _${owner}_`;
        logger.debug(`[notification] Sending Google Chat summary for productOwner=${owner}...`);
        await sendGoogleChatMessage(summary);
      }
      sentNotification = true;
    }
    
    res.json({ type: "scan-report", projects: grouped });
  } catch (err: any) {
    logger.error(err?.message || String(err));
  }
});

/**
 * @swagger
 * /promote:release:
 *   post:
 *     summary: Promote dev data to prod version
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               project:
 *                 type: string
 *                 description: Project root directory name
 *               app:
 *                 type: string
 *                 description: Application directory name
 *               dryRun:
 *                 type: boolean
 *                 description: If true, only simulate promotion
 *               aclPublic:
 *                 type: boolean
 *                 description: If true, set ACL to public-read
 *     responses:
 *       200:
 *         description: Promotion result
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 targetPrefix:
 *                   type: string
 *                 plannedCopies:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       from:
 *                         type: string
 *                       to:
 *                         type: string
 */
app.post("/promote:release", async (req: Request, res: Response) => {
  try {
    const { project, app: appName, dryRun, aclPublic } = req.body || {};
    if (!project || !appName) {
      return res.status(400).json({ error: "Missing project or app parameter" });
    }
    const { promoteDevToProd } = require("./services/promotionExecutor");
    const result = await promoteDevToProd({ project, app: appName, dryRun, aclPublic });
    res.json(result);
  } catch (err: any) {
    logger.error(err?.message || String(err));
    res.status(500).json({ error: err?.message || String(err) });
  }
});

/**
 * @swagger
 * /retention:cleanup:
 *   post:
 *     summary: Enforce retention policy for backups
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               project:
 *                 type: string
 *                 description: Project root directory name
 *               app:
 *                 type: string
 *                 description: Application directory name
 *               prodRetention:
 *                 type: integer
 *                 description: Number of prod v<number> folders to keep
 *               devRetention:
 *                 type: integer
 *                 description: Number of dev file.YYYYMMDD.ext files to keep
 *               dryRun:
 *                 type: boolean
 *                 description: If true, only simulate deletion
 *     responses:
 *       200:
 *         description: Retention cleanup result
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 deletedProdVersions:
 *                   type: array
 *                   items:
 *                     type: integer
 *                 deletedDevFiles:
 *                   type: array
 *                   items:
 *                     type: string
 */
app.post("/retention:cleanup", async (req: Request, res: Response) => {
  try {
    const { project, app: appName, prodRetention, devRetention, dryRun } = req.body || {};
    const { enforceRetention } = require("./services/retentionExecutor");
    let result;
    if (project && appName) {
      // Specific project/app
      result = await enforceRetention({ project, app: appName, prodRetention, devRetention, dryRun });
    } else if (project) {
      // All apps in project
      const { streamAllKeys } = require("./services/s3Client");
      const APP_PREFIXES = (process.env.APP_PREFIXES?.split(',').map((p: string) => p.trim()).filter(Boolean)) || ['app-', 'fe-', 'utils-'];
      const discoveredApps: string[] = [];
      await streamAllKeys(`${project}/`, async (appObjs: Array<{ key: string }>) => {
        for (const appObj of appObjs) {
          const parts = appObj.key.split("/");
          if (parts.length === 3 && APP_PREFIXES.some(prefix => parts[1].startsWith(prefix))) {
            discoveredApps.push(parts[1]);
          }
        }
      }, { useDelimiter: true });
      const results = [];
      for (const app of discoveredApps) {
        const r = await enforceRetention({ project, app, prodRetention, devRetention, dryRun });
        if (r && r.deletedProdVersions && r.deletedDevFiles) {
          results.push({ app, ...r });
        }
      }
      result = { mode: "project", project, results };
    } else {
      // Global retention cleanup
      result = await enforceRetention({ prodRetention, devRetention, dryRun });
    }
    res.json(result);
  } catch (err: any) {
    logger.error(err?.message || String(err));
    res.status(500).json({ error: err?.message || String(err) });
  }
});


const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  logger.info(`REST API server listening on port ${PORT}`);
  logger.info(`Swagger docs available at http://localhost:${PORT}/openapi`);
});
 
app.post("/scan:report", async (req: Request, res: Response) => {
  try {
    const { project, noGchat } = req.body || {};
    const { scanProjects } = require("./services/lifecycleScanner");
    const states = await (project ? scanProjects({ projectName: project, noGchat }) : scanProjects({ noGchat }));
    // --- Aggregation and structure validation (same as CLI) ---
    const issues: Array<{ prefix: string; issues: any[] }> = [];
    const { validateProjectStructure } = require("./services/structureValidator");
    const { streamAllKeys } = require("./services/s3Client");
    for (const state of states) {
      const projectIssues: any[] = [];
      if (state.hasMetadata && state.metadataLoaded) {
        const loaded = await require("./services/metadata").loadMetadata(state.prefix);
        if (loaded && loaded.issues && loaded.issues.length > 0) {
          projectIssues.push(...loaded.issues);
        }
      } else {
        projectIssues.push({ field: "metadata.json", message: "Missing metadata.json", severity: "warn" });
      }
    
      const allPrefixes: string[] = [];
      await streamAllKeys(state.prefix, async (objs: { key: string }[]) => {
        for (const obj of objs) {
          const lastSlash = obj.key.lastIndexOf("/");
          if (lastSlash < 0) continue;
          const dir = obj.key.substring(0, lastSlash + 1);
          if (!allPrefixes.includes(dir)) allPrefixes.push(dir);
        }
      });
    
      const structureResult = validateProjectStructure(state.prefix, allPrefixes, { noGchat });
      if (structureResult.issues && structureResult.issues.length > 0) {
        for (const si of structureResult.issues) {
          projectIssues.push({ field: "structure", message: si.message, code: si.code, severity: "warn" });
        }
      }
      if (projectIssues.length > 0) {
        issues.push({ prefix: state.prefix, issues: projectIssues });
      }
    }
    
    function extractProjectName(prefix: string): string {
      const parts = prefix.replace(/\/$/, "").split("/");
      return parts[parts.length - 1];
    }
    const grouped = issues.map(entry => ({
      project: extractProjectName(entry.prefix),
      issues: entry.issues
    }));
    
    const { sendGoogleChatMessage } = require("./services/notification");
    let sentNotification = false;
    if (!noGchat && process.env.GCHAT_WEBHOOK_URL && !sentNotification) {
      const missingMetaOrManagerOwner: Array<{ project: string; issues: any[] }> = [];
      const managerGroups: Record<string, Array<{ project: string; issues: any[] }>> = {};
      const productOwnerGroups: Record<string, Array<{ project: string; issues: any[] }>> = {};
      for (const entry of issues) {
        const project = extractProjectName(entry.prefix);
        let meta: any = null;
        let projectManager: string | undefined;
        let productOwner: string | undefined;
        let hasMetadata = false;
        for (const issue of entry.issues) {
          if (issue.field === "metadata.json" && issue.message === "Missing metadata.json") {
            missingMetaOrManagerOwner.push({ project, issues: entry.issues });
            hasMetadata = false;
            break;
          }
          if (issue.field === "structure") continue;
        }
        if (!entry.issues.some(i => i.field === "metadata.json")) {
          try {
            const loaded = await require("./services/metadata").loadMetadata(entry.prefix);
            if (loaded && loaded.meta) {
              meta = loaded.meta;
              hasMetadata = true;
              projectManager = meta.projectManager;
              productOwner = meta.productOwner;
            }
          } catch {}
        }
        // Group notifications by manager or owner if metadata is present
        if (hasMetadata) {
          if (!meta.projectManager && !meta.productOwner) {
            missingMetaOrManagerOwner.push({ project, issues: entry.issues });
          } else if (projectManager) {
            if (!managerGroups[projectManager]) managerGroups[projectManager] = [];
            managerGroups[projectManager].push({ project, issues: entry.issues });
          } else if (!projectManager && productOwner) {
            if (!productOwnerGroups[productOwner]) productOwnerGroups[productOwner] = [];
            productOwnerGroups[productOwner].push({ project, issues: entry.issues });
          }
        }
      }
      // Send notification for projects missing metadata or manager/owner
      if (missingMetaOrManagerOwner.length) {
        let summary = `🚨 *Storage Compliance Report* 🚨\n\n*Projects missing metadata.json or both projectManager/productOwner:*\n`;
        for (const entry of missingMetaOrManagerOwner) {
          summary += `• *${entry.project}*\n`;
          for (const issue of entry.issues) {
            summary += `   - ${issue.message}`;
            if (issue.field) summary += ` _(field: ${issue.field})_`;
            if (issue.code) summary += ` _(code: ${issue.code})_`;
            summary += '\n';
          }
        }
        summary += `\nℹ️ Please add required metadata and contacts.`;
        logger.debug(`[notification] Sending Google Chat summary (missing metadata/manager/owner)...`);
        await sendGoogleChatMessage(summary);
      }
      // Send notification for each manager group
      for (const manager in managerGroups) {
        const group = managerGroups[manager];
        let summary = `✅ *Storage Compliance Report*\n\n*Issues for projects managed by:* _${manager}_\n`;
        for (const entry of group) {
          summary += `• *${entry.project}*\n`;
          for (const issue of entry.issues) {
            summary += `   - ${issue.message}`;
            if (issue.field) summary += ` _(field: ${issue.field})_`;
            if (issue.code) summary += ` _(code: ${issue.code})_`;
            summary += '\n';
          }
        }
        summary += `\n👤 *Project Manager:* _${manager}_`;
        logger.debug(`[notification] Sending Google Chat summary for projectManager=${manager}...`);
        await sendGoogleChatMessage(summary);
      }
      // Send notification for each product owner group
      for (const owner in productOwnerGroups) {
        const group = productOwnerGroups[owner];
        let summary = `⚠️ *Storage Compliance Report*\n\n*Issues for projects with productOwner:* _${owner}_ (no projectManager set)\n`;
        for (const entry of group) {
          summary += `• *${entry.project}*\n`;
          for (const issue of entry.issues) {
            summary += `   - ${issue.message}`;
            if (issue.field) summary += ` _(field: ${issue.field})_`;
            if (issue.code) summary += ` _(code: ${issue.code})_`;
            summary += '\n';
          }
        }
        summary += `\n👤 *Product Owner:* _${owner}_`;
        logger.debug(`[notification] Sending Google Chat summary for productOwner=${owner}...`);
        await sendGoogleChatMessage(summary);
      }
      sentNotification = true;
    }
    
  // Return the grouped issues as JSON response
  res.json({ type: "scan-report", projects: grouped });
  } catch (err: any) {
    logger.error(err?.message || String(err));
    res.status(500).json({ error: err?.message || String(err) });
  }
});

/**
 * @swagger
 * /promote:release:
 *   post:
 *     summary: Promote dev data to prod version
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               project:
 *                 type: string
 *                 description: Project root directory name
 *               app:
 *                 type: string
 *                 description: Application directory name
 *               dryRun:
 *                 type: boolean
 *                 description: If true, only simulate promotion
 *               aclPublic:
 *                 type: boolean
 *                 description: If true, set ACL to public-read
 *     responses:
 *       200:
 *         description: Promotion result
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 targetPrefix:
 *                   type: string
 *                 plannedCopies:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       from:
 *                         type: string
 *                       to:
 *                         type: string
 */
app.post("/promote:release", async (req: Request, res: Response) => {
  try {
    const { project, app: appName, dryRun, aclPublic } = req.body || {};
    if (!project || !appName) {
      return res.status(400).json({ error: "Missing project or app parameter" });
    }
    const { promoteDevToProd } = require("./services/promotionExecutor");
    const result = await promoteDevToProd({ project, app: appName, dryRun, aclPublic });
    res.json(result);
  } catch (err: any) {
    logger.error(err?.message || String(err));
    res.status(500).json({ error: err?.message || String(err) });
  }
});
