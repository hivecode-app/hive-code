import 'dart:js_interop';
import 'dart:typed_data';

import 'upload_files.dart';

@JS('companyMediaStorage')
external _Storage get _storage;

extension type _Storage(JSObject _) implements JSObject {
  external JSPromise<JSAny?> write(JSString key, JSUint8Array bytes);
  external JSPromise<JSUint8Array?> read(JSString key);
  external JSPromise<JSUint8Array?> readRange(JSString key, JSNumber start, JSNumber end);
  external JSPromise<JSAny?> copyFromUrl(JSString key, JSString url);
  external JSPromise<JSAny?> remove(JSString key);
  external void releaseSource(JSString path);
  external JSPromise<JSAny?> move(JSString from, JSString to);
}

UploadFiles deviceFiles() => _Files();

class _Files implements UploadFiles {
  @override
  Future<void> releaseSource(String path) async {
    _storage.releaseSource(path.toJS);
  }

  @override
  Future<void> write(String key, Uint8List data) async {
    await _storage.write(key.toJS, data.toJS).toDart;
  }

  @override
  Future<Uint8List?> read(String key) async => (await _storage.read(key.toJS).toDart)?.toDart;
  @override
  Future<Uint8List?> readRange(String key, int start, int end) async => (await _storage.readRange(key.toJS, start.toJS, end.toJS).toDart)?.toDart;
  @override
  Future<void> copyFromPath(String key, String path) async {
    await _storage.copyFromUrl(key.toJS, path.toJS).toDart;
  }

  @override
  Future<void> move(String from, String to) async {
    await _storage.move(from.toJS, to.toJS).toDart;
  }

  @override
  Future<void> delete(String key) async {
    await _storage.remove(key.toJS).toDart;
  }
}
