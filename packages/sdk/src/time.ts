const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const WEEK = 7 * DAY;

const startOfDay = (at: number) => new Date(at).setHours(0, 0, 0, 0);

/**
 * A time for lists and labels, in the product's English: `just now`,
 * `5 minutes ago`, `3 hours ago`, `Yesterday`, `4 days ago`, then `Oct 28`
 * (with the year when it is not the current one). Times ahead, such as an
 * expiry, read `in 3 hours`, `Tomorrow`, `in 5 days`, then the date. Every surface that shows
 * when something happened uses it, so times read the same everywhere; pair
 * it with {@link fullTime} for the exact moment.
 *
 * @stability experimental
 */
export function relativeTime(at: number, now = Date.now()): string {
  if (at - now >= 45_000) return untilTime(at, now);
  const elapsed = now - at;
  if (elapsed < 45_000) return "just now";
  if (elapsed < HOUR) {
    const minutes = Math.max(1, Math.round(elapsed / MINUTE));
    return minutes === 1 ? "1 minute ago" : `${minutes} minutes ago`;
  }
  const days = Math.round((startOfDay(now) - startOfDay(at)) / DAY);
  if (days === 0) {
    const hours = Math.max(1, Math.round(elapsed / HOUR));
    return hours === 1 ? "1 hour ago" : `${hours} hours ago`;
  }
  if (days === 1) return "Yesterday";
  if (elapsed < WEEK) return `${days} days ago`;
  return shortDate(at, now);
}

/** A time ahead, such as an expiry: `in 3 hours`, `Tomorrow`, `in 5 days`, `Nov 6`. */
function untilTime(at: number, now: number): string {
  const ahead = at - now;
  if (ahead < HOUR) {
    const minutes = Math.max(1, Math.round(ahead / MINUTE));
    return minutes === 1 ? "in 1 minute" : `in ${minutes} minutes`;
  }
  const days = Math.round((startOfDay(at) - startOfDay(now)) / DAY);
  if (days === 0) {
    const hours = Math.max(1, Math.round(ahead / HOUR));
    return hours === 1 ? "in 1 hour" : `in ${hours} hours`;
  }
  if (days === 1) return "Tomorrow";
  if (ahead < WEEK) return `in ${days} days`;
  return shortDate(at, now);
}

function shortDate(at: number, now: number): string {
  const date = new Date(at);
  return date.toLocaleDateString("en", {
    month: "short",
    day: "numeric",
    ...(date.getFullYear() !== new Date(now).getFullYear() && {
      year: "numeric",
    }),
  });
}

/**
 * The exact moment, for a tooltip or a detail line: `Oct 28, 2026, 1:16 PM`.
 *
 * @stability experimental
 */
export function fullTime(at: number): string {
  return new Date(at).toLocaleString("en", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}
