// Bidi corpus (docs/app/qa/QA-LOG.md, "RTL/bidi"): 44 real mixed Hebrew/English messages from
// Claude Code transcripts and hq.db (tool/qa/bidi_corpus.py), each rendered as a chat bubble in
// light and dark side by side. A change to how any of them lays out shows up as a golden diff.
import 'dart:io';
import 'dart:ui' as ui;

import 'package:agent_company/model/models.dart';
import 'package:agent_company/theme/theme.dart';
import 'package:agent_company/theme/tokens.dart';
import 'package:agent_company/ui/chat/items.dart';
import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter_test/flutter_test.dart';

import 'fixtures/bidi/corpus.dart';
import 'helpers.dart';

void main() {
  const corpus = kBidiCorpus;
  final ts = DateTime(2026, 10, 20, 14, 6);

  Widget bubble(Map<String, dynamic> m) => m['from'] == 'owner'
      ? UserBubble(msg: UserMsg(id: m['id'], ts: ts, text: m['text'], delivery: Delivery.read), identityId: 'yoav')
      : TextBubble(msg: TextMsg(id: m['id'], ts: ts, text: m['text']));

  Widget side(Palette pal, Widget child) => Theme(
        data: buildTheme(pal),
        child: Builder(
          builder: (context) => Container(
            width: kPhone.width,
            color: context.p.chatBg,
            padding: const EdgeInsets.symmetric(vertical: 8),
            child: DefaultTextStyle(style: T.body.copyWith(color: context.p.text), child: Column(mainAxisSize: MainAxisSize.min, children: [child])),
          ),
        ),
      );

  for (final m in corpus) {
    testWidgets('bidi ${m['id']}', (tester) async {
      await pumpApp(
        tester,
        size: const Size(684, 1600),
        home: Material(
          child: Align(
            alignment: Alignment.topCenter,
            child: RepaintBoundary(
              key: const ValueKey('pair'),
              child: Row(textDirection: TextDirection.ltr, crossAxisAlignment: CrossAxisAlignment.start, mainAxisSize: MainAxisSize.min, children: [
                side(Palette.light, bubble(m)),
                side(Palette.darkPalette, bubble(m)),
              ]),
            ),
          ),
        ),
      );
      // Review copy at 3x for a human eye (goldens are 1x): QA_HIRES=<dir> flutter test ...
      final hires = Platform.environment['QA_HIRES'];
      if (hires != null) {
        final boundary = tester.renderObject<RenderRepaintBoundary>(find.byKey(const ValueKey('pair')));
        await tester.runAsync(() async {
          final img = await boundary.toImage(pixelRatio: 3);
          final png = await img.toByteData(format: ui.ImageByteFormat.png);
          File('$hires/${m['id']}.png').writeAsBytesSync(png!.buffer.asUint8List());
        });
      }
      await expectLater(find.byKey(const ValueKey('pair')), matchesGoldenFile('goldens/bidi/${m['id']}.png'));
    });
  }
}
