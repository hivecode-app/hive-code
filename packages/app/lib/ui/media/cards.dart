import '../../data/error_report.dart';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../../data/store.dart';
import '../../l10n/app_localizations.dart';
import '../../model/models.dart';
import '../../theme/tokens.dart';
import '../common.dart';
import 'actions.dart';
import 'audio_card.dart';
import 'gallery.dart';
import 'viewer.dart';

String fileIcon(Attachment a) => a.mime.startsWith('video/')
    ? 'movie'
    : a.mime.startsWith('audio/')
    ? 'audio_file'
    : a.mime.contains('pdf')
    ? 'picture_as_pdf'
    : a.mime.contains('spreadsheet')
    ? 'table_chart'
    : a.mime.contains('zip') || a.mime.contains('tar')
    ? 'folder_zip'
    : 'description';
String fileSize(int size) => size >= 1024 * 1024 ? '${(size / 1024 / 1024).toStringAsFixed(1)} MB' : '${(size / 1024).ceil()} KB';
String shortFileName(String name) {
  final end = name.lastIndexOf('.');
  final title = end > 0 ? name.substring(0, end) : name;
  if (title.characters.length <= 46) return title;
  var first = title.characters.take(26).toString(), last = title.characters.skip(title.characters.length - 17).toString();
  if (title.contains(' ')) {
    first = first.replaceFirst(RegExp(r'\s+\S*$'), '');
    last = last.replaceFirst(RegExp(r'^\S*\s+'), '');
  }
  return '$first… $last';
}

/// Kept under the original public name so existing bubbles use one renderer for all attachments.
class BubbleImages extends StatelessWidget {
  const BubbleImages({super.key, required this.images, this.uploading = false, this.onCancel, this.onRetry, this.failed = false});
  final List<Attachment> images;
  final bool uploading, failed;
  final VoidCallback? onCancel, onRetry;
  @override
  Widget build(BuildContext context) => ListenableBuilder(listenable: StoreScope.read(context).uploads, builder: (context, _) => _content(context));
  Widget _content(BuildContext context) {
    final current = [for (final a in images) StoreScope.read(context).uploads.current(a)];
    final photos = current.where((a) => a.isImage).toList();
    return Column(
      mainAxisSize: MainAxisSize.min,
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        if (photos.isNotEmpty)
          Wrap(
            spacing: 4,
            runSpacing: 4,
            children: [
              for (var i = 0; i < photos.length.clamp(0, 4); i++)
                SizedBox(
                  width: photos.length == 1 ? 260 : 128,
                  height: photos.length == 1 ? 240 : 128,
                  child: Stack(
                    fit: StackFit.expand,
                    children: [
                      ClipRRect(
                        borderRadius: BorderRadius.circular(6),
                        child: InkWell(
                          onTap: () => openGallery(context, photos, i),
                          child: AttachmentImage(attachment: photos[i]),
                        ),
                      ),
                      if (i == 3 && photos.length > 4)
                        IgnorePointer(
                          child: Center(
                            child: DecoratedBox(
                              decoration: const BoxDecoration(color: Colors.black54),
                              child: Padding(
                                padding: const EdgeInsets.all(8),
                                child: Text('+${photos.length - 4}', style: T.bar.copyWith(color: Colors.white)),
                              ),
                            ),
                          ),
                        ),
                      if (photos[i].id == null && photos[i].transfer != null)
                        _PhotoUpload(attachment: photos[i], failed: failed || photos[i].transfer!.failed, onCancel: onCancel, onRetry: onRetry)
                      else
                        PositionedDirectional(top: 0, end: 0, child: FileMenu(attachment: photos[i])),
                    ],
                  ),
                ),
            ],
          ),
        for (final a in current.where((a) => !a.isImage))
          Padding(
            padding: const EdgeInsets.only(top: 4),
            child: FileCard(attachment: a),
          ),
      ],
    );
  }
}

/// Keep the image visible: one central control, with a separate short status label.
class _PhotoUpload extends StatelessWidget {
  const _PhotoUpload({required this.attachment, required this.failed, this.onCancel, this.onRetry});
  final Attachment attachment;
  final bool failed;
  final VoidCallback? onCancel, onRetry;
  @override
  Widget build(BuildContext context) {
    final l = AppLocalizations.of(context), transfer = attachment.transfer!;
    return Semantics(
      liveRegion: true,
      label: '${attachment.name}: ${failed ? l.mediaFailed : l.mediaUploading('${(transfer.progress * 4).floor() * 25}')}',
      child: Stack(
        children: [
          Center(
            child: SizedBox(
              width: 48,
              height: 48,
              child: DecoratedBox(
                decoration: const BoxDecoration(color: Colors.black54, shape: BoxShape.circle),
                child: Stack(
                  alignment: Alignment.center,
                  children: [
                    if (!failed)
                      Positioned.fill(
                        child: Padding(
                          padding: const EdgeInsets.all(3),
                          child: Transform.flip(
                            flipX: Directionality.of(context) == TextDirection.rtl,
                            child: CircularProgressIndicator(value: transfer.progress, color: Colors.white, strokeWidth: 3),
                          ),
                        ),
                      ),
                    IconButton(
                      tooltip: failed ? l.mediaRetry : l.mediaCancelMessage,
                      onPressed: failed ? onRetry ?? () => StoreScope.read(context).uploads.run(attachment) : onCancel,
                      icon: Ic(failed ? 'refresh' : 'close', color: Colors.white),
                    ),
                  ],
                ),
              ),
            ),
          ),
          Positioned(
            bottom: 4,
            left: 4,
            right: 4,
            child: Center(
              child: ExcludeSemantics(
                child: DecoratedBox(
                  decoration: BoxDecoration(color: Colors.black54, borderRadius: BorderRadius.circular(4)),
                  child: Padding(
                    padding: const EdgeInsets.symmetric(horizontal: 4),
                    child: Text(
                      failed ? l.mediaUploadFailedShort : l.mediaPercent('${(transfer.progress * 100).floor()}'),
                      maxLines: 1,
                      style: T.meta.copyWith(color: Colors.white),
                      textDirection: failed ? null : TextDirection.ltr,
                    ),
                  ),
                ),
              ),
            ),
          ),
          if (failed && onCancel != null)
            PositionedDirectional(
              top: 0,
              end: 0,
              child: IconButton(
                constraints: const BoxConstraints.tightFor(width: 48, height: 48),
                padding: const EdgeInsets.all(8),
                tooltip: l.mediaCancelMessage,
                onPressed: onCancel,
                icon: const DecoratedBox(
                  decoration: BoxDecoration(color: Colors.black54, shape: BoxShape.circle),
                  child: SizedBox(
                    width: 32,
                    height: 32,
                    child: Center(child: Ic('close', size: 20, color: Colors.white)),
                  ),
                ),
              ),
            ),
        ],
      ),
    );
  }
}

class FileCard extends StatelessWidget {
  const FileCard({super.key, required this.attachment});
  final Attachment attachment;
  @override
  Widget build(BuildContext context) => ListenableBuilder(listenable: StoreScope.read(context).uploads, builder: (context, _) => _content(context));
  Widget _content(BuildContext context) {
    final a = StoreScope.read(context).uploads.current(attachment), l = AppLocalizations.of(context), p = context.p;
    if (a.mime.startsWith('audio/')) {
      return AudioCard(
        attachment: a,
        actions: FileMenu(attachment: a),
      );
    }

    return ConstrainedBox(
      constraints: const BoxConstraints(maxWidth: 360),
      child: Material(
        color: p.surface,
        shape: RoundedRectangleBorder(
          borderRadius: BorderRadius.circular(9),
          side: BorderSide(color: p.line),
        ),
        child: InkWell(
          borderRadius: BorderRadius.circular(9),
          onTap: () => openFile(context, a),
          onLongPress: () => fileActions(context, a),
          child: Padding(
            padding: const EdgeInsets.all(10),
            child: Row(
              children: [
                SizedBox(
                  width: 48,
                  height: 56,
                  child: a.mime.startsWith('audio/')
                      ? const Ic('play_circle')
                      : a.id == null
                      ? Ic(fileIcon(a))
                      : AttachmentImage(attachment: a, thumbnail: true),
                ),
                const SizedBox(width: 10),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Semantics(
                        label: a.name,
                        child: ExcludeSemantics(
                          child: Text(shortFileName(a.name), maxLines: 2, overflow: TextOverflow.ellipsis, style: T.name, textDirection: firstStrongDirection(a.name)),
                        ),
                      ),
                      if (a.id == null && a.transfer != null) Text(a.transfer!.failed ? l.mediaFailed : l.mediaUploading('${(a.transfer!.progress * 100).floor()}'), style: T.meta),
                      if (a.transfer?.failed == true)
                        Wrap(
                          children: [
                            TextButton(onPressed: () => StoreScope.read(context).uploads.run(a), child: Text(l.mediaRetry)),
                            TextButton(onPressed: () => _omit(context, a), child: Text(l.mediaWithoutAction)),
                          ],
                        ),
                      FileMetadata(attachment: a),
                    ],
                  ),
                ),
                FileMenu(attachment: a),
              ],
            ),
          ),
        ),
      ),
    );
  }
}

class FileMetadata extends StatelessWidget {
  const FileMetadata({super.key, required this.attachment});
  final Attachment attachment;
  @override
  Widget build(BuildContext context) {
    final a = attachment, l = AppLocalizations.of(context), p = context.p;
    final parts = <String>[
      a.name.contains('.') ? a.name.split('.').last.toUpperCase() : a.mime.split('/').last,
      if (a.meta['pages'] != null) l.mediaPages('${a.meta['pages']}'),
      if (a.meta['sheets'] != null) l.mediaSheets('${a.meta['sheets']}'),
      if (a.meta['slides'] != null) l.mediaSlides('${a.meta['slides']}'),
      if (a.meta['files'] != null) l.mediaEntries('${a.meta['files']}'),
      if (a.meta['duration'] is num) '${(a.meta['duration'] as num).floor() ~/ 60}:${((a.meta['duration'] as num).floor() % 60).toString().padLeft(2, '0')}',
      fileSize(a.bytes),
    ];
    return Wrap(
      children: [
        for (final (index, part) in parts.indexed)
          Row(
            mainAxisSize: MainAxisSize.min,
            children: [
              if (index > 0) Text(' · ', style: T.meta.copyWith(color: p.text2)),
              Text(
                part,
                textDirection: firstStrongDirection(part),
                style: T.meta.copyWith(color: p.text2),
              ),
            ],
          ),
      ],
    );
  }
}

Future<void> _omit(BuildContext context, Attachment a) async {
  final store = StoreScope.read(context), l = AppLocalizations.of(context);
  final message = store.data?.chats.values
      .expand((c) => c.items.whereType<UserMsg>())
      .where((m) => m.attachments.contains(a) && (m.delivery == Delivery.pendingConnection || m.delivery == Delivery.failed))
      .firstOrNull;
  if (message == null) return;
  final yes = await showDialog<bool>(
    context: context,
    builder: (ctx) => AlertDialog(
      title: Text(l.mediaWithout(a.name)),
      actions: [
        TextButton(onPressed: () => Navigator.pop(ctx, false), child: Text(l.mediaCancelAction)),
        TextButton(onPressed: () => Navigator.pop(ctx, true), child: Text(l.mediaWithoutAction)),
      ],
    ),
  );
  if (yes == true) await store.omitFailedFile(message, a);
}

class FileMenu extends StatelessWidget {
  const FileMenu({super.key, required this.attachment});
  final Attachment attachment;
  @override
  Widget build(BuildContext context) {
    final l = AppLocalizations.of(context);
    return PopupMenuButton<String>(
      tooltip: l.mediaMore,
      icon: const Ic('more_vert', size: 20),
      onSelected: (key) => runFileAction(context, attachment, key),
      itemBuilder: (_) => [
        PopupMenuItem(value: 'save', child: Text(l.mediaSave)),
        PopupMenuItem(value: 'share', child: Text(l.mediaShare)),
        PopupMenuItem(value: 'copy', child: Text(l.mediaCopy)),
        PopupMenuItem(value: 'reply', child: Text(l.mediaReply)),
        PopupMenuItem(value: 'forward', child: Text(l.mediaForward)),
      ],
    );
  }
}

Future<void> fileActions(BuildContext context, Attachment a) => showModalBottomSheet<void>(
  context: context,
  builder: (_) => SafeArea(
    child: Row(
      children: [
        Expanded(child: Text(a.name)),
        FileMenu(attachment: a),
      ],
    ),
  ),
);
Future<void> runFileAction(BuildContext context, Attachment a, String key) async {
  switch (key) {
    case 'save':
      await originalAction(context, a);
    case 'share':
      await originalAction(context, a, share: true);
    case 'copy':
      await Clipboard.setData(ClipboardData(text: a.name));
    case 'reply':
      fileReply(context, a);
    case 'forward':
      final store = StoreScope.read(context), l = AppLocalizations.of(context);
      final to = await showModalBottomSheet<String>(
        context: context,
        builder: (ctx) => SafeArea(
          child: ListView(
            shrinkWrap: true,
            children: [
              for (final c in store.data!.conversations.where((c) => store.data!.canChat(c.identityId)))
                ListTile(title: Text(store.data!.who(c.identityId).name), subtitle: Text(store.data!.roleLine(c.identityId)), onTap: () => Navigator.pop(ctx, c.identityId)),
            ],
          ),
        ),
      );
      if (to != null) {
        if (!await store.addImage(to, a)) return;
        store.notice(l.mediaForwardedDraft(store.data!.who(to).name));
        store.touch();
      }
  }
}

class AttachmentImage extends StatefulWidget {
  const AttachmentImage({super.key, required this.attachment, this.fit = BoxFit.cover, this.thumbnail = true});
  final Attachment attachment;
  final BoxFit fit;
  final bool thumbnail;
  @override
  State<AttachmentImage> createState() => _AttachmentImageState();
}

class _AttachmentImageState extends State<AttachmentImage> {
  Future<Uint8List?>? _load;
  bool _reported = false;
  void _report() {
    if (!_reported && mounted && StoreScope.read(context).backend.status.state == LinkState.online) {
      _reported = true;
      reportShown('screen', AppLocalizations.of(context).mediaPreviewFailed, screen: AppLocalizations.of(context).mediaFiles);
    }
  }

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    _load ??= _fetch();
  }

  @override
  void didUpdateWidget(AttachmentImage oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.attachment.id != widget.attachment.id || oldWidget.thumbnail != widget.thumbnail) {
      _reported = false;
      _load = _fetch();
    }
  }

  Future<Uint8List?> _fetch() async {
    final a = widget.attachment, backend = StoreScope.read(context).backend;
    if (a.isImage && a.data != null) return a.data;
    if (a.isImage && !widget.thumbnail) {
      final local = await a.transfer?.read?.call();
      if (local != null) return local;
    }
    if (a.id == null) return null;
    final data = await (widget.thumbnail ? backend.attachmentThumb(a.id!) : backend.attachmentData(a.id!));
    if (data == null && !widget.thumbnail) _report();
    return data;
  }

  @override
  Widget build(BuildContext context) {
    final l = AppLocalizations.of(context), a = widget.attachment;
    return Semantics(
      image: true,
      label: a.name,
      child: FutureBuilder<Uint8List?>(
        future: _load,
        builder: (context, snap) {
          if (snap.data != null) {
            return Image.memory(snap.data!, fit: widget.fit, gaplessPlayback: true, errorBuilder: (_, _, _) => _fallback());
          }
          if (snap.connectionState != ConnectionState.done) {
            return Center(
              child: Semantics(
                label: l.mediaLoading,
                child: LoadingWatch(
                  screen: l.mediaFiles,
                  after: const Duration(seconds: 40),
                  child: const SizedBox(width: 18, height: 18, child: CircularProgressIndicator(strokeWidth: 2)),
                ),
              ),
            );
          }
          return _fallback();
        },
      ),
    );
  }

  Widget _fallback() => Center(
    child: Tooltip(
      message: AppLocalizations.of(context).mediaPreviewFailed,
      child: Ic(fileIcon(widget.attachment), color: context.p.text2),
    ),
  );
}
