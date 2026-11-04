import '../../model/task_progress.dart';
import '../chat/chat_screen.dart';
import '../tasks/task_screen.dart';
import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../../data/search.dart';
import '../../data/store.dart';
import '../../l10n/app_localizations.dart';
import '../../theme/tokens.dart';
import '../../model/models.dart';
import '../common.dart';
import '../nav.dart';
import 'product_theme.dart';

Future<void> openProductSearch(BuildContext context) => showDialog<void>(
  context: context,
  builder: (_) => Dialog(
    insetPadding: EdgeInsets.symmetric(horizontal: 16, vertical: 40),
    child: ConstrainedBox(constraints: BoxConstraints(maxWidth: 640, maxHeight: 650), child: const ProductSearch()),
  ),
);

class ProductSearch extends StatefulWidget {
  const ProductSearch({super.key});
  @override
  State<ProductSearch> createState() => _ProductSearchState();
}

class _ProductSearchState extends State<ProductSearch> {
  final input = TextEditingController();
  final scroll = ScrollController();
  final rowKeys = <String, GlobalKey>{};
  Timer? debounce;
  int generation = 0, selected = 0;
  bool busy = false, failed = false;
  List<SearchHit> results = [];
  @override
  void dispose() {
    debounce?.cancel();
    input.dispose();
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
      results = [];
    });
    if (q.trim().isEmpty) return;
    debounce = Timer(const Duration(milliseconds: 180), () async {
      try {
        final hits = await StoreScope.read(context).backend.search(q);
        if (mounted && gen == generation) {
          setState(() {
            results = hits;
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

  @override
  Widget build(BuildContext context) {
    final l = AppLocalizations.of(context), p = context.p;
    final d = StoreScope.of(context).data!;
    final groupLabels = {'person': l.people, 'project': l.projects, 'task': l.tasks, 'message': l.messages};
    return CallbackShortcuts(
      bindings: {
        const SingleActivator(LogicalKeyboardKey.escape): () => Navigator.pop(context),
        const SingleActivator(LogicalKeyboardKey.arrowDown): () => move(1),
        const SingleActivator(LogicalKeyboardKey.arrowUp): () => move(-1),
        const SingleActivator(LogicalKeyboardKey.enter): () {
          if (results.isNotEmpty) open(results[selected]);
        },
      },
      child: Column(
        children: [
          Padding(
            padding: const EdgeInsetsDirectional.fromSTEB(16, 4, 4, 4),
            child: Row(
              children: [
                Ic('search', color: p.text2),
                const SizedBox(width: 10),
                Expanded(
                  child: TextField(
                    key: const Key('global-search'),
                    controller: input,
                    autofocus: true,
                    onChanged: changed,
                    decoration: InputDecoration(hintText: l.search, border: InputBorder.none),
                  ),
                ),
                IBtn('close', tip: l.close, onTap: () => Navigator.pop(context)),
              ],
            ),
          ),
          Divider(height: 1, color: p.line),
          if (busy) const LinearProgressIndicator(minHeight: 2),
          Expanded(
            child: failed
                ? Center(
                    child: TextButton(onPressed: () => changed(input.text), child: Text(l.searchFailed)),
                  )
                : results.isEmpty
                ? Center(
                    child: Text(
                      input.text.isEmpty ? l.searchHint : l.noResults,
                      textAlign: TextAlign.center,
                      style: T.secondary.copyWith(color: p.text2),
                    ),
                  )
                : ListView(
                    controller: scroll,
                    children: [
                      for (final (i, h) in results.indexed) ...[
                        if (i == 0 || results[i - 1].kind != h.kind)
                          Padding(
                            padding: const EdgeInsetsDirectional.fromSTEB(20, 18, 20, 8),
                            child: Text(
                              groupLabels[h.kind] ?? l.messages,
                              style: T.small.copyWith(color: p.text2, fontWeight: FontWeight.w600),
                            ),
                          ),
                        ListTile(
                          key: rowKeys.putIfAbsent(key(h), GlobalKey.new),
                          selected: i == selected,
                          selectedTileColor: p.accentSoft,
                          onTap: () => open(h),
                          leading: h.kind == 'person'
                              ? ProjectMonogram.person(d, h.id, size: 28)
                              : Ic(switch (h.kind) {
                                  'project' => 'folder',
                                  'task' => 'task_alt',
                                  _ => 'chat',
                                }, color: p.text2),
                          title: ProductContentText(
                            h.title,
                            maxLines: 3,
                            overflow: TextOverflow.ellipsis,
                            style: T.row2.copyWith(color: p.text),
                          ),
                          subtitle: ProductContentText(
                            [
                              if (h.subtitle.isNotEmpty) h.subtitle,
                              if (h.kind == 'person') l.reportsTo(h.reportsTo != null ? d.who(h.reportsTo!).name : companyNames.owner),
                            ].join('\n'),
                            style: T.small.copyWith(color: p.text2),
                          ),
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
