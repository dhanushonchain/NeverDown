import assert from "node:assert/strict";
import { it } from "node:test";
import { workerLaunchSpec } from "../src/payment-worker/client.js";

it("runs compiled payment worker without a development-only tsx loader", () => {
  assert.deepEqual(workerLaunchSpec("file:///pkg/dist/payment-worker/client.js"), {
    entryPath: "/pkg/dist/payment-worker/worker.js",
    execArgv: [],
  });
  assert.deepEqual(workerLaunchSpec("file:///pkg/src/payment-worker/client.ts"), {
    entryPath: "/pkg/src/payment-worker/worker.ts",
    execArgv: ["--import", "tsx"],
  });
});
