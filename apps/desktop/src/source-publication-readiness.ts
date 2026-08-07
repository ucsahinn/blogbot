export interface SourcePublicationReview {
  canPublish: boolean;
  trustStatus: "PENDING" | "APPROVED" | "REJECTED";
  rightsStatus: "PENDING" | "APPROVED" | "REJECTED";
}

export interface SourcePublicationReadiness {
  label: string;
  detail: string;
  tone: "ready" | "attention" | "blocked";
}

export function describeSourcePublicationReadiness(source: SourcePublicationReview): SourcePublicationReadiness {
  if (source.canPublish && source.trustStatus === "APPROVED" && source.rightsStatus === "APPROVED") {
    return {
      label: "Kanıt olarak kullanıma hazır",
      detail: "Kaynak makalede kanıt olarak kullanılabilir. Makale onayı için son adım: Editoryal Masa > TR / EN inceleme ekranında tam revizyonu onaylayın.",
      tone: "ready"
    };
  }

  const rejected = [
    source.trustStatus === "REJECTED" ? "Güven değerlendirmesi reddedildi." : "",
    source.rightsStatus === "REJECTED" ? "Kullanım hakkı değerlendirmesi reddedildi." : ""
  ].filter(Boolean);
  if (rejected.length > 0) {
    return {
      label: "Kanıt olarak kullanılamaz",
      detail: `${rejected.join(" ")} Kaynak taranabilir, ancak makalede kanıt olarak seçilemez.`,
      tone: "blocked"
    };
  }

  const pending = [
    source.trustStatus === "PENDING" ? "Güven değerlendirmesi tamamlanmadı." : "",
    source.rightsStatus === "PENDING" ? "Kullanım hakkı değerlendirmesi tamamlanmadı." : ""
  ].filter(Boolean);
  return {
    label: "Araştırma kullanımı için karar bekliyor",
    detail: `${pending.join(" ")} Kaynak taranabilir. Araştırmada kanıt olarak kullanmadan önce güven ve kullanım hakkını tek insan kararıyla kaydedin. Bu bir makale/yayın onayı değildir.`,
    tone: "attention"
  };
}
