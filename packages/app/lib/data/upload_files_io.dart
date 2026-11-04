import 'dart:io';
import 'dart:typed_data';

import 'package:path_provider/path_provider.dart';

import 'upload_files.dart';

UploadFiles deviceFiles() => _Files();

class _Files implements UploadFiles {
  Future<Directory>? _root;
  @override
  Future<void> releaseSource(String path) async {}
  Future<File> _file(String key) async {
    if (!RegExp(r'^[a-zA-Z0-9_-]+$').hasMatch(key)) {
      throw ArgumentError('invalid upload key');
    }
    final root = await (_root ??= () async {
      final dir = Directory('${(await getApplicationSupportDirectory()).path}/media');
      return dir.create(recursive: true);
    }());
    return File('${root.path}/$key');
  }

  @override
  Future<void> write(String key, Uint8List data) async {
    final f = await _file(key);
    final tmp = File('${f.path}.tmp');
    await tmp.writeAsBytes(data, flush: true);
    await tmp.rename(f.path);
  }

  @override
  Future<Uint8List?> read(String key) async {
    final f = await _file(key);
    return await f.exists() ? f.readAsBytes() : null;
  }

  @override
  Future<Uint8List?> readRange(String key, int start, int end) async {
    final f = await _file(key);
    if (!await f.exists()) return null;
    final handle = await f.open();
    try {
      await handle.setPosition(start);
      return await handle.read(end - start);
    } finally {
      await handle.close();
    }
  }

  @override
  Future<void> copyFromPath(String key, String path) async {
    final f = await _file(key), tmp = File('${(await _file(key)).path}.tmp');
    await File(path).copy(tmp.path);
    await tmp.rename(f.path);
  }

  @override
  Future<void> move(String from, String to) async {
    final source = await _file(from), target = await _file(to);
    if (await source.exists()) await source.rename(target.path);
  }

  @override
  Future<void> delete(String key) async {
    final f = await _file(key);
    if (await f.exists()) await f.delete();
  }
}
