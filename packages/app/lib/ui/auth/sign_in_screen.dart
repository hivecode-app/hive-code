// Sign-in (#23): fingerprint with a passkey, or a pairing code from a device that is already in
// (settings → devices, or a link with ?pair=). Every device gets its own token, revocable there.
// The app has no server built in (docs/generic/PLAN.md §2): with [askServer] the screen starts with
// the server's address, filled from a pairing link or the last server, and checks that hq is there.
import 'package:flutter/material.dart';

import '../../data/auth_client.dart';
import '../../data/backend_select.dart';
import '../../data/passkey.dart';
import '../../theme/tokens.dart';
import '../common.dart';

class SignInScreen extends StatefulWidget {
  const SignInScreen(
      {super.key, required this.client, required this.onSignedIn, this.note, this.pairCode, this.askServer = false, this.server, this.current, this.onCancel});
  final AuthClient client;
  final ValueChanged<Session> onSignedIn;
  /// Why we are here, e.g. "המכשיר הזה נותק".
  final String? note;

  /// From the pairing link.
  final String? pairCode;

  /// The app (not the web build): which server is part of signing in.
  final bool askServer;

  /// The server to start with: an hq address or an origin.
  final String? server;

  /// Switching servers: the host this device is still signed in to, until the new one works.
  final String? current;
  final VoidCallback? onCancel;

  @override
  State<SignInScreen> createState() => _SignInScreenState();
}

class _SignInScreenState extends State<SignInScreen> {
  late final code = TextEditingController(text: widget.pairCode ?? '');
  late final server = TextEditingController(text: widget.server == null || widget.server!.isEmpty ? '' : serverHost(widget.server!));
  String? error;
  bool busy = false;

  /// Shown after the passkey prompt was dismissed during pairing: pair with the code alone.
  bool offerCodeOnly = false;

  @override
  void dispose() {
    code.dispose();
    server.dispose();
    super.dispose();
  }

  /// A whole pairing link pasted into the address: the host stays there, the code goes to its field.
  /// Typing a path by hand (`app.example.com/hq`) is left alone; _useServer reads it as it is.
  void _serverChanged(String v) {
    if (!v.contains('://') && !v.contains('?')) return;
    final t = parseServer(v);
    if (t == null) return;
    if (t.code != null) code.text = t.code!;
    server.value = TextEditingValue(text: t.host, selection: TextSelection.collapsed(offset: t.host.length));
  }

  /// Points the client at the typed server and checks that hq answers there.
  Future<void> _useServer() async {
    if (!widget.askServer) return;
    final t = parseServer(server.text);
    if (t == null) {
      throw AuthFailure(server.text.trim().isEmpty
          ? 'צריך את הכתובת של השרת, מה-QR או מהקישור שקיבלת.'
          : 'הכתובת לא נראית כמו כתובת של שרת. למשל app.example.com.');
    }
    if (t.code != null && code.text.trim().isEmpty) code.text = t.code!;
    widget.client.baseUrl = t.hqUrl;
    await widget.client.probe();
  }

  Future<void> _run(Future<Session> Function() f) async {
    setState(() {
      busy = true;
      error = null;
    });
    try {
      await _useServer();
      final s = await f();
      if (mounted) widget.onSignedIn(s);
    } on AuthFailure catch (e) {
      if (mounted) setState(() => error = e.message);
    } finally {
      if (mounted) setState(() => busy = false);
    }
  }

  Future<void> _login() => _run(() => widget.client.login(defaultDeviceName()));

  Future<void> _pair() => _run(() async {
        final c = code.text.trim();
        if (c.isEmpty) throw const AuthFailure('צריך קוד צימוד ממסך המכשירים שבהגדרות, במכשיר שכבר מחובר.');
        final name = defaultDeviceName();
        if (!widget.client.passkeysSupported) return widget.client.pair(c, name);
        try {
          return await widget.client.register(c, name);
        } on AuthFailure catch (e) {
          // A passkey of the company already lives here (synced): signing in with it is the same thing.
          if (e.code == PasskeyError.exists) return widget.client.login(name);
          if (e.code == PasskeyError.unsupported) return widget.client.pair(c, name);
          if (e.code == PasskeyError.cancelled || e.code == PasskeyError.failed) setState(() => offerCodeOnly = true);
          rethrow;
        }
      });

  Future<void> _codeOnly() => _run(() => widget.client.pair(code.text.trim(), defaultDeviceName()));

  @override
  Widget build(BuildContext context) {
    final p = context.p;
    final hasPasskeys = widget.client.passkeysSupported;
    return Scaffold(
      backgroundColor: p.bg,
      body: SafeArea(
        child: Center(
          child: SingleChildScrollView(
            padding: const EdgeInsets.symmetric(vertical: 24),
            child: ConstrainedBox(
              constraints: const BoxConstraints(maxWidth: 420),
              child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
                BigTitle('החברה', sub: widget.current != null ? 'החלפת שרת' : 'כניסה במכשיר הזה'),
                if (widget.note != null)
                  Padding(
                    padding: const EdgeInsets.fromLTRB(16, 0, 16, 12),
                    child: Text(widget.note!, style: T.secondary.copyWith(color: p.text)),
                  ),
                if (widget.current != null)
                  Padding(
                    padding: const EdgeInsets.fromLTRB(16, 0, 16, 12),
                    child: Text('המכשיר מחובר עכשיו ל-${widget.current}, ונשאר מחובר אליו עד שהכניסה לשרת החדש מצליחה.',
                        style: T.secondary.copyWith(color: p.text)),
                  ),
                if (widget.askServer) ...[
                  const Section('שרת', top: 8),
                  ListBlock(inset: 16, children: [
                    Padding(
                      padding: const EdgeInsets.fromLTRB(16, 12, 16, 14),
                      child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
                        Text('הכתובת מה-QR או מהקישור שקיבלת. אפשר גם להדביק כאן את הקישור כולו.', style: T.small.copyWith(color: p.text2)),
                        const SizedBox(height: 8),
                        TextField(
                          key: const Key('server-address'),
                          controller: server,
                          textDirection: TextDirection.ltr,
                          keyboardType: TextInputType.url,
                          autocorrect: false,
                          enableSuggestions: false,
                          onChanged: _serverChanged,
                          style: T.mono(15).copyWith(color: p.text),
                          decoration: InputDecoration(
                            isDense: true,
                            hintText: 'app.example.com',
                            hintTextDirection: TextDirection.ltr,
                            hintStyle: T.mono(15).copyWith(color: p.text3),
                            filled: true,
                            fillColor: p.surface2,
                            border: OutlineInputBorder(borderRadius: BorderRadius.circular(8), borderSide: BorderSide.none),
                          ),
                        ),
                      ]),
                    ),
                  ]),
                  const SizedBox(height: 24),
                ],
                if (hasPasskeys) ...[
                  Padding(
                    padding: const EdgeInsets.symmetric(horizontal: 16),
                    child: Btn(busy ? 'רגע…' : 'כניסה עם טביעת אצבע', kind: BtnKind.primary, icon: 'fingerprint', height: 44, onTap: busy ? null : _login),
                  ),
                  Padding(
                    padding: const EdgeInsets.fromLTRB(16, 8, 16, 0),
                    child: Text('עם passkey שכבר שמור אצלך, גם אם נוצר במכשיר אחר.', style: T.small.copyWith(color: p.text2)),
                  ),
                ],
                Section('מכשיר חדש', top: hasPasskeys ? 24 : 8),
                ListBlock(inset: 16, children: [
                  Padding(
                    padding: const EdgeInsets.fromLTRB(16, 12, 16, 14),
                    child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
                      Text('קוד צימוד ממסך המכשירים שבהגדרות, במכשיר שכבר מחובר.', style: T.small.copyWith(color: p.text2)),
                      const SizedBox(height: 8),
                      TextField(
                        key: const Key('pair-code'),
                        controller: code,
                        textDirection: TextDirection.ltr,
                        textCapitalization: TextCapitalization.characters,
                        autocorrect: false,
                        style: T.mono(16, w: FontWeight.w500).copyWith(color: p.text, letterSpacing: 2),
                        onSubmitted: (_) => busy ? null : _pair(),
                        decoration: InputDecoration(
                          isDense: true,
                          hintText: 'XXXX-XXXX',
                          hintStyle: T.mono(16).copyWith(color: p.text3, letterSpacing: 2),
                          filled: true,
                          fillColor: p.surface2,
                          border: OutlineInputBorder(borderRadius: BorderRadius.circular(8), borderSide: BorderSide.none),
                        ),
                      ),
                      const SizedBox(height: 12),
                      Wrap(spacing: 8, runSpacing: 8, crossAxisAlignment: WrapCrossAlignment.center, children: [
                        Btn(hasPasskeys ? 'צימוד ויצירת passkey' : 'צימוד', icon: 'link', onTap: busy ? null : _pair),
                        if (offerCodeOnly) Btn('צימוד בלי טביעת אצבע', onTap: busy ? null : _codeOnly),
                      ]),
                    ]),
                  ),
                ]),
                if (error != null)
                  Padding(
                    padding: const EdgeInsets.fromLTRB(16, 12, 16, 0),
                    child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
                      Ic('error', size: 18, color: p.urgent),
                      const SizedBox(width: 6),
                      Expanded(child: Text(error!, style: T.secondary.copyWith(color: p.text))),
                    ]),
                  ),
                if (widget.onCancel != null)
                  Padding(
                    padding: const EdgeInsets.fromLTRB(16, 24, 16, 0),
                    child: Align(alignment: AlignmentDirectional.centerStart, child: Btn('ביטול', onTap: busy ? null : widget.onCancel)),
                  ),
              ]),
            ),
          ),
        ),
      ),
    );
  }
}
