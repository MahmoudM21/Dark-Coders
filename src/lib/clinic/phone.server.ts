const ARABIC_INDIC = "٠١٢٣٤٥٦٧٨٩";
const PERSIAN = "۰۱۲۳۴۵۶۷۸۹";

function toAsciiDigits(value: string): string {
  return Array.from(value)
    .map((char) => {
      const ai = ARABIC_INDIC.indexOf(char);
      if (ai >= 0) return String(ai);
      const pi = PERSIAN.indexOf(char);
      if (pi >= 0) return String(pi);
      return char;
    })
    .join("");
}

export function normalizePhone(raw: string, defaultCountry: "EG" | string = "EG"): string | null {
  const normalized = toAsciiDigits(raw).trim();
  if (!normalized) return null;

  let cleaned = normalized.replace(/[\s\-()]+/g, "");
  if (cleaned.startsWith("00")) cleaned = `+${cleaned.slice(2)}`;

  if (defaultCountry === "EG") {
    // Egyptian mobile "01XXXXXXXXX" (11 digits): drop the trunk 0, then add +20.
    if (/^01\d{9}$/.test(cleaned)) return `+20${cleaned.slice(1)}`;
    if (/^20\d{10}$/.test(cleaned)) cleaned = `+${cleaned}`;
  }

  if (!cleaned.startsWith("+")) return null;
  if (!/^\+[1-9][0-9]{7,14}$/.test(cleaned)) return null;
  return cleaned;
}
