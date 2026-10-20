// "בעבודה ובתור" (#128): every task that is not done, wherever it runs. A task opened by Yoav ran under a
// project worker, or waited in the queue, and showed nowhere he looks; now it is
// · under whoever opened it in his conversations, one line ("3 משימות · 2 רצות · 1 בתור") that opens the list;
// · at the top of "סטטוס";
// · the home block `tasks {tasks: [ids] | "open"}`.
// A row is the task in his words and its state: running (`play_arrow`) with who is on it, queued (`schedule`)
// with its place in line, waiting for him (`pause_circle`), or blocked (`block`). A tap goes where every task
// goes ([EntityLink]): the worker on it, or whoever opened it while nobody is on it yet.
import 'package:flutter/material.dart';

import '../../data/backend.dart';
import '../../data/store.dart';
import '../../model/models.dart';
import '../../theme/tokens.dart';
import '../common.dart';
import '../entity_link.dart';
import '../nav.dart';
import 'parts.dart';

const kOpenTaskIcon = {
  OpenTaskState.running: 'play_arrow',
  OpenTaskState.queued: 'schedule',
  OpenTaskState.waitingForYou: 'pause_circle',
  OpenTaskState.blocked: 'block',
};

/// The list a block shows: every open task, or only [ids] (the recipe's, in its order).
List<OpenTask> openTasksOf(CompanyData d, [List<int>? ids]) {
  if (ids == null) return d.openTasks;
  final byId = {for (final t in d.openTasks) t.id: t};
  return [for (final id in ids) ?byId[id]];
}

/// "3 משימות · 2 רצות · 1 בתור": what is open under someone, in one line. One task says itself.
String openTasksLine(List<OpenTask> tasks) {
  if (tasks.length == 1) return '${stateWord(tasks.single)}: ${tasks.single.title}';
  int n(OpenTaskState s) => tasks.where((t) => t.state == s).length;
  final running = n(OpenTaskState.running), queued = n(OpenTaskState.queued), waiting = n(OpenTaskState.waitingForYou), blocked = n(OpenTaskState.blocked);
  return [
    '${tasks.length} משימות',
    if (running > 0) running == 1 ? 'אחת רצה' : '$running רצות',
    if (waiting > 0) waiting == 1 ? 'אחת מחכה לך' : '$waiting מחכות לך',
    if (queued > 0) '$queued בתור',
    if (blocked > 0) blocked == 1 ? 'אחת חסומה' : '$blocked חסומות',
  ].join(' · ');
}

/// The icon for a group of tasks: what needs him first, then what runs, then the queue.
String openTasksIcon(List<OpenTask> tasks) {
  for (final s in [OpenTaskState.waitingForYou, OpenTaskState.running, OpenTaskState.queued, OpenTaskState.blocked]) {
    if (tasks.any((t) => t.state == s)) return kOpenTaskIcon[s]!;
  }
  return 'schedule';
}

String stateWord(OpenTask t) => switch (t.state) {
      OpenTaskState.running => 'רצה',
      OpenTaskState.queued => t.position == null ? 'בתור' : 'בתור, מקום ${t.position}',
      OpenTaskState.waitingForYou => 'מחכה לך',
      OpenTaskState.blocked => 'חסומה',
    };

/// The second line of a task: its state, who is on it or why it waits, who opened it, since when.
String openTaskMeta(CompanyData? d, OpenTask t, {required DateTime now, bool opener = true}) {
  String name(String id) => d == null ? id : d.who(id).name;
  String opened(String id) => d?.who(id).gender == Gender.f ? 'פתחה' : 'פתח';
  final since = t.since == null ? null : (daysAgo(t.since!, now) <= 0 ? 'מ-${hm(t.since!)}' : 'מ-${dm(t.since!)}');
  return [
    stateWord(t),
    if (t.worker != null) name(t.worker!) else if (t.reason != null && t.reason!.isNotEmpty) t.reason!,
    if (opener && t.openedBy != null) '${opened(t.openedBy!)} ${name(t.openedBy!)}',
    ?since,
  ].join(' · ');
}

class TasksBlock extends StatelessWidget {
  const TasksBlock({super.key, required this.tasks, this.now, this.opener = true});
  final List<OpenTask> tasks;
  final DateTime? now;

  /// Say who opened each one (off where the list is already someone's).
  final bool opener;

  @override
  Widget build(BuildContext context) {
    return AnimatedSize(
      duration: kBlockMotion,
      curve: kBlockCurve,
      alignment: Alignment.topCenter,
      child: tasks.isEmpty
          ? const SizedBox(width: double.infinity)
          : Padding(
              padding: const EdgeInsets.symmetric(vertical: 4),
              child: Column(children: [
                for (final (i, t) in tasks.indexed) ...[
                  if (i > 0) const BlockHairline(),
                  OpenTaskRow(key: ValueKey('open-task-${t.id}'), t: t, now: now ?? CompanyTime.now(), opener: opener),
                ],
              ]),
            ),
    );
  }
}

class OpenTaskRow extends StatelessWidget {
  const OpenTaskRow({super.key, required this.t, required this.now, this.opener = true, this.open});
  final OpenTask t;
  final DateTime now;
  final bool opener;

  /// How its conversation opens when not from here ([EntityLink.open]: a sheet closes first).
  final void Function(String identity)? open;

  @override
  Widget build(BuildContext context) {
    final p = context.p;
    final d = StoreScope.of(context).data;
    final meta = openTaskMeta(d, t, now: now, opener: opener);
    return EntityLink(
      identity: d == null ? null : chatTargetOf(d, worker: t.worker, openedBy: t.openedBy),
      label: '${t.title}. $meta',
      minHeight: kLinkRow,
      open: open,
      child: Padding(
        padding: const EdgeInsetsDirectional.fromSTEB(16, 10, 16, 10),
        child: Row(children: [
          BlockSymbol(kOpenTaskIcon[t.state]!),
          const SizedBox(width: 12),
          Expanded(
            child: Column(crossAxisAlignment: CrossAxisAlignment.start, mainAxisSize: MainAxisSize.min, children: [
              Rich(t.title, auto: true, maxLines: 2, style: T.body.copyWith(fontWeight: FontWeight.w500, color: p.text, height: 21 / 15.5)),
              const SizedBox(height: 2),
              Text(meta, maxLines: 2, overflow: TextOverflow.ellipsis, style: T.small.copyWith(color: p.text2)),
            ]),
          ),
        ]),
      ),
    );
  }
}

/// The line under a conversation: what is open under [identityId], and a tap opens the list.
class OpenTasksLine extends StatelessWidget {
  const OpenTasksLine({super.key, required this.identityId, required this.tasks});
  final String identityId;
  final List<OpenTask> tasks;

  @override
  Widget build(BuildContext context) {
    final p = context.p;
    final line = openTasksLine(tasks);
    return Semantics(
      button: true,
      label: 'מה פתוח: $line',
      hint: 'פתיחת הרשימה',
      excludeSemantics: true,
      child: InkWell(
        onTap: () => showOpenTasks(context, identityId),
        borderRadius: BorderRadius.circular(8),
        child: ConstrainedBox(
          constraints: const BoxConstraints(minHeight: 32),
          child: Row(children: [
            Ic(openTasksIcon(tasks), size: 18, fill: true, color: p.text),
            const SizedBox(width: 4),
            Expanded(child: Rich(line, auto: true, maxLines: 1, style: TextStyle(fontFamily: kFont, fontSize: 14.5, height: 1.45, color: p.text))),
            Ic('chevron_left', size: 18, color: p.text3),
          ]),
        ),
      ),
    );
  }
}

/// "מה פתוח אצל יואב": the tasks [identityId] opened, as a sheet; a tap opens the worker's chat.
void showOpenTasks(BuildContext context, String identityId) {
  final p = context.p;
  showModalBottomSheet<void>(
    context: context,
    backgroundColor: p.surface,
    showDragHandle: true,
    isScrollControlled: true,
    builder: (ctx) {
      final d = StoreScope.of(ctx).data;
      final tasks = d?.openedBy(identityId) ?? const <OpenTask>[];
      final name = d?.who(identityId).name ?? identityId;
      return SafeArea(
        child: ConstrainedBox(
          constraints: BoxConstraints(maxHeight: MediaQuery.sizeOf(ctx).height * 0.7),
          child: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.stretch, children: [
            Padding(padding: const EdgeInsets.fromLTRB(16, 0, 16, 8), child: Text('מה פתוח אצל $name', style: T.name.copyWith(color: p.text))),
            if (tasks.isEmpty)
              Padding(padding: const EdgeInsets.fromLTRB(16, 4, 16, 16), child: Text('אין משימות פתוחות', style: T.row2.copyWith(color: p.text2)))
            else
              Flexible(
                child: SingleChildScrollView(
                  child: Column(children: [
                    for (final (i, t) in tasks.indexed) ...[
                      if (i > 0) const BlockHairline(),
                      OpenTaskRow(
                        t: t,
                        now: CompanyTime.now(),
                        opener: false,
                        open: (id) {
                          Navigator.pop(ctx);
                          Nav.chat(context, id);
                        },
                      ),
                    ],
                  ]),
                ),
              ),
            const SizedBox(height: 8),
          ]),
        ),
      );
    },
  );
}
