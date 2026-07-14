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

// Standard "share" glyph — three linked nodes — matching the app's line-icon
// style. Pass as `html` on an `.icon-btn` (Tasks header, Claudia's brief, the
// weekly plan) so every share affordance is the same small icon.
export const SHARE_SVG = '<svg viewBox="0 0 24 24"><circle cx="18" cy="5" r="2.6"/><circle cx="6" cy="12" r="2.6"/><circle cx="18" cy="19" r="2.6"/><path d="M8.3 10.7l7.4-4.4"/><path d="M8.3 13.3l7.4 4.4"/></svg>';

// Render a minimal slice of Markdown — **bold** only — as safe DOM nodes
// (text nodes + <strong>, never innerHTML, so model output can't inject
// markup). Anything that isn't a matched **…** pair renders literally, so a
// stray asterisk just shows as typed. Returns an array of nodes for use as
// el() children. Used for Claudia's briefs/comments so she can emphasize the
// word or two that matters (a name, a date, a key action).
export function richText(str) {
  const s = String(str ?? '');
  const out = [];
  const re = /\*\*(.+?)\*\*/g;
  let last = 0;
  let m;
  while ((m = re.exec(s))) {
    if (m.index > last) out.push(document.createTextNode(s.slice(last, m.index)));
    out.push(el('strong', {}, m[1]));
    last = m.index + m[0].length;
  }
  if (last < s.length) out.push(document.createTextNode(s.slice(last)));
  return out;
}

// Strip the **bold** markers richText() renders, for plain-text payloads
// (share sheets, clipboard) where the asterisks would just be noise.
export function plainText(str) {
  return String(str ?? '').replace(/\*\*(.+?)\*\*/g, '$1');
}

// Wrap a full-page re-render (clear(root) + rebuild) so it doesn't reset
// scroll to the top — replacing DOM nodes loses the browser's scroll anchor
// even though the content looks the same. Every view's `rerender` should be
// wrapped with this; forgetting it is exactly what sends you back to the top
// after adding an agenda item, ticking a task, etc.
export function preserveScroll(renderFn) {
  return (...args) => {
    const y = window.scrollY;
    return Promise.resolve(renderFn(...args)).then(() => window.scrollTo(0, y));
  };
}

// A collapsible section: a bare heading (matches the app's panel-head
// convention elsewhere) that expands to reveal a bordered panel below it —
// "acts as a button for further action, and saves visual space" for anything
// that isn't the primary reason someone opened this view. `open` controls
// whether it starts expanded (the main content) or collapsed (secondary
// stuff like Done items or an occasional-use import box).
// `content` is placed directly after the summary — pass an already-built
// `.panel` section (the common case) or several nodes for anything that
// needs more than one panel inside (e.g. grouped-by-store sub-lists).
export function disclosure(heading, content, { open = false } = {}) {
  const attrs = { class: 'disclosure' };
  if (open) attrs.open = 'open';
  const kids = Array.isArray(content) ? content : [content];
  return el('details', attrs, [el('summary', { class: 'group-heading' }, heading), ...kids]);
}

// Horizontal swipe navigation (e.g. Calendar's day/week paging). Fires onLeft
// (finger moved left → "go forward", like flipping to the next page) or
// onRight ("go back") once the gesture clearly reads as horizontal — a big
// enough X move that also dominates any Y move, so vertical page scrolling
// is never hijacked. Passive listeners: never blocks native scroll.
export function onSwipe(node, { onLeft, onRight, threshold = 50 } = {}) {
  let x0 = null, y0 = null;
  node.addEventListener('touchstart', (e) => {
    x0 = e.touches[0].clientX;
    y0 = e.touches[0].clientY;
  }, { passive: true });
  node.addEventListener('touchend', (e) => {
    if (x0 == null) return;
    const dx = e.changedTouches[0].clientX - x0;
    const dy = e.changedTouches[0].clientY - y0;
    x0 = y0 = null;
    if (Math.abs(dx) < threshold || Math.abs(dx) < Math.abs(dy) * 1.5) return;
    (dx < 0 ? onLeft : onRight)?.();
  }, { passive: true });
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
// buttons. Returns { close } — tapping the scrim also closes. `onClose`
// (optional) fires exactly once, on ANY close path (scrim tap or the
// returned close()) — use it for state that must be saved no matter how the
// sheet gets dismissed, e.g. a running timer.
export function openModal(title, body, actions = [], { onClose } = {}) {
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
  let closed = false;
  function close() {
    if (closed) return;
    closed = true;
    onClose?.();
    overlay.remove();
  }
  return { close };
}

// A small sticky "table of contents" for long views: a short inline list of
// hyperlinks that jump to sections. `entries` is [{ label, at }] where `at`
// is the heading text to find (prefix match, case-insensitive); label is the
// link text. Tags the matched headings with ids + a scroll-margin class,
// then inserts the link row right after the view's header. No-ops if fewer
// than 2 sections resolve (a TOC for one section is just clutter).
export function tableOfContents(root, entries) {
  // Collapsible sections use <summary> for the heading (see disclosure()) —
  // match those too, or a section that gets turned into a dropdown silently
  // drops out of the jump menu.
  const heads = [...root.querySelectorAll('h4, summary, .view-head-row h1')];
  const norm = (s) => (s || '').trim().toLowerCase();
  const links = [];
  entries.forEach((e, i) => {
    const needle = norm(e.at || e.label);
    const target = heads.find((h) => norm(h.textContent).startsWith(needle));
    if (!target) return;
    if (!target.id) target.id = `toc-${i}-${needle.replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 24)}`;
    target.classList.add('toc-anchor');
    const id = target.id;
    links.push(el('a', {
      class: 'toc-link',
      href: `#${id}`,
      onclick: (ev) => {
        ev.preventDefault();
        document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      },
    }, e.label));
  });
  if (links.length < 2) return;
  // Interleave middot separators between the links.
  const items = links.flatMap((a, i) => (i ? [el('span', { class: 'toc-sep', 'aria-hidden': 'true' }, '·'), a] : [a]));
  const toc = el('nav', { class: 'toc', 'aria-label': 'On this page' }, items);
  const head = root.querySelector('.view-head, .view-head-row');
  if (head) head.after(toc);
  else root.prepend(toc);
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
