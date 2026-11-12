/* Meeting notes saved on this device, one store per signed-in admin (a shared device keeps each admin's apart).
   No passphrase: the device's own screen lock and Google sign-in protect them (Mark's choice, Nov 12).
   Notes saved before that were encrypted with a passphrase; legacy() and unlockLegacy() bring them over once,
   and copies saved back then still open with their passphrase. */
(function () {
  let uid = '';
  const storeKey = () => 'mm_notes_v1:' + uid;
  const legacyKey = () => 'mm_vault_v2:' + uid;
  const enc = new TextEncoder(), dec = new TextDecoder();
  const unb64 = s => Uint8Array.from(atob(s), c => c.charCodeAt(0));
  const readJSON = k => { try { const t = localStorage.getItem(k); return t ? JSON.parse(t) : null; } catch (e) { return null; } };

  /* ----- the old encrypted format (PBKDF2-SHA256 310k → AES-256-GCM), read-only ----- */
  async function derive(pass, saltBytes) {
    const base = await crypto.subtle.importKey('raw', enc.encode(pass), 'PBKDF2', false, ['deriveKey']);
    return crypto.subtle.deriveKey({ name: 'PBKDF2', salt: saltBytes, iterations: 310000, hash: 'SHA-256' },
      base, { name: 'AES-GCM', length: 256 }, false, ['decrypt']);
  }
  async function openBox(box, pass) {
    const k = await derive(pass, unb64(box.salt));
    const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(box.iv) }, k, unb64(box.ct));
    return JSON.parse(dec.decode(pt));
  }

  const Vault = {
    /* Pick whose notes to use (the signed-in person's account id). */
    use(userId) { uid = userId || ''; },
    load() { return readJSON(storeKey()); },
    save(obj) {
      try { localStorage.setItem(storeKey(), JSON.stringify(obj)); }
      catch (e) { throw new Error('This device’s browser storage is full'); }
    },
    erase() { try { localStorage.removeItem(storeKey()); localStorage.removeItem(legacyKey()); } catch (e) {} },

    /* Notes still in the old passphrase format on this device. */
    legacy() { return !!readJSON(legacyKey()); },
    async unlockLegacy(pass) {
      const box = readJSON(legacyKey()); if (!box) throw new Error('Nothing to bring over');
      let data;
      try { data = await openBox(box, pass); } catch (e) { throw new Error('That isn’t the old passphrase'); }
      this.save(data); this.dropLegacy();
      return data;
    },
    dropLegacy() { try { localStorage.removeItem(legacyKey()); } catch (e) {} },

    /* Meeting copies: plain files that open on any device with this app. Old copies were encrypted and need their passphrase. */
    exportFile(obj) { return { app: 'meeting-minutes', v: 2, data: obj }; },
    async importFile(box, pass) {
      if (!box || box.app !== 'meeting-minutes' || !(box.data || box.ct)) throw new Error('That isn’t a meeting file');
      if (box.data) return box.data;
      if (!pass) throw new Error('needpass');
      try { return await openBox(box, pass); } catch (e) { throw new Error('Wrong passphrase for that file'); }
    }
  };
  window.Vault = Vault;
})();
