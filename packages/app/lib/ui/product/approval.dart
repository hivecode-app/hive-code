import 'package:agent_company/l10n/input_copy.dart';
import 'package:flutter/material.dart';

import '../../data/store.dart';
import '../../l10n/app_localizations.dart';
import '../../model/models.dart';
import '../../theme/tokens.dart';
import '../common.dart';
import '../decision.dart';
import '../nav.dart';
import 'product_theme.dart';

String approvalTitle(BuildContext context, WaitItem item) {
  final l = AppLocalizations.of(context);
  final headline = item.headline?.trim();
  if (headline == null || headline.isEmpty) return item.action == 'release' ? l.releaseThisChange : l.approveThisAction;
  if (headline.endsWith('?') || headline.endsWith('؟')) return headline;
  final title = headline;
  return item.action == 'release' ? l.releaseQuestion(title) : l.approvalQuestion(title);
}

/// Old servers still send a single body. Extract only labelled facts; absent facts are disclosed.
/// Structured approval facts from a future server can replace this adapter without changing UI.
List<String?> approvalFacts(String body) {
  final labels = [
    RegExp(InputCopy.v13, caseSensitive: false),
    RegExp(InputCopy.v14, caseSensitive: false),
    RegExp(InputCopy.v15, caseSensitive: false),
    RegExp(InputCopy.v16, caseSensitive: false),
  ];
  final parts = List<String?>.filled(4, null);
  int? current;
  for (final raw in body.split('\n')) {
    final line = raw.replaceAll('**', '').replaceFirst(RegExp(r'^#+\s*'), '').trim();
    bool header = false;
    for (var i = 0; i < labels.length; i++) {
      final m = labels[i].firstMatch(line);
      if (m != null) {
        current = i;
        parts[i] = m[1]!.trim();
        header = true;
        break;
      }
    }
    if (!header && current != null && line.isNotEmpty) parts[current] = '${parts[current] ?? ''}\n$line'.trim();
  }
  if (parts.every((p) => p == null)) parts[0] = body.trim().isEmpty ? null : body;
  return parts;
}

Future<void> showApproval(BuildContext context, WaitItem item) => showModalBottomSheet<void>(
  context: context,
  isScrollControlled: true,
  useSafeArea: true,
  showDragHandle: false,
  backgroundColor: context.p.surface,
  constraints: const BoxConstraints(maxWidth: 600),
  builder: (_) => SizedBox(
    height: MediaQuery.sizeOf(context).height * .92,
    child: ApprovalSheet(item: item),
  ),
);

class ApprovalSheet extends StatelessWidget {
  const ApprovalSheet({super.key, required this.item});
  final WaitItem item;
  @override
  Widget build(BuildContext context) {
    final store = StoreScope.of(context), p = context.p, l = AppLocalizations.of(context);
    final d = store.data!;
    final facts = approvalFacts(item.body);
    final pending = store.decision(item.askId, item.id);
    final unavailable = pending != null || item.state == WaitState.answered || d.superseded(item);
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Row(
          children: [
            IBtn('close', tip: l.close, onTap: () => Navigator.pop(context)),
            const Spacer(),
            TextButton(
              onPressed: () {
                Navigator.pop(context);
                Nav.chat(context, item.from, focus: true);
              },
              child: Text(l.askPerson(d.who(item.from).name)),
            ),
          ],
        ),
        Expanded(
          child: SingleChildScrollView(
            padding: const EdgeInsetsDirectional.fromSTEB(20, 4, 20, 24),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                Row(
                  children: [
                    Ic('front_hand', size: 18, color: p.text2),
                    const SizedBox(width: 6),
                    Text(l.needsYou, style: T.small.copyWith(color: p.text2)),
                  ],
                ),
                const SizedBox(height: 8),
                ProductContentText(
                  approvalTitle(context, item),
                  style: T.bar.copyWith(fontSize: 23, fontWeight: FontWeight.w600, color: p.text),
                ),
                const SizedBox(height: 16),
                DecoratedBox(
                  decoration: BoxDecoration(
                    border: Border.all(color: p.line),
                    borderRadius: BorderRadius.circular(8),
                  ),
                  child: ListTile(
                    leading: ProjectMonogram.person(d, item.from, size: 28),
                    title: ProductContentText(d.who(item.from).name),
                    subtitle: ProductContentText(d.roleLine(item.from)),
                  ),
                ),
                for (final (i, label) in [l.whatChanges, l.risk, l.rollback, l.checked].indexed) ...[
                  const SizedBox(height: 20),
                  Text(
                    label,
                    style: T.small.copyWith(fontWeight: FontWeight.w600, color: p.text2),
                  ),
                  const SizedBox(height: 6),
                  Rich(facts[i]?.isNotEmpty == true ? facts[i]! : l.notProvided, auto: true, style: T.row2.copyWith(color: p.text)),
                ],
                if (pending != null)
                  Padding(
                    padding: const EdgeInsets.only(top: 20),
                    child: DecisionLine(
                      icon: 'check_circle',
                      text: pendingLine(pending),
                      onUndo: () => store.cancelUndo(AppStore.decisionKey(item.askId, item.id)),
                    ),
                  ),
              ],
            ),
          ),
        ),
        Container(
          padding: const EdgeInsets.all(20),
          decoration: BoxDecoration(
            border: Border(top: BorderSide(color: p.line)),
          ),
          child: SafeArea(
            top: false,
            child: Builder(
              builder: (context) {
                final buttons = [
                  OutlinedButton(
                    onPressed: unavailable
                        ? null
                        : () {
                            store.notNow(item);
                            Navigator.pop(context);
                          },
                    child: Text(l.notNow),
                  ),
                  FilledButton(
                    onPressed: unavailable ? null : () => store.answerWait(item, AskOption(id: 'go', label: l.approve, primary: true)),
                    style: FilledButton.styleFrom(minimumSize: const Size(0, 48)),
                    child: Text(item.action == 'release' ? l.releaseToUsers : l.approve),
                  ),
                ];
                if (MediaQuery.textScalerOf(context).scale(1) >= 1.5) {
                  return Column(
                    crossAxisAlignment: CrossAxisAlignment.stretch,
                    mainAxisSize: MainAxisSize.min,
                    children: [buttons[0], const SizedBox(height: 10), buttons[1]],
                  );
                }
                return Row(
                  children: [
                    Expanded(flex: 5, child: buttons[0]),
                    const SizedBox(width: 10),
                    Expanded(flex: 7, child: buttons[1]),
                  ],
                );
              },
            ),
          ),
        ),
      ],
    );
  }
}
