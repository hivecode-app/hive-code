// Pasting an image into the chat (web build). Flutter's text field only knows text, so the page
// catches the paste itself: when the clipboard holds an image and no plain text, the image goes to
// the open composer (lib/native/paste_web.dart) and the field gets nothing. Text, or text that comes
// with a picture of itself (Word, a web page), pastes as text, as before.
(function () {
  var handler = null;
  window.companyPaste = {
    set: function (fn) { handler = fn; },
    clear: function (fn) { if (handler === fn) handler = null; },
  };
  document.addEventListener('paste', function (e) {
    var data = e.clipboardData;
    if (!handler || !data) return;
    if ((data.getData('text/plain') || '').trim()) return;
    var files = [];
    for (var i = 0; i < data.items.length; i++) {
      var it = data.items[i];
      if (it.kind === 'file' && it.type.indexOf('image/') === 0) {
        var f = it.getAsFile();
        if (f) files.push(f);
      }
    }
    if (!files.length) return;
    e.preventDefault();
    e.stopPropagation();
    var fn = handler;
    files.forEach(function (f) {
      f.arrayBuffer().then(function (buf) { fn(new Uint8Array(buf), f.type, f.name || ''); });
    });
  }, true);
})();
