import assert from "node:assert/strict";
import test from "node:test";
import { windowsShellEnvironment, windowsShellExecutable } from "../helpers/windows-shell-environment.ts";

test("Windows shell fixtures retain OS startup context without inheriting application credentials", () => {
  const environment = windowsShellEnvironment({
    SystemRoot: "C:\\Windows", WINDIR: "C:\\Windows", SystemDrive: "C:",
    USERPROFILE: "C:\\Users\\fixture", HOMEDRIVE: "C:", HOMEPATH: "\\Users\\fixture",
    APPDATA: "C:\\Users\\fixture\\AppData\\Roaming", LOCALAPPDATA: "C:\\Users\\fixture\\AppData\\Local",
    ComSpec: "C:\\Windows\\System32\\cmd.exe", PATH: "C:\\Windows\\System32", PATHEXT: ".EXE;.CMD",
    PSModulePath: "C:\\Program Files\\PowerShell\\7\\Modules",
    GH_TOKEN: "synthetic-must-not-pass", OPE_WINDOWS_CERTIFICATE_PASSWORD: "synthetic-must-not-pass",
    OPE_UPDATE_SIGNER_SHA256: "synthetic-must-not-pass", NODE_OPTIONS: "synthetic-must-not-pass",
    ARBITRARY_APPLICATION_SETTING: "synthetic-must-not-pass"
  });
  assert.equal(environment.USERPROFILE, "C:\\Users\\fixture");
  assert.equal(environment.HOMEDRIVE, "C:");
  assert.equal(environment.HOMEPATH, "\\Users\\fixture");
  assert.equal(environment.PATH, "C:\\Windows\\System32");
  assert.equal(environment.PSModulePath, "C:\\Program Files\\PowerShell\\7\\Modules");
  assert.equal(environment.ComSpec, "C:\\Windows\\System32\\cmd.exe");
  assert.equal(Object.values(environment).includes("synthetic-must-not-pass"), false);
});

test("release fixtures prefer the workflow PowerShell runtime with a Windows inbox fallback", () => {
  assert.equal(windowsShellExecutable({}, () => true), "C:\\Program Files\\PowerShell\\7\\pwsh.exe");
  assert.equal(windowsShellExecutable({}, () => false), "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe");
});
