import 'dart:convert';

import 'package:crypto/crypto.dart';

import 'dart:typed_data';

import 'upload_files_io.dart' if (dart.library.js_interop) 'upload_files_web.dart' as impl;

abstract class UploadFiles {
  factory UploadFiles.device() => impl.deviceFiles();
  Future<void> write(String key, Uint8List data);
  Future<Uint8List?> read(String key);
  Future<Uint8List?> readRange(String key, int start, int end);
  Future<void> copyFromPath(String key, String path);
  Future<void> delete(String key);
  Future<void> move(String from, String to);
  Future<void> releaseSource(String path);
}

/// The storage namespace is fixed for one backend, including asynchronous completions.
class ScopedUploadFiles implements UploadFiles {
  ScopedUploadFiles(this.delegate, String scope) : prefix = 'company-${sha256.convert(utf8.encode(scope))}-';
  final UploadFiles delegate;
  final String prefix;
  @override
  Future<void> releaseSource(String path) => delegate.releaseSource(path);
  Future<void> migrate(String key) => delegate.move(key, '$prefix$key');
  @override
  Future<void> write(String key, Uint8List data) => delegate.write('$prefix$key', data);
  @override
  Future<Uint8List?> read(String key) => delegate.read('$prefix$key');
  @override
  Future<Uint8List?> readRange(String key, int start, int end) => delegate.readRange('$prefix$key', start, end);
  @override
  Future<void> copyFromPath(String key, String path) => delegate.copyFromPath('$prefix$key', path);
  @override
  Future<void> delete(String key) => delegate.delete('$prefix$key');
  @override
  Future<void> move(String from, String to) => delegate.move('$prefix$from', '$prefix$to');
}

class MemoryUploadFiles implements UploadFiles {
  final files = <String, Uint8List>{};
  final sources = <String, Uint8List>{};
  final releasedSources = <String>[];
  @override
  Future<void> releaseSource(String path) async {
    releasedSources.add(path);
  }

  @override
  Future<void> write(String key, Uint8List data) async {
    files[key] = data;
  }

  @override
  Future<Uint8List?> read(String key) async => files[key];
  @override
  Future<Uint8List?> readRange(String key, int start, int end) async {
    final data = files[key];
    return data == null ? null : Uint8List.sublistView(data, start, end);
  }

  @override
  Future<void> copyFromPath(String key, String path) async {
    final data = sources[path];
    if (data == null) throw StateError('missing source');
    files[key] = data;
  }

  @override
  Future<void> move(String from, String to) async {
    final value = files.remove(from);
    if (value != null) files[to] = value;
  }

  @override
  Future<void> delete(String key) async {
    files.remove(key);
  }
}
