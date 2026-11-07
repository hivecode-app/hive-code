// What a conversation is about (a-he-chat): the chips under its title, the task cards inside its messages,
// and on a desktop the panel beside it and the "משימות" and "הערות" tabs.
import 'dart:async';

import 'package:flutter/material.dart';

import '../../data/backend.dart';
import '../../data/store.dart';
import '../../l10n/app_localizations.dart';
import '../../model/models.dart';
import '../../model/task_progress.dart';
import '../../theme/tokens.dart';
import '../common.dart';
import '../media/artifact.dart';
import '../media/viewer.dart';
import '../product/product_theme.dart';
import '../projects/project_screen.dart';
import '../tasks/organization.dart';
import '../tasks/task_copy.dart';
import '../tasks/task_screen.dart';
import 'chat_screen.dart';

/// A list from hq shared by every conversation widget on screen: one read at a time, however many of them ask,
/// and nothing of another company (sign-out, the demo, a test) stays in it.
class _Feed<Item> {
  _Feed(this.read);
  final Future<List<Item>> Function(Backend) read;
  final value = ValueNotifier<List<Item>?>(null);
  final failed = ValueNotifier<bool>(false);
  Backend? _backend;
  Future<void>? _loading;

  Future<void> load(Backend backend) {
    if (!identical(backend, _backend)) {
      _backend = backend;
      _loading = null;
      value.value = null;
      failed.value = false;
    }
    final loading = _loading;
    if (loading != null) return loading;
    return _loading = () async {
      try {
        final v = await read(backend);
        if (identical(backend, _backend)) {
          value.value = v;
          failed.value = false;
        }
      } catch (_) {
        if (identical(backend, _backend)) failed.value = true;
      } finally {
        if (identical(backend, _backend)) _loading = null;
      }
    }();
  }
}

/// hq's task list (`/api/tasks`) and its organization tree (`/api/organization`), for the conversation.
class ChatTaskFeed {
  static final _tasks = _Feed<TaskProgress>((b) => b.taskProgress());
  static final _org = _Feed<OrgPerson>((b) => b.organization());
  static ValueNotifier<List<TaskProgress>?> get tasks => _tasks.value;
  static ValueNotifier<bool> get failed => _tasks.failed;
  static ValueNotifier<List<OrgPerson>?> get org => _org.value;
  static ValueNotifier<bool> get orgFailed => _org.failed;
  static Future<void> load(Backend backend) => Future.wait([_tasks.load(backend), _org.load(backend)]);

  // One 30-second refresh for every builder on screen (the chat and its panel), not one each.
  static final _watching = <Object, Backend Function()>{};
  static Timer? _timer;
  static void _watch(Object who, Backend Function() backend) {
    _watching[who] = backend;
    _timer ??= Timer.periodic(const Duration(seconds: 30), (_) {
      if (_watching.isNotEmpty) load(_watching.values.last());
    });
  }

  static void _unwatch(Object who) {
    _watching.remove(who);
    if (_watching.isEmpty) {
      _timer?.cancel();
      _timer = null;
    }
  }
}

/// Builds with the shared task list, and keeps it fresh while on screen: every 30 seconds and on return to the app.
class ChatTasksBuilder extends StatefulWidget {
  const ChatTasksBuilder({super.key, required this.builder});
  final Widget Function(BuildContext context, List<TaskProgress>? tasks, bool failed) builder;
  @override
  State<ChatTasksBuilder> createState() => _ChatTasksBuilderState();
}

class _ChatTasksBuilderState extends State<ChatTasksBuilder> with WidgetsBindingObserver {
  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!mounted) return;
      ChatTaskFeed._watch(this, () => StoreScope.read(context).backend);
      _load();
    });
  }

  void _load() {
    if (mounted) ChatTaskFeed.load(StoreScope.read(context).backend);
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState s) {
    if (s == AppLifecycleState.resumed) _load();
  }

  @override
  void dispose() {
    ChatTaskFeed._unwatch(this);
    WidgetsBinding.instance.removeObserver(this);
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => ListenableBuilder(
    listenable: Listenable.merge([ChatTaskFeed.tasks, ChatTaskFeed.failed, ChatTaskFeed.org, ChatTaskFeed.orgFailed]),
    builder: (context, _) => widget.builder(context, ChatTaskFeed.tasks.value, ChatTaskFeed.failed.value),
  );
}

/// Still his to follow: not released, not cancelled, and not finished unless something about it waits (a deploy).
bool isOpenTask(TaskProgress t) => t.stage != TaskStage.released && t.outcome != 'cancelled' && (t.outcome == null || t.awaiting != null);

const _stageRank = {TaskStage.approval: 0, TaskStage.review: 1, TaskStage.development: 2, TaskStage.proposal: 3};

/// The tasks of [identityId]'s conversation: the ones it opened and the ones it works on, by stage (what waits
/// for him first), then the last three released.
List<TaskProgress> conversationTasks(List<TaskProgress> all, String identityId) {
  final mine = [for (final t in all) if (t.openedBy == identityId || t.worker == identityId) t];
  final open = [for (final t in mine) if (isOpenTask(t)) t];
  // A stable sort: hq's order (latest first) stays within a stage.
  final ranked = [for (final (i, t) in open.indexed) (i, t)]..sort((a, b) {
    final r = (_stageRank[a.$2.stage] ?? 2) - (_stageRank[b.$2.stage] ?? 2);
    return r != 0 ? r : a.$1 - b.$1;
  });
  return [for (final (_, t) in ranked) t, ...mine.where((t) => t.stage == TaskStage.released).take(3)];
}

/// The conversation's team, from the organization tree: the workers who report to it (working ones first), or,
/// for a worker, the one it reports to.
({List<OrgPerson> people, OrgPerson? root}) conversationTeam(List<OrgPerson> org, String identityId) {
  final kids = [for (final p in org) if (p.manager == identityId && p.id != identityId) p];
  final me = org.where((p) => p.id == identityId).firstOrNull;
  if (kids.isNotEmpty) return (people: [...kids.where((p) => p.atWork), ...kids.where((p) => !p.atWork)], root: me);
  final manager = org.where((p) => p.id == me?.manager && p.id != identityId).firstOrNull;
  return manager == null ? (people: const <OrgPerson>[], root: null) : (people: [manager], root: manager);
}

/// "העובדים של X": the whole tree, with the ones who finished, a tap from the conversation (ג6).
void openTeam(BuildContext context, String identityId, OrgPerson root) {
  final l = AppLocalizations.of(context), p = context.p;
  Navigator.of(context).push(MaterialPageRoute<void>(
    builder: (ctx) => Scaffold(
      backgroundColor: p.bg,
      appBar: AppBar(leading: IBtn(backIcon(ctx), tip: l.back, onTap: () => Navigator.maybePop(ctx)), title: Text(l.progressTeamOf(root.name))),
      body: ConversationHierarchy(identity: identityId, sidebar: true),
    ),
  ));
}

/// The stage word on a task, with the icon beside it. No stage: a task done without code (a report) is
/// "הושלם"; an open one is "שלב המשימה באימות", as on the board.
(String, String) taskStageLook(AppLocalizations l, TaskProgress t) {
  final stage = t.stage;
  if (stage != null) return (stageIcon(stage), stageLabel(l, stage));
  return t.outcome == 'completed' ? ('check_circle', l.progressCompleted) : ('progress_activity', l.progressUnknown);
}

/// [list] in stage groups, what waits on the owner first: (icon, heading, filled, tasks).
List<(String, String, bool, List<TaskProgress>)> taskStageGroups(AppLocalizations l, List<TaskProgress> list) {
  int rank(TaskProgress t) => switch (t.stage) {
        TaskStage.approval => 0,
        TaskStage.review => 1,
        TaskStage.development => 2,
        null when t.outcome != 'completed' => 3,
        TaskStage.proposal => 4,
        TaskStage.released => 5,
        null => 6,
      };
  final groups = <int, List<TaskProgress>>{};
  for (final t in list) {
    (groups[rank(t)] ??= []).add(t);
  }
  return [
    for (final r in groups.keys.toList()..sort())
      (taskStageLook(l, groups[r]!.first).$1, taskStageLook(l, groups[r]!.first).$2, r == 0, groups[r]!),
  ];
}

void openTask(BuildContext context, TaskProgress t) {
  StoreScope.read(context).selectedTask = t.id;
  Navigator.of(context).push(MaterialPageRoute<void>(builder: (_) => ProductTaskScreen(id: t.id, initial: t)));
}

void _openChat(BuildContext context, String id) => Navigator.of(context).push(MaterialPageRoute<void>(builder: (_) => ChatScreen(identityId: id)));

// ───────────────────────────── task cards inside messages ─────────────────────────────

final _taskInPreview = RegExp(r'"task"\s*:\s*(\d+)');
final _opInPreview = RegExp(r'"id"\s*:\s*"([^"]+)"');

/// The tasks a tool group opened (`open_team`): by the id hq answered with, or by the call's id when the tool
/// heard only {queued, id} and hq answered later.
List<Object> openedTaskRefs(ToolGroup g) => [
  for (final line in g.tools)
    if (line.name?.endsWith('open_team') == true && line.call?.isError != true && line.call?.preview != null)
      if (_taskInPreview.firstMatch(line.call!.preview!) case final m?) int.parse(m.group(1)!) else if (_opInPreview.firstMatch(line.call!.preview!) case final m?) m.group(1)!,
];

TaskProgress? resolveTaskRef(List<TaskProgress> tasks, Object ref) =>
    tasks.where((t) => ref is int ? t.id == ref : t.op == ref).firstOrNull;

/// The tasks opened in each turn, under the message the worker wrote after opening them (its "פתחתי משימה"):
/// message id → refs. A turn with no message after the call keeps them under the tool group (its id).
Map<String, List<Object>> taskCardsByItem(List<ChatItem> items) {
  final out = <String, List<Object>>{};
  List<Object>? pending;
  String? pendingAt;
  void flush() {
    if (pending != null && pendingAt != null) (out[pendingAt!] ??= []).addAll(pending!);
    pending = null;
    pendingAt = null;
  }
  for (final it in items) {
    if (it is ToolGroup) {
      final refs = openedTaskRefs(it);
      if (refs.isNotEmpty) {
        (pending ??= []).addAll(refs);
        pendingAt ??= it.id;
      }
    } else if (it is TextMsg && pending != null) {
      pendingAt = it.id;
      flush();
    } else if (it is UserMsg) {
      flush();
    }
  }
  flush();
  return out;
}

/// A task inside a message (a-he-chat `.tref`): its stage, its title, and a tap to its page.
class TaskRefCard extends StatelessWidget {
  const TaskRefCard({super.key, required this.task});
  final TaskProgress task;
  @override
  Widget build(BuildContext context) {
    final p = context.p, l = AppLocalizations.of(context);
    final (icon, word) = taskStageLook(l, task);
    return Padding(
      padding: const EdgeInsets.only(top: 10),
      child: Semantics(
        button: true,
        label: '${task.title} · $word',
        excludeSemantics: true,
        child: Material(
          color: p.surface,
          shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(10), side: BorderSide(color: p.line)),
          child: InkWell(
            key: ValueKey('task-card-${task.id}'),
            borderRadius: BorderRadius.circular(10),
            onTap: () => openTask(context, task),
            child: Padding(
              padding: const EdgeInsetsDirectional.fromSTEB(12, 10, 6, 10),
              child: Row(children: [
                Ic(icon, size: 22, fill: task.stage == TaskStage.approval, color: p.text),
                const SizedBox(width: 10),
                Expanded(
                  child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                    ProductContentText(task.title, maxLines: 2, overflow: TextOverflow.ellipsis, style: T.row2.copyWith(color: p.text, fontWeight: FontWeight.w600)),
                    Text(word, style: T.small.copyWith(color: p.text2)),
                  ]),
                ),
                Ic(chevronIcon(context), size: 20, color: p.text2),
              ]),
            ),
          ),
        ),
      ),
    );
  }
}

// ───────────────────────────── the chips under the title (phone) ─────────────────────────────

class ConversationChips extends StatelessWidget {
  const ConversationChips({super.key, required this.identityId, required this.tasks});
  final String identityId;

  /// The conversation's tasks ([conversationTasks]); null while they load.
  final List<TaskProgress>? tasks;

  @override
  Widget build(BuildContext context) {
    final p = context.p, l = AppLocalizations.of(context);
    final d = StoreScope.of(context).data!;
    final project = d.projectOf(identityId);
    final mine = tasks ?? const <TaskProgress>[];
    final team = conversationTeam(ChatTaskFeed.org.value ?? const [], identityId);
    final working = [for (final x in team.people) if (x.atWork) x];
    // One at work (or one in all): by name, like the mockup's "איתי, מפתח". More: how many at work; none: "צוות".
    final one = working.length == 1 ? working.first : team.people.length == 1 ? team.people.first : null;
    final teamStale = ChatTaskFeed.org.value != null && ChatTaskFeed.orgFailed.value;
    final tasksStale = tasks != null && ChatTaskFeed.failed.value;
    final open = mine.where(isOpenTask).length;
    final chips = <Widget>[
      if (project != null)
        _Chip(
          key: const Key('chat-chip-project'),
          lead: Container(width: 8, height: 8, decoration: BoxDecoration(shape: BoxShape.circle, color: projectColor(context, d.projectTone(project)))),
          text: d.projectName(project),
          onTap: () => Navigator.of(context).push(MaterialPageRoute<void>(builder: (_) => ProjectScreen(projectId: project))),
        ),
      if (ChatTaskFeed.org.value == null && ChatTaskFeed.orgFailed.value)
        Tooltip(
          message: l.progressTeamFailed,
          child: _Chip(key: const Key('conversation-team'), lead: Ic('warning', size: 18, color: p.text2), text: l.progressTeamRetry, onTap: () => ChatTaskFeed.load(StoreScope.read(context).backend)),
        )
      else if (team.root != null && team.people.isNotEmpty)
        _Chip(
          key: const Key('conversation-team'),
          lead: one != null ? ProjectMonogram.person(d, one.id, size: 22) : Ic('group', size: 18, color: p.text2),
          text: one != null ? '${one.name}, ${one.title}' : working.isEmpty ? l.team : l.chatWorkersCount(working.length),
          onTap: () => openTeam(context, identityId, team.root!),
        ),
      if (open > 0)
        _Chip(
          key: const Key('chat-chip-tasks'),
          lead: Ic('view_kanban', size: 18, color: p.text2),
          text: l.openTasksCount(open),
          onTap: () => _tasksSheet(context, mine),
        ),
      // A refresh that failed over what is shown: said, with a retry, at the end so the others stay put.
      if (teamStale || tasksStale)
        Tooltip(
          message: teamStale ? l.progressTeamStale : l.chatTasksFailed,
          child: _Chip(key: const Key('chat-chip-stale'), lead: Ic('warning', size: 18, color: p.text2), text: teamStale ? l.progressTeamRetry : l.chatTasksFailed, onTap: () => ChatTaskFeed.load(StoreScope.read(context).backend)),
        ),
    ];
    if (chips.isEmpty) return Container(width: double.infinity, height: 1, color: p.line);
    return Container(
      width: double.infinity,
      alignment: AlignmentDirectional.centerStart,
      decoration: BoxDecoration(color: p.surface, border: Border(bottom: BorderSide(color: p.line))),
      child: SingleChildScrollView(
        scrollDirection: Axis.horizontal,
        padding: const EdgeInsets.fromLTRB(16, 4, 16, 10),
        child: Row(children: [for (final c in chips) Padding(padding: const EdgeInsetsDirectional.only(end: 8), child: c)]),
      ),
    );
  }

  void _tasksSheet(BuildContext context, List<TaskProgress> tasks) {
    final p = context.p;
    showModalBottomSheet<void>(
      context: context,
      backgroundColor: p.bg,
      showDragHandle: true,
      isScrollControlled: true,
      builder: (ctx) => SafeArea(
        child: ConstrainedBox(
          constraints: BoxConstraints(maxHeight: MediaQuery.sizeOf(ctx).height * 0.8),
          child: ConversationTaskList(tasks: tasks, shrinkWrap: true, onOpen: (t) {
            Navigator.pop(ctx);
            openTask(context, t);
          }),
        ),
      ),
    );
  }
}

class _Chip extends StatelessWidget {
  const _Chip({super.key, required this.lead, required this.text, required this.onTap});
  final Widget lead;
  final String text;
  final VoidCallback onTap;
  @override
  Widget build(BuildContext context) {
    final p = context.p;
    return Material(
      color: p.surface,
      shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(8), side: BorderSide(color: p.line)),
      child: InkWell(
        borderRadius: BorderRadius.circular(8),
        onTap: onTap,
        child: ConstrainedBox(
          constraints: const BoxConstraints(minHeight: 36),
          child: Padding(
            padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 6),
            child: Row(mainAxisSize: MainAxisSize.min, children: [
              lead,
              const SizedBox(width: 8),
              ConstrainedBox(constraints: const BoxConstraints(maxWidth: 220), child: ProductContentText(text, maxLines: 1, overflow: TextOverflow.ellipsis, style: T.small.copyWith(color: p.text))),
            ]),
          ),
        ),
      ),
    );
  }
}

// ───────────────────────────── people and tasks ─────────────────────────────

/// A worker in the conversation's team (a-he-chat desktop `.out`): name, title, and what it is on now.
/// One of the team as a compact line: monogram, name, and the stage of the task in their hands; the task's
/// title in a tooltip (the panel keeps "משימות" in view, design review on #453).
class PersonRow extends StatelessWidget {
  const PersonRow({super.key, required this.person, required this.onTap, this.tasks});
  final OrgPerson person;
  final VoidCallback onTap;

  /// All the company's tasks, for the stage of theirs; null while they load.
  final List<TaskProgress>? tasks;
  @override
  Widget build(BuildContext context) {
    final p = context.p, l = AppLocalizations.of(context);
    final d = StoreScope.of(context).data!;
    final on = person.tasks.where((t) => !OrgPerson.over.contains(t.state)).firstOrNull;
    final task = on == null ? null : tasks?.where((t) => t.id == on.id).firstOrNull;
    final row = InkWell(
      key: ValueKey('chat-person-${person.id}'),
      onTap: onTap,
      borderRadius: BorderRadius.circular(8),
      child: Padding(
        padding: const EdgeInsets.symmetric(vertical: 6, horizontal: 4),
        child: Row(children: [
          ProjectMonogram.person(d, person.id, size: 26),
          const SizedBox(width: 10),
          Expanded(child: ProductContentText(person.name, maxLines: 1, overflow: TextOverflow.ellipsis, style: T.row2.copyWith(color: p.text))),
          if (task != null) ...[
            const SizedBox(width: 8),
            Ic(taskStageLook(l, task).$1, size: 18, fill: task.stage == TaskStage.approval, color: p.text2),
          ],
        ]),
      ),
    );
    return on == null ? row : Tooltip(message: on.title, child: row);
  }
}

/// One task as a line: stage icon, title, stage word (a-he-chat desktop "משימות").
class TaskLine extends StatelessWidget {
  const TaskLine({super.key, required this.task, required this.onTap, this.showWorker = false});
  final TaskProgress task;
  final VoidCallback onTap;
  final bool showWorker;
  @override
  Widget build(BuildContext context) {
    final p = context.p, l = AppLocalizations.of(context);
    final (icon, word) = taskStageLook(l, task);
    final d = StoreScope.of(context).data!;
    final worker = showWorker && task.worker != null && d.identities.containsKey(task.worker) ? d.who(task.worker!).name : null;
    return InkWell(
      key: ValueKey('chat-task-${task.id}'),
      onTap: onTap,
      borderRadius: BorderRadius.circular(8),
      child: Padding(
        padding: const EdgeInsets.symmetric(vertical: 8, horizontal: 4),
        child: Row(children: [
          Ic(icon, size: 20, fill: task.stage == TaskStage.approval, color: p.text),
          const SizedBox(width: 10),
          Expanded(
            child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              ProductContentText(task.title, maxLines: 2, overflow: TextOverflow.ellipsis, style: T.row2.copyWith(color: p.text)),
              if (worker != null) Text(worker, style: T.small.copyWith(color: p.text2)),
            ]),
          ),
          const SizedBox(width: 8),
          Text(word, style: T.small.copyWith(color: p.text3)),
        ]),
      ),
    );
  }
}

/// The conversation's tasks by stage, under a heading for each (the "משימות" tab and the chip's sheet).
class ConversationTaskList extends StatelessWidget {
  const ConversationTaskList({super.key, required this.tasks, required this.onOpen, this.shrinkWrap = false, this.failed = false});
  final List<TaskProgress>? tasks;
  final void Function(TaskProgress) onOpen;
  final bool shrinkWrap;
  final bool failed;
  @override
  Widget build(BuildContext context) {
    final p = context.p, l = AppLocalizations.of(context);
    final list = tasks;
    if (list == null) {
      if (failed) return _Retry(text: l.chatTasksFailed);
      return const Center(child: Padding(padding: EdgeInsets.all(24), child: CircularProgressIndicator()));
    }
    if (list.isEmpty) return Center(child: Padding(padding: const EdgeInsets.all(24), child: Text(l.chatNoTasks, style: T.row2.copyWith(color: p.text2))));
    return ListView(
      shrinkWrap: shrinkWrap,
      padding: const EdgeInsets.fromLTRB(20, 4, 20, 20),
      children: [
        for (final (_, heading, _, group) in taskStageGroups(l, list)) ...[
          Padding(padding: const EdgeInsets.only(top: 14, bottom: 4), child: Text(heading, style: T.section.copyWith(color: p.text2))),
          for (final t in group) TaskLine(task: t, showWorker: true, onTap: () => onOpen(t)),
        ],
      ],
    );
  }
}

/// Beside the conversation list (a-he-home-desktop, 280): the conversation's tasks by stage, as cards.
class ConversationTaskColumn extends StatelessWidget {
  const ConversationTaskColumn({super.key, required this.tasks, this.failed = false});
  final List<TaskProgress>? tasks;
  final bool failed;

  static const width = 280.0;

  @override
  Widget build(BuildContext context) {
    final p = context.p, l = AppLocalizations.of(context);
    final d = StoreScope.of(context).data!;
    final list = tasks;
    Widget card(TaskProgress t) {
      final worker = t.worker != null && d.identities.containsKey(t.worker) ? d.who(t.worker!).name : null;
      final project = t.project == null ? null : d.projectName(t.project!);
      final meta = [?project, ?worker].join(' · ');
      return Padding(
        padding: const EdgeInsets.only(bottom: 8),
        child: Material(
          color: p.surface,
          shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(10), side: BorderSide(color: p.line)),
          child: InkWell(
            key: ValueKey('chat-task-${t.id}'),
            borderRadius: BorderRadius.circular(10),
            onTap: () => openTask(context, t),
            child: Padding(
              padding: const EdgeInsets.fromLTRB(14, 10, 14, 10),
              child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                ProductContentText(t.title, maxLines: 2, overflow: TextOverflow.ellipsis, style: T.row2.copyWith(color: p.text)),
                if (meta.isNotEmpty) ProductContentText(meta, maxLines: 1, overflow: TextOverflow.ellipsis, style: T.small.copyWith(color: p.text2)),
              ]),
            ),
          ),
        ),
      );
    }

    return Container(
      decoration: BoxDecoration(color: p.surface, border: BorderDirectional(start: BorderSide(color: p.line))),
      child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
        Padding(padding: const EdgeInsets.fromLTRB(20, 18, 20, 6), child: Text(l.tasks, style: T.bar.copyWith(color: p.text, fontSize: 18))),
        if (list != null && failed) const Padding(padding: EdgeInsets.symmetric(horizontal: 16), child: _Stale(team: false)),
        Expanded(
          child: list == null
              ? (failed ? _Retry(text: l.chatTasksFailed) : const Align(alignment: Alignment.topCenter, child: LinearProgressIndicator(minHeight: 2)))
              : list.isEmpty
                  ? Padding(padding: const EdgeInsets.all(20), child: Text(l.chatNoTasks, style: T.small.copyWith(color: p.text2)))
                  : ListView(
                      padding: const EdgeInsets.fromLTRB(16, 0, 16, 20),
                      children: [
                        for (final (icon, heading, fill, group) in taskStageGroups(l, list)) ...[
                          Padding(
                            padding: const EdgeInsets.fromLTRB(4, 14, 4, 8),
                            child: Row(children: [
                              Ic(icon, size: 18, fill: fill, color: p.text2),
                              const SizedBox(width: 8),
                              Text(heading, style: T.section.copyWith(color: p.text2)),
                            ]),
                          ),
                          for (final t in group) card(t),
                        ],
                      ],
                    ),
        ),
      ]),
    );
  }
}

/// Shown over the panel and the column when their last refresh failed and what they show is saved.
class _Stale extends StatelessWidget {
  const _Stale({required this.team});
  final bool team;
  @override
  Widget build(BuildContext context) {
    final p = context.p, l = AppLocalizations.of(context);
    return InkWell(
      key: const Key('chat-panel-stale'),
      onTap: () => ChatTaskFeed.load(StoreScope.read(context).backend),
      borderRadius: BorderRadius.circular(8),
      child: Padding(
        padding: const EdgeInsets.symmetric(vertical: 6, horizontal: 4),
        child: Row(children: [
          Ic('warning', size: 18, color: p.text2),
          const SizedBox(width: 8),
          Expanded(child: Text(team ? l.progressTeamStale : l.chatTasksFailed, style: T.small.copyWith(color: p.text2))),
          Text(l.retry, style: T.small.copyWith(color: p.accent, fontWeight: FontWeight.w600)),
        ]),
      ),
    );
  }
}

class _Retry extends StatelessWidget {
  const _Retry({required this.text});
  final String text;
  @override
  Widget build(BuildContext context) {
    final l = AppLocalizations.of(context);
    return Center(
      child: Column(mainAxisSize: MainAxisSize.min, children: [
        Text(text, style: T.row2.copyWith(color: context.p.text2)),
        TextButton(onPressed: () => ChatTaskFeed.load(StoreScope.read(context).backend), child: Text(l.retry)),
      ]),
    );
  }
}

// ───────────────────────────── notes ─────────────────────────────

/// The conversation's notes: the documents and reports (`show`) in it, newest first. Read once a minute at most.
class ChatNotes {
  static final _cache = <String, (DateTime, Future<List<Map<String, dynamic>>>)>{};
  static Backend? _backend;

  static Future<List<Map<String, dynamic>>> of(Backend backend, String identityId) {
    if (!identical(backend, _backend)) {
      _backend = backend;
      _cache.clear();
    }
    final hit = _cache[identityId];
    if (hit != null && DateTime.now().difference(hit.$1) < const Duration(minutes: 1)) return hit.$2;
    final f = backend.files(chat: identityId).then((rows) => [for (final r in rows) if (isNote(r)) r]);
    // A failure is not kept: the next look asks again.
    f.catchError((Object _) {
      _cache.remove(identityId);
      return const <Map<String, dynamic>>[];
    }).ignore();
    _cache[identityId] = (DateTime.now(), f);
    return f;
  }

  static bool isNote(Map<String, dynamic> row) =>
      row['artifact'] is Map || RegExp(r'pdf|officedocument|opendocument|text/|markdown').hasMatch(row['mime'] as String? ?? '');
}

void openNote(BuildContext context, Map<String, dynamic> row) {
  final artifact = (row['artifact'] as Map?)?.cast<String, dynamic>();
  if (artifact == null) {
    openFile(context, Attachment.fromJson(row));
  } else {
    Navigator.of(context).push(MaterialPageRoute<void>(builder: (_) => ArtifactScreen(id: artifact['id'] as String, version: artifact['latest'] as int)));
  }
}

String noteTitle(Map<String, dynamic> row) => ((row['artifact'] as Map?)?['title'] as String?) ?? row['name'] as String? ?? '';

class NoteLine extends StatelessWidget {
  const NoteLine({super.key, required this.row});
  final Map<String, dynamic> row;
  @override
  Widget build(BuildContext context) {
    final p = context.p;
    return Material(
      color: p.surface,
      shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(10), side: BorderSide(color: p.line)),
      child: InkWell(
        borderRadius: BorderRadius.circular(10),
        onTap: () => openNote(context, row),
        child: Padding(
          padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 12),
          child: Row(children: [
            Ic(row['artifact'] is Map ? 'web' : 'description', size: 20, color: p.text2),
            const SizedBox(width: 10),
            Expanded(child: ProductContentText(noteTitle(row), maxLines: 2, overflow: TextOverflow.ellipsis, style: T.row2.copyWith(color: p.text))),
          ]),
        ),
      ),
    );
  }
}

/// The "הערות" tab: every note in the conversation.
class ConversationNotes extends StatefulWidget {
  const ConversationNotes({super.key, required this.identityId});
  final String identityId;
  @override
  State<ConversationNotes> createState() => _ConversationNotesState();
}

class _ConversationNotesState extends State<ConversationNotes> {
  @override
  Widget build(BuildContext context) {
    final l = AppLocalizations.of(context), p = context.p;
    return FutureBuilder<List<Map<String, dynamic>>>(
      future: ChatNotes.of(StoreScope.read(context).backend, widget.identityId),
      builder: (context, snap) {
        if (snap.hasError) {
          return Center(child: Column(mainAxisSize: MainAxisSize.min, children: [
            Text(l.mediaFilesFailed, style: T.row2.copyWith(color: p.text2)),
            TextButton(onPressed: () => setState(() {}), child: Text(l.retry)),
          ]));
        }
        final rows = snap.data;
        if (rows == null) return const Center(child: CircularProgressIndicator());
        if (rows.isEmpty) return Center(child: Padding(padding: const EdgeInsets.all(24), child: Text(l.chatNoNotes, style: T.row2.copyWith(color: p.text2))));
        return ListView(
          padding: const EdgeInsets.all(20),
          children: [for (final r in rows) Padding(padding: const EdgeInsets.only(bottom: 8), child: NoteLine(row: r))],
        );
      },
    );
  }
}

// ───────────────────────────── the panel beside the conversation (desktop) ─────────────────────────────

/// The third column of a conversation on a desktop (a-he-chat-desktop `.rpanel`): role, team, tasks by stage, notes.
class ConversationTasksPanel extends StatelessWidget {
  const ConversationTasksPanel({super.key, required this.identityId});
  final String identityId;

  static const width = 320.0;

  @override
  Widget build(BuildContext context) {
    final p = context.p, l = AppLocalizations.of(context);
    final store = StoreScope.of(context);
    final d = store.data!;
    final who = d.who(identityId);
    final presence = d.presence[identityId] ?? const Presence(status: WorkerStatus.free);
    Widget heading(String text) => Padding(padding: const EdgeInsets.only(bottom: 8), child: Text(text, style: T.section.copyWith(color: p.text2)));
    return Container(
      decoration: BoxDecoration(color: p.surface, border: BorderDirectional(start: BorderSide(color: p.line))),
      child: ChatTasksBuilder(builder: (context, all, failed) {
        final tasks = all == null ? null : conversationTasks(all, identityId);
        final team = conversationTeam(ChatTaskFeed.org.value ?? const [], identityId);
        // The ones at work now; the whole tree, with who finished, is a tap away ("העובדים של X").
        final people = [for (final x in team.people) if (x.atWork) x];
        return ListView(
          key: PageStorageKey('chat-panel-$identityId'),
          padding: const EdgeInsets.fromLTRB(20, 20, 20, 24),
          children: [
            if ((ChatTaskFeed.org.value != null && ChatTaskFeed.orgFailed.value) || (all != null && failed))
              Padding(padding: const EdgeInsets.only(bottom: 12), child: _Stale(team: ChatTaskFeed.org.value != null && ChatTaskFeed.orgFailed.value)),
            heading(l.role),
            ProductContentText(d.roleLine(identityId), style: T.row2.copyWith(color: p.text)),
            const SizedBox(height: 4),
            StatusWord.of(presence, who.gender, withActivity: true),
            if (people.isNotEmpty) ...[
              const SizedBox(height: 24),
              heading(l.team),
              for (final x in people.take(4)) PersonRow(person: x, tasks: all, onTap: () => _openChat(context, x.id)),
            ],
            if (team.root != null && team.people.length > people.take(4).length)
              Align(
                alignment: AlignmentDirectional.centerStart,
                child: TextButton(key: const Key('conversation-team'), onPressed: () => openTeam(context, identityId, team.root!), child: Text(l.progressTeamOf(team.root!.name))),
              ),
            const SizedBox(height: 24),
            heading(l.tasks),
            if (tasks == null)
              failed ? _Retry(text: l.chatTasksFailed) : const LinearProgressIndicator(minHeight: 2)
            else if (tasks.isEmpty)
              Text(l.chatNoTasks, style: T.small.copyWith(color: p.text2))
            else
              for (final t in tasks) TaskLine(task: t, onTap: () => openTask(context, t)),
            FutureBuilder<List<Map<String, dynamic>>>(
              future: ChatNotes.of(store.backend, identityId),
              builder: (context, snap) {
                final rows = snap.data ?? const [];
                if (rows.isEmpty) return const SizedBox.shrink();
                return Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
                  const SizedBox(height: 24),
                  heading(l.notes),
                  for (final r in rows.take(5)) Padding(padding: const EdgeInsets.only(bottom: 8), child: NoteLine(row: r)),
                ]);
              },
            ),
          ],
        );
      }),
    );
  }
}
