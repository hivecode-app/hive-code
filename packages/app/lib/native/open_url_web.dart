import 'dart:js_interop';

@JS('window.open')
external JSObject? _open(JSString url, JSString target);

Future<bool> openExternalUrl(String url) async => _open(url.toJS, '_blank'.toJS) != null;
