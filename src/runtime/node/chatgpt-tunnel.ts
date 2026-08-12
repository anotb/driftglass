export type LocalCommandShell = "posix" | "powershell";

export interface LocalMcpBridgeCommand {
  readonly command: string;
  readonly args: readonly string[];
}

export interface ChatGptTunnelSetupInput {
  readonly targetInstanceId: string;
  readonly bridge: LocalMcpBridgeCommand;
  readonly shell?: LocalCommandShell;
}

export interface TunnelClientCommand {
  readonly command: "tunnel-client";
  readonly args: readonly string[];
  readonly copyCommand: string;
}

export interface ChatGptTunnelProfile {
  readonly label: string;
  readonly purpose: string;
  readonly access: "read" | "approval";
  readonly default: boolean;
  readonly profile: string;
  readonly tunnelIdEnvironment: "CONTROL_PLANE_TUNNEL_ID" | "CONTROL_PLANE_UPDATES_TUNNEL_ID";
  readonly localBridge: LocalMcpBridgeCommand & { readonly mcpCommand: string };
  readonly init: TunnelClientCommand;
  readonly check: TunnelClientCommand;
  readonly run: TunnelClientCommand;
}

export interface ChatGptTunnelSetup {
  readonly supported: true;
  readonly available: false;
  readonly status: "setup-required";
  readonly optional: true;
  readonly mode: "openai-secure-mcp-tunnel";
  readonly title: "Connect ChatGPT";
  readonly detail: string;
  readonly defaultConnection: "compact";
  readonly managedByDriftglass: false;
  readonly environment: {
    readonly runtimeKey: "CONTROL_PLANE_API_KEY";
    readonly researchTunnelId: "CONTROL_PLANE_TUNNEL_ID";
    readonly updatesTunnelId: "CONTROL_PLANE_UPDATES_TUNNEL_ID";
  };
  readonly network: {
    readonly inboundPortsRequired: false;
    readonly routesThroughDriftglassCloud: false;
    readonly outboundHttps: readonly ["api.openai.com:443"];
  };
  readonly links: {
    readonly guide: "https://developers.openai.com/api/docs/guides/secure-mcp-tunnels";
    readonly download: "https://github.com/openai/tunnel-client/releases/latest";
    readonly tunnelSettings: "https://platform.openai.com/settings/organization/tunnels";
    readonly chatgptPlugins: "https://chatgpt.com/plugins";
  };
  readonly steps: readonly string[];
  readonly profiles: {
    readonly compact: ChatGptTunnelProfile;
    readonly updates: ChatGptTunnelProfile;
  };
}

const SAFE_COMMAND_ARGUMENT = /^[A-Za-z0-9_./:@%+=,-]+$/;
function posixQuote(value: string): string {
  if (SAFE_COMMAND_ARGUMENT.test(value)) return value;
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

function powershellQuote(value: string): string {
  if (SAFE_COMMAND_ARGUMENT.test(value)) return value;
  return `'${value.replace(/'/g, "''")}'`;
}

function windowsProcessQuote(value: string): string {
  if (value && !/[\s"]/u.test(value)) return value;
  let quoted = '"';
  let backslashes = 0;
  for (const character of value) {
    if (character === "\\") {
      backslashes += 1;
      continue;
    }
    if (character === '"') {
      quoted += "\\".repeat(backslashes * 2 + 1) + '"';
      backslashes = 0;
      continue;
    }
    quoted += "\\".repeat(backslashes) + character;
    backslashes = 0;
  }
  return `${quoted}${"\\".repeat(backslashes * 2)}"`;
}

function commandLine(command: string, args: readonly string[], shell: LocalCommandShell): string {
  const quote = shell === "powershell" ? powershellQuote : posixQuote;
  return [...(command ? [command] : []), ...args].map(quote).join(" ");
}

function localMcpCommand(command: string, args: readonly string[], shell: LocalCommandShell): string {
  if (shell === "powershell") {
    return [command, ...args].map(windowsProcessQuote).join(" ");
  }
  return [command, ...args].map(posixQuote).join(" ");
}

function tunnelInitCopyCommand(
  profile: string,
  tunnelIdEnvironment: ChatGptTunnelProfile["tunnelIdEnvironment"],
  mcpCommand: string,
  shell: LocalCommandShell,
): string {
  const beforeTunnelId = commandLine("tunnel-client", [
    "init",
    "--sample",
    "sample_mcp_stdio_local",
    "--profile",
    profile,
    "--health-listen-addr",
    "127.0.0.1:0",
    "--tunnel-id",
  ], shell);
  const afterTunnelId = commandLine("", ["--mcp-command", mcpCommand], shell).trim();
  const tunnelId = shell === "powershell"
    ? `$env:${tunnelIdEnvironment}`
    : `"\${${tunnelIdEnvironment}:?Set ${tunnelIdEnvironment} first}"`;
  return `${beforeTunnelId} ${tunnelId} ${afterTunnelId}`;
}

function profileTag(targetInstanceId: string): string {
  const value = targetInstanceId.toLowerCase().replace(/[^a-z0-9]/g, "");
  if (value.length < 8) throw new Error("The local instance identity is too short to name a ChatGPT tunnel profile safely");
  return value.slice(-12);
}

function tunnelProfile(input: {
  readonly name: string;
  readonly label: string;
  readonly purpose: string;
  readonly access: "read" | "approval";
  readonly isDefault: boolean;
  readonly tunnelIdEnvironment: ChatGptTunnelProfile["tunnelIdEnvironment"];
  readonly bridge: LocalMcpBridgeCommand;
  readonly shell: LocalCommandShell;
}): ChatGptTunnelProfile {
  const args = [...input.bridge.args, "--access", input.access];
  const mcpCommand = localMcpCommand(input.bridge.command, args, input.shell);
  const initArgs = [
    "init",
    "--sample",
    "sample_mcp_stdio_local",
    "--profile",
    input.name,
    "--health-listen-addr",
    "127.0.0.1:0",
    "--tunnel-id",
    `\${${input.tunnelIdEnvironment}}`,
    "--mcp-command",
    mcpCommand,
  ];
  const checkArgs = ["doctor", "--profile", input.name, "--explain"];
  const runArgs = ["run", "--profile", input.name];
  return Object.freeze({
    label: input.label,
    purpose: input.purpose,
    access: input.access,
    default: input.isDefault,
    profile: input.name,
    tunnelIdEnvironment: input.tunnelIdEnvironment,
    localBridge: Object.freeze({ command: input.bridge.command, args: Object.freeze(args), mcpCommand }),
    init: Object.freeze({
      command: "tunnel-client" as const,
      args: Object.freeze(initArgs),
      copyCommand: tunnelInitCopyCommand(input.name, input.tunnelIdEnvironment, mcpCommand, input.shell),
    }),
    check: Object.freeze({
      command: "tunnel-client" as const,
      args: Object.freeze(checkArgs),
      copyCommand: commandLine("tunnel-client", checkArgs, input.shell),
    }),
    run: Object.freeze({
      command: "tunnel-client" as const,
      args: Object.freeze(runArgs),
      copyCommand: commandLine("tunnel-client", runArgs, input.shell),
    }),
  });
}

/**
 * Build owner-specific OpenAI Secure MCP Tunnel setup without reading or
 * emitting the OpenAI runtime key, tunnel ID, Driftglass owner secret, or MCP
 * capability. The two profiles intentionally stay separate.
 */
export function buildChatGptTunnelSetup(input: ChatGptTunnelSetupInput): ChatGptTunnelSetup {
  const shell = input.shell ?? "posix";
  const tag = profileTag(input.targetInstanceId);
  const compact = tunnelProfile({
    name: `driftglass-${tag}-read`,
    label: "Research",
    purpose: "Read Today, Missions, Stories, and public evidence",
    access: "read",
    isDefault: true,
    tunnelIdEnvironment: "CONTROL_PLANE_TUNNEL_ID",
    bridge: input.bridge,
    shell,
  });
  const updates = tunnelProfile({
    name: `driftglass-${tag}-updates`,
    label: "Allow updates",
    purpose: "Save and review answers against a fixed evidence snapshot",
    access: "approval",
    isDefault: false,
    tunnelIdEnvironment: "CONTROL_PLANE_UPDATES_TUNNEL_ID",
    bridge: input.bridge,
    shell,
  });
  return Object.freeze({
    supported: true,
    available: false,
    status: "setup-required",
    optional: true,
    mode: "openai-secure-mcp-tunnel",
    title: "Connect ChatGPT",
    detail: "OpenAI's tunnel client runs on this machine and connects outward over HTTPS. Driftglass stays on loopback and does not use a Driftglass cloud relay.",
    defaultConnection: "compact",
    managedByDriftglass: false,
    environment: Object.freeze({
      runtimeKey: "CONTROL_PLANE_API_KEY",
      researchTunnelId: "CONTROL_PLANE_TUNNEL_ID",
      updatesTunnelId: "CONTROL_PLANE_UPDATES_TUNNEL_ID",
    }),
    network: Object.freeze({
      inboundPortsRequired: false,
      routesThroughDriftglassCloud: false,
      outboundHttps: Object.freeze(["api.openai.com:443"] as const),
    }),
    links: Object.freeze({
      guide: "https://developers.openai.com/api/docs/guides/secure-mcp-tunnels",
      download: "https://github.com/openai/tunnel-client/releases/latest",
      tunnelSettings: "https://platform.openai.com/settings/organization/tunnels",
      chatgptPlugins: "https://chatgpt.com/plugins",
    }),
    steps: Object.freeze([
      "Create a Secure MCP Tunnel and runtime key in your OpenAI Platform organization.",
      "Install the latest tunnel-client on this machine.",
      "Set CONTROL_PLANE_API_KEY and CONTROL_PLANE_TUNNEL_ID in your local shell, then create, check, and run the default Research profile.",
      "Keep the Research tunnel-client run active, then choose its Tunnel when connecting Driftglass in ChatGPT.",
      "After Driftglass shows Connected, use Tools for a quick check. For steadier routing, download Add @Driftglass from this card, install it in ChatGPT desktop, and start a new Work chat with @Driftglass.",
      "Only when you want ChatGPT to save suggestions for review, create a second tunnel, set CONTROL_PLANE_UPDATES_TUNNEL_ID, and run the separate Allow updates profile.",
    ]),
    profiles: Object.freeze({ compact, updates }),
  });
}
