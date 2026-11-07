import 'package:agent_company/l10n/ui_copy.dart';
// System status strip (APP-SPEC §4.1): only when something is off, always in words with a time.
// Connecting and "updated" are not "off": they show as a small word next to the title (LinkHint,
// §4.2), so the screen never jumps when the link comes up.
import 'dart:async';

import 'package:flutter/material.dart';

import '../data/error_report.dart';
import '../data/store.dart';
import '../model/models.dart';
import '../theme/tokens.dart';
import 'common.dart';
import 'nav.dart';
import '../l10n/app_localizations.dart';
import '../native/app_update.dart';
import '../native/native_bridge.dart';
import '../native/native_glue.dart';

class SystemBar extends StatefulWidget {
  const SystemBar({super.key});
  @override
  State<SystemBar> createState() => _SystemBarState();
}

class _SystemBarState extends State<SystemBar> {
  Timer? _t;
  bool _slow = false;
  LinkState? _last;

  @override
  void dispose() {
    _t?.cancel();
    super.dispose();
  }

  void _watch(LinkState s) {
    if (s == _last) return;
    _last = s;
    _t?.cancel();
    _slow = false;
    // After 10s the spinner is replaced by a sentence that says what happened (§7.5).
    if (s == LinkState.connecting) _t = Timer(const Duration(seconds: 10), () => mounted ? setState(() => _slow = true) : null);
  }

  @override
  Widget build(BuildContext context) {
    UiCopy.watch(context);
    final st = StoreScope.of(context).status;
    _watch(st.state);
    final p = context.p;
    final (String? icon, String? text, bool spin) = switch (st.state) {
      LinkState.online || LinkState.reconnected => (null, null, false),
      LinkState.demo => ('info', UiCopy.copy.demoServerNot, false),
      LinkState.connecting when !_slow => (null, null, false),
      LinkState.connecting || LinkState.offline =>
        ('cloud_off', UiCopy.copy.noConnectionServer(st.since != null ? UiCopy.copy.since5(st.since!) : ''), false),
    };
    // Offline: no update strip either, it could not download anyway.
    if (text == null) return const Column(mainAxisSize: MainAxisSize.min, children: [_NotificationsOff(), _GlueUpdateStrip()]);
    Widget ic = Ic(icon!, size: 17, color: p.text2);
    if (spin) ic = Spin(child: ic);
    return Semantics(
      liveRegion: true,
      child: Container(
        width: double.infinity,
        padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 6),
        color: p.surface2,
        child: Row(children: [
          ic,
          const SizedBox(width: 6),
          Expanded(child: Text(text, style: T.meta.copyWith(color: p.text2))),
        ]),
      ),
    );
  }
}

/// The chats' head when the link is down (mockup a-he-trouble-phone): a framed card that says since when, that the
/// work goes on, and where to look. Anything else that is off is the usual strip.
class OfflineCard extends StatelessWidget {
  const OfflineCard({super.key});
  @override
  Widget build(BuildContext context) {
    final st = StoreScope.of(context).status;
    if (st.state != LinkState.offline) return const SystemBar();
    final l = AppLocalizations.of(context), p = context.p;
    return Semantics(
      liveRegion: true,
      child: Container(
        margin: const EdgeInsetsDirectional.fromSTEB(16, 0, 16, 12),
        padding: const EdgeInsetsDirectional.fromSTEB(16, 14, 16, 12),
        decoration: BoxDecoration(color: p.surface, borderRadius: BorderRadius.circular(12), border: Border.all(color: p.text3)),
        child: Row(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Ic('cloud_off', size: 22, color: p.text),
            const SizedBox(width: 12),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(st.since == null ? l.offlineNow : l.offlineSince(st.since!), style: T.name.copyWith(fontWeight: FontWeight.w600, color: p.text)),
                  const SizedBox(height: 4),
                  Text(l.offlineBody, style: T.small.copyWith(color: p.text2)),
                  const SizedBox(height: 4),
                  // A row that reads as an action, as in settings: the words and the forward chevron; a button to a reader.
                  Semantics(
                    button: true,
                    child: InkWell(
                      onTap: () => Nav.settings(context),
                      borderRadius: BorderRadius.circular(6),
                      child: ConstrainedBox(
                        constraints: const BoxConstraints(minHeight: 48),
                        child: Row(
                          children: [
                            Expanded(child: Text(l.troubleshoot, style: T.small.copyWith(color: p.text, fontWeight: FontWeight.w600))),
                            Ic(chevronIcon(context), size: 20, color: p.text2),
                          ],
                        ),
                      ),
                    ),
                  ),
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }
}

/// Next to a screen's title (APP-SPEC §4.2): a small spinner with "מתעדכן" while the link comes up,
/// then "עודכן" for a moment after a reconnect. Shown only if connecting takes more than half a
/// second, so a quick start doesn't flash it. It sits in the title row, so nothing below it moves.
class LinkHint extends StatefulWidget {
  const LinkHint({super.key});
  @override
  State<LinkHint> createState() => _LinkHintState();
}

class _LinkHintState extends State<LinkHint> {
  Timer? _t;
  bool _shown = false;
  LinkState? _last;

  @override
  void dispose() {
    _t?.cancel();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    UiCopy.watch(context);
    final st = StoreScope.maybeOf(context)?.status.state;
    if (st != _last) {
      _last = st;
      _t?.cancel();
      _shown = false;
      if (st == LinkState.connecting) _t = Timer(const Duration(milliseconds: 500), () => mounted ? setState(() => _shown = true) : null);
    }
    final p = context.p;
    final style = T.meta.copyWith(color: p.text2);
    final child = switch (st) {
      LinkState.connecting when _shown => Row(mainAxisSize: MainAxisSize.min, key: const ValueKey('c'), children: [
          Spin(child: Ic('progress_activity', size: 15, color: p.text2)),
          const SizedBox(width: 4),
          Text(UiCopy.copy.updating, style: style),
        ]),
      LinkState.reconnected => Row(mainAxisSize: MainAxisSize.min, key: const ValueKey('r'), children: [
          Ic('check', size: 15, color: p.text2),
          const SizedBox(width: 4),
          Text(UiCopy.copy.updated, style: style),
        ]),
      _ => const SizedBox.shrink(key: ValueKey('n')),
    };
    return AnimatedSwitcher(duration: const Duration(milliseconds: 150), child: child);
  }
}

/// "ההתראות כבויות" (APP-SPEC §4.1): blocking questions would not arrive, so say it and offer the fix.
class _NotificationsOff extends StatelessWidget {
  const _NotificationsOff();
  @override
  Widget build(BuildContext context) {
    UiCopy.watch(context);
    final g = kGlue;
    if (g == null) return const SizedBox.shrink();
    final p = context.p;
    return ValueListenableBuilder<bool>(
      valueListenable: g.notificationsOff,
      builder: (context, off, _) => !off
          ? const SizedBox.shrink()
          : Container(
              width: double.infinity,
              padding: const EdgeInsetsDirectional.fromSTEB(16, 4, 8, 4),
              color: p.surface2,
              child: Row(children: [
                Ic('notifications_off', size: 17, color: p.text2),
                const SizedBox(width: 6),
                Expanded(child: Text(UiCopy.copy.notificationsOffQuestions, style: T.meta.copyWith(color: p.text2))),
                TextButton(
                  onPressed: () async {
                    final ok = await NativeBridge.instance.requestNotificationPermission();
                    if (!ok) await NativeBridge.instance.openNotificationSettings();
                    g.notificationsOff.value = !(await NativeBridge.instance.notificationsEnabled());
                  },
                  child: Text(UiCopy.copy.play, style: T.meta.copyWith(color: p.accent, fontWeight: FontWeight.w700)),
                ),
              ]),
            ),
    );
  }
}

class _GlueUpdateStrip extends StatelessWidget {
  const _GlueUpdateStrip();
  @override
  Widget build(BuildContext context) {
    UiCopy.watch(context);
    final g = kGlue;
    return g == null || !g.update.supported ? const SizedBox.shrink() : UpdateStrip(update: g.update);
  }
}

/// A newer APK on hq (app_update.dart): "עדכון" downloads it and opens Android's installer. A strip
/// with a close button, never a bar that vanishes by itself; the download is a ring with an X in
/// the middle that cancels, like WhatsApp (design-taste §6).
class UpdateStrip extends StatelessWidget {
  const UpdateStrip({super.key, required this.update});
  final AppUpdate update;

  @override
  Widget build(BuildContext context) {
    UiCopy.watch(context);
    return ListenableBuilder(listenable: update, builder: (context, _) {
      final p = context.p;
      final meta = T.meta.copyWith(color: p.text2);
      Widget action(String label, VoidCallback onTap) =>
          TextButton(onPressed: onTap, child: Text(label, style: T.meta.copyWith(color: p.accent, fontWeight: FontWeight.w700)));
      final close = IconButton(
        onPressed: update.dismiss,
        tooltip: UiCopy.copy.notNow2,
        visualDensity: VisualDensity.compact,
        icon: Ic('close', size: 17, color: p.text2),
      );
      final pct = (update.progress * 100).floor();
      final List<Widget> row = switch (update.phase) {
        UpdatePhase.none => const [],
        UpdatePhase.available => [
            Ic('system_update', size: 17, color: p.text2),
            const SizedBox(width: 6),
            Expanded(child: Text(UiCopy.copy.newAppVersion, style: meta)),
            action(UiCopy.copy.update, update.install),
            close,
          ],
        UpdatePhase.needsPermission => [
            Ic('system_update', size: 17, color: p.text2),
            const SizedBox(width: 6),
            Expanded(child: Text(UiCopy.copy.allowUpdateInstallation, style: meta)),
            action(UiCopy.copy.settings2, update.install),
            close,
          ],
        UpdatePhase.downloading => [
            Tooltip(
              message: UiCopy.copy.cancelDownload,
              child: InkResponse(
                onTap: update.cancel,
                radius: 18,
                child: SizedBox(
                  width: 28,
                  height: 28,
                  child: Stack(alignment: Alignment.center, children: [
                    SizedBox(
                      width: 22,
                      height: 22,
                      child: CircularProgressIndicator(
                        value: update.progress > 0 ? update.progress : null,
                        strokeWidth: 2,
                        color: p.accent,
                        backgroundColor: p.line,
                      ),
                    ),
                    Ic('close', size: 12, color: p.text2),
                  ]),
                ),
              ),
            ),
            const SizedBox(width: 6),
            Expanded(child: Text(UiCopy.copy.downloadingAppUpdate(pct), style: meta)),
          ],
        UpdatePhase.installing => [
            Spin(child: Ic('progress_activity', size: 17, color: p.text2)),
            const SizedBox(width: 6),
            Expanded(child: Text(UiCopy.copy.confirmInstallationAndroid, style: meta)),
            close,
          ],
        UpdatePhase.failed => [
            Ic('error', size: 17, color: p.text2),
            const SizedBox(width: 6),
            Expanded(child: Text(UiCopy.copy.updateFailed(ErrorReports.instance.active ? ' ${SentNote.text}.' : ''), style: meta)),
            action(UiCopy.copy.tryAgain, update.install),
            close,
          ],
      };
      if (row.isEmpty) return const SizedBox.shrink();
      return Semantics(
        liveRegion: true,
        child: Container(
          width: double.infinity,
          constraints: const BoxConstraints(minHeight: 40),
          padding: const EdgeInsetsDirectional.fromSTEB(16, 2, 4, 2),
          color: p.surface2,
          child: Row(children: row),
        ),
      );
    });
  }
}
