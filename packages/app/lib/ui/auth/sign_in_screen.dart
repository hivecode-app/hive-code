import 'package:agent_company/l10n/ui_copy.dart';
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
  bool errorFault = false;
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
          ? UiCopy.copy.enterServerAddress
          : UiCopy.copy.thisDoesNot);
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
      if (mounted) {
        setState(() {
          error = e.message;
          errorFault = e.fault;
        });
      }
    } finally {
      if (mounted) setState(() => busy = false);
    }
  }

  Future<void> _login() => _run(() => widget.client.login(defaultDeviceName()));

  Future<void> _pair() => _run(() async {
        final c = code.text.trim();
        if (c.isEmpty) throw  AuthFailure(UiCopy.copy.usePairingCode);
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
    UiCopy.watch(context);
    final p = context.p;
    final hasPasskeys = widget.client.passkeysSupported;
    InputDecoration field(String hint, TextStyle style) => InputDecoration(
          hintText: hint,
          hintTextDirection: TextDirection.ltr,
          hintStyle: style.copyWith(color: p.text3),
          filled: true,
          fillColor: p.surface2,
          contentPadding: const EdgeInsets.symmetric(horizontal: 16, vertical: 14),
          border: OutlineInputBorder(borderRadius: BorderRadius.circular(10), borderSide: BorderSide.none),
        );
    Widget label(String s) => Padding(padding: const EdgeInsets.only(bottom: 8), child: Text(s, style: T.row2.copyWith(color: p.text2)));
    final pairLabel = hasPasskeys ? UiCopy.copy.pairCreatePasskey : UiCopy.copy.pair;
    return Scaffold(
      backgroundColor: p.bg,
      body: SafeArea(
        child: Align(
          alignment: Alignment.topCenter,
          child: SingleChildScrollView(
            padding: const EdgeInsets.fromLTRB(24, 48, 24, 24),
            child: ConstrainedBox(
              constraints: const BoxConstraints(maxWidth: 420),
              child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
                Text(UiCopy.copy.signThisDevice, style: T.big.copyWith(color: p.text, height: 1.2)),
                Padding(
                  padding: const EdgeInsets.only(top: 8, bottom: 28),
                  child: Text(widget.current != null ? UiCopy.copy.switchServer2 : hasPasskeys ? UiCopy.copy.company2 : UiCopy.copy.pairingCodeFrom, style: T.body.copyWith(color: p.text2)),
                ),
                if (widget.note != null)
                  Padding(padding: const EdgeInsets.only(bottom: 16), child: Text(widget.note!, style: T.body.copyWith(color: p.text))),
                if (widget.current != null)
                  Padding(padding: const EdgeInsets.only(bottom: 16), child: Text(UiCopy.copy.thisDeviceStays(widget.current!), style: T.row2.copyWith(color: p.text))),
                if (widget.askServer) ...[
                  label(UiCopy.copy.useAddressFrom),
                  TextField(
                    key: const Key('server-address'),
                    controller: server,
                    textDirection: TextDirection.ltr,
                    keyboardType: TextInputType.url,
                    autocorrect: false,
                    enableSuggestions: false,
                    onChanged: _serverChanged,
                    style: T.mono(15).copyWith(color: p.text),
                    decoration: field('app.example.com', T.mono(15)),
                  ),
                  const SizedBox(height: 24),
                ],
                if (hasPasskeys) ...[
                  _BigButton(busy ? UiCopy.copy.oneMoment : UiCopy.copy.signPasskey, icon: 'fingerprint', primary: true, onTap: busy ? null : _login),
                  Padding(padding: const EdgeInsets.only(top: 8, bottom: 28), child: Text(UiCopy.copy.useSavedPasskey, style: T.small.copyWith(color: p.text2))),
                  label(UiCopy.copy.newDevice),
                  Padding(padding: const EdgeInsets.only(bottom: 8), child: Text(UiCopy.copy.pairingCodeFrom, style: T.small.copyWith(color: p.text2))),
                ],
                TextField(
                  key: const Key('pair-code'),
                  controller: code,
                  textDirection: TextDirection.ltr,
                  textAlign: TextAlign.center,
                  textCapitalization: TextCapitalization.characters,
                  autocorrect: false,
                  style: T.mono(20, w: FontWeight.w500).copyWith(color: p.text, letterSpacing: 3),
                  onSubmitted: (_) => busy ? null : _pair(),
                  decoration: field('XXXX-XXXX', T.mono(20).copyWith(letterSpacing: 3)),
                ),
                const SizedBox(height: 12),
                _BigButton(busy && !hasPasskeys ? UiCopy.copy.oneMoment : pairLabel, icon: 'link', primary: !hasPasskeys, onTap: busy ? null : _pair),
                if (offerCodeOnly) ...[const SizedBox(height: 8), _BigButton(UiCopy.copy.pairWithoutPasskey, onTap: busy ? null : _codeOnly)],
                if (error != null) ShownError(error!, screen: UiCopy.copy.sign, padding: const EdgeInsets.only(top: 16), report: errorFault),
                if (widget.onCancel != null)
                  Padding(
                    padding: const EdgeInsets.only(top: 24),
                    child: Align(alignment: AlignmentDirectional.centerStart, child: Btn(UiCopy.copy.cancel, onTap: busy ? null : widget.onCancel)),
                  ),
              ]),
            ),
          ),
        ),
      ),
    );
  }
}

/// A full-width 48px button with a 10px radius, as the onboarding's "המשך" (a-he-onboard-*).
class _BigButton extends StatelessWidget {
  const _BigButton(this.label, {this.icon, this.primary = false, this.onTap});
  final String label;
  final String? icon;
  final bool primary;
  final VoidCallback? onTap;
  @override
  Widget build(BuildContext context) {
    final p = context.p;
    final fg = primary ? p.onAccent : p.text;
    return Semantics(
      button: true,
      enabled: onTap != null,
      child: Material(
        color: primary ? p.accent : p.surface,
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(10), side: BorderSide(color: primary ? p.accent : p.line)),
        clipBehavior: Clip.antiAlias,
        child: InkWell(
          onTap: onTap,
          child: SizedBox(
            height: 48,
            child: Row(mainAxisAlignment: MainAxisAlignment.center, children: [
              if (icon != null) ...[Ic(icon!, size: 20, color: fg), const SizedBox(width: 8)],
              Flexible(child: Text(label, maxLines: 1, overflow: TextOverflow.ellipsis, style: T.button.copyWith(color: fg, fontWeight: FontWeight.w700, fontSize: 15))),
            ]),
          ),
        ),
      ),
    );
  }
}
