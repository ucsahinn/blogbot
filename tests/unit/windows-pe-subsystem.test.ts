import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  WINDOWS_CONSOLE_SUBSYSTEM,
  assertWindowsConsoleSubsystem,
  readWindowsPeSubsystem
} from "../../scripts/windows-pe-subsystem.mjs";

function minimalPortableExecutable(subsystem = 3): Buffer {
  const image = Buffer.alloc(0x100);
  image.write("MZ", 0, "ascii");
  image.writeUInt32LE(0x80, 0x3c);
  image.write("PE\0\0", 0x80, "ascii");
  image.writeUInt16LE(0xf0, 0x80 + 4 + 16);
  image.writeUInt16LE(0x20b, 0x98);
  image.writeUInt16LE(subsystem, 0x98 + 68);
  return image;
}

test("packaged Windows sidecars retain the console subsystem for no-window launches", () => {
  const image = minimalPortableExecutable();

  assert.equal(readWindowsPeSubsystem(image), WINDOWS_CONSOLE_SUBSYSTEM);
  assert.doesNotThrow(() => assertWindowsConsoleSubsystem(image));
  assert.throws(() => assertWindowsConsoleSubsystem(minimalPortableExecutable(2)), /PE_SUBSYSTEM_NOT_CONSOLE/u);
});

test("PE subsystem helpers reject malformed input instead of patching arbitrary bytes", () => {
  assert.throws(() => readWindowsPeSubsystem(Buffer.from("not a PE")), /PE_/u);
  assert.throws(() => assertWindowsConsoleSubsystem(Buffer.from("not a PE")), /PE_/u);
});

test("desktop entrypoint opts out of the Windows console subsystem", async () => {
  const source = await readFile(
    new URL("../../apps/desktop/src-tauri/src/main.rs", import.meta.url),
    "utf8"
  );

  assert.match(
    source,
    /cfg_attr\(windows,\s*windows_subsystem\s*=\s*"windows"\)/u
  );
});

test("sidecar build never converts helpers into feedback-cursor GUI processes", async () => {
  const build = await readFile(
    new URL("../../scripts/build-engine-sidecar.mjs", import.meta.url),
    "utf8"
  );

  assert.doesNotMatch(build, /setWindowsGuiSubsystem/u);
  assert.match(build, /assertWindowsConsoleSubsystem\(fetcherSidecarImage\)/u);
  assert.match(build, /assertWindowsConsoleSubsystem\(sidecarImage\)/u);
});
