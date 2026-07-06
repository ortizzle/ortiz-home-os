// ui.js — tiny shared DOM helpers so view modules stay DRY.
// Ported from Ortiz Learning OS; adds a modal helper and local-date utils.

// Create an element: el('div', { class: 'card', onclick: fn }, [children|strings]).
export function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k === 'html') node.innerHTML = v;
    else if (k.startsWith('on') && typeof v === 'function') {
      node.addEventListener(k.slice(2).toLowerCase(), v);
    } else if (k === 'dataset') {
      Object.assign(node.dataset, v);
    } else {
      node.setAttribute(k, v);
    }
  }
  const kids = Array.isArray(children) ? children : [children];
  for (const c of kids) {
    if (c == null || c === false) continue;
    node.append(c.nodeType ? c : document.createTextNode(String(c)));
  }
  return node;
}

export function clear(node) {
  node.replaceChildren();
  return node;
}

export function escapeHtml(s = '') {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// Lightweight non-blocking toast.
export function toast(message, kind = 'info') {
  let host = document.getElementById('toast-host');
  if (!host) {
    host = el('div', { id: 'toast-host', class: 'toast-host' });
    document.body.append(host);
  }
  const t = el('div', { class: `toast toast-${kind}` }, message);
  host.append(t);
  requestAnimationFrame(() => t.classList.add('show'));
  setTimeout(() => {
    t.classList.remove('show');
    setTimeout(() => t.remove(), 300);
  }, 3200);
}

// Full-view loading state.
export function loading(root, label = 'Working…') {
  clear(root).append(
    el('div', { class: 'loading' }, [el('div', { class: 'spinner' }), el('span', {}, label)])
  );
}

export function navigate(hash) {
  location.hash = hash;
}

// Bottom-sheet modal. `body` is an array of nodes; `actions` an array of
// buttons. Returns { close } — tapping the scrim also closes.
export function openModal(title, body, actions = []) {
  const overlay = el('div', {
    class: 'modal-overlay',
    onclick: (e) => {
      if (e.target === overlay) close();
    },
  });
  overlay.append(
    el('div', { class: 'modal' }, [
      el('h3', {}, title),
      el('div', { class: 'modal-fields' }, body),
      el('div', { class: 'modal-actions' }, actions),
    ])
  );
  document.body.append(overlay);
  function close() {
    overlay.remove();
  }
  return { close };
}

// Share text via the native share sheet (Android/Chrome), falling back to
// the clipboard on platforms without navigator.share.
export async function shareText({ title, text }) {
  if (navigator.share) {
    try {
      await navigator.share({ title, text });
      return true;
    } catch (err) {
      if (err?.name === 'AbortError') return false; // user closed the sheet
    }
  }
  try {
    await navigator.clipboard.writeText(text);
    toast('Copied to clipboard', 'success');
    return true;
  } catch {
    toast('Could not share on this device', 'error');
    return false;
  }
}

// ---------- local dates ----------
// All day-keyed data uses local YYYY-MM-DD strings — never toISOString(),
// which is UTC and rolls the date over at 4-5pm PT.

export function dateStr(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

export function todayStr() {
  return dateStr(new Date());
}

export function parseDate(str) {
  const [y, m, d] = str.split('-').map(Number);
  return new Date(y, m - 1, d);
}

export function addDays(str, n) {
  const d = parseDate(str);
  d.setDate(d.getDate() + n);
  return dateStr(d);
}

// "Sat, Jul 5" (year appended only when not the current year).
export function fmtDay(str) {
  const d = parseDate(str);
  const opts = { weekday: 'short', month: 'short', day: 'numeric' };
  if (d.getFullYear() !== new Date().getFullYear()) opts.year = 'numeric';
  return d.toLocaleDateString(undefined, opts);
}

// Relative label for due dates: Today / Tomorrow / Yesterday / fmtDay.
export function fmtDue(str) {
  const today = todayStr();
  if (str === today) return 'Today';
  if (str === addDays(today, 1)) return 'Tomorrow';
  if (str === addDays(today, -1)) return 'Yesterday';
  return fmtDay(str);
}
