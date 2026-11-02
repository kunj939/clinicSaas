import { randomUUID } from 'node:crypto';

export interface OutboundMessage {
  /** E.164 number, e.g. +919876543210 */
  to: string;
  text: string;
  /** 'reply' stays inside an open customer conversation; 'notification' is business-initiated. */
  kind: 'reply' | 'notification';
  templateKey: string;
  /** Meta phone_number_id of the clinic's WhatsApp number. */
  phoneNumberId: string | null;
}

export interface MessagingAdapter {
  readonly provider: 'mock' | 'meta';
  send(message: OutboundMessage): Promise<{ providerMessageId: string }>;
}

/** No network calls. Used for local development, tests and demos. */
export function createMockAdapter(onSend?: (message: OutboundMessage) => void): MessagingAdapter {
  return {
    provider: 'mock',
    async send(message) {
      onSend?.(message);
      return { providerMessageId: `mock-${randomUUID()}` };
    },
  };
}

export class ProviderError extends Error {
  readonly status: number | null;
  readonly providerCode: number | string | null;

  constructor(message: string, status: number | null, providerCode: number | string | null) {
    super(message);
    this.name = 'ProviderError';
    this.status = status;
    this.providerCode = providerCode;
  }
}

/** WhatsApp template parameters cannot contain newlines or long runs of spaces. */
export function toTemplateParameter(text: string): string {
  return text
    .replace(/\s*\n\s*/g, ' | ')
    .replace(/ {2,}/g, ' ')
    .slice(0, 1000);
}

export interface MetaAdapterOptions {
  accessToken: string;
  apiVersion: string;
  notificationTemplate?: string;
  templateLanguage: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

/**
 * WhatsApp Cloud API adapter. Replies use free-form text inside the 24h customer service window.
 * Notifications use one approved utility template with a single body variable, because they are
 * sent outside that window. Requires Meta setup; see DEPLOYMENT.md.
 */
export function createMetaAdapter(options: MetaAdapterOptions): MessagingAdapter {
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? 10_000;

  return {
    provider: 'meta',
    async send(message) {
      if (!message.phoneNumberId) {
        throw new ProviderError('Clinic WhatsApp number is not configured', null, 'not_configured');
      }
      const to = message.to.replace(/^\+/, '');
      const useTemplate = message.kind === 'notification' && Boolean(options.notificationTemplate);
      const payload = useTemplate
        ? {
            messaging_product: 'whatsapp',
            to,
            type: 'template',
            template: {
              name: options.notificationTemplate,
              language: { code: options.templateLanguage },
              components: [{ type: 'body', parameters: [{ type: 'text', text: toTemplateParameter(message.text) }] }],
            },
          }
        : {
            messaging_product: 'whatsapp',
            recipient_type: 'individual',
            to,
            type: 'text',
            text: { preview_url: false, body: message.text },
          };

      const response = await fetchImpl(
        `https://graph.facebook.com/${options.apiVersion}/${message.phoneNumberId}/messages`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${options.accessToken}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(payload),
          signal: AbortSignal.timeout(timeoutMs),
        },
      );

      // Never echo the provider body: it can contain recipient details.
      const json = (await response.json().catch(() => ({}))) as {
        messages?: { id?: string }[];
        error?: { code?: number };
      };
      if (!response.ok) {
        throw new ProviderError(`WhatsApp API responded ${response.status}`, response.status, json.error?.code ?? null);
      }
      const id = json.messages?.[0]?.id;
      if (!id) throw new ProviderError('WhatsApp API returned no message id', response.status, null);
      return { providerMessageId: id };
    },
  };
}
