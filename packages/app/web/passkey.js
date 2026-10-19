// WebAuthn for the web build (#23). JSON in, JSON out, base64url for binary fields, so the Dart
// side never touches ArrayBuffers. Never rejects: failures come back as {"error": "<DOMException name>"}.
(function () {
  function toB64u(buf) {
    var s = '', b = new Uint8Array(buf);
    for (var i = 0; i < b.length; i++) s += String.fromCharCode(b[i]);
    return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }
  function fromB64u(str) {
    var s = atob(str.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((str.length + 3) % 4));
    var b = new Uint8Array(s.length);
    for (var i = 0; i < s.length; i++) b[i] = s.charCodeAt(i);
    return b.buffer;
  }
  function creds(list) {
    return (list || []).map(function (c) { return Object.assign({}, c, { id: fromB64u(c.id) }); });
  }
  function fail(e) { return JSON.stringify({ error: (e && e.name) || 'Error' }); }

  async function create(json) {
    try {
      var o = JSON.parse(json);
      o.challenge = fromB64u(o.challenge);
      o.user = Object.assign({}, o.user, { id: fromB64u(o.user.id) });
      o.excludeCredentials = creds(o.excludeCredentials);
      var c = await navigator.credentials.create({ publicKey: o });
      return JSON.stringify({
        id: c.id, rawId: toB64u(c.rawId), type: c.type, authenticatorAttachment: c.authenticatorAttachment || undefined,
        clientExtensionResults: c.getClientExtensionResults(),
        response: {
          clientDataJSON: toB64u(c.response.clientDataJSON),
          attestationObject: toB64u(c.response.attestationObject),
          transports: c.response.getTransports ? c.response.getTransports() : [],
        },
      });
    } catch (e) { return fail(e); }
  }

  async function get(json) {
    try {
      var o = JSON.parse(json);
      o.challenge = fromB64u(o.challenge);
      o.allowCredentials = creds(o.allowCredentials);
      var c = await navigator.credentials.get({ publicKey: o });
      return JSON.stringify({
        id: c.id, rawId: toB64u(c.rawId), type: c.type, authenticatorAttachment: c.authenticatorAttachment || undefined,
        clientExtensionResults: c.getClientExtensionResults(),
        response: {
          clientDataJSON: toB64u(c.response.clientDataJSON),
          authenticatorData: toB64u(c.response.authenticatorData),
          signature: toB64u(c.response.signature),
          userHandle: c.response.userHandle ? toB64u(c.response.userHandle) : undefined,
        },
      });
    } catch (e) { return fail(e); }
  }

  window.companyPasskey = { supported: !!(window.PublicKeyCredential && navigator.credentials), create: create, get: get };
})();
