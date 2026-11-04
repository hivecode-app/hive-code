import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../../data/store.dart';
import '../../l10n/app_localizations.dart';
import '../../model/models.dart';
import '../../theme/tokens.dart';
import '../common.dart';
import '../nav.dart';
import 'actions.dart';
import 'cards.dart';

typedef GallerySource = ({String chat, String message, String caption, DateTime at, bool mine});
void openGallery(BuildContext context, List<Attachment> images, int index) {
  final data = StoreScope.read(context).data;
  final chat = data?.chats.entries
      .where(
        (e) => e.value.items.any(
          (m) => switch (m) {
            UserMsg m => m.attachments.any((a) => images.any((b) => identical(a, b) || a.id != null && a.id == b.id)),
            TextMsg m => m.attachments.any((a) => images.any((b) => identical(a, b) || a.id != null && a.id == b.id)),
            _ => false,
          },
        ),
      )
      .firstOrNull;
  final all = <Attachment>[], sources = <GallerySource>[];
  if (chat != null) {
    for (final m in chat.value.items) {
      final files = switch (m) {
        UserMsg m => m.attachments,
        TextMsg m => m.attachments,
        _ => <Attachment>[],
      };
      final text = switch (m) {
        UserMsg m => m.text,
        TextMsg m => m.text,
        _ => '',
      };
      for (final a in files.where((a) => a.isImage)) {
        all.add(a);
        sources.add((chat: chat.key, message: m.id, caption: text, at: m.ts, mine: m is UserMsg));
      }
    }
  }
  final at = all.indexWhere((a) => identical(a, images[index]) || a.id != null && a.id == images[index].id);
  Navigator.of(context).push(
    PageRouteBuilder<void>(
      transitionDuration: MediaQuery.disableAnimationsOf(context) ? Duration.zero : const Duration(milliseconds: 160),
      pageBuilder: (_, _, _) => ImageViewer(
        images: at < 0 ? images : all,
        initial: at < 0 ? index : at,
        sources: at < 0 ? const [] : sources,
        conversation: chat?.key ?? images[index].meta['source_chat'] as String?,
      ),
    ),
  );
}

class ImageViewer extends StatefulWidget {
  const ImageViewer({super.key, required this.images, this.initial = 0, this.sources = const [], this.conversation});
  final List<Attachment> images;
  final int initial;
  final String? conversation;
  final List<GallerySource> sources;
  @override
  State<ImageViewer> createState() => _ImageViewerState();
}

class _ImageViewerState extends State<ImageViewer> {
  late PageController _pages = PageController(initialPage: widget.initial);
  late List<Attachment> _images = [...widget.images];
  late List<GallerySource?> _sources = [...widget.sources];
  bool _requested = false;
  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    if (!_requested && widget.conversation != null) {
      _requested = true;
      unawaited(_loadConversation());
    }
  }

  Future<void> _loadConversation() async {
    try {
      final rows = await StoreScope.read(context).backend.files(chat: widget.conversation, kind: 'images');
      if (!mounted || rows.isEmpty) return;
      final selected = _images[_at],
          byId = {
            for (final image in _images)
              if (image.id != null) image.id!: image,
          };
      final entries = <({Attachment image, GallerySource? source})>[], seen = <String>{};
      for (final row in rows) {
        if (!(row['mime'] as String? ?? '').startsWith('image/') || row['id'] is! String) continue;
        final id = row['id'] as String, previous = byId[id];
        seen.add(id);
        entries.add((
          image: Attachment.fromJson(row, data: previous?.data, transfer: previous?.transfer),
          source: (
            chat: widget.conversation!,
            message: row['message'] as String,
            caption: row['caption'] as String? ?? '',
            at: DateTime.fromMillisecondsSinceEpoch((row['created_at'] as num?)?.toInt() ?? 0),
            mine: row['sender'] == 'owner',
          ),
        ));
      }
      for (final (index, image) in _images.indexed) {
        if (image.id == null || !seen.contains(image.id)) entries.add((image: image, source: index < _sources.length ? _sources[index] : null));
      }
      entries.sort((a, b) => (a.source?.at ?? CompanyTime.now()).compareTo(b.source?.at ?? CompanyTime.now()));
      final at = entries.indexWhere((entry) => identical(entry.image, selected) || selected.id != null && entry.image.id == selected.id);
      if (at < 0) return;
      final previous = _pages;
      setState(() {
        _images = entries.map((entry) => entry.image).toList();
        _sources = entries.map((entry) => entry.source).toList();
        _at = at;
        _pages = PageController(initialPage: at);
      });
      WidgetsBinding.instance.addPostFrameCallback((_) {
        previous.dispose();
      });
    } catch (_) {
      /* The initial, already available images remain usable offline. */
    }
  }

  final _transform = TransformationController();
  late int _at = widget.initial;
  Offset _doubleAt = Offset.zero;
  double _scale = 1;
  void _zoom(double value, [Offset? point]) {
    final scale = value.clamp(1.0, 5.0), p = point ?? Offset.zero;
    setState(() {
      _scale = scale;
      _transform.value = Matrix4.identity()
        ..translateByDouble(-p.dx * (scale - 1), -p.dy * (scale - 1), 0, 1)
        ..scaleByDouble(scale, scale, 1, 1);
    });
  }

  void _move(int at) {
    if (at < 0 || at >= _images.length) return;
    _zoom(1);
    if (MediaQuery.disableAnimationsOf(context)) {
      _pages.jumpToPage(at);
    } else {
      _pages.animateToPage(at, duration: const Duration(milliseconds: 160), curve: Curves.easeOut);
    }
  }

  @override
  void dispose() {
    _pages.dispose();
    _transform.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final l = AppLocalizations.of(context), a = _images[_at];
    final rtl = Directionality.of(context) == TextDirection.rtl,
        nextIcon = chevronIcon(context),
        previousIcon = chevronIcon(context) == 'chevron_left' ? 'chevron_right' : 'chevron_left';
    final source = _sources.length > _at ? _sources[_at] : null;
    final data = StoreScope.read(context).data;
    return CallbackShortcuts(
      bindings: {
        const SingleActivator(LogicalKeyboardKey.escape): () => Navigator.pop(context),
        const SingleActivator(LogicalKeyboardKey.arrowLeft): () => _move(_at + (rtl ? 1 : -1)),
        const SingleActivator(LogicalKeyboardKey.arrowRight): () => _move(_at + (rtl ? -1 : 1)),
        const SingleActivator(LogicalKeyboardKey.equal): () => _zoom(_scale + 1),
        const SingleActivator(LogicalKeyboardKey.minus): () => _zoom(_scale - 1),
      },
      child: Focus(
        autofocus: true,
        child: Theme(
          data: ThemeData.dark().copyWith(textTheme: ThemeData.dark().textTheme.apply(fontFamily: kFont)),
          child: Scaffold(
            backgroundColor: Colors.black,
            appBar: AppBar(
              backgroundColor: Colors.black,
              leading: IconButton(
                tooltip: l.close,
                icon: const Ic('close', color: Colors.white),
                onPressed: () => Navigator.pop(context),
              ),
              title: Text(l.mediaCount('${_at + 1}', '${_images.length}')),
              actions: [
                IconButton(
                  tooltip: l.mediaShare,
                  onPressed: () => originalAction(context, a, share: true),
                  icon: const Ic('share', color: Colors.white),
                ),
                IconButton(
                  tooltip: l.mediaSave,
                  onPressed: () => originalAction(context, a),
                  icon: const Ic('download', color: Colors.white),
                ),
              ],
            ),
            body: Column(
              children: [
                Expanded(
                  child: GestureDetector(
                    onVerticalDragEnd: _scale <= 1
                        ? (d) {
                            if ((d.primaryVelocity ?? 0) > 650) {
                              Navigator.pop(context);
                            }
                          }
                        : null,
                    child: PageView.builder(
                      key: ValueKey(_pages),
                      controller: _pages,
                      physics: _scale > 1 ? const NeverScrollableScrollPhysics() : null,
                      itemCount: _images.length,
                      onPageChanged: (i) {
                        _zoom(1);
                        setState(() => _at = i);
                      },
                      itemBuilder: (_, i) => GestureDetector(
                        onDoubleTapDown: (d) => _doubleAt = d.localPosition,
                        onDoubleTap: () => _zoom(_scale > 1 ? 1 : 2.5, _doubleAt),
                        child: InteractiveViewer(
                          transformationController: i == _at ? _transform : null,
                          maxScale: 5,
                          panEnabled: _scale > 1,
                          onInteractionEnd: (_) {
                            if (i == _at) {
                              setState(() => _scale = _transform.value.getMaxScaleOnAxis());
                            }
                          },
                          child: Center(
                            child: AttachmentImage(attachment: _images[i], fit: BoxFit.contain, thumbnail: false),
                          ),
                        ),
                      ),
                    ),
                  ),
                ),
                Padding(
                  padding: const EdgeInsets.symmetric(horizontal: 12),
                  child: Column(
                    children: [
                      Text(a.name, maxLines: 2, overflow: TextOverflow.ellipsis, style: T.body),
                      if (source != null)
                        Wrap(
                          alignment: WrapAlignment.center,
                          spacing: 8,
                          children: [
                            Text(source.mine ? (data?.ownerName.isNotEmpty == true ? data!.ownerName : l.mediaYou) : data?.who(source.chat).name ?? '', style: T.meta),
                            Text(MaterialLocalizations.of(context).formatCompactDate(source.at), style: T.meta),
                            Text(MaterialLocalizations.of(context).formatTimeOfDay(TimeOfDay.fromDateTime(source.at)), style: T.meta, textDirection: TextDirection.ltr),
                            Text(fileSize(a.bytes), style: T.meta, textDirection: TextDirection.ltr),
                          ],
                        ),
                      if (source != null) Text(source.caption, maxLines: 2, style: T.secondary),
                      Wrap(
                        alignment: WrapAlignment.center,
                        crossAxisAlignment: WrapCrossAlignment.center,
                        children: [
                          IconButton(
                            tooltip: l.mediaPrevious,
                            onPressed: _at > 0 ? () => _move(_at - 1) : null,
                            icon: Ic(previousIcon, color: Colors.white),
                          ),
                          IconButton(
                            tooltip: l.mediaZoomOut,
                            onPressed: () => _zoom(_scale - .5),
                            icon: const Ic('zoom_out', color: Colors.white),
                          ),
                          Text('${(_scale * 100).round()}%'),
                          IconButton(
                            tooltip: l.mediaZoomIn,
                            onPressed: () => _zoom(_scale + .5),
                            icon: const Ic('zoom_in', color: Colors.white),
                          ),
                          IconButton(
                            tooltip: l.mediaNext,
                            onPressed: _at < _images.length - 1 ? () => _move(_at + 1) : null,
                            icon: Ic(nextIcon, color: Colors.white),
                          ),
                          if (source != null)
                            TextButton(
                              onPressed: () {
                                Nav.chat(context, source.chat, preserveRoute: true, message: (id: source.message, text: source.caption));
                              },
                              child: Text(l.mediaInChat),
                            ),
                        ],
                      ),
                    ],
                  ),
                ),
                if (_images.length > 1)
                  SafeArea(
                    top: false,
                    child: SizedBox(
                      height: 68,
                      child: ListView.builder(
                        scrollDirection: Axis.horizontal,
                        itemCount: _images.length,
                        itemBuilder: (context, i) => Padding(
                          padding: const EdgeInsets.all(4),
                          child: Semantics(
                            selected: i == _at,
                            button: true,
                            label: _images[i].name,
                            child: InkWell(
                              onTap: () => _move(i),
                              child: Container(
                                width: 58,
                                decoration: BoxDecoration(border: Border.all(color: i == _at ? Colors.white : Colors.transparent, width: 2)),
                                child: AttachmentImage(attachment: _images[i]),
                              ),
                            ),
                          ),
                        ),
                      ),
                    ),
                  ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}
