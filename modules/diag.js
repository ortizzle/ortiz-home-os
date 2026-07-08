// diag.js — the Diagnostics panel in Settings. Inspects every layer the
// shared AI records (especially the weekly review) pass through, so a
// "my review vanished" report can be pinned to an exact cause: the local
// DB record, the localStorage mirror, deletion tombstones, storage
// eviction, and what the synced Gist actually contains right now.

import { getAll, getSettings, uid } from './store.js';
import { el, toast, todayStr, disclosure } from './ui.js';

async function openRawDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('ortiz-home-os');
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

// A direct write→read→delete round trip against the reviews store, bypassing
// app helpers — proves the storage layer itself works on this device.
async function roundTrip() {
  const db = await openRawDb();
  const id = 'diag-' + uid();
  try {
    await new Promise((res, rej) => {
      const tx = db.transaction('reviews', 'readwrite');
      tx.objectStore('reviews').put({ id, probe: true });
      tx.oncomplete = res;
      tx.onerror = () => rej(tx.error);
    });
    const back = await new Promise((res, rej) => {
      const r = db.transaction('reviews', 'readonly').objectStore('reviews').get(id);
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
    await new Promise((res, rej) => {
      const tx = db.transaction('reviews', 'readwrite');
      tx.objectStore('reviews').delete(id); // raw delete: no tombstone
      tx.oncomplete = res;
      tx.onerror = () => rej(tx.error);
    });
    return back?.probe ? 'OK' : 'FAILED (read back empty)';
  } catch (err) {
    return `FAILED (${err.message})`;
  } finally {
    db.close();
  }
}

export async function runDiagnostics(appVersion) {
  const s = getSettings();
  const L = [];
  const line = (k, v) => L.push(`${k}: ${v}`);

  L.push(`— Ortiz Home OS diagnostics · ${new Date().toLocaleString()} —`);
  line('App version', appVersion);
  line('Device name', s.deviceName || '(not set)');
  line('User agent', navigator.userAgent.replace(/^Mozilla\/5\.0 /, '').slice(0, 90));

  // Storage health — eviction wipes the whole origin, so "persisted: false"
  // on a phone that loses data is a smoking gun.
  try {
    const persisted = await navigator.storage?.persisted?.();
    line('Storage persisted', persisted === undefined ? 'unknown' : persisted);
    if (persisted === false) {
      const granted = await navigator.storage.persist();
      line('  → requested persist', granted ? 'GRANTED now' : 'denied (browser decides)');
    }
    const est = await navigator.storage?.estimate?.();
    if (est) line('Storage used', `${Math.round((est.usage || 0) / 1024)} KB of ~${Math.round((est.quota || 0) / 1048576)} MB quota`);
  } catch { line('Storage health', 'unavailable'); }

  // Local DB
  try {
    const db = await openRawDb();
    line('DB version', `${db.version} (stores: ${[...db.objectStoreNames].join(', ')})`);
    db.close();
  } catch (err) { line('DB', `FAILED to open: ${err.message}`); }
  line('Write→read round trip', await roundTrip());

  // The review, layer by layer
  const reviews = await getAll('reviews').catch(() => []);
  const cur = reviews.find((r) => r.id === 'current');
  if (cur) {
    line('Review (synced record)', `PRESENT — reviewed ${cur.reviewedAt}, updated ${cur.updatedAt}, ${(cur.data?.planItems || []).length} items, ${(cur.added || []).length} added, ${(cur.dismissed || []).length} dismissed, by ${cur.by || '?'}`);
  } else {
    line('Review (synced record)', 'MISSING');
  }
  try {
    const m = JSON.parse(localStorage.getItem('ohos.weekReview'));
    line('Review (local mirror)', m?.data ? `present — reviewed ${m.reviewedAt}, ${(m.data.planItems || []).length} items` : 'empty');
  } catch { line('Review (local mirror)', 'unreadable'); }
  const tombs = (await getAll('tombstones').catch(() => [])).filter((t) => t.store === 'reviews');
  line('Review tombstones', tombs.length ? tombs.map((t) => `${t.recordId} deleted ${t.deletedAt}`).join('; ') : 'none');

  // Companion shared records
  const briefs = await getAll('briefs').catch(() => []);
  line('Briefs stored', `${briefs.length}${briefs.length ? ` (latest: ${briefs.map((b) => b.id).sort().pop()})` : ''}`);
  line('Pins stored', String((await getAll('pins').catch(() => [])).length));

  // The Gist — what's actually in the shared file right now
  if (!s.gistToken || !s.gistId) {
    line('Sync', 'not configured on this device');
  } else {
    try {
      const res = await fetch(`https://api.github.com/gists/${s.gistId}`, {
        headers: { Authorization: `Bearer ${s.gistToken}`, Accept: 'application/vnd.github+json' },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const gist = await res.json();
      const file = gist.files?.['ortiz-home-os.json'];
      if (!file?.content) {
        line('Gist', 'file missing or empty');
      } else {
        const snap = JSON.parse(file.content);
        const keys = Object.keys(snap.data || {});
        line('Gist data keys', keys.join(', ') || '(none)');
        const gr = (snap.data?.reviews || []).find((r) => r.id === 'current');
        line('Gist review', gr ? `PRESENT — reviewed ${gr.reviewedAt}, updated ${gr.updatedAt}, by ${gr.by || '?'}` : 'MISSING from gist');
        if (!keys.includes('reviews')) line('  ⚠', 'gist lacks the reviews store entirely — a device running pre-v24 code pushed last');
      }
      const hist = (gist.history || []).slice(0, 5).map((h) => new Date(h.committed_at).toLocaleString());
      line('Gist last 5 pushes', hist.join(' | ') || 'none');
    } catch (err) {
      line('Gist', `FAILED to fetch: ${err.message}`);
    }
  }

  return L.join('\n');
}

// The Settings panel: run + copy.
export function diagnosticsSection(appVersion) {
  const out = el('pre', { class: 'diag-out', style: 'display: none' });
  const copyBtn = el('button', {
    class: 'btn', style: 'display: none',
    onclick: async () => {
      try { await navigator.clipboard.writeText(out.textContent); toast('Copied — paste it to Claude', 'success'); }
      catch { toast('Could not copy — long-press to select instead', 'warn'); }
    },
  }, 'Copy report');
  const runBtn = el('button', {
    class: 'btn btn-primary',
    onclick: async () => {
      runBtn.disabled = 'disabled';
      runBtn.textContent = 'Checking…';
      out.style.display = '';
      out.textContent = 'Running checks…';
      out.textContent = await runDiagnostics(appVersion);
      copyBtn.style.display = '';
      runBtn.disabled = null;
      runBtn.textContent = 'Run diagnostics';
    },
  }, 'Run diagnostics');

  return disclosure('Diagnostics', el('section', { class: 'panel' }, [
    el('p', { class: 'muted small' }, 'If something looks off — a vanished review, missing sync — run this and copy the report. It checks this phone’s storage, the backup mirror, and what the shared sync file actually contains.'),
    el('div', { class: 'settings-actions' }, [runBtn, copyBtn]),
    out,
  ]));
}
