// The bidi corpus on a real Android text engine (emulator or phone): every message as a chat
// bubble, light then dark, one screenshot per screenful. Run with tool/qa/device.sh bidi.
import 'package:agent_company/model/models.dart';
import 'package:agent_company/theme/theme.dart';
import 'package:agent_company/theme/tokens.dart';
import 'package:agent_company/ui/chat/items.dart';
import 'package:flutter/material.dart';
import 'package:flutter_localizations/flutter_localizations.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:integration_test/integration_test.dart';

import '../test/fixtures/bidi/corpus.dart';

void main() {
  final binding = IntegrationTestWidgetsFlutterBinding.ensureInitialized();
  final ts = DateTime(2026, 10, 20, 14, 6);

  Widget bubble(Map<String, String> m) => m['from'] == 'owner'
      ? UserBubble(msg: UserMsg(id: m['id']!, ts: ts, text: m['text']!, delivery: Delivery.read), identityId: 'yoav')
      : TextBubble(msg: TextMsg(id: m['id']!, ts: ts, text: m['text']!));

  for (final dark in [false, true]) {
    testWidgets('bidi corpus on device (${dark ? 'dark' : 'light'})', (tester) async {
      final scroll = ScrollController();
      await tester.pumpWidget(MaterialApp(
        debugShowCheckedModeBanner: false,
        theme: buildTheme(dark ? Palette.darkPalette : Palette.light),
        locale: const Locale('he'),
        supportedLocales: const [Locale('he')],
        localizationsDelegates: const [GlobalMaterialLocalizations.delegate, GlobalWidgetsLocalizations.delegate, GlobalCupertinoLocalizations.delegate],
        home: Builder(
          builder: (context) => Scaffold(
            backgroundColor: context.p.chatBg,
            body: SafeArea(
              child: ListView(controller: scroll, children: [
                for (final m in kBidiCorpus) ...[
                  Padding(
                    padding: const EdgeInsets.only(top: 6),
                    child: Center(child: Text(m['id']!, style: TextStyle(fontSize: 11, color: context.p.text3))),
                  ),
                  bubble(m),
                ],
              ]),
            ),
          ),
        ),
      ));
      await tester.pumpAndSettle();
      await binding.convertFlutterSurfaceToImage();
      await tester.pumpAndSettle();
      var page = 0;
      while (true) {
        await binding.takeScreenshot('bidi-${dark ? 'dark' : 'light'}-${(page++).toString().padLeft(2, '0')}');
        final pos = scroll.position;
        if (pos.pixels >= pos.maxScrollExtent) break;
        scroll.jumpTo((pos.pixels + pos.viewportDimension * 0.9).clamp(0, pos.maxScrollExtent));
        await tester.pumpAndSettle();
      }
    });
  }
}
