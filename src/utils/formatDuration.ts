const MONTHS: Record<string, number> = {
  Jan: 0,
  Feb: 1,
  Mar: 2,
  Apr: 3,
  May: 4,
  Jun: 5,
  Jul: 6,
  Aug: 7,
  Sep: 8,
  Oct: 9,
  Nov: 10,
  Dec: 11,
};

/**
 * Formats an inclusive duration string (e.g. "1 yr 7 mos", "2 mos") from a
 * date range like "Nov 2026 – Present" or "May 2025 – Nov 2026".
 */
export function formatDuration(
  dateRange: string,
  now = new Date()
): string | undefined {
  const parts = dateRange.split(/\s*[–-]\s*/);
  if (parts.length !== 2) return undefined;

  const startMatch = parts[0].trim().match(/^([A-Za-z]{3})\s+(\d{4})$/);
  if (!startMatch) return undefined;
  const startMonth = MONTHS[startMatch[1]];
  const startYear = Number(startMatch[2]);
  if (startMonth === undefined) return undefined;

  let endMonth: number;
  let endYear: number;
  if (parts[1].trim().toLowerCase() === "present") {
    endMonth = now.getMonth();
    endYear = now.getFullYear();
  } else {
    const endMatch = parts[1].trim().match(/^([A-Za-z]{3})\s+(\d{4})$/);
    if (!endMatch) return undefined;
    endMonth = MONTHS[endMatch[1]];
    endYear = Number(endMatch[2]);
    if (endMonth === undefined) return undefined;
  }

  const totalMonths = (endYear - startYear) * 12 + (endMonth - startMonth) + 1;
  if (totalMonths < 1) return undefined;

  const years = Math.floor(totalMonths / 12);
  const months = totalMonths % 12;
  const segments: string[] = [];
  if (years > 0) segments.push(`${years} ${years === 1 ? "yr" : "yrs"}`);
  if (months > 0) segments.push(`${months} ${months === 1 ? "mo" : "mos"}`);
  return segments.join(" ");
}

