import 'native_bridge.dart';

Future<bool> openExternalUrl(String url) => NativeBridge.instance.openUrl(url);
