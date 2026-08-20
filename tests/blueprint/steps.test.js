import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { sanitizeArchivePath } from "../../lib/moodle-loader.js";
import {
  getRegisteredStepNames,
  getStepHandler,
} from "../../src/blueprint/steps/index.js";
import { __testables as dbTestables } from "../../src/blueprint/steps/moodle-database.js";

// A small but valid ZIP (shared with moodle-plugins.test.js) used to drive the
// plugin install handler past the download/extract phase into runMoodleUpgrade
// (where plugin-name validation lives) without hitting the network.
const SAMPLE_PLUGIN_ZIP_BASE64 =
  "UEsDBBQAAAAIAHcBgVyusmujBwAAAAUAAAAhAAAAbW9vZGxlLW1vZF9ib2FyZC1tYWluL3ZlcnNpb24ucGhws7EvyCgAAFBLAwQUAAAACAB3AYFczmE/Ew8AAAANAAAAKQAAAG1vb2RsZS1tb2RfYm9hcmQtbWFpbi9jbGFzc2VzL2V4YW1wbGUucGhws7EvyChQSE3OyFcwtAYAUEsBAhQDFAAAAAgAdwGBXK6ya6MHAAAABQAAACEAAAAAAAAAAAAAAIABAAAAAG1vb2RsZS1tb2RfYm9hcmQtbWFpbi92ZXJzaW9uLnBocFBLAQIUAxQAAAAIAHcBgVzOYT8TDwAAAA0AAAApAAAAAAAAAAAAAACAAUYAAABtb29kbGUtbW9kX2JvYXJkLW1haW4vY2xhc3Nlcy9leGFtcGxlLnBocFBLBQYAAAAAAgACAKYAAACcAAAAAAA=";

function decodeBase64Bytes(base64) {
  return Uint8Array.from(Buffer.from(base64, "base64"));
}

describe("step registry", () => {
  it("has all expected step names registered", () => {
    const expected = [
      "installMoodle",
      "setAdminAccount",
      "login",
      "setConfig",
      "setConfigs",
      "setConfigFile",
      "setConfigFiles",
      "setTheme",
      "setLandingPage",
      "createUser",
      "createUsers",
      "createCategory",
      "createCategories",
      "createCourse",
      "createCourses",
      "createSection",
      "createSections",
      "enrolUser",
      "enrolUsers",
      "addModule",
      "createRole",
      "createRoles",
      "importRolePreset",
      "importRoles",
      "createScale",
      "createScales",
      "createCohort",
      "createCohorts",
      "installMoodlePlugin",
      "installTheme",
      "installLanguagePack",
      "restoreCourse",
      "restoreDatabase",
      "mkdir",
      "rmdir",
      "writeFile",
      "writeFiles",
      "copyFile",
      "moveFile",
      "deleteFile",
      "deleteFiles",
      "unzip",
      "request",
      "runPhpCode",
      "runPhpScript",
      "purgeMoodleCaches",
      "applyPrOverlay",
    ];
    const registered = getRegisteredStepNames();
    for (const name of expected) {
      assert.ok(registered.includes(name), `Missing step: ${name}`);
    }
  });

  it("returns null for unknown steps", () => {
    assert.strictEqual(getStepHandler("doesNotExist"), null);
  });

  it("returns functions for known steps", () => {
    const handler = getStepHandler("login");
    assert.strictEqual(typeof handler, "function");
  });

  it("installMoodle handler is a no-op", async () => {
    const handler = getStepHandler("installMoodle");
    // Should not throw
    await handler({}, {});
  });

  it("setLandingPage returns landingPage", async () => {
    const handler = getStepHandler("setLandingPage");
    const result = await handler({ path: "/course/view.php" }, {});
    assert.strictEqual(result.landingPage, "/course/view.php");
  });

  it("setLandingPage throws without path", async () => {
    const handler = getStepHandler("setLandingPage");
    await assert.rejects(() => handler({}, {}), /path/);
  });

  it("setTheme is registered", () => {
    const handler = getStepHandler("setTheme");
    assert.strictEqual(typeof handler, "function");
  });

  it("setTheme throws without name", async () => {
    const handler = getStepHandler("setTheme");
    await assert.rejects(
      () => handler({}, { php: { run: async () => ({}) } }),
      /name/,
    );
  });

  it("setTheme runs php.run with a set_config('theme', ...) script", async () => {
    const handler = getStepHandler("setTheme");
    const calls = [];
    await handler(
      { name: "moove" },
      {
        php: {
          async run(code) {
            calls.push(code);
            return { text: '{"ok":true}' };
          },
        },
      },
    );
    assert.strictEqual(calls.length, 1);
    assert.ok(calls[0].includes("set_config('theme', 'moove'"));
    assert.ok(calls[0].includes("theme_reset_all_caches"));
  });
});

describe("sanitizeArchivePath (ZIP-slip prevention)", () => {
  it("passes through a normal relative path unchanged", () => {
    assert.strictEqual(sanitizeArchivePath("a/b/c.php"), "a/b/c.php");
  });

  it("drops '.' and empty segments", () => {
    assert.strictEqual(sanitizeArchivePath("./a//b/./c"), "a/b/c");
  });

  it("returns null for an empty or dot-only path", () => {
    assert.strictEqual(sanitizeArchivePath(""), null);
    assert.strictEqual(sanitizeArchivePath("."), null);
    assert.strictEqual(sanitizeArchivePath("./"), null);
  });

  it("throws on a leading '..' traversal", () => {
    assert.throws(
      () => sanitizeArchivePath("../etc/passwd"),
      /path traversal/i,
    );
  });

  it("throws on an embedded '..' segment", () => {
    assert.throws(() => sanitizeArchivePath("a/../../b"), /path traversal/i);
  });

  it("does not treat '..' inside a filename as traversal", () => {
    // Only a whole segment equal to ".." is traversal; "..foo" is a real name.
    assert.strictEqual(sanitizeArchivePath("a/..foo/b"), "a/..foo/b");
  });
});

describe("unzip step handler (ZIP-slip containment)", () => {
  const handler = getStepHandler("unzip");

  function createPhpMock() {
    const writes = [];
    const rawPhp = {
      mkdirTree() {},
      writeFile(path, data) {
        writes.push([path, data]);
      },
    };
    return { writes, php: { _php: rawPhp } };
  }

  it("only writes entries that stay within the destination", async () => {
    const { php, writes } = createPhpMock();
    // Stub the resolved entries by intercepting resources.resolve to return
    // ZIP bytes, then rely on readZipEntries' own sanitization. The known-good
    // sample ZIP extracts two safe entries under a top-level dir.
    const resources = {
      async resolve() {
        return decodeBase64Bytes(SAMPLE_PLUGIN_ZIP_BASE64);
      },
    };

    await handler(
      { destination: "/persist/moodledata/unzipped", data: "@dummy" },
      { php, resources },
    );

    // Every written path must be under the destination prefix.
    for (const [path] of writes) {
      assert.ok(
        path.startsWith("/persist/moodledata/unzipped/"),
        `Write escaped destination: ${path}`,
      );
    }
    assert.ok(writes.length > 0, "expected at least one safe write");
  });
});

describe("restoreDatabase step handler", () => {
  const handler = getStepHandler("restoreDatabase");

  const DOWNLOAD_OK = JSON.stringify({ ok: true, bytes: 4096 });
  const PATCH_OK = JSON.stringify({ ok: true, swapped: true });

  // php.run mock that replies with queued texts (or throws queued Errors) in
  // call order and records every script it was given.
  function makePhpMock(results = [DOWNLOAD_OK, PATCH_OK]) {
    const runs = [];
    const queue = [...results];
    return {
      runs,
      php: {
        async run(code) {
          runs.push(code);
          const next = queue.length ? queue.shift() : '{"ok":true}';
          if (next instanceof Error) {
            throw next;
          }
          return { text: next };
        },
      },
    };
  }

  it("throws when url is missing", async () => {
    await assert.rejects(() => handler({}, {}), /url.*required/i);
  });

  it("throws when url is not http(s)", async () => {
    await assert.rejects(
      () => handler({ url: "file:///tmp/db.sq3" }, {}),
      /http/i,
    );
  });

  it("throws when the download script reports failure (live DB untouched)", async () => {
    const mock = makePhpMock([
      JSON.stringify({ ok: false, error: { message: "HTTP 404" } }),
    ]);
    await assert.rejects(
      () => handler({ url: "https://example.com/db.sq3" }, { php: mock.php }),
      /HTTP 404/,
    );
    assert.strictEqual(mock.runs.length, 1, "must never reach the swap");
  });

  it("download PHP streams inside PHP and validates the SQLite magic header", () => {
    const php = dbTestables.buildRestoreDownloadPhp(
      "https://example.com/db.sq3",
    );
    assert.ok(php.includes("download_file_content("));
    assert.ok(php.includes("SQLite format 3"));
    assert.ok(php.includes(dbTestables.RESTORE_TMP_PATH));
    assert.ok(php.includes("require_once('/www/moodle/config.php')"));
    // setup.php only loads filelib behind a proxy-config conditional, so the
    // script must require it itself or download_file_content() is undefined.
    assert.ok(php.includes("require_once($CFG->libdir . '/filelib.php')"));
  });

  it("swap PHP renames the snapshot into place BEFORE loading config.php", () => {
    const php = dbTestables.buildRestoreSwapAndPatchPhp(
      "/persist/moodledata/moodle_a_b.sq3.php",
    );
    const renameAt = php.indexOf("rename(");
    const configAt = php.indexOf("require_once('/www/moodle/config.php')");
    assert.ok(renameAt >= 0, "expected a rename call");
    assert.ok(configAt >= 0, "expected the config.php require");
    assert.ok(renameAt < configAt, "rename must precede config.php load");
    assert.ok(php.includes("PLAYGROUND_SKIP_INITIALISE_CFG"));
  });

  it("swap PHP updates wwwroot, dirroot, dataroot and adminsetuppending", () => {
    const php = dbTestables.buildRestoreSwapAndPatchPhp("/x.sq3.php");
    assert.ok(php.includes("set_config('wwwroot'"));
    assert.ok(php.includes("set_config('dirroot'"));
    assert.ok(php.includes("set_config('dataroot'"));
    assert.ok(php.includes("adminsetuppending"));
  });

  it("swap PHP seeds allversionshash to the CURRENT code hash, never blank", () => {
    const php = dbTestables.buildRestoreSwapAndPatchPhp("/x.sq3.php");
    assert.ok(php.includes("core_component::get_all_versions_hash()"));
    assert.ok(
      !php.includes("set_config('allversionshash', '')"),
      "a blank hash FORCES upgrade detection (see moodle-plugins.js)",
    );
  });

  it("targets the shared MEMFS db path formula in the swap script", async () => {
    const mock = makePhpMock();
    await handler(
      { url: "https://example.com/mysite-20260630.sq3" },
      { php: mock.php, scopeId: "abc", runtimeId: "php83-moodle50" },
    );
    assert.strictEqual(mock.runs.length, 2);
    assert.ok(
      mock.runs[1].includes(
        "/persist/moodledata/moodle_abc_php83_moodle50.sq3.php",
      ),
      `unexpected swap script: ${mock.runs[1].slice(0, 400)}`,
    );
  });

  it("throws when the swap failed before touching the live database", async () => {
    const mock = makePhpMock([
      DOWNLOAD_OK,
      JSON.stringify({
        ok: false,
        swapped: false,
        error: { message: "rename failed" },
      }),
    ]);
    await assert.rejects(
      () => handler({ url: "https://example.com/db.sq3" }, { php: mock.php }),
      /rename failed/,
    );
  });

  it("reports failure and does NOT publish success when the env patch fails after the swap", async () => {
    const mock = makePhpMock([
      DOWNLOAD_OK,
      JSON.stringify({
        ok: false,
        swapped: true,
        error: { message: "set_config exploded" },
      }),
    ]);
    const published = [];
    // Must NOT throw — the swap already happened and aborting cannot undo it.
    await handler(
      { url: "https://example.com/db.sq3" },
      { php: mock.php, publish: (msg) => published.push(msg) },
    );
    assert.ok(
      published.some((msg) => /environment patch failed/i.test(msg)),
      `expected a patch-failure message in: ${JSON.stringify(published)}`,
    );
    assert.ok(!published.includes("Database restored."));
  });

  it("reports via publish() instead of silently continuing when php.run() crashes on the patch", async () => {
    const mock = makePhpMock([DOWNLOAD_OK, new Error("simulated WASM crash")]);
    const published = [];
    await handler(
      { url: "https://example.com/db.sq3" },
      { php: mock.php, publish: (msg) => published.push(msg) },
    );
    assert.ok(
      published.some((msg) => /crashed/i.test(msg)),
      `expected a crash message in: ${JSON.stringify(published)}`,
    );
    assert.ok(!published.includes("Database restored."));
  });

  it("reports via publish() when the patch returns no JSON", async () => {
    // Simulates a PHP fatal that exits before echoing the JSON result.
    const mock = makePhpMock([DOWNLOAD_OK, ""]);
    const published = [];
    await handler(
      { url: "https://example.com/db.sq3" },
      { php: mock.php, publish: (msg) => published.push(msg) },
    );
    assert.ok(
      published.some((msg) => /no parseable result/i.test(msg)),
      `expected a no-parseable-result message in: ${JSON.stringify(published)}`,
    );
    assert.ok(!published.includes("Database restored."));
  });

  it("publishes success and re-runs the normalizer + theme warmup via context hooks", async () => {
    // download, swap, cache purge
    const mock = makePhpMock([DOWNLOAD_OK, PATCH_OK, '{"ok":true}']);
    const published = [];
    let normalized = 0;
    let warmed = 0;
    await handler(
      { url: "https://example.com/db.sq3" },
      {
        php: mock.php,
        publish: (msg) => published.push(msg),
        runConfigNormalizer: async () => {
          normalized += 1;
          return { ok: true };
        },
        runThemeCssWarmup: async () => {
          warmed += 1;
          return { ok: true };
        },
      },
    );
    assert.strictEqual(normalized, 1);
    assert.strictEqual(warmed, 1);
    assert.strictEqual(mock.runs.length, 3, "download + swap + cache purge");
    assert.ok(mock.runs[2].includes("purge_all_caches"));
    assert.ok(published.includes("Database restored."));
  });

  it("skips the cache purge when the normalizer hook is unavailable", async () => {
    // phpPurgeMoodleCaches() blanks allversionshash; only the normalizer
    // re-seeds it, so without the hook the purge must not run.
    const mock = makePhpMock();
    const published = [];
    await handler(
      { url: "https://example.com/db.sq3" },
      { php: mock.php, publish: (msg) => published.push(msg) },
    );
    assert.strictEqual(mock.runs.length, 2, "download + swap only, no purge");
    assert.ok(published.includes("Database restored."));
  });
});

describe("installMoodlePlugin plugin-name validation (code injection guard)", () => {
  const handler = getStepHandler("installMoodlePlugin");

  function createPhpMock() {
    const runCalls = [];
    const rawPhp = {
      mkdirTree() {},
      writeFile() {},
    };
    return {
      runCalls,
      php: {
        _php: rawPhp,
        async run(code) {
          runCalls.push(code);
          return { text: '{"ok":true}', errors: "" };
        },
      },
    };
  }

  it("rejects a malicious pluginName before generating upgrade PHP", async () => {
    const originalFetch = globalThis.fetch;
    const { php, runCalls } = createPhpMock();
    globalThis.fetch = async () =>
      new Response(decodeBase64Bytes(SAMPLE_PLUGIN_ZIP_BASE64), {
        status: 200,
        headers: { "content-type": "application/zip" },
      });

    try {
      await assert.rejects(
        () =>
          handler(
            {
              pluginType: "mod",
              pluginName: "evil', 'x'); evil();//",
              url: "https://example.com/plugin.zip",
            },
            { php },
          ),
        /invalid plugin name/i,
      );
    } finally {
      globalThis.fetch = originalFetch;
    }

    // The upgrade script must never have been generated/run for a bad name.
    assert.strictEqual(runCalls.length, 0);
  });

  it("accepts a valid frankenstyle pluginName", async () => {
    const originalFetch = globalThis.fetch;
    const { php, runCalls } = createPhpMock();
    globalThis.fetch = async () =>
      new Response(decodeBase64Bytes(SAMPLE_PLUGIN_ZIP_BASE64), {
        status: 200,
        headers: { "content-type": "application/zip" },
      });

    try {
      await handler(
        {
          pluginType: "mod",
          pluginName: "board",
          url: "https://example.com/plugin.zip",
        },
        { php },
      );
    } finally {
      globalThis.fetch = originalFetch;
    }

    // Upgrade ran, and the generated component string is exactly mod_board.
    assert.strictEqual(runCalls.length, 1);
    assert.ok(
      runCalls[0].includes(
        "playground_refresh_installed_plugin_cache('mod_board'",
      ),
    );
  });
});
