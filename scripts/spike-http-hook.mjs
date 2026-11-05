#!/usr/bin/env node
/**
 * Purpose: temporary loopback probe for observing HTTP hook request metadata.
 * Owner: documented developer experiment in docs/SPIKE_HTTP_HOOK.md.
 * Lifecycle: output is private, create-only, capped at 4 MiB, and retained at
 * the printed path until the operator reviews and removes it.
 * Forbidden: recording header values or writing output inside the source tree.
 */

import { createServer } from "node:http";
import {
  chmodSync,
  closeSync,
  fstatSync,
  mkdtempSync,
  openSync,
  realpathSync,
  rmSync,
  rmdirSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const port = Number(process.argv[2] ?? 10523);
const mode = process.argv[3] ?? "json";
if (!Number.isSafeInteger(port) || port < 0 || port > 65535) throw new Error("port must be an integer in [0,65535]");
if (!["empty", "json", "text", "status500"].includes(mode)) throw new Error("mode must be empty, json, text, or status500");

const repoRoot = realpathSync(resolve(dirname(fileURLToPath(import.meta.url)), ".."));
const insideRepository = (path) => {
  const rel = relative(repoRoot, path);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
};

let defaultLogDir;
let log;
if (process.env.JEV_SPIKE_LOG) {
  log = resolve(process.env.JEV_SPIKE_LOG);
  const actualPath = join(realpathSync(dirname(log)), basename(log));
  if (insideRepository(actualPath)) throw new Error("JEV_SPIKE_LOG must be outside the repository");
} else {
  defaultLogDir = mkdtempSync(join(tmpdir(), "jev-spike-"));
  chmodSync(defaultLogDir, 0o700);
  log = join(defaultLogDir, "requests.jsonl");
}

// Exclusive creation rejects pre-existing files and symlinks. Hold the file
// descriptor for the process lifetime so path replacement cannot redirect logs.
let logFd;
try {
  logFd = openSync(log, "ax", 0o600);
} catch (error) {
  if (defaultLogDir !== undefined) rmdirSync(defaultLogDir);
  throw error;
}
const MAX_LOG_BYTES = 4 * 1024 * 1024;
const MAX_BODY_BYTES = 1024 * 1024;
const KNOWN_EVENTS = new Set(["SessionStart", "UserPromptSubmit", "PreToolUse", "PostToolUse", "PostToolBatch", "Stop", "SubagentStop"]);
let logBytes = fstatSync(logFd).size;
let logLimitReported = false;
let logFdClosed = false;
let shutdownTimer;

function closeLog() {
  if (logFdClosed) return;
  closeSync(logFd);
  logFdClosed = true;
  if (logBytes === 0) {
    rmSync(log, { force: true });
    if (defaultLogDir !== undefined) rmdirSync(defaultLogDir);
  }
}

function describeHeaderValue(value) {
  return `${value.length} chars${value.includes("$") ? " (contains $ — not interpolated)" : ""}`;
}

function logRequest(line) {
  const serialized = `${JSON.stringify(line)}\n`;
  const bytes = Buffer.byteLength(serialized);
  if (logBytes + bytes > MAX_LOG_BYTES) {
    if (!logLimitReported) {
      logLimitReported = true;
      process.stderr.write(`spike log reached ${MAX_LOG_BYTES} bytes; further requests will not be recorded\n`);
    }
    return;
  }
  writeFileSync(logFd, serialized);
  logBytes += bytes;
}

const server = createServer((req, res) => {
  const chunks = [];
  let bodyBytes = 0;
  let bodyTooLarge = false;
  req.on("data", (chunk) => {
    bodyBytes += chunk.length;
    if (bodyBytes > MAX_BODY_BYTES) {
      bodyTooLarge = true;
      chunks.length = 0;
      return;
    }
    if (!bodyTooLarge) chunks.push(chunk);
  });
  req.on("end", () => {
    const body = Buffer.concat(chunks).toString("utf8");
    let event = "?";
    let session = "?";
    try {
      const parsed = bodyTooLarge ? {} : JSON.parse(body);
      if (typeof parsed.hook_event_name === "string" && KNOWN_EVENTS.has(parsed.hook_event_name)) {
        event = parsed.hook_event_name;
      }
      if (typeof parsed.session_id === "string") session = `${parsed.session_id.length} chars`;
    } catch {
      // Preserve the probe's request-count evidence without retaining raw input.
    }
    const headers = Object.fromEntries(
      Object.entries(req.headers).map(([name, value]) => [
        name,
        Array.isArray(value) ? value.map(describeHeaderValue) : typeof value === "string" ? describeHeaderValue(value) : value,
      ]),
    );
    logRequest({
      ts: new Date().toISOString(),
      method: ["GET", "POST", "PUT", "DELETE", "PATCH", "OPTIONS", "HEAD"].includes(req.method ?? "") ? req.method : "OTHER",
      url: /^\/v1\/hook\/[A-Za-z]+$/.test(new URL(req.url ?? "/", "http://127.0.0.1").pathname)
        ? new URL(req.url ?? "/", "http://127.0.0.1").pathname
        : "(other path)",
      event,
      session,
      headers,
      body_bytes: bodyBytes,
      answered: mode,
    });

    switch (mode) {
      case "empty":
        res.writeHead(200).end();
        break;
      case "text":
        res.writeHead(200, { "content-type": "text/plain" }).end("not json");
        break;
      case "status500":
        res.writeHead(500).end();
        break;
      default:
        res.writeHead(200, { "content-type": "application/json" }).end("{}");
    }
  });
});

server.on("error", (error) => {
  process.stderr.write(`spike listener failed: ${error.message}\n`);
  closeLog();
  process.exitCode = 1;
});
server.on("close", () => {
  clearTimeout(shutdownTimer);
  closeLog();
});

function stopListener() {
  if (!server.listening) {
    closeLog();
    return;
  }
  server.close();
  shutdownTimer = setTimeout(() => server.closeAllConnections(), 1_000);
  shutdownTimer.unref();
}

process.once("SIGINT", stopListener);
process.once("SIGTERM", stopListener);

server.listen(port, "127.0.0.1", () => {
  const address = server.address();
  const actualPort = typeof address === "object" && address !== null ? address.port : port;
  process.stderr.write(
    `spike listener on http://127.0.0.1:${actualPort} answering "${mode}", logging privately to ${log}\n`,
  );
});
