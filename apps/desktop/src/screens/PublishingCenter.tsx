import { useEffect, useRef, useState } from "react";

import { userFacingBridgeError, type BlogbotBridge } from "../bridge.ts";
import { handleTabListKeyDown } from "../components/tab-keyboard.ts";
import { sectionLabel, slotStateLabel } from "../app-model.ts";
import {
  PREFERRED_PUBLISHING_TIMES,
  recommendBalancedSeoSlots,
  resolveScheduleTime,
  scheduleTimeChoice,
  type ScheduleTimeChoice
} from "../schedule-options.ts";
import type { ConnectorStateSnapshot, EditorialWorkspaceSnapshot } from "../types.ts";

interface SlotDraft {
  enabled: boolean;
  choice: ScheduleTimeChoice;
  customTime: string;
}

const HOURS = Array.from({ length: 24 }, (_, hour) => String(hour).padStart(2, "0"));
const MINUTES = Array.from({ length: 60 }, (_, minute) => String(minute).padStart(2, "0"));

function customTimeParts(value: string): { hour: string; minute: string } {
  const match = /^(\d{2}):(\d{2})$/u.exec(value);
  return match ? { hour: match[1]!, minute: match[2]! } : { hour: "12", minute: "00" };
}

function slotLabel(slot: EditorialWorkspaceSnapshot["weeklySlots"][number]): string {
  const position = /-(\d+)$/u.exec(slot.id)?.[1] ?? "1";
  return `${slot.dayLabel} · ${position}. slot`;
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
  connectorState: ConnectorStateSnapshot;
  readOnly: boolean;
  onWorkspaceChange: (snapshot: EditorialWorkspaceSnapshot) => void;
  onConnectorStateChange: (snapshot: ConnectorStateSnapshot) => void;
}

export function PublishingCenter({
  bridge,
  workspace,
  connectorState,
  readOnly,
  onWorkspaceChange,
  onConnectorStateChange
}: PublishingCenterProps) {
  const [tab, setTab] = useState<"calendar" | "scheduled" | "history">("calendar");
  const [busyId, setBusyId] = useState("");
  const [message, setMessage] = useState("");
  const [refreshing, setRefreshing] = useState(false);
  const [suggestingSeoSlots, setSuggestingSeoSlots] = useState(false);
  const [slotDrafts, setSlotDrafts] = useState<Record<string, SlotDraft>>({});
  const [activeSlotId, setActiveSlotId] = useState("");
  const refreshRequestId = useRef(0);
  const siteMode = connectorState.mode;

  useEffect(() => {
    return () => {
      refreshRequestId.current += 1;
    };
  }, []);

  const getSlotDraft = (slot: EditorialWorkspaceSnapshot["weeklySlots"][number]): SlotDraft =>
    slotDrafts[slot.id] ?? {
      enabled: slot.enabled,
      choice: scheduleTimeChoice(slot.time),
      customTime: slot.time
    };

  const slotActionUnavailableReason = (slotId: string): string =>
    readOnly
      ? "Yerel çalışma alanı yeniden bağlanana kadar bu slot değiştirilemez."
      : busyId === slotId
        ? "Bu slot kaydediliyor; işlem tamamlanana kadar bekleyin."
        : "";

  const updateSlotDraft = (slotId: string, update: Partial<SlotDraft>) => {
    const slot = workspace.weeklySlots.find((entry) => entry.id === slotId);
    if (!slot) return;
    setSlotDrafts((current) => ({ ...current, [slotId]: { ...getSlotDraft(slot), ...current[slotId], ...update } }));
  };

  const refresh = async () => {
    const requestId = refreshRequestId.current + 1;
    refreshRequestId.current = requestId;
    setRefreshing(true);
    setMessage("");
    try {
      const [nextWorkspace, nextConnectorState] = await Promise.all([
        bridge.getEditorialWorkspace(),
        bridge.getConnectorState()
      ]);
      if (requestId !== refreshRequestId.current) return;
      onWorkspaceChange(nextWorkspace);
      onConnectorStateChange(nextConnectorState);
      setMessage("Takvim ve yayın durumu yerel veriden yenilendi.");
    } catch {
      if (requestId !== refreshRequestId.current) return;
      setMessage("Takvim ve yayın durumu yenilenemedi. Yerel engine ve bağlantıları Kurulum Merkezi'nden denetleyin.");
    } finally {
      if (requestId === refreshRequestId.current) setRefreshing(false);
    }
  };

  const saveSlot = async (slot: EditorialWorkspaceSnapshot["weeklySlots"][number]) => {
    const draft = getSlotDraft(slot);
    setBusyId(slot.id);
    setMessage("");
    try {
      const time = resolveScheduleTime(draft.choice, draft.customTime);
      await bridge.updateScheduleSlot({
        slotId: slot.id,
        enabled: draft.enabled,
        time
      });
      setSlotDrafts((current) => {
        const { [slot.id]: _saved, ...rest } = current;
        return rest;
      });
      try {
        onWorkspaceChange(await bridge.getEditorialWorkspace());
        setMessage(`${slot.dayLabel} için haftalık yayın slotu güncellendi.`);
      } catch {
        setMessage(`${slot.dayLabel} için haftalık yayın slotu güncellendi; takvim görünümü henüz yenilenemedi. Takvim durumunu yenileyin.`);
      }
    } catch (reason) {
      setMessage(userFacingBridgeError(reason, "Slot güncellenemedi."));
    } finally {
      setBusyId("");
    }
  };

  const suggestSeoSlots = async () => {
    const recommendations = recommendBalancedSeoSlots(workspace.weeklySlots);
    if (recommendations.length === 0) {
      setMessage("Atanmamış uygun slot bulunamadı; mevcut editoryal plan korunuyor.");
      return;
    }
    setSuggestingSeoSlots(true);
    setMessage("");
    try {
      await Promise.all(recommendations.map((recommendation) => bridge.updateScheduleSlot({
        ...recommendation,
        articleId: null,
        articleTitle: null
      })));
      onWorkspaceChange(await bridge.getEditorialWorkspace());
      setMessage(`${recommendations.length} dengeli SEO slotu yerel takvime uygulandı.`);
    } catch (reason) {
      setMessage(userFacingBridgeError(reason, "SEO saat önerisi kaydedilemedi."));
    } finally {
      setSuggestingSeoSlots(false);
    }
  };

  return (
    <div className="page hub-page">
      <header className="page-header">
        <div>
          <p className="section-kicker">{siteMode === "PUBLISH" ? "TAKVİM VE YAYIN" : "TAKVİM VE ÇIKTI"}</p>
          <h1>{siteMode === "PUBLISH" ? "Haftalık ritim, hazır yayınlar ve geçmiş." : "Haftalık ritim, hazır çıktılar ve geçmiş."}</h1>
          <p>Her gün için beşe kadar yayın saati açın. Yeni taslaklar için NEXT_SLOT ritmi budur; onaylı bir içerik bu takvimden atanmaz veya planlanmaz.</p>
          {readOnly ? (
            <p className="inline-notice" role="status" aria-live="polite">
              Takvim ayarları yerel çalışma alanı yeniden bağlanana kadar salt okunur.
            </p>
          ) : null}
        </div>
        <div className="page-header-actions">
          <button className="button button-secondary" type="button" disabled={readOnly || suggestingSeoSlots} onClick={() => void suggestSeoSlots()}>
            {suggestingSeoSlots ? "SEO saatleri uygulanıyor…" : "Dengeli SEO saatlerini öner"}
          </button>
        <button className="button button-secondary" type="button" disabled={refreshing} onClick={() => void refresh()}>
          {refreshing ? "Yenileniyor…" : "Takvim durumunu yenile"}
        </button>
        </div>
      </header>
      <div className="workspace-tabs" role="tablist" aria-label="Yayın bölümleri" onKeyDown={handleTabListKeyDown}>
        {([
          ["calendar", "Haftalık takvim"],
          ["scheduled", `Planlananlar · ${workspace.scheduled.length}`],
          ["history", "Yayın geçmişi"]
        ] as const).map(([id, label]) => (
          <button key={id} type="button" role="tab" id={`publishing-tab-${id}`} aria-controls={`publishing-panel-${id}`} aria-selected={tab === id} tabIndex={tab === id ? 0 : -1} className={tab === id ? "is-active" : ""} onClick={() => setTab(id)}>{label}</button>
        ))}
      </div>
      <section className="hub-panel" role="tabpanel" id={`publishing-panel-${tab}`} aria-labelledby={`publishing-tab-${tab}`}>
        {tab === "calendar" ? (
          <div className="week-grid">
            {workspace.weeklySlots.map((slot) => {
              const actionReason = slotActionUnavailableReason(slot.id);
              const actionReasonId = `slot-action-unavailable-${slot.id}`;
              const legacyAssignment = slot.articleId || slot.articleTitle
                ? `Geçmiş atama: ${slot.articleTitle ?? slot.articleId}. Bu bilgi yeni planlama yapmaz.`
                : null;
              const activeSlot = activeSlotId || workspace.weeklySlots[0]?.id;
              if (slot.id !== activeSlot) {
                return (
                  <button
                    className={`slot-summary ${getSlotDraft(slot).enabled ? "" : "is-disabled"}`}
                    type="button"
                    key={slot.id}
                    aria-pressed={false}
                    aria-label={`${slotLabel(slot)}: Takvimde bu slotu düzenle`}
                    onClick={() => setActiveSlotId(slot.id)}
                  >
                    <span><strong>{slotLabel(slot)}</strong><em>{getSlotDraft(slot).enabled ? resolveScheduleTime(getSlotDraft(slot).choice, getSlotDraft(slot).customTime) : "Kapalı"}</em></span>
                    <span className={`state-pill state-${slot.state.toLowerCase()}`}>{slotStateLabel(slot.state)}</span>
                    <small>{legacyAssignment ?? "Yeni taslaklar ilk uygun etkin slota göre ilerler."}</small>
                  </button>
                );
              }
              return (
              <article aria-label={`${slotLabel(slot)} yayın slotu`} className={`slot-card slot-card-active ${getSlotDraft(slot).enabled ? "" : "is-disabled"}`} key={slot.id}>
                <div><strong>{slotLabel(slot)}</strong><span className={`state-pill state-${slot.state.toLowerCase()}`}>{slotStateLabel(slot.state)}</span></div>
                <label className="slot-time-field">
                  <span>Yayın saati</span>
                  <select
                    aria-label={`${slot.dayLabel} yayın saati seçimi`}
                    value={getSlotDraft(slot).choice}
                    disabled={readOnly || busyId === slot.id}
                    aria-describedby={actionReason ? actionReasonId : undefined}
                    onChange={(event) => updateSlotDraft(slot.id, { choice: event.target.value as ScheduleTimeChoice })}
                  >
                    {PREFERRED_PUBLISHING_TIMES.map((time) => <option key={time} value={time}>{time}</option>)}
                    <option value="CUSTOM">Özel saat…</option>
                  </select>
                </label>
                {getSlotDraft(slot).choice === "CUSTOM" ? (
                  <fieldset className="slot-custom-time" disabled={readOnly || busyId === slot.id} aria-describedby={actionReason ? actionReasonId : undefined}>
                    <legend>Özel saat (24 saat)</legend>
                    <label>
                      <span>Saat</span>
                      <select
                        aria-label={`${slot.dayLabel} özel saat`}
                        value={customTimeParts(getSlotDraft(slot).customTime).hour}
                        onChange={(event) => updateSlotDraft(slot.id, { customTime: `${event.target.value}:${customTimeParts(getSlotDraft(slot).customTime).minute}` })}
                      >
                        {HOURS.map((hour) => <option key={hour} value={hour}>{hour}</option>)}
                      </select>
                    </label>
                    <span aria-hidden="true">:</span>
                    <label>
                      <span>Dakika</span>
                      <select
                        aria-label={`${slot.dayLabel} özel dakika`}
                        value={customTimeParts(getSlotDraft(slot).customTime).minute}
                        onChange={(event) => updateSlotDraft(slot.id, { customTime: `${customTimeParts(getSlotDraft(slot).customTime).hour}:${event.target.value}` })}
                      >
                        {MINUTES.map((minute) => <option key={minute} value={minute}>{minute}</option>)}
                      </select>
                    </label>
                    <output aria-label={`${slot.dayLabel} seçilen özel yayın saati`}>{getSlotDraft(slot).customTime}</output>
                  </fieldset>
                ) : null}
                {legacyAssignment ? <p>{legacyAssignment}</p> : null}
                <label className="toggle-label">
                  <input
                    type="checkbox"
                    checked={getSlotDraft(slot).enabled}
                    disabled={readOnly || busyId === slot.id}
                    aria-describedby={actionReason ? actionReasonId : undefined}
                    onChange={(event) => updateSlotDraft(slot.id, { enabled: event.target.checked })}
                  />
                  <span>{getSlotDraft(slot).enabled ? "Slot etkin" : "Slot kapalı"}</span>
                </label>
                <button className="button button-secondary slot-save" type="button" disabled={readOnly || busyId === slot.id} aria-describedby={actionReason ? actionReasonId : undefined} onClick={() => void saveSlot(slot)}>
                  {busyId === slot.id ? "Kaydediliyor…" : "Slotu kaydet"}
                </button>
                {actionReason ? <small id={actionReasonId} className="action-unavailable-reason">{actionReason}</small> : null}
                {busyId === slot.id ? <div className="slot-progress" role="progressbar" aria-label={`${slot.dayLabel} slotu kaydediliyor`} aria-valuetext="Takvim ayarı kaydediliyor"><span /></div> : null}
              </article>
              );
            })}
          </div>
        ) : null}
        {tab === "scheduled" ? (
          <div className="data-list">
            {workspace.scheduled.map((item) => (
              <article className="data-row" key={item.id}>
                <div><strong>{item.title}</strong><small>{sectionLabel(item.section)} · {new Date(item.scheduledAt).toLocaleString("tr-TR")}</small></div>
                <code>{item.targetPath}</code>
                <span className={`state-pill state-${item.state.toLowerCase()}`}>{siteMode === "PUBLISH" ? publicationStateLabel[item.state] : publicationStateLabel[item.state].replace("Yayın", "Çıktı")} · {ciStateLabel[item.ciState]}</span>
              </article>
            ))}
            {workspace.scheduled.length === 0 ? (
              <div className="empty-state"><strong>Planlanmış içerik yok.</strong><span>Editoryal Masa'da değişmez revizyonu onayladıktan sonra uygun bir haftalık slota atayın.</span></div>
            ) : null}
          </div>
        ) : null}
        {tab === "history" ? (
          <div className="data-list">
            {workspace.history.map((item) => (
              <article className="data-row" key={item.id}>
                <div><strong>{item.title}</strong><small>{new Date(item.publishedAt).toLocaleString("tr-TR")} · {sectionLabel(item.section)}</small></div>
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
            {workspace.history.length === 0 ? (
              <div className="empty-state"><strong>Henüz çıktı geçmişi yok.</strong><span>Başarı yalnız yerel engine tamamlanan işlemi doğruladığında burada görünür.</span></div>
            ) : null}
          </div>
        ) : null}
        {message ? <p className="form-message" role="status" aria-live="polite">{message}</p> : null}
      </section>
    </div>
  );
}
