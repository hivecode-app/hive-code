import 'dart:async';
import 'dart:typed_data';

import 'package:agent_company/data/backend.dart';
import 'package:agent_company/data/fake_backend.dart';
import 'package:agent_company/data/store.dart';
import 'package:agent_company/data/upload_files.dart';
import 'package:agent_company/model/models.dart';
import 'package:agent_company/ui/chat/chat_screen.dart';
import 'package:agent_company/ui/chat/composer.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'media_uploads_test.dart' show GatedMediaBackend, PartialBackend;
import 'product_test.dart' show productApp;

Attachment source([String name = 'source.bin']) => Attachment(name: name, mime: 'application/octet-stream', bytes: 4, data: Uint8List.fromList([1, 2, 3, 4]));

class SlowPost extends FakeBackend {
  SlowPost() : super(simulate: false);
  final post = Completer<CommandResult>();
  UserMsg? message;
  @override
  Future<CommandResult> send(String identityId, UserMsg msg) {
    message = msg;
    return post.future;
  }

  @override
  Future<CommandResult> freeAnswer(String askId, String text, {List<Attachment> attachments = const []}) => post.future;
}

class ManualAnswer extends GatedMediaBackend {
  final answers = <String>[];
  @override
  Future<CommandResult> freeAnswer(String askId, String text, {List<Attachment> attachments = const []}) async {
    answers.add(askId);
    return const CommandResult.ok();
  }
}

class RejectedAnswer extends PartialBackend {
  int retractCalls = 0;
  @override
  Future<CommandResult> freeAnswer(String askId, String text, {List<Attachment> attachments = const []}) async => const CommandResult.fail('Question already answered', gone: true);
  @override
  Future<CommandResult> retract(String identityId, String msgId) async {
    retractCalls++;
    return const CommandResult.fail('Unknown message', gone: true);
  }
}

Future<void> settleMedia() async {
  for (var i = 0; i < 12; i++) {
    await Future<void>.delayed(Duration.zero);
  }
}

class RetrySource extends MemoryUploadFiles {
  bool fail = true;
  @override
  Future<void> copyFromPath(String key, String path) async {
    if (fail) throw StateError('local write');
    await super.copyFromPath(key, path);
  }
}

void main() {
  test('an interrupted media answer is retained for manual retry without replaying the ask', () async {
    SharedPreferences.setMockInitialValues({});
    final prefs = await SharedPreferences.getInstance(), disk = MemoryUploadFiles();
    final one = ManualAnswer(), two = ManualAnswer(), first = AppStore(one, prefs: prefs, uploadFiles: disk), second = AppStore(two, prefs: prefs, uploadFiles: disk);
    Future<UserMsg>? delivery;
    var closed = false;
    try {
      await first.start();
      await first.addImage('dana', source());
      delivery = first.send(
        'dana',
        'The answer',
        Priority.next,
        quote: const Quote(author: 'Dana', text: 'Question', itemId: 'source-question', askId: 'q1'),
        attachments: [...first.images('dana')],
      );
      for (var i = 0; i < 10; i++) {
        await Future<void>.delayed(Duration.zero);
      }
      for (final file in [...first.images('dana')]) {
        first.removeImage('dana', file);
      }
      first.dispose();
      one.dispose();
      closed = true;
      expect(prefs.getString('outbox'), isNull);
      await second.start();
      for (var i = 0; i < 10; i++) {
        await Future<void>.delayed(Duration.zero);
      }
      final restored = second.data!.chats['dana']!.items.whereType<UserMsg>().singleWhere((m) => m.text == 'The answer');
      expect(restored.delivery, Delivery.failed);
      expect(restored.replyTo!.askId, 'q1');
      expect(restored.replyTo!.itemId, 'source-question');
      expect(two.answers, isEmpty);
      final retry = second.resend('dana', restored);
      two.gate.complete();
      await retry;
      expect(two.answers, ['q1']);
      expect(prefs.getKeys().where((k) => k.startsWith('media-answer:')), isEmpty);
    } finally {
      if (!one.gate.isCompleted) one.gate.complete();
      if (!two.gate.isCompleted) two.gate.complete();
      await delivery;
      if (!closed) {
        first.dispose();
        one.dispose();
      }
      second.dispose();
      two.dispose();
    }
  });
  test('omitting the last failed ask file deletes its recovery snapshot and source', () async {
    SharedPreferences.setMockInitialValues({});
    final prefs = await SharedPreferences.getInstance(), disk = MemoryUploadFiles();
    final backend = PartialBackend(), restoredBackend = PartialBackend();
    final store = AppStore(backend, prefs: prefs, uploadFiles: disk), restored = AppStore(restoredBackend, prefs: prefs, uploadFiles: disk);
    try {
      await store.start();
      await store.addImage('dana', source('bad.xyz'));
      final msg = await store.send(
        'dana',
        '',
        Priority.next,
        quote: const Quote(author: 'Dana', text: 'Question', askId: 'q1'),
        attachments: [...store.images('dana')],
      );
      for (final file in [...store.images('dana')]) {
        store.removeImage('dana', file);
      }
      expect(msg.delivery, Delivery.failed);
      expect(prefs.containsKey('media-answer:${msg.id}'), isTrue);
      await store.omitFailedFile(msg, msg.attachments.single);
      await settleMedia();
      expect(prefs.containsKey('media-answer:${msg.id}'), isFalse);
      expect(disk.files, isEmpty);
      await restored.start();
      expect(restored.data!.chats['dana']!.items.where((item) => item.id == msg.id), isEmpty);
      expect(restoredBackend.sent, isEmpty);
    } finally {
      store.dispose();
      restored.dispose();
      backend.dispose();
      restoredBackend.dispose();
    }
  });
  for (final restart in [false, true]) {
    test('retract a refused ask locally with uploaded files; restarted=$restart', () async {
      SharedPreferences.setMockInitialValues({});
      final prefs = await SharedPreferences.getInstance(), disk = MemoryUploadFiles();
      final backend = RejectedAnswer(), recoveredBackend = RejectedAnswer(), finalBackend = RejectedAnswer();
      final first = AppStore(backend, prefs: prefs, uploadFiles: disk),
          recovered = AppStore(recoveredBackend, prefs: prefs, uploadFiles: disk),
          finalStore = AppStore(finalBackend, prefs: prefs, uploadFiles: disk);
      try {
        await first.start();
        await first.addImage('dana', source());
        final original = await first.send(
          'dana',
          'My answer',
          Priority.next,
          quote: const Quote(author: 'Dana', text: 'Question', itemId: 'question-source', askId: 'q1'),
          attachments: [...first.images('dana')],
        );
        for (final file in [...first.images('dana')]) {
          first.removeImage('dana', file);
        }
        expect(original.delivery, Delivery.failed);
        expect(original.attachments.single.id, isNotNull);
        if (restart) {
          first.dispose();
          backend.dispose();
          await recovered.start();
        }
        final store = restart ? recovered : first;
        final msg = store.data!.chats['dana']!.items.whereType<UserMsg>().singleWhere((m) => m.id == original.id);
        store.setDraft('dana', 'New draft');
        expect(await store.retract('dana', msg), 'New draft\nMy answer');
        expect(backend.retractCalls + recoveredBackend.retractCalls, 0);
        expect(prefs.containsKey('media-answer:${msg.id}'), isFalse);
        expect(store.data!.chats['dana']!.items.where((item) => item.id == msg.id), isEmpty);
        expect(store.images('dana').single.id, isNotNull);
        expect(await store.images('dana').single.transfer!.read!(), [1, 2, 3, 4]);
        await finalStore.start();
        expect(finalStore.data!.chats['dana']!.items.where((item) => item.id == msg.id), isEmpty);
        expect(finalStore.data!.chats['dana']!.draft, 'New draft\nMy answer');
        expect(finalStore.images('dana').single.id, isNotNull);
        expect(finalBackend.sent, isEmpty);
        for (final file in [...finalStore.images('dana')]) {
          finalStore.removeImage('dana', file);
        }
        await settleMedia();
        expect(disk.files, isEmpty);
      } finally {
        if (!restart) {
          first.dispose();
          backend.dispose();
        }
        recovered.dispose();
        recoveredBackend.dispose();
        finalStore.dispose();
        finalBackend.dispose();
      }
    });
  }
  test('a failed durable copy keeps its original until retry or removal', () async {
    SharedPreferences.setMockInitialValues({});
    final disk = RetrySource()..sources['blob:original'] = Uint8List.fromList([1, 2, 3, 4]);
    final backend = GatedMediaBackend(), store = AppStore(backend, uploadFiles: disk);
    try {
      await store.start();
      expect(
        await store.addImage(
          'dana',
          Attachment(name: 'source.bin', mime: 'application/octet-stream', bytes: 4),
          sourcePath: 'blob:original',
        ),
        isFalse,
      );
      expect(store.retainsMediaSource('blob:original'), isTrue);
      expect(disk.releasedSources, isEmpty);
      disk.fail = false;
      await store.retryUpload('dana', store.images('dana').single);
      expect(store.retainsMediaSource('blob:original'), isFalse);
      expect(disk.releasedSources, ['blob:original']);
    } finally {
      backend.gate.complete();
      store.dispose();
      backend.dispose();
    }
  });
  testWidgets('another draft can be submitted while the earlier file is still uploading', (tester) async {
    final backend = GatedMediaBackend();
    final store = await productApp(
      tester,
      backend: backend,
      home: const ChatScreen(identityId: 'dana'),
      prepare: (s) => s.setDraft('dana', ''),
    );
    addTearDown(() {
      if (!backend.gate.isCompleted) backend.gate.complete();
    });
    await store.addImage('dana', source());
    await tester.pump();
    await tester.enterText(find.byType(TextField), 'First with a file');
    await tester.pump();
    await tester.tap(find.bySemanticsLabel('Send'));
    await tester.pump();
    await tester.pump();
    await tester.enterText(find.byType(TextField), 'Second draft');
    await tester.pump();
    await tester.tap(find.bySemanticsLabel('Send'));
    await tester.pump();
    await tester.pump();
    expect(store.data!.chats['dana']!.items.whereType<UserMsg>().map((m) => m.text), containsAll(['First with a file', 'Second draft']));
    expect(backend.sent, isEmpty);
    backend.gate.complete();
    await tester.pumpAndSettle();
  });
  testWidgets('omitting the only failed file never sends an empty wake-up', (tester) async {
    final backend = PartialBackend();
    final store = await productApp(
      tester,
      backend: backend,
      home: const ChatScreen(identityId: 'dana'),
      prepare: (s) => s.setDraft('dana', ''),
    );
    await store.addImage('dana', source('bad.xyz'));
    await tester.pumpAndSettle();
    await tester.tap(find.bySemanticsLabel('Send'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Send without this file'));
    await tester.pumpAndSettle();
    expect(backend.sent, isEmpty);
    expect(store.images('dana'), isEmpty);
  });
  testWidgets('a draft changed while confirming an omission is preserved with its new files', (tester) async {
    final backend = PartialBackend();
    final store = await productApp(
      tester,
      backend: backend,
      home: const ChatScreen(identityId: 'dana'),
      prepare: (s) => s.setDraft('dana', 'Original captured text'),
    );
    await store.addImage('dana', source('bad.xyz'));
    await tester.pumpAndSettle();
    await tester.tap(find.bySemanticsLabel('Send'));
    await tester.pumpAndSettle();
    final composer = tester.widget<Composer>(find.byType(Composer));
    composer.controller.text = 'New arriving draft';
    await store.addImage('dana', source('New.bin'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Send without this file'));
    await tester.pumpAndSettle();
    expect(backend.sent.single.text, 'Original captured text');
    expect(composer.controller.text, 'New arriving draft');
    expect(store.images('dana').single.name, 'New.bin');
  });
  test('an online text post remains queued while in flight; ask answers never enter the durable outbox', () async {
    SharedPreferences.setMockInitialValues({});
    final prefs = await SharedPreferences.getInstance();
    final plain = SlowPost(), answer = SlowPost();
    final first = AppStore(plain, prefs: prefs), second = AppStore(answer, prefs: prefs);
    try {
      await first.start();
      final pending = first.send('dana', 'Ordinary text', Priority.next);
      await Future<void>.delayed(Duration.zero);
      expect(plain.message!.delivery, Delivery.queued);
      plain.post.complete(const CommandResult.ok());
      await pending;
      await second.start();
      final pendingAnswer = second.send(
        'dana',
        'Answer',
        Priority.next,
        quote: const Quote(author: 'Dana', text: 'Question', askId: 'q1'),
      );
      await Future<void>.delayed(Duration.zero);
      expect(prefs.getString('outbox'), isNull);
      answer.post.complete(const CommandResult.ok());
      await pendingAnswer;
    } finally {
      if (!plain.post.isCompleted) plain.post.complete(const CommandResult.ok());
      if (!answer.post.isCompleted) answer.post.complete(const CommandResult.ok());
      first.dispose();
      second.dispose();
      plain.dispose();
      answer.dispose();
    }
  });
}
