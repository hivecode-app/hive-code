import 'package:agent_company/l10n/ui_copy.dart';

// Composer (chat.md §3), WhatsApp layout: rounded field with attach + camera inside, one round
// button beside it: mic when empty, send when there is text or an image. Tap on send while the
// worker is busy = "after the current step"; long press opens "when to deliver?". Stop is NOT here
// (top bar). Images (attach, camera, paste) wait above the field as a removable preview, and go
// with the next message. On Android the text field itself is native (composer_field.dart).
import 'dart:async';
import 'dart:typed_data';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:image_picker/image_picker.dart';
import 'package:file_picker/file_picker.dart';

import '../../l10n/app_localizations.dart';
import '../media/upload_strip.dart';

import '../../data/dictation.dart';
import '../../data/store.dart';
import '../../model/models.dart';
import '../../native/paste.dart';
import '../../native/native_bridge.dart';
import '../../theme/tokens.dart';
import '../common.dart';
import 'composer_field.dart';
import 'items.dart';

class Composer extends StatefulWidget {
  const Composer({super.key, required this.identityId, required this.controller, required this.focus, this.quote, this.onClearQuote, this.onSent});
  final String identityId;
  final TextEditingController controller;
  final FocusNode focus;
  final Quote? quote;
  final VoidCallback? onClearQuote;
  final VoidCallback? onSent;

  @override
  State<Composer> createState() => _ComposerState();
}

class _ComposerState extends State<Composer> {
  final _portal = OverlayPortalController();
  final _link = LayerLink();

  void _openMenu() => _portal.show();
  void _closeMenu() {
    if (_portal.isShowing) _portal.hide();
  }

  bool _original = false;
  bool _sending = false;
  bool recording = false;
  bool _starting = false;
  int recSeconds = 0;
  Timer? _rec;
  Timer? _tick; // the elapsed time while a recording goes out
  int _elapsed = 0;
  final _jobs = Dictation.instance.jobs;

  /// The recordings of this chat that wait for transcription; the one going out now, if any.
  List<PendingDictation> get _pending => _jobs.of(widget.identityId);
  PendingDictation? get _running => _pending.where((p) => p.running).firstOrNull;
  bool get transcribing => _running != null;

  /// Past this the recording stops by itself and goes to transcription: the 25 MB hq takes (13 min).
  static const maxRecSeconds = 13 * 60;

  void Function()? _stopPaste;
  String? _pasteChat;
  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    if (ModalRoute.isCurrentOf(context) == false) {
      _stopPaste?.call();
      _stopPaste = null;
      _pasteChat = null;
    } else {
      _bindPaste();
    }
  }

  void _bindPaste() {
    final id = widget.identityId, store = StoreScope.read(context), labels = AppLocalizations.of(context);
    if (_pasteChat == id && _stopPaste != null) return;
    _stopPaste?.call();
    _pasteChat = id;
    _stopPaste = listenPastedImages((bytes, mime, name, {String? path, int? size}) async {
      if (store.isDisposed) return true;
      if (path != null) {
        await _stagePicked(
          store,
          id,
          XFile(path, name: name, mimeType: mime, length: size),
          mime: mime,
          source: 'paste',
          labels: labels,
        );
        return !store.retainsMediaSource(path);
      } else {
        await _addFile(store, id, bytes, name, mime: mime, source: 'paste', labels: labels);
        return true;
      }
    });
  }

  @override
  void initState() {
    super.initState();
    widget.controller.addListener(_changed);
    _jobs.addListener(_jobsChanged);
    _jobs.load();
    WidgetsBinding.instance.addPostFrameCallback((_) => _jobsChanged());
  }

  @override
  void didUpdateWidget(Composer old) {
    super.didUpdateWidget(old);
    // The desktop keeps this composer when he picks another chat: that chat's text, its own clock.
    if (old.identityId != widget.identityId) {
      _bindPaste();
      _tick?.cancel();
      _tick = null;
      WidgetsBinding.instance.addPostFrameCallback((_) => _jobsChanged());
    }
  }

  void _jobsChanged() {
    if (!mounted) return;
    // A recording of this chat that is all text goes into the field, wherever it was recorded from.
    final text = _jobs.take(widget.identityId);
    if (text != null && text.isNotEmpty) _insert(text);
    if (transcribing && _tick == null) {
      _elapsed = CompanyTime.now().difference(_running!.startedAt ?? CompanyTime.now()).inSeconds;
      _tick = Timer.periodic(const Duration(seconds: 1), (_) => setState(() => _elapsed++));
    } else if (!transcribing) {
      _tick?.cancel();
      _tick = null;
    }
    setState(() {});
  }

  @override
  void dispose() {
    _stopPaste?.call();
    widget.controller.removeListener(_changed);
    _rec?.cancel();
    _tick?.cancel();
    _jobs.removeListener(_jobsChanged);
    if (recording) Dictation.instance.recorder.cancel();
    super.dispose();
  }

  void _changed() {
    StoreScope.read(context).setDraft(widget.identityId, widget.controller.text);
    setState(() {});
  }

  Future<void> _send(Priority p) async {
    if (_sending) return;
    final id = widget.identityId, quote = widget.quote;
    final draft = widget.controller.text;
    final text = draft.trim();
    _closeMenu();
    final store = StoreScope.read(context), l = AppLocalizations.of(context);
    final files = [...store.images(id)];
    if (files.length > AppStore.maxImages) {
      store.notice(l.mediaLimit);
      store.touch();
      return;
    }
    if (files.any(store.staging)) {
      store.notice(l.mediaLoading);
      store.touch();
      return;
    }
    if (text.isEmpty && files.isEmpty) return;
    _sending = true;
    try {
      for (final a in files.where(store.uploadFailed).toList()) {
        final without = await showDialog<bool>(
          context: context,
          builder: (ctx) => AlertDialog(
            title: Text(l.mediaWithout(a.name)),
            actions: [
              TextButton(onPressed: () => Navigator.pop(ctx, false), child: Text(l.mediaRetry)),
              TextButton(onPressed: () => Navigator.pop(ctx, true), child: Text(l.mediaWithoutAction)),
            ],
          ),
        );
        if (without != true) {
          store.retryUpload(id, a);
          return;
        }
        files.remove(a);
        store.removeImage(id, a);
      }
      if (text.isEmpty && files.isEmpty) return;
      if (!mounted || widget.identityId != id || store.isDisposed) return;
      // Register ownership before removing draft references, so pruning cannot lose a source.
      final delivery = store.send(id, text, p, quote: quote, attachments: files, clearDraft: false);
      if (widget.controller.text == draft) widget.controller.clear();
      for (final a in [...store.images(id)]) {
        if (files.any((sent) => identical(sent, a) || sent.transfer != null && sent.transfer!.key == a.transfer?.key || sent.id != null && sent.id == a.id)) {
          store.removeImage(id, a);
        }
      }
      if (identical(widget.quote, quote)) widget.onClearQuote?.call();
      widget.onSent?.call();
      _sending = false;
      unawaited(delivery);
    } finally {
      _sending = false;
    }
  }

  /// [fault]: sent to hq as well (error_report.dart); his own to fix (a permission, too short) only shown.
  void _fail(String message, {bool fault = true}) => _failOn(StoreScope.read(context), message, fault: fault);

  // Dictation goes to dictate-server and lands in the field for editing (never sent by itself).
  Future<void> _toggleRecording() async {
    if (transcribing || _starting) return;
    final dict = Dictation.instance;
    if (recording) return _stopAndTranscribe();
    if (dict.client == null) return _fail(UiCopy.copy.dictationUnavailableThis, fault: false);
    // Starting waits on the permission prompt; taps meanwhile must not start a second recording.
    _starting = true;
    try {
      await dict.recorder.start();
    } on DictationError catch (e) {
      if (mounted) _fail(e.message, fault: e.fault);
      return;
    } catch (_) {
      if (mounted) _fail(kMicFailed);
      return;
    } finally {
      _starting = false;
    }
    if (!mounted) return dict.recorder.cancel();
    _rec?.cancel();
    setState(() {
      recording = true;
      recSeconds = 0;
    });
    _rec = Timer.periodic(const Duration(seconds: 1), (_) {
      if (!mounted) return;
      setState(() => recSeconds++);
      if (recSeconds >= maxRecSeconds) _stopAndTranscribe();
    });
  }

  // Nothing after the first await reads [context]: he may have left the chat by then, and the
  // recording still goes out; its text waits for this chat's composer (DictationJobs.take).
  Future<void> _stopAndTranscribe() async {
    if (!recording) return;
    final dict = Dictation.instance;
    final store = StoreScope.read(context);
    final id = widget.identityId;
    _rec?.cancel();
    setState(() => recording = false);
    final PendingDictation job;
    try {
      final pcm = await dict.recorder.stop();
      if (pcm.length < kDictateRate * 2 ~/ 4) {
        throw DictationError(UiCopy.copy.recordingTooShort, fault: false);
      }
      job = await _jobs.add(id, pcm);
    } on DictationError catch (e) {
      return _failOn(store, e.message, fault: e.fault);
    } catch (_) {
      return _failOn(store, kMicFailed);
    }
    await _transcribeOn(store, job);
  }

  /// Sends a kept recording; a failure keeps it, with "לנסות שוב" above the field.
  Future<void> _transcribeOn(AppStore store, PendingDictation job) async {
    final client = Dictation.instance.client;
    if (client == null || job.running) return;
    try {
      await _jobs.run(job, client);
    } on DictationError catch (e) {
      _failOn(store, e.message, fault: e.fault);
    }
  }

  void _failOn(AppStore s, String message, {bool fault = true}) {
    if (fault) {
      s.error = message;
    } else {
      s.notice(message);
    }
    s.touch();
  }

  Future<void> _discard(PendingDictation job) async {
    final p = context.p;
    final yes = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        backgroundColor: p.surface,
        title: Text(
          UiCopy.copy.deleteThisRecording,
          style: T.body.copyWith(color: p.text, fontWeight: FontWeight.w700),
        ),
        content: Text(UiCopy.copy.hasNotBeen, style: T.body.copyWith(color: p.text2)),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(ctx, false),
            child: Text(UiCopy.copy.cancel, style: T.secondary.copyWith(color: p.accent)),
          ),
          TextButton(
            onPressed: () => Navigator.pop(ctx, true),
            child: Text(
              UiCopy.copy.delete,
              style: T.secondary.copyWith(color: p.accent, fontWeight: FontWeight.w700),
            ),
          ),
        ],
      ),
    );
    if (yes == true) await _jobs.discard(job);
  }

  void _cancelRecording() {
    _rec?.cancel();
    Dictation.instance.recorder.cancel();
    setState(() => recording = false);
  }

  /// Puts the dictated text at the cursor (or the end), ready for editing.
  void _insert(String text) {
    final c = widget.controller;
    final sel = c.selection;
    final at = sel.isValid ? sel.start : c.text.length;
    final end = sel.isValid ? sel.end : c.text.length;
    final before = c.text.substring(0, at);
    final pad = before.isEmpty || before.endsWith(' ') || before.endsWith('\n') ? '' : ' ';
    final ins = '$pad$text';
    c.value = TextEditingValue(
      text: before + ins + c.text.substring(end),
      selection: TextSelection.collapsed(offset: at + ins.length),
    );
    widget.focus.requestFocus();
  }

  void _addImage(Uint8List bytes, String name, {String? mime}) {
    if (!mounted) return;
    _addFile(StoreScope.read(context), widget.identityId, bytes, name, mime: mime);
    widget.focus.requestFocus();
  }

  Future<void> _addFile(AppStore store, String id, Uint8List bytes, String name, {String? mime, String? source, bool original = true, AppLocalizations? labels}) async {
    final l = labels ?? AppLocalizations.of(context);
    if (mime == 'too-many') {
      store.notice(l.mediaLimit);
      store.touch();
      return;
    }
    if (mime == 'too-large' || bytes.length > maxImageBytes) {
      store.notice(l.mediaTooLarge(name));
      store.touch();
      return;
    }
    if (bytes.isEmpty) {
      store.notice(l.mediaReadFailed(name));
      store.touch();
      return;
    }
    if (store.images(id).length >= AppStore.maxImages) {
      store.notice(l.mediaLimit);
      store.touch();
      return;
    }
    final kind = imageMime(bytes) ?? (mime?.isNotEmpty == true ? mime! : 'application/octet-stream');
    await store.addImage(id, Attachment(name: name.isEmpty ? 'file' : name, bytes: bytes.length, mime: kind, data: bytes, meta: {'app_source': ?source, 'app_original': original}));
  }

  Future<void> _stagePicked(AppStore store, String id, XFile file, {String? mime, String? source, bool original = true, AppLocalizations? labels}) async {
    final l = labels ?? AppLocalizations.of(context), size = await file.length();
    if (store.isDisposed) return;
    if (size <= 0 || size > maxImageBytes) {
      store.notice(l.mediaTooLarge(file.name));
      store.touch();
      return;
    }
    if (store.images(id).length >= AppStore.maxImages) {
      store.notice(l.mediaLimit);
      store.touch();
      return;
    }
    final prefix = BytesBuilder(copy: false);
    await for (final bytes in file.openRead(0, size.clamp(0, 8192))) {
      prefix.add(bytes);
    }
    if (store.isDisposed) return;
    final kind = imageMime(prefix.takeBytes()) ?? mime ?? 'application/octet-stream';
    await store.addImage(
      id,
      Attachment(name: file.name, bytes: size, mime: kind, meta: {'app_source': ?source, 'app_original': original}),
      sourcePath: file.path,
    );
  }

  static const _maxSide = 2048.0;
  Future<void> _pick(ImageSource source, {bool video = false}) async {
    final store = StoreScope.read(context), id = widget.identityId, l = AppLocalizations.of(context);
    final original = _original;
    try {
      final picker = ImagePicker();
      final files = video
          ? [?await picker.pickVideo(source: source)]
          : source == ImageSource.gallery
          ? await picker.pickMultiImage(maxWidth: original ? null : _maxSide, maxHeight: original ? null : _maxSide, imageQuality: original ? null : 85, limit: AppStore.maxImages)
          : [?await picker.pickImage(source: source, maxWidth: original ? null : _maxSide, maxHeight: original ? null : _maxSide, imageQuality: original ? null : 85)];
      for (final f in files) {
        if (!mounted) return;
        try {
          if (await f.length() > maxImageBytes) {
            store.notice(l.mediaTooLarge(f.name));
            store.touch();
            continue;
          }
          await _stagePicked(store, id, f, mime: f.mimeType, source: source == ImageSource.gallery ? 'gallery' : 'camera', original: original);
        } catch (_) {
          store.notice(l.mediaReadFailed(f.name));
          store.touch();
        }
      }
    } on PlatformException catch (e) {
      final name = source == ImageSource.camera
          ? l.mediaCamera
          : video
          ? l.mediaVideo
          : l.mediaGallery;
      store.notice(RegExp('permission|denied|access', caseSensitive: false).hasMatch(e.code) ? l.mediaPermissionDenied(name) : l.mediaReadFailed(name));
      store.touch();
    } catch (_) {
      store.notice(
        l.mediaReadFailed(
          source == ImageSource.camera
              ? l.mediaCamera
              : video
              ? l.mediaVideo
              : l.mediaGallery,
        ),
      );
      store.touch();
    }
  }

  Future<void> _files() async {
    final store = StoreScope.read(context), id = widget.identityId, l = AppLocalizations.of(context);
    try {
      final result = await FilePicker.pickFiles();
      for (final file in result) {
        if (!mounted) return;
        if (store.images(id).length >= AppStore.maxImages) {
          store.notice(l.mediaLimit);
          store.touch();
          break;
        }
        try {
          if ((await file.length() ?? 0) > maxImageBytes) {
            store.notice(l.mediaTooLarge(file.name));
            store.touch();
            continue;
          }
          await _stagePicked(store, id, file.xFile, source: 'files');
        } catch (_) {
          store.notice(l.mediaReadFailed(file.name));
          store.touch();
        }
      }
    } catch (_) {
      store.notice(l.mediaReadFailed(l.mediaFiles));
      store.touch();
    }
  }

  Future<void> _requestScreenshotAccess() async {
    final store = StoreScope.read(context), id = widget.identityId, labels = AppLocalizations.of(context);
    try {
      final file = await NativeBridge.instance.recentScreenshot(requestPermission: true);
      if (store.isDisposed) return;
      if (file == null) {
        store.notice(await NativeBridge.instance.imageAccessGranted() ? labels.mediaNoRecentScreenshot : labels.mediaPermissionDenied(labels.mediaGallery));
        store.touch();
        return;
      }
      await _stagePicked(
        store,
        id,
        XFile(file.path, name: file.name, mimeType: file.mime, length: file.bytes),
        mime: file.mime,
        source: 'screenshot',
        labels: labels,
      );
    } catch (_) {
      if (!store.isDisposed) {
        store.notice(labels.mediaReadFailed(labels.mediaScreenshot));
        store.touch();
      }
    }
  }

  Future<void> _attach() async {
    final screenshot = await NativeBridge.instance.recentScreenshot(requestPermission: false);
    final access = screenshot != null || await NativeBridge.instance.imageAccessGranted();
    if (!mounted) return;
    final l = AppLocalizations.of(context), p = context.p;
    showModalBottomSheet<void>(
      context: context,
      backgroundColor: p.surface,
      showDragHandle: true,
      isScrollControlled: true,
      builder: (ctx) => StatefulBuilder(
        builder: (ctx, change) => SafeArea(
          child: ConstrainedBox(
            constraints: BoxConstraints(maxHeight: MediaQuery.sizeOf(ctx).height * .82),
            child: SingleChildScrollView(
              child: Column(
                mainAxisSize: MainAxisSize.min,
                children: [
                  SwitchListTile(title: Text(l.mediaOriginal), subtitle: Text(l.mediaOriginalHint), value: _original, onChanged: (v) => change(() => _original = v)),
                  for (final (icon, label, action) in <(String, String, VoidCallback)>[
                    ('photo_camera', l.mediaCamera, () => _pick(ImageSource.camera)),
                    ('image', l.mediaGallery, () => _pick(ImageSource.gallery)),
                    ('videocam', l.mediaVideo, () => _pick(ImageSource.camera, video: true)),
                    ('folder', l.mediaFiles, _files),
                    if (screenshot != null)
                      (
                        'screenshot',
                        l.mediaScreenshot,
                        () async {
                          final store = StoreScope.read(context), id = widget.identityId;
                          try {
                            await _stagePicked(store, id, XFile(screenshot.path), mime: screenshot.mime, source: 'screenshot');
                          } catch (_) {
                            store.notice(l.mediaReadFailed(screenshot.name));
                            store.touch();
                          }
                        },
                      ),
                  ])
                    ListTile(
                      leading: Ic(icon, color: p.text2),
                      title: Text(label),
                      onTap: () {
                        Navigator.pop(ctx);
                        action();
                      },
                    ),
                  if (screenshot == null && NativeBridge.instance.supported && !access)
                    ListTile(
                      leading: Ic('image', color: p.text2),
                      title: Text(l.mediaPhotoAccess),
                      subtitle: Text(l.mediaScreenshotAccessHint),
                      onTap: () {
                        Navigator.pop(ctx);
                        _requestScreenshotAccess();
                      },
                    ),
                ],
              ),
            ),
          ),
        ),
      ),
    );
  }

  /// Android keyboards (Gboard's clipboard chip, a copied screenshot) hand images over this way.
  void _inserted(KeyboardInsertedContent c) {
    final data = c.data;
    if (data == null || data.isEmpty) return _fail(UiCopy.copy.keyboardDidNot);
    _addImage(data, c.uri.split('/').last, mime: c.mimeType);
  }

  @override
  Widget build(BuildContext context) {
    UiCopy.watch(context);
    final p = context.p;
    final store = StoreScope.of(context);
    final d = store.data!;
    final who = d.who(widget.identityId);
    final busy = d.chats[widget.identityId]?.live.busy ?? false;
    final images = store.images(widget.identityId);
    final hasText = widget.controller.text.trim().isNotEmpty || images.isNotEmpty;
    final staging = images.any(store.staging);
    final f = who.gender == Gender.f;

    final field = Container(
      constraints: const BoxConstraints(minHeight: 46),
      decoration: BoxDecoration(color: p.surface, borderRadius: BorderRadius.circular(23), boxShadow: p.hairShadow),
      padding: const EdgeInsets.symmetric(horizontal: 4),
      child: transcribing
          ? _Transcribing(job: _running!, elapsed: _elapsed)
          : recording
          ? SizedBox(
              height: 46,
              child: Row(
                children: [
                  const SizedBox(width: 12),
                  Ic('mic', size: 20, fill: true, color: p.urgent),
                  const SizedBox(width: 8),
                  Text(
                    _clock(recSeconds),
                    style: T.body.copyWith(color: p.text, fontFeatures: const [FontFeature.tabularFigures()]),
                  ),
                  const Spacer(),
                  TextButton(
                    onPressed: _cancelRecording,
                    child: Text(
                      UiCopy.copy.cancel,
                      style: T.secondary.copyWith(color: p.accent, fontWeight: FontWeight.w700),
                    ),
                  ),
                ],
              ),
            )
          : Row(
              crossAxisAlignment: CrossAxisAlignment.end,
              children: [
                Expanded(
                  child: NativeComposerField.available
                      ? NativeComposerField(
                          key: ValueKey(widget.identityId),
                          controller: widget.controller,
                          focus: widget.focus,
                          hint: UiCopy.copy.message(who.name),
                          style: T.body.copyWith(color: p.text, height: 1.45),
                          hintColor: p.text3,
                          accent: p.accent,
                          onImage: (bytes, name, mime) => _addImage(bytes, name, mime: mime),
                          onImageFailed: () => _fail(UiCopy.copy.thisImageCould),
                        )
                      : CallbackShortcuts(
                          bindings: {
                            const SingleActivator(LogicalKeyboardKey.enter): () => _send(Priority.now),
                            const SingleActivator(LogicalKeyboardKey.enter, control: true): () => _send(Priority.now),
                          },
                          // Web and desktop: one direction for the whole field, from its first line.
                          child: TextField(
                            controller: widget.controller,
                            focusNode: widget.focus,
                            minLines: 1,
                            maxLines: 6,
                            keyboardType: TextInputType.multiline,
                            textInputAction: TextInputAction.newline,
                            textDirection: firstStrongDirection(widget.controller.text),
                            style: T.body.copyWith(color: p.text, height: 1.45),
                            cursorColor: p.accent,
                            contentInsertionConfiguration: ContentInsertionConfiguration(onContentInserted: _inserted, allowedMimeTypes: kImageMimes),
                            decoration: InputDecoration(
                              isCollapsed: true,
                              border: InputBorder.none,
                              contentPadding: const EdgeInsets.fromLTRB(4, 12, 4, 12),
                              hintText: UiCopy.copy.message(who.name),
                              hintStyle: T.body.copyWith(color: p.text3),
                            ),
                          ),
                        ),
                ),
                _FieldBtn(icon: 'attach_file', tip: UiCopy.copy.attach2, onTap: _attach),
                if (MediaQuery.sizeOf(context).width < 800) _FieldBtn(icon: 'photo_camera', tip: UiCopy.copy.camera, onTap: () => _pick(ImageSource.camera)),
              ],
            ),
    );

    final round = Semantics(
      button: true,
      label: staging
          ? AppLocalizations.of(context).mediaLoading
          : hasText
          ? UiCopy.copy.send2
          : (recording ? UiCopy.copy.stopRecording : (transcribing ? UiCopy.copy.transcribing : UiCopy.copy.dictation)),
      child: GestureDetector(
        onLongPress: hasText && busy ? _openMenu : null,
        child: Material(
          color: p.accent,
          shape: const CircleBorder(),
          child: InkWell(
            customBorder: const CircleBorder(),
            onTap: staging
                ? null
                : hasText
                ? () => _send(Priority.now)
                : _toggleRecording,
            child: SizedBox(
              width: 46,
              height: 46,
              child: Center(
                child: staging
                    ? SizedBox(width: 20, height: 20, child: CircularProgressIndicator(strokeWidth: 2, color: p.onAccent))
                    : hasText
                    ? Transform.flip(flipX: true, child: Ic('send', fill: true, color: p.onAccent))
                    : Ic(recording ? 'stop_circle' : 'mic', color: p.onAccent, fill: recording),
              ),
            ),
          ),
        ),
      ),
    );

    return Container(
      color: p.chatBg,
      padding: const EdgeInsets.fromLTRB(8, 6, 8, 8),
      child: Stack(
        clipBehavior: Clip.none,
        children: [
          Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              if (images.isNotEmpty)
                Padding(
                  padding: const EdgeInsets.only(bottom: 6),
                  child: UploadStrip(files: images, onRemove: (a) => store.removeImage(widget.identityId, a)),
                ),
              for (final job in _pending.where((j) => !j.running && !j.done))
                Padding(
                  padding: const EdgeInsets.only(bottom: 6),
                  child: _KeptRecording(job: job, onRetry: transcribing ? null : () => _transcribeOn(StoreScope.read(context), job), onDiscard: () => _discard(job)),
                ),
              if (widget.quote != null)
                Padding(
                  padding: const EdgeInsets.only(bottom: 4),
                  child: Container(
                    decoration: BoxDecoration(color: p.surface, borderRadius: BorderRadius.circular(12)),
                    padding: const EdgeInsets.fromLTRB(8, 2, 2, 2),
                    child: QuoteStrip(quote: widget.quote!, onClose: widget.onClearQuote),
                  ),
                ),
              Row(
                crossAxisAlignment: CrossAxisAlignment.end,
                children: [
                  Expanded(child: field),
                  const SizedBox(width: 6),
                  // The menu floats above the send button in the overlay, so it can leave the composer's box.
                  CompositedTransformTarget(
                    link: _link,
                    child: OverlayPortal(
                      controller: _portal,
                      overlayChildBuilder: (_) => CompositedTransformFollower(
                        link: _link,
                        targetAnchor: AlignmentDirectional.topEnd.resolve(Directionality.of(context)),
                        followerAnchor: AlignmentDirectional.bottomEnd.resolve(Directionality.of(context)),
                        offset: const Offset(0, -16),
                        child: Align(
                          alignment: AlignmentDirectional.bottomEnd.resolve(Directionality.of(context)),
                          child: TapRegion(
                            onTapOutside: (_) => _closeMenu(),
                            child: Directionality(
                              textDirection: Directionality.of(context),
                              child: _PriorityMenu(name: who.name, female: f, onPick: _send),
                            ),
                          ),
                        ),
                      ),
                      child: round,
                    ),
                  ),
                ],
              ),
            ],
          ),
        ],
      ),
    );
  }
}

String _clock(int s) => '${s ~/ 60}:${(s % 60).toString().padLeft(2, '0')}';

/// A recording on its way: which piece, how much of it has left the phone, and for how long.
class _Transcribing extends StatelessWidget {
  const _Transcribing({required this.job, required this.elapsed});
  final PendingDictation job;
  final int elapsed;
  @override
  Widget build(BuildContext context) {
    UiCopy.watch(context);
    final p = context.p;
    final piece = job.pieces > 1 ? UiCopy.copy.part2(job.piece + 1, job.pieces) : '';
    final step = job.sent < 1 ? UiCopy.copy.sending((job.sent * 100).floor()) : UiCopy.copy.transcribing;
    // Of the whole recording: pieces done, plus the share of this one that has gone out.
    final done = job.texts.where((t) => t != null).length;
    final share = ((done + job.sent * 0.9) / job.pieces).clamp(0.0, 1.0);
    return SizedBox(
      height: 46,
      child: Row(
        children: [
          const SizedBox(width: 12),
          SizedBox(
            width: 18,
            height: 18,
            child: CircularProgressIndicator(strokeWidth: 2, value: share, color: p.accent, backgroundColor: p.line),
          ),
          const SizedBox(width: 10),
          Expanded(
            child: Text(
              '$piece$step',
              style: T.body.copyWith(color: p.text2, fontFeatures: const [FontFeature.tabularFigures()]),
              overflow: TextOverflow.ellipsis,
            ),
          ),
          Text(
            _clock(elapsed),
            style: T.secondary.copyWith(color: p.text3, fontFeatures: const [FontFeature.tabularFigures()]),
          ),
          const SizedBox(width: 12),
        ],
      ),
    );
  }
}

/// A recording that did not make it to text, kept: what happened, try again, delete. The text has
/// the whole width and the buttons a row of their own under it, at the end (WhatsApp's unsent message).
class _KeptRecording extends StatelessWidget {
  const _KeptRecording({required this.job, required this.onRetry, required this.onDiscard});
  final PendingDictation job;
  final VoidCallback? onRetry;
  final VoidCallback onDiscard;
  @override
  Widget build(BuildContext context) {
    UiCopy.watch(context);
    final p = context.p;
    final now = CompanyTime.now();
    final ago = daysAgo(job.at, now);
    final at = ago == 0 ? '-${hm(job.at)}' : (ago == 1 ? UiCopy.copy.yesterday3(hm(job.at)) : '-${dm(job.at)}, ${hm(job.at)}');
    final kept = job.onDisk ? UiCopy.copy.savedThisDevice : UiCopy.copy.savedUntilApp;
    const tab = TextStyle(fontFeatures: [FontFeature.tabularFigures()]);
    return Container(
      decoration: BoxDecoration(color: p.surface, borderRadius: BorderRadius.circular(12), boxShadow: p.hairShadow),
      padding: const EdgeInsetsDirectional.fromSTEB(12, 10, 12, 2),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Padding(
                padding: const EdgeInsets.only(top: 2),
                child: Ic('mic', size: 20, color: p.text2),
              ),
              const SizedBox(width: 10),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      UiCopy.copy.recordingFromWas(at, _clock(job.seconds)),
                      style: T.body.copyWith(color: p.text, fontWeight: FontWeight.w500).merge(tab),
                    ),
                    Text(UiCopy.copy.tryAgainDelete(kept), style: T.secondary.copyWith(color: p.text2)),
                  ],
                ),
              ),
            ],
          ),
          Align(
            alignment: AlignmentDirectional.centerEnd,
            child: Row(
              mainAxisSize: MainAxisSize.min,
              children: [
                TextButton(
                  onPressed: onDiscard,
                  style: TextButton.styleFrom(foregroundColor: p.text2, textStyle: T.secondary),
                  child: Text(UiCopy.copy.delete),
                ),
                TextButton(
                  onPressed: onRetry,
                  style: TextButton.styleFrom(
                    foregroundColor: p.accent,
                    disabledForegroundColor: p.text3,
                    textStyle: T.secondary.copyWith(fontWeight: FontWeight.w700),
                  ),
                  child: Text(UiCopy.copy.tryAgain),
                ),
              ],
            ),
          ),
        ],
      ),
    );
  }
}

/// What waits to go with the next message: a thumbnail each, with an × to take it out (WhatsApp).
class _FieldBtn extends StatelessWidget {
  const _FieldBtn({required this.icon, required this.tip, required this.onTap});
  final String icon;
  final String tip;
  final VoidCallback onTap;
  @override
  Widget build(BuildContext context) {
    UiCopy.watch(context);
    return Tooltip(
      message: tip,
      child: InkWell(
        customBorder: const CircleBorder(),
        onTap: onTap,
        child: SizedBox(
          width: 40,
          height: 46,
          child: Center(
            child: Ic(icon, color: context.p.text2, semantic: tip),
          ),
        ),
      ),
    );
  }
}

/// `.pmenu`: when to deliver to a busy worker.
class _PriorityMenu extends StatelessWidget {
  const _PriorityMenu({required this.name, required this.female, required this.onPick});
  final String name;
  final bool female;
  final void Function(Priority) onPick;
  @override
  Widget build(BuildContext context) {
    UiCopy.watch(context);
    final p = context.p;
    Widget opt(Priority pr, String t, String s, {bool sel = false}) => Material(
      color: sel ? p.surface2 : Colors.transparent,
      borderRadius: BorderRadius.circular(8),
      child: InkWell(
        borderRadius: BorderRadius.circular(8),
        onTap: () => onPick(pr),
        child: Container(
          width: double.infinity,
          padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 9),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(
                t,
                style: TextStyle(fontFamily: kFont, fontSize: 14.5, height: 1.4, fontWeight: FontWeight.w700, color: p.text),
              ),
              Text(
                s,
                style: TextStyle(fontFamily: kFont, fontSize: 12.5, height: 1.4, color: p.text2),
              ),
            ],
          ),
        ),
      ),
    );
    return Container(
      width: 254,
      padding: const EdgeInsets.all(6),
      decoration: BoxDecoration(
        color: p.surface,
        borderRadius: BorderRadius.circular(12),
        border: Border.all(color: p.line),
        boxShadow: const [BoxShadow(color: Color(0x29000000), blurRadius: 28, offset: Offset(0, 8))],
      ),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Padding(
            padding: const EdgeInsets.fromLTRB(12, 6, 12, 4),
            child: Text(
              UiCopy.copy.workingWhenShould(name),
              style: TextStyle(fontFamily: kFont, fontSize: 12.5, color: p.text2),
            ),
          ),
          opt(Priority.now, UiCopy.copy.now, UiCopy.copy.interruptsWhenSafe(female ? UiCopy.copy.them : UiCopy.copy.them2), sel: true),
          opt(Priority.next, UiCopy.copy.afterCurrentStep, UiCopy.copy.stepThenReads(female ? UiCopy.copy.finishes : UiCopy.copy.finishes2, female ? UiCopy.copy.text : '')),
          opt(Priority.later, UiCopy.copy.endQueue, UiCopy.copy.afterEverythingAlready(female ? UiCopy.copy.them3 : UiCopy.copy.them4)),
        ],
      ),
    );
  }
}
