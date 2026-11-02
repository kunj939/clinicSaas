import { z } from 'zod';
import { isIsoDate } from './clinic-time.js';

/** Shared request-validation building blocks. */

export const uuidParam = z.object({ id: z.uuid() });

export const isoDate = z.string().refine(isIsoDate, { message: 'Use a valid date in YYYY-MM-DD format' });

export const timeOfDay = z
  .string()
  .regex(/^([01]\d|2[0-3]):[0-5]\d$/, { message: 'Use 24-hour time in HH:MM format' });

export const email = z.string().trim().toLowerCase().max(254).email();

export const personName = z.string().trim().min(2, 'Name is too short').max(120, 'Name is too long');

export const phoneInput = z.string().trim().min(6).max(25);

export const timeZone = z
  .string()
  .min(3)
  .max(64)
  .refine(
    (value) => {
      try {
        new Intl.DateTimeFormat('en-US', { timeZone: value });
        return true;
      } catch {
        return false;
      }
    },
    { message: 'Unknown timezone' },
  );

export const limitQuery = z.coerce.number().int().min(1).max(100).default(25);
