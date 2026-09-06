import assert from "node:assert/strict";
import path from "node:path";
import moduleApi from "node:module";

function loadFrontendWarnings(): typeof import("../frontend/src/lib/printer/warnings") {
  const mod = moduleApi as unknown as { _resolveFilename: (...args: any[]) => string };
  const originalResolveFilename = mod._resolveFilename;
  mod._resolveFilename = function (request: string, parent: any, isMain: boolean, options?: any) {
    const resolvedRequest = request.startsWith("@print/")
      ? path.resolve(__dirname, "../shared/print", request.slice("@print/".length))
      : request.startsWith("@/")
        ? path.resolve(__dirname, "../frontend/src", request.slice("@/".length))
        : request;
    return originalResolveFilename.call(this, resolvedRequest, parent, isMain, options);
  };
  try {
    return require("../frontend/src/lib/printer/warnings");
  } finally {
    mod._resolveFilename = originalResolveFilename;
  }
}

const { formatReceiptErrorToast, formatKotErrorToast } = loadFrontendWarnings();

function runTests(): void {
  // 1. Receipt formatting: financial refusal is passed as-is without double-wrapping
  const financialMsg = "Receipt not printed: a financial row contains unsupported printer text: €5.00";
  assert.equal(
    formatReceiptErrorToast(financialMsg, "Receipt print failed"),
    financialMsg,
  );

  // 2. Receipt formatting: specific operational detail is appended with context
  const timeoutMsg = "Timed out connecting to 192.168.1.100:9100";
  assert.equal(
    formatReceiptErrorToast(timeoutMsg, "Receipt print failed"),
    "Receipt print failed (Timed out connecting to 192.168.1.100:9100)",
  );

  // 3. Receipt formatting: generic messages fall back cleanly without empty parentheses
  assert.equal(formatReceiptErrorToast("print failed", "Receipt print failed"), "Receipt print failed");
  assert.equal(formatReceiptErrorToast("Print failed", "Receipt print failed"), "Receipt print failed");
  assert.equal(formatReceiptErrorToast("", "Receipt print failed"), "Receipt print failed");
  assert.equal(formatReceiptErrorToast(undefined, "Receipt print failed"), "Receipt print failed");

  // 4. KOT formatting: operational detail is appended
  assert.equal(
    formatKotErrorToast("Spooler service paused", "KOT print failed"),
    "KOT print failed: Spooler service paused",
  );

  // 5. KOT formatting: generic messages fall back cleanly
  assert.equal(formatKotErrorToast("print failed", "KOT print failed"), "KOT print failed");
  assert.equal(formatKotErrorToast("KOT print failed", "KOT print failed"), "KOT print failed");
  assert.equal(formatKotErrorToast("", "KOT print failed"), "KOT print failed");
  assert.equal(formatKotErrorToast(undefined, "KOT print failed"), "KOT print failed");

  console.log("✓ All printer error toast clarity tests passed.");
}

runTests();
