// Unread and mute on screen, as in WhatsApp (#task-50): a count on each row and on "שיחות" (muted ones left
// out, shown quieter with notifications_off), long press and the chat menu mute, opening a chat reads it.
import 'package:agent_company/ui/chat/chat_screen.dart';
import 'package:agent_company/ui/common.dart';
import 'package:agent_company/ui/product/chats.dart';
import 'package:agent_company/ui/product/product_theme.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'helpers.dart';

void main() {
  testWidgets('rows show their count, muted ones quieter with notifications_off; "שיחות" counts the rest', (tester) async {
    final store = await pumpApp(tester, size: const Size(342, 1600));
    final badge = find.byType(ProductUnreadBadge);
    expect(find.descendant(of: find.byType(ListView), matching: find.descendant(of: badge, matching: find.text('2'))), findsOneWidget, reason: 'Ido');
    expect(find.descendant(of: badge, matching: find.text('3')), findsOneWidget, reason: 'Noga, muted');
    expect(find.byWidgetPredicate((w) => w is Ic && w.name == 'notifications_off'), findsOneWidget);
    expect(store.data!.unreadCount, 2);
    // The chats tab counts the rest: 2, not 5.
    expect(find.descendant(of: find.byType(NavigationBar), matching: find.descendant(of: badge, matching: find.text('2'))), findsOneWidget);
  });

  testWidgets('long press mutes for a week; the total drops; long press again offers "ביטול השתקה"', (tester) async {
    final store = await pumpApp(tester, size: const Size(342, 1600), home: const Scaffold(body: ProductChats()));
    await tester.longPress(find.text('עידו'));
    await tester.pumpAndSettle();
    expect(find.text('8 שעות'), findsOneWidget);
    expect(find.text('תמיד'), findsOneWidget);
    await tester.tap(find.text('שבוע'));
    await tester.pumpAndSettle();
    expect(store.data!.conversation('ido')!.muted, isTrue);
    expect(store.data!.unreadCount, 0);
    await tester.longPress(find.text('עידו'));
    await tester.pumpAndSettle();
    expect(find.text('שבוע'), findsNothing);
    await tester.tap(find.text('ביטול השתקה'));
    await tester.pumpAndSettle();
    expect(store.data!.conversation('ido')!.muted, isFalse);
  });

  testWidgets('opening a conversation reads it; the sheet behind "i" mutes it', (tester) async {
    final store = await pumpApp(tester, home: const ChatScreen(identityId: 'ido'));
    await tester.pumpAndSettle();
    expect(store.data!.conversation('ido')!.unread, 0);
    await tester.tap(find.byTooltip('תפקיד'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('השתקה'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('תמיד'));
    await tester.pumpAndSettle();
    expect(store.data!.conversation('ido')!.muted, isTrue);
  });
}
