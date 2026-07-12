// push.js — Web Push opt-in for notifications (e.g. the morning "brief is
// ready" nudge). This is the CLIENT half: request permission, subscribe via
// the service worker, and store the subscription in the household Gist. A
// scheduled GitHub Action (.github/workflows/notify.yml) reads those
// subscriptions and actually SENDS the pushes — there's no app backend.
//
// iOS note: Web Push only works in an INSTALLED PWA (Add to Home Screen,
// iOS 16.4+), never a plain Safari tab. pushSupported() reflects that.

import { savePushSub, removePushSub, syncConfigured, deviceName } from './store.js';

// VAPID public key — safe to ship in the client. The matching PRIVATE key is a
// GitHub Actions secret (VAPID_PRIVATE_KEY); the two are generated as a pair.
export const VAPID_PUBLIC_KEY = 'BKNTxUkQp9TtfrfZs9gHVxJF8iplDKxrlHbte6UjE7Ys3KUojw6ulo70znOswKG9wN7ujq0eGjJDRE_F8d3HV68';

export function pushSupported() {
  return 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
}

function urlB64ToUint8Array(base64) {
  const padding = '='.repeat((4 - (base64.length % 4)) % 4);
  const b64 = (base64 + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(b64);
  return Uint8Array.from([...raw].map((c) => c.charCodeAt(0)));
}

// { supported, permission, subscribed } — drives the Settings UI.
export async function getPushState() {
  if (!pushSupported()) return { supported: false, permission: 'unsupported', subscribed: false };
  const reg = await navigator.serviceWorker.getRegistration();
  const sub = reg ? await reg.pushManager.getSubscription() : null;
  return { supported: true, permission: Notification.permission, subscribed: Boolean(sub) };
}

// Ask for permission, subscribe, and register the subscription in the Gist.
export async function enablePush() {
  if (!pushSupported()) {
    throw new Error('This device can’t do push notifications. On iPhone, add Home OS to your Home Screen first, then try again.');
  }
  if (!syncConfigured()) {
    throw new Error('Set up Household sync first (Settings → Household sync) — notifications are stored in your Gist.');
  }
  const perm = await Notification.requestPermission();
  if (perm !== 'granted') {
    throw new Error('Notifications weren’t allowed. You can turn them on for Home OS in your device settings.');
  }
  const reg = await navigator.serviceWorker.ready;
  const sub = await reg.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: urlB64ToUint8Array(VAPID_PUBLIC_KEY),
  });
  await savePushSub(sub.toJSON(), deviceName());
  return true;
}

// Unsubscribe this device and drop it from the Gist.
export async function disablePush() {
  const reg = await navigator.serviceWorker.getRegistration();
  const sub = reg ? await reg.pushManager.getSubscription() : null;
  if (sub) {
    await removePushSub(sub.endpoint).catch(() => {});
    await sub.unsubscribe().catch(() => {});
  }
}
