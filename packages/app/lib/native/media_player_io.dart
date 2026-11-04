import 'dart:io';
import 'dart:typed_data';

import 'package:path_provider/path_provider.dart';
import 'package:video_player/video_player.dart';

Future<({VideoPlayerController controller, Future<void> Function() release})> mediaPlayer(Uint8List bytes, String mime, String name) async {
  final dir = await Directory('${(await getTemporaryDirectory()).path}/player-').createTemp();
  final file = File('${dir.path}/media.${name.split('.').last.replaceAll(RegExp(r'[^a-zA-Z0-9]'), '')}');
  await file.writeAsBytes(bytes);
  return (
    controller: VideoPlayerController.file(file),
    release: () async {
      if (await dir.exists()) await dir.delete(recursive: true);
    },
  );
}

bool get supportsStreamingMedia => true;
Future<({VideoPlayerController controller, Future<void> Function() release})> streamingMediaPlayer(Uri url, Map<String, String> headers) async =>
    (controller: VideoPlayerController.networkUrl(url, httpHeaders: headers), release: () async {});
