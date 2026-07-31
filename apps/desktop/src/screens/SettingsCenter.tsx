import { useEffect, useState } from "react";

import type { BlogbotBridge } from "../bridge.ts";
import type { DesktopPreferences, EditorialWorkspaceSnapshot, Section } from "../types.ts";

interface SettingsCenterProps {
  bridge: BlogbotBridge;
  workspace: EditorialWorkspaceSnapshot;
  readOnly: boolean;
  onWorkspaceChange: (snapshot: EditorialWorkspaceSnapshot) => void;
}

export function SettingsCenter({ bridge, workspace, readOnly, onWorkspaceChange }: SettingsCenterProps) {
  const [form, setForm] = useState<DesktopPreferences>(workspace.preferences);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [autostart, setAutostart] = useState<boolean | null>(null);
  const dirty = JSON.stringify(form) !== JSON.stringify(workspace.preferences);

  useEffect(() => {
    let alive = true;
    void bridge.getAutostartStatus().then(({ enabled }) => {
      if (alive) setAutostart(enabled);
    }).catch(() => {
      if (alive) setAutostart(null);
    });
    return () => {
      alive = false;
    };
  }, [bridge]);

  const save = async () => {
    setBusy(true);
    setMessage("");
    try {
      await bridge.saveDesktopPreferences(form);
      onWorkspaceChange(await bridge.getEditorialWorkspace());
      setMessage("Masaüstü tercihleri kaydedildi.");
    } catch (reason) {
      setMessage(reason instanceof Error ? reason.message : "Ayarlar kaydedilemedi.");
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
        reason instanceof Error ? reason.message : "Test bildirimi gönderilemedi."
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
        reason instanceof Error
          ? reason.message
          : "Windows başlangıç ayarı değiştirilemedi."
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="page settings-page">
      <header className="page-header"><div><p className="section-kicker">AYARLAR</p><h1>Editoryal varsayılanlar ve bildirimler.</h1><p>Credential ve gizli anahtarlar bu ekranda tutulmaz. Bu tercihler masaüstü deneyimini ve üretilecek paketlerin varsayılanlarını yönetir.</p></div></header>
      <section className="settings-panel">
        <div className="form-grid">
          <label className="field"><span>Varsayılan yazar</span><input name="author" value={form.author} onChange={(event) => setForm({ ...form, author: event.target.value })} /></label>
          <label className="field"><span>İnceleyen</span><input name="reviewer" value={form.reviewer} onChange={(event) => setForm({ ...form, reviewer: event.target.value })} /></label>
          <label className="field"><span>Varsayılan bölüm</span><select value={form.defaultSection} onChange={(event) => setForm({ ...form, defaultSection: event.target.value as Section })}><option value="haberler">Haberler</option><option value="analiz">Analiz</option><option value="dosyalar">Dosyalar</option><option value="rehberler">Rehberler</option></select></label>
        </div>
        <div className="preference-toggles">
          <label><input type="checkbox" checked={autostart ?? false} disabled={autostart === null || busy} onChange={(event) => void toggleAutostart(event.target.checked)} /><span><strong>Windows ile başlat</strong><small>Blogbot oturum açılışında tepsiye hazır biçimde gelir; istediğiniz zaman kapatabilirsiniz.</small></span></label>
          <label><input type="checkbox" checked={form.notifications} onChange={(event) => setForm({ ...form, notifications: event.target.checked })} /><span><strong>Windows bildirimleri</strong><small>Onay, hata, limit ve yaklaşan yayın uyarıları.</small></span></label>
        </div>
        <div className="setup-actions">
          <button className="button button-primary" type="button" disabled={readOnly || busy || !dirty || form.author.trim().length < 2 || form.reviewer.trim().length < 2} onClick={() => void save()}>{busy ? "Kaydediliyor…" : "Ayarları kaydet"}</button>
          <button className="button button-secondary" type="button" onClick={() => void testNotification()}>Test bildirimi gönder</button>
          <small>{readOnly ? "Yerel engine kurtarma modundayken ayarlar değiştirilemez; bildirim testi yine çalışır." : dirty ? "Kaydedilmemiş değişiklik var." : "Tüm değişiklikler kaydedildi."}</small>
        </div>
        {message ? <p className="form-message" role="status" aria-live="polite">{message}</p> : null}
      </section>
    </div>
  );
}
