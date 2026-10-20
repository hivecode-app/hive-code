// "עוד" → settings (APP-SPEC §4.8): server and sign-out, devices, focus, appearance, version. Stripe-style pairs.
// Signing in is a passkey or a pairing code (#23); hq's own token is never entered on a device.
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../../data/backend.dart';
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

  /// Signing this device out revokes its token in hq first, so no live token is left behind in the
  /// devices list (#23).
  Future<void> _leave() async {
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
      await kGlue?.syncConfig();
      // Back to sign-in now: the running link would otherwise go on with a token that is gone.
      final out = kSignOut;
      if (out != null) {
        out('המכשיר יצא מהחברה. אפשר להיכנס שוב.');
      } else if (mounted) {
        setState(() => note = 'המכשיר יצא מהחברה. בפתיחה הבאה האפליקציה תבקש כניסה.');
      }
    } catch (_) {
      if (mounted) setState(() => note = 'היציאה לא הושלמה. אפשר לנסות שוב.');
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
                pair('כתובת', Text(store.backend.label, textDirection: TextDirection.ltr, style: T.row2.copyWith(color: p.text))),
                Padding(
                  padding: const EdgeInsets.fromLTRB(16, 12, 16, 12),
                  child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
                    Align(alignment: AlignmentDirectional.centerStart, child: Btn('יציאה מהמכשיר הזה', onTap: busy || note != null ? null : _leave)),
                    if (note != null) Padding(padding: const EdgeInsets.only(top: 10), child: Text(note!, style: T.secondary.copyWith(color: p.text))),
                  ]),
                ),
              ]),
              _AccountSwitch(backend: store.backend),
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

/// B.7 "החלפה בלחיצה": which account the company runs on. Shown only when the backend has accounts.
class _AccountSwitch extends StatefulWidget {
  const _AccountSwitch({required this.backend});
  final Backend backend;
  @override
  State<_AccountSwitch> createState() => _AccountSwitchState();
}

class _AccountSwitchState extends State<_AccountSwitch> {
  AccountsView? view;
  String? note;
  bool busy = false;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    final v = await widget.backend.accounts();
    if (mounted) setState(() => view = v);
  }

  Future<void> _pin(String? name) async {
    setState(() {
      busy = true;
      note = null;
    });
    final r = await widget.backend.pinAccount(name);
    await _load();
    if (mounted) {
      setState(() {
        busy = false;
        note = r.ok ? (name == null ? 'החברה בוחרת לבד לפי המקום שנשאר.' : 'משמרות חדשות הולכות לחשבון הזה, והחיות עוברות בסוף התור הנוכחי.') : r.error;
      });
    }
  }

  @override
  Widget build(BuildContext context) {
    final v = view;
    if (v == null) return const SizedBox.shrink();
    final p = context.p;
    String state(AccountInfo a) {
      if (!a.usable) return a.note ?? 'לא מחובר';
      if (a.blocked) return 'חסום: מכסה';
      final room = a.room == null ? '' : ' · ${a.room!.round()}% פנוי';
      return '${a.name == v.active ? 'בשימוש' : 'זמין'}$room';
    }

    return Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
      const Section('חשבון'),
      ListBlock(inset: 16, children: [
        for (final a in v.accounts)
          Padding(
            padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 9),
            child: Row(children: [
              Expanded(
                child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                  Text(a.label, style: T.row2.copyWith(color: p.text)),
                  Text(state(a), style: T.small.copyWith(color: p.text2)),
                ]),
              ),
              if (a.usable)
                v.pinned == a.name
                    ? Text('כולם כאן', style: T.small.copyWith(color: p.text2))
                    : Btn('העבר לכאן', onTap: busy ? null : () => _pin(a.name)),
            ]),
          ),
        Padding(
          padding: const EdgeInsets.fromLTRB(16, 4, 16, 11),
          child: Row(children: [
            Expanded(child: Text(v.pinned == null ? 'אוטומטי: לחשבון עם הכי הרבה מקום, ומעבר לבד כשחשבון נגמר.' : 'נעוץ ידנית.', style: T.small.copyWith(color: p.text2))),
            if (v.pinned != null) Btn('אוטומטי', onTap: busy ? null : () => _pin(null)),
          ]),
        ),
        if (note != null) Padding(padding: const EdgeInsets.fromLTRB(16, 0, 16, 11), child: Text(note!, style: T.secondary.copyWith(color: p.text))),
      ]),
    ]);
  }
}
