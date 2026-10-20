// Composer (chat.md §3), WhatsApp layout: rounded field with attach + camera inside, one round
// button beside it: mic when empty, send when there is text or an image. Tap on send while the
// worker is busy = "after the current step"; long press opens "when to deliver?". Stop is NOT here
// (top bar). Images (attach, camera, paste) wait above the field as a removable preview, and go
// with the next message. On Android the text field itself is native (composer_field.dart).
import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:image_picker/image_picker.dart';

import '../../data/dictation.dart';
import '../../data/store.dart';
import '../../model/models.dart';
import '../../native/paste.dart';
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
  bool recording = false;
  bool transcribing = false;
  bool _starting = false;
  int recSeconds = 0;
  Timer? _rec;

  /// A short dictation; past this the recording stops by itself and goes to transcription.
  static const maxRecSeconds = 120;

  void Function()? _stopPaste;

  @override
  void initState() {
    super.initState();
    widget.controller.addListener(_changed);
    _stopPaste = listenPastedImages((bytes, mime, name) => _addImage(bytes, name, mime: mime));
  }

  @override
  void dispose() {
    _stopPaste?.call();
    widget.controller.removeListener(_changed);
    _rec?.cancel();
    if (recording) Dictation.instance.recorder.cancel();
    super.dispose();
  }

  void _changed() {
    StoreScope.read(context).setDraft(widget.identityId, widget.controller.text);
    setState(() {});
  }

  Future<void> _send(Priority p) async {
    final text = widget.controller.text.trim();
    _closeMenu();
    final store = StoreScope.read(context);
    final images = [...store.images(widget.identityId)];
    if (text.isEmpty && images.isEmpty) return;
    widget.controller.clear();
    for (final a in images) {
      store.removeImage(widget.identityId, a);
    }
    await store.send(widget.identityId, text, p, quote: widget.quote, attachments: images);
    widget.onClearQuote?.call();
    widget.onSent?.call();
  }

  void _fail(String message) {
    final s = StoreScope.read(context);
    s.error = message;
    s.touch();
  }

  // Dictation goes to dictate-server and lands in the field for editing (never sent by itself).
  Future<void> _toggleRecording() async {
    if (transcribing || _starting) return;
    final dict = Dictation.instance;
    if (recording) return _stopAndTranscribe();
    if (dict.client == null) return _fail('ההכתבה לא מחוברת בגרסה הזו. אפשר להכתיב דרך המיקרופון שבמקלדת.');
    // Starting waits on the permission prompt; taps meanwhile must not start a second recording.
    _starting = true;
    try {
      await dict.recorder.start();
    } on DictationError catch (e) {
      if (mounted) _fail(e.message);
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

  Future<void> _stopAndTranscribe() async {
    if (!recording) return;
    final dict = Dictation.instance;
    _rec?.cancel();
    setState(() {
      recording = false;
      transcribing = true;
    });
    try {
      final pcm = await dict.recorder.stop();
      if (pcm.length < kDictateRate * 2 ~/ 4) throw const DictationError('ההקלטה קצרה מדי. אפשר ללחוץ, לדבר, ואז ללחוץ שוב.');
      final text = await dict.client!.transcribe(wavFromPcm(pcm));
      if (!mounted) return;
      _insert(text);
    } on DictationError catch (e) {
      if (mounted) _fail(e.message);
    } catch (_) {
      if (mounted) _fail(kMicFailed);
    } finally {
      if (mounted) setState(() => transcribing = false);
    }
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

  /// An image from any source: checked here, so a wrong file says so at once and not after send.
  void _addImage(Uint8List bytes, String name, {String? mime}) {
    if (!mounted) return;
    final kind = imageMime(bytes);
    if (kind == null) return _fail('אפשר לצרף תמונות מסוג PNG, ‏JPEG, ‏GIF או WebP.');
    if (bytes.length > maxImageBytes) return _fail('התמונה גדולה מדי (עד 25MB).');
    StoreScope.read(context).addImage(widget.identityId, Attachment(name: name.isEmpty ? 'image' : name, bytes: bytes.length, mime: kind, data: bytes));
    widget.focus.requestFocus();
  }

  /// Phone photos are big; past this size they say nothing more to a worker and only slow the upload.
  static const _maxSide = 2048.0;

  Future<void> _pick(ImageSource source) async {
    final picker = ImagePicker();
    try {
      final files = source == ImageSource.gallery
          ? await picker.pickMultiImage(maxWidth: _maxSide, maxHeight: _maxSide, imageQuality: 85, limit: AppStore.maxImages)
          : [?await picker.pickImage(source: source, maxWidth: _maxSide, maxHeight: _maxSide, imageQuality: 85)];
      for (final f in files) {
        _addImage(await f.readAsBytes(), f.name);
      }
    } on PlatformException catch (e) {
      if (mounted) _fail(e.code.contains('camera') ? 'אין גישה למצלמה. אפשר לאשר אותה בהגדרות המכשיר.' : 'לא הצלחתי לפתוח את התמונות. אפשר לנסות שוב.');
    } catch (_) {
      if (mounted) _fail('לא הצלחתי לפתוח את התמונות. אפשר לנסות שוב.');
    }
  }

  void _attach() {
    final p = context.p;
    showModalBottomSheet(
      context: context,
      backgroundColor: p.surface,
      showDragHandle: true,
      builder: (ctx) => SafeArea(
        child: Column(mainAxisSize: MainAxisSize.min, children: [
          for (final (icon, label, source) in [('photo_camera', 'מצלמה', ImageSource.camera), ('image', 'גלריה', ImageSource.gallery)])
            ListTile(
              leading: Ic(icon, color: p.text2),
              title: Text(label, style: T.body.copyWith(color: p.text)),
              onTap: () {
                Navigator.pop(ctx);
                _pick(source);
              },
            ),
        ]),
      ),
    );
  }

  /// Android keyboards (Gboard's clipboard chip, a copied screenshot) hand images over this way.
  void _inserted(KeyboardInsertedContent c) {
    final data = c.data;
    if (data == null || data.isEmpty) return _fail('המקלדת לא העבירה את התמונה. אפשר לצרף אותה מהגלריה.');
    _addImage(data, c.uri.split('/').last, mime: c.mimeType);
  }

  @override
  Widget build(BuildContext context) {
    final p = context.p;
    final store = StoreScope.of(context);
    final d = store.data!;
    final who = d.who(widget.identityId);
    final busy = d.chats[widget.identityId]?.live.busy ?? false;
    final images = store.images(widget.identityId);
    final hasText = widget.controller.text.trim().isNotEmpty || images.isNotEmpty;
    final f = who.gender == Gender.f;

    final field = Container(
      constraints: const BoxConstraints(minHeight: 46),
      decoration: BoxDecoration(color: p.surface, borderRadius: BorderRadius.circular(23), boxShadow: p.hairShadow),
      padding: const EdgeInsets.symmetric(horizontal: 4),
      child: transcribing
          ? SizedBox(
              height: 46,
              child: Row(children: [
                const SizedBox(width: 12),
                SizedBox(width: 18, height: 18, child: CircularProgressIndicator(strokeWidth: 2, color: p.accent)),
                const SizedBox(width: 10),
                Text('מתמלל את ההקלטה…', style: T.body.copyWith(color: p.text2)),
              ]),
            )
          : recording
          ? SizedBox(
              height: 46,
              child: Row(children: [
                const SizedBox(width: 12),
                Ic('mic', size: 20, fill: true, color: p.urgent),
                const SizedBox(width: 8),
                Text('${recSeconds ~/ 60}:${(recSeconds % 60).toString().padLeft(2, '0')}', style: T.body.copyWith(color: p.text)),
                const Spacer(),
                TextButton(
                  onPressed: _cancelRecording,
                  child: Text('ביטול', style: T.secondary.copyWith(color: p.accent, fontWeight: FontWeight.w700)),
                ),
              ]),
            )
          : Row(crossAxisAlignment: CrossAxisAlignment.end, children: [
              Expanded(
                child: NativeComposerField.available
                    ? NativeComposerField(
                        controller: widget.controller,
                        focus: widget.focus,
                        hint: 'הודעה ל${who.name}',
                        style: T.body.copyWith(color: p.text, height: 1.45),
                        hintColor: p.text3,
                        accent: p.accent,
                        onImage: (bytes, name, mime) => _addImage(bytes, name, mime: mime),
                        onImageFailed: () => _fail('לא הצלחתי לקרוא את התמונה. אפשר לצרף אותה מהגלריה.'),
                      )
                    : CallbackShortcuts(
                        bindings: {
                          const SingleActivator(LogicalKeyboardKey.enter): () => _send(Priority.next),
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
                            hintText: 'הודעה ל${who.name}',
                            hintStyle: T.body.copyWith(color: p.text3),
                          ),
                        ),
                      ),
              ),
              _FieldBtn(icon: 'attach_file', tip: 'צירוף', onTap: _attach),
              if (MediaQuery.sizeOf(context).width < 800) _FieldBtn(icon: 'photo_camera', tip: 'מצלמה', onTap: () => _pick(ImageSource.camera)),
            ]),
    );

    final round = Semantics(
      button: true,
      label: hasText ? 'שליחה' : (recording ? 'עצירת ההקלטה' : (transcribing ? 'מתמלל' : 'הכתבה')),
      child: GestureDetector(
        onLongPress: hasText && busy ? _openMenu : null,
        child: Material(
          color: p.accent,
          shape: const CircleBorder(),
          child: InkWell(
            customBorder: const CircleBorder(),
            onTap: hasText ? () => _send(busy ? Priority.next : Priority.next) : _toggleRecording,
            child: SizedBox(
              width: 46,
              height: 46,
              child: Center(
                child: hasText
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
      child: Stack(clipBehavior: Clip.none, children: [
        Column(mainAxisSize: MainAxisSize.min, children: [
          if (images.isNotEmpty)
            Padding(
              padding: const EdgeInsets.only(bottom: 6),
              child: _ImagePreview(images: images, onRemove: (a) => store.removeImage(widget.identityId, a)),
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
          Row(crossAxisAlignment: CrossAxisAlignment.end, children: [
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
          ]),
        ]),
      ]),
    );
  }
}

/// What waits to go with the next message: a thumbnail each, with an × to take it out (WhatsApp).
class _ImagePreview extends StatelessWidget {
  const _ImagePreview({required this.images, required this.onRemove});
  final List<Attachment> images;
  final void Function(Attachment) onRemove;
  @override
  Widget build(BuildContext context) {
    final p = context.p;
    return Container(
      decoration: BoxDecoration(color: p.surface, borderRadius: BorderRadius.circular(12), boxShadow: p.hairShadow),
      padding: const EdgeInsets.all(6),
      height: 88,
      child: ListView.separated(
        scrollDirection: Axis.horizontal,
        itemCount: images.length,
        separatorBuilder: (_, _) => const SizedBox(width: 6),
        itemBuilder: (context, i) {
          final a = images[i];
          return Semantics(
            label: 'תמונה מצורפת ${i + 1}',
            child: Stack(children: [
              ClipRRect(
                borderRadius: BorderRadius.circular(8),
                child: Image.memory(a.data!, width: 76, height: 76, fit: BoxFit.cover, gaplessPlayback: true),
              ),
              PositionedDirectional(
                top: 2,
                end: 2,
                child: Tooltip(
                  message: 'הסרה',
                  child: InkWell(
                    customBorder: const CircleBorder(),
                    onTap: () => onRemove(a),
                    child: Container(
                      width: 26,
                      height: 26,
                      decoration: const BoxDecoration(color: Color(0x99000000), shape: BoxShape.circle),
                      child: const Center(child: Ic('close', size: 16, color: Colors.white, semantic: 'הסרת התמונה')),
                    ),
                  ),
                ),
              ),
            ]),
          );
        },
      ),
    );
  }
}

class _FieldBtn extends StatelessWidget {
  const _FieldBtn({required this.icon, required this.tip, required this.onTap});
  final String icon;
  final String tip;
  final VoidCallback onTap;
  @override
  Widget build(BuildContext context) => Tooltip(
        message: tip,
        child: InkWell(
          customBorder: const CircleBorder(),
          onTap: onTap,
          child: SizedBox(width: 40, height: 46, child: Center(child: Ic(icon, color: context.p.text2, semantic: tip))),
        ),
      );
}

/// `.pmenu`: when to deliver to a busy worker.
class _PriorityMenu extends StatelessWidget {
  const _PriorityMenu({required this.name, required this.female, required this.onPick});
  final String name;
  final bool female;
  final void Function(Priority) onPick;
  @override
  Widget build(BuildContext context) {
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
              child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                Text(t, style: TextStyle(fontFamily: kFont, fontSize: 14.5, height: 1.4, fontWeight: FontWeight.w700, color: p.text)),
                Text(s, style: TextStyle(fontFamily: kFont, fontSize: 12.5, height: 1.4, color: p.text2)),
              ]),
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
      child: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.start, children: [
        Padding(
          padding: const EdgeInsets.fromLTRB(12, 6, 12, 4),
          child: Text('$name באמצע עבודה. מתי למסור?', style: TextStyle(fontFamily: kFont, fontSize: 12.5, color: p.text2)),
        ),
        opt(Priority.now, 'עכשיו', 'עוצר ${female ? 'אותה' : 'אותו'} באמצע הצעד'),
        opt(Priority.next, 'אחרי הצעד הנוכחי', 'ברירת המחדל, בנגיעה רגילה', sel: true),
        opt(Priority.later, 'בסוף התור', 'אחרי כל מה שכבר מחכה ${female ? 'אצלה' : 'אצלו'}'),
      ]),
    );
  }
}
