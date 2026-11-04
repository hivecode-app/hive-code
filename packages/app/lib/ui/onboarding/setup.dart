import 'dart:convert';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:flutter/material.dart';
import '../../data/backend_select.dart';
import '../../data/product_client.dart';
import '../../data/store.dart';
import '../../l10n/app_localizations.dart';
import '../../native/native_bridge.dart';
import '../../theme/tokens.dart';
import '../common.dart';
import '../chat/chat_screen.dart';

/// Wraps the existing navigation. Pairing an existing company never enters setup.
class SetupGate extends StatefulWidget {
  const SetupGate({super.key, required this.child, this.client});
  final Widget child;
  final ProductClient? client;
  @override
  State<SetupGate> createState() => _SetupGateState();
}
class _SetupGateState extends State<SetupGate> {
  ProductClient? client;
  Map<String, dynamic>? initial;
  bool loading = true, failed = false, knownCompany = false;
  @override
  void initState() { super.initState(); load(); }
  Future<void> load() async {
    setState(() { loading = true; failed = false; });
    try {
      final session = await savedSession();
      if (session != null || widget.client != null) {
        if (widget.client == null) client?.close();
        client = widget.client ?? ProductClient(session!);
        final prefs = await SharedPreferences.getInstance();
        final completeKey = 'setup-complete:${client!.session.baseUrl}';
        knownCompany = prefs.getBool(completeKey) == true || (mounted && StoreScope.read(context).data?.projects.isNotEmpty == true);
        // Established companies can keep cached conversations while a server is unavailable.
        if (knownCompany && mounted) setState(() => loading = false);
        initial = await client!.request('/api/setup');
        await prefs.setBool(completeKey, initial?['pending'] != true || initial?['started'] == true);
      }
    } on ProductFailure catch (e) {
      // Compatibility with a server from before setup. A failed connection is never a successful setup.
      if (e.status != 404 && !knownCompany) { failed = true; }
    } catch (_) { failed = !knownCompany; }
    if (mounted) setState(() => loading = false);
  }
  @override
  void dispose() { if (widget.client == null) client?.close(); super.dispose(); }
  @override
  Widget build(BuildContext context) {
    final l = AppLocalizations.of(context);
    if (loading || failed) { return Scaffold(body: SafeArea(child: Center(child: Padding(padding: const EdgeInsets.all(24), child: Column(mainAxisSize: MainAxisSize.min, children: [
      if (loading) const CircularProgressIndicator(),
      Text(failed ? l.setupError : l.setupLoading),
      if (failed) TextButton(onPressed: load, child: Text(l.retry)),
    ]))))); }
    if (client != null && initial?['pending'] == true && initial?['started'] != true) {
      return SetupScreen(client: client!, initial: initial!, onDone: () => setState(() => initial = null));
    }
    return widget.child;
  }
}

class SetupScreen extends StatefulWidget {
  const SetupScreen({super.key, required this.client, required this.initial, required this.onDone});
  final ProductClient client;
  final Map<String, dynamic> initial;
  final VoidCallback onDone;
  @override
  State<SetupScreen> createState() => _SetupScreenState();
}
class _SetupScreenState extends State<SetupScreen> {
  int step = 0, page = 0;
  bool notificationsAllowed = true;
  bool accepted = false, busy = false, error = false, repoError = false, more = true;
  final checks = <String, bool?>{'claude': null, 'github': null};
  final checking = <String>{};
  final selected = <String>{};
  final repos = <Map<String, dynamic>>[];
  String query = '';
  final search = TextEditingController();
  @override
  void dispose() { search.dispose(); super.dispose(); }
  @override
  void initState() {
    super.initState();
    selected.addAll((widget.initial['selected'] as List? ?? []).cast<String>());
    if (widget.initial['started'] == true) { step = 3; }
    else if (widget.initial['consent'] == true) { step = 1; accepted = true; }
    if (step == 1) { check('claude'); check('github'); }
    restore();
    refreshPermission();
  }
  Future<void> refreshPermission() async {
    final allowed = await NativeBridge.instance.notificationsEnabled();
    if (mounted) setState(() => notificationsAllowed = allowed);
  }
  String get draftKey => 'setup-draft:${widget.client.session.baseUrl}';
  Future<void> restore() async {
    final prefs = await SharedPreferences.getInstance();
    final raw = prefs.getString(draftKey);
    if (raw == null || !mounted) return;
    try {
      final saved = jsonDecode(raw) as Map;
      setState(() {
        selected..clear()..addAll((saved['selected'] as List? ?? []).cast<String>());
        query = saved['query'] as String? ?? '';
        search.text = query;
        if (widget.initial['consent'] == true && saved['step'] == 2) step = 2;
      });
      if (step == 2) await loadRepos();
    } catch (_) { /* An old draft does not block the authoritative server state. */ }
  }
  Future<void> saveDraft() async {
    final prefs = await SharedPreferences.getInstance();
    await prefs.setString(draftKey, jsonEncode({'step': step, 'selected': selected.toList(), 'query': query}));
  }
  Future<void> run(Future<void> Function() operation) async {
    if (busy) return;
    setState(() { busy = true; error = false; });
    try { await operation(); } catch (_) { if (mounted) setState(() => error = true); }
    finally { if (mounted) setState(() => busy = false); }
  }
  Future<void> check(String service) async {
    if (checking.contains(service)) return;
    setState(() => checking.add(service));
    bool connected = false;
    try { connected = (await widget.client.request('/api/setup/check', {'service': service}))['connected'] == true; } catch (_) { /* retry remains available */ }
    if (mounted) setState(() { checks[service] = connected; checking.remove(service); });
  }
  Future<void> loadRepos() async {
    if (busy) return;
    await run(() async {
      final value = await widget.client.request('/api/setup/repos?page=${page + 1}');
      if (!mounted) return;
      setState(() {
        for (final row in (value['repos'] as List)) {
          final repo = (row as Map).cast<String, dynamic>();
          if (!repos.any((r) => r['name'] == repo['name'])) repos.add(repo);
        }
        page++; more = value['more'] == true; repoError = false;
      });
    });
    if (error && mounted) setState(() => repoError = true);
  }
  Future<void> consent() => run(() async {
    await widget.client.request('/api/consent', {'accepted': true, 'version': widget.initial['version'], 'language': Localizations.localeOf(context).languageCode});
    if (!mounted) return;
    setState(() => step = 1);
    await saveDraft();
    check('claude'); check('github');
  });
  Future<void> persistSelection() async {
    if (selected.isEmpty) return;
    await widget.client.request('/api/setup/projects', {'selected': selected.toList()});
  }
  Future<void> start() => run(() async {
    await persistSelection();
    await widget.client.request('/api/setup/start', {});
    final prefs = await SharedPreferences.getInstance();
    await prefs.remove(draftKey);
    if (mounted) setState(() => step = 3);
  });
  @override
  Widget build(BuildContext context) {
    final l = AppLocalizations.of(context), p = context.p;
    final titles = [l.approvedCopy14, l.setupAlmostReady, l.setupProjects, l.setupFirstTask];
    final visible = repos.where((r) => '${r['name']} ${r['description']}'.toLowerCase().contains(query.toLowerCase())).toList();
    Widget connection(String service, String title, String hint) => ListTile(
      contentPadding: EdgeInsets.zero,
      leading: Ic(checks[service] == true ? 'check_circle' : 'link'),
      title: Text(title), subtitle: Text(checks[service] == true ? l.setupConnected : '${l.setupNeedsConnection}\n$hint'),
      trailing: checking.contains(service) ? const SizedBox(width: 24, height: 24, child: CircularProgressIndicator()) : IconButton(tooltip: l.retry, onPressed: () => check(service), icon: const Ic('refresh')),
    );
    void openConversation() {
      final manager = widget.initial['manager'] as String;
      widget.onDone();
      Navigator.push(context, MaterialPageRoute<void>(builder: (_) => Scaffold(body: SafeArea(child: ChatScreen(identityId: manager)))));
    }
    final primary = switch (step) {
      0 => FilledButton(key: const Key('setup-continue'), onPressed: accepted && !busy ? consent : null, child: Text(l.setupContinue)),
      1 => FilledButton(onPressed: !busy && checks.values.every((v) => v == true) ? () { setState(() => step = 2); saveDraft(); if (page == 0) loadRepos(); } : null, child: Text(l.setupContinue)),
      2 => FilledButton(key: const Key('setup-start'), onPressed: selected.isEmpty || busy ? null : start, child: Text(l.setupStart)),
      _ => FilledButton(onPressed: openConversation, child: Text(l.setupOpenConversation)),
    };
    return Scaffold(backgroundColor: p.bg,
      bottomNavigationBar: SafeArea(child: Align(heightFactor: 1, child: ConstrainedBox(constraints: const BoxConstraints(maxWidth: 640), child: Padding(padding: const EdgeInsets.fromLTRB(24, 12, 24, 16), child: SizedBox(width: double.infinity, child: primary))))),
      body: SafeArea(child: Align(alignment: Alignment.topCenter, child: ConstrainedBox(constraints: const BoxConstraints(maxWidth: 640), child: Column(children: [
        Padding(padding: const EdgeInsets.fromLTRB(24, 12, 24, 0), child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
          Row(children: [
            if (step > 0 && step < 3) IconButton(tooltip: l.back, onPressed: busy ? null : () { setState(() => step--); saveDraft(); }, icon: Ic(backIcon(context))),
            Expanded(child: Text(l.setupStep(step + 1), style: T.small.copyWith(color: p.text2))),
            TextButton(onPressed: () {
              final prefs = StoreScope.of(context).preferences;
              prefs.setLanguage(prefs.language == 'en' ? 'he' : 'en');
            }, child: Text(Localizations.localeOf(context).languageCode == 'en' ? l.hebrewLanguage : l.englishLanguage)),
          ]),
          Semantics(label: l.setupStep(step + 1), child: Row(children: [for (var i = 0; i < 4; i++) Expanded(child: Container(margin: EdgeInsetsDirectional.only(end: i < 3 ? 6 : 0), height: 3, color: i <= step ? p.text : p.line))])),
        ])),
        Expanded(child: ListView(padding: const EdgeInsets.all(24), children: [
          Text(titles[step], style: T.bar.copyWith(color: p.text)),
          const SizedBox(height: 24),
          if (step == 0) ...[
            Text(l.approvedCopy15, style: T.body.copyWith(color: p.text)),
            const SizedBox(height: 16),
            for (final row in [('terminal', l.setupCommandAccess), ('code', l.approvedCopy17), ('key', l.setupTokenAccess), ('front_hand', l.approvedCopy19)])
              ListTile(contentPadding: EdgeInsets.zero, leading: Ic(row.$1, color: p.text2), title: Text(row.$2)),
            CheckboxListTile(key: const Key('setup-consent'), contentPadding: EdgeInsets.zero, controlAffinity: ListTileControlAffinity.leading, title: Text(l.approvedCopy20),
              subtitle: Align(alignment: AlignmentDirectional.centerStart, child: TextButton(style: TextButton.styleFrom(foregroundColor: p.read),
                onPressed: () => showDialog<void>(context: context, builder: (context) => AlertDialog(title: Text(l.approvedCopy21), content: SingleChildScrollView(child: Text(l.setupTermsBody)), actions: [TextButton(onPressed: () => Navigator.pop(context), child: Text(l.back))])), child: Text(l.approvedCopy21))),
              value: accepted, onChanged: busy ? null : (v) => setState(() => accepted = v == true)),
          ],
          if (step == 1) ...[
            ListTile(contentPadding: EdgeInsets.zero, leading: const Ic('check_circle'), title: Text(l.setupServer)),
            connection('claude', l.setupClaude, l.setupClaudeHint), connection('github', l.setupGithub, l.setupGithubHint),
          ],
          if (step == 2) ...[
            TextField(decoration: InputDecoration(labelText: l.setupFindRepo, prefixIcon: const Ic('search')), controller: search, onChanged: (v) { query = v; saveDraft(); setState(() {}); }),
            const SizedBox(height: 12),
            if (page > 0 && visible.isEmpty) Text(repos.isEmpty ? l.setupNoRepos : l.setupNoResults),
            for (final repo in visible) CheckboxListTile(contentPadding: EdgeInsets.zero, title: Text(repo['name'] as String), subtitle: (repo['description'] as String).isEmpty ? null : Text(repo['description'] as String), value: selected.contains(repo['name']), onChanged: busy ? null : (v) {
              setState(() { v == true ? selected.add(repo['name'] as String) : selected.remove(repo['name']); }); saveDraft();
            }),
            if (more) TextButton(onPressed: busy ? null : loadRepos, child: Text(repoError ? l.retry : l.setupMore)),
          ],
          if (step == 3) ...[
            Text(l.setupFirstTaskHint), const SizedBox(height: 24),
            TextButton(onPressed: widget.onDone, child: Text(l.setupLater)),
            if (!notificationsAllowed) TextButton(onPressed: () async {
              await NativeBridge.instance.requestNotificationPermission();
              await refreshPermission();
            }, child: Text(l.setupEnableNotifications)),
          ],
          if (busy) const Padding(padding: EdgeInsets.all(16), child: Center(child: CircularProgressIndicator())),
          if (error) Semantics(liveRegion: true, child: Padding(padding: const EdgeInsets.symmetric(vertical: 16), child: Text(repoError ? l.setupRepoFailure : l.setupError))),
        ])),
      ])))));
  }
}
