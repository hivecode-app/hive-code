
import 'package:flutter/material.dart';

import '../../data/store.dart';
import '../../l10n/app_localizations.dart';
import '../../model/models.dart';
import '../../theme/tokens.dart';
import 'cards.dart';
import 'artifact.dart';
import 'viewer.dart';
import '../common.dart';

/// Both entry points preserve scope while filters change. Stage C can open this with a task id.
class FilesScreen extends StatefulWidget {
  const FilesScreen({super.key, this.chat, this.task});
  final String? chat;
  final int? task;
  @override
  State<FilesScreen> createState() => _FilesScreenState();
}

class _FilesScreenState extends State<FilesScreen> {
  String? _kind;
  Future<List<Map<String, dynamic>>>? _files;
  void _load() {
    _files = StoreScope.read(context).backend.files(chat: widget.chat, task: widget.task, kind: _kind);
    // A fast offline failure can precede the next frame's FutureBuilder subscription.
    // Keep the original future (and its error) for the builder while attaching a handler now.
    _files!.ignore();
  }

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    if (_files == null) _load();
  }

  @override
  Widget build(BuildContext context) {
    final l = AppLocalizations.of(context), store = StoreScope.of(context);
    return Scaffold(
      appBar: AppBar(
        title: Text(widget.chat == null && widget.task == null ? l.mediaAllFiles : l.mediaFiles),
        actions: [
          if (widget.chat != null || widget.task != null)
            IconButton(
              tooltip: l.mediaAllFiles,
              onPressed: () => Navigator.of(context).push(MaterialPageRoute<void>(builder: (_) => const FilesScreen())),
              icon: const Ic('folder'),
            ),
        ],
      ),
      body: Column(
        children: [
          if (widget.chat != null)
            Padding(
              padding: const EdgeInsets.all(12),
              child: Text('${store.data!.who(widget.chat!).name} · ${store.data!.roleLine(widget.chat!)}', style: T.secondary),
            ),
          SingleChildScrollView(
            scrollDirection: Axis.horizontal,
            child: Padding(
              padding: const EdgeInsets.symmetric(horizontal: 12),
              child: Row(
                children: [
                  for (final (key, label) in <(String?, String)>[
                    (null, l.all),
                    ('images', l.mediaImages),
                    ('documents', l.mediaDocuments),
                    ('apps', l.mediaApps),
                    ('audio', l.mediaAudio),
                    ('other', l.mediaOther),
                  ])
                    Padding(
                      padding: const EdgeInsetsDirectional.only(end: 8),
                      child: ChoiceChip(
                        label: Text(label),
                        selected: _kind == key,
                        onSelected: (_) => setState(() {
                          _kind = key;
                          _load();
                        }),
                      ),
                    ),
                ],
              ),
            ),
          ),
          Expanded(
            child: FutureBuilder<List<Map<String, dynamic>>>(
              future: _files,
              builder: (context, snap) {
                if (snap.hasError) {
                  return Center(
                    child: Column(
                      mainAxisSize: MainAxisSize.min,
                      children: [
                        Text(l.mediaFilesFailed),
                        TextButton(onPressed: () => setState(_load), child: Text(l.retry)),
                      ],
                    ),
                  );
                }
                if (!snap.hasData) return const Center(child: CircularProgressIndicator());
                if (snap.data!.isEmpty) {
                  return Center(
                    child: Padding(
                      padding: const EdgeInsets.all(24),
                      child: Column(
                        mainAxisSize: MainAxisSize.min,
                        children: [
                          Text(_kind == null ? l.mediaEmpty : l.mediaFilteredEmpty),
                          if (_kind != null)
                            TextButton(
                              onPressed: () => setState(() {
                                _kind = null;
                                _load();
                              }),
                              child: Text(l.mediaReset),
                            ),
                        ],
                      ),
                    ),
                  );
                }
                final rows = snap.data!;
                String sender(Map<String, dynamic> row) => store.data!.who(row['sender'] as String? ?? '').name;
                String date(Map<String, dynamic> row) {
                  final at = DateTime.fromMillisecondsSinceEpoch(row['created_at'] as int? ?? 0), days = daysAgo(at, CompanyTime.now());
                  final label = days == 0 ? l.today : days == 1 ? l.yesterday : dm(at);
                  return '$label ${hm(at)}';
                }

                Widget entry(Map<String, dynamic> row, {bool desktop = false}) {
                  final a = Attachment.fromJson(row), artifact = (row['artifact'] as Map?)?.cast<String, dynamic>();
                  return InkWell(
                    onTap: () => artifact == null
                        ? openFile(context, a)
                        : Navigator.push(
                            context,
                            MaterialPageRoute<void>(
                              builder: (_) => ArtifactScreen(id: artifact['id'] as String, version: artifact['latest'] as int),
                            ),
                          ),
                    child: Padding(
                      padding: const EdgeInsets.symmetric(vertical: 14),
                      child: Row(
                        crossAxisAlignment: CrossAxisAlignment.center,
                        children: [
                          Expanded(
                            flex: 5,
                            child: Row(
                              children: [
                                SizedBox(width: 44, height: 52, child: artifact == null ? AttachmentImage(attachment: a) : const Ic('web')),
                                const SizedBox(width: 12),
                                Expanded(
                                  child: Column(
                                    crossAxisAlignment: CrossAxisAlignment.start,
                                    children: [
                                      Semantics(
                                        label: a.name,
                                        child: ExcludeSemantics(
                                          child: Text(
                                            shortFileName(a.name),
                                            style: T.name,
                                            maxLines: 2,
                                            overflow: TextOverflow.ellipsis,
                                            textDirection: firstStrongDirection(a.name),
                                          ),
                                        ),
                                      ),
                                      if (artifact == null) FileMetadata(attachment: a),
                                      if (!desktop) Text('${sender(row)} · ${date(row)}', style: T.meta),
                                    ],
                                  ),
                                ),
                              ],
                            ),
                          ),
                          if (desktop) ...[
                            const SizedBox(width: 20),
                            Expanded(flex: 2, child: Text(sender(row), style: T.secondary)),
                            Expanded(flex: 2, child: Text(date(row), style: T.secondary)),
                          ],
                          if (artifact == null) FileMenu(attachment: a) else const Padding(padding: EdgeInsets.all(12), child: Ic('open_in_new')),
                        ],
                      ),
                    ),
                  );
                }

                return LayoutBuilder(
                  builder: (context, box) {
                    if (box.maxWidth >= 840) {
                      return ListView(
                        padding: const EdgeInsets.all(20),
                        children: [
                          Row(
                            children: [
                              Expanded(flex: 5, child: Text(l.mediaFiles, style: T.name)),
                              const SizedBox(width: 20),
                              Expanded(flex: 2, child: Text(l.mediaSender, style: T.name)),
                              Expanded(flex: 2, child: Text(l.mediaDate, style: T.name)),
                              const SizedBox(width: 48),
                            ],
                          ),
                          const Divider(),
                          for (final row in rows) ...[entry(row, desktop: true), const Divider(height: 1)],
                        ],
                      );
                    }
                    final images = rows.where((row) => (row['mime'] as String).startsWith('image/') || (row['mime'] as String).startsWith('video/')).toList();
                    final others = rows.where((row) => !images.contains(row)).toList();
                    return ListView(
                      padding: const EdgeInsets.all(16),
                      children: [
                        if (images.isNotEmpty)
                          Wrap(
                            spacing: 12,
                            runSpacing: 16,
                            children: [
                              for (final row in images)
                                SizedBox(
                                  width: (box.maxWidth - 44) / 2,
                                  child: Column(
                                    crossAxisAlignment: CrossAxisAlignment.start,
                                    children: [
                                      Semantics(
                                        button: true,
                                        label: row['name'] as String,
                                        child: InkWell(
                                          onTap: () => openFile(context, Attachment.fromJson(row)),
                                          child: AspectRatio(
                                            aspectRatio: 1,
                                            child: Stack(
                                              fit: StackFit.expand,
                                              children: [
                                                AttachmentImage(attachment: Attachment.fromJson(row)),
                                                if ((row['mime'] as String).startsWith('video/')) const Center(child: Ic('play_circle')),
                                              ],
                                            ),
                                          ),
                                        ),
                                      ),
                                      Text(row['name'] as String, style: T.secondary),
                                      Text('${sender(row)} · ${date(row)}', style: T.meta),
                                    ],
                                  ),
                                ),
                            ],
                          ),
                        for (final row in others) ...[entry(row), const Divider(height: 1)],
                      ],
                    );
                  },
                );
              },
            ),
          ),
        ],
      ),
    );
  }
}
