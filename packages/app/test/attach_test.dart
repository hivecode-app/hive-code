// Attached and pasted images: the preview in the composer (removable), what a send carries, and how
// HqBackend uploads them before the message (POST /api/uploads, then tell with their ids).
import 'dart:convert';
import 'dart:typed_data';

import 'package:agent_company/data/hq_backend.dart';
import 'package:agent_company/model/models.dart';
import 'package:agent_company/ui/chat/chat_screen.dart';
import 'package:agent_company/ui/chat/items.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

import 'helpers.dart';

/// A 2x2 PNG (four colours), so the thumbnail draws something real.
final png = base64Decode('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAFklEQVR4nGO4E2Bj03OHIWpL1IcTNgArVgZpg9MzkAAAAABJRU5ErkJggg==');

Attachment image([String name = 'צילום.png']) => Attachment(name: name, bytes: png.length, mime: 'image/png', data: png);

void main() {
  test('imageMime: by the bytes, the four formats hq takes', () {
    expect(imageMime(png), 'image/png');
    expect(imageMime(Uint8List.fromList([0xff, 0xd8, 0xff, 0xe0])), 'image/jpeg');
    expect(imageMime(Uint8List.fromList('GIF89a..'.codeUnits)), 'image/gif');
    expect(imageMime(Uint8List.fromList('RIFF\x00\x00\x00\x00WEBP'.codeUnits)), 'image/webp');
    expect(imageMime(Uint8List.fromList('<svg/>'.codeUnits)), isNull);
  });

  testWidgets('an image waits above the field, can be removed, and goes with the message', (tester) async {
    final store = await pumpApp(
      tester,
      size: const Size(342, 1500),
      home: const ChatScreen(identityId: 'dana'),
    );
    await tester.enterText(find.byType(TextField), '');
    await tester.pump();
    expect(find.bySemanticsLabel('הכתבה'), findsOneWidget, reason: 'empty: the round button is the mic');

    store.addImage('dana', image());
    await tester.pump();
    // Image decoding is real async work: done outside the fake clock, so the golden shows the thumbnail.
    await tester.runAsync(() => precacheImage(MemoryImage(png), tester.element(find.byType(ChatScreen))));
    await tester.pump();
    expect(find.byTooltip('להסיר את צילום.png'), findsOneWidget);
    expect(find.bySemanticsLabel('שליחה'), findsOneWidget, reason: 'an image alone can be sent');
    await expectLater(find.byType(MaterialApp), matchesGoldenFile('goldens/chat_attach_preview.png'));

    await tester.tap(find.byTooltip('להסיר את צילום.png'));
    await tester.pump();
    expect(find.byTooltip('להסיר את צילום.png'), findsNothing);
    expect(store.images('dana'), isEmpty);

    store.addImage('dana', image('א.png'));
    store.addImage('dana', image('ב.png'));
    await tester.enterText(find.byType(TextField), 'מה רואים כאן?');
    await tester.pump();
    await tester.tap(find.bySemanticsLabel('שליחה'));
    await tester.pump();
    final sent = store.data!.chats['dana']!.items.whereType<UserMsg>().last;
    expect(sent.text, 'מה רואים כאן?');
    expect(sent.attachments.map((a) => a.name), ['א.png', 'ב.png']);
    expect(store.images('dana'), isEmpty, reason: 'the preview empties once sent');
    expect(find.byType(BubbleImages), findsOneWidget);
  });

  test('HqBackend: images are uploaded first, then the message carries their ids', () async {
    final reqs = <http.Request>[];
    var n = 0;
    final hq = HqBackend(
      baseUrl: 'http://hq',
      token: 't',
      client: MockClient((req) async {
        reqs.add(req);
        if (req.url.path == '/api/uploads') {
          return http.Response(
            jsonEncode({
              'upload': {'id': 'u-${++n}'},
            }),
            200,
          );
        }
        return http.Response('{}', 200);
      }),
    );
    final msg = UserMsg(id: 'm-1', ts: DateTime(2026, 10, 20), text: '', attachments: [image(), image('שני.png')]);
    expect((await hq.send('yoav', msg)).ok, isTrue);
    expect(reqs.map((r) => r.url.path), ['/api/uploads', '/api/uploads', '/api/messages/tell']);
    expect(reqs.first.headers['content-type'], 'image/png');
    expect(Uri.decodeComponent(reqs[1].headers['x-file-name']!), 'שני.png');
    expect(reqs.first.bodyBytes, png);
    final tell = jsonDecode(reqs.last.body) as Map;
    expect(tell['attachments'], ['u-1', 'u-2']);
    expect(tell['body'], '');
    expect(msg.attachments.map((a) => a.id), ['u-1', 'u-2']);
    expect(await hq.attachmentData('u-1'), png, reason: 'what was sent from here is not fetched again');
    expect(reqs.length, 3);
  });

  test('HqBackend: an upload that fails fails the message, and a retry skips what is already up', () async {
    final paths = <String>[];
    var fail = true;
    final hq = HqBackend(
      baseUrl: 'http://hq',
      token: 't',
      client: MockClient((req) async {
        paths.add(req.url.path);
        if (req.url.path == '/api/uploads') return fail ? http.Response('{"error":"x"}', 500) : http.Response('{"upload":{"id":"u-9"}}', 200);
        return http.Response('{}', 200);
      }),
    );
    final msg = UserMsg(id: 'm-2', ts: DateTime(2026, 10, 20), text: 'הנה', attachments: [image()]);
    final r = await hq.send('yoav', msg);
    expect(r.ok, isFalse);
    expect(msg.delivery, Delivery.failed);
    expect(paths, ['/api/uploads'], reason: 'no message without its image');

    fail = false;
    final again = UserMsg(id: 'm-3', ts: DateTime(2026, 10, 20), text: 'הנה', attachments: [image().uploaded('u-1'), image()]);
    expect((await hq.send('yoav', again)).ok, isTrue);
    expect(paths.skip(1), ['/api/uploads', '/api/messages/tell']);
  });

  testWidgets('a worker\'s message shows its images in a grid; a tap opens them full screen, a swipe moves on', (tester) async {
    final msg = TextMsg(id: 'msg:m-mock', ts: DateTime(2026, 10, 20), text: 'המוקאפ', attachments: [for (var i = 1; i <= 7; i++) image('$i.png').uploaded('u-$i')]);
    await pumpApp(
      tester,
      home: Scaffold(
        body: Center(child: TextBubble(msg: msg)),
      ),
    );
    expect(find.descendant(of: find.byType(TextBubble), matching: find.byType(AttachmentImage)), findsNWidgets(4));
    expect(find.textContaining('המוקאפ', findRichText: true), findsWidgets);

    await tester.tap(find.byType(AttachmentImage).at(2));
    await tester.pumpAndSettle();
    expect(find.byType(ImageViewer), findsOneWidget);
    expect(find.text('3 מתוך 7'), findsOneWidget);
    await tester.fling(find.byType(PageView), const Offset(-400, 0), 1000);
    await tester.pumpAndSettle();
    expect(find.text('3 מתוך 7'), findsNothing, reason: 'a swipe moves to a neighbouring image');
  });

  test('history: a stored message brings its images back, and an image alone is "תמונה" in the list', () {
    final m = {
      'body': '',
      'attachments': [
        {'id': 'u-1', 'name': 'a.png', 'mime': 'image/png', 'bytes': 10},
      ],
    };
    expect(attachmentsOf(m).single.id, 'u-1');
    expect(lastLineOf(m), 'תמונה');
    expect(lastLineOf({'body': 'שלום\nעוד', 'attachments': null}), 'שלום');
  });
}
