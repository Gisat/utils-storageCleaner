
/* filepath: src/cli.ts */
import { logger } from "./logger";
import { scanForExpiredMetadata, scanProjects } from "./services/lifecycleScanner";

// Read allowed app prefixes from environment variable (comma-separated), fallback to default
const APP_PREFIXES: string[] = (process.env.APP_PREFIXES?.split(',').map(p => p.trim()).filter(Boolean)) || ['app-', 'fe-', 'utils-'];

/**
 * Storage Cleaner & Promotion CLI
 * Adds early S3 connectivity check (can skip via S3_SKIP_STARTUP_CHECK=1).
 */

let testS3Connectivity: (() => Promise<void>) | undefined;
try {
  // Only import if needed (for scan:report)
  testS3Connectivity = require("./services/s3Client").testS3Connectivity;
} catch {}


interface Args {
  command?: string;
  flags: Record<string, string | boolean>;
  positionals: string[];
}

function parseArgs(argv: string[]): Args {
  const [, , ...rest] = argv;
  const flags: Record<string, string | boolean> = {};
  const positionals: string[] = [];
  let command: string | undefined;

  for (let i = 0; i < rest.length; i++) {
    const token = rest[i];
    if (!command && !token.startsWith("-")) {
      command = token;
      continue;
    }
    if (token.startsWith("--")) {
      const eq = token.indexOf("=");
      if (eq > -1) {
        const k = token.slice(2, eq);
        const v = token.slice(eq + 1);
        flags[k] = v;
      } else {
        const k = token.slice(2);
        if (i + 1 < rest.length && !rest[i + 1].startsWith("-")) {
          flags[k] = rest[++i];
        } else {
          flags[k] = true;
        }
      }
    } else {
      positionals.push(token);
    }
  }
  return { command, flags, positionals };
}

function usage(): string {
  return `
Usage:
  storage-tool scan:report [--project <name>] [--no-gchat] [--json] [--log-level <level>]
  storage-tool promote:release --project <name> --app <app-name> [--dry-run] [--public]
  storage-tool retention:cleanup [--project <name>] [--app <app-name>] [--prod-retention <x>] [--dev-retention <y>] [--dry-run]

Options:
  --project <name>        Project root directory name to scan/promote/cleanup (e.g. WorldCereal_GST-10). If omitted for retention:cleanup, runs for all projects.
  --app <app-name>        Application directory name (e.g. app-esaWorldCereal, fe-frontend, utils-storageCleaner, or any prefix in APP_PREFIXES). If omitted for retention:cleanup, runs for all apps in all projects.
  --prod-retention <x>    Number of prod v<number> folders to keep (default: 3)
  --dev-retention <y>     Number of dev file.YYYYMMDD.ext files to keep (default: 5)
  --dry-run               Simulate deletion, do not actually delete files
  --no-gchat              Disable Google Chat notifications for this run
  --json                  Output results as machine-readable JSON
  --log-level <level>     Override LOG_LEVEL (error|warn|info|debug|trace)
  --public                Set ACL to public-read for promoted files (promote:release)
  APP_PREFIXES            Comma-separated list of allowed app directory prefixes (default: app-,fe-,utils-)
  S3_SKIP_STARTUP_CHECK   Set to 1 to skip S3 connectivity check at startup
`.trim();
}

function setLogLevelOverride(level?: string | boolean) {
  if (typeof level === "string" && level) {
    (process as any).env.LOG_LEVEL = level;
  }
}

async function ensureConnectivity() {
  if (process.env.S3_SKIP_STARTUP_CHECK) {
    logger.debug("startup: skipping S3 connectivity check (env override)");
    return;
  }
  try {
    if (typeof testS3Connectivity === "function") {
      await testS3Connectivity();
      logger.debug("startup: S3 connectivity OK");
    } else {
      logger.warn("startup: testS3Connectivity not available; skipping S3 check");
    }
  } catch (e: any) {
    logger.error(`S3 connectivity check failed: ${e?.message || e}`);
    process.exit(4);
  }
}


async function handleScanReport(projectName: string | undefined, json: boolean) {
  logger.debug(`scan:report start project='${projectName || '*'}'`);
  const scanStart = Date.now();
  const noGchat = !!(process.argv.includes('--no-gchat'));
  const states = await (projectName ? scanProjects({ projectName, noGchat }) : scanProjects({ noGchat }));
  const scanMs = Date.now() - scanStart;
  logger.debug(`scan:report scanned ${states.length} prefixes in ${scanMs}ms`);

  // Aggregate issues for all scanned project roots, including structure validation
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
    // Structure validation: collect all sub-prefixes for this project
    const allPrefixes: string[] = [];
    await streamAllKeys(state.prefix, async (objs: { key: string }[]) => {
      for (const obj of objs) {
        const lastSlash = obj.key.lastIndexOf("/");
        if (lastSlash < 0) continue;
        const dir = obj.key.substring(0, lastSlash + 1);
        if (!allPrefixes.includes(dir)) allPrefixes.push(dir);
      }
    });
    // Always run structure validation, even if there are zero or one sub-prefixes
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

  // Helper for project name extraction
  function extractProjectName(prefix: string): string {
    const parts = prefix.replace(/\/$/, "").split("/");
    return parts[parts.length - 1];
  }
  logger.info(`Scan report project='${projectName || '*'}' prefixes=${states.length}`);
  // For each project, try to load top-level metadata.json content
  const grouped = await Promise.all(issues.map(async entry => {
    const project = extractProjectName(entry.prefix);
    let topLevelMetadata = null;
    try {
      // Try to load metadata.json at the project root
      const loaded = await require("./services/metadata").loadMetadata(entry.prefix);
      if (loaded && loaded.meta) {
        topLevelMetadata = loaded.meta;
      }
    } catch {}
    return {
      project,
      issues: entry.issues,
      metadata: topLevelMetadata
    };
  }));
  const jsonReport = JSON.stringify(
    {
      type: "scan-report",
      projects: grouped
    },
    null,
    2
  );
  process.stdout.write(jsonReport + "\n");

  // Enhanced Google Chat summary grouping logic
  const { sendGoogleChatMessage } = require("./services/notification");
  let sentNotification = false;
  if (!noGchat && process.env.GCHAT_WEBHOOK_URL && !sentNotification) {
    // Prepare grouping
    const missingMetaOrManagerOwner: Array<{ project: string; issues: any[] }> = [];
  const managerGroups: Record<string, Array<{ project: string; issues: any[] }>> = {};
  const productOwnerGroups: Record<string, Array<{ project: string; issues: any[] }>> = {};

    for (const entry of issues) {
      const project = extractProjectName(entry.prefix);
      let meta: any = null;
  let projectManager: string | undefined;
  let productOwner: string | undefined;
      let hasMetadata = false;
      // Try to get metadata for grouping
      for (const issue of entry.issues) {
        if (issue.field === "metadata.json" && issue.message === "Missing metadata.json") {
          missingMetaOrManagerOwner.push({ project, issues: entry.issues });
          hasMetadata = false;
          break;
        }
        if (issue.field === "structure") continue;
      }
      // If not missing metadata, try to load metadata
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
      // If metadata exists, check for missing projectManager/productOwner
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

    // 1. Send message for all projects missing metadata or both manager/owner
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

    // 2. Send grouped messages for each projectManager
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

    // 3. Send grouped messages for each productOwner (if projectOwner missing)
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
}



async function main() {
  const { command, flags, positionals } = parseArgs(process.argv);
  setLogLevelOverride(flags["log-level"]);

  if (!command) {
    process.stderr.write(usage() + "\n");
    process.exit(1);
    return;
  }
  const json = !!flags.json;
  const project = (flags.project as string) || undefined;

  try {
    switch (command) {
      case "scan:report":
        await ensureConnectivity(); // Only check S3 for scan:report
        await handleScanReport(project, json);
        break;
      case "promote:release": {
        const projectArg = (flags.project as string) || positionals[0];
        const appArg = (flags.app as string) || positionals[1];
        const dryRun = !!flags["dry-run"];
        const aclPublic = flags["public"] === true || flags["acl"] === "public";
        if (!projectArg || !appArg) {
          process.stderr.write("Missing --project or --app argument for promote:release\n\n" + usage() + "\n");
          process.exit(1);
        }
        logger.info(`Promoting dev to prod for project='${projectArg}' app='${appArg}'${dryRun ? " [DRY RUN]" : ""}${aclPublic ? " [public-read]" : ""}...`);
        const { promoteDevToProd } = require("./services/promotionExecutor");
        await ensureConnectivity();
        try {
          const { targetPrefix, plannedCopies } = await promoteDevToProd({ project: projectArg, app: appArg, dryRun, aclPublic });
          if (dryRun) {
            process.stdout.write(`[DRY RUN] Would promote dev to prod version: ${targetPrefix}${aclPublic ? " [public-read]" : ""}\n`);
            for (const { from, to } of plannedCopies) {
              process.stdout.write(`  - ${from} -> ${to}${aclPublic ? " [public-read]" : ""}\n`);
            }
          } else {
            logger.info(`Promotion complete. New prod version: ${targetPrefix}${aclPublic ? " [public-read]" : ""}`);
            process.stdout.write(`Promotion complete. New prod version: ${targetPrefix}${aclPublic ? " [public-read]" : ""}\n`);
          }
        } catch (err: any) {
          logger.error(`Promotion failed: ${err?.message || err}`);
          process.stderr.write(`Promotion failed: ${err?.message || err}\n`);
          process.exit(2);
        }
        break;
      }
      case "retention:cleanup": {
          const projectArg = (flags.project as string) || positionals[0];
          const appArg = (flags.app as string) || positionals[1];
          const prodRetention = flags["prod-retention"] ? parseInt(flags["prod-retention"] as string, 10) : 3;
          const devRetention = flags["dev-retention"] ? parseInt(flags["dev-retention"] as string, 10) : 5;
          const dryRun = !!flags["dry-run"];
          const { enforceRetention } = require("./services/retentionExecutor");
          await ensureConnectivity();
          try {
            let result;
            if (projectArg && appArg) {
              logger.info(`Retention cleanup for project='${projectArg}' app='${appArg}' prodRetention=${prodRetention} devRetention=${devRetention}${dryRun ? " [DRY RUN]" : ""}`);
              result = await enforceRetention({ project: projectArg, app: appArg, prodRetention, devRetention, dryRun });
            } else if (projectArg) {
              // Discover all app-* folders for the given project
              const { streamAllKeys } = require("./services/s3Client");
              const discoveredApps: string[] = [];
              await streamAllKeys(`${projectArg}/`, async (appObjs: Array<{ key: string }>) => {
                for (const appObj of appObjs) {
                  // appObj.key is e.g. Panther_GST-35/app-utils-storageCleaner/
                  const parts = appObj.key.split("/");
                  // Only consider folders with allowed prefixes directly under the project
                  if (parts.length === 3 && APP_PREFIXES.some(prefix => parts[1].startsWith(prefix))) {
                    discoveredApps.push(parts[1]);
                  }
                }
              }, { useDelimiter: true });
              logger.info(`Retention cleanup for project='${projectArg}' (all apps) prodRetention=${prodRetention} devRetention=${devRetention}${dryRun ? " [DRY RUN]" : ""}`);
              const results = [];
              for (const appName of discoveredApps) {
                const r = await enforceRetention({ project: projectArg, app: appName, prodRetention, devRetention, dryRun });
                if (r && r.deletedProdVersions && r.deletedDevFiles) {
                  results.push({ app: appName, ...r });
                }
              }
              result = { mode: "project", project: projectArg, results };
            } else {
              logger.info(`Global retention cleanup for all projects/apps prodRetention=${prodRetention} devRetention=${devRetention}${dryRun ? " [DRY RUN]" : ""}`);
              result = await enforceRetention({ prodRetention, devRetention, dryRun });
            }
            process.stdout.write(JSON.stringify(result, null, 2) + "\n");
          } catch (err: any) {
            logger.error(`Retention cleanup failed: ${err?.message || err}`);
            process.stderr.write(`Retention cleanup failed: ${err?.message || err}\n`);
            process.exit(2);
          }
          break;
      }
      case "help":
      case "--help":
      case "-h":
        process.stdout.write(usage() + "\n");
        break;
      default:
        process.stderr.write(`Unknown command: ${command}\n\n${usage()}\n`);
        process.exit(1);
    }
  } catch (err: any) {
    if (json) {
      process.stdout.write(
        JSON.stringify(
          { error: "runtime", message: err?.message || String(err) },
          null,
          2
        ) + "\n"
      );
    } else {
      logger.error(err?.message || String(err));
    }
    process.exit(process.exitCode ?? 3);
  }
}

if (require.main === module) {
  // eslint-disable-next-line @typescript-eslint/no-floating-promises
  main();
}