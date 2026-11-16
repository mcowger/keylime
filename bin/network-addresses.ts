import os from "node:os";

type AddressEntry = {
  label: string;
  url: string;
  name?: string;
  address?: string;
};
type InterfaceAddress = {
  family: string | number;
  internal: boolean;
  address: string;
};
type AccessibleAddressOptions = {
  hostname?: string | null;
  port: string | number;
  interfaces?: Record<string, InterfaceAddress[] | undefined>;
};
type BannerOptions = {
  version?: string;
  entries?: AddressEntry[];
  hint?: string;
  passwordEnabled?: boolean;
  isTTY?: boolean;
};

const LOOPBACK_HOSTNAMES = new Set([
  "127.0.0.1",
  "localhost",
  "::1",
  "[::1]",
  "0:0:0:0:0:0:0:1",
  "[0:0:0:0:0:0:0:1]",
]);
const WILDCARD_HOSTNAMES = new Set([
  "0.0.0.0",
  "::",
  "[::]",
  "0:0:0:0:0:0:0:0",
  "[0:0:0:0:0:0:0:0]",
  "",
]);

export function isWildcardHost(hostname: unknown): boolean {
  if (hostname == null) return true;
  if (typeof hostname !== "string") return false;
  return WILDCARD_HOSTNAMES.has(hostname.trim());
}

export function isLoopbackHost(hostname: unknown): boolean {
  if (typeof hostname !== "string") return false;
  const h = hostname.trim().toLowerCase();
  if (h.startsWith("127.")) return true;
  return LOOPBACK_HOSTNAMES.has(h);
}
export function getBrowserUrl(
  hostname: string | null | undefined,
  port: string | number,
): string {
  if (isWildcardHost(hostname)) {
    return `http://localhost:${port}`;
  }
  if (
    typeof hostname === "string" &&
    hostname.includes(":") &&
    !hostname.startsWith("[")
  ) {
    return `http://[${hostname}]:${port}`;
  }
  return `http://${hostname}:${port}`;
}

/** Open `url` in the default browser; a failure only warns. */
export function openInBrowser(url: string): void {
  const { spawn } = process.getBuiltinModule("node:child_process");
  const command = process.platform === "darwin" ? "open" : "xdg-open";
  const opener = spawn(command, [url], { stdio: "ignore", detached: true });
  opener.on("error", (error) =>
    console.warn(`Could not open browser automatically: ${error.message}`),
  );
  opener.unref();
}

export function isTailscaleAddress(
  ifaceName: unknown,
  address: unknown,
): boolean {
  if (
    typeof ifaceName === "string" &&
    ifaceName.toLowerCase().includes("tailscale")
  ) {
    return true;
  }
  // Tailscale IPv4 uses CGNAT range 100.64.0.0/10 (100.64.0.0 to 100.127.255.255)
  if (typeof address === "string") {
    const parts = address.split(".").map(Number);
    if (
      parts.length === 4 &&
      parts[0] === 100 &&
      parts[1] >= 64 &&
      parts[1] <= 127
    ) {
      return true;
    }
  }
  return false;
}

export function isIgnoredAddress(
  ifaceName: unknown,
  address: unknown,
): boolean {
  if (!address || typeof address !== "string") return true;
  // APIPA (Automatic Private IP Addressing: 169.254.0.0/16)
  if (address.startsWith("169.254.")) return true;
  // RFC 2544 benchmark / TUN proxy fake-ip range (198.18.0.0/15)
  if (/^198\.(18|19)\./.test(address)) return true;
  // Loopback
  if (address.startsWith("127.")) return true;
  return false;
}

export function isVirtualBridge(ifaceName: unknown): boolean {
  if (!ifaceName || typeof ifaceName !== "string") return false;
  const name = ifaceName.toLowerCase();
  return (
    name.includes("vethernet") ||
    name.includes("veth") ||
    name.includes("wsl") ||
    name.includes("docker") ||
    name.includes("hyper-v") ||
    name.includes("vmware") ||
    name.includes("virtualbox") ||
    name.includes("virbr")
  );
}

export function isStandardPhysicalInterface(name: unknown): boolean {
  if (!name || typeof name !== "string") return false;
  if (isVirtualBridge(name)) return false;
  const lower = name.toLowerCase();
  return (
    lower.includes("以太网") ||
    lower.includes("ethernet") ||
    lower.includes("wi-fi") ||
    lower.includes("wifi") ||
    lower.includes("wlan") ||
    lower.includes("无线") ||
    /^en\d+$/.test(lower) ||
    /^eth\d+$/.test(lower) ||
    /^wlan\d+$/.test(lower) ||
    /^enp\d+s\d+/.test(lower) ||
    /^wlp\d+s\d+/.test(lower)
  );
}

export function getAccessibleAddresses({
  hostname,
  port,
  interfaces = os.networkInterfaces(),
}: AccessibleAddressOptions): { entries: AddressEntry[]; hint?: string } {
  if (isLoopbackHost(hostname)) {
    return {
      entries: [{ label: "Local", url: `http://localhost:${port}` }],
      hint: "use -H 0.0.0.0 to expose to the network",
    };
  }

  if (!isWildcardHost(hostname)) {
    return {
      entries: [{ label: "Network", url: `http://${hostname}:${port}` }],
    };
  }

  const entries: AddressEntry[] = [
    { label: "Local", url: `http://localhost:${port}` },
  ];
  const lanEntries: AddressEntry[] = [];
  const tailscaleEntries: AddressEntry[] = [];
  const otherEntries: AddressEntry[] = [];
  const seenAddresses = new Set(["127.0.0.1", "localhost"]);

  for (const [name, addrs] of Object.entries(interfaces)) {
    if (!addrs || !Array.isArray(addrs)) continue;
    for (const info of addrs) {
      if (info.family !== "IPv4" && info.family !== 4) continue;
      if (info.internal) continue;
      const addr = info.address;
      if (seenAddresses.has(addr)) continue;
      if (isIgnoredAddress(name, addr)) continue;

      seenAddresses.add(addr);

      if (isTailscaleAddress(name, addr)) {
        tailscaleEntries.push({
          label: "Tailscale",
          url: `http://${addr}:${port}`,
          name,
          address: addr,
        });
      } else if (isStandardPhysicalInterface(name)) {
        lanEntries.push({
          label: "Network",
          url: `http://${addr}:${port}`,
          name,
          address: addr,
        });
      } else {
        otherEntries.push({
          label: name,
          url: `http://${addr}:${port}`,
          name,
          address: addr,
        });
      }
    }
  }

  entries.push(...lanEntries, ...tailscaleEntries, ...otherEntries);
  return { entries };
}

export function formatAddressBanner({
  version = "0.0.0",
  entries = [],
  hint,
  passwordEnabled = false,
  isTTY = process.stdout.isTTY,
}: BannerOptions): string {
  const dim = isTTY ? (s: string) => `\x1b[90m${s}\x1b[0m` : (s: string) => s;
  const bold = isTTY ? (s: string) => `\x1b[1m${s}\x1b[0m` : (s: string) => s;
  const green = isTTY ? (s: string) => `\x1b[32m${s}\x1b[0m` : (s: string) => s;
  const cyan = isTTY ? (s: string) => `\x1b[36m${s}\x1b[0m` : (s: string) => s;

  const lines = [];
  lines.push("");
  lines.push(`  ${bold("keylime")} ${dim(`v${version}`)} ${green("is ready")}`);
  lines.push("");

  const maxLabelLen = Math.max(
    ...entries.map((e) => e.label.length),
    hint ? 7 : 5,
  );
  for (const entry of entries) {
    const padLabel = (entry.label + ":").padEnd(maxLabelLen + 2, " ");
    lines.push(`  ${green("➜")}  ${bold(padLabel)} ${cyan(entry.url)}`);
  }

  if (hint) {
    const padLabel = "Network:".padEnd(maxLabelLen + 2, " ");
    lines.push(`  ${dim("➜")}  ${dim(padLabel)} ${dim(hint)}`);
  }

  if (passwordEnabled) {
    lines.push("");
    lines.push(
      `  ${dim("🔒 Password protection enabled (KEYLIME_PASSWORD_HASH)")}`,
    );
  }

  lines.push("");
  return lines.join("\n");
}
