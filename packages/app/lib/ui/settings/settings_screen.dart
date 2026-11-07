import 'package:agent_company/l10n/input_copy.dart';
import 'package:agent_company/l10n/ui_copy.dart';
// What the product's settings (product/settings.dart) still take from the old settings screen: the automations
// page, the account switch and the version.
import 'package:flutter/material.dart';

import '../../data/backend.dart';
import '../../model/models.dart';
import '../../data/store.dart';
import '../../theme/tokens.dart';
import '../common.dart';

const kVersion = '0.1.0';

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
