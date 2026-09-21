/** True for IANA timezone names Node's ICU data knows about, e.g. "Asia/Kolkata" or "UTC". */
export function isValidTimezone(value: string): boolean {
  if (value.length === 0 || value.length > 64) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value });
    return true;
  } catch {
    return false;
  }
}
