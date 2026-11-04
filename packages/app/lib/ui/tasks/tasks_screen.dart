import 'dart:async';

import 'package:flutter/material.dart';

import '../../data/store.dart';
import '../../data/backend.dart' show CompanyData;
import '../../l10n/app_localizations.dart';
import '../../model/models.dart';
import '../../model/task_progress.dart';
import '../../theme/tokens.dart';
import '../common.dart';
import '../nav.dart';
import '../product/product_theme.dart';
import 'task_copy.dart';
import 'task_screen.dart';

class ProductTasks extends StatefulWidget {
  const ProductTasks({super.key});
  @override
  State<ProductTasks> createState() => _ProductTasksState();
}

class _ProductTasksState extends State<ProductTasks>
    with WidgetsBindingObserver {
  List<TaskProgress>? tasks;
  bool busy = false, failed = false;
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
    await Navigator.push(
      context,
      MaterialPageRoute<void>(
        builder: (_) => ProductTaskScreen(id: t.id, initial: t),
      ),
    );
    if (mounted) load();
  }

  Map<String, String> projectChoices(CompanyData d) => {
    if (d.projects.isNotEmpty)
      for (final p in d.projects) p.id: p.name,
    if (d.projects.isEmpty)
      for (final t in d.teams.values.where((t) => !t.permanent)) t.id: t.name,
    for (final t in tasks ?? <TaskProgress>[])
      if (t.project != null)
        t.project!:
            d.projects.where((p) => p.id == t.project).firstOrNull?.name ??
            d.teams[t.project]?.name ??
            t.project!,
  };

  Future<void> newTask() async {
    final store = StoreScope.read(context),
        l = AppLocalizations.of(context),
        d = store.data!;
    var project = store.taskProject;
    project ??= await showDialog<String>(
      context: context,
      builder: (c) => SimpleDialog(
        title: Text(l.progressChooseProject),
        children: [
          for (final project in projectChoices(d).entries)
            SimpleDialogOption(
              onPressed: () => Navigator.pop(c, project.key),
              child: Padding(
                padding: const EdgeInsets.symmetric(vertical: 8),
                child: Text(project.value),
              ),
            ),
        ],
      ),
    );
    if (project == null || !mounted) return;
    final team =
        d.projects.where((p) => p.id == project).firstOrNull?.teamId ?? project;
    final lead = d.teams[team]?.leadId;
    if (lead == null || lead.isEmpty) {
      ScaffoldMessenger.of(context)
          .showSnackBar(SnackBar(content: Text(l.progressLeadMissing)));
      return;
    }
    final chat = d.chats.putIfAbsent(
      lead,
      () => Conversation(identityId: lead, items: []),
    );
    if (!chat.draft.endsWith(l.progressDraft)) {
      store.setDraft(
        lead,
        '${chat.draft}${chat.draft.isEmpty ? '' : '\n\n'}${l.progressDraft}',
      );
    }
    Nav.chat(context, lead, focus: true);
  }

  @override
  Widget build(BuildContext context) {
    final store = StoreScope.of(context),
        d = store.data!,
        p = context.p,
        l = AppLocalizations.of(context);
    final projects = projectChoices(d);
    final list = [
      for (final t in tasks ?? <TaskProgress>[])
        if ((store.taskProject == null || t.project == store.taskProject) &&
            t.outcome != 'cancelled' &&
            (store.taskIncludeCompleted ||
                t.outcome == null ||
                t.awaiting != null ||
                t.requests.isNotEmpty ||
                t.stage == TaskStage.released))
          t,
    ];
    return Material(
      color: p.bg,
      child: LayoutBuilder(
        builder: (context, c) {
          final board =
              store.taskBoard &&
              !list.any((t) => t.stage == null) &&
              c.maxWidth >= 700 &&
              MediaQuery.textScalerOf(context).scale(1) < 1.5;
          return Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              Padding(
                padding: const EdgeInsets.all(16),
                child: Wrap(
                  spacing: 12,
                  runSpacing: 8,
                  crossAxisAlignment: WrapCrossAlignment.center,
                  children: [
                    Text(l.tasks, style: T.bar.copyWith(color: p.text)),
                    DropdownButton<String>(
                      icon: const Ic('expand_more'),
                      key: const Key('task-project'),
                      value: projects.containsKey(store.taskProject)
                          ? store.taskProject
                          : null,
                      hint: Text(l.progressAllProjects),
                      onChanged: (v) => setState(() => store.taskProject = v),
                      items: [
                        DropdownMenuItem(
                          value: null,
                          child: Text(l.progressAllProjects),
                        ),
                        for (final e in projects.entries)
                          DropdownMenuItem(value: e.key, child: Text(e.value)),
                      ],
                    ),
                    if (c.maxWidth >= 700)
                      SegmentedButton<bool>(
                        segments: [
                          ButtonSegment(
                            value: false,
                            icon: const Ic('list'),
                            label: Text(l.progressList),
                          ),
                          ButtonSegment(
                            value: true,
                            icon: const Ic('view_kanban'),
                            label: Text(l.progressBoard),
                          ),
                        ],
                        selected: {store.taskBoard},
                        onSelectionChanged: (s) =>
                            setState(() => store.taskBoard = s.first),
                      ),
                    OutlinedButton.icon(
                      key: const Key('new-task'),
                      onPressed: newTask,
                      icon: const Ic('add'),
                      label: Text(l.progressNewTask),
                    ),
                    IBtn('refresh', tip: l.progressRefresh, onTap: load),
                  ],
                ),
              ),
              CheckboxListTile(
                dense: true,
                value: store.taskIncludeCompleted,
                controlAffinity: ListTileControlAffinity.leading,
                onChanged: (v) =>
                    setState(() => store.taskIncludeCompleted = v!),
                title: Text(l.progressShowCompleted),
              ),
              if (busy)
                Semantics(
                  label: l.loading,
                  child: const LinearProgressIndicator(minHeight: 2),
                ),
              if (failed)
                TextButton(onPressed: load, child: Text(l.progressLoadFailed)),
              Expanded(
                child: tasks == null && !failed
                    ? const SizedBox.shrink()
                    : list.isEmpty
                    ? Center(
                        child: Column(
                          mainAxisSize: MainAxisSize.min,
                          children: [
                            Text(l.progressEmpty, textAlign: TextAlign.center),
                            TextButton(
                              onPressed: () =>
                                  setState(() => store.taskProject = null),
                              child: Text(l.progressReset),
                            ),
                          ],
                        ),
                      )
                    : board
                    ? SingleChildScrollView(
                        scrollDirection: Axis.horizontal,
                        child: Row(
                          crossAxisAlignment: CrossAxisAlignment.stretch,
                          children: [
                            for (final stage in TaskStage.values)
                              SizedBox(
                                width: 280,
                                child: _column(stage, list, l, store),
                              ),
                          ],
                        ),
                      )
                    : ListView(
                        key: const PageStorageKey('task-list'),
                        children: [
                          for (final t in list.where((t) => t.stage == null))
                            TaskRow(task: t, onTap: () => open(t)),
                          for (final stage in TaskStage.values) ...[
                            _heading(
                              stage,
                              list.where((t) => t.stage == stage).length,
                              l,
                            ),
                            for (final t in list.where((t) => t.stage == stage))
                              TaskRow(
                                task: t,
                                selected: store.selectedTask == t.id,
                                onTap: () => open(t),
                              ),
                          ],
                        ],
                      ),
              ),
            ],
          );
        },
      ),
    );
  }

  Widget _heading(TaskStage stage, int count, AppLocalizations l) => Padding(
    padding: const EdgeInsets.fromLTRB(20, 18, 20, 8),
    child: Semantics(
      header: true,
      child: Row(
        children: [
          Ic(stageIcon(stage), size: 20),
          const SizedBox(width: 8),
          Expanded(
            child: Text(
              stageLabel(l, stage),
              style: T.row2.copyWith(fontWeight: FontWeight.w600),
            ),
          ),
          Text('$count'),
        ],
      ),
    ),
  );
  Widget _column(
    TaskStage stage,
    List<TaskProgress> tasks,
    AppLocalizations l,
    AppStore store,
  ) {
    final list = tasks.where((t) => t.stage == stage).toList();
    return Column(
      children: [
        _heading(stage, list.length, l),
        Expanded(
          child: ListView.builder(
            key: PageStorageKey('task-board-${stage.name}'),
            itemCount: list.length,
            itemBuilder: (_, i) => TaskRow(
              task: list[i],
              selected: store.selectedTask == list[i].id,
              onTap: () => open(list[i]),
            ),
          ),
        ),
      ],
    );
  }
}

class TaskRow extends StatelessWidget {
  const TaskRow({
    super.key,
    required this.task,
    required this.onTap,
    this.selected = false,
  });
  final TaskProgress task;
  final VoidCallback onTap;
  final bool selected;
  @override
  Widget build(BuildContext context) {
    final l = AppLocalizations.of(context),
        d = StoreScope.of(context).data!,
        p = context.p;
    return ListTile(
      key: ValueKey('task-${task.id}'),
      selected: selected,
      selectedTileColor: p.accentSoft,
      onTap: onTap,
      leading: task.worker == null
          ? Ic(
              task.stage == null ? 'progress_activity' : stageIcon(task.stage!),
            )
          : ProjectMonogram.person(d, task.worker!, size: 28),
      title: ProductContentText(
        task.title,
        style: T.row2.copyWith(color: p.text),
      ),
      subtitle: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          if (task.project != null)
            Text(
              d.projects.where((p) => p.id == task.project).firstOrNull?.name ??
                  d.teams[task.project]?.name ??
                  task.project!,
              style: T.meta,
            ),
          if (task.outcome == 'completed' && task.stage != TaskStage.released)
            Text(
              l.progressWorkCompleted,
              style: T.meta.copyWith(color: p.text2),
            ),
          if (task.stage == null) Text(l.progressUnknown),
          if (task.workerStatus == 'stuck')
            StatusWord(icon: 'warning', word: l.stuck),
          if (task.requests.isNotEmpty) Text(l.needsYou, style: T.small),
        ],
      ),
    );
  }
}
