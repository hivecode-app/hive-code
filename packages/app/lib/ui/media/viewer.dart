import 'dismiss.dart';

import 'dart:typed_data';

import 'package:flutter/material.dart';
import 'package:pdfrx/pdfrx.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:video_player/video_player.dart';

import '../../data/store.dart';
import '../../l10n/app_localizations.dart';
import '../../model/models.dart';
import '../../native/media_player.dart';
import '../../theme/tokens.dart';
import '../common.dart';
import 'actions.dart';
import 'cards.dart';
import 'gallery.dart';

Future<void> openFile(BuildContext context, Attachment a) async {
  if (a.isImage) {
    openGallery(context, [a], 0);
    return;
  }
  await Navigator.of(context).push(
    PageRouteBuilder<void>(
      pageBuilder: (_, _, _) => FileViewer(attachment: a),
      transitionDuration: MediaQuery.disableAnimationsOf(context) ? Duration.zero : const Duration(milliseconds: 160),
    ),
  );
}

class FileViewer extends StatefulWidget {
  const FileViewer({super.key, required this.attachment});
  final Attachment attachment;
  @override
  State<FileViewer> createState() => _FileViewerState();
}

class _FileViewerState extends State<FileViewer> {
  Future<Uint8List?>? _data;
  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    final a = widget.attachment, b = StoreScope.read(context).backend;
    _data ??= () async {
      if (a.mime.contains('wordprocessing') || a.mime.contains('presentation') || a.mime.contains('opendocument')) {
        return a.id == null ? null : await b.attachmentPreview(a.id!);
      }
      if ((a.mime.startsWith('audio/') || a.mime.startsWith('video/')) && supportsStreamingMedia && a.id != null && b.mediaSource(a.id!) != null) return Uint8List(0);
      if (a.mime == 'application/pdf' || a.mime.startsWith('audio/') || a.mime.startsWith('video/')) {
        return a.data ?? await a.transfer?.read?.call() ?? (a.id == null ? null : await b.attachmentData(a.id!));
      }
      return Uint8List(0); // Other previews and archive listings do not download the original.
    }();
  }

  @override
  Widget build(BuildContext context) {
    final a = widget.attachment, l = AppLocalizations.of(context);
    return DismissMedia(
      child: Scaffold(
        appBar: AppBar(
          toolbarHeight: mediaToolbarHeight(context, a.name, actions: 2),
          leading: IconButton(tooltip: l.close, onPressed: () => Navigator.maybePop(context), icon: const Ic('close')),
          title: Text(a.name, maxLines: 3, overflow: TextOverflow.ellipsis),
          actions: [
            IconButton(tooltip: l.mediaShare, onPressed: () => originalAction(context, a, share: true), icon: const Ic('share')),
            IconButton(tooltip: l.mediaSave, onPressed: () => originalAction(context, a), icon: const Ic('download')),
          ],
        ),
        body: FutureBuilder<Uint8List?>(
          future: _data,
          builder: (context, snap) {
            if (snap.connectionState != ConnectionState.done) {
              return Center(
                child: Column(mainAxisSize: MainAxisSize.min, children: [const CircularProgressIndicator(), Text(l.mediaLoading)]),
              );
            }
            if (snap.data == null) {
              return Center(
                child: Padding(
                  padding: const EdgeInsets.all(24),
                  child: Column(
                    mainAxisSize: MainAxisSize.min,
                    children: [
                      Text(l.mediaPreviewFailed),
                      TextButton(onPressed: () => originalAction(context, a), child: Text(l.mediaSave)),
                      TextButton(
                        onPressed: () => setState(() {
                          _data = null;
                          didChangeDependencies();
                        }),
                        child: Text(l.retry),
                      ),
                    ],
                  ),
                ),
              );
            }
            if (a.mime.contains('pdf') || a.mime.contains('wordprocessing') || a.mime.contains('presentation') || a.mime.contains('opendocument')) {
              return PdfView(bytes: snap.data!, attachment: a);
            }
            if (a.mime.startsWith('video/') || a.mime.startsWith('audio/')) {
              return MediaPlayback(bytes: snap.data!, attachment: a);
            }
            if (a.mime.contains('zip') || a.mime.contains('tar') || a.mime.contains('gzip')) {
              return ArchiveView(attachment: a);
            }
            return Center(
              child: Padding(
                padding: const EdgeInsets.all(24),
                child: Column(
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    Ic(fileIcon(a), size: 48),
                    const SizedBox(height: 16),
                    Text(l.mediaPreviewFailed),
                    TextButton(onPressed: () => originalAction(context, a), child: Text(l.mediaSave)),
                  ],
                ),
              ),
            );
          },
        ),
      ),
    );
  }
}

class PdfView extends StatefulWidget {
  const PdfView({super.key, required this.bytes, required this.attachment});
  final Uint8List bytes;
  final Attachment attachment;
  @override
  State<PdfView> createState() => _PdfViewState();
}

class _PdfViewState extends State<PdfView> {
  final _controller = PdfViewerController();
  late final _searcher = PdfTextSearcher(_controller)..addListener(_changed);
  final _search = TextEditingController();
  int _page = 1, _total = 0;
  SharedPreferences? _prefs;
  bool _loaded = false;
  List<double>? _matrix, _lastMatrix;
  String get _key => 'pdf:${widget.attachment.id ?? widget.attachment.name}';
  @override
  void initState() {
    super.initState();
    _controller.addListener(_positionChanged);
    _loadPosition();
  }

  Future<void> _loadPosition() async {
    _prefs = await SharedPreferences.getInstance();
    if (mounted) {
      setState(() {
        _page = _prefs?.getInt(_key) ?? 1;
        _matrix = _prefs?.getStringList('$_key:position')?.map(double.parse).toList();
        _loaded = true;
      });
    }
  }

  void _positionChanged() {
    if (_controller.isReady) _lastMatrix = List<double>.of(_controller.value.storage);
  }

  void _changed() {
    if (mounted) setState(() {});
  }

  @override
  void dispose() {
    if (_lastMatrix != null) _prefs?.setStringList('$_key:position', _lastMatrix!.map((v) => '$v').toList());
    _controller.removeListener(_positionChanged);
    _searcher.removeListener(_changed);
    _searcher.dispose();
    _search.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final l = AppLocalizations.of(context), p = context.p;
    final nextIcon = chevronIcon(context), previousIcon = chevronIcon(context) == 'chevron_left' ? 'chevron_right' : 'chevron_left';
    final duration = MediaQuery.disableAnimationsOf(context) ? Duration.zero : const Duration(milliseconds: 160);
    return Column(
      children: [
        Padding(
          padding: const EdgeInsets.symmetric(horizontal: 12),
          child: Row(
            children: [
              Expanded(
                child: TextField(
                  controller: _search,
                  decoration: InputDecoration(hintText: l.mediaSearch, prefixIcon: const Ic('search')),
                  onChanged: (text) => _searcher.startTextSearch(text),
                ),
              ),
              IconButton(
                tooltip: l.mediaPrevious,
                onPressed: _searcher.hasMatches ? () => _searcher.goToMatchOfIndex(((_searcher.currentIndex ?? 0) - 1).clamp(0, _searcher.matches.length - 1)) : null,
                icon: Ic(previousIcon),
              ),
              IconButton(tooltip: l.mediaNext, onPressed: _searcher.hasMatches ? _searcher.goToNextMatch : null, icon: Ic(nextIcon)),
            ],
          ),
        ),
        if (_search.text.isNotEmpty && !_searcher.isSearching)
          Padding(
            padding: const EdgeInsets.all(8),
            child: Text(_searcher.matches.isEmpty ? l.mediaSearchEmpty : l.mediaCount('${(_searcher.currentIndex ?? 0) + 1}', '${_searcher.matches.length}')),
          ),
        Expanded(
          child: !_loaded
              ? const Center(child: CircularProgressIndicator())
              : PdfViewer.data(
                  widget.bytes,
                  sourceName: _key,
                  controller: _controller,
                  initialPageNumber: _page,
                  params: PdfViewerParams(
                    backgroundColor: p.bg,
                    onViewerReady: (document, controller) {
                      if (mounted) {
                        setState(() => _total = document.pages.length);
                        if (_matrix?.length == 16) controller.goTo(Matrix4.fromList(_matrix!), duration: Duration.zero);
                      }
                    },
                    onPageChanged: (page) {
                      if (page != null) {
                        _prefs?.setInt(_key, page);
                        if (mounted) setState(() => _page = page);
                      }
                    },
                    pagePaintCallbacks: [_searcher.pageTextMatchPaintCallback],
                    errorBannerBuilder: (context, error, stack, doc) => Center(child: Text(l.mediaPreviewFailed)),
                  ),
                ),
        ),
        SafeArea(
          top: false,
          child: Wrap(
            crossAxisAlignment: WrapCrossAlignment.center,
            alignment: WrapAlignment.center,
            children: [
              IconButton(
                tooltip: l.mediaPrevious,
                onPressed: _page > 1 ? () => _controller.goToPage(pageNumber: _page - 1, duration: duration) : null,
                icon: Ic(previousIcon),
              ),
              Text(l.mediaPage('$_page', '$_total')),
              IconButton(
                tooltip: l.mediaNext,
                onPressed: _page < _total ? () => _controller.goToPage(pageNumber: _page + 1, duration: duration) : null,
                icon: Ic(nextIcon),
              ),
              IconButton(
                tooltip: l.mediaZoomOut,
                onPressed: () {
                  if (_controller.isReady) {
                    _controller.zoomDown(duration: duration);
                  }
                },
                icon: const Ic('zoom_out'),
              ),
              IconButton(
                tooltip: l.mediaZoomIn,
                onPressed: () {
                  if (_controller.isReady) {
                    _controller.zoomUp(duration: duration);
                  }
                },
                icon: const Ic('zoom_in'),
              ),
            ],
          ),
        ),
      ],
    );
  }
}

class MediaPlayback extends StatefulWidget {
  const MediaPlayback({super.key, required this.bytes, required this.attachment});
  final Uint8List bytes;
  final Attachment attachment;
  @override
  State<MediaPlayback> createState() => _MediaPlaybackState();
}

class _MediaPlaybackState extends State<MediaPlayback> {
  VideoPlayerController? _controller;
  Future<void> Function()? _release;
  bool _failed = false;
  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    try {
      final a = widget.attachment, source = a.id == null ? null : StoreScope.read(context).backend.mediaSource(a.id!);
      final p = supportsStreamingMedia && source != null ? await streamingMediaPlayer(source.url, source.headers) : await mediaPlayer(widget.bytes, a.mime, a.name);
      if (!mounted) {
        await p.controller.dispose();
        await p.release();
        return;
      }
      _controller = p.controller;
      _release = p.release;
      await p.controller.initialize();
      if (mounted) setState(() {});
    } catch (_) {
      if (mounted) setState(() => _failed = true);
    }
  }

  @override
  void dispose() {
    final controller = _controller, release = _release;
    () async {
      await controller?.dispose();
      await release?.call();
    }();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final l = AppLocalizations.of(context), c = _controller;
    if (_failed) return Center(child: Text(l.mediaPreviewFailed));
    if (c == null || !c.value.isInitialized) {
      return const Center(child: CircularProgressIndicator());
    }
    return Center(
      child: ValueListenableBuilder(
        valueListenable: c,
        builder: (context, v, _) => Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            if (widget.attachment.mime.startsWith('video/'))
              Flexible(
                child: AspectRatio(aspectRatio: v.aspectRatio, child: VideoPlayer(c)),
              )
            else
              const Ic('audio_file', size: 64),
            VideoProgressIndicator(c, allowScrubbing: true, padding: const EdgeInsets.all(16)),
            Row(
              mainAxisAlignment: MainAxisAlignment.center,
              children: [
                IconButton(tooltip: v.isPlaying ? l.mediaPause : l.mediaPlay, onPressed: () => v.isPlaying ? c.pause() : c.play(), icon: Ic(v.isPlaying ? 'pause' : 'play_arrow')),
                Text('${_mediaTime(v.position)} / ${_mediaTime(v.duration)}', textDirection: TextDirection.ltr),
              ],
            ),
          ],
        ),
      ),
    );
  }
}

String _mediaTime(Duration value) => '${value.inMinutes}:${(value.inSeconds % 60).toString().padLeft(2, '0')}';

class ArchiveView extends StatefulWidget {
  const ArchiveView({super.key, required this.attachment});
  final Attachment attachment;
  @override
  State<ArchiveView> createState() => _ArchiveViewState();
}

class _ArchiveViewState extends State<ArchiveView> {
  Future<List<String>>? _entries;
  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    _entries ??= widget.attachment.id == null ? Future.value([]) : StoreScope.read(context).backend.archiveEntries(widget.attachment.id!);
  }

  @override
  Widget build(BuildContext context) {
    final l = AppLocalizations.of(context);
    return FutureBuilder<List<String>>(
      future: _entries,
      builder: (context, snap) {
        if (snap.hasError) return Center(child: Text(l.mediaPreviewFailed));
        if (!snap.hasData) {
          return const Center(child: CircularProgressIndicator());
        }
        return ListView(
          children: [
            for (final name in snap.data!)
              ListTile(
                leading: const Ic('description'),
                title: Text(name),
                trailing: IconButton(
                  tooltip: l.mediaSave,
                  icon: const Ic('download'),
                  onPressed: () async {
                    final store = StoreScope.read(context);
                    try {
                      final bytes = await store.backend.archiveEntry(widget.attachment.id!, name);
                      if (bytes == null) throw StateError('entry unavailable');
                      if (context.mounted) {
                        await originalAction(context, Attachment(name: name.split('/').last, bytes: bytes.length, mime: 'application/octet-stream', data: bytes));
                      }
                    } catch (_) {
                      if (!store.isDisposed) {
                        store.notice(l.mediaActionFailed);
                        store.touch();
                      }
                    }
                  },
                ),
              ),
          ],
        );
      },
    );
  }
}
