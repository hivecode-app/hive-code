import 'product/settings.dart';
import 'product/shell.dart' show ProductDirectory;
// Navigation in one place: phone pushes full screens; desktop (≥800px) swaps the main column.
import 'package:flutter/material.dart';

import '../data/store.dart';
import '../model/models.dart';
import 'chat/chat_screen.dart';
import '../native/open_url.dart';
import 'handoff/handoff_screen.dart';
import 'home/wait_item_screen.dart';
import 'projects/project_screen.dart';

/// The three tabs (mockup a-he-home): chats, tasks and the team, in that order. Settings open from his account (the
/// icon atop the chats on the phone, the foot of the sidebar on a desktop); projects live in the sidebar and the chips.
/// What waits for him is not a tab (task 986): a row pinned on top of the chats opens it (decisions_screen.dart).
enum AppTab { chats, tasks, status }

class AppNav extends ChangeNotifier {
  AppTab tab = AppTab.chats;
  bool wide = false;

  void go(AppTab t) {
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
}

class NavScope extends InheritedNotifier<AppNav> {
  const NavScope({super.key, required AppNav nav, required super.child}) : super(notifier: nav);
  static AppNav of(BuildContext c) => c.dependOnInheritedWidgetOfExactType<NavScope>()!.notifier!;
  static AppNav read(BuildContext c) => c.getInheritedWidgetOfExactType<NavScope>()!.notifier!;
}

class Nav {
  /// [message]: a message of that conversation to bring into view and light for a moment, by its id or, when the
  /// id is not known, by the start of its text. [closeSheet]: the tap came from a sheet over the screen (the details
  /// of a tool), which closes first.
  static void chat(BuildContext context, String identityId, {Quote? quote, bool focus = false, ({String? id, String? text})? message, bool closeSheet = false, bool preserveRoute = false}) {
    final nav = NavScope.read(context);
    final store = StoreScope.read(context);
    final navigator = Navigator.of(context);
    if (closeSheet) navigator.pop();
    if (message != null) {
      ChatScreen.pendingTarget[identityId] = message.id ?? 'text:${message.text}';
      if (message.text != null) ChatScreen.pendingTargetText[identityId] = message.text!;
      ChatScreen.pendingFlash.add(identityId);
      if (message.id != null) ChatScreen.pendingSource.add(identityId);
    }
    if (nav.wide && !preserveRoute) {
      // A task or advanced page may have opened over the desktop shell. Reveal its main column.
      navigator.popUntil((route) => route.isFirst);
      store.selectedConversation = identityId;
      store.homeOpen = false;
      nav.go(AppTab.chats);
      store.touch();
      if (quote != null || focus) ChatScreen.pendingQuote[identityId] = quote;
      return;
    }
    if (quote != null || focus) ChatScreen.pendingQuote[identityId] = quote;
    navigator.push(MaterialPageRoute(builder: (_) => ChatScreen(identityId: identityId)));
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

  /// Every project and standing team, as a page: the folded desktop sidebar has no room for the list.
  static void projects(BuildContext context) => Navigator.of(context).push(
    MaterialPageRoute(builder: (_) => Scaffold(appBar: AppBar(), body: const SafeArea(top: false, child: ProductDirectory()))),
  );

  static void settings(BuildContext context) => Navigator.of(context).push(MaterialPageRoute(builder: (_) => const ProductSettings()));
}
