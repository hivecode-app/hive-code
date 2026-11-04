import 'dart:async';
import 'dart:io';

import 'package:agent_company/ui/chat/chat_screen.dart';
import 'package:agent_company/ui/chat/composer.dart';
import 'package:agent_company/ui/media/actions.dart';
import 'package:agent_company/model/task_progress.dart';
import 'package:agent_company/ui/tasks/task_screen.dart';

import 'dart:convert';

import 'package:agent_company/data/fake_backend.dart';
import 'package:agent_company/model/models.dart';
import 'package:agent_company/native/native_bridge.dart';
import 'package:agent_company/ui/media/cards.dart';
import 'package:agent_company/ui/media/files_screen.dart';
import 'package:agent_company/ui/media/share_review.dart';
import 'package:agent_company/ui/media/upload_strip.dart';
import 'package:agent_company/ui/media/viewer.dart';
import 'package:agent_company/ui/chat/items.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';

import 'product_test.dart' show productApp;

final png = base64Decode('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAFklEQVR4nGO4E2Bj03OHIWpL1IcTNgArVgZpg9MzkAAAAABJRU5ErkJggg==');
List<Attachment> sampleFiles(String language) => [
  Attachment(
    name: language == 'he' ? 'חוזה שירות ארוך במיוחד עם כל הסעיפים והנספחים גרסה 3.pdf' : 'Service contract with all conditions and appendices version 3.pdf',
    mime: 'application/pdf',
    bytes: 2400000,
    meta: const {'pages': 12},
  ),
  const Attachment(name: 'Sites for the whole country.xlsx', mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', bytes: 184000, meta: {'sheets': 3}),
  const Attachment(name: 'Support logs.zip', mime: 'application/zip', bytes: 6100000, meta: {'files': 38}),
  Attachment(
    name: 'Voice recording.mp3',
    mime: 'audio/mpeg',
    bytes: 1300000,
    meta: {
      'duration': 84,
      'waveform': [.12, .24, .55, .78, .42, .2, .34, .6, .82, .56, .31, .18, .4, .7, .9, .65, .38, .16, .22, .49, .73, .94, .61, .3],
    },
  ),
  const Attachment(name: 'Map crash Android 15.mp4', mime: 'video/mp4', bytes: 5200000, meta: {'duration': 42}),
  const Attachment(name: 'Proposal version 2.docx', mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', bytes: 91000, meta: {'pages': 4}),
  const Attachment(name: 'Unknown format.xyz', mime: 'application/octet-stream', bytes: 1200),
];

class ProgressMedia extends FakeBackend {
  ProgressMedia() : super(simulate: false);
  final done = Completer<Attachment?>(), ready = Completer<void>();
  late Attachment file;
  Future<void> Function()? changed;
  @override
  Future<Attachment?> uploadAttachment(Attachment a, {Future<void> Function()? changed}) async {
    file = a;
    this.changed = changed;
    ready.complete();
    return done.future;
  }

  Future<void> advance(double value) async {
    file.transfer!.progress = value;
    await changed?.call();
  }
}

class FilesBackend extends FakeBackend {
  FilesBackend() : super(simulate: false);
  final thumbnail = File('test/fixtures/media/landscape-2.png').readAsBytesSync();
  final calls = <({String? chat, int? task, String? kind})>[];
  @override
  Future<TaskProgress?> taskDetail(int id) async => TaskProgress(id: id, title: 'Media task', project: 'lumo', stage: TaskStage.development);
  @override
  Future<TaskActivity> taskActivity(int id) async => TaskActivity(
    files: [
      {...sampleFiles('en').first.toJson(), 'id': 'document', 'identity': 'dana', 'message': 'source'},
    ],
  );
  @override
  Future<Uint8List?> attachmentThumb(String id) async => id == 'fixture-video' ? thumbnail : null;
  bool fail = false;
  @override
  Future<List<Map<String, dynamic>>> files({String? chat, int? task, String? kind}) async {
    calls.add((chat: chat, task: task, kind: kind));
    if (fail) throw StateError('connection');
    return kind == 'audio'
        ? []
        : [
            for (final a in sampleFiles('en'))
              {...a.toJson(), if (a.mime.startsWith('video/')) 'id': 'fixture-video', 'sender': 'dana', 'created_at': DateTime(2026, 10, 20, 9, 14).millisecondsSinceEpoch},
          ];
  }
}

class HistoryMedia extends FakeBackend {
  HistoryMedia() : super(simulate: false);
  final history = Completer<List<Map<String, dynamic>>>();
  @override
  Future<List<Map<String, dynamic>>> files({String? chat, int? task, String? kind}) {
    expect(chat, 'dana');
    expect(kind, 'images');
    return history.future;
  }

  @override
  Future<Uint8List?> attachmentData(String id) async => png;
  @override
  Future<Uint8List?> attachmentThumb(String id) async => png;
}

void main() {
  for (final lang in ['en', 'he']) {
    for (final dark in [false, true]) {
      for (final scale in [1.0, 1.3, 2.0]) {
        testWidgets('media cards and upload strip $lang dark=$dark scale=$scale', (tester) async {
          final waiting = UploadTransfer('waiting')
            ..progress = .4
            ..running = true;
          final failed = UploadTransfer('failed')..failed = true;
          await productApp(
            tester,
            language: lang,
            dark: dark,
            scale: scale,
            size: const Size(390, 1250),
            home: Scaffold(
              body: SingleChildScrollView(
                padding: const EdgeInsets.all(16),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    UploadStrip(
                      files: [
                        const Attachment(name: 'Ready.txt', bytes: 44, mime: 'text/plain', id: 'u-ready'),
                        Attachment(name: 'Uploading.mp4', bytes: 100, mime: 'video/mp4', transfer: waiting),
                        Attachment(name: 'Failed.pdf', bytes: 100, mime: 'application/pdf', transfer: failed),
                      ],
                      onRemove: (_) {},
                    ),
                    const SizedBox(height: 16),
                    for (final a in sampleFiles(lang))
                      Padding(
                        padding: const EdgeInsets.only(bottom: 10),
                        child: FileCard(attachment: a),
                      ),
                  ],
                ),
              ),
            ),
          );
          expect(tester.takeException(), isNull);
          await expectLater(find.byType(MaterialApp), matchesGoldenFile('goldens/media/cards-$lang-${dark ? 'dark' : 'light'}-${(scale * 100).round()}.png'));
        });
      }
    }
  }

  for (final lang in ['en', 'he']) {
    for (final dark in [false, true]) {
      for (final scale in [1.0, 2.0]) {
        testWidgets('upload strip $lang dark=$dark scale=$scale', (tester) async {
          final bytes = File('test/fixtures/media/landscape-1.png').readAsBytesSync();
          final files = [
            Attachment(name: 'Morning walk.png', bytes: bytes.length, mime: 'image/png', data: bytes, id: 'ready', meta: const {'app_original': false}),
            Attachment(name: 'Walk by the lake.mp4', bytes: 200, mime: 'video/mp4', transfer: UploadTransfer('video')..progress = .4),
            Attachment(name: 'Service contract.pdf', bytes: 200, mime: 'application/pdf', transfer: UploadTransfer('pdf')..failed = true),
          ];
          await productApp(
            tester,
            language: lang,
            dark: dark,
            scale: scale,
            home: Scaffold(
              body: Align(
                alignment: Alignment.topCenter,
                child: Padding(
                  padding: const EdgeInsets.all(16),
                  child: UploadStrip(files: files, onRemove: (_) {}),
                ),
              ),
            ),
          );
          await tester.runAsync(() => precacheImage(MemoryImage(bytes), tester.element(find.byType(UploadStrip))));
          await tester.pumpAndSettle();
          await expectLater(find.byType(MaterialApp), matchesGoldenFile('goldens/media/uploads-$lang-${dark ? 'dark' : 'light'}-${(scale * 100).round()}.png'));
        });
      }
      for (final scale in [1.0, 2.0]) {
        testWidgets('photo upload tile $lang dark=$dark scale=$scale', (tester) async {
          final bytes = File('test/fixtures/media/landscape-1.png').readAsBytesSync();
          final files = [
            Attachment(name: 'Photo.png', bytes: bytes.length, mime: 'image/png', data: bytes, transfer: UploadTransfer('photo')..progress = .4),
            Attachment(name: 'Second.png', bytes: bytes.length, mime: 'image/png', data: bytes, transfer: UploadTransfer('second')..failed = true),
          ];
          await productApp(
            tester,
            language: lang,
            dark: dark,
            scale: scale,
            home: Scaffold(
              body: Padding(
                padding: const EdgeInsets.all(16),
                child: BubbleImages(images: files, onCancel: () {}, onRetry: () {}),
              ),
            ),
          );
          await tester.runAsync(() => precacheImage(MemoryImage(bytes), tester.element(find.byType(BubbleImages))));
          await tester.pumpAndSettle();
          await expectLater(find.byType(MaterialApp), matchesGoldenFile('goldens/media/photo-upload-$lang-${dark ? 'dark' : 'light'}${scale == 1 ? '' : '-200'}.png'));
        });
      }
      testWidgets('files phone $lang dark=$dark', (tester) async {
        final backend = FilesBackend();
        await productApp(tester, language: lang, dark: dark, backend: backend, home: const FilesScreen(task: 77));
        await tester.runAsync(() => precacheImage(MemoryImage(backend.thumbnail), tester.element(find.byType(FilesScreen))));
        await tester.pumpAndSettle();
        await expectLater(find.byType(MaterialApp), matchesGoldenFile('goldens/media/files-$lang-${dark ? 'dark' : 'light'}.png'));
      });
      testWidgets('files desktop $lang dark=$dark', (tester) async {
        final backend = FilesBackend();
        await productApp(tester, language: lang, dark: dark, size: const Size(1280, 900), backend: backend, home: const FilesScreen(task: 77));
        await tester.runAsync(() => precacheImage(MemoryImage(backend.thumbnail), tester.element(find.byType(FilesScreen))));
        await tester.pumpAndSettle();
        await expectLater(find.byType(MaterialApp), matchesGoldenFile('goldens/media/files-desktop-$lang-${dark ? 'dark' : 'light'}.png'));
      });
      testWidgets('gallery $lang dark=$dark', (tester) async {
        final images = [
          for (var i = 1; i <= 3; i++) Attachment(name: 'Landscape $i.png', mime: 'image/png', data: File('test/fixtures/media/landscape-$i.png').readAsBytesSync(), bytes: 12000),
        ];
        await productApp(
          tester,
          language: lang,
          dark: dark,
          home: ImageViewer(
            images: images,
            sources: [
              for (var i = 0; i < 3; i++)
                (chat: 'dana', message: 'gallery-$i', caption: lang == 'he' ? 'טיול הבוקר ליד האגם' : 'Morning walk by the lake', at: DateTime(2026, 10, 20, 9, 14), mine: false),
            ],
          ),
        );
        for (final image in images) {
          await tester.runAsync(() => precacheImage(MemoryImage(image.data!), tester.element(find.byType(ImageViewer))));
        }
        await tester.pumpAndSettle();
        await expectLater(find.byType(MaterialApp), matchesGoldenFile('goldens/media/gallery-$lang-${dark ? 'dark' : 'light'}.png'));
      });
    }
  }
  testWidgets('RTL gallery arrow keys follow their on-screen direction', (tester) async {
    final images = [for (var i = 0; i < 2; i++) Attachment(name: 'Image $i.png', bytes: png.length, mime: 'image/png', data: png)];
    await productApp(
      tester,
      language: 'he',
      home: ImageViewer(images: images),
    );
    await tester.sendKeyEvent(LogicalKeyboardKey.arrowLeft);
    await tester.pumpAndSettle();
    expect(find.text('2 מתוך 2'), findsOneWidget);
    await tester.sendKeyEvent(LogicalKeyboardKey.arrowRight);
    await tester.pumpAndSettle();
    expect(find.text('1 מתוך 2'), findsOneWidget);
  });
  testWidgets('a cached photo tile receives live upload progress', (tester) async {
    final backend = ProgressMedia(), transfer = UploadTransfer('progress')..progress = .4;
    final file = Attachment(name: 'Live photo.png', bytes: png.length, mime: 'image/png', data: png, transfer: transfer);
    final store = await productApp(
      tester,
      backend: backend,
      home: Scaffold(
        body: BubbleImages(images: [file], onCancel: () {}),
      ),
    );
    final pending = store.uploads.run(file);
    await backend.ready.future;
    expect(find.text('40%'), findsOneWidget);
    await backend.advance(.75);
    await tester.pump();
    expect(find.text('75%'), findsOneWidget);
    expect(find.text('40%'), findsNothing);
    backend.done.complete(file.uploaded('ready-photo'));
    await pending;
    await tester.pumpAndSettle();
  });
  testWidgets('photo upload progress and cancellation are visible without a delivery-state flag', (tester) async {
    var cancelled = 0;
    final a = Attachment(name: 'Photo.png', bytes: png.length, mime: 'image/png', data: png, transfer: UploadTransfer('photo')..progress = .4);
    await productApp(
      tester,
      home: Scaffold(
        body: BubbleImages(images: [a], onCancel: () => cancelled++),
      ),
    );
    expect(find.text('40%'), findsOneWidget);
    expect(find.byType(CircularProgressIndicator), findsOneWidget);
    await tester.tap(find.byTooltip('Cancel message and keep draft'));
    expect(cancelled, 1);
  });
  test('long human file titles retain complete words around the middle ellipsis', () {
    expect(shortFileName('Service contract with all conditions and appendices version 3.pdf'), 'Service contract with all… version 3');
    expect(shortFileName('חוזה שירות ארוך במיוחד עם כל הסעיפים והנספחים גרסה 3.pdf'), 'חוזה שירות ארוך במיוחד עם… והנספחים גרסה 3');
  });
  testWidgets('large-text upload strip keeps retry and remove reachable by scrolling', (tester) async {
    final files = [for (var i = 0; i < 8; i++) Attachment(name: 'File $i.pdf', bytes: 4, mime: 'application/pdf', transfer: UploadTransfer('f$i')..failed = true)];
    await productApp(
      tester,
      scale: 2,
      home: Scaffold(
        body: UploadStrip(files: files, onRemove: (_) {}),
      ),
    );
    final retry = find.byTooltip('Try again');
    await tester.drag(find.byType(SingleChildScrollView), const Offset(0, -2000));
    await tester.pumpAndSettle();
    expect(retry.hitTestable(), findsWidgets);
    expect(find.byTooltip('Remove File 7.pdf').hitTestable(), findsOneWidget);
  });
  testWidgets('reply from files works before its source message is loaded and preserves the draft', (tester) async {
    final file = Attachment.fromJson({'id': 'u-old', 'name': 'Earlier.pdf', 'mime': 'application/pdf', 'bytes': 8, 'chat': 'dana', 'message': 'old-source'});
    final store = await productApp(
      tester,
      prepare: (s) => s.setDraft('dana', 'Existing draft'),
      home: Scaffold(
        body: Builder(
          builder: (context) => TextButton(onPressed: () => fileReply(context, file), child: const Text('Reply to file')),
        ),
      ),
    );
    expect(store.data!.chats['dana']!.items.any((m) => m.id == 'old-source'), isFalse);
    await tester.tap(find.text('Reply to file'));
    await tester.pumpAndSettle();
    expect(find.byType(ChatScreen), findsOneWidget);
    final composer = tester.widget<Composer>(find.byType(Composer));
    expect(composer.identityId, 'dana');
    expect(composer.quote?.itemId, 'old-source');
    expect(composer.quote?.text, contains('u-old'));
    expect(composer.controller.text, 'Existing draft');
  });

  testWidgets('task files preserve task scope and open documents in the viewer', (tester) async {
    final backend = FilesBackend();
    await productApp(tester, backend: backend, home: const ProductTaskScreen(id: 77));
    await tester.tap(find.byTooltip('Files'));
    await tester.pumpAndSettle();
    expect(find.byType(FilesScreen), findsOneWidget);
    expect(backend.calls.last.task, 77);
    await tester.pageBack();
    await tester.pumpAndSettle();
    final document = find.text(sampleFiles('en').first.name);
    await tester.scrollUntilVisible(document, 200);
    await tester.tap(document);
    await tester.pumpAndSettle();
    expect(find.byType(FileViewer), findsOneWidget);
  });

  testWidgets('a document from a worker is rendered in the conversation', (tester) async {
    await productApp(
      tester,
      home: Scaffold(
        body: TextBubble(
          msg: TextMsg(id: 'document', ts: DateTime(2026, 11, 4), text: 'Document attached', attachments: [sampleFiles('en').first]),
        ),
      ),
    );
    expect(find.byType(FileCard), findsOneWidget);
  });

  testWidgets('gallery continues across messages and zoomed drag does not close it; keyboard closes', (tester) async {
    final a = Attachment(name: 'first.png', bytes: png.length, mime: 'image/png', data: png, id: 'first');
    final b = Attachment(name: 'second.png', bytes: png.length, mime: 'image/png', data: png, id: 'second');
    final store = await productApp(
      tester,
      home: Scaffold(
        body: Center(child: BubbleImages(images: [a])),
      ),
      prepare: (s) {
        s.data!.chats['dana']!.items.addAll([
          TextMsg(id: 'one', ts: DateTime(2026, 11, 4), text: 'first caption', attachments: [a]),
          TextMsg(id: 'two', ts: DateTime(2026, 11, 4), text: 'second caption', attachments: [b]),
        ]);
      },
    );
    await tester.tap(find.byType(AttachmentImage).first);
    await tester.pumpAndSettle();
    expect(find.byType(ImageViewer), findsOneWidget);
    expect(find.text('1 of 2'), findsOneWidget);
    await tester.tap(find.byTooltip('Next'));
    await tester.pumpAndSettle();
    expect(find.text('second.png'), findsOneWidget);
    expect(find.text('second caption'), findsOneWidget);
    await tester.tap(find.byTooltip('Zoom in'));
    await tester.pumpAndSettle();
    await tester.fling(find.byType(InteractiveViewer).first, const Offset(0, 400), 1600);
    await tester.pumpAndSettle();
    expect(find.byType(ImageViewer), findsOneWidget);
    await tester.sendKeyEvent(LogicalKeyboardKey.escape);
    await tester.pumpAndSettle();
    expect(find.byType(ImageViewer), findsNothing);
    expect(store.data!.chats['dana']!.items.last.id, 'two');
  });

  testWidgets('gallery loads older conversation images without losing selection, zoom or return route', (tester) async {
    final backend = HistoryMedia();
    final image = Attachment(name: 'current.png', bytes: png.length, mime: 'image/png', data: png, id: 'current');
    await productApp(
      tester,
      backend: backend,
      home: Scaffold(body: BubbleImages(images: [image])),
      prepare: (s) {
        s.data!.chats['dana']!.items.add(TextMsg(id: 'current-message', ts: DateTime(2026, 11, 4), text: 'Current caption', attachments: [image]));
      },
    );
    await tester.tap(find.byType(AttachmentImage).first);
    await tester.pumpAndSettle();
    expect(find.text('1 of 1'), findsOneWidget);
    await tester.tap(find.byTooltip('Zoom in'));
    await tester.pumpAndSettle();
    expect(find.text('150%'), findsOneWidget);
    backend.history.complete([
      {...image.toJson(), 'message': 'current-message', 'caption': 'Current caption', 'created_at': DateTime(2026, 11, 4).millisecondsSinceEpoch, 'sender': 'dana'},
      {
        ...image.toJson(),
        'id': 'older',
        'name': 'older.png',
        'message': 'older-message',
        'caption': 'Older caption',
        'created_at': DateTime(2026, 11, 3).millisecondsSinceEpoch,
        'sender': 'owner',
      },
    ]);
    await tester.pumpAndSettle();
    expect(find.text('2 of 2'), findsOneWidget);
    expect(find.text('current.png'), findsOneWidget);
    expect(find.text('150%'), findsOneWidget);
    await tester.sendKeyEvent(LogicalKeyboardKey.arrowLeft);
    await tester.pumpAndSettle();
    expect(find.text('older.png'), findsOneWidget);
    expect(find.text('Older caption'), findsOneWidget);
    expect(find.text('100%'), findsOneWidget);
    await tester.tap(find.text('In chat'));
    await tester.pumpAndSettle();
    expect(find.byType(ChatScreen), findsOneWidget);
    await tester.pageBack();
    await tester.pumpAndSettle();
    expect(find.byType(ImageViewer), findsOneWidget);
    expect(find.text('1 of 2'), findsOneWidget);
    expect(find.text('Older caption'), findsOneWidget);
  });

  testWidgets('files filters keep the task; empty filter differs from failure', (tester) async {
    final backend = FilesBackend();
    await productApp(tester, backend: backend, home: const FilesScreen(task: 77));
    await tester.ensureVisible(find.text('Audio'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Audio'));
    await tester.pumpAndSettle();
    expect(find.text('No files match this filter.'), findsOneWidget);
    await tester.tap(find.text('Clear filter'));
    await tester.pumpAndSettle();
    expect(backend.calls.last.task, 77);
    expect(backend.calls.last.kind, isNull);
    backend.fail = true;
    await tester.tap(find.text('Documents'));
    await tester.pumpAndSettle();
    expect(find.text('Files could not load. Try again.'), findsOneWidget);
  });

  testWidgets('share review changes recipient without editing either draft; cancel leaves both', (tester) async {
    final store = await productApp(
      tester,
      home: const Scaffold(body: SizedBox()),
      prepare: (s) {
        s.setDraft('dana', 'existing draft');
      },
    );
    final ctx = tester.element(find.byType(Scaffold));
    showModalBottomSheet<String>(
      context: ctx,
      builder: (_) => ShareReview(
        store: store,
        payload: const SharedPayload(
          identityId: 'dana',
          text: 'shared text',
          files: [SharedFile(path: '/cache/a.pdf', name: 'a.pdf', mime: 'application/pdf', bytes: 100)],
        ),
      ),
    );
    await tester.pumpAndSettle();
    expect(find.textContaining('existing draft'), findsOneWidget);
    expect(find.text('a.pdf'), findsOneWidget);
    await tester.tap(find.text('Cancel'));
    await tester.pumpAndSettle();
    expect(store.data!.chats['dana']!.draft, 'existing draft');
    expect(store.images('dana'), isEmpty);
  });

  testWidgets('a very long viewer title at 200 percent leaves the close and original actions on screen', (tester) async {
    final name = '${List.filled(16, 'Long segment').join(' ')}.xyz';
    await productApp(
      tester,
      scale: 2,
      home: FileViewer(
        attachment: Attachment(name: name, mime: 'application/octet-stream', bytes: 4),
      ),
    );
    expect(tester.getRect(find.byType(AppBar)).height, lessThan(240));
    expect(find.byTooltip('Close').hitTestable(), findsOneWidget);
    expect(find.byTooltip('Save original').hitTestable(), findsOneWidget);
    expect(tester.takeException(), isNull);
  });
  testWidgets('failed document preview retains title, close and original actions', (tester) async {
    await productApp(
      tester,
      home: const FileViewer(
        attachment: Attachment(name: 'Broken.docx', id: 'bad', bytes: 20, mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'),
      ),
    );
    expect(find.text('Broken.docx'), findsOneWidget);
    expect(find.text('Preview unavailable. You can save the original.'), findsOneWidget);
    expect(find.byTooltip('Save original'), findsOneWidget);
    expect(find.byTooltip('Share original'), findsOneWidget);
  });
}
