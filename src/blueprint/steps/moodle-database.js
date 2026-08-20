/**
 * Database restore step: restoreDatabase.
 *
 * Downloads a playground-compatible SQLite .sq3 file from a URL and installs
 * it as the runtime database, replacing whatever the snapshot or CLI install
 * produced. Runs as a normal blueprint step (after the install phase). See
 * docs/decisions/0017-restore-database-step.md.
 *
 * The download is streamed inside PHP straight to a MEMFS temp file (the same
 * memory-efficient path restoreCourse uses — no whole-database JS buffer), and
 * the first 16 bytes are verified against the SQLite magic header before the
 * live database is touched. The swap itself happens inside PHP *before*
 * config.php is loaded, so the environment patch (wwwroot, dirroot, dataroot,
 * allversionshash) runs against the restored database. After a successful
 * swap the step purges Moodle's caches and re-runs the boot-time config
 * normalizer and theme CSS warmup via hooks the bootstrap passes in the step
 * context, so a restored database gets the same treatment the boot database
 * did.
 *
 * Failure semantics (ADR-0005): anything that fails BEFORE the live database
 * is replaced throws — the step failed and nothing changed. Anything that
 * fails AFTER the swap is reported loudly via publish() but does not throw
 * (aborting cannot undo the swap), and the success message is only published
 * when every mandatory part actually succeeded.
 *
 * The .sq3 must have been produced by mchef's `playground --snapshot` export,
 * which uses the same SQLite driver patches as this runtime. A dump from a
 * standard MySQL/PostgreSQL Moodle will NOT work without that conversion.
 */

import {
  buildDatabaseFilePath,
  MOODLE_ROOT,
} from "../../runtime/config-template.js";
import { escapePhp, phpPurgeMoodleCaches } from "../php/helpers.js";
import { isHttpUrl, trimmedString } from "./step-utils.js";

// MEMFS path the snapshot is streamed to before the swap. Outside Moodle's
// tempdir (/tmp/moodle) so Moodle's own temp cleanup can never race it.
const RESTORE_TMP_PATH = "/tmp/playground-restore-db.sq3";

export function registerMoodleDatabaseSteps(register) {
  register("restoreDatabase", handleRestoreDatabase);
}

async function handleRestoreDatabase(step, context) {
  const { php, publish, scopeId, runtimeId } = context;

  const url = trimmedString(step.url);

  if (!url) {
    throw new Error("restoreDatabase: 'url' is required.");
  }
  if (!isHttpUrl(url)) {
    throw new Error("restoreDatabase: 'url' must be an http(s) URL.");
  }

  if (publish) {
    publish("Downloading database snapshot...", 0.921);
  }

  // Phase 1 — streamed download + validation. The live database is untouched,
  // so any failure here throws (the step honestly failed, nothing changed).
  let download = null;
  try {
    download = await runJsonPhp(php, buildRestoreDownloadPhp(url));
  } catch (err) {
    throw new Error(`restoreDatabase: download crashed: ${err.message || err}`);
  }
  if (!download?.ok) {
    throw new Error(
      `restoreDatabase: failed to fetch '${url}': ${
        download?.error?.message ||
        "the download script produced no parseable result"
      }`,
    );
  }

  // Compute the MEMFS database path via the shared formula (same one bootstrap.js
  // uses to write the live DB in the first place — see config-template.js).
  const dbPath = buildDatabaseFilePath(scopeId, runtimeId);

  if (publish) {
    publish(`Restoring database (${download.bytes} bytes)...`, 0.922);
  }

  // Phase 2 — swap the file into place and patch environment-specific config.
  // The rename happens inside PHP before config.php loads, so the patch runs
  // against the restored database. PLAYGROUND_SKIP_INITIALISE_CFG prevents the
  // restored mdl_config from overriding the correct config.php values before
  // we can fix them.
  let patch = null;
  try {
    patch = await runJsonPhp(php, buildRestoreSwapAndPatchPhp(dbPath));
  } catch (err) {
    // A crash here may have happened before or after the rename — the safe
    // assumption is that the database may already be replaced, so don't throw
    // (aborting cannot undo it); report loudly instead and skip the success
    // message.
    reportRestoreFailure(
      publish,
      `restoreDatabase: environment patch crashed: ${err.message || err}`,
    );
    return;
  }

  if (patch === null) {
    reportRestoreFailure(
      publish,
      "restoreDatabase: environment patch produced no parseable result " +
        "(likely a PHP fatal before it could report).",
    );
    return;
  }

  if (!patch.ok && !patch.swapped) {
    // The live database was NOT touched — fail the step honestly.
    throw new Error(
      `restoreDatabase: ${patch?.error?.message || "could not install the downloaded database"}`,
    );
  }

  if (!patch.ok) {
    // Swapped but the env patch failed: the restored data is in place with the
    // source instance's wwwroot/dirroot still in mdl_config — the site is
    // likely stuck in a redirect loop. Surface that instead of claiming
    // success (the auto-login that follows blueprint execution reads these
    // values from the database).
    reportRestoreFailure(
      publish,
      "restoreDatabase: database installed but the environment patch failed" +
        ` (${patch?.error?.message || "unknown error"}) — the site may redirect incorrectly.`,
    );
    return;
  }

  // Phase 3 — post-restore normalization (best-effort, reported not thrown).
  await runPostRestorePipeline(php, context);

  if (publish) {
    publish("Database restored.", 0.928);
  }
}

/**
 * Re-establish boot-time invariants against the freshly restored database:
 * purge caches built against the pre-restore DB, re-run the config normalizer
 * (defaults, cache-store seeding, allversionshash), and recompile theme CSS
 * under the restored DB's themerev (the localcache seed's sheets are keyed to
 * the old one). The hooks come from bootstrap.js via the step context.
 */
async function runPostRestorePipeline(php, context) {
  const { publish, runConfigNormalizer, runThemeCssWarmup } = context;

  if (typeof runConfigNormalizer !== "function") {
    // phpPurgeMoodleCaches() deliberately blanks allversionshash (its
    // pr-overlay caller WANTS upgrade detection) and only the normalizer
    // re-seeds it to the current code hash — so without the normalizer hook,
    // running the purge would strand the site on the upgrade screen. Skip
    // both and say so.
    if (publish) {
      publish(
        "restoreDatabase: config normalizer unavailable — skipping post-restore cache purge and normalization; stale cached values may persist.",
        0.925,
      );
    }
  } else {
    try {
      const purged = await runJsonPhp(php, phpPurgeMoodleCaches());
      if (!purged?.ok) {
        console.warn(
          "[restoreDatabase] post-restore cache purge reported failure:",
          purged?.error || "unknown error",
        );
      }
    } catch (err) {
      console.warn(
        "[restoreDatabase] post-restore cache purge crashed:",
        err.message || err,
      );
    }

    try {
      const normalized = await runConfigNormalizer();
      if (!normalized?.ok && publish) {
        publish(
          `restoreDatabase: post-restore config normalization failed: ${
            normalized?.error?.message || "unknown error"
          }`,
          0.926,
        );
      }
    } catch (err) {
      if (publish) {
        publish(
          `restoreDatabase: post-restore config normalization crashed: ${err.message || err}`,
          0.926,
        );
      }
    }
  }

  if (typeof runThemeCssWarmup === "function") {
    try {
      if (publish) {
        publish("Compiling theme CSS for the restored database...", 0.927);
      }
      const warmed = await runThemeCssWarmup();
      if (!warmed?.ok && publish) {
        publish(
          `restoreDatabase: theme CSS warmup failed: ${
            warmed?.error?.message || "unknown error"
          } — pages may be unstyled or slow on first view.`,
          0.927,
        );
      }
    } catch (err) {
      if (publish) {
        publish(
          `restoreDatabase: theme CSS warmup crashed: ${err.message || err} — pages may be unstyled or slow on first view.`,
          0.927,
        );
      }
    }
  }
}

// Run a generated PHP script and parse the JSON object it echoes. The scripts
// wrap their body in ob_start()/ob_get_clean(), so stdout is exactly the
// json_encode output and the first "{" reliably starts it. Returns null when
// no parseable JSON was produced (PHP fatal before the echo).
async function runJsonPhp(php, code) {
  const result = await php.run(code);
  const text = result?.text || "";
  const jsonStart = text.indexOf("{");
  if (jsonStart < 0) {
    return null;
  }
  try {
    return JSON.parse(text.slice(jsonStart));
  } catch {
    return null;
  }
}

function reportRestoreFailure(publish, message) {
  console.error(`[restoreDatabase] ${message}`);
  if (publish) {
    publish(message, 0.923);
  }
}

// Phase-1 script: stream the snapshot to a temp MEMFS file inside PHP (no
// large JS arrayBuffer — same download_file_content($tofile) path as
// phpRestoreCourse, with its 600s/30s timeouts) and validate it is actually
// a SQLite database before anything touches the live one.
function buildRestoreDownloadPhp(url) {
  return `<?php
define('CLI_SCRIPT', true);
ob_start();
$result = ['ok' => false];
try {
    require_once('${MOODLE_ROOT}/config.php');
    // setup.php only loads filelib (download_file_content) behind a proxy-config
    // conditional, so a bare config.php require does not provide it.
    require_once($CFG->libdir . '/filelib.php');

    $tmp = '${RESTORE_TMP_PATH}';
    @unlink($tmp);
    $dlok = download_file_content('${escapePhp(url)}', null, null, false, 600, 30, false, $tmp);
    if ($dlok === false || !is_file($tmp)) {
        throw new Exception('Could not download the database snapshot. The URL must be reachable and CORS-accessible (e.g. raw.githubusercontent.com).');
    }

    $size = filesize($tmp);
    if ($size < 512) {
        @unlink($tmp);
        throw new Exception('Downloaded file is too small to be a SQLite database (' . $size . ' bytes).');
    }

    // SQLite databases start with the 16-byte magic header "SQLite format 3\\x00".
    // Reject anything else (HTML error pages, JSON errors, redirects rendered
    // as 200s) BEFORE it can overwrite the live database.
    $fh = fopen($tmp, 'rb');
    $magic = $fh ? fread($fh, 16) : '';
    if ($fh) {
        fclose($fh);
    }
    if ($magic !== "SQLite format 3\\x00") {
        @unlink($tmp);
        throw new Exception('Downloaded file is not a SQLite database (magic header mismatch).');
    }

    $result['ok'] = true;
    $result['bytes'] = $size;
} catch (Throwable $error) {
    $result['error'] = [
        'type' => get_class($error),
        'message' => $error->getMessage(),
    ];
}
$buffer = ob_get_clean();
if ($buffer !== '') {
    $result['output'] = $buffer;
}
echo json_encode($result, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES);
`;
}

// Phase-2 script: move the validated snapshot over the live database, then
// patch environment-specific config values that differ between the source
// Moodle instance and this playground runtime. The rename happens BEFORE
// config.php loads so every set_config below writes to the restored database.
function buildRestoreSwapAndPatchPhp(dbPath) {
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
$result = ['ok' => false, 'swapped' => false];
try {
    $tmp = '${RESTORE_TMP_PATH}';
    $db = '${escapePhp(dbPath)}';
    if (!is_file($tmp)) {
        throw new Exception('Downloaded database is missing: ' . $tmp);
    }
    if (!@rename($tmp, $db)) {
        throw new Exception('Failed to move the restored database into place at ' . $db);
    }
    $result['swapped'] = true;

    require_once('${MOODLE_ROOT}/config.php');
    require_once($CFG->libdir . '/moodlelib.php');

    // Overwrite source-instance paths with playground runtime values.
    set_config('wwwroot', $CFG->wwwroot);
    set_config('dirroot', $CFG->dirroot);
    set_config('dataroot', $CFG->dataroot);

    // Seed allversionshash to the CURRENT code hash, exactly as the boot-time
    // config normalizer does (bootstrap.js createConfigNormalizerPhp). An
    // EMPTY hash would FORCE upgrade detection — moodle-plugins.js blanks it
    // deliberately and pairs that with upgrade_noncore() — stranding any
    // version-mismatched restore on the admin upgrade screen.
    set_config('allversionshash', core_component::get_all_versions_hash());

    // Clear the post-install admin setup flag (causes redirect loops if left set).
    if (!empty($CFG->adminsetuppending)) {
        unset_config('adminsetuppending');
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

export const __testables = {
  buildRestoreDownloadPhp,
  buildRestoreSwapAndPatchPhp,
  RESTORE_TMP_PATH,
};
