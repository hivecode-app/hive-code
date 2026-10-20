// Navigation in one place: phone pushes full screens; desktop (≥800px) swaps the main column.
import 'package:flutter/material.dart';

import '../data/store.dart';
import '../model/models.dart';
import 'chat/chat_screen.dart';
import '../native/open_url.dart';
import 'handoff/handoff_screen.dart';
import 'home/wait_item_screen.dart';
import 'projects/project_screen.dart';
import 'settings/settings_screen.dart';

/// The bottom tabs (#53): chats is the main screen; status, projects and settings are secondary.
enum AppTab { chats, status, projects, settings }

class AppNav extends ChangeNotifier {
  AppTab tab = AppTab.chats;
  bool wide = false;

  void go(AppTab t) {
    // Leaving a tab closes what its back handler would have closed (an open search), so it can't
    // be found still open, with nothing behind back, on return.
    final h = backHandler;
    if (t != tab && h != null) {
      backHandler = null;
      h();
    }
    // Leaving "סטטוס", by any way (a tab, back, a link, a shortcut), is his visit there.
    if (tab == AppTab.status && t != AppTab.status) onLeaveStatus?.call();
    if (tab == AppTab.chats && t != AppTab.chats) onLeaveChats?.call();
    tab = t;
    notifyListeners();
  }

  /// Set by the shell: what finishes after this is "מאז הביקור הקודם" next time.
  VoidCallback? onLeaveStatus;

  /// Set by the shell: what finishes after this is "מאז שהיית פה" on the chats screen next time.
  VoidCallback? onLeaveChats;

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
      nav.go(AppTab.chats);
      store.touch();
      if (quote != null || focus) ChatScreen.pendingQuote[identityId] = quote;
      return;
    }
    if (quote != null || focus) ChatScreen.pendingQuote[identityId] = quote;
    Navigator.of(context).push(MaterialPageRoute(builder: (_) => ChatScreen(identityId: identityId)));
  }

  /// A real handoff (hq gave a link) opens the phone page in the browser, as the bet6 spike had it;
  /// "סיימתי" there wakes the worker. Without a link the in-app screen shows the request and a code field.
  static void handoff(BuildContext context, WaitItem item) {
    final link = item.link;
    if (link != null) {
      openExternalUrl(link);
      return;
    }
    Navigator.of(context).push(MaterialPageRoute(fullscreenDialog: true, builder: (_) => HandoffScreen(item: item)));
  }

  static void waitItem(BuildContext context, WaitItem item) =>
      Navigator.of(context).push(MaterialPageRoute(builder: (_) => WaitItemScreen(item: item)));

  static void project(BuildContext context, String projectId) =>
      Navigator.of(context).push(MaterialPageRoute(builder: (_) => ProjectScreen(projectId: projectId)));

  static void team(BuildContext context, String teamId) => Navigator.of(context).push(MaterialPageRoute(builder: (_) => ProjectScreen(teamId: teamId)));

  static void settings(BuildContext context) => Navigator.of(context).push(MaterialPageRoute(builder: (_) => const SettingsScreen()));
}
