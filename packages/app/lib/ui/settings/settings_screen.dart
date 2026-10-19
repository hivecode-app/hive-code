// "עוד" → settings (APP-SPEC §4.8): server, focus, appearance, version. Stripe-style pairs.
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:shared_preferences/shared_preferences.dart';

import '../../data/backend_select.dart';
import '../../data/hq_backend.dart';
import '../../data/store.dart';
import '../../theme/tokens.dart';
import '../common.dart';
import '../org/org_screen.dart';

const kVersion = '0.1.0';

class SettingsScreen extends StatefulWidget {
  const SettingsScreen({super.key});
  @override
  State<SettingsScreen> createState() => _SettingsScreenState();
}

class _SettingsScreenState extends State<SettingsScreen> {
  final url = TextEditingController();
  final token = TextEditingController();
  String? note;
  bool busy = false;

  @override
  void initState() {
    super.initState();
    SharedPreferences.getInstance().then((p) {
      if (!mounted) return;
      url.text = p.getString(kHqUrl) ?? gatewayUrl();
      token.text = p.getString(kHqToken) ?? '';
      setState(() {});
    });
  }

  @override
  void dispose() {
    url.dispose();
    token.dispose();
    super.dispose();
  }

  Future<void> _connect() async {
    setState(() {
      busy = true;
      note = null;
    });
    final probe = HqBackend(baseUrl: url.text.trim(), token: token.text.trim());
    try {
      await probe.start();
      final ok = probe.data != null;
      if (ok) {
        final p = await SharedPreferences.getInstance();
        await p.setString(kHqUrl, url.text.trim());
        await p.setString(kHqToken, token.text.trim());
        await p.remove(kDemo);
      }
      setState(() => note = ok ? 'מחובר. האפליקציה תעבור לשרת בפתיחה הבאה.' : 'השרת לא ענה. כדאי לבדוק את הכתובת ואת הטוקן.');
    } finally {
      probe.dispose();
      if (mounted) setState(() => busy = false);
    }
  }

  Future<void> _demo() async {
    final p = await SharedPreferences.getInstance();
    await p.remove(kHqUrl);
    await p.remove(kHqToken);
    await p.setBool(kDemo, true);
    setState(() => note = 'בפתיחה הבאה האפליקציה תציג את ההדגמה.');
  }

  @override
  Widget build(BuildContext context) {
    final p = context.p;
    final store = StoreScope.of(context);
    final d = store.data;
    InputDecoration deco(String hint) => InputDecoration(
          isDense: true,
          hintText: hint,
          hintStyle: T.row2.copyWith(color: p.text3),
          filled: true,
          fillColor: p.surface2,
          border: OutlineInputBorder(borderRadius: BorderRadius.circular(8), borderSide: BorderSide.none),
        );
    Widget pair(String k, Widget v) => Padding(
          padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 11),
          child: Row(children: [Text(k, style: T.row2.copyWith(color: p.text2)), const SizedBox(width: 12), Expanded(child: Align(alignment: AlignmentDirectional.centerEnd, child: v))]),
        );
    return Scaffold(
      backgroundColor: p.bg,
      body: SafeArea(
        child: Column(children: [
          TopBar(title: 'הגדרות', leading: IBtn('arrow_forward', tip: 'חזרה', onTap: () => Navigator.of(context).maybePop())),
          Expanded(
            child: ListView(padding: EdgeInsets.zero, children: [
              const Section('שרת', top: 8),
              ListBlock(inset: 16, children: [
                pair('מקור הנתונים', Text(store.backend.label, style: T.row2.copyWith(color: p.text))),
                Padding(
                  padding: const EdgeInsets.fromLTRB(16, 12, 16, 12),
                  child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
                    Text('כתובת', style: T.small.copyWith(color: p.text2)),
                    const SizedBox(height: 4),
                    TextField(controller: url, textDirection: TextDirection.ltr, style: T.mono(13).copyWith(color: p.text), decoration: deco('https://…/hq')),
                    const SizedBox(height: 10),
                    Text('טוקן', style: T.small.copyWith(color: p.text2)),
                    const SizedBox(height: 4),
                    TextField(controller: token, obscureText: true, textDirection: TextDirection.ltr, style: T.mono(13).copyWith(color: p.text), decoration: deco('api-token של hq')),
                    const SizedBox(height: 12),
                    Wrap(spacing: 8, runSpacing: 8, crossAxisAlignment: WrapCrossAlignment.center, children: [
                      Btn(busy ? 'בודק…' : 'חיבור', kind: BtnKind.primary, onTap: busy ? null : _connect),
                      Btn('הדגמה', onTap: _demo),
                      Btn('חברה אמיתית', onTap: () async {
                        final p = await SharedPreferences.getInstance();
                        await p.remove(kDemo);
                        await p.remove(kHqUrl);
                        await p.remove(kHqToken);
                        setState(() => note = 'בפתיחה הבאה האפליקציה תתחבר לחברה.');
                      }),
                    ]),
                    if (note != null) Padding(padding: const EdgeInsets.only(top: 10), child: Text(note!, style: T.secondary.copyWith(color: p.text))),
                  ]),
                ),
              ]),
              const Section('התראות'),
              ListBlock(inset: 16, children: [
                pair('פוקוס', Toggle(on: d?.focus ?? false, label: 'פוקוס', onTap: store.toggleFocus)),
                Padding(
                  padding: const EdgeInsets.fromLTRB(16, 11, 16, 11),
                  child: Text('בפוקוס ההתראות נאספות בשקט, ותקלה דחופה בפרודקשן עוברת בכל מקרה.', style: T.small.copyWith(color: p.text2)),
                ),
              ]),
              const Section('תצוגה'),
              ListBlock(inset: 16, children: [
                pair('מצב כהה', Text('לפי המכשיר', style: T.row2.copyWith(color: p.text))),
                pair('גודל טקסט', Text('לפי המכשיר, עד 130%', style: T.row2.copyWith(color: p.text))),
              ]),
              const Section('אודות'),
              ListBlock(inset: 16, children: [
                pair('גרסה', GestureDetector(onLongPress: () => Clipboard.setData(const ClipboardData(text: kVersion)), child: Text(kVersion, style: T.mono(13).copyWith(color: p.text)))),
              ]),
              const SizedBox(height: 24),
            ]),
          ),
        ]),
      ),
    );
  }
}
