import 'dart:js_interop';
import 'dart:typed_data';

import 'package:web/web.dart' as web;
import 'package:video_player/video_player.dart';

Future<({VideoPlayerController controller, Future<void> Function() release})> mediaPlayer(Uint8List bytes, String mime, String name) async {
  final url = web.URL.createObjectURL(web.Blob([bytes.toJS].toJS, web.BlobPropertyBag(type: mime)));
  return (controller: VideoPlayerController.networkUrl(Uri.parse(url)), release: () async => web.URL.revokeObjectURL(url));
}

// Browser media elements cannot add the device Authorization header; they use a local Blob.
bool get supportsStreamingMedia => false;
Future<({VideoPlayerController controller, Future<void> Function() release})> streamingMediaPlayer(Uri url, Map<String, String> headers) =>
    throw UnsupportedError('browser authorization requires blob media');
