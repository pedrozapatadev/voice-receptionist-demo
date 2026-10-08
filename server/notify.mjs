/**
 * Owner notifications. The booking is the source of truth; a failed notification
 * is logged and reported, never allowed to undo or block the booking.
 *
 * Channels (all optional, any combination):
 *   console           always on — the demo default
 *   webhook           NOTIFY_WEBHOOK_URL — POSTs {text, event}; Slack/Discord/Make/n8n compatible
 *   twilio-whatsapp   TWILIO_ACCOUNT_SID + TWILIO_AUTH_TOKEN + TWILIO_WHATSAPP_FROM + OWNER_WHATSAPP_TO
 */

const sendWebhook = (url, fetchImpl) => async (text, event) => {
  const res = await fetchImpl(url, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text, event }),
  });
  if (!res.ok) throw new Error(`webhook ${res.status}`);
};

const sendTwilioWhatsApp = (env, fetchImpl) => async (text) => {
  const sid = env.TWILIO_ACCOUNT_SID;
  const auth = Buffer.from(`${sid}:${env.TWILIO_AUTH_TOKEN}`).toString('base64');
  const res = await fetchImpl(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
    method: 'POST',
    headers: { authorization: `Basic ${auth}`, 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      From: `whatsapp:${env.TWILIO_WHATSAPP_FROM}`, To: `whatsapp:${env.OWNER_WHATSAPP_TO}`, Body: text,
    }),
  });
  if (!res.ok) throw new Error(`twilio ${res.status}`);
};

export function createNotifier({ env = process.env, fetchImpl = fetch, log = console.log } = {}) {
  const channels = [['console', async (text) => log(`\n📣 Aviso al negocio\n${text}\n`)]];
  if (env.NOTIFY_WEBHOOK_URL) channels.push(['webhook', sendWebhook(env.NOTIFY_WEBHOOK_URL, fetchImpl)]);
  if (env.TWILIO_ACCOUNT_SID && env.TWILIO_AUTH_TOKEN && env.TWILIO_WHATSAPP_FROM && env.OWNER_WHATSAPP_TO)
    channels.push(['twilio-whatsapp', sendTwilioWhatsApp(env, fetchImpl)]);

  return {
    channels: channels.map(([name]) => name),
    async send(text, event) {
      const results = await Promise.allSettled(channels.map(([, fn]) => fn(text, event)));
      const failed = results
        .map((r, i) => (r.status === 'rejected' ? `${channels[i][0]}: ${r.reason.message}` : null))
        .filter(Boolean);
      failed.forEach(f => console.error(`notification failed — ${f}`));
      return { delivered: channels.length - failed.length, failed };
    },
  };
}
