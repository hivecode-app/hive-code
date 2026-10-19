// Tab handoff (APP-SPEC §9, mockup screen 8): only the site's page at phone size, the domain from
// the server's browser (not editable), the SMS code offered by the keyboard, and three exits.
// The page itself is the worker's tab drawn from the screencast; in demo mode it is the mockup's page.
import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../../data/store.dart';
import '../../model/models.dart';
import '../../theme/tokens.dart';
import '../common.dart';
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
  Timer? _close;

  @override
  void initState() {
    super.initState();
    code.addListener(() {
      setState(() {});
      if (code.text.length == 6) _done();
    });
  }

  @override
  void dispose() {
    _close?.cancel();
    code.dispose();
    focus.dispose();
    super.dispose();
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
    final p = context.p;
    final store = StoreScope.of(context);
    final who = store.data!.who(widget.item.from);
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
                  IBtn('close', tip: 'סגירה', onTap: () => Navigator.of(context).maybePop()),
                  const SizedBox(width: 4),
                  Expanded(child: Text('${who.name} · קוד אימות', style: TextStyle(fontFamily: kFont, fontSize: 16, fontWeight: FontWeight.w700, color: p.text))),
                ]),
                Padding(
                  padding: const EdgeInsets.symmetric(horizontal: 12),
                  child: Row(children: [
                    Semantics(
                      label: 'הדומיין מהדפדפן של השרת: ${widget.item.domain}',
                      child: Container(
                        height: 26,
                        padding: const EdgeInsets.symmetric(horizontal: 10),
                        decoration: BoxDecoration(color: p.surface2, borderRadius: BorderRadius.circular(13)),
                        child: Row(mainAxisSize: MainAxisSize.min, children: [
                          Ic('lock', size: 15, fill: true, color: p.text),
                          const SizedBox(width: 4),
                          Text(widget.item.domain ?? '', textDirection: TextDirection.ltr, style: T.mono(12).copyWith(color: p.text)),
                        ]),
                      ),
                    ),
                    const SizedBox(width: 8),
                    Text("בתוקף עוד 8 דק'", style: T.meta.copyWith(color: p.text2)),
                  ]),
                ),
              ]),
            ),
            Expanded(child: _DemoSite(code: code, focus: focus)),
            Container(
              decoration: BoxDecoration(color: p.surface, border: Border(top: BorderSide(color: p.line))),
              padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
              child: Row(children: [
                Expanded(child: Btn('סיימתי', kind: BtnKind.primary, hpad: 8, onTap: _done)),
                const SizedBox(width: 8),
                Expanded(child: Btn('לא עכשיו', hpad: 8, onTap: () {
                  store.notNow(widget.item);
                  Navigator.of(context).maybePop();
                })),
                const SizedBox(width: 8),
                Expanded(child: Btn('הודעה ל${who.name}', hpad: 8, onTap: () {
                  Navigator.of(context).maybePop();
                  Nav.chat(context, who.id, focus: true);
                })),
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
                    Text('תודה. ${who.name} ממשיך.', style: TextStyle(fontFamily: kFont, fontSize: 17, fontWeight: FontWeight.w700, color: p.text)),
                    const SizedBox(height: 4),
                    Text('הדף נסגר לבד', style: T.secondary.copyWith(color: p.text2)),
                  ]),
                ),
              ),
            ),
        ]),
      ),
    );
  }
}

/// The demo stand-in for the worker's tab (Mercury's 2FA page from the mockup), LTR like the site.
class _DemoSite extends StatelessWidget {
  const _DemoSite({required this.code, required this.focus});
  final TextEditingController code;
  final FocusNode focus;

  @override
  Widget build(BuildContext context) {
    const ink = Color(0xFF1D1D1F), grey = Color(0xFF5B5B60);
    final digits = code.text.padRight(6).characters.toList();
    return Container(
      color: Colors.white,
      width: double.infinity,
      child: Directionality(
        textDirection: TextDirection.ltr,
        child: SingleChildScrollView(
          padding: const EdgeInsets.fromLTRB(22, 24, 22, 24),
          child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            const Text('mercury', style: TextStyle(fontFamily: kFont, fontWeight: FontWeight.w700, fontSize: 15, letterSpacing: 0.4, color: ink)),
            const SizedBox(height: 30),
            const Text('Check your phone', style: TextStyle(fontFamily: kFont, fontWeight: FontWeight.w700, fontSize: 21, color: ink)),
            const SizedBox(height: 6),
            const Text('Enter the 6-digit code we sent to (•••) •••-4417.', style: TextStyle(fontFamily: kFont, fontSize: 14, color: grey)),
            const SizedBox(height: 22),
            GestureDetector(
              onTap: () => focus.requestFocus(),
              child: Stack(children: [
                Row(children: [
                  for (var i = 0; i < 6; i++)
                    Container(
                      width: 38,
                      height: 46,
                      margin: const EdgeInsets.only(right: 7),
                      alignment: Alignment.center,
                      decoration: BoxDecoration(
                        borderRadius: BorderRadius.circular(8),
                        border: Border.all(color: i == code.text.length.clamp(0, 5) || digits[i].trim().isNotEmpty ? ink : const Color(0xFFC9C9CE), width: 1.5),
                      ),
                      child: Text(digits[i], style: T.mono(20, w: FontWeight.w700).copyWith(color: ink)),
                    ),
                ]),
                // The real input: one-time-code autofill lets Android offer the SMS code above the keyboard.
                Positioned.fill(
                  child: Opacity(
                    opacity: 0,
                    child: TextField(
                      controller: code,
                      focusNode: focus,
                      autofocus: true,
                      maxLength: 6,
                      keyboardType: TextInputType.number,
                      autofillHints: const [AutofillHints.oneTimeCode],
                      inputFormatters: [FilteringTextInputFormatter.digitsOnly],
                      decoration: const InputDecoration(counterText: '', border: InputBorder.none),
                    ),
                  ),
                ),
              ]),
            ),
            const SizedBox(height: 14),
            Container(
              height: 44,
              alignment: Alignment.center,
              decoration: BoxDecoration(color: ink, borderRadius: BorderRadius.circular(8)),
              child: const Text('Verify', style: TextStyle(fontFamily: kFont, color: Colors.white, fontWeight: FontWeight.w700, fontSize: 14.5)),
            ),
            const SizedBox(height: 14),
            const Text("Didn't get a code? Resend", style: TextStyle(fontFamily: kFont, fontSize: 12.5, color: grey)),
          ]),
        ),
      ),
    );
  }
}
