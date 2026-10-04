import { z } from "zod";

/** MySQL TIMESTAMP columns end at 2038-01-19 03:14:07 UTC; later dates fail in strict mode. */
export const TIMESTAMP_MIN = new Date(Date.UTC(1970, 0, 2));
export const TIMESTAMP_MAX = new Date(Date.UTC(2037, 11, 31, 23, 59, 59));

export const DATE_OUT_OF_RANGE = "DATE_OUT_OF_RANGE";

export const inTimestampRange = (value: Date | number) => {
  const ms = typeof value === "number" ? value : value.getTime();
  return Number.isFinite(ms) && ms >= TIMESTAMP_MIN.getTime() && ms <= TIMESTAMP_MAX.getTime();
};

/** A date input that is stored in a TIMESTAMP column. */
export const timestampDate = () => z.coerce.date().min(TIMESTAMP_MIN, DATE_OUT_OF_RANGE).max(TIMESTAMP_MAX, DATE_OUT_OF_RANGE);

/** An ISO date-time string that is stored in a TIMESTAMP column. */
export const timestampIso = () =>
  z
    .string()
    .datetime()
    .refine((s) => inTimestampRange(Date.parse(s)), DATE_OUT_OF_RANGE);
