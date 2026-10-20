// Navigation in one place: phone pushes full screens; desktop (≥800px) swaps the main column.
import 'package:flutter/material.dart';

import '../data/store.dart';
import '../model/models.dart';
import 'board/ticket_screen.dart';
import 'chat/chat_screen.dart';
import '../native/open_url.dart';
import 'handoff/handoff_screen.dart';
import 'settings/settings_screen.dart';

enum AppTab { home, convs, board, org }

class AppNav extends ChangeNotifier {
  AppTab tab = AppTab.home;
  bool wide = false;

  /// Desktop main column: ticket detail shown instead of the chat.
  String? ticket;

  void go(AppTab t) {
    // Leaving a tab closes what its back handler would have closed (an open search), so it can't
    // be found still open, with nothing behind back, on return.
    final h = backHandler;
    if (t != tab && h != null) {
      backHandler = null;
      h();
    }
    tab = t;
    notifyListeners();
  }

  /// Something on the current tab that Android back should close first (an open search).
  VoidCallback? backHandler;
  void setBackHandler(VoidCallback? h) {
    if (backHandler == h) return;
    backHandler = h;
    notifyListeners();
  }
}

class NavScope extends InheritedNotifier<AppNav> {
  const NavScope({super.key, required AppNav nav, required super.child}) : super(notifier: nav);
  static AppNav of(BuildContext c) => c.dependOnInheritedWidgetOfExactType<NavScope>()!.notifier!;
  static AppNav read(BuildContext c) => c.getInheritedWidgetOfExactType<NavScope>()!.notifier!;
}

class Nav {
  static void chat(BuildContext context, String identityId, {Quote? quote, bool focus = false}) {
    final nav = NavScope.read(context);
    final store = StoreScope.read(context);
    if (nav.wide) {
      store.selectedConversation = identityId;
      nav.ticket = null;
      nav.go(AppTab.convs);
      store.touch();
      if (quote != null || focus) ChatScreen.pendingQuote[identityId] = quote;
      return;
    }
    if (quote != null || focus) ChatScreen.pendingQuote[identityId] = quote;
    Navigator.of(context).push(MaterialPageRoute(builder: (_) => ChatScreen(identityId: identityId)));
  }

  static void ticket(BuildContext context, String number) {
    final nav = NavScope.read(context);
    if (nav.wide) {
      nav.ticket = number;
      nav.go(AppTab.board);
      return;
    }
    Navigator.of(context).push(MaterialPageRoute(builder: (_) => TicketScreen(number: number)));
  }

  /// A real handoff (hq gave a link) opens the phone page in the browser, as the bet6 spike had it;
  /// "סיימתי" there wakes the worker. The in-app screen stays for demo mode.
  static void handoff(BuildContext context, WaitItem item) {
    final link = item.link;
    if (link != null) {
      openExternalUrl(link);
      return;
    }
    Navigator.of(context).push(MaterialPageRoute(fullscreenDialog: true, builder: (_) => HandoffScreen(item: item)));
  }

  static void settings(BuildContext context) => Navigator.of(context).push(MaterialPageRoute(builder: (_) => const SettingsScreen()));
}
