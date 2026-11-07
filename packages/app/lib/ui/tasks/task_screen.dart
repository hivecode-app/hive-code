import 'dart:async';

import 'package:flutter/material.dart';

import '../../data/backend.dart' show CompanyData;
import '../../data/store.dart';
import '../../l10n/app_localizations.dart';
import '../../model/models.dart';
import '../../model/task_progress.dart';
import '../../native/open_url.dart';
import '../../theme/tokens.dart';
import '../common.dart';
import '../media/files_screen.dart';
import '../media/viewer.dart';
import '../nav.dart';
import '../product/approval.dart' show showApproval;
import '../product/product_theme.dart';
import 'task_copy.dart';
import 'task_timeline.dart';

/// A task's page: what it changes for him, who is on it, what happened, and a line to the worker.
/// Never the worker's own instructions (`body`): those are for the worker.
class ProductTaskScreen extends StatefulWidget {
  const ProductTaskScreen({super.key, required this.id, this.initial});
  final int id;
  final TaskProgress? initial;
  @override
  State<ProductTaskScreen> createState() => _ProductTaskScreenState();
}

class _ProductTaskScreenState extends State<ProductTaskScreen> with WidgetsBindingObserver {
  TaskProgress? task;
  TaskActivity? activity;
  int detailGeneration = 0, activityGeneration = 0;
  bool detailFailed = false, activityFailed = false, starting = false, startFailed = false, sending = false, sendFailed = false;
  /// What he started writing to the worker stays when he leaves the page and comes back.
  static final drafts = <int, String>{};
  late final message = TextEditingController(text: drafts[widget.id]);
  @override
  void initState() {
    super.initState();
    task = widget.initial;
    message.addListener(() => drafts[widget.id] = message.text);
    WidgetsBinding.instance.addObserver(this);
    WidgetsBinding.instance.addPostFrameCallback((_) => reload());
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    message.dispose();
    super.dispose();
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState s) {
    if (s == AppLifecycleState.resumed) reload();
  }

  void reload() {
    loadDetail();
    loadActivity();
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
      if (mounted && gen == detailGeneration) setState(() => detailFailed = true);
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
      if (mounted && gen == activityGeneration) setState(() => activityFailed = true);
    }
  }

  Future<void> start() async {
    if (starting) return;
    setState(() {
      starting = true;
      startFailed = false;
    });
    try {
      final result = await StoreScope.read(context).backend.startTask(widget.id);
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

  /// The line at the bottom goes to the worker's chat, about this task: the same message as from the chat.
  Future<void> send(String worker) async {
    final text = message.text.trim();
    if (text.isEmpty || sending) return;
    setState(() => sending = true);
    try {
      final sent = await StoreScope.read(context).send(worker, text, Priority.now, ref: 'task-${widget.id}', clearDraft: false);
      if (!mounted) return;
      // A message that did not get there waits in the chat with "send again"; the page says so, and keeps nothing twice.
      setState(() => sendFailed = sent.delivery == Delivery.failed);
      message.clear();
      unawaited(loadActivity());
    } finally {
      if (mounted) setState(() => sending = false);
    }
  }

  void openRequest(CompanyData d, TaskRequest r) {
    final item = d.waiting.where((w) => w.inboxId == r.id).firstOrNull;
    if (item == null) {
      if (r.askedBy != null) Nav.chat(context, r.askedBy!, preserveRoute: true);
    } else if (item.kind == WaitKind.go) {
      unawaited(showApproval(context, item));
    } else if (item.kind == WaitKind.login) {
      Nav.handoff(context, item);
    } else {
      Nav.waitItem(context, item);
    }
  }

  void files() => Navigator.push(context, MaterialPageRoute<void>(builder: (_) => FilesScreen(task: widget.id)));

  @override
  Widget build(BuildContext context) {
    final l = AppLocalizations.of(context), p = context.p, d = StoreScope.of(context).data!, t = task;
    return LayoutBuilder(
      builder: (context, c) {
        final wide = c.maxWidth >= 900;
        final menu = PopupMenuButton<String>(
          key: const Key('task-menu'),
          tooltip: l.taskMore,
          icon: const Ic('more_horiz'),
          onSelected: (v) => v == 'files' ? files() : reload(),
          itemBuilder: (_) => [
            PopupMenuItem(value: 'files', child: Text(l.mediaFiles)),
            PopupMenuItem(value: 'refresh', child: Text(l.progressRefresh)),
          ],
        );
        final project = t == null ? '' : projectName(d, t.project);
        return Scaffold(
          backgroundColor: p.bg,
          appBar: AppBar(
            leading: IBtn(backIcon(context), tip: l.back, onTap: () => Navigator.maybePop(context)),
            titleSpacing: 0,
            title: wide && t != null
                ? Text.rich(
                    TextSpan(children: [
                      if (project.isNotEmpty) TextSpan(text: '$project  /  ', style: TextStyle(color: p.text2)),
                      TextSpan(text: t.title),
                    ]),
                    style: T.secondary.copyWith(color: p.text),
                    overflow: TextOverflow.ellipsis,
                  )
                : Text(project.isEmpty ? l.tasks : project, style: T.secondary.copyWith(color: p.text2)),
            actions: [
              if (wide && t?.worker != null)
                Padding(
                  padding: const EdgeInsetsDirectional.only(end: 8),
                  child: OutlinedButton.icon(
                    key: const Key('task-message-wide'),
                    onPressed: () => Nav.chat(context, t.worker!, preserveRoute: true, focus: true),
                    icon: const Ic('chat', size: 18),
                    label: Text(l.messageTo(d.who(t!.worker!).name)),
                  ),
                ),
              menu,
            ],
          ),
          body: t == null
              ? Center(
                  child: detailFailed
                      ? TextButton(onPressed: loadDetail, child: Text(l.progressMissing))
                      : Semantics(label: l.loading, child: const CircularProgressIndicator()),
                )
              : wide
              ? Row(
                  crossAxisAlignment: CrossAxisAlignment.stretch,
                  children: [
                    Expanded(child: _scroll(context, t, wide: true)),
                    VerticalDivider(width: 1, color: p.line),
                    SizedBox(
                      width: 340,
                      child: SingleChildScrollView(
                        padding: const EdgeInsets.fromLTRB(28, 28, 28, 28),
                        child: _Facts(task: t, activity: activity, side: true),
                      ),
                    ),
                  ],
                )
              // In the body, not as a bottom bar: the keyboard lifts it with the page instead of covering it.
              : Column(
                  children: [
                    Expanded(child: _scroll(context, t, wide: false)),
                    if (t.worker != null && t.outcome == null) _composer(context, t.worker!),
                  ],
                ),
        );
      },
    );
  }

  Widget _scroll(BuildContext context, TaskProgress t, {required bool wide}) {
    final l = AppLocalizations.of(context), p = context.p, d = StoreScope.of(context).data!;
    // What it changes for him: his words from when it was opened, then how it ended.
    final words = [t.about, t.summary].whereType<String>().where((s) => s.trim().isNotEmpty).toList();
    return SingleChildScrollView(
      key: PageStorageKey('task-detail-${widget.id}'),
      padding: EdgeInsets.fromLTRB(wide ? 48 : 20, wide ? 28 : 8, wide ? 48 : 20, 28),
      child: Center(
        child: ConstrainedBox(
          constraints: const BoxConstraints(maxWidth: 820),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              ProductContentText(t.title, style: (wide ? T.big : T.bar).copyWith(color: p.text)),
              for (final w in words)
                Padding(padding: const EdgeInsets.only(top: 8), child: ProductContentText(w, style: T.secondary.copyWith(color: p.text2))),
              if (t.stage == null && t.outcome == null)
                Padding(padding: const EdgeInsets.only(top: 8), child: StatusWord(icon: 'progress_activity', word: l.progressUnknown)),
              if (t.outcome == 'cancelled')
                Padding(padding: const EdgeInsets.only(top: 8), child: StatusWord(icon: 'close', word: l.progressCancelled)),
              if (detailFailed) TextButton(onPressed: loadDetail, child: Text(l.progressLoadFailed)),
              Padding(padding: const EdgeInsets.symmetric(vertical: 20), child: TaskTimeline(current: t.stage)),
              if (!wide) _Facts(task: t, activity: activity, side: false),
              if (t.canStart)
                Padding(
                  padding: const EdgeInsets.only(top: 12),
                  child: Align(
                    alignment: AlignmentDirectional.centerStart,
                    child: FilledButton.icon(
                      key: const Key('start-task'),
                      onPressed: starting ? null : start,
                      icon: const Ic('play_arrow'),
                      label: Text(starting ? l.progressStarting : l.progressStart),
                    ),
                  ),
                ),
              if (startFailed) Semantics(liveRegion: true, child: Text(l.progressStartFailed)),
              for (final r in t.requests)
                Padding(
                  padding: const EdgeInsets.only(top: 12),
                  child: _RequestCard(request: r, onOpen: () => openRequest(d, r)),
                ),
              const SizedBox(height: 24),
              _Section(l.taskActivity),
              if (activityFailed)
                TextButton(key: const Key('retry-task-activity'), onPressed: loadActivity, child: Text(l.progressActivityFailed)),
              if (activity == null && !activityFailed) Semantics(label: l.loading, child: const LinearProgressIndicator(minHeight: 2)),
              if (activity != null && activity!.timeline.isEmpty)
                Padding(padding: const EdgeInsets.symmetric(vertical: 8), child: Text(l.progressNoActivity, style: T.secondary.copyWith(color: p.text2))),
              if (activity != null) _Activity(events: activity!.timeline),
              const SizedBox(height: 24),
              _Section(l.taskNotesFiles),
              _NotesFiles(activity: activity, wide: wide),
            ],
          ),
        ),
      ),
    );
  }

  Widget _composer(BuildContext context, String worker) {
    final l = AppLocalizations.of(context), p = context.p, d = StoreScope.of(context).data!;
    return SafeArea(
      top: false,
      child: Container(
        decoration: BoxDecoration(color: p.surface, border: Border(top: BorderSide(color: p.line))),
        padding: const EdgeInsets.fromLTRB(16, 10, 16, 10),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            if (sendFailed)
              Semantics(
                liveRegion: true,
                child: TextButton(
                  key: const Key('task-message-failed'),
                  onPressed: () => Nav.chat(context, worker, preserveRoute: true),
                  child: Text(l.taskMessageFailed, style: T.secondary.copyWith(color: p.text2)),
                ),
              ),
            Row(
              children: [
            Expanded(
              child: TextField(
                key: const Key('task-message'),
                controller: message,
                minLines: 1,
                maxLines: 4,
                textInputAction: TextInputAction.send,
                onSubmitted: (_) => send(worker),
                decoration: InputDecoration(
                  hintText: l.messageTo(d.who(worker).name),
                  filled: true,
                  fillColor: p.surface2,
                  isDense: true,
                  contentPadding: const EdgeInsets.symmetric(horizontal: 16, vertical: 12),
                  border: OutlineInputBorder(borderRadius: BorderRadius.circular(24), borderSide: BorderSide.none),
                ),
              ),
            ),
            const SizedBox(width: 10),
            ListenableBuilder(
              listenable: message,
              builder: (context, _) => IconButton.filled(
                key: const Key('task-send'),
                tooltip: l.messageTo(d.who(worker).name),
                onPressed: message.text.trim().isEmpty || sending ? null : () => send(worker),
                icon: const Ic('arrow_upward'),
              ),
            ),
              ],
            ),
          ],
        ),
      ),
    );
  }
}

class _Section extends StatelessWidget {
  const _Section(this.label);
  final String label;
  @override
  Widget build(BuildContext context) => Padding(
    padding: const EdgeInsets.only(bottom: 12),
    child: Semantics(header: true, child: Text(label, style: T.section.copyWith(color: context.p.text2))),
  );
}

/// אחראי, נפתחה על ידי, קוד; on the desktop's side panel also שלב, מקור, בדיקות and השלב הבא.
class _Facts extends StatelessWidget {
  const _Facts({required this.task, required this.activity, required this.side});
  final TaskProgress task;
  final TaskActivity? activity;
  final bool side;
  @override
  Widget build(BuildContext context) {
    final l = AppLocalizations.of(context), p = context.p, d = StoreScope.of(context).data!, t = task;
    final value = T.secondary.copyWith(color: p.text);
    final link = T.secondary.copyWith(color: p.accent);
    final opener = t.openedBy == null ? null : (t.openedBy == 'owner' ? null : d.who(t.openedBy!).name);
    // The message he opened it with: the first of his in its activity.
    final source = activity?.messages.where((m) => m['mine'] == true).firstOrNull;
    final pr = t.prs.where((x) => x.open).firstOrNull ?? t.prs.lastOrNull;
    // What GitHub said last time is not said as now: a PR that could not be read has no checks line.
    final ci = pr == null || pr.stale ? null : pr.ci;
    Widget row(String label, Widget child) => Padding(
      padding: const EdgeInsets.symmetric(vertical: 8),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.center,
        children: [
          SizedBox(width: side ? 110 : 120, child: Text(label, style: T.secondary.copyWith(color: p.text2))),
          const SizedBox(width: 12),
          Expanded(child: Align(alignment: AlignmentDirectional.centerStart, child: child)),
        ],
      ),
    );
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        if (side && t.stage != null)
          row(l.taskStage, StatusWord(icon: stageIcon(t.stage!), word: stageLabel(l, t.stage!), size: 14)),
        if (side && t.stage == null && t.outcome == null) row(l.taskStage, Text(l.progressUnknown, style: value)),
        if (t.worker != null)
          row(
            l.taskOwner,
            Row(
              mainAxisSize: MainAxisSize.min,
              children: [
                ProjectMonogram.person(d, t.worker!, size: 32),
                const SizedBox(width: 10),
                Flexible(child: Text([d.who(t.worker!).name, d.identities[t.worker!]?.title].whereType<String>().where((s) => s.isNotEmpty).join(', '), style: value)),
              ],
            ),
          ),
        if (opener != null || t.project != null)
          row(l.taskOpenedBy, Text([opener ?? (t.openedBy == 'owner' ? d.who('owner').name : null), projectName(d, t.project)].whereType<String>().where((s) => s.isNotEmpty).join(' · '), style: value)),
        if (side && source != null)
          row(
            l.taskSource,
            InkWell(
              onTap: () => Nav.chat(context, source['identity'] as String, preserveRoute: true, message: (id: source['id'] as String, text: source['body'] as String)),
              child: Text(l.taskSourceYours(_time(context, source['created_at'])), style: link),
            ),
          ),
        if (t.prs.isNotEmpty)
          row(
            l.taskCode,
            Wrap(
              spacing: 12,
              children: [
                for (final (i, x) in t.prs.indexed)
                  Semantics(
                    link: true,
                    child: InkWell(
                    key: ValueKey('task-pr-${x.url}'),
                    onTap: () => openExternalUrl(x.url),
                    child: Row(
                      mainAxisSize: MainAxisSize.min,
                      children: [
                        Ic('open_in_new', size: 16, color: p.accent),
                        const SizedBox(width: 4),
                        Text(t.prs.length == 1 ? 'GitHub' : l.codeChangeN(i + 1), style: link),
                      ],
                    ),
                  ),
                  ),
              ],
            ),
          ),
        if (side && pr != null && (ci == 'passed' || ci == 'failed' || ci == 'pending'))
          row(
            l.taskChecks,
            StatusWord(
              icon: ci == 'passed' ? 'check_circle' : ci == 'failed' ? 'error' : 'pending',
              word: switch (ci) {
                'passed' => l.progressCiPassed,
                'failed' => l.progressCiFailed,
                _ => l.progressCiPending,
              },
              size: 14,
            ),
          ),
        if (side && t.outcome == null) row(l.taskNext, Text(_next(l, t), style: value)),
      ],
    );
  }

  /// What comes next, from where it stands: his part named as his.
  static String _next(AppLocalizations l, TaskProgress t) {
    if (t.requests.any((r) => r.kind == 'go')) return l.nextYourGo;
    if (t.awaiting == 'verify' || t.awaiting == 'check') return l.nextYourCheck;
    return switch (t.stage) {
      TaskStage.proposal => l.nextStart,
      TaskStage.development => l.nextReview,
      TaskStage.review || TaskStage.approval => l.nextRelease,
      TaskStage.released || null => l.nextNothing,
    };
  }
}

String _time(BuildContext context, dynamic ms) => ms is int ? _when(context, DateTime.fromMillisecondsSinceEpoch(ms)) : '';

/// The company's clock, like the chats: "14:02" today, "20/10 · 14:02" on another day.
String _when(BuildContext context, DateTime at) => daysAgo(at, CompanyTime.now()) == 0 ? hm(at) : '${dm(at)} · ${hm(at)}';

class _RequestCard extends StatelessWidget {
  const _RequestCard({required this.request, required this.onOpen});
  final TaskRequest request;
  final VoidCallback onOpen;
  @override
  Widget build(BuildContext context) {
    final l = AppLocalizations.of(context), p = context.p;
    final go = request.kind == 'go';
    return Material(
      color: p.surface,
      shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(10), side: BorderSide(color: p.text, width: 1.5)),
      child: Padding(
        padding: const EdgeInsets.fromLTRB(16, 12, 16, 12),
        child: Row(
          children: [
            Ic(go ? 'front_hand' : 'help', fill: go),
            const SizedBox(width: 12),
            Expanded(child: ProductContentText(request.title, style: T.name.copyWith(color: p.text))),
            const SizedBox(width: 12),
            FilledButton(key: ValueKey('task-request-${request.id}'), onPressed: onOpen, child: Text(go ? l.reviewAndRelease : l.progressView)),
          ],
        ),
      ),
    );
  }
}

/// The activity, oldest first, each with its icon on a line, like the mockup.
class _Activity extends StatelessWidget {
  const _Activity({required this.events});
  final List<TaskEvent> events;
  @override
  Widget build(BuildContext context) {
    final p = context.p;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        for (var i = 0; i < events.length; i++)
          IntrinsicHeight(
            child: Row(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                SizedBox(
                  width: 40,
                  child: Column(
                    children: [
                      Container(
                        width: 36,
                        height: 36,
                        decoration: BoxDecoration(shape: BoxShape.circle, color: p.surface, border: Border.all(color: p.line)),
                        child: Center(child: Ic(_icon(events[i]), size: 18, color: p.text)),
                      ),
                      if (i < events.length - 1) Expanded(child: Container(width: 1, color: p.line)),
                    ],
                  ),
                ),
                const SizedBox(width: 14),
                Expanded(
                  child: Padding(
                    padding: const EdgeInsets.only(top: 6, bottom: 18),
                    child: _EventText(event: events[i]),
                  ),
                ),
              ],
            ),
          ),
      ],
    );
  }

  static String _icon(TaskEvent e) => switch (e.kind) {
    'opened' => 'add_task',
    'started' => 'play_arrow',
    'pr' => 'code',
    'checks' => e.str('ci') == 'failed' ? 'error' : 'check_circle',
    'review' => 'rate_review',
    'merged' => 'merge',
    'request' => e.str('request') == 'go' ? 'front_hand' : 'help',
    'awaiting' => 'front_hand',
    'deployed' => 'rocket_launch',
    'file' => (e.str('mime') ?? '').startsWith('image/') ? 'image' : 'description',
    'unread' => 'cloud_off',
    'done' => 'task_alt',
    _ => 'close',
  };
}

class _EventText extends StatelessWidget {
  const _EventText({required this.event});
  final TaskEvent event;
  @override
  Widget build(BuildContext context) {
    final l = AppLocalizations.of(context), p = context.p, d = StoreScope.of(context).data!, e = event;
    // His language sets the line's direction; a name or a title in the other script is isolated inside it, so
    // "Maya opened…" never reads as "…opened Maya".
    String iso(String? s) => s == null || s.isEmpty ? '' : '$kFSI${isolateLtr(s)}$kPDI';
    String name(String? id) => id == null ? '' : iso(d.who(id).name);
    final by = e.str('by');
    final title = switch (e.kind) {
      'opened' => [
        by == null ? l.evOpened : by == 'owner' ? l.evOpenedByYou : l.evOpenedBy(name(by)),
        if (e.str('worker') != null) l.evAssigned(name(e.str('worker'))),
      ].join(', '),
      'started' => l.evStarted,
      'pr' => l.evPr,
      'checks' => e.str('ci') == 'failed' ? l.evChecksFailed : l.evChecksPassed,
      'review' => [
        e.str('review') == 'changes' ? l.evReviewChanges : l.evReviewApproved,
        if (_quote(e.str('quote')) case final q?) '"$kFSI$q$kPDI"',
      ].join('. '),
      'merged' => l.evMerged,
      'request' => switch (e.str('request')) {
        'go' => l.evGo(iso(e.str('title'))),
        'login' => l.evLogin(iso(e.str('title'))),
        _ => l.evAsk(iso(e.str('title'))),
      },
      'awaiting' => switch (e.str('awaiting')) {
        'verify' => l.progressDetailVerify,
        'check' => l.progressDetailCheck,
        _ => l.progressDetailDeploy,
      },
      'deployed' => l.evDeployed,
      'file' => e.data['mine'] == true ? l.evFileYours(iso(e.str('name'))) : l.evFileFrom(name(e.str('identity')), iso(e.str('name'))),
      'unread' => l.evUnread,
      'done' => l.evDone,
      _ => l.progressCancelled,
    };
    final url = e.str('url');
    final number = e.data['number'] as int?;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text(title, textAlign: TextAlign.start, style: T.secondary.copyWith(color: p.text, fontSize: 15)),
        const SizedBox(height: 2),
        Wrap(
          crossAxisAlignment: WrapCrossAlignment.center,
          children: [
            Text(_when(context, e.at), style: T.meta.copyWith(color: p.text2)),
            if (url != null && (e.kind == 'pr' || e.kind == 'merged')) ...[
              Text(' · ', style: T.meta.copyWith(color: p.text2)),
              Semantics(
                link: true,
                child: InkWell(
                onTap: () => openExternalUrl(url),
                child: Row(
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    Ic('open_in_new', size: 14, color: p.accent),
                    const SizedBox(width: 3),
                    Text(number == null ? l.progressPullRequests : 'GitHub', style: T.meta.copyWith(color: p.accent)),
                  ],
                ),
              ),
              ),
            ],
          ],
        ),
      ],
    );
  }

  /// The line hq picked from the review for him (its summary), shortened; code in it keeps its own direction.
  static String? _quote(String? text) {
    final line = text?.trim();
    if (line == null || line.isEmpty) return null;
    final short = line.length > 140 ? '${line.substring(0, 140)}…' : line;
    // Code as it is, left to right and in one piece; emphasis marks only outside it, in the words around it.
    return short.splitMapJoin(
      RegExp(r'`([^`]*)`?'),
      onMatch: (m) => '$kLRI${m[1]!.replaceAll(' ', '\u00A0')}$kPDI',
      onNonMatch: (words) => isolateLtr(words.replaceAll(RegExp(r'[*_]'), '')),
    );
  }
}

/// The worker's notes to him about the task, and the files in it: each opens where it is.
class _NotesFiles extends StatelessWidget {
  const _NotesFiles({required this.activity, required this.wide});
  final TaskActivity? activity;
  final bool wide;
  @override
  Widget build(BuildContext context) {
    final l = AppLocalizations.of(context), p = context.p;
    final a = activity;
    if (a == null) return const SizedBox.shrink();
    final notes = [for (final m in a.messages) if (m['mine'] != true && (m['body'] as String? ?? '').trim().isNotEmpty) m];
    final cards = <Widget>[
      for (final m in notes)
        _Card(
          key: ValueKey('task-note-${m['id']}'),
          icon: 'description',
          title: (m['body'] as String).trim().split('\n').first,
          kind: l.taskNote,
          onTap: () => Nav.chat(context, m['identity'] as String, preserveRoute: true, message: (id: m['id'] as String, text: m['body'] as String)),
        ),
      for (final f in a.files)
        _Card(
          key: ValueKey('task-file-${f['id']}'),
          icon: (f['mime'] as String? ?? '').startsWith('image/') ? 'image' : 'attach_file',
          title: f['name'] as String,
          kind: l.taskFile,
          onTap: () => openFile(context, Attachment.fromJson(f)),
        ),
    ];
    if (cards.isEmpty) return Text(l.progressNoFiles, style: T.secondary.copyWith(color: p.text2));
    if (!wide) return Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: cards);
    return LayoutBuilder(
      builder: (context, c) => Wrap(
        spacing: 16,
        children: [for (final card in cards) SizedBox(width: (c.maxWidth - 16) / 2, child: card)],
      ),
    );
  }
}

class _Card extends StatelessWidget {
  const _Card({super.key, required this.icon, required this.title, required this.kind, required this.onTap});
  final String icon, title, kind;
  final VoidCallback onTap;
  @override
  Widget build(BuildContext context) {
    final p = context.p;
    return Padding(
      padding: const EdgeInsets.only(bottom: 12),
      child: Material(
        color: p.surface,
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(10), side: BorderSide(color: p.line)),
        clipBehavior: Clip.antiAlias,
        child: InkWell(
          onTap: onTap,
          child: Padding(
            padding: const EdgeInsets.fromLTRB(16, 14, 16, 14),
            child: Row(
              children: [
                Ic(icon, size: 20, color: p.text),
                const SizedBox(width: 12),
                Expanded(child: ProductContentText(title, style: T.secondary.copyWith(color: p.text), maxLines: 2, overflow: TextOverflow.ellipsis)),
                const SizedBox(width: 12),
                Text(kind, style: T.meta.copyWith(color: p.text3)),
              ],
            ),
          ),
        ),
      ),
    );
  }
}
