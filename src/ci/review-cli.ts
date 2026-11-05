import { readFileSync } from "node:fs";

const BLOCKING = new Set(["BLOCK", "SECURITY REVIEW"]);

function main(): number {
  const raw = readFileSync(0, "utf8");
  let receipt: unknown;
  try {
    receipt = JSON.parse(raw);
  } catch {
    console.error("invalid JSON");
    return 2;
  }
  if (typeof receipt !== "object" || receipt === null) {
    console.error("invalid receipt");
    return 2;
  }
  const lane = (receipt as { lane?: unknown }).lane;
  if (BLOCKING.has(lane as string)) {
    console.error(`review rejected: ${String(lane)}`);
    return 1;
  }
  if (lane !== "NITS" && lane !== "MERGE" && lane !== "UNAVAILABLE") {
    console.error("review unavailable or malformed");
    return 2;
  }
  if (lane === "UNAVAILABLE") {
    console.error("review unavailable");
    return 2;
  }
  return 0;
}

process.exit(main());
