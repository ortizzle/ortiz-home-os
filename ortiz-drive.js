/* ortiz-drive.js — the Ortiz apps' Google Drive copy. Same file in every app.
 *
 * Saves the app's data as one dated JSON per day into
 *   My Drive › Ortiz App Backups › <App name> › <prefix>-YYYY-MM-DD.json
 * whenever the data has changed since the last copy. Same-day saves update that
 * day's file in place, so a busy day is one file, not fifty.
 *
 * drive.file is the narrow scope: the app can only see files it created, never
 * the rest of the Drive. The client ID is Home OS's (same origin, same project).
 *
 * All the apps share one origin (ortizzle.github.io), so the Google token and
 * the folder cache are shared too: signing in from one app covers every app
 * for the next hour. Per-app state is keyed by the app's prefix.
 *
 * Usage:
 *   OrtizDrive.init({ app: 'Home OS', prefix: 'home-os', getData: () => payload,
 *                     toast: msg => ..., onChange: () => render() });
 *   OrtizDrive.check();                    // after load/sync/save — cheap, safe to over-call
 *   container.appendChild(OrtizDrive.settingsBlock());   // in Settings
 *   OrtizDrive.mountBar(container);        // where a one-tap nudge may appear
 */
(function () {
  'use strict';
  var CLIENT_ID = '305346848345-0q6ojf9t6eqhguh4pb3f2gm5p7rhhmtq.apps.googleusercontent.com';
  var SCOPE = 'https://www.googleapis.com/auth/drive.file';
  var ROOT = 'Ortiz App Backups';
  var NS = 'ortizdrive:';

  var cfg = null, gisLoading = null, busy = false, due = false, lastError = '';

  function get(k, d) { try { var v = localStorage.getItem(NS + k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } }
  function set(k, v) { try { localStorage.setItem(NS + k, JSON.stringify(v)); } catch (e) {} }
  function mine(k) { return cfg.prefix + ':' + k; }

  // Arizona has no DST; never derive "today" from toISOString (that's UTC).
  function today() {
    return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Phoenix', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  }

  function say(msg) {
    if (cfg && typeof cfg.toast === 'function') { try { cfg.toast(msg); return; } catch (e) {} }
    var t = document.createElement('div');
    t.textContent = msg;
    t.setAttribute('role', 'status');
    t.style.cssText = 'position:fixed;left:50%;bottom:24px;transform:translateX(-50%);max-width:90vw;padding:12px 16px;border-radius:12px;background:rgba(20,20,28,.92);color:#fff;font:14px/1.4 system-ui,sans-serif;z-index:99999;box-shadow:0 6px 20px rgba(0,0,0,.3)';
    document.body.appendChild(t);
    setTimeout(function () { t.remove(); }, 4200);
  }

  function changed() {
    try { window.dispatchEvent(new CustomEvent('ortizdrive:change')); } catch (e) {}
    if (cfg && typeof cfg.onChange === 'function') { try { cfg.onChange(); } catch (e) {} }
    refreshMounted();
  }

  function fingerprint(data) {
    var s = JSON.stringify(data);
    var h = 5381;
    for (var i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
    return s.length + ':' + h;
  }

  function loadGis() {
    if (window.google && google.accounts && google.accounts.oauth2) return Promise.resolve();
    if (!gisLoading) {
      gisLoading = new Promise(function (resolve, reject) {
        var s = document.createElement('script');
        s.src = 'https://accounts.google.com/gsi/client';
        s.async = true;
        s.onload = resolve;
        s.onerror = function () { gisLoading = null; reject(new Error('Google sign-in didn’t load')); };
        document.head.appendChild(s);
      });
    }
    return gisLoading;
  }

  function validToken() {
    var t = get('token', null);
    return t && t.accessToken && t.expiresAt > Date.now() + 60000 ? t.accessToken : null;
  }

  // A fresh token needs a tap: Android Chrome blocks Google's popup unless it
  // comes straight from a user gesture, and there's no server to refresh tokens.
  // GIS must already be loaded when the tap lands, or the await eats the gesture.
  function requestToken() {
    return new Promise(function (resolve, reject) {
      if (!(window.google && google.accounts && google.accounts.oauth2)) {
        loadGis().catch(function () {});
        reject(new Error('Google sign-in is still loading — tap again in a second'));
        return;
      }
      var client = google.accounts.oauth2.initTokenClient({
        client_id: CLIENT_ID,
        scope: SCOPE,
        callback: function (resp) {
          if (resp.error || !resp.access_token) { reject(new Error(resp.error_description || resp.error || 'not allowed')); return; }
          set('token', { accessToken: resp.access_token, expiresAt: Date.now() + (resp.expires_in || 3600) * 1000 });
          set('granted', true);
          resolve(resp.access_token);
        },
        error_callback: function (err) { reject(new Error(err && err.type === 'popup_closed' ? 'Sign-in closed' : 'Sign-in didn’t open')); }
      });
      client.requestAccessToken({ prompt: get('granted', false) ? '' : 'consent' });
    });
  }

  function api(url, opts) {
    opts = opts || {};
    var tok = validToken();
    if (!tok) return Promise.reject(new Error('AUTH'));
    var headers = Object.assign({}, opts.headers || {}, { Authorization: 'Bearer ' + tok });
    return fetch(url, Object.assign({}, opts, { headers: headers })).then(function (res) {
      if (res.status === 401) { set('token', null); throw new Error('AUTH'); }
      if (!res.ok) throw new Error('Drive ' + res.status);
      return res.json();
    });
  }

  function folder(name, parentId) {
    var cache = get('folders', {}) || {};
    var key = (parentId || 'root') + '/' + name;
    var verify = cache[key]
      ? api('https://www.googleapis.com/drive/v3/files/' + cache[key] + '?fields=id,trashed')
          .then(function (f) { return f.trashed ? null : f.id; }, function (e) { if (e.message === 'AUTH') throw e; return null; })
      : Promise.resolve(null);
    return verify.then(function (id) {
      if (id) return id;
      var q = "name='" + name.replace(/'/g, "\\'") + "' and mimeType='application/vnd.google-apps.folder' and trashed=false and '" + (parentId || 'root') + "' in parents";
      return api('https://www.googleapis.com/drive/v3/files?q=' + encodeURIComponent(q) + '&fields=files(id)&spaces=drive').then(function (found) {
        var hit = found.files && found.files[0] && found.files[0].id;
        if (hit) return hit;
        var meta = { name: name, mimeType: 'application/vnd.google-apps.folder' };
        if (parentId) meta.parents = [parentId];
        return api('https://www.googleapis.com/drive/v3/files?fields=id', {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(meta)
        }).then(function (made) { return made.id; });
      }).then(function (newId) {
        var c = get('folders', {}) || {};
        c[key] = newId;
        set('folders', c);
        return newId;
      });
    });
  }

  function upload(blob, name, parentId) {
    var form = new FormData();
    form.append('metadata', new Blob([JSON.stringify({ name: name, parents: [parentId] })], { type: 'application/json' }));
    form.append('file', blob);
    return api('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id', { method: 'POST', body: form });
  }

  function run() {
    if (busy) return Promise.resolve(false);
    busy = true;
    var data, fp;
    try { data = cfg.getData(); fp = fingerprint(data); }
    catch (e) { busy = false; return Promise.reject(new Error('couldn’t read the app data')); }
    var date = today();
    var blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    return folder(ROOT, null)
      .then(function (root) { return folder(cfg.app, root); })
      .then(function (appFolder) {
        var day = get(mine('day'), null);
        var patch = (day && day.date === date && day.id)
          ? api('https://www.googleapis.com/upload/drive/v3/files/' + day.id + '?uploadType=media&fields=id', { method: 'PATCH', body: blob })
              .then(function () { return true; }, function (e) { if (e.message === 'AUTH') throw e; return false; })
          : Promise.resolve(false);
        return patch.then(function (done) {
          if (done) return;
          return upload(blob, cfg.prefix + '-' + date + '.json', appFolder).then(function (made) {
            set(mine('day'), { date: date, id: made.id });
          });
        });
      })
      .then(function () {
        set(mine('fp'), fp);
        set(mine('last_at'), new Date().toISOString());
        due = false; lastError = '';
        return true;
      })
      .finally(function () { busy = false; });
  }

  var OrtizDrive = {
    rootFolder: ROOT,

    init: function (options) {
      cfg = options;
      if (!cfg || !cfg.app || !cfg.prefix || typeof cfg.getData !== 'function') throw new Error('OrtizDrive.init needs app, prefix, getData');
      if (this.enabled()) loadGis().catch(function () {});
      document.addEventListener('visibilitychange', function () {
        if (document.visibilityState === 'visible') setTimeout(function () { OrtizDrive.check(); }, 2500);
      });
      setTimeout(function () { OrtizDrive.check(); }, 2500);
    },

    enabled: function () {
      if (!cfg || !get(mine('on'), false)) return false;
      return typeof cfg.allowed === 'function' ? !!cfg.allowed() : true;
    },
    allowedHere: function () { return !cfg || typeof cfg.allowed !== 'function' || !!cfg.allowed(); },
    isDue: function () { return due && this.enabled(); },
    folderPath: function () { return 'My Drive › ' + ROOT + ' › ' + (cfg ? cfg.app : ''); },

    status: function () {
      var at = cfg && get(mine('last_at'), null);
      if (!at) return 'Not saved yet.';
      var d = new Date(at);
      return 'Last saved ' + d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'America/Phoenix' }) +
        ', ' + d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: 'America/Phoenix' }) + '.';
    },

    // Cheap; call after every load, sync, or save. Saves quietly while a token
    // is live; otherwise raises the one-tap bar — only if the data changed.
    check: function () {
      if (!this.enabled() || busy) return Promise.resolve();
      var fp;
      try { fp = fingerprint(cfg.getData()); } catch (e) { return Promise.resolve(); }
      if (get(mine('fp'), null) === fp) { if (due) { due = false; changed(); } return Promise.resolve(); }
      loadGis().catch(function () {});
      var self = this;
      var attempt = validToken() ? run().then(function () { changed(); return true; }, function () { return false; }) : Promise.resolve(false);
      return attempt.then(function (saved) {
        if (!saved && !due && self.enabled()) { due = true; changed(); }
      });
    },

    // From a tap. Never loses anything: the app's own storage and sync are
    // untouched whatever Drive says.
    save: function () {
      var first = !get(mine('on'), false);
      var getTok = validToken() ? Promise.resolve() : loadGis().then(requestToken);
      return getTok.then(function () {
        set(mine('on'), true);
        say('Saving a copy to Google Drive…');
        return run();
      }).then(function (ok) {
        if (ok) say('Saved to Drive · ' + ROOT + ' › ' + cfg.app);
      }).catch(function (e) {
        if (first && !validToken()) set(mine('on'), false);
        lastError = e.message;
        say(e.message === 'AUTH' ? 'Google sign-in expired — tap again to reconnect.' : 'Drive copy didn’t finish: ' + e.message + '. Nothing in the app is lost.');
      }).then(changed);
    },

    turnOff: function () {
      set(mine('on'), false);
      due = false;
      say('Drive copies off for ' + cfg.app + ' on this device. Files already in Drive stay put.');
      changed();
    },

    // A self-updating block for the app's Settings. Inherits the app's colors.
    settingsBlock: function (opts) {
      opts = opts || {};
      var wrap = document.createElement('div');
      wrap.className = 'ortiz-drive';
      wrap.setAttribute('data-ortiz-drive', 'settings');
      draw(wrap, opts);
      mounted.push({ el: wrap, kind: 'settings', opts: opts });
      if (this.allowedHere()) loadGis().catch(function () {});
      return wrap;
    },

    // Put (or clear) the one-tap bar inside container. Safe to call on every render.
    mountBar: function (container, opts) {
      if (!container) return;
      var old = container.querySelector('[data-ortiz-drive="bar"]');
      if (old) old.remove();
      if (!this.isDue()) return;
      var b = barButton(opts || {});
      if (opts && opts.before && opts.before.parentNode === container) container.insertBefore(b, opts.before);
      else if (opts && opts.prepend) container.insertBefore(b, container.firstChild);
      else container.appendChild(b);
      mounted.push({ el: b, kind: 'bar', container: container, opts: opts || {} });
    }
  };

  var BTN_CSS = 'display:block;width:100%;box-sizing:border-box;min-height:48px;padding:10px 14px;margin:8px 0;border-radius:12px;' +
    'border:1px solid currentColor;background:transparent;color:inherit;font:inherit;font-size:.9em;text-align:center;cursor:pointer;';

  var mounted = [];
  function refreshMounted() {
    mounted = mounted.filter(function (m) { return document.body.contains(m.el); });
    mounted.slice().forEach(function (m) {
      if (m.kind === 'settings') draw(m.el, m.opts);
      else if (m.kind === 'bar') OrtizDrive.mountBar(m.container, m.opts);
    });
  }

  function barButton(opts) {
    var b = document.createElement('button');
    b.type = 'button';
    b.className = 'ortiz-drive-bar' + (opts.className ? ' ' + opts.className : '');
    b.setAttribute('data-ortiz-drive', 'bar');
    b.style.cssText = opts.className ? '' : BTN_CSS + 'opacity:.92;';
    b.textContent = '☁  Changes since the last Drive copy — tap to save one';
    b.addEventListener('click', function () {
      b.disabled = true;
      b.textContent = 'Saving to Google Drive…';
      OrtizDrive.save();
    });
    return b;
  }

  function draw(wrap, opts) {
    wrap.textContent = '';
    if (!OrtizDrive.allowedHere()) return;
    var on = !!get(mine('on'), false);
    var label = document.createElement(opts.labelTag || 'div');
    label.className = opts.labelClass || 'ortiz-drive-label';
    if (!opts.labelClass) label.style.cssText = 'font-weight:600;margin:14px 0 4px;';
    label.textContent = 'Google Drive copy';
    wrap.appendChild(label);
    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'ortiz-drive-btn' + (opts.buttonClass ? ' ' + opts.buttonClass : '');
    if (!opts.buttonClass) btn.style.cssText = BTN_CSS;
    btn.textContent = on ? '☁ Save a copy to Google Drive now' : '☁ Connect Google Drive — a dated copy whenever something changes';
    btn.addEventListener('click', function () { btn.disabled = true; OrtizDrive.save(); });
    wrap.appendChild(btn);
    var hint = document.createElement('div');
    hint.className = opts.hintClass || 'ortiz-drive-hint';
    if (!opts.hintClass) hint.style.cssText = 'font-size:.8em;opacity:.75;line-height:1.4;';
    hint.textContent = 'Saves to ' + OrtizDrive.folderPath() + '. ' + (on ? OrtizDrive.status() : 'The app can only see files it makes there — nothing else in your Drive.');
    wrap.appendChild(hint);
    if (on) {
      var off = document.createElement('button');
      off.type = 'button';
      off.className = 'ortiz-drive-off';
      off.style.cssText = 'background:none;border:none;color:inherit;opacity:.7;font:inherit;font-size:.8em;text-decoration:underline;min-height:48px;padding:0 4px;cursor:pointer;';
      off.textContent = 'Stop the Drive copies on this device';
      off.addEventListener('click', function () { OrtizDrive.turnOff(); });
      wrap.appendChild(off);
    }
  }

  window.OrtizDrive = OrtizDrive;
})();
