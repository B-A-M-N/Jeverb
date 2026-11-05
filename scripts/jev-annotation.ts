#!/usr/bin/env tsx
/**
 * Prepare blind human-label packets and reconcile two independent raters.
 * The source-ID key is sensitive and must never be sent to annotators.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { prepareBlindAnnotation, reconcileBlindAnnotations, type BlindAnnotationKey, type BlindAnnotationPacket } from "../src/jev/annotation.js";
import { assertOutputPathAvailable } from "./artifact-output.js";

function option(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index < 0 ? undefined : process.argv[index + 1];
}

function required(name: string): string {
  const value = option(name);
  if (!value) throw new Error(`missing ${name}`);
  return value;
}

function createOnly(path: string, data: string, mode: number): void {
  assertOutputPathAvailable(path);
  writeFileSync(path, data, { flag: "wx", mode });
}

function main(): void {
  const command = process.argv[2];
  if (command === "prepare") {
    const sourcePath = process.argv[3];
    if (!sourcePath) throw new Error("usage: jev-annotation.ts prepare <dataset.jsonl> --packet <packet.json> --key <private-key.json>");
    const result = prepareBlindAnnotation(readFileSync(sourcePath, "utf8"));
    createOnly(required("--packet"), `${JSON.stringify(result.packet, null, 2)}\n`, 0o600);
    createOnly(required("--key"), `${JSON.stringify(result.key, null, 2)}\n`, 0o600);
    console.log(JSON.stringify({ status: "packet-prepared", cases: result.packet.cases.length, sourceHash: result.packet.sourceHash, keyMode: "0600" }));
    return;
  }
  if (command === "reconcile") {
    const sourcePath = required("--dataset");
    const packet = JSON.parse(readFileSync(required("--packet"), "utf8")) as BlindAnnotationPacket;
    const key = JSON.parse(readFileSync(required("--key"), "utf8")) as BlindAnnotationKey;
    const result = reconcileBlindAnnotations({
      sourceText: readFileSync(sourcePath, "utf8"),
      packet,
      key,
      firstText: readFileSync(required("--rater-a"), "utf8"),
      secondText: readFileSync(required("--rater-b"), "utf8"),
      ...(option("--adjudicator") ? { adjudicatorText: readFileSync(option("--adjudicator")!, "utf8") } : {}),
    });
    createOnly(required("--report"), `${JSON.stringify({ ...result, labeledDataset: undefined }, null, 2)}\n`, 0o600);
    if (result.resolved && result.labeledDataset !== undefined) {
      createOnly(required("--labeled-dataset"), result.labeledDataset, 0o600);
    }
    console.log(JSON.stringify({ status: result.unanimous ? "unanimous" : result.resolved ? "adjudicated" : "adjudication-required", cases: result.cases, judgments: result.judgments, agreements: result.agreements, disagreements: result.disagreements.length }));
    return;
  }
  throw new Error("usage: jev-annotation.ts <prepare|reconcile> ...");
}

try {
  main();
} catch (error) {
  console.error(`jev-annotation: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 2;
}
