/**
 * Wave 1 regression: credential-exposure bypass in `isSensitivePath`.
 *
 * Two defects let credential files slip through the prefilter path:
 *
 *  1. `SENSITIVE_DIRS` held the two-segment entry `.config/gcloud`, but the
 *     check compared it against single path segments — so it never matched and
 *     every gcloud credential path was treated as ordinary.
 *  2. There was no basename rule for `hosts.yml` (gh CLI token store) or
 *     `application_default_credentials.json` (gcloud ADC), so those files were
 *     sensitive only when some other rule happened to catch them.
 *
 * Each `isSensitivePath` case below fails on the original implementation and
 * passes after the fix; the `prefilterBash` / `prefilterFileWrite` cases pin
 * the prefilter-level effect (sensitive path => judged, never skipped into
 * model context).
 */

import { describe, expect, it } from "vitest";
import { isSensitivePath, prefilterBash, prefilterFileWrite } from "../../src/hooks/prefilter.js";

const cwd = "/home/dev/project";

describe("wave1 credential-exposure regression", () => {
  const sensitive = [
    // Two-segment sensitive dir: every spelling must match.
    "~/.config/gcloud/credentials.db",
    "/home/dev/.config/gcloud/credentials.db",
    ".config/gcloud/credentials.db",
    ".config/gcloud/access_tokens.db",
    // gh CLI token store basename.
    "~/.config/gh/hosts.yml",
    "/home/dev/.config/gh/hosts.yml",
    // gcloud application-default-credentials basename, wherever it sits.
    "~/.config/gcloud/application_default_credentials.json",
    "/home/dev/.config/gcloud/application_default_credentials.json",
    "application_default_credentials.json",
    // Already-covered sibling: must stay sensitive (basename `credentials`).
    "~/.aws/credentials",
    "/home/dev/.aws/credentials",
  ];
  for (const path of sensitive) {
    it(`treats ${path} as sensitive`, () => {
      expect(isSensitivePath(path)).toBe(true);
    });
  }

  const ordinary = [
    "/home/dev/project/src/index.ts",
    "/home/dev/project/.config/app/settings.json",
    "/home/dev/project/hosts.txt",
  ];
  for (const path of ordinary) {
    it(`treats ${path} as ordinary`, () => {
      expect(isSensitivePath(path)).toBe(false);
    });
  }

  it("judges a file write to a gcloud credential path", () => {
    const verdict = prefilterFileWrite("~/.config/gcloud/credentials.db", { cwd, strict: false });
    expect(verdict.kind).toBe("judge");
    expect(verdict.reason).toMatch(/sensitive/);
  });

  it("judges a file write to hosts.yml", () => {
    const verdict = prefilterFileWrite("~/.config/gh/hosts.yml", { cwd, strict: false });
    expect(verdict.kind).toBe("judge");
    expect(verdict.reason).toMatch(/sensitive/);
  });

  it("judges reading a gcloud credential file through bash", () => {
    const verdict = prefilterBash("cat ~/.config/gcloud/credentials.db");
    expect(verdict.kind).toBe("judge");
    expect(verdict.reason).toMatch(/sensitive/);
  });

  it("judges reading hosts.yml through bash", () => {
    const verdict = prefilterBash("cat ~/.config/gh/hosts.yml");
    expect(verdict.kind).toBe("judge");
    expect(verdict.reason).toMatch(/sensitive/);
  });
});
