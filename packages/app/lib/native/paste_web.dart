// Web: web/paste.js hands over the clipboard's image as bytes.
import 'dart:js_interop';

import 'paste.dart';

@JS('companyPaste')
external _Api? get _api;

extension type _Api(JSObject _) implements JSObject {
  external void set(JSFunction fn);
  external void clear(JSFunction fn);
}

void Function() listenPastedImages(PastedImage onImage) {
  final api = _api;
  if (api == null) return () {};
  final fn = ((JSUint8Array bytes, JSString mime, JSString name, JSString? path, JSNumber? size) => onImage(
    bytes.toDart,
    mime.toDart,
    name.toDart,
    path: path?.toDart,
    size: size?.toDartInt,
  ).then<JSAny?>((release) => release.toJS).toJS).toJS;
  api.set(fn);
  return () => api.clear(fn);
}
