import { useEffect, useState } from "react";

import { userFacingBridgeError, type BlogbotBridge } from "../bridge.ts";
import type { DesktopPreferences, EditorialWorkspaceSnapshot, Section } from "../types.ts";

interface SettingsCenterProps {
  bridge: BlogbotBridge;
  workspace: EditorialWorkspaceSnapshot;
  readOnly: boolean;
  onWorkspaceChange: (snapshot: EditorialWorkspaceSnapshot) => void;
}

const defaultPreferences: DesktopPreferences = {
  author: "Blogbot Editorya",
  reviewer: "Editör",
  notifications: true,
  emailDigest: false,
  defaultSection: "haberler"
};

export function SettingsCenter({ bridge, workspace, readOnly, onWorkspaceChange }: SettingsCenterProps) {
  const [form, setForm] = useState<DesktopPreferences>(workspace.preferences);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [autostart, setAutostart] = useState<boolean | null>(null);
  const [autostartStatusError, setAutostartStatusError] = useState(false);
  const dirty = JSON.stringify(form) !== JSON.stringify(workspace.preferences);
  const notificationPreferenceChanged = form.notifications !== workspace.preferences.notifications;

  useEffect(() => {
    let alive = true;
    void bridge.getAutostartStatus().then(({ enabled }) => {
      if (alive) {
        setAutostart(enabled);
        setAutostartStatusError(false);
      }
    }).catch(() => {
      if (alive) {
        setAutostart(null);
        setAutostartStatusError(true);
      }
    });
    return () => {
      alive = false;
    };
  }, [bridge]);

  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  const save = async () => {
    setBusy(true);
    setMessage("");
    try {
      await bridge.saveDesktopPreferences(form);
      try {
        onWorkspaceChange(await bridge.getEditorialWorkspace());
        setMessage("Masaüstü tercihleri kaydedildi.");
      } catch {
        setMessage("Masaüstü tercihleri kaydedildi; görünüm henüz yenilenemedi. Sayfayı yeniden açın veya Çalışma alanını yenile eylemini kullanın.");
      }
    } catch (reason) {
      setMessage(userFacingBridgeError(reason, "Ayarlar kaydedilemedi."));
    } finally {
      setBusy(false);
    }
  };

  const testNotification = async () => {
    setMessage("");
    try {
      await bridge.sendTestNotification();
      setMessage("Windows test bildirimi gönderildi.");
    } catch (reason) {
      setMessage(
        userFacingBridgeError(reason, "Test bildirimi gönderilemedi.")
      );
    }
  };

  const toggleAutostart = async (enabled: boolean) => {
    setBusy(true);
    setMessage("");
    try {
      const result = await bridge.setAutostart(enabled);
      setAutostart(result.enabled);
      setMessage(
        result.enabled
          ? "Blogbot Windows oturum açılışında başlatılacak."
          : "Windows başlangıcında otomatik açılma kapatıldı."
      );
    } catch (reason) {
      setMessage(
        userFacingBridgeError(reason, "Windows başlangıç ayarı değiştirilemedi.")
      );
    } finally {
      setBusy(false);
    }
  };

  const saveUnavailableReason = readOnly
    ? "Yerel çalışma alanı yeniden bağlanana kadar ayarlar değiştirilemez."
    : busy
      ? "Ayar işlemi tamamlanana kadar bekleyin."
      : !dirty
        ? "Kaydedilecek değişiklik yok."
        : form.author.trim().length < 2 || form.reviewer.trim().length < 2
          ? "Yazar ve inceleyen en az iki karakter olmalıdır."
          : "";
  const cancelUnavailableReason = readOnly
    ? "Yerel çalışma alanı yeniden bağlanana kadar değişiklikler geri alınamaz."
    : busy
      ? "Ayar işlemi tamamlanana kadar bekleyin."
      : !dirty
        ? "Kaydedilmemiş değişiklik yok."
        : "";
  const defaultsUnavailableReason = readOnly
    ? "Yerel çalışma alanı yeniden bağlanana kadar varsayılanlar forma yüklenemez."
    : busy
      ? "Ayar işlemi tamamlanana kadar bekleyin."
      : JSON.stringify(form) === JSON.stringify(defaultPreferences)
        ? "Form zaten varsayılan ayarları kullanıyor."
        : "";
  const notificationUnavailableReason = readOnly
    ? "Yerel çalışma alanı yeniden bağlanana kadar test bildirimi gönderilemez."
    : busy
      ? "Ayar işlemi tamamlanana kadar bekleyin."
      : !form.notifications
        ? "Windows bildirimlerini açıp tercihi kaydedin."
        : notificationPreferenceChanged
          ? "Bildirim tercihini önce kaydedin."
          : "";

  return (
    <div className="page settings-page">
      <header className="page-header"><div><p className="section-kicker">AYARLAR</p><h1>Editoryal varsayılanlar ve bildirimler.</h1><p>Parola, erişim anahtarı ve benzeri gizli bilgiler bu ekranda tutulmaz. Buradaki tercihler yalnızca masaüstü deneyimini ve yeni içeriklerin başlangıç ayarlarını yönetir.</p></div></header>
      <section className="settings-panel">
        <div className="form-grid">
          <label className="field"><span>Varsayılan yazar</span><input name="author" value={form.author} disabled={readOnly || busy} onChange={(event) => setForm({ ...form, author: event.target.value })} /></label>
          <label className="field"><span>İnceleyen</span><input name="reviewer" value={form.reviewer} disabled={readOnly || busy} onChange={(event) => setForm({ ...form, reviewer: event.target.value })} /></label>
          <label className="field"><span>Varsayılan bölüm</span><select value={form.defaultSection} disabled={readOnly || busy} onChange={(event) => setForm({ ...form, defaultSection: event.target.value as Section })}><option value="haberler">Haberler</option><option value="teknoloji">Teknoloji</option><option value="ekonomi">Ekonomi ve iş</option><option value="analiz">Analiz</option><option value="dosyalar">Dosyalar</option><option value="rehberler">Rehberler</option><option value="kultur">Kültür</option><option value="yasam">Yaşam</option></select></label>
        </div>
        <div className="preference-toggles">
          <label><input type="checkbox" checked={autostart ?? false} disabled={readOnly || autostart === null || busy} aria-describedby={autostartStatusError ? "autostart-status-unavailable" : undefined} onChange={(event) => void toggleAutostart(event.target.checked)} /><span><strong>Windows ile başlat</strong><small>Blogbot oturum açılışında tepsiye hazır biçimde gelir; istediğiniz zaman kapatabilirsiniz.</small>{autostartStatusError ? <small id="autostart-status-unavailable" role="status">Windows başlangıç durumu okunamadı; bu ayar güvenle değiştirilemez.</small> : null}</span></label>
          <label><input type="checkbox" checked={form.notifications} disabled={readOnly || busy} onChange={(event) => setForm({ ...form, notifications: event.target.checked })} /><span><strong>Windows bildirimleri</strong><small>Bu cihazdaki yerel bildirim kanalını açar; kapalıyken test bildirimi gönderilmez.</small></span></label>
        </div>
        <div className="setup-actions">
          <button className="button button-primary" type="button" disabled={Boolean(saveUnavailableReason)} title={saveUnavailableReason || undefined} aria-describedby={saveUnavailableReason ? "settings-save-unavailable" : undefined} onClick={() => void save()}>{busy ? "Kaydediliyor…" : "Ayarları kaydet"}</button>
          <button className="button button-secondary" type="button" disabled={Boolean(cancelUnavailableReason)} title={cancelUnavailableReason || undefined} aria-describedby={cancelUnavailableReason ? "settings-cancel-unavailable" : undefined} onClick={() => { setForm(workspace.preferences); setMessage("Kaydedilmemiş değişiklikler geri alındı."); }}>Değişiklikleri iptal et</button>
          <button className="button button-secondary" type="button" disabled={Boolean(defaultsUnavailableReason)} title={defaultsUnavailableReason || undefined} aria-describedby={defaultsUnavailableReason ? "settings-defaults-unavailable" : undefined} onClick={() => { setForm(defaultPreferences); setMessage("Varsayılanlar forma yüklendi; kalıcı olması için kaydedin."); }}>Varsayılana dön</button>
          <button className="button button-secondary" type="button" disabled={Boolean(notificationUnavailableReason)} title={notificationUnavailableReason || undefined} aria-describedby={notificationUnavailableReason ? "settings-notification-unavailable" : undefined} onClick={() => void testNotification()}>Test bildirimi gönder</button>
          {saveUnavailableReason ? <small id="settings-save-unavailable" className="action-unavailable-reason">{saveUnavailableReason}</small> : null}
          {cancelUnavailableReason ? <small id="settings-cancel-unavailable" className="action-unavailable-reason">{cancelUnavailableReason}</small> : null}
          {defaultsUnavailableReason ? <small id="settings-defaults-unavailable" className="action-unavailable-reason">{defaultsUnavailableReason}</small> : null}
          {notificationUnavailableReason ? <small id="settings-notification-unavailable" className="action-unavailable-reason">{notificationUnavailableReason}</small> : null}
          <small>{readOnly ? "Yerel engine kurtarma modundayken ayarlar ve bildirim testi değişiklik yapmaz." : dirty ? "Kaydedilmemiş değişiklik var." : "Tüm değişiklikler kaydedildi."}</small>
        </div>
        {message ? <p className="form-message" role="status" aria-live="polite">{message}</p> : null}
      </section>
    </div>
  );
}
