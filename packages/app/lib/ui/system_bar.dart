// System status strip (APP-SPEC §4.1): only when something is off, always in words with a time.
import 'dart:async';

import 'package:flutter/material.dart';

import '../data/store.dart';
import '../model/models.dart';
import '../theme/tokens.dart';
import 'common.dart';
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
    final st = StoreScope.of(context).status;
    _watch(st.state);
    final p = context.p;
    final (String? icon, String? text, bool spin) = switch (st.state) {
      LinkState.online => (null, null, false),
      LinkState.demo => ('info', 'הדגמה · השרת עוד לא מחובר, והתוכן לדוגמה', false),
      LinkState.connecting when !_slow => ('progress_activity', 'מתחבר…', true),
      LinkState.connecting || LinkState.offline =>
        ('cloud_off', 'אין חיבור לשרת${st.since != null ? ' מ-${st.since}' : ''}. ההתראות הדחופות ממשיכות בטלגרם.', false),
      LinkState.reconnected => ('check', 'מחובר · עודכנו ${st.updated} אירועים', false),
    };
    if (text == null) return const _NotificationsOff();
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

/// "ההתראות כבויות" (APP-SPEC §4.1): blocking questions would not arrive, so say it and offer the fix.
class _NotificationsOff extends StatelessWidget {
  const _NotificationsOff();
  @override
  Widget build(BuildContext context) {
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
                Expanded(child: Text('ההתראות כבויות, ולכן שאלות חוסמות לא יגיעו.', style: T.meta.copyWith(color: p.text2))),
                TextButton(
                  onPressed: () async {
                    final ok = await NativeBridge.instance.requestNotificationPermission();
                    if (!ok) await NativeBridge.instance.openNotificationSettings();
                    g.notificationsOff.value = !(await NativeBridge.instance.notificationsEnabled());
                  },
                  child: Text('הפעלה', style: T.meta.copyWith(color: p.accent, fontWeight: FontWeight.w700)),
                ),
              ]),
            ),
    );
  }
}
