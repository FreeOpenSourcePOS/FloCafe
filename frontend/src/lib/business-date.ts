export function businessDateInTimezone(timeZone: string, startTime = '00:00', instant = new Date()): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(instant);
  const localPart = (type: string) => parts.find((part) => part.type === type)?.value ?? '';
  const localDate = `${localPart('year')}-${localPart('month')}-${localPart('day')}`;
  const normalizedStartTime = startTime.trim();
  if (!/^(?:0\d|1[01]):[0-5]\d$/.test(normalizedStartTime)) return localDate;
  const [hours, minutes] = normalizedStartTime.split(':').map(Number);
  const localMinutes = Number(localPart('hour')) * 60 + Number(localPart('minute'));
  if (localMinutes < hours * 60 + minutes) {
    return new Date(Date.UTC(Number(localPart('year')), Number(localPart('month')) - 1, Number(localPart('day')) - 1)).toISOString().slice(0, 10);
  }
  return localDate;
}
