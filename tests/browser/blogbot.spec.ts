import { expect, test, type Page } from "@playwright/test";
import { AxeBuilder } from "@axe-core/playwright";

const surfaces = [
  ["dashboard", "Yayın akışı kontrol altında."],
  ["content", "Kaynaklardan yayın fikrine tek çalışma alanı"],
  ["content-candidates", "Kaynaklardan yayın fikrine tek çalışma alanı"],
  ["instant", "Kaynaklardan yayın fikrine tek çalışma alanı"],
  ["editorial", "Taslak, iki dil ve kanıt paketi aynı masada"],
  ["editorial-review", "Taslak, iki dil ve kanıt paketi aynı masada"],
  ["publishing", "Haftalık ritim, hazır çıktılar ve geçmiş"],
  ["operations", "İşler, Codex kapasitesi ve sistem sağlığı"],
  ["settings", "Editoryal varsayılanlar ve bildirimler"],
  ["setup", "Yerel çalışma durumu"],
  ["setup-guide", "Yerel çalışma durumu"]
] as const;

const runtimeErrors = new WeakMap<Page, string[]>();

function collectRuntimeErrors(page: Page): string[] {
  const errors: string[] = [];
  runtimeErrors.set(page, errors);
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("requestfailed", (request) => errors.push(`${request.method()} ${request.url()} ${request.failure()?.errorText ?? "failed"}`));
  page.on("response", (response) => {
    if (response.status() >= 400) errors.push(`${response.status()} ${response.url()}`);
  });
  return errors;
}

async function waitForPageTransition(page: Page): Promise<void> {
  await page.waitForFunction(() =>
    Array.from(document.querySelectorAll(".page")).every((surface) =>
      surface.getAnimations().every((animation) => animation.playState !== "running")
    )
  );
}

async function advanceSetupToTarget(page: Page): Promise<void> {
  const guideHeading = page.getByRole("heading", { name: "Bu bilgisayarı kontrol et" });
  const wizardAlreadyOpen = await guideHeading
    .waitFor({ state: "visible", timeout: 2_000 })
    .then(() => true)
    .catch(() => false);
  if (!wizardAlreadyOpen) {
    await page.getByRole("button", { name: /İlk başlangıç/u }).click();
    await expect(guideHeading).toBeVisible();
  }
  await page.getByRole("button", { name: "Codex bağlantısına devam et" }).click();
  await expect(page.getByRole("heading", { name: "Codex'i bağla ve test et" })).toBeVisible();
  await page.getByRole("button", { name: "Codex'i şimdilik atla" }).click();
  await expect(page.getByRole("heading", { name: "Çıktı klasörünü seç", exact: true })).toBeVisible();
}

async function completeEditorialApprovalAttestation(page: Page): Promise<void> {
  await page.getByRole("textbox", { name: "Sorumlu editörün adı" }).fill("Browser QA Editörü");
  const sourceRoles = page.locator('[aria-label="Kaynak rol onayları"] input[type="checkbox"]');
  const count = await sourceRoles.count();
  expect(count).toBeGreaterThan(0);
  for (let index = 0; index < count; index += 1) await sourceRoles.nth(index).check();
}

async function approveCurrentRevision(page: Page): Promise<void> {
  await completeEditorialApprovalAttestation(page);
  const approval = page.getByRole("button", { name: "Bu revizyonu onayla" });
  await expect(approval).toBeEnabled();
  await approval.click();
}

test.beforeEach(async ({ page }) => {
  collectRuntimeErrors(page);
});

test.afterEach(async ({ page }) => {
  expect(runtimeErrors.get(page) ?? []).toEqual([]);
});

test("all primary routes render without browser runtime errors", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1366, height: 768 });
  for (const [route, heading] of surfaces) {
    await page.goto(`#${route}`);
    await expect(page.getByRole("heading", { name: heading })).toBeVisible();
    await waitForPageTransition(page);
    await page.screenshot({ path: testInfo.outputPath(`${route}-1366.png`), fullPage: true });
  }
});

test("Editor Boby answers immediately in-panel without starting a queued task", async ({ page }) => {
  await page.goto("#dashboard");
  await page.getByRole("button", { name: "Editör Boby'yi aç" }).click();
  const boby = page.getByRole("dialog", { name: "Editör Boby" });
  await expect(boby).toContainText("Boby doğrudan yanıtlar ve gerekirse seni doğru yere götürür");
  await boby.getByRole("button", { name: "Kaynak ekle" }).click();
  await expect(boby).toContainText("Kaynağı İçerik Akışı'nda ekle");
  await expect(boby.getByRole("textbox", { name: "Boby'ye sor" })).toBeEnabled();
  await expect(boby).not.toContainText("Boby düşünüyor");
  await expect(boby).not.toContainText("sırada");
});

test("Editor Boby gives distinct in-panel guidance for two different questions", async ({ page }) => {
  await page.goto("#dashboard");
  await page.getByRole("button", { name: "Editör Boby'yi aç" }).click();
  const boby = page.getByRole("dialog", { name: "Editör Boby" });
  const question = boby.getByRole("textbox", { name: "Boby'ye sor" });

  await question.fill("Kaynak nasıl eklenir?");
  await boby.getByRole("button", { name: "Sor" }).click();
  await expect(boby).toContainText("Kaynağı İçerik Akışı'nda ekle");
  await expect(question).toBeEnabled();

  await question.fill("Bu konu için post hazırla");
  await boby.getByRole("button", { name: "Sor" }).click();
  await expect(boby).toContainText("Bu konu için Yeni Taslak'ta kısa editoryal talimatı ve kaynakları seç");
});

test("Boby preserves its conversation when closed and reopened after navigation", async ({ page }) => {
  await page.goto("#dashboard");
  const launcher = page.getByRole("button", { name: "Editör Boby'yi aç" });
  await launcher.click();
  const boby = page.getByRole("dialog", { name: "Editör Boby" });
  const question = boby.getByRole("textbox", { name: "Boby'ye sor" });
  await question.fill("Kaynak ekleme adımı nerede?");
  await boby.getByRole("button", { name: "Sor" }).click();
  await expect(boby).toContainText("Kaynak ekleme adımı nerede?");
  await boby.getByRole("button", { name: "Editör Boby'yi kapat" }).click();
  await page.goto("#content");
  await page.getByRole("button", { name: "Editör Boby'yi aç" }).click();
  await expect(page.getByRole("dialog", { name: "Editör Boby" })).toContainText("Kaynak ekleme adımı nerede?");
});
test("primary navigation exposes exactly the five stable workspaces", async ({ page }) => {
  const destinations = [
    ["Genel Bakış", "#dashboard", "Yayın akışı kontrol altında."],
    ["İçerik Akışı", "#content", "Kaynaklardan yayın fikrine tek çalışma alanı."],
    ["Editoryal Masa", "#editorial", "Taslak, iki dil ve kanıt paketi aynı masada."],
    ["Takvim ve Yayın", "#publishing", "Haftalık ritim, hazır çıktılar ve geçmiş."],
    ["Operasyonlar", "#operations", "İşler, Codex kapasitesi ve sistem sağlığı."]
  ] as const;

  const primaryNavigation = page.getByRole("navigation", { name: "Ana menü" });
  await page.goto("#dashboard");
  await expect(primaryNavigation.getByRole("button")).toHaveCount(destinations.length);

  for (const [label, hash, heading] of destinations) {
    await page.goto("#dashboard");
    await primaryNavigation.getByRole("button", { name: label }).click();
    await expect(page).toHaveURL(new RegExp(`${hash}$`, "u"));
    await expect(page.getByRole("heading", { name: heading })).toBeVisible();
  }
});

test("editorial deep routes activate Editoryal Masa instead of İçerik Akışı", async ({ page }) => {
  const primaryNavigation = page.getByRole("navigation", { name: "Ana menü" });

  for (const route of ["editorial", "editorial-review"]) {
    await page.goto(`#${route}`);
    await expect(primaryNavigation.getByRole("button", { name: "Editoryal Masa" })).toHaveAttribute("aria-current", "page");
    await expect(primaryNavigation.getByRole("button", { name: "İçerik Akışı" })).not.toHaveAttribute("aria-current", "page");
  }
});

test("route transitions move focus to the main workspace", async ({ page }) => {
  await page.goto("#dashboard");
  await page.getByRole("navigation", { name: "Ana menü" }).getByRole("button", { name: "Editoryal Masa" }).click();

  await expect(page).toHaveURL(/#editorial$/u);
  await expect(page.getByRole("main")).toBeFocused();

  await page.evaluate(() => {
    window.location.hash = "#content-candidates";
  });
  await expect(page).toHaveURL(/#content-candidates$/u);
  await expect(page.getByRole("main")).toBeFocused();
});

test("operational workspace copy follows the 14px body type floor", async ({ page }) => {
  for (const route of ["#dashboard", "#content", "#instant", "#setup", "#publishing"]) {
    await page.goto(route);
    await waitForPageTransition(page);
    const tooSmall = await page.locator(".app-shell").evaluate((root) =>
      [...root.querySelectorAll("p, label, button, input, select, textarea, li, dd, summary")]
        .filter((element) => {
          const text = element.textContent?.trim() ?? "";
          const style = window.getComputedStyle(element);
          const compactLabel = element.matches(".section-kicker, .status-pill, .metric-label, .eyebrow");
          return text.length > 0 && !compactLabel && style.display !== "none" && style.visibility !== "hidden" && Number.parseFloat(style.fontSize) < 14;
        })
        .map((element) => `${element.tagName.toLowerCase()}:${element.textContent?.trim().slice(0, 60)}`)
    );
    expect(tooSmall, `small text on ${route}`).toEqual([]);
  }
});

test("visible support copy and operational state labels stay readable at 13px or larger", async ({ page }) => {
  await page.goto("#content-candidates");
  const tooSmall = await page.locator(".app-shell :is(small, .state-pill, .signal-grid dt)").evaluateAll((nodes) =>
    nodes
      .filter((node) => {
        const style = window.getComputedStyle(node);
        return style.display !== "none" && style.visibility !== "hidden" && Number.parseFloat(style.fontSize) < 13;
      })
      .map((node) => ({ text: node.textContent?.trim(), fontSize: window.getComputedStyle(node).fontSize }))
  );
  expect(tooSmall).toEqual([]);
});

test("source workflow presents one simple path while keeping publication after editorial review", async ({ page }) => {
  await page.goto("#content");

  await expect(page.getByRole("region", { name: "Kaynak ekleme adımları" })).toContainText(
    "Kaynak ekle"
  );
  await expect(page.getByRole("region", { name: "Kaynak ekleme adımları" })).toContainText(
    "Tara"
  );
  await expect(page.getByRole("region", { name: "Kaynak ekleme adımları" })).toContainText(
    "Yayın yalnızca hazır taslağı inceledikten sonra başlar."
  );

  const addressCheck = page.getByRole("button", { name: "Adresi kontrol et" });
  await expect(addressCheck).toBeDisabled();
  await expect(addressCheck).toHaveAttribute("aria-describedby", "source-address-action-reason");
  await expect(page.locator("#source-address-action-reason")).toHaveText(
    "Önce kontrol etmek istediğiniz herkese açık kaynak adresini girin."
  );
});

test("source inventory status and actions remain readable", async ({ page }) => {
  await page.goto("#content");
  await expect(page.locator(".source-list .source-row").first()).toBeVisible();

  const sourceStatusAndActions = page.locator(".source-list .source-health-summary, .source-list .source-row-actions .button");
  await expect(sourceStatusAndActions).not.toHaveCount(0);
  const tooSmall = await sourceStatusAndActions.evaluateAll((nodes) =>
    nodes
      .filter((node) => {
        const style = window.getComputedStyle(node);
        const text = node.textContent?.trim() ?? "";
        return text.length > 0 && style.display !== "none" && Number.parseFloat(style.fontSize) < 13;
      })
      .map((node) => ({ text: node.textContent?.trim(), fontSize: window.getComputedStyle(node).fontSize }))
  );

  expect(tooSmall).toEqual([]);
});

test("setup opens as focused tasks instead of one long technical form", async ({ page }) => {
  await page.goto("#setup");

  await expect(page.getByRole("heading", { name: "Ne yapmak istiyorsunuz?" })).toBeVisible();
  for (const task of [
    "İlk başlangıç",
    "Yazı üretimi hesabı",
    "Yayın bağlantısı",
    "Yedekleme ve kurtarma",
    "Tanılama ve onarım"
  ]) {
    await expect(page.locator(".setup-task-card").filter({ hasText: task })).toBeVisible();
  }
  await expect(page.getByLabel("Yeni yedekleme şifresi", { exact: false })).toBeHidden();

  await page.getByRole("button", { name: /İlk başlangıç/u }).click();
  await expect(page.getByRole("heading", { name: "İlk başlangıç" })).toBeVisible();
  await expect(page.getByRole("progressbar", { name: "İlk başlangıç ilerlemesi" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Kurulum görevlerine dön" })).toBeVisible();
});

test("prerequisite states are explicit and color-independent", async ({ page }) => {
  await page.goto("#setup");
  await page.getByRole("button", { name: /Tanılama ve onarım/u }).click();

  const cards = page.locator(".prerequisite-card");
  await expect(cards.first()).toBeVisible();
  await expect(cards.first().locator(".prerequisite-state-badge")).toBeVisible();
  await expect(cards.first().locator(".prerequisite-state-badge")).toHaveAttribute("aria-label", /Durum:/u);
  await expect(cards.locator(".prerequisite-state-badge")).not.toHaveCount(0);
  await expect(cards.first()).toHaveAttribute("data-state", /READY|MISSING|BLOCKED|ATTENTION/u);
});

test("operations health exposes a readable state for every local component", async ({ page }) => {
  await page.goto("#operations");
  await page.getByRole("tab", { name: "Yerel sistem ve bağlantılar" }).click();

  const health = page.locator(".health-list article");
  await expect(health.first()).toBeVisible();
  await expect(health.locator(".health-state")).toHaveCount(await health.count());
  await expect(health.locator(".health-state").first()).toContainText(/Hazır|Dikkat gerekli|Sorun var|Kurulmadı/u);
});

test("first-start guide uses a readable step rail and current-step panel", async ({ page }) => {
  await page.goto("#setup-guide");
  await expect(page.locator(".guided-progress")).toHaveClass(/guided-progress-shell/u);
  await expect(page.locator(".guided-setup")).toHaveClass(/guided-setup-panel/u);
  await expect(page.locator(".guided-step-state").first()).toBeVisible();
  await expect(page.getByRole("heading", { name: "Bu bilgisayarı kontrol et" })).toBeVisible();
  await expect(page.locator(".guided-progress button").first()).toHaveAttribute("aria-current", "step");
});

test("setup shows the native Windows folder path without decorative separators", async ({ page }) => {
  await page.goto("#setup");
  await advanceSetupToTarget(page);
  await page.getByRole("button", { name: "Bilgisayardan klasör seç" }).click();

  const selectedPath = page.getByRole("status").filter({ hasText: "Seçili klasör" });
  await expect(selectedPath).toContainText("C:\\OPE-Demo");
  await expect(selectedPath).not.toContainText("›");
});

test("guided setup keeps its output target in one compact final panel", async ({ page }) => {
  await page.goto("#setup");
  await advanceSetupToTarget(page);
  await page.getByRole("button", { name: "Bilgisayardan klasör seç" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Seçili klasör" })).toContainText("C:\\OPE-Demo");
  await expect(page.getByRole("button", { name: "Klasörü test et" })).toBeVisible();
  await expect(page.getByRole("button", { name: "OPE’yi bu hedefle kullan" })).toBeVisible();
});

test("guided setup names the missing activation steps before its final action is available", async ({ page }) => {
  await page.goto("#setup-guide");
  await advanceSetupToTarget(page);

  const finish = page.getByRole("button", { name: "OPE’yi bu hedefle kullan" });
  await expect(finish).toBeDisabled();
  await expect(finish).toHaveAttribute("aria-describedby", "quickstart-activation-prerequisite");
  await expect(page.getByText("Önce çıktı klasörünü seçin ve içerik değişirse yeniden onay gerektiğini onaylayın.")).toBeVisible();
});

test("representative workspaces have no automatically detectable accessibility violations", async ({ page }) => {
  for (const route of ["dashboard", "content", "editorial-review", "publishing", "setup"]) {
    await page.goto(`#${route}`);
    await waitForPageTransition(page);
    const results = await new AxeBuilder({ page }).analyze();
    expect(results.violations, `${route}: ${results.violations.map((violation) => violation.id).join(", ")}`).toEqual([]);
  }
});

test("every primary route has no automatically detectable accessibility violations", async ({ page }) => {
  // Axe scans every application surface in one browser session. The complete
  // route matrix legitimately exceeds Playwright's 30-second default on
  // slower Windows CI hosts even when every scan is clean.
  test.setTimeout(60_000);
  for (const [route] of surfaces) {
    await page.goto(`#${route}`);
    await waitForPageTransition(page);
    const results = await new AxeBuilder({ page }).analyze();
    expect(
      results.violations,
      `${route}: ${results.violations.map((violation) => violation.id).join(", ")}`
    ).toEqual([]);
  }
});

test("workspace tabs support roving keyboard focus", async ({ page }) => {
  await page.goto("#content");
  const sources = page.getByRole("tab", { name: "Kaynaklar" });
  await sources.focus();
  await page.keyboard.press("ArrowRight");
  await expect(page.getByRole("tab", { name: /Haber adayları/u })).toHaveAttribute("aria-selected", "true");
  await expect(page.getByRole("tabpanel")).toContainText(/etkin aday|Eşleşen etkin aday yok/u);
});

test("mobile utility destinations are exposed as a named navigation landmark", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("#dashboard");

  const utilityNavigation = page.getByRole("navigation", { name: "İkincil menü" });
  await expect(utilityNavigation).toBeVisible();
  await expect(utilityNavigation.getByRole("button", { name: "Ayarlar" })).toBeVisible();
  await expect(utilityNavigation.getByRole("button", { name: "Kurulum ve önkoşullar" })).toBeVisible();
  await expect(utilityNavigation.getByRole("button", { name: "OPE hakkında" })).toBeVisible();
});

test("global shortcuts do not navigate while an editor is entering form text", async ({ page }) => {
  await page.goto("#settings");
  const author = page.getByRole("textbox", { name: "Varsayılan yazar" });
  await author.focus();
  await page.keyboard.press("Control+n");

  await expect(page).toHaveURL(/#settings$/u);
  await expect(author).toBeFocused();
});

test("settings explains why the Windows autostart control is unavailable", async ({ page }) => {
  await page.goto("?state=autostart-status-failure#settings");
  const autostart = page.getByRole("checkbox", { name: /Windows ile başlat/u });

  await expect(autostart).toBeDisabled();
  await expect(page.getByText("Windows başlangıç durumu okunamadı; bu ayar güvenle değiştirilemez.")).toBeVisible();
  await expect(autostart).toHaveAttribute("aria-describedby", "autostart-status-unavailable");
});

test("settings exposes a visible reason for each disabled save action", async ({ page }) => {
  await page.goto("?state=offline#settings");

  const save = page.getByRole("button", { name: "Ayarları kaydet" });
  await expect(save).toBeDisabled();
  await expect(save).toHaveAttribute("aria-describedby", "settings-save-unavailable");
  await expect(page.getByText("Yerel çalışma alanı yeniden bağlanana kadar ayarlar değiştirilemez.")).toBeVisible();
});

test("settings save, cancel and defaults expose truthful state", async ({ page }) => {
  await page.goto("#settings");
  const cancel = page.getByRole("button", { name: "Değişiklikleri iptal et" });
  await expect(cancel).toBeDisabled();
  await expect(cancel).toHaveAttribute("title", "Kaydedilmemiş değişiklik yok.");
  const author = page.getByRole("textbox", { name: "Varsayılan yazar" });
  await author.fill("QA Editörü");
  await expect(page.getByText("Kaydedilmemiş değişiklik var.")).toBeVisible();
  await cancel.click();
  await expect(author).not.toHaveValue("QA Editörü");
  await author.fill("QA Editörü");
  const notifications = page.getByRole("checkbox", { name: /Windows bildirimleri/u });
  await notifications.uncheck();
  await expect(page.getByRole("button", { name: "Test bildirimi gönder" })).toBeDisabled();
  await notifications.check();
  await page.getByRole("combobox", { name: "Varsayılan bölüm" }).selectOption("analiz");
  await page.getByRole("button", { name: "Ayarları kaydet" }).click();
  await expect(page.getByText("Masaüstü tercihleri kaydedildi.")).toBeVisible();
  await page.getByRole("button", { name: "Test bildirimi gönder" }).click();
  await expect(page.getByRole("status")).toContainText("Windows test bildirimi gönderildi.");
  const autostart = page.getByRole("checkbox", { name: /Windows ile başlat/u });
  await autostart.check();
  await expect(page.getByRole("status")).toContainText("OPE Windows oturum açılışında başlatılacak.");
  await autostart.uncheck();
  await expect(page.getByRole("status")).toContainText("Windows başlangıcında otomatik açılma kapatıldı.");
  await page.goto("#instant");
  await expect(page.getByRole("combobox", { name: "Site bölümü" })).toHaveValue("analiz");
  await page.goto("#settings");
  await page.getByRole("button", { name: "Varsayılana dön" }).click();
  await expect(page.getByText("Varsayılanlar forma yüklendi; kalıcı olması için kaydedin.")).toBeVisible();
  await expect(page.getByRole("textbox", { name: "Varsayılan yazar" })).toHaveValue("OPE Editorya");
});

test("saved source-reference preference keeps review evidence visible beside the article", async ({ page }) => {
  await page.goto("#settings");
  const sourceReferences = page.getByRole("checkbox", { name: "Taslakta kaynak referanslarını öne çıkar" });

  await sourceReferences.uncheck();
  await page.getByRole("button", { name: "Ayarları kaydet" }).click();
  await expect(page.getByText("Masaüstü tercihleri kaydedildi.")).toBeVisible();
  await page.goto("#editorial-review");
  await expect(page.getByRole("region", { name: "Taslak kaynak referansları" })).toHaveCount(0);

  await page.goto("#settings");
  await sourceReferences.check();
  await page.getByRole("button", { name: "Ayarları kaydet" }).click();
  await expect(page.getByText("Masaüstü tercihleri kaydedildi.")).toBeVisible();

  await page.goto("#editorial-review");
  const references = page.getByRole("region", { name: "Taslak kaynak referansları" });
  await expect(references).toBeVisible();
  await expect(references.getByRole("link", { name: /Birincil kaynak · Uygulama rehberi/i })).toHaveAttribute("href", "https://example.org/guides/primary");
  await expect(references.getByText(/Kaynak kontrolünde eşleşmeleri incele/i)).toBeVisible();
});

test("notification test waits until a changed notification preference is saved", async ({ page }) => {
  await page.goto("#settings");
  const notifications = page.getByRole("checkbox", { name: /Windows bildirimleri/u });
  const testNotification = page.getByRole("button", { name: "Test bildirimi gönder" });

  await notifications.uncheck();
  await page.getByRole("button", { name: "Ayarları kaydet" }).click();
  await expect(testNotification).toBeDisabled();

  await notifications.check();
  await expect(testNotification).toBeDisabled();
  await expect(testNotification).toHaveAttribute("title", "Bildirim tercihini önce kaydedin.");

  await page.getByRole("button", { name: "Ayarları kaydet" }).click();
  await expect(testNotification).toBeEnabled();
});

test("weekly calendar lets every day use a preset or an explicit custom publishing time", async ({ page }) => {
  await page.goto("#publishing");
  const monday = page.getByRole("article", { name: "Pazartesi · 1. slot yayın slotu" });
  const timeChoice = monday.getByRole("combobox", { name: "Pazartesi yayın saati seçimi" });

  await timeChoice.selectOption("18:30");
  await monday.getByRole("button", { name: "Slotu kaydet" }).click();
  await expect(page.getByText("Pazartesi için haftalık yayın slotu güncellendi.")).toBeVisible();

  await timeChoice.selectOption("CUSTOM");
  await monday.getByRole("combobox", { name: "Pazartesi özel saat" }).selectOption("17");
  await monday.getByRole("combobox", { name: "Pazartesi özel dakika" }).selectOption("15");
  await expect(monday.getByText("17:15", { exact: true })).toBeVisible();
  await monday.getByRole("button", { name: "Slotu kaydet" }).click();
  await expect(page.getByText("Pazartesi için haftalık yayın slotu güncellendi.")).toBeVisible();
});

test("weekly calendar keeps legacy assignments visible without a separate SEO recommendation action", async ({ page }) => {
  await page.goto("#publishing");
  await expect(page.getByRole("button", { name: "Dengeli SEO saatlerini öner" })).toHaveCount(0);

  await page.getByRole("button", { name: "Perşembe · 1. slot: Takvimde bu slotu düzenle" }).click();
  const thursday = page.getByRole("article", { name: "Perşembe · 1. slot yayın slotu" });
  await expect(thursday.getByText(/Geçmiş atama: Ekipler için uygulama kontrol listesi\. Bu bilgi yeni planlama yapmaz\./u)).toBeVisible();
  await expect(thursday.getByRole("combobox", { name: "Perşembe paylaşılacak onaylı post" })).toHaveCount(0);
});

test("weekly slot controls stay inside their cards at supported widths", async ({ page }) => {
  for (const viewport of [
    { width: 1440, height: 900 },
    { width: 1366, height: 768 },
    { width: 1101, height: 768 },
    { width: 960, height: 680 },
    { width: 390, height: 844 }
  ]) {
    await page.setViewportSize(viewport);
    await page.goto("#publishing");
    const escaped = await page.locator(".slot-card").evaluateAll((cards) => cards.flatMap((card) => {
      const cardRect = card.getBoundingClientRect();
      return [...card.querySelectorAll("select, input, button")].flatMap((control) => {
        const rect = control.getBoundingClientRect();
        return rect.left < cardRect.left - 1 || rect.right > cardRect.right + 1
          ? [`${control.tagName}:${rect.left}-${rect.right}/${cardRect.left}-${cardRect.right}`]
          : [];
      });
    }));
    expect(escaped, `slot overflow at ${viewport.width}px`).toEqual([]);
  }
});

test("publishing refreshes calendar and connector state from the local engine", async ({ page }) => {
  await page.goto("#publishing");
  await page.getByRole("button", { name: "Takvim durumunu yenile" }).click();
  await expect(page.getByText("Takvim ve yayın durumu yerel veriden yenilendi.", { exact: true })).toBeVisible();
});

test("editorial desk refreshes its draft inventory from the local engine", async ({ page }) => {
  await page.goto("#editorial");
  await page.getByRole("button", { name: "Taslak envanterini yenile" }).click();
  await expect(page.getByRole("status")).toContainText("Taslak envanteri yerel veriden yenilendi.");
});

test("offline publishing explains why weekly schedule controls are unavailable", async ({ page }) => {
  await page.goto("?state=offline#publishing");
  const monday = page.getByRole("article", { name: "Pazartesi · 1. slot yayın slotu" });
  const save = monday.getByRole("button", { name: "Slotu kaydet" });
  await expect(save).toBeDisabled();
  await expect(save).toHaveAttribute("aria-describedby", "slot-action-unavailable-slot-mon-1");
  await expect(monday.getByText("Yerel çalışma alanı yeniden bağlanana kadar bu slot değiştirilemez.")).toBeVisible();
  await expect(page.getByText("Takvim ayarları yerel çalışma alanı yeniden bağlanana kadar salt okunur.", { exact: true })).toBeVisible();
});

test("source catalog refreshes live data and explains publication readiness without a misleading approval", async ({ page }) => {
  await page.goto("#content");
  const source = page.getByRole("article", { name: "Proje duyuruları (örnek) kaynak durumu" });
  await expect(source.getByText("Araştırma kullanımı için karar bekliyor")).toBeVisible();
  await expect(source.getByText(/Kaynak taranabilir/u)).toBeVisible();

  await page.getByRole("button", { name: "Yenile" }).click();
  await expect(page.getByText("Kaynak envanteri yenilendi.")).toBeVisible();
});

test("a delayed automatic source refresh cannot overwrite a newer user refresh", async ({ page }) => {
  await page.goto("?state=source-refresh-race#content");
  const source = page.getByRole("article", { name: "Proje duyuruları (örnek) kaynak durumu" });

  const refresh = page.getByRole("button", { name: "Yenile" });
  await expect(refresh).toBeVisible();
  await page.waitForFunction(() => document.documentElement.dataset.qaSourceRefreshStarted === "true");
  await refresh.click();
  await expect(source).toBeVisible();
  await page.waitForTimeout(120);
  await expect(source).toBeVisible();
});

test("source review distinguishes evidence eligibility from a later article approval", async ({ page }) => {
  await page.goto("#content");
  const details = page.locator("details.source-policy-details");
  await expect(details.locator("summary")).toContainText("Kaynak güveni ve kullanım hakkı");
  await details.locator("summary").click();
  await expect(details.getByText(/Makale onayı yalnız Editoryal Masa/u)).toBeVisible();
  await expect(details.locator("summary")).not.toContainText("Kaynak güvenliği ve yayın izni");
});

test("source review saves separate trust and rights decisions without publishing", async ({ page }) => {
  await page.goto("#content");
  const source = page.getByRole("article", { name: "Proje duyuruları (örnek) kaynak durumu" });
  await source.getByRole("button", { name: "Araştırma kullanımını değerlendir" }).click();

  const review = page.getByRole("region", { name: "Proje duyuruları (örnek) kaynak incelemesi" });
  await expect(review.getByRole("heading", { name: "Proje duyuruları (örnek)" })).toBeFocused();
  await review.getByRole("combobox", { name: "Güven değerlendirmesi" }).selectOption("APPROVED");
  await review.getByRole("combobox", { name: "Kullanım hakkı değerlendirmesi" }).selectOption("REJECTED");
  await review.getByRole("textbox", { name: "İnceleme gerekçesi" }).fill("Yayıncının yeniden kullanım koşulları doğrulanamadı.");
  await review.getByRole("button", { name: "Araştırma kullanım kararını kaydet" }).click();

  await expect(page.getByText("Kaynak incelemesi yerel kayda işlendi. Bu işlem revizyon veya yayın onayı vermez.")).toBeVisible();
  await expect(source.getByText("Kanıt olarak kullanılamaz")).toBeVisible();
});

test("source details and cancelled review remain local, visible, and non-mutating", async ({ page }) => {
  await page.goto("#content");
  const source = page.getByRole("article", { name: "Proje duyuruları (örnek) kaynak durumu" });

  await source.getByRole("button", { name: "Proje duyuruları (örnek) kaynak ayrıntılarını göster" }).click();
  const notice = page.locator(".inline-notice[role='status']");
  await expect(notice).toContainText("https://example.org/updates/");
  await expect(notice).toContainText("Bu bir makale/yayın onayı değildir.");

  await source.getByRole("button", { name: "Araştırma kullanımını değerlendir" }).click();
  const review = page.getByRole("region", { name: "Proje duyuruları (örnek) kaynak incelemesi" });
  await review.getByRole("textbox", { name: "İnceleme gerekçesi" }).fill("Bu geçici inceleme kaydedilmemelidir.");
  await review.getByRole("button", { name: "İptal" }).click();
  await expect(review).toHaveCount(0);
  await expect(source.getByText("Araştırma kullanımı için karar bekliyor")).toBeVisible();
});

test("instant create shows source evidence readiness before selection", async ({ page }) => {
  await page.goto("#instant");
  const pendingSource = page.getByRole("checkbox", {
    name: /Proje duyuruları \(örnek\).*Değerlendirme bekliyor; araştırmada kullanılabilir/u
  });
  await expect(pendingSource).toBeVisible();
  await pendingSource.check();
  await expect(page.getByRole("note")).toContainText("Seçtiğiniz 1 kaynak yayın kanıtı olmadan önce değerlendirilmelidir");
});

test("instant create explains the local visual fallback when ImageGen is unavailable", async ({ page }) => {
  await page.goto("#instant");
  await page.locator("details.optional-controls > summary").click();

  await expect(page.getByRole("combobox", { name: "Görsel yaklaşımı" })).toHaveValue("GENERATE");
  await expect(page.locator("#instant-visual-policy-hint")).toHaveText(
    "Önce ImageGen denenir; kullanılamazsa veya üretim başarısız olursa yerel oluşturucu metinsiz kapak ve üç yayın oranı üretir."
  );
});

test("dashboard refreshes the complete local workspace snapshot on demand", async ({ page }) => {
  await page.goto("#dashboard");

  await page.getByRole("button", { name: "Çalışma alanını yenile" }).click();
  await expect(page.getByText("Çalışma alanı yerel veriden yenilendi.")).toBeVisible();
});

test("dashboard work and navigation actions open their named destinations", async ({ page }) => {
  for (const [action, destination, heading] of [
    ["Anlık içerik oluştur", "#instant", "Kaynaklardan yayın fikrine tek çalışma alanı."],
    ["Tüm kuyruğu aç", "#editorial-review", "Taslak, iki dil ve kanıt paketi aynı masada."],
    ["Yayın takvimini aç", "#publishing", "Haftalık ritim, hazır çıktılar ve geçmiş."],
    ["Ayrıntılar", "#operations", "İşler, Codex kapasitesi ve sistem sağlığı."]
  ] as const) {
    await page.goto("#dashboard");
    await page.getByRole("button", { name: action }).click();
    await expect(page).toHaveURL(new RegExp(`${destination.replace("#", "#")}$`, "u"));
    await expect(page.getByRole("heading", { name: heading })).toBeVisible();
  }
});

test("dashboard surfaces one next task before system detail and routes it to the actionable desk", async ({ page }) => {
  await page.goto("#dashboard");

  await expect(page.getByText("ŞİMDİ YAPILACAK", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Bu işi aç" }).click();
  await expect(page).toHaveURL(/#editorial$/u);
});

test("dashboard priority rows route each work type to its actionable workspace", async ({ page }) => {
  for (const [work, route, heading] of [
    ["Örnek analiz paketini incele", "#editorial", "Taslak, iki dil ve kanıt paketi aynı masada."],
    ["Yeni adayın bölümünü belirle", "#content-candidates", "Kaynaklardan yayın fikrine tek çalışma alanı."],
    ["Örnek rehberi yayın öncesi kontrol", "#publishing", "Haftalık ritim, hazır çıktılar ve geçmiş."]
  ] as const) {
    await page.goto("#dashboard");
    await page.getByRole("button", { name: work }).click();
    await expect(page).toHaveURL(new RegExp(`${route}$`, "u"));
    await expect(page.getByRole("heading", { name: heading })).toBeVisible();
  }
});

test("operations refreshes runtime, queue and connector evidence together", async ({ page }) => {
  await page.goto("#operations");

  await page.getByRole("button", { name: "Operasyon durumunu yenile" }).click();
  await expect(page.getByText("Operasyon durumu yerel veriden yenilendi.")).toBeVisible();
});

test("operations makes a queued candidate draft visible and opens it on the editorial desk", async ({ page }) => {
  await page.goto("#content-candidates");
  await page.getByRole("button", { name: "Araştırmaya al" }).first().click();
  await expect(page.getByRole("heading", { name: "Taslak, iki dil ve kanıt paketi aynı masada." })).toBeVisible();

  await page.getByRole("button", { name: "Operasyonlar", exact: true }).click();
  await expect(page.getByRole("heading", { name: "İşler, Codex kapasitesi ve sistem sağlığı." })).toBeVisible();
  const activeWork = page.getByRole("article", { name: "Devam eden taslak işi" }).first();
  await expect(activeWork).toContainText("Araştırma güvenli yerel kuyruğa alındı.");
  await activeWork.getByRole("button", { name: "Editoryal Masa’da aç" }).click();
  await expect(page.getByRole("heading", { name: "Taslak, iki dil ve kanıt paketi aynı masada." })).toBeVisible();
});

test("hash navigation opens the candidate tab before a user starts research", async ({ page }) => {
  await page.goto("#content");
  await expect(page.getByRole("tab", { name: /Kaynaklar/u })).toHaveAttribute("aria-selected", "true");

  await page.evaluate(() => {
    window.location.hash = "#content-candidates";
  });

  await expect(page.getByRole("tab", { name: /Haber adayları/u })).toHaveAttribute("aria-selected", "true");
  await expect(page.getByRole("button", { name: "Araştırmaya al" }).first()).toBeVisible();
});

test("operations pause and resume update the visible local automation state", async ({ page }) => {
  await page.goto("#operations");
  await page.getByRole("tab", { name: "İş günlüğü" }).click();
  const pause = page.getByRole("button", { name: "Taramayı duraklat" });
  await pause.click();
  await expect(page.getByRole("status")).toContainText("Kaynak taraması duraklatıldı.");
  await expect(page.getByRole("button", { name: "Taramayı sürdür" })).toBeVisible();
  await expect(page.getByLabel("Yerel otomasyon durumu").getByText("Duraklatıldı", { exact: true })).toBeVisible();

  await page.getByRole("button", { name: "Taramayı sürdür" }).click();
  await expect(page.getByRole("status")).toContainText("Kaynak taraması devam ettirildi.");
  await expect(page.getByRole("button", { name: "Taramayı duraklat" })).toBeVisible();
});

test("read-only operations explains why automation controls are unavailable", async ({ page }) => {
  await page.goto("?state=offline#operations");

  const pause = page.getByRole("button", { name: "Taramayı duraklat" });
  await expect(pause).toBeDisabled();
  await expect(pause).toHaveAttribute("aria-describedby", "operations-automation-unavailable");
  await expect(page.locator("#operations-automation-unavailable")).toHaveText("Yerel çalışma alanı yeniden bağlanana kadar otomasyon değiştirilemez.");
});

test("publish-mode operations expose the real publication emergency pause", async ({ page }) => {
  await page.goto("#setup");
  await page.getByRole("button", { name: /Yayın bağlantısı: Yerel klasör, proje veya GitHub hedefini/i }).click();
  const outputTarget = page.getByTestId("setup-connector-site");
  await outputTarget.getByRole("radio", { name: /Yayındaki siteye gönder/i }).click();
  await outputTarget.getByLabel(/Proje klasörü/i).fill("C:\\Yayin-Hedefi");
  await outputTarget.getByRole("textbox", { name: "Public adres (yayın için)" }).fill("https://example.com");
  await outputTarget.getByRole("button", { name: "Bu ayarı kaydet" }).click();

  await page.goto("#operations");
  await page.getByRole("button", { name: "Yayını duraklat" }).click();
  await expect(page.getByRole("status")).toContainText("Yayın duraklatıldı.");
  await expect(page.getByRole("button", { name: "Yayını sürdür" })).toBeVisible();

  await page.getByRole("button", { name: "Yayını sürdür" }).click();
  await expect(page.getByRole("status")).toContainText("Yayın devam ettirildi.");
});

test("operations retry sends an actionable failed job back to the durable queue", async ({ page }) => {
  await page.goto("#operations");
  await page.getByRole("button", { name: "Tekrar dene" }).first().click();
  await expect(page.getByRole("status")).toContainText("İş güvenli tekrar deneme kuyruğuna alındı.");
});

test("manual-retry jobs explain why automatic retry is unavailable", async ({ page }) => {
  await page.goto("?state=manual-retry-required#operations");

  const failure = page.getByRole("article").filter({ hasText: "Elle inceleme gerektiren yayın denemesi" });
  const retry = failure.getByRole("button", { name: "Tekrar dene" });
  await expect(retry).toBeDisabled();
  await expect(retry).toHaveAttribute("title", "Bu iş otomatik tekrar için güvenli değil; önce hata ayrıntısını inceleyin.");
  const reasonId = await retry.getAttribute("aria-describedby");
  expect(reasonId).toMatch(/^retry-unavailable-/);
  await expect(failure.locator(`[id="${reasonId}"]`)).toHaveText("Bu iş otomatik tekrar için güvenli değil; önce hata ayrıntısını inceleyin.");
});

test("offline, empty, loading and fatal states are distinguishable", async ({ page }) => {
  await page.goto("?state=offline#dashboard");
  await expect(page.getByText(/salt okunur/iu)).toBeVisible();
  await page.screenshot({ path: test.info().outputPath("offline.png"), fullPage: true });

  await page.goto("?state=empty#operations");
  await expect(page.getByText("Müdahale bekleyen iş yok.")).toBeVisible();
  await page.getByRole("tab", { name: "Codex kullanım ve limit" }).click();
  await expect(page.getByText("Codex kapasite verisi alınamadı.")).toBeVisible();

  await page.goto("?state=loading");
  await expect(page.getByRole("status")).toHaveAttribute("aria-busy", "true");

  await page.goto("?state=error");
  await expect(page.getByRole("alert")).toContainText("Çalışma alanı açılamadı.");
});

test("responsive layouts keep navigation and main content reachable", async ({ page }, testInfo) => {
  for (const viewport of [
    { width: 1440, height: 900, name: "1440" },
    { width: 960, height: 680, name: "960x680" },
    { width: 390, height: 844, name: "narrow" }
  ]) {
    await page.setViewportSize(viewport);
    await page.goto("#editorial-review");
    await expect(page.getByRole("main")).toBeVisible();
    await expect(page.getByRole("button", { name: "Ayarlar" })).toBeVisible();
    await expect(page.getByRole("button", { name: /Kurulum|Önkoşulları test et/u })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    if (viewport.width === 960) {
      const approvalBounds = await page.getByRole("button", { name: "Bu revizyonu onayla" }).boundingBox();
      expect(approvalBounds).not.toBeNull();
      expect((approvalBounds?.x ?? 0) + (approvalBounds?.width ?? 0)).toBeLessThanOrEqual(viewport.width);
    }
    await page.screenshot({ path: testInfo.outputPath(`review-${viewport.name}.png`), fullPage: true });
  }
});

test("every primary workspace route avoids horizontal overflow at constrained widths", async ({ page }) => {
  for (const viewport of [
    { width: 960, height: 680 },
    { width: 390, height: 844 }
  ]) {
    await page.setViewportSize(viewport);
    for (const [route, heading] of surfaces) {
      await page.goto(`#${route}`);
      await expect(page.getByRole("main")).toBeVisible();
      await expect(page.getByRole("heading", { name: heading })).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    }
  }
});

test("critical workspaces stay operable at a 200 percent zoom equivalent", async ({ page }) => {
  await page.setViewportSize({ width: 683, height: 768 });
  for (const [route, control] of [
    ["content-candidates", "Araştırmaya al"],
    ["publishing", "Takvim durumunu yenile"],
    ["editorial-review", "Bu revizyonu onayla"]
  ] as const) {
    await page.goto(`#${route}`);
    await expect(page.getByRole("button", { name: control }).first()).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  }
});

test("review queue count never overlaps its heading at constrained desktop widths", async ({ page }) => {
  await page.setViewportSize({ width: 960, height: 680 });
  await page.goto("#editorial-review");
  const layout = await page.getByRole("complementary", { name: "İnceleme kuyruğu" }).evaluate((queue) => {
    const heading = queue.querySelector("header h1");
    const count = queue.querySelector("header > span");
    if (!(heading instanceof HTMLElement) || !(count instanceof HTMLElement)) return null;
    const headingRect = heading.getBoundingClientRect();
    const countRect = count.getBoundingClientRect();
    return { headingBottom: headingRect.bottom, countTop: countRect.top };
  });
  expect(layout).not.toBeNull();
  expect(layout!.countTop).toBeGreaterThanOrEqual(layout!.headingBottom + 4);
});

test("review state remains separate from review actions at desktop width", async ({ page }) => {
  await page.setViewportSize({ width: 1366, height: 768 });
  await page.goto("#editorial-review");
  const state = page.getByText("İnceleme bekliyor", { exact: true });
  const edit = page.getByRole("button", { name: "Düzenleme iste" });
  const bounds = await Promise.all([state.boundingBox(), edit.boundingBox()]);
  expect(bounds[0]).not.toBeNull();
  expect(bounds[1]).not.toBeNull();
  const [stateBox, editBox] = bounds as [{ x: number; y: number; width: number; height: number }, { x: number; y: number; width: number; height: number }];
  const overlaps = stateBox.x < editBox.x + editBox.width
    && stateBox.x + stateBox.width > editBox.x
    && stateBox.y < editBox.y + editBox.height
    && stateBox.y + stateBox.height > editBox.y;
  expect(overlaps).toBe(false);
});

test("offline mode disables state-changing source and settings controls", async ({ page }) => {
  await page.goto("?state=offline#content");
  await page.getByRole("textbox", { name: "Kaynak adresi" }).fill("https://example.net/feed.xml");
  await expect(page.getByRole("button", { name: "Adresi kontrol et" })).toBeDisabled();

  await page.goto("?state=offline#settings");
  await expect(page.getByRole("textbox", { name: "Varsayılan yazar" })).toBeDisabled();
  await expect(page.getByRole("checkbox", { name: /Windows ile başlat/u })).toBeDisabled();
  await expect(page.getByRole("checkbox", { name: /Windows bildirimleri/u })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Test bildirimi gönder" })).toBeDisabled();
});

test("read-only candidate actions explain why research cannot start", async ({ page }) => {
  await page.goto("?state=offline#content-candidates");

  const candidate = page.getByRole("article").filter({ has: page.getByRole("button", { name: "Araştırmaya al" }) }).first();
  const research = candidate.getByRole("button", { name: "Araştırmaya al" });
  await expect(research).toBeDisabled();
  await expect(research).toHaveAttribute("aria-describedby", /candidate-action-unavailable-/u);
  const reason = candidate.getByText("Yerel çalışma alanı yeniden bağlanana kadar araştırma başlatılamaz.");
  await expect(reason).toBeVisible();
  expect(await reason.evaluate((element) => Number.parseFloat(window.getComputedStyle(element).fontSize))).toBeGreaterThanOrEqual(14);
});

test("offline setup keeps diagnostics available but locks every state-changing setup action", async ({ page }) => {
  await page.goto("?state=offline#setup");

  await expect(page.getByRole("status").filter({ hasText: "Kurulum değişiklikleri yerel çalışma alanı yeniden bağlanana kadar salt okunur." })).toBeVisible();
  await page.getByRole("button", { name: "İlk başlangıç" }).click();
  await page.getByRole("button", { name: "Codex bağlantısına devam et" }).click();
  await expect(page.getByRole("button", { name: "Giriş penceresini aç" })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Durumu yenile" })).toBeEnabled();
});

test("guided setup shows local readiness without turning it into a blocking wizard gate", async ({ page }) => {
  await page.goto("#setup");

  await page.getByRole("button", { name: "İlk başlangıç" }).click();
  await expect(page.getByRole("heading", { name: "Bu bilgisayarı kontrol et" })).toBeVisible();
  await expect(page.locator(".guided-step-state").first()).toBeVisible();
  await expect(page.getByRole("button", { name: "Codex bağlantısına devam et" })).toBeEnabled();
});

test("guided setup keeps final activation disabled until an output folder and approval are provided", async ({ page }) => {
  await page.goto("#setup");
  await advanceSetupToTarget(page);
  const activation = page.getByRole("button", { name: "OPE’yi bu hedefle kullan" });
  await expect(activation).toBeDisabled();
  await expect(page.locator("#quickstart-activation-prerequisite")).toContainText("Önce çıktı klasörünü seçin");
});

test("guided setup back control returns to the previous focused step", async ({ page }) => {
  await page.goto("#setup");
  await page.getByRole("button", { name: "İlk başlangıç" }).click();
  await expect(page.getByRole("heading", { name: "Bu bilgisayarı kontrol et" })).toBeVisible();
  await page.getByRole("button", { name: "Codex bağlantısına devam et" }).click();
  await expect(page.getByRole("heading", { name: "Codex'i bağla ve test et" })).toBeVisible();
  await page.getByRole("button", { name: "Geri" }).click();
  await expect(page.getByRole("heading", { name: "Bu bilgisayarı kontrol et" })).toBeVisible();
  await expect(page.getByRole("progressbar", { name: "İlk başlangıç ilerlemesi" })).toHaveAttribute("aria-valuenow", "1");
});

test("guided setup never offers destructive workspace recovery after an engine timeout", async ({ page }) => {
  await page.goto("?state=engine-timeout#setup");
  await page.locator(".setup-task-card").filter({ hasText: "Tanılama ve onarım" }).click();
  await page.getByRole("button", { name: "Yerel bileşeni test et" }).click();

  await expect(page.getByRole("button", { name: "Yeni yerel çalışma alanıyla kurtar" })).toHaveCount(0);
  await expect(page.getByRole("status")).toContainText("yerel çalışma bileşeni");
});

test("engine timeout keeps diagnostics available without offering workspace replacement", async ({ page }) => {
  await page.goto("?state=recovery-postsuccess-refresh-failure#setup");
  await page.locator(".setup-task-card").filter({ hasText: "Tanılama ve onarım" }).click();
  await page.getByRole("button", { name: "Yerel bileşeni test et" }).click();

  await expect(page.getByRole("button", { name: "Tanı paketi oluştur" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Yeni yerel çalışma alanıyla kurtar" })).toHaveCount(0);
});

test("instant create validation identifies and focuses the first invalid field", async ({ page }) => {
  await page.goto("#instant");
  await page.getByRole("button", { name: "Araştırmayı başlat" }).click();
  const instruction = page.getByRole("textbox", { name: "Ne oluşturmak istiyorsunuz?" });
  await expect(instruction).toBeFocused();
  await expect(instruction).toHaveAttribute("aria-invalid", "true");
  await expect(instruction).toHaveAttribute("aria-describedby", "instant-error-instruction");
  await expect(page.getByText("En az bir kayıtlı kaynak veya URL ekleyin.")).toBeVisible();
  await expect(page.getByRole("combobox", { name: "Site bölümü" })).toHaveValue("haberler");
});

test("single source address check performs the technical test before the source is persisted", async ({ page }) => {
  await page.goto("#content");
  await page.getByRole("textbox", { name: "Kaynak adresi" }).fill("https://new.example.org/feed.xml");
  await page.getByRole("button", { name: "Adresi kontrol et" }).click();
  await expect(page.getByRole("heading", { name: "1 kaynak eklenmeye hazır" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Yeniden test et", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Tümünü izlemeye al" }).click();
  await expect(page.getByText(/izlemeye alındı/u)).toBeVisible();
});

test("idempotent source replay updates the existing catalog row instead of duplicating it", async ({ page }) => {
  await page.goto("?state=source-idempotent-replay#content");
  await page.getByRole("textbox", { name: "Kaynak adresi" }).fill("https://example.org/updates/");
  await page.getByRole("button", { name: "Adresi kontrol et" }).click();
  await page.getByRole("button", { name: "Tümünü izlemeye al" }).click();

  await expect(page.getByRole("article", { name: "Proje duyuruları (örnek) kaynak durumu" })).toHaveCount(1);
});

test("backup setup guides the user through picker-backed create, verify, preview, and confirmed new-folder restore", async ({ page }) => {
  await page.goto("#setup");
  await page.getByRole("button", { name: /Yedekleme ve kurtarma/u }).click();

  await page.locator("label:has(#backup-source-directory)").getByRole("button", { name: "Bilgisayardan klasör seç" }).click();
  await page.locator("label:has(#backup-output-path)").getByRole("button", { name: "Yedek klasörü seç" }).click();
  await page.getByLabel("Alınacak dosyalar").fill("state.json");
  await page.getByLabel(/Yedekleme şifresi/u).fill("yerel-yedek-anahtari-123");
  await page.getByRole("button", { name: "Şifreli yedek oluştur" }).click();
  await expect(page.getByText("Yedek oluşturuldu: 0 dosya, 0 bayt.", { exact: true })).toBeVisible();

  await page.locator("label:has(#backup-archive-path)").getByRole("button", { name: "Yedek klasörü seç" }).click();
  await page.locator("label:has(#backup-target-parent)").getByRole("button", { name: "Üst klasörü seç" }).click();
  await page.getByLabel(/Yedekleme şifresi/u).fill("yerel-yedek-anahtari-123");
  await page.getByRole("button", { name: "Yedeği doğrula" }).click();
  await expect(page.getByText("Yedek doğrulandı: 0 dosya.", { exact: true })).toBeVisible();

  await page.getByLabel(/Yedekleme şifresi/u).fill("yerel-yedek-anahtari-123");
  await page.getByRole("button", { name: "Şifreli yedek geri yüklemesini önizle" }).click();
  await expect(page.getByText("Geri yükleme önizlemesi hazır: 0 dosya; hiçbir dosya yazılmadı.", { exact: true })).toBeVisible();

  await page.getByLabel(/Yedekleme şifresi/u).fill("yerel-yedek-anahtari-123");
  await page.getByRole("button", { name: "Yeni klasöre geri yükle" }).click();
  const restoreConfirmation = page.getByRole("alertdialog", { name: "Geri yüklemeyi onayla" });
  await expect(restoreConfirmation).toContainText("Yalnızca boş ve yeni bir klasöre geri yükleme yapılacak.");
  await restoreConfirmation.getByRole("button", { name: "Geri yüklemeyi başlat" }).click();
  await expect(page.getByText("Geri yükleme tamamlandı: 0 dosya yeni klasöre çıkarıldı. Aktif çalışma alanı değiştirilmedi.", { exact: true })).toBeVisible();
});

test("automatic snapshot restore previews and explicitly replaces the live local database", async ({ page }) => {
  await page.goto("#setup");
  await page.getByRole("button", { name: /Yedekleme ve kurtarma/u }).click();

  await page.getByRole("button", { name: "Snapshot'ları yenile" }).click();
  await expect(page.getByText("1 yerel kurtarma snapshot'ı hazır.", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Snapshot'ı doğrula" }).click();
  await expect(page.getByText("Yerel kurtarma snapshot'ı doğrulandı: 2 tablo ve 3 satır.", { exact: true })).toBeVisible();

  await page.getByRole("button", { name: "Yerel snapshot geri yüklemesini önizle" }).click();
  await expect(page.getByText("Geri yükleme önizlemesi hazır: 2 tablo ve 3 satır mevcut yerel verinin yerini alacak; henüz hiçbir veri değiştirilmedi.", { exact: true })).toBeVisible();

  await page.getByRole("button", { name: "Yerel veriyi geri yükle" }).click();
  const confirmation = page.getByRole("alertdialog", { name: "Yerel verinin değiştirilmesini onayla" });
  await expect(confirmation).toContainText("mevcut OPE yerel verisinin tamamının yerini alacak");
  await confirmation.getByRole("button", { name: "Yerel veriyi geri yükle" }).click();
  await expect(page.getByText("Yerel çalışma alanı geri yüklendi: 3 satır snapshot verisiyle değiştirildi.", { exact: true })).toBeVisible();
});

test("scanning sources makes queued research visible on the editorial desk before review is available", async ({ page }) => {
  await page.goto("#content");
  await page.getByRole("button", { name: "Tümünü tara" }).click();
  await expect(page.getByText("2 kaynak tarandı; 1 yeni haber adayı bulundu.")).toBeVisible();
  await expect(page.getByRole("progressbar", { name: "Kaynak tarama ilerlemesi" })).toHaveAttribute("aria-valuenow", "2");
  await page.getByRole("tab", { name: /Haber adayları/u }).click();
  await expect(page.getByRole("heading", { name: "Yerel tarama sonucu: yeni haber" })).toBeVisible();
  await page.getByRole("button", { name: "Araştırmaya al" }).last().click();
  await expect(page.getByRole("heading", { name: "Taslak, iki dil ve kanıt paketi aynı masada." })).toBeVisible();
  await expect(page.getByRole("status")).toContainText("araştırma için yerel kuyruğa alındı");
  await expect(page.getByRole("status")).toContainText("Editoryal Masa");
  const queuedDraft = page.getByRole("button", { name: /Kuyrukta$/u }).first();
  await expect(queuedDraft).toBeVisible();
  await expect(queuedDraft.getByLabel("İlerleme yüzdesi henüz ölçülmedi")).toBeVisible();
  await expect(queuedDraft.getByLabel(/Yüzde .* tamamlandı/u)).toHaveCount(0);
});

test("editorial desk refreshes an active draft when the local engine changes its phase", async ({ page }) => {
  await page.goto("?state=live-draft-refresh#editorial");
  const draft = page.getByRole("button", { name: /Bir hizmetin sınırlarını daraltmak/u });
  await expect(draft).toContainText("Kuyrukta");
  await expect(draft).toContainText("İnceleme bekliyor", { timeout: 8_000 });
  await expect(draft).toContainText("TR / EN incelemesine hazır.");
});

test("a queued candidate offers a direct return to its editorial desk", async ({ page }) => {
  await page.goto("#content-candidates");
  await page.getByRole("button", { name: "Araştırmaya al" }).first().click();
  await expect(page.getByRole("heading", { name: "Taslak, iki dil ve kanıt paketi aynı masada." })).toBeVisible();

  await page.goto("#content-candidates");
  const followUp = page.getByRole("button", { name: "Editoryal Masa’da takip et" }).first();
  await expect(followUp).toBeEnabled();
  await followUp.click();
  await expect(page.getByRole("heading", { name: "Taslak, iki dil ve kanıt paketi aynı masada." })).toBeVisible();
  await expect(page.getByRole("status")).toContainText("Yerel kuyruktaki taslak masa envanterine eklendi.");
});

test("a failed candidate research job explains why the editorial desk is empty and opens Operations", async ({ page }) => {
  await page.goto("?state=candidate-draft-failed#content-candidates");
  await expect(page.getByText("Araştırma başarısız", { exact: true })).toBeVisible();
  await expect(page.getByText(/Nedeni ve güvenli tekrar seçeneğini Operasyonlar’dan açın/u)).toBeVisible();
  await page.getByRole("button", { name: "Operasyonlarda hatayı aç" }).click();
  await expect(page).toHaveURL(/#operations$/u);
  await expect(page.getByRole("heading", { name: "İşler, Codex kapasitesi ve sistem sağlığı." })).toBeVisible();
});

test("failed candidate guidance does not overlap its primary-source detail", async ({ page }) => {
  await page.goto("?state=candidate-draft-failed#content-candidates");
  const failedCandidate = page.locator(".candidate-card").filter({
    has: page.getByText(/Ara.t.rma ba.ar.s.z/u)
  });
  const source = failedCandidate.getByText(/Birincil kaynak:/u);
  const guidance = page.getByText(/Nedeni ve güvenli tekrar seçeneğini Operasyonlar’dan açın/u);

  const [sourceBox, guidanceBox] = await Promise.all([source.boundingBox(), guidance.boundingBox()]);
  expect(sourceBox).not.toBeNull();
  expect(guidanceBox).not.toBeNull();
  expect(
    sourceBox!.y + sourceBox!.height <= guidanceBox!.y || guidanceBox!.y + guidanceBox!.height <= sourceBox!.y,
    "candidate source and recovery guidance must occupy separate visual rows"
  ).toBe(true);
});

test("candidate triage explains that drafting is local and publication follows review", async ({ page }) => {
  await page.goto("#content-candidates");

  await expect(page.getByText("Araştırmaya almak yerel kuyruğu başlatır; hemen yayın yapmaz.")).toBeVisible();
  await expect(page.getByText("Yayın yalnızca hazır taslağı inceledikten sonra başlar; insan onayı olmadan hiçbir içerik gönderilmez.")).toBeVisible();
});

test("candidate triage presents a simple priority, source date, and accessible bulk selection", async ({ page }) => {
  await page.goto("#content-candidates");
  const candidate = page.locator(".candidate-card").filter({
    has: page.getByRole("heading", { name: "Resmî kurum yeni bir duyuru yayımladı" })
  });

  await expect(candidate.getByText("İnceleme önceliği: 92%", { exact: true })).toBeVisible();
  await expect(candidate.getByText(/3 kaynak/u)).toBeVisible();
  await expect(candidate.getByRole("checkbox", { name: /adayını seç/u })).toBeVisible();
  await expect(page.getByRole("button", { name: "Görünenleri seç" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Seçimi temizle" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Seçilmiş adayları araştır" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Seçilenleri kapat" })).toBeVisible();
});

test("bulk research accepts every eligible selected candidate into the local queue", async ({ page }) => {
  await page.goto("#content-candidates");

  const selectable = page.getByRole("checkbox", { name: /adayını seç/u });
  const eligibleCount = await selectable.count();
  expect(eligibleCount).toBeGreaterThan(0);

  await page.getByRole("button", { name: "Görünenleri seç" }).click();
  await expect(page.getByText(`${eligibleCount} aday seçildi`, { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Seçilmiş adayları araştır" }).click();

  await expect(page.getByText(`${eligibleCount} aday araştırma kuyruğuna alındı.`, { exact: true })).toBeVisible();
  await expect(page.getByText("0 aday seçildi", { exact: true })).toBeVisible();
  await expect(page.getByText("Araştırma kuyruğunda", { exact: true })).toHaveCount(eligibleCount);
});

test("section and article-type labels avoid mechanical duplication", async ({ page }) => {
  await page.goto("#content-candidates");

  await expect(page.getByText("Analiz · Analiz", { exact: true })).toHaveCount(0);
  await page.goto("#editorial-review");
  await expect(page.getByText("Analiz / Analiz", { exact: true })).toHaveCount(0);
});

test("queued candidate draft explains why review is locked and where to follow progress", async ({ page }) => {
  await page.goto("#content");
  await page.getByRole("button", { name: "Tümünü tara" }).click();
  await page.getByRole("tab", { name: /Haber adayları/u }).click();
  await page.getByRole("button", { name: "Araştırmaya al" }).last().click();

  await expect(page.getByRole("heading", { name: "Taslak, iki dil ve kanıt paketi aynı masada." })).toBeVisible();
  const guidance = page.getByLabel("İnceleme kilidi açıklaması");
  await expect(guidance).toContainText("İnceleme neden kapalı?");
  await expect(guidance).toContainText("Her satırda gerçek çalışma durumu ve varsa tek güvenli sonraki adım gösterilir");
  await expect(page.getByRole("button", { name: "Operasyonları aç" })).toHaveCount(0);
});

test("promoting a candidate refreshes the dashboard pipeline without requiring an app restart", async ({ page }) => {
  await page.goto("#content-candidates");
  await page.getByRole("button", { name: "Araştırmaya al" }).first().click();
  await expect(page.getByRole("heading", { name: "Taslak, iki dil ve kanıt paketi aynı masada." })).toBeVisible();

  await page.getByRole("button", { name: "Genel Bakış" }).click();
  await expect(page.getByText("Keşfedilen", { exact: true }).locator("../..")).toContainText("17");
  await expect(page.getByText("Araştırılan", { exact: true }).locator("../..")).toContainText("5");
});

test("candidate promotion stays truthful when the follow-up dashboard summary refresh fails", async ({ page }) => {
  await page.goto("?state=candidate-postpromotion-summary-failure#content-candidates");
  await page.getByRole("button", { name: "Araştırmaya al" }).first().click();

  await expect(page.getByRole("heading", { name: "Taslak, iki dil ve kanıt paketi aynı masada." })).toBeVisible();
  await expect(page.getByRole("status")).toContainText("araştırma için yerel kuyruğa alındı");
  await expect(page.getByRole("status")).toContainText("Genel Bakış sayaçları henüz yenilenemedi");
});

test("candidate promotion keeps the accepted job visible while the editorial inventory catches up", async ({ page }) => {
  await page.goto("?state=candidate-inventory-delay#content-candidates");
  await page.getByRole("button", { name: "Araştırmaya al" }).first().click();

  await expect(page.getByRole("heading", { name: "Taslak, iki dil ve kanıt paketi aynı masada." })).toBeVisible();
  await expect(page.getByRole("status")).toContainText("taslak masa envanterine eklendi");
});

test("candidate promotion keeps a visible pending desk row when the inventory remains unavailable", async ({ page }) => {
  await page.goto("?state=candidate-inventory-unavailable#content-candidates");
  await page.getByRole("button", { name: "Araştırmaya al" }).first().click();

  await expect(page.getByRole("heading", { name: "Taslak, iki dil ve kanıt paketi aynı masada." })).toBeVisible();
  await expect(page.getByRole("article", { name: "Araştırma kuyruğundaki taslak" })).toBeVisible();
  await expect(page.getByText("Taslak envanteri henüz güncellenmedi; yerel kuyruk işi kaydedildi.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Operasyonları aç" })).toHaveCount(0);
});

test("candidate promotion does not fabricate a completion percentage before the desk inventory arrives", async ({ page }) => {
  await page.goto("?state=candidate-inventory-unavailable#content-candidates");
  await page.getByRole("button", { name: "Araştırmaya al" }).first().click();

  const pendingDraft = page.getByRole("article", { name: "Araştırma kuyruğundaki taslak" });
  await expect(pendingDraft).toBeVisible();
  await expect(pendingDraft.getByLabel(/Yüzde .* tamamlandı/u)).toHaveCount(0);
  await expect(pendingDraft.getByText("İlerleme ölçümü henüz yok; işin durumunu Operasyonlar'dan takip edin.")).toBeVisible();
});

test("candidate promotion keeps an accepted job visible when the first editorial read fails", async ({ page }) => {
  await page.goto("?state=candidate-inventory-read-failure#content-candidates");
  await page.getByRole("button", { name: "Araştırmaya al" }).first().click();

  await expect(page.getByRole("heading", { name: "Taslak, iki dil ve kanıt paketi aynı masada." })).toBeVisible();
  await expect(page.getByRole("article", { name: "Araştırma kuyruğundaki taslak" })).toBeVisible();
  await expect(page.locator(".inline-notice")).toContainText("yerel kuyruk işi kabul edildi");
  await expect(page.getByRole("button", { name: "Operasyonları aç" })).toHaveCount(0);
});

test("candidate promotion keeps an accepted job visible when an inventory retry fails", async ({ page }) => {
  await page.goto("?state=candidate-inventory-retry-read-failure#content-candidates");
  await page.getByRole("button", { name: "Araştırmaya al" }).first().click();

  await expect(page.getByRole("heading", { name: "Taslak, iki dil ve kanıt paketi aynı masada." })).toBeVisible();
  await expect(page.getByRole("article", { name: "Araştırma kuyruğundaki taslak" })).toBeVisible();
  await expect(page.locator(".inline-notice")).toContainText("yerel kuyruk işi kabul edildi");
});

test("candidate dismissal stays truthful when the follow-up dashboard summary refresh fails", async ({ page }) => {
  await page.goto("?state=candidate-postdismiss-summary-failure#content-candidates");
  await page.getByRole("button", { name: "Adayı kapat" }).first().click();

  await expect(page.getByRole("status")).toContainText("Aday bu akıştan kapatıldı");
  await expect(page.getByRole("status")).toContainText("Genel Bakış sayaçları henüz yenilenemedi");
});

test("first start keeps the local output target focused instead of opening remote publishing", async ({ page }) => {
  await page.goto("#setup");
  await advanceSetupToTarget(page);
  await expect(page.getByRole("heading", { name: "Çıktı klasörünü seç", exact: true })).toBeVisible();
  await expect(page.getByRole("radio", { name: /Yayındaki siteye gönder/u })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "OPE’yi bu hedefle kullan" })).toBeDisabled();
});

test("offline engine health has direct recovery and redacted diagnostics actions", async ({ page }) => {
  await page.goto("?state=engine-offline#operations");
  await page.getByRole("tab", { name: "Yerel sistem ve bağlantılar" }).click();

  await expect(page.getByText("Yerel engine bağlantısı şu anda kullanılamıyor.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Yerel durumu yeniden dene" })).toBeVisible();
  await page.getByRole("button", { name: "Tanılama ve günlükleri aç" }).click();
  await expect(page.getByRole("button", { name: "Tanılama paketi oluştur" })).toBeVisible();
  await page.getByText("Engine hata günlüğü", { exact: true }).click();
  await expect(page.getByText("engine.stderr.log", { exact: false })).toBeVisible();
  await expect(page.getByText(/Bu özet sır, anahtar, kaynak metni veya kullanıcı verisi içermez/u)).toBeVisible();
});

test("offline runtime can still create a redacted diagnostics package", async ({ page }) => {
  await page.goto("?state=offline-engine#operations");
  await page.getByRole("tab", { name: "Yerel sistem ve bağlantılar" }).click();
  await page.getByRole("button", { name: "Tanılama ve günlükleri aç" }).click();
  await page.getByRole("button", { name: "Tanılama paketi oluştur" }).click();

  await expect(page.getByRole("status")).toContainText("Tanılama paketi hazırlandı");
  await expect(page.getByText("Son paket:", { exact: false })).toBeVisible();
  await expect(page.getByLabel("Tanılama özeti")).toContainText("Salt okunur kurtarma modu");
  await expect(page.getByLabel("Tanılama özeti")).not.toContainText("OFFLINE_READ_ONLY");
});

test("diagnostics export confirms the redacted bundle location", async ({ page }) => {
  await page.goto("#operations");
  await page.getByRole("tab", { name: "İş günlüğü" }).click();
  await page.getByRole("button", { name: "Tanılama özeti" }).click();
  await page.getByRole("button", { name: "Tanılama paketi oluştur" }).click();

  await expect(page.getByRole("status")).toContainText("Tanılama paketi hazırlandı");
  await expect(page.getByText("Son paket:", { exact: false })).toContainText("blogbot-diagnostics-demo.json");
  await expect(page.getByText(/Bu özet sır, anahtar, kaynak metni veya kullanıcı verisi içermez/u)).toBeVisible();
});

test("operations read failure does not leave the activity screen falsely loading forever", async ({ page }) => {
  await page.goto("?state=operations-read-failure#operations");
  await page.getByRole("tab", { name: /İş günlüğü/u }).click();

  await expect(page.getByText("Operasyon günlüğü okunamadı.", { exact: true })).toBeVisible();
  await expect(page.getByText("Operasyon verisi okunamadı. Günlüğü yenileyerek yeniden deneyin.")).toHaveCount(2);
  await expect(page.getByText("Operasyon günlüğü yükleniyor…")).toHaveCount(0);
});

test("diagnostics distinguishes an unreadable engine log from a log that simply has no entries", async ({ page }) => {
  await page.goto("?state=engine-diagnostics-failure#operations");
  await page.getByRole("tab", { name: /İş günlüğü/u }).click();
  await page.getByRole("button", { name: "Tanılama özeti" }).click();
  const engineLog = page.locator("details.engine-diagnostics");
  await engineLog.locator("summary").click();

  await expect(engineLog.getByText("Engine hata günlüğü şu anda okunamadı.")).toBeVisible();
  await expect(engineLog.getByText("Henüz günlük oluşmadı.")).toHaveCount(0);
});

test("saving a source refreshes the dashboard source count without manual refresh", async ({ page }) => {
  await page.goto("#content");
  await page.getByRole("textbox", { name: "Kaynak adresi" }).fill("https://fresh.example.org/feed.xml");
  await page.getByRole("button", { name: "Adresi kontrol et" }).click();
  await expect(page.getByRole("button", { name: "Yeniden test et", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Tümünü izlemeye al" }).click();

  await page.goto("#dashboard");
  await expect(page.getByText(/5 kaynak/u)).toBeVisible();
});

test("saving a source stays truthful when the wider dashboard summary cannot refresh", async ({ page }) => {
  await page.goto("?state=source-postsave-summary-failure#content");
  await page.getByRole("textbox", { name: "Kaynak adresi" }).fill("https://fresh.example.org/feed.xml");
  await page.getByRole("button", { name: "Adresi kontrol et" }).click();
  await expect(page.getByRole("button", { name: "Yeniden test et", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Tümünü izlemeye al" }).click();

  const notice = page.locator(".inline-notice[role='status']");
  await expect(notice).toContainText("1 kaynak izlemeye alındı");
  await expect(notice).toContainText("Genel Bakış sayaçları henüz yenilenemedi");
});

test("instant-create happy path queues a review-only job", async ({ page }) => {
  await page.goto("#instant");
  await page.getByRole("textbox", { name: "Ne oluşturmak istiyorsunuz?" }).fill("Seçilen kanıtları karşılaştır ve özgün bir analiz hazırla.");
  await page.getByRole("checkbox", { name: /Resmî duyurular/u }).check();
  await expect(page.getByRole("option", { name: "Teknoloji" })).toHaveCount(1);
  await page.getByRole("combobox", { name: "Site bölümü" }).selectOption("teknoloji");
  await expect(page.getByRole("combobox", { name: "İçerik türü" })).toHaveValue("news");
  await page.getByRole("combobox", { name: "Site bölümü" }).selectOption("analiz");
  await expect(page.getByRole("combobox", { name: "İçerik türü" })).toHaveValue("analysis");
  await expect(page.getByRole("combobox", { name: "İçerik türü" })).toBeDisabled();
  await page.getByRole("button", { name: "Araştırmayı başlat" }).click();
  await expect(page.getByRole("heading", { name: "İş güvenli kuyruğa alındı." })).toBeVisible();
  await expect(page.getByText("İş kimliği")).toBeVisible();
  await page.getByRole("button", { name: "Editoryal Masada gör" }).click();
  await expect(page.getByRole("heading", { name: "Taslak, iki dil ve kanıt paketi aynı masada." })).toBeVisible();
  const queuedDraft = page.getByRole("button", { name: /Seçilen kanıtları karşılaştır ve özgün bir analiz hazırla/u });
  await expect(queuedDraft).toBeEnabled();
  await queuedDraft.click();
  await expect(queuedDraft.getByText("Yazı üretimi hesabı veya izole runner bekleniyor.", { exact: true })).toBeVisible();
});

test("instant create carries an accepted delayed draft to the editorial desk", async ({ page }) => {
  await page.goto("?state=instant-inventory-delay#instant");
  await page.getByRole("textbox", { name: "Ne oluşturmak istiyorsunuz?" }).fill("Seçilen kanıtları karşılaştır ve özgün bir analiz hazırla.");
  await page.getByRole("checkbox", { name: /Resmî duyurular/u }).check();
  await page.getByRole("combobox", { name: "Site bölümü" }).selectOption("analiz");
  await page.getByRole("button", { name: "Araştırmayı başlat" }).click();
  await page.getByRole("button", { name: "Editoryal Masada gör" }).click();

  await expect(page.getByRole("heading", { name: "Taslak, iki dil ve kanıt paketi aynı masada." })).toBeVisible();
  await expect(page.getByRole("status")).toContainText("taslak masa envanterine eklendi");
  await expect(page.getByRole("button", { name: /Seçilen kanıtları karşılaştır ve özgün bir analiz hazırla/u })).toBeVisible({ timeout: 10_000 });
});

test("empty editorial desk explains the next useful action", async ({ page }) => {
  await page.goto("?state=empty#editorial");
  await expect(page.getByText("Henüz taslak yok.")).toBeVisible();
  await expect(page.getByText(/Anlık Oluştur/u)).toBeVisible();
});

test("bootstrap waits for the native Doctor result before first reading the editorial desk", async ({ page }) => {
  await page.goto("?state=bootstrap-race#editorial");

  await expect(page.getByText("Henüz taslak yok.")).toHaveCount(0);
  await expect(page.locator(".draft-row").first()).toBeVisible();
});

test("operations refresh does not overwrite the desk with a pre-Doctor workspace", async ({ page }) => {
  await page.goto("?state=operations-refresh-race#operations");
  await page.getByRole("button", { name: "Operasyon durumunu yenile" }).click();
  await expect(page.getByRole("status")).toContainText("Operasyon durumu yerel veriden yenilendi.");
  await page.goto("?state=operations-refresh-race#editorial");

  await expect(page.getByText("Henüz taslak yok.")).toHaveCount(0);
  await expect(page.locator(".draft-row").first()).toBeVisible();
});

test("empty review workspace gives an actionable empty state instead of an error alert", async ({ page }) => {
  await page.goto("?state=empty#editorial-review");

  await expect(page.getByRole("alert")).toHaveCount(0);
  await expect(page.getByText("İncelenecek revizyon yok.")).toBeVisible();
  await expect(page.getByText("İçerik Akışı'ndan bir işi araştırmaya alın.")).toBeVisible();
});

test("review queue exposes filter and selection state", async ({ page }) => {
  await page.goto("#editorial-review");
  await expect(page.getByRole("button", { name: "Bekleyenler" })).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByRole("button", { name: /Yeni teknoloji geçişinde gözden kaçan üç risk/u })).toHaveAttribute("aria-pressed", "true");
});

test("a failed revision selection never leaves the previous revision visible", async ({ page }) => {
  await page.goto("?state=review-selection-read-failure#editorial-review");
  const previousTitle = "Yeni teknoloji geçişinde gözden kaçan üç risk";
  await expect(page.getByRole("heading", { name: previousTitle, level: 2 })).toBeVisible();

  await page.getByRole("button", { name: /Yeni gelişmenin ilk 24 saati/u }).click();

  await expect(page.getByText("Revizyon açılamadı.")).toBeVisible();
  await expect(page.getByRole("heading", { name: previousTitle, level: 2 })).toHaveCount(0);
  await expect(page.getByText("Revizyon gösterilemiyor.")).toBeVisible();
});

test("requesting a revision edit refreshes the durable draft inventory and returns to it", async ({ page }) => {
  await page.goto("#editorial-review");
  await page.getByRole("button", { name: "Düzenleme iste" }).click();
  await page.getByRole("textbox", { name: /Değişmesini istediğiniz noktayı açıkça yazın/u }).fill("İkinci iddiayı birincil kaynakla yeniden doğrulayın.");
  await page.getByRole("button", { name: "Yeni revizyon iste" }).click();

  await expect(page.getByRole("tab", { name: /Taslaklar/u })).toHaveAttribute("aria-selected", "true");
  await expect(page.getByRole("button", { name: /Düzenleme talebini işliyor/u })).toBeVisible();
});

test("an approved revision can request a new immutable revision instead of becoming permanently locked", async ({ page }) => {
  await page.goto("?state=publish-ready#editorial-review");
  await approveCurrentRevision(page);

  const edit = page.getByRole("button", { name: "Düzenleme iste" });
  await expect(edit).toBeEnabled();
  await edit.click();
  await page.getByRole("textbox", { name: /Değişmesini istediğiniz noktayı açıkça yazın/u }).fill("Onaydan sonra ortaya çıkan kaynak güncellemesini yeni revizyonda doğrulayın.");
  await page.getByRole("button", { name: "Yeni revizyon iste" }).click();

  await expect(page.getByRole("tab", { name: /Taslaklar/u })).toHaveAttribute("aria-selected", "true");
  await expect(page.getByRole("button", { name: /Düzenleme talebini işliyor/u })).toBeVisible();
});

test("revision edit keeps the accepted job visible while the editorial inventory catches up", async ({ page }) => {
  await page.goto("?state=revision-edit-inventory-delay#editorial-review");
  await page.getByRole("button", { name: "Düzenleme iste" }).click();
  await page.getByRole("textbox", { name: /Değişmesini istediğiniz noktayı açıkça yazın/u }).fill("İkinci iddiayı birincil kaynakla yeniden doğrulayın.");
  await page.getByRole("button", { name: "Yeni revizyon iste" }).click();

  await expect(page.getByRole("tab", { name: /Taslaklar/u })).toHaveAttribute("aria-selected", "true");
  await expect(page.getByRole("status")).toContainText("taslak masa envanterine eklendi");
  await expect(page.getByRole("button", { name: /Düzenleme talebini işliyor/u })).toBeVisible({ timeout: 10_000 });
});

test("review metadata is derived from the selected immutable revision", async ({ page }) => {
  await page.goto("?state=truthful-review#editorial-review");

  await expect(page.getByText("2031", { exact: false })).toBeVisible();
  await expect(page.getByText("29 Temmuz · 16:30", { exact: true })).toHaveCount(0);
  await expect(page.getByText("8 dk okuma", { exact: true })).toHaveCount(0);
  await page.getByRole("tab", { name: /Kaynak kontrolü/u }).click();
  await expect(page.getByText("Tümü kaynaklı", { exact: true })).toHaveCount(0);
  await expect(page.getByText("1 iddia kaynak bekliyor", { exact: true })).toBeVisible();
  await page.getByRole("tab", { name: /Medya/u }).click();
  await expect(page.getByText("Medya eksik", { exact: true })).toBeVisible();
  await expect(page.getByText("2 / 2 uygun", { exact: true })).toHaveCount(0);
  await page.getByRole("tab", { name: /Yayın kontrolü/u }).click();
  await expect(page.getByText(/engel nedeniyle onaya hazır değil/u)).toBeVisible();
  await expect(page.getByText(/sınırlarından geçti/u)).toHaveCount(0);
});

test("review content makes missing hero media actionable instead of showing a synthetic preview", async ({ page }) => {
  await page.goto("?state=missing-media#editorial-review");

  await expect(page.getByText("Bu taslakta hero medya yok.")).toHaveCount(2);
  await expect(page.getByRole("button", { name: "Görseli hazırla" })).toHaveCount(2);
  await expect(page.getByText("Hero medya güvenli önizlemesi")).toHaveCount(0);
});

test("a short legacy review draft offers one-step comprehensive regeneration", async ({ page }) => {
  await page.goto("#editorial-review");

  await expect(page.getByText(/Bu taslak .* kelimeyle kısa kaldı/u)).toBeVisible();
  await page.getByRole("button", { name: "Kapsamlı yeniden oluştur" }).click();

  await expect(page.getByRole("tab", { name: /Taslaklar/u })).toHaveAttribute("aria-selected", "true");
  await expect(page.getByRole("button", { name: /Kapsamlı yeniden oluşturma işleniyor/u })).toBeVisible();
});

test("narrow embedded V3 review reaches comprehensive regeneration without forced interaction", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("#editorial-review");

  const embeddedWorkspace = page.locator(".review-page-embedded");
  await expect(embeddedWorkspace).toBeVisible();
  const regenerate = embeddedWorkspace.getByRole("button", { name: "Kapsamlı yeniden oluştur" });
  await regenerate.click();

  await expect(page.getByRole("tab", { name: /Taslaklar/u })).toHaveAttribute("aria-selected", "true");
  await expect(page.getByRole("button", { name: /Kapsamlı yeniden oluşturma işleniyor/u })).toBeVisible();
});

test("review approval remains hash-bound and requires a selected local target before materialization", async ({ page }) => {
  await page.goto("#editorial-review");

  const approval = page.getByRole("button", { name: "Bu revizyonu onayla" });
  await completeEditorialApprovalAttestation(page);
  await expect(approval).toBeEnabled();
  await approval.click();
  await expect(page.getByRole("status")).toContainText("Revizyon onaylandı");

  await expect(page.getByRole("button", { name: /Onaylı paketi seçili klasöre yaz/u })).toBeDisabled();
  await expect(page.getByText("Yerel hedef seçilmeden onaylı paket yazılamaz.")).toBeVisible();
});

test("revision approval refreshes the review queue instead of leaving a stale pending count", async ({ page }) => {
  await page.goto("?state=approval-refresh#editorial-review");
  await expect(page.getByText("2 açık revizyon")).toBeVisible();
  await approveCurrentRevision(page);

  await expect(page.getByRole("status")).toContainText("Revizyon onaylandı");
  await expect(page.getByText("1 açık revizyon")).toBeVisible();
  await expect(page.getByRole("button", { name: "Yeni teknoloji geçişinde gözden kaçan üç risk" })).toHaveCount(0);
});

test("high-risk approval requires reauthentication acknowledgement and refreshes the review queue", async ({ page }) => {
  await page.goto("?state=high-risk-approval-refresh#editorial-review");
  const approval = page.getByRole("button", { name: "Yüksek risk onayını ver" });
  await expect(approval).toBeDisabled();
  await expect(approval).toHaveAttribute("aria-describedby", "high-risk-reauthentication");
  await page.getByLabel("Güvenlik kontrol listesini yeniden okudum ve ikinci yüksek risk onayını bilinçli olarak veriyorum.").check();
  await approval.click();

  await expect(page.getByRole("status")).toContainText("Yüksek risk onayı kaydedildi");
  await expect(page.getByText("1 açık revizyon")).toBeVisible();
});

test("an approved revision keeps remote publication unavailable until the GitHub broker is configured", async ({ page }) => {
  await page.goto("?state=publish-ready#editorial-review");
  await approveCurrentRevision(page);
  await expect(page.getByRole("button", { name: "Yayın kuyruğuna al" })).toHaveCount(0);
  await expect(page.getByText("GitHub yayın bağlantısı henüz hazır değil. Bu revizyonu şimdi onaylayabilir; bağlantı doğrulanınca aynı onaylı paketi hedefe gönderebilirsiniz.")).toBeVisible();
});

test("publication setup does not offer a misleading remote queue before the GitHub broker is ready", async ({ page }) => {
  await page.goto("?state=publish-ready#editorial-review");

  await expect(page.getByRole("button", { name: "Yayın kuyruğuna al" })).toHaveCount(0);
  await expect(page.getByText("GitHub yayın bağlantısı henüz hazır değil. Bu revizyonu şimdi onaylayabilir; bağlantı doğrulanınca aynı onaylı paketi hedefe gönderebilirsiniz.")).toBeVisible();
});

test("saved local output target unlocks approved revision materialization", async ({ page }) => {
  await page.goto("?state=materialization-ready#setup");
  await page.getByRole("button", { name: /Yayın bağlantısı: Yerel klasör, proje veya GitHub hedefini/u }).click();
  const localOutput = page.getByRole("group", { name: "Çıktı klasörü" });
  await localOutput.getByRole("button", { name: "Bilgisayardan klasör seç" }).click();
  await localOutput.getByRole("button", { name: "Bu ayarı kaydet" }).click();
  await expect(localOutput.getByRole("status")).toContainText("Kurulum alanları demo çalışma alanında doğrulandı.");

  await page.goto("#editorial-review");
  await approveCurrentRevision(page);
  const materialize = page.getByRole("button", { name: /Onaylı paketi seçili klasöre yaz/u });
  await expect(materialize).toBeEnabled();
  await materialize.click();
  const materializeConfirmation = page.getByRole("alertdialog", { name: "Yerel dosya yazımını onayla" });
  await expect(materializeConfirmation).toContainText("Mevcut OPE çıktıları güvenli bir yedeğe alınır;");
  await materializeConfirmation.getByRole("button", { name: "Dosyaları yerel hedefe yaz" }).click();
  await expect(page.getByRole("status")).toContainText("dosya yerel proje klasörüne yazıldı");
  await expect(page.getByRole("status")).toContainText(/^5 /u);
});

test("local write confirmation traps focus on the safe action and returns it when cancelled", async ({ page }) => {
  await page.goto("#setup");
  await page.getByRole("button", { name: /Yayın bağlantısı: Yerel klasör, proje veya GitHub hedefini/u }).click();
  const localOutput = page.getByRole("group", { name: "Çıktı klasörü" });
  await localOutput.getByRole("button", { name: "Bilgisayardan klasör seç" }).click();
  await localOutput.getByRole("button", { name: "Bu ayarı kaydet" }).click();

  await page.goto("#editorial-review");
  await approveCurrentRevision(page);
  const materialize = page.getByRole("button", { name: /Onaylı paketi seçili klasöre yaz/u });
  await materialize.click();
  const confirmation = page.getByRole("alertdialog", { name: "Yerel dosya yazımını onayla" });
  await expect(confirmation).toBeVisible();
  const cancel = confirmation.getByRole("button", { name: "Vazgeç" });
  const confirm = confirmation.getByRole("button", { name: "Dosyaları yerel hedefe yaz" });
  await expect(cancel).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  await expect(confirm).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(cancel).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(confirmation).toHaveCount(0);
  await expect(materialize).toBeFocused();
});

test("saving a setup target stays truthful when the post-save status refresh is unavailable", async ({ page }) => {
  await page.goto("?state=setup-postsave-refresh-failure#setup");
  await page.getByRole("button", { name: /Yayın bağlantısı: Yerel klasör, proje veya GitHub hedefini/u }).click();
  const localOutput = page.getByRole("group", { name: "Çıktı klasörü" });
  await localOutput.getByRole("button", { name: "Bilgisayardan klasör seç" }).click();
  await localOutput.getByRole("button", { name: "Bu ayarı kaydet" }).click();

  await expect(localOutput.getByRole("status")).toContainText("Ayar yerel olarak kaydedildi");
  await expect(localOutput.getByRole("status")).toContainText("güncel bağlantı durumu yenilenemedi");
  await expect(localOutput.getByRole("status")).not.toContainText("Ayarlar kaydedilemedi");
});

test("testing a setup target stays truthful when the post-test status refresh is unavailable", async ({ page }) => {
  await page.goto("?state=setup-posttest-refresh-failure#setup");
  await page.getByRole("button", { name: /Yayın bağlantısı: Yerel klasör, proje veya GitHub hedefini/u }).click();
  const localOutput = page.getByRole("group", { name: "Çıktı klasörü" });
  await localOutput.getByRole("button", { name: "Bilgisayardan klasör seç" }).click();
  await localOutput.getByRole("button", { name: "Bilgileri doğrula" }).click();

  await expect(localOutput.getByRole("status")).toContainText("Biçim doğrulandı");
  await expect(localOutput.getByRole("status")).toContainText("güncel bağlantı durumu yenilenemedi");
  await expect(localOutput.getByRole("status")).not.toContainText("Biçim testi tamamlanamadı");
});

test("an accepted source scan stays truthful when its first status read is unavailable", async ({ page }) => {
  await page.goto("?state=scan-status-refresh-failure#content");
  await page.getByRole("button", { name: "Tümünü tara" }).click();

  const notice = page.getByText(/Tarama .* kuyruğa alındı/u);
  await expect(notice).toContainText("Tarama yerel kuyruğa alındı");
  await expect(notice).toContainText("durumu henüz okunamadı");
  await expect(notice).not.toContainText("Kaynak taraması başlatılamadı");
});

test("completed source scan explains when the wider dashboard summary cannot refresh", async ({ page }) => {
  await page.goto("?state=scan-postcompletion-summary-failure#content");
  await page.getByRole("button", { name: "Tümünü tara" }).click();

  const notice = page.locator(".inline-notice[role='status']");
  await expect(notice).toContainText("2 kaynak tarandı; 1 yeni haber adayı bulundu.");
  await expect(notice).toContainText("Genel Bakış sayaçları henüz yenilenemedi");
});

test("a ready local engine test stays truthful when prerequisite cards cannot refresh", async ({ page }) => {
  await page.goto("?state=engine-posttest-refresh-failure#setup");
  await page.getByRole("button", { name: "Tanılama ve onarım" }).click();
  await page.getByRole("button", { name: "Yerel bileşeni test et" }).click();
  const result = page.getByText(/Yerel çalışma bileşeni hazır; ancak önkoşul kartları yenilenemedi/u);
  await expect(result).toBeVisible();
  await expect(result).not.toContainText("yerel çalışma bileşeni test edilemedi");
});

test("retry stays truthful when the durable queue accepts the job but the desk cannot refresh", async ({ page }) => {
  await page.goto("?state=retry-postsave-refresh-failure#operations");
  await page.getByRole("button", { name: "Tekrar dene" }).first().click();

  await expect(page.getByRole("status")).toContainText("İş güvenli tekrar deneme kuyruğuna alındı");
  await expect(page.getByRole("status")).toContainText("envanter henüz yenilenemedi");
  await expect(page.getByRole("status")).not.toContainText("İş yeniden başlatılamadı");
});

test("offline review never offers approval or local materialization", async ({ page }) => {
  await page.goto("?state=offline#editorial-review");

  const approval = page.getByRole("button", { name: "Bu revizyonu onayla" });
  await expect(approval).toBeDisabled();
  await expect(approval).toHaveAttribute("aria-describedby", "review-approval-read-only");
  await expect(page.getByText("Yerel çalışma alanı yeniden bağlanana kadar bu revizyon onaylanamaz.")).toBeVisible();
  const localOutput = page.getByRole("button", { name: /Onaylı paketi seçili klasöre yaz/u });
  await expect(localOutput).toBeDisabled();
  await expect(localOutput).toHaveAttribute("aria-describedby", /review-approval-read-only/u);
});

test("narrow review keeps queue search, filters, and revision selection operable", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("#editorial-review");
  const queue = page.getByRole("complementary", { name: "İnceleme kuyruğu" });
  await expect(queue.getByRole("searchbox", { name: "İnceleme kuyruğunda ara" })).toBeVisible();
  await expect(queue.getByRole("button", { name: "Bekleyenler" })).toBeVisible();
  await expect(queue.getByRole("button", { name: "Onaylı" })).toBeVisible();
  const items = queue.locator(".review-queue-item");
  await expect(items.first()).toBeVisible();
  await items.first().click();
  await expect(page.getByRole("region", { name: "Revizyon inceleme çalışma alanı" })).toBeVisible();
});

test("setup guide sends the user from preferences to the real target selection", async ({ page }) => {
  await page.goto("#setup-guide");
  await advanceSetupToTarget(page);
  await expect(page.getByRole("heading", { name: "Çıktı klasörünü seç", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Bilgisayardan klasör seç" })).toBeVisible();
});

test("setup guide route opens the first-start wizard directly", async ({ page }) => {
  await page.goto("#setup-guide");

  await expect(page.getByRole("heading", { name: "Bu bilgisayarı kontrol et" })).toBeVisible();
  await expect(page.getByRole("progressbar", { name: "İlk başlangıç ilerlemesi" })).toHaveAttribute("aria-valuenow", "1");
  await expect(page.getByRole("heading", { name: "Ne yapmak istiyorsunuz?" })).not.toBeVisible();
});

test("setup guide finishes with evidence from a fresh prerequisite check", async ({ page }) => {
  await page.goto("#setup-guide");
  await advanceSetupToTarget(page);
  await page.getByRole("button", { name: "Bilgisayardan klasör seç" }).click();
  await page.getByRole("button", { name: "Klasörü test et" }).click();
  const finalResult = page.getByText("Biçim doğrulandı", { exact: false });
  await expect(finalResult).toContainText("Biçim doğrulandı");
});

test("setup explains security-gated external execution and filesystem actions", async ({ page }) => {
  await page.goto("#setup");
  await page.getByRole("button", { name: /Yayın bağlantısı/u }).click();
  await page.getByRole("radio", { name: /Yerel projeye gönder/u }).click();
  const siteCard = page.getByRole("group", { name: "Yerel proje" });
  await expect(siteCard.getByRole("button", { name: "npm run dev sürecini başlat" })).toBeDisabled();
  await siteCard.getByRole("button", { name: "Bilgisayardan klasör seç" }).click();
  await expect(siteCard.getByRole("textbox", { name: /Proje klasörü \(ör\. C:\\Siteler\\benim-site\)/u })).toHaveValue("C:\\OPE-Demo");
  await expect(siteCard.getByRole("button", { name: "npm run dev sürecini başlat" })).toBeDisabled();
  await siteCard.getByRole("checkbox", { name: /Seçtiğim proje klasörüne/u }).check();
  await expect(siteCard.getByRole("button", { name: "npm run dev sürecini başlat" })).toBeEnabled();
  await siteCard.getByRole("button", { name: "npm run dev sürecini başlat" }).click();
  await expect(siteCard.getByRole("button", { name: "npm run dev sürecini durdur" })).toBeVisible();

  await page.getByRole("button", { name: "Kurulum görevlerine dön" }).click();
  await page.getByRole("button", { name: /Yedekleme ve kurtarma/u }).click();
  await expect(page.getByText("Yedek dosya erişimi Windows seçimiyle sınırlandırılır.")).toBeVisible();
  const createBackup = page.getByRole("group", { name: "Yeni şifreli yedek oluştur" });
  await createBackup.getByRole("button", { name: "Bilgisayardan klasör seç" }).click();
  await createBackup.getByRole("button", { name: "Yedek klasörü seç" }).click();
  await createBackup.getByLabel(/Yeni yedekleme şifresi/u).fill("demo-recovery-key-2026");
  await createBackup.getByRole("button", { name: "Şifreli yedek oluştur" }).click();
  await expect(page.getByText(/Yedek oluşturuldu/u)).toBeVisible();

  const restoreBackup = page.getByRole("group", { name: "Şifreli yedek doğrulama ve geri yükleme önizlemesi" });
  await restoreBackup.getByRole("button", { name: "Üst klasörü seç" }).click();
  await restoreBackup.getByLabel(/Yedekleme şifresi/u).fill("demo-recovery-key-2026");
  await restoreBackup.getByRole("button", { name: "Yedeği doğrula" }).click();
  await expect(page.getByText(/Yedek doğrulandı/u)).toBeVisible();

  await page.getByRole("button", { name: "Kurulum görevlerine dön" }).click();
  await page.getByRole("button", { name: /Yayın bağlantısı/u }).click();
  await page.getByRole("radio", { name: /Yayındaki siteye gönder/u }).click();
  await expect(page.getByRole("button", { name: "GitHub girişini başlat" })).toHaveCount(0);
});

test("setup exposes the read-only GitHub broker status before external authorization is available", async ({ page }) => {
  await page.goto("#setup");
  await page.getByRole("button", { name: /Yayın bağlantısı/u }).click();
  await page.getByRole("radio", { name: /Yayındaki siteye gönder/u }).click();

  const github = page.getByTestId("setup-connector-github");
  const status = github.getByRole("button", { name: "GitHub bağlantı durumunu kontrol et" });
  await expect(status).toBeEnabled();
  await status.click();
  await expect(github.getByRole("status")).toContainText("Demo GitHub bağlantısı hazır.");
});

test("local project setup explains when the safe process status cannot be checked", async ({ page }) => {
  await page.goto("?state=local-dev-status-failure#setup");
  await page.getByRole("button", { name: /Yayın bağlantısı: Yerel klasör, proje veya GitHub hedefini/u }).click();
  await page.getByRole("radio", { name: /Yerel projeye gönder/u }).click();

  await expect(page.getByText(/Yerel proje sunucusunun durumu okunamadı/u)).toBeVisible();
  await expect(page.getByRole("button", { name: /npm run dev sürecini başlat/u })).toBeDisabled();
  await page.getByRole("button", { name: "Durumu yeniden dene" }).click();
  await expect(page.getByText(/Yerel proje sunucusunun durumu okunamadı/u)).toHaveCount(0);
  await expect(page.getByText(/OPE yalnız seçtiğiniz klasördeki komutu/u)).toBeVisible();
});

test("stopping a local project server names the stop failure and recovery action", async ({ page }) => {
  await page.goto("?state=local-dev-stop-failure#setup");
  await page.getByRole("button", { name: /Yayın bağlantısı: Yerel klasör, proje veya GitHub hedefini/u }).click();
  await page.getByRole("radio", { name: /Yerel projeye gönder/u }).click();
  const siteCard = page.getByRole("group", { name: "Yerel proje" });
  await siteCard.getByRole("button", { name: "Bilgisayardan klasör seç" }).click();
  await siteCard.getByRole("checkbox", { name: /Seçtiğim proje klasörüne/u }).check();
  await siteCard.getByRole("button", { name: "npm run dev sürecini başlat" }).click();
  const stop = siteCard.getByRole("button", { name: "npm run dev sürecini durdur" });
  await expect(stop).toBeVisible();
  await stop.click();

  await expect(page.getByText(/Yerel geliştirme süreci durdurulamadı/u)).toBeVisible();
  await expect(page.getByText(/çalışıp çalışmadığını kontrol edin/u)).toBeVisible();
});

test("local project setup shows successful start and stop results in its own card", async ({ page }) => {
  await page.goto("#setup");
  await page.getByRole("button", { name: /Yayın bağlantısı: Yerel klasör, proje veya GitHub hedefini/u }).click();
  await page.getByRole("radio", { name: /Yerel projeye gönder/u }).click();
  const siteCard = page.getByRole("group", { name: "Yerel proje" });
  await siteCard.getByRole("button", { name: "Bilgisayardan klasör seç" }).click();
  await siteCard.getByRole("checkbox", { name: /Seçtiğim proje klasörüne/u }).check();
  await siteCard.getByRole("button", { name: "npm run dev sürecini başlat" }).click();
  await expect(siteCard.getByRole("status")).toContainText("Yerel geliştirme süreci başlatıldı");
  await siteCard.getByRole("button", { name: "npm run dev sürecini durdur" }).click();
  await expect(siteCard.getByRole("status")).toContainText("Yerel geliştirme süreci durduruldu");
});

test("writing setup keeps Codex check and login results in the focused task", async ({ page }) => {
  await page.goto("#setup");
  await page.locator(".setup-task-card").filter({ hasText: "Yazı üretimi hesabı" }).click();
  const codex = page.getByTestId("setup-connector-codex");

  await codex.getByRole("button", { name: "Bağlantıyı kontrol et" }).click();
  await expect(codex.getByRole("status")).toContainText("Codex bağlantısı hazır görünüyor");
  await codex.getByRole("button", { name: "Giriş penceresini aç" }).click();
  await expect(codex.getByRole("status")).toContainText("Demo giriş akışı başlatıldı");
});

test("a successful Codex check stays truthful when its prerequisite refresh is unavailable", async ({ page }) => {
  await page.goto("?state=codex-posttest-refresh-failure#setup");
  await page.locator(".setup-task-card").filter({ hasText: "Yazı üretimi hesabı" }).click();
  const codex = page.getByTestId("setup-connector-codex");

  await codex.getByRole("button", { name: "Bağlantıyı kontrol et" }).click();
  await expect(codex.getByRole("status")).toContainText("Codex bağlantısı hazır görünüyor");
  await expect(codex.getByRole("status")).toContainText("Önkoşul kartları yenilenemedi");
  await expect(codex.getByRole("status")).not.toContainText("Yazı üretimi hesabı kontrol edilemedi");
});

test("unconfigured GitHub broker never offers a misleading login action", async ({ page }) => {
  await page.goto("?state=github-unconfigured#setup");
  await page.getByRole("button", { name: /Yayın bağlantısı/u }).click();
  await page.getByRole("radio", { name: /Yayındaki siteye gönder/u }).click();
  await page.getByRole("textbox", { name: "GitHub OAuth istemci kimliği (gerekli)" }).fill("public-client-id");

  await expect(page.getByRole("button", { name: "GitHub girişini başlat" })).toHaveCount(0);
  await expect(page.getByText("GitHub App broker bu uygulama paketinde yapılandırılmadı; gerçek giriş ve yayın kapalı tutuluyor.")).toBeVisible();
});

test("about panel shows the project signature and keeps update checks explicit", async ({ page }) => {
  await page.goto("#dashboard");

  const about = page.getByRole("button", { name: "OPE hakkında" });
  await expect(about).toHaveAttribute("aria-expanded", "false");
  await about.click();
  await expect(about).toHaveAttribute("aria-expanded", "true");
  await expect(page.getByText("@ucsahinn")).toBeVisible();
  const projectPage = page.getByRole("link", { name: "GitHub’da projeyi görüntüle" });
  await expect(projectPage).toBeVisible();
  await projectPage.click();

  await page.getByRole("button", { name: "Güncellemeleri denetle" }).click();
  await expect(page.getByRole("status")).toContainText(
    "Güncelleme denetimi yalnız paketlenmiş OPE uygulamasında yapılır."
  );
  await expect(page.getByRole("button", { name: /indir ve kur/u })).toHaveCount(0);
});

test("every desktop workspace exposes bounded, named controls without actionable collisions", async ({ page }) => {
  await page.setViewportSize({ width: 1366, height: 768 });

  for (const [route, heading] of surfaces) {
    await page.goto(`#${route}`);
    await expect(page.getByRole("heading", { name: heading })).toBeVisible();
    await waitForPageTransition(page);

    const report = await page.evaluate(() => {
      const visible = (element: Element): element is HTMLElement => {
        const node = element as HTMLElement;
        const style = window.getComputedStyle(node);
        const rect = node.getBoundingClientRect();
        return style.display !== "none" && style.visibility !== "hidden" && !element.closest("details:not([open]), [hidden]") && rect.width > 0 && rect.height > 0;
      };
      const controls = Array.from(document.querySelectorAll("button, a[href], input, select, textarea")).filter(visible) as HTMLElement[];
      const viewport = { width: window.innerWidth, height: window.innerHeight };
      const outOfBounds = controls
        .map((element) => ({ element, rect: element.getBoundingClientRect() }))
        .filter(({ rect }) => rect.left < -1 || rect.right > viewport.width + 1)
        .map(({ element, rect }) => ({ tag: element.tagName, text: element.innerText || element.getAttribute("aria-label") || element.getAttribute("name") || "", left: Math.round(rect.left), right: Math.round(rect.right) }));
      const unnamed = controls
        .filter((element) => {
          if (element.matches("input, select, textarea")) return !(element.getAttribute("aria-label") || element.getAttribute("aria-labelledby") || (element as HTMLInputElement).labels?.length);
          return !(element.innerText?.trim() || element.getAttribute("aria-label") || element.getAttribute("title"));
        })
        .map((element) => element.outerHTML.slice(0, 180));
      const collisions: Array<{ first: string; second: string }> = [];
      const collisionControls = controls.filter((element) => !element.matches(".boby-launcher, .boby-panel, .boby-panel *"));
      for (let index = 0; index < collisionControls.length; index += 1) {
        const first = collisionControls[index]!;
        const firstRect = first.getBoundingClientRect();
        for (let next = index + 1; next < collisionControls.length; next += 1) {
          const second = collisionControls[next]!;
          if (first.contains(second) || second.contains(first)) continue;
          const secondRect = second.getBoundingClientRect();
          const overlapWidth = Math.min(firstRect.right, secondRect.right) - Math.max(firstRect.left, secondRect.left);
          const overlapHeight = Math.min(firstRect.bottom, secondRect.bottom) - Math.max(firstRect.top, secondRect.top);
          if (overlapWidth > 2 && overlapHeight > 2) {
            collisions.push({
              first: `${first.tagName}:${first.innerText?.trim() || first.getAttribute("aria-label") || "unnamed"} @ ${Math.round(firstRect.left)},${Math.round(firstRect.top)} ${Math.round(firstRect.width)}x${Math.round(firstRect.height)} parent=${first.parentElement?.className}`,
              second: `${second.tagName}:${second.innerText?.trim() || second.getAttribute("aria-label") || "unnamed"} @ ${Math.round(secondRect.left)},${Math.round(secondRect.top)} ${Math.round(secondRect.width)}x${Math.round(secondRect.height)} parent=${second.parentElement?.className}`
            });
          }
        }
      }
      return { outOfBounds, unnamed, collisions };
    });

    expect(report.outOfBounds, `${route}: controls escape the viewport`).toEqual([]);
    expect(report.unnamed, `${route}: visible controls need an accessible name`).toEqual([]);
    expect(report.collisions, `${route}: actionable controls overlap`).toEqual([]);
  }
});

test("an approved revision can revoke its exact approval before publication", async ({ page }) => {
  await page.goto("#editorial-review");
  await approveCurrentRevision(page);
  await expect(page.getByRole("status")).toContainText("Revizyon onaylandı");

  await page.getByRole("button", { name: "Onayı geri çek" }).click();
  await page.getByRole("textbox", { name: "Onayı geri çekme gerekçesi" }).fill("Kaynak doğrulaması yeniden yapılacak.");
  await page.getByRole("button", { name: "Geri çekmeyi onayla" }).click();
  const confirmation = page.getByRole("alertdialog", { name: "Revizyon onayını geri çek" });
  await confirmation.getByRole("button", { name: "Onayı geri çek" }).click();

  await expect(page.getByRole("status")).toContainText("Revizyon onayı geri çekildi");
  await expect(page.getByRole("button", { name: "Bu revizyonu onayla" })).toBeVisible();
});

test("mobile About opens above the fixed utility navigation without overflow", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("#dashboard");
  await page.getByRole("navigation", { name: "İkincil menü" }).getByRole("button", { name: "OPE hakkında" }).click();
  const about = page.locator(".about-card");
  await expect(about).toBeVisible();
  const box = await about.boundingBox();
  expect(box).not.toBeNull();
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.y).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(390);
  expect(box!.y + box!.height).toBeLessThanOrEqual(844);
});
