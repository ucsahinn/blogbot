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
  assert.match(app, /<h1>Boby güvenli çalışma alanı hazırlanıyor<\/h1>/u);
  assert.match(app, /aria-live="polite"/u);
  assert.match(app, /aria-busy="true"/u);
  assert.match(app, /className="fatal-state">\s*<div role="alert"/u);
});

test("Boby is a persistent local editor guide with a keyboard-accessible conversation panel", async () => {
  const app = await readFile(source("App.tsx"), "utf8");
  const shell = await readFile(source("components", "AppShell.tsx"), "utf8");
  const assistant = await readFile(source("components", "BobyAssistant.tsx"), "utf8");

  assert.match(app, /BobyAssistant/u);
  assert.match(app, /bridge=\{bridge\}/u);
  assert.match(shell, /onOpenBoby/u);
  assert.match(assistant, /requestBobyGuidance/u);
  assert.match(assistant, /getBobyGuidance/u);
  assert.match(assistant, /describeBobyAvailability/u);
  assert.match(assistant, /Boby isteği başlatılamadı/u);
  assert.match(assistant, /boby-availability/u);
  assert.match(assistant, /Yerel rehber/u);
});

test("Boby keeps one pending direct reply alive without a short false timeout", async () => {
  const assistant = await readFile(source("components", "BobyAssistant.tsx"), "utf8");

  assert.match(assistant, /const \[pendingGuidanceId, setPendingGuidanceId\]/u);
  assert.match(assistant, /if \(!open \|\| !pendingGuidanceId\) return;/u);
  assert.match(assistant, /window\.setTimeout\(resolve, 2_000\)/u);
  assert.match(assistant, /disabled=\{deliveryState === "queued"\}/u);
  assert.doesNotMatch(assistant, /attempt < 12/u);
});

test("Boby status refresh handles a rejected native probe without an unhandled promise", async () => {
  const assistant = await readFile(source("components", "BobyAssistant.tsx"), "utf8");

  assert.match(
    assistant,
    /onClick=\{\(\) => void refreshBobyRuntime\(\)\.catch\(/u,
    "the visible refresh action must consume native probe failures"
  );
});

test("notifications use local feedback sounds without speech synthesis", async () => {
  const settings = await readFile(source("screens", "SettingsCenter.tsx"), "utf8");
  const boby = await readFile(source("components", "BobyAssistant.tsx"), "utf8");

  assert.match(settings, /playFeedbackSound\("notification"\)/u);
  assert.match(boby, /playFeedbackSound\("boby-open"\)/u);
  assert.match(boby, /playFeedbackSound\("boby-reply"\)/u);
  assert.doesNotMatch(boby, /speechSynthesis/u);
});

test("setup center keeps the legacy guide route while opening the focused first-start wizard", async () => {
  const app = await readFile(source("App.tsx"), "utf8");
  const setup = await readFile(source("screens", "SetupCenter.tsx"), "utf8");

  assert.match(app, /activePage === "setup" \|\| activePage === "setup-guide"/u);
  assert.match(app, /startInGuide=\{activePage === "setup-guide"\}/u);
  assert.match(setup, /startInGuide \? "first-start" : "overview"/u);
  assert.match(setup, /setSelectedTask\(startInGuide \? "first-start" : "overview"\)/u);
  assert.match(setup, /const guidedMode = selectedTask === "first-start"/u);
  assert.match(setup, /Ne yapmak istiyorsunuz\?/u);
  assert.match(setup, /function formatFolderPath/u);
  assert.match(setup, /Klasörü test et/u);
});

test("first-start wizard is a non-blocking three-step flow with one semantic status per step", async () => {
  const setup = await readFile(source("screens", "SetupCenter.tsx"), "utf8");

  assert.match(setup, /type GuidedStatus = SetupStatusTone/u);
  assert.match(setup, /title: "Bu bilgisayarı kontrol et"/u);
  assert.match(setup, /title: "Codex'i bağla ve test et"/u);
  assert.match(setup, /title: "Çıktı klasörünü seç, test et ve bitir"/u);
  assert.match(setup, /className=\{`guided-status guided-status-\$\{guidedStepState\(step\)\}`\}/u);
  assert.match(setup, /describePrerequisiteState/u);
  assert.match(setup, /summarizeGuidedStates/u);
  assert.match(setup, /Codex'i şimdilik atla/u);
  assert.match(setup, /guidedMode && guidedStep === 2/u);
  assert.match(setup, /Blogbot’u bu hedefle kullan/u);
  assert.match(setup, /<h2 id="quickstart-title">Çıktı klasörünü seç<\/h2>/u);
  assert.doesNotMatch(setup, /quickstart-modes/u);
  assert.doesNotMatch(setup, /guided-progress-inline-meter/u);
  assert.doesNotMatch(setup, /guided-preferences/u);
  assert.doesNotMatch(setup, /setDeviceName/u);
  assert.doesNotMatch(setup, /setScanIntervalMinutes/u);
  assert.doesNotMatch(setup, /setAutostartEnabled/u);
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

test("offline bootstrap does not start a connector read after Doctor has closed the local engine", async () => {
  const app = await readFile(source("App.tsx"), "utf8");

  assert.match(app, /if \(initialSnapshot\.runtime === "ONLINE"\) \{/u);
  assert.match(app, /void coalescingBridge\.getConnectorState\(\)/u);
  assert.match(app, /nextSnapshot\.runtime === "ONLINE"\s*\? await bridge\.getConnectorState\(\)/u);
});

test("primary navigation preserves five stable workspaces and route focus", async () => {
  const shell = await readFile(source("components", "AppShell.tsx"), "utf8");
  const primaryNavigation = shell.match(/const navigation:[\s\S]*?= \[([\s\S]*?)\n\];/u)?.[1] ?? "";

  assert.equal([...primaryNavigation.matchAll(/\{ id: /gu)].length, 5);
  for (const destination of ["dashboard", "content", "editorial", "publishing", "operations"]) {
    assert.match(primaryNavigation, new RegExp(`id: "${destination}"`, "u"));
  }
  assert.match(shell, /page === "editorial" && activePage === "editorial-review"/u);
  assert.doesNotMatch(shell, /page === "content"[^\n]*editorial-review/u);
  assert.match(shell, /workspace\?\.focus\(\{ preventScroll: true \}\);[\s\S]*?\[activePage\]/u);
});

test("collapsed and mobile navigation retain names and setup/settings entry points", async () => {
  const shell = await readFile(source("components", "AppShell.tsx"), "utf8");
  assert.match(shell, /aria-label=\{item\.label\}/u);
  assert.match(shell, /className="mobile-utility-nav"/u);
  assert.match(shell, /aria-label="Ayarlar"/u);
  assert.match(shell, /aria-label="Kurulum ve önkoşullar"/u);
});

test("Boby uses the dedicated assistant avatar in every persistent entry point", async () => {
  const app = await readFile(source("App.tsx"), "utf8");
  const shell = await readFile(source("components", "AppShell.tsx"), "utf8");
  const assistant = await readFile(source("components", "BobyAssistant.tsx"), "utf8");

  assert.match(app, /import bobyAvatar from "\.\/assets\/boby-avatar-v2\.webp"/u);
  assert.equal(
    [...app.matchAll(/src=\{bobyAvatar\}/gu)].length,
    2,
    "boot and safe-start failure states must not fall back to a letter mark"
  );
  assert.match(shell, /import bobyAvatar from "\.\.\/assets\/boby-avatar-v2\.webp"/u);
  assert.equal(
    [...shell.matchAll(/src=\{bobyAvatar\}/gu)].length,
    3,
    "brand, operator presence, and the floating chat launcher must show the same Boby avatar"
  );
  assert.match(assistant, /import bobyAvatar from "\.\.\/assets\/boby-avatar-v2\.webp"/u);
  assert.match(assistant, /src=\{bobyAvatar\}/u);
});

test("about control exposes the verified project identity and GitHub source", async () => {
  const shell = await readFile(source("components", "AppShell.tsx"), "utf8");

  assert.match(shell, /aria-label="Boby hakkında"/u);
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

test("settings separates saving, reversible changes, and notification diagnostics by intent", async () => {
  const settings = await readFile(source("screens", "SettingsCenter.tsx"), "utf8");

  assert.match(settings, /settings-action-primary/u);
  assert.match(settings, /settings-action-secondary/u);
  assert.match(settings, /settings-action-notification/u);
});

test("editorial drafts keep Boby's unavailable state human instead of exposing its runtime", async () => {
  const desk = await readFile(new URL("../src/screens/EditorialDesk.tsx", import.meta.url), "utf8");

  assert.match(desk, /Boby sohbeti açıldı. Bağlamak için Boby'yi bağla düğmesini kullan./u);
  assert.match(desk, /"Boby'yi bağla"/u);
  assert.match(desk, /onOpenBoby\(\)/u);
  assert.doesNotMatch(desk, /Codex'i bağla/u);
});

test("dashboard exposes one actionable next task before supporting system detail", async () => {
  const dashboard = await readFile(source("screens", "Dashboard.tsx"), "utf8");

  assert.match(dashboard, /primaryToday/u);
  assert.match(dashboard, /dashboard-next-action/u);
  assert.match(dashboard, /ŞİMDİ YAPILACAK/u);
});

test("compact desktop turns the editable weekly calendar into an operable grid instead of a horizontal strip", async () => {
  const [styles, publishing] = await Promise.all([
    readFile(source("styles.css"), "utf8"),
    readFile(source("screens", "PublishingCenter.tsx"), "utf8")
  ]);

  assert.match(
    styles,
    /@media \(max-width: 1100px\)[\s\S]*?\.week-grid\s*\{[\s\S]*?grid-template-columns:\s*repeat\(2, minmax\(0, 1fr\)\)[\s\S]*?overflow-x:\s*visible/u
  );
  assert.match(publishing, /activeSlotId/u);
  assert.match(publishing, /Takvimde bu slotu düzenle/u);
});

test("weekly cadence configures only future NEXT_SLOT drafts and treats legacy article assignments as non-binding", async () => {
  const publishing = await readFile(source("screens", "PublishingCenter.tsx"), "utf8");

  assert.match(publishing, /Yeni taslaklar için NEXT_SLOT ritmi/u);
  assert.match(publishing, /Geçmiş atama:/u);
  assert.match(publishing, /slot\.articleId \|\| slot\.articleTitle/u);
  assert.doesNotMatch(publishing, /Paylaşılacak onaylı post/u);
  assert.doesNotMatch(publishing, /articleId: selectedPost/u);
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
  assert.match(flow, /Araştırmaya al/u);
  assert.match(flow, /Yayın yalnızca hazır taslağı inceledikten sonra başlar/u);
});

test("source catalog does not poll the local engine while the screen is idle", async () => {
  const sourceCenter = await readFile(source("screens", "SourceCenter.tsx"), "utf8");

  assert.doesNotMatch(sourceCenter, /window\.setInterval\(\(\) => void refreshSources/u);
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

test("backup restore never implies that the active local workspace was replaced", async () => {
  const setup = await readFile(source("screens", "SetupCenter.tsx"), "utf8");

  assert.match(setup, /Geri yükleme tamamlandı: \$\{result\.entries\} dosya yeni klasöre çıkarıldı\. Aktif çalışma alanı değiştirilmedi\./u);
  assert.match(setup, /Yedek dosyaları çıkarır; Blogbot'un aktif çalışma alanını otomatik değiştirmez\./u);
});

test("automatic local recovery snapshots are selectable without exposing their derived key", async () => {
  const setup = await readFile(source("screens", "SetupCenter.tsx"), "utf8");

  assert.match(setup, /Yerel kurtarma snapshot'ları/u);
  assert.match(setup, /listAutomaticBackups()/u);
  assert.match(setup, /verifyAutomaticBackup/u);
  assert.match(setup, /previewAutomaticBackupRestore/u);
  assert.match(setup, /restoreAutomaticBackup/u);
  assert.doesNotMatch(setup, /automatic.*recoveryKey/iu);
});

test("GitHub device login starts only from a user action and renders only the safe code and fixed URL", async () => {
  const setup = await readFile(source("screens", "SetupCenter.tsx"), "utf8");

  assert.match(setup, /const startGitHubDeviceFlow = async \(\) =>/u);
  assert.match(setup, /await bridge\.startGitHubDeviceFlow\(\)/u);
  assert.match(setup, /await bridge\.pollGitHubDeviceFlow\(\)/u);
  assert.match(setup, /onClick=\{\(\) => void startGitHubDeviceFlow\(\)\}/u);
  assert.match(setup, /GitHub cihaz girişini başlat/u);
  assert.match(setup, /GitHub onayını kontrol et/u);
  assert.match(setup, /githubDeviceFlow\.userCode/u);
  assert.match(setup, /https:\/\/github\.com\/login\/device/u);
  assert.doesNotMatch(setup, /githubDeviceFlow\.(?:deviceCode|accessToken|token)/u);
});

test("publish setup requires explicit GitHub check names instead of assuming CI success", async () => {
  const setup = await readFile(source("screens", "SetupCenter.tsx"), "utf8");
  const types = await readFile(source("types.ts"), "utf8");

  assert.match(types, /deploy: \{ workflowName: string; requiredChecks: string\[\] \}/u);
  assert.match(setup, /Zorunlu GitHub kontrolleri/u);
  assert.match(setup, /requiredChecks\.join\("\\n"\)/u);
  assert.match(setup, /split\(/u);
  assert.match(setup, /filter\(Boolean\)/u);
  assert.match(setup, /En az bir zorunlu GitHub kontrolü/u);
});

test("diagnostics exposes an explicit bounded encrypted-data integrity check", async () => {
  const setup = await readFile(source("screens", "SetupCenter.tsx"), "utf8");
  const bridge = await readFile(source("bridge.ts"), "utf8");

  assert.match(setup, /const verifyLocalIntegrity = async \(\) =>/u);
  assert.match(setup, /Yerel veri bütünlüğünü doğrula/u);
  assert.match(setup, /bütünlüğü doğrulanıyor/u);
  assert.match(bridge, /verifyLocalIntegrity\(\): Promise<\{ verified: true; completedAt: string \}>/u);
  assert.match(bridge, /verifyLocalIntegrity: \(\) => mutate\("verify_local_integrity"\)/u);
});

test("main WebView exposes only native-granted filesystem actions and keeps credentials and logs denied", async () => {
  const permissions = await readFile(
    join(desktopRoot, "src-tauri", "permissions", "default.toml"),
    "utf8"
  );
  for (const forbidden of [
    "allow-get-local-dev-logs"
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
    "allow-github-device-flow-start",
    "allow-github-device-flow-poll",
    "allow-github-device-flow-clear",
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

test("instant create offers only publishable visual policies and explains their real media outcome", async () => {
  const instantCreate = await readFile(source("screens", "InstantCreate.tsx"), "utf8");

  assert.deepEqual(
    [...instantCreate.matchAll(/<option value="(GENERATE|LOCAL_RENDERER|NONE)">/gu)].map((match) => match[1]),
    ["GENERATE", "LOCAL_RENDERER"]
  );
  assert.match(instantCreate, /ImageGen kullan\u0131l\u0131r; kullan\u0131lamazsa veya \u00fcretim ba\u015far\u0131s\u0131z olursa g\u00f6rsel eklenmez/u);
  assert.match(instantCreate, /Yerel olu\u015fturucu d\u0131\u015f g\u00f6rsel \u00fcretimi \u00e7a\u011f\u0131rmaz; metinsiz kapak ve \u00fc\u00e7 yay\u0131n oran\u0131 \u00fcretir/u);
});

test("Operations exposes a real retry action for a blocked active draft", async () => {
  const contents = await readFile(source("screens", "OperationsHub.tsx"), "utf8");
  assert.match(contents, /draft\.blockers > 0/u);
  assert.match(contents, /onClick=\{\(\) => void retry\(draft\.id\)\}/u);
  assert.match(contents, /Tekrar dene/u);
});
