// Where a recording waits until it is transcribed (dictation.dart): files in the app's own storage
// on Android and desktop, so it survives the app closing; memory on the web, where minutes of PCM
// do not fit in localStorage.
import 'dart:typed_data';

import 'dictation_files_io.dart' if (dart.library.js_interop) 'dictation_files_web.dart' as impl;

abstract class DictationFiles {
  factory DictationFiles.device() => impl.deviceFiles();

  /// Every saved recording's metadata (JSON), by id.
  Future<Map<String, String>> list();

  /// Saves the metadata, and the audio with it when [pcm] is given (written first, so metadata
  /// never points at audio that is not there).
  Future<void> write(String id, String meta, {Uint8List? pcm});

  Future<Uint8List?> pcm(String id);

  Future<void> delete(String id);
}

class MemoryDictationFiles implements DictationFiles {
  final meta = <String, String>{};
  final audio = <String, Uint8List>{};

  @override
  Future<Map<String, String>> list() async => {...meta};

  @override
  Future<void> write(String id, String meta, {Uint8List? pcm}) async {
    if (pcm != null) audio[id] = pcm;
    this.meta[id] = meta;
  }

  @override
  Future<Uint8List?> pcm(String id) async => audio[id];

  @override
  Future<void> delete(String id) async {
    meta.remove(id);
    audio.remove(id);
  }
}
