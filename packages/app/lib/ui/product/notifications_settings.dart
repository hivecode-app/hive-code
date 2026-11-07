// Settings → notifications: when the phone rings, when it stays quiet, and what the number on the app means.
// Every line here is what hq does, not a wish: `alertLevel` in packages/hq/src/conversations.ts for a worker's
// message, `pushWorthy` in inbox.ts for what waits on him, and the 20 seconds of ALERT_DELAY_MS
// (docs/product/notifications-policy.md). A change there changes this page in the same PR.
import 'package:flutter/material.dart';

import '../../data/store.dart';
import '../../l10n/app_localizations.dart';
import '../../native/native_bridge.dart';
import '../../theme/tokens.dart';
import '../common.dart';

enum AlertWord { ring, silent, badge, none }

class NotificationsSettings extends StatelessWidget {
  const NotificationsSettings({super.key});

  @override
  Widget build(BuildContext context) {
    final store = StoreScope.of(context), l = AppLocalizations.of(context), p = context.p;
    final d = store.data;
    final push = d?.automations.where((a) => a.key == 'push').firstOrNull;
    String word(AlertWord w) => switch (w) { AlertWord.ring => l.notifRing, AlertWord.silent => l.notifSilent, AlertWord.badge => l.notifBadge, AlertWord.none => l.notifNone };
    Widget toggle(String title, String hint, bool on, VoidCallback onTap, Key key) => InkWell(
          key: key,
          onTap: onTap,
          child: Padding(
            padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 12),
            child: Row(children: [
              Expanded(
                child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                  Text(title, style: T.body.copyWith(color: p.text)),
                  Text(hint, style: T.small.copyWith(color: p.text2)),
                ]),
              ),
              const SizedBox(width: 16),
              Toggle(on: on, onTap: onTap, label: title),
            ]),
          ),
        );
    Widget event(String title, AlertWord w, {String? hint}) => Semantics(
          container: true,
          child: Padding(
            padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 12),
            child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
              Expanded(
                child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                  Text(title, style: T.body.copyWith(color: p.text)),
                  if (hint != null) Text(hint, style: T.small.copyWith(color: p.text2)),
                ]),
              ),
              const SizedBox(width: 16),
              Text(word(w), style: T.row2.copyWith(color: w == AlertWord.ring ? p.text : p.text2, fontWeight: w == AlertWord.ring ? FontWeight.w700 : FontWeight.w400)),
            ]),
          ),
        );
    Widget para(String title, String body) => Padding(
          padding: const EdgeInsets.fromLTRB(16, 20, 16, 0),
          child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            Text(title, style: T.section.copyWith(color: p.text)),
            const SizedBox(height: 4),
            Text(body, style: T.row2.copyWith(color: p.text2)),
          ]),
        );

    return Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
      if (d != null)
        ListBlock(inset: 16, children: [
          if (push != null) toggle(l.notifications, l.notifPushHint, push.enabled, () => store.toggleAutomation(push), const Key('notif-push')),
          toggle(l.focus, l.focusHint, d.focus, store.toggleFocus, const Key('notif-focus')),
          if (d.night != null)
            Padding(
              padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 12),
              child: Row(children: [
                Ic('bedtime', size: 20, color: p.text2),
                const SizedBox(width: 12),
                Expanded(child: Text(l.notifNightOn, style: T.row2.copyWith(color: p.text))),
              ]),
            ),
          if (NativeBridge.instance.supported)
            InkWell(
              onTap: () => NativeBridge.instance.openNotificationSettings(),
              child: Padding(
                padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 14),
                child: Row(children: [
                  Expanded(child: Text(l.notifDevice, style: T.body.copyWith(color: p.text))),
                  Ic(chevronIcon(context), size: 20, color: p.text3),
                ]),
              ),
            ),
        ]),
      Section(l.notifWhen, top: 24),
      ListBlock(inset: 16, children: [
        Padding(
          padding: const EdgeInsets.fromLTRB(16, 10, 16, 6),
          child: Row(children: [
            Expanded(child: Text(l.notifEvent, style: T.small.copyWith(color: p.text3))),
            Text(l.notifAlert, style: T.small.copyWith(color: p.text3)),
          ]),
        ),
        event(l.notifGo, AlertWord.ring),
        event(l.notifAsk, AlertWord.ring),
        event(l.notifLogin, AlertWord.ring),
        event(l.notifMessage, AlertWord.ring, hint: l.notifMessageHint),
        event(l.notifUrgent, AlertWord.ring, hint: l.notifUrgentHint),
        event(l.notifEta, AlertWord.silent),
        event(l.notifFyi, AlertWord.badge),
        event(l.notifSoftAsk, AlertWord.none, hint: l.notifSoftAskHint),
      ]),
      para(l.focusAndNight, l.notifFocusBody),
      para(l.notifNeverTitle, l.notifNeverBody),
      para(l.notifBadgeTitle, l.notifBadgeBody),
      para(l.notifTogetherTitle, l.notifTogetherBody),
    ]);
  }
}
