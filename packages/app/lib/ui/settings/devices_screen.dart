import 'package:agent_company/l10n/ui_copy.dart';
// Settings → devices (#23): every device with its own token, the passkeys, and pairing a new one.
// Revoking a device stops its token at once (hq closes its live link too); removing a passkey
// also signs out the devices that came in with it.
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../../data/auth_client.dart';
import '../../data/backend_select.dart';
import '../../theme/tokens.dart';
import '../common.dart';

class DevicesScreen extends StatefulWidget {
  const DevicesScreen({super.key, this.client, this.session});

  /// Tests pass these; otherwise the saved session and a client for it.
  final AuthClient? client;
  final Session? session;

  @override
  State<DevicesScreen> createState() => _DevicesScreenState();
}

class _DevicesScreenState extends State<DevicesScreen> {
  Session? session;
  AuthClient? client;
  List<DeviceInfo>? devices;
  List<PasskeyInfo> passkeys = const [];
  PairCode? pairCode;
  String? error;
  bool errorFault = false;
  bool loading = true;

  @override
  void initState() {
    super.initState();
    _init();
  }

  Future<void> _init() async {
    session = widget.session ?? await savedSession();
    if (session != null) client = widget.client ?? AuthClient(session!.baseUrl);
    await _reload();
  }

  @override
  void dispose() {
    if (widget.client == null) client?.close();
    super.dispose();
  }

  Future<void> _reload() async {
    final c = client, s = session;
    if (c == null || s == null) {
      if (mounted) setState(() => loading = false);
      return;
    }
    try {
      final r = await c.devices(s.token);
      if (!mounted) return;
      setState(() {
        devices = r.devices;
        passkeys = r.passkeys;
        error = null;
      });
    } on AuthFailure catch (e) {
      if (mounted) {
        setState(() {
          error = e.message;
          errorFault = e.fault;
        });
      }
    } finally {
      if (mounted) setState(() => loading = false);
    }
  }

  Future<void> _act(Future<void> Function() f) async {
    try {
      await f();
    } on AuthFailure catch (e) {
      if (mounted) {
        setState(() {
          error = e.message;
          errorFault = e.fault;
        });
      }
    }
    await _reload();
  }

  Future<bool> _confirm(String question, String yes) async {
    final p = context.p;
    final ok = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        backgroundColor: p.surface,
        content: Text(question, style: T.body.copyWith(color: p.text)),
        actions: [
          TextButton(onPressed: () => Navigator.pop(ctx, false), child: Text(UiCopy.copy.keep, style: T.button.copyWith(color: p.text2))),
          TextButton(onPressed: () => Navigator.pop(ctx, true), child: Text(yes, style: T.button.copyWith(color: p.urgent, fontWeight: FontWeight.w700))),
        ],
      ),
    );
    return ok == true;
  }

  Future<void> _revoke(DeviceInfo d) async {
    final q = d.current ? UiCopy.copy.signOutThis : UiCopy.copy.revokeWillDisconnect(d.name);
    if (!await _confirm(q, d.current ? UiCopy.copy.signOut2 : UiCopy.copy.revokeDevice)) return;
    // Signing out this device: hq refuses the token from now on, and the app returns to sign-in.
    await _act(() => client!.revokeDevice(session!.token, d.id));
  }

  Future<void> _removePasskey(PasskeyInfo k) async {
    final n = devices?.where((d) => d.passkeyId == k.id).length ?? 0;
    final q = UiCopy.copy.removePasskey(k.name, n > 0 ? UiCopy.copy.devicesUsingThis(n) : '');
    if (!await _confirm(q, UiCopy.copy.remove)) return;
    await _act(() => client!.revokePasskey(session!.token, k.id));
  }

  Future<void> _newCode() async {
    try {
      final c = await client!.newPairCode(session!.token);
      if (mounted) setState(() => pairCode = c);
    } on AuthFailure catch (e) {
      if (mounted) {
        setState(() {
          error = e.message;
          errorFault = e.fault;
        });
      }
    }
  }

  String _when(DateTime t) => '${dm(t)} ${hm(t)}';

  String _via(DeviceInfo d) => switch (d.via) {
        'passkey' => UiCopy.copy.signedPasskey,
        'register' => UiCopy.copy.pairedCodePasskey,
        _ => UiCopy.copy.pairedCode,
      };

  @override
  Widget build(BuildContext context) {
    UiCopy.watch(context);
    final p = context.p;
    final pc = pairCode;
    return Scaffold(
      backgroundColor: p.bg,
      body: SafeArea(
        child: Column(children: [
          TopBar(title: UiCopy.copy.devices2, leading: IBtn(backIcon(context), tip: UiCopy.copy.back2, onTap: () => Navigator.of(context).maybePop())),
          Expanded(
            child: ListView(padding: EdgeInsets.zero, children: [
              if (loading)
                Padding(padding: const EdgeInsets.all(24), child: Center(child: LoadingWatch(screen: UiCopy.copy.settingsDevices, child: Spin(child: Ic('progress_activity', color: p.text2)))))
              else if (session == null)
                Padding(
                  padding: const EdgeInsets.all(16),
                  child: Text(UiCopy.copy.thisDeviceNot, style: T.secondary.copyWith(color: p.text2)),
                )
              else ...[
                if (error != null) ShownError(error!, screen: UiCopy.copy.settingsDevices, padding: const EdgeInsets.fromLTRB(16, 8, 16, 0), report: errorFault),
                Section(UiCopy.copy.devices2, top: 8, count: devices == null ? null : '${devices!.length}'),
                ListBlock(inset: 16, children: [
                  for (final d in devices ?? const <DeviceInfo>[])
                    _Row(
                      icon: 'devices',
                      title: d.name,
                      tag: d.current ? UiCopy.copy.thisDevice2 : null,
                      sub: '${_via(d)} · ${d.lastSeenAt == null ? UiCopy.copy.neverSeen : UiCopy.copy.seen(_when(d.lastSeenAt!))}',
                      action: Btn(d.current ? UiCopy.copy.signOut2 : UiCopy.copy.cancel, height: 32, onTap: () => _revoke(d)),
                    ),
                ]),
                const Section('passkeys'),
                ListBlock(inset: 16, children: [
                  if (passkeys.isEmpty)
                    Padding(
                      padding: const EdgeInsets.fromLTRB(16, 12, 16, 12),
                      child: Text(UiCopy.copy.noRegisteredPasskeys, style: T.small.copyWith(color: p.text2)),
                    ),
                  for (final k in passkeys)
                    _Row(
                      icon: 'passkey',
                      title: k.name,
                      sub: UiCopy.copy.created(_when(k.createdAt), k.lastUsedAt == null ? '' : UiCopy.copy.lastUsed(_when(k.lastUsedAt!))),
                      action: Btn(UiCopy.copy.remove, height: 32, onTap: () => _removePasskey(k)),
                    ),
                ]),
                 Section(UiCopy.copy.pairNewDevice),
                ListBlock(inset: 16, children: [
                  Padding(
                    padding: const EdgeInsets.fromLTRB(16, 12, 16, 14),
                    child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                      Text(UiCopy.copy.singleUseCode,
                          style: T.small.copyWith(color: p.text2)),
                      const SizedBox(height: 10),
                      if (pc != null) ...[
                        SelectableText(pc.code, key: const Key('pair-code-shown'), textDirection: TextDirection.ltr,
                            style: T.mono(24, w: FontWeight.w700).copyWith(color: p.text, letterSpacing: 3)),
                        const SizedBox(height: 2),
                        Text(UiCopy.copy.validUntil(hm(pc.expiresAt)), style: T.meta.copyWith(color: p.text2)),
                        const SizedBox(height: 10),
                      ],
                      Wrap(spacing: 8, runSpacing: 8, children: [
                        Btn(pc == null ? UiCopy.copy.pairingCode : UiCopy.copy.newCode, icon: 'link', onTap: _newCode),
                        if (pc?.link != null)
                          Btn(UiCopy.copy.copyLink2, icon: 'content_copy', onTap: () => Clipboard.setData(ClipboardData(text: pc!.link!))),
                      ]),
                    ]),
                  ),
                ]),
                const SizedBox(height: 24),
              ],
            ]),
          ),
        ]),
      ),
    );
  }
}

class _Row extends StatelessWidget {
  const _Row({required this.icon, required this.title, required this.sub, required this.action, this.tag});
  final String icon, title, sub;
  final String? tag;
  final Widget action;

  @override
  Widget build(BuildContext context) {
    UiCopy.watch(context);
    final p = context.p;
    return Padding(
      padding: const EdgeInsets.fromLTRB(16, 10, 12, 10),
      child: Row(children: [
        Ic(icon, size: 20, color: p.text2),
        const SizedBox(width: 10),
        Expanded(
          child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            Row(children: [
              Flexible(child: Text(title, style: T.name.copyWith(color: p.text), maxLines: 1, overflow: TextOverflow.ellipsis)),
              if (tag != null) ...[const SizedBox(width: 6), Badge2(label: tag!)],
            ]),
            Text(sub, style: T.meta.copyWith(color: p.text2)),
          ]),
        ),
        const SizedBox(width: 8),
        action,
      ]),
    );
  }
}
