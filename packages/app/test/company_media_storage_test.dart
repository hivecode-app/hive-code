import 'dart:convert';
import 'dart:typed_data';

import 'package:agent_company/data/auth_client.dart';
import 'package:agent_company/data/backend_select.dart';
import 'package:agent_company/data/store.dart';
import 'package:agent_company/data/upload_files.dart';
import 'package:agent_company/model/models.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'media_uploads_test.dart' show GatedMediaBackend;

class ScopedMedia extends GatedMediaBackend {
  ScopedMedia(this.storageScope);
  @override
  final String storageScope;
  int uploadsStarted = 0;
  @override
  Future<Attachment?> uploadAttachment(Attachment a, {Future<void> Function()? changed}) async {
    uploadsStarted++;
    return super.uploadAttachment(a, changed: changed);
  }
}

Attachment media(String name) => Attachment(name: name, bytes: 4, mime: 'application/octet-stream', data: Uint8List.fromList([1, 2, 3, 4]));
Future<void> settle() async {
  for (var i = 0; i < 10; i++) {
    await Future<void>.delayed(Duration.zero);
  }
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  test('pending media and its binary stay with server A while B uses the same worker name', () async {
    const first = 'https://first.example/hq', second = 'https://second.example/hq';
    SharedPreferences.setMockInitialValues({kHqUrl: first, kHqToken: 'first'});
    final disk = MemoryUploadFiles(), original = ScopedMedia(first), other = ScopedMedia(second), restored = ScopedMedia(first);
    final a = AppStore(original, uploadFiles: disk), b = AppStore(other, uploadFiles: disk), again = AppStore(restored, uploadFiles: disk);
    Future<UserMsg>? delivery;
    bool firstClosed = false;
    try {
      await a.start();
      await a.addImage('dana', media('Private source.bin'));
      delivery = a.send('dana', 'Only the first company', Priority.next, attachments: [...a.images('dana')]);
      await settle();
      final sources = disk.files.keys.toSet();
      expect(sources, isNotEmpty);
      a.dispose();
      original.dispose();
      firstClosed = true;
      await saveSession(const Session(second, 'second'));
      await b.start();
      await settle();
      expect(b.images('dana'), isEmpty);
      expect(other.uploadsStarted, 0);
      expect(other.sent, isEmpty);
      await b.addImage('dana', media('Second company.bin'));
      await b.uploads.prune({b.images('dana').single.transfer!.key});
      expect(disk.files.keys.toSet().containsAll(sources), isTrue);
      await again.start();
      await settle();
      restored.gate.complete();
      await settle();
      expect(restored.sent.single.to, 'dana');
      expect(restored.sent.single.text, 'Only the first company');
      expect(restored.sent.single.files, ['uploaded-Private source.bin']);
      expect(other.sent, isEmpty);
    } finally {
      if (!original.gate.isCompleted) original.gate.complete();
      if (!other.gate.isCompleted) other.gate.complete();
      if (!restored.gate.isCompleted) restored.gate.complete();
      await delivery;
      if (!firstClosed) a.dispose();
      b.dispose();
      again.dispose();
      if (!firstClosed) original.dispose();
      other.dispose();
      restored.dispose();
    }
  });
  test('legacy media is assigned to the saved server before switching and its source migrates', () async {
    const first = 'https://first.example/hq', second = 'https://second.example/hq';
    final record = {'name': 'Legacy.bin', 'mime': 'application/octet-stream', 'bytes': 4, 'id': null, 'local': 'legacy-source'};
    SharedPreferences.setMockInitialValues({
      kHqUrl: first,
      kHqToken: 'first',
      'media-uploads': jsonEncode([record]),
      'media-draft:dana': jsonEncode([record]),
    });
    final disk = MemoryUploadFiles();
    await disk.write('legacy-source', Uint8List.fromList([9, 8, 7, 6]));
    await saveSession(const Session(second, 'second'));
    final prefs = await SharedPreferences.getInstance();
    expect(prefs.getString('media-uploads'), isNull);
    expect(prefs.getString('company:$first:media-uploads'), isNotNull);
    final backend = ScopedMedia(first), store = AppStore(backend, uploadFiles: disk);
    try {
      await store.start();
      expect(await store.images('dana').single.transfer!.read!(), [9, 8, 7, 6]);
      expect(disk.files.containsKey('legacy-source'), isFalse);
    } finally {
      backend.gate.complete();
      store.dispose();
      backend.dispose();
    }
  });
}
