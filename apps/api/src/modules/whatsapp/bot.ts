import type { AppContext } from '../../context.js';
import type { Db } from '../../db/pool.js';
import { addDays, dateInTimeZone, formatDisplayDate, timeInTimeZone } from '../../lib/clinic-time.js';
import { AppError } from '../../lib/errors.js';
import { recordAudit } from '../audit/service.js';
import { getClinicById, type ClinicRow } from '../clinic/service.js';
import { enqueueMessage } from '../messaging/outbox.js';
import { isLang, languageMenu, render, type Lang, type TemplateKey } from '../messaging/templates.js';
import { findOrCreatePatientByPhone, findPatientByPhone, type PatientRow } from '../patients/service.js';
import { getAvailability } from '../tokens/availability.js';
import { doctorNameFor } from '../tokens/booking.js';
import { allocateToken } from '../tokens/service.js';

export interface InboundMessage {
  clinicId: string;
  /** E.164 sender number. */
  phone: string;
  /** Text body, or null for images, stickers, locations and other non-text messages. */
  text: string | null;
  now: Date;
}

type State = 'idle' | 'await_language' | 'await_name' | 'await_age' | 'await_phone' | 'choose_day' | 'choose_doctor';

interface ConversationRow {
  id: string;
  state: State;
  state_data: { lang?: string; name?: string; age?: number; days?: string[]; date?: string; options?: string[] };
}

/** Sender-scoped reply helper: every bot message goes to the same patient in their language. */
type Send = (key: TemplateKey, vars?: Record<string, string | number>) => Promise<unknown>;

const MAX_MENU_OPTIONS = 9;
const BOOK_WORDS = new Set(['book', 'booking', 'hi', 'hello', 'hey', 'start', 'बुक', 'नमस्ते', 'नमस्कार']);
const STATUS_WORDS = new Set(['status', 'स्थिति']);
const CANCEL_WORDS = new Set(['cancel', 'रद्द']);
const NAME_PATTERN = /^[\p{L}][\p{L}\p{M}\s.'-]{0,79}$/u;
const SAVEPOINT = 'bot_step';
const CONFLICT_CODES = new Set(['fully_booked', 'already_booked', 'doctor_not_available', 'clinic_closed']);

/**
 * Conversational booking over WhatsApp. Runs inside the webhook's transaction, so the booking,
 * the conversation state and the replies are committed together or not at all.
 *
 * Commands (BOOK / STATUS / CANCEL) are checked before conversation state, so a patient can always
 * restart or cancel. Booking is limited to tomorrow in the clinic's timezone.
 */
export async function handleInbound(ctx: AppContext, client: Db, input: InboundMessage): Promise<void> {
  const clinic = await getClinicById(client, input.clinicId);
  if (!clinic) return;

  const conversation = await loadConversation(client, ctx, clinic.id, input.phone);
  const patient = await findPatientByPhone(client, ctx.cipher, clinic.id, input.phone);
  const lang = languageFor(clinic, conversation.state_data, patient);
  const sendAs = (key: TemplateKey, vars: Record<string, string | number> = {}, as: Lang = lang) =>
    enqueueMessage(client, ctx.cipher, {
      clinicId: clinic.id,
      kind: 'reply',
      templateKey: key,
      phone: input.phone,
      text: render(as, key, { clinic: clinic.name, ...vars }),
      period: '',
      quota: 0,
    });
  const send: Send = (key, vars) => sendAs(key, vars);
  const scope: Scope = { ctx, client, clinic, input, lang, sendAs, patient };

  const today = dateInTimeZone(input.now, clinic.timezone);
  const keep: Next = { state: conversation.state, data: conversation.state_data };
  let next: Next = { state: 'idle', data: {} };

  const text = input.text?.trim() ?? null;
  const normalized = text === null ? null : text.toLowerCase().replace(/\s+/g, ' ');

  if (normalized === null) {
    // Pictures, stickers and locations. They can start the welcome, but are no use as an answer to a question.
    if (conversation.state === 'idle') {
      next = await welcome(scope);
    } else {
      await send('bot.unsupported');
      next = keep;
    }
  } else if (CANCEL_WORDS.has(normalized)) {
    await cancelUpcoming(ctx, client, clinic, input.phone, today, send);
  } else if (STATUS_WORDS.has(normalized)) {
    await sendStatus(ctx, client, clinic, input.phone, lang, today, send);
  } else if (isBookingRequest(normalized)) {
    // Also what the prefilled "click to chat" message says, so tapping the booking link starts the flow.
    next = await welcome(scope);
  } else if (conversation.state === 'await_language') {
    const chosen = /^\d{1,2}$/.test(normalized) ? clinic.enabled_languages[Number(normalized) - 1] : undefined;
    if (!chosen) {
      await send('bot.choose_language', { list: languageMenu(clinic.enabled_languages) });
      next = keep;
    } else {
      next = await askName(scope, chosen);
    }
  } else if (conversation.state === 'await_name') {
    if (!NAME_PATTERN.test(text!)) {
      await send('bot.name_invalid');
      next = keep;
    } else {
      await send('bot.thanks_name', { name: firstName(text!) });
      await send('bot.ask_age');
      next = { state: 'await_age', data: { ...conversation.state_data, name: text! } };
    }
  } else if (conversation.state === 'await_age') {
    const age = parseAge(text!);
    if (age === null) {
      await send('bot.age_invalid');
      next = keep;
    } else {
      await send('bot.confirm_phone', { phone: input.phone });
      next = { state: 'await_phone', data: { ...conversation.state_data, age } };
    }
  } else if (conversation.state === 'await_phone') {
    if (YES_WORDS.has(normalized)) {
      const { name, age } = conversation.state_data;
      if (!name) {
        next = await welcome(scope);
      } else {
        // The patient record is created only now, once the name, age and number are all confirmed.
        await findOrCreatePatientByPhone(client, ctx.cipher, clinic.id, {
          fullName: name,
          phone: input.phone,
          preferredLanguage: lang,
          ageYears: age ?? null,
        });
        next = await openDays(scope);
      }
    } else if (NO_WORDS.has(normalized)) {
      await send('bot.phone_declined');
      next = { state: 'idle', data: {} };
    } else {
      await send('bot.confirm_phone', { phone: input.phone });
      next = keep;
    }
  } else if (conversation.state === 'choose_day') {
    const date = /^\d{1,2}$/.test(normalized) ? conversation.state_data.days?.[Number(normalized) - 1] : undefined;
    if (!date) {
      await send('bot.invalid_option');
      next = keep;
    } else {
      next = await openDoctors(scope, date);
    }
  } else if (conversation.state === 'choose_doctor' && /^\d{1,2}$/.test(normalized)) {
    const doctorId = conversation.state_data.options?.[Number(normalized) - 1];
    if (!doctorId) {
      await send('bot.invalid_option');
      next = keep;
    } else if (patient) {
      await attemptBooking(ctx, client, clinic, input.phone, lang, patient, doctorId, conversation.state_data.date ?? addDays(today, 1));
    } else {
      next = await welcome(scope);
    }
  } else if (conversation.state === 'idle' && patient === null) {
    // The first message from a number the clinic has never seen starts the welcome, whatever it says.
    next = await welcome(scope);
  } else {
    await send('bot.help');
  }

  await client.query(
    `UPDATE whatsapp_conversations SET state = $2, state_data = $3, updated_at = now() WHERE id = $1`,
    [conversation.id, next.state, JSON.stringify(next.data)],
  );
}

const YES_WORDS = new Set(['yes', 'y', 'ok', 'haan', 'ha', 'हाँ', 'हां', 'जी']);
const NO_WORDS = new Set(['no', 'n', 'nahi', 'नहीं', 'नही']);
/** Matches "book", "booking" or "token" in English, and the Hindi words, anywhere in the message. */
const BOOKING_PATTERN = /\b(book|booking|token)\b|बुक|टोकन/;

interface Scope {
  ctx: AppContext;
  client: Db;
  clinic: ClinicRow;
  input: InboundMessage;
  lang: Lang;
  sendAs: (key: TemplateKey, vars?: Record<string, string | number>, as?: Lang) => Promise<unknown>;
  patient: PatientRow | null;
}

function isBookingRequest(normalized: string): boolean {
  return BOOK_WORDS.has(normalized) || BOOKING_PATTERN.test(normalized);
}

/** A returning patient keeps their language. A new one has the language they chose, or the clinic default. */
function languageFor(clinic: ClinicRow, data: ConversationRow['state_data'], patient: PatientRow | null): Lang {
  if (patient) return patient.preferred_language;
  if (isLang(data.lang)) return data.lang;
  return isLang(clinic.default_language) ? clinic.default_language : 'en';
}

/** Age in whole years, from "34", "34 years" or "34 saal". Null when it does not look like an age. */
function parseAge(text: string): number | null {
  const match = /^(\d{1,3})\s*(years?|yrs?|saal|साल)?\.?$/i.exec(text.trim());
  if (!match) return null;
  const age = Number(match[1]);
  return age >= 0 && age <= 120 ? age : null;
}

interface Next {
  state: State;
  data: ConversationRow['state_data'];
}

/**
 * The dates a patient can still book on WhatsApp, from tomorrow up to the window. Booking for a day
 * closes at the cut-off time on the day before it, so only tomorrow can already be closed.
 */
function openDates(clinic: ClinicRow, now: Date): string[] {
  const today = dateInTimeZone(now, clinic.timezone);
  const tomorrowOpen = timeInTimeZone(now, clinic.timezone) < clinic.booking_cutoff_time.slice(0, 5);
  const dates: string[] = [];
  for (let offset = 1; offset <= clinic.booking_window_days; offset += 1) {
    if (offset === 1 && !tomorrowOpen) continue;
    dates.push(addDays(today, offset));
  }
  return dates;
}

/** Greets the sender. A known patient gets their language and goes on to the days; a new one chooses a language first. */
async function welcome(scope: Scope): Promise<Next> {
  const { patient, sendAs, clinic } = scope;
  if (patient) {
    await sendAs('bot.welcome_back', { name: firstName(patient.full_name) });
    return openDays(scope);
  }
  await sendAs('bot.choose_language', { list: languageMenu(clinic.enabled_languages) }, 'en');
  return { state: 'await_language', data: {} };
}

/** A new patient picked a language: greet them in it and ask for the name, unless nothing is open to book. */
async function askName(scope: Scope, lang: Lang): Promise<Next> {
  const { clinic, input, sendAs } = scope;
  if (openDates(clinic, input.now).length === 0) {
    await sendAs('bot.cutoff_passed', { cutoff: formatTime12h(clinic.booking_cutoff_time.slice(0, 5)) }, lang);
    return { state: 'idle', data: {} };
  }
  await sendAs('bot.welcome_new', {}, lang);
  await sendAs('bot.ask_name', {}, lang);
  return { state: 'await_name', data: { lang } };
}

/** Offers the open days when the window is more than one day, otherwise goes straight to the doctors. */
async function openDays(scope: Scope): Promise<Next> {
  const { ctx, client, clinic, input, lang, sendAs } = scope;
  const dates = openDates(clinic, input.now);
  if (dates.length === 0) {
    await sendAs('bot.cutoff_passed', { cutoff: formatTime12h(clinic.booking_cutoff_time.slice(0, 5)) });
    return { state: 'idle', data: {} };
  }
  if (dates.length === 1) return openDoctors(scope, dates[0]!);

  const header = render(lang, 'bot.choose_day', { clinic: clinic.name });
  const lines = dates.map((date, index) => render(lang, 'bot.day_line', { n: index + 1, date: formatDisplayDate(date) }));
  await enqueueMessage(client, ctx.cipher, {
    clinicId: clinic.id,
    kind: 'reply',
    templateKey: 'bot.choose_day',
    phone: input.phone,
    text: [header, ...lines].join('\n'),
    period: '',
    quota: 0,
  });
  return { state: 'choose_day', data: { lang, days: dates } };
}

/** Shows the doctors with room on the chosen day, and waits for the number of one of them. */
async function openDoctors(scope: Scope, date: string): Promise<Next> {
  const { ctx, client, clinic, input, lang, sendAs } = scope;
  const send: Send = (key, vars) => sendAs(key, vars);
  const options = await startBooking(ctx, client, clinic, input.phone, input.now, date, lang, send);
  return options ? { state: 'choose_doctor', data: { lang, date, options } } : { state: 'idle', data: {} };
}

function firstName(fullName: string): string {
  return fullName.trim().split(/\s+/)[0] ?? fullName;
}

async function loadConversation(client: Db, ctx: AppContext, clinicId: string, phone: string): Promise<ConversationRow> {
  const phoneHash = ctx.cipher.blindIndex(phone);
  await client.query(
    `INSERT INTO whatsapp_conversations (clinic_id, phone_hash, phone_encrypted)
     VALUES ($1, $2, $3) ON CONFLICT (clinic_id, phone_hash) DO NOTHING`,
    [clinicId, phoneHash, ctx.cipher.encrypt(phone)],
  );
  const { rows } = await client.query<ConversationRow>(
    'SELECT id, state, state_data FROM whatsapp_conversations WHERE clinic_id = $1 AND phone_hash = $2 FOR UPDATE',
    [clinicId, phoneHash],
  );
  return rows[0]!;
}

/** Shows open doctors for tomorrow. Returns doctor ids in menu order, or null when no menu was shown. */
/** Shows the open doctors for one date. Returns doctor ids in menu order, or null when no menu was shown. The caller checks the date is open. */
async function startBooking(
  ctx: AppContext,
  client: Db,
  clinic: ClinicRow,
  phone: string,
  now: Date,
  date: string,
  lang: Lang,
  send: Send,
): Promise<string[] | null> {
  const today = dateInTimeZone(now, clinic.timezone);
  const { rows: doctors } = await client.query<{ id: string; name: string }>(
    'SELECT id, name FROM doctors WHERE clinic_id = $1 AND is_active ORDER BY name',
    [clinic.id],
  );
  const open: { id: string; name: string; remaining: number }[] = [];
  let closedByHoliday = false;
  for (const doctor of doctors) {
    const availability = await getAvailability(client, { clinicId: clinic.id, doctorId: doctor.id, date, today });
    if (availability.open) open.push({ id: doctor.id, name: doctor.name, remaining: availability.remaining });
    if (availability.reason === 'clinic_closed') closedByHoliday = true;
  }

  if (open.length === 0) {
    await send(closedByHoliday ? 'bot.clinic_closed' : 'bot.no_doctors', { date: formatDisplayDate(date) });
    return null;
  }

  const menu = open.slice(0, MAX_MENU_OPTIONS);
  const lines = menu.map((doctor, index) =>
    render(lang, 'bot.menu_line', { n: index + 1, doctor: doctor.name, remaining: doctor.remaining }),
  );
  const header = render(lang, 'bot.menu_header', { clinic: clinic.name, date: formatDisplayDate(date) });
  await enqueueMessage(client, ctx.cipher, {
    clinicId: clinic.id,
    kind: 'reply',
    templateKey: 'bot.menu',
    phone,
    text: [header, ...lines].join('\n'),
    period: '',
    quota: 0,
  });
  return menu.map((doctor) => doctor.id);
}

function formatTime12h(hhmm: string): string {
  const [h, m] = hhmm.split(':').map(Number) as [number, number];
  const suffix = h >= 12 ? 'PM' : 'AM';
  const hour = h % 12 === 0 ? 12 : h % 12;
  return `${hour}:${String(m).padStart(2, '0')} ${suffix}`;
}

/**
 * Books the token inside a savepoint. Expected conflicts (sold out, already booked) become a reply
 * instead of aborting the whole webhook transaction.
 */
async function attemptBooking(
  ctx: AppContext,
  client: Db,
  clinic: ClinicRow,
  phone: string,
  lang: Lang,
  patient: PatientRow,
  doctorId: string,
  date: string,
): Promise<void> {
  const doctorName = await doctorNameFor(client, doctorId);
  const vars = { doctor: doctorName, date: formatDisplayDate(date) };
  const sendTo = (key: TemplateKey, extra: Record<string, string | number> = {}) =>
    enqueueMessage(client, ctx.cipher, {
      clinicId: clinic.id,
      kind: 'reply',
      templateKey: key,
      phone,
      text: render(lang, key, { clinic: clinic.name, ...vars, ...extra }),
      period: '',
      quota: 0,
    });

  const existing = await client.query<{ token_number: number }>(
    `SELECT token_number FROM tokens
      WHERE patient_id = $1 AND doctor_id = $2 AND service_date = $3 AND status <> 'cancelled'`,
    [patient.id, doctorId, date],
  );
  if (existing.rows[0]) {
    await sendTo('bot.already_booked', { token: existing.rows[0].token_number });
    return;
  }

  await client.query(`SAVEPOINT ${SAVEPOINT}`);
  try {
    const token = await allocateToken(client, {
      clinicId: clinic.id,
      doctorId,
      patientId: patient.id,
      date,
      source: 'whatsapp',
      createdByUserId: null,
      checkIn: false,
    });
    await client.query(`RELEASE SAVEPOINT ${SAVEPOINT}`);
    await sendTo('bot.booked', { token: token.token_number });
    await recordAudit(client, {
      clinicId: clinic.id,
      actorUserId: null,
      action: 'token.booked',
      entityType: 'token',
      entityId: token.id,
      metadata: { source: 'whatsapp' },
    });
  } catch (error) {
    await client.query(`ROLLBACK TO SAVEPOINT ${SAVEPOINT}`);
    await client.query(`RELEASE SAVEPOINT ${SAVEPOINT}`);
    if (error instanceof AppError && CONFLICT_CODES.has(error.code)) {
      const key: TemplateKey =
        error.code === 'fully_booked'
          ? 'bot.fully_booked'
          : error.code === 'already_booked'
            ? 'bot.already_booked'
            : 'bot.clinic_closed';
      await sendTo(key);
      return;
    }
    throw error;
  }
}

async function sendStatus(
  ctx: AppContext,
  client: Db,
  clinic: ClinicRow,
  phone: string,
  lang: Lang,
  today: string,
  send: Send,
): Promise<void> {
  const patient = await findPatientByPhone(client, ctx.cipher, clinic.id, phone);
  const { rows } = patient
    ? await client.query<{ token_number: number; status: string; service_date: string; doctor_name: string }>(
        `SELECT t.token_number, t.status, t.service_date, d.name AS doctor_name
           FROM tokens t JOIN doctors d ON d.id = t.doctor_id
          WHERE t.patient_id = $1 AND t.service_date >= $2 AND t.status IN ('booked', 'checked_in', 'in_consultation')
          ORDER BY t.service_date, t.token_number`,
        [patient.id, today],
      )
    : { rows: [] };

  if (rows.length === 0) {
    await send('bot.status_none');
    return;
  }
  const text = rows
    .map((row) =>
      render(lang, 'bot.status_line', {
        token: row.token_number,
        doctor: row.doctor_name,
        date: formatDisplayDate(row.service_date),
        status: render(lang, `status.${row.status}` as TemplateKey),
      }),
    )
    .join('\n');
  await enqueueMessage(client, ctx.cipher, {
    clinicId: clinic.id,
    kind: 'reply',
    templateKey: 'bot.status',
    phone,
    text,
    period: '',
    quota: 0,
  });
}

async function cancelUpcoming(
  ctx: AppContext,
  client: Db,
  clinic: ClinicRow,
  phone: string,
  today: string,
  send: Send,
): Promise<void> {
  const patient = await findPatientByPhone(client, ctx.cipher, clinic.id, phone);
  if (!patient) {
    await send('bot.cancel_none');
    return;
  }
  const { rows } = await client.query<{
    id: string;
    day_id: string;
    token_number: number;
    status: string;
    service_date: string;
    doctor_name: string;
  }>(
    `SELECT t.id, t.day_id, t.token_number, t.status, t.service_date, d.name AS doctor_name
       FROM tokens t JOIN doctors d ON d.id = t.doctor_id
      WHERE t.patient_id = $1 AND t.service_date >= $2 AND t.status IN ('booked', 'checked_in')
      ORDER BY t.service_date, t.token_number, t.created_at
      LIMIT 1
      FOR UPDATE OF t`,
    [patient.id, today],
  );
  const token = rows[0];
  if (!token) {
    await send('bot.cancel_none');
    return;
  }
  if (token.status === 'checked_in') {
    await send('bot.cancel_blocked', { token: token.token_number });
    return;
  }

  await client.query(`UPDATE tokens SET status = 'cancelled', cancelled_at = now(), updated_at = now() WHERE id = $1`, [token.id]);
  await client.query('UPDATE appointment_days SET active_count = active_count - 1 WHERE id = $1 AND active_count > 0', [
    token.day_id,
  ]);
  await recordAudit(client, {
    clinicId: clinic.id,
    actorUserId: null,
    action: 'token.cancelled',
    entityType: 'token',
    entityId: token.id,
    metadata: { source: 'whatsapp' },
  });
  await send('bot.cancelled', {
    token: token.token_number,
    doctor: token.doctor_name,
    date: formatDisplayDate(token.service_date),
  });
}
