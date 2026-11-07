import 'dart:async';

import 'package:flutter/material.dart';

import '../../data/store.dart';
import '../../data/backend.dart' show CompanyData;
import '../../l10n/app_localizations.dart';
import '../../model/models.dart';
import '../../model/task_progress.dart';
import '../../theme/tokens.dart';
import '../common.dart';
import '../convs/head.dart' show HeadData;
import '../nav.dart';
import '../product/approval.dart' show showApproval;
import '../product/product_theme.dart';
import 'task_copy.dart';
import 'task_screen.dart';

/// The tasks tab (a-he-tasks): what waits for him first, then in review, in development and proposals. On a wide
/// screen a board of five columns, the requests in a strip above it.
class ProductTasks extends StatefulWidget {
  const ProductTasks({super.key});
  @override
  State<ProductTasks> createState() => _ProductTasksState();
}

class _ProductTasksState extends State<ProductTasks> with WidgetsBindingObserver {
  List<TaskProgress>? tasks;
  bool busy = false, failed = false;
  /// The released column shows the latest few; the rest open on request, like the list's "including finished".
  bool releasedAll = false;
  /// "מחכות לשחרור" opens on request: merged work waits for the lead's GO and the deploy, not for him.
  bool releasingOpen = false;
  final starting = <int>{};
  Timer? refresh;
  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    WidgetsBinding.instance.addPostFrameCallback((_) => load());
    refresh = Timer.periodic(const Duration(seconds: 30), (_) => load());
  }

  @override
  void dispose() {
    refresh?.cancel();
    WidgetsBinding.instance.removeObserver(this);
    super.dispose();
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState s) {
    if (s == AppLifecycleState.resumed) load();
  }

  Future<void> load() async {
    if (!mounted || busy || ModalRoute.of(context)?.isCurrent == false) return;
    setState(() {
      busy = true;
      failed = false;
    });
    try {
      final value = await StoreScope.read(context).backend.taskProgress();
      if (mounted) setState(() => tasks = value);
    } catch (_) {
      if (mounted) setState(() => failed = true);
    } finally {
      if (mounted) setState(() => busy = false);
    }
  }

  void open(TaskProgress t) async {
    StoreScope.read(context).selectedTask = t.id;
    await Navigator.push(context, MaterialPageRoute<void>(builder: (_) => ProductTaskScreen(id: t.id, initial: t)));
    if (mounted) load();
  }

  void openRequest(WaitItem w) {
    if (w.kind == WaitKind.go) return unawaited(showApproval(context, w));
    if (w.kind == WaitKind.login) return Nav.handoff(context, w);
    Nav.waitItem(context, w);
  }

  /// "התחלה" on a proposal: once, however many times it is pressed.
  Future<void> start(TaskProgress t) async {
    if (!starting.add(t.id)) return;
    setState(() {});
    final l = AppLocalizations.of(context), messenger = ScaffoldMessenger.of(context);
    final r = await StoreScope.read(context).backend.startTask(t.id);
    if (!mounted) return;
    starting.remove(t.id);
    if (!r.ok) messenger.showSnackBar(SnackBar(content: Text(l.progressStartFailed)));
    await load();
  }

  Map<String, String> projectChoices(CompanyData d) => {
    if (d.projects.isNotEmpty)
      for (final p in d.projects) p.id: p.name,
    if (d.projects.isEmpty)
      for (final t in d.teams.values.where((t) => !t.permanent)) t.id: t.name,
    for (final t in tasks ?? <TaskProgress>[])
      if (t.project != null) t.project!: projectName(d, t.project),
  };

  Future<void> newTask() async {
    final store = StoreScope.read(context), l = AppLocalizations.of(context), d = store.data!;
    var project = store.taskProject;
    project ??= await showDialog<String>(
      context: context,
      builder: (c) => SimpleDialog(
        title: Text(l.progressChooseProject),
        children: [
          for (final project in projectChoices(d).entries)
            SimpleDialogOption(
              onPressed: () => Navigator.pop(c, project.key),
              child: Padding(padding: const EdgeInsets.symmetric(vertical: 8), child: Text(project.value)),
            ),
        ],
      ),
    );
    if (project == null || !mounted) return;
    final team = d.projects.where((p) => p.id == project).firstOrNull?.teamId ?? project;
    final lead = d.teams[team]?.leadId;
    if (lead == null || lead.isEmpty) {
      ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(l.progressLeadMissing)));
      return;
    }
    final chat = d.chats.putIfAbsent(lead, () => Conversation(identityId: lead, items: []));
    if (!chat.draft.endsWith(l.progressDraft)) {
      store.setDraft(lead, '${chat.draft}${chat.draft.isEmpty ? '' : '\n\n'}${l.progressDraft}');
    }
    Nav.chat(context, lead, focus: true);
  }

  Future<void> options() async {
    final store = StoreScope.read(context), l = AppLocalizations.of(context);
    await showModalBottomSheet<void>(
      context: context,
      useSafeArea: true,
      builder: (c) => Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          ListTile(
            key: const Key('new-task'),
            leading: const Ic('add'),
            title: Text(l.progressNewTask),
            onTap: () {
              Navigator.pop(c);
              newTask();
            },
          ),
          StatefulBuilder(
            builder: (c, set) => CheckboxListTile(
              value: store.taskIncludeCompleted,
              controlAffinity: ListTileControlAffinity.leading,
              onChanged: (v) {
                set(() => store.taskIncludeCompleted = v!);
                setState(() {});
              },
              title: Text(l.progressShowCompleted),
            ),
          ),
          const SizedBox(height: 8),
        ],
      ),
    );
  }

  /// His requests: `needsYou`, the source of the count on the home and the chats, so both say the same.
  List<WaitItem> requests(CompanyData d, String? project) => [
    for (final w in d.needsYou)
      if ((project == null || requestTask(w)?.project == project || (requestTask(w) == null && d.identities[w.from]?.teamId == project)))
        w,
  ];

  /// He has something to check on it himself: before its release (verify) or after it (check).
  static bool checksFor(TaskProgress t) => t.awaiting == 'check' || t.awaiting == 'verify';

  TaskProgress? requestTask(WaitItem w) =>
      w.inboxId == null ? null : tasks?.where((t) => t.requests.any((r) => r.id == w.inboxId)).firstOrNull;

  @override
  Widget build(BuildContext context) {
    final store = StoreScope.of(context), d = store.data!, p = context.p, l = AppLocalizations.of(context);
    final projects = projectChoices(d);
    final now = CompanyTime.now();
    final project = projects.containsKey(store.taskProject) ? store.taskProject : null;
    final list = [
      for (final t in tasks ?? <TaskProgress>[])
        if ((project == null || t.project == project) &&
            t.outcome != 'cancelled' &&
            // A finished task shows when it was released or waits for him. One without a stage (a report, an
            // investigation: nothing shipped) is not "in development" either: it is finished, and stays out.
            (t.outcome == null || (t.stage != null && (store.taskIncludeCompleted || t.stage == TaskStage.released || t.stage == TaskStage.approval))))
          t,
    ];
    // Released this week; with "including finished", everything finished that is in the list.
    bool recent(TaskProgress t) =>
        store.taskIncludeCompleted || (t.updatedAt != null && now.difference(t.updatedAt!) < const Duration(days: 7));
    List<TaskProgress> of(TaskStage? s) => [
      for (final t in list)
        if (t.stage == s && (s != TaskStage.released || recent(t))) t,
    ];
    final asks = requests(d, project);
    bool asked(TaskProgress t) => asks.any((w) => t.requests.any((r) => r.id == w.inboxId));
    // What waits on him as a task: something to check or verify, unless his request on it is already shown.
    final waiting = [for (final t in of(TaskStage.approval)) if (checksFor(t) && !asked(t)) t];
    // The rest of "approval" waits for its release (the lead's GO, the deploy): folded, by project, the oldest first.
    // A GO he put off ("not now") is not counted, so its task waits here too, saying it waits for his approval.
    final releasing = [for (final t in of(TaskStage.approval)) if (!checksFor(t) && !asked(t)) t]
      ..sort((a, b) {
        final byProject = projectName(d, a.project).compareTo(projectName(d, b.project));
        return byProject != 0 ? byProject : (a.awaitingAt ?? a.updatedAt ?? now).compareTo(b.awaitingAt ?? b.updatedAt ?? now);
      });
    // Projects with something open, for the chips: the ones he moves between.
    final active = {for (final t in list) if (t.outcome == null && t.project != null) t.project!};
    return Material(
      color: p.bg,
      child: LayoutBuilder(
        builder: (context, c) {
          final wide = c.maxWidth >= 900;
          final board = wide && store.taskBoard && MediaQuery.textScalerOf(context).scale(1) < 1.5;
          final header = wide
              ? _DesktopHeader(
                  projects: projects,
                  project: project,
                  board: store.taskBoard,
                  onBoard: (v) => setState(() => store.taskBoard = v),
                  onProject: (v) => setState(() => store.taskProject = v),
                  onNew: newTask,
                  onOptions: options,
                )
              : _PhoneHeader(
                  projects: {for (final e in projects.entries) if (active.contains(e.key) || e.key == project) e.key: e.value},
                  all: projects,
                  project: project,
                  onProject: (v) => setState(() => store.taskProject = v),
                  onOptions: options,
                );
          final body = tasks == null && !failed
              ? const SizedBox.shrink()
              : list.isEmpty && asks.isEmpty
              ? Center(
                  child: Column(
                    mainAxisSize: MainAxisSize.min,
                    children: [
                      Text(l.progressEmpty, textAlign: TextAlign.center),
                      if (project != null)
                        TextButton(onPressed: () => setState(() => store.taskProject = null), child: Text(l.progressReset)),
                    ],
                  ),
                )
              : board
              ? Column(
                  crossAxisAlignment: CrossAxisAlignment.stretch,
                  children: [
                    if (asks.isNotEmpty) _RequestStrip(items: asks, taskOf: requestTask, onOpen: openRequest),
                    Expanded(
                      child: Row(
                        crossAxisAlignment: CrossAxisAlignment.stretch,
                        children: [
                          for (final s in TaskStage.values) ...[
                            if (s != TaskStage.proposal) VerticalDivider(width: 1, color: p.line),
                            Expanded(
                              child: _Column(
                                stage: s,
                                tasks: [
                                  for (final t in [...of(s), if (s == TaskStage.development) ...of(null)])
                                    if (s != TaskStage.approval || !releasing.contains(t)) t,
                                ],
                                // "מחכה לך" says only what waits on him; merged work waits for its release beside the released.
                                releasing: s == TaskStage.released ? releasing : const [],
                                releasingOpen: releasingOpen,
                                onReleasing: () => setState(() => releasingOpen = !releasingOpen),
                                selected: store.selectedTask,
                                starting: starting,
                                limit: s == TaskStage.released && !releasedAll ? 5 : null,
                                onMore: () => setState(() => releasedAll = true),
                                onOpen: open,
                                onStart: start,
                                onRequest: (t) {
                                  // Also a GO he put off ("not now"): its task waits in "מחכות לשחרור" with its action.
                                  final w = [...asks, ...d.waiting.where((w) => w.state == WaitState.notNow)]
                                      .where((w) => t.requests.any((r) => r.id == w.inboxId))
                                      .firstOrNull;
                                  if (w != null) openRequest(w);
                                },
                              ),
                            ),
                          ],
                        ],
                      ),
                    ),
                  ],
                )
              : ListView(
                  key: const PageStorageKey('task-list'),
                  padding: const EdgeInsets.only(bottom: 24),
                  children: [
                    // What waits for him: his requests first, then tasks that wait on him with no request of their own.
                    if (asks.isNotEmpty || waiting.isNotEmpty) ...[
                      _Heading(key: const Key('task-needs-you'), label: l.needsYou, count: asks.length + waiting.length),
                      for (final w in asks) _RequestRow(item: w, task: requestTask(w), onTap: () => openRequest(w)),
                      for (final t in waiting)
                        TaskRow(task: t, now: now, selected: store.selectedTask == t.id, onTap: () => open(t)),
                    ],
                    for (final (stage, rows) in [
                      (TaskStage.review, of(TaskStage.review)),
                      (TaskStage.development, [...of(TaskStage.development), ...of(null)]),
                      (TaskStage.proposal, of(TaskStage.proposal)),
                      (TaskStage.approval, releasing),
                      (TaskStage.released, of(TaskStage.released)),
                    ])
                      if (stage == TaskStage.approval && rows.isNotEmpty) ...[
                        _ReleasingHeading(tasks: rows, open: releasingOpen, onTap: () => setState(() => releasingOpen = !releasingOpen)),
                        if (releasingOpen)
                          for (final (i, t) in rows.indexed) ...[
                            if (rows.any((x) => x.project != rows.first.project) && (i == 0 || rows[i - 1].project != t.project)) _ProjectHeading(name: projectName(d, t.project), count: rows.where((x) => x.project == t.project).length),
                            TaskRow(task: t, now: now, selected: store.selectedTask == t.id, onTap: () => open(t)),
                          ],
                      ] else if (rows.isNotEmpty) ...[
                        _Heading(label: groupLabel(l, stage), count: rows.length),
                        for (final t in rows)
                          TaskRow(
                            task: t,
                            now: now,
                            selected: store.selectedTask == t.id,
                            onTap: () => open(t),
                            onStart: t.canStart ? (starting.contains(t.id) ? () {} : () => start(t)) : null,
                          ),
                      ],
                  ],
                );
          return Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              header,
              if (busy && tasks == null) Semantics(label: l.loading, child: const LinearProgressIndicator(minHeight: 2)),
              if (failed) TextButton(onPressed: load, child: Text(l.progressLoadFailed)),
              Expanded(child: body),
            ],
          );
        },
      ),
    );
  }
}

class _PhoneHeader extends StatelessWidget {
  const _PhoneHeader({required this.projects, required this.all, required this.project, required this.onProject, required this.onOptions});
  final Map<String, String> projects, all;
  final String? project;
  final ValueChanged<String?> onProject;
  final VoidCallback onOptions;
  @override
  Widget build(BuildContext context) {
    final l = AppLocalizations.of(context), p = context.p;
    return Padding(
      padding: const EdgeInsets.fromLTRB(20, 8, 20, 12),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Row(
            children: [
              Expanded(child: Semantics(header: true, child: Text(l.tasks, style: T.big.copyWith(color: p.text)))),
              IBtn('tune', key: const Key('task-options'), tip: l.progressOptions, onTap: onOptions),
            ],
          ),
          const SizedBox(height: 12),
          SingleChildScrollView(
            scrollDirection: Axis.horizontal,
            child: Row(
              children: [
                _ProjectMenu(projects: all, project: project, onProject: onProject),
                for (final e in projects.entries) ...[
                  const SizedBox(width: 8),
                  ChoiceChip(
                    key: Key('task-project-${e.key}'),
                    label: Text(e.value),
                    selected: project == e.key,
                    showCheckmark: false,
                    onSelected: (on) => onProject(on ? e.key : null),
                  ),
                ],
              ],
            ),
          ),
        ],
      ),
    );
  }
}

/// "כל הפרויקטים ▾": every project, also the quiet ones.
class _ProjectMenu extends StatelessWidget {
  const _ProjectMenu({required this.projects, required this.project, required this.onProject});
  final Map<String, String> projects;
  final String? project;
  final ValueChanged<String?> onProject;
  @override
  Widget build(BuildContext context) {
    final l = AppLocalizations.of(context), p = context.p;
    return PopupMenuButton<String>(
      key: const Key('task-project'),
      tooltip: l.progressAllProjects,
      onSelected: (v) => onProject(v.isEmpty ? null : v),
      itemBuilder: (_) => [
        PopupMenuItem(value: '', child: Text(l.progressAllProjects)),
        for (final e in projects.entries) PopupMenuItem(value: e.key, child: Text(e.value)),
      ],
      child: Container(
        height: 40,
        padding: const EdgeInsets.symmetric(horizontal: 14),
        decoration: BoxDecoration(
          color: project == null ? p.surface2 : p.surface,
          border: Border.all(color: p.line),
          borderRadius: BorderRadius.circular(10),
        ),
        child: Row(
          mainAxisSize: MainAxisSize.min,
          children: [
            Text(project == null ? l.progressAllProjects : projects[project] ?? project!, style: T.button.copyWith(color: p.text)),
            const SizedBox(width: 6),
            Ic('expand_more', size: 18, color: p.text2),
          ],
        ),
      ),
    );
  }
}

class _DesktopHeader extends StatelessWidget {
  const _DesktopHeader({
    required this.projects,
    required this.project,
    required this.board,
    required this.onBoard,
    required this.onProject,
    required this.onNew,
    required this.onOptions,
  });
  final Map<String, String> projects;
  final String? project;
  final bool board;
  final ValueChanged<bool> onBoard;
  final ValueChanged<String?> onProject;
  final VoidCallback onNew, onOptions;
  @override
  Widget build(BuildContext context) {
    final l = AppLocalizations.of(context), p = context.p;
    return Container(
      padding: const EdgeInsets.fromLTRB(24, 14, 24, 14),
      decoration: BoxDecoration(border: Border(bottom: BorderSide(color: p.line))),
      child: Row(
        children: [
          Semantics(header: true, child: Text(l.tasks, style: T.bar.copyWith(color: p.text))),
          const SizedBox(width: 20),
          SegmentedButton<bool>(
            showSelectedIcon: false,
            segments: [
              ButtonSegment(value: true, icon: const Ic('view_kanban', size: 18), label: Text(l.progressBoard)),
              ButtonSegment(value: false, icon: const Ic('list', size: 18), label: Text(l.progressList)),
            ],
            selected: {board},
            onSelectionChanged: (s) => onBoard(s.first),
          ),
          const Spacer(),
          IBtn('tune', key: const Key('task-options'), tip: l.progressOptions, onTap: onOptions),
          const SizedBox(width: 8),
          _ProjectMenu(projects: projects, project: project, onProject: onProject),
          const SizedBox(width: 12),
          FilledButton.icon(key: const Key('new-task-wide'), onPressed: onNew, icon: const Ic('add', size: 18), label: Text(l.progressNewTask)),
        ],
      ),
    );
  }
}

class _Heading extends StatelessWidget {
  const _Heading({super.key, required this.label, required this.count});
  final String label;
  final int count;
  @override
  Widget build(BuildContext context) {
    final p = context.p;
    return Container(
      padding: const EdgeInsets.fromLTRB(20, 14, 20, 10),
      decoration: BoxDecoration(color: p.bg, border: Border(top: BorderSide(color: p.line), bottom: BorderSide(color: p.line))),
      child: Semantics(
        header: true,
        child: Row(
          children: [
            Text(label, style: T.section.copyWith(color: p.text)),
            const SizedBox(width: 8),
            Text('$count', style: T.secondary.copyWith(color: p.text2)),
          ],
        ),
      ),
    );
  }
}

/// A request of his, as a row: the question itself, who asks, in which project, about which task.
class _RequestRow extends StatelessWidget {
  const _RequestRow({required this.item, required this.task, required this.onTap});
  final WaitItem item;
  final TaskProgress? task;
  final VoidCallback onTap;
  @override
  Widget build(BuildContext context) {
    final d = StoreScope.of(context).data!, p = context.p;
    final who = [d.who(item.from).name, if (task?.project != null) projectName(d, task!.project)].join(' · ');
    return Material(
      color: p.surface,
      child: InkWell(
        key: ValueKey('task-request-${item.id}'),
        onTap: onTap,
        child: Container(
          padding: const EdgeInsets.fromLTRB(20, 14, 20, 14),
          decoration: BoxDecoration(border: Border(bottom: BorderSide(color: p.line))),
          child: Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Padding(
                padding: const EdgeInsets.only(top: 2),
                child: Ic(item.kind == WaitKind.go ? 'front_hand' : 'contact_support', size: 24, color: p.text, fill: item.kind == WaitKind.go),
              ),
              const SizedBox(width: 14),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    ProductContentText(item.headline ?? item.short, style: T.name.copyWith(color: p.text)),
                    const SizedBox(height: 4),
                    Row(
                      children: [
                        ProjectMonogram.person(d, item.from, size: 22),
                        const SizedBox(width: 6),
                        Flexible(
                          child: Text.rich(
                            TextSpan(
                              children: [
                                TextSpan(text: who, style: T.small.copyWith(color: p.text2)),
                                if (task != null) TextSpan(text: '   ${task!.title}', style: T.small.copyWith(color: p.text)),
                              ],
                            ),
                            maxLines: 2,
                            overflow: TextOverflow.ellipsis,
                          ),
                        ),
                      ],
                    ),
                  ],
                ),
              ),
              const SizedBox(width: 12),
              Text(item.time, style: T.meta.copyWith(color: p.text3)),
            ],
          ),
        ),
      ),
    );
  }
}

class TaskRow extends StatelessWidget {
  const TaskRow({super.key, required this.task, required this.onTap, required this.now, this.selected = false, this.onStart});
  final TaskProgress task;
  final VoidCallback onTap;
  final VoidCallback? onStart;
  final DateTime now;
  final bool selected;
  @override
  Widget build(BuildContext context) {
    final l = AppLocalizations.of(context), d = StoreScope.of(context).data!, p = context.p;
    final detail = task.stage == null ? l.progressUnknown : taskDetail(d, l, task);
    final stuck = (task.workerStatus == 'stuck' && task.outcome == null) || task.releaseStuck;
    return Material(
      color: selected ? p.accentSoft : p.surface,
      child: InkWell(
        key: ValueKey('task-${task.id}'),
        onTap: onTap,
        child: Container(
          padding: const EdgeInsets.fromLTRB(20, 14, 20, 14),
          decoration: BoxDecoration(border: Border(bottom: BorderSide(color: p.line))),
          child: Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Padding(
                padding: const EdgeInsets.only(top: 2),
                child: Ic(
                  stuck ? 'warning' : (task.stage == null ? 'progress_activity' : task.releasing ? 'hourglass_top' : stageIcon(task.stage!)),
                  key: const Key('task-row-icon'),
                  size: 22,
                  color: p.text2,
                  fill: task.stage == TaskStage.approval && !task.releasing,
                ),
              ),
              const SizedBox(width: 14),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    ProductContentText(task.title, style: T.name.copyWith(color: p.text)),
                    const SizedBox(height: 4),
                    Text.rich(
                      TextSpan(
                        children: [
                          TextSpan(text: taskWhere(d, l, task), style: T.small.copyWith(color: p.text2)),
                          if (detail.isNotEmpty) TextSpan(text: '   $detail', style: T.small.copyWith(color: p.text)),
                        ],
                      ),
                    ),
                    if (onStart != null) ...[
                      const SizedBox(height: 10),
                      OutlinedButton(key: Key('start-${task.id}'), onPressed: onStart, child: Text(l.progressStart)),
                    ],
                  ],
                ),
              ),
              const SizedBox(width: 12),
              Text(HeadData.ago(task.updatedAt, now), style: T.meta.copyWith(color: p.text3)),
            ],
          ),
        ),
      ),
    );
  }
}

/// The board's strip of what waits for him (a-he-tasks-desktop): one card per request, with its action.
class _RequestStrip extends StatelessWidget {
  const _RequestStrip({required this.items, required this.taskOf, required this.onOpen});
  final List<WaitItem> items;
  final TaskProgress? Function(WaitItem) taskOf;
  final ValueChanged<WaitItem> onOpen;
  @override
  Widget build(BuildContext context) {
    final l = AppLocalizations.of(context), d = StoreScope.of(context).data!, p = context.p;
    return Container(
      padding: const EdgeInsets.fromLTRB(24, 16, 24, 16),
      decoration: BoxDecoration(color: p.surface, border: Border(bottom: BorderSide(color: p.line))),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          SizedBox(
            width: 110,
            child: Row(
              children: [
                Text(l.needsYou, style: T.section.copyWith(color: p.text)),
                const SizedBox(width: 6),
                Text('${items.length}', style: T.secondary.copyWith(color: p.text2)),
              ],
            ),
          ),
          Expanded(
            child: Wrap(
              spacing: 16,
              runSpacing: 12,
              children: [
                for (final w in items.take(4))
                  ConstrainedBox(
                    constraints: const BoxConstraints(minWidth: 320, maxWidth: 520),
                    child: Container(
                      key: ValueKey('task-request-${w.id}'),
                      padding: const EdgeInsets.fromLTRB(16, 12, 16, 12),
                      decoration: BoxDecoration(
                        color: p.surface,
                        border: Border.all(color: w.kind == WaitKind.go ? p.text : p.line, width: w.kind == WaitKind.go ? 1.5 : 1),
                        borderRadius: BorderRadius.circular(10),
                      ),
                      child: Row(
                        children: [
                          Ic(w.kind == WaitKind.go ? 'front_hand' : 'contact_support', size: 22, color: p.text, fill: w.kind == WaitKind.go),
                          const SizedBox(width: 12),
                          Expanded(
                            child: Column(
                              crossAxisAlignment: CrossAxisAlignment.start,
                              children: [
                                ProductContentText(w.headline ?? w.short, style: T.name.copyWith(color: p.text), maxLines: 2, overflow: TextOverflow.ellipsis),
                                const SizedBox(height: 2),
                                Text(
                                  [d.who(w.from).name, taskOf(w)?.title].whereType<String>().join(' · '),
                                  style: T.small.copyWith(color: p.text2),
                                  maxLines: 1,
                                  overflow: TextOverflow.ellipsis,
                                ),
                              ],
                            ),
                          ),
                          const SizedBox(width: 12),
                          w.kind == WaitKind.go
                              ? FilledButton(onPressed: () => onOpen(w), child: Text(l.progressView))
                              : OutlinedButton(onPressed: () => onOpen(w), child: Text(l.answer)),
                        ],
                      ),
                    ),
                  ),
              ],
            ),
          ),
        ],
      ),
    );
  }
}

class _Column extends StatelessWidget {
  const _Column({
    required this.stage,
    required this.tasks,
    required this.selected,
    required this.starting,
    required this.onOpen,
    required this.onStart,
    required this.onRequest,
    required this.onMore,
    this.limit,
    this.releasing = const [],
    this.releasingOpen = false,
    this.onReleasing,
  });
  final TaskStage stage;
  final List<TaskProgress> tasks;
  /// The released column's fold: merged work waiting for its release, under what was released.
  final List<TaskProgress> releasing;
  final bool releasingOpen;
  final VoidCallback? onReleasing;
  final int? selected, limit;
  final VoidCallback onMore;
  final Set<int> starting;
  final ValueChanged<TaskProgress> onOpen, onStart, onRequest;
  @override
  Widget build(BuildContext context) {
    final l = AppLocalizations.of(context), p = context.p;
    final shown = limit == null ? tasks.length : tasks.length.clamp(0, limit!), more = tasks.length - shown;
    final d = StoreScope.of(context).data!, several = releasing.any((t) => t.project != releasing.first.project);
    Widget card(TaskProgress t) => _Card(
      task: t,
      selected: selected == t.id,
      onTap: () => onOpen(t),
      action: t.canStart
          ? OutlinedButton(key: Key('start-${t.id}'), onPressed: starting.contains(t.id) ? null : () => onStart(t), child: Text(l.progressStart))
          : t.requests.any((r) => r.kind == 'go')
          ? FilledButton(onPressed: () => onRequest(t), child: Text(l.reviewAndRelease))
          : null,
    );
    // The fold, by project: a project's name over its tasks when there is more than one.
    final folded = [
      for (final (i, t) in releasing.indexed) ...[
        if (several && (i == 0 || releasing[i - 1].project != t.project))
          _ProjectHeading(name: projectName(d, t.project), count: releasing.where((x) => x.project == t.project).length, card: true),
        card(t),
      ],
    ];
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Padding(
          padding: const EdgeInsets.fromLTRB(16, 18, 16, 10),
          child: Semantics(
            header: true,
            child: Row(
              children: [
                Ic(stageIcon(stage), size: 20, color: p.text, fill: stage == TaskStage.approval),
                const SizedBox(width: 8),
                Flexible(
                  child: Text(
                    groupLabel(l, stage),
                    style: T.section.copyWith(color: p.text),
                    overflow: TextOverflow.ellipsis,
                  ),
                ),
                const SizedBox(width: 8),
                Text('${tasks.length}', style: T.secondary.copyWith(color: p.text2)),
              ],
            ),
          ),
        ),
        if (tasks.isEmpty)
          Padding(
            padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 8),
            child: Text(
              switch (stage) {
                TaskStage.proposal => l.progressNoProposals,
                TaskStage.released => l.progressNoneReleased,
                _ => l.progressNoneHere,
              },
              style: T.secondary.copyWith(color: p.text3),
            ),
          ),
        Expanded(
          child: ListView.builder(
            key: PageStorageKey('task-board-${stage.name}'),
            padding: const EdgeInsets.fromLTRB(12, 0, 12, 16),
            itemCount: shown + (more > 0 ? 1 : 0) + (releasing.isEmpty ? 0 : 1 + (releasingOpen ? folded.length : 0)),
            itemBuilder: (_, i) {
              final fold = shown + (more > 0 ? 1 : 0);
              if (i == fold) return _ReleasingHeading(tasks: releasing, open: releasingOpen, onTap: onReleasing ?? () {}, card: true);
              if (i > fold) return folded[i - fold - 1];
              if (i == shown) {
                return Align(
                  alignment: AlignmentDirectional.centerStart,
                  child: TextButton.icon(key: Key('more-${stage.name}'), onPressed: onMore, icon: const Ic('expand_more', size: 18), label: Text(l.progressMore(more))),
                );
              }
              return card(tasks[i]);
            },
          ),
        ),
      ],
    );
  }
}

class _Card extends StatelessWidget {
  const _Card({required this.task, required this.selected, required this.onTap, this.action});
  final TaskProgress task;
  final bool selected;
  final VoidCallback onTap;
  final Widget? action;
  @override
  Widget build(BuildContext context) {
    final l = AppLocalizations.of(context), d = StoreScope.of(context).data!, p = context.p;
    final detail = task.stage == null ? l.progressUnknown : taskDetail(d, l, task);
    final waits = task.stage == TaskStage.approval && !task.releasing;
    return Padding(
      padding: const EdgeInsets.only(bottom: 10),
      child: Material(
        color: selected ? p.accentSoft : p.surface,
        shape: RoundedRectangleBorder(
          borderRadius: BorderRadius.circular(10),
          side: BorderSide(color: waits ? p.text : p.line, width: waits ? 1.5 : 1),
        ),
        clipBehavior: Clip.antiAlias,
        child: InkWell(
          key: ValueKey('task-${task.id}'),
          onTap: onTap,
          child: Padding(
            padding: const EdgeInsets.fromLTRB(14, 12, 14, 12),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                ProductContentText(task.title, style: T.name.copyWith(color: p.text)),
                const SizedBox(height: 6),
                Row(
                  children: [
                    Container(
                      width: 8,
                      height: 8,
                      decoration: BoxDecoration(shape: BoxShape.circle, color: projectColor(context, projectTone(d, task.project))),
                    ),
                    const SizedBox(width: 8),
                    Flexible(child: Text(taskWhere(d, l, task), style: T.small.copyWith(color: p.text2))),
                  ],
                ),
                if (detail.isNotEmpty) ...[
                  const SizedBox(height: 4),
                  Text(detail, style: T.small.copyWith(color: p.text)),
                ],
                if (action != null) ...[
                  const SizedBox(height: 10),
                  Align(alignment: AlignmentDirectional.centerEnd, child: action),
                ],
              ],
            ),
          ),
        ),
      ),
    );
  }
}

/// "מחכות לשחרור", folded: merged work that waits for the lead's GO and the deploy. The count says how many are
/// stuck (a week and more) without opening it.
class _ReleasingHeading extends StatelessWidget {
  const _ReleasingHeading({required this.tasks, required this.open, required this.onTap, this.card = false});
  final List<TaskProgress> tasks;
  final bool open, card;
  final VoidCallback onTap;
  @override
  Widget build(BuildContext context) {
    final l = AppLocalizations.of(context), p = context.p;
    final stuck = tasks.where((t) => t.releaseStuck).length;
    // It wraps rather than cut "תקועה" off: in a board column and at a large text size.
    final row = Row(
      children: [
        Expanded(
          child: Wrap(
            crossAxisAlignment: WrapCrossAlignment.center,
            children: [
              Text(l.progressReleasing, style: T.section.copyWith(color: p.text)),
              const SizedBox(width: 8),
              Text('${tasks.length}', style: T.secondary.copyWith(color: p.text2)),
              if (stuck > 0)
                Row(
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    Text(' · ', style: T.secondary.copyWith(color: p.text2)),
                    Ic('warning', size: 16, color: p.text2),
                    const SizedBox(width: 4),
                    Text(l.progressReleasingStuck(stuck), style: T.secondary.copyWith(color: p.text2)),
                  ],
                ),
            ],
          ),
        ),
        const SizedBox(width: 8),
        Ic(open ? 'expand_less' : 'expand_more', size: 20, color: p.text2),
      ],
    );
    return Semantics(
      button: true,
      expanded: open,
      child: Material(
        color: card ? Colors.transparent : p.bg,
        child: InkWell(
          key: const Key('task-releasing'),
          onTap: onTap,
          child: Container(
            padding: card ? const EdgeInsets.fromLTRB(4, 12, 4, 12) : const EdgeInsets.fromLTRB(20, 14, 20, 10),
            decoration: card ? null : BoxDecoration(border: Border(top: BorderSide(color: p.line), bottom: BorderSide(color: p.line))),
            child: row,
          ),
        ),
      ),
    );
  }
}

/// A project's name over its tasks inside "מחכות לשחרור".
class _ProjectHeading extends StatelessWidget {
  const _ProjectHeading({required this.name, required this.count, this.card = false});
  final String name;
  final int count;
  /// In a board column: no band of its own.
  final bool card;
  @override
  Widget build(BuildContext context) {
    final p = context.p;
    return Container(
      color: card ? null : p.bg,
      padding: card ? const EdgeInsets.fromLTRB(4, 4, 4, 8) : const EdgeInsets.fromLTRB(20, 10, 20, 6),
      child: Semantics(
        header: true,
        child: Text('$name · $count', style: T.small.copyWith(color: p.text2)),
      ),
    );
  }
}
