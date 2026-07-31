import { useState } from "react";

import type { BlogbotBridge } from "../bridge.ts";
import type { EditorialWorkspaceSnapshot } from "../types.ts";

type SiteWorkMode = "LOCAL_ONLY" | "LOCAL_DEV" | "PUBLISH";

function selectedSiteMode(): SiteWorkMode {
  try {
    const value = JSON.parse(localStorage.getItem("blogbot.setup.connector-draft.v1") ?? "null") as { site?: { mode?: string } } | null;
    return value?.site?.mode === "PUBLISH" || value?.site?.mode === "LOCAL_DEV" ? value.site.mode : "LOCAL_ONLY";
  } catch {
    return "LOCAL_ONLY";
  }
}

const publicationStateLabel: Record<"READY" | "BLOCKED" | "PUBLISHING", string> = {
  READY: "Yayın niyeti hazır",
  BLOCKED: "Yayın engellendi",
  PUBLISHING: "Yayın kuyruğunda"
};

const ciStateLabel: Record<"NOT_STARTED" | "RUNNING" | "PASSED" | "FAILED", string> = {
  NOT_STARTED: "Kontrol başlamadı",
  RUNNING: "Kontrol ediliyor",
  PASSED: "Kontroller geçti",
  FAILED: "Kontrol başarısız"
};

interface PublishingCenterProps {
  bridge: BlogbotBridge;
  workspace: EditorialWorkspaceSnapshot;
  readOnly: boolean;
  onWorkspaceChange: (snapshot: EditorialWorkspaceSnapshot) => void;
}

export function PublishingCenter({
  bridge,
  workspace,
  readOnly,
  onWorkspaceChange
}: PublishingCenterProps) {
  const [tab, setTab] = useState<"calendar" | "scheduled" | "history">("calendar");
  const [busyId, setBusyId] = useState("");
  const [message, setMessage] = useState("");
  const siteMode = selectedSiteMode();

  const saveSlot = async (slotId: string, enabled: boolean, time: string) => {
    setBusyId(slotId);
    setMessage("");
    try {
      await bridge.updateScheduleSlot({ slotId, enabled, time });
      onWorkspaceChange(await bridge.getEditorialWorkspace());
      setMessage("Haftalık yayın slotu güncellendi.");
    } catch (reason) {
      setMessage(reason instanceof Error ? reason.message : "Slot güncellenemedi.");
    } finally {
      setBusyId("");
    }
  };

  return (
    <div className="page hub-page">
      <header className="page-header">
        <div>
          <p className="section-kicker">{siteMode === "PUBLISH" ? "TAKVİM VE YAYIN" : "TAKVİM VE ÇIKTI"}</p>
          <h1>{siteMode === "PUBLISH" ? "Haftalık ritim, hazır yayınlar ve geçmiş." : "Haftalık ritim, hazır çıktılar ve geçmiş."}</h1>
          <p>İstanbul saatindeki yedi varsayılan slotu yönetin. Süresi geçen içerik kendiliğinden işleme alınmaz.</p>
        </div>
      </header>
      <div className="workspace-tabs" role="tablist" aria-label="Yayın bölümleri">
        {([
          ["calendar", "Haftalık takvim"],
          ["scheduled", `Planlananlar · ${workspace.scheduled.length}`],
          ["history", "Yayın geçmişi"]
        ] as const).map(([id, label]) => (
          <button key={id} type="button" role="tab" aria-selected={tab === id} className={tab === id ? "is-active" : ""} onClick={() => setTab(id)}>{label}</button>
        ))}
      </div>
      <section className="hub-panel" role="tabpanel">
        {tab === "calendar" ? (
          <div className="week-grid">
            {workspace.weeklySlots.map((slot) => (
              <article className={`slot-card ${slot.enabled ? "" : "is-disabled"}`} key={slot.id}>
                <div><strong>{slot.dayLabel}</strong><span className={`state-pill state-${slot.state.toLowerCase()}`}>{slot.state}</span></div>
                <input
                  aria-label={`${slot.dayLabel} yayın saati`}
                  type="time"
                  value={slot.time}
                  disabled={readOnly || busyId === slot.id}
                  onChange={(event) => void saveSlot(slot.id, slot.enabled, event.target.value)}
                />
                <p>{slot.articleTitle ?? "Henüz içerik atanmadı"}</p>
                <label className="toggle-label">
                  <input
                    type="checkbox"
                    checked={slot.enabled}
                    disabled={readOnly || busyId === slot.id}
                    onChange={(event) => void saveSlot(slot.id, event.target.checked, slot.time)}
                  />
                  <span>{slot.enabled ? "Slot etkin" : "Slot kapalı"}</span>
                </label>
              </article>
            ))}
          </div>
        ) : null}
        {tab === "scheduled" ? (
          <div className="data-list">
            {workspace.scheduled.map((item) => (
              <article className="data-row" key={item.id}>
                <div><strong>{item.title}</strong><small>{item.section} · {new Date(item.scheduledAt).toLocaleString("tr-TR")}</small></div>
                <code>{item.targetPath}</code>
                <span className={`state-pill state-${item.state.toLowerCase()}`}>{siteMode === "PUBLISH" ? publicationStateLabel[item.state] : publicationStateLabel[item.state].replace("Yayın", "Çıktı")} · {ciStateLabel[item.ciState]}</span>
              </article>
            ))}
          </div>
        ) : null}
        {tab === "history" ? (
          <div className="data-list">
            {workspace.history.map((item) => (
              <article className="data-row" key={item.id}>
                <div><strong>{item.title}</strong><small>{new Date(item.publishedAt).toLocaleString("tr-TR")} · {item.section}</small></div>
                {item.url ? <a href={item.url} target="_blank" rel="noreferrer">Yayın URL'si</a> : <span className="muted">{siteMode === "PUBLISH" ? "Site adresi yapılandırılmadı" : "Yerel hedefe yazıldı"}</span>}
                <span className={`state-pill state-${item.verificationState.toLowerCase()}`}>
                  {item.verificationState === "VERIFIED" || item.verificationState === "PASSED"
                    ? "Doğrulandı"
                    : item.verificationState === "UNVERIFIED" || item.verificationState === "WARNING"
                      ? "Doğrulama bekliyor"
                      : "Başarısız"}
                </span>
              </article>
            ))}
          </div>
        ) : null}
        {message ? <p className="form-message" role="status" aria-live="polite">{message}</p> : null}
      </section>
    </div>
  );
}
