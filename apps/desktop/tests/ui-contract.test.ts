import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import type * as TypeScript from "typescript";

const desktopRoot = fileURLToPath(new URL("..", import.meta.url));
const source = (...parts: string[]) => join(desktopRoot, "src", ...parts);
const require = createRequire(import.meta.url);
const typescript = require("typescript") as typeof TypeScript;

test("desktop boot and fatal states expose truthful assistive-technology status", async () => {
  const app = await readFile(source("App.tsx"), "utf8");

  assert.match(app, /className="boot-state"\s+aria-busy="true"/u);
  assert.match(app, /<h1>Blogbot güvenli çalışma alanı hazırlanıyor<\/h1>/u);
  assert.match(app, /aria-live="polite"/u);
  assert.match(app, /aria-busy="true"/u);
  assert.match(app, /className="fatal-state">\s*<div role="alert"/u);
});

test("setup center opens focused tasks and keeps the first-start wizard sequential", async () => {
  const app = await readFile(source("App.tsx"), "utf8");
  const setup = await readFile(source("screens", "SetupCenter.tsx"), "utf8");

  assert.match(app, /activePage === "setup" \|\| activePage === "setup-guide"/u);
  assert.match(app, /startInGuide=\{activePage === "setup-guide"\}/u);
  assert.match(setup, /startInGuide \? "first-start" : "overview"/u);
  assert.match(setup, /setSelectedTask\(startInGuide \? "first-start" : "overview"\)/u);
  assert.match(setup, /const guidedMode = selectedTask === "first-start"/u);
  assert.match(setup, /Ne yapmak istiyorsunuz\?/u);
  assert.match(setup, /disabled=\{index > guidedStep\}/u);
  assert.match(setup, /function formatFolderPath/u);
  assert.match(setup, /Klasörü doğrula ve sonraki adıma geç/u);
  assert.match(setup, /useState<boolean \| null>\(null\)/u);
  assert.match(setup, /bridge\.getAutostartStatus\(\)/u);
});

test("background synchronization exposes failures without creating an unhandled rejection", async () => {
  const app = await readFile(source("App.tsx"), "utf8");
  const shell = await readFile(source("components", "AppShell.tsx"), "utf8");

  assert.match(app, /const \[syncError, setSyncError\]/u);
  assert.match(app, /\.catch\(\(reason\) =>/u);
  assert.match(app, /syncError=\{syncError\}/u);
  assert.match(shell, /syncError\?: string/u);
  assert.match(shell, /role="status" aria-live="polite"/u);
});

test("collapsed and mobile navigation retain names and setup/settings entry points", async () => {
  const shell = await readFile(source("components", "AppShell.tsx"), "utf8");
  assert.match(shell, /aria-label=\{item\.label\}/u);
  assert.match(shell, /className="mobile-utility-nav"/u);
  assert.match(shell, /aria-label="Ayarlar"/u);
  assert.match(shell, /aria-label="Kurulum ve önkoşullar"/u);
});

test("about control exposes the verified project identity and GitHub source", async () => {
  const shell = await readFile(source("components", "AppShell.tsx"), "utf8");

  assert.match(shell, /aria-label="Blogbot hakkında"/u);
  assert.match(shell, /aria-expanded=\{aboutOpen\}/u);
  assert.match(shell, /https:\/\/github\.com\/ucsahinn\/blogbot/u);
  assert.match(shell, /target="_blank"/u);
  assert.match(shell, /rel="noreferrer"/u);
  assert.match(shell, /@ucsahinn/u);
  assert.match(shell, /checkUnsignedUpdate/u);
  assert.match(shell, /installUnsignedUpdate/u);
  assert.match(shell, /Güncellemeleri denetle/u);
  assert.match(shell, /indir ve kur/u);
  assert.doesNotMatch(shell, /downloadAndInstall/u);
  assert.doesNotMatch(shell, /dangerousInsecureTransportProtocol/u);
});

test("mobile fixed navigation cannot obscure focus and form focus remains visible", async () => {
  const styles = await readFile(source("styles.css"), "utf8");
  assert.match(styles, /\.field input:focus-visible[\s\S]*?outline:\s*3px solid/u);
  assert.match(styles, /@media \(max-width: 700px\)[\s\S]*?\.workspace\s*\{[\s\S]*?padding-bottom:\s*(?:8[4-9]|9\d|\d{3,})px/u);
});

test("focus indicators use an opaque semantic color with sufficient contrast", async () => {
  const styles = await readFile(source("styles.css"), "utf8");

  assert.match(styles, /--ink-faint:\s*#405056/u);
  assert.match(styles, /--accent:\s*#a93618/u);
  assert.match(styles, /\.workspace small\s*\{[\s\S]*?font-size:\s*12px !important/u);
  assert.match(styles, /button:focus-visible[\s\S]*?outline:\s*3px solid var\(--blue\)/u);
  assert.match(styles, /\.field input:focus-visible[\s\S]*?outline:\s*3px solid var\(--blue\)/u);
});

test("compact desktop turns the editable weekly calendar into an operable grid instead of a horizontal strip", async () => {
  const styles = await readFile(source("styles.css"), "utf8");

  assert.match(
    styles,
    /@media \(max-width: 1100px\)[\s\S]*?\.week-grid\s*\{[\s\S]*?grid-template-columns:\s*repeat\(2, minmax\(0, 1fr\)\)[\s\S]*?overflow-x:\s*visible/u
  );
});

test("candidate triage uses dense comparable rows and falls back cleanly on narrow screens", async () => {
  const styles = await readFile(source("styles.css"), "utf8");

  assert.match(styles, /\.candidate-grid\s*\{[\s\S]*?grid-template-columns:\s*1fr/u);
  assert.match(styles, /\.candidate-card\s*\{[\s\S]*?grid-template-areas:/u);
  assert.match(styles, /@media \(max-width: 700px\)[\s\S]*?\.candidate-card\s*\{[\s\S]*?grid-template-columns:\s*1fr/u);
});

test("source flow explains one simple editorial path instead of treating checks as user gates", async () => {
  const sourceCenter = await readFile(source("screens", "SourceCenter.tsx"), "utf8");
  const flow = await readFile(source("screens", "ContentFlow.tsx"), "utf8");

  assert.match(sourceCenter, /Kaynak ekle[\s\S]*?Tara[\s\S]*?Taslak hazırla[\s\S]*?İncele ve onayla/u);
  assert.match(flow, /Taslak hazırla/u);
  assert.match(flow, /Yayın yalnızca hazır taslağı inceledikten sonra başlar/u);
});

test("Codex operations distinguishes measured local work from unavailable token and quota data", async () => {
  const operations = await readFile(source("screens", "OperationsHub.tsx"), "utf8");

  assert.match(operations, /props\.connectorState\.config\.codex\.accountLabel/u);
  assert.match(operations, /YEREL GÖREV GÖRÜNÜMÜ/u);
  assert.match(operations, /Token ve kota ölçümü yok/u);
  assert.match(operations, /Sadece kalıcı yerel iş kaydından türetilen veriler gösterilir/u);
});

test("local materialization never reuses a publication preview from another revision", async () => {
  const review = await readFile(source("screens", "ReviewWorkspace.tsx"), "utf8");

  assert.match(review, /const \[lastPreview, setLastPreview\] = useState<\{ revisionId: string; hash: string \} \| null>\(null\)/u);
  assert.match(review, /setLastPreview\(null\);[\s\S]*?setSelectedId\(revisionId\)/u);
  assert.match(review, /lastPreview\?\.revisionId === revision\.id \? lastPreview\.hash : ""/u);
});

test("setup keeps unrelated controls hidden until the user selects their task", async () => {
  const setup = await readFile(source("screens", "SetupCenter.tsx"), "utf8");

  assert.match(setup, /selectedTask === "overview" \?/u);
  assert.match(setup, /selectedTask !== "overview" && selectedTask !== "first-start"/u);
  assert.match(setup, /selectedTask === "diagnostics" \? "Canlı teknik durum"/u);
  assert.match(setup, /selectedTask === "writing"[\s\S]*?connector\.id === "codex"/u);
  assert.doesNotMatch(setup, /Teknik kontroller ve ayrıntılı ayarlar/u);
});

test("main WebView exposes only native-granted filesystem actions and keeps credentials and logs denied", async () => {
  const permissions = await readFile(
    join(desktopRoot, "src-tauri", "permissions", "default.toml"),
    "utf8"
  );
  for (const forbidden of [
    "allow-get-local-dev-logs",
    "allow-github-device-flow-start"
  ]) {
    assert.doesNotMatch(permissions, new RegExp(`\\b${forbidden}\\b`, "u"));
  }
  for (const granted of [
    "allow-start-local-dev",
    "allow-stop-local-dev",
    "allow-backup-create",
    "allow-backup-verify",
    "allow-backup-restore-preview",
    "allow-backup-restore-apply",
    "allow-github-device-flow-status"
  ]) {
    assert.match(permissions, new RegExp(`\\b${granted}\\b`, "u"));
  }

  const commands = await readFile(join(desktopRoot, "src-tauri", "src", "commands.rs"), "utf8");
  assert.match(commands, /require_granted_directory/u);
  assert.match(commands, /require_granted_existing_file/u);
  assert.match(commands, /require_granted_output_file/u);
});

test("every production bridge command is registered by Tauri and explicitly permitted to the main window", async () => {
  const bridge = await readFile(source("bridge.ts"), "utf8");
  const nativeApp = await readFile(join(desktopRoot, "src-tauri", "src", "lib.rs"), "utf8");
  const permissions = await readFile(join(desktopRoot, "src-tauri", "permissions", "default.toml"), "utf8");

  const bridgeCommands = [...bridge.matchAll(/(?:read|mutate)\("([a-z_]+)"/gu)]
    .map((match) => match[1]!)
    .filter((command, index, all) => all.indexOf(command) === index)
    .sort();
  const registeredHandlers = new Set(
    [...nativeApp.matchAll(/commands::([a-z_]+)/gu)].map((match) => match[1]!)
  );
  const allowedCommands = new Set(
    [...permissions.matchAll(/allow-([a-z-]+)/gu)].map((match) => match[1]!.replaceAll("-", "_"))
  );

  assert.ok(bridgeCommands.length >= 45, "bridge command surface unexpectedly shrank");
  assert.deepEqual(
    bridgeCommands.filter((command) => !registeredHandlers.has(command)),
    [],
    "a WebView action must not invoke an unregistered native command"
  );
  assert.deepEqual(
    bridgeCommands.filter((command) => !allowedCommands.has(command)),
    [],
    "a registered command must also be explicitly permitted to the main window"
  );
});

test("production buttons always have an explicit action or form submission behavior", async () => {
  const interactiveFiles = [
    "components/AppShell.tsx",
    "components/tab-keyboard.ts",
    "screens/ContentFlow.tsx",
    "screens/Dashboard.tsx",
    "screens/EditorialDesk.tsx",
    "screens/InstantCreate.tsx",
    "screens/Operations.tsx",
    "screens/OperationsHub.tsx",
    "screens/PublishingCenter.tsx",
    "screens/ReviewWorkspace.tsx",
    "screens/SettingsCenter.tsx",
    "screens/SetupCenter.tsx",
    "screens/SourceCenter.tsx"
  ];
  const missing: Array<{ file: string; line: number }> = [];
  let buttonCount = 0;

  for (const file of interactiveFiles) {
    const contents = await readFile(source(...file.split("/")), "utf8");
    const tree = typescript.createSourceFile(file, contents, typescript.ScriptTarget.Latest, true, typescript.ScriptKind.TSX);
    const visit = (node: TypeScript.Node): void => {
      if (typescript.isJsxOpeningElement(node) && node.tagName.getText(tree) === "button") {
        buttonCount += 1;
        const attributes = node.attributes.properties.filter(typescript.isJsxAttribute);
        const names = new Set(attributes.map((attribute) => attribute.name.getText(tree)));
        const type = attributes.find((attribute) => attribute.name.getText(tree) === "type");
        const isSubmit = type?.initializer?.getText(tree).replace(/[{}"']/gu, "") === "submit";
        if (!names.has("onClick") && !isSubmit) {
          missing.push({ file, line: tree.getLineAndCharacterOfPosition(node.getStart(tree)).line + 1 });
        }
      }
      typescript.forEachChild(node, visit);
    };
    visit(tree);
  }

  assert.ok(buttonCount >= 100, "interactive production surface unexpectedly shrank");
  assert.deepEqual(missing, []);
});

test("Operations exposes a real retry action for a blocked active draft", async () => {
  const contents = await readFile(source("screens", "OperationsHub.tsx"), "utf8");
  assert.match(contents, /draft\.blockers > 0/u);
  assert.match(contents, /onClick=\{\(\) => void retry\(draft\.id\)\}/u);
  assert.match(contents, /Tekrar dene/u);
});
