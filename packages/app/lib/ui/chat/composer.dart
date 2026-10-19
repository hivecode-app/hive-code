// Composer (chat.md §3), WhatsApp layout: rounded field with attach + camera inside, one round
// button beside it: mic when empty, send when there is text. Tap on send while the worker is busy
// = "after the current step"; long press opens "when to deliver?". Stop is NOT here (top bar).
import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../../data/dictation.dart';
import '../../data/store.dart';
import '../../model/models.dart';
import '../../theme/tokens.dart';
import '../common.dart';
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

  @override
  void initState() {
    super.initState();
    widget.controller.addListener(_changed);
  }

  @override
  void dispose() {
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
    if (text.isEmpty) return;
    final store = StoreScope.read(context);
    widget.controller.clear();
    await store.send(widget.identityId, text, p, quote: widget.quote);
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

  void _attach() {
    final p = context.p;
    showModalBottomSheet(
      context: context,
      backgroundColor: p.surface,
      showDragHandle: true,
      builder: (ctx) => SafeArea(
        child: Column(mainAxisSize: MainAxisSize.min, children: [
          for (final (icon, label) in [('photo_camera', 'מצלמה'), ('image', 'גלריה'), ('draft', 'קובץ'), ('image', 'צילום מסך אחרון')])
            ListTile(
              leading: Ic(icon, color: p.text2),
              title: Text(label, style: T.body.copyWith(color: p.text)),
              onTap: () {
                Navigator.pop(ctx);
                final s = StoreScope.read(context);
                s.error = 'צירוף קבצים יעבוד כשהשרת יקבל העלאות. בינתיים אפשר לשלוח טקסט.';
                s.touch();
              },
            ),
        ]),
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    final p = context.p;
    final store = StoreScope.of(context);
    final d = store.data!;
    final who = d.who(widget.identityId);
    final busy = d.chats[widget.identityId]?.live.busy ?? false;
    final hasText = widget.controller.text.trim().isNotEmpty;
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
                child: CallbackShortcuts(
                  bindings: {
                    const SingleActivator(LogicalKeyboardKey.enter): () => _send(Priority.next),
                    const SingleActivator(LogicalKeyboardKey.enter, control: true): () => _send(Priority.now),
                  },
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
              if (MediaQuery.sizeOf(context).width < 800) _FieldBtn(icon: 'photo_camera', tip: 'מצלמה', onTap: _attach),
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
