import 'dart:io';
import 'dart:typed_data';

import 'package:path_provider/path_provider.dart';

import 'dictation_files.dart';

DictationFiles deviceFiles() => _DirFiles();

/// `<app support>/dictation/<id>.pcm` and `<id>.json`.
class _DirFiles implements DictationFiles {
  Future<Directory>? _dir;
  Future<Directory> get _root => _dir ??= () async {
        final d = Directory('${(await getApplicationSupportDirectory()).path}/dictation');
        await d.create(recursive: true);
        return d;
      }();

  Future<File> _file(String id, String ext) async => File('${(await _root).path}/$id.$ext');

  @override
  Future<Map<String, String>> list() async {
    final out = <String, String>{};
    await for (final f in (await _root).list()) {
      if (f is! File || !f.path.endsWith('.json')) continue;
      final name = f.uri.pathSegments.last;
      try {
        out[name.substring(0, name.length - 5)] = await f.readAsString();
      } catch (_) {
        // A half-written file from a crash: the next write replaces it.
      }
    }
    return out;
  }

  @override
  Future<void> write(String id, String meta, {Uint8List? pcm}) async {
    if (pcm != null) await (await _file(id, 'pcm')).writeAsBytes(pcm, flush: true);
    final tmp = await _file(id, 'json.tmp');
    await tmp.writeAsString(meta, flush: true);
    await tmp.rename((await _file(id, 'json')).path);
  }

  @override
  Future<Uint8List?> pcm(String id) async {
    final f = await _file(id, 'pcm');
    return await f.exists() ? f.readAsBytes() : null;
  }

  @override
  Future<void> delete(String id) async {
    for (final ext in ['json', 'pcm']) {
      try {
        await (await _file(id, ext)).delete();
      } catch (_) {}
    }
  }
}
