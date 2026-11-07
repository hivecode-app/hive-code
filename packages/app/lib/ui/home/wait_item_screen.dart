import 'package:agent_company/l10n/ui_copy.dart';
// One "מחכה לך" item on a page of its own, for what has no conversation to open: questions and
// notes from the system (the accounts manager, pairing, failures). The whole text, selectable,
// links that open, and the answer right there (#55).
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../../data/error_report.dart';
import '../../data/store.dart';
import '../../model/models.dart';
import '../../theme/tokens.dart';
import '../chat/chat_screen.dart';
import '../common.dart';
import '../convs/head.dart' show decisionKeysOf;
import '../decision.dart';
import '../nav.dart';
import '../selection.dart';
import 'home_screen.dart';

class WaitItemScreen extends StatelessWidget {
  const WaitItemScreen({super.key, required this.item});
  final WaitItem item;

  @override
  Widget build(BuildContext context) {
    UiCopy.watch(context);
    final p = context.p;
    final store = StoreScope.of(context);
    final d = store.data;
    if (d == null) return const SizedBox.shrink();
    final who = d.who(item.from);
    final isAsk = (item.kind == WaitKind.blockingAsk || item.kind == WaitKind.softAsk) && item.askId != null;
    final decided = store.decision(item.askId, item.id);
    final pending = decided ?? store.pending(item.id);
    final chat = d.canChat(item.from);
    // A decision of the card's kind, with a conversation behind it: the same buttons as the card (#258).
    final keys = chat && item.kind != WaitKind.awaiting && item.state != WaitState.answered && pending == null ? decisionKeysOf(context, item) : null;
    final isDecision = item.kind == WaitKind.go || isAsk;
    final bodyStyle = T.body.copyWith(color: item.kind == WaitKind.awaiting ? p.text2 : p.text);
    return Scaffold(
      backgroundColor: p.bg,
      body: SafeArea(
        child: Column(children: [
          TopBar(
            title: who.name,
            leading: IBtn(backIcon(context), tip: UiCopy.copy.back2, onTap: () => Navigator.of(context).maybePop()),
            actions: [
              IBtn('content_copy', tip: UiCopy.copy.copyText, onTap: () {
                Clipboard.setData(ClipboardData(text: item.body));
              }),
            ],
          ),
          Expanded(
            child: ListView(padding: const EdgeInsets.fromLTRB(16, 4, 16, 24), children: [
              Row(children: [
                Monogram.of(d, item.from, size: AvSize.sm),
                const SizedBox(width: 10),
                Expanded(child: Text(isCaughtFault(item.from, item.askId) ? item.kicker : '${item.kicker} · ${item.time}', style: T.secondary.copyWith(color: p.text2))),
              ]),
              const SizedBox(height: 14),
              // The question first, as a screen's title, in his words when the worker gave them; the details under it, open (#258).
              if (item.headline != null) ...[
                Rich(item.headline!, style: T.bar.copyWith(color: p.text)),
                const SizedBox(height: 6),
                if (isDecision && item.body.trim().isNotEmpty) Text(UiCopy.copy.details, style: T.small.copyWith(color: p.text2, fontWeight: FontWeight.w700)),
                if (isDecision && item.body.trim().isNotEmpty) const SizedBox(height: 4),
                CopySelectionArea(child: Rich(item.body, auto: true, style: bodyStyle)),
              ] else
                CopySelectionArea(child: Rich(item.body, auto: true, style: isDecision ? bodyStyle.copyWith(fontWeight: FontWeight.w700) : bodyStyle)),
              const SizedBox(height: 20),
              if (item.state == WaitState.answered)
                DoneLine(item.answerLine ?? item.doneLine ?? UiCopy.copy.handled2, icon: item.failed ? 'close' : 'check')
              else if (decided != null)
                DecisionLine(icon: pendingIcon(decided), text: pendingLine(decided), onUndo: () => store.cancelUndo(AppStore.decisionKey(item.askId, item.id)))
              else if (pending != null)
                UndoLine(label: pending.label, onCancel: () => store.cancelUndo(pending.key))
              else if (keys != null) ...[
                DecisionKeys(keys: keys),
              ] else ...[
                if (isAsk) AnswerField(item: item, autofocus: item.options.isEmpty),
                if (isAsk) const SizedBox(height: 12),
                Wrap(spacing: 8, runSpacing: 8, children: [
                  if (!isAsk)
                    for (final o in item.options) Btn(o.label, kind: o.primary ? BtnKind.primary : BtnKind.plain, onTap: () => store.answerWait(item, o)),
                  if (item.state != WaitState.notNow)
                    Btn(UiCopy.copy.notNow2, onTap: () {
                      store.notNow(item);
                      Navigator.of(context).maybePop();
                    }),
                  // Closed without doing it; the worker who asked is told (#74). A finished task closes with "עובד" or "לא עובד".
                  if (item.inboxId != null && item.kind != WaitKind.awaiting)
                    Btn(UiCopy.copy.close2, onTap: () {
                      store.dismiss(item);
                      Navigator.of(context).maybePop();
                    }),
                ]),
              ],
              if (chat && item.kind != WaitKind.awaiting) ...[
                const SizedBox(height: 20),
                Align(
                  alignment: AlignmentDirectional.centerStart,
                  child: LinkText(UiCopy.copy.chat(who.name), size: 15, onTap: () {
                    if (item.askId != null) ChatScreen.pendingTarget[item.from] = item.askId!;
                    Nav.chat(context, item.from);
                  }),
                ),
              ],
            ]),
          ),
        ]),
      ),
    );
  }
}
