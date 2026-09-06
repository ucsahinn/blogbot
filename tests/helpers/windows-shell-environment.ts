import { tmpdir } from "node:os";
import { win32 } from "node:path";

export function windowsShellEnvironment(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  // Stripping the Windows startup context makes PowerShell 5.1 take tens of
  // seconds to initialize on hosted runners. Keep only known OS/shell keys:
  // no GitHub, signing, provider or arbitrary application environment values.
  const startup: NodeJS.ProcessEnv = {};
  for (const key of [
    "SystemDrive", "ComSpec", "PATH", "PATHEXT", "ProgramFiles", "ProgramFiles(x86)",
    "ProgramW6432", "ProgramData", "PUBLIC", "USERPROFILE", "HOMEDRIVE", "HOMEPATH",
    "APPDATA", "LOCALAPPDATA", "USERNAME", "USERDOMAIN", "COMPUTERNAME", "LOGONSERVER",
    "PROCESSOR_ARCHITECTURE", "PROCESSOR_IDENTIFIER", "PROCESSOR_LEVEL", "PROCESSOR_REVISION",
    "NUMBER_OF_PROCESSORS", "OS"
  ]) {
    if (source[key] !== undefined) startup[key] = source[key];
  }
  return {
    ...startup,
    SystemRoot: source.SystemRoot ?? "C:\\Windows",
    WINDIR: source.WINDIR ?? "C:\\Windows",
    // These fixtures launch Windows PowerShell 5.1, not the parent CI pwsh.
    // Core's module path can hide 5.1 script commands such as Get-FileHash.
    PSModulePath: win32.join(source.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "Modules"),
    TEMP: tmpdir(),
    TMP: tmpdir()
  };
}
