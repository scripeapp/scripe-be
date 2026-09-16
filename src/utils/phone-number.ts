const DEFAULT_COUNTRY_CODE = process.env.DEFAULT_PHONE_COUNTRY_CODE || "234";

export function normalizeInternationalPhone(phone: string): string | null {
  const digits = phone.replace(/\D/g, "");
  if (!digits) return null;

  const international = digits.startsWith("0")
    ? `${DEFAULT_COUNTRY_CODE}${digits.slice(1)}`
    : digits;

  return /^\d{10,15}$/.test(international) ? international : null;
}

