import os
import tempfile

from playwright.sync_api import sync_playwright


def main() -> None:
    console_errors: list[str] = []
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True)
        page = browser.new_page(viewport={"width": 1440, "height": 1000})
        page.on(
            "console",
            lambda message: console_errors.append(message.text)
            if message.type == "error"
            else None,
        )
        page.goto("http://127.0.0.1:1420/#dashboard")
        page.wait_for_load_state("networkidle")

        page.get_by_role(
            "heading", name="Yayın akışı kontrol altında."
        ).wait_for()

        page.get_by_role("button", name="İçerik Akışı").click()
        page.get_by_role(
            "heading", name="Kaynaklardan yayın fikrine tek çalışma alanı."
        ).wait_for()
        page.get_by_role("tab", name="Anlık oluştur").click()
        page.get_by_role(
            "heading", name="Niyeti anlatın; kanıt sınırını Blogbot korusun."
        ).wait_for()

        page.get_by_role("button", name="Editoryal Masa").click()
        page.get_by_role("tab", name="TR / EN inceleme").click()
        page.get_by_role("heading", name="Yayın kuyruğu").wait_for()
        page.get_by_role("tab", name="SEO ve güvenlik").click()
        page.get_by_text("7/7").wait_for()

        page.get_by_role("button", name="Operasyonlar").click()
        page.get_by_role(
            "heading", name="Otomasyon görünür, sınırlar açık."
        ).wait_for()

        page.get_by_role("button", name="Önkoşulları test et").click()
        page.get_by_role(
            "heading",
            name="Blogbot her zaman açılır; hazır olmayan işlem güvenle kilitlenir.",
        ).wait_for()
        page.get_by_role("button", name="Rehberli kurulumu aç").click()
        page.get_by_role("heading", name="Bu bilgisayarı kontrol et").wait_for()

        screenshot_path = os.path.join(
            tempfile.gettempdir(), "blogbot-desktop-smoke.png"
        )
        page.screenshot(path=screenshot_path, full_page=True)
        browser.close()

    if console_errors:
        raise AssertionError(f"Browser console errors: {console_errors}")
    print(f"BROWSER_SMOKE_OK screenshot={screenshot_path}")


if __name__ == "__main__":
    main()
