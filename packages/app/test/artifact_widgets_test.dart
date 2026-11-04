import 'dart:typed_data';

import 'package:agent_company/data/fake_backend.dart';
import 'package:agent_company/data/hq_backend.dart' show ArtifactAccessFailure;
import 'package:agent_company/model/models.dart';
import 'package:agent_company/model/company_time.dart';
import 'package:agent_company/ui/chat/items.dart';
import 'package:agent_company/ui/media/artifact.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'product_test.dart' show productApp;

Map<String, dynamic> info([int latest = 2]) => {
  'id': 'a-example',
  'owner': 'dana',
  'task_id': 77,
  'title': 'A one-time comparison',
  'latest': latest,
  'expires_at': DateTime(2026, 12, 4).millisecondsSinceEpoch,
  'pinned': false,
  'expired': false,
  'versions': [
    for (var n = latest; n > 0; n--)
      {
        'version': n,
        'title': 'Comparison version $n',
        'note': n == latest ? 'Updated comparison' : '',
        'network': false,
        'created_at': DateTime(2026, 11, 4, 9, n).millisecondsSinceEpoch,
      },
  ],
};

class ArtifactBackend extends FakeBackend {
  ArtifactBackend() : super(simulate: false);
  Map<String, dynamic> current = info();
  final opened = <int>[];
  bool keepOk = false, expired = false;
  @override
  Future<Map<String, dynamic>?> artifact(String id) async => current;
  @override
  Future<Map<String, dynamic>> openArtifact(String id, int version) async {
    if (expired) throw ArtifactAccessFailure(410);
    opened.add(version);
    return {
      'id': id,
      'version': version,
      'url': 'https://art.example/artifacts/$id/v$version/token-${opened.length}/index.html',
      'access_expires_at': CompanyTime.now().add(const Duration(hours: 12)).millisecondsSinceEpoch,
    };
  }

  @override
  Future<bool> keepArtifact(String id) async {
    if (keepOk) current = {...current, 'pinned': true};
    return keepOk;
  }

  @override
  Future<Uint8List?> artifactThumb(String id) async => null;
  void publish(int version) {
    current = info(version);
    artifactRevision.value++;
  }
}

Widget surface(String url, void Function(String) blocked) => Center(child: Text('content ${Uri.parse(url).pathSegments[2]}'));
void main() {
  for (final lang in ['en', 'he']) {
    for (final dark in [false, true]) {
      testWidgets('artifact card and open screen $lang dark=$dark', (tester) async {
        final backend = ArtifactBackend();
        await productApp(
          tester,
          language: lang,
          dark: dark,
          backend: backend,
          home: Scaffold(
            body: Center(child: ArtifactCard(info: info())),
          ),
        );
        await expectLater(find.byType(MaterialApp), matchesGoldenFile('goldens/media/artifact-card-$lang-${dark ? 'dark' : 'light'}.png'));
        await tester.pumpWidget(const SizedBox.shrink());
      });
      testWidgets('artifact chrome $lang dark=$dark', (tester) async {
        final backend = ArtifactBackend();
        await productApp(
          tester,
          language: lang,
          dark: dark,
          backend: backend,
          home: ArtifactScreen(id: 'a-example', version: 2, surfaceBuilder: surface),
        );
        expect(find.text('content v2'), findsOneWidget);
        await expectLater(find.byType(MaterialApp), matchesGoldenFile('goldens/media/artifact-open-$lang-${dark ? 'dark' : 'light'}.png'));
      });
    }
  }
  testWidgets('a third version does not replace the second until explicitly selected; renewal stays on the selected version', (tester) async {
    final backend = ArtifactBackend();
    await productApp(
      tester,
      backend: backend,
      home: ArtifactScreen(id: 'a-example', version: 2, surfaceBuilder: surface),
    );
    expect(backend.opened, [2]);
    backend.publish(3);
    await tester.pumpAndSettle();
    expect(find.text('content v2'), findsOneWidget);
    expect(backend.opened, [2]);
    await tester.pump(const Duration(hours: 12));
    await tester.pumpAndSettle();
    expect(backend.opened, [2, 2]);
    expect(find.text('content v2'), findsOneWidget);
    await tester.tap(find.text('A newer version is available'));
    await tester.pumpAndSettle();
    expect(backend.opened, [2, 2, 3]);
    expect(find.text('content v3'), findsOneWidget);
  });
  testWidgets('failed keep never labels the content kept; reply quotes exact id and version in a preserved draft', (tester) async {
    final backend = ArtifactBackend();
    final store = await productApp(
      tester,
      backend: backend,
      home: ArtifactScreen(id: 'a-example', version: 2, surfaceBuilder: surface),
      prepare: (s) => s.setDraft('dana', 'existing draft'),
    );
    await tester.tap(find.byTooltip('File actions'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Keep'));
    await tester.pumpAndSettle();
    expect(find.text('Kept without expiration'), findsNothing);
    expect(backend.current['pinned'], false);
    artifactDraft(tester.element(find.byType(ArtifactScreen)), backend.current, 2);
    await tester.pumpAndSettle();
    expect(store.data!.chats['dana']!.draft, contains('existing draft'));
    expect(store.data!.chats['dana']!.draft, contains('a-example, version 2'));
  });
  testWidgets('expired content has a stable card and a request for a new copy instead of a loading loop', (tester) async {
    final backend = ArtifactBackend()..expired = true;
    final store = await productApp(
      tester,
      backend: backend,
      home: ArtifactScreen(id: 'a-example', version: 2, surfaceBuilder: surface),
    );
    expect(find.text('Content expired. The card remains in your chat.'), findsOneWidget);
    await tester.tap(find.text('Ask for a new copy'));
    await tester.pumpAndSettle();
    expect(store.data!.chats['dana']!.draft, contains('a-example, version 2'));
  });
  testWidgets('the typed artifact field renders a card instead of the legacy signed-link text', (tester) async {
    final backend = ArtifactBackend();
    await productApp(
      tester,
      backend: backend,
      home: Scaffold(
        body: TextBubble(
          msg: TextMsg(id: 'artifact-message', ts: DateTime(2026, 11, 4), text: 'https://signed.example/private-token', artifact: info()),
        ),
      ),
    );
    expect(find.byType(ArtifactCard), findsOneWidget);
    expect(find.textContaining('private-token'), findsNothing);
  });
  testWidgets('comparison opens two explicitly selected versions', (tester) async {
    final backend = ArtifactBackend()..current = info(3);
    await productApp(
      tester,
      backend: backend,
      size: const Size(1200, 844),
      home: ArtifactCompare(info: info(3), initial: 2, surfaceBuilder: surface),
    );
    expect(find.text('content v2'), findsOneWidget);
    expect(find.text('content v3'), findsOneWidget);
    expect(backend.opened.toSet(), {2, 3});
    expect(find.byType(DropdownButton<int>), findsNWidgets(2));
  });
}
