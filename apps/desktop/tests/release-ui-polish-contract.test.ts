import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const shell = readFileSync(new URL("../src/components/AppShell.tsx", import.meta.url), "utf8");
const review = readFileSync(new URL("../src/screens/ReviewWorkspace.tsx", import.meta.url), "utf8");
const operations = readFileSync(new URL("../src/screens/OperationsHub.tsx", import.meta.url), "utf8");
const settings = readFileSync(new URL("../src/screens/SettingsCenter.tsx", import.meta.url), "utf8");
const setup = readFileSync(new URL("../src/screens/SetupCenter.tsx", import.meta.url), "utf8");
const editorial = readFileSync(new URL("../src/screens/EditorialDesk.tsx", import.meta.url), "utf8");
const styles = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");
const nativeSmoke = readFileSync(new URL("../../../scripts/native-webview-smoke.mjs", import.meta.url), "utf8");

test("Boby lives in the sidebar and About is visually distinct from active navigation", () => {
  const launcher = shell.indexOf('className="boby-launcher"');
  const sidebarEnd = shell.indexOf("</aside>");
  const mobileUtilities = shell.indexOf('className="mobile-utility-nav"');
  assert.ok(launcher > 0 && launcher < mobileUtilities && mobileUtilities < sidebarEnd);
  assert.match(shell, /about-toggle\$\{updateAvailable \? " has-update" : ""\}/u);
  assert.match(styles, /\.sidebar \.boby-launcher\s*\{[^}]*position:\s*static;/su);
  assert.match(styles, /\.sidebar \.about-toggle\s*\{[^}]*background:\s*transparent;/su);
});

test("empty review state is not duplicated when the entire queue is empty", () => {
  assert.match(review, /!visibleQueue\.length && snapshot\.queue\.length > 0/u);
});

test("Operations labels active work truthfully and never retries a running draft", () => {
  assert.match(operations, /\["jobs", `İşler ·/u);
  assert.doesNotMatch(operations, /draft\.blockers > 0 \|\| draft\.state === "DRAFTING"/u);
  assert.match(operations, /Devam eden/u);
  assert.match(operations, /Müdahale gereken/u);
});

test("idle Settings shows one state line instead of every disabled reason", () => {
  assert.match(settings, /saveUnavailableReason && \(readOnly \|\| busy \|\| dirty\)/u);
  assert.match(settings, /cancelUnavailableReason && \(readOnly \|\| busy\)/u);
  assert.match(settings, /defaultsUnavailableReason && \(readOnly \|\| busy\)/u);
});

test("setup has one next-action control and no artificial guided panel height", () => {
  const summaryStart = setup.indexOf('className={`setup-readiness-summary');
  const summaryEnd = setup.indexOf("</div>", summaryStart);
  assert.ok(summaryStart > 0 && summaryEnd > summaryStart);
  assert.doesNotMatch(setup.slice(summaryStart, summaryEnd), /button/u);
  assert.match(styles, /\.guided-setup-panel > div:nth-child\(2\)\s*\{[^}]*min-height:\s*0;/su);
});

test("pending editorial work is calm, localized, and the calendar preserves readable columns", () => {
  assert.match(editorial, /İngilizce başlık araştırmadan sonra hazırlanacak/u);
  assert.match(styles, /\.progress-ring\.progress-indeterminate\s*\{[^}]*animation:\s*none;/su);
  assert.match(styles, /\.week-day-groups\.slot-picker\s*\{/u);
  assert.match(styles, /\.candidate-action-guidance\s*\{[^}]*max-width:\s*none;/su);
});

test("native screenshot acceptance can exercise the supported compact desktop size", () => {
  assert.match(nativeSmoke, /BLOGBOT_NATIVE_WINDOW_WIDTH/u);
  assert.match(nativeSmoke, /BLOGBOT_NATIVE_WINDOW_HEIGHT/u);
  assert.match(nativeSmoke, /\/window\/rect/u);
  assert.match(styles, /@media \(max-width: 1050px\)[\s\S]*?\.guided-setup-panel > \.guided-progress-shell\s*\{[^}]*grid-template-columns:\s*minmax\(0, 1fr\)/u);
  assert.match(styles, /\.sidebar\s*\{[^}]*overflow-y:\s*auto;/su);
});

test("native acceptance asks Boby through the visible composer", () => {
  assert.match(nativeSmoke, /async function verifyVisibleBobyConversationJourney/u);
  assert.match(nativeSmoke, /document\.querySelector\('\.boby-launcher'\)/u);
  assert.match(nativeSmoke, /document\.getElementById\('boby-question'\)/u);
  assert.match(nativeSmoke, /bobyUiJourney/u);
});

test("native restart recovery uses the engine-recovery budget", () => {
  assert.match(nativeSmoke, /window\.location\.reload\(\); return true;[\s\S]*?waitForVisibleHeading\(sessionId, "editorial", MAX_ENGINE_RECOVERY_RENDER_MS\)/u);
});
