import 'dart:async';
import 'dart:convert';

import 'package:agent_company/data/backend.dart';
import 'package:agent_company/data/fake_backend.dart';
import 'package:agent_company/data/hq_backend.dart';
import 'package:agent_company/data/store.dart';
import 'package:agent_company/data/upload_files.dart';
import 'package:agent_company/data/uploads.dart';
import 'package:agent_company/model/models.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:flutter/foundation.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:shared_preferences/shared_preferences.dart';

class RangeOnlyFiles extends MemoryUploadFiles {
  @override
  Future<Uint8List?> read(String key) async => throw StateError('a large upload must use bounded range reads');
}

class GatedMediaBackend extends FakeBackend {
  GatedMediaBackend() : super(simulate: false);
  final gate = Completer<void>();
  final sent = <({String to, String text, String id, List<String?> files})>[];
  @override
  Future<Attachment?> uploadAttachment(Attachment a, {Future<void> Function()? changed}) async {
    await gate.future;
    return a.uploaded('uploaded-${a.name}');
  }

  @override
  Future<CommandResult> send(String identityId, UserMsg msg) async {
    sent.add((to: identityId, text: msg.text, id: msg.id, files: msg.attachments.map((a) => a.id).toList()));
    msg.delivery = Delivery.delivered;
    return const CommandResult.ok();
  }
}

class UnloadedChatsBackend extends GatedMediaBackend {
  @override
  Future<void> start() async {
    await super.start();
    data!.chats.clear();
    notifyListeners();
  }
}

class PartialBackend extends GatedMediaBackend {
  PartialBackend() {
    gate.complete();
  }
  @override
  Future<Attachment?> uploadAttachment(Attachment a, {Future<void> Function()? changed}) async => a.name == 'bad.xyz' ? null : super.uploadAttachment(a, changed: changed);
}

Attachment file([String name = 'document.xyz']) => Attachment(name: name, bytes: 4, mime: 'application/octet-stream', data: Uint8List.fromList([1, 2, 3, 4]));

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  setUp(() => SharedPreferences.setMockInitialValues({}));
  test('large file persists its session, resumes accepted parts after restart, then sends once', () async {
    final prefs = await SharedPreferences.getInstance(), disk = RangeOnlyFiles();
    final bytes = Uint8List(4 * 8 * 1024 * 1024 + 17);
    for (var i = 0; i < bytes.length; i++) {
      bytes[i] = i % 251;
    }
    final parts = <int, List<int>>{};
    var fail = true, opens = 0, tells = 0;
    final backend = HqBackend(
      baseUrl: 'http://hq',
      token: 'device',
      client: MockClient((req) async {
        Object body = {};
        if (req.url.path == '/api/uploads') {
          opens++;
          body = {
            'upload': {'id': 'up-session', 'parts': [], 'part_bytes': 8 * 1024 * 1024},
          };
        } else if (req.url.path.endsWith('/status')) {
          body = {
            'upload': {'id': 'up-session', 'parts': parts.keys.toList(), 'part_bytes': 8 * 1024 * 1024},
          };
        } else if (req.url.path.contains('/parts/')) {
          final n = int.parse(req.url.pathSegments.last);
          if (n == 3 && fail) return http.Response('{}', 503);
          parts[n] = req.bodyBytes;
        } else if (req.url.path.endsWith('/complete')) {
          body = {
            'upload': {'id': 'u-complete', 'name': 'large.xyz', 'mime': 'application/octet-stream', 'bytes': bytes.length},
          };
        } else if (req.url.path == '/api/messages/tell') {
          tells++;
        }
        return http.Response(jsonEncode(body), 200);
      }),
    );
    final queue = MediaUploads(backend, files: disk);
    await queue.load(prefs);
    final a = await queue.keep(Attachment(name: 'large.xyz', bytes: bytes.length, mime: 'application/octet-stream', data: bytes));
    expect(a.data, isNull, reason: 'large originals live on disk, outside the draft widget');
    expect(await queue.run(a), isNull);
    expect(parts.keys, [0, 1, 2]);
    expect(tells, 0);
    final key = a.transfer!.key;
    queue.dispose();
    final restored = MediaUploads(backend, files: disk);
    await restored.load(prefs);
    fail = false;
    final done = await restored.run(restored.items[key]!);
    expect(done!.id, 'u-complete');
    expect(opens, 1, reason: 'the persisted session is reused');
    expect(parts.length, 5);
    for (final n in parts.keys) {
      expect(listEquals(parts[n], Uint8List.sublistView(bytes, n * 8 * 1024 * 1024, ((n + 1) * 8 * 1024 * 1024).clamp(0, bytes.length))), isTrue);
    }
    final message = UserMsg(id: 'once', ts: DateTime.now(), text: 'source', attachments: [done]);
    expect((await backend.send('dana', message)).ok, isTrue);
    expect(tells, 1);
    restored.dispose();
    backend.dispose();
  });

  test('send captures recipient and text; unsubmitted completion never sends; a new draft is kept', () async {
    final backend = GatedMediaBackend(), disk = MemoryUploadFiles();
    final store = AppStore(backend, uploadFiles: disk);
    await store.start();
    await store.addImage('dana', file());
    expect(backend.sent, isEmpty);
    final sending = store.send('dana', 'original', Priority.now, attachments: [...store.images('dana')]);
    store.setDraft('yoav', 'different chat');
    store.setDraft('dana', 'new draft');
    await Future<void>.delayed(Duration.zero);
    backend.gate.complete();
    await sending;
    expect(backend.sent.single.to, 'dana');
    expect(backend.sent.single.text, 'original');
    expect(store.data!.chats['dana']!.draft, 'new draft');
    expect(store.data!.chats['yoav']!.draft, 'different chat');
    await store.flushOutbox();
    expect(backend.sent.length, 1);
    store.dispose();
    backend.dispose();
  });

  test('cancel while an upload is running prevents delivery after completion', () async {
    final store = AppStore(GatedMediaBackend(), uploadFiles: MemoryUploadFiles());
    final actual = store.backend as GatedMediaBackend;
    await store.start();
    await store.addImage('dana', file());
    final sending = store.send('dana', 'cancel this', Priority.now, attachments: [...store.images('dana')]);
    await Future<void>.delayed(Duration.zero);
    final message = store.data!.chats['dana']!.items.whereType<UserMsg>().last;
    store.setDraft('dana', 'new draft');
    expect(await store.retract('dana', message), 'new draft\ncancel this');
    expect(store.data!.chats['dana']!.draft, 'new draft\ncancel this');
    actual.gate.complete();
    await sending;
    await store.flushOutbox();
    expect(actual.sent, isEmpty);
    store.dispose();
    actual.dispose();
  });

  test('closing the app preserves not-yet-uploaded files, recipient, text and quote', () async {
    final prefs = await SharedPreferences.getInstance(), disk = MemoryUploadFiles();
    final store = AppStore(GatedMediaBackend(), prefs: prefs, uploadFiles: disk);
    final actual = store.backend as GatedMediaBackend;
    await store.start();
    await store.addImage('dana', file());
    final sending = store.send(
      'dana',
      'kept',
      Priority.next,
      quote: const Quote(author: 'worker', text: 'source', itemId: 'source-id'),
      attachments: [...store.images('dana')],
    );
    await Future<void>.delayed(Duration.zero);
    expect((jsonDecode(prefs.getString('outbox')!) as List).single['to'], 'dana');
    store.dispose();
    final next = UnloadedChatsBackend();
    next.gate.complete();
    final again = AppStore(next, prefs: prefs, uploadFiles: disk);
    await again.start();
    await again.flushOutbox();
    await Future<void>.delayed(Duration.zero);
    expect(next.sent.single.to, 'dana');
    expect(next.sent.single.text, 'kept');
    final restored = again.data!.chats['dana']!.items.whereType<UserMsg>().last;
    expect(restored.replyTo!.itemId, 'source-id');
    expect(restored.attachments.single.id, isNotNull);
    // The process that closed cannot deliver a second copy.
    actual.gate.complete();
    await sending;
    again.dispose();
    next.dispose();
    actual.dispose();
  });
  test('twenty files, a rejected oversize file and a partial failure preserve valid files and text', () async {
    final store = AppStore(GatedMediaBackend(), uploadFiles: MemoryUploadFiles());
    final actual = store.backend as GatedMediaBackend;
    await store.start();
    store.setDraft('dana', 'kept text');
    await store.addImage('dana', Attachment(name: 'oversize.zip', bytes: 200 * 1024 * 1024 + 1, mime: 'application/zip', data: Uint8List(1)));
    expect(store.images('dana'), isEmpty);
    for (var i = 0; i < 21; i++) {
      await store.addImage('dana', file('$i.xyz'));
    }
    expect(store.images('dana').length, 20);
    expect(store.data!.chats['dana']!.draft, 'kept text');
    expect(actual.sent, isEmpty);
    actual.gate.complete();
    await Future<void>.delayed(Duration.zero);
    store.dispose();
    actual.dispose();
  });

  test('a failed file blocks the whole message until an explicit omission, preserving all other content', () async {
    final store = AppStore(PartialBackend(), uploadFiles: MemoryUploadFiles());
    final actual = store.backend as PartialBackend;
    await store.start();
    await store.addImage('dana', file('good.xyz'));
    await store.addImage('dana', file('bad.xyz'));
    final msg = await store.send('dana', 'original text', Priority.now, attachments: [...store.images('dana')]);
    expect(actual.sent, isEmpty);
    expect(msg.attachments.map((a) => a.name), ['good.xyz', 'bad.xyz']);
    final bad = msg.attachments.singleWhere((a) => a.name == 'bad.xyz');
    await store.omitFailedFile(msg, bad);
    expect(actual.sent.single.text, 'original text');
    expect(actual.sent.single.files, ['uploaded-good.xyz']);
    store.dispose();
    actual.dispose();
  });

  test('a picked file is copied to durable storage without loading it through the composer', () async {
    final backend = GatedMediaBackend(), disk = MemoryUploadFiles();
    disk.sources['/picked/video.mp4'] = Uint8List.fromList([7, 8, 9]);
    final store = AppStore(backend, uploadFiles: disk);
    await store.start();
    await store.addImage(
      'dana',
      const Attachment(name: 'video.mp4', bytes: 3, mime: 'video/mp4'),
      sourcePath: '/picked/video.mp4',
    );
    final a = store.images('dana').single;
    expect(a.data, isNull);
    expect(await a.transfer!.readRange!(1, 3), [8, 9]);
    backend.gate.complete();
    await Future<void>.delayed(Duration.zero);
    store.dispose();
    backend.dispose();
  });
}
