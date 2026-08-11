const ISO_TIMESTAMP = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?(Z|([+-])(\d{2}):(\d{2}))$/;
const RFC_UTC_TIMESTAMP = /^(Mon|Tue|Wed|Thu|Fri|Sat|Sun), (\d{1,2}) (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) (\d{4}) (\d{2}):(\d{2}):(\d{2}) (GMT|UTC|[+-]0000)$/i;

const MONTHS = Object.freeze({
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
} as const);

function leapYear(year: number): boolean {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}

function daysInMonth(year: number, month: number): number {
  if (month === 2) return leapYear(year) ? 29 : 28;
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

function validDateTime(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  second: number,
): boolean {
  return year >= 1_000 && year <= 9_999
    && month >= 1 && month <= 12
    && day >= 1 && day <= daysInMonth(year, month)
    && hour >= 0 && hour <= 23
    && minute >= 0 && minute <= 59
    && second >= 0 && second <= 59;
}

function supportedUtcResult(milliseconds: number): string | null {
  if (!Number.isFinite(milliseconds)) return null;
  const canonical = new Date(milliseconds).toISOString();
  const year = Number(canonical.slice(0, 4));
  return canonical.length === 24 && year >= 1_000 && year <= 9_999 ? canonical : null;
}

/**
 * Evidence timestamps require a complete date-time and explicit timezone.
 * Accepted inputs are ISO-8601 with `Z` or a `+/-HH:MM` offset, plus legacy
 * RFC 1123/2822 UTC feed dates. Fractional seconds are limited to millisecond
 * precision and the canonical UTC result must remain in years 1000-9999.
 * Leading and trailing ASCII spaces are ignored; other whitespace, date-only,
 * and offsetless values are rejected.
 */
export function canonicalEvidenceTimestamp(value: unknown): string | null {
  const text = String(value ?? "").replace(/^ +| +$/g, "");
  const iso = ISO_TIMESTAMP.exec(text);
  if (iso) {
    const year = Number(iso[1]);
    const month = Number(iso[2]);
    const day = Number(iso[3]);
    const hour = Number(iso[4]);
    const minute = Number(iso[5]);
    const second = Number(iso[6]);
    if (!validDateTime(year, month, day, hour, minute, second)) return null;
    const fraction = (iso[7] ?? "").padEnd(3, "0").slice(0, 3);
    let offsetMinutes = 0;
    if (iso[8] !== "Z") {
      const offsetHour = Number(iso[10]);
      const offsetMinute = Number(iso[11]);
      if (offsetHour > 14 || offsetMinute > 59 || (offsetHour === 14 && offsetMinute !== 0)) return null;
      offsetMinutes = (offsetHour * 60 + offsetMinute) * (iso[9] === "+" ? 1 : -1);
    }
    const utc = Date.UTC(year, month - 1, day, hour, minute - offsetMinutes, second, Number(fraction || "0"));
    return supportedUtcResult(utc);
  }

  const rfc = RFC_UTC_TIMESTAMP.exec(text);
  if (!rfc) return null;
  const day = Number(rfc[2]);
  const month = MONTHS[String(rfc[3]).toLocaleLowerCase("en") as keyof typeof MONTHS] ?? 0;
  const year = Number(rfc[4]);
  const hour = Number(rfc[5]);
  const minute = Number(rfc[6]);
  const second = Number(rfc[7]);
  if (!validDateTime(year, month, day, hour, minute, second)) return null;
  return supportedUtcResult(Date.UTC(year, month - 1, day, hour, minute, second));
}

function sqlDigits(valueSql: string, length: number | string): string {
  return `LENGTH(${valueSql}) = ${length} AND ${valueSql} NOT GLOB '*[^0-9]*'`;
}

function sqlMonth(valueSql: string, start: number): string {
  return `CASE LOWER(SUBSTR(${valueSql}, ${start}, 3))
    WHEN 'jan' THEN '01' WHEN 'feb' THEN '02' WHEN 'mar' THEN '03'
    WHEN 'apr' THEN '04' WHEN 'may' THEN '05' WHEN 'jun' THEN '06'
    WHEN 'jul' THEN '07' WHEN 'aug' THEN '08' WHEN 'sep' THEN '09'
    WHEN 'oct' THEN '10' WHEN 'nov' THEN '11' WHEN 'dec' THEN '12'
    ELSE NULL END`;
}

function sqlCalendarValid(
  yearSql: string,
  monthSql: string,
  daySql: string,
  hourSql: string,
  minuteSql: string,
  secondSql: string,
): string {
  const year = `CAST(${yearSql} AS INTEGER)`;
  const month = `CAST(${monthSql} AS INTEGER)`;
  const maximumDay = `CASE ${month}
    WHEN 2 THEN CASE WHEN (${year} % 4 = 0 AND (${year} % 100 != 0 OR ${year} % 400 = 0)) THEN 29 ELSE 28 END
    WHEN 4 THEN 30 WHEN 6 THEN 30 WHEN 9 THEN 30 WHEN 11 THEN 30
    ELSE 31 END`;
  return `(${sqlDigits(yearSql, 4)} AND CAST(${yearSql} AS INTEGER) BETWEEN 1000 AND 9999
    AND ${sqlDigits(monthSql, 2)} AND CAST(${monthSql} AS INTEGER) BETWEEN 1 AND 12
    AND ${sqlDigits(daySql, 2)} AND CAST(${daySql} AS INTEGER) BETWEEN 1 AND ${maximumDay}
    AND ${sqlDigits(hourSql, 2)} AND CAST(${hourSql} AS INTEGER) BETWEEN 0 AND 23
    AND ${sqlDigits(minuteSql, 2)} AND CAST(${minuteSql} AS INTEGER) BETWEEN 0 AND 59
    AND ${sqlDigits(secondSql, 2)} AND CAST(${secondSql} AS INTEGER) BETWEEN 0 AND 59)`;
}

function sqlOffsetValid(valueSql: string, signStartSql: string): string {
  const sign = `SUBSTR(${valueSql}, ${signStartSql}, 1)`;
  const hour = `SUBSTR(${valueSql}, (${signStartSql}) + 1, 2)`;
  const minute = `SUBSTR(${valueSql}, (${signStartSql}) + 4, 2)`;
  return `(${sign} IN ('+', '-')
    AND ${sqlDigits(hour, 2)} AND CAST(${hour} AS INTEGER) BETWEEN 0 AND 14
    AND ${sqlDigits(minute, 2)} AND CAST(${minute} AS INTEGER) BETWEEN 0 AND 59
    AND (CAST(${hour} AS INTEGER) < 14 OR CAST(${minute} AS INTEGER) = 0))`;
}

/** SQL counterpart to canonicalEvidenceTimestamp for bounded D1 reads. */
export function canonicalEvidenceTimestampSql(columnSql: string): string {
  const value = `NULLIF(TRIM(${columnSql}), '')`;
  const year = `SUBSTR(${value}, 1, 4)`;
  const month = `SUBSTR(${value}, 6, 2)`;
  const day = `SUBSTR(${value}, 9, 2)`;
  const hour = `SUBSTR(${value}, 12, 2)`;
  const minute = `SUBSTR(${value}, 15, 2)`;
  const second = `SUBSTR(${value}, 18, 2)`;
  const calendar = sqlCalendarValid(year, month, day, hour, minute, second);
  const punctuation = `SUBSTR(${value}, 5, 1) = '-' AND SUBSTR(${value}, 8, 1) = '-'
    AND SUBSTR(${value}, 11, 1) = 'T' AND SUBSTR(${value}, 14, 1) = ':'
    AND SUBSTR(${value}, 17, 1) = ':'`;
  const zShape = `(LENGTH(${value}) = 20 AND SUBSTR(${value}, 20, 1) = 'Z')`;
  const zFraction = `SUBSTR(${value}, 21, LENGTH(${value}) - 21)`;
  const fractionalZShape = `(LENGTH(${value}) BETWEEN 22 AND 24
    AND SUBSTR(${value}, 20, 1) = '.' AND SUBSTR(${value}, -1, 1) = 'Z'
    AND ${sqlDigits(zFraction, `LENGTH(${value}) - 21`)})`;
  const offsetShape = `(LENGTH(${value}) = 25 AND SUBSTR(${value}, 23, 1) = ':'
    AND ${sqlOffsetValid(value, "20")})`;
  const offsetFraction = `SUBSTR(${value}, 21, LENGTH(${value}) - 26)`;
  const fractionalOffsetShape = `(LENGTH(${value}) BETWEEN 27 AND 29
    AND SUBSTR(${value}, 20, 1) = '.' AND SUBSTR(${value}, -3, 1) = ':'
    AND ${sqlDigits(offsetFraction, `LENGTH(${value}) - 26`)}
    AND ${sqlOffsetValid(value, `LENGTH(${value}) - 5`)})`;
  const isoValid = `(${calendar} AND ${punctuation}
    AND julianday(${value}) BETWEEN julianday('1000-01-01T00:00:00.000Z') AND julianday('9999-12-31T23:59:59.999Z')
    AND (${zShape} OR ${fractionalZShape} OR ${offsetShape} OR ${fractionalOffsetShape}))`;

  const rfcTwoYear = `SUBSTR(${value}, 13, 4)`;
  const rfcTwoMonth = sqlMonth(value, 9);
  const rfcTwoDay = `SUBSTR(${value}, 6, 2)`;
  const rfcTwoHour = `SUBSTR(${value}, 18, 2)`;
  const rfcTwoMinute = `SUBSTR(${value}, 21, 2)`;
  const rfcTwoSecond = `SUBSTR(${value}, 24, 2)`;
  const rfcTwoDate = `${rfcTwoYear} || '-' || ${rfcTwoMonth} || '-' || ${rfcTwoDay} || 'T' || SUBSTR(${value}, 18, 8) || 'Z'`;
  const rfcTwoShape = `(UPPER(SUBSTR(${value}, 1, 3)) IN ('MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT', 'SUN')
    AND (UPPER(${value}) GLOB '???, ?? ??? ???? ??:??:?? GMT'
      OR UPPER(${value}) GLOB '???, ?? ??? ???? ??:??:?? UTC'
      OR UPPER(${value}) GLOB '???, ?? ??? ???? ??:??:?? +0000'
      OR UPPER(${value}) GLOB '???, ?? ??? ???? ??:??:?? -0000')
    AND ${sqlCalendarValid(rfcTwoYear, rfcTwoMonth, rfcTwoDay, rfcTwoHour, rfcTwoMinute, rfcTwoSecond)})`;

  const rfcOneYear = `SUBSTR(${value}, 12, 4)`;
  const rfcOneMonth = sqlMonth(value, 8);
  const rfcOneDay = `'0' || SUBSTR(${value}, 6, 1)`;
  const rfcOneHour = `SUBSTR(${value}, 17, 2)`;
  const rfcOneMinute = `SUBSTR(${value}, 20, 2)`;
  const rfcOneSecond = `SUBSTR(${value}, 23, 2)`;
  const rfcOneDate = `${rfcOneYear} || '-' || ${rfcOneMonth} || '-' || ${rfcOneDay} || 'T' || SUBSTR(${value}, 17, 8) || 'Z'`;
  const rfcOneShape = `(UPPER(SUBSTR(${value}, 1, 3)) IN ('MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT', 'SUN')
    AND (UPPER(${value}) GLOB '???, ? ??? ???? ??:??:?? GMT'
      OR UPPER(${value}) GLOB '???, ? ??? ???? ??:??:?? UTC'
      OR UPPER(${value}) GLOB '???, ? ??? ???? ??:??:?? +0000'
      OR UPPER(${value}) GLOB '???, ? ??? ???? ??:??:?? -0000')
    AND ${sqlCalendarValid(rfcOneYear, rfcOneMonth, rfcOneDay, rfcOneHour, rfcOneMinute, rfcOneSecond)})`;

  return `CASE
    WHEN ${isoValid} THEN strftime('%Y-%m-%dT%H:%M:%fZ', ${value})
    WHEN ${rfcTwoShape} THEN strftime('%Y-%m-%dT%H:%M:%fZ', ${rfcTwoDate})
    WHEN ${rfcOneShape} THEN strftime('%Y-%m-%dT%H:%M:%fZ', ${rfcOneDate})
    ELSE NULL END`;
}

export function evidenceTimestampSql(alias: string): string {
  return `COALESCE(
    ${canonicalEvidenceTimestampSql(`${alias}.published_at`)},
    ${canonicalEvidenceTimestampSql(`${alias}.observed_at`)}
  )`;
}
