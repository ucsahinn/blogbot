export interface OperationTimestamp {
  label: string;
  dateTime?: string;
}

const operationTimestampFormatter = new Intl.DateTimeFormat("tr-TR", {
  dateStyle: "long",
  timeStyle: "short",
  timeZone: "Europe/Istanbul"
});

export function formatOperationTimestamp(value: string): OperationTimestamp {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return { label: "Zaman bilgisi alınamadı" };
  }
  return {
    label: operationTimestampFormatter.format(parsed),
    dateTime: value
  };
}