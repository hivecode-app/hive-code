// The composer's text field on Android: Android's own EditText (ComposerField.kt), shown through a
// platform view. Flutter's TextField lays all its text out in one direction; WhatsApp's field gives
// every line its own, from its first strong letter: "git status" is LTR and left-aligned, the
// Hebrew line under it RTL. Android's EditText does exactly that, with Android's selection handles,
// copy/paste menu, select all and the keyboard's clipboard. Web and desktop keep the TextField.
//
// The TextEditingController stays the composer's source of truth for everything around the field
// (draft, send, dictation, "למה?"): what is typed comes back as `changed`, and what Dart sets on the
// controller goes to the EditText. Each value Dart sends carries a number, and a `changed` the
// EditText sent before it applied that value is dropped, so a send never resurrects its text.

import 'package:flutter/foundation.dart';
import 'package:flutter/gestures.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../../native/host.dart';

typedef ComposerImage = void Function(Uint8List bytes, String name, String mime);

class NativeComposerField extends StatefulWidget {
  const NativeComposerField({
    super.key,
    required this.controller,
    required this.focus,
    required this.hint,
    required this.style,
    required this.hintColor,
    required this.accent,
    required this.onImage,
    required this.onImageFailed,
  });
  final TextEditingController controller;
  final FocusNode focus;
  final String hint;
  final TextStyle style;
  final Color hintColor;
  final Color accent;
  final ComposerImage onImage;
  final VoidCallback onImageFailed;

  /// Android only. Tests set it to drive the field through a mocked channel.
  static bool? debugNative;
  static bool get available => debugNative ?? runsOnAndroid;

  static const viewType = 'company/composer';

  /// Same padding as the TextField it replaces (start, top, end, bottom).
  static const padding = [4.0, 12.0, 4.0, 12.0];
  static const minHeight = 46.0;

  @override
  State<NativeComposerField> createState() => NativeComposerFieldState();
}

class NativeComposerFieldState extends State<NativeComposerField> {
  MethodChannel? _ch;
  double height = NativeComposerField.minHeight;

  /// The value both sides last agreed on, and the number of the last one Dart sent.
  TextEditingValue? _synced;
  int _seq = 0;
  Map<String, Object?>? _style;

  @override
  void initState() {
    super.initState();
    widget.controller.addListener(_push);
    widget.focus.addListener(_focusChanged);
  }

  @override
  void didUpdateWidget(NativeComposerField oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.controller != widget.controller) {
      oldWidget.controller.removeListener(_push);
      widget.controller.addListener(_push);
      _push();
    }
    if (oldWidget.focus != widget.focus) {
      oldWidget.focus.removeListener(_focusChanged);
      widget.focus.addListener(_focusChanged);
    }
  }

  @override
  void dispose() {
    widget.controller.removeListener(_push);
    widget.focus.removeListener(_focusChanged);
    _ch?.setMethodCallHandler(null);
    super.dispose();
  }

  Map<String, Object?> _styleArgs() => {
        'hint': widget.hint,
        'color': (widget.style.color ?? Colors.black).toARGB32(),
        'hintColor': widget.hintColor.toARGB32(),
        'accent': widget.accent.toARGB32(),
        'size': widget.style.fontSize ?? 15.5,
        'height': widget.style.height ?? 1.45,
        'padding': NativeComposerField.padding,
      };

  static Map<String, Object?> _valueArgs(TextEditingValue v, int seq) {
    final s = v.selection.isValid ? v.selection : TextSelection.collapsed(offset: v.text.length);
    return {'text': v.text, 'start': s.baseOffset, 'end': s.extentOffset, 'seq': seq};
  }

  void _push() {
    final v = widget.controller.value;
    final ch = _ch;
    if (ch == null) return;
    final last = _synced;
    if (last != null && last.text == v.text && (last.selection == v.selection || !v.selection.isValid)) return;
    _synced = v;
    ch.invokeMethod('setValue', _valueArgs(v, ++_seq));
  }

  // When the EditText already has focus, taking it here makes the AndroidView send `clearFocus`
  // during this same change; `focus` goes after it, so the field ends up focused either way.
  void _focusChanged() {
    if (widget.focus.hasPrimaryFocus) {
      Future(() {
        if (mounted && widget.focus.hasPrimaryFocus) _ch?.invokeMethod('focus');
      });
    }
  }

  Future<Object?> _onCall(MethodCall call) async {
    final a = call.arguments is Map ? call.arguments as Map : const {};
    switch (call.method) {
      case 'changed':
        // Typed before Dart's latest value reached the EditText: that value wins.
        if ((a['seq'] as int? ?? 0) < _seq) return null;
        final text = a['text'] as String? ?? '';
        final v = TextEditingValue(
          text: text,
          selection: TextSelection(baseOffset: (a['start'] as int? ?? text.length).clamp(0, text.length), extentOffset: (a['end'] as int? ?? text.length).clamp(0, text.length)),
        );
        _synced = v;
        widget.controller.value = v;
      case 'height':
        final h = ((a['px'] as num?)?.toDouble() ?? 0).clamp(NativeComposerField.minHeight, 400.0);
        if (mounted && h != height) setState(() => height = h);
      case 'image':
        final bytes = a['bytes'];
        if (bytes is Uint8List) {
          widget.onImage(bytes, a['name'] as String? ?? 'image', a['mime'] as String? ?? 'image/png');
        } else {
          widget.onImageFailed();
        }
    }
    return null;
  }

  void _created(int id) {
    _ch = MethodChannel('company/composer/$id')..setMethodCallHandler(_onCall);
    _style = _styleArgs();
    // What changed while the view was being created.
    _push();
    if (widget.focus.hasPrimaryFocus) _focusChanged();
  }

  @override
  Widget build(BuildContext context) {
    final style = _styleArgs();
    if (_ch != null && !mapEquals(style, _style)) {
      _style = style;
      _ch!.invokeMethod('style', style);
    }
    _synced ??= widget.controller.value;
    return Focus(
      focusNode: widget.focus,
      child: SizedBox(
        height: height,
        child: AndroidView(
          viewType: NativeComposerField.viewType,
          layoutDirection: Directionality.of(context),
          creationParams: {...style, ..._valueArgs(widget.controller.value, 0)},
          creationParamsCodec: const StandardMessageCodec(),
          onPlatformViewCreated: _created,
          // Every touch on the field is the EditText's: taps, selection drags, scrolling inside it.
          gestureRecognizers: {Factory<OneSequenceGestureRecognizer>(EagerGestureRecognizer.new)},
        ),
      ),
    );
  }
}
