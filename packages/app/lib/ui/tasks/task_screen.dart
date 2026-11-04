import 'dart:convert';

import 'task_timeline.dart';

import 'package:flutter/material.dart';

import '../../data/store.dart';
import '../../l10n/app_localizations.dart';
import '../../model/task_progress.dart';
import '../../native/open_url.dart';
import '../../theme/tokens.dart';
import '../common.dart';
import '../nav.dart';
import '../product/product_theme.dart';
import '../chat/items.dart' show ImageViewer;
import '../../model/models.dart';
import 'task_copy.dart';

class ProductTaskScreen extends StatefulWidget {
  const ProductTaskScreen({super.key, required this.id, this.initial});
  final int id;
  final TaskProgress? initial;
  @override
  State<ProductTaskScreen> createState() => _ProductTaskScreenState();
}

class _ProductTaskScreenState extends State<ProductTaskScreen>
    with WidgetsBindingObserver {
  TaskProgress? task;
  TaskActivity? activity;
  int detailGeneration = 0, activityGeneration = 0;
  bool detailFailed = false,
      activityFailed = false,
      starting = false,
      startFailed = false;
  @override
  void initState() {
    super.initState();
    task = widget.initial;
    WidgetsBinding.instance.addObserver(this);
    WidgetsBinding.instance.addPostFrameCallback((_) {
      loadDetail();
      loadActivity();
    });
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    super.dispose();
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState s) {
    if (s == AppLifecycleState.resumed) {
      loadDetail();
      loadActivity();
    }
  }

  Future<void> loadDetail() async {
    if (!mounted) return;
    final gen = ++detailGeneration;
    setState(() => detailFailed = false);
    try {
      final t = await StoreScope.read(context).backend.taskDetail(widget.id);
      if (mounted && gen == detailGeneration) {
        setState(() {
          task = t;
          detailFailed = t == null;
        });
      }
    } catch (_) {
      if (mounted && gen == detailGeneration) {
        setState(() => detailFailed = true);
      }
    }
  }

  Future<void> loadActivity() async {
    if (!mounted) return;
    final gen = ++activityGeneration;
    setState(() => activityFailed = false);
    try {
      final a = await StoreScope.read(context).backend.taskActivity(widget.id);
      if (mounted && gen == activityGeneration) setState(() => activity = a);
    } catch (_) {
      if (mounted && gen == activityGeneration) {
        setState(() => activityFailed = true);
      }
    }
  }

  Future<void> start() async {
    if (starting) return;
    setState(() {
      starting = true;
      startFailed = false;
    });
    try {
      final result = await StoreScope.read(context).backend
          .startTask(widget.id);
      if (!mounted) return;
      if (result.ok) {
        await loadDetail();
      } else {
        setState(() => startFailed = true);
      }
    } catch (_) {
      if (mounted) setState(() => startFailed = true);
    } finally {
      if (mounted) setState(() => starting = false);
    }
  }

  String eventTitle(AppLocalizations l, Map<String, dynamic> e) {
    if (e['type'] == 'task.new') return l.progressTaskCreated;
    dynamic data = e['data'];
    if (data is String) {
      try {
        data = jsonDecode(data);
      } catch (_) {
        data = null;
      }
    }
    final state = data is Map ? data['state'] : null;
    return switch (state) {
      'queued' => l.progressQueued,
      'running' => l.progressWorkStarted,
      'open' => l.progressWorkResumed,
      'resting' => l.progressWorkPaused,
      'interrupted' => l.progressWorkInterrupted,
      'done' => l.progressWorkCompleted,
      'closed' => l.progressCancelled,
      'parked' || 'needs_decision' => l.progressDecisionPending,
      _ => l.progressActivity,
    };
  }

  String eventTime(BuildContext context, Map<String, dynamic> e) {
    final at = DateTime.fromMillisecondsSinceEpoch((e['ts'] as num).toInt())
        .toLocal();
    final copy = MaterialLocalizations.of(context);
    return '${copy.formatShortDate(at)} · ${copy.formatTimeOfDay(TimeOfDay.fromDateTime(at), alwaysUse24HourFormat: MediaQuery.alwaysUse24HourFormatOf(context))}';
  }

  @override
  Widget build(BuildContext context) {
    final l = AppLocalizations.of(context),
        p = context.p,
        store = StoreScope.of(context),
        d = store.data!,
        t = task;
    final stage =
        TaskStage.values
            .where((s) => s.name == store.taskActivityStages[widget.id])
            .firstOrNull ??
        t?.stage;
    final events =
        activity?.events
            .where(
              (e) =>
                  (stage == TaskStage.development &&
                      e['type'] == 'task.state') ||
                  (stage == TaskStage.proposal && e['type'] == 'task.new'),
            )
            .toList() ??
        [];
    return Scaffold(
      backgroundColor: p.bg,
      appBar: AppBar(
        leading: IBtn(
          backIcon(context),
          tip: l.back,
          onTap: () => Navigator.maybePop(context),
        ),
        title: Text(l.tasks),
        actions: [
          IBtn(
            'refresh',
            tip: l.progressRefresh,
            onTap: () {
              loadDetail();
              loadActivity();
            },
          ),
        ],
      ),
      body: t == null
          ? Center(
              child: detailFailed
                  ? TextButton(
                      onPressed: loadDetail,
                      child: Text(l.progressMissing),
                    )
                  : Semantics(
                      label: l.loading,
                      child: const CircularProgressIndicator(),
                    ),
            )
          : SingleChildScrollView(
              key: PageStorageKey('task-detail-${widget.id}'),
              padding: const EdgeInsets.all(20),
              child: Center(
                child: ConstrainedBox(
                  constraints: const BoxConstraints(maxWidth: 900),
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.stretch,
                    children: [
                      ProductContentText(
                        t.title,
                        style: T.bar.copyWith(color: p.text),
                      ),
                      if (t.project != null)
                        Padding(
                          padding: const EdgeInsets.only(top: 8),
                          child: Text(
                            d.projects
                                    .where((p) => p.id == t.project)
                                    .firstOrNull
                                    ?.name ??
                                d.teams[t.project]?.name ??
                                t.project!,
                            style: T.secondary.copyWith(color: p.text2),
                          ),
                        ),
                      if (t.stage == null)
                        StatusWord(
                          icon: 'progress_activity',
                          word: l.progressUnknown,
                        ),
                      if (t.outcome != null && t.stage != TaskStage.released)
                        Padding(
                          padding: const EdgeInsets.symmetric(vertical: 8),
                          child: StatusWord(
                            icon: t.outcome == 'cancelled'
                                ? 'close'
                                : 'check_circle',
                            word: t.outcome == 'cancelled'
                                ? l.progressCancelled
                                : l.progressWorkCompleted,
                          ),
                        ),
                      if (detailFailed)
                        TextButton(
                          onPressed: loadDetail,
                          child: Text(l.progressLoadFailed),
                        ),
                      Padding(
                        padding: const EdgeInsets.symmetric(vertical: 20),
                        child: TaskTimeline(
                          current: t.stage,
                          selected: stage,
                          onSelect: (s) => setState(
                            () => store.taskActivityStages[widget.id] = s.name,
                          ),
                        ),
                      ),
                      if (t.body.isNotEmpty) Rich(t.body, auto: true),
                      if (t.summary?.isNotEmpty == true)
                        Padding(
                          padding: const EdgeInsets.symmetric(vertical: 12),
                          child: ProductContentText(t.summary!),
                        ),
                      if (t.canStart)
                        Align(
                          alignment: AlignmentDirectional.centerStart,
                          child: FilledButton.icon(
                            key: const Key('start-task'),
                            onPressed: starting ? null : start,
                            icon: const Ic('play_arrow'),
                            label: Text(
                              starting ? l.progressStarting : l.progressStart,
                            ),
                          ),
                        ),
                      if (startFailed)
                        Semantics(
                          liveRegion: true,
                          child: Text(l.progressStartFailed),
                        ),
                      for (final r in t.requests)
                        ListTile(
                          contentPadding: EdgeInsets.zero,
                          leading: const Ic('front_hand'),
                          title: ProductContentText(r.title),
                          subtitle: Text(
                            l.progressRequestedBy(d.who(r.askedBy ?? '').name),
                          ),
                          trailing: Ic(chevronIcon(context)),
                          onTap: () {
                            final item = d.waiting
                                .where((w) => w.inboxId == r.id)
                                .firstOrNull;
                            if (item != null) {
                              Nav.waitItem(context, item);
                            } else if (r.askedBy != null) {
                              Nav.chat(
                                context,
                                r.askedBy!,
                                preserveRoute: true,
                              );
                            }
                          },
                        ),
                      if (t.worker != null)
                        TextButton.icon(
                          onPressed: () =>
                              Nav.chat(context, t.worker!, preserveRoute: true),
                          icon: const Ic('chat'),
                          label: Text(l.messageTo(d.who(t.worker!).name)),
                        ),
                      const SizedBox(height: 20),
                      Semantics(
                        header: true,
                        child: Text(
                          stage == null
                              ? l.progressActivity
                              : l.progressStageActivity(stageLabel(l, stage)),
                          style: T.name,
                        ),
                      ),
                      if (activityFailed)
                        TextButton(
                          key: const Key('retry-task-activity'),
                          onPressed: loadActivity,
                          child: Text(l.progressActivityFailed),
                        ),
                      if (activity == null && !activityFailed)
                        Semantics(
                          label: l.loading,
                          child: const LinearProgressIndicator(),
                        ),
                      if (t.prs.isNotEmpty) ...[
                        for (final pr in t.prs)
                          Padding(
                            padding: const EdgeInsets.symmetric(vertical: 12),
                            child: Column(
                              crossAxisAlignment: CrossAxisAlignment.stretch,
                              children: [
                                TextButton.icon(
                                  onPressed: () => openExternalUrl(pr.url),
                                  icon: const Ic('open_in_new'),
                                  label: Text(l.progressPullRequests),
                                ),
                                StatusWord(
                                  icon: pr.review == 'approved'
                                      ? 'check_circle'
                                      : pr.review == 'changes'
                                      ? 'edit'
                                      : 'pending',
                                  word: pr.review == 'approved'
                                      ? l.progressApproved
                                      : pr.review == 'changes'
                                      ? l.progressChanges
                                      : l.progressPendingReview,
                                ),
                                StatusWord(
                                  icon: pr.ci == 'passed'
                                      ? 'check_circle'
                                      : pr.ci == 'failed'
                                      ? 'error'
                                      : 'pending',
                                  word: switch (pr.ci) {
                                    'passed' => l.progressCiPassed,
                                    'failed' => l.progressCiFailed,
                                    'pending' => l.progressCiPending,
                                    _ => l.progressCiUnknown,
                                  },
                                ),
                                if (pr.stale)
                                  Text(l.progressStale, style: T.small),
                                if (pr.quote != null)
                                  Padding(
                                    padding: const EdgeInsets.only(top: 8),
                                    child: Rich(pr.quote!, auto: true),
                                  ),
                              ],
                            ),
                          ),
                      ],
                      for (final e in events)
                        ListTile(
                          contentPadding: EdgeInsets.zero,
                          leading: const Ic('history'),
                          title: Text(eventTitle(l, e)),
                          subtitle: Text(eventTime(context, e)),
                        ),
                      if (activity != null &&
                          events.isEmpty &&
                          (!(stage == TaskStage.review ||
                                  stage == TaskStage.approval) ||
                              t.prs.isEmpty))
                        Padding(
                          padding: const EdgeInsets.symmetric(vertical: 12),
                          child: Text(l.progressNoActivity, style: T.secondary),
                        ),
                      for (final m
                          in activity?.messages ?? <Map<String, dynamic>>[])
                        ListTile(
                          contentPadding: EdgeInsets.zero,
                          title: ProductContentText(m['body'] as String),
                          subtitle: Text(
                            l.progressSource,
                            style: T.small.copyWith(color: p.accent),
                          ),
                          trailing: Ic(
                            Directionality.of(context) == TextDirection.rtl
                                ? 'chevron_left'
                                : 'chevron_right',
                          ),
                          onTap: () => Nav.chat(
                            context,
                            m['identity'] as String,
                            preserveRoute: true,
                            message: (
                              id: m['id'] as String,
                              text: m['body'] as String,
                            ),
                          ),
                        ),
                      const SizedBox(height: 20),
                      Semantics(
                        header: true,
                        child: Text(l.progressFiles, style: T.name),
                      ),
                      if (activity != null && activity!.files.isEmpty)
                        Padding(
                          padding: const EdgeInsets.symmetric(vertical: 12),
                          child: Text(l.progressNoFiles, style: T.secondary),
                        ),
                      for (final f
                          in activity?.files ?? <Map<String, dynamic>>[])
                        ListTile(
                          contentPadding: EdgeInsets.zero,
                          leading: const Ic('attach_file'),
                          title: ProductContentText(f['name'] as String),
                          subtitle: Text(
                            l.progressSource,
                            style: T.small.copyWith(color: p.accent),
                          ),
                          trailing: Ic(
                            Directionality.of(context) == TextDirection.rtl
                                ? 'chevron_left'
                                : 'chevron_right',
                          ),
                          onTap: () {
                            if ((f['mime'] as String).startsWith('image/')) {
                              Navigator.push(
                                context,
                                MaterialPageRoute<void>(
                                  builder: (_) => ImageViewer(
                                    images: [
                                      Attachment(
                                        id: f['id'] as String,
                                        name: f['name'] as String,
                                        mime: f['mime'] as String,
                                        bytes: f['bytes'] as int,
                                      ),
                                    ],
                                  ),
                                ),
                              );
                            } else {
                              Nav.chat(
                                context,
                                f['identity'] as String,
                                preserveRoute: true,
                                message: (
                                  id: f['message'] as String,
                                  text: null,
                                ),
                              );
                            }
                          },
                        ),
                    ],
                  ),
                ),
              ),
            ),
    );
  }
}
