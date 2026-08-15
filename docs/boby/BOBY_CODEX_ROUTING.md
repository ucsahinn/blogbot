# Boby - Codex yönlendirme tasarımı

## Rol seçimi

| Boby görevi | Mantıksal rol | Neden |
| --- | --- | --- |
| Ekran rehberliği, kısa açıklama, menü yönlendirmesi | `FAST` | Düşük gecikme ve kısa, yapılandırılmış yanıt |
| Makale/araştırma üretimi | Mevcut editoryal akıştaki `DEFAULT` | Boby sohbetinden ayrı, kanıtlı iş akışı |
| İddia çelişkisi ve yüksek risk incelemesi | Mevcut editoryal akıştaki `DEEP_REVIEW` | Normal sohbetin değil inceleme kapısının işi |

“Luna low” ürün ekranında hızlı Boby deneyiminin adı olabilir; teknik tarafta
mevcut `FAST` rolünün model seçimi kullanılır. Kod belirli ve erişilemeyebilecek
bir model adını sabitlemez; kullanıcının Codex hesabının kullanılabilir modeli
çalıştırıcı tarafından çözülür.

## Kuyruklu konuşma akışı

```text
Kullanıcı sorar
  -> yerel giriş doğrulama ve sır ayıklama
  -> BOBY_CHAT işi idempotent olarak yerel kuyruğa yazılır
  -> panel bekliyor durumunu gösterir, ana ekran serbest kalır
  -> izole Codex runner (read-only, araçsız, şema doğrulamalı)
  -> sadece allowlist eylemli yanıt
  -> panel sonucu gösterir veya güvenli yerel rehberliğe döner
```

Bu işlem yayın, onay ve ayar değişikliği üretmez. Boby'nin eylem önerisine
kullanıcının görünür düğmeyle basması gerekir.

## Güvenlik sınırları

- Runner `read-only`, araçsız ve geçici çalışma bağlamında çalışır.
- Prompt, çıktı şeması ve eylem kimlikleri sürümlenmiş kod sözleşmesidir.
- Sohbet işi normal taslak işlerinden ayrıdır; bir sohbet hatası taslak veya
  yayın kuyruğunu bloke etmez.
- Tanılama paketi sadece durum sınıfını kaydeder; soru ve model cevabı varsayılan
  olarak pakete eklenmez.
- En fazla 20 yerel görünür mesaj tutularak bellek ve arayüz büyümesi sınırlandırılır.
