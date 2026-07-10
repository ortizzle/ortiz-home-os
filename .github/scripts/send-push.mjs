// send-push.mjs — reads the household push subscriptions from the Gist and
// sends each device a notification. Run by .github/workflows/notify.yml on a
// daily cron. No app backend involved: the Gist IS the store, GitHub Actions
// is the sender. Expired subscriptions (410/404) are pruned from the Gist.
import webpush from 'web-push';

const {
  GIST_ID,
  GIST_TOKEN,
  VAPID_PRIVATE_KEY,
  VAPID_SUBJECT = 'mailto:example@example.com',
} = process.env;

// Public VAPID key — matches modules/push.js in the app. Public, so hardcoded.
const VAPID_PUBLIC_KEY = 'BMJIta4PeTtDNGgMMdOCuYDJWfMELreh04yi7ytEAEgNG0aO5CkwzBAMY1CbiwsDBYZc_DdArPvoOtA6atLIQ24';
const SUBS_FILE = 'push-subscriptions.json';

if (!GIST_ID || !GIST_TOKEN || !VAPID_PRIVATE_KEY) {
  console.error('Missing GIST_ID, GIST_TOKEN, or VAPID_PRIVATE_KEY secret.');
  process.exit(1);
}

webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);

const gh = (path, opts = {}) =>
  fetch(`https://api.github.com${path}`, {
    ...opts,
    headers: {
      Authorization: `Bearer ${GIST_TOKEN}`,
      Accept: 'application/vnd.github+json',
      'Content-Type': 'application/json',
      ...(opts.headers || {}),
    },
  });

const gist = await (await gh(`/gists/${GIST_ID}`)).json();
const file = gist.files && gist.files[SUBS_FILE];
let subs = [];
try { subs = JSON.parse((file && file.content) || '[]'); } catch { subs = []; }

if (!subs.length) {
  console.log('No push subscriptions yet — nothing to send.');
  process.exit(0);
}

const payload = JSON.stringify({
  title: 'Good morning ☀️',
  body: 'Today’s brief is ready — tap to open Home OS.',
  url: 'https://ortizzle.github.io/ortiz-home-os/',
});

const keep = [];
for (const s of subs) {
  try {
    await webpush.sendNotification({ endpoint: s.endpoint, keys: s.keys }, payload);
    keep.push(s);
    console.log('sent →', s.label || 'device', s.endpoint.slice(0, 42) + '…');
  } catch (err) {
    const code = err.statusCode;
    if (code === 404 || code === 410) {
      console.log('pruning expired subscription', s.endpoint.slice(0, 42) + '…');
      // dropped by not pushing to keep[]
    } else {
      console.log('send error', code, (err.body || err.message || '').slice(0, 120));
      keep.push(s); // transient — keep it for next time
    }
  }
}

if (keep.length !== subs.length) {
  await gh(`/gists/${GIST_ID}`, {
    method: 'PATCH',
    body: JSON.stringify({ files: { [SUBS_FILE]: { content: JSON.stringify(keep, null, 2) } } }),
  });
  console.log(`pruned ${subs.length - keep.length} expired subscription(s).`);
}
