import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const installer = fileURLToPath(new URL("../scripts/install-control-service.sh", import.meta.url));
const script = readFileSync(installer, "utf8");
const packageJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { files: string[] };

describe("protected control service installer", () => {
  it("is valid POSIX shell and consumes only a pinned candidate", () => {
    const syntax = spawnSync("sh", ["-n", installer], { encoding: "utf8" });
    expect(syntax.status, syntax.stderr).toBe(0);
    expect(script).toContain("EXPECTED_MANIFEST_SHA256");
    expect(script).toContain("sha256sum --check --status SHA256SUMS");
    expect(script).toContain("STAGE_PARENT=/var/lib/jeverb/install-staging");
    expect(script).toContain("$STAGE/jeverb_control_service.py");
    expect(script).toContain("$STAGE/jeverb-control.service");
    expect(script).toContain("$STAGE/org.jeverb.control.policy");
    expect(script).toContain('$CANDIDATE/verify_installed.py');
    expect(script).toContain('python3 "$STAGE/verify_installed.py" "$STAGE" /');
    expect(script.indexOf('python3 "$STAGE/verify_installed.py" "$STAGE" /')).toBeLessThan(script.indexOf("systemctl daemon-reload"));
    expect(packageJson.files).toContain("control-service/verify_installed.py");
    expect(packageJson.files).toContain("scripts/assemble_control_candidate.py");
    expect(script).not.toContain('ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.."');
    expect(script).not.toContain('"$ROOT/control-service/');
  });

  it("refuses a non-root invocation before reading or installing a candidate", () => {
    if (process.getuid?.() === 0) return;
    const result = spawnSync("sh", [installer, "/tmp/not-a-candidate", "0".repeat(64)], {
      encoding: "utf8",
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("explicit root/operator install");
    expect(result.stderr).not.toContain("candidate manifest");
  });
});
