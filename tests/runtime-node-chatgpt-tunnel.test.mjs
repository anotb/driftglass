import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { isAbsolute, join, resolve } from "node:path";

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
const compiledRoot = process.env.DRIFTGLASS_TEST_DIST
  ? resolve(process.env.DRIFTGLASS_TEST_DIST)
  : join(repositoryRoot, ".test-dist");
const require = createRequire(import.meta.url);

test("self-host ChatGPT tunnel setup is exact, outbound-only, and keeps read and updates separate", () => {
  const { buildChatGptTunnelSetup } = require(join(compiledRoot, "runtime/node/chatgpt-tunnel.js"));
  const executable = "/opt/Driftglass Runtime/bin/node";
  const bridgeArguments = [
    "/opt/Driftglass Runtime/driftglass-selfhost.mjs",
    "connect",
    "--data-dir",
    "/srv/driftglass owner/data",
    "--origin",
    "http://127.0.0.1:8787",
  ];
  const setup = buildChatGptTunnelSetup({
    targetInstanceId: "local-instance-0123456789abcdef",
    bridge: { command: executable, args: bridgeArguments },
    shell: "posix",
  });

  assert.equal(setup.supported, true);
  assert.equal(setup.available, false);
  assert.equal(setup.status, "setup-required");
  assert.equal(setup.optional, true);
  assert.equal(setup.title, "Connect ChatGPT");
  assert.equal(setup.defaultConnection, "compact");
  assert.equal(setup.managedByDriftglass, false);
  assert.deepEqual(setup.network, {
    inboundPortsRequired: false,
    routesThroughDriftglassCloud: false,
    outboundHttps: ["api.openai.com:443"],
  });
  assert.deepEqual(setup.environment, {
    runtimeKey: "CONTROL_PLANE_API_KEY",
    researchTunnelId: "CONTROL_PLANE_TUNNEL_ID",
    updatesTunnelId: "CONTROL_PLANE_UPDATES_TUNNEL_ID",
  });
  assert.equal(setup.links.download, "https://github.com/openai/tunnel-client/releases/latest");

  const read = setup.profiles.compact;
  const updates = setup.profiles.updates;
  assert.equal(read.default, true);
  assert.equal(read.access, "read");
  assert.equal(read.tunnelIdEnvironment, "CONTROL_PLANE_TUNNEL_ID");
  assert.equal(updates.default, false);
  assert.equal(updates.access, "approval");
  assert.equal(updates.tunnelIdEnvironment, "CONTROL_PLANE_UPDATES_TUNNEL_ID");
  assert.notEqual(read.profile, updates.profile);
  assert.match(read.profile, /^driftglass-[a-z0-9]{8,12}-read$/);
  assert.match(updates.profile, /^driftglass-[a-z0-9]{8,12}-updates$/);
  assert.equal(isAbsolute(read.localBridge.command), true);
  assert.deepEqual(read.localBridge.args, [...bridgeArguments, "--access", "read"]);
  assert.deepEqual(updates.localBridge.args, [...bridgeArguments, "--access", "approval"]);

  assert.deepEqual(read.init.args.slice(0, 2), ["init", "--sample"]);
  assert.equal(read.init.args[2], "sample_mcp_stdio_local");
  assert.equal(read.label, "Research");
  assert.equal(read.init.args[read.init.args.indexOf("--health-listen-addr") + 1], "127.0.0.1:0");
  assert.equal(read.init.args[read.init.args.indexOf("--tunnel-id") + 1], "${CONTROL_PLANE_TUNNEL_ID}");
  assert.equal(updates.init.args[updates.init.args.indexOf("--tunnel-id") + 1], "${CONTROL_PLANE_UPDATES_TUNNEL_ID}");
  assert.equal(read.init.args[read.init.args.indexOf("--mcp-command") + 1], read.localBridge.mcpCommand);
  assert.deepEqual(read.check.args, ["doctor", "--profile", read.profile, "--explain"]);
  assert.deepEqual(read.run.args, ["run", "--profile", read.profile]);
  assert.match(read.localBridge.mcpCommand, /^'\/opt\/Driftglass Runtime\/bin\/node'/);
  assert.match(read.init.copyCommand, /--tunnel-id "\$\{CONTROL_PLANE_TUNNEL_ID:\?Set CONTROL_PLANE_TUNNEL_ID first\}" --mcp-command/);
  assert.match(updates.init.copyCommand, /--tunnel-id "\$\{CONTROL_PLANE_UPDATES_TUNNEL_ID:\?Set CONTROL_PLANE_UPDATES_TUNNEL_ID first\}" --mcp-command/);
  assert.doesNotMatch(read.init.copyCommand, /\s''\s--mcp-command/);

  const serialized = JSON.stringify(setup);
  assert.doesNotMatch(serialized, /sk-[A-Za-z0-9_-]+/);
  assert.doesNotMatch(serialized, /owner-secret|readKey|operationsKey|\/mcp\/[A-Za-z0-9_-]{16,}/i);
  assert.doesNotMatch(serialized, /0\.0\.0\.0|driftglass\.cloud/i);
});

test("Windows setup keeps the local bridge exact without merging the update-enabled profile", () => {
  const { buildChatGptTunnelSetup } = require(join(compiledRoot, "runtime/node/chatgpt-tunnel.js"));
  const setup = buildChatGptTunnelSetup({
    targetInstanceId: "local-instance-fedcba9876543210",
    bridge: {
      command: "C:\\Program Files\\nodejs\\node.exe",
      args: [
        "C:\\Driftglass Home\\driftglass-selfhost.mjs",
        "connect",
        "--data-dir",
        "C:\\Driftglass Data",
        "--origin",
        "http://127.0.0.1:8787",
      ],
    },
    shell: "powershell",
  });

  assert.match(setup.profiles.compact.localBridge.mcpCommand, /^"C:\\Program Files\\nodejs\\node\.exe"/);
  assert.match(setup.profiles.compact.init.copyCommand, /\$env:CONTROL_PLANE_TUNNEL_ID/);
  assert.match(setup.profiles.updates.init.copyCommand, /\$env:CONTROL_PLANE_UPDATES_TUNNEL_ID/);
  assert.match(setup.profiles.compact.localBridge.mcpCommand, /--access read$/);
  assert.match(setup.profiles.updates.localBridge.mcpCommand, /--access approval$/);
});
