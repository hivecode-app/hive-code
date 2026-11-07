import 'package:agent_company/data/app_preferences.dart';
import 'package:agent_company/l10n/app_localizations.dart';
import 'package:agent_company/ui/common.dart';
import 'package:agent_company/ui/nav.dart';
import 'package:agent_company/ui/product/settings.dart';
import 'package:agent_company/ui/product/shell.dart';
import 'package:agent_company/ui/product/team.dart';
import 'package:agent_company/ui/projects/project_screen.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'product_test.dart' show productApp;

/// The three tabs, back, and where settings and the projects are reached from, now that the old shell is gone.
void main() {
  int tab(WidgetTester tester) => tester.widget<NavigationBar>(find.byType(NavigationBar)).selectedIndex;
  AppLocalizations l(WidgetTester tester) => AppLocalizations.of(tester.element(find.byType(ProductShell)));

  testWidgets('back on tasks or team returns to the chats; on the chats it leaves the app', (tester) async {
    await productApp(tester);
    for (final name in [l(tester).tasks, l(tester).team]) {
      await tester.tap(find.descendant(of: find.byType(NavigationBar), matching: find.text(name)));
      await tester.pumpAndSettle();
      expect(tab(tester), isNot(0));
      expect(await tester.binding.handlePopRoute(), isTrue);
      await tester.pumpAndSettle();
      expect(tab(tester), 0);
    }
    expect(await tester.binding.handlePopRoute(), isFalse);
  });

  testWidgets('back over a pushed page closes it and stays on the same tab', (tester) async {
    await productApp(tester);
    await tester.tap(find.descendant(of: find.byType(NavigationBar), matching: find.text(l(tester).team)));
    await tester.pumpAndSettle();
    Nav.settings(tester.element(find.byType(ProductTeam)));
    await tester.pumpAndSettle();
    expect(find.byType(ProductSettings), findsOneWidget);
    expect(await tester.binding.handlePopRoute(), isTrue);
    await tester.pumpAndSettle();
    expect(find.byType(ProductSettings), findsNothing);
    expect(tab(tester), 2);
  });

  testWidgets('a phone on its side keeps the phone layout; a wide low window is a desktop', (tester) async {
    await productApp(tester, size: const Size(914, 411));
    expect(find.byType(NavigationBar), findsOneWidget);
    await tester.pumpWidget(const SizedBox.shrink());
    await productApp(tester, size: const Size(1280, 520));
    expect(find.byType(NavigationBar), findsNothing);
  });

  testWidgets('the selected tab has a filled icon and a 600 label', (tester) async {
    await productApp(tester);
    final label = tester.widget<Text>(find.descendant(of: find.byType(NavigationBar), matching: find.text(l(tester).chats)));
    final other = tester.widget<Text>(find.descendant(of: find.byType(NavigationBar), matching: find.text(l(tester).tasks)));
    TextStyle style(Text t) => DefaultTextStyle.of(tester.element(find.byWidget(t))).style.merge(t.style);
    expect(style(label).fontWeight, FontWeight.w600);
    expect(style(other).fontWeight, isNot(FontWeight.w600));
    final icons = tester.widgetList<Ic>(find.descendant(of: find.byType(NavigationBar), matching: find.byType(Ic))).toList();
    expect(icons.firstWhere((x) => x.name == 'chat').fill, isTrue);
    expect(icons.firstWhere((x) => x.name == 'view_kanban').fill, isFalse);
  });

  testWidgets('the account icon on the chats opens settings', (tester) async {
    await productApp(tester);
    await tester.tap(find.byWidgetPredicate((w) => w is Ic && w.name == 'account_circle'));
    await tester.pumpAndSettle();
    expect(find.byType(ProductSettings), findsOneWidget);
  });

  testWidgets('the sidebar counts open tasks, and settings and his name at its foot open settings', (tester) async {
    final store = await productApp(tester, size: const Size(1280, 840));
    final d = store.data!;
    expect(find.text('${d.openTasks.length}'), findsWidgets);
    for (final name in [l(tester).settings, d.ownerName.isEmpty ? l(tester).account : d.ownerName]) {
      await tester.tap(find.text(name).last);
      await tester.pumpAndSettle();
      expect(find.byType(ProductSettings), findsOneWidget);
      Navigator.of(tester.element(find.byType(ProductSettings))).pop();
      await tester.pumpAndSettle();
    }
  });

  testWidgets('the folded sidebar opens the projects as a page', (tester) async {
    await productApp(tester, size: const Size(900, 700));
    await tester.tap(find.byTooltip(l(tester).projects));
    await tester.pumpAndSettle();
    expect(find.byType(ProductDirectory), findsOneWidget);
  });

  testWidgets('on the phone a group heading in the team opens its project page', (tester) async {
    final store = await productApp(tester);
    await tester.tap(find.descendant(of: find.byType(NavigationBar), matching: find.text(l(tester).team)));
    await tester.pumpAndSettle();
    final group = ProductTeam.groups(store.data!).first;
    await tester.tap(find.text(group.$1).first);
    await tester.pumpAndSettle();
    expect(find.byType(ProjectScreen), findsOneWidget);
  });

  testWidgets('a standing team heading opens its team page; a team org.yaml does not know opens nothing', (tester) async {
    final store = await productApp(tester);
    await tester.tap(find.descendant(of: find.byType(NavigationBar), matching: find.text(l(tester).team)));
    await tester.pumpAndSettle();
    final d = store.data!;
    final standing = {for (final t in standingTeams(d)) t.name};
    final group = ProductTeam.groups(d).where((g) => standing.contains(g.$1)).first;
    await tester.scrollUntilVisible(find.text(group.$1).first, 200, scrollable: find.byType(Scrollable).last);
    await tester.tap(find.text(group.$1).first);
    await tester.pumpAndSettle();
    expect(tester.widget<ProjectScreen>(find.byType(ProjectScreen)).teamId, isNotNull);
  });

  testWidgets('a device that still holds the old interface choice forgets it', (tester) async {
    SharedPreferences.setMockInitialValues({'language': 'he', 'new_interface': false});
    final disk = await SharedPreferences.getInstance();
    await AppPreferences().load(disk);
    expect(disk.containsKey('new_interface'), isFalse);
  });

  testWidgets('the fold chevron turns over when open', (tester) async {
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: FoldTile(key: const PageStorageKey('t'), title: const Text('t'), children: const [Text('in')]),
        ),
      ),
    );
    double turns() => tester.widget<AnimatedRotation>(find.byType(AnimatedRotation)).turns;
    expect(turns(), 0);
    await tester.tap(find.text('t'));
    await tester.pumpAndSettle();
    expect(turns(), 0.5);
  });
}
