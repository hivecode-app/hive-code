import 'dart:async';

import 'package:flutter/widgets.dart';
import 'package:web/web.dart' as web;

Widget artifactSurface(String url, void Function(String url) onBlocked) => _Frame(url: url, onBlocked: onBlocked);

class _Frame extends StatefulWidget {
  const _Frame({required this.url, required this.onBlocked});
  final String url;
  final void Function(String url) onBlocked;
  @override
  State<_Frame> createState() => _FrameState();
}

class _FrameState extends State<_Frame> {
  StreamSubscription<web.Event>? _loads;
  bool _loaded = false;
  @override
  void dispose() {
    _loads?.cancel();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => HtmlElementView.fromTagName(
    tagName: 'iframe',
    onElementCreated: (element) {
      final frame = element as web.HTMLIFrameElement;
      frame.sandbox.add('allow-scripts');
      frame.referrerPolicy = 'no-referrer';
      frame.style.border = '0';
      frame.style.width = '100%';
      frame.style.height = '100%';
      _loads = frame.onLoad.listen((_) {
        if (_loaded) {
          frame.remove();
          widget.onBlocked(widget.url);
        } else {
          _loaded = true;
        }
      });
      frame.src = widget.url;
    },
  );
}
