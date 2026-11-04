import 'dart:typed_data';

import 'package:video_player/video_player.dart';

import 'media_player_io.dart' if (dart.library.js_interop) 'media_player_web.dart' as impl;

Future<({VideoPlayerController controller, Future<void> Function() release})> mediaPlayer(Uint8List bytes, String mime, String name) => impl.mediaPlayer(bytes, mime, name);

bool get supportsStreamingMedia => impl.supportsStreamingMedia;
Future<({VideoPlayerController controller, Future<void> Function() release})> streamingMediaPlayer(Uri url, Map<String, String> headers) => impl.streamingMediaPlayer(url, headers);
