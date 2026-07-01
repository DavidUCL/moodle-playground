/**
 * Database restore step: restoreDatabase.
 *
 * Downloads a playground-compatible SQLite .sq3 file from a URL and installs
 * it as the runtime database, replacing whatever the snapshot or CLI install
 * produced. Runs as a normal blueprint step (after the install phase) — it
 * simply overwrites the MEMFS .sq3 file, then patches environment-specific
 * config values (wwwroot, dirroot, dataroot) so the restored data works
 * against this playground runtime rather than the source Moodle instance.
 *
 * The .sq3 must have been produced by mchef's `playground --data` export,
 * which uses the same SQLite driver patches as this runtime. A dump from a
 * standard MySQL/PostgreSQL Moodle will NOT work without that conversion.
 */

import {
  buildDatabaseFilePath,
  MOODLE_ROOT,
} from "../../runtime/config-template.js";

export function registerMoodleDatabaseSteps(register) {
  register("restoreDatabase", handleRestoreDatabase);
}

async function handleRestoreDatabase(step, context) {
  const { php, publish, scopeId, runtimeId } = context;

  const url = typeof step.url === "string" ? step.url.trim() : "";

  if (!url) {
    throw new Error("restoreDatabase: 'url' is required.");
  }
  if (!/^https?:\/\//iu.test(url)) {
    throw new Error("restoreDatabase: 'url' must be an http(s) URL.");
  }

  if (publish) {
    publish("Downloading database snapshot...", 0.921);
  }

  let bytes;
  try {
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    bytes = new Uint8Array(await response.arrayBuffer());
  } catch (err) {
    throw new Error(
      `restoreDatabase: failed to fetch '${url}': ${err.message || err}`,
    );
  }

  if (bytes.length < 100) {
    throw new Error(
      "restoreDatabase: downloaded file is too small to be a valid SQLite database.",
    );
  }

  // Compute the MEMFS database path via the shared formula (same one bootstrap.js
  // uses to write the live DB in the first place — see config-template.js).
  const dbPath = buildDatabaseFilePath(scopeId, runtimeId);

  if (publish) {
    publish(`Restoring database (${bytes.length} bytes)...`, 0.922);
  }

  await php.writeFile(dbPath, bytes);

  // Patch environment-specific config values that differ between the source
  // Moodle instance and this playground runtime. PLAYGROUND_SKIP_INITIALISE_CFG
  // prevents mdl_config from overwriting the correct config.php values before
  // we can fix them.
  //
  // This is the one part of the step that MUST succeed for the restored site to
  // be usable — a wrong wwwroot/dirroot/dataroot leaves it broken or stuck in a
  // redirect loop. Per ADR-0005 we still don't throw (a failure here doesn't
  // undo the .sq3 write above, and aborting would only prevent later blueprint
  // steps from running too), but we surface it loudly via publish()/console.error
  // instead of silently doing nothing, which is what happened before: a PHP
  // fatal (e.g. require_once failing) exits before printing anything, so
  // php.run() either throws or returns empty/non-JSON text, and both cases used
  // to be swallowed without any indication the patch never applied.
  let text = "";
  try {
    const result = await php.run(buildRestoreEnvPatchPhp());
    text = result?.text || "";
  } catch (err) {
    reportEnvPatchFailure(
      publish,
      `restoreDatabase: environment patch crashed: ${err.message || err}`,
    );
    return;
  }

  const jsonStart = text.indexOf("{");
  let payload = null;
  if (jsonStart >= 0) {
    try {
      payload = JSON.parse(text.slice(jsonStart));
    } catch {
      payload = null;
    }
  }

  if (payload === null) {
    reportEnvPatchFailure(
      publish,
      `restoreDatabase: environment patch produced no parseable result ` +
        `(likely a PHP fatal before it could report). Raw output: ${text.slice(0, 300)}`,
    );
    return;
  }

  if (!payload.ok) {
    console.warn(
      "[restoreDatabase] Environment patch reported issues:",
      payload?.error?.message || text.slice(0, 200),
    );
  }

  if (publish) {
    publish("Database restored.", 0.924);
  }
}

function reportEnvPatchFailure(publish, message) {
  console.error(`[restoreDatabase] ${message}`);
  if (publish) {
    publish(message, 0.923);
  }
}

function buildRestoreEnvPatchPhp() {
  return `<?php
define('CLI_SCRIPT', true);
// Prevent mdl_config values (from the source Moodle instance) from overriding
// the correct playground values set in config.php.
if (!defined('PLAYGROUND_SKIP_INITIALISE_CFG')) {
    define('PLAYGROUND_SKIP_INITIALISE_CFG', true);
}
if (!defined('CACHE_DISABLE_ALL')) {
    define('CACHE_DISABLE_ALL', true);
}
ob_start();
$result = ['ok' => false];
try {
    require_once('${MOODLE_ROOT}/config.php');
    require_once($CFG->libdir . '/moodlelib.php');

    // Overwrite source-instance paths with playground runtime values.
    set_config('wwwroot', $CFG->wwwroot);
    set_config('dirroot', $CFG->dirroot);
    set_config('dataroot', $CFG->dataroot);

    // Force a version-hash recalculation to avoid the "upgrade needed" redirect.
    set_config('allversionshash', '');

    // Clear the post-install admin setup flag (causes redirect loops if left set).
    if (!empty($CFG->adminsetuppending)) {
        unset_config('adminsetuppending');
    }

    // Suppress user tours — distracting in a demo/preview environment.
    try {
        $DB->execute("UPDATE {tool_usertours_tours} SET enabled = 0 WHERE enabled = 1");
    } catch (Throwable $toursError) {
        $result['warning']['usertours'] = $toursError->getMessage();
    }

    $result['ok'] = true;
} catch (Throwable $error) {
    $result['error'] = [
        'type' => get_class($error),
        'message' => $error->getMessage(),
        'file' => $error->getFile(),
        'line' => $error->getLine(),
    ];
}
$buffer = ob_get_clean();
if ($buffer !== '') {
    $result['output'] = $buffer;
}
echo json_encode($result, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES);
`;
}

export const __testables = { buildRestoreEnvPatchPhp };
