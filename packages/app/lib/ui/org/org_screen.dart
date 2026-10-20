// Org (APP-SPEC §4.6, mockup screen 7): teams tree with each worker's status and the capacity of
// each machine; automations grouped by team with one-tap switches.
import 'package:flutter/material.dart';

import '../../data/backend.dart';
import '../../data/store.dart';
import '../../model/models.dart';
import '../../theme/tokens.dart';
import '../common.dart';
import '../nav.dart';
import '../system_bar.dart';

class OrgScreen extends StatefulWidget {
  const OrgScreen({super.key});
  @override
  State<OrgScreen> createState() => _OrgScreenState();
}

class _OrgScreenState extends State<OrgScreen> {
  bool autos = false;
  /// Teams the owner opened or closed this session; a project team with workers starts open.
  final toggled = <String>{};

  @override
  Widget build(BuildContext context) {
    final store = StoreScope.of(context);
    final d = store.data;
    if (d == null) return const SizedBox.shrink();
    return Column(children: [
      TopBar(showLink: true, actions: [IBtn('more_vert', tip: 'עוד', onTap: () => Nav.settings(context))]),
      const SystemBar(),
      Expanded(
        child: ListView(padding: EdgeInsets.zero, children: [
          BigTitle('ארגון', sub: d.orgSubtitle),
          Segmented(
            items: const ['צוותים', 'אוטומציות'],
            index: autos ? 1 : 0,
            onChanged: (i) => setState(() => autos = i == 1),
          ),
          if (!autos) ..._teams(context, d) else ..._autos(context, d, store),
          const SizedBox(height: 20),
        ]),
      ),
    ]);
  }

  List<Widget> _teams(BuildContext context, CompanyData d) {
    final p = context.p;
    final rows = <Widget>[];
    for (final (i, t) in d.orgTeams.indexed) {
      final team = d.teams[t.teamId]!;
      final expandable = t.members.isNotEmpty;
      final isOpen = toggled.contains(t.teamId) != (!team.permanent && t.members.length > 1);
      if (i > 0) rows.add(Container(color: p.surface, padding: const EdgeInsetsDirectional.only(start: 16), child: Container(height: 1, color: p.line)));
      Widget end;
      if (t.canWake) {
        end = const Btn('להעיר', height: 32, fontSize: 13);
      } else if (expandable) {
        end = AnimatedRotation(turns: isOpen ? 0.5 : 0, duration: const Duration(milliseconds: 150), child: Ic('expand_more', size: 20, color: p.text2));
      } else {
        end = StatusWord(icon: t.statusIcon, word: t.statusWord, bold: t.bold);
      }
      rows.add(Material(
        color: p.surface,
        child: InkWell(
          onTap: expandable
              ? () => setState(() => toggled.contains(t.teamId) ? toggled.remove(t.teamId) : toggled.add(t.teamId))
              : (team.leadId != null ? () => Nav.chat(context, team.leadId!) : null),
          child: Padding(
            padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 12),
            child: Row(children: [
              SizedBox(width: 24, child: Ic(team.symbol, color: p.text2)),
              const SizedBox(width: 12),
              Expanded(
                child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                  Text(team.name, style: TextStyle(fontFamily: kFont, fontSize: 15, height: 1.4, fontWeight: FontWeight.w700, color: p.text)),
                  Text(t.line, style: T.small.copyWith(color: p.text2)),
                ]),
              ),
              end,
            ]),
          ),
        ),
      ));
      if (isOpen) {
        for (final m in t.members) {
          if (m.group != null) {
            rows.add(Container(
              color: p.surface,
              padding: const EdgeInsetsDirectional.fromSTEB(52, 8, 16, 2),
              child: Rich(m.group!, style: TextStyle(fontFamily: kFont, fontSize: 12.5, height: 1.5, color: p.text2)),
            ));
          }
          final who = d.who(m.identityId);
          final pr = d.presence[m.identityId] ?? const Presence(status: WorkerStatus.resting);
          rows.add(Material(
            color: p.surface,
            child: InkWell(
              onTap: () => Nav.chat(context, m.identityId),
              child: Padding(
                padding: EdgeInsetsDirectional.fromSTEB(m.sub ? 68 : 52, 8, 16, 8),
                child: Row(children: [
                  Monogram.of(d, m.identityId, size: AvSize.sm),
                  const SizedBox(width: 10),
                  Expanded(
                    child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                      Text(who.name, style: TextStyle(fontFamily: kFont, fontSize: 14.5, height: 1.35, fontWeight: FontWeight.w500, color: p.text)),
                      Text(m.line, style: TextStyle(fontFamily: kFont, fontSize: 12.5, height: 1.4, color: p.text2)),
                    ]),
                  ),
                  StatusWord.of(pr, who.gender),
                ]),
              ),
            ),
          ));
        }
      }
    }
    return [
      Container(
        decoration: BoxDecoration(border: Border.symmetric(horizontal: BorderSide(color: p.line))),
        child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: rows),
      ),
      if (d.capacity.isNotEmpty) const Section('קיבולת'),
      if (d.capacity.isNotEmpty) ListBlock(inset: 16, children: [
        for (final c in d.capacity)
          Padding(
            padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 11),
            child: Row(children: [
              Ic('dns', size: 17, color: p.text2),
              const SizedBox(width: 4),
              Text(c.mono ? ltr(c.host) : c.host, style: c.mono ? T.mono(13).copyWith(color: p.text2) : T.row2.copyWith(color: p.text2)),
              const Spacer(),
              Text(c.value, style: T.row2.copyWith(color: c.off ? p.text2 : p.text)),
            ]),
          ),
      ]),
    ];
  }

  List<Widget> _autos(BuildContext context, CompanyData d, AppStore store) {
    final p = context.p;
    final teams = <String>[];
    for (final a in d.automations) {
      if (!teams.contains(a.team)) teams.add(a.team);
    }
    return [
      for (final team in teams) ...[
        Section(team),
        ListBlock(inset: 16, children: [
          for (final a in d.automations.where((a) => a.team == team))
            Padding(
              padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 12),
              child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
                Expanded(
                  child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                    Rich(a.sentence, style: TextStyle(fontFamily: kFont, fontSize: 15, height: 1.4, fontWeight: FontWeight.w500, color: a.enabled ? p.text : p.text2)),
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
    ];
  }
}

/// `.seg`: two-tab segmented control.
class Segmented extends StatelessWidget {
  const Segmented({super.key, required this.items, required this.index, required this.onChanged});
  final List<String> items;
  final int index;
  final ValueChanged<int> onChanged;
  @override
  Widget build(BuildContext context) {
    final p = context.p;
    return Container(
      margin: const EdgeInsets.fromLTRB(16, 0, 16, 10),
      padding: const EdgeInsets.all(3),
      decoration: BoxDecoration(color: p.surface2, borderRadius: BorderRadius.circular(10)),
      child: Row(children: [
        for (final (i, t) in items.indexed)
          Expanded(
            child: Semantics(
              selected: i == index,
              button: true,
              child: GestureDetector(
                onTap: () => onChanged(i),
                child: AnimatedContainer(
                  duration: const Duration(milliseconds: 150),
                  height: 34,
                  alignment: Alignment.center,
                  decoration: BoxDecoration(
                    color: i == index ? p.surface : Colors.transparent,
                    borderRadius: BorderRadius.circular(8),
                    boxShadow: i == index ? const [BoxShadow(color: Color(0x14000000), blurRadius: 2, offset: Offset(0, 1))] : null,
                  ),
                  child: Text(t, style: TextStyle(fontFamily: kFont, fontSize: 14, fontWeight: i == index ? FontWeight.w700 : FontWeight.w500, color: i == index ? p.text : p.text2)),
                ),
              ),
            ),
          ),
      ]),
    );
  }
}

/// `.tog`: 46x28 switch, accent when on.
class Toggle extends StatelessWidget {
  const Toggle({super.key, required this.on, required this.onTap, required this.label});
  final bool on;
  final VoidCallback onTap;
  final String label;
  @override
  Widget build(BuildContext context) {
    final p = context.p;
    return Semantics(
      toggled: on,
      label: label,
      child: GestureDetector(
        onTap: onTap,
        child: Padding(
          padding: const EdgeInsets.only(top: 2),
          child: AnimatedContainer(
            duration: const Duration(milliseconds: 150),
            width: 46,
            height: 28,
            decoration: BoxDecoration(color: on ? p.accent : p.surface3, borderRadius: BorderRadius.circular(14)),
            child: AnimatedAlign(
              duration: const Duration(milliseconds: 150),
              alignment: on ? AlignmentDirectional.centerEnd : AlignmentDirectional.centerStart,
              child: Container(
                width: 20,
                height: 20,
                margin: const EdgeInsets.all(4),
                decoration: BoxDecoration(shape: BoxShape.circle, color: on ? p.onAccent : p.text3),
              ),
            ),
          ),
        ),
      ),
    );
  }
}
