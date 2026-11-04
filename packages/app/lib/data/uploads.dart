import 'dart:async';
import 'dart:convert';

import 'package:flutter/foundation.dart';
import 'package:shared_preferences/shared_preferences.dart';

import '../model/models.dart';
import 'backend.dart';
import 'upload_files.dart';

/// Owns local media independently of the composer route. Metadata never precedes its bytes.
class MediaUploads extends ChangeNotifier {
  MediaUploads(this.backend, {UploadFiles? files})
    : files = backend.storageScope == null ? (files ?? UploadFiles.device()) : ScopedUploadFiles(files ?? UploadFiles.device(), backend.storageScope!);
  final Backend backend;
  final UploadFiles files;
  final items = <String, Attachment>{};
  final _active = <String, Future<Attachment?>>{};
  SharedPreferences? _prefs;
  bool _disposed = false;
  int _next = 0;

  String get _storageKey => backend.storageScope == null ? 'media-uploads' : 'company:${backend.storageScope}:media-uploads';

  Future<void> load(SharedPreferences? prefs) async {
    _prefs = prefs;
    for (final raw in (jsonDecode(prefs?.getString(_storageKey) ?? '[]') as List)) {
      final m = (raw as Map).cast<String, dynamic>();
      final key = m['local'] as String;
      if (files case final ScopedUploadFiles scoped) {
        if (m['storage_scoped'] != true) await scoped.migrate(key);
      }
      final transfer = UploadTransfer(key, session: m['session'] as String?, id: m['id'] as String?);
      transfer.read = () => files.read(key);
      transfer.readRange = (start, end) => files.readRange(key, start, end);
      items[key] = Attachment.fromJson(m, transfer: transfer);
    }
    await _save();
  }

  Future<Attachment> keep(Attachment a, {String? sourcePath}) async {
    if (a.transfer != null || a.id != null) return a;
    if (a.data == null && sourcePath == null || a.bytes <= 0 || a.bytes > maxImageBytes) {
      throw ArgumentError('invalid media size');
    }
    final key = 'media-${DateTime.now().microsecondsSinceEpoch}-${_next++}';
    if (sourcePath != null) {
      await files.copyFromPath(key, sourcePath);
    } else {
      await files.write(key, a.data!);
    }
    final transfer = UploadTransfer(key);
    transfer.read = () => files.read(key);
    transfer.readRange = (start, end) => files.readRange(key, start, end);
    final kept = Attachment(name: a.name, bytes: a.bytes, mime: a.mime, data: a.bytes <= 1024 * 1024 ? a.data : null, meta: a.meta, transfer: transfer);
    items[key] = kept;
    await _save();
    return kept;
  }

  Future<void> _save() async {
    if (_disposed) return;
    await _prefs?.setString(
      _storageKey,
      jsonEncode([
        for (final a in items.values) {...a.toJson(), 'session': a.transfer?.session, if (files is ScopedUploadFiles) 'storage_scoped': true},
      ]),
    );
  }

  Future<Attachment?> run(Attachment a) {
    if (a.id != null) return Future.value(a);
    final t = a.transfer;
    if (t == null) return backend.uploadAttachment(a);
    return _active.putIfAbsent(
      t.key,
      () => _run(a).whenComplete(() {
        _active.remove(t.key);
        _changed();
      }),
    );
  }

  int _running = 0;
  final _waiting = <Completer<void>>[];
  Future<Attachment?> _run(Attachment a) async {
    if (_running >= 2) {
      final ready = Completer<void>();
      _waiting.add(ready);
      await ready.future;
    } else {
      _running++;
    }
    try {
      return await _transfer(a);
    } finally {
      if (_waiting.isNotEmpty) {
        _waiting.removeAt(0).complete();
      } else {
        _running--;
      }
    }
  }

  Future<Attachment?> _transfer(Attachment a) async {
    final t = a.transfer!;
    t.running = true;
    t.failed = false;
    _changed();
    try {
      final result = await backend.uploadAttachment(
        a,
        changed: () async {
          await _save();
          _changed();
        },
      );
      if (result == null) {
        t.failed = true;
        return null;
      }
      t.id = result.id;
      t.progress = 1;
      items[t.key] = Attachment(name: a.name, bytes: a.bytes, mime: result.mime, id: result.id, data: a.data, meta: {...a.meta, ...result.meta}, transfer: t);
      await _save();
      return items[t.key];
    } catch (e) {
      t.failed = true;
      t.retryable = e is UploadFailure ? e.transient : true;
      return null;
    } finally {
      t.running = false;
      _changed();
    }
  }

  Future<void> prune(Set<String> referenced) async {
    final unused = items.entries.where((e) => !referenced.contains(e.key) && !_active.containsKey(e.key)).map((e) => e.key).toList();
    for (final key in unused) {
      items.remove(key);
      await files.delete(key);
    }
    if (unused.isNotEmpty) await _save();
  }

  Attachment current(Attachment a) => items[a.transfer?.key] ?? a;
  Attachment restore(Map<String, dynamic> m) => items[m['local']] ?? Attachment.fromJson(m);
  void _changed() {
    if (!_disposed) notifyListeners();
  }

  @override
  void dispose() {
    _disposed = true;
    super.dispose();
  }
}
