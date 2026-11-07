import 'package:agent_company/l10n/ui_copy.dart';
// Tab handoff (APP-SPEC §9, mockup screen 8): what the worker needs on a site, the domain from the
// server's browser (not editable), a code field the SMS autofill can fill, and three exits.
// The live page from the worker's tab comes with #50; until then the screen shows the request
// itself, and the code goes to the worker (or answers the ask, when the item is one).
import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../../data/backend.dart';
import '../../data/store.dart';
import '../../model/models.dart';
import '../../theme/tokens.dart';
import '../common.dart';
import '../selection.dart';
import '../nav.dart';

class HandoffScreen extends StatefulWidget {
  const HandoffScreen({super.key, required this.item});
  final WaitItem item;
  @override
  State<HandoffScreen> createState() => _HandoffScreenState();
}

class _HandoffScreenState extends State<HandoffScreen> {
  final code = TextEditingController();
  final focus = FocusNode();
  bool thanks = false;
  bool busy = false;
  String? error;
  bool errorFault = false;
  Timer? _close;

  @override
  void initState() {
    super.initState();
    code.addListener(() {
      setState(() {});
      if (code.text.length == 6 && RegExp(r'^\d{6}$').hasMatch(code.text)) _send();
    });
  }

  @override
  void dispose() {
    _close?.cancel();
    code.dispose();
    focus.dispose();
    super.dispose();
  }

  /// The code goes where the request came from: the ask's answer, or a message to the worker.
  Future<void> _send() async {
    final c = code.text.trim();
    if (busy || thanks || c.isEmpty) return;
    final store = StoreScope.read(context);
    final item = widget.item;
    setState(() {
      busy = true;
      error = null;
    });
    final r = item.askId != null
        ? await store.backend.freeAnswer(item.askId!, c)
        : !store.data!.canChat(item.from)
            ?  CommandResult.fail(UiCopy.copy.noCodeNeeded)
            : await store.backend.send(item.from, UserMsg(id: 'm-${DateTime.now().millisecondsSinceEpoch}', ts: CompanyTime.now(), text: c));
    if (!mounted) return;
    if (!r.ok) {
      setState(() {
        busy = false;
        error = r.error;
        errorFault = !r.transient;
      });
      return;
    }
    _done();
  }

  void _done() {
    if (thanks) return;
    focus.unfocus();
    setState(() => thanks = true);
    StoreScope.read(context).backend.handoffDone(widget.item);
    // "תודה. עמית ממשיך." for 1.5s, then the screen closes by itself (§9.1).
    _close = Timer(const Duration(milliseconds: 1500), () {
      if (mounted) Navigator.of(context).maybePop();
    });
  }

  @override
  Widget build(BuildContext context) {
    UiCopy.watch(context);
    final p = context.p;
    final store = StoreScope.of(context);
    final who = store.data!.who(widget.item.from);
    final domain = widget.item.domain;
    return Scaffold(
      backgroundColor: p.surface,
      resizeToAvoidBottomInset: true,
      body: SafeArea(
        child: Stack(children: [
          Column(children: [
            Container(
              decoration: BoxDecoration(color: p.surface, border: Border(bottom: BorderSide(color: p.line))),
              padding: const EdgeInsets.fromLTRB(4, 2, 4, 10),
              child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                Row(children: [
                  IBtn('close', tip: UiCopy.copy.close2, onTap: () => Navigator.of(context).maybePop()),
                  const SizedBox(width: 4),
                  Expanded(child: Text(UiCopy.copy.websiteSign(who.name), style: TextStyle(fontFamily: kFont, fontSize: 16, fontWeight: FontWeight.w700, color: p.text))),
                ]),
                if (domain != null && domain.isNotEmpty)
                  Padding(
                    padding: const EdgeInsets.symmetric(horizontal: 12),
                    child: Semantics(
                      label: UiCopy.copy.websiteOpenedYour(domain),
                      child: Container(
                        height: 26,
                        padding: const EdgeInsets.symmetric(horizontal: 10),
                        decoration: BoxDecoration(color: p.surface2, borderRadius: BorderRadius.circular(13)),
                        child: Row(mainAxisSize: MainAxisSize.min, children: [
                          Ic('lock', size: 15, fill: true, color: p.text),
                          const SizedBox(width: 4),
                          Flexible(child: Text(domain, textDirection: TextDirection.ltr, maxLines: 1, overflow: TextOverflow.ellipsis, style: T.mono(12).copyWith(color: p.text))),
                        ]),
                      ),
                    ),
                  ),
              ]),
            ),
            Expanded(
              child: CopySelectionArea(
                child: ListView(padding: const EdgeInsets.fromLTRB(16, 16, 16, 16), children: [
                  Rich(widget.item.body, auto: true, style: T.body.copyWith(color: p.text)),
                  const SizedBox(height: 20),
                  Text(UiCopy.copy.code, style: T.small.copyWith(color: p.text2, fontWeight: FontWeight.w700)),
                  const SizedBox(height: 6),
                  TextField(
                    key: const Key('handoff-code'),
                    controller: code,
                    focusNode: focus,
                    autofocus: true,
                    textDirection: TextDirection.ltr,
                    keyboardType: TextInputType.visiblePassword,
                    autofillHints: const [AutofillHints.oneTimeCode],
                    autocorrect: false,
                    enableSuggestions: false,
                    onSubmitted: (_) => _send(),
                    style: T.mono(16, w: FontWeight.w500).copyWith(color: p.text),
                    decoration: InputDecoration(
                      isDense: true,
                      hintText: UiCopy.copy.verificationCodeCode,
                      hintTextDirection: TextDirection.rtl,
                      hintStyle: T.body.copyWith(color: p.text3),
                      filled: true,
                      fillColor: p.surface2,
                      border: OutlineInputBorder(borderRadius: BorderRadius.circular(8), borderSide: BorderSide.none),
                      suffixIcon: IconButton(
                        tooltip: UiCopy.copy.paste,
                        icon: Ic('content_paste', size: 20, color: p.text2),
                        onPressed: () async {
                          final t = (await Clipboard.getData(Clipboard.kTextPlain))?.text;
                          if (!mounted || t == null) return;
                          code.text = t.trim();
                        },
                      ),
                    ),
                  ),
                  const SizedBox(height: 10),
                  Align(
                    alignment: AlignmentDirectional.centerStart,
                    child: Btn(busy ? UiCopy.copy.sending2 : UiCopy.copy.sendCode(toName(who.name)), kind: BtnKind.primary, onTap: busy || code.text.trim().isEmpty ? null : _send),
                  ),
                  if (error != null) ShownError(error!, screen: UiCopy.copy.yourTurn, padding: const EdgeInsets.only(top: 10), report: errorFault),
                ]),
              ),
            ),
            Container(
              decoration: BoxDecoration(color: p.surface, border: Border(top: BorderSide(color: p.line))),
              padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
              child: Row(children: [
                // A code typed and not sent yet goes first; "סיימתי" never drops it.
                Expanded(child: Btn(UiCopy.copy.done8, hpad: 8, onTap: busy ? null : (code.text.trim().isEmpty ? _done : _send))),
                const SizedBox(width: 8),
                Expanded(child: Btn(UiCopy.copy.notNow2, hpad: 8, onTap: () {
                  store.notNow(widget.item);
                  Navigator.of(context).maybePop();
                })),
                if (store.data!.canChat(who.id)) ...[
                  const SizedBox(width: 8),
                  Expanded(child: Btn(UiCopy.copy.message(who.name), hpad: 8, onTap: () {
                    Navigator.of(context).maybePop();
                    Nav.chat(context, who.id, focus: true);
                  })),
                ],
              ]),
            ),
          ]),
          if (thanks)
            Positioned.fill(
              child: Semantics(
                liveRegion: true,
                child: Container(
                  color: p.bg,
                  child: Column(mainAxisAlignment: MainAxisAlignment.center, children: [
                    Ic('check', size: 44, color: p.text),
                    const SizedBox(height: 8),
                    Text(UiCopy.copy.continuing(who.name), style: TextStyle(fontFamily: kFont, fontSize: 17, fontWeight: FontWeight.w700, color: p.text)),
                    const SizedBox(height: 4),
                    Text(UiCopy.copy.thisPageCloses, style: T.secondary.copyWith(color: p.text2)),
                  ]),
                ),
              ),
            ),
        ]),
      ),
    );
  }
}
