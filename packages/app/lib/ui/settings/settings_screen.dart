// "עוד" → settings (APP-SPEC §4.8): data source, devices, focus, appearance, version. Stripe-style pairs.
// Signing in is a passkey or a pairing code (#23); hq's own token is never entered on a device.
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:shared_preferences/shared_preferences.dart';

import '../../data/backend_select.dart';
import '../../data/auth_client.dart';
import '../../data/store.dart';
import '../../theme/tokens.dart';
import '../common.dart';
import '../org/org_screen.dart';
import 'devices_screen.dart';
import '../../native/native_bridge.dart';
import '../../native/native_glue.dart';

const kVersion = '0.1.0';

class SettingsScreen extends StatefulWidget {
  const SettingsScreen({super.key});
  @override
  State<SettingsScreen> createState() => _SettingsScreenState();
}

class _SettingsScreenState extends State<SettingsScreen> {
  String? note;
  bool busy = false;

  /// Leaving the real company on this device (demo, or back to sign-in) revokes its token in hq
  /// first, so no live token is left behind in the devices list (#23).
  Future<void> _leave({required bool demo}) async {
    setState(() => busy = true);
    try {
      final s = await savedSession();
      if (s != null) {
        final c = AuthClient(s.baseUrl);
        try {
          final list = await c.devices(s.token);
          final me = list.devices.where((d) => d.current).firstOrNull;
          if (me != null) await c.revokeDevice(s.token, me.id);
        } on AuthFailure {
          // Offline or already revoked: the token is dropped here anyway; the devices screen can revoke it later.
        } finally {
          c.close();
        }
      }
      await clearSession();
      final p = await SharedPreferences.getInstance();
      if (demo) {
        await p.setBool(kDemo, true);
      } else {
        await p.remove(kDemo);
      }
      await kGlue?.syncConfig();
      if (mounted) setState(() => note = demo ? 'בפתיחה הבאה האפליקציה תציג את ההדגמה.' : 'בפתיחה הבאה האפליקציה תבקש כניסה.');
    } finally {
      if (mounted) setState(() => busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final p = context.p;
    final store = StoreScope.of(context);
    final d = store.data;
    Widget pair(String k, Widget v) => Padding(
          padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 11),
          child: Row(children: [Text(k, style: T.row2.copyWith(color: p.text2)), const SizedBox(width: 12), Expanded(child: Align(alignment: AlignmentDirectional.centerEnd, child: v))]),
        );
    return Scaffold(
      backgroundColor: p.bg,
      body: SafeArea(
        child: Column(children: [
          TopBar(title: 'הגדרות', leading: IBtn('arrow_forward', tip: 'חזרה', onTap: () => Navigator.of(context).maybePop())),
          Expanded(
            child: ListView(padding: EdgeInsets.zero, children: [
              const Section('שרת', top: 8),
              ListBlock(inset: 16, children: [
                pair('מקור הנתונים', Text(store.backend.label, style: T.row2.copyWith(color: p.text))),
                Padding(
                  padding: const EdgeInsets.fromLTRB(16, 12, 16, 12),
                  child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
                    Wrap(spacing: 8, runSpacing: 8, crossAxisAlignment: WrapCrossAlignment.center, children: [
                      Btn('הדגמה', onTap: busy ? null : () => _leave(demo: true)),
                      Btn('חברה אמיתית', onTap: busy ? null : () => _leave(demo: false)),
                    ]),
                    if (note != null) Padding(padding: const EdgeInsets.only(top: 10), child: Text(note!, style: T.secondary.copyWith(color: p.text))),
                  ]),
                ),
              ]),
              const Section('מכשירים'),
              MoreRow(
                icon: 'devices',
                bold: 'מכשירים ו-passkeys',
                rest: 'ביטול וצימוד',
                onTap: () => Navigator.of(context).push(MaterialPageRoute(builder: (_) => const DevicesScreen())),
              ),
              const Section('התראות'),
              ListBlock(inset: 16, children: [
                pair('פוקוס', Toggle(on: d?.focus ?? false, label: 'פוקוס', onTap: store.toggleFocus)),
                if (NativeBridge.instance.supported)
                  Padding(
                    padding: const EdgeInsets.fromLTRB(16, 12, 16, 12),
                    child: Wrap(spacing: 8, runSpacing: 8, children: [
                      Btn('הרשאת התראות', onTap: () => NativeBridge.instance.requestNotificationPermission()),
                      Btn('התראות לדוגמה', onTap: () async {
                        final ok = await NativeBridge.instance.showDemoNotifications();
                        if (!ok) await NativeBridge.instance.requestNotificationPermission();
                      }),
                      Btn('פטור מחיסכון בסוללה', onTap: () => NativeBridge.instance.requestBatteryExemption()),
                    ]),
                  ),
                Padding(
                  padding: const EdgeInsets.fromLTRB(16, 11, 16, 11),
                  child: Text('בפוקוס ההתראות נאספות בשקט, ותקלה דחופה בפרודקשן עוברת בכל מקרה.', style: T.small.copyWith(color: p.text2)),
                ),
              ]),
              const Section('תצוגה'),
              ListBlock(inset: 16, children: [
                pair('מצב כהה', Text('לפי המכשיר', style: T.row2.copyWith(color: p.text))),
                pair('גודל טקסט', Text('לפי המכשיר, עד 130%', style: T.row2.copyWith(color: p.text))),
              ]),
              const Section('אודות'),
              ListBlock(inset: 16, children: [
                pair('גרסה', GestureDetector(onLongPress: () => Clipboard.setData(const ClipboardData(text: kVersion)), child: Text(kVersion, style: T.mono(13).copyWith(color: p.text)))),
              ]),
              const SizedBox(height: 24),
            ]),
          ),
        ]),
      ),
    );
  }
}
