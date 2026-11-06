/* Encrypted storage for meeting notes on the tablet. AES-256-GCM, key derived from the passphrase with PBKDF2.
   Each signed-in admin has their own store on a shared tablet. The passphrase is never stored;
   a forgotten passphrase cannot be recovered. */
(function () {
  let KEY = 'mm_vault_v2';
  const ITER = 310000;
  const enc = new TextEncoder(), dec = new TextDecoder();
  const b64 = buf => {
    const u = new Uint8Array(buf); let s = '';
    for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode.apply(null, u.subarray(i, i + 0x8000));
    return btoa(s);
  };
  const unb64 = s => Uint8Array.from(atob(s), c => c.charCodeAt(0));

  let key = null, salt = null;

  async function derive(pass, saltBytes) {
    const base = await crypto.subtle.importKey('raw', enc.encode(pass), 'PBKDF2', false, ['deriveKey']);
    return crypto.subtle.deriveKey({ name: 'PBKDF2', salt: saltBytes, iterations: ITER, hash: 'SHA-256' },
      base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  }
  async function seal(obj, k, s) {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, k, enc.encode(JSON.stringify(obj)));
    return { v: 1, salt: b64(s), iv: b64(iv), ct: b64(ct) };
  }
  async function open(box, k) {
    const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(box.iv) }, k, unb64(box.ct));
    return JSON.parse(dec.decode(pt));
  }
  function read() { try { const t = localStorage.getItem(KEY); return t ? JSON.parse(t) : null; } catch (e) { return null; } }

  const Vault = {
    /* Pick whose store to use (the signed-in person's account id). Locks any other. */
    use(userId) { const k = 'mm_vault_v2:' + userId; if (k !== KEY) { key = null; salt = null; KEY = k; } },
    exists() { return !!read(); },
    isOpen() { return !!key; },
    async create(pass, initial) {
      salt = crypto.getRandomValues(new Uint8Array(16));
      key = await derive(pass, salt);
      await this.save(initial);
      return initial;
    },
    async unlock(pass) {
      const box = read(); if (!box) throw new Error('Nothing stored yet');
      const s = unb64(box.salt); const k = await derive(pass, s);
      let data;
      try { data = await open(box, k); } catch (e) { throw new Error('Wrong passphrase'); }
      key = k; salt = s; return data;
    },
    lock() { key = null; },
    async save(obj) {
      if (!key) return;
      const box = await seal(obj, key, salt);
      try { localStorage.setItem(KEY, JSON.stringify(box)); }
      catch (e) { throw new Error('The tablet’s browser storage is full'); }
    },
    erase() { try { localStorage.removeItem(KEY); } catch (e) {} key = null; },
    /* Meeting files: encrypted with the same passphrase, readable on any device with this app. */
    async exportFile(obj) { if (!key) throw new Error('Locked'); return { app: 'meeting-minutes', ...(await seal(obj, key, salt)) }; },
    async importFile(box, pass) {
      if (!box || box.app !== 'meeting-minutes' || !box.ct) throw new Error('That isn’t a meeting file');
      const k = pass ? await derive(pass, unb64(box.salt)) : (box.salt === b64(salt) ? key : await Promise.reject(new Error('needpass')));
      try { return await open(box, k); } catch (e) { throw new Error('Wrong passphrase for that file'); }
    }
  };
  window.Vault = Vault;
})();
