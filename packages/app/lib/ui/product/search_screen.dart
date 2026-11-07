import '../../model/task_progress.dart';
import '../chat/chat_screen.dart';
import '../tasks/task_copy.dart';
import '../tasks/task_screen.dart';
import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../../data/backend.dart';
import '../../data/search.dart';
import '../../data/store.dart';
import '../../l10n/app_localizations.dart';
import '../../theme/tokens.dart';
import '../../model/models.dart';
import '../common.dart';
import '../nav.dart';
import 'product_theme.dart';

/// Search opens over the desktop as a dialog, and on the phone as a screen of its own (mockup a-he-search).
Future<void> openProductSearch(BuildContext context) {
  final size = MediaQuery.sizeOf(context);
  if (size.width < 840) {
    return Navigator.of(context).push(
      MaterialPageRoute<void>(
        builder: (context) => Scaffold(
          backgroundColor: context.p.bg,
          body: const SafeArea(child: ProductSearch(fullScreen: true)),
        ),
      ),
    );
  }
  return showDialog<void>(
    context: context,
    builder: (_) => Dialog(
      insetPadding: const EdgeInsets.symmetric(horizontal: 16, vertical: 40),
      clipBehavior: Clip.antiAlias,
      child: ConstrainedBox(constraints: const BoxConstraints(maxWidth: 640, maxHeight: 650), child: const ProductSearch()),
    ),
  );
}

/// What the chips show. Projects appear only under "all".
enum SearchFilter { all, tasks, people, notes }

class ProductSearch extends StatefulWidget {
  const ProductSearch({super.key, this.fullScreen = false});
  final bool fullScreen;
  @override
  State<ProductSearch> createState() => _ProductSearchState();
}

class _ProductSearchState extends State<ProductSearch> {
  final input = TextEditingController();
  final inputFocus = FocusNode();
  @override
  void initState() {
    super.initState();
    // The field holds the keyboard from the first frame, also over a chat whose composer had it.
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (mounted) inputFocus.requestFocus();
    });
  }
  final scroll = ScrollController();
  final rowKeys = <String, GlobalKey>{};
  Timer? debounce;
  int generation = 0, selected = 0;
  bool busy = false, failed = false;
  List<SearchHit> found = [];
  SearchFilter filter = SearchFilter.all;

  /// The mockup's order: projects, people, tasks, notes. Within a group, hq's order (active before old).
  static const groupOrder = ['project', 'person', 'task', 'message'];

  /// "All" is a summary: this many of each group, then "all N" (as Slack and Linear do).
  static const perGroup = 3;

  /// Projects have no chip of their own: their "all N" opens the rest in place.
  bool allProjects = false;

  List<SearchHit> get results {
    final kinds = switch (filter) {
      SearchFilter.all => groupOrder,
      SearchFilter.tasks => const ['task'],
      SearchFilter.people => const ['person'],
      SearchFilter.notes => const ['message'],
    };
    return [
      for (final k in kinds) ...found.where((h) => h.kind == k).take(filter == SearchFilter.all && !(k == 'project' && allProjects) ? perGroup : 1 << 30),
    ];
  }

  /// How many of a kind hq found, when "all" shows fewer.
  int? hidden(String kind) {
    if (filter != SearchFilter.all || (kind == 'project' && allProjects)) return null;
    final n = found.where((h) => h.kind == kind).length;
    return n > perGroup ? n : null;
  }

  void more(String kind) {
    if (kind == 'project') return setState(() => allProjects = true);
    pick(switch (kind) { 'person' => SearchFilter.people, 'task' => SearchFilter.tasks, _ => SearchFilter.notes });
  }

  void pick(SearchFilter f) => setState(() {
    filter = f;
    selected = 0;
  });
  @override
  void dispose() {
    debounce?.cancel();
    input.dispose();
    inputFocus.dispose();
    scroll.dispose();
    super.dispose();
  }

  void changed(String q) {
    debounce?.cancel();
    final gen = ++generation;
    setState(() {
      selected = 0;
      busy = q.trim().isNotEmpty;
      failed = false;
      found = [];
      allProjects = false;
    });
    if (q.trim().isEmpty) return;
    debounce = Timer(const Duration(milliseconds: 180), () async {
      try {
        final hits = await StoreScope.read(context).backend.search(q);
        if (mounted && gen == generation) {
          setState(() {
            found = hits;
            busy = false;
          });
        }
      } catch (_) {
        if (mounted && gen == generation) {
          setState(() {
            failed = true;
            busy = false;
          });
        }
      }
    });
  }

  String key(SearchHit h) => '${h.kind}:${h.id}';
  void move(int delta) {
    final results = this.results;
    if (results.isEmpty) return;
    setState(() => selected = (selected + delta).clamp(0, results.length - 1));
    final c = rowKeys[key(results[selected])]?.currentContext;
    if (c != null) Scrollable.ensureVisible(c, alignment: .5, duration: const Duration(milliseconds: 100));
  }

  Future<void> open(SearchHit hit) async {
    final root = Navigator.of(context);
    final data = StoreScope.read(context).data!;
    // The dialog shares the app navigator. Navigation uses its still-mounted parent context.
    final target = root.context;
    if (hit.kind == 'task') {
      await root.push(MaterialPageRoute<void>(builder: (_) => ProductTaskScreen(id: int.parse(hit.id), initial: TaskProgress(id: int.parse(hit.id), title: hit.title, body: hit.body, project: hit.project, worker: hit.identity))));
    } else if (hit.kind == 'project') {
      Nav.project(target, hit.project ?? hit.id);
    } else if (hit.identity != null && data.canChat(hit.identity!)) {
      if (hit.kind == 'message') {
        ChatScreen.pendingTarget[hit.identity!] = hit.id;
        ChatScreen.pendingTargetText[hit.identity!] = hit.title;
        ChatScreen.pendingFlash.add(hit.identity!);
        ChatScreen.pendingSource.add(hit.identity!);
      }
      if (hit.kind == 'person') {
        data.identities.putIfAbsent(hit.identity!, () => Identity(id: hit.identity!, name: hit.title, title: hit.subtitle, teamId: hit.project ?? ''));
      }
      await root.push(MaterialPageRoute<void>(builder: (_) => ChatScreen(identityId: hit.identity!)));
    } else if (hit.project != null) {
      Nav.project(target, hit.project!);
    }
  }

  /// The second line of a row: never a raw project id, always the stage of a task.
  String meta(AppLocalizations l, CompanyData d, SearchHit h) {
    String stageOf(SearchHit h) => h.waiting
        ? l.needsYou
        : h.outcome == 'cancelled'
        ? l.searchCancelled
        : h.outcome == 'completed'
        ? l.searchFinished
        : h.stage == null
        ? ''
        : stageLabel(l, h.stage!);
    String join(Iterable<String?> parts) => parts.whereType<String>().where((s) => s.isNotEmpty).join(' · ');
    return switch (h.kind) {
      'project' => join([if (h.leadName != null) l.searchLedBy(h.leadName!), if (h.openTasks != null) l.searchOpenTasks(h.openTasks!)]),
      'person' => d.needsYou.any((w) => w.from == (h.identity ?? h.id))
          ? l.needsYou
          : join([
              if (h.leadName != null) h.leads ? l.reportsTo(h.leadName!) : l.searchInTeamOf(h.leadName!),
              if (h.nowTask != null) h.nowTask!.stage == null ? h.nowTask!.title : l.searchTaskStage(h.nowTask!.title, stageLabel(l, h.nowTask!.stage!)),
              if (h.leadName == null && h.nowTask == null && h.reportsTo != null && h.reportsTo != 'owner') l.reportsTo(d.who(h.reportsTo!).name),
            ]),
      'task' => join([h.projectName ?? (h.project == null ? null : d.teams[h.project]?.name), stageOf(h)]),
      _ => join([h.subtitle, h.taskTitle]),
    };
  }

  String icon(SearchHit h) => switch (h.kind) {
    'project' => 'folder',
    // A check mark only on what ended (as in #436): a task whose stage is not known yet gets a neutral circle.
    'task' => h.waiting ? 'front_hand' : h.outcome != null ? 'check_circle' : h.stage == null ? 'radio_button_unchecked' : stageIcon(h.stage!),
    _ => 'description',
  };

  Widget row(BuildContext context, CompanyData d, SearchHit h, int i) {
    final l = AppLocalizations.of(context), p = context.p;
    final second = meta(l, d, h);
    // "מפתח · יומן שטח": the role, and the project unless the role already names it.
    final role = h.kind != 'person'
        ? ''
        : [
            if ((h.role ?? '').isNotEmpty) h.role!,
            if ((h.projectName ?? '').isNotEmpty && !(h.role ?? '').contains(h.projectName!)) h.projectName!,
          ].join(' · ');
    return Material(
      key: rowKeys.putIfAbsent(key(h), GlobalKey.new),
      color: i == selected && !widget.fullScreen ? p.accentSoft : p.surface,
      child: InkWell(
        onTap: () => open(h),
        child: Container(
          constraints: const BoxConstraints(minHeight: 64),
          padding: const EdgeInsetsDirectional.fromSTEB(20, 12, 20, 12),
          decoration: BoxDecoration(border: Border(bottom: BorderSide(color: p.line, width: .5))),
          child: Row(
            children: [
              if (h.kind == 'person')
                ProjectMonogram.person(d, h.id, size: 32)
              else if (h.kind == 'project')
                Container(
                  width: 32,
                  height: 32,
                  alignment: Alignment.center,
                  decoration: BoxDecoration(shape: BoxShape.circle, color: p.surface2, border: Border.all(color: p.line)),
                  child: Ic(icon(h), size: 18, color: p.text2),
                )
              else
                SizedBox(width: 32, child: Ic(icon(h), size: 22, color: p.text2)),
              const SizedBox(width: 14),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    if (h.kind == 'person')
                      Text.rich(
                        TextSpan(
                          children: [
                            TextSpan(text: h.title, style: T.name.copyWith(color: p.text)),
                            if (role.isNotEmpty) TextSpan(text: '  $role', style: T.small.copyWith(color: p.text3)),
                          ],
                        ),
                        maxLines: 2,
                        overflow: TextOverflow.ellipsis,
                      )
                    else if (h.kind == 'message')
                      Text.rich(
                        matchSpan(h.title, input.text, T.row2.copyWith(color: p.text)),
                        textDirection: paragraphDirection(h.title),
                        textAlign: TextAlign.start,
                        maxLines: 2,
                        overflow: TextOverflow.ellipsis,
                      )
                    else
                      ProductContentText(
                        h.title,
                        maxLines: 3,
                        overflow: TextOverflow.ellipsis,
                        style: T.name.copyWith(fontWeight: FontWeight.w500, color: p.text),
                      ),
                    if (second.isNotEmpty) ...[
                      const SizedBox(height: 2),
                      ProductContentText(second, maxLines: 2, overflow: TextOverflow.ellipsis, style: T.small.copyWith(color: p.text2)),
                    ],
                  ],
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }

  Widget chip(String text, SearchFilter f) {
    final p = context.p, on = filter == f;
    return Padding(
      padding: const EdgeInsetsDirectional.only(end: 8),
      child: Material(
        color: on ? p.surface2 : p.surface,
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(8), side: BorderSide(color: on ? Colors.transparent : p.line)),
        child: InkWell(
          key: Key('search-filter-${f.name}'),
          onTap: () => pick(f),
          borderRadius: BorderRadius.circular(8),
          child: Padding(
            padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 8),
            child: Text(text, style: T.row2.copyWith(color: p.text, fontWeight: on ? FontWeight.w600 : FontWeight.w400)),
          ),
        ),
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    final l = AppLocalizations.of(context), p = context.p;
    final d = StoreScope.of(context).data!;
    final results = this.results;
    final groupLabels = {'person': l.people, 'project': l.projects, 'task': l.tasks, 'message': l.searchNotes};
    final field = TextField(
      key: const Key('global-search'),
      controller: input,
      focusNode: inputFocus,
      autofocus: true,
      onChanged: changed,
      decoration: InputDecoration(hintText: l.search, border: InputBorder.none),
    );
    return CallbackShortcuts(
      bindings: {
        const SingleActivator(LogicalKeyboardKey.escape): () => Navigator.pop(context),
        const SingleActivator(LogicalKeyboardKey.arrowDown): () => move(1),
        const SingleActivator(LogicalKeyboardKey.arrowUp): () => move(-1),
        const SingleActivator(LogicalKeyboardKey.enter): () {
          if (results.isNotEmpty) open(results[selected.clamp(0, results.length - 1)]);
        },
      },
      child: ColoredBox(
        color: widget.fullScreen ? p.bg : Colors.transparent,
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            if (widget.fullScreen)
              Padding(
                padding: const EdgeInsets.fromLTRB(16, 8, 16, 4),
                child: Container(
                  height: 44,
                  padding: const EdgeInsetsDirectional.only(start: 12),
                  decoration: BoxDecoration(color: p.surface2, borderRadius: BorderRadius.circular(10)),
                  child: Row(
                    children: [
                      Ic('search', size: 22, color: p.text2),
                      const SizedBox(width: 10),
                      Expanded(child: field),
                      IBtn('close', tip: l.close, onTap: () => Navigator.pop(context)),
                    ],
                  ),
                ),
              )
            else ...[
              Padding(
                padding: const EdgeInsetsDirectional.fromSTEB(18, 4, 6, 4),
                child: Row(
                  children: [
                    Ic('search', color: p.text2),
                    const SizedBox(width: 10),
                    Expanded(child: field),
                    IBtn('close', tip: '${l.close} (Esc)', onTap: () => Navigator.pop(context)),
                  ],
                ),
              ),
              Divider(height: 1, color: p.line),
            ],
            SingleChildScrollView(
              scrollDirection: Axis.horizontal,
              // Chips start at the reading edge, as on the home screen, never centred.
              padding: const EdgeInsetsDirectional.fromSTEB(16, 10, 16, 6),
              child: Row(
                children: [
                  chip(l.all, SearchFilter.all),
                  chip(l.tasks, SearchFilter.tasks),
                  chip(l.people, SearchFilter.people),
                  chip(l.searchNotes, SearchFilter.notes),
                ],
              ),
            ),
            if (busy) const LinearProgressIndicator(minHeight: 2),
            Expanded(
              child: failed
                  ? Center(
                      child: TextButton(onPressed: () => changed(input.text), child: Text(l.searchFailed)),
                    )
                  : results.isEmpty
                  ? Center(
                      child: Padding(
                        padding: const EdgeInsets.all(24),
                        child: Text(
                          input.text.isEmpty ? l.searchHint : l.noResults,
                          textAlign: TextAlign.center,
                          style: T.secondary.copyWith(color: p.text2),
                        ),
                      ),
                    )
                  : ListView(
                      controller: scroll,
                      children: [
                        for (final (i, h) in results.indexed) ...[
                          if (i == 0 || results[i - 1].kind != h.kind)
                            Container(
                              padding: const EdgeInsetsDirectional.fromSTEB(20, 22, 20, 8),
                              decoration: BoxDecoration(border: Border(bottom: BorderSide(color: p.line, width: .5))),
                              child: Text(
                                groupLabels[h.kind] ?? l.searchNotes,
                                style: T.section.copyWith(color: p.text2),
                              ),
                            ),
                          row(context, d, h, i),
                          if ((i == results.length - 1 || results[i + 1].kind != h.kind) && hidden(h.kind) != null)
                            Material(
                              color: p.surface,
                              child: InkWell(
                                key: Key('search-more-${h.kind}'),
                                onTap: () => more(h.kind),
                                child: Container(
                                  constraints: const BoxConstraints(minHeight: 48),
                                  padding: const EdgeInsetsDirectional.fromSTEB(66, 12, 20, 12),
                                  alignment: AlignmentDirectional.centerStart,
                                  decoration: BoxDecoration(border: Border(bottom: BorderSide(color: p.line, width: .5))),
                                  child: Row(children: [
                                    Expanded(child: Text(l.searchAll(hidden(h.kind)!), style: T.row2.copyWith(color: p.text, fontWeight: FontWeight.w600))),
                                    Ic(chevronIcon(context), size: 20, color: p.text3),
                                  ]),
                                ),
                              ),
                            ),
                        ],
                      ],
                    ),
            ),
          ],
        ),
      ),
    );
  }
}

/// A note from the words that matched, with them in bold (as WhatsApp's search): a match deep in a long note
/// starts the line a little before it, so it is never cut away. In a Hebrew note each piece isolates its
/// English (a PR, a path, a branch), as ProductContentText does for the whole line.
TextSpan matchSpan(String text, String query, TextStyle style) {
  final flat = text.replaceAll(RegExp(r'\s+'), ' ').trim();
  final rtl = paragraphDirection(flat) == TextDirection.rtl;
  String iso(String s) => rtl ? isolateLtr(s, force: true) : s;
  final q = query.trim().toLowerCase();
  final at = q.isEmpty ? -1 : flat.toLowerCase().indexOf(q);
  if (at < 0) return TextSpan(text: iso(flat), style: style);
  final from = at > 40 ? flat.lastIndexOf(' ', at - 24) + 1 : 0;
  return TextSpan(style: style, children: [
    TextSpan(text: iso('${from > 0 ? '…' : ''}${flat.substring(from, at)}')),
    TextSpan(text: iso(flat.substring(at, at + q.length)), style: const TextStyle(fontWeight: FontWeight.w700)),
    TextSpan(text: iso(flat.substring(at + q.length))),
  ]);
}
