import 'package:flutter/material.dart';
import 'package:video_player/video_player.dart';

import '../../data/store.dart';
import '../../l10n/app_localizations.dart';
import '../../model/models.dart';
import '../../native/media_player.dart';
import '../../theme/tokens.dart';
import '../common.dart';

class AudioCard extends StatefulWidget {
  const AudioCard({super.key, required this.attachment, required this.actions});
  final Attachment attachment;
  final Widget actions;
  @override
  State<AudioCard> createState() => _AudioCardState();
}

class _AudioCardState extends State<AudioCard> {
  VideoPlayerController? _controller;
  Future<void> Function()? _release;
  AppLifecycleListener? _lifecycle;
  bool _loading = false, _failed = false, _transcriptOpen = false;
  String? _transcript;
  @override
  void initState() {
    super.initState();
    _lifecycle = AppLifecycleListener(onInactive: () => _controller?.pause());
  }

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    if (ModalRoute.isCurrentOf(context) == false) _controller?.pause();
  }

  Future<void> _play() async {
    if (_loading) return;
    final c = _controller;
    if (c != null) {
      c.value.isPlaying ? await c.pause() : await c.play();
      return;
    }
    final a = widget.attachment, backend = StoreScope.read(context).backend;
    setState(() {
      _loading = true;
      _failed = false;
    });
    try {
      final source = a.id == null ? null : backend.mediaSource(a.id!);
      final bytes = supportsStreamingMedia && source != null ? null : a.data ?? await a.transfer?.read?.call() ?? (a.id == null ? null : await backend.attachmentData(a.id!));
      if (bytes == null && (!supportsStreamingMedia || source == null)) throw StateError('audio unavailable');
      final player = supportsStreamingMedia && source != null ? await streamingMediaPlayer(source.url, source.headers) : await mediaPlayer(bytes!, a.mime, a.name);
      if (!mounted) {
        await player.controller.dispose();
        await player.release();
        return;
      }
      _controller = player.controller;
      _release = player.release;
      await player.controller.initialize();
      player.controller.addListener(_changed);
      if (mounted) {
        await player.controller.play();
        setState(() => _loading = false);
      }
    } catch (_) {
      final broken = _controller, release = _release;
      _controller = null;
      _release = null;
      await broken?.dispose();
      await release?.call();
      if (mounted) {
        setState(() {
          _loading = false;
          _failed = true;
        });
      }
    }
  }

  void _changed() {
    if (mounted) setState(() {});
  }

  @override
  void dispose() {
    _lifecycle?.dispose();
    final c = _controller, r = _release;
    c?.removeListener(_changed);
    () async {
      await c?.dispose();
      await r?.call();
    }();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final l = AppLocalizations.of(context), p = context.p, a = widget.attachment, c = _controller;
    final total = c?.value.duration.inSeconds ?? (a.meta['duration'] as num?)?.floor() ?? 0;
    final position = c?.value.position.inSeconds ?? 0;
    final peaks = (a.meta['waveform'] as List? ?? const []).cast<num>();
    return ConstrainedBox(
      constraints: const BoxConstraints(maxWidth: 360),
      child: Material(
        color: p.surface,
        shape: RoundedRectangleBorder(
          borderRadius: BorderRadius.circular(9),
          side: BorderSide(color: p.line),
        ),
        child: Padding(
          padding: const EdgeInsets.all(10),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(a.name, style: T.name, textDirection: firstStrongDirection(a.name)),
              Row(
                children: [
                  IconButton(
                    tooltip: c?.value.isPlaying == true ? l.mediaPause : l.mediaPlay,
                    onPressed: _loading ? null : _play,
                    icon: _loading
                        ? const SizedBox(width: 20, height: 20, child: CircularProgressIndicator(strokeWidth: 2))
                        : Ic(c?.value.isPlaying == true ? 'pause' : 'play_arrow'),
                  ),
                  Expanded(
                    child: Column(
                      children: [
                        if (peaks.isNotEmpty)
                          SizedBox(
                            height: 24,
                            child: CustomPaint(size: const Size(double.infinity, 24), painter: _Wave(peaks, p.text2)),
                          ),
                        Slider(
                          value: position.toDouble().clamp(0, total.toDouble()),
                          max: total > 0 ? total.toDouble() : 1,
                          onChanged: c?.value.isInitialized == true ? (v) => c!.seekTo(Duration(seconds: v.round())) : null,
                        ),
                      ],
                    ),
                  ),
                  Text('${_clock(position)} / ${_clock(total)}', textDirection: TextDirection.ltr, style: T.meta),
                  widget.actions,
                ],
              ),
              if (_failed) Text(l.mediaPreviewFailed, style: T.secondary),
              if (a.meta['transcript'] == true)
                TextButton(
                  onPressed: () async {
                    if (!_transcriptOpen && _transcript == null && a.id != null) {
                      try {
                        _transcript = await StoreScope.read(context).backend.attachmentTranscript(a.id!);
                      } catch (_) {}
                    }
                    if (mounted) setState(() => _transcriptOpen = !_transcriptOpen);
                  },
                  child: Text(l.mediaTranscript),
                ),
              if (_transcriptOpen) Text(_transcript ?? l.mediaPreviewFailed),
            ],
          ),
        ),
      ),
    );
  }
}

String _clock(int n) => '${n ~/ 60}:${(n % 60).toString().padLeft(2, '0')}';

class _Wave extends CustomPainter {
  _Wave(this.peaks, this.color);
  final List<num> peaks;
  final Color color;
  @override
  void paint(Canvas canvas, Size size) {
    final paint = Paint()
      ..color = color
      ..strokeWidth = 2
      ..strokeCap = StrokeCap.round;
    for (var i = 0; i < peaks.length; i++) {
      final x = (i + .5) * size.width / peaks.length, h = peaks[i].toDouble().clamp(.04, 1) * size.height;
      canvas.drawLine(Offset(x, (size.height - h) / 2), Offset(x, (size.height + h) / 2), paint);
    }
  }

  @override
  bool shouldRepaint(_Wave oldDelegate) => oldDelegate.peaks != peaks || oldDelegate.color != color;
}
