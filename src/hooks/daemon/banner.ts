/**
 * The one line the daemon prints when its listener is up, plus a warning
 * when it holds no auth keys. Keyless means the loopback API accepts
 * unauthenticated requests, which is only safe on a single-user machine —
 * the banner already said `auth none`, but nothing called it a warning.
 * Pure composition so the keyless path is unit-testable: actually running
 * keyless requires token minting to fail, which a test cannot arrange
 * without breaking the data dir the daemon needs.
 */
export interface DaemonStartupNotice {
  line: string;
  warning?: string;
}

export function daemonStartupBanner(args: {
  version: string;
  protocol: number | string;
  port: number;
  dataDir: string;
  keyCount: number;
  restarts: number;
}): DaemonStartupNotice {
  const line =
    `[jev-daemon] v${args.version} protocol ${args.protocol} listening on 127.0.0.1:${args.port}, ` +
    `data ${args.dataDir}, auth ${args.keyCount === 0 ? "none" : `${args.keyCount} key${args.keyCount === 1 ? "" : "s"}`}, ` +
    `restarts ${args.restarts}`;
  if (args.keyCount !== 0) return { line };
  return {
    line,
    warning:
      "[jev-daemon] WARNING: running with no auth keys: the local API accepts unauthenticated requests " +
      "on 127.0.0.1. Configure a key, or keep this machine single-user.",
  };
}
