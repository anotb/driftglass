import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, copyFile, link, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const relay = fileURLToPath(new URL("../driftglass-relay/driftglass-relay.mjs", import.meta.url));
const ts = await readFile(new URL("../src/relay-capabilities.ts", import.meta.url), "utf8");
const workspaceCapability = ts.match(/WORKSPACE_MIRROR_CAPABILITY\s*=\s*"([^"]+)"/)?.[1];
const workerCapabilities = [
  ...ts.matchAll(/\bid:\s*"([^"]+)"/g),
].map((match) => match[1]).concat(workspaceCapability ? [workspaceCapability] : []);
const relayCapabilities = JSON.parse(execFileSync(process.execPath, [relay, "capabilities"], { encoding: "utf8" })).capabilities;
const executableRelayCapabilities = relayCapabilities.filter((capability) => capability !== workspaceCapability);

const requiredArgs = {
  "x.search": ["--query", "post"],
  "x.list": ["--id", "123"],
  "x.thread": ["--id", "123"],
  "x.user": ["--name", "cloudflare"],
  "x.user-posts": ["--name", "cloudflare"],
  "x.article": ["--id", "123"],
  "reddit.subreddit": ["--subreddit", "cloudflare"],
  "reddit.search": ["--query", "agents"],
  "reddit.thread": ["--id", "abc"],
  "reddit.user": ["--name", "spez"],
  "reddit.user-posts": ["--name", "spez"],
  "reddit.user-comments": ["--name", "spez"],
  "reddit.subreddit-info": ["--subreddit", "cloudflare"],
  "youtube.search": ["--query", "cloudflare agents"],
  "youtube.video": ["--id", "https://www.youtube.com/watch?v=dQw4w9WgXcQ"],
  "youtube.transcript": ["--id", "https://www.youtube.com/watch?v=dQw4w9WgXcQ"],
  "youtube.comments": ["--id", "https://www.youtube.com/watch?v=dQw4w9WgXcQ"],
  "youtube.channel": ["--id", "cloudflare"],
  "youtube.playlist": ["--id", "PL123"],
  "linkedin.jobs": ["--query", "platform engineer"],
  "linkedin.people": ["--query", "AI researcher"],
  "linkedin.job": ["--url", "https://www.linkedin.com/jobs/view/123"],
  "instagram.search": ["--query", "cloudflare"],
  "instagram.user": ["--name", "cloudflare"],
  "instagram.profile": ["--name", "cloudflare"],
  "facebook.search": ["--query", "cloudflare"],
  "facebook.profile": ["--name", "cloudflare"],
  "tiktok.search": ["--query", "cloudflare"],
  "tiktok.user": ["--name", "cloudflare"],
  "tiktok.profile": ["--name", "cloudflare"],
  "opencli.read": ["--site", "hackernews", "--command", "top", "--params", '{"limit":2}'],
};

const fixtureManifest = fileURLToPath(new URL("./fixtures/opencli-manifest.json", import.meta.url));

function relayResult(args, env = {}, options = {}) {
  return spawnSync(process.execPath, [relay, ...args], {
    encoding: "utf8",
    maxBuffer: 8 * 1024 * 1024,
    env: { ...process.env, ...env },
    ...options,
  });
}

function isolatedEnvironment(root, extra = {}) {
  return {
    HOME: join(root, "home"),
    XDG_CONFIG_HOME: join(root, "config"),
    XDG_STATE_HOME: join(root, "state"),
    XDG_DATA_HOME: join(root, "data"),
    ...extra,
  };
}

async function writeExecutable(path, content = "#!/bin/sh\nexit 0\n") {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content, { mode: 0o755 });
  await chmod(path, 0o755);
}

async function writePrivateTokenFixture(root, content = "fixture-token\n") {
  const stateDirectory = join(root, "state", "driftglass");
  const tokenDirectory = join(stateDirectory, "tokens");
  const tokenPath = join(tokenDirectory, "collector-test.secret");
  await mkdir(tokenDirectory, { recursive: true, mode: 0o700 });
  await chmod(stateDirectory, 0o700);
  await chmod(tokenDirectory, 0o700);
  await writeFile(tokenPath, content, { mode: 0o600 });
  await chmod(tokenPath, 0o600);
  return tokenPath;
}

async function startCloudFixture(logPath, mode = "healthy") {
  const source = String.raw`
const { appendFileSync } = require("node:fs");
const http = require("node:http");
const logPath = process.argv[1];
const mode = process.argv[2];
let heartbeatCount = 0;
let jobCount = 0;
const server = http.createServer((request, response) => {
  const chunks = [];
  request.on("data", (chunk) => chunks.push(chunk));
  request.on("end", () => {
    const text = Buffer.concat(chunks).toString("utf8");
    let body = null;
    try { body = text ? JSON.parse(text) : null; } catch { body = text; }
    appendFileSync(logPath, JSON.stringify({ method: request.method, url: request.url, authorization: request.headers.authorization || null, body }) + "\n");
    response.setHeader("content-type", "application/json");
    if (mode === "transient" && request.url === "/collector/heartbeat") {
      heartbeatCount += 1;
      if (heartbeatCount === 1) {
        response.statusCode = 503;
        response.end(JSON.stringify({ error: "temporary heartbeat failure" }));
        return;
      }
    }
    if (mode === "transient" && request.url === "/collector/jobs") {
      jobCount += 1;
      if (jobCount === 1) {
        response.statusCode = 503;
        response.end(JSON.stringify({ error: "temporary poll failure" }));
        return;
      }
      response.statusCode = 204;
      response.end();
      return;
    }
    if (request.url === "/collector/pair") {
      response.end(JSON.stringify({ ok: true, collectorId: "collector-test", token: "fixture-token" }));
      return;
    }
    if (request.url === "/collector/workspaces") {
      if (mode === "stall") {
        response.write('{"ok":true,"workspaces":[');
        return;
      }
      if (request.headers.authorization !== "Bearer fixture-token") {
        response.statusCode = 401;
        response.end(JSON.stringify({ error: "Invalid collector token" }));
        return;
      }
      response.end(JSON.stringify({ ok: true, workspaces: [] }));
      return;
    }
    response.end(JSON.stringify({ ok: true }));
  });
});
server.listen(0, "127.0.0.1", () => console.log("PORT=" + server.address().port));
`;
  const child = spawn(process.execPath, ["-e", source, logPath, mode], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  const port = await new Promise((resolvePromise, rejectPromise) => {
    const timer = setTimeout(() => rejectPromise(new Error("Cloud fixture did not start")), 5_000);
    let output = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      output += chunk;
      const match = output.match(/PORT=(\d+)/);
      if (!match) return;
      clearTimeout(timer);
      resolvePromise(Number(match[1]));
    });
    child.once("error", (error) => {
      clearTimeout(timer);
      rejectPromise(error);
    });
    child.once("exit", (code) => {
      if (code === 0) return;
      clearTimeout(timer);
      rejectPromise(new Error(`Cloud fixture exited ${code}`));
    });
  });
  return {
    url: `http://localhost:${port}`,
    async stop() {
      if (child.exitCode !== null) return;
      child.kill("SIGTERM");
      await new Promise((resolvePromise) => child.once("exit", resolvePromise));
    },
  };
}

async function startResultOutboxFixture(logPath, resultStatuses, jobId = "11111111-1111-4111-8111-111111111111") {
  const source = String.raw`
const { appendFileSync } = require("node:fs");
const http = require("node:http");
const logPath = process.argv[1];
const resultStatuses = JSON.parse(process.argv[2]);
const jobId = process.argv[3];
let jobIssued = false;
let resultCount = 0;
const server = http.createServer((request, response) => {
  const chunks = [];
  request.on("data", (chunk) => chunks.push(chunk));
  request.on("end", () => {
    const text = Buffer.concat(chunks).toString("utf8");
    let body = null;
    try { body = text ? JSON.parse(text) : null; } catch { body = text; }
    appendFileSync(logPath, JSON.stringify({ method: request.method, url: request.url, body }) + "\n");
    response.setHeader("content-type", "application/json");
    if (request.url === "/collector/heartbeat") {
      response.end(JSON.stringify({ ok: true }));
      return;
    }
    if (request.url === "/collector/jobs") {
      if (!jobIssued) {
        jobIssued = true;
        response.end(JSON.stringify({
          ok: true,
          job: {
            id: jobId,
            operation: "opencli.read",
            args: { site: "hackernews", command: "top", params: { limit: 2 } },
          },
        }));
        return;
      }
      response.statusCode = 204;
      response.end();
      return;
    }
    if (/^\/collector\/jobs\/[^/]+\/result$/.test(request.url)) {
      const outcome = resultStatuses[Math.min(resultCount, resultStatuses.length - 1)];
      resultCount += 1;
      if (outcome === "drop") {
        request.socket.destroy();
        return;
      }
      response.statusCode = Number(outcome);
      if (response.statusCode >= 200 && response.statusCode < 300) {
        response.end(JSON.stringify({ ok: true, accepted: 1, duplicate: resultCount > 1 }));
      } else {
        response.end(JSON.stringify({ error: "fixture result acknowledgement unavailable" }));
      }
      return;
    }
    response.statusCode = 404;
    response.end(JSON.stringify({ error: "not found" }));
  });
});
server.listen(0, "127.0.0.1", () => console.log("PORT=" + server.address().port));
`;
  const child = spawn(process.execPath, ["-e", source, logPath, JSON.stringify(resultStatuses), jobId], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  const port = await new Promise((resolvePromise, rejectPromise) => {
    const timer = setTimeout(() => rejectPromise(new Error("Result outbox fixture did not start")), 5_000);
    let output = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      output += chunk;
      const match = output.match(/PORT=(\d+)/);
      if (!match) return;
      clearTimeout(timer);
      resolvePromise(Number(match[1]));
    });
    child.once("error", (error) => {
      clearTimeout(timer);
      rejectPromise(error);
    });
    child.once("exit", (code) => {
      if (code === 0) return;
      clearTimeout(timer);
      rejectPromise(new Error(`Result outbox fixture exited ${code}`));
    });
  });
  return {
    url: `http://localhost:${port}`,
    async stop() {
      if (child.exitCode !== null) return;
      child.kill("SIGTERM");
      await new Promise((resolvePromise) => child.once("exit", resolvePromise));
    },
  };
}

async function prepareOutboxRelay(root, cloudUrl) {
  const bin = join(root, "bin");
  const executionLog = join(root, "collector-executions.log");
  await writeExecutable(join(bin, "opencli"), `#!/bin/sh
if [ "$1" = "doctor" ]; then
  printf 'opencli ready\\n'
  exit 0
fi
printf 'executed\\n' >> "${executionLog}"
printf '[{"id":"hn-1","title":"Exact result fixture","url":"https://news.ycombinator.com/item?id=1"}]\\n'
`);
  await writeExecutable(join(bin, "systemctl"), "#!/bin/sh\nif [ \"$2\" = \"is-active\" ]; then\n  printf 'unknown\\n'\n  exit 4\nfi\nexit 0\n");
  const tokenPath = await writePrivateTokenFixture(root);
  const configDirectory = join(root, "config", "driftglass");
  await mkdir(configDirectory, { recursive: true });
  await writeFile(join(configDirectory, "relay.json"), JSON.stringify({
    baseUrl: cloudUrl,
    collectorId: "collector-test",
    tokenStore: { kind: "private-file", account: "collector-test", file: tokenPath },
    workspaceMirror: false,
  }));
  return {
    env: isolatedEnvironment(root, {
      PATH: [bin, "/usr/bin", "/bin"].join(delimiter),
      OPENCLI_MANIFEST: fixtureManifest,
    }),
    executionLog,
    outboxPath: join(root, "state", "driftglass", "result-outbox.json"),
    tokenPath,
    configPath: join(configDirectory, "relay.json"),
  };
}

test("Worker and Relay advertise exactly the same pairable capabilities", () => {
  assert.deepEqual(relayCapabilities, workerCapabilities);
});

test("every executable Relay capability produces a validated, inspectable read plan", () => {
  for (const operation of executableRelayCapabilities) {
    const args = [relay, "plan", "--operation", operation, "--limit", "2", ...(requiredArgs[operation] || [])];
    const result = spawnSync(process.execPath, args, {
      encoding: "utf8",
      env: { ...process.env, OPENCLI_MANIFEST: fileURLToPath(new URL("./fixtures/opencli-manifest.json", import.meta.url)) },
    });
    assert.equal(result.status, 0, `${operation}: ${result.stderr}`);
    const plan = JSON.parse(result.stdout);
    assert.ok(plan.candidates.length >= 1, `${operation} has no candidates`);
    assert.ok(plan.candidates.every((candidate) => ["opencli", "twitter", "rdt"].includes(candidate.command)));
  }
});

test("unknown or write capabilities are rejected before any executable runs", () => {
  const result = spawnSync(process.execPath, [relay, "plan", "--operation", "x.post", "--query", "hello"], { encoding: "utf8" });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /not allowlisted/i);
});

test("LinkedIn job search requires a query and treats bare --remote as a flag", () => {
  const missing = relayResult(["plan", "--operation", "linkedin.jobs"]);
  assert.notEqual(missing.status, 0);
  assert.match(missing.stderr, /linkedin\.jobs requires args\.query/i);

  const result = relayResult(["plan", "--operation", "linkedin.jobs", "--query", "platform engineer", "--remote"]);
  assert.equal(result.status, 0, result.stderr);
  const args = JSON.parse(result.stdout).candidates[0].args;
  const remoteIndex = args.indexOf("--remote");
  assert.ok(remoteIndex >= 0);
  assert.notEqual(args[remoteIndex + 1], "true");
});

test("version, help, and unknown commands use conventional output and exit codes", () => {
  const version = relayResult(["--version"]);
  assert.equal(version.status, 0, version.stderr);
  assert.equal(version.stdout.trim(), "0.9.0");

  const help = relayResult(["service-start", "--help"]);
  assert.equal(help.status, 0, help.stderr);
  for (const command of ["service-install", "service-start", "service-stop", "service-restart", "service-status", "service-uninstall"]) {
    assert.match(help.stdout, new RegExp(`\\b${command}\\b`));
  }

  const unknown = relayResult(["definitely-not-a-command"]);
  assert.notEqual(unknown.status, 0);
  assert.match(unknown.stderr, /Unknown command: definitely-not-a-command/);
  assert.match(unknown.stderr, /Usage:/);
});

test("Doctor fails without an executable collector and reports local-only readiness honestly", async () => {
  const root = await mkdtemp(join(tmpdir(), "driftglass-doctor-empty-"));
  try {
    const emptyPath = join(root, "empty-bin");
    await mkdir(emptyPath);
    const result = relayResult(["doctor"], isolatedEnvironment(root, {
      PATH: emptyPath,
      OPENCLI_MANIFEST: fixtureManifest,
    }));
    assert.notEqual(result.status, 0, result.stderr);
    const report = JSON.parse(result.stdout);
    assert.equal(report.ok, false);
    assert.equal(report.mode, "local-only");
    assert.equal(report.paired, false);
    assert.equal(report.localExecutableReady, false);
    assert.equal(report.probeChecked, false);
    assert.equal(report.probeReady, false);
    assert.equal(report.cloudChecked, false);
    assert.equal(report.cloudReady, false);
    assert.equal(report.serviceReady, false);
    assert.deepEqual(report.usableCollectors, []);
    assert.ok(report.blockers.some((blocker) => /No executable read collector/i.test(blocker)));
    assert.ok(report.notices.some((notice) => /unpaired/i.test(notice)));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Doctor separates executable readiness from an unrequested content probe", async () => {
  const root = await mkdtemp(join(tmpdir(), "driftglass-doctor-probe-"));
  try {
    const bin = join(root, "bin");
    await writeExecutable(join(bin, "opencli"), "#!/bin/sh\nprintf 'opencli ready\\n'\n");
    const result = relayResult(["doctor"], isolatedEnvironment(root, {
      PATH: [bin, "/usr/bin", "/bin"].join(delimiter),
      OPENCLI_MANIFEST: fixtureManifest,
    }));
    assert.equal(result.status, 0, result.stderr);
    const report = JSON.parse(result.stdout);
    assert.equal(report.ok, true);
    assert.equal(report.mode, "local-only");
    assert.equal(report.localExecutableReady, true);
    assert.equal(report.probeChecked, false);
    assert.equal(report.probeReady, false);
    assert.equal(report.contentProbe.status, "not-requested");
    assert.equal(report.cloudChecked, false);
    assert.equal(report.cloudReady, false);
    assert.equal(report.serviceReady, false);
    assert.deepEqual(report.usableCollectors, ["opencli"]);
    assert.deepEqual(report.blockers, []);
    assert.deepEqual(report.polling, {
      minimumMs: 15_000,
      maximumMs: 120_000,
      heartbeatMs: 240_000,
      detailedHeartbeatMs: 21_600_000,
      workspaceSyncMs: 900_000,
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Empty OpenCLI profile inventory falls back to unscoped Browser Bridge Doctor", async () => {
  const root = await mkdtemp(join(tmpdir(), "driftglass-opencli-bridge-"));
  try {
    const bin = join(root, "bin");
    const commandLog = join(root, "commands.log");
    await writeExecutable(join(bin, "opencli"), `#!/bin/sh
printf '%s\n' "$*" >> "${commandLog}"
if [ "$1" = "profile" ] && [ "$2" = "list" ]; then
  if [ -n "$OPENCLI_PROFILE" ]; then exit 8; fi
  printf 'No Browser Bridge profiles connected.\n'
  exit 0
fi
if [ "$1" = "doctor" ]; then
  if [ -n "$OPENCLI_PROFILE" ]; then exit 8; fi
  printf '[MISSING] Extension: not connected\n[FAIL] Connectivity: failed (Browser Bridge extension not connected)\n'
  exit 0
fi
printf '[{"id":"unexpected","title":"Unexpected execution"}]\n'
`);
    const env = isolatedEnvironment(root, {
      PATH: [bin, "/usr/bin", "/bin"].join(delimiter),
      OPENCLI_MANIFEST: fixtureManifest,
    });
    const started = Date.now();
    const result = relayResult([
      "probe",
      "--operation", "reddit.frontpage",
      "--profile", "driftglass",
      "--limit", "3",
    ], env);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Browser Bridge is not connected/i);
    assert.ok(Date.now() - started < 5_000, "disconnected bridge should fail before the collection timeout");
    assert.deepEqual((await readFile(commandLog, "utf8")).trim().split("\n"), ["profile list", "doctor"]);

    const doctor = relayResult(["doctor", "--profile", "driftglass"], env);
    assert.notEqual(doctor.status, 0);
    const report = JSON.parse(doctor.stdout);
    assert.equal(report.opencliBrowserBridgeReady, false);
    assert.equal(report.opencliProfileReady, false);
    assert.equal(report.opencliSetupStatus, "bridge-disconnected");
    assert.equal(report.localExecutableReady, false);
    assert.ok(report.blockers.some((blocker) => /Browser Bridge is not connected/i.test(blocker)));
    assert.deepEqual((await readFile(commandLog, "utf8")).trim().split("\n"), [
      "profile list", "doctor", "profile list", "doctor",
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Unscoped Doctor distinguishes profile selection from a disconnected Browser Bridge", async () => {
  const root = await mkdtemp(join(tmpdir(), "driftglass-opencli-profile-required-"));
  try {
    const bin = join(root, "bin");
    const commandLog = join(root, "commands.log");
    await writeExecutable(join(bin, "opencli"), `#!/bin/sh
printf '%s\n' "$*" >> "${commandLog}"
if [ "$1" = "doctor" ]; then
  if [ -n "$OPENCLI_PROFILE" ]; then exit 8; fi
  printf '[MISSING] Extension: not connected\nProfiles:\n  context-one: connected v1.0.0\n  context-two: connected v1.0.0\n\nIssues:\n  Multiple Chrome profiles are connected to the daemon, but no default profile was selected.\n'
  exit 0
fi
exit 9
`);
    const result = relayResult(["doctor"], isolatedEnvironment(root, {
      PATH: [bin, "/usr/bin", "/bin"].join(delimiter),
      OPENCLI_MANIFEST: fixtureManifest,
    }));
    assert.notEqual(result.status, 0);
    const report = JSON.parse(result.stdout);
    assert.equal(report.opencliBrowserBridgeReady, true);
    assert.equal(report.opencliProfileReady, null);
    assert.equal(report.opencliSetupStatus, "profile-required");
    assert.ok(report.blockers.some((blocker) => /multiple connected profiles/i.test(blocker)));
    assert.ok(report.blockers.every((blocker) => !/Browser Bridge is not connected/i.test(blocker)));
    assert.deepEqual((await readFile(commandLog, "utf8")).trim().split("\n"), ["doctor"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Unprofiled OpenCLI readiness and execution preserve the same ambient profile", async () => {
  const root = await mkdtemp(join(tmpdir(), "driftglass-opencli-ambient-profile-"));
  try {
    const bin = join(root, "bin");
    const commandLog = join(root, "commands.log");
    await writeExecutable(join(bin, "opencli"), `#!/bin/sh
printf '%s|%s\n' "$*" "$OPENCLI_PROFILE" >> "${commandLog}"
if [ "$OPENCLI_PROFILE" != "ambient-profile" ]; then exit 8; fi
if [ "$1" = "doctor" ]; then
  printf '[PASS] Extension connected\n[PASS] Connectivity ready\n'
  exit 0
fi
if [ "$1" = "reddit" ] && [ "$2" = "frontpage" ]; then
  printf '[{"id":"reddit-1","title":"Ambient profile fixture","url":"https://www.reddit.com/r/test/comments/1"}]\n'
  exit 0
fi
exit 9
`);
    const result = relayResult([
      "probe",
      "--operation", "reddit.frontpage",
      "--limit", "3",
    ], isolatedEnvironment(root, {
      OPENCLI_PROFILE: "ambient-profile",
      PATH: [bin, "/usr/bin", "/bin"].join(delimiter),
      OPENCLI_MANIFEST: fixtureManifest,
    }));
    assert.equal(result.status, 0, result.stderr);
    const output = JSON.parse(result.stdout);
    assert.equal(output.provider, "opencli");
    assert.equal(output.returned, 1);
    assert.deepEqual((await readFile(commandLog, "utf8")).trim().split("\n"), [
      "doctor|ambient-profile",
      "reddit frontpage --limit 3 -f json|ambient-profile",
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Multiple connected profiles without a default report a missing dedicated alias from inventory", async () => {
  const root = await mkdtemp(join(tmpdir(), "driftglass-opencli-profile-missing-"));
  try {
    const bin = join(root, "bin");
    const commandLog = join(root, "commands.log");
    await writeExecutable(join(bin, "opencli"), `#!/bin/sh
printf '%s\n' "$*" >> "${commandLog}"
if [ "$1" = "doctor" ]; then
  printf '[MISSING] Extension: not connected\nMultiple Chrome profiles are connected to the daemon, but no default profile was selected.\n'
  exit 8
fi
if [ "$1" = "profile" ] && [ "$2" = "list" ]; then
  if [ -n "$OPENCLI_PROFILE" ]; then exit 8; fi
  printf 'Connected Browser Bridge profiles\n\n  context-one personal - connected v1.0.0\n  context-two work - connected v1.0.0\n'
  exit 0
fi
if [ "$1" = "--profile" ] && [ "$3" = "doctor" ]; then
  printf '[MISSING] Extension: not connected\n[FAIL] Connectivity: failed\n'
  exit 0
fi
printf '[{"id":"unexpected","title":"Unexpected execution"}]\n'
`);
    const env = isolatedEnvironment(root, {
      OPENCLI_PROFILE: "ambient-profile",
      PATH: [bin, "/usr/bin", "/bin"].join(delimiter),
      OPENCLI_MANIFEST: fixtureManifest,
    });
    const missingProfile = relayResult(["doctor", "--profile", "driftglass"], env);
    assert.notEqual(missingProfile.status, 0);
    const missingProfileReport = JSON.parse(missingProfile.stdout);
    assert.equal(missingProfileReport.opencliBrowserBridgeReady, true);
    assert.equal(missingProfileReport.opencliProfileReady, false);
    assert.equal(missingProfileReport.opencliSetupStatus, "profile-missing");
    assert.ok(missingProfileReport.blockers.some((blocker) => /profile is not available/i.test(blocker)));
    assert.ok(missingProfileReport.blockers.every((blocker) => !/Browser Bridge is not connected/i.test(blocker)));
    assert.deepEqual((await readFile(commandLog, "utf8")).trim().split("\n"), ["profile list"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("A named profile goes from inventory to scoped Doctor even when unscoped Doctor requires a default", async () => {
  const root = await mkdtemp(join(tmpdir(), "driftglass-opencli-profile-scoped-"));
  try {
    for (const fixture of [
      { name: "ready", scoped: "[PASS] Extension connected\\n[PASS] Connectivity ready\\n", succeeds: true },
      { name: "unready", scoped: "[MISSING] Extension: not connected\\n[FAIL] Connectivity: failed\\n", succeeds: false },
    ]) {
      const caseRoot = join(root, fixture.name);
      const bin = join(caseRoot, "bin");
      const commandLog = join(caseRoot, "commands.log");
      await writeExecutable(join(bin, "opencli"), `#!/bin/sh
printf '%s\n' "$*" >> "${commandLog}"
if [ "$1" = "doctor" ]; then
  printf '[MISSING] Extension: not connected\nMultiple Chrome profiles are connected to the daemon, but no default profile was selected.\n'
  exit 0
fi
if [ "$1" = "profile" ] && [ "$2" = "list" ]; then
  if [ -n "$OPENCLI_PROFILE" ]; then exit 8; fi
  printf 'Connected Browser Bridge profiles\n\n  context-one personal - connected v1.0.0\n  context-two driftglass - connected v1.0.0\n'
  exit 0
fi
if [ "$1" = "--profile" ] && [ "$2" = "driftglass" ] && [ "$3" = "doctor" ]; then
  if [ "$OPENCLI_PROFILE" != "driftglass" ]; then exit 8; fi
  printf '%b' "$DRIFTGLASS_SCOPED_DOCTOR"
  exit 0
fi
exit 9
`);
      const env = isolatedEnvironment(caseRoot, {
        DRIFTGLASS_SCOPED_DOCTOR: fixture.scoped,
        OPENCLI_PROFILE: "ambient-profile",
        PATH: [bin, "/usr/bin", "/bin"].join(delimiter),
        OPENCLI_MANIFEST: fixtureManifest,
      });
      const result = relayResult(["doctor", "--profile", "driftglass"], env);
      assert.equal(result.status === 0, fixture.succeeds, result.stderr);
      const report = JSON.parse(result.stdout);
      assert.equal(report.opencliBrowserBridgeReady, true);
      assert.equal(report.opencliProfileReady, fixture.succeeds);
      assert.equal(report.opencliSetupStatus, fixture.succeeds ? "ready" : "profile-unready");
      if (!fixture.succeeds) {
        assert.ok(report.blockers.some((blocker) => /profile is not ready/i.test(blocker)));
        assert.ok(report.blockers.every((blocker) => !/Browser Bridge is not connected/i.test(blocker)));
      }
      assert.deepEqual((await readFile(commandLog, "utf8")).trim().split("\n"), [
        "profile list",
        "--profile driftglass doctor",
      ]);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Cold OpenCLI daemon refreshes profile inventory before explicit scoped readiness", async () => {
  const root = await mkdtemp(join(tmpdir(), "driftglass-opencli-cold-profile-"));
  try {
    for (const fixture of [
      {
        name: "bootstrap-ready-scoped-ready",
        bootstrap: "[PASS] Extension connected\\n[PASS] Connectivity ready\\n",
        scoped: "[PASS] Extension connected\\n[PASS] Connectivity ready\\n",
        succeeds: true,
      },
      {
        name: "bootstrap-profile-required-scoped-unready",
        bootstrap: "[MISSING] Extension: not connected\\nMultiple Chrome profiles are connected to the daemon, but no default profile was selected.\\n",
        scoped: "[MISSING] Extension: not connected\\n[FAIL] Connectivity: failed\\n",
        succeeds: false,
      },
    ]) {
      const caseRoot = join(root, fixture.name);
      const bin = join(caseRoot, "bin");
      const commandLog = join(caseRoot, "commands.log");
      const daemonReady = join(caseRoot, "daemon-ready");
      await writeExecutable(join(bin, "opencli"), `#!/bin/sh
printf '%s\n' "$*" >> "${commandLog}"
if [ "$1" = "profile" ] && [ "$2" = "list" ]; then
  if [ -n "$OPENCLI_PROFILE" ]; then exit 8; fi
  if [ -f "${daemonReady}" ]; then
    printf 'Connected Browser Bridge profiles\n\n  context-one personal - connected v1.0.0\n  context-two driftglass - connected v1.0.0\n'
  else
    printf 'Daemon is not running. Run opencli doctor after opening Chrome.\n'
  fi
  exit 0
fi
if [ "$1" = "doctor" ]; then
  if [ -n "$OPENCLI_PROFILE" ]; then exit 8; fi
  : > "${daemonReady}"
  printf '%b' "$DRIFTGLASS_BOOTSTRAP_DOCTOR"
  exit 0
fi
if [ "$1" = "--profile" ] && [ "$2" = "driftglass" ] && [ "$3" = "doctor" ]; then
  if [ "$OPENCLI_PROFILE" != "driftglass" ]; then exit 8; fi
  printf '%b' "$DRIFTGLASS_SCOPED_DOCTOR"
  exit 0
fi
exit 9
`);
      const result = relayResult(["doctor", "--profile", "driftglass"], isolatedEnvironment(caseRoot, {
        DRIFTGLASS_BOOTSTRAP_DOCTOR: fixture.bootstrap,
        DRIFTGLASS_SCOPED_DOCTOR: fixture.scoped,
        OPENCLI_PROFILE: "ambient-profile",
        PATH: [bin, "/usr/bin", "/bin"].join(delimiter),
        OPENCLI_MANIFEST: fixtureManifest,
      }));
      assert.equal(result.status === 0, fixture.succeeds, result.stderr);
      const report = JSON.parse(result.stdout);
      assert.equal(report.opencliBrowserBridgeReady, true);
      assert.equal(report.opencliProfileReady, fixture.succeeds);
      assert.equal(report.opencliSetupStatus, fixture.succeeds ? "ready" : "profile-unready");
      assert.deepEqual((await readFile(commandLog, "utf8")).trim().split("\n"), [
        "profile list",
        "doctor",
        "profile list",
        "--profile driftglass doctor",
      ]);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("OpenCLI manifest adapters marked browser-free bypass Browser Bridge preflight", async () => {
  const root = await mkdtemp(join(tmpdir(), "driftglass-opencli-public-"));
  try {
    const bin = join(root, "bin");
    const manifest = join(root, "manifest.json");
    await writeFile(manifest, JSON.stringify([{
      site: "hackernews",
      name: "top",
      access: "read",
      browser: false,
      args: [{ name: "limit", type: "int" }],
    }]));
    await writeExecutable(join(bin, "opencli"), `#!/bin/sh
if [ "$1" = "doctor" ]; then
  printf '[MISSING] Extension: not connected\n[FAIL] Connectivity: failed (Browser Bridge extension not connected)\n'
  exit 0
fi
printf '[{"id":"hn-1","title":"Public fixture","url":"https://news.ycombinator.com/item?id=1"},{"title":"Unusable fixture"},{"id":"hn-3","title":"Capped fixture","url":"https://news.ycombinator.com/item?id=3"},{"id":"hn-4","title":"Also capped","url":"https://news.ycombinator.com/item?id=4"}]\n'
`);
    const result = relayResult([
      "probe",
      "--operation", "opencli.read",
      "--site", "hackernews",
      "--command", "top",
      "--params", '{"limit":2}',
    ], isolatedEnvironment(root, {
      PATH: [bin, "/usr/bin", "/bin"].join(delimiter),
      OPENCLI_MANIFEST: manifest,
    }));
    assert.equal(result.status, 0, result.stderr);
    const output = JSON.parse(result.stdout);
    assert.equal(output.ok, true);
    assert.equal(output.operation, "opencli.read");
    assert.equal(output.provider, "opencli");
    assert.equal(output.returned, 1);
    assert.equal(output.collectionPartial, true);
    assert.equal(output.cappedRecords, 2, "the nested adapter limit must cap normalization, not the probe default");
    assert.equal(output.unusableRecords, 1);
    assert.deepEqual(output.fallbackFailures, []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Doctor blocks paired service readiness when its credential cannot be loaded", async () => {
  const root = await mkdtemp(join(tmpdir(), "driftglass-doctor-paired-"));
  try {
    const bin = join(root, "bin");
    await writeExecutable(join(bin, "opencli"));
    const env = isolatedEnvironment(root, {
      PATH: [bin, "/usr/bin", "/bin"].join(delimiter),
      OPENCLI_MANIFEST: fixtureManifest,
    });
    const configDirectory = join(root, "config", "driftglass");
    await mkdir(configDirectory, { recursive: true });
    await writeFile(join(configDirectory, "relay.json"), JSON.stringify({
      baseUrl: "https://private.example",
      collectorId: "collector-test",
      tokenStore: { kind: "private-file", account: "collector-test", file: join(root, "state", "driftglass", "tokens", "collector-test.secret") },
    }));
    const result = relayResult(["doctor"], env);
    assert.notEqual(result.status, 0, result.stderr);
    const report = JSON.parse(result.stdout);
    assert.equal(report.mode, "paired-connectivity");
    assert.equal(report.paired, true);
    assert.equal(report.localExecutableReady, true);
    assert.equal(report.probeChecked, false);
    assert.equal(report.probeReady, false);
    assert.equal(report.cloudChecked, false);
    assert.equal(report.cloudReady, false);
    assert.equal(report.serviceReady, false);
    assert.equal(report.ok, false);
    assert.ok(report.blockers.some((blocker) => /credential is unavailable/i.test(blocker)));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Doctor validates content-bearing output separately from local executable discovery", async () => {
  const root = await mkdtemp(join(tmpdir(), "driftglass-doctor-content-"));
  try {
    const bin = join(root, "bin");
    await writeExecutable(join(bin, "opencli"), `#!/bin/sh
if [ "$1" = "doctor" ]; then
  printf 'opencli ready\\n'
  exit 0
fi
printf '[{"id":"hn-1","title":"Content-bearing fixture","url":"https://news.ycombinator.com/item?id=1"}]\\n'
`);
    const result = relayResult([
      "doctor",
      "--probe-operation", "opencli.read",
      "--site", "hackernews",
      "--command", "top",
      "--params", '{"limit":2}',
    ], isolatedEnvironment(root, {
      PATH: [bin, "/usr/bin", "/bin"].join(delimiter),
      OPENCLI_MANIFEST: fixtureManifest,
    }));
    assert.equal(result.status, 0, result.stderr);
    const report = JSON.parse(result.stdout);
    assert.equal(report.mode, "probe-only");
    assert.equal(report.localExecutableReady, true);
    assert.equal(report.probeChecked, true);
    assert.equal(report.probeReady, true);
    assert.equal(report.contentProbe.status, "passed");
    assert.equal(report.contentProbe.operation, "opencli.read");
    assert.equal(report.contentProbe.provider, "opencli");
    assert.equal(report.contentProbe.returned, 1);
    assert.equal(report.cloudReady, false);
    assert.equal(report.serviceReady, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Doctor requires both a content probe and authenticated cloud check for service readiness", async () => {
  const root = await mkdtemp(join(tmpdir(), "driftglass-doctor-service-"));
  const logPath = join(root, "cloud-requests.ndjson");
  const cloud = await startCloudFixture(logPath);
  try {
    const bin = join(root, "bin");
    await writeExecutable(join(bin, "opencli"), `#!/bin/sh
if [ "$1" = "doctor" ]; then
  printf 'opencli ready\\n'
  exit 0
fi
printf '[{"id":"hn-1","title":"Content-bearing fixture","url":"https://news.ycombinator.com/item?id=1"}]\\n'
`);
    const env = isolatedEnvironment(root, {
      PATH: [bin, "/usr/bin", "/bin"].join(delimiter),
      OPENCLI_MANIFEST: fixtureManifest,
    });
    const configDirectory = join(root, "config", "driftglass");
    const tokenPath = await writePrivateTokenFixture(root);
    await mkdir(configDirectory, { recursive: true });
    await writeFile(join(configDirectory, "relay.json"), JSON.stringify({
      baseUrl: cloud.url,
      collectorId: "collector-test",
      tokenStore: { kind: "private-file", account: "collector-test", file: tokenPath },
    }));
    const result = relayResult([
      "doctor",
      "--probe-operation", "opencli.read",
      "--site", "hackernews",
      "--command", "top",
    ], env);
    assert.equal(result.status, 0, result.stderr);
    const report = JSON.parse(result.stdout);
    assert.equal(report.mode, "paired-service");
    assert.equal(report.localExecutableReady, true);
    assert.equal(report.probeReady, true);
    assert.equal(report.cloudChecked, true);
    assert.equal(report.cloudReady, true);
    assert.equal(report.cloud.authenticated, true);
    assert.equal(report.serviceReady, true);
    assert.equal(report.ok, true);
    const requests = (await readFile(logPath, "utf8")).trim().split("\n").map(JSON.parse);
    assert.deepEqual(requests.map((entry) => entry.url), ["/collector/workspaces"]);
    assert.equal(requests[0].authorization, "Bearer fixture-token");
  } finally {
    await cloud.stop();
    await rm(root, { recursive: true, force: true });
  }
});

test("Pair can require an explicit content-bearing lane without forcing probes for every adapter", async () => {
  const root = await mkdtemp(join(tmpdir(), "driftglass-pair-content-"));
  try {
    const bin = join(root, "bin");
    await writeExecutable(join(bin, "opencli"), `#!/bin/sh
if [ "$1" = "doctor" ]; then
  printf 'opencli ready\\n'
  exit 0
fi
printf '[]\\n'
`);
    const result = relayResult([
      "pair",
      "--url", "http://localhost:1",
      "--code", "ABCD1234",
      "--probe-operation", "opencli.read",
      "--site", "hackernews",
      "--command", "top",
    ], isolatedEnvironment(root, {
      PATH: [bin, "/usr/bin", "/bin"].join(delimiter),
      OPENCLI_MANIFEST: fixtureManifest,
    }));
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Pairing content probe failed/i);
    assert.doesNotMatch(result.stderr, /fetch failed|ECONNREFUSED/i);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Pairing and workspace mirroring do not require OpenCLI or Browser Bridge", async () => {
  const root = await mkdtemp(join(tmpdir(), "driftglass-pair-workspace-"));
  const logPath = join(root, "cloud-requests.ndjson");
  const cloud = await startCloudFixture(logPath);
  try {
    const numericLoopbackUrl = cloud.url.replace("localhost", "127.0.0.1");
    const env = isolatedEnvironment(root, {
      DRIFTGLASS_TEST_PLATFORM: "linux",
      PATH: ["/usr/bin", "/bin"].join(delimiter),
      OPENCLI_MANIFEST: join(root, "missing-manifest.json"),
    });
    const result = relayResult([
      "pair",
      "--url", numericLoopbackUrl,
      "--code", "ABCD1234",
    ], env);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Paired collector/i);

    const config = JSON.parse(await readFile(join(root, "config", "driftglass", "relay.json"), "utf8"));
    assert.equal(config.workspaceMirror, true);
    assert.equal(config.profile, undefined);

    const doctor = relayResult(["doctor"], env);
    assert.equal(doctor.status, 1, doctor.stderr);
    const report = JSON.parse(doctor.stdout);
    assert.equal(report.mode, "paired-connectivity");
    assert.equal(report.paired, true);
    assert.equal(report.cloudReady, true);
    assert.equal(report.cloud.authenticated, true);
    assert.equal(report.localExecutableReady, false);
    assert.equal(report.ok, false);

    const requests = (await readFile(logPath, "utf8")).trim().split("\n").map(JSON.parse);
    assert.deepEqual(requests.map((entry) => entry.url), ["/collector/pair", "/collector/workspaces"]);
    assert.ok(requests[0].body.capabilities.includes("workspace.mirror"));
  } finally {
    await cloud.stop();
    await rm(root, { recursive: true, force: true });
  }
});

test("Collector endpoints reject raw delimiters and normalized path escapes", async () => {
  const source = await readFile(relay, "utf8");
  const start = source.indexOf("function isLoopbackHostname(");
  const end = source.indexOf("\nasync function readBoundedResponseBytes(", start);
  assert.ok(start >= 0 && end > start);
  const collectorEndpoint = Function(`"use strict";\n${source.slice(start, end)}\nreturn collectorEndpoint;`)();

  assert.equal(
    collectorEndpoint("http://127.0.0.1:8787/", "/collector/workspaces").href,
    "http://127.0.0.1:8787/collector/workspaces",
  );
  for (const baseUrl of [
    "https://private.example?",
    "https://private.example#",
    "https://private.example/?",
    "https://private.example/#",
  ]) {
    assert.throws(
      () => collectorEndpoint(baseUrl, "/collector/pair"),
      /must not contain credentials, a query, or a fragment/,
      baseUrl,
    );
  }
  for (const path of [
    "/collector/../admin",
    "/collector/%2e%2e/admin",
    "/collector/%2E%2E/admin",
    "/collector/.%2e/admin",
  ]) {
    assert.throws(
      () => collectorEndpoint("https://private.example", path),
      /outside the paired Driftglass origin or Collector path/,
      path,
    );
  }
});

test("dashboard pairing keeps browser-source setup optional", async () => {
  const app = await readFile(new URL("../public/app.js", import.meta.url), "utf8");
  const start = app.indexOf("function pairCommands()");
  const end = app.indexOf("function renderPairOutput()", start);
  assert.ok(start >= 0 && end > start);
  const pairing = app.slice(start, end);
  assert.match(pairing, /driftglass-companion pair --url \$\{base\} --code \$\{code\} --start/);
  assert.doesNotMatch(pairing, /--profile|--probe-operation/);
  assert.match(app.slice(end, app.indexOf("async function compileLivingDossier", end)), /Add Reddit and X/);
});

test("pairing passes operating-system credentials through stdin, never argv or environment", async () => {
  const root = await mkdtemp(join(tmpdir(), "driftglass-pair-secret-boundary-"));
  const logPath = join(root, "cloud-requests.ndjson");
  const cloud = await startCloudFixture(logPath);
  try {
    for (const platform of ["darwin", "win32"]) {
      const platformRoot = join(root, platform);
      const bin = join(platformRoot, "bin");
      const argsLog = join(platformRoot, "credential-args.log");
      const envLog = join(platformRoot, "credential-env.log");
      const stdinLog = join(platformRoot, "credential-stdin.log");
      await writeExecutable(join(bin, "opencli"), "#!/bin/sh\nprintf 'opencli ready\\n'\n");
      if (platform === "win32") {
        await writeExecutable(join(bin, "where.exe"), `#!/bin/sh
candidate="$(command -v "$1" 2>/dev/null || true)"
[ -n "$candidate" ] || exit 1
printf '%s\\n' "$candidate"
`);
      }
      const credentialCommand = platform === "darwin" ? "security" : "powershell.exe";
      const credentialFixture = platform === "darwin" ? `#!/bin/sh
printf '%s\\n' "$@" > "$DRIFTGLASS_CREDENTIAL_ARGS_LOG"
env > "$DRIFTGLASS_CREDENTIAL_ENV_LOG"
stdin="$(cat)"
printf '%s\\n' "$stdin" > "$DRIFTGLASS_CREDENTIAL_STDIN_LOG"
first="$(printf '%s\\n' "$stdin" | sed -n '1p')"
second="$(printf '%s\\n' "$stdin" | sed -n '2p')"
third="$(printf '%s\\n' "$stdin" | sed -n '3p')"
[ -n "$first" ] && [ "$first" = "$second" ] && [ -z "$third" ] || exit 36
` : `#!/bin/sh
printf '%s\\n' "$@" > "$DRIFTGLASS_CREDENTIAL_ARGS_LOG"
env > "$DRIFTGLASS_CREDENTIAL_ENV_LOG"
cat > "$DRIFTGLASS_CREDENTIAL_STDIN_LOG"
`;
      await writeExecutable(join(bin, credentialCommand), credentialFixture);
      const env = isolatedEnvironment(platformRoot, {
        DRIFTGLASS_TEST_PLATFORM: platform,
        DRIFTGLASS_CREDENTIAL_ARGS_LOG: argsLog,
        DRIFTGLASS_CREDENTIAL_ENV_LOG: envLog,
        DRIFTGLASS_CREDENTIAL_STDIN_LOG: stdinLog,
        APPDATA: join(platformRoot, "appdata"),
        LOCALAPPDATA: join(platformRoot, "localappdata"),
        PATH: [bin, "/usr/bin", "/bin"].join(delimiter),
        OPENCLI_MANIFEST: fixtureManifest,
      });
      const result = relayResult(["pair", "--url", cloud.url, "--code", "ABCD1234"], env);
      assert.equal(result.status, 0, `${platform}: ${result.stderr}`);
      assert.equal(
        await readFile(stdinLog, "utf8"),
        platform === "darwin" ? "fixture-token\nfixture-token\n" : "fixture-token\n",
      );
      assert.doesNotMatch(await readFile(argsLog, "utf8"), /fixture-token/);
      assert.doesNotMatch(await readFile(envLog, "utf8"), /fixture-token/);
      assert.doesNotMatch(result.stdout, /fixture-token/);
      assert.doesNotMatch(result.stderr, /fixture-token/);
      const configRoot = platform === "win32" ? join(platformRoot, "appdata") : join(platformRoot, "config");
      const config = JSON.parse(await readFile(join(configRoot, "driftglass", "relay.json"), "utf8"));
      if (platform === "darwin") {
        assert.match(await readFile(argsLog, "utf8"), /(?:^|\n)-w(?:\n|$)/);
        assert.equal(config.tokenStore.kind, "macos-keychain");
        await assert.rejects(
          lstat(join(platformRoot, "state", "driftglass", "tokens", "collector-test.secret")),
          (error) => error?.code === "ENOENT",
        );
      } else {
        assert.doesNotMatch(await readFile(envLog, "utf8"), /DRIFTGLASS_TOKEN_INPUT/);
        assert.equal(config.tokenStore.kind, "windows-dpapi");
      }
    }
  } finally {
    await cloud.stop();
    await rm(root, { recursive: true, force: true });
  }
});

test("macOS pairing falls back only from the exact noninteractive Keychain denial and unpairs cleanly", async () => {
  const root = await mkdtemp(join(tmpdir(), "driftglass-pair-keychain-fallback-"));
  const logPath = join(root, "cloud-requests.ndjson");
  const cloud = await startCloudFixture(logPath);
  try {
    const bin = join(root, "bin");
    const argsLog = join(root, "credential-args.log");
    const envLog = join(root, "credential-env.log");
    const stdinLog = join(root, "credential-stdin.log");
    await writeExecutable(join(bin, "opencli"), "#!/bin/sh\nprintf 'opencli ready\\n'\n");
    await writeExecutable(join(bin, "security"), [
      "#!/bin/sh",
      "printf '%s\\n' \"$@\" > \"$DRIFTGLASS_CREDENTIAL_ARGS_LOG\"",
      "env > \"$DRIFTGLASS_CREDENTIAL_ENV_LOG\"",
      "stdin=\"$(cat)\"",
      "printf '%s\\n' \"$stdin\" > \"$DRIFTGLASS_CREDENTIAL_STDIN_LOG\"",
      "first=\"$(printf '%s\\n' \"$stdin\" | sed -n '1p')\"",
      "second=\"$(printf '%s\\n' \"$stdin\" | sed -n '2p')\"",
      "third=\"$(printf '%s\\n' \"$stdin\" | sed -n '3p')\"",
      "[ -n \"$first\" ] && [ \"$first\" = \"$second\" ] && [ -z \"$third\" ] || exit 35",
      "printf 'fixture-token'",
      "printf 'password data for new item: retype password for new item: security: SecKeychainItemCreateFromContent (<default>): User interaction is not allowed.\\n' >&2",
      "exit 36",
      "",
    ].join("\n"));
    await writeExecutable(join(bin, "launchctl"), [
      "#!/bin/sh",
      "if [ \"$1\" = \"print\" ]; then printf 'services = {\\n}\\n'; fi",
      "exit 0",
      "",
    ].join("\n"));
    const env = isolatedEnvironment(root, {
      DRIFTGLASS_TEST_PLATFORM: "darwin",
      DRIFTGLASS_CREDENTIAL_ARGS_LOG: argsLog,
      DRIFTGLASS_CREDENTIAL_ENV_LOG: envLog,
      DRIFTGLASS_CREDENTIAL_STDIN_LOG: stdinLog,
      PATH: [bin, "/usr/bin", "/bin"].join(delimiter),
      OPENCLI_MANIFEST: fixtureManifest,
    });
    const paired = relayResult(["pair", "--url", cloud.url, "--code", "ABCD1234"], env);
    assert.equal(paired.status, 0, paired.stderr);
    assert.doesNotMatch(paired.stdout + "\n" + paired.stderr, /fixture-token/);
    assert.equal(await readFile(stdinLog, "utf8"), "fixture-token\nfixture-token\n");
    assert.doesNotMatch(await readFile(argsLog, "utf8"), /fixture-token/);
    assert.doesNotMatch(await readFile(envLog, "utf8"), /fixture-token/);

    const configPath = join(root, "config", "driftglass", "relay.json");
    const config = JSON.parse(await readFile(configPath, "utf8"));
    assert.equal(config.tokenStore.kind, "private-file");
    const stateDirectory = join(root, "state", "driftglass");
    const tokenDirectory = join(stateDirectory, "tokens");
    const tokenPath = join(tokenDirectory, "collector-test.secret");
    assert.equal(config.tokenStore.file, tokenPath);
    assert.equal((await lstat(stateDirectory)).mode & 0o777, 0o700);
    assert.equal((await lstat(tokenDirectory)).mode & 0o777, 0o700);
    assert.equal((await lstat(tokenPath)).mode & 0o777, 0o600);
    assert.equal(await readFile(tokenPath, "utf8"), "fixture-token\n");
    assert.deepEqual((await readdir(tokenDirectory)).sort(), ["collector-test.secret"]);

    const staleTemporary = join(tokenDirectory, ".collector-test.99999999.33333333-3333-4333-8333-333333333333.tmp");
    await writeFile(staleTemporary, "fixture-token\n", { mode: 0o600 });
    await chmod(staleTemporary, 0o600);

    const unpaired = relayResult(["unpair"], env);
    assert.equal(unpaired.status, 0, unpaired.stderr);
    assert.doesNotMatch(unpaired.stdout + "\n" + unpaired.stderr, /fixture-token/);
    await assert.rejects(lstat(tokenPath), (error) => error?.code === "ENOENT");
    await assert.rejects(lstat(staleTemporary), (error) => error?.code === "ENOENT");
    await assert.rejects(lstat(configPath), (error) => error?.code === "ENOENT");
  } finally {
    await cloud.stop();
    await rm(root, { recursive: true, force: true });
  }
});

test("macOS pairing does not fall back for similar, wrong-code, or secret-echoing Keychain failures", async () => {
  const root = await mkdtemp(join(tmpdir(), "driftglass-pair-keychain-fail-closed-"));
  const logPath = join(root, "cloud-requests.ndjson");
  const cloud = await startCloudFixture(logPath);
  try {
    const cases = [
      { name: "similar", code: 36, message: "security: User interaction is not allowed." },
      { name: "wrong-code", code: 35, message: "security: SecKeychainItemCreateFromContent (<default>): User interaction is not allowed." },
      { name: "extra-error", code: 36, message: "security: SecKeychainItemCreateFromContent (<default>): User interaction is not allowed.\\nunknown failure" },
      { name: "secret-echo", code: 42, message: "fixture-token" },
    ];
    for (const fixture of cases) {
      const caseRoot = join(root, fixture.name);
      const bin = join(caseRoot, "bin");
      await writeExecutable(join(bin, "opencli"), "#!/bin/sh\nprintf 'opencli ready\\n'\n");
      await writeExecutable(join(bin, "security"), [
        "#!/bin/sh",
        "if [ \"$1\" = \"delete-generic-password\" ]; then",
        "  printf 'security: SecKeychainSearchCopyNext: The specified item could not be found in the keychain.\\n' >&2",
        "  exit 44",
        "fi",
        "cat >/dev/null",
        "printf '%s\\n' \"$DRIFTGLASS_SECURITY_FAILURE\" >&2",
        "exit \"$DRIFTGLASS_SECURITY_EXIT\"",
        "",
      ].join("\n"));
      const env = isolatedEnvironment(caseRoot, {
        DRIFTGLASS_TEST_PLATFORM: "darwin",
        DRIFTGLASS_SECURITY_FAILURE: fixture.message,
        DRIFTGLASS_SECURITY_EXIT: String(fixture.code),
        PATH: [bin, "/usr/bin", "/bin"].join(delimiter),
        OPENCLI_MANIFEST: fixtureManifest,
      });
      const result = relayResult(["pair", "--url", cloud.url, "--code", "ABCD1234"], env);
      assert.notEqual(result.status, 0, fixture.name);
      assert.doesNotMatch(result.stdout + "\n" + result.stderr, /fixture-token/, fixture.name);
      assert.match(result.stderr, new RegExp("security exited " + fixture.code), fixture.name);
      await assert.rejects(
        lstat(join(caseRoot, "config", "driftglass", "relay.json")),
        (error) => error?.code === "ENOENT",
      );
      await assert.rejects(
        lstat(join(caseRoot, "state", "driftglass", "tokens", "collector-test.secret")),
        (error) => error?.code === "ENOENT",
      );
    }
  } finally {
    await cloud.stop();
    await rm(root, { recursive: true, force: true });
  }
});

test("macOS private fallback rejects unsafe state, token-directory, and token-file paths", async () => {
  const root = await mkdtemp(join(tmpdir(), "driftglass-pair-keychain-fallback-paths-"));
  const logPath = join(root, "cloud-requests.ndjson");
  const cloud = await startCloudFixture(logPath);
  try {
    for (const fixture of ["state-symlink", "directory-mode", "token-symlink", "token-hardlink"]) {
      const caseRoot = join(root, fixture);
      const bin = join(caseRoot, "bin");
      const stateDirectory = join(caseRoot, "state", "driftglass");
      const tokenDirectory = join(stateDirectory, "tokens");
      const tokenPath = join(tokenDirectory, "collector-test.secret");
      const outside = join(caseRoot, "outside");
      const outsideFile = join(outside, "must-stay.txt");
      await mkdir(outside, { recursive: true, mode: 0o700 });
      await writeFile(outsideFile, "unchanged", { mode: 0o600 });
      if (fixture === "state-symlink") {
        await mkdir(dirname(stateDirectory), { recursive: true, mode: 0o700 });
        await symlink(outside, stateDirectory);
      } else {
        await mkdir(tokenDirectory, { recursive: true, mode: fixture === "directory-mode" ? 0o755 : 0o700 });
        await chmod(stateDirectory, 0o700);
        await chmod(tokenDirectory, fixture === "directory-mode" ? 0o755 : 0o700);
        if (fixture === "token-symlink") await symlink(outsideFile, tokenPath);
        if (fixture === "token-hardlink") await link(outsideFile, tokenPath);
      }
      await writeExecutable(join(bin, "opencli"), "#!/bin/sh\nprintf 'opencli ready\\n'\n");
      await writeExecutable(join(bin, "security"), [
        "#!/bin/sh",
        "if [ \"$1\" = \"delete-generic-password\" ]; then",
        "  printf 'security: SecKeychainSearchCopyNext: The specified item could not be found in the keychain.\\n' >&2",
        "  exit 44",
        "fi",
        "cat >/dev/null",
        "printf 'security: SecKeychainItemCreateFromContent (<default>): User interaction is not allowed.\\n' >&2",
        "exit 36",
        "",
      ].join("\n"));
      const env = isolatedEnvironment(caseRoot, {
        DRIFTGLASS_TEST_PLATFORM: "darwin",
        PATH: [bin, "/usr/bin", "/bin"].join(delimiter),
        OPENCLI_MANIFEST: fixtureManifest,
      });
      const result = relayResult(["pair", "--url", cloud.url, "--code", "ABCD1234"], env);
      assert.notEqual(result.status, 0, fixture);
      assert.doesNotMatch(result.stdout + "\n" + result.stderr, /fixture-token/, fixture);
      assert.equal(await readFile(outsideFile, "utf8"), "unchanged", fixture);
      await assert.rejects(
        lstat(join(caseRoot, "config", "driftglass", "relay.json")),
        (error) => error?.code === "ENOENT",
      );
      const tokenInfo = await lstat(tokenPath).catch((error) => error?.code === "ENOENT" ? null : Promise.reject(error));
      if (fixture === "token-symlink") assert.equal(tokenInfo?.isSymbolicLink(), true);
      else if (fixture === "token-hardlink") assert.equal(tokenInfo?.nlink, 2);
      else assert.equal(tokenInfo, null);
    }
  } finally {
    await cloud.stop();
    await rm(root, { recursive: true, force: true });
  }
});

test("pairing journal recovers private-token crashes without deleting a committed pairing", async () => {
  const root = await mkdtemp(join(tmpdir(), "driftglass-pair-journal-crash-"));
  const logPath = join(root, "cloud-requests.ndjson");
  const cloud = await startCloudFixture(logPath);
  try {
    for (const crashPoint of ["after-temp-fsync", "after-rename", "after-config-rename"]) {
      const caseRoot = join(root, crashPoint);
      const bin = join(caseRoot, "bin");
      await writeExecutable(join(bin, "opencli"), "#!/bin/sh\nprintf 'opencli ready\\n'\n");
      await writeExecutable(join(bin, "security"), [
        "#!/bin/sh",
        "if [ \"$1\" = \"delete-generic-password\" ]; then",
        "  printf 'security: SecKeychainSearchCopyNext: The specified item could not be found in the keychain.\\n' >&2",
        "  exit 44",
        "fi",
        "cat >/dev/null",
        "printf 'security: SecKeychainItemCreateFromContent (<default>): User interaction is not allowed.\\n' >&2",
        "exit 36",
        "",
      ].join("\n"));
      const env = isolatedEnvironment(caseRoot, {
        DRIFTGLASS_TEST_PLATFORM: "darwin",
        PATH: [bin, "/usr/bin", "/bin"].join(delimiter),
        OPENCLI_MANIFEST: fixtureManifest,
      });
      const crashed = relayResult(["pair", "--url", cloud.url, "--code", "ABCD1234"], {
        ...env,
        DRIFTGLASS_TEST_TOKEN_CRASH_POINT: crashPoint,
      });
      assert.equal(crashed.status, 86, `${crashPoint}: ${crashed.stderr}`);
      assert.doesNotMatch(`${crashed.stdout}\n${crashed.stderr}`, /fixture-token/, crashPoint);

      const stateDirectory = join(caseRoot, "state", "driftglass");
      const tokenDirectory = join(stateDirectory, "tokens");
      const tokenPath = join(tokenDirectory, "collector-test.secret");
      const journalPath = join(stateDirectory, "pairing-journal.json");
      const configPath = join(caseRoot, "config", "driftglass", "relay.json");
      assert.equal((await lstat(journalPath)).mode & 0o777, 0o600, crashPoint);
      assert.doesNotMatch(await readFile(journalPath, "utf8"), /fixture-token/, crashPoint);
      const tokenEntries = (await readdir(tokenDirectory)).sort();
      if (crashPoint === "after-temp-fsync") {
        assert.equal(tokenEntries.length, 1);
        assert.match(tokenEntries[0], /^\.collector-test\.\d+\.[0-9a-f-]+\.tmp$/i);
        assert.equal((await lstat(join(tokenDirectory, tokenEntries[0]))).nlink, 1);
        await assert.rejects(lstat(tokenPath), (error) => error?.code === "ENOENT");
      } else if (crashPoint === "after-rename") {
        assert.equal(tokenEntries.length, 2);
        const temporary = tokenEntries.find((name) => name.endsWith(".tmp"));
        const temporaryInfo = await lstat(join(tokenDirectory, temporary));
        const finalInfo = await lstat(tokenPath);
        assert.equal(temporaryInfo.nlink, 2);
        assert.equal(finalInfo.nlink, 2);
        assert.equal(temporaryInfo.dev, finalInfo.dev);
        assert.equal(temporaryInfo.ino, finalInfo.ino);
      } else {
        assert.deepEqual(tokenEntries, ["collector-test.secret"]);
        assert.equal((await lstat(tokenPath)).nlink, 1);
      }

      const recovered = relayResult(["doctor"], env);
      assert.equal(recovered.status, 0, `${crashPoint}: ${recovered.stderr}`);
      assert.doesNotMatch(`${recovered.stdout}\n${recovered.stderr}`, /fixture-token/, crashPoint);
      const report = JSON.parse(recovered.stdout);
      await assert.rejects(lstat(journalPath), (error) => error?.code === "ENOENT");
      if (crashPoint === "after-config-rename") {
        assert.equal(report.paired, true);
        assert.equal(report.cloudReady, true);
        await lstat(configPath);
        assert.equal(await readFile(tokenPath, "utf8"), "fixture-token\n");
      } else {
        assert.equal(report.paired, false);
        await assert.rejects(lstat(configPath), (error) => error?.code === "ENOENT");
        await assert.rejects(lstat(tokenPath), (error) => error?.code === "ENOENT");
        assert.deepEqual(await readdir(tokenDirectory), []);
      }
    }

    const caseRoot = join(root, "injected-post-rename-failure");
    const bin = join(caseRoot, "bin");
    await writeExecutable(join(bin, "opencli"), "#!/bin/sh\nprintf 'opencli ready\\n'\n");
    await writeExecutable(join(bin, "security"), [
      "#!/bin/sh",
      "if [ \"$1\" = \"delete-generic-password\" ]; then",
      "  printf 'security: SecKeychainSearchCopyNext: The specified item could not be found in the keychain.\\n' >&2",
      "  exit 44",
      "fi",
      "cat >/dev/null",
      "printf 'security: SecKeychainItemCreateFromContent (<default>): User interaction is not allowed.\\n' >&2",
      "exit 36",
      "",
    ].join("\n"));
    const env = isolatedEnvironment(caseRoot, {
      DRIFTGLASS_TEST_PLATFORM: "darwin",
      DRIFTGLASS_TEST_TOKEN_FAILURE_POINT: "after-rename",
      PATH: [bin, "/usr/bin", "/bin"].join(delimiter),
      OPENCLI_MANIFEST: fixtureManifest,
    });
    const failed = relayResult(["pair", "--url", cloud.url, "--code", "ABCD1234"], env);
    assert.notEqual(failed.status, 0);
    assert.doesNotMatch(`${failed.stdout}\n${failed.stderr}`, /fixture-token/);
    for (const path of [
      join(caseRoot, "config", "driftglass", "relay.json"),
      join(caseRoot, "state", "driftglass", "tokens", "collector-test.secret"),
      join(caseRoot, "state", "driftglass", "pairing-journal.json"),
    ]) await assert.rejects(lstat(path), (error) => error?.code === "ENOENT");
    assert.deepEqual(await readdir(join(caseRoot, "state", "driftglass", "tokens")), []);
  } finally {
    await cloud.stop();
    await rm(root, { recursive: true, force: true });
  }
});

test("Doctor refuses unsafe or active private-token crash artifacts without exposing their contents", async () => {
  const root = await mkdtemp(join(tmpdir(), "driftglass-token-temp-safety-"));
  try {
    for (const fixture of ["mode", "symlink", "hardlink", "active", "malformed-name"]) {
      const caseRoot = join(root, fixture);
      const bin = join(caseRoot, "bin");
      const stateDirectory = join(caseRoot, "state", "driftglass");
      const tokenDirectory = join(stateDirectory, "tokens");
      const outside = join(caseRoot, "outside-secret.txt");
      const pid = fixture === "active" ? process.pid : 99_999_999;
      const name = fixture === "malformed-name"
        ? ".collector-test.bad.tmp"
        : `.collector-test.${pid}.44444444-4444-4444-8444-444444444444.tmp`;
      const temporary = join(tokenDirectory, name);
      await mkdir(tokenDirectory, { recursive: true, mode: 0o700 });
      await chmod(stateDirectory, 0o700);
      await chmod(tokenDirectory, 0o700);
      await writeFile(outside, "PRIVATE_TEMP_MARKER", { mode: 0o600 });
      if (fixture === "symlink") await symlink(outside, temporary);
      else if (fixture === "hardlink") await link(outside, temporary);
      else {
        await writeFile(temporary, "PRIVATE_TEMP_MARKER", { mode: fixture === "mode" ? 0o644 : 0o600 });
        await chmod(temporary, fixture === "mode" ? 0o644 : 0o600);
      }
      await writeExecutable(join(bin, "opencli"), "#!/bin/sh\nprintf 'opencli ready\\n'\n");
      const result = relayResult(["doctor"], isolatedEnvironment(caseRoot, {
        PATH: [bin, "/usr/bin", "/bin"].join(delimiter),
        OPENCLI_MANIFEST: fixtureManifest,
      }));
      assert.notEqual(result.status, 0, fixture);
      assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, /PRIVATE_TEMP_MARKER/, fixture);
      const report = JSON.parse(result.stdout);
      assert.ok(report.blockers.some((blocker) => /credential recovery is blocked/i.test(blocker)), fixture);
      await lstat(temporary);
      assert.equal(await readFile(outside, "utf8"), "PRIVATE_TEMP_MARKER", fixture);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Doctor removes one valid private-token temp left by a crashed writer", async () => {
  const root = await mkdtemp(join(tmpdir(), "driftglass-token-temp-crash-"));
  try {
    const bin = join(root, "bin");
    const stateDirectory = join(root, "state", "driftglass");
    const tokenDirectory = join(stateDirectory, "tokens");
    const temporary = join(tokenDirectory, ".collector-test.99999999.55555555-5555-4555-8555-555555555555.tmp");
    await mkdir(tokenDirectory, { recursive: true, mode: 0o700 });
    await chmod(stateDirectory, 0o700);
    await chmod(tokenDirectory, 0o700);
    await writeFile(temporary, "PRIVATE_CRASH_MARKER", { mode: 0o600 });
    await chmod(temporary, 0o600);
    await writeExecutable(join(bin, "opencli"), "#!/bin/sh\nprintf 'opencli ready\\n'\n");
    const result = relayResult(["doctor"], isolatedEnvironment(root, {
      PATH: [bin, "/usr/bin", "/bin"].join(delimiter),
      OPENCLI_MANIFEST: fixtureManifest,
    }));
    assert.equal(result.status, 0, result.stderr);
    assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, /PRIVATE_CRASH_MARKER/);
    await assert.rejects(lstat(temporary), (error) => error?.code === "ENOENT");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("macOS unpair preserves pairing state when service shutdown cannot be proven", async () => {
  const root = await mkdtemp(join(tmpdir(), "driftglass-unpair-service-fail-"));
  try {
    const bin = join(root, "bin");
    const tokenPath = await writePrivateTokenFixture(root);
    const configPath = join(root, "config", "driftglass", "relay.json");
    const launchAgent = join(root, "home", "Library", "LaunchAgents", "dev.driftglass.relay.plist");
    await mkdir(dirname(configPath), { recursive: true });
    await mkdir(dirname(launchAgent), { recursive: true });
    await writeFile(configPath, JSON.stringify({
      baseUrl: "https://private.example",
      collectorId: "collector-test",
      tokenStore: { kind: "private-file", account: "collector-test", file: tokenPath },
    }));
    await writeFile(launchAgent, "service fixture", { mode: 0o600 });
    await writeExecutable(join(bin, "launchctl"), [
      "#!/bin/sh",
      "if [ \"$1\" = \"print\" ]; then printf 'services = { dev.driftglass.relay = { state = running } }\\n'; exit 0; fi",
      "printf 'PRIVATE_SERVICE_MARKER\\n' >&2",
      "exit 5",
      "",
    ].join("\n"));
    const result = relayResult(["unpair"], isolatedEnvironment(root, {
      DRIFTGLASS_TEST_PLATFORM: "darwin",
      PATH: [bin, "/usr/bin", "/bin"].join(delimiter),
    }));
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /service stop failed/i);
    assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, /fixture-token|PRIVATE_SERVICE_MARKER/);
    assert.doesNotMatch(result.stdout, /local token removed/i);
    assert.equal(await readFile(tokenPath, "utf8"), "fixture-token\n");
    await lstat(configPath);
    await lstat(launchAgent);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("macOS unpair accepts only the exact Keychain not-found result", async () => {
  const root = await mkdtemp(join(tmpdir(), "driftglass-unpair-keychain-delete-"));
  try {
    for (const fixture of [
      { name: "not-found", code: 44, output: "security: SecKeychainSearchCopyNext: The specified item could not be found in the keychain.", succeeds: true },
      { name: "wrong-code", code: 45, output: "security: SecKeychainSearchCopyNext: The specified item could not be found in the keychain.", succeeds: false },
      { name: "extra-output", code: 44, output: "security: SecKeychainSearchCopyNext: The specified item could not be found in the keychain.\\nPRIVATE_DELETE_MARKER", succeeds: false },
    ]) {
      const caseRoot = join(root, fixture.name);
      const bin = join(caseRoot, "bin");
      const configPath = join(caseRoot, "config", "driftglass", "relay.json");
      await mkdir(dirname(configPath), { recursive: true });
      await writeFile(configPath, JSON.stringify({
        baseUrl: "https://private.example",
        collectorId: "collector-test",
        tokenStore: { kind: "macos-keychain", account: "collector-test" },
      }));
      await writeExecutable(join(bin, "launchctl"), "#!/bin/sh\nif [ \"$1\" = \"print\" ]; then printf 'services = {\\n}\\n'; fi\nexit 0\n");
      await writeExecutable(join(bin, "security"), "#!/bin/sh\nprintf '%b\\n' \"$DRIFTGLASS_DELETE_OUTPUT\" >&2\nexit \"$DRIFTGLASS_DELETE_EXIT\"\n");
      const result = relayResult(["unpair"], isolatedEnvironment(caseRoot, {
        DRIFTGLASS_TEST_PLATFORM: "darwin",
        DRIFTGLASS_DELETE_OUTPUT: fixture.output,
        DRIFTGLASS_DELETE_EXIT: String(fixture.code),
        PATH: [bin, "/usr/bin", "/bin"].join(delimiter),
      }));
      assert.equal(result.status === 0, fixture.succeeds, fixture.name);
      assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, /PRIVATE_DELETE_MARKER|fixture-token/, fixture.name);
      if (fixture.succeeds) await assert.rejects(lstat(configPath), (error) => error?.code === "ENOENT");
      else await lstat(configPath);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("unpair treats malformed configuration as paired state and changes nothing", async () => {
  const root = await mkdtemp(join(tmpdir(), "driftglass-unpair-config-invalid-"));
  try {
    for (const fixture of ["invalid-json", "missing-identity"]) {
      const caseRoot = join(root, fixture);
      const bin = join(caseRoot, "bin");
      const serviceLog = join(caseRoot, "service.log");
      const tokenPath = await writePrivateTokenFixture(caseRoot);
      const configPath = join(caseRoot, "config", "driftglass", "relay.json");
      await mkdir(dirname(configPath), { recursive: true });
      await writeFile(configPath, fixture === "invalid-json" ? "{broken" : JSON.stringify({ tokenStore: { kind: "private-file", account: "collector-test", file: tokenPath } }));
      await writeExecutable(join(bin, "launchctl"), `#!/bin/sh\nprintf 'called\\n' >> "${serviceLog}"\nexit 0\n`);
      const result = relayResult(["unpair"], isolatedEnvironment(caseRoot, {
        DRIFTGLASS_TEST_PLATFORM: "darwin",
        PATH: [bin, "/usr/bin", "/bin"].join(delimiter),
      }));
      assert.notEqual(result.status, 0, fixture);
      assert.doesNotMatch(result.stdout, /local token removed/i, fixture);
      await lstat(configPath);
      assert.equal(await readFile(tokenPath, "utf8"), "fixture-token\n");
      await assert.rejects(readFile(serviceLog, "utf8"), (error) => error?.code === "ENOENT");
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Linux and Windows unpair preserve credentials when service-stop verification fails", async () => {
  const root = await mkdtemp(join(tmpdir(), "driftglass-unpair-cross-platform-"));
  try {
    const linuxRoot = join(root, "linux");
    const linuxBin = join(linuxRoot, "bin");
    const linuxToken = await writePrivateTokenFixture(linuxRoot);
    const linuxConfig = join(linuxRoot, "config", "driftglass", "relay.json");
    const linuxUnit = join(linuxRoot, "config", "systemd", "user", "driftglass-relay.service");
    await mkdir(dirname(linuxConfig), { recursive: true });
    await mkdir(dirname(linuxUnit), { recursive: true });
    await writeFile(linuxConfig, JSON.stringify({ baseUrl: "https://private.example", collectorId: "collector-test", tokenStore: { kind: "private-file", account: "collector-test", file: linuxToken } }));
    await writeFile(linuxUnit, "service fixture");
    await writeExecutable(join(linuxBin, "systemctl"), "#!/bin/sh\nif [ \"$2\" = \"is-active\" ]; then printf 'active\\n'; exit 0; fi\nprintf 'PRIVATE_LINUX_MARKER\\n' >&2\nexit 5\n");
    const linux = relayResult(["unpair"], isolatedEnvironment(linuxRoot, {
      DRIFTGLASS_TEST_PLATFORM: "linux",
      PATH: [linuxBin, "/usr/bin", "/bin"].join(delimiter),
    }));
    assert.notEqual(linux.status, 0);
    assert.doesNotMatch(`${linux.stdout}\n${linux.stderr}`, /fixture-token|PRIVATE_LINUX_MARKER/);
    await lstat(linuxConfig);
    await lstat(linuxUnit);
    assert.equal(await readFile(linuxToken, "utf8"), "fixture-token\n");

    const windowsRoot = join(root, "windows");
    const windowsBin = join(windowsRoot, "bin");
    const appData = join(windowsRoot, "appdata");
    const localAppData = join(windowsRoot, "localappdata");
    const windowsToken = join(localAppData, "driftglass", "tokens", "collector-test.secret");
    const windowsConfig = join(appData, "driftglass", "relay.json");
    const windowsRunner = join(localAppData, "driftglass", "driftglass-relay.cmd");
    await mkdir(dirname(windowsToken), { recursive: true });
    await mkdir(dirname(windowsConfig), { recursive: true });
    await writeFile(windowsToken, "encrypted-token-fixture");
    await writeFile(windowsConfig, JSON.stringify({ baseUrl: "https://private.example", collectorId: "collector-test", tokenStore: { kind: "windows-dpapi", account: "collector-test", file: windowsToken } }));
    await writeFile(windowsRunner, "service fixture");
    await writeExecutable(join(windowsBin, "powershell.exe"), "#!/bin/sh\nprintf 'PRIVATE_WINDOWS_MARKER\\n' >&2\nexit 9\n");
    const windows = relayResult(["unpair"], isolatedEnvironment(windowsRoot, {
      DRIFTGLASS_TEST_PLATFORM: "win32",
      APPDATA: appData,
      LOCALAPPDATA: localAppData,
      PATH: [windowsBin, "/usr/bin", "/bin"].join(delimiter),
    }));
    assert.notEqual(windows.status, 0);
    assert.doesNotMatch(`${windows.stdout}\n${windows.stderr}`, /encrypted-token-fixture|PRIVATE_WINDOWS_MARKER/);
    await lstat(windowsConfig);
    await lstat(windowsRunner);
    assert.equal(await readFile(windowsToken, "utf8"), "encrypted-token-fixture");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("service-operation lock recovers every publish crash boundary", async () => {
  const root = await mkdtemp(join(tmpdir(), "driftglass-service-lock-crash-"));
  try {
    for (const crashPoint of ["after-temp-open", "after-temp-fsync", "after-link"]) {
      const caseRoot = join(root, crashPoint);
      const bin = join(caseRoot, "bin");
      const stateDirectory = join(caseRoot, "state", "driftglass");
      await writeExecutable(join(bin, "launchctl"), "#!/bin/sh\nexit 0\n");
      const env = isolatedEnvironment(caseRoot, {
        DRIFTGLASS_TEST_PLATFORM: "darwin",
        PATH: [bin, "/usr/bin", "/bin"].join(delimiter),
      });
      const crashed = relayResult(["service-stop"], {
        ...env,
        DRIFTGLASS_TEST_SERVICE_LOCK_CRASH_POINT: crashPoint,
      });
      assert.equal(crashed.status, 87, crashPoint);
      const recovered = relayResult(["service-stop"], env);
      assert.equal(recovered.status, 0, `${crashPoint}: ${recovered.stderr}`);
      assert.match(recovered.stdout, /Companion stopped/i);
      const names = await readdir(stateDirectory);
      assert.equal(names.some((name) => name === "service-operation.lock" || name.startsWith(".service-operation.")), false, crashPoint);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("one lifecycle lock blocks pair, second-pair, and unpair state races", async () => {
  const root = await mkdtemp(join(tmpdir(), "driftglass-lifecycle-lock-race-"));
  try {
    const stateDirectory = join(root, "state", "driftglass");
    const lockPath = join(stateDirectory, "service-operation.lock");
    await mkdir(stateDirectory, { recursive: true, mode: 0o700 });
    await chmod(stateDirectory, 0o700);
    await writeFile(lockPath, JSON.stringify({ pid: process.pid, nonce: "66666666-6666-4666-8666-666666666666" }) + "\n", { mode: 0o600 });
    await chmod(lockPath, 0o600);
    const env = isolatedEnvironment(root, {
      DRIFTGLASS_TEST_PLATFORM: "darwin",
      PATH: ["/usr/bin", "/bin"].join(delimiter),
      OPENCLI_MANIFEST: fixtureManifest,
    });

    const firstPair = relayResult(["pair", "--url", "http://localhost:1", "--code", "ABCD1234"], env);
    assert.notEqual(firstPair.status, 0);
    assert.match(firstPair.stderr, /service operation is in progress/i);
    await assert.rejects(lstat(join(root, "config", "driftglass", "relay.json")), (error) => error?.code === "ENOENT");

    const tokenPath = await writePrivateTokenFixture(root);
    const configPath = join(root, "config", "driftglass", "relay.json");
    await mkdir(dirname(configPath), { recursive: true });
    await writeFile(configPath, JSON.stringify({
      baseUrl: "https://private.example",
      collectorId: "collector-test",
      tokenStore: { kind: "private-file", account: "collector-test", file: tokenPath },
    }));
    for (const args of [
      ["pair", "--url", "http://localhost:1", "--code", "ABCD1234"],
      ["unpair"],
    ]) {
      const blocked = relayResult(args, env);
      assert.notEqual(blocked.status, 0);
      assert.match(blocked.stderr, /service operation is in progress/i);
      await lstat(configPath);
      assert.equal(await readFile(tokenPath, "utf8"), "fixture-token\n");
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Windows unpair accepts only an explicitly Disabled task before credential deletion", async () => {
  const root = await mkdtemp(join(tmpdir(), "driftglass-windows-service-state-"));
  try {
    for (const state of ["Disabled", "Ready", "Running", "Queued", "Unknown"]) {
      const caseRoot = join(root, state.toLowerCase());
      const bin = join(caseRoot, "bin");
      const appData = join(caseRoot, "appdata");
      const localAppData = join(caseRoot, "localappdata");
      const tokenPath = join(localAppData, "driftglass", "tokens", "collector-test.secret");
      const configPath = join(appData, "driftglass", "relay.json");
      const runnerPath = join(localAppData, "driftglass", "driftglass-relay.cmd");
      const argsLog = join(caseRoot, "powershell-args.log");
      await mkdir(dirname(tokenPath), { recursive: true });
      await mkdir(dirname(configPath), { recursive: true });
      await writeFile(tokenPath, "encrypted-token-fixture");
      await writeFile(configPath, JSON.stringify({
        baseUrl: "https://private.example",
        collectorId: "collector-test",
        tokenStore: { kind: "windows-dpapi", account: "collector-test", file: tokenPath },
      }));
      await writeFile(runnerPath, "service fixture");
      await writeExecutable(join(bin, "powershell.exe"), [
        "#!/bin/sh",
        "printf '%s\\n' \"$@\" > \"$DRIFTGLASS_POWERSHELL_ARGS_LOG\"",
        "if [ \"$DRIFTGLASS_TASK_STATE\" = \"Disabled\" ]; then exit 0; fi",
        "exit 41",
        "",
      ].join("\n"));
      const result = relayResult(["unpair"], isolatedEnvironment(caseRoot, {
        DRIFTGLASS_TEST_PLATFORM: "win32",
        DRIFTGLASS_TASK_STATE: state,
        DRIFTGLASS_POWERSHELL_ARGS_LOG: argsLog,
        APPDATA: appData,
        LOCALAPPDATA: localAppData,
        PATH: [bin, "/usr/bin", "/bin"].join(delimiter),
      }));
      const command = await readFile(argsLog, "utf8");
      assert.match(command, /State -ne 'Disabled'/);
      assert.ok((command.match(/Get-ScheduledTask/g) || []).length >= 3);
      assert.equal(
        (command.match(/\{/g) || []).length,
        (command.match(/\}/g) || []).length,
        "PowerShell service teardown blocks must be balanced",
      );
      if (state === "Disabled") {
        assert.equal(result.status, 0, result.stderr);
        for (const path of [tokenPath, configPath, runnerPath]) await assert.rejects(lstat(path), (error) => error?.code === "ENOENT");
      } else {
        assert.notEqual(result.status, 0, state);
        await lstat(tokenPath);
        await lstat(configPath);
        await lstat(runnerPath);
      }
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("stalled cloud responses hit the Companion body deadline", async () => {
  const root = await mkdtemp(join(tmpdir(), "driftglass-cloud-deadline-"));
  const logPath = join(root, "cloud-requests.ndjson");
  const cloud = await startCloudFixture(logPath, "stall");
  try {
    const bin = join(root, "bin");
    await writeExecutable(join(bin, "opencli"), "#!/bin/sh\nprintf 'opencli ready\\n'\n");
    const tokenPath = await writePrivateTokenFixture(root);
    const configDirectory = join(root, "config", "driftglass");
    await mkdir(configDirectory, { recursive: true });
    await writeFile(join(configDirectory, "relay.json"), JSON.stringify({
      baseUrl: cloud.url,
      collectorId: "collector-test",
      tokenStore: { kind: "private-file", account: "collector-test", file: tokenPath },
    }));
    const result = relayResult(["doctor"], isolatedEnvironment(root, {
      PATH: [bin, "/usr/bin", "/bin"].join(delimiter),
      OPENCLI_MANIFEST: fixtureManifest,
      DRIFTGLASS_TEST_NETWORK_TIMEOUT_MS: "100",
    }), { timeout: 5_000 });
    assert.notEqual(result.status, 0, result.stderr);
    const report = JSON.parse(result.stdout);
    assert.equal(report.cloudReady, false);
    assert.match(report.cloud.error, /timed out/i);
  } finally {
    await cloud.stop();
    await rm(root, { recursive: true, force: true });
  }
});

test("Service keeps transient heartbeat and poll failures in-process with bounded retries", async () => {
  const root = await mkdtemp(join(tmpdir(), "driftglass-service-backoff-"));
  const logPath = join(root, "cloud-requests.ndjson");
  const cloud = await startCloudFixture(logPath, "transient");
  try {
    const env = isolatedEnvironment(root, {
      PATH: ["/usr/bin", "/bin"].join(delimiter),
      OPENCLI_MANIFEST: fixtureManifest,
      DRIFTGLASS_TEST_LOOP_LIMIT: "4",
      DRIFTGLASS_TEST_DELAY_CAP_MS: "5",
    });
    const configDirectory = join(root, "config", "driftglass");
    const tokenPath = await writePrivateTokenFixture(root);
    await mkdir(configDirectory, { recursive: true });
    await writeFile(join(configDirectory, "relay.json"), JSON.stringify({
      baseUrl: cloud.url,
      collectorId: "collector-test",
      tokenStore: { kind: "private-file", account: "collector-test", file: tokenPath },
      workspaceMirror: false,
    }));
    const result = relayResult(["run"], env, { timeout: 5_000 });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stderr, /heartbeat failed; retrying service loop in 15000ms/i);
    assert.match(result.stderr, /job poll failed; retrying service loop in 22500ms/i);
    const requests = (await readFile(logPath, "utf8")).trim().split("\n").map(JSON.parse);
    const heartbeats = requests.filter((entry) => entry.url === "/collector/heartbeat");
    const polls = requests.filter((entry) => entry.url === "/collector/jobs");
    assert.equal(heartbeats.length, 1, "a failed detailed heartbeat must not be retried on each loop");
    assert.equal(heartbeats.filter((entry) => entry.body?.details).length, 1);
    assert.equal(polls.length, 3, "polling should resume and remain in-process after transient failures");
  } finally {
    await cloud.stop();
    await rm(root, { recursive: true, force: true });
  }
});

test("successful Collector results survive a crash and replay before polling without dynamic re-execution", async () => {
  const root = await mkdtemp(join(tmpdir(), "driftglass-result-outbox-crash-"));
  const logPath = join(root, "cloud-requests.ndjson");
  const cloud = await startResultOutboxFixture(logPath, [202]);
  try {
    const prepared = await prepareOutboxRelay(root, cloud.url);
    const crashed = relayResult(["once"], {
      ...prepared.env,
      DRIFTGLASS_TEST_EXIT_AFTER_OUTBOX_WRITE: "1",
    });
    assert.equal(crashed.status, 86, crashed.stderr);

    const outboxInfo = await lstat(prepared.outboxPath);
    assert.equal(outboxInfo.isFile(), true);
    if (process.platform !== "win32") assert.equal(outboxInfo.mode & 0o777, 0o600);
    const privateEnvelope = await readFile(prepared.outboxPath, "utf8");
    assert.doesNotMatch(privateEnvelope, /Exact result fixture/);
    assert.equal((await readFile(prepared.executionLog, "utf8")).trim().split("\n").length, 1);

    const beforeRestart = (await readFile(logPath, "utf8")).trim().split("\n").map(JSON.parse);
    assert.equal(beforeRestart.filter((entry) => /\/result$/.test(entry.url)).length, 0, "crash injection must occur after durable persistence and before POST");

    // Recreate the earlier crash boundary: the fully fsynced temp exists but
    // its fixed directory entry was not yet linked. Startup must recover it.
    const staleTemporary = join(dirname(prepared.outboxPath), ".result-outbox.99999999.22222222-2222-4222-8222-222222222222.tmp");
    await link(prepared.outboxPath, staleTemporary);
    await rm(prepared.outboxPath);

    const originalConfig = JSON.parse(await readFile(prepared.configPath, "utf8"));
    await writeFile(prepared.configPath, JSON.stringify({ ...originalConfig, collectorId: "different-collector" }));
    const wrongDestination = relayResult(["once"], prepared.env);
    assert.notEqual(wrongDestination.status, 0);
    assert.match(wrongDestination.stderr, /different paired destination/i);
    await lstat(prepared.outboxPath);
    await assert.rejects(lstat(staleTemporary), (error) => error?.code === "ENOENT");
    await writeFile(prepared.configPath, JSON.stringify(originalConfig));

    const restarted = relayResult(["once"], prepared.env);
    assert.equal(restarted.status, 0, restarted.stderr);
    assert.match(restarted.stdout, /replayed and acknowledged one pending Collector result/i);
    await assert.rejects(lstat(prepared.outboxPath), (error) => error?.code === "ENOENT");
    await assert.rejects(lstat(staleTemporary), (error) => error?.code === "ENOENT");
    assert.equal((await readFile(prepared.executionLog, "utf8")).trim().split("\n").length, 1, "restart must not execute the dynamic collector again");

    const requests = (await readFile(logPath, "utf8")).trim().split("\n").map(JSON.parse);
    const jobAndResultRequests = requests.filter((entry) => entry.url === "/collector/jobs" || /\/result$/.test(entry.url));
    assert.deepEqual(jobAndResultRequests.map((entry) => entry.url), [
      "/collector/jobs",
      "/collector/jobs/11111111-1111-4111-8111-111111111111/result",
      "/collector/jobs",
    ]);
    assert.equal(jobAndResultRequests[1].body.ok, true);
    assert.equal(jobAndResultRequests[1].body.result.items[0].title, "Exact result fixture");
  } finally {
    await cloud.stop();
    await rm(root, { recursive: true, force: true });
  }
});

test("every temp/link/directory-fsync outbox crash boundary recovers one exact result and leaves no private temp", async () => {
  for (const crashPoint of ["after-temp-fsync", "after-link", "after-directory-fsync", "after-temp-unlink"]) {
    const root = await mkdtemp(join(tmpdir(), `driftglass-result-outbox-${crashPoint}-`));
    const logPath = join(root, "cloud-requests.ndjson");
    const cloud = await startResultOutboxFixture(logPath, [202]);
    try {
      const prepared = await prepareOutboxRelay(root, cloud.url);
      const crashed = relayResult(["once"], {
        ...prepared.env,
        DRIFTGLASS_TEST_OUTBOX_CRASH_POINT: crashPoint,
      });
      assert.equal(crashed.status, 86, `${crashPoint}: ${crashed.stderr}`);

      const restarted = relayResult(["once"], prepared.env);
      assert.equal(restarted.status, 0, `${crashPoint}: ${restarted.stderr}`);
      assert.match(restarted.stdout, /replayed and acknowledged one pending Collector result/i);
      assert.equal((await readFile(prepared.executionLog, "utf8")).trim().split("\n").length, 1, crashPoint);
      await assert.rejects(lstat(prepared.outboxPath), (error) => error?.code === "ENOENT");
      const stateNames = await readdir(dirname(prepared.outboxPath));
      assert.equal(stateNames.some((name) => /^\.result-outbox\..+\.tmp$/.test(name)), false, crashPoint);
      const requests = (await readFile(logPath, "utf8")).trim().split("\n").map(JSON.parse);
      const results = requests.filter((entry) => /\/result$/.test(entry.url));
      assert.equal(results.length, 1, crashPoint);
      assert.equal(results[0].body?.ok, true, crashPoint);
    } finally {
      await cloud.stop();
      await rm(root, { recursive: true, force: true });
    }
  }
});

test("network, 409, and 5xx ambiguity retain identical success bytes until acknowledgement and safe unpair", async () => {
  const root = await mkdtemp(join(tmpdir(), "driftglass-result-outbox-retry-"));
  const logPath = join(root, "cloud-requests.ndjson");
  const cloud = await startResultOutboxFixture(logPath, ["drop", 409, 503, 202]);
  try {
    const prepared = await prepareOutboxRelay(root, cloud.url);
    for (const expectedStatus of ["network", "409", "503"]) {
      const attempted = relayResult(["once"], prepared.env);
      assert.notEqual(attempted.status, 0, `${expectedStatus}: ${attempted.stderr}`);
      await lstat(prepared.outboxPath);
    }

    const unpaired = relayResult(["unpair"], prepared.env);
    assert.equal(unpaired.status, 0, unpaired.stderr);
    assert.match(unpaired.stdout, /acknowledged before unpairing/i);
    assert.match(unpaired.stdout, /No unacknowledged result was discarded/i);
    for (const removed of [prepared.outboxPath, prepared.tokenPath, prepared.configPath]) {
      await assert.rejects(lstat(removed), (error) => error?.code === "ENOENT");
    }

    assert.equal((await readFile(prepared.executionLog, "utf8")).trim().split("\n").length, 1, "ambiguous submissions must not re-run collection");
    const requests = (await readFile(logPath, "utf8")).trim().split("\n").map(JSON.parse);
    const resultRequests = requests.filter((entry) => /\/result$/.test(entry.url));
    assert.equal(resultRequests.length, 4);
    assert.ok(resultRequests.every((entry) => entry.body?.ok === true), "submission failures must never produce ok:false");
    assert.ok(resultRequests.every((entry) => JSON.stringify(entry.body) === JSON.stringify(resultRequests[0].body)), "every retry must replay the identical success payload");
    const relevantUrls = requests
      .filter((entry) => entry.url === "/collector/jobs" || /\/result$/.test(entry.url))
      .map((entry) => entry.url);
    assert.deepEqual(relevantUrls, [
      "/collector/jobs",
      "/collector/jobs/11111111-1111-4111-8111-111111111111/result",
      "/collector/jobs/11111111-1111-4111-8111-111111111111/result",
      "/collector/jobs/11111111-1111-4111-8111-111111111111/result",
      "/collector/jobs/11111111-1111-4111-8111-111111111111/result",
    ]);
  } finally {
    await cloud.stop();
    await rm(root, { recursive: true, force: true });
  }
});

test("Doctor blocks corrupted, oversized, or symbolic-link result outboxes without exposing contents", { skip: process.platform === "win32" }, async () => {
  const root = await mkdtemp(join(tmpdir(), "driftglass-result-outbox-invalid-"));
  try {
    const prepared = await prepareOutboxRelay(root, "https://private.example");
    await mkdir(dirname(prepared.outboxPath), { recursive: true, mode: 0o700 });
    const secretMarker = "PRIVATE_RESULT_MARKER_SHOULD_NOT_LEAK";
    await writeFile(prepared.outboxPath, `{broken:${secretMarker}}`, { mode: 0o600 });

    const corrupted = relayResult(["doctor", "--skip-cloud"], prepared.env);
    assert.notEqual(corrupted.status, 0, corrupted.stderr);
    assert.doesNotMatch(`${corrupted.stdout}\n${corrupted.stderr}`, new RegExp(secretMarker));
    const corruptedReport = JSON.parse(corrupted.stdout);
    assert.deepEqual(
      { status: corruptedReport.resultOutbox.status, pending: corruptedReport.resultOutbox.pending, valid: corruptedReport.resultOutbox.valid },
      { status: "invalid", pending: true, valid: false },
    );
    assert.ok(corruptedReport.blockers.some((blocker) => /outbox is unsafe or unreadable/i.test(blocker)));

    await writeFile(prepared.outboxPath, Buffer.alloc(2_500_000, 0x78), { mode: 0o600 });
    const oversized = relayResult(["doctor", "--skip-cloud"], prepared.env);
    assert.notEqual(oversized.status, 0, oversized.stderr);
    const oversizedReport = JSON.parse(oversized.stdout);
    assert.equal(oversizedReport.resultOutbox.status, "invalid");
    assert.match(oversizedReport.resultOutbox.error, /oversized/i);

    await rm(prepared.outboxPath, { force: true });
    const outside = join(root, "outside-result.json");
    await writeFile(outside, secretMarker, { mode: 0o600 });
    await symlink(outside, prepared.outboxPath);
    const linked = relayResult(["doctor", "--skip-cloud"], prepared.env);
    assert.notEqual(linked.status, 0, linked.stderr);
    const linkedReport = JSON.parse(linked.stdout);
    assert.equal(linkedReport.resultOutbox.status, "invalid");
    assert.match(linkedReport.resultOutbox.error, /symbolic link/i);
    assert.equal(await readFile(outside, "utf8"), secretMarker);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("invalid Collector job IDs cannot traverse the bounded result outbox path", async () => {
  const root = await mkdtemp(join(tmpdir(), "driftglass-result-outbox-job-id-"));
  const logPath = join(root, "cloud-requests.ndjson");
  const cloud = await startResultOutboxFixture(logPath, [202], "../escaped-result");
  try {
    const prepared = await prepareOutboxRelay(root, cloud.url);
    const attempted = relayResult(["once"], prepared.env);
    assert.notEqual(attempted.status, 0);
    assert.match(attempted.stderr, /invalid Collector job ID/i);
    await assert.rejects(lstat(prepared.outboxPath), (error) => error?.code === "ENOENT");
    await assert.rejects(readFile(prepared.executionLog, "utf8"), (error) => error?.code === "ENOENT");
    const requests = (await readFile(logPath, "utf8")).trim().split("\n").map(JSON.parse);
    assert.equal(requests.filter((entry) => /\/result$/.test(entry.url)).length, 0);
  } finally {
    await cloud.stop();
    await rm(root, { recursive: true, force: true });
  }
});

function readPlan(operation, extra = []) {
  const result = spawnSync(process.execPath, [relay, "plan", "--operation", operation, "--limit", "3", ...extra], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

test("X Following fallback preserves the requested timeline instead of silently using For You", () => {
  const plan = readPlan("x.timeline", ["--type", "following"]);
  const fallback = plan.candidates.find((candidate) => candidate.provider === "twitter-cli");
  assert.deepEqual(fallback.args.slice(0, 3), ["feed", "-t", "following"]);
});

test("Reddit public and personal feeds map to distinct rdt-cli commands", () => {
  const frontpage = readPlan("reddit.frontpage");
  const home = readPlan("reddit.home");
  assert.equal(frontpage.candidates.find((candidate) => candidate.provider === "rdt-cli").args[0], "all");
  assert.equal(home.candidates.find((candidate) => candidate.provider === "rdt-cli").args[0], "feed");
});

test("Reddit upvoted fallback does not regress to the saved-items command", () => {
  const plan = readPlan("reddit.upvoted");
  assert.equal(plan.candidates.find((candidate) => candidate.provider === "rdt-cli").args[0], "upvoted");
});

test("OpenCLI catalogs retain more than 800 safe read entries", async () => {
  const root = await mkdtemp(join(tmpdir(), "driftglass-catalog-full-"));
  try {
    const manifest = join(root, "manifest.json");
    const entries = Array.from({ length: 1005 }, (_, index) => ({
      site: `site-${Math.floor(index / 100)}`,
      name: `read-${index}`,
      access: "read",
      description: `Read adapter ${index}`,
      args: [],
    }));
    await writeFile(manifest, JSON.stringify(entries));
    const result = relayResult(["catalog"], { OPENCLI_MANIFEST: manifest });
    assert.equal(result.status, 0, result.stderr);
    const catalog = JSON.parse(result.stdout);
    assert.equal(catalog.total, entries.length);
    assert.equal(catalog.count, entries.length);
    assert.equal(catalog.adapters.length, entries.length);
    assert.equal(catalog.truncated, false);

    const last = entries.at(-1);
    const plan = relayResult(["plan", "--operation", "opencli.read", "--site", last.site, "--command", last.name], { OPENCLI_MANIFEST: manifest });
    assert.equal(plan.status, 0, plan.stderr);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("OpenCLI catalog hard byte bounds report explicit truncation", async () => {
  const root = await mkdtemp(join(tmpdir(), "driftglass-catalog-bound-"));
  try {
    const manifest = join(root, "manifest.json");
    const entries = Array.from({ length: 12 }, (_, index) => ({
      site: "large",
      name: `read-${index}`,
      access: "read",
      description: `${index}:${"x".repeat(220_000)}`,
      args: [],
    }));
    await writeFile(manifest, JSON.stringify(entries));
    const result = relayResult(["catalog"], { OPENCLI_MANIFEST: manifest });
    assert.equal(result.status, 0, result.stderr);
    const catalog = JSON.parse(result.stdout);
    assert.equal(catalog.total, entries.length);
    assert.ok(catalog.count > 0 && catalog.count < entries.length);
    assert.equal(catalog.adapters.length, catalog.count);
    assert.equal(catalog.truncated, true);
    assert.ok(catalog.payloadBytes <= catalog.payloadLimitBytes);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("workspace import, push, and export reject symlinks and escaped real paths", { skip: process.platform === "win32" }, async () => {
  const root = await mkdtemp(join(tmpdir(), "driftglass-workspace-safe-"));
  try {
    const env = isolatedEnvironment(root);
    const payloadPath = join(root, "workspace.json");
    await writeFile(payloadPath, JSON.stringify({
      schemaVersion: "1",
      id: "mission-safe",
      exportedAt: "2026-08-10T00:00:00.000Z",
      files: { "/mission.md": "managed", "/notes/seed.md": "local" },
    }));
    const imported = relayResult(["workspace-import", "--file", payloadPath], env);
    assert.equal(imported.status, 0, imported.stderr);

    const workspace = join(root, "data", "driftglass", "workspaces", "mission-safe");
    const outside = join(root, "outside");
    await mkdir(outside);
    const outsideFile = join(outside, "private.txt");
    await writeFile(outsideFile, "must not leave the workspace");
    const linkedExport = join(root, "linked-export.json");
    await symlink(outsideFile, linkedExport);
    const linkedExportResult = relayResult(["workspace-export", "--id", "mission-safe", "--out", linkedExport], env);
    assert.notEqual(linkedExportResult.status, 0);
    assert.match(linkedExportResult.stderr, /export target must not be a symbolic link/i);
    assert.equal(await readFile(outsideFile, "utf8"), "must not leave the workspace");
    await rm(linkedExport);

    const linkedFile = join(workspace, "notes", "escape.txt");
    await symlink(outsideFile, linkedFile);

    for (const args of [
      ["workspace-export", "--id", "mission-safe", "--out", join(root, "export.json")],
      ["workspace-push", "--id", "mission-safe"],
    ]) {
      const result = relayResult(args, env);
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /symbolic links/i);
    }

    await rm(linkedFile);
    const linkedDirectory = join(workspace, "results", "escape");
    await mkdir(dirname(linkedDirectory), { recursive: true });
    await symlink(outside, linkedDirectory);
    const updatePath = join(root, "workspace-update.json");
    await writeFile(updatePath, JSON.stringify({
      schemaVersion: "1",
      id: "mission-safe",
      exportedAt: "2026-08-10T00:00:00.000Z",
      files: { "/results/escape/leak.md": "blocked" },
    }));
    const update = relayResult(["workspace-import", "--file", updatePath], env);
    assert.notEqual(update.status, 0);
    assert.match(update.stderr, /symbolic links/i);
    assert.equal(await readFile(outsideFile, "utf8"), "must not leave the workspace");

    const escapedRoot = join(root, "data", "driftglass", "workspaces", "mission-escaped");
    await symlink(outside, escapedRoot);
    const escapedPath = join(root, "workspace-escaped.json");
    await writeFile(escapedPath, JSON.stringify({
      schemaVersion: "1",
      id: "mission-escaped",
      exportedAt: "2026-08-10T00:00:00.000Z",
      files: { "/notes/leak.md": "blocked" },
    }));
    const escaped = relayResult(["workspace-import", "--file", escapedPath], env);
    assert.notEqual(escaped.status, 0);
    assert.match(escaped.stderr, /must not be a symbolic link/i);

    const escapedData = join(root, "escaped-data");
    await mkdir(join(escapedData, "driftglass"), { recursive: true });
    await symlink(outside, join(escapedData, "driftglass", "workspaces"));
    const escapedContainer = relayResult(["workspace-import", "--file", payloadPath], { ...env, XDG_DATA_HOME: escapedData });
    assert.notEqual(escapedContainer.status, 0);
    assert.match(escapedContainer.stderr, /Workspace root must not be a symbolic link/i);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("workspace import validates every portable path before creating or writing a Mission directory", async () => {
  const root = await mkdtemp(join(tmpdir(), "driftglass-workspace-preflight-"));
  try {
    const payloadPath = join(root, "workspace.json");
    await writeFile(payloadPath, JSON.stringify({
      schemaVersion: "1",
      id: "mission-preflight",
      exportedAt: "2026-08-10T00:00:00.000Z",
      files: {
        "/mission.md": "must not be written",
        "/notes/CON": "reserved Windows device name",
      },
    }));
    const result = relayResult(["workspace-import", "--file", payloadPath], isolatedEnvironment(root));
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Invalid workspace path/i);
    const workspace = join(root, "data", "driftglass", "workspaces", "mission-preflight");
    await assert.rejects(lstat(workspace), (error) => error?.code === "ENOENT");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("workspace archives round-trip across Mission IDs without exporting protected Companion metadata", async () => {
  const root = await mkdtemp(join(tmpdir(), "driftglass-workspace-round-trip-"));
  try {
    const env = isolatedEnvironment(root);
    const sourcePayloadPath = join(root, "source-workspace.json");
    const sourceFiles = {
      "/mission.md": "# Source Mission\n",
      "/notes/continuity.md": "Owner note survives\n",
      "/results/reviewed.json": '{"status":"reviewed"}\n',
      "/exports/continuity.csv": "kind,status\nrestore,passed\n",
    };
    await writeFile(sourcePayloadPath, JSON.stringify({
      schemaVersion: "1",
      id: "mission-source",
      exportedAt: "2026-08-10T00:00:00.000Z",
      files: sourceFiles,
    }));
    const imported = relayResult(["workspace-import", "--file", sourcePayloadPath], env);
    assert.equal(imported.status, 0, imported.stderr);

    const archivePath = join(root, "source-archive.json");
    const exported = relayResult(["workspace-export", "--id", "mission-source", "--out", archivePath], env);
    assert.equal(exported.status, 0, exported.stderr);
    const archive = JSON.parse(await readFile(archivePath, "utf8"));
    assert.equal(archive.schemaVersion, "1");
    assert.equal(archive.id, "mission-source");
    assert.equal(new Date(archive.exportedAt).toISOString(), archive.exportedAt);
    assert.deepEqual(archive.files, sourceFiles);
    assert.equal(Object.keys(archive.files).some((path) => path.toLowerCase() === "/.driftglass-workspace.json"), false);

    const repeatedArchivePath = join(root, "source-archive-repeated.json");
    const repeatedExport = relayResult(["workspace-export", "--id", "mission-source", "--out", repeatedArchivePath], env);
    assert.equal(repeatedExport.status, 0, repeatedExport.stderr);
    const repeatedArchive = JSON.parse(await readFile(repeatedArchivePath, "utf8"));
    assert.equal(new Date(repeatedArchive.exportedAt).toISOString(), repeatedArchive.exportedAt);
    assert.deepEqual(
      { ...repeatedArchive, exportedAt: "<export provenance>" },
      { ...archive, exportedAt: "<export provenance>" },
    );

    const restored = relayResult(["workspace-import", "--file", archivePath, "--id", "mission-target"], env);
    assert.equal(restored.status, 0, restored.stderr);
    const restoredArchivePath = join(root, "target-archive.json");
    const reexported = relayResult(["workspace-export", "--id", "mission-target", "--out", restoredArchivePath], env);
    assert.equal(reexported.status, 0, reexported.stderr);
    const restoredArchive = JSON.parse(await readFile(restoredArchivePath, "utf8"));
    assert.equal(restoredArchive.id, "mission-target");
    assert.deepEqual(restoredArchive.files, sourceFiles);

    for (const metadataPath of ["/.driftglass-workspace.json", "/.DRIFTGLASS-WORKSPACE.JSON"]) {
      const protectedPayloadPath = join(root, `protected-${metadataPath === metadataPath.toLowerCase() ? "lower" : "upper"}.json`);
      await writeFile(protectedPayloadPath, JSON.stringify({
        schemaVersion: "1",
        id: `mission-protected-${metadataPath === metadataPath.toLowerCase() ? "lower" : "upper"}`,
        exportedAt: "2026-08-10T00:00:00.000Z",
        files: { [metadataPath]: "must not be imported", "/notes/after-metadata.md": "must not be written" },
      }));
      const protectedImport = relayResult(["workspace-import", "--file", protectedPayloadPath], env);
      assert.notEqual(protectedImport.status, 0);
      assert.match(protectedImport.stderr, /cannot replace Companion metadata/i);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("workspace archive import rejects unsupported metadata before creating a Mission directory", async () => {
  const root = await mkdtemp(join(tmpdir(), "driftglass-workspace-archive-metadata-"));
  try {
    const cases = [
      {
        name: "missing-schema",
        payload: { id: "mission-missing-schema", exportedAt: "2026-08-10T00:00:00.000Z", files: {} },
        error: /schemaVersion must be 1/i,
      },
      {
        name: "unknown-schema",
        payload: { schemaVersion: "2", id: "mission-unknown-schema", exportedAt: "2026-08-10T00:00:00.000Z", files: {} },
        error: /schemaVersion must be 1/i,
      },
      {
        name: "missing-exported-at",
        payload: { schemaVersion: "1", id: "mission-missing-exported-at", files: {} },
        error: /archive fields are invalid/i,
      },
      {
        name: "invalid-exported-at",
        payload: { schemaVersion: "1", id: "mission-invalid-exported-at", exportedAt: "2026-08-10", files: {} },
        error: /exportedAt is not a canonical ISO timestamp/i,
      },
      {
        name: "noncanonical-id",
        payload: { schemaVersion: "1", id: "Mission Noncanonical", exportedAt: "2026-08-10T00:00:00.000Z", files: {} },
        error: /archive ID is not canonical/i,
      },
      {
        name: "invalid-files",
        payload: { schemaVersion: "1", id: "mission-invalid-files", exportedAt: "2026-08-10T00:00:00.000Z", files: null },
        error: /files must be a JSON object/i,
      },
      {
        name: "unknown-field",
        payload: { schemaVersion: "1", id: "mission-unknown-field", exportedAt: "2026-08-10T00:00:00.000Z", files: {}, future: true },
        error: /archive fields are invalid/i,
      },
    ];
    for (const entry of cases) {
      const payloadPath = join(root, `${entry.name}.json`);
      await writeFile(payloadPath, JSON.stringify(entry.payload));
      const result = relayResult(["workspace-import", "--file", payloadPath], isolatedEnvironment(root));
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, entry.error);
    }
    const workspaceRoot = join(root, "data", "driftglass", "workspaces");
    const entries = await readdir(workspaceRoot).catch((error) => {
      if (error?.code === "ENOENT") return [];
      throw error;
    });
    assert.deepEqual(entries, []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("workspace archive round-trip preserves the 2,000 user-file ceiling beside Companion metadata", async () => {
  const root = await mkdtemp(join(tmpdir(), "driftglass-workspace-max-files-"));
  try {
    const env = isolatedEnvironment(root);
    const maxFiles = Object.fromEntries(Array.from({ length: 2_000 }, (_, index) => [
      `/notes/file-${String(index).padStart(4, "0")}.txt`,
      `${index}\n`,
    ]));
    const maxArchivePath = join(root, "max-files.json");
    await writeFile(maxArchivePath, JSON.stringify({
      schemaVersion: "1",
      id: "mission-max-files",
      exportedAt: "2026-08-10T00:00:00.000Z",
      files: maxFiles,
    }));
    const imported = relayResult(["workspace-import", "--file", maxArchivePath], env);
    assert.equal(imported.status, 0, imported.stderr);

    const reexportPath = join(root, "max-files-reexport.json");
    const reexported = relayResult(["workspace-export", "--id", "mission-max-files", "--out", reexportPath], env);
    assert.equal(reexported.status, 0, reexported.stderr);
    const archive = JSON.parse(await readFile(reexportPath, "utf8"));
    assert.equal(Object.keys(archive.files).length, 2_000);
    assert.deepEqual(archive.files, maxFiles);

    const overLimitPath = join(root, "over-limit.json");
    await writeFile(overLimitPath, JSON.stringify({
      schemaVersion: "1",
      id: "mission-over-limit",
      exportedAt: "2026-08-10T00:00:00.000Z",
      files: { ...maxFiles, "/notes/file-2000.txt": "2000\n" },
    }));
    const overLimit = relayResult(["workspace-import", "--file", overLimitPath], env);
    assert.notEqual(overLimit.status, 0);
    assert.match(overLimit.stderr, /more than 2000 files/i);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("verified local update refuses remote trust and replaces only after an exact digest match", { skip: process.platform === "win32" }, async () => {
  const root = await mkdtemp(join(tmpdir(), "driftglass-update-boundary-"));
  try {
    const installed = join(root, "driftglass-companion.mjs");
    const candidate = join(root, "trusted-release.mjs");
    await copyFile(relay, installed);
    const current = await readFile(relay, "utf8");
    const next = current.replace('const VERSION = "0.9.0";', 'const VERSION = "0.9.1-test";');
    assert.notEqual(next, current);
    await writeFile(candidate, next, { mode: 0o755 });
    const digest = createHash("sha256").update(next).digest("hex");

    const remote = spawnSync(process.execPath, [installed, "update", "--url", "https://paired.example"], { encoding: "utf8" });
    assert.notEqual(remote.status, 0);
    assert.match(remote.stderr, /Remote self-update is disabled/i);
    assert.equal(await readFile(installed, "utf8"), current);

    const mismatch = spawnSync(process.execPath, [installed, "update", "--file", candidate, "--sha256", "0".repeat(64), "--restart", "false"], { encoding: "utf8" });
    assert.notEqual(mismatch.status, 0);
    assert.match(mismatch.stderr, /does not match/i);
    assert.equal(await readFile(installed, "utf8"), current);

    const updated = spawnSync(process.execPath, [installed, "update", "--file", candidate, "--sha256", digest, "--restart", "false"], { encoding: "utf8" });
    assert.equal(updated.status, 0, updated.stderr);
    assert.match(updated.stdout, /Installed verified Companion update/i);
    assert.equal(await readFile(installed, "utf8"), next);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("macOS and Linux service definitions use a controlled collector PATH without serializing ambient credentials", { skip: process.platform === "win32" }, async () => {
  const root = await mkdtemp(join(tmpdir(), "driftglass-service-env-"));
  try {
    const bin = join(root, "collector-bin");
    await writeExecutable(join(bin, "opencli"));
    await writeExecutable(join(bin, "launchctl"));
    await writeExecutable(join(bin, "systemctl"));
    const nodeDirectory = dirname(await realpath(process.execPath));
    const companionDirectory = dirname(await realpath(relay));
    const sentinel = "credential-value-that-must-not-be-written";

    const macRoot = join(root, "mac");
    const macEnv = isolatedEnvironment(macRoot, {
      DRIFTGLASS_TEST_PLATFORM: "darwin",
      DRIFTGLASS_SECRET_SENTINEL: sentinel,
      PATH: [bin, "/usr/bin", "/bin"].join(delimiter),
    });
    await mkdir(join(macRoot, "config", "driftglass"), { recursive: true });
    await writeFile(join(macRoot, "config", "driftglass", "relay.json"), "{}\n");
    const macInstall = relayResult(["service-install"], macEnv);
    assert.equal(macInstall.status, 0, macInstall.stderr);
    const plist = await readFile(join(macRoot, "home", "Library", "LaunchAgents", "dev.driftglass.relay.plist"), "utf8");
    assert.match(plist, /<key>EnvironmentVariables<\/key>/);
    assert.match(plist, /<key>PATH<\/key>/);
    assert.match(plist, new RegExp(nodeDirectory.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.match(plist, new RegExp(companionDirectory.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.match(plist, new RegExp(bin.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.doesNotMatch(plist, new RegExp(sentinel));

    const linuxRoot = join(root, "linux");
    const linuxEnv = isolatedEnvironment(linuxRoot, {
      DRIFTGLASS_TEST_PLATFORM: "linux",
      DRIFTGLASS_SECRET_SENTINEL: sentinel,
      PATH: [bin, "/usr/bin", "/bin"].join(delimiter),
    });
    await mkdir(join(linuxRoot, "config", "driftglass"), { recursive: true });
    await writeFile(join(linuxRoot, "config", "driftglass", "relay.json"), "{}\n");
    const linuxInstall = relayResult(["service-install"], linuxEnv);
    assert.equal(linuxInstall.status, 0, linuxInstall.stderr);
    const unit = await readFile(join(linuxRoot, "config", "systemd", "user", "driftglass-relay.service"), "utf8");
    assert.match(unit, /Environment="PATH=/);
    assert.match(unit, new RegExp(nodeDirectory.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.match(unit, new RegExp(companionDirectory.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.match(unit, new RegExp(bin.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.doesNotMatch(unit, new RegExp(sentinel));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Companion metadata is portable across macOS, Windows, and Linux", () => {
  for (const platform of ["darwin", "win32", "linux"]) {
    const output = JSON.parse(execFileSync(process.execPath, [relay, "capabilities"], {
      encoding: "utf8",
      env: { ...process.env, DRIFTGLASS_TEST_PLATFORM: platform },
    }));
    assert.equal(output.platform, platform);
    assert.equal(output.version, "0.9.0");
    assert.deepEqual(output.capabilities, relayCapabilities);
  }
});
