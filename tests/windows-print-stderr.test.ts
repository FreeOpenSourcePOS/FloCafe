import assert from "node:assert/strict";
import { sanitizePowerShellStderr, classifyPrintFailure } from "../main/printers/thermal";

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

runTests();
