import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { printViaUSB, sanitizePowerShellStderr, classifyPrintFailure } from "../main/printers/thermal";

function runTests(): void {
  // 1. Plain stderr without CLIXML
  assert.equal(sanitizePowerShellStderr("Printer is offline"), "Printer is offline");
  assert.equal(sanitizePowerShellStderr(""), "");
  assert.equal(sanitizePowerShellStderr(undefined), "");

  // 2. Standard PowerShell CLIXML with single error
  const clixmlSingle = [
    "#< CLIXML",
    "<Objs Version=\"1.1.0.1\" xmlns=\"http://schemas.microsoft.com/powershell/2004/04\">",
    "  <S S=\"Error\">The RPC server is unavailable._x000D__x000A_</S>",
    "  <S S=\"Error\">At line:1 char:1_x000D__x000A_</S>",
    "  <S S=\"Error\">+ [WINSPOOL]::PrintRawFile(\$name, \$file)_x000D__x000A_</S>",
    "</Objs>",
  ].join("\r\n");

  assert.equal(sanitizePowerShellStderr(clixmlSingle), "The RPC server is unavailable.");

  // 3. CLIXML with XML entities and quotes
  const clixmlEntities = [
    "#< CLIXML",
    "<Objs Version=\"1.1.0.1\" xmlns=\"http://schemas.microsoft.com/powershell/2004/04\">",
    "  <S S=\"Error\">Exception calling &quot;OpenPrinter&quot; with &quot;3&quot; argument(s): &quot;The printer name is invalid&quot;_x000D__x000A_</S>",
    "  <S S=\"Error\">At line:1 char:1_x000D__x000A_</S>",
    "</Objs>",
  ].join("\r\n");

  assert.equal(
    sanitizePowerShellStderr(clixmlEntities),
    "Exception calling \"OpenPrinter\" with \"3\" argument(s): \"The printer name is invalid\"",
  );

  // 4. CLIXML with multiple meaningful error lines
  const clixmlMulti = [
    "#< CLIXML",
    "<Objs Version=\"1.1.0.1\" xmlns=\"http://schemas.microsoft.com/powershell/2004/04\">",
    "  <S S=\"Error\">Printer spooler service stopped._x000D__x000A_</S>",
    "  <S S=\"Error\">Cannot communicate with spooler daemon._x000D__x000A_</S>",
    "  <S S=\"Error\">At line:1 char:1_x000D__x000A_</S>",
    "</Objs>",
  ].join("\r\n");

  assert.equal(
    sanitizePowerShellStderr(clixmlMulti),
    "Printer spooler service stopped.\nCannot communicate with spooler daemon.",
  );

  // 5. Fallback when no <S S="Error"> blocks match (strips CLIXML header and decodes escapes)
  const malformedClixml = '#< CLIXML\r\nSome unexpected error message_x000D__x000A_';
  assert.equal(sanitizePowerShellStderr(malformedClixml), 'Some unexpected error message');

  // 5b. Real ticket #885: engine-level progress-record CLIXML from `Add-Type`
  // module auto-loading, with no leading "#< CLIXML" marker, appended after
  // the real plain-text exception message. Must keep only the first line.
  const progressNoise = [
    'Exception calling "SendRaw" with "2" argument(s): "printer is set to \'Use Printer Offline\' in Windows"',
    '<Objs Version="1.1.0.1" xmlns="http://schemas.microsoft.com/powershell/2004/04">'
      + '<Obj S="progress" RefId="0"><TN RefId="0"><T>System.Management.Automation.PSCustomObject</T>'
      + '<T>System.Object</T></TN><MS><I64 N="SourceId">1</I64><PR N="Record">'
      + '<AV>Preparing modules for first use.</AV><AI>0</AI><Nil /><PI>-1</PI><PC>-1</PC>'
      + '<T>Completed</T><SR>-1</SR><SD> </SD></PR></MS></Obj>'
      + '<Obj S="progress" RefId="1"><TNRef RefId="0" /><MS><I64 N="SourceId">2</I64><PR N="Record">'
      + '<AV>Preparing modules for first use.</AV><AI>0</AI><Nil /><PI>-1</PI><PC>-1</PC>'
      + '<T>Completed</T><SR>-1</SR><SD> </SD></PR></MS></Obj></Objs>',
  ].join('\n');
  assert.equal(
    sanitizePowerShellStderr(progressNoise),
    'Exception calling "SendRaw" with "2" argument(s): "printer is set to \'Use Printer Offline\' in Windows"',
  );

  // 6. classifyPrintFailure handles CLIXML-wrapped errors correctly
  assert.equal(classifyPrintFailure(clixmlSingle), "unknown");
  const clixmlOffline = "#< CLIXML\r\n<Objs Version=\"1.1.0.1\"><S S=\"Error\">Printer device is offline_x000D__x000A_</S></Objs>";
  assert.equal(classifyPrintFailure(clixmlOffline), "offline");

  const clixmlSpooler = "#< CLIXML\r\n<Objs Version=\"1.1.0.1\"><S S=\"Error\">StartDocPrinter failed for job_x000D__x000A_</S></Objs>";
  assert.equal(classifyPrintFailure(clixmlSpooler), "spooler_error");

  const clixmlTimeout = "#< CLIXML\r\n<Objs Version=\"1.1.0.1\"><S S=\"Error\">Operation timed out after 20s_x000D__x000A_</S></Objs>";
  assert.equal(classifyPrintFailure(clixmlTimeout), "timeout");

  console.log("✓ All Windows PowerShell stderr sanitization tests passed.");
}

/**
 * Issue #790: PowerShell diagnostics must survive the subprocess byte boundary.
 *
 * Windows PowerShell 5.1 encodes redirected stdout/stderr with the console/OEM
 * code page, so the helpers force UTF-8 for both streams and FloCafe decodes
 * UTF-8. These cases drive the real `printViaUSB()` transport through a stub
 * `powershell` that writes exact bytes to stderr, so a pre-decoded JavaScript
 * string is never the thing under test.
 */
const REPLACEMENT_CHARACTER = "\uFFFD";
const DUMP_ENV = "FLO_FAKE_PS_DUMP";
const PAYLOAD_ENV = "FLO_FAKE_PS_STDERR_PAYLOAD";

const STUB_POWERSHELL = `#!/bin/sh
if [ -n "$FLO_FAKE_PS_STDERR_PAYLOAD" ]; then
  cat "$FLO_FAKE_PS_STDERR_PAYLOAD" >&2
  exit 1
fi
if [ -n "$FLO_FAKE_PS_DUMP" ]; then
  printf '%s' "$4" > "$FLO_FAKE_PS_DUMP"
  exit 1
fi
exit 1
`;

let stubDir = "";
let fixtureDir = "";
let originalPath = "";
let originalPlatform = "";
let payloadSequence = 0;

function setPlatform(platform: string): void {
  Object.defineProperty(process, "platform", { value: platform, configurable: true });
}

/** Runs the Windows raw-print transport with `stderrBytes` written verbatim. */
async function dispatchWithStderr(stderrBytes: Buffer): Promise<{ ok: boolean; detail?: string; failureClass?: string }> {
  const payloadPath = path.join(fixtureDir, `stderr-${payloadSequence++}.bin`);
  fs.writeFileSync(payloadPath, stderrBytes);
  process.env[PAYLOAD_ENV] = payloadPath;
  process.env.PATH = `${stubDir}${path.delimiter}${originalPath}`;
  try {
    return await printViaUSB(Buffer.from("FLO-RAW-PRINT-PAYLOAD"), "Fake Printer");
  } finally {
    delete process.env[PAYLOAD_ENV];
  }
}

function clixmlErrorRecord(text: string): Buffer {
  return Buffer.from(
    `#< CLIXML\r\n<Objs Version="1.1.0.1" xmlns="http://schemas.microsoft.com/powershell/2004/04">\r\n`
    + `  <S S="Error">${text}_x000D__x000A_</S>\r\n  <S S="Error">At line:1 char:1_x000D__x000A_</S>\r\n</Objs>\r\n`,
    "utf8",
  );
}

async function runEncodingRegression(): Promise<void> {
  originalPlatform = process.platform;
  originalPath = process.env.PATH || "";

  // On native Windows hosts, child_process.execFile('powershell') resolves
  // against PATHEXT (.exe) and cannot execute an extensionless POSIX shell script.
  // The subprocess transport cases below run on POSIX hosts with a mocked
  // process.platform = 'win32'.
  if (originalPlatform === "win32") {
    console.log("✓ Windows PowerShell stderr encoding tests skipped on native win32 (POSIX stub mode).");
    return;
  }

  try {
    stubDir = fs.mkdtempSync(path.join(os.tmpdir(), "flo-utf8-powershell-"));
    fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), "flo-utf8-fixtures-"));
    fs.writeFileSync(path.join(stubDir, "powershell"), STUB_POWERSHELL, { mode: 0o755 });
    setPlatform("win32");

    // 1. Accented Spanish and Portuguese diagnostics written as UTF-8 bytes
    //    reach the printer detail unchanged.
    const spanish = "Excepción al llamar a SendRaw: no se puede acceder a la impresora";
    const spanishResult = await dispatchWithStderr(Buffer.from(spanish, "utf8"));
    assert.equal(spanishResult.detail, spanish, "accented Spanish stderr survives the byte boundary");
    assert.ok(!spanishResult.detail.includes(REPLACEMENT_CHARACTER), "no replacement character for Spanish stderr");

    const portuguese = "Não foi possível concluir a impressão: verifique o modo economizado";
    const portugueseResult = await dispatchWithStderr(Buffer.from(portuguese, "utf8"));
    assert.equal(portugueseResult.detail, portuguese, "accented Portuguese stderr survives the byte boundary");
    assert.notEqual(portugueseResult.detail, portuguese.replace(/[ãíç]/g, "?"), "accents are not replaced by question marks");

    // 2. The same bytes inside CLIXML framing keep their accents after the
    //    existing framing cleanup, including _xNNNN_ escapes.
    const clixmlResult = await dispatchWithStderr(clixmlErrorRecord("Excepción al llamar a SendRaw"));
    assert.equal(clixmlResult.detail, "Excepción al llamar a SendRaw");
    const clixmlEscaped = await dispatchWithStderr(clixmlErrorRecord("La impresora perdió el trabajo"));
    assert.equal(clixmlEscaped.detail, "La impresora perdió el trabajo", "literal accented text inside CLIXML is preserved");

    // 3. English diagnostics and their classification are unchanged.
    const englishResult = await dispatchWithStderr(Buffer.from("Printer is offline\n", "utf8"));
    assert.equal(englishResult.detail, "Printer is offline");
    assert.equal(englishResult.failureClass, "offline", "English classification still applies");

    // 4. Why the helper has to emit UTF-8: legacy single-byte bytes (0xF3 for
    //    Spanish 'ó') cannot be recovered by a UTF-8 decode, so the corruption
    //    seen in the reports is irreversible once it reaches this boundary.
    const oemBytes = Buffer.from("Excepción", "latin1");
    assert.ok(oemBytes.includes(0xf3), "the OEM fixture really is a single-byte encoding");
    const oemResult = await dispatchWithStderr(oemBytes);
    assert.ok(
      oemResult.detail.includes(REPLACEMENT_CHARACTER),
      "console-code-page bytes decode lossily, which is why the helper must emit UTF-8",
    );

    // 5. The command FloCafe actually sends carries the UTF-8 stream contract
    //    for both stdout and stderr before the helper body runs.
    const dumpPath = path.join(fixtureDir, "command.txt");
    process.env[DUMP_ENV] = dumpPath;
    try {
      process.env.PATH = `${stubDir}${path.delimiter}${originalPath}`;
      await printViaUSB(Buffer.from("FLO-RAW-PRINT-PAYLOAD"), "Fake Printer");
    } finally {
      delete process.env[DUMP_ENV];
    }
    const encodedCommand = fs.readFileSync(dumpPath, "utf8");
    const helperScript = Buffer.from(encodedCommand, "base64").toString("utf16le");
    assert.ok(helperScript.includes("UTF8Encoding"), "the helper switches its writers to UTF-8");
    assert.ok(helperScript.includes("[Console]::SetOut"), "stdout is explicitly UTF-8");
    assert.ok(helperScript.includes("[Console]::SetError"), "stderr is explicitly UTF-8");
    assert.ok(
      helperScript.indexOf("[Console]::SetError") < helperScript.indexOf("$env:FLO_PRINTER_NAME"),
      "the stream contract is applied before the helper reads its inputs",
    );
    assert.ok(!helperScript.includes("\uFFFD"), "the transmitted helper script is clean ASCII");

    console.log("✓ All Windows PowerShell stderr encoding tests passed.");
  } finally {
    delete process.env[PAYLOAD_ENV];
    delete process.env[DUMP_ENV];
    process.env.PATH = originalPath;
    setPlatform(originalPlatform);
    if (stubDir) fs.rmSync(stubDir, { recursive: true, force: true });
    if (fixtureDir) fs.rmSync(fixtureDir, { recursive: true, force: true });
  }
}

runTests();
runEncodingRegression().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
