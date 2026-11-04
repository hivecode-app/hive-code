import 'package:flutter/material.dart';
import 'package:webview_flutter/webview_flutter.dart';
import 'package:webview_flutter_android/webview_flutter_android.dart';

import '../l10n/app_localizations.dart';

Widget artifactSurface(String url, void Function(String url) onBlocked) => _Surface(url: url, onBlocked: onBlocked);

class _Surface extends StatefulWidget {
  const _Surface({required this.url, required this.onBlocked});
  final String url;
  final void Function(String url) onBlocked;
  @override
  State<_Surface> createState() => _SurfaceState();
}

class _SurfaceState extends State<_Surface> {
  late final WebViewController _controller;
  bool _loading = true, _failed = false;
  @override
  void initState() {
    super.initState();
    _controller = WebViewController();
    _configure();
  }

  Future<void> _configure() async {
    final source = Uri.parse(widget.url), root = Uri.parse(widget.url).resolve('.').path;
    try {
      if (_controller.platform case final AndroidWebViewController android) {
        await android.setAllowFileAccess(false);
        await android.setAllowContentAccess(false);
        await android.setMixedContentMode(MixedContentMode.neverAllow);
      }
      await _controller.setJavaScriptMode(JavaScriptMode.unrestricted);
      await _controller.setNavigationDelegate(
        NavigationDelegate(
          onNavigationRequest: (request) {
            final destination = Uri.tryParse(request.url);
            if (destination != null && ['http', 'https'].contains(destination.scheme) && destination.origin == source.origin && destination.path.startsWith(root)) {
              return NavigationDecision.navigate;
            }
            widget.onBlocked(request.url);
            return NavigationDecision.prevent;
          },
          onPageStarted: (_) {
            if (mounted) setState(() => _loading = true);
          },
          onPageFinished: (_) {
            if (mounted) setState(() => _loading = false);
          },
          onWebResourceError: (error) {
            if (error.isForMainFrame == true && mounted) {
              setState(() {
                _failed = true;
                _loading = false;
              });
            }
          },
        ),
      );
      await _controller.loadRequest(source);
    } catch (_) {
      if (mounted) {
        setState(() {
          _failed = true;
          _loading = false;
        });
      }
    }
  }

  @override
  Widget build(BuildContext context) => Stack(
    children: [
      Positioned.fill(child: WebViewWidget(controller: _controller)),
      if (_loading) const Center(child: CircularProgressIndicator()),
      if (_failed)
        Positioned.fill(
          child: ColoredBox(
            color: Theme.of(context).scaffoldBackgroundColor,
            child: Center(
              child: Column(
                mainAxisSize: MainAxisSize.min,
                children: [
                  Text(AppLocalizations.of(context).mediaPreviewFailed),
                  TextButton(
                    onPressed: () {
                      setState(() {
                        _loading = true;
                        _failed = false;
                      });
                      _controller.loadRequest(Uri.parse(widget.url));
                    },
                    child: Text(AppLocalizations.of(context).retry),
                  ),
                ],
              ),
            ),
          ),
        ),
    ],
  );
}
