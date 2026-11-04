import 'package:agent_company/l10n/input_copy.dart';
import 'package:agent_company/l10n/ui_copy.dart';
import '../../l10n/app_localizations.dart';
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
        out(UiCopy.text(699));
      } else if (mounted) {
        setState(() => note = UiCopy.text(700));
      }
    } catch (_) {
      if (mounted) setState(() => note = UiCopy.text(701));
    } finally {
      if (mounted) setState(() => busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    UiCopy.watch(context);
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
              title: UiCopy.text(702),
              showLink: widget.tab,
              leading: widget.tab ? null : IBtn(backIcon(context), tip: UiCopy.text(161), onTap: () => Navigator.of(context).maybePop())),
          Expanded(
            child: ListView(padding: EdgeInsets.zero, children: [
              if (widget.tab && d != null) ...[
                 Section(UiCopy.text(703), top: 8),
                MoreRow(
                  icon: 'tune',
                  bold: UiCopy.text(704, [autos.where((a) => a.enabled).length]),
                  rest: UiCopy.text(706, [autos.length, autos.any((a) => a.meta.startsWith(InputCopy.v17)) ? UiCopy.text(705, [autos.where((a) => a.meta.startsWith(InputCopy.v17)).length]) : '']),
                  onTap: () => Navigator.of(context).push(MaterialPageRoute(builder: (_) => const AutomationsScreen())),
                ),
              ],
              AccountSwitch(backend: store.backend),
               Section(UiCopy.text(684)),
              MoreRow(
                icon: 'devices',
                bold: UiCopy.text(707),
                rest: UiCopy.text(708),
                onTap: () => Navigator.of(context).push(MaterialPageRoute(builder: (_) => const DevicesScreen())),
              ),
               Section(UiCopy.text(709)),
              ListBlock(inset: 16, children: [
                pair(UiCopy.text(7), Text(store.backend.label, key: const Key('server-host'), textDirection: TextDirection.ltr, style: T.row2.copyWith(color: p.text))),
                Padding(
                  padding: const EdgeInsets.fromLTRB(16, 12, 16, 12),
                  child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
                    // The web build belongs to its own server; the app can move to another one.
                    if (!kIsWeb) ...[
                      Text(UiCopy.text(710),
                          style: T.small.copyWith(color: p.text2)),
                      const SizedBox(height: 10),
                    ],
                    Wrap(spacing: 8, runSpacing: 8, children: [
                      if (!kIsWeb) Btn(UiCopy.text(4), icon: 'dns', onTap: busy || note != null ? null : () => kSwitchServer?.call()),
                      Btn(UiCopy.text(711), onTap: busy || note != null ? null : _leave),
                    ]),
                    if (note != null) Padding(padding: const EdgeInsets.only(top: 10), child: Text(note!, style: T.secondary.copyWith(color: p.text))),
                  ]),
                ),
              ]),
               Section(UiCopy.text(712)),
              ListBlock(inset: 16, children: [
                pair(UiCopy.text(713), Toggle(on: d?.focus ?? false, label: UiCopy.text(713), onTap: store.toggleFocus)),
                if (NativeBridge.instance.supported)
                  Padding(
                    padding: const EdgeInsets.fromLTRB(16, 12, 16, 12),
                    child: Wrap(spacing: 8, runSpacing: 8, children: [
                      Btn(UiCopy.text(714), onTap: () => NativeBridge.instance.requestNotificationPermission()),
                      Btn(UiCopy.text(715), onTap: () => NativeBridge.instance.requestBatteryExemption()),
                    ]),
                  ),
                Padding(
                  padding: const EdgeInsets.fromLTRB(16, 11, 16, 11),
                  child: Text(UiCopy.text(716), style: T.small.copyWith(color: p.text2)),
                ),
              ]),
              Material(color: p.bg, child: SwitchListTile(key: const Key('new-interface'), title: Text(AppLocalizations.of(context).newInterface),
                value: store.preferences.newInterface, onChanged: (v) { store.preferences.setNewInterface(v); if (!widget.tab && Navigator.canPop(context)) Navigator.pop(context); })),
               Section(UiCopy.text(717)),
              ListBlock(inset: 16, children: [
                pair(UiCopy.text(718), Text(UiCopy.text(719), style: T.row2.copyWith(color: p.text))),
                pair(UiCopy.text(720), Text(UiCopy.text(721), style: T.row2.copyWith(color: p.text))),
              ]),
               Section(UiCopy.text(722)),
              ListBlock(inset: 16, children: [
                pair(UiCopy.text(723), GestureDetector(onLongPress: () => Clipboard.setData(const ClipboardData(text: kVersion)), child: Text(kVersion, style: T.mono(13).copyWith(color: p.text)))),
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
    UiCopy.watch(context);
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
    final order = [...groups.keys]..sort((a, b) => a == InputCopy.v18 ? -1 : (b == InputCopy.v18 ? 1 : 0));
    return Scaffold(
      backgroundColor: p.bg,
      body: SafeArea(
        child: Column(children: [
          TopBar(title: UiCopy.text(703), leading: IBtn(backIcon(context), tip: UiCopy.text(161), onTap: () => Navigator.of(context).maybePop())),
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
class AccountSwitch extends StatefulWidget {
  const AccountSwitch({super.key, required this.backend});
  final Backend backend;
  @override
  State<AccountSwitch> createState() => AccountSwitchState();
}

class AccountSwitchState extends State<AccountSwitch> {
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
        note = r.ok ? (name == null ? UiCopy.text(724) : UiCopy.text(725)) : r.error;
      });
    }
  }

  @override
  Widget build(BuildContext context) {
    UiCopy.watch(context);
    final v = view;
    if (v == null) return const SizedBox.shrink();
    final p = context.p;
    String state(AccountInfo a) {
      if (!a.usable) return a.note ?? UiCopy.text(511);
      if (a.blocked) return UiCopy.text(726);
      final room = a.room == null ? '' : UiCopy.text(727, [a.room!.round()]);
      return '${a.name == v.active ? UiCopy.text(728) : UiCopy.text(729)}$room';
    }

    return Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
       Section(UiCopy.text(730)),
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
                    ? Text(UiCopy.text(731), style: T.small.copyWith(color: p.text2))
                    : Btn(UiCopy.text(732), onTap: busy ? null : () => _pin(a.name)),
            ]),
          ),
        Padding(
          padding: const EdgeInsets.fromLTRB(16, 4, 16, 11),
          child: Row(children: [
            Expanded(child: Text(v.pinned == null ? UiCopy.text(733) : UiCopy.text(734), style: T.small.copyWith(color: p.text2))),
            if (v.pinned != null) Btn(UiCopy.text(735), onTap: busy ? null : () => _pin(null)),
          ]),
        ),
        if (note != null && noteFailed)
          ShownError(note!, screen: UiCopy.text(736), padding: const EdgeInsets.fromLTRB(16, 0, 16, 11))
        else if (note != null)
          Padding(padding: const EdgeInsets.fromLTRB(16, 0, 16, 11), child: Text(note!, style: T.secondary.copyWith(color: p.text))),
      ]),
    ]);
  }
}
