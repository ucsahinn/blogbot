import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { resolve, join } from "node:path";
import { tmpdir } from "node:os";
import { verifyVisibleActionMatrix } from "./native-visible-action-matrix.mjs";

const repositoryRoot = resolve(import.meta.dirname, "..");
const tauriDriverPath = process.env.BLOGBOT_TAURI_DRIVER;
const edgeDriverPath = process.env.BLOGBOT_EDGE_DRIVER;
const applicationPath = process.env.BLOGBOT_DESKTOP_EXE
  ?? resolve(repositoryRoot, "apps/desktop/src-tauri/target/release/blogbot.exe");
const inspectExistingProfile = process.env.BLOGBOT_NATIVE_PROFILE === "actual";
const keepSmokeDataRoot = process.env.BLOGBOT_NATIVE_KEEP_TEMP === "1";
const profileObserveMs = Number.parseInt(process.env.BLOGBOT_PROFILE_OBSERVE_MS ?? "0", 10);
const skipProfileFinalRead = process.env.BLOGBOT_PROFILE_SKIP_FINAL_READ === "1";
const retryBlockedActualProfile = process.env.BLOGBOT_PROFILE_RETRY_BLOCKED === "1";
const screenshotDirectory = process.env.BLOGBOT_NATIVE_SCREENSHOT_DIR
  ? resolve(repositoryRoot, process.env.BLOGBOT_NATIVE_SCREENSHOT_DIR)
  : undefined;
const requestedWindowWidth = process.env.BLOGBOT_NATIVE_WINDOW_WIDTH
  ? Number.parseInt(process.env.BLOGBOT_NATIVE_WINDOW_WIDTH, 10)
  : undefined;
const requestedWindowHeight = process.env.BLOGBOT_NATIVE_WINDOW_HEIGHT
  ? Number.parseInt(process.env.BLOGBOT_NATIVE_WINDOW_HEIGHT, 10)
  : undefined;

const rewriteFirstShortActualProfile = process.env.BLOGBOT_PROFILE_REWRITE_SHORT === "1";
const testExistingProfileSources = process.env.BLOGBOT_PROFILE_TEST_SOURCES === "1";
const verifyBobyLiveReply = process.env.BLOGBOT_VERIFY_BOBY_LIVE_REPLY === "1";
const verifyUpdaterLiveCheck = process.env.BLOGBOT_VERIFY_UPDATER_LIVE_CHECK === "1";
const liveBobyReplyTimeoutMs = Number.parseInt(
  process.env.BLOGBOT_LIVE_BOBY_TIMEOUT_MS ?? "120000",
  10
);

const nativeSmokeRequestTimeoutMs = Number.parseInt(
  process.env.BLOGBOT_NATIVE_REQUEST_TIMEOUT_MS ?? "20000",
  10
);
const webdriverBaseUrl = "http://127.0.0.1:4444";
let webdriverUserDataFolder;
const smokeFeedUrl = process.env.BLOGBOT_SMOKE_FEED_URL ?? "https://www.cshub.com/rss/news";
// Navigation is a local render, not a network operation. A multi-second wait
// means the user sees a frozen menu, so keep this gate deliberately stricter
// than setup and engine-startup probes.
const MAX_INITIAL_BOOT_RENDER_MS = 15_000;
const MAX_ENGINE_RECOVERY_RENDER_MS = 15_000;
const MAX_ROUTE_RENDER_MS = 3_000;
const ROUTE_RENDER_POLL_MS = 100;
const routes = [
  "dashboard",
  "content",
  "content-candidates",
  "instant",
  "editorial",
  "editorial-review",
  "publishing",
  "operations",
  "settings",
  "setup",
  "setup-guide"
];
const expectedHeadings = {
  dashboard: "Yayın akışı kontrol altında.",
  content: "Kaynaklardan yayın fikrine tek çalışma alanı.",
  "content-candidates": "Kaynaklardan yayın fikrine tek çalışma alanı.",
  instant: "Kaynaklardan yayın fikrine tek çalışma alanı.",
  editorial: "Taslak, iki dil ve kanıt paketi aynı masada.",
  "editorial-review": "Taslak, iki dil ve kanıt paketi aynı masada.",
  publishing: ["Haftalık ritim, hazır yayınlar ve geçmiş.", "Haftalık ritim, hazır çıktılar ve geçmiş."],
  operations: "İşler, Codex kapasitesi ve sistem sağlığı.",
  settings: "Editoryal varsayılanlar ve bildirimler.",
  setup: "Yerel çalışma durumu",
  "setup-guide": "Yerel çalışma durumu"
};
const requiredNativeReadContracts = {
  get_bootstrap_snapshot: {
    required: ["onboardingComplete", "runtime", "capabilities", "connection", "automation", "codex", "pipeline", "queue", "sourceCount", "scheduledCount"]
  },
  get_prerequisite_status: { required: ["checkedAtUnixMs", "checks"] },
  get_connector_state: {
    required: ["sourceState", "mode", "configured", "config", "site", "checks", "localReadiness", "externalReadiness"],
    optional: ["migration"]
  },
  get_editorial_workspace: {
    required: ["sync", "today", "candidates", "drafts", "weeklySlots", "scheduled", "history", "failures", "codexRoles", "preferences", "systemHealth"],
    optional: ["hiddenDraftCount"]
  },
  get_operations: { required: ["events", "schedule", "worker", "publisher"] },
  get_engine_diagnostics: { required: ["path", "lines", "bridgeError"] },
  list_sources: { required: ["sources"] },
  local_dev_status: { required: ["running", "supported"] },
  github_device_flow_status: {
    required: ["status", "writes", "network", "detail"],
    optional: ["userCode", "verificationUri", "scopes", "retryAfterSeconds", "lastError"]
  },
  autostart_status: { required: ["enabled"] }
};
function fail(message) {
  throw new Error(`Native WebView smoke failed: ${message}`);
}

function wait(milliseconds) {
  return new Promise((resolveWait) => setTimeout(resolveWait, milliseconds));
}

async function cleanupSmokeDataRoot(root) {
  // WebView2 can release its profile lock shortly after the driver exits.
  // Keep cleanup bounded but long enough for that asynchronous shutdown.
  for (let attempt = 0; attempt < 20; attempt += 1) {
    await rm(root, { recursive: true, force: true }).catch(() => undefined);
    try {
      await access(root);
    } catch {
      return true;
    }
    await wait(250);
  }
  // Do not hide a locked disposable profile. The path contains no user data
  // by construction, and this redacted warning tells CI exactly what needs
  // cleanup without dumping driver or engine contents.
  console.error(`Native smoke temporary profile retained after cleanup retries: ${root}`);
  return false;
}

async function requireFile(path, name) {
  if (!path) {
    fail(`${name} is required. Set ${name} to a local executable path.`);
  }
  try {
    await access(path);
  } catch {
    fail(`${name} does not point to a readable executable.`);
  }
}

async function request(path, options) {
  if (
    !Number.isSafeInteger(nativeSmokeRequestTimeoutMs)
    || nativeSmokeRequestTimeoutMs < 1_000
    || nativeSmokeRequestTimeoutMs > 120_000
  ) {
    fail("BLOGBOT_NATIVE_REQUEST_TIMEOUT_MS must be an integer from 1000 to 120000.");
  }
  let response;
  try {
    response = await fetch(`${webdriverBaseUrl}${path}`, {
      ...options,
      signal: options?.signal ?? AbortSignal.timeout(nativeSmokeRequestTimeoutMs)
    });
  } catch (error) {
    if (error?.name === "TimeoutError" || error?.name === "AbortError") {
      fail(`NATIVE_SMOKE_REQUEST_TIMEOUT: ${path} did not respond within ${nativeSmokeRequestTimeoutMs}ms.`);
    }
    throw error;
  }
  const payload = await response.json();
  if (!response.ok) {
    const driverMessage = typeof payload?.value?.message === "string" ? payload.value.message : "";
    if (
      path === "/session"
      && !inspectExistingProfile
      && /session not created: Chrome instance exited/iu.test(driverMessage)
    ) {
      // Boby intentionally uses Tauri's single-instance plugin. When an
      // editor-owned instance is already open, the second isolated executable
      // forwards to it and WebDriver only reports the misleading Edge crash.
      fail("NATIVE_SMOKE_SINGLE_INSTANCE_CONFLICT: Boby may already be open. Close the running Boby instance, then rerun this isolated native smoke.");
    }
    if (
      path === "/session"
      && inspectExistingProfile
      && /session not created: Chrome instance exited/iu.test(driverMessage)
    ) {
      fail("NATIVE_SMOKE_EXISTING_PROFILE_ATTACH_UNSUPPORTED: WebDriver cannot attach to an already-running Tauri window. Close Boby and rerun the isolated smoke; this does not indicate an application crash.");
    }
    fail(`${path} returned ${response.status}: ${JSON.stringify(payload)}`);
  }
  return payload;
}

async function setRequestedWindowRect(sessionId) {
  if (requestedWindowWidth === undefined && requestedWindowHeight === undefined) return;
  if (
    (requestedWindowWidth !== undefined && (!Number.isSafeInteger(requestedWindowWidth) || requestedWindowWidth < 640 || requestedWindowWidth > 3840))
    || (requestedWindowHeight !== undefined && (!Number.isSafeInteger(requestedWindowHeight) || requestedWindowHeight < 480 || requestedWindowHeight > 2160))
  ) {
    fail("BLOGBOT_NATIVE_WINDOW_WIDTH/HEIGHT must describe a supported desktop window.");
  }
  const current = await request(`/session/${sessionId}/window/rect`);
  const width = requestedWindowWidth ?? current?.value?.width;
  const height = requestedWindowHeight ?? current?.value?.height;
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height)) {
    fail("native driver did not expose a usable window rectangle.");
  }
  await request(`/session/${sessionId}/window/rect`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      x: Number.isSafeInteger(current?.value?.x) ? current.value.x : 0,
      y: Number.isSafeInteger(current?.value?.y) ? current.value.y : 0,
      width,
      height
    })
  });
}

async function captureRouteScreenshot(sessionId, route) {
  if (!screenshotDirectory || inspectExistingProfile) return undefined;
  const response = await request(`/session/${sessionId}/screenshot`);
  const encoded = response?.value;
  if (typeof encoded !== "string" || encoded.length === 0) {
    fail(`native screenshot for ${route} was empty.`);
  }
  await mkdir(screenshotDirectory, { recursive: true });
  const fileName = `${route.replace(/[^a-z0-9-]+/giu, "-")}.png`;
  await writeFile(resolve(screenshotDirectory, fileName), Buffer.from(encoded, "base64"));
  return fileName;
}

async function waitForDriver() {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      const response = await fetch(`${webdriverBaseUrl}/status`, { signal: AbortSignal.timeout(500) });
      if (response.ok) return;
    } catch {
      // The native driver has not bound its local inspection port yet.
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 250));
  }
  fail("Tauri driver did not become ready within 7.5 seconds.");
}

async function execute(sessionId, script) {
  const result = await request(`/session/${sessionId}/execute/sync`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ script, args: [] })
  });
  return result.value;
}

async function createNativeSession() {
  const tauriOptions = {
    application: applicationPath,
    // WebView2's GPU process is unstable on some Windows/driver combinations
    // used by clean-machine verification. Keep this mitigation inside the
    // disposable smoke session; production Boby keeps its normal renderer.
    webviewOptions: {
      additionalBrowserArguments: ["--disable-gpu"],
      ...(webdriverUserDataFolder ? { userDataFolder: webdriverUserDataFolder } : {})
    }
  };
  const created = await request("/session", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      capabilities: {
        alwaysMatch: {
          // tauri-driver routes Windows WebView2 sessions through its WRY
          // capability. Using "webview2" makes msedgedriver launch and then
          // reject the application with the misleading "Chrome not reachable"
          // session error before the app can be inspected.
          browserName: "wry",
          // Keep the native Windows path intact. Converting `C:\\...` to
          // `C:/...` is accepted by the shell but is not consistently
          // forwarded by tauri-driver to msedgedriver on Windows.
          "tauri:options": tauriOptions
        }
      }
    })
  });
  if (typeof created.value?.sessionId !== "string") {
    fail(`native driver returned an invalid session response: ${JSON.stringify(created)}`);
  }
  return created.value.sessionId;
}

async function waitForApplicationTitle(sessionId) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const title = await request(`/session/${sessionId}/title`);
    if (title.value === "Boby · Yerel yayın merkezi") return title;
    const visibleHeading = await execute(
      sessionId,
      "return document.querySelector('h1')?.textContent?.trim() ?? '';"
    );
    // Some compatible Windows WebDriver versions expose an empty native title
    // even when the WebView is visibly ready. The subsequent route assertions
    // still verify the rendered product surface, so do not turn that driver
    // limitation into a false negative.
    if (visibleHeading) return { value: "WEBDRIVER_TITLE_UNAVAILABLE" };
    await wait(150);
  }
  fail("application title did not become available within 15 seconds.");
}

async function waitForTauriBridge(sessionId) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const ready = await execute(
      sessionId,
      "return typeof window.__TAURI_INTERNALS__?.invoke === 'function';"
    );
    if (ready === true) return;
    await wait(150);
  }
  const diagnostic = await execute(
    sessionId,
    "return document.body?.innerText?.replace(/\\s+/g, ' ').trim().slice(0, 500) ?? '';"
  );
  fail(`Tauri invoke bridge did not become ready within 15 seconds. Visible text: ${JSON.stringify(diagnostic)}`);
}

async function safeFatalDiagnostic(sessionId) {
  return execute(
    sessionId,
    `return (() => {
      const detail = document.querySelector('.fatal-state p')?.textContent ?? '';
      const knownCodes = [
        'BRIDGE_UNAVAILABLE', 'ENGINE_EXECUTABLE_MISSING', 'PGLITE_ASSETS_MISSING',
        'LOCAL_DATA_KEY_UNAVAILABLE', 'ENGINE_START_FAILED', 'ENGINE_RESPONSE_TIMEOUT',
        'ENGINE_CLOSED_PIPE', 'ENGINE_READ_FAILED', 'ENGINE_WRITE_FAILED'
      ];
      return knownCodes.find((code) => detail.includes(code)) ?? 'UNCLASSIFIED_FATAL_STARTUP';
    })()`
  );
}

async function waitForVisibleHeading(sessionId, route, timeoutMs = MAX_ROUTE_RENDER_MS) {
  const expected = expectedHeadings[route];
  const startedAt = performance.now();
  while (performance.now() - startedAt < timeoutMs) {
    const heading = await execute(
      sessionId,
      `window.location.hash = '#${route}'; return document.querySelector('h1')?.textContent?.trim() ?? '';`
    );
    if (heading === "Çalışma alanı açılamadı.") {
      const safeErrorCode = await safeFatalDiagnostic(sessionId);
      fail(`route #${route} reached the fatal startup state. Safe error codes: ${JSON.stringify(safeErrorCode)}`);
    }
    if (Array.isArray(expected) ? expected.includes(heading) : heading === expected) {
      return {
        heading,
        routeRenderMs: Math.round(performance.now() - startedAt)
      };
    }
    await wait(ROUTE_RENDER_POLL_MS);
  }
  const diagnostic = await execute(
    sessionId,
    "return document.body?.innerText?.replace(/\\s+/g, ' ').trim().slice(0, 500) ?? '';"
  );
  fail(`route #${route} did not render a visible page heading within ${MAX_ROUTE_RENDER_MS} ms. Visible text: ${JSON.stringify(diagnostic)}`);
}

async function verifySetupGuideStartsFocusedWizard(sessionId) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const state = await execute(
      sessionId,
      `window.location.hash = '#setup-guide';
       return {
         title: document.querySelector('#guided-setup-title')?.textContent?.trim() ?? '',
         progress: document.querySelector('[aria-label="İlk başlangıç ilerlemesi"]')?.getAttribute('aria-valuenow') ?? '',
         taskHubVisible: Boolean(document.querySelector('#setup-task-hub-title'))
       };`
    );
    if (state?.title === "Bu bilgisayarı kontrol et" && state.progress === "1" && !state.taskHubVisible) {
      const nextClicked = await execute(
        sessionId,
        `return (() => {
          const button = [...document.querySelectorAll('button')].find((item) => item.textContent?.trim() === 'Codex bağlantısına devam et');
          if (!button || button.disabled) return false;
          button.click();
          return true;
        })();`
      );
      if (nextClicked !== true) fail("setup guide could not advance from its initial system-check step.");
      await waitForSetupGuideStep(sessionId, "Codex'i bağla ve test et", "2");
      const skipClicked = await execute(
        sessionId,
        `return (() => {
          const button = [...document.querySelectorAll('button')].find((item) => item.textContent?.trim() === "Codex'i şimdilik atla");
          if (!button || button.disabled) return false;
          button.click();
          return true;
        })();`
      );
      if (skipClicked !== true) fail("setup guide did not offer an enabled Codex skip action.");
      const target = await waitForSetupGuideStep(sessionId, "Çıktı klasörünü seç, test et ve bitir", "3");
      const targetSelectionVisible = await execute(
        sessionId,
        "return document.querySelector('#quickstart-title')?.textContent?.trim() === 'Çıktı klasörünü seç';"
      );
      if (targetSelectionVisible !== true) fail("setup guide reached the target step without rendering its target choices.");
      return { ...state, finalTitle: target.title, finalProgress: target.progress, targetSelectionVisible };
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 150));
  }
  const diagnostic = await execute(
    sessionId,
    "return document.body?.innerText?.replace(/\\s+/g, ' ').trim().slice(0, 500) ?? '';"
  );
  fail(`route #setup-guide did not open the focused first-start wizard. Visible text: ${JSON.stringify(diagnostic)}`);
}

async function waitForSetupGuideStep(sessionId, expectedTitle, expectedProgress) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const state = await execute(
      sessionId,
      `return {
        title: document.querySelector('#guided-setup-title')?.textContent?.trim() ?? '',
        progress: document.querySelector('[aria-label="İlk başlangıç ilerlemesi"]')?.getAttribute('aria-valuenow') ?? ''
      };`
    );
    if (state?.title === expectedTitle && state.progress === expectedProgress) return state;
    await new Promise((resolveWait) => setTimeout(resolveWait, 150));
  }
  const diagnostic = await execute(
    sessionId,
    "return document.body?.innerText?.replace(/\\s+/g, ' ').trim().slice(0, 700) ?? '';"
  );
  fail(`setup guide did not reach ${JSON.stringify(expectedTitle)} at step ${expectedProgress}. Visible text: ${JSON.stringify(diagnostic)}`);
}

async function verifyNativeReadCommands(sessionId) {
  const results = await execute(
    sessionId,
    `return Promise.all(Object.entries(${JSON.stringify(requiredNativeReadContracts)}).map(async ([command, contract]) => {
      try {
        const result = await window.__TAURI_INTERNALS__.invoke(command);
        if (!result || typeof result !== 'object' || Array.isArray(result)) {
          return { command, ok: false, error: 'response is not an object' };
        }
        const actualKeys = Object.keys(result);
        const allowedKeys = [...contract.required, ...(contract.optional ?? [])];
        const missingKeys = contract.required.filter((key) => !actualKeys.includes(key));
        const unexpectedKeys = actualKeys.filter((key) => !allowedKeys.includes(key));
        if (missingKeys.length > 0 || unexpectedKeys.length > 0) {
          return {
            command,
            ok: false,
            error: 'response key contract mismatch',
            missingKeys,
            unexpectedKeys
          };
        }
        return { command, ok: true };
      } catch (error) {
        return { command, ok: false, error: String(error).slice(0, 240) };
      }
    }));`
  );
  if (!Array.isArray(results)) {
    fail("native read command verification returned an invalid result.");
  }
  const failed = results.filter((result) => !result?.ok);
  if (failed.length > 0) {
    fail(`native read command verification failed: ${JSON.stringify(failed)}`);
  }
  return results.map(({ command }) => command);
}

async function verifyCodexRuntime(sessionId) {
  const codexRuntime = await execute(
    sessionId,
    `return window.__TAURI_INTERNALS__.invoke("test_codex_runtime")
      .then((result) => ({ ok: true, result }))
      .catch((error) => ({ ok: false, error: String(error) }));`
  );
  if (
    !codexRuntime?.ok
    || codexRuntime.result?.available !== true
    || codexRuntime.result?.authenticated !== true
    || codexRuntime.result?.runnerReady !== true
  ) {
    fail(`Codex runtime is not ready for direct Boby replies: ${JSON.stringify(codexRuntime)}`);
  }
  return codexRuntime.result;
}

async function verifyLiveBobyReply(sessionId) {
  const question = "Yeni bir kaynaktan içerik üretmeye nereden başlamalıyım?";
  if (
    !Number.isSafeInteger(liveBobyReplyTimeoutMs)
    || liveBobyReplyTimeoutMs < 10_000
    || liveBobyReplyTimeoutMs > 120_000
  ) fail("BLOGBOT_LIVE_BOBY_TIMEOUT_MS must be an integer from 10000 to 120000.");

  const submitted = await invoke(sessionId, "request_boby_guidance", {
    request: {
      question,
      activePage: "content",
      runtimeState: "ONLINE",
      safeWorkspaceSummary: { draftCount: 0, reviewCount: 0, sourceCount: 0 }
    }
  });
  const guidanceId = submitted?.result?.id;
  if (!submitted?.ok || typeof guidanceId !== "string" || !guidanceId.startsWith("boby-")) {
    fail(`live Boby request was not accepted: ok=${submitted?.ok === true}.`);
  }
  const startedAt = performance.now();
  while (performance.now() - startedAt < liveBobyReplyTimeoutMs) {
    const guidance = await invoke(sessionId, "get_boby_guidance", { guidanceId });
    if (!guidance?.ok) fail(`live Boby status read failed: ok=${guidance?.ok === true}.`);
    const result = guidance.result;
    if (result?.state === "SUCCEEDED" && typeof result.reply === "string" && result.reply.trim().length >= 20) {
      if (/OPE'nin yerel editöründesin\. Konuyu bir cümleyle yaz/iu.test(result.reply)) {
        fail("live Boby returned the retired canned local fallback.");
      }
      return { elapsedMs: Math.round(performance.now() - startedAt), replyLength: result.reply.trim().length };
    }
    if (result?.state === "FAILED") fail(`live Boby job failed: state=FAILED; diagnosticCode=${typeof result?.diagnosticCode === "string" ? result.diagnosticCode : "UNAVAILABLE"}.`);
    await wait(1_000);
  }
  const finalGuidance = await invoke(sessionId, "get_boby_guidance", { guidanceId });
  const safeLiveBobyState = {
    state: typeof finalGuidance.result?.state === "string" ? finalGuidance.result.state : "UNAVAILABLE",
    waitReason: typeof finalGuidance.result?.waitReason === "string" ? finalGuidance.result.waitReason : "UNAVAILABLE",
    diagnosticCode: typeof finalGuidance.result?.diagnosticCode === "string" ? finalGuidance.result.diagnosticCode : "UNAVAILABLE",
    suggestedActionCount: Array.isArray(finalGuidance.result?.suggestedActions) ? finalGuidance.result.suggestedActions.length : 0
  };
  fail(`live Boby did not finish within ${liveBobyReplyTimeoutMs}ms; safe state=${JSON.stringify(safeLiveBobyState)}.`);
}

async function verifyVisibleBobyConversationJourney(sessionId) {
  await execute(sessionId, "window.location.hash = '#dashboard'; return true;");
  await waitForVisibleHeading(sessionId, "dashboard");
  const opened = await execute(sessionId, `return (() => {
    const launcher = document.querySelector('.boby-launcher');
    if (!(launcher instanceof HTMLButtonElement)) return false;
    launcher.click();
    return true;
  })();`);
  if (!opened) fail("visible Boby launcher was not available.");
  await wait(150);

  const typed = await execute(sessionId, `return (() => {
    const input = document.getElementById('boby-question');
    if (!(input instanceof HTMLInputElement) || input.disabled) return false;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    if (!setter) return false;
    setter.call(input, 'Bu ekranda bir sonraki guvenli adim nedir?');
    input.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  })();`);
  if (!typed) fail("visible Boby composer did not accept a question.");
  await wait(100);

  const submitted = await execute(sessionId, `return (() => {
    const form = document.querySelector('.boby-composer');
    const button = form?.querySelector('button[type="submit"]');
    if (!(form instanceof HTMLFormElement) || !(button instanceof HTMLButtonElement) || button.disabled) return false;
    form.requestSubmit(button);
    return true;
  })();`);
  if (!submitted) fail("visible Boby composer did not submit the question.");

  const startedAt = performance.now();
  while (performance.now() - startedAt < liveBobyReplyTimeoutMs) {
    const state = await execute(sessionId, `return (() => ({
      dialogVisible: document.querySelector('.boby-panel') !== null,
      userMessages: document.querySelectorAll('.boby-message-user').length,
      directReplyLengths: [...document.querySelectorAll('.boby-message-boby p')]
        .map((item) => item.textContent?.trim().length ?? 0),
      systemReplies: document.querySelectorAll('.boby-message-system:not(:has(+ *))').length,
      submitDisabled: document.querySelector('.boby-composer button[type="submit"]')?.disabled === true
    }))();`);
    const replyLength = Math.max(0, ...(state?.directReplyLengths ?? []));
    if (state?.dialogVisible && state?.userMessages === 1 && replyLength >= 20) {
      const closeClicked = await execute(sessionId, `return (() => {
        const close = document.querySelector('.boby-close');
        if (!(close instanceof HTMLButtonElement)) return false;
        close.click();
        return true;
      })();`);
      if (!closeClicked) fail("visible Boby panel close control was unavailable.");
      await wait(100);
      const closed = await execute(sessionId, "return document.querySelector('.boby-panel') === null;");
      if (!closed) fail("visible Boby panel did not close after its reply.");
      const reopened = await execute(sessionId, `return (() => {
        const launcher = document.querySelector('.boby-launcher');
        if (!(launcher instanceof HTMLButtonElement)) return false;
        launcher.click();
        return true;
      })();`);
      if (!reopened) fail("visible Boby launcher was unavailable after closing the panel.");
      await wait(100);
      const conversationRestored = await execute(sessionId, "return document.querySelectorAll('.boby-message-user').length === 1 && document.querySelectorAll('.boby-message-boby p').length >= 1;");
      if (!conversationRestored) fail("visible Boby conversation did not remain in the panel after reopening.");
      return {
        elapsedMs: Math.round(performance.now() - startedAt),
        replyLength,
        conversationRestored,
        directReply: true
      };
    }
    if (state?.systemReplies > 0 && state?.submitDisabled !== true) {
      fail("visible Boby conversation ended without a direct Boby reply.");
    }
    await wait(500);
  }
  fail(`visible Boby did not finish within ${liveBobyReplyTimeoutMs}ms.`);
}
async function verifyLiveUpdaterCheck(sessionId) {
  const response = await invoke(sessionId, "check_unsigned_update");
  if (!response?.ok) fail(`live updater check failed: ok=${response?.ok === true}.`);
  const result = response.result;
  if (!result || !["upToDate", "localBuildNewer", "updateAvailable"].includes(result.kind)) {
    fail(`live updater check returned an unsupported kind: ${typeof result?.kind === "string" ? result.kind : "UNAVAILABLE"}.`);
  }
  const latestVersion = result.kind === "updateAvailable" ? result.update?.version : result.latestVersion;
  if (typeof latestVersion !== "string" || latestVersion.trim().length === 0) {
    fail("live updater check did not return a version.");
  }
  return { kind: result.kind, latestVersion };
}

async function measureCatalogReadLatency(sessionId) {
  const startedAt = performance.now();
  const catalog = await invoke(sessionId, "list_sources");
  const catalogReadLatencyMs = Math.round(performance.now() - startedAt);
  if (!catalog?.ok || !Array.isArray(catalog.result?.sources)) {
    fail(`source catalog read returned an invalid response: ${JSON.stringify(catalog)}`);
  }
  // Navigation must not silently tolerate the historical 30–45 second catalog
  // stall. Keep enough headroom for a busy but working local profile.
  if (catalogReadLatencyMs > 3000) {
    fail(`source catalog read exceeded the 3 second interaction budget: ${catalogReadLatencyMs}ms.`);
  }
  return {
    catalogReadLatencyMs,
    sourceCount: catalog.result.sources.length
  };
}

async function invoke(sessionId, command, argumentsValue = {}) {
  return execute(
    sessionId,
    `return window.__TAURI_INTERNALS__.invoke(${JSON.stringify(command)}, ${JSON.stringify(argumentsValue)})
      .then((result) => ({ ok: true, result }))
      .catch((error) => ({ ok: false, error: String(error).slice(0, 500) }));`
  );
}

async function refreshEditorialInventory(sessionId, expectedDraftTitle) {
  const clicked = await execute(
    sessionId,
    `return (() => {
      const button = [...document.querySelectorAll("button")].find(
        (item) => item.textContent?.trim() === "Taslak envanterini yenile"
      );
      if (!button || button.disabled) return false;
      button.click();
      return true;
    })();`
  );
  if (clicked !== true) {
    fail("Editorial Desk refresh action was not available to the native smoke journey.");
  }
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const rendered = await execute(
      sessionId,
      `return document.body?.innerText?.includes(${JSON.stringify(expectedDraftTitle)}) ?? false;`
    );
    if (rendered) return;
    await new Promise((resolveWait) => setTimeout(resolveWait, 150));
  }
  const [visibleText, workspace] = await Promise.all([
    execute(sessionId, "return document.body?.innerText?.replace(/\\s+/g, ' ').trim().slice(0, 1200) ?? '';"),
    invoke(sessionId, "get_editorial_workspace")
  ]);
  const drafts = workspace?.result?.drafts?.map((draft) => ({
    id: draft.id,
    titleTr: draft.titleTr,
    state: draft.state,
    detail: draft.detail
  }));
  const diagnostics = await invoke(sessionId, "get_engine_diagnostics");
  const diagnosticLines = Array.isArray(diagnostics?.result?.lines)
    ? diagnostics.result.lines.slice(-8)
    : [];
  fail(`Editorial Desk refresh did not render ${JSON.stringify(expectedDraftTitle)} within 15 seconds. Visible text: ${JSON.stringify(visibleText)}. Refreshed drafts: ${JSON.stringify(drafts)}. Redacted diagnostics: ${JSON.stringify(diagnosticLines)}`);
}

async function clickCandidateResearchAction(sessionId, candidateTitle) {
  await execute(
    sessionId,
    "window.location.hash = '#content-candidates'; window.location.reload(); return true;"
  );
  await waitForVisibleHeading(sessionId, "content-candidates");

  for (let attempt = 0; attempt < 100; attempt += 1) {
    const clicked = await execute(
      sessionId,
      `return (() => {
        const card = [...document.querySelectorAll('.candidate-card')].find(
          (item) => item.querySelector('h2')?.textContent?.trim() === ${JSON.stringify(candidateTitle)}
        );
        const button = card
          ? [...card.querySelectorAll('button')].find((item) => ['Araştırmaya al', 'Taslak hazırla'].includes(item.textContent?.trim()))
          : undefined;
        if (!button || button.disabled) return false;
        button.click();
        return true;
      })();`
    );
    if (clicked) return;
    await new Promise((resolveWait) => setTimeout(resolveWait, 150));
  }
  fail(`the visible candidate research action was not available for ${JSON.stringify(candidateTitle)}.`);
}

async function verifyInitialEngineSurface(sessionId) {
  await waitForVisibleHeading(sessionId, "operations", MAX_INITIAL_BOOT_RENDER_MS);
  await execute(sessionId, "document.getElementById('operations-tab-health')?.click(); return true;");
  const visible = await execute(sessionId, "return document.body?.innerText?.replace(/\\s+/g, ' ').trim() ?? ''; ");
  if (visible.includes("Yerel engine bağlantısı şu anda kullanılamıyor.")) {
    fail("the first rendered Operations health view falsely reported the ready local engine as offline.");
  }
  if (!visible.includes("Paketlenmiş sidecar stdio üzerinden çalışıyor.")) {
    fail(`the first rendered Operations health view did not show the ready engine detail: ${JSON.stringify(visible.slice(0, 700))}`);
  }
}

async function waitForRecoveredDraft(sessionId, draftId) {
  const startedAt = performance.now();
  let lastEngineState = "UNKNOWN";
  while (performance.now() - startedAt < MAX_ENGINE_RECOVERY_RENDER_MS) {
    const workspace = await invoke(sessionId, "get_editorial_workspace");
    const draft = workspace?.result?.drafts?.find((item) => item?.id === draftId);
    if (workspace?.ok && draft) return { workspace, draft };
    lastEngineState = workspace?.result?.systemHealth?.find((item) => item?.id === "engine")?.state ?? "UNKNOWN";
    await wait(250);
  }
  fail(`candidate draft did not recover after a native application restart within ${MAX_ENGINE_RECOVERY_RENDER_MS}ms; engine state=${lastEngineState}.`);
}

async function verifyCandidateJourney(sessionId, source) {
  if (!source?.id || source.url !== smokeFeedUrl) {
    fail(`candidate journey needs the source that was saved through the visible source flow: ${JSON.stringify(source)}`);
  }
  const sourceId = source.id;
  await reviewSourceThroughVisibleUI(sessionId, source);
  const catalog = await invoke(sessionId, "list_sources");
  const catalogSource = catalog?.result?.sources?.find((item) => item?.id === sourceId);
  if (
    !catalog?.ok ||
    catalogSource?.trustStatus !== "APPROVED" ||
    catalogSource?.rightsStatus !== "APPROVED" ||
    catalogSource?.canPublish !== true
  ) {
    fail(`source list did not project the reviewed source as usable evidence: ${JSON.stringify(catalog)}`);
  }
  const scan = await scanSourceThroughVisibleUI(sessionId, source);

  // Candidate inventory is intentionally cached briefly to keep desktop
  // polling bounded. A just-completed scan may therefore race one stale
  // workspace projection; wait for the cache to refresh instead of treating
  // a completed scan as an immediately visible candidate.
  let beforePromotion;
  let candidate;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    // Candidate projection is deliberately opt-in in the desktop bridge: the
    // normal workspace must not start an expensive candidate listing while the
    // editor is working elsewhere. This smoke is explicitly exercising the
    // candidate route, so request that projection just as Content Flow does.
    beforePromotion = await invoke(sessionId, "get_editorial_workspace", { includeCandidates: true });
    candidate = beforePromotion?.result?.candidates?.find(
      (item) => item?.sourceId === sourceId && item?.state === "NEW"
    );
    if (candidate?.id) break;
    await wait(150);
  }
  if (!candidate?.id || candidate.confidence !== 85) {
    fail(`candidate journey scan completed without a promotable candidate: ${JSON.stringify({ scan, candidates: beforePromotion?.result?.candidates })}`);
  }
  await clickCandidateResearchAction(sessionId, candidate.title);
  await waitForVisibleHeading(sessionId, "editorial");
  // The accepted draft must survive a WebView restart. This mirrors the
  // practical failure mode where a user refreshes or reopens the desktop app
  // before the Editorial Desk has rendered its inventory.
  await execute(sessionId, "window.location.reload(); return true;");
  await waitForVisibleHeading(sessionId, "editorial", MAX_ENGINE_RECOVERY_RENDER_MS);

  let workspace;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const response = await invoke(sessionId, "get_editorial_workspace");
    if (!response?.ok) fail(`candidate journey could not refresh editorial workspace: ${JSON.stringify(response)}`);
    workspace = response.result;
    const draft = workspace?.drafts?.find((item) => item?.id === `draft-candidate-${candidate.id}`);
    if (draft) {
      if (draft.reviewable !== false || draft.state !== "DRAFTING") {
        fail(`queued candidate draft had an invalid editorial state: ${JSON.stringify(draft)}`);
      }
      await waitForVisibleHeading(sessionId, "editorial");
      await refreshEditorialInventory(sessionId, draft.titleTr);
      for (let visibleAttempt = 0; visibleAttempt < 40; visibleAttempt += 1) {
        const visible = await execute(sessionId, `return document.body?.innerText?.includes(${JSON.stringify(draft.titleTr)}) ?? false;`);
        if (visible) return { sourceId, sourceReview: { trustStatus: catalogSource.trustStatus, rightsStatus: catalogSource.rightsStatus, evidenceReady: catalogSource.canPublish }, candidateId: candidate.id, draftId: draft.id, scan };
        await new Promise((resolveWait) => setTimeout(resolveWait, 150));
      }
      fail("queued candidate draft was returned by the native bridge but not rendered after the Editorial Desk refresh.");
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 150));
  }
  fail(`candidate promotion did not appear on the Editorial Desk: ${JSON.stringify(workspace?.drafts)}`);
}

async function reviewSourceThroughVisibleUI(sessionId, source) {
  await execute(sessionId, "window.location.hash = '#content'; window.location.reload(); return true;");
  await waitForVisibleHeading(sessionId, "content");
  const opened = await execute(
    sessionId,
    `return (() => {
      const row = [...document.querySelectorAll('article')].find((item) => item.getAttribute('aria-label') === ${JSON.stringify(`${source.name} kaynak durumu`)});
      const button = row ? [...row.querySelectorAll('button')].find((item) => item.textContent?.trim() === 'Araştırma kullanımını değerlendir') : undefined;
      if (!button || button.disabled) return false;
      button.click();
      return true;
    })();`
  );
  if (opened !== true) fail(`the visible source review action was unavailable for ${JSON.stringify(source.name)}.`);
  const rationaleEntered = await execute(
    sessionId,
    `return (() => {
      const input = document.querySelector('textarea[aria-label="İnceleme gerekçesi"]');
      if (!(input instanceof HTMLTextAreaElement)) return false;
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
      setter?.call(input, 'Native smoke: kaynak sahipliği ve kullanım koşulları ayrı olarak doğrulandı.');
      input.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    })();`
  );
  if (rationaleEntered !== true) fail("the visible source review rationale field was unavailable.");
  const saved = await execute(
    sessionId,
    `return (() => {
      const button = [...document.querySelectorAll('button')].find((item) => item.textContent?.trim() === 'Araştırma kullanım kararını kaydet');
      if (!button || button.disabled) return false;
      button.click();
      return true;
    })();`
  );
  if (saved !== true) fail("the visible source review save action was unavailable after a valid rationale.");
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const catalog = await invoke(sessionId, "list_sources");
    const sourceAfterReview = catalog?.result?.sources?.find((item) => item?.id === source.id);
    if (
      catalog?.ok &&
      sourceAfterReview?.trustStatus === "APPROVED" &&
      sourceAfterReview?.rightsStatus === "APPROVED" &&
      sourceAfterReview?.canPublish === true &&
      Number(sourceAfterReview?.version ?? 0) > Number(source.version ?? 0)
    ) {
      return sourceAfterReview;
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 150));
  }
  fail(`visible source review did not persist its separate evidence decisions for ${JSON.stringify(source.id)}.`);
}

async function scanSourceThroughVisibleUI(sessionId, source) {
  await execute(sessionId, "window.location.hash = '#content'; window.location.reload(); return true;");
  await waitForVisibleHeading(sessionId, "content");
  let started = false;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    started = await execute(
      sessionId,
      `return (() => {
        const row = [...document.querySelectorAll('article')].find(
          (item) => item.getAttribute('aria-label') === ${JSON.stringify(`${source.name} kaynak durumu`)}
        );
        const button = row
          ? [...row.querySelectorAll('button')].find((item) => item.textContent?.trim() === 'Şimdi tara')
          : undefined;
        if (!button || button.disabled) return false;
        button.click();
        return true;
      })();`
    );
    if (started) break;
    await new Promise((resolveWait) => setTimeout(resolveWait, 150));
  }
  if (!started) {
    fail(`the visible Şimdi tara action was not available for ${JSON.stringify(source.name)}.`);
  }

  for (let attempt = 0; attempt < 120; attempt += 1) {
    const complete = await execute(
      sessionId,
      "return document.body?.innerText?.includes('Tarama tamamlandı') ?? false;"
    );
    if (complete) {
      const detail = await execute(
        sessionId,
        "return document.querySelector('.source-scan-progress')?.innerText ?? '';"
      );
      return { visibleAction: true, complete: true, detail };
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 250));
  }
  fail(`visible source scan did not report completion for ${JSON.stringify(source.name)}.`);
}

async function verifySingleSourceAddressCheckJourney(sessionId) {
  await execute(sessionId, "window.location.hash = '#content'; window.location.reload(); return true;");
  await waitForVisibleHeading(sessionId, "content");
  const inputUpdated = await execute(
    sessionId,
    `return (() => {
      const input = document.querySelector('textarea');
      if (!input) return false;
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
      setter?.call(input, ${JSON.stringify(smokeFeedUrl)});
      input.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    })();`
  );
  if (inputUpdated !== true) fail("the single-source input was not available to native smoke.");
  let submitted = false;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    submitted = await execute(
      sessionId,
      `return (() => {
        const button = [...document.querySelectorAll('button')].find((item) => item.textContent?.trim() === 'Adresi kontrol et');
        if (!button || button.disabled) return false;
        button.click();
        return true;
      })();`
    );
    if (submitted) break;
    await new Promise((resolveWait) => setTimeout(resolveWait, 150));
  }
  if (submitted !== true) fail("the visible single-source address check action was not enabled after the source URL was entered.");
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const tested = await execute(
      sessionId,
      "return [...document.querySelectorAll('button')].some((item) => item.textContent?.trim() === 'Yeniden test et');"
    );
    if (tested) break;
    await new Promise((resolveWait) => setTimeout(resolveWait, 150));
  }
  const tested = await execute(
    sessionId,
    "return [...document.querySelectorAll('button')].some((item) => item.textContent?.trim() === 'Yeniden test et');"
  );
  if (!tested) fail("single-source address check did not render a real technical test result in the native package.");
  let saved = false;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    saved = await execute(
      sessionId,
      `return (() => {
        const button = [...document.querySelectorAll('button')].find((item) => item.textContent?.trim() === 'Tümünü izlemeye al');
        if (!button || button.disabled) return false;
        button.click();
        return true;
      })();`
    );
    if (saved) break;
    await new Promise((resolveWait) => setTimeout(resolveWait, 150));
  }
  if (!saved) fail("visible source save action was not available after the technical address check.");
  for (let attempt = 0; attempt < 80; attempt += 1) {
    const catalog = await invoke(sessionId, "list_sources");
    const source = catalog?.result?.sources?.find((item) => item?.url === smokeFeedUrl);
    if (catalog?.ok && source?.id) return { url: smokeFeedUrl, tested: true, source };
    await new Promise((resolveWait) => setTimeout(resolveWait, 150));
  }
  fail("visible source save did not persist the technically checked source in the native catalog.");
}

async function verifyVisibleInstantCreateJourney(sessionId) {
  const instruction = "Kaynakları karşılaştırarak doğrulanmış bir teknoloji analizi hazırla";
  await execute(sessionId, "window.location.hash = '#content'; return true;");
  await waitForVisibleHeading(sessionId, "content");
  const opened = await execute(sessionId, `return (() => {
    const tab = [...document.querySelectorAll('button[role="tab"]')].find((item) => item.textContent?.trim() === 'Anlık oluştur');
    if (!tab || tab.disabled) return false;
    tab.click();
    return true;
  })();`);
  if (!opened) fail("visible Anlık oluştur tab was not available to native smoke.");
  let configured = false;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    configured = await execute(sessionId, `return (() => {
      const instructionField = document.querySelector('textarea');
      const source = [...document.querySelectorAll('input[type="checkbox"]')].find((item) => !item.disabled);
      const section = document.querySelector('select');
      if (!instructionField || !source || !section) return false;
      const setText = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
      const setSelect = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set;
      setText?.call(instructionField, ${JSON.stringify(instruction)});
      instructionField.dispatchEvent(new Event('input', { bubbles: true }));
      source.click();
      setSelect?.call(section, 'analiz');
      section.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    })();`);
    if (configured) break;
    await new Promise((resolveWait) => setTimeout(resolveWait, 150));
  }
  if (!configured) fail("visible Instant Create fields were not available to native smoke.");
  let formReady = false;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    formReady = await execute(sessionId, `return (() => {
      const selectedSource = [...document.querySelectorAll('input[type="checkbox"]')].some((item) => item.checked);
      const section = document.querySelector('select');
      return selectedSource && section?.value === 'analiz';
    })();`);
    if (formReady) break;
    await new Promise((resolveWait) => setTimeout(resolveWait, 150));
  }
  if (!formReady) fail("visible Instant Create did not retain the selected source and section before submission.");
  let submitted = false;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    submitted = await execute(sessionId, `return (() => {
      const button = [...document.querySelectorAll('button')].find((item) => item.textContent?.trim() === 'Araştırmayı başlat');
      if (!button || button.disabled) return false;
      button.click();
      return true;
    })();`);
    if (submitted) break;
    await new Promise((resolveWait) => setTimeout(resolveWait, 150));
  }
  if (!submitted) fail("visible Instant Create submit action was not enabled after valid input.");
  let instantCreateSurface;
  for (let attempt = 0; attempt < 60; attempt += 1) {
    instantCreateSurface = await execute(sessionId, `return (() => ({
      errors: [...document.querySelectorAll('[role="alert"]')].map((item) => item.textContent?.trim() ?? ''),
      primaryAction: [...document.querySelectorAll('button')].find((item) => item.textContent?.trim() === 'Araştırmayı başlat')?.disabled ?? null,
      instantPanel: document.querySelector('#content-flow-panel-instant')?.innerText?.slice(0, 480) ?? ''
    }))();`);
    const accepted = instantCreateSurface?.instantPanel?.includes('İş güvenli kuyruğa alındı.') || instantCreateSurface?.instantPanel?.includes('İş kaydedildi; Codex bağlantısı bekleniyor.');
    if (accepted) break;
    if (attempt === 59) fail(`visible Instant Create did not render either its durable-queue or its honest Codex-waiting state: ${JSON.stringify(instantCreateSurface)}`);
    await new Promise((resolveWait) => setTimeout(resolveWait, 150));
  }
  let workspace;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const response = await invoke(sessionId, "get_editorial_workspace");
    if (!response?.ok) fail(`visible Instant Create could not refresh editorial workspace: ${JSON.stringify(response)}`);
    workspace = response.result;
    const draft = workspace?.drafts?.find((item) => item?.titleTr === instruction);
    if (draft) {
      if (draft.reviewable !== false || draft.state !== "DRAFTING" || typeof draft.scheduledAt !== "string" || Number.isNaN(Date.parse(draft.scheduledAt))) {
        fail(`visible Instant Create persisted an invalid review-only NEXT_SLOT draft: ${JSON.stringify(draft)}`);
      }
      const deskOpened = await execute(sessionId, `return (() => {
        const button = [...document.querySelectorAll('button')].find((item) => item.textContent?.trim() === 'Editoryal Masada gör');
        if (!button || button.disabled) return false;
        button.click();
        return true;
      })();`);
      if (!deskOpened) fail("visible Instant Create completion could not open the Editorial Desk.");
      await waitForVisibleHeading(sessionId, "editorial");
      await refreshEditorialInventory(sessionId, instruction);
      for (let visibleAttempt = 0; visibleAttempt < 40; visibleAttempt += 1) {
        const visible = await execute(sessionId, `return document.body?.innerText?.includes(${JSON.stringify(instruction)}) ?? false;`);
        if (visible) return { draftId: draft.id, queueState: draft.state, scheduledAt: draft.scheduledAt };
        await new Promise((resolveWait) => setTimeout(resolveWait, 150));
      }
      fail("visible Instant Create draft was persisted but not rendered on the Editorial Desk.");
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 150));
  }
  fail(`visible Instant Create draft did not appear on the Editorial Desk: ${JSON.stringify(workspace?.drafts)}`);
}

async function verifyPreferencesAndScheduleJourney(sessionId) {
  const preferences = {
    author: "Native smoke editorya",
    reviewer: "Native smoke inceleyen",
    notifications: true,
    emailDigest: false,
    defaultSection: "analiz"
  };
  const savedPreferences = await invoke(sessionId, "save_desktop_preferences", { preferences });
  if (!savedPreferences?.ok || savedPreferences.result?.preferences?.author !== preferences.author) {
    fail(`desktop preferences were not accepted by the native bridge: ${JSON.stringify(savedPreferences)}`);
  }
  const savedSlot = await invoke(sessionId, "update_schedule_slot", {
    slotId: "slot-sun-1",
    enabled: true,
    time: "18:45"
  });
  if (!savedSlot?.ok || savedSlot.result?.time !== "18:45") {
    fail(`custom weekly schedule slot was not accepted by the native bridge: ${JSON.stringify(savedSlot)}`);
  }
  const workspace = await invoke(sessionId, "get_editorial_workspace");
  if (!workspace?.ok) fail(`preferences and schedule could not refresh the editorial workspace: ${JSON.stringify(workspace)}`);
  const sunday = workspace.result?.weeklySlots?.find((slot) => slot?.id === "slot-sun-1");
  if (
    workspace.result?.preferences?.author !== preferences.author ||
    workspace.result?.preferences?.defaultSection !== preferences.defaultSection ||
    sunday?.time !== "18:45" ||
    sunday?.enabled !== true
  ) {
    fail(`preferences or custom weekly schedule did not persist locally: ${JSON.stringify({ preferences: workspace.result?.preferences, sunday })}`);
  }
  return { author: preferences.author, sundayTime: sunday.time };
}

async function verifyVisibleSettingsSaveJourney(sessionId) {
  await execute(sessionId, "window.location.hash = '#settings'; window.location.reload(); return true;");
  await waitForVisibleHeading(sessionId, "settings");
  const author = "Native WebView Editorya";
  const filled = await execute(
    sessionId,
    `return (() => {
      const input = document.querySelector('input[name="author"]');
      if (!input) return false;
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
      setter?.call(input, ${JSON.stringify(author)});
      input.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    })();`
  );
  if (!filled) fail("Settings author input was not available to native smoke.");
  let clicked = false;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    clicked = await execute(sessionId, `return (() => {
      const button = [...document.querySelectorAll('button')].find((item) => item.textContent?.trim() === 'Ayarları kaydet');
      if (!button || button.disabled) return false;
      button.click(); return true;
    })();`);
    if (clicked) break;
    await new Promise((resolveWait) => setTimeout(resolveWait, 150));
  }
  if (!clicked) fail("visible Settings save action was not enabled after changing the author.");
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const saved = await execute(sessionId, "return document.body?.innerText?.includes('Masaüstü tercihleri kaydedildi.') ?? false;");
    if (saved) break;
    if (attempt === 59) fail("visible Settings save action did not render its success state.");
    await new Promise((resolveWait) => setTimeout(resolveWait, 150));
  }
  const workspace = await invoke(sessionId, "get_editorial_workspace");
  if (!workspace?.ok || workspace.result?.preferences?.author !== author) {
    fail(`visible Settings save did not persist the author preference: ${JSON.stringify(workspace)}`);
  }
  return { author };
}

async function verifyVisibleWeeklyScheduleJourney(sessionId) {
  await execute(sessionId, "window.location.hash = '#publishing'; window.location.reload(); return true;");
  await waitForVisibleHeading(sessionId, "publishing");
  const opened = await execute(sessionId, `return (() => {
    const button = [...document.querySelectorAll('button')].find((item) =>
      item.getAttribute('aria-label') === 'Pazar · 1. slot: Takvimde bu slotu düzenle'
    );
    if (!button || button.disabled) return false;
    button.click();
    return true;
  })();`);
  if (!opened) fail("Sunday weekly schedule summary was not available to native smoke.");
  let configured = false;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    configured = await execute(sessionId, `return (() => {
      const card = document.querySelector('article[aria-label="Pazar · 1. slot yayın slotu"]');
      const select = card?.querySelector('select');
      if (!card || !select) return false;
      const setValue = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set;
      setValue?.call(select, 'CUSTOM');
      select.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    })();`);
    if (configured) break;
    await wait(150);
  }
  if (!configured) fail("Sunday weekly schedule selector was not available to native smoke.");
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const updated = await execute(sessionId, `return (() => {
      const card = document.querySelector('article[aria-label="Pazar · 1. slot yayın slotu"]');
      const hour = card?.querySelector('select[aria-label="Pazar özel saat"]');
      const minute = card?.querySelector('select[aria-label="Pazar özel dakika"]');
      const save = [...(card?.querySelectorAll('button') ?? [])].find((item) => item.textContent?.trim() === 'Slotu kaydet');
      if (!hour || !minute || !save || save.disabled) return false;
      const setValue = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set;
      setValue?.call(hour, '18'); hour.dispatchEvent(new Event('change', { bubbles: true }));
      setValue?.call(minute, '45'); minute.dispatchEvent(new Event('change', { bubbles: true }));
      save.click(); return true;
    })();`);
    if (updated) break;
    await new Promise((resolveWait) => setTimeout(resolveWait, 150));
  }
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const saved = await execute(sessionId, "return document.body?.innerText?.includes('Pazar için haftalık yayın slotu güncellendi.') ?? false;");
    if (saved) break;
    if (attempt === 59) fail("visible Sunday weekly schedule save did not report success.");
    await new Promise((resolveWait) => setTimeout(resolveWait, 150));
  }
  const workspace = await invoke(sessionId, "get_editorial_workspace");
  const sunday = workspace?.result?.weeklySlots?.find((slot) => slot?.id === "slot-sun-1");
  if (!workspace?.ok || sunday?.time !== "18:45" || sunday?.enabled !== true) {
    fail(`visible Sunday weekly schedule save did not persist: ${JSON.stringify(sunday)}`);
  }
  return { sundayTime: sunday.time };
}

async function verifyOperationsJourney(sessionId) {
  const paused = await invoke(sessionId, "set_runtime_pause", { target: "ingestion", paused: true });
  if (!paused?.ok || paused.result?.paused !== true) {
    fail(`Operations could not pause source ingestion: ${JSON.stringify(paused)}`);
  }
  const pausedSnapshot = await invoke(sessionId, "get_bootstrap_snapshot");
  if (!pausedSnapshot?.ok || pausedSnapshot.result?.automation?.ingestionPaused !== true) {
    fail(`paused source ingestion was not persisted to the bootstrap snapshot: ${JSON.stringify(pausedSnapshot?.result?.automation)}`);
  }
  const resumed = await invoke(sessionId, "set_runtime_pause", { target: "ingestion", paused: false });
  if (!resumed?.ok || resumed.result?.paused !== false) {
    fail(`Operations could not resume source ingestion: ${JSON.stringify(resumed)}`);
  }
  const resumedSnapshot = await invoke(sessionId, "get_bootstrap_snapshot");
  if (!resumedSnapshot?.ok || resumedSnapshot.result?.automation?.ingestionPaused !== false) {
    fail(`resumed source ingestion was not persisted to the bootstrap snapshot: ${JSON.stringify(resumedSnapshot?.result?.automation)}`);
  }
  const diagnostics = await invoke(sessionId, "get_engine_diagnostics");
  const diagnosticText = Array.isArray(diagnostics?.result?.lines) ? diagnostics.result.lines.join("\n") : "";
  if (!diagnostics?.ok || /token|password|authorization|bearer|private.?key/iu.test(diagnosticText)) {
    fail(`engine diagnostics did not satisfy the redaction contract: ${JSON.stringify(diagnostics)}`);
  }
  const exported = await invoke(sessionId, "export_diagnostics");
  if (!exported?.ok || !Array.isArray(exported.result?.included) || !exported.result.included.includes("runtime")) {
    fail(`Operations could not create a redacted diagnostics bundle: ${JSON.stringify(exported)}`);
  }
  return { diagnosticsIncluded: exported.result.included };
}

async function verifyVisibleOperationsPauseJourney(sessionId) {
  await execute(sessionId, "window.location.hash = '#operations'; window.location.reload(); return true;");
  await waitForVisibleHeading(sessionId, "operations");
  for (const [action, expectedMessage, nextAction] of [
    ["Taramayı duraklat", "Kaynak taraması duraklatıldı.", "Taramayı sürdür"],
    ["Taramayı sürdür", "Kaynak taraması devam ettirildi.", "Taramayı duraklat"]
  ]) {
    let clicked = false;
    for (let attempt = 0; attempt < 40; attempt += 1) {
      clicked = await execute(
        sessionId,
        `return (() => {
          const button = [...document.querySelectorAll('button')].find((item) => item.textContent?.trim() === ${JSON.stringify(action)});
          if (!button || button.disabled) return false;
          button.click();
          return true;
        })();`
      );
      if (clicked) break;
      await new Promise((resolveWait) => setTimeout(resolveWait, 150));
    }
    if (!clicked) fail(`visible Operations action ${JSON.stringify(action)} was not available.`);
    for (let attempt = 0; attempt < 60; attempt += 1) {
      const state = await execute(
        sessionId,
        `return {
          message: document.body?.innerText?.includes(${JSON.stringify(expectedMessage)}) ?? false,
          nextAction: [...document.querySelectorAll('button')].some((item) => item.textContent?.trim() === ${JSON.stringify(nextAction)})
        };`
      );
      if (state?.message && state?.nextAction) break;
      if (attempt === 59) fail(`visible Operations action ${JSON.stringify(action)} did not render ${JSON.stringify(expectedMessage)}.`);
      await new Promise((resolveWait) => setTimeout(resolveWait, 150));
    }
  }
  const snapshot = await invoke(sessionId, "get_bootstrap_snapshot");
  if (!snapshot?.ok || snapshot.result?.automation?.ingestionPaused !== false) {
    fail(`visible Operations resume did not persist the expected automation state: ${JSON.stringify(snapshot)}`);
  }
  return { pausedThenResumed: true };
}

async function verifyVisibleDiagnosticsExportJourney(sessionId) {
  await waitForVisibleHeading(sessionId, "operations");
  const activityOpened = await execute(sessionId, `return (() => {
    const tab = [...document.querySelectorAll('button[role="tab"]')].find((item) => item.textContent?.trim() === 'İş günlüğü');
    if (!tab || tab.disabled) return false;
    tab.click();
    return true;
  })();`);
  if (!activityOpened) fail("visible Operations activity tab was not available to native smoke.");
  let opened = false;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    opened = await execute(sessionId, `return (() => {
      const button = [...document.querySelectorAll('button')].find((item) => item.textContent?.trim() === 'Tanılama özeti');
      if (!button || button.disabled) return false;
      button.click();
      return true;
    })();`);
    if (opened) break;
    await new Promise((resolveWait) => setTimeout(resolveWait, 150));
  }
  if (!opened) {
    const diagnostic = await execute(sessionId, `return ({
      tabs: [...document.querySelectorAll('button[role="tab"]')].map((item) => item.textContent?.trim() ?? ''),
      activeTab: document.querySelector('button[role="tab"][aria-selected="true"]')?.textContent?.trim() ?? '',
      buttons: [...document.querySelectorAll('button')].map((item) => item.textContent?.trim() ?? '').filter(Boolean).slice(-20)
    });`);
    fail(`visible diagnostics summary action was not available to native smoke: ${JSON.stringify(diagnostic)}`);
  }
  let exported = false;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    exported = await execute(sessionId, `return (() => {
      const button = [...document.querySelectorAll('button')].find((item) => item.textContent?.trim() === 'Tanılama paketi oluştur');
      if (!button || button.disabled) return false;
      button.click();
      return true;
    })();`);
    if (exported) break;
    await new Promise((resolveWait) => setTimeout(resolveWait, 150));
  }
  if (!exported) fail("visible diagnostics export action was not available to native smoke.");
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const result = await execute(sessionId, `return (() => ({
      status: document.querySelector('[role="status"]')?.textContent?.trim() ?? '',
      summary: document.querySelector('[aria-label="Tanılama özeti"]')?.textContent?.trim() ?? ''
    }))();`);
    if (result?.status.includes('Tanılama paketi hazırlandı') && result.summary && !/token|password|authorization|bearer|private.?key/iu.test(result.summary)) {
      return { exported: true, redactedSummary: true };
    }
    if (attempt === 59) fail(`visible diagnostics export did not produce a redacted package result: ${JSON.stringify(result)}`);
    await new Promise((resolveWait) => setTimeout(resolveWait, 150));
  }
}

async function verifyVisibleCandidateJournalJourney(sessionId) {
  await waitForVisibleHeading(sessionId, "operations");
  const activityOpened = await execute(sessionId, `return (() => {
    const tab = [...document.querySelectorAll('button[role="tab"]')].find((item) => item.textContent?.trim() === 'İş günlüğü');
    if (!tab || tab.disabled) return false;
    tab.click();
    return true;
  })();`);
  if (!activityOpened) fail("visible Operations activity tab was not available for candidate journal evidence.");

  for (let attempt = 0; attempt < 60; attempt += 1) {
    const event = await execute(sessionId, `return (() => {
      const row = [...document.querySelectorAll('.event-list .event-row')].find((item) =>
        item.textContent?.includes('Araştırma işi kuyruğa alındı')
      );
      return row?.textContent?.trim() ?? '';
    })();`);
    if (
      event.includes("Araştırma işi kuyruğa alındı") &&
      event.includes("Taslağı Editoryal Masa’da takip edebilirsiniz.")
    ) {
      return { candidateQueuedEvent: true, nextAction: "editorial-desk" };
    }
    if (attempt === 59) {
      fail(`native Operations journal did not explain the candidate handoff: ${JSON.stringify(event)}`);
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 150));
  }
}

async function verifyVisibleReviewEmptyJourney(sessionId) {
  await execute(sessionId, "window.location.hash = '#editorial-review'; return true;");
  await waitForVisibleHeading(sessionId, "editorial-review");
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const result = await execute(
      sessionId,
      `return (() => {
        const empty = [...document.querySelectorAll('[role="status"]')].find((item) =>
          item.textContent?.includes('İncelenecek revizyon yok.')
        );
        return {
          empty: empty?.textContent?.trim() ?? '',
          queueHeading: [...document.querySelectorAll('h1')].some((item) => item.textContent?.trim() === 'Yayın kuyruğu')
        };
      })();`
    );
    if (
      result?.queueHeading === true &&
      result.empty.includes("İncelenecek revizyon yok.") &&
      result.empty.includes("İçerik Akışı'ndan bir işi araştırmaya alın.")
    ) {
      return { emptyState: true, nextAction: "content-flow" };
    }
    if (attempt === 59) {
      fail(`native review empty state did not explain the next action: ${JSON.stringify(result)}`);
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 150));
  }
}

async function verifyPrimaryNavigationJourney(sessionId) {
  const destinations = [
    ["Genel Bakış", "#dashboard", "Yayın akışı kontrol altında."],
    ["İçerik Akışı", "#content", "Kaynaklardan yayın fikrine tek çalışma alanı."],
    ["Takvim ve Yayın", "#publishing", "Haftalık ritim, hazır çıktılar ve geçmiş."],
    ["Operasyonlar", "#operations", "İşler, Codex kapasitesi ve sistem sağlığı."]
  ];

  for (const [label, expectedHash, expectedHeading] of destinations) {
    await execute(sessionId, "window.location.hash = '#dashboard'; return true;");
    await waitForVisibleHeading(sessionId, "dashboard");
    const clicked = await execute(
      sessionId,
      `return (() => {
        const navigation = [...document.querySelectorAll('nav')].find((item) => item.getAttribute('aria-label') === 'Ana menü');
        const button = navigation
          ? [...navigation.querySelectorAll('button')].find((item) => item.getAttribute('aria-label') === ${JSON.stringify(label)})
          : undefined;
        if (!button || button.disabled) return false;
        button.click();
        return true;
      })();`
    );
    if (!clicked) fail(`primary navigation action ${JSON.stringify(label)} was unavailable.`);
    for (let attempt = 0; attempt < 60; attempt += 1) {
      const result = await execute(
        sessionId,
        `return {
          hash: window.location.hash,
          heading: document.querySelector('h1')?.textContent?.trim() ?? ''
        };`
      );
      if (result?.hash === expectedHash && result?.heading === expectedHeading) break;
      if (attempt === 59) {
        fail(`primary navigation action ${JSON.stringify(label)} did not open ${expectedHash}: ${JSON.stringify(result)}`);
      }
      await new Promise((resolveWait) => setTimeout(resolveWait, 150));
    }
  }
  return { destinations: destinations.map(([label, hash]) => ({ label, hash })) };
}

/**
 * Read the editor's existing local workspace without exposing article content,
 * URLs, credentials, or filesystem paths. This mode does not call a durable
 * write command itself, although normal engine startup may safely recover an
 * interrupted local job. It exists to distinguish an actual hand-off failure
 * from a queued/running job that is merely not explained well enough by the UI.
 */
async function inspectExistingProfileState(sessionId, localEngine) {
  const [workspaceResponse, operationsResponse, diagnosticsResponse] = await Promise.all([
    invoke(sessionId, "get_editorial_workspace", { includeCandidates: true }),
    invoke(sessionId, "get_operations"),
    invoke(sessionId, "get_engine_diagnostics")
  ]);
  if (!workspaceResponse?.ok || !operationsResponse?.ok) {
    fail(`existing-profile read failed: ${JSON.stringify({ workspace: workspaceResponse?.ok, operations: operationsResponse?.ok })}`);
  }
  const countBy = (items, field) => Object.fromEntries(
    [...new Set((items ?? []).map((item) => String(item?.[field] ?? "UNKNOWN")))].sort().map((value) => [
      value,
      (items ?? []).filter((item) => String(item?.[field] ?? "UNKNOWN") === value).length
    ])
  );  const candidateRankingScores = (workspaceResponse.result?.candidates ?? [])
    .map((candidate) => candidate?.rankingScore)
    .filter((score) => typeof score === "number" && Number.isFinite(score));
  const candidateRankingSummary = {
    listed: candidateRankingScores.length,
    distinctScores: new Set(candidateRankingScores).size,
    allScoresIdentical: candidateRankingScores.length > 1 && new Set(candidateRankingScores).size === 1
  };
  const diagnosticCodes = [...new Set((diagnosticsResponse?.result?.lines ?? []).flatMap((line) =>
    typeof line === "string"
      ? line.match(/(?:ENGINE|CODEX|QUEUE|BRIDGE)_[A-Z_]+/g) ?? []
      : []
  ))].slice(0, 20);
  // Read only aggregate editorial measures from the user's existing drafts.
  // Keeping article text, source URLs, and media bytes out of the report lets
  // the smoke test distinguish a short draft from a legacy no-media revision
  // without turning a support diagnostic into a content export.
  const reviewSummaries = await Promise.all(
    (workspaceResponse.result?.drafts ?? [])
      .filter((draft) => typeof draft?.id === "string" && draft.reviewable !== false)
      .slice(0, 12)
      .map(async (draft) => {
        const response = await invoke(sessionId, "get_review_revision", { revisionId: draft.id });
        const countWords = (value) => typeof value === "string"
          ? value.trim().split(/\s+/u).filter(Boolean).length
          : 0;
        const media = Array.isArray(response?.result?.media) ? response.result.media : [];
        return {
          id: draft.id,
          readable: response?.ok === true,
          trWords: countWords(response?.result?.tr?.bodyMarkdown),
          enWords: countWords(response?.result?.en?.bodyMarkdown),
          mediaAssets: media.length,
          heroAssets: media.filter((asset) => asset?.role === "hero").length
        };
      })
  );
  const renderedEditorial = await execute(sessionId, `
    window.location.hash = '#editorial';
    return new Promise((resolveResult) => setTimeout(() => resolveResult({
      heading: document.querySelector('h1')?.textContent?.trim() ?? '',
      draftRows: document.querySelectorAll('.draft-row').length,
      pendingRows: document.querySelectorAll('[aria-label="Araştırma kuyruğundaki taslak"]').length,
      errorAlerts: document.querySelectorAll('[role="alert"]').length
    }), 500));
  `);
  const renderedReviewMedia = await execute(sessionId, `
    window.location.hash = '#editorial-review';
    return (async () => {
      const delay = (milliseconds) => new Promise((resolveResult) => setTimeout(resolveResult, milliseconds));
      await delay(750);
      let selectedMediaRevision = false;
      // The review queue intentionally preserves legacy revisions that may not
      // have media. Exercise the visible queue until a persisted media package
      // is selected, rather than treating the default legacy row as proof that
      // a newly generated hero cannot render.
      for (const item of [...document.querySelectorAll('.review-queue-item')]) {
        item.click();
        await delay(500);
        if (document.querySelectorAll('.article-hero-media img').length > 0) {
          selectedMediaRevision = true;
          break;
        }
      }
      return {
        heroImages: document.querySelectorAll('.article-hero-media img').length,
        selectedMediaRevision,
        availablePersistedHeroPackages: ${JSON.stringify(reviewSummaries.filter((item) => item.mediaAssets > 0 && item.heroAssets > 0).length)},
        missingHeroNotices: document.querySelectorAll('[aria-label="Hero medya durumu"]').length,
        mediaRepairButtons: [...document.querySelectorAll('[aria-label="Hero medya durumu"] button')]
          .filter((button) => button.textContent?.trim() === 'Görseli hazırla').length,
        shortContentNotices: document.querySelectorAll('[aria-label="İçerik kapsamı"]').length,
        comprehensiveRewriteButtons: [...document.querySelectorAll('[aria-label="İçerik kapsamı"] button')]
          .filter((button) => button.textContent?.trim() === 'Kapsamlı yeniden oluştur').length,
        reviewLoadErrors: document.querySelectorAll('.review-loading[role="alert"]').length
      };
    })();
  `);
  return {
    mode: "actual-profile-read-only",
    localEngineReady: localEngine?.ready === true,
    candidateStates: countBy(workspaceResponse.result?.candidates, "state"),
    candidateRankingSummary,
    draftStates: countBy(workspaceResponse.result?.drafts, "state"),
    failureCount: Array.isArray(workspaceResponse.result?.failures) ? workspaceResponse.result.failures.length : 0,
    codexRoles: countBy(workspaceResponse.result?.codexRoles, "state"),
    activeDrafts: (workspaceResponse.result?.drafts ?? [])
      .filter((draft) => draft?.reviewable === false)
      .map((draft) => ({ id: draft?.id, state: draft?.state, blockers: draft?.blockers, detail: draft?.detail })),
    runtimeHealth: (workspaceResponse.result?.systemHealth ?? []).map((item) => ({
      component: item?.id,
      state: item?.state
    })),
    worker: {
      state: operationsResponse.result?.worker?.state,
      queueDepth: operationsResponse.result?.worker?.queueDepth,
      oldestJobMinutes: operationsResponse.result?.worker?.oldestJobMinutes
    },
    diagnosticSummary: {
      lineCount: Array.isArray(diagnosticsResponse?.result?.lines) ? diagnosticsResponse.result.lines.length : 0,
      bridgeError: diagnosticsResponse?.result?.bridgeError ? "present" : null,
      codes: diagnosticCodes
    },
    reviewSummaries,
    renderedEditorial,
    renderedReviewMedia
  };
}

async function verifyExistingProfileSources(sessionId) {
  const catalog = await invoke(sessionId, "list_sources");
  const sources = Array.isArray(catalog?.result?.sources) ? catalog.result.sources : [];
  const durations = [];
  let reachable = 0;
  const invalidIndexes = [];
  const unreachableIndexes = [];
  const unreachableCodes = [];
  const unreachableSources = [];

  for (const source of sources) {
    const url = typeof source?.url === "string" ? source.url : "";
    if (!url) {
      invalidIndexes.push(durations.length);
      continue;
    }
    const startedAt = performance.now();
    const result = await invoke(sessionId, "test_source", { url });
    durations.push(Math.round(performance.now() - startedAt));
    if (result?.ok === true && result.result?.reachable === true) {
      reachable += 1;
    } else {
      unreachableIndexes.push(durations.length - 1);
      const raw = typeof result?.error === "string" ? result.error : "SOURCE_TEST_FAILED";
      const code = raw.match(/[A-Z][A-Z_]{2,}/u)?.[0] ?? "SOURCE_TEST_FAILED";
      unreachableCodes.push(code);
      unreachableSources.push({
        index: durations.length - 1,
        name: typeof source?.name === "string" ? source.name.slice(0, 120) : "Adsız kaynak",
        code
      });
    }
  }

  if (invalidIndexes.length > 0) {
    fail(`actual profile source catalog has ${invalidIndexes.length}/${sources.length} invalid source URLs at catalog indexes ${invalidIndexes.join(",")}.`);
  }
  return {
    tested: sources.length,
    reachable,
    degraded: unreachableIndexes.length > 0,
    unreachableCount: unreachableIndexes.length,
    unreachableCodes,
    unreachableSources,
    maxLatencyMs: durations.length > 0 ? Math.max(...durations) : 0,
    averageLatencyMs: durations.length > 0
      ? Math.round(durations.reduce((total, value) => total + value, 0) / durations.length)
      : 0
  };
}

async function retryFirstBlockedActualDraft(sessionId) {
  await execute(sessionId, "window.location.hash = '#operations'; return true;");
  await waitForVisibleHeading(sessionId, "operations");
  const clicked = await execute(sessionId, `return (() => {
    const button = [...document.querySelectorAll('button')].find((item) =>
      item.textContent?.trim() === 'Tekrar dene' && !item.disabled
    );
    if (!button) return false;
    button.click();
    return true;
  })();`);
  if (!clicked) {
    const controls = await execute(sessionId, `return [...document.querySelectorAll('button')].map((item) => ({
      text: item.textContent?.trim() ?? '', disabled: item.disabled
    })).filter((item) => /Tekrar|Kuyruk|Editoryal/u.test(item.text));`);
    fail(`actual profile had no enabled visible retry action for a blocked draft: ${JSON.stringify(controls)}`);
  }
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const message = await execute(sessionId, "return document.querySelector('[role=status]')?.textContent?.trim() ?? document.body?.innerText?.includes('güvenli tekrar deneme kuyruğuna alındı.') ?? false;");
    if (message) return { clicked: true };
    await wait(150);
  }
  fail("actual blocked-draft retry did not acknowledge queueing in the visible UI.");
}

async function rewriteFirstShortActualDraft(sessionId) {
  await execute(sessionId, "window.location.hash = '#editorial-review'; return true;");
  await waitForVisibleHeading(sessionId, "editorial-review");
  const clicked = await execute(sessionId, `return (() => {
    const button = [...document.querySelectorAll('[aria-label="İçerik kapsamı"] button')].find((item) =>
      item.textContent?.trim() === 'Kapsamlı yeniden oluştur' && !item.disabled
    );
    if (!button) return false;
    button.click();
    return true;
  })();`);
  if (!clicked) {
    fail("actual profile had no enabled comprehensive rewrite action for a short draft.");
  }
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const queued = await execute(sessionId, `return window.location.hash === '#editorial'
      && document.body?.innerText?.includes('Kapsamlı yeniden oluşturma işleniyor') === true;`);
    if (queued) return { clicked: true, destination: "editorial" };
    await wait(150);
  }
  fail("actual short-draft rewrite did not navigate to its queued Editorial Desk row.");
}

async function main() {
  if (!Number.isSafeInteger(profileObserveMs) || profileObserveMs < 0 || profileObserveMs > 16 * 60 * 1_000) {
    fail("BLOGBOT_PROFILE_OBSERVE_MS must be an integer from 0 to 960000.");
  }
  await Promise.all([
    requireFile(tauriDriverPath, "BLOGBOT_TAURI_DRIVER"),
    requireFile(edgeDriverPath, "BLOGBOT_EDGE_DRIVER"),
    requireFile(applicationPath, "BLOGBOT_DESKTOP_EXE")
  ]);

  const smokeDataRoot = inspectExistingProfile ? undefined : await mkdtemp(join(tmpdir(), "blogbot-native-webview-"));
  webdriverUserDataFolder = smokeDataRoot ? join(smokeDataRoot, "webview2-user-data") : undefined;
  if (webdriverUserDataFolder) await mkdir(webdriverUserDataFolder, { recursive: true });
  const driver = spawn(tauriDriverPath, ["--native-driver", edgeDriverPath], {
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
    // The engine derives its durable state from LOCALAPPDATA, whereas Tauri's
    // app-data and diagnostic paths derive from APPDATA.  Keep both inside the
    // disposable smoke profile: a release verification must never add feeds,
    // drafts, settings, or logs to the editor's real workspace.
    env: smokeDataRoot
      ? {
          ...process.env,
          LOCALAPPDATA: smokeDataRoot,
          APPDATA: smokeDataRoot,
          // tauri-driver does not consistently forward WebView2's nested
          // browser arguments on Windows. This environment variable is read
          // by the WebView2 loader itself and is therefore the authoritative
          // way to keep the disposable smoke renderer off the crashing GPU
          // path.
          WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: "--disable-gpu"
        }
      : {
          ...process.env,
          WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: "--disable-gpu"
        }
  });
  let driverOutput = "";
  const appendDriverOutput = (chunk) => {
    driverOutput = `${driverOutput}${chunk.toString()}`.slice(-12_000);
  };
  driver.stdout?.on("data", appendDriverOutput);
  driver.stderr?.on("data", appendDriverOutput);
  let sessionId;

  try {
    await waitForDriver();
    sessionId = await createNativeSession();
    await setRequestedWindowRect(sessionId);
    await new Promise((resolveWait) => setTimeout(resolveWait, 2000));

    // The Tauri native driver intermittently reports an empty WebView title
    // for a live existing profile even though the native window itself has
    // the configured title. Keep title enforcement in disposable release
    // smoke, while allowing the read-only profile probe to reach its actual
    // engine and workspace checks.
    const title = inspectExistingProfile
      ? await request(`/session/${sessionId}/title`)
      : await waitForApplicationTitle(sessionId);
    await waitForTauriBridge(sessionId);

    await verifyInitialEngineSurface(sessionId);

    const localEngine = await execute(
      sessionId,
      `return window.__TAURI_INTERNALS__.invoke("test_local_engine")
        .then((result) => ({ ok: true, result }))
        .catch((error) => ({ ok: false, error: String(error) }));`
    );
    if (!localEngine?.ok || localEngine.result?.ready !== true) {
      if (process.env.BLOGBOT_RECOVER_LOCAL_WORKSPACE !== "1") {
        fail(`local engine doctor did not report READY: ${JSON.stringify(localEngine)}`);
      }
      const recovery = await execute(
        sessionId,
        `return window.__TAURI_INTERNALS__.invoke("recover_local_workspace")
          .then((result) => ({ ok: true, result }))
          .catch((error) => ({ ok: false, error: String(error) }));`
      );
      if (!recovery?.ok || recovery.result?.ready !== true) {
        fail(`local workspace recovery did not report READY: ${JSON.stringify(recovery)}`);
      }
      localEngine.ok = true;
      localEngine.result = recovery.result;
    }

    const nativeReadCommands = await verifyNativeReadCommands(sessionId);
    const catalogRead = await measureCatalogReadLatency(sessionId);
    if (inspectExistingProfile) {
      const profileRoutePerformance = [];
      for (const route of routes) {
        const { heading, routeRenderMs } = await waitForVisibleHeading(sessionId, route);
        profileRoutePerformance.push({ route, heading, routeRenderMs });
      }
      const profileSourceChecks = testExistingProfileSources
        ? await verifyExistingProfileSources(sessionId)
        : undefined;
      const codexRuntime = await verifyCodexRuntime(sessionId);
      const liveBobyReply = verifyBobyLiveReply ? await verifyLiveBobyReply(sessionId) : undefined;
      const liveUpdaterCheck = verifyUpdaterLiveCheck ? await verifyLiveUpdaterCheck(sessionId) : undefined;
      const initialProfile = await inspectExistingProfileState(sessionId, localEngine.result);
      const retryJourney = retryBlockedActualProfile
        ? await retryFirstBlockedActualDraft(sessionId)
        : undefined;
      const comprehensiveRewriteJourney = rewriteFirstShortActualProfile
        ? await rewriteFirstShortActualDraft(sessionId)
        : undefined;
      const bobyUiJourney = verifyBobyLiveReply ? await verifyVisibleBobyConversationJourney(sessionId) : undefined;
      if (profileObserveMs > 0) await wait(profileObserveMs);
      const finalProfile = profileObserveMs > 0 && !skipProfileFinalRead
        ? await inspectExistingProfileState(sessionId, localEngine.result)
        : initialProfile;
      console.log(JSON.stringify({
        status: "PASS",
        profile: finalProfile,
        initialProfile,
        finalProfile,
        skippedFinalRead: skipProfileFinalRead,
        observedForMs: profileObserveMs,
        retryJourney,
        comprehensiveRewriteJourney,
        nativeReadCommands,
        catalogRead,
        profileRoutePerformance,
        profileSourceChecks,
        codexRuntime,
        liveBobyReply,
        bobyUiJourney,
        liveUpdaterCheck
      }, null, 2));
      return;
    }
    const singleSourceAddressCheckJourney = await verifySingleSourceAddressCheckJourney(sessionId);
    const liveBobyReply = verifyBobyLiveReply ? await verifyLiveBobyReply(sessionId) : undefined;
    const liveUpdaterCheck = verifyUpdaterLiveCheck ? await verifyLiveUpdaterCheck(sessionId) : undefined;
    const candidateJourney = await verifyCandidateJourney(sessionId, singleSourceAddressCheckJourney.source);
    await request(`/session/${sessionId}`, { method: "DELETE" });
    sessionId = undefined;
    await new Promise((resolveWait) => setTimeout(resolveWait, 700));
    sessionId = await createNativeSession();
    await setRequestedWindowRect(sessionId);
    await new Promise((resolveWait) => setTimeout(resolveWait, 2000));
    await waitForTauriBridge(sessionId);
    const bobyUiJourney = verifyBobyLiveReply ? await verifyVisibleBobyConversationJourney(sessionId) : undefined;
    const { draft: recoveredDraft } = await waitForRecoveredDraft(sessionId, candidateJourney.draftId);
    await execute(sessionId, "window.location.hash = '#editorial'; return true;");
    await waitForVisibleHeading(sessionId, "editorial");
    await refreshEditorialInventory(sessionId, recoveredDraft.titleTr);
    const visibleActionMatrixJourney = await verifyVisibleActionMatrix({
      execute,
      fail,
      sessionId,
      wait,
      waitForVisibleHeading
    });
    const preferencesAndScheduleJourney = await verifyPreferencesAndScheduleJourney(sessionId);
    const visibleSettingsSaveJourney = await verifyVisibleSettingsSaveJourney(sessionId);
    const visibleWeeklyScheduleJourney = await verifyVisibleWeeklyScheduleJourney(sessionId);
    const instantCreateJourney = await verifyVisibleInstantCreateJourney(sessionId);
    const operationsJourney = await verifyOperationsJourney(sessionId);
    const visibleCandidateJournalJourney = await verifyVisibleCandidateJournalJourney(sessionId);
    const visibleDiagnosticsExportJourney = await verifyVisibleDiagnosticsExportJourney(sessionId);
    const visibleOperationsPauseJourney = await verifyVisibleOperationsPauseJourney(sessionId);
    const visibleReviewEmptyJourney = await verifyVisibleReviewEmptyJourney(sessionId);
    const setupGuideJourney = await verifySetupGuideStartsFocusedWizard(sessionId);
    const primaryNavigationJourney = await verifyPrimaryNavigationJourney(sessionId);

    const evidence = [];
    const screenshotFiles = [];
    for (const route of routes) {
      const { heading, routeRenderMs } = await waitForVisibleHeading(sessionId, route);
      await wait(150);
      const scrollPosition = await execute(
        sessionId,
        `return {
          workspaceY: document.getElementById('main-workspace')?.scrollTop ?? -1,
          workspaceX: document.getElementById('main-workspace')?.scrollLeft ?? -1,
          windowY: window.scrollY,
          windowX: window.scrollX
        };`
      );
      if (scrollPosition?.workspaceY > 1 || scrollPosition?.workspaceX > 1 || scrollPosition?.windowY > 1 || scrollPosition?.windowX > 1) {
        fail(`route #${route} retained a previous scroll position.`);
      }
      const routeLayout = await execute(
        sessionId,
        `return (() => {
          const sidebar = document.querySelector('.sidebar')?.getBoundingClientRect();
          const heading = document.querySelector('h1')?.getBoundingClientRect();
          return {
            viewportWidth: window.innerWidth,
            sidebarLeft: sidebar?.left ?? -1,
            sidebarRight: sidebar?.right ?? -1,
            headingTop: heading?.top ?? -1,
            headingLeft: heading?.left ?? -1
          };
        })();`
      );
      if (routeLayout?.sidebarLeft < -1 || routeLayout?.sidebarRight > routeLayout?.viewportWidth + 1 || routeLayout?.headingTop < -1 || routeLayout?.headingLeft < -1) {
        fail(`route #${route} rendered outside the native viewport.`);
      }
      evidence.push({ route, heading, routeRenderMs, scrollPosition, routeLayout });
      const screenshot = await captureRouteScreenshot(sessionId, route);
      if (screenshot) screenshotFiles.push(screenshot);
    }

    const publishingHeading = evidence.find((entry) => entry.route === "publishing")?.heading;
    if (
      publishingHeading !== "Haftalık ritim, hazır yayınlar ve geçmiş." &&
      publishingHeading !== "Haftalık ritim, hazır çıktılar ve geçmiş."
    ) {
      fail(`expected the Turkish publishing heading at #publishing, got ${JSON.stringify(publishingHeading)}.`);
    }
    console.log(JSON.stringify({ status: "PASS", title: title.value, localEngine: localEngine.result, liveBobyReply, bobyUiJourney, liveUpdaterCheck, nativeReadCommands, catalogRead, singleSourceAddressCheckJourney, candidateJourney, visibleActionMatrixJourney, instantCreateJourney, preferencesAndScheduleJourney, visibleSettingsSaveJourney, visibleWeeklyScheduleJourney, operationsJourney, visibleCandidateJournalJourney, visibleOperationsPauseJourney, visibleDiagnosticsExportJourney, visibleReviewEmptyJourney, setupGuideJourney, primaryNavigationJourney, screenshotFiles, routes: evidence }, null, 2));
  } catch (error) {
    const detail = driverOutput.trim();
    if (!detail) throw error;
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`${message}\nTauri driver output (last 12 KB):\n${detail}`, { cause: error });
  } finally {
    if (sessionId) {
      await fetch(`${webdriverBaseUrl}/session/${sessionId}`, { method: "DELETE" }).catch(() => undefined);
    }
    if (!driver.killed) {
      driver.kill();
      await Promise.race([once(driver, "exit"), new Promise((resolveWait) => setTimeout(resolveWait, 1000))]);
    }
    if (smokeDataRoot && keepSmokeDataRoot) {
      console.error(`Native smoke temporary profile retained: ${smokeDataRoot}`);
    } else if (smokeDataRoot) {
      await cleanupSmokeDataRoot(smokeDataRoot);
    }
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
