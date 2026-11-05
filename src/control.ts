#!/usr/bin/env node
/** Deterministic, model-independent administrative switch CLI. */
import { main } from "./hooks/main.js";

await main([process.argv[0] ?? "node", process.argv[1] ?? "jev-control", "control", ...process.argv.slice(2)]);
