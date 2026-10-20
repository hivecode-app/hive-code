// Rebuild cost guards (quality.md §1: no frame over 8.3ms while streaming). Counts rebuilds, which
// is deterministic, rather than timing them: a hidden tab or a screen under a pushed chat must not
// rebuild on store changes, and a streaming token must rebuild only the bubble that grew.
import 'package:agent_company/data/store.dart';
import 'package:agent_company/model/models.dart';
import 'package:agent_company/ui/chat/chat_screen.dart';
import 'package:agent_company/ui/chat/items.dart';
import 'package:agent_company/ui/home/home_screen.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'helpers.dart';

class _Probe extends StatelessWidget {
  const _Probe(this.builds);
  final List<int> builds;
  @override
  Widget build(BuildContext context) {
    StoreScope.of(context);
    builds.add(1);
    return const SizedBox();
  }
}

class _Gated extends StatefulWidget {
  const _Gated(this.builds);
  final List<int> builds;
  @override
  State<_Gated> createState() => _GatedState();
}

class _GatedState extends State<_Gated> {
  bool active = false;
  void show() => setState(() => active = true);
  @override
  Widget build(BuildContext context) => StoreGate(active: active, child: _Probe(widget.builds));
}

void addHistory(Conversation chat, int n) {
  final start = DateTime(2026, 10, 18);
  chat.items.insertAll(0, [
    for (var i = 0; i < n; i++)
      i % 7 == 3
          ? UserMsg(id: 'h-u$i', ts: start.add(Duration(minutes: i)), text: 'מה המצב עם הבדיקות?', delivery: Delivery.read)
          : TextMsg(id: 't:h$i', ts: start.add(Duration(minutes: i)), text: 'בדקתי את `renew.go`. PR #3712 נפתח, ה-CI רץ.'),
  ]);
}

void main() {
  testWidgets('a hidden part of the screen ignores store changes, then catches up once', (tester) async {
    final builds = <int>[];
    final store = await pumpApp(tester, home: _Gated(builds));
    builds.clear();
    for (var i = 0; i < 5; i++) {
      store.touch();
      await tester.pump();
    }
    expect(builds, isEmpty);
    tester.state<_GatedState>(find.byType(_Gated)).show();
    await tester.pump();
    expect(builds.length, 1);
    store.touch();
    await tester.pump();
    expect(builds.length, 2);
  });

  testWidgets('a streaming token rebuilds the bubble that grew, nothing else on screen', (tester) async {
    final store = await pumpApp(tester, size: const Size(342, 1500), home: const SizedBox());
    final ido = store.data!.chats['ido']!;
    addHistory(ido, 2000);
    tester.state<NavigatorState>(find.byType(Navigator).first).push(MaterialPageRoute(builder: (_) => const ChatScreen(identityId: 'ido')));
    await tester.pumpAndSettle();

    final msg = TextMsg(id: 't:streaming-1', ts: DateTime(2026, 10, 20, 14, 6), text: 'בודקת', streaming: true);
    ido.items.add(msg);
    store.touch();
    await tester.pump();

    TextBubble.debugBuilds = 0;
    const tokens = 40;
    for (var i = 0; i < tokens; i++) {
      msg.text += ' מילה$i';
      store.touch();
      await tester.pump();
    }
    expect(TextBubble.debugBuilds, tokens, reason: 'one bubble per token');
    expect(findShown('מילה${tokens - 1}'), findsOneWidget, reason: 'the streaming text is on screen');
  });

  testWidgets('the tabs under an open chat do not rebuild while it streams, and catch up after', (tester) async {
    final store = await pumpApp(tester, home: const StoreGate(child: _ShellLike()));
    final nav = tester.state<NavigatorState>(find.byType(Navigator).first);
    nav.push(MaterialPageRoute(builder: (_) => const ChatScreen(identityId: 'dana')));
    await tester.pumpAndSettle();
    HomeScreen.debugBuilds = 0;
    for (var i = 0; i < 10; i++) {
      store.touch();
      await tester.pump();
    }
    expect(HomeScreen.debugBuilds, 0, reason: 'home is covered by the chat');
    nav.pop();
    await tester.pumpAndSettle();
    expect(HomeScreen.debugBuilds, greaterThanOrEqualTo(1), reason: 'home caught up when shown again');
  });

  testWidgets('a dialog does not freeze the screen behind it', (tester) async {
    final store = await pumpApp(tester, home: const StoreGate(child: _ShellLike()));
    showDialog<void>(context: tester.element(find.byType(HomeScreen)), builder: (_) => const AlertDialog(content: Text('דיאלוג')));
    await tester.pumpAndSettle();
    HomeScreen.debugBuilds = 0;
    store.touch();
    await tester.pump();
    expect(HomeScreen.debugBuilds, 1, reason: 'what is behind a dialog stays visible, so it stays live');
  });
}

/// The phone shell's home tab, as the app wraps it (main.dart: StoreGate(child: Shell())).
class _ShellLike extends StatelessWidget {
  const _ShellLike();
  @override
  Widget build(BuildContext context) => const Scaffold(body: HomeScreen());
}
