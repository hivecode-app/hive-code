import 'dart:js_interop';

@JS('document.hasFocus')
external JSBoolean _hasFocus();

@JS('document.visibilityState')
external JSString get _visibility;

@JS('window.addEventListener')
external void _winOn(JSString type, JSFunction f);

@JS('window.removeEventListener')
external void _winOff(JSString type, JSFunction f);

@JS('document.addEventListener')
external void _docOn(JSString type, JSFunction f);

@JS('document.removeEventListener')
external void _docOff(JSString type, JSFunction f);

bool windowFocused() {
  try {
    return _hasFocus().toDart && _visibility.toDart == 'visible';
  } catch (_) {
    return true;
  }
}

void Function() onWindowFocusChange(void Function() changed) {
  final f = ((JSAny? _) => changed()).toJS;
  _winOn('focus'.toJS, f);
  _winOn('blur'.toJS, f);
  _docOn('visibilitychange'.toJS, f);
  return () {
    _winOff('focus'.toJS, f);
    _winOff('blur'.toJS, f);
    _docOff('visibilitychange'.toJS, f);
  };
}
