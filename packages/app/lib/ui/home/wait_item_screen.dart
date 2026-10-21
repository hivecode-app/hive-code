// One "מחכה לך" item on a page of its own, for what has no conversation to open: questions and
// notes from the system (the accounts manager, pairing, failures). The whole text, selectable,
// links that open, and the answer right there (#55).
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../../data/store.dart';
import '../../model/models.dart';
import '../../theme/tokens.dart';
import '../common.dart';
import '../selection.dart';
import 'home_screen.dart';

class WaitItemScreen extends StatelessWidget {
  const WaitItemScreen({super.key, required this.item});
  final WaitItem item;

  @override
  Widget build(BuildContext context) {
    final p = context.p;
    final store = StoreScope.of(context);
    final d = store.data;
    if (d == null) return const SizedBox.shrink();
    final who = d.who(item.from);
    final isAsk = (item.kind == WaitKind.blockingAsk || item.kind == WaitKind.softAsk) && item.askId != null;
    final pending = store.pending(item.id);
    return Scaffold(
      backgroundColor: p.bg,
      body: SafeArea(
        child: Column(children: [
          TopBar(
            title: who.name,
            leading: IBtn('arrow_forward', tip: 'חזרה', onTap: () => Navigator.of(context).maybePop()),
            actions: [
              IBtn('content_copy', tip: 'העתקת הטקסט', onTap: () {
                Clipboard.setData(ClipboardData(text: item.body));
              }),
            ],
          ),
          Expanded(
            child: ListView(padding: const EdgeInsets.fromLTRB(16, 4, 16, 24), children: [
              Row(children: [
                Monogram.of(d, item.from, size: AvSize.sm),
                const SizedBox(width: 10),
                Expanded(child: Text('${item.kicker} · ${item.time}', style: T.secondary.copyWith(color: p.text2))),
              ]),
              const SizedBox(height: 14),
              // A finished task's card (#219): what to check first, in his words; what changed under it.
              if (item.kind == WaitKind.awaiting && item.headline != null) ...[
                Rich(item.headline!, style: T.body.copyWith(color: p.text, fontWeight: FontWeight.w700)),
                const SizedBox(height: 6),
              ],
              CopySelectionArea(child: Rich(item.body, auto: true, style: T.body.copyWith(color: item.kind == WaitKind.awaiting ? p.text2 : p.text))),
              const SizedBox(height: 20),
              if (item.state == WaitState.answered)
                DoneLine(item.answerLine ?? item.doneLine ?? 'טופל', icon: item.failed ? 'close' : 'check')
              else if (pending != null)
                UndoLine(label: pending.label, onCancel: () => store.cancelUndo(item.id))
              else ...[
                if (isAsk) AnswerField(item: item, autofocus: item.options.isEmpty),
                if (isAsk) const SizedBox(height: 12),
                Wrap(spacing: 8, runSpacing: 8, children: [
                  if (!isAsk)
                    for (final o in item.options) Btn(o.label, kind: o.primary ? BtnKind.primary : BtnKind.tonal, onTap: () => store.answerWait(item, o)),
                  if (item.state != WaitState.notNow)
                    Btn('לא עכשיו', onTap: () {
                      store.notNow(item);
                      Navigator.of(context).maybePop();
                    }),
                  // Closed without doing it; the worker who asked is told (#74). A finished task closes with "בוצע" or "נכשל".
                  if (item.inboxId != null && item.kind != WaitKind.awaiting)
                    Btn('סגירה', onTap: () {
                      store.dismiss(item);
                      Navigator.of(context).maybePop();
                    }),
                ]),
              ],
            ]),
          ),
        ]),
      ),
    );
  }
}
