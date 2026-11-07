import 'package:agent_company/l10n/ui_copy.dart';
// "מה לבדוק" (#108) as a block of its own (the home recipe's `awaiting {tasks[]}`): a row per finished task that
// still waits on him. `deploy` = merged, waits for a GO or a deploy; `check` = live, he has to check something
// himself. A tap opens the conversation with whoever did it; "בדקתי" ("נפרס" on a deploy) takes it off, on
// every device. A deploy that includes the task takes a `deploy` off by itself.
import 'package:flutter/material.dart';
import 'package:flutter/semantics.dart';

import '../../data/backend.dart';
import '../../data/store.dart';
import '../../model/models.dart';
import '../../theme/tokens.dart';
import '../common.dart';
import '../entity_link.dart';
import '../nav.dart';
import 'parts.dart';

/// One task on the list: what it did in his words, what waits, who did it, since when.
class AwaitingItem {
  const AwaitingItem({required this.id, required this.kind, required this.text, required this.at, this.note, this.who, this.project = ''});
  final int id;
  final AwaitingKind kind;
  final String text;
  final String? note;
  final String? who;
  final String project;
  final DateTime at;

  factory AwaitingItem.of(AwaitingTask t) =>
      AwaitingItem(id: t.id, kind: t.kind, text: t.line, note: t.note, who: t.identity, project: t.project, at: t.at);

  factory AwaitingItem.fromJson(Map<String, dynamic> j) => AwaitingItem(
        id: (j['id'] as num).toInt(),
        kind: AwaitingKind.values.asNameMap()[j['kind']] ?? AwaitingKind.check,
        text: j['text'] as String? ?? '',
        note: j['note'] as String?,
        who: j['who'] as String?,
        project: j['project'] as String? ?? '',
        at: DateTime.fromMillisecondsSinceEpoch(((j['at'] as num?) ?? 0).toInt()),
      );
  Map<String, dynamic> toJson() => {'id': id, 'kind': kind.name, 'text': text, 'note': note, 'who': who, 'project': project, 'at': at.millisecondsSinceEpoch};

  /// The task as the backend knows it, for "בדקתי".
  AwaitingTask get task => AwaitingTask(id: id, kind: kind, title: text, summary: text, note: note, identity: who, project: project, at: at);
}

/// "מה לבדוק": what waits on him, newest first.
class AwaitingData {
  const AwaitingData({required this.items});
  final List<AwaitingItem> items;

  /// Everything that waits, or only [tasks] (the recipe's ids, in its order). A task that left the list is gone.
  factory AwaitingData.of(CompanyData d, [List<int>? tasks]) {
    if (tasks == null) return AwaitingData(items: [for (final t in d.awaiting) AwaitingItem.of(t)]);
    final byId = {for (final t in d.awaiting) t.id: t};
    return AwaitingData(items: [for (final id in tasks) if (byId[id] != null) AwaitingItem.of(byId[id]!)]);
  }

  /// A kind this app does not know is left out, as from hq.
  factory AwaitingData.fromJson(Map<String, dynamic> j) => AwaitingData(items: [
        for (final x in (j['items'] as List? ?? const []).whereType<Map>())
          if (AwaitingKind.values.asNameMap().containsKey(x['kind'])) AwaitingItem.fromJson(x.cast<String, dynamic>()),
      ]);
  Map<String, dynamic> toJson() => {'items': [for (final x in items) x.toJson()]};
}

/// The worker who did it, or who opened it once a task worker is done: it is finished (docs/app/links.md).
String? awaitingTarget(CompanyData d, AwaitingItem x) => chatTargetOf(d, worker: x.who, openedBy: ticketOf(d, x.id)?.openedBy, done: true);

class AwaitingBlock extends StatelessWidget {
  const AwaitingBlock({super.key, required this.data, this.now});
  final AwaitingData data;

  /// For "מאתמול" and dates, read out to a screen reader; now when null.
  final DateTime? now;

  @override
  Widget build(BuildContext context) {
    UiCopy.watch(context);
    final store = StoreScope.of(context);
    // What he already checked leaves at once, also when the recipe still lists it.
    final live = {for (final t in store.data?.awaiting ?? const <AwaitingTask>[]) t.id};
    final items = [for (final x in data.items) if (store.data == null || live.contains(x.id)) x];
    return AnimatedSize(
      duration: kBlockMotion,
      curve: kBlockCurve,
      alignment: Alignment.topCenter,
      child: items.isEmpty
          ? const SizedBox(width: double.infinity)
          : Padding(
              padding: const EdgeInsets.symmetric(vertical: 4),
              child: Column(children: [
                for (final (i, x) in items.indexed) ...[
                  if (i > 0) const BlockHairline(),
                  _Row(key: ValueKey('awaiting-${x.id}'), x: x, now: now ?? CompanyTime.now()),
                ],
              ]),
            ),
    );
  }
}

class _Row extends StatelessWidget {
  const _Row({super.key, required this.x, required this.now});
  final AwaitingItem x;
  final DateTime now;

  @override
  Widget build(BuildContext context) {
    UiCopy.watch(context);
    final p = context.p;
    final store = StoreScope.of(context);
    final d = store.data;
    final deploy = x.kind == AwaitingKind.deploy;
    final word = deploy ? UiCopy.copy.waitingRelease : UiCopy.copy.check;
    final action = deploy ? UiCopy.copy.released : UiCopy.copy.checked2;
    final who = x.who == null || d == null ? null : d.who(x.who!).name;
    final ago = daysAgo(x.at, now);
    final when = ago <= 0
        ? hm(x.at)
        : ago == 1
            ? UiCopy.copy.yesterday2
            : dm(x.at);
    final second = T.small.copyWith(color: p.text2);
    final to = d == null ? null : awaitingTarget(d, x);
    final canOpen = to != null;
    void done() => store.checked(x.task);
    return Semantics(
      button: canOpen,
      label: [word, x.text, ?x.note, ?who, ago == 1 ? UiCopy.copy.sinceYesterday : UiCopy.copy.since(when)].join('. '),
      hint: canOpen ? UiCopy.copy.openChat : null,
      excludeSemantics: true,
      customSemanticsActions: {CustomSemanticsAction(label: action): done},
      child: InkWell(
        onTap: canOpen ? () => Nav.chat(context, to) : null,
        child: ConstrainedBox(
          constraints: const BoxConstraints(minHeight: 60),
          child: Padding(
            padding: const EdgeInsetsDirectional.fromSTEB(16, 10, 8, 10),
            child: Row(children: [
              BlockSymbol(deploy ? 'rocket_launch' : 'fact_check'),
              const SizedBox(width: 12),
              Expanded(
                child: Column(crossAxisAlignment: CrossAxisAlignment.start, mainAxisSize: MainAxisSize.min, children: [
                  Rich(x.text, auto: true, maxLines: 4, style: T.body.copyWith(fontWeight: FontWeight.w500, color: p.text, height: 21 / 15.5)),
                  const SizedBox(height: 2),
                  Text.rich(
                    TextSpan(children: [
                      TextSpan(text: word, style: const TextStyle(fontWeight: FontWeight.w700)),
                      if (x.note != null) TextSpan(text: ' · ${x.note}') else if (who != null) TextSpan(text: ' · $who'),
                    ]),
                    maxLines: 4,
                    overflow: TextOverflow.ellipsis,
                    style: second,
                  ),
                ]),
              ),
              const SizedBox(width: 4),
              ExcludeSemantics(
                child: TextButton(
                  onPressed: done,
                  style: TextButton.styleFrom(
                    foregroundColor: p.text,
                    minimumSize: const Size(48, 44),
                    padding: const EdgeInsets.symmetric(horizontal: 8),
                    textStyle: T.small.copyWith(fontWeight: FontWeight.w700),
                  ),
                  child: Text(action),
                ),
              ),
            ]),
          ),
        ),
      ),
    );
  }
}
