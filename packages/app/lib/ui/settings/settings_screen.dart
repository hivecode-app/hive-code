// "עוד" → settings (APP-SPEC §4.8): the server (switching to another, sign-out), devices, focus, appearance, version. Stripe-style pairs.
// Signing in is a passkey or a pairing code (#23); hq's own token is never entered on a device.
import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../../data/backend.dart';
import '../../model/models.dart';
import '../../data/backend_select.dart';
import '../../data/auth_client.dart';
import '../../data/store.dart';
import '../../theme/tokens.dart';
import '../common.dart';
import 'devices_screen.dart';
import '../../native/native_bridge.dart';
import '../../native/native_glue.dart';

const kVersion = '0.1.0';

class SettingsScreen extends StatefulWidget {
  const SettingsScreen({super.key, this.tab = false});

  /// A bottom tab (#53): no back arrow, and the automations are here (they were on "ארגון").
  final bool tab;
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
    final autos = d?.automations ?? const <Automation>[];
    final page = Column(children: [
          TopBar(
              title: 'הגדרות',
              showLink: widget.tab,
              leading: widget.tab ? null : IBtn('arrow_forward', tip: 'חזרה', onTap: () => Navigator.of(context).maybePop())),
          Expanded(
            child: ListView(padding: EdgeInsets.zero, children: [
              if (widget.tab && d != null) ...[
                const Section('אוטומציות', top: 8),
                MoreRow(
                  icon: 'tune',
                  bold: '${autos.where((a) => a.enabled).length} פועלות',
                  rest: 'מתוך ${autos.length}${autos.any((a) => a.meta.startsWith('כובתה ידנית')) ? ' · ${autos.where((a) => a.meta.startsWith('כובתה ידנית')).length} כובו ידנית' : ''}',
                  onTap: () => Navigator.of(context).push(MaterialPageRoute(builder: (_) => const AutomationsScreen())),
                ),
              ],
              _AccountSwitch(backend: store.backend),
              const Section('מכשירים'),
              MoreRow(
                icon: 'devices',
                bold: 'מכשירים ו-passkeys',
                rest: 'ביטול וצימוד',
                onTap: () => Navigator.of(context).push(MaterialPageRoute(builder: (_) => const DevicesScreen())),
              ),
              const Section('חיבור לשרת'),
              ListBlock(inset: 16, children: [
                pair('שרת', Text(store.backend.label, key: const Key('server-host'), textDirection: TextDirection.ltr, style: T.row2.copyWith(color: p.text))),
                Padding(
                  padding: const EdgeInsets.fromLTRB(16, 12, 16, 12),
                  child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
                    // The web build belongs to its own server; the app can move to another one.
                    if (!kIsWeb) ...[
                      Text('לשרת אחר צריך קישור צימוד או QR ממנו. המכשיר נשאר מחובר לשרת הזה עד שהכניסה לחדש מצליחה.',
                          style: T.small.copyWith(color: p.text2)),
                      const SizedBox(height: 10),
                    ],
                    Wrap(spacing: 8, runSpacing: 8, children: [
                      if (!kIsWeb) Btn('החלפת שרת', icon: 'dns', onTap: busy || note != null ? null : () => kSwitchServer?.call()),
                      Btn('יציאה מהמכשיר הזה', onTap: busy || note != null ? null : _leave),
                    ]),
                    if (note != null) Padding(padding: const EdgeInsets.only(top: 10), child: Text(note!, style: T.secondary.copyWith(color: p.text))),
                  ]),
                ),
              ]),
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
        ]);
    if (widget.tab) return page;
    return Scaffold(backgroundColor: p.bg, body: SafeArea(child: page));
  }
}

/// Every automation, grouped by the worker who runs it ("noga/drift-check" is Noga's), one switch each.
class AutomationsScreen extends StatelessWidget {
  const AutomationsScreen({super.key});
  @override
  Widget build(BuildContext context) {
    final p = context.p;
    final store = StoreScope.of(context);
    final d = store.data!;
    String owner(Automation a) {
      final i = a.key.indexOf('/');
      if (i < 0) return a.team;
      final who = d.who(a.key.substring(0, i));
      return who.title.isEmpty ? who.name : '${who.name} · ${who.title}';
    }

    final groups = <String, List<Automation>>{};
    for (final a in d.automations) {
      groups.putIfAbsent(owner(a), () => []).add(a);
    }
    final order = [...groups.keys]..sort((a, b) => a == 'מערכת' ? -1 : (b == 'מערכת' ? 1 : 0));
    return Scaffold(
      backgroundColor: p.bg,
      body: SafeArea(
        child: Column(children: [
          TopBar(title: 'אוטומציות', leading: IBtn('arrow_forward', tip: 'חזרה', onTap: () => Navigator.of(context).maybePop())),
          Expanded(
            child: ListView(padding: EdgeInsets.zero, children: [
              for (final (i, g) in order.indexed) ...[
                Section(g, top: i == 0 ? 8 : 16),
                ListBlock(inset: 16, children: [
                  for (final a in groups[g]!)
                    Padding(
                      padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 12),
                      child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
                        Expanded(
                          child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                            Rich(a.sentence, maxLines: 2, style: TextStyle(fontFamily: kFont, fontSize: 15, height: 1.4, fontWeight: FontWeight.w500, color: a.enabled ? p.text : p.text2)),
                            const SizedBox(height: 2),
                            Text(a.meta, style: T.small.copyWith(color: p.text2)),
                          ]),
                        ),
                        const SizedBox(width: 12),
                        Toggle(on: a.enabled, label: a.sentence, onTap: () => store.toggleAutomation(a)),
                      ]),
                    ),
                ]),
              ],
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

  /// [note] is a refusal of hq's (shown as an error, and sent).
  bool noteFailed = false;
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
        noteFailed = !r.ok && !r.transient;
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
        if (note != null && noteFailed)
          ShownError(note!, screen: 'הגדרות · חשבונות', padding: const EdgeInsets.fromLTRB(16, 0, 16, 11))
        else if (note != null)
          Padding(padding: const EdgeInsets.fromLTRB(16, 0, 16, 11), child: Text(note!, style: T.secondary.copyWith(color: p.text))),
      ]),
    ]);
  }
}
