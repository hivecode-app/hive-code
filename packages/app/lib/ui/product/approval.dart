import 'package:flutter/material.dart';

import '../../data/store.dart';
import '../../l10n/app_localizations.dart';
import '../../model/models.dart';
import '../../native/open_url.dart';
import '../../theme/tokens.dart';
import '../chat/markdown.dart' show Markdown;
import '../common.dart';
import '../decision.dart';
import '../nav.dart';
import '../selection.dart';
import 'product_theme.dart';

String approvalTitle(BuildContext context, WaitItem item) {
  final l = AppLocalizations.of(context);
  final headline = item.headline?.trim();
  if (headline == null || headline.isEmpty) return item.action == 'release' ? l.releaseThisChange : l.approveThisAction;
  // Only a short name of a thing is wrapped ("לשחרר את התיקון לקריסה במפה?"). A question, or a sentence of
  // the worker's own ("להחליט אם להמשיך הלילה…"), is shown as written (#1499).
  if (RegExp(r'[?؟.!:]$').hasMatch(headline) || headline.split(RegExp(r'\s+')).length > 4) return headline;
  return item.action == 'release' ? l.releaseQuestion(headline) : l.approvalQuestion(headline);
}

/// A GO's whole text as the worker wrote it, without its trailer and without the headline when it opens the
/// text too, and the PR it is about: hq's link first (#1499).
({String text, String? pr, String? risk}) approvalParts(WaitItem item) {
  final t = decisionTrailer(item.body);
  var text = t.text;
  final headline = item.headline?.trim();
  if (headline != null && headline.isNotEmpty && text.startsWith(headline)) text = text.substring(headline.length).trim();
  final pr = item.links.where((l) => l.kind == WaitLinkKind.pr).firstOrNull?.url ?? t.pr;
  return (text: text, pr: pr, risk: t.risk);
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
    final parts = approvalParts(item);
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
                // The worker's own text, whole and in its order, as markdown: no section is guessed out of it, and
                // nothing of it is dropped (#1499).
                if (parts.text.isNotEmpty) ...[
                  const SizedBox(height: 20),
                  CopySelectionArea(child: Markdown(parts.text)),
                ],
                if (parts.risk != null) ...[
                  const SizedBox(height: 16),
                  Text(
                    riskWords(parts.risk)!,
                    style: T.small.copyWith(fontWeight: FontWeight.w600, color: p.text2),
                  ),
                ],
                if (parts.pr != null) ...[
                  const SizedBox(height: 16),
                  Align(
                    alignment: AlignmentDirectional.centerStart,
                    child: Btn(l.pullRequest, icon: 'call_merge', height: 40, fontSize: 13.5, hpad: 14, onTap: () => openExternalUrl(parts.pr!)),
                  ),
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
