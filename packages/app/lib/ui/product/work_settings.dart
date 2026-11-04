import 'package:flutter/material.dart';
import 'package:intl/intl.dart';
import '../../data/backend_select.dart';
import '../../data/product_client.dart';
import '../../l10n/app_localizations.dart';
import '../common.dart';

/// Work preferences are confirmed by the server; device preferences remain in ProductSettings.
class WorkSettingsScreen extends StatefulWidget {
  const WorkSettingsScreen({super.key, this.client});
  final ProductClient? client;
  @override
  State<WorkSettingsScreen> createState() => _WorkSettingsScreenState();
}
class _WorkSettingsScreenState extends State<WorkSettingsScreen> {
  ProductClient? client;
  Map<String, dynamic>? confirmed, draft;
  bool loading = true, saving = false, error = false, saved = false;
  int? forecast;
  @override
  void initState() { super.initState(); load(); }
  Future<void> load() async {
    setState(() { loading = true; error = false; });
    try {
      if (client == null) {
        final session = await savedSession();
        client = widget.client ?? (session == null ? null : ProductClient(session));
      }
      if (client == null) throw const ProductFailure(503);
      final value = await client!.request('/api/settings/work');
      Map<String, dynamic> estimate = {};
      try { estimate = await client!.request('/api/usage/forecast'); } catch (_) { /* A missing estimate does not block work preferences. */ }
      if (!mounted) return;
      setState(() {
        confirmed = (value['settings'] as Map).cast<String, dynamic>();
        draft = Map.of(confirmed!); forecast = estimate['sufficient_until'] as int?;
      });
    } catch (_) { if (mounted) setState(() => error = true); }
    finally { if (mounted) setState(() => loading = false); }
  }
  Future<void> save() async {
    if (saving || draft == null) return;
    setState(() { saving = true; error = false; saved = false; });
    try {
      final value = await client!.request('/api/settings/work', draft);
      if (mounted) setState(() { confirmed = (value['settings'] as Map).cast<String, dynamic>(); draft = Map.of(confirmed!); saved = true; });
    } catch (_) {
      if (mounted) setState(() { draft = Map.of(confirmed!); error = true; });
    } finally { if (mounted) setState(() => saving = false); }
  }
  Future<void> time(String key, String label) async {
    final parts = (draft![key] as String).split(':').map(int.parse).toList();
    final result = await showTimePicker(context: context, helpText: label, initialTime: TimeOfDay(hour: parts[0], minute: parts[1]));
    if (result != null && mounted) setState(() { saved = false; draft![key] = '${result.hour.toString().padLeft(2, '0')}:${result.minute.toString().padLeft(2, '0')}'; });
  }
  @override
  void dispose() { if (widget.client == null) client?.close(); super.dispose(); }
  @override
  Widget build(BuildContext context) {
    final l = AppLocalizations.of(context);
    return Scaffold(appBar: AppBar(leading: IBtn(backIcon(context), tip: l.back, onTap: () => Navigator.maybePop(context)), title: Text(l.workSettingsTitle)), body: SafeArea(child: ListView(padding: const EdgeInsets.all(20), children: [
      if (loading) const Center(child: CircularProgressIndicator()),
      if (draft != null && !loading) ...[
        Text(forecast == null ? l.workForecastUnknown : l.workForecast(DateFormat.yMMMMEEEEd(Localizations.localeOf(context).languageCode).format(DateTime.fromMillisecondsSinceEpoch(forecast!)))),
        const SizedBox(height: 20),
        Text(l.workParallel),
        Row(children: [
          IconButton(tooltip: l.workDecreaseParallel, onPressed: saving || draft!['parallel'] == 1 ? null : () => setState(() { draft!['parallel']--; saved = false; }), icon: const Ic('remove')),
          Semantics(liveRegion: true, child: Text('${draft!['parallel']}')),
          IconButton(tooltip: l.workIncreaseParallel, onPressed: saving || draft!['parallel'] == 32 ? null : () => setState(() { draft!['parallel']++; saved = false; }), icon: const Ic('add')),
        ]),
        SwitchListTile(contentPadding: EdgeInsets.zero, title: Text(l.workNight), subtitle: Text(l.workNightHint), value: draft!['nightEnabled'] as bool, onChanged: saving ? null : (v) => setState(() { draft!['nightEnabled'] = v; saved = false; })),
        if (draft!['nightEnabled'] == true) ...[
          ListTile(contentPadding: EdgeInsets.zero, title: Text(l.workFrom), subtitle: Text(draft!['nightStart'] as String), onTap: saving ? null : () => time('nightStart', l.workFrom)),
          ListTile(contentPadding: EdgeInsets.zero, title: Text(l.workUntil), subtitle: Text(draft!['nightEnd'] as String), onTap: saving ? null : () => time('nightEnd', l.workUntil)),
        ],
        SwitchListTile(key: const Key('auto-accounts'), contentPadding: EdgeInsets.zero, title: Text(l.workAutoAccounts), value: draft!['autoAccounts'] as bool, onChanged: saving ? null : (v) => setState(() { draft!['autoAccounts'] = v; saved = false; })),
        Text(l.workContinueLimit), const SizedBox(height: 20),
        FilledButton(onPressed: saving ? null : save, child: saving ? const SizedBox(width: 24, height: 24, child: CircularProgressIndicator()) : Text(l.workSave)),
      ],
      if (error) Semantics(liveRegion: true, child: Text(draft == null ? l.workOffline : l.setupError)),
      if (error) TextButton(onPressed: loading || saving ? null : load, child: Text(l.retry)),
      if (saved) Semantics(liveRegion: true, child: Text(l.workSaved)),
    ])));
  }
}
