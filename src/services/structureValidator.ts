import { logger } from '../logger';

// Read allowed app prefixes from environment variable (comma-separated), fallback to default
const APP_PREFIXES: string[] = (process.env.APP_PREFIXES?.split(',').map(p => p.trim()).filter(Boolean)) || ['app-', 'fe-', 'utils-'];

/**
 * Validate required filesystem (prefix) structure for a single project.
 * Rules:
 * 1. Project root: <ProjectName_GST-#>/ must exist (assumed given prefix).
 * 2. Under project root: one or more data directories. Names must either:
 *    - start with 'app-' (application directory) OR
 *    - be exactly 'project'
 * 3. An 'app-' directory may contain zero, one, or both of 'dev/' and 'prod/'. No other immediate subdirectories are allowed.
 * 4. If present, 'prod/' must contain ONLY version directories named vN/ (N integer >=1). No other immediate entries.
 * 5. 'dev/' directory has no enforced internal structure (free-form).
 * 6. Version directories vN/ have no enforced internal structure (free-form).
 *
 * We operate on a list of discovered prefixes (directories) for the project.
 */
export interface StructureIssue {
  code: string;
  message: string;
  prefix: string;
  project?: string;
}

export interface StructureValidationResult {
  issues: StructureIssue[];
}

// Matches version directory names like v1/ v2/ etc (with trailing slash retained in prefix strings)
const VERSION_DIR_REGEX: RegExp = /^v\d+\/$/;

export function validateProjectStructure(projectRoot: string, allPrefixes: string[], opts?: { noGchat?: boolean }): StructureValidationResult {
  const issues: StructureIssue[] = [];
  // Extract project name from projectRoot (e.g. Panther_GST-35/ => Panther_GST-35)
  const projectName = projectRoot.replace(/\/$/, '');
  const normalizedRoot = projectRoot.endsWith('/') ? projectRoot : projectRoot + '/';
  // Filter prefixes belonging to this project (root inclusive)
  const projectPrefixes = allPrefixes.filter(p => p.startsWith(normalizedRoot));

  // Collect immediate children of project root (depth=1 beneath root)
  const immediateChildren = projectPrefixes
    .filter(p => p !== normalizedRoot)
    .filter(p => {
      const rel = p.substring(normalizedRoot.length); // e.g. 'app-foo/bar/' or 'project/'
      // immediate child has exactly one segment after removing trailing slash
      const segs = rel.split('/').filter(Boolean);
      return segs.length === 1; // only directories directly under project root
    });

  if (!immediateChildren.length) {
    issues.push({ code: 'NO_DATA_DIRS', prefix: normalizedRoot, message: 'Project root has no data directories (expected app-* or project/).', project: projectName });
  }

  for (const child of immediateChildren) {
    const baseName = child.slice(normalizedRoot.length); // includes trailing slash
  const isAppDir = APP_PREFIXES.some(prefix => baseName.startsWith(prefix));
    if (!(isAppDir || baseName === 'project/')) {
      issues.push({ code: 'INVALID_DATA_DIR_NAME', prefix: child, message: `Invalid data directory name '${baseName}'. Must start with one of [${APP_PREFIXES.join(', ')}] or be exactly 'project/'.`, project: projectName });
      continue;
    }
    // For app-/fe-/utils- directories, enforce allowed immediate children (only dev/ and/or prod/ if they exist).
    if (isAppDir) {
      const devPrefix = child + 'dev/';
      const prodPrefix = child + 'prod/';
      const hasDev = projectPrefixes.includes(devPrefix);
      const hasProd = projectPrefixes.includes(prodPrefix);
      // Identify any other direct child under app directory
      const appChildren = projectPrefixes.filter(p => p.startsWith(child) && p !== child).filter(p => {
        const rel = p.substring(child.length);
        const segs = rel.split('/').filter(Boolean);
        return segs.length === 1; // direct child
      });
      for (const ac of appChildren) {
        if (ac !== devPrefix && ac !== prodPrefix) {
          const name = ac.substring(child.length);
          issues.push({ code: 'INVALID_APP_CHILD', prefix: ac, message: `Invalid subdirectory '${name}' under '${child}'. Only 'dev/' or 'prod/' allowed.`, project: projectName });
        }
      }
      // Validate prod substructure only if prod exists
      if (hasProd) {
        // Immediate children of prodPrefix must all be version dirs (vN/)
        const prodChildren = projectPrefixes.filter(p => p.startsWith(prodPrefix) && p !== prodPrefix).filter(p => {
          const rel = p.substring(prodPrefix.length);
          const segs = rel.split('/').filter(Boolean);
          return segs.length === 1; // direct child
        });
        for (const pc of prodChildren) {
          const name = pc.substring(prodPrefix.length);
          if (!VERSION_DIR_REGEX.test(name)) {
            issues.push({ code: 'INVALID_PROD_CHILD', prefix: pc, message: `Non-version directory '${name}' under '${prodPrefix}'. Only vN/ directories allowed.`, project: projectName });
          }
        }
      }
    }
  }

  // Accept opts as an optional third argument for notification suppression
  if (issues.length) {
    for (const i of issues) {
      logger.warn(`Structure issue (${i.code}): ${i.message} [project=${i.project || projectName}]`, undefined, arguments[2]);
    }
  }

  return { issues };
}
