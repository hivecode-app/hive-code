// Images pasted into the page (web build: web/paste.js). On Android the composer takes them from
// the keyboard and the clipboard itself (composer.dart), so this is a no-op there.
import 'dart:typed_data';

import 'paste_io.dart' if (dart.library.js_interop) 'paste_web.dart' as impl;

typedef PastedImage = void Function(Uint8List bytes, String mime, String name);

/// The open composer listens; the returned function stops it. The last one to listen gets them.
void Function() listenPastedImages(PastedImage onImage) => impl.listenPastedImages(onImage);
