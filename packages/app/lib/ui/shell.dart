import 'package:agent_company/l10n/ui_copy.dart';
// App frame. Phone (<800px): one column + bottom navigation (mockup `.nav`).
// Desktop (APP-SPEC §8.1): rail · list · main · context, the context column from 1280px.
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../data/backend.dart';
import '../data/store.dart';
import '../theme/motion.dart';
import '../theme/tokens.dart';
import 'common.dart';
import 'convs/conversations_screen.dart';
import 'desktop.dart';
import 'nav.dart';
import 'projects/projects_screen.dart';
import 'settings/settings_screen.dart';
import 'status/status_screen.dart';
import 'system_bar.dart';

class Shell extends StatelessWidget {
  const Shell({super.key});

  @override
  Widget build(BuildContext context) {
    UiCopy.watch(context);
    final nav = NavScope.of(context);
    if (nav.tab == AppTab.tasks) nav.tab = AppTab.chats;
    final store = StoreScope.of(context);
    nav.onLeaveStatus = store.markStatusSeen;
    nav.onLeaveChats = () => store.markChatsSeen(CompanyTime.now());
    return LayoutBuilder(builder: (context, c) {
      // A phone on its side (up to ~930 x 430dp) stays a phone, the way WhatsApp does, instead of
      // squeezing three columns into 411dp of height. A short but wide window (a laptop browser
      // made short) is still a desktop. The keyboard can't flip this: it never shrinks these
      // constraints (it only sets viewInsets).
      nav.wide = c.maxWidth >= 800 && (c.maxHeight >= 560 || c.maxWidth >= 1100);
      final p = context.p;
      final body = store.data == null
          ? const _FirstLoad()
          : nav.wide
          ? DesktopFrame(width: c.maxWidth)
          : Column(children: [
              Expanded(
                // Only the tab on screen follows the store; the others catch up when shown.
                child: (kDesignV2 ? FadeThroughIndexedStack.new : _plainStack)(index: nav.tab.index, children: [
                  StoreGate(active: nav.tab == AppTab.chats, child: const ConversationsScreen()),
                  StoreGate(active: nav.tab == AppTab.status, child: const StatusScreen()),
                  StoreGate(active: nav.tab == AppTab.projects, child: const ProjectsScreen()),
                  StoreGate(active: nav.tab == AppTab.settings, child: const SettingsScreen(tab: true)),
                ]),
              ),
              const BottomNav(),
            ]);
      return AnnotatedRegion<SystemUiOverlayStyle>(
        value: (p.dark ? SystemUiOverlayStyle.light : SystemUiOverlayStyle.dark).copyWith(
          statusBarColor: Colors.transparent,
          systemNavigationBarColor: nav.wide ? p.bg : p.surface,
        ),
        // Android back on another tab goes to home first, then leaves the app (as WhatsApp does).
        child: PopScope(
          canPop: (nav.wide || nav.tab == AppTab.chats) && nav.backHandler == null,
          onPopInvokedWithResult: (didPop, _) {
            if (didPop) return;
            final close = nav.backHandler;
            if (close != null) {
              close(); // an open search closes first
            } else {
              nav.go(AppTab.chats);
            }
          },
          child: Scaffold(
            backgroundColor: p.bg,
            body: SafeArea(bottom: true, child: Stack(children: [body, if (store.error != null) _ErrorBar(store.error!)])),
          ),
        ),
      );
    });
  }
}

Widget _plainStack({required int index, required List<Widget> children}) => IndexedStack(index: index, children: children);

/// Error as a bar with "הבנתי" (design-taste E16): it stays until dismissed.
class _ErrorBar extends StatelessWidget {
  const _ErrorBar(this.text);
  final String text;
  @override
  Widget build(BuildContext context) {
    UiCopy.watch(context);
    final p = context.p;
    return PositionedDirectional(
      start: 12,
      end: 12,
      top: 8,
      child: Material(
        color: p.surface,
        elevation: 0,
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(10), side: BorderSide(color: p.line)),
        child: Padding(
          padding: const EdgeInsets.fromLTRB(14, 8, 8, 8),
          child: Row(children: [
            Ic('error', size: 18, fill: true, color: p.urgent),
            const SizedBox(width: 8),
            Expanded(
              child: Column(crossAxisAlignment: CrossAxisAlignment.start, mainAxisSize: MainAxisSize.min, children: [
                Text(text, style: T.secondary.copyWith(color: p.text)),
                if (StoreScope.of(context).errorReported) const SentNote(),
              ]),
            ),
            TextButton(onPressed: StoreScope.read(context).clearError, child: Text(UiCopy.text(737), style: T.secondary.copyWith(color: p.accent, fontWeight: FontWeight.w700))),
          ]),
        ),
      ),
    );
  }
}

class NavDest {
  const NavDest(this.tab, this.icon, this.label);
  final AppTab tab;
  final String icon;
  final String label;
}

List<NavDest> get kDests => [
  NavDest(AppTab.chats, 'chat', UiCopy.text(471)),
  NavDest(AppTab.status, 'monitor_heart', UiCopy.text(738)),
  NavDest(AppTab.projects, 'folder', UiCopy.text(631)),
  NavDest(AppTab.settings, 'settings', UiCopy.text(702)),
];

/// Mockup `.nav`: 72dp, pill 56x30 in accent-soft on the active tab, FILL 1 icon,
/// count on home = things waiting for you, count on chats = unread messages, muted ones left out.
class BottomNav extends StatelessWidget {
  const BottomNav({super.key});
  @override
  Widget build(BuildContext context) {
    UiCopy.watch(context);
    final nav = NavScope.of(context);
    final d = StoreScope.of(context).data;
    final p = context.p;
    return Container(
      height: 72,
      decoration: BoxDecoration(color: p.surface, border: Border(top: BorderSide(color: p.line))),
      child: Row(children: [
        for (final dest in kDests)
          Expanded(
            child: NavItem(
              dest: dest,
              on: nav.tab == dest.tab,
              count: navCount(dest.tab, d),
              onTap: () => nav.go(dest.tab),
            ),
          ),
      ]),
    );
  }
}

/// The number on a tab: "בית" counts what waits for him, "שיחות" the messages he hasn't read.
int? navCount(AppTab tab, CompanyData? d) => switch (tab) {
      AppTab.chats => d?.unreadCount,
      _ => null,
    };

class NavItem extends StatelessWidget {
  const NavItem({super.key, required this.dest, required this.on, this.count, this.dot = false, this.warn = false, required this.onTap, this.pillWidth = 56, this.fontSize = 12});
  final NavDest dest;
  final bool on;
  final int? count;
  final bool dot;
  final bool warn;
  final VoidCallback onTap;
  final double pillWidth;
  final double fontSize;

  @override
  Widget build(BuildContext context) {
    UiCopy.watch(context);
    final p = context.p;
    final color = on ? p.text : p.text2;
    return Semantics(
      selected: on,
      button: true,
      label: count != null && count! > 0 ? '${dest.label}, $count ${dest.tab == AppTab.chats ? UiCopy.text(739) : UiCopy.text(740)}' : dest.label,
      child: InkWell(
        onTap: onTap,
        child: Column(mainAxisAlignment: MainAxisAlignment.center, children: [
          SizedBox(
            width: pillWidth,
            height: 30,
            child: Stack(clipBehavior: Clip.none, children: [
              AnimatedContainer(
                // v2: the indicator fades in with the tab (M3 navigation bar); v1 switched at once.
                duration: kDesignV2 ? Mo.sm : Duration.zero,
                curve: Mo.standard,
                width: pillWidth,
                height: 30,
                decoration: BoxDecoration(color: on ? p.accentSoft : p.accentSoft.withValues(alpha: 0), borderRadius: BorderRadius.circular(15)),
                alignment: Alignment.center,
                child: Ic(dest.icon, fill: on, color: color),
              ),
              if (count != null && count! > 0)
                PositionedDirectional(
                  top: -1,
                  start: pillWidth / 2 + 3,
                  child: Container(
                    constraints: const BoxConstraints(minWidth: 18),
                    height: 18,
                    padding: const EdgeInsets.symmetric(horizontal: 5),
                    // The count in the brand, ringed by the bar so it sits on the icon cleanly (v2, audit #6).
                    decoration: BoxDecoration(color: p.accent, borderRadius: BorderRadius.circular(9), border: Border.all(color: p.surface, width: 2)),
                    alignment: Alignment.center,
                    child: Text('$count', style: TextStyle(fontFamily: kFont, fontSize: 11, height: 1, fontWeight: FontWeight.w700, color: p.onAccent)),
                  ),
                ),
              if (dot)
                PositionedDirectional(
                  top: 4,
                  start: pillWidth / 2 + 7,
                  child: Container(width: 7, height: 7, decoration: BoxDecoration(color: p.text, shape: BoxShape.circle)),
                ),
              if (warn) PositionedDirectional(top: -2, start: pillWidth / 2 + 4, child: Ic('warning', size: 15, fill: true, color: p.text)),
            ]),
          ),
          const SizedBox(height: 3),
          Text(dest.label, style: TextStyle(fontFamily: kFont, fontSize: fontSize, height: 1.3, fontWeight: on ? FontWeight.w700 : FontWeight.w500, color: color)),
        ]),
      ),
    );
  }
}

/// First start before any data (no cache yet): the screen is up at once with a spinner and a
/// word, and the system strip turns it into a sentence after 10s (APP-SPEC §7.5).
class _FirstLoad extends StatelessWidget {
  const _FirstLoad();
  @override
  Widget build(BuildContext context) {
    UiCopy.watch(context);
    final p = context.p;
    return Column(children: [
       TopBar(title: UiCopy.text(3), showLink: true),
      const SystemBar(),
      Expanded(
        child: Center(
          child: LoadingWatch(
            screen: UiCopy.text(741),
            child: Row(mainAxisSize: MainAxisSize.min, children: [
              Spin(child: Ic('progress_activity', size: 20, color: p.text2)),
              const SizedBox(width: 8),
              Text(UiCopy.text(640), style: T.secondary.copyWith(color: p.text2)),
            ]),
          ),
        ),
      ),
    ]);
  }
}
