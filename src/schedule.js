const DEFAULT_TIME_ZONE = 'Asia/Kolkata';
const DEFAULT_HOUR = 3;
const formatterCache = new Map();

function getFormatter(timeZone) {
  let formatter = formatterCache.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    });
    formatterCache.set(timeZone, formatter);
  }
  return formatter;
}

function getZonedParts(date, timeZone) {
  const values = {};
  for (const part of getFormatter(timeZone).formatToParts(date)) {
    if (part.type !== 'literal') values[part.type] = Number(part.value);
  }
  return {
    year: values.year,
    month: values.month,
    day: values.day,
    hour: values.hour === 24 ? 0 : values.hour,
    minute: values.minute,
    second: values.second,
  };
}

function zonedDateTimeToDate(year, month, day, hour, timeZone) {
  const target = Date.UTC(year, month - 1, day, hour, 0, 0, 0);
  let timestamp = target;

  for (let attempt = 0; attempt < 4; attempt += 1) {
    const parts = getZonedParts(new Date(timestamp), timeZone);
    const observed = Date.UTC(
      parts.year,
      parts.month - 1,
      parts.day,
      parts.hour,
      parts.minute,
      parts.second,
    );
    const difference = target - observed;
    if (difference === 0) break;
    timestamp += difference;
  }

  return new Date(timestamp);
}

function calendarDateAtHour(date, daysToAdd, hour, timeZone) {
  const parts = getZonedParts(date, timeZone);
  const anchor = new Date(Date.UTC(parts.year, parts.month - 1, parts.day + daysToAdd, 12, 0, 0));
  const anchorParts = getZonedParts(anchor, timeZone);
  return zonedDateTimeToDate(anchorParts.year, anchorParts.month, anchorParts.day, hour, timeZone);
}

export function resolveScheduleOptions({ timeZone, hour } = {}) {
  const resolvedTimeZone = timeZone || DEFAULT_TIME_ZONE;
  const resolvedHour = hour === undefined || hour === '' ? DEFAULT_HOUR : Number(hour);

  if (!Number.isInteger(resolvedHour) || resolvedHour < 0 || resolvedHour > 23) {
    throw new Error('WEBHOOK_SCHEDULE_HOUR must be an integer between 0 and 23');
  }

  try {
    getFormatter(resolvedTimeZone).format(new Date());
  } catch {
    throw new Error(`Invalid webhook schedule timezone: ${resolvedTimeZone}`);
  }

  return { timeZone: resolvedTimeZone, hour: resolvedHour };
}

export function nextScheduledRun(now = new Date(), options = {}) {
  const { timeZone, hour } = resolveScheduleOptions(options);
  const parts = getZonedParts(now, timeZone);
  const today = zonedDateTimeToDate(parts.year, parts.month, parts.day, hour, timeZone);
  if (today.getTime() > now.getTime()) return today;

  const tomorrow = calendarDateAtHour(now, 1, hour, timeZone);
  return tomorrow;
}

export function addScheduledDays(date, days, options = {}) {
  if (!Number.isInteger(days) || days < 1) throw new Error('Schedule interval must be a positive number of days');
  const { timeZone, hour } = resolveScheduleOptions(options);
  return calendarDateAtHour(date, days, hour, timeZone);
}

export function nextScheduledRunAfter(dueAt, intervalDays, now = new Date(), options = {}) {
  if (!Number.isInteger(intervalDays) || intervalDays < 1) {
    throw new Error('Schedule interval must be a positive number of days');
  }

  let candidate = addScheduledDays(dueAt, intervalDays, options);
  let attempts = 0;
  while (candidate.getTime() <= now.getTime() && attempts < 5000) {
    candidate = addScheduledDays(candidate, intervalDays, options);
    attempts += 1;
  }
  return candidate;
}

export { DEFAULT_HOUR, DEFAULT_TIME_ZONE };
